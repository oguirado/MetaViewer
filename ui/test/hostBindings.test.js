import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, mkdir, chmod, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMainBindings } from '../electron/hostBindings.js';
import { loadMainBindings, bootProductionMain, ELECTRON_PIN, CHANNELS } from '../electron/main.js';
import { deliverAuthorityFrame, WIRE_CHANNELS } from '../electron/authorityWire.js';

const surface = {schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'agent',profile_id:'test'};
const registration = component => ({endpoint:{component,instance:component+'-test'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
async function fixture(t, {badHello=false,refuseIntent=false}={}) {
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
      else if(env.body.schema==='ui_intent/v0.2')send(refuseIntent
        ? {schema:'action_verdict/v0.2',proposal_id:env.body.request_id,decision:'refused',reason_code:'POLICY',core_seq:1}
        : {schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surface,control:env.body.op==='take_control'?'human':'agent',visibility:env.body.op==='fold'?'folded':'unfolded'}}});
      else send({schema:'action_verdict/v0.2',proposal_id:env.body.proposal_id,decision:'refused',reason_code:'POLICY',core_seq:1});
    }
  });});
  server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');await chmod(join(root,'metaviewer/core.sock'),0o600);
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});await rm(ram,{recursive:true,force:true});});
  const messages=[];const channels=[];
  const createMessageChannel=()=>{const port1=new EventEmitter();Object.assign(port1,{postMessage:value=>messages.push(value),start(){},close(){}});const port2={close(){}};channels.push({port1,port2});return {port1,port2};};
  const env={MV_CORE_CONFIG:configPath,XDG_RUNTIME_DIR:root};
  return {env,root,frame,send,requests,messages,channels,createMessageChannel};
}
test('default bootstrap connects, pins hello, delivers real bytes and routes intents/proposals',async t=>{
  const f=await fixture(t);
  const bindings=await loadMainBindings(f.env,{createMessageChannel:f.createMessageChannel});t.after(()=>bindings.core.dispose());
  assert.equal((await bindings.core.start()).availability,'live');
  const entryPromise=new Promise(resolve=>bindings.wire.frames.subscribe(resolve));
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const entry=await entryPromise,streams=new Set(),metadata=[];
  try {
    assert.equal(await deliverAuthorityFrame(entry,{postMessage:(...args)=>metadata.push(args)},streams),true);
    assert.equal(f.messages.length,1);assert.deepEqual(metadata[0][2],[f.channels[0].port2]);
    assert.ok(!JSON.stringify(metadata).includes('/dev/shm'));
    for(const op of ['take_control','release_control','fold','unfold']) {
      const params=op==='fold'||op==='unfold'?{slot_id:'s1'}:{surface_id:'s1'};
      assert.equal(await bindings.core.request({op:'intent',json:JSON.stringify({schema:'ui_intent/v0.2',request_id:op,op,params})}),true);
      assert.equal(f.requests.at(-1).body.op,op);
    }
    const verdict=await bindings.core.request({op:'propose',json:JSON.stringify({schema:'action_proposal/v0.2',proposal_id:'p'})});
    assert.equal(verdict.reason_code,'POLICY');assert.equal(f.requests.at(-1).body.proposal_id,'p');
  } finally {for(const stream of streams){await stream.reader.closeReader();stream.port.revokeFramePort('SHUTDOWN');}}
});
test('missing configuration, unsafe socket and incorrect hello fail closed',async t=>{
  await assert.rejects(createMainBindings({env:{}}),/CORE_SEAMS_ABSENT/);
  const f=await fixture(t);await chmod(join(f.root,'metaviewer/core.sock'),0o666);
  await assert.rejects(createMainBindings({...f}),/CORE_SEAMS_ABSENT/);
  const bad=await fixture(t,{badHello:true});await assert.rejects(createMainBindings({...bad}),/CORE_SEAMS_ABSENT/);
});
test('bootstrap overrides are absolute and validated before returning bindings',async t=>{
  await assert.rejects(loadMainBindings({MV_CORE_BOOTSTRAP:'relative.js'}),/CORE_SEAMS_ABSENT/);
  const f=await fixture(t);const path=join(f.root,'bad.mjs');await writeFile(path,'export const createMainBindings = () => ({core:{}});');
  await assert.rejects(loadMainBindings({MV_CORE_BOOTSTRAP:path}),/CORE_SEAMS_ABSENT/);
  const main=await readFile(new URL('../electron/main.js',import.meta.url),'utf8');
  assert.ok(main.indexOf('const bindings = await loadMainBindings')<main.indexOf('await bootProductionMain({ core:bindings.core'));
});
test('producer refuses cross-bound references and path substitution',async t=>{
  const f=await fixture(t);const bindings=await createMainBindings({...f});t.after(()=>bindings.core.dispose());
  const entryPromise=new Promise(resolve=>bindings.wire.frames.subscribe(resolve));
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const entry=await entryPromise;
  const streams=new Set();
  try {
    assert.equal(await deliverAuthorityFrame({...entry,frameRef:{...f.frame,surface_id:'other'},state:{...surface,surface_id:'other'}},{postMessage(){assert.fail('cross-bound frame reached renderer');}},streams),false);
    assert.equal(f.messages.length,0);
  } finally {for(const stream of streams){await stream.reader.closeReader();stream.port.revokeFramePort('SHUTDOWN');}}
});
test('producer refuses changed capability identity without opening a foreign path',async t=>{
  const f=await fixture(t);const bindings=await createMainBindings({...f});t.after(()=>bindings.core.dispose());
  const entryPromise=new Promise(resolve=>bindings.wire.frames.subscribe(resolve));
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const entry=await entryPromise;
  for(const patch of [{surface_id:'other'},{ramws_path:'/etc/passwd'}]) {
    await assert.rejects(entry.readerOptions.acquirePublishedLease({binding:entry.readerOptions.binding,frameRef:{...f.frame,...patch},signal:new AbortController().signal}),/FRAME_BINDING/);
  }
  await assert.rejects(entry.readerOptions.acquirePublishedLease({binding:{...entry.readerOptions.binding,surfaceId:'other'},frameRef:f.frame,signal:new AbortController().signal}),/FRAME_BINDING/);
});

test('core refusals never become successful renderer intents',async t=>{
  const f=await fixture(t,{refuseIntent:true});const bindings=await createMainBindings({...f});t.after(()=>bindings.core.dispose());
  await assert.rejects(bindings.core.request({op:'intent',json:JSON.stringify({schema:'ui_intent/v0.2',request_id:'refused',op:'take_control',params:{surface_id:'s1'}})}),/INTENT_REFUSED/);
});

test('production boot installs the default socket wire and delivers a subscribed renderer frame',async t=>{
  const f=await fixture(t),handlers=new Map();
  const bindings=await loadMainBindings(f.env,{createMessageChannel:f.createMessageChannel});
  t.after(()=>bindings.core.dispose());
  const shell=join(f.root,'shell');
  await mkdir(join(shell,'dist/renderer'),{recursive:true});await mkdir(join(shell,'dist/preload'),{recursive:true});
  await writeFile(join(shell,'dist/renderer/index.html'),'<!doctype html><title>host test</title>');
  await writeFile(join(shell,'dist/preload/preload.cjs'),'');
  const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){}};
  const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
  let resolveNotice;const notice=new Promise(resolve=>{resolveNotice=resolve;});
  const contents={id:17,mainFrame:frame,session,isDestroyed:()=>false,setWindowOpenHandler(){},on(){},loadURL:async()=>{},postMessage:(...args)=>resolveNotice(args)};
  let windows=0;
  class Window {
    constructor(){windows++;this.webContents=contents;}
    once(){} on(){} show(){} destroy(){} isDestroyed(){return false;}
  }
  const booted=await bootProductionMain({...bindings,app:{requestSingleInstanceLock:()=>true,whenReady:async()=>{},on(){},quit(){},getAppPath:()=>shell,getPath:()=>join(f.root,'user')},
    BrowserWindow:Window,ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
    protocol:{registerSchemesAsPrivileged(){},handle(){},unhandle(){}},session:{defaultSession:session},
    electronVersion:ELECTRON_PIN,shellRoot:shell,argv:['metaviewer'],env:f.env,
    runtime:{xdgRuntimeDir:f.root,uid:process.getuid()},geometry:{width:1280,height:720},bridge:[CHANNELS.load,CHANNELS.save].map(channel=>({channel,decode:value=>value,invoke:async()=>null}))});
  t.after(()=>booted.dispose());assert.equal(windows,1);
  await handlers.get(WIRE_CHANNELS.subscribeFrames)({sender:contents,senderFrame:frame});
  f.send({schema:'surface_event/v0.2',event:'created',data:{surface}});
  f.send({schema:'surface_event/v0.2',event:'frame_ready',data:{frame_ref:f.frame}});
  const delivered=await notice;assert.equal(delivered[0],'metaviewer:authority.frames');assert.equal(f.messages.length,1);
  assert.deepEqual(delivered[2],[f.channels[0].port2]);
  assert.equal(await handlers.get(WIRE_CHANNELS.intent)({sender:contents,senderFrame:frame},JSON.stringify({schema:'ui_intent/v0.2',request_id:'boot-take',op:'take_control',params:{surface_id:'s1'}})),true);
});
