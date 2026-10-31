import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,utimesSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOperatorService,discoverHandoffPaths,HANDOFF_DISCOVERY} from '../electron/operatorBridge.js';
const record={schema:'metaviewer.handoff/v1',surface_id:'surface-1',step_index:7,reason:'captcha_wall',confidence:100,evidence_kinds:['ax_role_name']};
const hex=n=>n.toString(16).padStart(32,'0');
function home(t) {
  const root=mkdtempSync(join(tmpdir(),'mv-esh-handoff-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const runs=join(root,'metaviewer/runs');mkdirSync(runs,{recursive:true,mode:0o700});
  return {root,runs,env:{XDG_STATE_HOME:root}};
}
function run(runs,n,value=record,{mode=0o600,dirMode=0o700,name=HANDOFF_DISCOVERY.fileName}={}) {
  const dir=join(runs,hex(n));mkdirSync(dir,{mode:dirMode});chmodSync(dir,dirMode);
  if(value!==null)writeFileSync(join(dir,name),JSON.stringify(value),{mode});
  return dir;
}
test('ESH-HAND-1: a handoff written under a fresh run dir after start appears with no MV_HANDOFF_PATHS',async t=>{
  const {env,runs}=home(t),sent=[];
  const service=createOperatorService({env,notify:v=>sent.push(v)});
  assert.deepEqual(await service.request('handoff.list',[]),{ok:true,rows:[]});
  run(runs,1);
  assert.deepEqual(service.refresh().rows,[record]);
  assert.equal(sent.length,1);
  assert.deepEqual(await service.request('handoff.list',[]),{ok:true,rows:[record]});
  run(runs,2,{...record,surface_id:'surface-2'});
  assert.equal(service.refresh().rows.length,2);
});
test('ESH-HAND-2: ack persists next to the discovered record and never reopens',async t=>{
  const {env,runs}=home(t);
  const dir=run(runs,1);
  const service=createOperatorService({env});
  assert.equal(service.refresh().rows.length,1);
  assert.deepEqual(await service.request('handoff.ack',[{surface_id:'surface-1',step_index:7,gesture:'operator-acknowledge'}]),{ok:true});
  assert.ok(existsSync(join(dir,HANDOFF_DISCOVERY.fileName+'.ack.json')));
  const fresh=createOperatorService({env});
  assert.equal(fresh.refresh().rows.length,0);
});
test('ESH-HAND-3 negative control: an explicit MV_HANDOFF_PATHS (even empty) disables discovery',async t=>{
  const {env,runs}=home(t);run(runs,1);
  const service=createOperatorService({env:{...env,MV_HANDOFF_PATHS:'[]'}});
  assert.equal(service.refresh().rows.length,0);
  assert.deepEqual(discoverHandoffPaths({},Date.now()),[]);
  assert.deepEqual(discoverHandoffPaths({XDG_STATE_HOME:'relative/path'},Date.now()),[]);
});
test('ESH-HAND-4 negative controls: unsafe, foreign, stale and symlinked entries never surface',async t=>{
  const {env,runs,root}=home(t);
  run(runs,1,record,{mode:0o644});                       // not private file
  run(runs,2,record,{dirMode:0o755});                    // not private dir
  run(runs,3,{...record,extra:true});                    // invalid record shape
  run(runs,4,record,{name:'other.handoff.json'});        // foreign file name
  const stale=run(runs,5);const old=new Date(Date.now()-HANDOFF_DISCOVERY.maxAgeMs-60000);utimesSync(stale,old,old);
  const target=run(root,6);symlinkSync(target,join(runs,hex(7)));  // symlinked run dir
  mkdirSync(join(runs,'not-a-run-id'),{mode:0o700});chmodSync(join(runs,'not-a-run-id'),0o700);writeFileSync(join(runs,'not-a-run-id',HANDOFF_DISCOVERY.fileName),JSON.stringify(record),{mode:0o600});
  const service=createOperatorService({env});
  assert.deepEqual(service.refresh().rows,[]);
  run(runs,8);
  assert.equal(service.refresh().rows.length,1);          // the control: one valid run still surfaces
});
test('ESH-HAND-5: discovery is bounded to the newest runs and latch cap evicts only acknowledged rows',async t=>{
  const {env,runs}=home(t);
  for(let i=1;i<=HANDOFF_DISCOVERY.maxRuns+8;i++){const d=run(runs,i,{...record,step_index:i});const at=new Date(Date.now()-(1000-i)*1000);utimesSync(d,at,at);}
  const found=discoverHandoffPaths(env,Date.now());
  assert.equal(found.length,HANDOFF_DISCOVERY.maxRuns);
  assert.ok(found[0].includes(hex(HANDOFF_DISCOVERY.maxRuns+8)));
  assert.ok(!found.some(p=>p.includes(hex(1))));
  const service=createOperatorService({env});
  assert.equal(service.refresh().rows.length,HANDOFF_DISCOVERY.maxRuns);
  assert.ok(service.refresh().rows.length<=64);
});
test('ESH-HAND-6: a vanished run dir never clears a latched notice',async t=>{
  const {env,runs}=home(t);const dir=run(runs,1);
  const service=createOperatorService({env});assert.equal(service.refresh().rows.length,1);
  rmSync(dir,{recursive:true,force:true});
  assert.equal(service.refresh().rows.length,1);
});
test('ESH-HAND-7: at the latch cap no unacknowledged row is evicted; after one ack the new run latches and the acked row is the one evicted',async t=>{
  const {env,runs}=home(t);
  assert.equal(2*HANDOFF_DISCOVERY.maxRuns,HANDOFF_DISCOVERY.maxLatched);
  const base=Date.now(),at=(n,age)=>{const d=join(runs,hex(n));const when=new Date(base-age*1000);utimesSync(d,when,when);};
  const batch=(from,age)=>{for(let i=from;i<from+HANDOFF_DISCOVERY.maxRuns;i++){run(runs,i,{...record,step_index:i});at(i,age-i);}};
  const service=createOperatorService({env});
  batch(1,4000);
  assert.equal(service.refresh().rows.length,HANDOFF_DISCOVERY.maxRuns);
  batch(HANDOFF_DISCOVERY.maxRuns+1,2000);
  assert.equal(service.refresh().rows.length,HANDOFF_DISCOVERY.maxLatched);
  const extra=HANDOFF_DISCOVERY.maxLatched+1;
  run(runs,extra,{...record,step_index:extra});at(extra,0);
  const full=service.refresh().rows;
  assert.equal(full.length,HANDOFF_DISCOVERY.maxLatched);
  assert.ok(!full.some(r=>r.step_index===extra));        // nothing unacked was evicted to make room
  assert.ok(full.some(r=>r.step_index===1));
  const spent=HANDOFF_DISCOVERY.maxRuns+5;
  assert.deepEqual(await service.request('handoff.ack',[{surface_id:'surface-1',step_index:spent,gesture:'operator-acknowledge'}]),{ok:true});
  const after=service.refresh().rows;
  assert.equal(after.length,HANDOFF_DISCOVERY.maxLatched);
  assert.ok(after.some(r=>r.step_index===extra));        // the new run took the acked row's slot
  assert.ok(!after.some(r=>r.step_index===spent));
  assert.ok(after.some(r=>r.step_index===1));
});
