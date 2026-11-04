import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createGuestCommandObservation,validGuestCommandObservation} from '../electron/guestCommandObservation.js';
import {gcValid} from '../electron/guestCommandValues.js';
const owner='actor-'+createHash('sha256').update('agent:agent-one').digest('hex');
const session={schema:'guest_command_session/v0.2',workload_id:'workload-one',generation:1,owner_id:owner,profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64',phase:'ready',ownership:'held',jobs_started:0,job:null,controls:{cancel:null,stop:null}};
const record={schema:'guest_command_observation/v0.2',event_id:'event-observation',event:'accepted_run',accepted_event_id:'event-accepted',request_id:'request-run',reservation_id:'reservation-create',owner_id:owner,workload_id:'workload-one',generation:1,job_id:'job-one',requester:{component:'agent',instance:'agent-one'},command_utf8:'printf ok',cwd:'',timeout_ms:1000};
const job={job_id:'job-one',state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false};
const clone=v=>structuredClone(v);
const meta=seq=>({session_id:'session-one',from:{component:'core',instance:'core-one'},to:{component:'ui',instance:'ui-one'},seq});
const event=(kind,id,data,s={})=>({schema:'guest_command_event/v0.2',event_id:id,request_id:'request-run',reservation_id:'reservation-create',owner_id:owner,event:kind,data,session:{...clone(session),phase:'running',jobs_started:1,job:clone(job),...s}});
const accepted=()=>event('accepted','event-accepted',{op:'run'});
function fixture(){return createGuestCommandObservation({sessionId:'session-one',coreInstance:'core-one',uiInstance:'ui-one',agentInstance:'agent-one',session:clone(session),reservationId:'reservation-create'});}
function join(h){h.observe(clone(record),meta(10));return h.receive(accepted(),meta(11));}
function finished(text='ok'){
 const hash=createHash('sha256').update(text).digest('hex');
 return event('job_finished','event-finished',{job_id:'job-one',cause:'exit',cancel_request_id:null,stop_request_id:null,stdout_sent_bytes:Buffer.byteLength(text),stderr_sent_bytes:0,stdout_sha256:hash,stderr_sha256:createHash('sha256').digest('hex'),guest_job_empty:true},{phase:'ready',job:{...job,state:'exited',exit_code:0,stdout_bytes:Buffer.byteLength(text),output_complete:true}});
}
function output(){return event('output','event-output',{job_id:'job-one',stream:'stdout',chunk_index:0,data_b64:Buffer.from('ok').toString('base64')},{job:{...job,stdout_bytes:2}});}
test('canonical fixture and real accepted event obey immutable contracts',()=>{
 const file=JSON.parse(readFileSync(new URL('../../contracts/examples/v0.2/guest_command_observation.valid.json',import.meta.url)));
 assert.equal(validGuestCommandObservation(file),true);assert.equal(gcValid('guest_command_event.schema.json',accepted()),true);
 const schema=JSON.parse(readFileSync(new URL('../../contracts/v0.2/guest_command_observation.schema.json',import.meta.url)));
 assert.deepEqual(Object.keys(record).sort(),schema.required.toSorted());assert.equal(schema.additionalProperties,false);
});
test('stage is read-only; exact join, output conservation and labelled history',()=>{
 const h=fixture();const s=h.observe(record,meta(10));assert.equal(s.active,null);assert.equal(s.uncertain,false);
 assert.equal(joined(h).active.command_utf8,'printf ok');
 function joined(x){return x.receive(accepted(),meta(11));}
 assert.equal(h.receive(output(),meta(12)).active.stdout,'ok');const end=h.receive(finished(),meta(13));assert.equal(end.active,null);assert.equal(end.history[0].stdout,'ok');assert.equal(end.history[0].generation,1);
 end.history[0].command_utf8='changed';assert.equal(h.snapshot().history[0].command_utf8,'printf ok');
});
test('unknown keys, accessors, scalar and UTF8 limits are refused',()=>{
 for(const mutate of [v=>v.stdin='secret',v=>v.generation=true,v=>v.command_utf8='\0',v=>v.command_utf8='\ud800',v=>v.command_utf8='😀'.repeat(4097),v=>v.cwd='../work',v=>v.cwd='/work',v=>v.timeout_ms=60001,v=>Object.defineProperty(v,'cwd',{get(){throw Error('getter executed');},enumerable:true})]){const v=clone(record);mutate(v);assert.equal(validGuestCommandObservation(v),false);}
});
test('foreign or unproven gateway metadata cannot stage',()=>{
 for(const mutate of [m=>m.from.component='agent',m=>m.from.instance='other',m=>m.to.instance='other',m=>m.session_id='other',m=>m.authenticated=true,m=>m.seq=0]){const h=fixture(),m=meta(10);mutate(m);assert.throws(()=>h.observe(record,m),/OBSERVATION/);assert.equal(h.snapshot().active,null);assert.equal(h.snapshot().uncertain,true);}
});
test('all join identities and adjacency must match',()=>{
 for(const mutate of [e=>e.event_id='event-other',e=>e.request_id='request-other',e=>e.reservation_id='reservation-other',e=>e.owner_id='actor-other',e=>e.session.owner_id='actor-other',e=>e.session.workload_id='workload-other',e=>e.session.generation=2,e=>e.session.job.job_id='job-other',e=>e.data.op='stop']){const h=fixture();h.observe(record,meta(10));const e=accepted();mutate(e);assert.throws(()=>h.receive(e,meta(11)),/OBSERVATION/);assert.equal(h.snapshot().active,null);}
 const h=fixture();h.observe(record,meta(10));assert.throws(()=>h.receive(accepted(),meta(12)),/OBSERVATION/);
});
test('foreign requester and future/stale observation refused before adoption',()=>{
 for(const mutate of [v=>v.requester.instance='foreign',v=>v.generation=2,v=>v.generation=0,v=>v.reservation_id='reservation-other']){const h=fixture(),v=clone(record);mutate(v);assert.throws(()=>h.observe(v,meta(10)),/OBSERVATION/);}
});
test('accepted or output without pair cannot fabricate pending operation',()=>{
 for(const e of [accepted(),output()]){const h=fixture();assert.throws(()=>h.receive(e,meta(11)),/OBSERVATION/);assert.equal(h.snapshot().active,null);}
});
test('duplicate/replayed pair and reused request ID fail closed',()=>{
 const h=fixture();join(h);assert.throws(()=>h.receive(accepted(),meta(12)),/OBSERVATION/);assert.equal(h.snapshot().uncertain,true);
 const q=fixture();q.observe(record,meta(10));assert.throws(()=>q.observe({...record,event_id:'event-new'},meta(11)),/OBSERVATION/);
});
test('wrong output count/index/hash does not become complete',()=>{
 for(const mutate of [e=>e.data.chunk_index=1,e=>e.session.job.stdout_bytes=3,e=>e.data.data_b64='!!!']){const h=fixture();join(h);const e=output();mutate(e);assert.throws(()=>h.receive(e,meta(12)),/OBSERVATION/);assert.equal(h.snapshot().history.length,0);}
 const h=fixture();join(h);h.receive(output(),meta(12));const e=finished();e.data.stdout_sha256='a'.repeat(64);assert.throws(()=>h.receive(e,meta(13)),/OBSERVATION/);assert.equal(h.snapshot().history.length,0);
});
test('normalized ready retires generation, retains labelled history, rejects old records',()=>{
 const h=fixture();join(h);h.receive(output(),meta(12));h.receive(finished(),meta(13));h.retire({...clone(session),generation:2},1);
 assert.equal(h.snapshot().generation,2);assert.equal(h.snapshot().history[0].generation,1);assert.throws(()=>h.observe({...record,event_id:'event-late'},meta(14)),/OBSERVATION/);
});
test('new generation can join a new command without relabelling previous output',()=>{
 const h=fixture();join(h);h.receive(output(),meta(12));h.receive(finished(),meta(13));h.retire({...clone(session),generation:2},1);
 const v={...clone(record),generation:2,event_id:'event-new-observation',accepted_event_id:'event-new-accepted',request_id:'request-new',job_id:'job-new'};
 h.observe(v,meta(14));const e=accepted();e.event_id=v.accepted_event_id;e.request_id=v.request_id;e.session.generation=2;e.session.job.job_id=v.job_id;h.receive(e,meta(15));assert.equal(h.snapshot().active.generation,2);assert.equal(h.snapshot().history[0].stdout,'ok');
});
test('loss and unresolved active work cannot be cleared by invented restore',()=>{
 const h=fixture();join(h);h.lost();assert.throws(()=>h.retire({...clone(session),generation:2},1),/OBSERVATION/);assert.equal(h.snapshot().active.state,'unknown');assert.throws(()=>h.observe({...record,event_id:'event-next'},meta(12)),/OBSERVATION/);
});
test('stopping acceptance stays stopping and grants no control API',()=>{
 const h=fixture();h.observe(record,meta(10));const e=accepted();e.session.phase='stopping';e.session.controls.stop={request_id:'request-stop',ack:'pending'};const s=h.receive(e,meta(11));assert.equal(s.active.state,'stopping');assert.deepEqual(Object.keys(h).sort(),['lost','observe','receive','retire','snapshot']);assert.equal('canCancel' in s,false);
});

test('accepted cannot invent prior output or skip the job counter',()=>{
 for(const mutate of [e=>e.session.job.stdout_bytes=1,e=>e.session.job.stderr_bytes=1,e=>e.session.job.output_complete=true,e=>e.session.jobs_started=2]){const h=fixture();h.observe(record,meta(10));const e=accepted();mutate(e);assert.throws(()=>h.receive(e,meta(11)),/OBSERVATION/);assert.equal(h.snapshot().active,null);}
});
