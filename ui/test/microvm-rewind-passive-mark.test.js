import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createGuestCommandHost} from '../electron/guestCommandHost.js';
import {createRewindHost} from '../electron/rewindHost.js';
const template=()=>JSON.parse(readFileSync(new URL('../../contracts/examples/v0.2/rewind_session.valid.json',import.meta.url),'utf8'));
function fixture(timeoutMs=100){
 const sent=[],commits=[];let seq=0;
 const gc={available:true,busy:false,uncertain:false,session:{workload_id:'workload-one',generation:1,owner_id:'actor-one',backend:'firecracker',isa:'aarch64',phase:'ready',ownership:'held',controls:{cancel:null,stop:null}}};
 const host=createRewindHost({send:b=>sent.push(b),available:()=>true,ownerId:'actor-one',guest:()=>gc,commitReady:(s,prior)=>{commits.push({s:structuredClone(s),prior});gc.session={...gc.session,generation:s.generation};},timeoutMs});
 const event=(kind,session,data={op:'mark'},rid='request-agent-mark')=>({schema:'rewind_event/v0.2',event_id:'event-passive-'+ ++seq,request_id:rid,owner_id:'actor-one',event:kind,session,data});
 const accepted=()=>({...template(),phase:'marking',generation:2,authority_epoch:2,pending_request_id:'request-agent-mark',points:[],last_good_usable:null});
 const completed=()=>({...template(),phase:'ready',generation:2,authority_epoch:2,pending_request_id:null});
 return {host,sent,commits,gc,event,accepted,completed};
}
test('authenticated agent mark is observed without sending or fabricating a UI request',()=>{
 const f=fixture();f.host.receive(f.event('accepted',f.accepted()));
 assert.equal(f.host.status().busy,true);assert.equal(f.host.commandAllowed(),false);assert.equal(f.commits.length,0);assert.deepEqual(f.sent,[]);
 f.host.receive(f.event('completed',f.completed(),{op:'mark',point_id:f.completed().points[0].point_id}));
 assert.equal(f.host.status().busy,false);assert.equal(f.host.commandAllowed(),true);assert.equal(f.commits.length,1);assert.equal(f.commits[0].prior,1);assert.equal(f.gc.session.generation,2);assert.deepEqual(f.sent,[]);f.host.disconnect();
});
test('passive mark rejects foreign, stale, jumping, unsolicited other ops and completion-before-acceptance',()=>{
 for(const mutate of [e=>{e.owner_id='actor-foreign';},e=>{e.session.workload_id='workload-foreign';},e=>{e.session.generation=1;},e=>{e.session.generation=3;},e=>{e.session.authority_epoch=3;},e=>{e.session.pending_request_id='request-foreign';},e=>{e.session.points=template().points;},e=>{e.data.op='restore';}]){
  const f=fixture(),e=f.event('accepted',f.accepted());mutate(e);const before=f.host.status();assert.throws(()=>f.host.receive(e));assert.deepEqual(f.host.status(),before);assert.deepEqual(f.sent,[]);f.host.disconnect();
 }
 const f=fixture();assert.throws(()=>f.host.receive(f.event('completed',f.completed(),{op:'mark',point_id:f.completed().points[0].point_id})));assert.deepEqual(f.sent,[]);f.host.disconnect();
});
test('only exact accepted mark completion may commit, no overlapping local or passive operation',async()=>{
 const f=fixture();f.host.receive(f.event('accepted',f.accepted()));const prior=f.host.status();
 assert.throws(()=>f.host.receive(f.event('accepted',f.accepted(),{op:'mark'},'request-other')));
 for(const mutate of [e=>{e.request_id='request-other';},e=>{e.session.generation=3;},e=>{e.session.authority_epoch=3;},e=>{e.data.point_id='point-foreign';},e=>{e.session.points[0].source_generation=2;},e=>{e.session.compatibility_sha256='f'.repeat(64);},e=>{e.session.points[0].status='unavailable';},e=>{e.session.points[0].active_references=1;},e=>{e.session.points[0].created_order=2;}]){
  const e=f.event('completed',f.completed(),{op:'mark',point_id:f.completed().points[0].point_id});mutate(e);assert.throws(()=>f.host.receive(e));assert.deepEqual(f.host.status(),prior);
 }
 await f.host.request({op:'mark',workload_id:'workload-one',generation:2,authority_epoch:2,label:'Local'});assert.deepEqual(f.sent,[]);assert.equal(f.commits.length,0);f.host.disconnect();
});
test('observed unknown remains fenced and never retries or accepts a late completion',()=>{
 const f=fixture();f.host.receive(f.event('accepted',f.accepted()));
 f.host.receive(f.event('outcome_unknown',{...f.accepted(),phase:'uncertain'},{op:'mark',code:'TRANSPORT'}));
 assert.equal(f.host.status().uncertain,true);assert.equal(f.host.commandAllowed(),false);assert.deepEqual(f.sent,[]);assert.equal(f.commits.length,0);
 assert.throws(()=>f.host.receive(f.event('completed',f.completed(),{op:'mark',point_id:f.completed().points[0].point_id})));f.host.disconnect();
});

test('actual guest and rewind hosts retain the next-generation agent observation after passive mark',async()=>{
 const sent=[],owner='actor-'+createHash('sha256').update('agent:agent-one').digest('hex');let sequence=0,rewind;
 const guest=createGuestCommandHost({send:b=>sent.push(b),available:()=>true,ownerId:owner,sessionId:'session-test',commandAllowed:()=>rewind.commandAllowed(),observationIdentity:{coreInstance:'core-one',uiInstance:'ui-one',agentInstance:'agent-one'}});
 rewind=createRewindHost({send:b=>sent.push(b),available:()=>true,ownerId:owner,guest:guest.status,commitReady:guest.commitRewind});
 const meta=()=>({session_id:'session-test',from:{component:'core',instance:'core-one'},to:{component:'ui',instance:'ui-one'},seq:++sequence});
 const created=guest.request({op:'create'}),create=sent[0];
 const length=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},ss=Buffer.from('session-test'),rr=Buffer.from(create.request_id);
 const reservation='reservation-'+createHash('sha256').update(Buffer.concat([Buffer.from('MetaViewer/guest-command/reservation/v1\0'),length(ss.length),ss,length(rr.length),rr])).digest('hex');
 let state={schema:'guest_command_session/v0.2',workload_id:'workload-one',generation:1,owner_id:owner,profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64',phase:'starting',ownership:'held',jobs_started:0,job:null,controls:{cancel:null,stop:null}};
 function emit(kind,requestId,data,eventId='event-gc-'+(sequence+1)){
  guest.receive({schema:'guest_command_event/v0.2',event_id:eventId,request_id:requestId,reservation_id:reservation,owner_id:owner,event:kind,session:structuredClone(state),data},meta());
 }
 emit('accepted',create.request_id,{op:'create'});state.phase='ready';emit('ready',create.request_id,{});await created;
 function observedRun(index,text){
  state=structuredClone(guest.status().session);const request='request-agent-'+index,job='job-agent-'+index,accepted='event-agent-accepted-'+index;
  guest.observe({schema:'guest_command_observation/v0.2',event_id:'event-observation-'+index,event:'accepted_run',accepted_event_id:accepted,request_id:request,reservation_id:reservation,owner_id:owner,workload_id:state.workload_id,generation:state.generation,job_id:job,requester:{component:'agent',instance:'agent-one'},command_utf8:'printf '+text,cwd:'',timeout_ms:1000},meta());
  state.phase='running';state.jobs_started++;state.job={job_id:job,state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false};emit('accepted',request,{op:'run'},accepted);
  state.job.stdout_bytes=Buffer.byteLength(text);emit('output',request,{job_id:job,stream:'stdout',chunk_index:0,data_b64:Buffer.from(text).toString('base64')});
  state.phase='ready';state.job={...state.job,state:'exited',exit_code:0,output_complete:true};emit('job_finished',request,{job_id:job,cause:'exit',cancel_request_id:null,stop_request_id:null,stdout_sent_bytes:Buffer.byteLength(text),stderr_sent_bytes:0,stdout_sha256:createHash('sha256').update(text).digest('hex'),stderr_sha256:createHash('sha256').digest('hex'),guest_job_empty:true});
 }
 observedRun(1,'created-and-read-back');
 const accepted={...template(),owner_id:owner,phase:'marking',generation:2,authority_epoch:2,pending_request_id:'request-agent-mark',points:[],last_good_usable:null};
 rewind.receive({schema:'rewind_event/v0.2',event_id:'event-rw-accepted',request_id:'request-agent-mark',owner_id:owner,event:'accepted',session:accepted,data:{op:'mark'}});
 const completed={...template(),owner_id:owner,phase:'ready',generation:2,authority_epoch:2,pending_request_id:null};
 rewind.receive({schema:'rewind_event/v0.2',event_id:'event-rw-completed',request_id:'request-agent-mark',owner_id:owner,event:'completed',session:completed,data:{op:'mark',point_id:completed.points[0].point_id}});
 observedRun(2,'deleted-and-read-back');
 assert.equal(guest.status().available,true);assert.equal(guest.status().uncertain,false);assert.equal(guest.status().busy,false);assert.equal(guest.status().session.generation,2);assert.equal(guest.status().stdout,'deleted-and-read-back');
 assert.equal(rewind.status().available,true);assert.equal(rewind.commandAllowed(),true);assert.equal(rewind.status().uncertain,false);
 assert.deepEqual(guest.observationSnapshot().history.map(item=>[item.generation,item.stdout]),[[1,'created-and-read-back'],[2,'deleted-and-read-back']]);
 assert.equal(sent.length,1);assert.equal(sent[0].op,'create');rewind.disconnect();guest.disconnect();
});
test('passive mark ring rotation preserves retained point bytes and only evicts oldest unreferenced point',()=>{
 const f=fixture();
 for(let i=1;i<=3;i++){
  const prior=f.host.status().session,points=prior?.points??[],gen=f.gc.session.generation,epoch=prior?.authority_epoch??1,rid='request-ring-'+i;
  const accepted={...template(),generation:gen+1,authority_epoch:epoch+1,phase:'marking',pending_request_id:rid,points:structuredClone(points),last_good_usable:prior?.last_good_usable??null};
  f.host.receive(f.event('accepted',accepted,{op:'mark'},rid));
  const added={...template().points[0],point_id:'point-ring-'+i,created_order:i,source_generation:gen,source_authority_epoch:epoch};
  const ring=[...(points.length===2?points.slice(1):points),added];
  const completed={...accepted,phase:'ready',pending_request_id:null,points:ring,last_good_usable:added.point_id};
  f.host.receive(f.event('completed',completed,{op:'mark',point_id:added.point_id},rid));
 }
 assert.deepEqual(f.host.status().session.points.map(p=>p.point_id),['point-ring-2','point-ring-3']);assert.equal(f.commits.length,3);assert.deepEqual(f.sent,[]);f.host.disconnect();
});

test('Stop during an observed mark preserves stopping until authenticated guest closure',()=>{
 const f=fixture();f.host.receive(f.event('accepted',f.accepted()));
 f.gc.session={...f.gc.session,generation:2,phase:'stopping',controls:{cancel:null,stop:{request_id:'request-stop',ack:'accepted'}}};
 const completed={...f.completed(),phase:'stopping'};
 f.host.receive(f.event('completed',completed,{op:'mark',point_id:completed.points[0].point_id}));
 assert.equal(f.host.commandAllowed(),false);assert.equal(f.commits.length,0);assert.deepEqual(f.host.stopTarget(),{workload_id:'workload-one',generation:2});
 f.gc.session={...f.gc.session,phase:'stopped',ownership:'released'};f.host.guestClosed();
 assert.equal(f.host.status().session.ownership,'released');assert.equal(f.host.stopTarget(),null);assert.deepEqual(f.sent,[]);f.host.disconnect();
});
test('observed mark times out without retry and duplicates cannot resurrect it',async()=>{
 const f=fixture(1),accepted=f.event('accepted',f.accepted());f.host.receive(accepted);
 assert.throws(()=>f.host.receive(accepted));
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(f.host.status().uncertain,true);assert.equal(f.host.commandAllowed(),false);assert.equal(f.commits.length,0);assert.deepEqual(f.sent,[]);
 assert.throws(()=>f.host.receive(f.event('completed',f.completed(),{op:'mark',point_id:f.completed().points[0].point_id})));f.host.disconnect();
});
test('local and observed marks share one bounded history capacity',async()=>{
 const f=fixture();
 for(let i=1;i<=256;i++){
  const prior=f.host.status().session,points=prior?.points??[],gen=f.gc.session.generation,epoch=prior?.authority_epoch??1;
  let promise=null,rid='request-cap-'+i;
  if(i===1){promise=f.host.request({op:'mark',workload_id:'workload-one',generation:gen,authority_epoch:epoch,label:'Local first'});rid=f.sent[0].request_id;}
  const accepted={...template(),generation:gen+1,authority_epoch:epoch+1,phase:'marking',pending_request_id:rid,points:structuredClone(points),last_good_usable:prior?.last_good_usable??null};
  f.host.receive(f.event('accepted',accepted,{op:'mark'},rid));
  const added={...template().points[0],point_id:'point-cap-'+i,created_order:i,source_generation:gen,source_authority_epoch:epoch};
  const completed={...accepted,phase:'ready',pending_request_id:null,points:[...(points.length===2?points.slice(1):points),added],last_good_usable:added.point_id};
  f.host.receive(f.event('completed',completed,{op:'mark',point_id:added.point_id},rid));if(promise)await promise;
 }
 const current=f.host.status().session;
 const extra={...current,generation:current.generation+1,authority_epoch:current.authority_epoch+1,phase:'marking',pending_request_id:'request-overflow'};
 assert.throws(()=>f.host.receive(f.event('accepted',extra,{op:'mark'},'request-overflow')));
 await f.host.request({op:'mark',workload_id:current.workload_id,generation:current.generation,authority_epoch:current.authority_epoch,label:'Over cap'});
 assert.equal(f.host.status().code,'BUSY');assert.equal(f.commits.length,256);assert.equal(f.sent.length,1);f.host.disconnect();
});
