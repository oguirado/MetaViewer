import {programBinaries} from '../electron/programBinaries.js';
import {createPreloadFacade} from '../electron/preload.js';
import test from 'node:test';
import vm from 'node:vm';
import {parse,compileScript} from '@vue/compiler-sfc';
import {once, EventEmitter} from 'node:events';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {createDisplayPort,DISPLAY_PORT_NOTICE_TYPE,DISPLAY_PORT_NOTICE_SCHEMA} from '../electron/framePort.js';
import {installDisplayPortRouter} from '../src/frames/displayPortRouter.js';
import {attachXpraHumanTile} from '../electron/xpraHumanTile.js';
import {installRoleHost} from '../electron/roleHost.js';
import {createMainBindings} from '../electron/hostBindings.js';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, mkdir, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installAuthorityWire,WIRE_CHANNELS,createSettingsStore} from '../electron/authorityWire.js';
import {summarizeSurfaces, pickProfile, acquireCapsuleCreation, CAPSULE_MEMORY_LIMIT_BYTES, parseMemAvailableBytes} from '../electron/profilePicker.js';
import {PRIVILEGED_ORIGIN, CHANNELS, ELECTRON_PIN, bootProductionMain} from '../electron/main.js';

function wireFixture(t, options = {}) {
  let listener;
  const handlers = new Map();
  const capsuleStates = new Map();
  const frame = {origin:PRIVILEGED_ORIGIN,url:`${PRIVILEGED_ORIGIN}/index.html`};
  const contents = {id:7,mainFrame:frame,isDestroyed:()=>false,postMessage(){}};
  const binding = installAuthorityWire({
    ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},
    contents, core:{request:async()=>true}, env:{}, argv:[], capsuleStates,
    frames:{subscribe:f=>{listener=f;return ()=>{};}}, ...options,
  });
  t.after(()=>binding.dispose());
  return {binding,capsuleStates,emit:entry=>listener(entry),call: name=>handlers.get(WIRE_CHANNELS[name])({sender:contents,senderFrame:frame})};
}

async function bootFixture(t) {
  const baseDir=await mkdtemp(join(tmpdir(),'v027-main-'));
  t.after(()=>rm(baseDir,{recursive:true,force:true}));
  const appListeners=new Map();
  const root = join(baseDir, 'shell');
  const xdg = join(baseDir, 'xdg');
  await mkdir(join(root, 'dist', 'renderer'), {recursive: true});
  await mkdir(join(root, 'dist', 'preload'), {recursive: true});
  await writeFile(join(root, 'dist', 'renderer', 'index.html'), '<!doctype html><title>MetaViewer</title>');
  await writeFile(join(root, 'dist', 'preload', 'preload.cjs'), '"use strict";\n');
  await mkdir(xdg, {recursive: true, mode: 0o700});
  await chmod(xdg, 0o700);
  /** @type {string[]} */
  const calls = [];
  /** @type {Map<string, Function>} */
  const contentsListeners = new Map();
  const webContents = {
    id: 7,
    mainFrame: {url: `${PRIVILEGED_ORIGIN}/index.html`, origin: PRIVILEGED_ORIGIN, parent: null, routingId: 10, processId: 20},
    isDestroyed: () => false,
    session: {setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}},
    setWindowOpenHandler: () => {},
    on: (/** @type {string} */ name, /** @type {Function} */ fn) => { contentsListeners.set(name, fn); },
    setUserAgent: () => {},
    loadURL: async () => {},
    send: () => {},
  };
  class StubWindow {
    constructor() { this.webContents = webContents; }
    once() {}
    show() { calls.push('window.show'); }
    hide() { calls.push('window.hide'); }
    destroy() { calls.push('window.destroy'); }
  }
  const status = {availability: /** @type {const} */ ('live'), pid: 4141, authority_epoch: 1, reason: null};
  const handles = {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      on: (name,fn) => appListeners.set(name,fn),
      quit: () => { calls.push('app.quit'); },
      getAppPath: () => root,
      getPath: () => join(root, 'user-data'),
    },
    BrowserWindow: StubWindow,
    ipcMain: {handle: () => {}, removeHandler: () => {}},
    protocol: {registerSchemesAsPrivileged: () => {}, handle: () => {}, unhandle: () => { calls.push('protocol.unhandle'); }},
    session: {defaultSession: {setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}}},
    electronVersion: ELECTRON_PIN,
    shellRoot: root,
    argv: ['metaviewer'],
    env: {},
    runtime: {xdgRuntimeDir: xdg, uid: typeof process.getuid === 'function' ? process.getuid() : 1000},
    core: {start: async () => status, request: async (/** @type {unknown} */ m) => ({echo: m}),
      dispose: async () => { calls.push('core.dispose'); }, getStatus: () => status},
    bridge: [
      {channel: CHANNELS.load, decode: () => null, invoke: async () => null},
      {channel: CHANNELS.save, decode: (/** @type {unknown} */ v) => v, invoke: async () => true},
    ],
    geometry: {width: 1280, height: 720},
  };
  return {handles, calls, contentsListeners, appListeners, webContents};
}


test('V027-EM01 main renderer crash requests fail-closed quit; foreign renderer does not', async t=>{
  const f=await bootFixture(t);
  const boot=await bootProductionMain(f.handles);
  t.after(()=>boot.dispose());
  const gone=f.appListeners.get('render-process-gone');
  gone({}, {}, {reason:'crashed'});
  assert.equal(f.calls.includes('app.quit'),false);
  gone({},f.webContents,{reason:'crashed'});
  assert.equal(f.calls.includes('app.quit'),true);
});

test('V027-EM02 every quit waits for deferred teardown; only disposal-driven quit passes', async t=>{
  const f=await bootFixture(t);
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  f.handles.core.dispose=async()=>{f.calls.push('core.dispose');await pending;};
  const boot=await bootProductionMain(f.handles);
  t.after(async()=>{finish();await boot.dispose();});
  const quit=f.appListeners.get('will-quit');
  let prevented=0;
  const event={preventDefault:()=>{prevented++;}};
  quit(event);
  quit(event);
  assert.equal(prevented,2);
  assert.equal(f.calls.includes('app.quit'),false);
  finish();
  await boot.dispose();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(x=>x==='app.quit').length,1);
  quit(event);
  assert.equal(prevented,2);
});

const surface = {schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'agent',profile_id:'test'};
const registration = component => ({endpoint:{component,instance:component+'-test'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
async function waitForCondition(predicate, description = 'condition', timeoutMs = 5000) {
  const start = Date.now();
  while (true) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) {
      assert.fail(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function socketFixture(t, {badHello=false,refuseIntent=false,layoutRefusalCode=null}={}) {
  const root=await mkdtemp(join(tmpdir(),'mv-host-'));
  const ram=await mkdtemp('/dev/shm/mv-host-');
  const config={session_id:'host-test',core:registration('core'),peers:[registration('ui')]};
  await mkdir(join(root,'metaviewer'),{mode:0o700});
  const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const bytes=Buffer.from([1,2,3]);const path=join(ram,'frame.rgb');await writeFile(path,bytes,{mode:0o600});
  const frame={schema:'frame_ref/v0.2',surface_id:'s1',generation:1,tick:1,ts_ns:1,width:1,height:1,format:'rgb24',ramws_path:path,sha256:createHash('sha256').update(bytes).digest('hex'),capture_us:1};
  const requests=[],sockets=new Set();let peer,seq=0;
  const send=body=>peer.write(JSON.stringify({schema:'envelope/v0.2',msg_id:'reply-'+(++seq),ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:'nonce-'+seq,body})+'\n');
  const server=createServer(socket=>{peer=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',data=>{
    buffer+=data;let offset;while((offset=buffer.indexOf('\n'))>=0){const env=JSON.parse(buffer.slice(0,offset));buffer=buffer.slice(offset+1);requests.push(env);
      if(env.body.schema==='hello/v0.2')send({...config.core.hello,...(badHello?{component_commit:'b'.repeat(40)}:{})});
      else if(env.body.schema==='surface_request/v0.2') { /* subscription has no reply */ }
      else if(env.body.schema==='ui_intent/v0.2') {
        const extended=['move','tab','float','hide','show'].includes(env.body.op);
        if(refuseIntent) {
          send({schema:'action_verdict/v0.2',proposal_id:env.body.request_id,decision:'refused',reason_code:'POLICY',core_seq:1});
          if(extended && layoutRefusalCode) send({schema:'surface_event/v0.2',event:'error',data:{surface_id:env.body.params.slot_id,code:layoutRefusalCode,detail:env.body.request_id}});
        } else if(extended) send(env.body);
        else send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surface,control:env.body.op==='take_control'?'human':'agent',visibility:env.body.op==='fold'?'folded':'unfolded'}}});
      }
      else if(env.body.schema==='record_request/v0.2') { /* delayed capture reply */ }
      else send({schema:'action_verdict/v0.2',proposal_id:env.body.proposal_id,decision:'refused',reason_code:'POLICY',core_seq:1});
    }
  });});
  server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');await chmod(join(root,'metaviewer/core.sock'),0o600);
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});await rm(ram,{recursive:true,force:true});});
  const messages=[];const channels=[];
  const createMessageChannel=()=>{const port1=new EventEmitter();Object.assign(port1,{postMessage:value=>messages.push(value),start(){},close(){}});const port2={close(){}};channels.push({port1,port2});return {port1,port2};};
  const env={MV_CORE_CONFIG:configPath,XDG_RUNTIME_DIR:root};
  return {env,root,frame,send,requests,messages,channels,createMessageChannel,disconnect:()=>peer.destroy()};
}

test('V027-HB01 capture deadline and its late reply preserve the active session', async t=>{
  const f=await socketFixture(t);
  const bindings=await createMainBindings({env:f.env,createMessageChannel:f.createMessageChannel});
  t.after(()=>bindings.core.dispose());
  await bindings.core.start();
  const states=[];
  bindings.wire.frames.subscribe(entry=>states.push(entry.state));
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  await waitForCondition(()=>states.length);
  const reply=await bindings.core.request({op:'capture',method:'screenshot',request:{schema:'capture_request/v1',request_id:'shot1',surface_id:'s1'}});
  assert.deepEqual(reply,{ok:false,code:'CAPTURE_UNAVAILABLE',request_id:'shot1'});
  assert.equal((await bindings.core.start()).availability,'live');
  const request=f.requests.find(e=>e.body.schema==='record_request/v0.2');
  f.send({schema:'surface_event/v0.2',event:'error',data:{surface_id:'capture',code:'CAPTURE_REPLY',detail:JSON.stringify({method:'screenshot',request_id:request.body.request_id,reply:{ok:false,code:'CAPTURE_UNAVAILABLE',request_id:request.body.request_id}})}});
  assert.equal(await bindings.core.request({op:'intent',json:JSON.stringify({schema:'ui_intent/v0.2',request_id:'still-live',op:'take_control',params:{surface_id:'s1'}})}),true);
  assert.equal(states.at(-1).control,'human');
});

test('V027-HP06 failed native stop does not skip later owned programs and failures are collected', async t=>{
  const root=await mkdtemp(join(tmpdir(),'v027-role-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await chmod(root,0o700);
  const binary=join(root,'program');await writeFile(binary,'');await chmod(binary,0o755);
  const states=new Map(),stopped=[];let handler,seq=0;
  const window=new EventEmitter();window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
  const core={getHumanSurface:id=>states.get(id),async stopSurface(id){stopped.push(id);throw Error('stop failed '+id);},async request(q){
    const surface={schema:'surface/v0.2',surface_id:'surface-'+(++seq),profile_id:q.params.profile_id,state:'active',control:'human',geometry:{w:1280,h:900}};
    states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  }};
  const host=installRoleHost({electron:{ipcMain:{handle(_key,fn){handler=fn;},removeHandler(){}}},window,core,env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:'{}'},capsuleStates:states,admit:()=>true,readFreeMemoryBytes:async()=>8*1024**3,
    listIdentities:async()=>[],provisionProgramIdentity:async()=>{throw Error('unexpected identity provisioning');}});
  t.after(()=>host.dispose().catch(()=>{}));
  for(let i=0;i<2;i++) assert.equal((await handler({}, {schema:'metaviewer.roles/v0.3',op:'create-program',choice:{binary,role:'human',hostXpra:true}})).ok,true);
  await assert.rejects(host.dispose(),error=>{
    assert.deepEqual(stopped,['surface-1','surface-2']);
    assert.equal(error instanceof AggregateError,true);
    assert.equal(error.errors.length,2);
    return true;
  });
});

async function setupFunctions(file, names, context) {
  const source=await readFile(new URL(file,import.meta.url),'utf8');
  const {descriptor}=parse(source);
  const compiled=compileScript(descriptor,{id:'v027-unit'});
  const script=descriptor.scriptSetup.content;
  const functions=compiled.scriptSetupAst.filter(n=>n.type==='FunctionDeclaration' && names.includes(n.id.name));
  assert.equal(functions.length,names.length);
  vm.createContext(context);
  vm.runInContext(functions.map(n=>script.slice(n.start,n.end)).join('\n'),context);
  return context;
}

test('V027-LP02 transient write failure allows a subsequent layout edit; invalid-load protection remains', async()=>{
  let rejectWrite=true;
  const saved=[],errors=[];
  const c=await setupFunctions('../src/wall/DesktopWorkspace.vue',['persist'],{
    loaded:{value:true},alive:true,readOnly:false,dirty:false,saving:null,state:{value:{layout:'before'}},
    cleanLayouts:v=>v,emit:(name,error)=>errors.push(error),
    props:{storage:{writeAtomic:async raw=>{if(rejectWrite)throw Error('disk unavailable');saved.push(JSON.parse(raw));}}},
  });
  await assert.rejects(c.persist(),/disk unavailable/);
  assert.equal(errors.length,1);
  rejectWrite=false;
  c.state.value.layout='after';
  await c.persist();
  assert.deepEqual(saved,[{layout:'after'}]);
  c.readOnly=true;
  await assert.rejects(c.persist(),/LAYOUT_SAVE_REFUSED/);
  assert.equal(saved.length,1);
});

test('V027-AS01 opening and cancelling Add preserve a non-first selection',async()=>{
  const c=await setupFunctions('../src/App.vue',['openCapsule'],{
    nestedMode:{displayOnly:false},selectedCapsuleId:{value:'second'},launcherOpen:{value:false},
    rows:{value:[{id:'first'},{id:'second'}]},wall:{value:null},capsuleModes:{value:{}},markPanelOpen(){},
  });
  c.openCapsule({id:'add'});
  assert.equal(c.launcherOpen.value,true);
  c.launcherOpen.value=false;
  assert.equal(c.selectedCapsuleId.value,'second');
  c.openCapsule({id:'first'});
  assert.equal(c.selectedCapsuleId.value,'first');
});

test('V027-DP02 failed paint does not hide a visible tile; later frames resume',async t=>{
  const channel=new MessageChannel();
  let visible=true,contextReady=false,painted=0;
  const sender=createDisplayPort({port:channel.port1,surfaceId:'s1',onVisibilityChange:value=>{visible=value;}});
  const router=installDisplayPortRouter({target:null});
  t.after(()=>{sender.close();router.dispose();});
  router.bindSurface({surfaceId:'s1',onFrame:()=>{if(!contextReady)return false;painted++;return true;}});
  router.receiveNotice({type:DISPLAY_PORT_NOTICE_TYPE,schema:DISPLAY_PORT_NOTICE_SCHEMA,surface_id:'s1'},[channel.port2]);
  const frame={generation:1,seq:2,captureMonoNs:'100',width:1,height:1,bytes:new Uint8Array(3)};
  sender.postDisplayFrame(frame);
  await waitForCondition(()=>sender.getInstrumentation().acksReceived===1);
  assert.equal(visible,true,'paint failure must not suppress the next host delivery');
  contextReady=true;
  if(visible)sender.postDisplayFrame({...frame,seq:4,captureMonoNs:'200'});
  await waitForCondition(()=>painted===1);
  router.setSurfaceVisible('s1',false);
  await waitForCondition(()=>!visible);
});

test('V027-ID01 retained lost identity exposes its binding and can be stopped',async t=>{
  const root=await mkdtemp(join(tmpdir(),'v027-lost-'));t.after(()=>rm(root,{recursive:true,force:true}));await chmod(root,0o700);
  const lost={...surface,profile_id:'p1',state:'lost'};
  const states=new Map([['s1',lost]]);let handler;
  const window=new EventEmitter();window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
  const stopped=[];
  const core={getHumanSurface:()=>undefined,async stopSurface(sid){stopped.push(sid);return {schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...lost,state:'destroyed'}}};}};
  const host=installRoleHost({electron:{ipcMain:{handle(_key,fn){handler=fn;},removeHandler(){}}},window,core,
    env:{MV_SRF_STATE_DIR:root,MV_SRF_LIVE_PROFILE:'p1',MV_SRF_PROFILES:JSON.stringify({p1:{Kind:'browser'}})},capsuleStates:states,admit:()=>true,
    listIdentities:async()=>({ok:true,rows:[{id:'p1',browser:'browser'}]})});
  t.after(()=>host.dispose());
  const call=(op,args={})=>handler({}, {schema:'metaviewer.roles/v0.3',op,...args});
  const reply=await call('open',{choice:{profileId:'p1',role:'human'}});
  assert.equal(reply.ok,false);assert.equal(reply.surfaceId,'s1');assert.equal(reply.currentMode,'lost');
  const choices=await call('choices');assert.equal(choices[0].currentMode,'lost');
  assert.equal((await call('stop',{surfaceId:'s1'})).ok,true);
  assert.deepEqual(stopped,['s1']);assert.equal(states.get('s1').state,'destroyed');
  assert.equal((await call('stop',{surfaceId:'unknown'})).ok,false);
});

test('V027-ID01 dialog stop action uses the retained surface ID and refreshes identities',async()=>{
  const calls=[];
  const c=await setupFunctions('../src/identities/IdentitiesDialog.vue',['stopIdentity'],{
    busy:{value:false},error:{value:''},isForeignIdentity:()=>false,modeFor:()=>({surfaceId:'lost-id'}),
    roleApi:{stop:async id=>{calls.push(id);return {ok:true};}},invoke:async method=>calls.push(method),identityErrorText:String,
  });
  await c.stopIdentity('p1');assert.deepEqual(calls,['lost-id','list']);assert.equal(c.error.value,'');
});

test('V027-ID03 saved host-Xpra program keeps its mode through dialog and App',async()=>{
  const calls=[];
  const app=await setupFunctions('../src/App.vue',['createProgramCapsule'],{
    metaviewerRoles:{createProgram:async choice=>{calls.push(choice);return {ok:true,surfaceId:'new',role:'human'};}},
    selectGlobalView(){},nextTick:async()=>{},revealOpenedIdentity:async()=>true,
  });
  const dialog=await setupFunctions('../src/identities/IdentitiesDialog.vue',['openIdentity'],{
    isForeignIdentity:()=>false,busy:{value:false},error:{value:''},rows:{value:[{id:'saved',browser:'program'}]},
    modeFor:()=>({available:true,binary:'/program',hostXpra:true}),roleApi:{createProgram(){}},
    props:{openProgram:app.createProgramCapsule},emit(){},identityErrorText:String,
  });
  await dialog.openIdentity('saved','human');
  assert.equal(calls.length,1);assert.equal(calls[0].hostXpra,true);assert.equal(dialog.error.value,'');
});

function xpraFixture() {
 const ipcMain = new EventEmitter();
 const handlers = new Map(); ipcMain.handle=(k,v)=>handlers.set(k,v);ipcMain.removeHandler=k=>handlers.delete(k);
 const requests = {}, children = [], readiness = {ready:true,probes:0};
 class WC extends EventEmitter {
  mainFrame = {}; url=''; closed=false;
  menuShortcuts=[]; loads=[];
  setIgnoreMenuShortcuts(value){this.menuShortcuts.push(value);}
  setWindowOpenHandler(){} setZoomFactor(value){this.zoom=value;}
  async loadURL(url){this.loads.push(url);this.url=url;} getURL(){return this.url;} focus(){this.focused=true;}
  async executeJavaScript(){readiness.probes++;return readiness.ready;}
  close(){this.closed=true;}
 }
 class WebContentsView {webContents=new WC();setBounds(b){this.bounds=b;}setVisible(v){this.visible=v;}}
 const isolated = new EventEmitter();
 Object.assign(isolated,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},
  webRequest:{onBeforeRequest(_f,cb){requests.admit=cb;},onBeforeSendHeaders(_f,cb){requests.headers=cb;}},
  async clearStorageData(){}});
 const parentSession={registerPreloadScript(){return 'role-preload';},unregisterPreloadScript(){}};
 const window = new EventEmitter();window.webContents=Object.assign(new EventEmitter(),{session:parentSession});
 window.contentView={addChildView(v){children.push(v);},removeChildView(v){children.splice(children.indexOf(v),1);}};
 return {electron:{WebContentsView,ipcMain,session:{fromPartition(){return isolated;}}},window,handlers,requests,children,readiness};
}


test('V027-XP03 readiness preserves a newer focus choice; untouched opening still focuses',async()=>{
  for(const moved of [true,false]) {
    const f=xpraFixture();f.readiness.ready=false;
    const pending=attachXpraHumanTile({...f,bridge:{origin:'http://127.0.0.1:12345',requestHeaders:{}},bounds:{x:0,y:0,width:1280,height:900},
      trace:{setActive(){},record(){}},isActive:()=>true,writable:true,capsuleSize:()=>({width:1280,height:900}),onFailure:assert.fail});
    await waitForCondition(()=>f.readiness.probes>0);
    if(moved)f.window.webContents.emit('before-mouse-event',{},{});
    f.readiness.ready=true;
    const tile=await pending;
    try {assert.equal(tile.view.webContents.focused===true,!moved);}
    finally {await tile.close();}
    assert.equal(f.window.webContents.listenerCount('before-mouse-event'),0);
  }
});

test('V027-CP02 browser and program bridges share creation admission before asynchronous memory reads',async t=>{
  const root=await mkdtemp(join(tmpdir(),'v027-admit-'));t.after(()=>rm(root,{recursive:true,force:true}));await chmod(root,0o700);
  const binary=join(root,'program');await writeFile(binary,'');await chmod(binary,0o755);
  const states=new Map();let handler,releaseMemory;
  let reads=0,requests=0;
  const memory=new Promise(resolve=>{releaseMemory=resolve;});
  const readFreeMemoryBytes=()=>{reads++;return memory;};
  const core={async request(){requests++;return {ok:false,code:'RAM_ADMISSION_REFUSED'};}};
  const f=wireFixture(t,{capsuleStates:states,readFreeMemoryBytes,core});
  const window=new EventEmitter();window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
  const host=installRoleHost({electron:{ipcMain:{handle(_key,fn){handler=fn;},removeHandler(){}}},window,core,env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:'{}'},capsuleStates:states,admit:()=>true,readFreeMemoryBytes,listIdentities:async()=>[]});
  t.after(()=>host.dispose());
  t.after(()=>releaseMemory(null));
  const browser=f.call('createSurface');
  await waitForCondition(()=>reads===1);
  const program=handler({}, {schema:'metaviewer.roles/v0.3',op:'create-program',choice:{binary,role:'human',hostXpra:true}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1,'second bridge must refuse before consuming the same memory headroom');
  assert.equal((await program).code,'SURFACE_CREATE_BUSY');
  releaseMemory(null);
  assert.equal((await browser).ok,false);
  assert.equal(requests,0);
});

test('V027-CP03 boot creation applies the interactive memory floor before core dispatch',async()=>{
  const source=await readFile(new URL('../electron/main.js',import.meta.url),'utf8');
  const a=source.indexOf('async function requestFirstSurfaceCreate('),b=source.indexOf('\n/**\n * PKG-FIX ID-01/B1',a);
  assert(a>=0 && b>a);
  const failures=[],created=[],requests=[];
  const context={FIRST_SURFACE_CREATE_TIMEOUT_MS:1000,console:{log(){},error(){}},buildFirstSurfaceCreateRequest:()=>({}),
    acquireCapsuleCreation,CAPSULE_MEMORY_LIMIT_BYTES,parseMemAvailableBytes,setTimeout,clearTimeout,readFileSync:()=>'',Error};
  vm.createContext(context);vm.runInContext(source.slice(a,b),context);
  const states=new Map();
  const core={request:async q=>{requests.push(q);return {schema:'surface_event/v0.2',event:'created',data:{surface:{surface_id:'new'}}};}};
  const settled={onFailure:e=>failures.push(e),onCreated:s=>created.push(s)};
  await context.requestFirstSurfaceCreate(core,{},settled,states,async()=>CAPSULE_MEMORY_LIMIT_BYTES-1,{acquireCapsuleCreation,CAPSULE_MEMORY_LIMIT_BYTES,parseMemAvailableBytes});
  assert.equal(requests.length,0);assert.equal(failures.at(-1)?.code,'RAM_ADMISSION_REFUSED');
  await context.requestFirstSurfaceCreate(core,{},settled,states,async()=>CAPSULE_MEMORY_LIMIT_BYTES,{acquireCapsuleCreation,CAPSULE_MEMORY_LIMIT_BYTES,parseMemAvailableBytes});
  assert.equal(requests.length,1);assert.equal(created.length,1);
});

test('V027-EG03 stale settings cleanup cannot detach its replacement subscription',async t=>{
  const root=await mkdtemp(join(tmpdir(),'v027-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createSettingsStore({XDG_CONFIG_HOME:root});
  const seen=[];
  const old=store.subscribe(()=>{});old();
  const stop=store.subscribe(v=>seen.push(v));t.after(stop);
  old();
  await store.save(JSON.stringify({scheme:'mv-light',density:'compact',wallFps:60,recordingFps:17}));
  assert.equal(seen.length,1);assert.equal(seen[0].wallFps,60);
});

test('V027-EM06 authority disposal awaits terminal teardown',async t=>{
  let finish,settled=false;
  const pending=new Promise(resolve=>{finish=resolve;});
  const f=wireFixture(t,{terminal:{dispose:()=>pending}});
  t.after(()=>finish());
  const closing=f.binding.dispose().then(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);
  finish();await closing;
  assert.equal(settled,true);
});


test('V027-HB05 wall-clock rollback cannot enlarge typing throttle delays', async t=>{
  const originalNow=Date.now, originalTimer=globalThis.setTimeout;
  t.after(()=>{Date.now=originalNow;globalThis.setTimeout=originalTimer;});
  let wall=100000;
  Date.now=()=>wall;
  const delays=[],sent=[];
  globalThis.setTimeout=(fn,delay,...args)=>{delays.push(delay);return originalTimer(fn,0,...args);};
  const api=createPreloadFacade({transport:{nested:false,subscribe:()=>()=>{},invoke:async (_channel,args)=>{
    sent.push(args[0]);return {ok:true,accepted:args[0].events.length};
  }},bridge:{exposeInMainWorld(){}}});
  const batch=seq=>({schema:'surface_input/v1',surface_id:'s1',stream_id:1,seq,events:[{kind:'type',text:'x'}]});
  assert.equal((await api.input.send(batch(1))).ok,true);
  wall=1;
  assert.equal((await api.input.send(batch(2))).ok,true);
  assert.equal(sent.length,2);
  assert.ok(delays.every(delay=>delay<=1005),`unbounded clock rollback delay: ${delays}`);
});


test('V027-HP03 corrupt saved programs cannot hide healthy sibling programs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'v027-programs-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await chmod(root,0o700);
  const store=programBinaries(join(root,'program-binaries'));
  await store.remember('healthy','/bin/sh',true);
  await store.remember('broken','/bin/sh',true);
  await writeFile(join(root,'program-binaries','broken.json'),'{broken');
  assert.deepEqual(await store.hostProfiles(),[{id:'healthy',browser:'program'}]);
  let handler;
  const window=new EventEmitter();window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
  const host=installRoleHost({electron:{ipcMain:{handle(_key,fn){handler=fn;},removeHandler(){}}},window,
    core:{},env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:'{}'},capsuleStates:new Map(),admit:()=>true,
    listIdentities:async()=>({ok:true,rows:[{id:'broken',browser:'program'}]})});
  t.after(()=>host.dispose());
  const rows=await handler({}, {schema:'metaviewer.roles/v0.3',op:'programs'});
  assert.equal(Array.isArray(rows),true,JSON.stringify(rows));
  assert.equal(rows.find(row=>row.profileId==='healthy')?.available,true);
  assert.equal(rows.find(row=>row.profileId==='broken')?.available,false);
  await assert.rejects(store.readLaunch('broken'),SyntaxError);
});

