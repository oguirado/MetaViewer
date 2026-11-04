import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once,EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,chmod,lstat,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {envelopeTagForBody,createMainBindings} from '../electron/hostBindings.js';
const reg=c=>({endpoint:{component:c,instance:c+'-headless'},hello:{schema:'hello/v0.2',contract_version:'v0.2',component:c,component_version:'0.2.5',component_commit:'a'.repeat(40),dependencies:[]}});
for(const wrongTag of [false,true,'hello'])test(wrongTag==='hello'?'capsule-tagged legacy hello refuses authentication':wrongTag?'legacy-tagged capsule event fails closed without replay':'authenticated command binding routes create and stop without a surface request',async t=>{
 const root=await mkdtemp('/dev/shm/mv-hl-');await mkdir(root+'/metaviewer',{mode:0o700});
 const config={session_id:'headless-test',core:reg('core'),peers:[reg('ui'),reg('agent')]};
 const owner='actor-'+createHash('sha256').update('agent:'+config.peers[1].endpoint.instance).digest('hex');
 await writeFile(root+'/config',JSON.stringify(config),{mode:0o600});
 await writeFile(root+'/profile',JSON.stringify({schema:'mv-guest-command-host/v1',owner_id:owner,guardian_unit:'synthetic.service',python:{},python_prefix:'/usr',runner:{},controller_relative:'mc06-controller/controller.py',files:[],config_template:{schema:'guest-command-host-config/v1',runtime_admitted:true,owner_id:owner},state_root:root,runtime_root:root}),{mode:0o600});
 let peer,seq=0;const requests=[];let current,currentToken;
 const send=body=>peer.write(JSON.stringify({schema:wrongTag==='hello'&&body.schema==='hello/v0.2'?'capsule_envelope/v0.2':wrongTag===true&&body.schema==='guest_command_event/v0.2'?'envelope/v0.2':envelopeTagForBody(body),msg_id:'reply-'+(++seq),ts_ns:0,from:config.core.endpoint,to:config.peers[0].endpoint,session_id:config.session_id,seq,nonce:'nonce-'+seq,body})+'\n');
 const server=createServer(socket=>{peer=socket;let buffer='';socket.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const e=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);const r=e.body;assert.equal(e.schema,envelopeTagForBody(r));if(r.schema==='hello/v0.2'){send(config.core.hello);continue;}requests.push(r);if(r.schema!=='guest_command_request/v0.2')continue;
 const length=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
 if(r.op==='create'){const ss=Buffer.from(config.session_id),rr=Buffer.from(r.request_id);current={schema:'guest_command_session/v0.2',workload_id:'workload-real',generation:1,owner_id:owner,profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64',phase:'starting',ownership:'held',jobs_started:0,job:null,controls:{cancel:null,stop:null}};currentToken='reservation-'+createHash('sha256').update(Buffer.concat([Buffer.from('MetaViewer/guest-command/reservation/v1\0'),length(ss.length),ss,length(rr.length),rr])).digest('hex');}
 const emit=(event,data)=>send({schema:'guest_command_event/v0.2',event_id:'event-'+seq,request_id:r.request_id,reservation_id:currentToken,owner_id:owner,session:structuredClone(current),event,data});
 if(r.op==='stop'){current.phase='stopping';current.controls.stop={request_id:r.request_id,ack:'accepted'};}
 emit('accepted',{op:r.op});current.phase=r.op==='create'?'ready':'stopped';if(r.op==='stop')current.ownership='released';emit(r.op==='create'?'ready':'stopped',r.op==='create'?{}:{native_absent:true});
 } });});
 server.listen(root+'/metaviewer/core.sock');await once(server,'listening');await chmod(root+'/metaviewer/core.sock',0o600);
 let binding;t.after(async()=>{await binding?.core.dispose();peer?.destroy();await new Promise(r=>server.close(r));await rm(root,{recursive:true});});
 const ino=(await lstat(root+'/metaviewer/core.sock')).ino;
 const connect=()=>createMainBindings({env:{XDG_RUNTIME_DIR:root,MV_CORE_CONFIG:root+'/config',MV_GUEST_COMMAND_ONLY:'1',MV_GUEST_COMMAND_PROFILE:root+'/profile'},createMessageChannel:()=>({port1:Object.assign(new EventEmitter(),{close(){},start(){},postMessage(){}}),port2:{close(){}}}),getPeerCredentials:()=>({pid:1,uid:process.getuid(),gid:process.getgid(),ino})});
 if(wrongTag==='hello'){await assert.rejects(connect());assert.equal(requests.length,0);return;}binding=await connect();
 const h=binding.core.guestCommand;assert.equal(h.status().available,true);const notices=[];const unsubscribe=h.subscribe(s=>notices.push(s));
 if(wrongTag){const outcome=await h.request({op:'create'});assert.equal(outcome.uncertain,true);assert.equal(requests.length,1);assert.equal(outcome.session,null);unsubscribe();return;}
 assert.equal((await h.request({op:'create'})).session.phase,'ready');assert.equal((await h.request({op:'stop',workload_id:'workload-real',generation:1})).session.ownership,'released');
 assert.deepEqual(requests.map(r=>r.schema),Array(2).fill('guest_command_request/v0.2'));assert.ok(notices.some(s=>s.session?.phase==='starting'));unsubscribe();
});
