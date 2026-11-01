import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { xpraClientQuery, xpraReadyExpression, waitForXpraClient } from '../electron/xpraClient.js';
import { createHumanTraceFile } from '../electron/humanTrace.js';
import { createXpraHumanSession } from '../electron/xpraHumanSession.js';
import { attachXpraHumanTile } from '../electron/xpraHumanTile.js';
import { openXpraHumanBridge } from '../electron/xpraHumanBridge.js';
import { installRoleHost, readRoleBinding } from '../electron/roleHost.js';

const geometry = {width:1280,height:900,capsuleWidth:1280,capsuleHeight:900};
const bounds = {x:0,y:0,width:1280,height:900};
function fakeElectron() {
 const ipcMain = new EventEmitter();
 const handlers = new Map(); ipcMain.handle=(k,v)=>handlers.set(k,v);ipcMain.removeHandler=k=>handlers.delete(k);
 const requests = {}, children = [], readiness = {ready:true,probes:0};
 class WC extends EventEmitter {
  mainFrame = {}; url=''; closed=false;
  setWindowOpenHandler(){} setZoomFactor(value){this.zoom=value;}
  async loadURL(url){this.url=url;} getURL(){return this.url;} focus(){this.focused=true;}
  async executeJavaScript(){readiness.probes++;return readiness.ready;}
  close(){this.closed=true;}
 }
 class WebContentsView {webContents=new WC();setBounds(b){this.bounds=b;}}
 const isolated = new EventEmitter();
 Object.assign(isolated,{setPermissionRequestHandler(){},setPermissionCheckHandler(){},
  webRequest:{onBeforeRequest(_f,cb){requests.admit=cb;},onBeforeSendHeaders(_f,cb){requests.headers=cb;}},
  async clearStorageData(){}});
 const parentSession={registerPreloadScript(){return 'role-preload';},unregisterPreloadScript(){}};
 const window = new EventEmitter();window.webContents={session:parentSession};
 window.contentView={addChildView(v){children.push(v);},removeChildView(v){children.splice(children.indexOf(v),1);}};
 return {electron:{WebContentsView,ipcMain,session:{fromPartition(){return isolated;}}},window,handlers,requests,children,readiness};
}

test('human trace is readable before close and redacts sensitive keys and extra fields', async t => {
 const directory=await mkdtemp(join(tmpdir(),'role-trace-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const trace=createHumanTraceFile({directory,sessionId:'session',surfaceId:'human',capsuleId:'srf-id-human'});
 trace.setActive(true);
 trace.record({kind:'key',key:'secret-password',phase:'down',text:'hidden'},geometry);
 const first=await readFile(trace.path,'utf8');assert.equal(first.split('\n').length,2);
 trace.record({kind:'move',x:5,y:6},geometry);
 const content=await readFile(trace.path,'utf8');assert.equal(content.trim().split('\n').length,2);
 assert(!content.includes('secret-password'));assert(!content.includes('hidden'));
 assert.deepEqual(JSON.parse(first).details,{phase:'down',key:null,redacted:true});
 trace.close();assert.equal(trace.record({kind:'key',key:'x',phase:'down'},geometry),false);
});

test('immutable session acknowledges the role mode before mounting and closes resources', async () => {
 for (const role of ['human','agent']) {
  const calls=[];
  const session=createXpraHumanSession({role,setReadonly:async value=>{calls.push(value?'readonly':'writable');return true;},
   openBridge:async()=>{calls.push('bridge');return{close:async()=>calls.push('bridge-close')};},
   showView:async()=>{calls.push('view');return{close:async()=>calls.push('view-close'),resize(){}};},closeTrace:()=>calls.push('trace-close')});
  assert.equal(session.take,undefined);assert.equal(session.release,undefined);
  await session.open();assert.deepEqual(calls.slice(0,3),[role==='human'?'writable':'readonly','bridge','view']);
  await session.close();assert.deepEqual(calls.slice(3),['view-close','bridge-close','trace-close']);assert(!session.active);
 }
});

test('missing readonly ack never opens the agent watch', async () => {
 let opened=false;
 const session=createXpraHumanSession({role:'agent',setReadonly:async()=>false,openBridge:async()=>{opened=true;},showView:async()=>{},closeTrace(){}});
 await assert.rejects(session.open(),/XPRA_MODE_UNPROVEN/);assert(!opened);
});

test('readonly native tile suppresses keys and clicks and token stays in main request hook', async () => {
 const f=fakeElectron();let active=true;let recorded=0;
 const bridge={origin:'http://127.0.0.1:12345',requestHeaders:{'x-metaviewer-xpra-session':'main-only-secret'},close:async()=>{}};
 const tile=await attachXpraHumanTile({...f,bridge,bounds,trace:{setActive(){},record(){recorded++;}},
  isActive:()=>active,writable:false,capsuleSize:()=>({width:1280,height:900}),onFailure:assert.fail});
 for(const name of ['before-input-event','before-mouse-event']) {
  let prevented=false;tile.view.webContents.emit(name,{preventDefault(){prevented=true;}});
  assert(prevented, name+' forwarded input');
 }
 assert(!tile.view.webContents.focused);
 let headers;f.requests.headers({requestHeaders:{}},v=>headers=v.requestHeaders);
 assert.equal(headers['x-metaviewer-xpra-session'],'main-only-secret');
 assert(!tile.view.webContents.getURL().includes('main-only-secret'));
 assert(!JSON.stringify(tile.view.bounds).includes('main-only-secret'));
 assert.equal(recorded,0);
 active=false;let cancelled=false;f.requests.admit({url:bridge.origin+'/'},v=>cancelled=v.cancel);assert(cancelled);
 await tile.close();assert(tile.view.webContents.closed);assert.equal(f.children.length,0);
 assert.equal(f.electron.ipcMain.listenerCount('metaviewer:human-trace.v0.3'),0);
});

test('bridge requires main token and kills an upgraded websocket on close', async t => {
 const root=await mkdtemp(join(tmpdir(),'role-bridge-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const outer=join(root,'srf-id-demo'),inner=join(outer,'s');await mkdir(outer,{mode:0o700});await mkdir(inner,{mode:0o777});await chmod(inner,0o777);
 const socketPath=join(inner,'xpra.sock');
 const upstream=http.createServer((_q,r)=>r.end('xpra'));
 const sockets=new Set();upstream.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 upstream.on('upgrade',(_q,s)=>s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
 await new Promise(r=>upstream.listen(socketPath,r));await chmod(socketPath,0o666);
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>upstream.close(r));});
 const bridge=await openXpraHumanBridge({viewRoot:root,capsule:'srf-id-demo',expectedSocketUid:process.getuid()});t.after(()=>bridge.close());
 const get=(headers,route='/')=>new Promise((resolve,reject)=>{http.get(bridge.origin+route,{headers},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
 assert.equal(await get({}),403);assert.equal(await get(bridge.requestHeaders),200);
 assert.equal(await get({},'/metaviewer-tile.html'),403);
 assert.equal(await get(bridge.requestHeaders,'/metaviewer-tile.html'),200);
 const url=new URL(bridge.origin);const client=net.createConnection({host:url.hostname,port:Number(url.port)});await once(client,'connect');
 client.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-metaviewer-xpra-session: ${bridge.requestHeaders['x-metaviewer-xpra-session']}\r\n\r\n`);
 const [reply]=await once(client,'data');assert.match(reply.toString(),/101 Switching/);
 const closed=once(client,'close');client.resume();await Promise.race([bridge.close(),new Promise((_r,reject)=>{const timer=setTimeout(()=>reject(Error('bridge close did not revoke websocket')),200);timer.unref();})]);await closed;
 assert(client.destroyed);
 await assert.rejects(get(bridge.requestHeaders));
});

async function roleHostFixture(t, role='human', failure=null) {
 const root=await mkdtemp(join(tmpdir(),'role-host-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'human-bindings'),{mode:0o700});
 const surface={surface_id:'surface-human',profile_id:'demo',state:'active',control:role==='human'?'human':'agent'};
 const binding={schema:'metaviewer.human_binding/v0.3',profile_id:'demo',surface_id:surface.surface_id,container:'srf-id-demo',run_id:'run-demo',control_ready:true,input_epoch:0,width:1280,height:900,role};
 await writeFile(join(root,'human-bindings',surface.surface_id+'.json'),JSON.stringify(binding),{mode:0o600});
 const f=fakeElectron(), modes=[], calls=[], queries=[];
 const states=new Map([[surface.surface_id,surface]]);
 const host=installRoleHost({...f,admit:event=>event==='trusted',env:{MV_SRF_PROFILES:JSON.stringify({demo:{Kind:'browser',role}}),MV_SRF_STATE_DIR:root,MV_SRF_BIN_DIR:'/host/bin',MV_RECORDING_DESTINATION:root},
  capsuleStates:states,core:{getHumanSurface:()=>surface,request:async value=>{calls.push(value);return{};}},
  listIdentities:async()=>({ok:true,rows:[{id:'demo'}]}),mode:async value=>{modes.push(value.readonly);return true;},
  bridgeFactory:async()=>({origin:'http://127.0.0.1:12345',requestHeaders:{secret:'never-renderer'},close:async()=>calls.push('bridge-close')}),
  tileFactory:async options=>{if(failure)throw failure;queries.push(options.clientQuery);calls.push({writable:options.writable});return{resize(){},close:async()=>calls.push('tile-close')};}});
 t.after(()=>host.dispose());
 const handler=f.handlers.get('metaviewer:roles.v0.3');
 const request=(op,body={})=>handler('trusted',{schema:'metaviewer.roles/v0.3',op,...body});
 return{root,host,surface,binding,f,modes,calls,queries,request,handler};
}

test('human mount uses writable native view; IPC carries no bridge token',async t=>{
 const f=await roleHostFixture(t);
 const reply=await f.request('mount',{surfaceId:f.surface.surface_id,bounds});
 assert.deepEqual(reply,{ok:true,role:'human'});assert.deepEqual(f.modes,[false]);
 assert.deepEqual(f.calls[0],{writable:true});assert(!JSON.stringify(reply).includes('never-renderer'));
 await f.request('close',{surfaceId:f.surface.surface_id});assert.deepEqual(f.calls.slice(1),['tile-close','bridge-close']);
 await assert.rejects(f.handler('foreign',{schema:'metaviewer.roles/v0.3',op:'choices'}),/SENDER/);
});

test('agent mount requires server readonly and passes noninteractive native options',async t=>{
 const f=await roleHostFixture(t,'agent');await f.request('mount',{surfaceId:f.surface.surface_id,bounds});
 assert.deepEqual(f.modes,[true]);assert.deepEqual(f.calls[0],{writable:false});
 f.surface.control='human';await new Promise(r=>setTimeout(r,150));
 assert.deepEqual(f.calls.slice(1),['tile-close','bridge-close']);
});

test('duplicate identity and mismatched adapter bindings refuse without a native call',async t=>{
 const f=await roleHostFixture(t);
 assert.deepEqual(await f.request('create',{choice:{role:'human',profileId:'demo'}}),{ok:false,code:'PROFILE_ALREADY_BOUND'});
 assert.equal(f.calls.length,0);
 await writeFile(join(f.root,'human-bindings',f.surface.surface_id+'.json'),JSON.stringify({...f.binding,profile_id:'foreign'}),{mode:0o600});
 await assert.rejects(readRoleBinding(f.root,f.surface,'human'),/BINDING_REFUSED/);
 assert.deepEqual(await f.request('mount',{surfaceId:f.surface.surface_id,bounds}),{ok:false,code:'XPRA_BINDING_REFUSED'});
 assert.equal(f.modes.length,0);
});


test('human role never instantiates the canvas input slot; agent keeps it', async () => {
 const vue=await import('vue');
 const {parse,compileScript}=await import('@vue/compiler-sfc');
 const source=await readFile(new URL('../src/surfaces/RoleSurface.vue',import.meta.url),'utf8');
 const {descriptor}=parse(source);
 const compiled=compileScript(descriptor,{id:'role-surface-test',inlineTemplate:true}).content;
 const code=compiled.replace(/from ["']vue["']/g,'from '+JSON.stringify(import.meta.resolve('vue')));
 const Component=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
 const oldApi=globalThis.metaviewerRoles,oldWidth=globalThis.innerWidth,oldHeight=globalThis.innerHeight;
 globalThis.innerWidth=1600;globalThis.innerHeight=1100;
 const node=tag=>({tag,children:[],style:{display:''},props:{},parent:null,
  getBoundingClientRect:()=>({x:0,y:0,width:1280,height:900,right:1280,bottom:900}),getClientRects:()=>[1]});
 const renderer=vue.createRenderer({createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),
  setText(n,text){n.text=text;},setComment(n,text){n.text=text;},setElementText(n,text){n.text=text;n.children=[];},
  patchProp(n,key,_prev,value){n.props[key]=value;},insert(n,parent,anchor){n.parent=parent;const at=parent.children.indexOf(anchor);if(at<0)parent.children.push(n);else parent.children.splice(at,0,n);},
  remove(n){if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);},parentNode:n=>n.parent,nextSibling:()=>null});
 const tags=n=>[n.tag,...n.children.flatMap(tags)];
 try {
  for(const role of ['human','agent']) {
   const mounts=[];
   globalThis.metaviewerRoles={status:async()=>({role}),mount:async(...args)=>{mounts.push(args);return{ok:true};},resize:async()=>({ok:true}),close:async()=>({ok:true})};
   const root=node('root');
   const app=renderer.createApp({render:()=>vue.h(Component,{surfaceId:'surface',control:role==='human'?'human':'agent'},{default:()=>vue.h('canvas',{'data-input-path':true})})});
   try {
    app.mount(root);await new Promise(r=>setTimeout(r,20));await vue.nextTick();
    assert.equal(tags(root).includes('canvas'),role==='agent','canvas input path role isolation');
    assert.equal(mounts.length,role==='human'?1:0);
   } finally { app.unmount(); }
  }
  let attempts=0;
  globalThis.metaviewerRoles={status:async()=>({role:'human'}),mount:async()=>{attempts++;return{ok:false,code:'XPRA_CLIENT_READY_TIMEOUT'};},close:async()=>({ok:true})};
  const failed=node('root');const failedApp=renderer.createApp(Component,{surfaceId:'failed',control:'human'});
  try {
   failedApp.mount(failed);await new Promise(r=>setTimeout(r,170));await vue.nextTick();
   const all=n=>[n,...n.children.flatMap(all)];
   assert(all(failed).some(n=>n.text==='XPRA_CLIENT_READY_TIMEOUT'));
   assert.equal(attempts,1,'failure must not disappear into an automatic mount loop');
   const retry=all(failed).find(n=>n.tag==='button');assert(retry);
   retry.props.onClick();await new Promise(r=>setTimeout(r,20));assert.equal(attempts,2);
  } finally {failedApp.unmount();}
 } finally {globalThis.metaviewerRoles=oldApi;globalThis.innerWidth=oldWidth;globalThis.innerHeight=oldHeight;}
});


test('capsule destruction closes its child view and bridge',async t=>{
 const f=await roleHostFixture(t);
 await f.request('mount',{surfaceId:f.surface.surface_id,bounds});
 f.surface.state='destroyed';
 await new Promise(r=>setTimeout(r,150));
 assert.deepEqual(f.calls.slice(1),['tile-close','bridge-close']);
});


test('both role mounts send the proven connection query; only watch requests readonly',async t=>{
 for(const role of ['human','agent']) {
  const f=await roleHostFixture(t,role);
  await f.request('mount',{surfaceId:f.surface.surface_id,bounds});
  const q=new URLSearchParams(f.queries[0]);
  assert.equal(q.get('connect'),'1');assert.equal(q.get('username'),'worker');
  assert.equal(q.get('encoding'),'rgb');assert.equal(q.get('bandwidth_limit'),'0');
  assert.equal(q.get('clipboard'),'false');assert.equal(q.get('notifications'),'false');
  assert.equal(q.get('readonly'),role==='agent'?'1':null);
  assert.equal(q.has('resize'),false);
 }
});

test('loaded HTML cannot activate input or trace before client readiness',async()=>{
 const f=fakeElectron();f.readiness.ready=false;const active=[];
 const pending=attachXpraHumanTile({...f,bridge:{origin:'http://127.0.0.1:12345',requestHeaders:{}},
  bounds:{x:10,y:20,width:601,height:422},trace:{setActive:v=>active.push(v),record(){}},
  isActive:()=>true,capsuleSize:()=>({width:1280,height:900}),onFailure:assert.fail});
 await new Promise(r=>setTimeout(r,20));
 assert(f.readiness.probes>0);assert(!active.includes(true));assert(!f.children[0].webContents.focused);
 f.readiness.ready=true;const tile=await pending;
 assert(active.includes(true));assert(tile.view.webContents.focused);
 assert.equal(tile.view.webContents.zoom,1);
 assert.deepEqual(tile.view.bounds,{x:10,y:20,width:601,height:422});
 assert.equal(new URL(tile.view.webContents.getURL()).pathname,'/metaviewer-tile.html');
 assert.equal(new URL(tile.view.webContents.getURL()).search,xpraClientQuery(true));
 tile.resize({x:0,y:0,width:300,height:201});assert.equal(tile.view.webContents.zoom,1);
 await tile.close();
});

test('readiness requires healthy connection, native desktop, canvas, remote window and role mode',async()=>{
 function fixture(readonly=false) {
  const canvas={width:1280,height:900};
  const client={connected:true,server_ok:true,server_readonly:readonly,desktop_width:1280,desktop_height:900,id_to_window:{one:{w:1280,h:900}}};
  const page={client,innerWidth:1280,innerHeight:900};
  const doc={querySelectorAll:()=>[canvas]};
  const frame={contentWindow:page,contentDocument:doc};
  return {client,page,canvas,frame,document:{getElementById:()=>frame}};
 }
 for(const writable of [true,false]) {
  const good=fixture(!writable);
  assert.equal(vm.runInNewContext(xpraReadyExpression(writable),good),true);
 }
 const corrupt=[f=>f.client.connected=false,f=>f.client.server_ok=false,f=>f.client.server_readonly=true,
  f=>f.page.innerWidth=600,f=>f.page.innerHeight=422,f=>f.client.desktop_width=600,
  f=>f.client.desktop_height=422,f=>f.client.id_to_window={},f=>f.canvas.width=600,f=>f.canvas.height=422];
 for(const change of corrupt) {
  const f=fixture();change(f);
  const wc={executeJavaScript:async source=>vm.runInNewContext(source,f)};
  await assert.rejects(waitForXpraClient(wc,{writable:true,isActive:()=>true,timeoutMs:1}),
   {code:'XPRA_CLIENT_READY_TIMEOUT'});
 }
 await assert.rejects(waitForXpraClient({executeJavaScript:assert.fail},{writable:true,isActive:()=>false}),
  {code:'XPRA_HUMAN_LEASE_LOST'});
});


test('client readiness failure survives host IPC as a typed visible refusal',async t=>{
 const failure=Object.assign(Error('XPRA_CLIENT_READY_TIMEOUT'),{code:'XPRA_CLIENT_READY_TIMEOUT'});
 const f=await roleHostFixture(t,'human',failure);
 assert.deepEqual(await f.request('mount',{surfaceId:f.surface.surface_id,bounds}),
  {ok:false,code:'XPRA_CLIENT_READY_TIMEOUT'});
 assert.deepEqual(f.calls,['bridge-close']);
});


test('a renderer that never answers cannot bypass the readiness deadline',async()=>{
 await assert.rejects(waitForXpraClient({executeJavaScript:()=>new Promise(()=>{})},
  {writable:true,isActive:()=>true,timeoutMs:10}),{code:'XPRA_CLIENT_READY_TIMEOUT'});
});
