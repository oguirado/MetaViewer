import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGuestCommandHost} from '../electron/guestCommandHost.js';
import {GC_SCHEMAS,gcAction,gcSnapshot} from '../electron/guestCommandValues.js';
import {installPreload} from '../electron/preload.js';
const owner='actor-'+'a'.repeat(64),target={workload_id:'workload-one',generation:1};
function fixture(timeoutMs=1000){const sent=[];let index=0;const h=createGuestCommandHost({send:b=>sent.push(b),available:()=>true,ownerId:owner,sessionId:'session-test',timeoutMs});let session={schema:'guest_command_session/v0.2',...target,owner_id:owner,profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64',phase:'starting',ownership:'held',jobs_started:0,job:null,controls:{cancel:null,stop:null}};let token;
 const event=(r,event,data={},change={})=>{session={...session,...change};if(!token){token=reservation(r.request_id);}h.receive({schema:'guest_command_event/v0.2',event_id:'event-'+(++index),request_id:r.request_id,reservation_id:token,owner_id:owner,session:structuredClone(session),event,data});};
 return{h,sent,event,get session(){return session;}};}
import {createHash} from 'node:crypto';
function reservation(r){const s=Buffer.from('session-test'),b=Buffer.from(r),l=n=>{const x=Buffer.alloc(4);x.writeUInt32BE(n);return x;};return'reservation-'+createHash('sha256').update(Buffer.concat([Buffer.from('MetaViewer/guest-command/reservation/v1\0'),l(s.length),s,l(b.length),b])).digest('hex');}
async function ready(f){const p=f.h.request({op:'create'}),r=f.sent.at(-1);f.event(r,'accepted',{op:'create'});f.event(r,'ready',{}, {phase:'ready'});await p;}
const action={op:'run',...target,command_utf8:'printf hi',cwd:'',stdin_b64:'',timeout_ms:1000};
test('canonical schemas and renderer authority closure',()=>{for(const [name,s]of Object.entries(GC_SCHEMAS))assert.deepEqual(s,JSON.parse(readFileSync(new URL('../../contracts/v0.2/'+name,import.meta.url))));for(const a of [{op:'create',profile:'foreign'},{...action,path:'/host'},{...action,workload_id:'workload-one\n'},{...action,stdin_b64:'Zg==\n'}, {...action,stdin_b64:'Zh=='},{...action,generation:true},{...action,cwd:'../x'}])assert.equal(gcAction(a),false);assert.equal(gcAction(action),true);});
test('run remains pending while independently accepted cancel resolves',async()=>{const f=fixture();await ready(f);const p=f.h.request(action),run=f.sent.at(-1);const job={job_id:run.params.job_id,state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false};f.event(run,'accepted',{op:'run'},{phase:'running',jobs_started:1,job});assert.equal(f.h.status().canCancel,true);const c=f.h.request({op:'cancel',...target,job_id:job.job_id}),cancel=f.sent.at(-1);f.event(cancel,'accepted',{op:'cancel'},{phase:'cancelling',controls:{cancel:{request_id:cancel.request_id,ack:'accepted'},stop:null}});await c;assert.equal(f.h.status().busy,true);f.event(run,'job_finished',{job_id:job.job_id,cause:'cancel',cancel_request_id:cancel.request_id,stop_request_id:null,stdout_sha256:createHash('sha256').digest('hex'),stderr_sha256:createHash('sha256').digest('hex'),stdout_sent_bytes:0,stderr_sent_bytes:0,guest_job_empty:true},{phase:'ready',job:{...job,state:'cancelled',signal:9,output_complete:true}});assert.equal((await p).session.job.state,'cancelled');f.h.disconnect();});
test('idle original-create uncertainty preserves known job and blocks new run',async()=>{const f=fixture();await ready(f);const create=f.sent[0];f.event(create,'outcome_unknown',{op:'create',code:'TRANSPORT'},{phase:'uncertain'});assert.equal(f.h.status().uncertain,true);await f.h.request(action);assert.equal(f.sent.length,1);f.h.disconnect();});
test('one unknown resolves concurrent promises without resend',async()=>{const f=fixture();await ready(f);const p=f.h.request(action),run=f.sent.at(-1);const job={job_id:run.params.job_id,state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false};f.event(run,'accepted',{op:'run'},{phase:'running',jobs_started:1,job});const stop=f.h.request({op:'stop',...target});f.event(run,'outcome_unknown',{op:'run',code:'TRANSPORT'},{phase:'uncertain',job:{...job,state:'unknown'}});assert.equal((await p).uncertain,true);assert.equal((await stop).uncertain,true);assert.equal(f.sent.length,3);f.h.disconnect();});
test('native preload supports command subscription/status and refuses arbitrary channel',async()=>{const listeners=new Map(),calls=[];const snapshot={available:true,busy:false,canCancel:false,code:null,revision:1,session:null,uncertain:false,stdout:'',stderr:''};const api=installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async(c,...args)=>{calls.push([c,args]);return snapshot;},on:(c,f)=>listeners.set(c,f),removeListener:c=>listeners.delete(c)}});api.guestCommand.subscribe(s=>assert.equal(gcSnapshot(s),true));assert.ok(listeners.has('metaviewer:guest-command.state'));assert.deepEqual(await api.guestCommand.status(),snapshot);assert.equal(calls[0][0],'metaviewer:guest-command.status');await assert.rejects(api.guestCommand.request({op:'create',path:'evil'}));await assert.rejects(api.guestCommand.status('extra'));});
test('timeout consumes create and never automatically retries',async()=>{const f=fixture(5);assert.equal((await f.h.request({op:'create'})).uncertain,true);await f.h.request({op:'create'});assert.equal(f.sent.length,1);f.h.disconnect();});
test('foreign ownership and premature ready never become success',async()=>{const f=fixture();const p=f.h.request({op:'create'}),r=f.sent[0];assert.throws(()=>f.h.receive({schema:'guest_command_event/v0.2',event_id:'event-foreign',request_id:r.request_id,reservation_id:reservation(r.request_id),owner_id:'actor-other',session:f.session,event:'ready',data:{}}));assert.throws(()=>f.event(r,'ready',{}, {phase:'ready'}));f.h.disconnect();assert.equal((await p).uncertain,true);});
test('accepted run and cancel retain a locally pending Stop causal projection',async()=>{
 for(const withCancel of [false,true]){
  const f=fixture();await ready(f);const runPromise=f.h.request(action),run=f.sent.at(-1);
  const job={job_id:run.params.job_id,state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false};
  let cancel,cancelPromise;
  if(withCancel){f.event(run,'accepted',{op:'run'},{phase:'running',jobs_started:1,job});cancelPromise=f.h.request({op:'cancel',...target,job_id:job.job_id});cancel=f.sent.at(-1);}
  const stopPromise=f.h.request({op:'stop',...target}),stop=f.sent.at(-1);
  const controls={cancel:cancel?{request_id:cancel.request_id,ack:'accepted'}:null,stop:{request_id:stop.request_id,ack:'pending'}};
  f.event(cancel??run,'accepted',{op:cancel?'cancel':'run'},{phase:'stopping',jobs_started:1,job:cancel?{...job,state:'cancelling'}:job,controls});
  if(cancelPromise)await cancelPromise;
  assert.equal(f.h.status().session.phase,'stopping');assert.equal(f.h.status().busy,true);
  f.event(stop,'accepted',{op:'stop'},{controls:{...controls,stop:{request_id:stop.request_id,ack:'accepted'}}});
  f.event(run,'job_finished',{job_id:job.job_id,cause:'stop',cancel_request_id:cancel?.request_id??null,stop_request_id:stop.request_id,stdout_sent_bytes:0,stderr_sent_bytes:0,stdout_sha256:createHash('sha256').digest('hex'),stderr_sha256:createHash('sha256').digest('hex'),guest_job_empty:true},{job:{...job,state:'cancelled',signal:9,output_complete:true}});
  await runPromise;assert.equal(f.h.status().busy,true);
  f.event(stop,'stopped',{native_absent:true},{phase:'stopped',ownership:'released'});assert.equal((await stopPromise).session.ownership,'released');f.h.disconnect();
 }
});
test('stopping acceptance without the exact local pending Stop refuses',async()=>{
 for(const mode of ['missing','foreign','wrong-ack']){
  const f=fixture();await ready(f);const runPromise=f.h.request(action),run=f.sent.at(-1);
  const stopPromise=mode==='missing'?null:f.h.request({op:'stop',...target});const stop=f.sent.at(-1);
  const job={job_id:run.params.job_id,state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false};
  assert.throws(()=>f.event(run,'accepted',{op:'run'},{phase:'stopping',jobs_started:1,job,controls:{cancel:null,stop:{request_id:mode==='foreign'?'request-foreign':stop.request_id,ack:mode==='wrong-ack'?'accepted':'pending'}}}));
  f.h.disconnect();await runPromise;if(stopPromise)await stopPromise;
 }
});
test('create uncertainty before the first ACK settles immediately without a tuple',async()=>{
 const f=fixture();const p=f.h.request({op:'create'}),r=f.sent[0];
 f.h.receive({schema:'guest_command_event/v0.2',event_id:'event-unbound',request_id:r.request_id,reservation_id:reservation(r.request_id),owner_id:owner,session:null,event:'outcome_unknown',data:{op:'create',code:'TRANSPORT'}});
 const out=await p;assert.equal(out.uncertain,true);assert.equal(out.session,null);assert.equal(out.busy,false);await f.h.request({op:'create'});assert.equal(f.sent.length,1);f.h.disconnect();
});
test('refused Stop publishes authoritative restored control state',async()=>{
 const f=fixture();await ready(f);const runPromise=f.h.request(action),run=f.sent.at(-1),stopPromise=f.h.request({op:'stop',...target}),stop=f.sent.at(-1);
 const job={job_id:run.params.job_id,state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false};
 f.event(run,'accepted',{op:'run'},{phase:'stopping',jobs_started:1,job,controls:{cancel:null,stop:{request_id:stop.request_id,ack:'pending'}}});
 f.event(stop,'refused',{op:'stop',code:'BUSY'},{phase:'running',controls:{cancel:null,stop:null}});
 const result=await stopPromise;assert.equal(result.session.phase,'running');assert.equal(result.session.controls.stop,null);assert.equal(result.busy,true);f.h.disconnect();await runPromise;
});
test('Ready retains a witnessed pending Stop before its ACK',async()=>{
 const f=fixture(),createPromise=f.h.request({op:'create'}),create=f.sent[0];f.event(create,'accepted',{op:'create'});
 const stopPromise=f.h.request({op:'stop',...target}),stop=f.sent.at(-1);
 f.event(create,'ready',{}, {phase:'awaiting_control',controls:{cancel:null,stop:{request_id:stop.request_id,ack:'pending'}}});
 assert.equal((await createPromise).session.phase,'awaiting_control');assert.equal(f.h.status().busy,true);
 f.event(stop,'accepted',{op:'stop'},{phase:'stopping',controls:{cancel:null,stop:{request_id:stop.request_id,ack:'accepted'}}});
 f.event(stop,'stopped',{native_absent:true},{phase:'stopped',ownership:'released'});await stopPromise;f.h.disconnect();
});
test('Stop ACK retains finished job and awaiting Cancel refusal',async()=>{
 const f=fixture();await ready(f);const runPromise=f.h.request(action),run=f.sent.at(-1),job={job_id:run.params.job_id,state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false};
 f.event(run,'accepted',{op:'run'},{phase:'running',jobs_started:1,job});const cancelPromise=f.h.request({op:'cancel',...target,job_id:job.job_id}),cancel=f.sent.at(-1);
 const controls={cancel:{request_id:cancel.request_id,ack:'pending'},stop:null};
 f.event(run,'job_finished',{job_id:job.job_id,cause:'exit',cancel_request_id:null,stop_request_id:null,stdout_sent_bytes:0,stderr_sent_bytes:0,stdout_sha256:createHash('sha256').digest('hex'),stderr_sha256:createHash('sha256').digest('hex'),guest_job_empty:true},{phase:'awaiting_control',job:{...job,state:'exited',exit_code:0,output_complete:true},controls});await runPromise;
 const stopPromise=f.h.request({op:'stop',...target}),stop=f.sent.at(-1);
 f.event(stop,'accepted',{op:'stop'},{controls:{...controls,stop:{request_id:stop.request_id,ack:'accepted'}}});
 assert.equal(f.h.status().session.phase,'awaiting_control');assert.equal(f.h.status().session.job.state,'exited');
 f.event(cancel,'refused',{op:'cancel',code:'INVALID'},{phase:'stopping',controls:{cancel:{request_id:cancel.request_id,ack:'refused'},stop:{request_id:stop.request_id,ack:'accepted'}}});await cancelPromise;
 f.event(stop,'stopped',{native_absent:true},{phase:'stopped',ownership:'released'});await stopPromise;f.h.disconnect();
});
