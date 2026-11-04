import test from 'node:test';
import assert from 'node:assert/strict';
import {createGraphicalSessionController,emptyGraphicalSnapshot,graphicalAction,graphicalCapabilities} from '../src/wall/graphicalStateControls.js';
import {createGraphicalSessionHost} from '../electron/graphicalSessionHost.js';
const row={id:'surface-partials',kind:'vm',backendLifecycle:'active'},owner='actor-partials';
const point={point_id:'point-one',label:'One',generation:1,created_mono_ns:1,manifest_sha256:'b'.repeat(64)};
const session=(points=[])=>({schema:'graphical_session/v0.2',surface_id:row.id,runtime_id:'runtime-'+'a'.repeat(64),owner_id:owner,generation:1,authority_epoch:1,authority:'core',phase:'ready',ownership:'held',pending_request_id:null,backend:'qemu',isa:'aarch64',points});
function fixture(){const sent=[],host=createGraphicalSessionHost({send:p=>sent.push(p),available:()=>true,ownerId:owner});let n=0;const event=(p,event,s,extra={})=>host.receive({schema:'graphical_session_event/v0.2',event_id:'event-partial-'+(++n),request_id:p.request_id,surface_id:row.id,owner_id:owner,generation:1,authority_epoch:1,op:p.op,event,reason_code:null,point_id:null,session:s,elapsed_ms:event==='completed'?1:null,frame_sha256:null,frame_generation:null,...extra});return {host,sent,event};}
async function attach(f){const promise=f.host.request({op:'attach',surface_id:row.id}),p=f.sent.at(-1);f.event(p,'accepted',null);f.event(p,'completed',session());await promise;}
test('watcher attach is passive; enabling requires an explicit current-revision action and never retries',async()=>{
 const calls=[],changes=[];let notify;const initial={...emptyGraphicalSnapshot(),available:true,revision:1};
 const c=createGraphicalSessionController({subscribe:cb=>{notify=cb;cb(initial);return()=>{};},request:async a=>{calls.push(a);throw Error('ambiguous');}},s=>changes.push(s));
 await c.attach([row]);assert.equal(calls.length,0);
 const action=graphicalAction(initial,row,'attach');assert.deepEqual(action,{op:'attach',surface_id:row.id});
 assert.equal(await c.request(action,0,[row]),false);assert.equal(calls.length,0);
 assert.equal(await c.request(action,1,[{...row,backendLifecycle:'lost'}]),false);
 assert.equal(await c.request(action,1,[row]),false);assert.deepEqual(calls,[action]);
 notify({...initial,revision:2});await c.attach([row]);assert.equal(await c.request(action,2,[row]),false);assert.equal(calls.length,1);assert.equal(changes.some(x=>x.uncertain),true);c.dispose();
});
test('flag-off unavailable diagnostics stay hidden while held sessions retain visible custody',()=>{
 const disabled={...emptyGraphicalSnapshot(),code:'UNAVAILABLE'};assert.equal(graphicalCapabilities(disabled,row).visible,false);
 const held={...disabled,session:session([point]),uncertain:true};assert.equal(graphicalCapabilities(held,row).visible,true);assert.equal(graphicalCapabilities(held,row).enabled,false);
});
test('global bounded history capacity disables mutations until physical closure without evicting custody',async()=>{
 const f=fixture();await attach(f);
 const mark=f.host.request({op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:'One'}),m=f.sent.at(-1);f.event(m,'accepted',{...session(),phase:'pending',pending_request_id:m.request_id});f.event(m,'completed',session([point]),{point_id:point.point_id});await mark;
 for(let i=0;i<126;i++){const p=f.host.request({op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:'One'}),q=f.sent.at(-1);f.event(q,'accepted',{...session([point]),phase:'pending',pending_request_id:q.request_id});f.event(q,'refused',session([point]),{reason_code:'NATIVE_FAILED'});await p;}
 const snapshot=f.host.status();assert.equal(snapshot.code,'CAPACITY');assert.equal(f.host.commandAllowed(),false);assert.equal(graphicalCapabilities(snapshot,row).enabled,false);assert.equal(graphicalAction(snapshot,row,'mark'),null);assert.equal(graphicalAction(snapshot,row,'restore',point.point_id),null);assert.equal(graphicalCapabilities(snapshot,row).back.available,true);
 const sent=f.sent.length;assert.equal((await f.host.request({op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:'One'})).code,'CAPACITY');assert.equal(f.sent.length,sent);
 assert.equal(f.host.surfaceClosed('foreign'),false);assert.equal(f.host.status().code,'CAPACITY');assert.equal(f.host.surfaceClosed(row.id),true);assert.equal(f.host.status().code,null);
});
test('point capacity refuses only Mark and retains a valid Back action',async()=>{
 const f=fixture();await attach(f);let points=[];
 for(let i=0;i<4;i++){const p=f.host.request({op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:'One'}),q=f.sent.at(-1);f.event(q,'accepted',{...session(points),phase:'pending',pending_request_id:q.request_id});const pnt={...point,point_id:'point-'+i};points=[...points,pnt];f.event(q,'completed',session(points),{point_id:pnt.point_id});await p;}
 const sent=f.sent.length;assert.equal((await f.host.request({op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:'One'})).code,'POINT_CAPACITY');assert.equal(f.sent.length,sent);
 const snapshot=f.host.status();assert.equal(f.host.commandAllowed(),true);assert.equal(graphicalAction(snapshot,row,'mark'),null);assert.deepEqual(graphicalAction(snapshot,row,'restore','point-0'),{op:'restore',surface_id:row.id,generation:1,authority_epoch:1,point_id:'point-0'});
});

test('host deadline remains capped at thirty seconds',()=>{assert.throws(()=>createGraphicalSessionHost({send(){},available:()=>true,ownerId:owner,timeoutMs:30001}),/GRAPHICAL_CONFIG/);});

test('a Core global capacity refusal latches without releasing the held runtime',async()=>{
 const f=fixture();await attach(f);const promise=f.host.request({op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:'One'}),p=f.sent.at(-1);f.event(p,'refused',session(),{reason_code:'CAPACITY'});const snapshot=await promise;
 assert.equal(snapshot.code,'CAPACITY');assert.equal(snapshot.session.runtime_id,session().runtime_id);assert.equal(f.host.commandAllowed(),false);const count=f.sent.length;assert.equal((await f.host.request({op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:'One'})).code,'CAPACITY');assert.equal(f.sent.length,count);assert.equal(f.host.surfaceClosed('foreign'),false);assert.equal(f.host.commandAllowed(),false);assert.equal(f.host.surfaceClosed(row.id),true);assert.equal(f.host.commandAllowed(),true);
});

test('clean refusal disables Enable without IPC retry; only physical close permits a new surface action',async()=>{
 for(const reason of ['UNAVAILABLE','POLICY']) {
  const f=fixture(),changes=[],c=createGraphicalSessionController(f.host,s=>changes.push(s));await c.refresh();
  const initial=changes.at(-1),action=graphicalAction(initial,row,'attach'),pending=c.request(action,initial.revision,[row]),p=f.sent.at(-1);
  f.event(p,'refused',null,{reason_code:reason});await pending;
  const refused=changes.at(-1);assert.equal(refused.code,reason);assert.equal(refused.session,null);assert.equal(refused.uncertain,false);
  assert.equal(graphicalCapabilities(refused,row).attach.enabled,false);assert.equal(graphicalAction(refused,row,'attach'),null);
  assert.equal(await c.request(action,refused.revision,[row]),false);await c.attach([row]);assert.equal(f.sent.length,1);
  const nextRow={...row,id:'surface-next'};assert.equal(f.host.surfaceClosed('foreign'),false);assert.equal(graphicalAction(changes.at(-1),nextRow,'attach'),null);
  assert.equal(f.host.surfaceClosed(row.id),true);const closed=changes.at(-1);assert.equal(closed.code,null);assert.equal(graphicalCapabilities(closed,nextRow).attach.enabled,true);
  const nextAction=graphicalAction(closed,nextRow,'attach');assert.equal(await c.request(nextAction,refused.revision,[nextRow]),false);assert.equal(f.sent.length,1);
  await c.attach([nextRow]);assert.equal(f.sent.length,1);const next=c.request(nextAction,closed.revision,[nextRow]),np=f.sent.at(-1);assert.equal(f.sent.length,2);assert.equal(np.surface_id,nextRow.id);
  f.host.receive({schema:'graphical_session_event/v0.2',event_id:'event-next-refused',request_id:np.request_id,surface_id:nextRow.id,owner_id:owner,generation:1,authority_epoch:1,op:'attach',event:'refused',reason_code:'UNAVAILABLE',point_id:null,session:null,elapsed_ms:null,frame_sha256:null,frame_generation:null});await next;c.dispose();
 }
});
