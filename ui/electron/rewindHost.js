import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {rewindAction,rewindValid,rewindSnapshot} from './rewindValues.js';

/** One projection of authenticated core events, never a native executor.
 * @param {{send:(body:any)=>void,available:()=>boolean,ownerId:string,guest:()=>any,commitReady:(session:any,priorGeneration:number)=>void,timeoutMs?:number}} options */
export function createRewindHost({send,available,ownerId,guest,commitReady,timeoutMs=30000}) {
 let session=/** @type {any} */(null),plannedStop=/** @type {any} */(null),code=/** @type {string|null} */(null),revision=0,uncertain=false,closed=false;
 let observedMark=/** @type {any} */(null);
 const pending=new Map(),history=new Map(),observedHistory=new Set(),seen=new Set(),listeners=new Set();
 const retireObserved=()=>{if(observedMark){clearTimeout(observedMark.timer);observedHistory.add(observedMark.requestId);observedMark=null;}};
 const copy=(/** @type {any} */v)=>structuredClone(v);
 const status=()=>{const now=process.hrtime.bigint();const ages=Object.fromEntries((session?.points??[]).map((/** @type {any} */point)=>{const stamp=point.created_mono_ns;const delta=Number.isSafeInteger(stamp)&&stamp>0?now-BigInt(stamp):null;return [point.point_id,delta!==null&&delta>=0n&&delta<=BigInt(Number.MAX_SAFE_INTEGER)*1000000n?Number(delta/1000000n):null];}));return copy({available:!closed&&available(),busy:pending.size>0||observedMark!==null,code,revision,session,uncertain,point_ages_ms:ages,stop_target:stopTarget()});};
 const publish=()=>{revision++;const value=status();if(!rewindSnapshot(value))throw Error('REWIND_STATE');for(const f of listeners){try{f(copy(value));}catch{listeners.delete(f);}}return value;};
 const lose=()=>{retireObserved();uncertain=true;code='OUTCOME_UNKNOWN';const old=[...pending.values()];pending.clear();for(const p of old){clearTimeout(p.timer);history.set(p.body.request_id,{body:p.body,advances:p.advances,unknown:true});}const value=publish();for(const p of old)p.resolve(value);return value;};
 const target=()=>session??guest()?.session;
 // Proposed tuple is cleanup-only. The core still validates it; it never opens Run.
 const stopTarget=()=>plannedStop??(session?.ownership==='held'?{workload_id:session.workload_id,generation:session.generation}:null);
 const commandAllowed=()=>!closed&&!uncertain&&!pending.size&&!observedMark&&(!session||session.phase==='ready');
 function guestClosed(){
  const gc=guest()?.session;
  const target=stopTarget();
  if(!target||gc?.phase!=='stopped'||gc.ownership!=='released'||gc.workload_id!==target.workload_id||gc.generation!==target.generation)return;
  retireObserved();const old=[...pending.values()];pending.clear();
  for(const p of old){clearTimeout(p.timer);history.set(p.body.request_id,{body:p.body,advances:p.advances,unknown:true});}
  if(session)session={...session,phase:'stopped',ownership:'released',pending_request_id:null,points:[],last_good_usable:null};plannedStop=null;uncertain=false;code=old.length?'STOPPED':null;
  const value=publish();for(const p of old)p.resolve(value);
 }
 /** @param {any} action @returns {Promise<any>} */
 async function request(action){
  if(!rewindAction(action))throw Error('BAD_REQUEST');
  if(closed||!available()){code='UNAVAILABLE';return Promise.resolve(publish());}
  const current=target(),gc=guest();
  if(!current||current.ownership!=='held'||action.workload_id!==current.workload_id||action.generation!==current.generation||action.authority_epoch!==(session?.authority_epoch??1)){code='STALE';return Promise.resolve(publish());}
  if(pending.size||observedMark||gc?.busy||gc?.uncertain||history.size+observedHistory.size>=256){code='BUSY';return Promise.resolve(publish());}
  const phase=session?.phase??gc?.session?.phase;
  const allowed=action.op==='pause'?phase==='ready':action.op==='resume'?phase==='paused':action.op==='mark'?['ready','paused'].includes(phase):['ready','paused','recoverable'].includes(phase);
  if(!allowed||uncertain&&phase!=='recoverable'){code='BUSY';return Promise.resolve(publish());}
  if(action.op==='restore'&&(!session?.points.some((/** @type {any} */p)=>p.point_id===action.point_id&&p.status==='usable')||phase==='recoverable'&&action.point_id!==session.last_good_usable)){code='POINT_UNAVAILABLE';return Promise.resolve(publish());}
  if(action.op==='restore'&&phase==='ready'){
   const paused=await request({op:'pause',workload_id:current.workload_id,generation:current.generation,authority_epoch:session.authority_epoch});
   if(paused.uncertain||paused.code!==null||paused.session?.phase!=='paused')return paused;
   return request({op:'restore',workload_id:paused.session.workload_id,generation:paused.session.generation,authority_epoch:paused.session.authority_epoch,point_id:action.point_id});
  }
  const {op,...params}=action,body={schema:'rewind_request/v0.2',request_id:'request-'+randomUUID(),op,params};
  const advances=op==='resume'||op==='restore'||op==='mark'&&phase==='ready';
  if(advances&&(!Number.isSafeInteger(params.generation+1)||!Number.isSafeInteger(params.authority_epoch+1))){code='CAPACITY';return Promise.resolve(publish());}
  plannedStop={workload_id:params.workload_id,generation:params.generation+(advances?1:0)};
  code=null;
  return new Promise(resolve=>{const p={body,resolve,accepted:false,origin:phase,advances,timer:/** @type {ReturnType<typeof setTimeout>|null} */(null)};pending.set(body.request_id,p);p.timer=setTimeout(()=>{if(pending.has(body.request_id))lose();},timeoutMs);publish();try{send(body);}catch{lose();}});
 }
 /** Observe an authenticated external mark without inventing a local request or promise.
  * @param {any} event */
 function receiveObservedMark(event){
  const s=event.session,gc=guest(),current=target();
  if(event.data.op!=='mark')throw Error('REWIND_CORRELATION');
  if(!observedMark){
   const origin=session?.phase??gc?.session?.phase,advances=origin==='ready';
   const priorGeneration=current?.generation,priorEpoch=session?.authority_epoch??1;
   const points=session?.points??[],lastGood=session?.last_good_usable??null;
   if(event.event!=='accepted'||closed||!available()||uncertain||pending.size||gc?.busy||gc?.uncertain||history.has(event.request_id)||observedHistory.has(event.request_id)||history.size+observedHistory.size>=256||!['ready','paused'].includes(origin)||!current||current.ownership!=='held'||gc?.session?.owner_id!==ownerId||gc.session.workload_id!==current.workload_id||gc.session.generation!==priorGeneration||!Number.isSafeInteger(priorGeneration)||!Number.isSafeInteger(priorEpoch)||!s||s.owner_id!==ownerId||s.workload_id!==current.workload_id||s.generation!==priorGeneration+(advances?1:0)||s.authority_epoch!==priorEpoch+(advances?1:0)||s.phase!=='marking'||s.ownership!=='held'||s.pending_request_id!==event.request_id||!isDeepStrictEqual(s.points,points)||s.last_good_usable!==lastGood||session&&s.compatibility_sha256!==session.compatibility_sha256)throw Error('REWIND_OBSERVATION');
   observedMark={requestId:event.request_id,origin,priorGeneration,priorEpoch,accepted:copy(s),points:copy(points),timer:null};
   observedMark.timer=setTimeout(()=>{if(observedMark?.requestId===event.request_id)lose();},timeoutMs);
   plannedStop={workload_id:s.workload_id,generation:s.generation};session=copy(s);code=null;seen.add(event.event_id);publish();return;
  }
  const observed=observedMark,a=observed.accepted;
  if(event.request_id!==observed.requestId||!s||s.owner_id!==ownerId||s.workload_id!==a.workload_id||s.generation!==a.generation||s.authority_epoch!==a.authority_epoch||s.compatibility_sha256!==a.compatibility_sha256||s.ownership!=='held')throw Error('REWIND_BINDING');
  if(event.event==='outcome_unknown'){
   if(s.phase!=='uncertain'||s.pending_request_id!==observed.requestId||!isDeepStrictEqual(s.points,a.points)||s.last_good_usable!==a.last_good_usable)throw Error('REWIND_ORDER');
   session=copy(s);seen.add(event.event_id);lose();return;
  }
  const stopping=s.phase==='stopping'&&gc?.session?.controls?.stop!==null&&gc?.session?.controls?.stop!==undefined;
  if(event.event!=='completed'||s.phase!==observed.origin&&!stopping||s.pending_request_id!==null)throw Error('REWIND_ORDER');
  const prior=copy(observed.points);
  if(prior.length===2){
   const victims=prior.filter((/** @type {any} */point)=>point.active_references===0).sort((/** @type {any} */x,/** @type {any} */y)=>x.created_order-y.created_order||(x.point_id<y.point_id?-1:x.point_id>y.point_id?1:0));
   if(!victims.length)throw Error('REWIND_POINTS');
   prior.splice(prior.findIndex((/** @type {any} */point)=>point.point_id===victims[0].point_id),1);
  }
  const added=s.points.at(-1);
  if(s.points.length!==prior.length+1||!isDeepStrictEqual(s.points.slice(0,-1),prior)||!added||added.point_id!==event.data.point_id||observed.points.some((/** @type {any} */point)=>point.point_id===added.point_id)||s.last_good_usable!==added.point_id||added.source_generation!==observed.priorGeneration||added.source_authority_epoch!==observed.priorEpoch||s.points.some((/** @type {any} */point)=>point.compatibility_sha256!==s.compatibility_sha256)||added.status!=='usable'||added.active_references!==0||added.created_order!==Math.max(0,...observed.points.map((/** @type {any} */point)=>point.created_order))+1)throw Error('REWIND_POINTS');
  if(s.phase==='ready')commitReady(s,observed.priorGeneration);
  session=copy(s);retireObserved();uncertain=false;code=null;seen.add(event.event_id);publish();
 }
 /** Core-only incoming path; renderer cannot invoke this method. @param {any} event */
 function receive(event){
  if(!rewindValid('rewind_event.schema.json',event)||event.owner_id!==ownerId||seen.has(event.event_id)||seen.size>=8192)throw Error('REWIND_PROTOCOL');
  const p=pending.get(event.request_id),old=history.get(event.request_id),s=event.session;
  if(event.event==='recovery_ready'){
   const cleanup=stopTarget();
   if(!uncertain||pending.size||!old?.unknown||old.recovered||old.body.op!=='restore'||event.data.failed_request_id!==event.request_id||s?.phase!=='recoverable'||s.ownership!=='held'||s.last_good_usable!==event.data.point_id||!session||s.workload_id!==session.workload_id||s.generation!==cleanup?.generation||s.workload_id!==cleanup?.workload_id||s.generation!==old.body.params.generation+(old.advances?1:0)||s.authority_epoch!==old.body.params.authority_epoch+(old.advances?1:0))throw Error('REWIND_RECOVERY');
   old.recovered=true;session=copy(s);uncertain=false;code='RESTORE_FAILED';seen.add(event.event_id);publish();return;
  }
  if(!p&&!old){receiveObservedMark(event);return;}
  if(!p||event.data.op!==p.body.op)throw Error('REWIND_CORRELATION');
  if(s){
   const n=p.advances&&event.event!=='refused'?1:0;
   if(s.owner_id!==ownerId||s.workload_id!==p.body.params.workload_id||s.generation!==p.body.params.generation+n||s.authority_epoch!==p.body.params.authority_epoch+n)throw Error('REWIND_BINDING');
  }
  if(event.event==='accepted'){
   const phase=/** @type {Record<string,string>} */({pause:'pausing',resume:'resuming',mark:'marking',restore:'restoring'})[p.body.op];
   const stopping=s?.phase==='stopping'&&guest()?.session?.controls?.stop!==null&&guest()?.session?.controls?.stop!==undefined;
   if(p.accepted||!s||s.phase!==phase&&!stopping||s.pending_request_id!==p.body.request_id)throw Error('REWIND_ORDER');
   p.accepted=true;session=copy(s);seen.add(event.event_id);publish();return;
  }
  if(event.event==='refused'){
   if(p.accepted)throw Error('REWIND_ORDER');code=event.data.code;plannedStop=null;
  }else if(event.event==='outcome_unknown'){
   if(s&&(s.phase!=='uncertain'||s.ownership!=='held'||s.pending_request_id!==p.body.request_id))throw Error('REWIND_ORDER');if(s)session=copy(s);seen.add(event.event_id);lose();return;
  }else if(event.event==='completed'){
   if(!p.accepted||!s||s.pending_request_id!==null)throw Error('REWIND_ORDER');
   const expected=p.body.op==='pause'?'paused':p.body.op==='mark'?p.origin:'ready';
   const stopping=s.phase==='stopping'&&guest()?.session?.controls?.stop!==null&&guest()?.session?.controls?.stop!==undefined;
   if(s.phase!==expected&&!stopping||p.body.op==='restore'&&event.data.point_id!==p.body.params.point_id||p.body.op==='mark'&&!s.points.some((/** @type {any} */point)=>point.point_id===event.data.point_id))throw Error('REWIND_ORDER');
   if(s.phase==='ready')commitReady(s,p.body.params.generation);
   session=copy(s);uncertain=false;code=null;
  }else throw Error('REWIND_ORDER');
  seen.add(event.event_id);clearTimeout(p.timer);pending.delete(event.request_id);history.set(event.request_id,{body:p.body,unknown:false});p.resolve(publish());
 }
 return Object.freeze({status,request,receive,target,stopTarget,commandAllowed,guestClosed,disconnect(){closed=true;lose();},subscribe(/** @type {(value:any)=>void} */callback){if(typeof callback!=='function'||listeners.size>=64)throw Error('REWIND_SUBSCRIBER');listeners.add(callback);callback(status());return()=>listeners.delete(callback);}});
}
