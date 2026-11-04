import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {configuredVMProfiles,configuredProfiles,acquireCapsuleCreation} from '../electron/profilePicker.js';
import {installAuthorityWire,WIRE_CHANNELS} from '../electron/authorityWire.js';
import {createPreloadFacade} from '../electron/preload.js';
import {createAuthorityAdapter} from '../src/core/hostAdapters.js';

const profile={Kind:'vm',NativeKind:'vm',Program:'notepad-vm',Width:1280,Height:900,Display:':100',RAMRoot:'/dev/shm/synthetic-vm',default_mode:'agent'};
async function fixture(t,{rows={guest:profile},identities=[{id:'guest',browser:'program'}],memory=async()=>32*1024**3,states=new Map(),surfaceId='surface-created',hostArch='arm64'}={}){
  const dir=await mkdtemp(join(tmpdir(),'vm-create-'));const handlers=new Map(),calls=[];
  const env={XDG_CONFIG_HOME:dir,MV_SRF_PROFILES:JSON.stringify(rows)};
  const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
  const contents={id:9,mainFrame:frame,isDestroyed:()=>false,send(){},postMessage(){}};
  const event={sender:contents,senderFrame:frame};
  let reply=async request=>({schema:'surface_event/v0.2',event:'created',data:{surface:{schema:'surface/v0.2',surface_id:surfaceId,profile_id:request.params.profile_id,kind:request.params.kind,state:'active',control:'agent',visibility:'unfolded',display:':100',geometry:request.params.geometry}}});
  const wire=installAuthorityWire({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},contents,env,argv:[],capsuleStates:states,hostArch,
    listIdentities:async()=>({ok:true,rows:identities}),readFreeMemoryBytes:memory,
    core:{request:async request=>{calls.push(request);return reply(request);}}});
  t.after(async()=>{await wire.dispose();await rm(dir,{recursive:true,force:true});});
  const api=createPreloadFacade({transport:{invoke:(channel,args)=>handlers.get(channel)(event,...structuredClone(args))},bridge:{exposeInMainWorld(){}}});
  return {env,states,calls,handlers,event,contents,wire,api:api.authority,adapter:createAuthorityAdapter(api.authority),respond:fn=>{reply=fn;}};
}

test('VM facade keeps a closed create acknowledgement',async t=>{
  const f=await fixture(t);
  assert.deepEqual(Object.keys(f.api).sort(),['createSurface','intent','propose','subscribeFrames','vmAvailable']);
  assert.equal(Object.keys(WIRE_CHANNELS).length,14);
  assert.equal(WIRE_CHANNELS.slotRequest,'metaviewer:capsule-state.request');
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

test('shared creation flight serializes browser and VM windows at the last slot',async t=>{
  for(const firstKind of ['browser','vm']) await t.test(firstKind,async t=>{
    const states=new Map(Array.from({length:15},(_,i)=>[`old-${i}`,{profile_id:`old-${i}`,state:'active'}]));
    let resume,entered;
    const waiting=new Promise(resolve=>{entered=resolve;});
    const heldMemory=()=>{entered();return new Promise(resolve=>{resume=resolve;});};
    const browser=await fixture(t,{states,surfaceId:'browser-created',rows:{browser:{Kind:'browser',Width:800,Height:600}},identities:[{id:'browser'}],...(firstKind==='browser'?{memory:heldMemory}:{})});
    const guest=await fixture(t,{states,surfaceId:'guest-created',...(firstKind==='vm'?{memory:heldMemory}:{})});
    const first=firstKind==='browser'?browser:guest,second=firstKind==='browser'?guest:browser;
    const create=f=>f===guest?f.api.createSurface({kind:'vm'}):f.api.createSurface();
    const pending=create(first);await waiting;
    assert.deepEqual(await create(second),{ok:false,code:'SURFACE_CREATE_BUSY'});
    assert.equal(first.calls.length+second.calls.length,0,'contention refuses before either dispatch');
    resume(32*1024**3);assert.deepEqual(await pending,{ok:true});
    assert.equal(states.size,16);
    assert.equal((await create(second)).ok,false,'released flight still enforces the full quota');
    assert.equal(second.calls.length,0);
    states.delete('old-0');
    assert.deepEqual(await create(second),{ok:true},'a free slot is admitted after the shared flight releases');
    assert.equal(states.size,16);assert.equal(second.calls.length,1);
  });
});

test('VM honors the same shared lease used by boot and role creation',async t=>{
  const f=await fixture(t);const release=acquireCapsuleCreation(f.states);
  assert.equal(typeof release,'function');
  try {assert.deepEqual(await f.api.createSurface({kind:'vm'}),{ok:false,code:'SURFACE_CREATE_BUSY'});assert.equal(f.calls.length,0);}
  finally {release();}
  assert.deepEqual(await f.api.createSurface({kind:'vm'}),{ok:true});
});

test('VM releases the shared flight on refusals and retains only uncertain reservations',async t=>{
  for(const outcome of ['missing','memory-error','core-error','unknown','malformed']) await t.test(outcome,async t=>{
    const f=await fixture(t,{...(outcome==='missing'?{rows:{}}:{}),...(outcome==='memory-error'?{memory:async()=>{throw new Error('unavailable');}}:{})});
    if(outcome==='core-error')f.respond(async()=>({schema:'surface_event/v0.2',event:'error',data:{code:'REFUSED'}}));
    if(outcome==='unknown')f.respond(async()=>{throw new Error('unknown dispatch');});
    if(outcome==='malformed')f.respond(async()=>({schema:'surface_event/v0.2',event:'created',data:{}}));
    assert.equal((await f.api.createSurface({kind:'vm'})).ok,false);
    const uncertain=outcome==='unknown'||outcome==='malformed';
    assert.equal(f.states.has('pending:guest'),uncertain);
    const release=acquireCapsuleCreation(f.states);assert.equal(typeof release,'function','every exit releases the shared flight');release();
    const browser=await fixture(t,{states:f.states,rows:{browser:{Kind:'browser',Width:800,Height:600}},identities:[{id:'browser'}],surfaceId:'browser-created'});
    assert.deepEqual(await browser.api.createSurface(),{ok:true});
    assert.equal(f.states.has('pending:guest'),uncertain,'other creation cannot erase an uncertain VM reservation');
    if(uncertain){assert.equal((await f.api.createSurface({kind:'vm'})).ok,false);assert.equal(f.calls.length,1,'uncertain VM dispatch cannot replay');}
  });
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


test('catalog offers VM only for configured ARM64; direct x64 creation still refuses', async t => {
  const { availableCatalogKindIds } = await import('../src/catalog/catalogModel.js');
  const base = ['identity-browser', 'program', 'host-program', 'desktop-window'];
  for (const [hostArch, rows, offered] of [['x64', {guest:profile}, false], ['arm64', {}, false], ['arm64', {guest:profile}, true]]) {
    await t.test(`${hostArch} configured=${Object.keys(rows).length > 0}`, async t => {
      const f = await fixture(t, {hostArch, rows});
      assert.deepEqual(availableCatalogKindIds(await f.adapter.vmAvailable()), offered ? [...base, 'vm'] : base);
      assert.equal(f.calls.length, 0, 'availability never creates a surface');
      if (hostArch === 'x64') {
        assert.deepEqual(await f.api.createSurface({kind:'vm'}), {ok:false, code:'VM_UNAVAILABLE'});
        assert.equal(f.calls.length, 0);
      }
    });
  }
});


test('VM availability fails closed across absent, failed and malformed hosts', async () => {
  const { availableCatalogKindIds } = await import('../src/catalog/catalogModel.js');
  for (const port of [null, {}, {vmAvailable:async()=>{throw Error('unavailable');}}, ...[undefined, null, 1, 'true', {ok:true}].map(value=>({vmAvailable:async()=>value}))]) {
    assert.equal(availableCatalogKindIds(await createAuthorityAdapter(port).vmAvailable()).includes('vm'), false);
  }
  for (const reply of [undefined, null, 1, 'true', {ok:true}]) {
    const facade = createPreloadFacade({transport:{invoke:async()=>reply},bridge:{exposeInMainWorld(){}}});
    await assert.rejects(facade.authority.vmAvailable(), /VM availability/);
    assert.equal(await createAuthorityAdapter(facade.authority).vmAvailable(), false);
  }
  const facade = createPreloadFacade({transport:{invoke:async()=>true},bridge:{exposeInMainWorld(){}}});
  await assert.rejects(async()=>facade.authority.vmAvailable('extra'), /arity/);
});

test('App refreshes availability on opening and rejects stale replies; launcher defaults hidden', async () => {
  const {ref, watch, computed} = await import('vue');
  const {availableCatalogKindIds, CATALOG_KIND_IDS, normalizeCatalogEntries} = await import('../src/catalog/catalogModel.js');
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
  const start = app.indexOf('const vmAvailable = ref(false);');
  const end = app.indexOf("}, { immediate: true, flush: 'sync' });", start);
  assert.ok(start >= 0 && end > start);
  const launcherOpen = ref(false);
  let resolve;
  const props = {authorityHost:{vmAvailable:()=>new Promise(done=>{resolve=done;})}};
  const available = vm.runInNewContext(app.slice(start, end + "}, { immediate: true, flush: 'sync' });".length) + '\nvmAvailable;', {ref, watch, props, launcherOpen});
  assert.equal(available.value, false);
  launcherOpen.value = true;
  assert.equal(available.value, false);
  launcherOpen.value = false;
  resolve(true); await new Promise(done=>setImmediate(done));
  assert.equal(available.value, false, 'closed launcher ignores a late positive answer');
  launcherOpen.value = true;
  resolve(true); await new Promise(done=>setImmediate(done));
  assert.equal(available.value, true);
  launcherOpen.value = false;
  props.authorityHost.vmAvailable = async()=>{throw Error('offline');};
  launcherOpen.value = true; await new Promise(done=>setImmediate(done));
  assert.equal(available.value, false);
  launcherOpen.value = false;
  props.authorityHost = null;
  launcherOpen.value = true; await new Promise(done=>setImmediate(done));
  assert.equal(available.value, false);
  assert.match(app, /<CatalogLauncher[^>]*:vm-available="vmAvailable"/);

  const launcher = await readFile(new URL('../src/catalog/CatalogLauncher.vue', import.meta.url), 'utf8');
  assert.match(launcher, /vmAvailable: \{ type: Boolean, default: false \}/);
  const expression = launcher.match(/const dialogTypes = computed\(\(\) => (.+)\);/)[1];
  for (const vmAvailable of [undefined, false, true]) {
    for (const kinds of [CATALOG_KIND_IDS, CATALOG_KIND_IDS.map(kind=>({kind}))]) {
      const types = vm.runInNewContext(expression, {normalized:{value:normalizeCatalogEntries(kinds)}, availableCatalogKindIds, props:{vmAvailable}});
      assert.deepEqual([...types].map(type=>type.id), [...availableCatalogKindIds(vmAvailable)]);
    }
  }
});
