import {randomUUID} from 'node:crypto';
import {graphicalNoticePlain,graphicalNoticeValid} from './graphicalSessionNoticeValues.js';
import {graphicalAction,graphicalValid,graphicalSnapshot,graphicalPlain} from './graphicalSessionValues.js';

/** @typedef {{body:any, resolve:(value:any)=>void, accepted:boolean, before:any, timer:ReturnType<typeof setTimeout>|null, acceptTuple?:{generation:number,authority_epoch:number}}} GraphicalPending */
/** @typedef {{body:any,closed:boolean,unknown:boolean}} GraphicalHistory */
/** Core-event projection only. This module never invokes a native executor.
 * @param {{send:(body:any)=>void,available:()=>boolean,ownerId:string,timeoutMs?:number}} options */
export function createGraphicalSessionHost({send,available,ownerId,timeoutMs=30000}) {
 if(typeof send!=='function'||typeof available!=='function'||typeof ownerId!=='string'||!/^actor-[a-z0-9][a-z0-9._-]{0,63}$/.test(ownerId)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('GRAPHICAL_CONFIG');
 let session=/** @type {any} */(null),code=/** @type {string|null} */(null),revision=0,uncertain=false,disposed=false,capacityHeld=false;
 const pending=/** @type {Map<string,GraphicalPending>} */(new Map()),history=/** @type {Map<string,GraphicalHistory>} */(new Map()),seen=/** @type {Set<string>} */(new Set()),tombstones=/** @type {Set<string>} */(new Set()),listeners=/** @type {Set<(value:any)=>void>} */(new Set());
 /** @param {any} v @returns {any} */
 const clone=v=>structuredClone(v);
 const exhausted=()=>capacityHeld||history.size>=128||seen.size>=256||tombstones.size>=256;
 const status=()=>{const now=process.hrtime.bigint(), ages=/** @type {Record<string,number|null>} */({});for(const p of session?.points??[]){let age=/** @type {number|null} */(null);try{const then=BigInt(p.created_mono_ns),d=now-then;if(d>=0n&&d<=BigInt(Number.MAX_SAFE_INTEGER)*1000000n)age=Number(d/1000000n);}catch{}ages[p.point_id]=age;}return clone({available:!disposed&&available(),busy:pending.size>0,code,revision,session,uncertain,point_ages_ms:ages});};
 function publish(){if(code==='CAPACITY')capacityHeld=true;if(exhausted())code='CAPACITY';revision++;const v=status();if(!graphicalSnapshot(v))throw Error('GRAPHICAL_STATE');for(const cb of listeners){try{cb(clone(v));}catch{listeners.delete(cb);}}return v;}
 const commandAllowed=()=>!disposed&&available()&&!exhausted()&&!uncertain&&!pending.size&&(!session||session.phase==='ready'&&session.ownership==='held');
 /** @param {string} id @param {GraphicalHistory} entry */
 function remember(id,entry){if(history.has(id)){history.set(id,entry);return;}if(history.size>=128)throw Error('GRAPHICAL_HISTORY_CAPACITY');history.set(id,entry);}
 /** @param {GraphicalPending} p @param {string} [reason] */
 function unknown(p,reason='OUTCOME_UNKNOWN') {if(!pending.has(p.body.request_id))return;clearTimeout(/** @type {ReturnType<typeof setTimeout>} */(p.timer));pending.delete(p.body.request_id);uncertain=true;code=reason;if(session&&session.surface_id===p.body.surface_id)session={...session,phase:'outcome_unknown'};remember(p.body.request_id,{body:p.body,closed:false,unknown:true});const v=publish();p.resolve(v);}
 /** @param {any} action @returns {Promise<any>} */
 function request(action){
  if(!graphicalAction(action))throw Error('GRAPHICAL_REQUEST');
  if(disposed||!available()){code='UNAVAILABLE';return Promise.resolve(publish());}
  if(exhausted()){code='CAPACITY';return Promise.resolve(publish());}
  if(!commandAllowed()){code='BUSY';return Promise.resolve(publish());}
  if(action.op==='attach'){
   if(session||tombstones.has(action.surface_id)){code='BUSY';return Promise.resolve(publish());}
   if(tombstones.size>=256){code='CAPACITY';return Promise.resolve(publish());}
  } else {
   if(!session||session.surface_id!==action.surface_id||session.owner_id!==ownerId||session.ownership!=='held'||session.phase!=='ready'||uncertain||session.generation!==action.generation||session.authority_epoch!==action.authority_epoch){code='STALE';return Promise.resolve(publish());}
   if(action.op==='restore'&&!session.points.some((/** @type {any} */ p)=>p.point_id===action.point_id)){code='POINT_UNAVAILABLE';return Promise.resolve(publish());}
   if(action.op==='mark'&&session.points.length>=4){code='POINT_CAPACITY';return Promise.resolve(publish());}
  }
  const {op,surface_id,...params}=action,body={schema:'graphical_session_request/v0.2',request_id:'request-'+randomUUID(),surface_id,op,params:op==='attach'?{}:op==='mark'?{label:params.label}:{point_id:params.point_id},...(op==='attach'?{}:{generation:params.generation,authority_epoch:params.authority_epoch}),owner_id:ownerId};
  if(!graphicalValid('graphical_session_request.schema.json',body))throw Error('GRAPHICAL_REQUEST_INTERNAL');
  code=null;
  return new Promise(resolve=>{const p=/** @type {GraphicalPending} */({body,resolve,accepted:false,before:session?clone(session):null,timer:null});pending.set(body.request_id,p);p.timer=setTimeout(()=>unknown(p),timeoutMs);publish();try{send(clone(body));}catch{unknown(p);}});
 }
 /** @param {any} e @param {{body:any}} p @returns {boolean} */
 function correlate(e,p){const b=p.body;if(e.request_id!==b.request_id||e.owner_id!==ownerId||e.surface_id!==b.surface_id||e.op!==b.op)return false;if(b.op==='attach')return true;const advance=b.op==='restore'&&e.event==='completed'?1:0;return e.generation===b.generation+advance&&e.authority_epoch===b.authority_epoch+advance;}
 /** @param {any} event @returns {boolean} */
 function receive(event){
  if(!graphicalPlain(event)||!graphicalValid('graphical_session_event.schema.json',event))throw Error('GRAPHICAL_PROTOCOL');
  const p=pending.get(event.request_id),prior=history.get(event.request_id);
  // A local timeout does not revoke the Core's right to finish. Late events
  // are evidence only: they never reopen a timed-out or physically closed owner.
  if(!p){
   const s=event.session;
   if(event.event==='outcome_unknown'&&session&&s&&event.owner_id===ownerId&&event.surface_id===session.surface_id&&s.runtime_id===session.runtime_id&&s.generation===session.generation&&s.authority_epoch===session.authority_epoch){quarantine();return false;}
   if(prior&&!correlate(event,prior))throw Error('GRAPHICAL_CORRELATION');return false;
  }
  const fail=()=>{unknown(p);return false;};
  if(!correlate(event,p))return fail();
  if(seen.has(event.event_id))return false;
  if(seen.size>=256)return fail();
  const s=event.session,b=p.body;
  if(s&&(s.surface_id!==b.surface_id||s.owner_id!==ownerId||s.backend!=='qemu'||s.isa!=='aarch64'))return fail();
  if(event.event==='accepted'){
   if(p.accepted)return fail();
   if(b.op==='attach'&&s!==null)return fail();
   if(b.op!=='attach'&&(!s||s.phase!=='pending'||s.pending_request_id!==b.request_id||s.ownership!=='held'))return fail();
   if(b.op!=='attach'&&(s.runtime_id!==p.before?.runtime_id||s.generation!==b.generation||s.authority_epoch!==b.authority_epoch||b.op==='restore'&&!s.points.some((/** @type {any} */ x)=>x.point_id===b.params.point_id)))return fail();
   p.accepted=true;p.acceptTuple={generation:event.generation,authority_epoch:event.authority_epoch};if(s)session=clone(s);seen.add(event.event_id);publish();return true;
  }
  if(event.event==='outcome_unknown'){
   if(!p.accepted&&b.op!=='attach')return fail();
   if(s&& (s.phase!=='outcome_unknown'||s.ownership!=='held'||s.pending_request_id!==b.request_id))return fail();
   if(s)session=clone(s);seen.add(event.event_id);unknown(p);return true;
  }
  if(event.event==='refused'){
   const unchanged=b.op==='attach'?s===null:s!==null&&same(s,p.before);
   if(!unchanged){session=session?{...session,phase:'outcome_unknown'}:null;seen.add(event.event_id);unknown(p);return true;}
   session=p.before?clone(p.before):null;code=event.reason_code;seen.add(event.event_id);clearTimeout(/** @type {ReturnType<typeof setTimeout>} */(p.timer));pending.delete(b.request_id);remember(b.request_id,{body:b,closed:false,unknown:false});p.resolve(publish());return true;
  }
  if(event.event!=='completed'||!p.accepted||!s||s.phase!=='ready'||s.ownership!=='held'||s.pending_request_id!==null)return fail();
  if(b.op==='attach'){
   if(session!==null||event.generation!==p.acceptTuple?.generation||event.authority_epoch!==p.acceptTuple?.authority_epoch||s.generation!==event.generation||s.authority_epoch!==event.authority_epoch||!/^runtime-[0-9a-f]{64}$/.test(s.runtime_id)||s.phase!=='ready'||s.points.length!==0)return fail();
  }else if(b.op==='mark'){
   const newPoints=s.points.filter((/** @type {any} */ x)=>!p.before.points.some((/** @type {any} */ y)=>y.point_id===x.point_id));
   if(s.runtime_id!==p.before.runtime_id||s.generation!==b.generation||s.authority_epoch!==b.authority_epoch||s.points.length!==p.before.points.length+1||newPoints.length!==1||newPoints[0].point_id!==event.point_id||newPoints[0].label!==b.params.label||newPoints[0].generation!==b.generation||new Set(s.points.map((/** @type {any} */ x)=>x.point_id)).size!==s.points.length||!p.before.points.every((/** @type {any} */ x)=>s.points.some((/** @type {any} */ y)=>y.point_id===x.point_id&&same(x,y))))return fail();
  }else{
   if(s.runtime_id!==p.before.runtime_id||s.generation!==b.generation+1||s.authority_epoch!==b.authority_epoch+1||s.points.length!==p.before.points.length||!p.before.points.every((/** @type {any} */ x)=>s.points.some((/** @type {any} */ y)=>x.point_id===y.point_id&&same(x,y)))||event.point_id!==b.params.point_id||!s.points.some((/** @type {any} */ x)=>x.point_id===event.point_id)||event.frame_generation===null||event.frame_sha256===null)return fail();
  }
  session=clone(s);uncertain=false;code=null;seen.add(event.event_id);clearTimeout(/** @type {ReturnType<typeof setTimeout>} */(p.timer));pending.delete(b.request_id);remember(b.request_id,{body:b,closed:false,unknown:false});p.resolve(publish());return true;
 }
 /** Unsolicited authenticated Core invalidation; never establishes a session.
  * @param {any} value @returns {boolean} */
 function notice(value){
  if(!graphicalNoticePlain(value)||!graphicalNoticeValid(value))throw Error('GRAPHICAL_NOTICE_PROTOCOL');
  if(disposed)return false;
  const s=value.session;
  if(!session||session.ownership!=='held'||session.phase==='stopped'||s.owner_id!==ownerId||s.surface_id!==session.surface_id||s.runtime_id!==session.runtime_id||s.generation!==session.generation||s.authority_epoch!==session.authority_epoch||s.backend!==session.backend||s.isa!==session.isa||!same(s.points,session.points))return false;
  if(seen.has(value.notice_id))return false;
  if(seen.size>=256){if(!uncertain)quarantine();return false;}
  seen.add(value.notice_id);quarantine();return true;
 }
 /** @param {any} v @returns {any} */
 function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
 /** @param {any} a @param {any} b @returns {boolean} */
 function same(a,b){return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));}
 /** @param {string} surfaceId @returns {boolean} */
 function surfaceClosed(surfaceId){
  if(typeof surfaceId!=='string')throw Error('GRAPHICAL_CLOSE');
  const inflight=[...pending.values()],known=[...history.values()];
  const active=session?.surface_id??inflight[0]?.body.surface_id??(uncertain?known.at(-1)?.body.surface_id:null);
  if(active!==null&&active!==undefined?active!==surfaceId:!known.some(entry=>entry.body.surface_id===surfaceId))return false;
  const done=inflight.filter(p=>p.body.surface_id===surfaceId);
  for(const p of done){clearTimeout(/** @type {ReturnType<typeof setTimeout>} */(p.timer));pending.delete(p.body.request_id);}
  // Only this trusted physical-destroy callback resets per-owner replay caps.
  // Fresh random request IDs keep all old late events detached from new owners.
  history.clear();seen.clear();tombstones.clear();
  session=null;uncertain=false;code=null;capacityHeld=false;const v=publish();for(const p of done)p.resolve(v);return true;
 }
 function quarantine(){
  if(disposed)return;
  for(const p of [...pending.values()])unknown(p);
  uncertain=true;code='OUTCOME_UNKNOWN';if(session)session={...session,phase:'outcome_unknown'};
  publish();
 }
 function disconnect(){if(disposed)return;disposed=true;for(const p of pending.values())unknown(p);code='UNAVAILABLE';publish();}
 return Object.freeze({status,request,receive,notice,commandAllowed,disconnect,quarantine,subscribe(/** @type {(value:any)=>void} */ cb){if(typeof cb!=='function'||listeners.size>=64)throw Error('GRAPHICAL_SUBSCRIBER');listeners.add(cb);cb(status());return()=>listeners.delete(cb);},surfaceClosed});
}
