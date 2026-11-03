import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuthorityAdapter} from '../src/core/hostAdapters.js';
import {configuredVMProfiles,configuredProfiles} from '../electron/profilePicker.js';
import {installAuthorityWire,WIRE_CHANNELS} from '../electron/authorityWire.js';
import {createPreloadFacade} from '../electron/preload.js';
import {resolveCatalogKind,buildCreateIntent} from '../src/catalog/catalogModel.js';

const profile={Kind:'vm',NativeKind:'vm',Program:'notepad-vm',Width:1280,Height:720,RAMRoot:'/dev/shm/synthetic-vm',Display:':100'};
const envFor=(rows={guest:profile})=>({MV_SRF_PROFILES:JSON.stringify(rows)});

test('VM configuration has no default and keeps browser picker unchanged',()=>{
  assert.equal(configuredVMProfiles(envFor(),'arm64')[0].request.params.kind,'vm');
  assert.equal(configuredVMProfiles(envFor(),'x64').length,0);
  for(const env of [{},envFor({}),{MV_SRF_PROFILES:'{'},envFor({guest:{...profile,Width:undefined}}),envFor({guest:{...profile,RAMRoot:undefined}}),envFor({guest:{...profile,Display:undefined}}),envFor({guest:{...profile,NativeKind:'program'}}),envFor({guest:{...profile,Program:'arbitrary'}})]){
    assert.equal(configuredVMProfiles(env,'arm64').length,0);
  }
  const mixed=envFor({guest:profile,browser:{Kind:'browser',Width:800,Height:600}});
  assert.deepEqual(configuredProfiles(mixed).map(p=>p.id),['browser']);
  assert.match(resolveCatalogKind('vm').type.label,/ARM64/);
  assert.equal(buildCreateIntent({kind:'vm'}).intent.kind,'vm');
});

async function fixture(t,{rows={guest:profile},identities=[{id:'guest',browser:'program'}],free=32*1024**3,argv=[]}={}){
  const dir=await mkdtemp(join(tmpdir(),'vm-ui-test-')); const handlers=new Map(),calls=[];
  const env={XDG_CONFIG_HOME:dir,...envFor(rows)};
  const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
  const contents={id:91,mainFrame:frame,isDestroyed:()=>false,send(){},postMessage(){}};
  const event={sender:contents,senderFrame:frame}; const states=new Map();
  let respond=async request=>({schema:'surface_event/v0.2',event:'created',data:{surface:{schema:'surface/v0.2',surface_id:'surface-vm',profile_id:request.params.profile_id,kind:'vm',state:'active',control:'idle',visibility:'unfolded',display:':100',geometry:request.params.geometry}}});
  const wire=installAuthorityWire({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},contents,argv,env,capsuleStates:states,
    listIdentities:async()=>({ok:true,rows:identities}),readFreeMemoryBytes:typeof free === 'function' ? free : async()=>free,
    core:{request:async request=>{calls.push(request);return respond(request);}}});
  t.after(async()=>{await wire.dispose();await rm(dir,{recursive:true,force:true});});
  const invoke=(name,...args)=>handlers.get(WIRE_CHANNELS[name])(event,...args);
  const api=createPreloadFacade({transport:{invoke:(channel,args)=>handlers.get(channel)(event,...args)},bridge:{exposeInMainWorld(){}}});
  return {api:api.authority,adapter:createAuthorityAdapter(api.authority),env,invoke,calls,states,handlers,event,contents,respond:fn=>{respond=fn;}};
}

test('opaque VM choice crosses preload and creates exact host-owned request once',async t=>{
  const f=await fixture(t); const listed=await f.adapter.listVMCapsules();
  assert.equal(listed.ok,true);assert.equal(listed.choices.length,1);
  assert.deepEqual(Object.keys(listed.choices[0]).sort(),['choiceId','label']);
  assert.ok(!JSON.stringify(listed).includes('guest'));
  const selected={choiceId:listed.choices[0].choiceId};
  assert.deepEqual(await f.adapter.createVMCapsule(selected),{ok:true,surfaceId:'surface-vm'});
  assert.deepEqual(f.calls,[{schema:'surface_request/v0.2',op:'create',params:{kind:'vm',profile_id:'guest',geometry:{w:1280,h:720}}}]);
  assert.equal((await f.api.createVMCapsule(selected)).ok,false);assert.equal(f.calls.length,1);
  assert.equal((await f.api.listVMCapsules()).ok,false);
});

test('renderer profiles/images/commands and foreign windows cannot create a VM',async t=>{
  const f=await fixture(t);const l=await f.api.listVMCapsules();const choiceId=l.choices[0].choiceId;
  for(const extra of [{profile_id:'guest'},{image:'foreign'},{binary:'shell'},{kind:'vm'}]){
    await assert.rejects(f.api.createVMCapsule({choiceId,...extra}),/VM choice/);
    assert.equal((await f.invoke('createVMCapsule',{choiceId,...extra})).ok,false);
    assert.deepEqual(await f.adapter.createVMCapsule({choiceId,...extra}),{ok:false,code:'VM_CHOICE_INVALID'});
  }
  await assert.rejects(f.api.listVMCapsules('extra'),/arity/);
  await assert.rejects(f.api.createSurface({kind:'vm'}),/arity/);
  await assert.rejects(f.handlers.get(WIRE_CHANNELS.createVMCapsule)({...f.event,sender:{...f.contents}},{choiceId}),/SENDER/);
  const other=await fixture(t);assert.equal((await other.invoke('createVMCapsule',{choiceId})).ok,false);
  assert.equal(f.calls.length,0);assert.equal(other.calls.length,0);
});

test('missing identity, memory, nested mode and changed configuration refuse before core',async t=>{
  for(const opts of [{identities:[]},{free:null},{free:0},{argv:['--nested-depth=1']}]){
    const f=await fixture(t,opts);const l=await f.api.listVMCapsules();
    if(l.ok) assert.equal((await f.api.createVMCapsule({choiceId:l.choices[0].choiceId})).ok,false);
    else assert.equal(l.ok,false);
    assert.equal(f.calls.length,0);
  }
  const foreign=await fixture(t,{rows:{'srf-pg-foreign':profile},identities:[{id:'srf-pg-foreign',browser:'program'}]});
  assert.equal((await foreign.api.listVMCapsules()).ok,false);assert.equal(foreign.calls.length,0);
  const f=await fixture(t);const l=await f.api.listVMCapsules();
  f.env.MV_SRF_PROFILES=JSON.stringify({guest:{...profile,RAMRoot:'/dev/shm/replaced'}});
  assert.equal((await f.api.createVMCapsule({choiceId:l.choices[0].choiceId})).ok,false);assert.equal(f.calls.length,0);
});

test('busy and uncertain VM creation retain ownership without automatic replay',async t=>{
  const f=await fixture(t);const l=await f.api.listVMCapsules();const choice={choiceId:l.choices[0].choiceId};
  let finish;f.respond(()=>new Promise(resolve=>{finish=resolve;}));
  const opening=f.api.createVMCapsule(choice);
  while(!finish) await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await f.api.createVMCapsule(choice),{ok:false,code:'SURFACE_CREATE_BUSY'});
  finish({schema:'surface_event/v0.2',event:'created',data:{surface:{kind:'browser'}}});
  assert.deepEqual(await opening,{ok:false,code:'VM_CREATE_UNCERTAIN'});
  assert.equal(f.states.get('pending:guest').state,'creating');assert.equal(f.calls.length,1);
  assert.equal((await f.api.listVMCapsules()).ok,false);
});

test('preload refuses fabricated VM result shapes',async()=>{
  for(const reply of [{ok:true,surfaceId:'s',image:'bad'},{ok:true,choices:[{choiceId:'a'.repeat(36),label:'ARM64 Linux desktop VM',profileId:'bad'}]}]){
    const api=createPreloadFacade({transport:{invoke:async()=>reply},bridge:{exposeInMainWorld(){}}});
    await assert.rejects(reply.choices?api.authority.listVMCapsules():api.authority.createVMCapsule({choiceId:'a'.repeat(36)}),/VM capsule/);
  }
});

// Exercise the actual launcher setup, without a browser or guest process.
test('launcher opens only a host-issued VM choice and preserves refusal',async()=>{
  const vue=await import('vue');
  const {parse,compileScript}=await import('@vue/compiler-sfc');
  const {readFile}=await import('node:fs/promises');
  const {createRequire}=await import('node:module');
  const {pathToFileURL}=await import('node:url');
  const req=createRequire(import.meta.url);
  const source=await readFile(new URL('../src/catalog/CatalogLauncher.vue',import.meta.url),'utf8');
  const {descriptor}=parse(source);
  let code=compileScript(descriptor,{id:'vm-launcher-test'}).content;
  code=code.replace(/from ['"]vue['"]/g,`from ${JSON.stringify(pathToFileURL(req.resolve('vue')).href)}`)
    .replace(/import \{ NewCapsuleDialog \} from [^;]+;/,'const NewCapsuleDialog = {};')
    .replace(/from ['"]\.\/catalogModel.js['"]/g,`from ${JSON.stringify(new URL('../src/catalog/catalogModel.js',import.meta.url).href)}`);
  const component=(await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
  component.render=()=>vue.h('div');
  const renderer=vue.createRenderer({createElement:tag=>({tag,children:[]}),createText:text=>({text}),createComment:text=>({text}),
    insert:(child,parent)=>parent.children.push(child),remove(){},setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){}});
  const choiceId='12345678-1234-1234-1234-123456789abc';const sent=[],closed=[];
  const app=renderer.createApp(component,{visible:true,vmHost:{listVMCapsules:async()=>({ok:true,choices:[{choiceId,label:'ARM64 Linux desktop VM'}]})},
    onCreate:(body,settle)=>{sent.push(body);settle(Promise.resolve({ok:false,code:'VM_UNAVAILABLE'}));},'onUpdate:visible':value=>closed.push(value)});
  app.mount({children:[]});const state=app._instance.setupState;
  await state.onCreate({type:{id:'vm'}});
  assert.equal(state.vmChoice,choiceId);assert.equal(state.choosingVM,true);
  await state.confirmVM();assert.deepEqual(sent,[{kind:'vm',choiceId}]);assert.equal(state.vmError,'VM_UNAVAILABLE');assert.deepEqual(closed,[]);
  app.unmount();
  const unsupported=renderer.createApp(component,{visible:true});unsupported.mount({children:[]});
  const noHost=unsupported._instance.setupState;await noHost.onCreate({type:{id:'vm'}});
  assert.equal(noHost.vmChoices.length,0);assert.equal(noHost.vmError,'VM_UNAVAILABLE');unsupported.unmount();
});


test('VM admission rechecks configuration, capacity and choice after deferred memory',async t=>{
  for (const mode of ['removed','changed','oversized','full','bound','choice-invalidated','unchanged']) {
    await t.test(mode,async t=>{
      let release;
      const f=await fixture(t,{free:()=>new Promise(resolve=>{release=resolve;})});
      const list=await f.api.listVMCapsules();
      const opening=f.api.createVMCapsule({choiceId:list.choices[0].choiceId});
      while(!release) await new Promise(resolve=>setImmediate(resolve));
      if(mode==='removed') f.env.MV_SRF_PROFILES='{}';
      if(mode==='changed') f.env.MV_SRF_PROFILES=JSON.stringify({guest:{...profile,Width:1024}});
      if(mode==='oversized') f.env.MV_SRF_PROFILES=JSON.stringify({guest:profile,extra:'☃'.repeat(400000)});
      if(mode==='full') for(let i=0;i<16;i++) f.states.set(`other-${i}`,{profile_id:`other-${i}`,state:'active'});
      if(mode==='bound') f.states.set('foreign-holder',{profile_id:'guest',state:'active'});
      if(mode==='choice-invalidated') assert.equal((await f.api.listVMCapsules()).code,'SURFACE_CREATE_BUSY');
      release(32*1024**3);
      const result=await opening;
      if(mode==='unchanged') {assert.equal(result.ok,true);assert.equal(f.calls.length,1);}
      else {assert.equal(result.ok,false);assert.equal(f.calls.length,0);assert.equal(f.states.has('pending:guest'),false);}
    });
  }
});
