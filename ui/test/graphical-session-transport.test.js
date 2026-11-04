import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,chmod} from 'node:fs/promises';
import {createServer} from 'node:net';
import {EventEmitter,once} from 'node:events';
import {createMainBindings} from '../electron/hostBindings.js';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installAuthorityWire,GRAPHICAL_SESSION_CHANNELS} from '../electron/authorityWire.js';
import {createPreloadFacade} from '../electron/preload.js';

const snapshot=()=>({available:true,busy:false,code:null,revision:0,session:null,uncertain:false,point_ages_ms:{}});
async function fixture(t,nested=false){
 const root=await mkdtemp(join(tmpdir(),'graphical-wire-')),handlers=new Map(),calls=[],posts=[];
 const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};
 const contents={id:321,mainFrame:frame,isDestroyed:()=>false,postMessage:(...a)=>posts.push(a)};
 let removed=false;
 const core={request:async()=>true,graphicalSession:{status:snapshot,request:async a=>{calls.push(a);return snapshot();},subscribe:cb=>{cb(snapshot());return()=>{removed=true;};}}};
 const binding=installAuthorityWire({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},contents,core,argv:nested?['--nested-depth=1']:[],env:{XDG_CONFIG_HOME:root}});
 t.after(async()=>{await binding.dispose();await rm(root,{recursive:true,force:true});});
 return {handlers,calls,posts,event:{sender:contents,senderFrame:frame},contents,binding,removed:()=>removed};
}
test('graphical IPC forwards one validated action and rejects wrong arity and sender before dispatch',async t=>{
 const f=await fixture(t),action={op:'attach',surface_id:'surface-one'},handler=f.handlers.get(GRAPHICAL_SESSION_CHANNELS.graphicalSessionRequest);
 assert.deepEqual(await handler(f.event,action),snapshot());assert.deepEqual(f.calls,[action]);
 for(const args of [[],[action,action],[{...action,owner_id:'actor-forged'}]])await assert.rejects(handler(f.event,...args),/ARGS|BAD_REQUEST/);
 await assert.rejects(handler({...f.event,sender:{...f.contents}},action),/SENDER/);
 assert.equal(f.calls.length,1);
 assert.equal(f.posts[0][0],'metaviewer:graphical-session.state');
 await f.binding.dispose();assert.equal(f.removed(),true);
});
test('nested wall cannot request graphical rewind or subscribe to its state',async t=>{
 const f=await fixture(t,true),status=await f.handlers.get(GRAPHICAL_SESSION_CHANNELS.graphicalSessionStatus)(f.event);
 assert.equal(status.available,false);assert.equal(status.session,null);assert.deepEqual(f.posts,[]);
 await assert.rejects(f.handlers.get(GRAPHICAL_SESSION_CHANNELS.graphicalSessionRequest)(f.event,{op:'attach',surface_id:'surface-one'}),/BAD_REQUEST/);
 assert.deepEqual(f.calls,[]);
});
test('preload keeps the graphical action and snapshot boundary closed',async()=>{
 const calls=[];
 const api=createPreloadFacade({transport:{invoke:async(c,a)=>{calls.push([c,a]);return snapshot();},subscribe:()=>()=>{}},bridge:{exposeInMainWorld(){}}});
 const action={op:'attach',surface_id:'surface-one'};
 assert.deepEqual(await api.graphicalSession.request(action),snapshot());
 assert.equal(calls[0][0],'metaviewer:graphical-session.request');assert.deepEqual(calls[0][1],[action]);
 await assert.rejects(api.graphicalSession.request({...action,runtime_id:'runtime-forged'}),/PAYLOAD/);assert.equal(calls.length,1);
 const bad=createPreloadFacade({transport:{invoke:async()=>({...snapshot(),path:'/private'})},bridge:{exposeInMainWorld(){}}});
 await assert.rejects(bad.graphicalSession.status(),/OUTCOME/);
});


test('graphical channel registration rollback removes exact prior handlers and releases the feature subscription',()=>{
 for(const failChannel of Object.values(GRAPHICAL_SESSION_CHANNELS)){
  const handlers=new Map(),registered=[],removed=[];let unsubscribed=0;
  const contents={id:900,mainFrame:{origin:'app://metaviewer',url:'app://metaviewer/index.html'},isDestroyed:()=>false,postMessage(){}};
  const core={request:async()=>true,graphicalSession:{status:snapshot,request:async()=>snapshot(),subscribe:cb=>{cb(snapshot());return()=>{unsubscribed++;};}}};
  assert.throws(()=>installAuthorityWire({ipcMain:{handle:(c,f)=>{if(c===failChannel)throw Error('registration failed');handlers.set(c,f);registered.push(c);},removeHandler:c=>{removed.push(c);handlers.delete(c);}},contents,core,env:{}}),/registration failed/);
  assert.deepEqual(removed,registered);assert.equal(handlers.size,0);assert.equal(unsubscribed,1);
 }
});

test('a malformed graphical payload quarantines only that feature and ordinary physical Stop still completes',async t=>{
 const root=await mkdtemp('/dev/shm/graphical-transport-'),sockets=new Set();let peer,seq=0;
 const reg=component=>({endpoint:{component,instance:component+'-graphical-test'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
 const config={session_id:'graphical-transport-test',core:reg('core'),peers:[reg('ui'),reg('agent')]};
 await mkdir(join(root,'metaviewer'),{mode:0o700});const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const surface={schema:'surface/v0.2',surface_id:'surface-transport',kind:'vm',display:':100',geometry:{w:400,h:300},state:'active',visibility:'unfolded',control:'agent',profile_id:'graphical-test'};
 const send=(body)=>peer.write(JSON.stringify({schema:body.schema==='graphical_session_event/v0.2'?'graphical_session_envelope/v0.2':'envelope/v0.2',msg_id:'reply-'+(++seq),ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:'nonce-'+seq,body})+'\n');
 const server=createServer(socket=>{peer=socket;sockets.add(socket);socket.on('error',()=>{});let buffer='';socket.on('data',data=>{buffer+=data;let offset;while((offset=buffer.indexOf('\n'))!==-1){const message=JSON.parse(buffer.slice(0,offset));buffer=buffer.slice(offset+1);if(message.body.schema==='hello/v0.2')send(config.core.hello);else if(message.body.schema==='surface_request/v0.2'&&message.body.op==='destroy')send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surface,state:'destroyed'}}});}});});
 t.after(async()=>{for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const socketPath=join(root,'metaviewer/core.sock');server.listen(socketPath);await once(server,'listening');await chmod(socketPath,0o600);
 const bindings=await createMainBindings({env:{MV_CORE_CONFIG:configPath,XDG_RUNTIME_DIR:root,MV_GRAPHICAL_SESSION_ENABLED:'1'},createMessageChannel:()=>({port1:Object.assign(new EventEmitter(),{postMessage(){},start(){},close(){}}),port2:{close(){}}})});t.after(()=>bindings.core.dispose());
 assert.equal(bindings.core.getStatus().availability,'live');send({schema:'surface_event/v0.2',event:'created',data:{surface}});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 send({schema:'graphical_session_event/v0.2',request_id:'invalid-payload'});
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(bindings.core.getStatus().availability,'live');
 if(process.arch==='arm64'){assert.equal(bindings.core.graphicalSession.status().uncertain,true);assert.equal(bindings.core.graphicalSession.commandAllowed(),false);}else assert.equal(bindings.core.graphicalSession,undefined);
 await bindings.core.stopSurface(surface.surface_id);assert.equal(bindings.core.getStatus().availability,'live');
});


test('default host boot never imports the optional graphical host; enabled ARM64 imports the real implementation',()=>{
 const hostURL=new URL('../electron/hostBindings.js',import.meta.url).href;
 for(const flag of ['0','1']){
  const code=`import {registerHooks} from 'node:module';import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:net';import {once,EventEmitter} from 'node:events';
  let loads=0;const enabled=process.arch==='arm64'&&${JSON.stringify(flag)}==='1';
  const hook=registerHooks({resolve(specifier,context,next){if(specifier.endsWith('graphicalSessionHost.js')){loads++;if(!enabled)throw Error('disabled optional graphical import');}return next(specifier,context);}});
  const {createMainBindings}=await import(${JSON.stringify(hostURL)});
  const root=await mkdtemp(join(tmpdir(),'graphical-import-')),sockets=new Set();let peer,seq=0;
  const reg=component=>({endpoint:{component,instance:component+'-lazy'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component,component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});
  const config={session_id:'graphical-lazy',core:reg('core'),peers:[reg('ui'),reg('agent')]};
  await mkdir(join(root,'metaviewer'),{mode:0o700});await writeFile(join(root,'config.json'),JSON.stringify(config),{mode:0o600});
  const server=createServer(socket=>{peer=socket;sockets.add(socket);socket.on('error',()=>{});socket.once('data',()=>socket.write(JSON.stringify({schema:'envelope/v0.2',msg_id:'hello',ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq:++seq,nonce:'hello',body:config.core.hello})+'\\n'));});
  server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');await chmod(join(root,'metaviewer/core.sock'),0o600);
  let bindings;try{bindings=await createMainBindings({env:{XDG_RUNTIME_DIR:root,MV_CORE_CONFIG:join(root,'config.json'),MV_GRAPHICAL_SESSION_ENABLED:${JSON.stringify(flag)}},createMessageChannel:()=>({port1:Object.assign(new EventEmitter(),{postMessage(){},start(){},close(){}}),port2:{close(){}}})});if((loads>0)!==enabled||Boolean(bindings.core.graphicalSession)!==enabled)throw Error('optional host import/admission mismatch');if(bindings.core.getStatus().availability!=='live')throw Error('ordinary host unavailable');}finally{await bindings?.core.dispose();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));hook.deregister();await rm(root,{recursive:true,force:true});}
  console.log('OPTIONAL_GRAPHICAL_IMPORT_OK');`;
  const run=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:10000});
  assert.equal(run.error,undefined,run.stderr);assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/OPTIONAL_GRAPHICAL_IMPORT_OK/);
 }
});
