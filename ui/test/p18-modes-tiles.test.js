import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { parse } from '@vue/compiler-sfc';
import vm from 'node:vm';
import { installRoleHost, surfaceCreateRefusal } from '../electron/roleHost.js';
import { createHumanTraceFile } from '../electron/humanTrace.js';
import { xpraClientQuery } from '../electron/xpraClient.js';
import { identityMarkers } from '../electron/identityMarkers.js';
import { stageOpeningMode } from '../electron/openingMode.js';
import { createWallLayout, SCOPE } from '../src/wall/layout.js';
import { decodeAndMigrateLayoutProfile } from '../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';

const source = await readFile(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8');
const { descriptor } = parse(source);
const wall = await import('data:text/javascript;base64,' + Buffer.from(descriptor.script.content.replace(/from 'vue'/,"from '"+import.meta.resolve('vue')+"'")).toString('base64'));
const appSource = await readFile(new URL('../src/App.vue',import.meta.url),'utf8');
const bounds = {x:0,y:0,width:1280,height:900};

async function fixture(t, legacy = undefined) {
  const root = await mkdtemp(join(tmpdir(),'p18-host-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const handlers = new Map(), states = new Map(), calls = [], stageModes = [];
  let next = 0, failedStop = false, failedCreate = false, stage = 'agent';
  const parent = new EventEmitter();
  parent.webContents = {session:{registerPreloadScript(){return 'preload';},unregisterPreloadScript(){}}};
  const env = {MV_SRF_PROFILES:JSON.stringify({demo:{Kind:'browser',role:legacy}}),MV_SRF_STATE_DIR:root,MV_SRF_BIN_DIR:'/synthetic/bin',MV_RECORDING_DESTINATION:root};
  const core = {
    getHumanSurface:id => states.get(id),
    stopSurface:surfaceId => core.request({schema:'surface_request/v0.2',op:'destroy',params:{surface_id:surfaceId}}),
    async request(request) {
      calls.push(request.op);
      if (request.op === 'destroy') {
        if (failedStop) return {schema:'surface_event/v0.2',event:'error'};
        const surface = {...states.get(request.params.surface_id),state:'destroyed'};
        states.set(surface.surface_id,surface);
        return {schema:'surface_event/v0.2',event:'state_changed',data:{surface}};
      }
      if (failedCreate) return typeof failedCreate === 'object' ? failedCreate : {schema:'surface_event/v0.2',event:'error'};
      const mode = JSON.parse(await readFile(join(root,'opening-modes/demo.json'),'utf8'));
      assert.equal(mode.profile_id,'demo'); stage = mode.mode; stageModes.push(stage);
      const surface = {surface_id:'surface-'+(++next),profile_id:'demo',state:'active',control:stage,geometry:{w:1280,h:900}};
      states.set(surface.surface_id,surface);
      await mkdir(join(root,'human-bindings'),{mode:0o700,recursive:true});
      await writeFile(join(root,'human-bindings',surface.surface_id+'.json'),JSON.stringify({schema:'metaviewer.human_binding/v0.3',surface_id:surface.surface_id,profile_id:'demo',role:stage,control_ready:true,width:1280,height:900,container:'srf-id-demo',run_id:'run-'+next}),{mode:0o600});
      return {schema:'surface_event/v0.2',event:'created',data:{surface}};
    },
  };
  const host = installRoleHost({electron:{ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)}},window:parent,env,capsuleStates:states,core,admit:()=>true,
    keyboardLayout:async()=>'es',listIdentities:async()=>({ok:true,rows:[{id:'demo',logged_in:'yes',last_login_unix:123}]}),
    mode:async()=>true,bridgeFactory:async()=>({close:async()=>{calls.push('bridge-close');}}),
    tileFactory:async()=>({close:async()=>{calls.push('tile-close');},resize(){},setVisible(){}})});
  t.after(()=>host.dispose());
  const request = (op,body={}) => handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op,...body});
  return {root,request,states,calls,stageModes,set failStop(value){failedStop=value;},set failCreate(value){failedCreate=value;}};
}

test('P18 opening mode overrides legacy default; duplicate modes refuse; same-mode open reveals',async t=>{
  const f = await fixture(t,'human');
  const [choice] = await f.request('choices');
  assert.equal(choice.defaultMode,'human'); assert.equal(choice.currentMode,'closed');
  const opened = await f.request('create',{choice:{profileId:'demo',role:'agent'}});
  assert.equal(opened.ok,true); assert.deepEqual(f.stageModes,['agent']);
  assert.deepEqual(await f.request('open',{choice:{profileId:'demo',role:'agent'}}),{ok:true,reused:true,surfaceId:opened.surfaceId,role:'agent'});
  const refused = await f.request('open',{choice:{profileId:'demo',role:'human'}});
  assert.equal(refused.code,'PROFILE_ALREADY_BOUND'); assert.equal(refused.surfaceId,opened.surfaceId);
  assert.equal((await f.request('create',{choice:{profileId:'demo',role:'human'}})).code,'PROFILE_ALREADY_BOUND');
  assert.deepEqual(f.calls,['create']);
});

test('P18 absent legacy default is agent; every profile is offered in either mode',async t=>{
  const f = await fixture(t);
  assert.equal((await f.request('choices'))[0].defaultMode,'agent');
  assert.equal((await f.request('create',{choice:{profileId:'demo',role:'human'}})).ok,true);
  assert.deepEqual(f.stageModes,['human']);
});

test('P18 switch closes view then destroys before fresh create and retains identity',async t=>{
  const f = await fixture(t);
  const initial = await f.request('create',{choice:{profileId:'demo',role:'human'}});
  const lifecycle = await f.request('surfaces');
  assert.equal(lifecycle.length,1);assert.equal(lifecycle[0].schema,'metaviewer.role_surface/v0.3');
  assert.equal(lifecycle[0].surface.surface_id,initial.surfaceId);assert.equal(lifecycle[0].frame_ref,undefined);
  assert.equal((await f.request('mount',{surfaceId:initial.surfaceId,bounds})).ok,true);
  const switched = await f.request('switch',{surfaceId:initial.surfaceId});
  assert.equal(switched.ok,true); assert.notEqual(switched.surfaceId,initial.surfaceId); assert.equal(switched.role,'agent');
  assert.deepEqual(f.calls,['create','tile-close','bridge-close','destroy','create']);
  assert.deepEqual(f.stageModes,['human','agent']);
  assert.equal(f.states.get(initial.surfaceId).state,'destroyed');
  assert.equal([...f.states.values()].filter(s=>s.state==='active').length,1);
  assert.equal((await f.request('choices'))[0].currentMode,'agent');
  assert.deepEqual(await f.request('surfaces'),[]);
});

test('P18 failed stop never starts replacement; failed replacement leaves identity closed',async t=>{
  const f = await fixture(t);
  const initial = await f.request('create',{choice:{profileId:'demo',role:'human'}});
  f.failStop = true;
  assert.equal((await f.request('switch',{surfaceId:initial.surfaceId})).code,'CAPSULE_STOP_UNPROVEN');
  assert.deepEqual(f.calls,['create','destroy']);
  f.failStop = false; f.failCreate = true;
  assert.equal((await f.request('switch',{surfaceId:initial.surfaceId})).code,'SURFACE_CREATE_REFUSED');
  assert.equal((await f.request('choices'))[0].currentMode,'closed');
  assert.equal([...f.states.values()].filter(s=>s.state==='active').length,0);
});

test('P18 R2 destroy acknowledgement then create preserves the adapter fault code',async t=>{
  const f = await fixture(t);
  const initial = await f.request('create',{choice:{profileId:'demo',role:'human'}});
  f.failCreate = {schema:'surface_event/v0.2',event:'error',data:{surface_id:'replacement',code:'frame',detail:'native frame allocation mismatch'}};
  assert.deepEqual(await f.request('switch',{surfaceId:initial.surfaceId}),{ok:false,code:'ADAPTER_FRAME'});
  assert.deepEqual(f.calls,['create','destroy','create']);
  assert.equal(f.states.get(initial.surfaceId).state,'destroyed');
  assert.equal((await f.request('choices'))[0].currentMode,'closed');
});

test('P18 R2 create refusals map fixed adapter faults and withhold arbitrary diagnostics',()=>{
  const lines = [], prior = console.info; console.info = line => lines.push(line);
  try {
    for (const [code,detail,wanted] of [
      ['binding','profile already bound','PROFILE_ALREADY_BOUND'],
      ['uncertain','surface capacity or unresolved native outcome','SURFACE_CAPACITY_OR_QUARANTINE'],
      ['configuration','human mode requires 1280x900 browser','ADAPTER_CONFIGURATION'],
      ['profile','unadmitted profile, kind or geometry','ADAPTER_PROFILE'],
      ['frame','native frame allocation mismatch','ADAPTER_FRAME'],
      ['ADAPTER_FRAME','private-identity-data','ADAPTER_FRAME'],
    ]) assert.equal(surfaceCreateRefusal({data:{code,detail}}),wanted);
    assert.equal(lines.at(-1),'METAVIEWER_SURFACE_CREATE_REFUSED code=ADAPTER_FRAME detail=withheld');
    assert(!lines.join('\n').includes('private-identity-data'));
  } finally { console.info = prior; }
});

test('P18 last login is absent until explicit human operator confirmation',async t=>{
  const f = await fixture(t);
  assert.equal((await f.request('choices'))[0].lastLogin,null);
  let opened = await f.request('create',{choice:{profileId:'demo',role:'agent'}});
  assert.equal((await f.request('confirm-login',{surfaceId:opened.surfaceId})).code,'LOGIN_CONFIRMATION_REQUIRES_HUMAN');
  assert.equal((await f.request('choices'))[0].lastLogin,null);
  opened = await f.request('switch',{surfaceId:opened.surfaceId});
  assert.equal((await f.request('choices'))[0].lastLogin,null);
  const confirmed = await f.request('confirm-login',{surfaceId:opened.surfaceId});
  assert.equal(confirmed.ok,true); assert(confirmed.lastLogin > 0);
  assert.equal((await f.request('choices'))[0].lastLogin,confirmed.lastLogin);
  await f.request('stop',{surfaceId:opened.surfaceId});
  assert.equal((await f.request('choices'))[0].lastLogin,confirmed.lastLogin);
});

test('P18 trace destination is per identity and cannot traverse or follow a symlink',async t=>{
  const directory = await mkdtemp(join(tmpdir(),'p18-trace-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const trace = createHumanTraceFile({directory,profileId:'demo',sessionId:'session',surfaceId:'surface',capsuleId:'capsule'});
  assert.equal(trace.path.split('/').at(-2),'demo'); assert.match(trace.path,/human-trace-[a-f0-9-]+\.jsonl$/); trace.close();
  assert.throws(()=>createHumanTraceFile({directory,profileId:'../other',sessionId:'session',surfaceId:'surface',capsuleId:'capsule'}),/PROFILE/);
});

test('P18 opening mode request is exclusive and private; malformed modes never stage',async t=>{
  const root = await mkdtemp(join(tmpdir(),'p18-stage-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const clear = await stageOpeningMode(root,'demo','human');
  await assert.rejects(stageOpeningMode(root,'demo','agent'),/EEXIST/);
  assert.equal(JSON.parse(await readFile(join(root,'opening-modes/demo.json'))).mode,'human');
  await clear(); assert.deepEqual(await readdir(join(root,'opening-modes')),[]);
  await assert.rejects(stageOpeningMode(root,'demo','shared'),/INVALID/);
});

test('P18 native human path never invokes the agent Control builder, even before role resolves',async()=>{
  const start = appSource.indexOf('function applyWallControl('), end = appSource.indexOf('\n/** Feed reconcile:',start);
  let built = 0, armed = 0;
  const context = {nestedMode:{displayOnly:false},rows:{value:[{id:'human',control:'human'}]},capsuleModes:{value:{}},
    globalThis:{metaviewerRoles:{status:async()=>({role:'human'})}},
    onCapsuleMode:event=>{context.capsuleModes.value[event.surfaceId]=event.mode;},armWallInput:()=>armed++,disarmWallInput(){},
    props:{runtime:{intentBuilders:{control(){built++;throw Error('intent builder must not run');}}}},hostOutcome:{value:null}};
  vm.runInNewContext(appSource.slice(start,end)+'\napplyWallControl("human","release_control");',context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(built,0); assert.equal(armed,0); assert.equal(context.hostOutcome.value,null);
});

test('P18 host XKB layout is explicitly forwarded to the native client',()=>{
  assert.equal(new URLSearchParams(xpraClientQuery(true,'es')).get('keyboard_layout'),'es');
  assert.equal(new URLSearchParams(xpraClientQuery(false,'us')).get('keyboard_layout'),'us');
  assert.throws(()=>xpraClientQuery(true,'es&readonly=0'),/KEYMAP/);
});

test('P18 exact presets use tabs and reserve every grid cell',()=>{
  const tiles = Array.from({length:4},(_,i)=>({id:String(i)}));
  for (const preset of ['single','side-by-side','focus-strip']) assert.deepEqual(wall.presetRectangles(preset,tiles.slice(0,1),1000,800),[{id:'0',x:0,y:0,width:1000,height:800}]);
  assert.deepEqual(wall.presetRectangles('side-by-side',tiles,1000,800).map(r=>[r.x,r.y,r.width,r.height]),[[0,0,500,800],[500,0,500,800],[500,0,500,800],[500,0,500,800]]);
  assert.deepEqual(wall.presetRectangles('grid',tiles,1000,800),[{id:'0',x:0,y:0,width:500,height:400},{id:'1',x:500,y:0,width:500,height:400},{id:'2',x:0,y:400,width:500,height:400},{id:'3',x:500,y:400,width:500,height:400}]);
  assert.deepEqual(wall.presetRectangles('single',tiles.slice(0,2),1000,800).map(r=>[r.x,r.y,r.width,r.height]),[[0,0,1000,800],[0,0,1000,800]]);
  assert.deepEqual(wall.presetRectangles('single',tiles,1000,800).map(r=>[r.x,r.y,r.width,r.height]),Array.from({length:4},()=>[0,0,1000,800]));
  assert.deepEqual(wall.presetRectangles('focus-strip',tiles.slice(0,2),1000,800).map(r=>[r.x,r.y,r.width,r.height]),[[0,0,700,800],[700,0,300,800]]);
  assert.deepEqual(wall.presetRectangles('focus-strip',tiles,1000,900).map(r=>[r.x,r.y,r.width,r.height]),[[0,0,700,900],[700,0,300,300],[700,300,300,300],[700,600,300,300]]);
  assert.deepEqual(wall.presetRectangles('floating',tiles,1000,800).map(r=>[r.x,r.y,r.width,r.height]),[[0,0,600,480],[24,24,600,480],[48,48,600,480],[72,72,600,480]]);
});

test('P18 hidden tiles stay excluded; presets arrange floats too; maximize defers layout',()=>{
  const tiles = [{id:'a'},{id:'b',hidden:true},{id:'c',floating:true}];
  assert.deepEqual(wall.presetRectangles('grid',tiles,1000,800),[{id:'a',x:0,y:0,width:500,height:400},{id:'c',x:500,y:0,width:500,height:400}]);
  tiles[1].hidden = false;
  assert.deepEqual(wall.presetRectangles('grid',tiles,1000,800).map(r=>r.width),[500,500,500]);
  tiles[0].maximized = true;
  assert.deepEqual(wall.presetRectangles('grid',tiles,1000,800),[]);
});

test('P18 preset serialization preserves hidden records and passes the real kit decoder',()=>{
  const profile = structuredClone(createWallLayout(SCOPE,[{id:'a'},{id:'b'},{id:'c'},{id:'d'}]));
  const tiles = ['a','b','c','d'].map(id=>({id:'panel-'+id,hidden:id==='b'}));
  profile.dockview.panels['panel-b'].params.viewMode = 'window-hidden:'+JSON.stringify({groupId:'wall-group-1',index:0,viewMode:null,floating:null});
  for (const preset of wall.TILE_PRESETS) {
    const layout = wall.arrangePreset(profile.dockview,preset,tiles,1000,800);
    const next = {...profile,dockview:layout};
    const decoded = decodeAndMigrateLayoutProfile(next,{expectedScope:SCOPE});
    assert.equal(decoded.ok,true,decoded.reason);
    assert.deepEqual(layout.panels['panel-b'],profile.dockview.panels['panel-b']);
  }
});
