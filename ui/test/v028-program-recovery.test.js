import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {createServer} from 'node:net';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installRoleHost} from '../electron/roleHost.js';
import {createMainBindings} from '../electron/hostBindings.js';

const registration = component => ({endpoint:{component,instance:component+'-v028'},
  hello:{schema:'hello/v0.2',contract_version:'v0.2',component,
    component_version:'0.1.1',component_commit:'a'.repeat(40),dependencies:[]}});

test('lost Program retains Stop authority until verified destroy, then reopens without restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'v028-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const states=new Map(),authority=new Map();let invoke,verified=false,stops=0,seq=0,profile;
 const window=new EventEmitter();window.webContents={session:{registerPreloadScript:()=>1,unregisterPreloadScript(){}}};
 const host=installRoleHost({electron:{ipcMain:{handle(_k,fn){invoke=fn;},removeHandler(){}}},window,
  env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:'{}'},capsuleStates:states,admit:()=>true,
  listIdentities:async()=>({ok:true,rows:profile?[{id:profile,browser:'program'}]:[]}),
  provisionProgramIdentity:async()=>({ok:true}),stageMode:async()=>async()=>{},
  core:{getHumanSurface:id=>authority.get(id),request:async req=>{
   profile=req.params.profile_id;
   const surface={schema:'surface/v0.2',surface_id:`surface-${++seq}`,kind:'desktop_capsule',profile_id:profile,state:'active',control:'agent'};
   states.set(surface.surface_id,surface);authority.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  },stopSurface:async id=>{stops++;return {schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...states.get(id),state:verified?'destroyed':'lost'}}};}},
 });t.after(()=>host.dispose());
 const call=(op,body={})=>invoke({}, {schema:'metaviewer.roles/v0.3',op,...body});
 const first=await call('create-program',{choice:{binary:process.execPath,role:'agent'}});assert.equal(first.ok,true);
 // The core can report loss before its presentation mirror receives the event.
 authority.set(first.surfaceId,{...states.get(first.surfaceId),state:'lost'});
 const rows=await call('programs');assert.equal(rows[0].currentMode,'lost');assert.equal(rows[0].surfaceId,first.surfaceId);
 const refused=await call('stop',{surfaceId:first.surfaceId});assert.equal(refused.code,'CAPSULE_STOP_UNPROVEN');assert.equal(stops,1);
 assert.equal((await call('open',{choice:{profileId:profile,role:'agent'}})).ok,false);
 verified=true;assert.equal((await call('stop',{surfaceId:first.surfaceId})).ok,true);assert.equal(stops,2);
 const reopened=await call('open',{choice:{profileId:profile,role:'agent'}});assert.equal(reopened.ok,true);assert.equal(reopened.profileId,first.profileId);assert.notEqual(reopened.surfaceId,first.surfaceId);
});

test('real hostBindings seam publishes destroyed state after lost surface is stopped',async t=>{
 const root=await mkdtemp(join(tmpdir(),'v028-seam-'));
 const sockets=new Set(),requests=[];
 const config={session_id:'v028-session',core:registration('core'),peers:[registration('ui')]};
 await mkdir(join(root,'metaviewer'),{mode:0o700});
 const configPath=join(root,'config.json');
 await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 let peer,seq=0,bindings;
 const send=body=>peer.write(JSON.stringify({schema:'envelope/v0.2',msg_id:'reply-'+(++seq),
  ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,
  seq,nonce:'nonce-'+seq,body})+'\n');
 const server=createServer(socket=>{
  peer=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  let buf='';
  socket.on('data',d=>{
   buf+=d;
   for(let nl;(nl=buf.indexOf('\n'))>=0;){
    const env=JSON.parse(buf.slice(0,nl));buf=buf.slice(nl+1);
    requests.push(env);
    if(env.body.schema==='hello/v0.2') send(config.core.hello);
   }
  });
 });
 t.after(async()=>{
  await bindings?.core.dispose();
  for(const s of sockets) s.destroy();
  await new Promise(r=>server.close(r));
  await rm(root,{recursive:true,force:true});
 });
 server.listen(join(root,'metaviewer/core.sock'));await once(server,'listening');
 await chmod(join(root,'metaviewer/core.sock'),0o600);
 const frameDir=join(root,'frames','w1');await mkdir(frameDir,{recursive:true,mode:0o700});
 const framePath=join(frameDir,'000001.rgb24');await writeFile(framePath,Buffer.alloc(12));
 bindings=await createMainBindings({
  env:{MV_CORE_CONFIG:configPath,XDG_RUNTIME_DIR:root,MV_SRF_STATE_DIR:root,
   MV_SRF_PROFILES:JSON.stringify({'prog-1':{Kind:'desktop_capsule',NativeKind:'program',
    Width:2,Height:2,Display:':100',RAMRoot:root}})},
  createMessageChannel:()=>({port1:Object.assign(new EventEmitter(),{postMessage(){},start(){},close(){}}),port2:{close(){}}})
 });
 const entries=[];
 bindings.wire.frames.subscribe(entry=>entries.push(entry));
 const surface={schema:'surface/v0.2',surface_id:'surface-prog-1',profile_id:'prog-1',
  kind:'desktop_capsule',display:':100',geometry:{w:2,h:2},state:'active',visibility:'unfolded',control:'agent'};
 send({schema:'surface_event/v0.2',event:'created',data:{surface}});
 send({schema:'frame_ref/v0.2',surface_id:'surface-prog-1',generation:1,ts_ns:100,
  width:2,height:2,pixel_format:'rgb24',stride_bytes:6,byte_len:12,
  sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',ramws_path:'/dev/shm/v028-frame.rgb24'});
 await new Promise(r=>setTimeout(r,30));
 send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surface,state:'lost'}}});
 await new Promise(r=>setTimeout(r,30));
 assert.equal(entries.some(e=>e.stateOnly&&e.state?.state==='lost'),true);
 const stopPromise=bindings.core.stopSurface('surface-prog-1');
 await new Promise(r=>setTimeout(r,20));
 send({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{...surface,state:'destroyed'}}});
 const stopped=await stopPromise;
 assert.equal(stopped.data.surface.state,'destroyed');
 await new Promise(r=>setTimeout(r,30));
 assert.equal(entries.some(e=>e.stateOnly&&e.state?.state==='destroyed'),true,'destroyed state after lost must reach renderer listeners so Lost tile disappears');
});
