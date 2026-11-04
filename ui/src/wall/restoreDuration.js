import {rewindSnapshot} from '../../electron/rewindValues.js';
import {gcSnapshot} from '../../electron/guestCommandValues.js';
import {rewindHeaderRestoreAction} from './rewindStateControls.js';

/** Local presentation timing only. It grants no action or backend authority.
 * A ready generation alone is insufficient: an observed restoring request must
 * precede its ready successor. Missing intermediate props remain unavailable.
 * @param {()=>number} [clock] */
export function createRestoreDuration(clock=()=>performance.now()) {
 let attempt=/** @type {any} */(null),confirmed=/** @type {any} */(null);
 const clear=()=>{attempt=null;confirmed=null;return null;};
 /** @param {any} action @param {any} snapshot @param {any} guest */
 function begin(action,snapshot,guest){
  clear();
  const expected=rewindHeaderRestoreAction(snapshot,guest,action?.point_id),now=clock();
  if(!expected||!action||Object.keys(action).length!==Object.keys(expected).length||
     Object.keys(expected).some(key=>action[key]!==expected[/** @type {keyof typeof expected} */(key)])||!Number.isFinite(now)||now<0)return false;
  attempt={...expected,owner_id:snapshot.session.owner_id,start:now,last:now,request_id:null};
  return true;
 }
 /** @param {any} snapshot @param {any} guest @returns {number|null} */
 function observe(snapshot,guest){
  if(!rewindSnapshot(snapshot)||!gcSnapshot(guest)||!snapshot.available||!guest.available||snapshot.uncertain||guest.uncertain||snapshot.code!==null||guest.code!==null)return clear();
  const s=snapshot.session,g=guest.session;
  if(!s||!g||s.ownership!=='held'||g.ownership!=='held'||s.owner_id!==g.owner_id||s.workload_id!==g.workload_id||g.controls.stop!==null||g.controls.cancel!==null)return clear();
  if(!attempt){
   return confirmed&&s.owner_id===confirmed.owner_id&&s.workload_id===confirmed.workload_id&&s.generation===confirmed.generation&&s.authority_epoch===confirmed.authority_epoch&&s.phase==='ready'?confirmed.ms:clear();
  }
  const a=attempt,now=clock();
  if(!Number.isFinite(now)||now<a.last||now-a.start>=60000||s.owner_id!==a.owner_id||s.workload_id!==a.workload_id)return clear();
  a.last=now;
  const successor=s.generation===a.generation+1&&s.authority_epoch===a.authority_epoch+1;
  if(s.phase==='restoring'){
   if(!successor||!snapshot.busy||!s.pending_request_id||(a.request_id!==null&&a.request_id!==s.pending_request_id))return clear();
   a.request_id=s.pending_request_id;return null;
  }
  if(s.phase==='ready'&&successor){
   if(a.request_id===null||snapshot.busy||s.pending_request_id!==null||s.last_good_usable!==a.point_id)return clear();
   if(g.generation!==s.generation||g.phase!=='ready'||guest.busy)return null;
   const ms=Math.round((now-a.start)*10)/10;if(ms<=0)return clear();
   confirmed={owner_id:s.owner_id,workload_id:s.workload_id,generation:s.generation,authority_epoch:s.authority_epoch,ms};attempt=null;return ms;
  }
  if(s.generation!==a.generation||s.authority_epoch!==a.authority_epoch||!['ready','pausing','paused','recoverable'].includes(s.phase)||a.request_id!==null)return clear();
  return null;
 }
 return Object.freeze({begin,observe,clear});
}
