import test from 'node:test';
import assert from 'node:assert/strict';
import {createHeadlessHost} from '../electron/headlessHost.js';
import {validEvent} from '../electron/headlessValues.js';

const owner='actor-'+'a'.repeat(64);
const target={workload_id:'workload-one',generation:1};
const session=(phase,job=null)=>({schema:'headless_session/v0.2',...target,owner_id:owner,profile_id:'headless-sumsq-v1',backend:'firecracker',isa:'aarch64',phase,ownership:phase==='stopped'?'released':'held',job});
const acceptedJob={job_id:'job-agent',operation:'sumsq',n:10,status:'accepted',value:null};
const completedJob={...acceptedJob,status:'completed',value:385};
function fixture(t,timeoutMs=1000){
 const sent=[];let seq=0;
 const host=createHeadlessHost({send:value=>sent.push(value),available:()=>true,ownerId:owner,timeoutMs});
 t.after(()=>host.disconnect());
 const event=(request_id,kind,s,op)=>({schema:'headless_event/v0.2',request_id,event_id:'event-'+(++seq),event:kind,data:{session:s,...(op?{op}:{}),...(kind==='outcome_unknown'?{code:'OUTCOME_UNKNOWN'}:{})}});
 const deliver=(...args)=>{const e=event(...args);assert.equal(validEvent(e),true,'synthetic event must obey canonical contract');host.receive(e);return e;};
 return {host,sent,event,deliver};
}
async function humanCreated(t,timeout){const f=fixture(t,timeout);const p=f.host.request({op:'create'});const id=f.sent[0].request_id;f.deliver(id,'accepted',session('starting'),'create');f.deliver(id,'state_changed',session('ready'));await p;return f;}

test('human-created headless workload observes external agent run and stop without issuing requests',async t=>{
 const f=await humanCreated(t);assert.doesNotThrow(()=>f.deliver('request-agent-run','accepted',session('running',acceptedJob),'run'));
 assert.equal(f.host.status().busy,true);assert.equal(f.host.status().session.phase,'running');
 assert.equal((await f.host.request({op:'run',...target,n:10})).code,'BUSY');
 f.deliver('request-agent-run','completed',session('completed',completedJob));
 assert.equal(f.host.status().session.job.value,385);assert.equal(f.host.status().busy,false);
 f.deliver('request-agent-stop','accepted',session('stopping',completedJob),'stop');
 f.deliver('request-agent-stop','state_changed',session('stopped',completedJob));
 assert.equal(f.host.status().session.ownership,'released');assert.equal(f.host.status().uncertain,false);
 assert.deepEqual(f.sent.map(x=>x.op),['create']);
});
test('human-created ready workload observes external agent stop',async t=>{
 const f=await humanCreated(t);assert.doesNotThrow(()=>f.deliver('request-agent-stop','accepted',session('stopping'),'stop'));
 f.deliver('request-agent-stop','state_changed',session('stopped'));assert.equal(f.host.status().session.phase,'stopped');assert.equal(f.sent.length,1);
});
test('external run unknown is retained and permits an explicit distinct cleanup stop',async t=>{
 const f=await humanCreated(t);const job={...acceptedJob,status:'unknown'};
 assert.doesNotThrow(()=>f.deliver('request-agent-run','outcome_unknown',session('uncertain',job),'run'));
 assert.equal(f.host.status().uncertain,true);assert.equal(f.host.status().session.job.status,'unknown');
 f.deliver('request-agent-cleanup','accepted',session('stopping',job),'stop');
 f.deliver('request-agent-cleanup','state_changed',session('stopped',job));assert.equal(f.host.status().uncertain,false);assert.equal(f.host.status().session.ownership,'released');assert.equal(f.sent.length,1);
});
test('foreign tuples, invalid phase and unmatched completion never become observed work',async t=>{
 for(const change of [s=>s.owner_id='actor-'+'b'.repeat(64),s=>s.workload_id='workload-other',s=>s.generation=2,s=>s.phase='completed']){
  const f=await humanCreated(t);const s=session('running',acceptedJob);change(s);assert.throws(()=>f.host.receive(f.event('request-agent-run','accepted',s,'run')));assert.equal(f.host.status().session.phase,'ready');assert.equal(f.host.status().busy,false);
 }
 const f=await humanCreated(t);assert.throws(()=>f.deliver('request-agent-run','completed',session('completed',completedJob)));assert.equal(f.host.status().session.phase,'ready');
});
test('external event cannot replace an outstanding local create',async t=>{
 const f=fixture(t);const p=f.host.request({op:'create'});assert.throws(()=>f.deliver('request-agent-stop','accepted',session('stopping'),'stop'));const id=f.sent[0].request_id;f.deliver(id,'accepted',session('starting'),'create');f.deliver(id,'state_changed',session('ready'));await p;assert.equal(f.host.status().session.phase,'ready');
});

test('external lifecycle replays and a second run remain refused',async t=>{
 const f=await humanCreated(t);const first=f.deliver('request-agent-run','accepted',session('running',acceptedJob),'run');
 assert.throws(()=>f.host.receive(first),/HEADLESS_REPLAY/);
 f.deliver('request-agent-run','completed',session('completed',completedJob));
 assert.throws(()=>f.deliver('request-agent-run-two','accepted',session('running',{...acceptedJob,job_id:'job-two'}),'run'));
 assert.equal(f.host.status().busy,false);assert.equal(f.host.status().session.job.value,385);assert.equal(f.sent.length,1);
});
test('external completion must preserve the accepted job and operand',async t=>{
 const f=await humanCreated(t);f.deliver('request-agent-run','accepted',session('running',acceptedJob),'run');
 assert.throws(()=>f.deliver('request-agent-run','completed',session('completed',{...completedJob,n:11,value:506})),/HEADLESS_JOB/);
 assert.equal(f.host.status().session.phase,'running');assert.equal(f.host.status().busy,true);
});
test('external timeout stays unknown; foreign cleanup cannot be swallowed',async t=>{
 const f=await humanCreated(t,5);f.deliver('request-agent-run','accepted',session('running',acceptedJob),'run');
 await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.host.status().uncertain,true);assert.equal(f.host.status().busy,false);
 assert.throws(()=>f.deliver('request-foreign','accepted',{...session('stopping',{...acceptedJob,status:'unknown'}),owner_id:'actor-'+'b'.repeat(64)},'stop'),/HEADLESS_OWNER/);
 f.deliver('request-agent-run','completed',session('completed',completedJob));assert.equal(f.host.status().uncertain,true);assert.equal(f.host.status().session.phase,'running');
 const unknown={...acceptedJob,status:'unknown'};f.deliver('request-agent-cleanup','accepted',session('stopping',unknown),'stop');f.deliver('request-agent-cleanup','state_changed',session('stopped',unknown));assert.equal(f.host.status().session.ownership,'released');assert.equal(f.host.status().uncertain,false);assert.equal(f.sent.length,1);
});
