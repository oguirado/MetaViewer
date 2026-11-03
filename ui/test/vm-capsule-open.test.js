import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {configuredVMProfiles,configuredProfiles} from '../electron/profilePicker.js';
import {installAuthorityWire,WIRE_CHANNELS} from '../electron/authorityWire.js';
import {createPreloadFacade} from '../electron/preload.js';
import {createAuthorityAdapter} from '../src/core/hostAdapters.js';

const profile={Kind:'vm',NativeKind:'vm',Program:'notepad-vm',Width:1280,Height:900,Display:':100',RAMRoot:'/dev/shm/synthetic-vm',default_mode:'agent'};
async function fixture(t,{rows={guest:profile},identities=[{id:'guest',browser:'program'}],memory=async()=>32*1024**3}={}){
  const dir=await mkdtemp(join(tmpdir(),'vm-create-'));const handlers=new Map(),calls=[],states=new Map();
  const env={XDG_CONFIG_HOME:dir,MV_SRF_PROFILES:JSON.stringify(rows)};
  const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
  const contents={id:9,mainFrame:frame,isDestroyed:()=>false,send(){},postMessage(){}};
  const event={sender:contents,senderFrame:frame};
  let reply=async request=>({schema:'surface_event/v0.2',event:'created',data:{surface:{schema:'surface/v0.2',surface_id:'surface-created',profile_id:request.params.profile_id,kind:request.params.kind,state:'active',control:'agent',visibility:'unfolded',display:':100',geometry:request.params.geometry}}});
  const wire=installAuthorityWire({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},contents,env,argv:[],capsuleStates:states,hostArch:'arm64',
    listIdentities:async()=>({ok:true,rows:identities}),readFreeMemoryBytes:memory,
    core:{request:async request=>{calls.push(request);return reply(request);}}});
  t.after(async()=>{await wire.dispose();await rm(dir,{recursive:true,force:true});});
  const api=createPreloadFacade({transport:{invoke:(channel,args)=>handlers.get(channel)(event,...structuredClone(args))},bridge:{exposeInMainWorld(){}}});
  return {env,states,calls,handlers,event,contents,wire,api:api.authority,adapter:createAuthorityAdapter(api.authority),respond:fn=>{reply=fn;}};
}

test('VM uses only existing facade methods and channel with closed acknowledgement',async t=>{
  const f=await fixture(t);
  assert.deepEqual(Object.keys(f.api).sort(),['createSurface','intent','propose','subscribeFrames']);
  assert.equal(Object.keys(WIRE_CHANNELS).length,12);
  assert.deepEqual(await f.api.createSurface({kind:'vm'}),{ok:true});
  assert.deepEqual(f.calls,[{schema:'surface_request/v0.2',op:'create',params:{kind:'vm',profile_id:'guest',geometry:{w:1280,h:900}}}]);
  assert.equal((await f.api.createSurface({kind:'vm'})).ok,false);assert.equal(f.calls.length,1);
});

test('zero-argument browser selection remains unchanged and missing VM never falls back',async t=>{
  const rows={browser:{Kind:'browser',Width:800,Height:600}};
  const f=await fixture(t,{rows,identities:[{id:'browser'}]});
  assert.deepEqual(configuredProfiles(f.env).map(p=>p.id),['browser']);
  assert.equal((await f.api.createSurface({kind:'vm'})).ok,false);assert.equal(f.calls.length,0);
  assert.deepEqual(await f.api.createSurface(),{ok:true});assert.equal(f.calls[0].params.kind,'browser');
});

test('VM selector rejects arbitrary providers, profiles, image paths and foreign callers',async t=>{
  const f=await fixture(t);
  for(const selector of [{kind:'browser'},{kind:'vm',profile_id:'guest'},{kind:'vm',image:'arbitrary'},
    {kind:'vm',binary:'x'}, {kind:'vm',provider:'x'}, {kind:'vm',path:'/tmp/x'}, {},null,'vm']){
    await assert.rejects(f.api.createSurface(selector),/arity/);
    await assert.rejects(f.handlers.get(WIRE_CHANNELS.createSurface)(f.event,selector),/ARGS/);
  }
  await assert.rejects(f.api.createSurface({kind:'vm'},{}),/arity/);
  await assert.rejects(f.handlers.get(WIRE_CHANNELS.createSurface)({...f.event,sender:{...f.contents}},{kind:'vm'}),/SENDER/);
  assert.equal(f.calls.length,0);
});

test('VM template is explicit, unique, owned and agent-only',async t=>{
  assert.equal(configuredVMProfiles({MV_SRF_PROFILES:JSON.stringify({guest:profile})},'x64').length,0);
  for(const rows of [{},{guest:{...profile,Program:'other'}},{guest:{...profile,default_mode:'human'}},
    {guest:{...profile,RAMRoot:undefined}},{guest:profile,other:profile},{'srf-pg-foreign':profile}]){
    const f=await fixture(t,{rows,identities:[{id:'guest',browser:'program'},{id:'other',browser:'program'},{id:'srf-pg-foreign',browser:'program'}]});
    assert.equal((await f.api.createSurface({kind:'vm'})).ok,false);assert.equal(f.calls.length,0);
  }
});

test('VM rechecks after deferred memory and preserves uncertain creation reservation',async t=>{
  for(const mode of ['removed','changed','full','bound','unknown-memory','unchanged']){
    await t.test(mode,async t=>{
      let release;const f=await fixture(t,{memory:()=>new Promise(resolve=>{release=resolve;})});
      const creating=f.api.createSurface({kind:'vm'});
      while(!release) await new Promise(resolve=>setImmediate(resolve));
      if(mode==='removed')f.env.MV_SRF_PROFILES='{}';
      if(mode==='changed')f.env.MV_SRF_PROFILES=JSON.stringify({guest:{...profile,Width:1024}});
      if(mode==='full')for(let i=0;i<16;i++)f.states.set(`other-${i}`,{profile_id:`other-${i}`,state:'active'});
      if(mode==='bound')f.states.set('another',{profile_id:'guest',state:'active'});
      release(mode==='unknown-memory'?null:32*1024**3);
      const result=await creating;
      assert.equal(result.ok,mode==='unchanged');assert.equal(f.calls.length,mode==='unchanged'?1:0);
    });
  }
  const f=await fixture(t);f.respond(async()=>{throw new Error('delivery unknown');});
  assert.deepEqual(await f.api.createSurface({kind:'vm'}),{ok:false,code:'VM_CREATE_UNCERTAIN'});
  assert.equal(f.states.get('pending:guest').state,'creating');
  assert.equal((await f.api.createSurface({kind:'vm'})).ok,false);assert.equal(f.calls.length,1);
});

test('App cold VM create goes through existing adapter without new dialog or optimistic tile',async t=>{
  const f=await fixture(t);const source=await readFile(new URL('../src/App.vue',import.meta.url),'utf8');
  const {parse,compileScript}=await import('@vue/compiler-sfc');
  const {descriptor}=parse(source);
  const statement=compileScript(descriptor,{id:'vm-cold-create'}).scriptSetupAst.find(node=>node.type==='FunctionDeclaration' && node.id?.name==='onCreateCapsule');
  assert.ok(statement && Number.isInteger(statement.start) && Number.isInteger(statement.end));
  const functionSource=descriptor.scriptSetup.content.slice(statement.start,statement.end);
  const jobs=[];
  const open=vm.runInNewContext(functionSource+'\nonCreateCapsule;',{
    props:{authorityHost:f.adapter},nestedMode:{displayOnly:false},
    submitHost:action=>{const job=Promise.resolve().then(action);jobs.push(job);return job;},
  });
  open({type:'create-capsule',kind:'vm',placement:'tab'});await Promise.all(jobs);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.kind,'vm');
  assert.equal(f.states.get('surface-created').kind,'vm');
});
