import test from 'node:test';
import assert from 'node:assert/strict';
import {createGraphicalSessionHost} from '../electron/graphicalSessionHost.js';
import {graphicalSnapshot} from '../electron/graphicalSessionValues.js';

const owner='actor-demo',surface='surface-demo',runtime='runtime-'+'a'.repeat(64),hash='b'.repeat(64);
const point={point_id:'point-one',generation:1,label:'Before',manifest_sha256:hash,created_mono_ns:1};
const ready=(g=1,e=1,points=[])=>({schema:'graphical_session/v0.2',surface_id:surface,runtime_id:runtime,owner_id:owner,generation:g,authority_epoch:e,authority:'core',phase:'ready',ownership:'held',pending_request_id:null,points,backend:'qemu',isa:'aarch64'});
function fixture(timeoutMs=500){const sent=[],h=createGraphicalSessionHost({send:b=>sent.push(b),available:()=>true,ownerId:owner,timeoutMs});let seq=0;const event=(p,op,kind,session,g=1,e=1,extra={})=>h.receive({schema:'graphical_session_event/v0.2',event_id:`event-${++seq}`,request_id:p.request_id,owner_id:owner,surface_id:surface,generation:g,authority_epoch:e,op,event:kind,reason_code:null,point_id:null,session,elapsed_ms:kind==='completed'?1:null,frame_sha256:null,frame_generation:null,...extra});return {h,sent,event};}
function accepted(f,p,op,s,g=1,e=1){f.event(p,op,'accepted',{...s,phase:'pending',ownership:'held',pending_request_id:p.request_id},g,e);}

test('attach binds a surface only after correlated core completion and never fabricates a runtime',async()=>{
 const f=fixture(),promise=f.h.request({op:'attach',surface_id:surface}),p=f.sent[0];assert.equal(f.h.status().session,null);assert.equal(f.h.status().busy,true);
 f.event(p,'attach','accepted',null,1,1);const s=ready(1,1);f.event(p,'attach','completed',s,1,1);const v=await promise;assert.equal(v.session.runtime_id,runtime);assert.equal(f.h.commandAllowed(),true);assert.equal(graphicalSnapshot(v),true);
});
test('mark preserves generation/epoch and a wrong-owner result leaves the action fenced as uncertain',async()=>{
 const f=fixture(),attach=f.h.request({op:'attach',surface_id:surface}),ap=f.sent[0];f.event(ap,'attach','accepted',null);f.event(ap,'attach','completed',ready());await attach;
 const first=f.h.request({op:'mark',surface_id:surface,generation:1,authority_epoch:1,label:'Before'}),fp=f.sent.at(-1);accepted(f,fp,'mark',ready());f.event(fp,'mark','completed',ready(1,1,[point]),1,1,{point_id:'point-one'});assert.equal((await first).session.generation,1);assert.equal(f.h.status().session.authority_epoch,1);
 const promise=f.h.request({op:'mark',surface_id:surface,generation:1,authority_epoch:1,label:'After'}),p=f.sent.at(-1);accepted(f,p,'mark',ready(1,1,[point]));
 assert.equal(f.h.receive({schema:'graphical_session_event/v0.2',event_id:'event-forged',request_id:p.request_id,owner_id:'actor-other',surface_id:surface,generation:1,authority_epoch:1,op:'mark',event:'completed',reason_code:null,point_id:'point-new',session:ready(1,1,[point,{...point,point_id:'point-new'}]),elapsed_ms:1,frame_sha256:null,frame_generation:null}),false);const value=await promise;assert.equal(value.uncertain,true);assert.equal(f.h.commandAllowed(),false);assert.equal(f.sent.length,3);
});
test('restore advances only on matching point and fresh frame witness',async()=>{
 const f=fixture(),a=f.h.request({op:'attach',surface_id:surface}),ap=f.sent[0];f.event(ap,'attach','accepted',null);f.event(ap,'attach','completed',ready());await a;
 const m=f.h.request({op:'mark',surface_id:surface,generation:1,authority_epoch:1,label:'Before'}),mp=f.sent.at(-1);accepted(f,mp,'mark',ready());f.event(mp,'mark','completed',ready(1,1,[point]),1,1,{point_id:point.point_id,elapsed_ms:2});await m;
 const p=f.h.request({op:'restore',surface_id:surface,generation:1,authority_epoch:1,point_id:point.point_id}),rp=f.sent.at(-1);f.event(rp,'restore','accepted',{...ready(1,1,[point]),phase:'pending',pending_request_id:rp.request_id},1,1,{point_id:point.point_id});
 const restored=ready(2,2,[point]);f.event(rp,'restore','completed',restored,2,2,{point_id:point.point_id,elapsed_ms:5,frame_sha256:hash,frame_generation:2});assert.equal((await p).session.generation,2);
});
test('timeouts and disconnect remain uncertain, fence mutation, and never resend',async()=>{
 const f=fixture(5),a=f.h.request({op:'attach',surface_id:surface});const v=await a;assert.equal(v.uncertain,true);assert.equal(v.session,null);assert.equal(f.sent.length,1);assert.equal(f.h.commandAllowed(),false);
 assert.equal(f.h.request({op:'attach',surface_id:surface}) instanceof Promise,true);assert.equal(f.sent.length,1);f.h.disconnect();assert.equal(f.h.status().available,false);
});
test('trusted physical close releases pending custody and tombstones late events',async()=>{
 const f=fixture(1000),a=f.h.request({op:'attach',surface_id:surface}),p=f.sent[0];f.event(p,'attach','accepted',null);const pending=f.h.status();assert.equal(pending.busy,true);
 assert.equal(f.h.surfaceClosed(surface),true);const v=await a;assert.equal(v.session,null);assert.equal(v.busy,false);assert.equal(f.h.status().uncertain,false);
 assert.equal(f.h.receive({schema:'graphical_session_event/v0.2',event_id:'event-late',request_id:p.request_id,owner_id:owner,surface_id:surface,generation:1,authority_epoch:1,op:'attach',event:'completed',reason_code:null,point_id:null,session:ready(),elapsed_ms:1,frame_sha256:null,frame_generation:null}),false);
 const refused=f.h.request({op:'attach',surface_id:surface});assert.equal(f.sent.length,1);assert.equal(f.h.status().code,'BUSY');void refused;
});
test('completion must append one unique point matching the requested label and generation',async()=>{
 for(const added of [{...point,label:'Wrong label'},{...point,generation:2},{...point,point_id:'point-one'}]){
  const f=fixture(),a=f.h.request({op:'attach',surface_id:surface}),ap=f.sent[0];f.event(ap,'attach','accepted',null);f.event(ap,'attach','completed',ready());await a;
  const p=f.h.request({op:'mark',surface_id:surface,generation:1,authority_epoch:1,label:'Before'}),rp=f.sent.at(-1);accepted(f,rp,'mark',ready());
  const result=ready(1,1,[point,added]);assert.equal(f.h.receive({schema:'graphical_session_event/v0.2',event_id:'event-bad-mark',request_id:rp.request_id,owner_id:owner,surface_id:surface,generation:1,authority_epoch:1,op:'mark',event:'completed',reason_code:null,point_id:added.point_id,session:result,elapsed_ms:1,frame_sha256:null,frame_generation:null}),false);
  const status=await p;assert.equal(status.uncertain,true);assert.equal(f.h.commandAllowed(),false);
 }
});
test('data-only structural session matching ignores object key order and event accessors never execute',async()=>{
 const f=fixture(),a=f.h.request({op:'attach',surface_id:surface}),ap=f.sent[0];f.event(ap,'attach','accepted',null);f.event(ap,'attach','completed',ready());await a;
 const p=f.h.request({op:'mark',surface_id:surface,generation:1,authority_epoch:1,label:'Before'}),rp=f.sent.at(-1),prior=ready();
 const reordered=Object.fromEntries(Object.entries(prior).reverse());f.event(rp,'mark','refused',reordered,1,1,{reason_code:'NATIVE_FAILED'});assert.equal((await p).code,'NATIVE_FAILED');assert.equal(f.h.commandAllowed(),true);
 let reads=0;const hostile={};for(const [k,v] of Object.entries({schema:'graphical_session_event/v0.2',event_id:'event-accessor',request_id:'request-unknown'}))Object.defineProperty(hostile,k,{value:v,enumerable:true});Object.defineProperty(hostile,'owner_id',{enumerable:true,get(){reads++;return owner;}});assert.throws(()=>f.h.receive(hostile));assert.equal(reads,0);
});
