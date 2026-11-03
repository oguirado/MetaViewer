import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installRoleHost} from '../electron/roleHost.js';
import {configuredProfiles, configuredVMProfiles} from '../electron/profilePicker.js';

const profile = {Kind:'vm',NativeKind:'vm',Program:'notepad-vm',Width:1280,Height:900,
  Display:':100',RAMRoot:'/dev/shm/synthetic-vm',default_mode:'agent'};
const surface = {schema:'surface/v0.2',surface_id:'surface-owned',profile_id:'guest',
  kind:'vm',state:'active',control:'agent',visibility:'unfolded',display:':100',geometry:{w:1280,h:900}};

async function fixture(t, {profiles={guest:profile}, current=surface, lookup=true}={}) {
  // VM roles exist only on arm64: pin the host architecture so x64 CI runs the same path.
  const arch=Object.getOwnPropertyDescriptor(process,'arch');
  Object.defineProperty(process,'arch',{...arch,value:'arm64'});
  t.after(()=>Object.defineProperty(process,'arch',arch));
  const root = await mkdtemp(join(tmpdir(),'vm-role-'));
  let handler, nativeCalls=0, mutations=0;
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.webContents.session = {registerPreloadScript(){return 'fixture';},unregisterPreloadScript(){}};
  const env = {MV_SRF_PROFILES:JSON.stringify(profiles),MV_SRF_STATE_DIR:root};
  const states = new Map([['surface-owned',current]]);
  const core = {
    getHumanSurface:id=>lookup && id==='surface-owned' ? current : undefined,
    async stopSurface(){mutations++;throw Error('unexpected lifecycle mutation');},
    async request(){mutations++;throw Error('unexpected core mutation');},
  };
  const roles = installRoleHost({electron:{ipcMain:{handle(_channel,fn){handler=fn;},removeHandler(){}},
    app:{getPath:()=>root}},window,core,env,capsuleStates:states,admit:event=>event==='owned',
    mode(){nativeCalls++;throw Error('unexpected native mode');}});
  t.after(async()=>{await roles.dispose();await rm(root,{recursive:true,force:true});assert.equal(nativeCalls,0);assert.equal(mutations,0);});
  return {env,states,call:(op='status',body={},event='owned')=>handler(event,
    {schema:'metaviewer.roles/v0.3',op,surfaceId:'surface-owned',...body}),
    control(value){current={...current,control:value};states.set('surface-owned',current);}};
}

test('owned active VM receives the existing role status without changing the browser picker',async t=>{
  const f=await fixture(t);
  assert.deepEqual(configuredProfiles(f.env),[]);
  assert.deepEqual(configuredVMProfiles(f.env,process.arch).map(x=>x.id),['guest']);
  assert.deepEqual(await f.call(),{role:'agent',profileId:'guest',control:'agent',hostXpra:false,
    view:{state:'closed'},transition:null});
});

test('VM emergency control changes preserve the configured role and authoritative control',async t=>{
  const f=await fixture(t);
  // Core TakeControl/ReleaseControl changes agent_controlled, not the capsule role.
  for(const control of ['agent','human','agent']) {
    f.control(control);
    const status=await f.call();
    assert.equal(status.role,'agent');
    assert.equal(status.control,control);
    assert.equal(status.profileId,'guest');
    assert.equal(status.transition,null);
  }
});

test('VM role switching refuses before destroying or changing the current capsule',async t=>{
  const f=await fixture(t);
  for(const control of ['agent','human']) {
    f.control(control);
    assert.deepEqual(await f.call('switch'),{ok:false,code:'CAPSULE_ROLE_INVALID'});
    const status=await f.call();
    assert.equal(status.role,'agent');assert.equal(status.control,control);assert.equal(status.transition,null);
    assert.equal(f.states.get('surface-owned').state,'active');
  }
});

test('browser status and emergency control remain unchanged',async t=>{
  const f=await fixture(t,{profiles:{browser:{Kind:'browser',Width:800,Height:600,default_mode:'agent'}},
    current:{...surface,kind:'browser',profile_id:'browser'}});
  assert.deepEqual(configuredProfiles(f.env).map(x=>x.id),['browser']);
  assert.deepEqual(configuredVMProfiles(f.env,process.arch),[]);
  for(const control of ['agent','human','agent']) {
    f.control(control);const status=await f.call();assert.equal(status.role,'agent');assert.equal(status.control,control);
  }
});

test('unknown malformed foreign inactive and mismatched VM registrations refuse',async t=>{
  const cases=[{profiles:{}},{profiles:{guest:{...profile,NativeKind:'browser'}}},
    {profiles:{guest:{...profile,Program:'other'}}},{profiles:{guest:{...profile,Width:0}}},
    {profiles:{guest:{...profile,default_mode:'human'}}},{lookup:false},
    {current:{...surface,state:'lost'}},{current:{...surface,state:'destroyed'}},
    {current:{...surface,kind:'browser'}},{current:{...surface,surface_id:'other'}},
    {current:{...surface,control:'unknown'}},{current:{...surface,control:true}},
    {profiles:{browser:{Kind:'browser'}},current:{...surface,profile_id:'browser'}}];
  for(const options of cases) {const f=await fixture(t,options);assert.deepEqual(await f.call(),{ok:false,code:'SURFACE_UNKNOWN'});}
  const f=await fixture(t,{profiles:{'srf-pg-foreign':profile},current:{...surface,profile_id:'srf-pg-foreign'}});
  assert.deepEqual(await f.call(),{ok:false,code:'IDENTITY_PROTECTED'});
});

test('VM registration keeps sender and closed request-shape checks',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.call('status',{},'foreign'),/XPRA_SENDER_REFUSED/);
  await assert.rejects(f.call('status',{profile:'guest'}),/XPRA_PAYLOAD_REFUSED/);
});

test('VM role admission uses the actual nullish resolution without coercion',async t=>{
  const withoutPrimary={...profile};delete withoutPrimary.default_mode;
  for(const [name,configured] of [
    ['absent role uses the established agent default',withoutPrimary],
    ['explicit fallback agent',{...withoutPrimary,role:'agent'}],
    ['null primary uses explicit fallback agent',{...withoutPrimary,default_mode:null,role:'agent'}],
    ['explicit primary agent',profile],
  ]) await t.test(name,async t=>{
    const f=await fixture(t,{profiles:{guest:configured}});
    assert.equal((await f.call()).role,'agent');
  });
  for(const field of ['default_mode','role']) {
    for(const [name,value] of [['empty',''],['false',false],['zero',0],['array',[]],['object',{}]]) {
      await t.test(`${field} ${name} is not an agent role`,async t=>{
        const configured=field==='default_mode'?{...profile,default_mode:value,role:'agent'}:{...withoutPrimary,role:value};
        const f=await fixture(t,{profiles:{guest:configured}});
        assert.deepEqual(await f.call(),{ok:false,code:'SURFACE_UNKNOWN'});
      });
    }
  }
});
