import {rewindSnapshot,rewindAction} from '../../electron/rewindValues.js';
import {gcSnapshot} from '../../electron/guestCommandValues.js';

/** @typedef {{point_id:string,label:string,age_ms:number|null,counter_value:number|null}} HeaderPoint */
/** @typedef {{back:{available:boolean,points:HeaderPoint[]},phase:string|null,error:string|null,warning:string|null}} HeaderCapabilities */
/** @returns {HeaderCapabilities} */
const hidden=()=>({back:{available:false,points:[]},phase:null,error:null,warning:null});
/** Pure projection. Call with current authoritative props; no captured authority.
 * @param {any} snapshot @param {any} guest @returns {HeaderCapabilities} */
export function rewindHeaderCapabilities(snapshot,guest){
 try {
  if(!rewindSnapshot(snapshot)||!gcSnapshot(guest))return hidden();
  const s=snapshot.session,g=guest.session;
  if(!snapshot.available||!guest.available||!s||!g)return hidden();
  /** @type {HeaderCapabilities} */
  const result={back:{available:false,points:[]},phase:s.phase,error:snapshot.code,warning:s.external_effects_warning};
  const recovering=s.phase==='recoverable';
  if(s.ownership!=='held'||g.ownership!=='held'||s.workload_id!==g.workload_id||s.owner_id!==g.owner_id||
     snapshot.busy||guest.busy||guest.uncertain||g.phase!=='ready'||g.controls.stop!==null||g.controls.cancel!==null||
     s.pending_request_id!==null||!['ready','paused','recoverable'].includes(s.phase)||
     (snapshot.uncertain&&!recovering)||(!recovering&&snapshot.code!==null)||
     (!recovering&&s.generation!==g.generation)||(recovering&&g.generation>s.generation)||
     !Number.isSafeInteger(s.generation+1)||!Number.isSafeInteger(s.authority_epoch+1))return result;
  if(g.job!==null&&!['exited','cancelled','timed_out','output_limit'].includes(g.job.state))return result;
  result.back.points=s.points.filter((/** @type {any} */ p)=>p.status==='usable'&&(!recovering||p.point_id===s.last_good_usable))
   .map((/** @type {any} */ p)=>({point_id:p.point_id,label:p.label,age_ms:snapshot.point_ages_ms[p.point_id],counter_value:p.counter_value}));
  result.back.available=result.back.points.length>0;
  return result;
 } catch {return hidden();}
}

/** Build one facade action from props freshly supplied by the click handler.
 * @param {any} snapshot @param {any} guest @param {string} point_id
 * @returns {{op:string,workload_id:string,generation:number,authority_epoch:number,point_id:string}|null} */
export function rewindHeaderRestoreAction(snapshot,guest,point_id){
 const caps=rewindHeaderCapabilities(snapshot,guest);
 if(!caps.back.available||typeof point_id!=='string'||!caps.back.points.some(p=>p.point_id===point_id))return null;
 const s=snapshot.session;
 const action={op:'restore',workload_id:s.workload_id,generation:s.generation,authority_epoch:s.authority_epoch,point_id};
 return rewindAction(action)?action:null;
}
