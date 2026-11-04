import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRewindHost} from '../electron/rewindHost.js';
import {rewindValid,rewindAction,rewindSnapshot} from '../electron/rewindValues.js';
const examples=new URL('../../contracts/examples/v0.2/',import.meta.url);
const load=name=>JSON.parse(readFileSync(new URL(name,examples),'utf8'));
const base=()=>load('rewind_session.valid.json');

test('new validator accepts canonical positives and rejects canonical negatives, including nested arrays',()=>{
 let count=0;
 for(const file of readdirSync(examples)){
  const match=/^(rewind_(?:request|event|session|point))\.(valid|invalid)(?:\.|\.json)/.exec(file);
  if(!match)continue;
  assert.equal(rewindValid(match[1]+'.schema.json',load(file)),match[2]==='valid',file);count++;
 }
 assert.ok(count>100);
 const s=base();s.points.push(structuredClone(s.points[0]),structuredClone(s.points[0]));assert.equal(rewindValid('rewind_session.schema.json',s),false);
 const point=base().points[0];point.memory_bytes=true;assert.equal(rewindValid('rewind_point.schema.json',point),false);
});
test('renderer cannot select native paths, IDs, authority or malformed labels',()=>{
 const valid={op:'mark',workload_id:'workload-one',generation:1,authority_epoch:1,label:'Before change'};
 assert.equal(rewindAction(valid),true);
 for(const value of [{...valid,path:'/host'},{...valid,request_id:'request-foreign'},{...valid,generation:true},{...valid,label:'a/b'},{...valid,label:'x\n'},{...valid,label:'\ud800'}])assert.equal(rewindAction(value),false);
});
function fixture(timeoutMs=1000){
 const sent=[],commits=[];let gc={available:true,busy:false,uncertain:false,session:{workload_id:'workload-one',generation:1,owner_id:'actor-one',phase:'ready',ownership:'held',controls:{cancel:null,stop:null}}};
 const host=createRewindHost({send:body=>sent.push(body),available:()=>true,ownerId:'actor-one',guest:()=>gc,commitReady:s=>commits.push(structuredClone(s)),timeoutMs});let n=0;
 const event=(kind,session,data)=>host.receive({schema:'rewind_event/v0.2',event_id:'event-'+(++n),request_id:sent.at(-1).request_id,owner_id:'actor-one',event:kind,session,data});
 return {host,sent,commits,event,gc};
}
const target={workload_id:'workload-one',generation:1,authority_epoch:1};
function firstMark(f){
 const promise=f.host.request({op:'mark',...target,label:'Before'}),request=f.sent.at(-1);
 const accepted={...base(),generation:2,authority_epoch:2,phase:'marking',pending_request_id:request.request_id,points:[],last_good_usable:null};
 f.event('accepted',accepted,{op:'mark'});
 return {promise,request,accepted};
}
test('only correlated completion unblocks commands and commits the new Ready generation',async()=>{
 const f=fixture(),{promise}=firstMark(f);
 assert.equal(f.host.commandAllowed(),false);assert.equal(f.commits.length,0);
 const completed={...base(),phase:'ready',pending_request_id:null};
 f.event('completed',completed,{op:'mark',point_id:completed.points[0].point_id});
 const value=await promise;
 assert.equal(f.commits.length,1);assert.equal(f.commits[0].generation,2);assert.equal(f.host.commandAllowed(),true);assert.ok(rewindSnapshot(value));
});
test('foreign or stale execution witnesses cannot change the local target',async()=>{
 const f=fixture(),{promise,request}=firstMark(f),prior=f.host.status();
 const s={...base(),generation:1,authority_epoch:1,phase:'ready',pending_request_id:null};
 assert.throws(()=>f.host.receive({schema:'rewind_event/v0.2',event_id:'event-stale',request_id:request.request_id,owner_id:'actor-one',event:'completed',session:s,data:{op:'mark',point_id:s.points[0].point_id}}));
 assert.deepEqual(f.host.status(),prior);assert.equal(f.commits.length,0);
 f.host.disconnect();await promise;
});
test('ambiguous completion stays fenced without resending and cannot invent point ages',async()=>{
 const f=fixture(5),{promise}=firstMark(f);const value=await promise;
 assert.equal(value.uncertain,true);assert.equal(f.host.commandAllowed(),false);assert.equal(f.sent.length,1);assert.equal(f.commits.length,0);
 const forged={...value,point_ages_ms:{'point-foreign':0}};assert.equal(rewindSnapshot(forged),false);
});
test('cleanup target survives loss of the very first rewind witness without claiming Ready',async()=>{
 const f=fixture(5),promise=f.host.request({op:'mark',...target,label:'Before'});
 assert.equal(f.host.status().session,null);assert.deepEqual(f.host.status().stop_target,{workload_id:'workload-one',generation:2});
 await promise;assert.equal(f.host.commandAllowed(),false);assert.equal(f.commits.length,0);
 f.gc.session={...f.gc.session,generation:2,phase:'stopped',ownership:'released'};f.host.guestClosed();
 assert.equal(f.host.status().stop_target,null);assert.equal(f.host.status().session,null);assert.equal(f.host.status().uncertain,false);
});
test('Stop dominates a late accepted/completed rewind and authenticated closure releases the projection',async()=>{
 const f=fixture();const promise=f.host.request({op:'pause',...target});
 f.gc.session.controls.stop={request_id:'request-stop',ack:'pending'};
 const s={...base(),generation:1,authority_epoch:1,phase:'stopping',pending_request_id:f.sent[0].request_id,points:[],last_good_usable:null};
 f.event('accepted',s,{op:'pause'});f.event('completed',{...s,pending_request_id:null},{op:'pause',point_id:null});await promise;
 assert.equal(f.commits.length,0);assert.equal(f.host.commandAllowed(),false);
 f.gc.session={...f.gc.session,phase:'stopped',ownership:'released'};f.host.guestClosed();
 assert.equal(f.host.status().session.ownership,'released');assert.deepEqual(f.host.status().point_ages_ms,{});
});
async function marked(f){const {promise}=firstMark(f);const s={...base(),phase:'ready',pending_request_id:null};f.event('completed',s,{op:'mark',point_id:s.points[0].point_id});await promise;return s;}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('one Ready Restore selection explicitly pauses, then sends a distinct Restore only after confirmed Pause',async()=>{
 const f=fixture(),s=await marked(f),point=s.points[0].point_id;
 const p=f.host.request({op:'restore',workload_id:s.workload_id,generation:2,authority_epoch:2,point_id:point});
 const pause=f.sent.at(-1);assert.equal(pause.op,'pause');
 f.event('accepted',{...s,phase:'pausing',pending_request_id:pause.request_id},{op:'pause'});
 f.event('completed',{...s,phase:'paused',pending_request_id:null},{op:'pause',point_id:null});await flush();
 const restore=f.sent.at(-1);assert.equal(restore.op,'restore');assert.notEqual(restore.request_id,pause.request_id);
 f.event('accepted',{...s,generation:3,authority_epoch:3,phase:'restoring',pending_request_id:restore.request_id},{op:'restore'});
 f.event('completed',{...s,generation:3,authority_epoch:3,phase:'ready',pending_request_id:null},{op:'restore',point_id:point});await p;
 assert.equal(f.commits.at(-1).generation,3);
});
test('uncertain Pause never triggers a Restore retry or reopens commands',async()=>{
 const f=fixture(),s=await marked(f),before=f.sent.length;
 const p=f.host.request({op:'restore',workload_id:s.workload_id,generation:2,authority_epoch:2,point_id:s.points[0].point_id});
 assert.equal(f.sent.at(-1).op,'pause');f.event('outcome_unknown',null,{op:'pause',code:'NATIVE'});await p;
 assert.equal(f.sent.length,before+1);assert.equal(f.host.commandAllowed(),false);assert.equal(f.host.status().uncertain,true);
});
test('Stop between compound phases suppresses Restore',async()=>{
 const f=fixture(),s=await marked(f),before=f.sent.length;
 const p=f.host.request({op:'restore',workload_id:s.workload_id,generation:2,authority_epoch:2,point_id:s.points[0].point_id});const pause=f.sent.at(-1);
 f.gc.session.controls.stop={request_id:'request-stop',ack:'pending'};
 f.event('accepted',{...s,phase:'stopping',pending_request_id:pause.request_id},{op:'pause'});
 f.event('completed',{...s,phase:'stopping',pending_request_id:null},{op:'pause',point_id:null});await p;
 assert.equal(f.sent.length,before+1);assert.equal(f.host.commandAllowed(),false);
});
test('first admitted null-unknown keeps the advancing cleanup target without fabricating a session',async()=>{
 const f=fixture(),p=f.host.request({op:'mark',...target,label:'Before'});
 f.event('outcome_unknown',null,{op:'mark',code:'NATIVE'});await p;
 assert.equal(f.host.status().session,null);assert.equal(f.host.status().uncertain,true);assert.equal(f.host.commandAllowed(),false);
 assert.deepEqual(f.host.status().stop_target,{workload_id:'workload-one',generation:2});
});
test('a recovery witness is consumed once and cannot replace a newly accepted Restore',async()=>{
 const f=fixture(),s=await marked(f),point=s.points[0].point_id;
 const pause=f.host.request({op:'pause',workload_id:s.workload_id,generation:2,authority_epoch:2});const pauseId=f.sent.at(-1).request_id;
 f.event('accepted',{...s,phase:'pausing',pending_request_id:pauseId},{op:'pause'});f.event('completed',{...s,phase:'paused'},{op:'pause',point_id:null});await pause;
 const failed=f.host.request({op:'restore',workload_id:s.workload_id,generation:2,authority_epoch:2,point_id:point});const failedId=f.sent.at(-1).request_id;
 f.event('accepted',{...s,generation:3,authority_epoch:3,phase:'restoring',pending_request_id:failedId},{op:'restore'});
 f.event('outcome_unknown',{...s,generation:3,authority_epoch:3,phase:'uncertain',pending_request_id:failedId},{op:'restore',code:'NATIVE'});await failed;
 const recovery={schema:'rewind_event/v0.2',event_id:'event-recovery',request_id:failedId,owner_id:'actor-one',event:'recovery_ready',session:{...s,generation:3,authority_epoch:3,phase:'recoverable',last_good_usable:point,points:s.points.map(p=>({...p,active_references:0}))},data:{op:'restore',failed_request_id:failedId,point_id:point,no_active_vmm:true}};
 f.host.receive(recovery);assert.equal(f.host.status().session.phase,'recoverable');
 assert.throws(()=>f.host.receive({...recovery,event_id:'event-replay-before'}));
 const next=f.host.request({op:'restore',workload_id:s.workload_id,generation:3,authority_epoch:3,point_id:point});const nextId=f.sent.at(-1).request_id;
 f.event('accepted',{...s,generation:4,authority_epoch:4,phase:'restoring',pending_request_id:nextId},{op:'restore'});
 const prior=f.host.status();assert.throws(()=>f.host.receive({...recovery,event_id:'event-replay-after'}));assert.deepEqual(f.host.status(),prior);
 f.event('completed',{...s,generation:4,authority_epoch:4,phase:'ready'},{op:'restore',point_id:point});await next;assert.equal(f.commits.at(-1).generation,4);
});
