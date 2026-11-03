import {gcSnapshot} from '../../electron/guestCommandValues.js';
export const GUEST_WORKLOAD_PANEL_PREFIX='guest-console-panel:';
/** A presentation identity, never a surface ID or frame authority.
 * @param {any} snapshot */
export function guestWorkloadTile(snapshot) {
 if(!gcSnapshot(snapshot)||!snapshot.session)return null;
 const s=snapshot.session;
 return Object.freeze({kind:'guest-command',id:`guest-console:${s.workload_id}:${s.generation}`,workload_id:s.workload_id,generation:s.generation,title:'ARM64 MicroVM',snapshot});
}
/** @param {any} value */
export function validGuestWorkloadTile(value) {
 if(!value||Object.keys(value).sort().join(',')!=='generation,id,kind,snapshot,title,workload_id'||value.kind!=='guest-command'||value.title!=='ARM64 MicroVM')return false;
 const expected=guestWorkloadTile(value.snapshot);
 return expected!==null&&expected.id===value.id&&expected.workload_id===value.workload_id&&expected.generation===value.generation;
}
