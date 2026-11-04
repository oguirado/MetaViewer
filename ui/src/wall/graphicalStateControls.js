// Renderer-only projection of the graphical host facade; never an IPC envelope.
/** @returns {{available:boolean,busy:boolean,code:string|null,revision:number,session:any,uncertain:boolean,point_ages_ms:Record<string,number|null>}} */
export const emptyGraphicalSnapshot = () => ({available:false,busy:false,code:null,revision:0,session:null,uncertain:false,point_ages_ms:{}});
/** @param {any} value */
const integer = value => Number.isSafeInteger(value) && value >= 0;
/** @param {any} value */
const text = value => typeof value === 'string' && value.length <= 128 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
/** @param {any} value */
export const graphicalLabel = value => typeof value === 'string' && [...value].length <= 80 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069/\\]/.test(value);
/** The host validates the wire schema. Refuse malformed display/fence data here too. @param {any} value */
export function graphicalSnapshot(value) {
  if (!value || typeof value.available !== 'boolean' || typeof value.busy !== 'boolean' || typeof value.uncertain !== 'boolean' || !integer(value.revision) || !(value.code === null || text(value.code)) || !value.point_ages_ms || typeof value.point_ages_ms !== 'object' || Array.isArray(value.point_ages_ms)) return false;
  const s=value.session;
  if (s === null) return true;
  return s?.schema === 'graphical_session/v0.2' && text(s.surface_id) && s.surface_id.length > 0 && /^runtime-[a-f0-9]{64}$/.test(s.runtime_id) && /^actor-[a-z0-9][a-z0-9._-]{0,63}$/.test(s.owner_id)
    && integer(s.generation) && s.generation > 0 && integer(s.authority_epoch) && s.authority_epoch > 0 && s.authority === 'core' && s.backend === 'qemu' && s.isa === 'aarch64'
    && ['ready','pending','outcome_unknown','stopping','stopped'].includes(s.phase) && ['held','released'].includes(s.ownership) && (s.pending_request_id === null || /^request-[a-z0-9][a-z0-9._-]{0,63}$/.test(s.pending_request_id))
    && Array.isArray(s.points) && s.points.length <= 4 && new Set(s.points.map((/** @type {any} */p)=>p?.point_id)).size === s.points.length && s.points.every((/** @type {any} */p)=>p && /^point-[a-z0-9][a-z0-9._-]{0,63}$/.test(p.point_id) && graphicalLabel(p.label) && integer(p.generation) && p.generation > 0 && /^[a-f0-9]{64}$/.test(p.manifest_sha256) && integer(p.created_mono_ns) && p.created_mono_ns > 0);
}
/** Control ownership deliberately does not gate UI rewind: Human Take control retains it. @param {any} snapshot @param {any} row */
export function graphicalCapabilities(snapshot,row) {
  const visible = graphicalSnapshot(snapshot) && (snapshot.available || snapshot.code !== null || snapshot.session !== null) && row?.kind === 'vm' && (!snapshot.session || snapshot.session.surface_id===row.id);
  const s=visible ? snapshot.session : null;
  const matching = !!s && s.surface_id === row.id;
  const held=matching && snapshot.available && s.ownership === 'held' && s.phase !== 'stopped';
  const enabled=held && row.backendLifecycle === 'active' && !snapshot.busy && !snapshot.uncertain && s.phase === 'ready' && s.pending_request_id === null;
  return {visible,held,enabled,back:{available:held && s.points.length > 0},mark:{available:held && s.points.length < 4},points:matching?s.points:[],phase:matching?s.phase:null,code:visible?snapshot.code:null,uncertain:visible && snapshot.uncertain};
}
/** Build only the facade's admitted fields, bound to the currently displayed tuple. @param {any} snapshot @param {any} row @param {string} op @param {string} [value] */
export function graphicalAction(snapshot,row,op,value='') {
  if (!graphicalCapabilities(snapshot,row).enabled) return null;
  const s=snapshot.session;
  const target={op,surface_id:row.id,generation:s.generation,authority_epoch:s.authority_epoch};
  if(op==='mark' && s.points.length < 4 && graphicalLabel(value))return {...target,label:value};
  if(op==='restore' && s.points.some((/** @type {any} */p)=>p.point_id===value))return {...target,point_id:value};
  return null;
}
/** Subscribe once, fence async results, and never discard a held session on transport loss.
 * @param {any} host @param {(snapshot:any)=>void} changed */
export function createGraphicalSessionController(host,changed=()=>{}) {
  let state=emptyGraphicalSnapshot(),alive=true,pending=false,failedRevision=-1;
  const attempted=new Set();
  const publish=()=>changed({...state,busy:state.busy||pending});
  const accept=(/** @type {any} */value)=>{
    if(!alive || !graphicalSnapshot(value) || value.revision < state.revision || value.revision <= failedRevision)return false;
    state=value;publish();return true;
  };
  const uncertain=()=>{if(!alive)return;failedRevision=state.revision;state={...state,uncertain:true,code:'OUTCOME_UNKNOWN'};publish();};
  let unsubscribe=/** @type {(()=>void)|undefined} */(undefined);
  try {unsubscribe=host?.subscribe?.(accept);} catch {uncertain();}
  async function refresh(){try {const value=await host?.status?.();if(value!==undefined&&!accept(value)&&alive&&!graphicalSnapshot(value))uncertain();}catch{uncertain();}}
  /** @param {any} action */
  async function send(action){
    if(!alive||pending||typeof host?.request!=='function')return false;
    pending=true;publish();
    try {const value=await host.request(action);if(alive&&!accept(value)&&!graphicalSnapshot(value))uncertain();return alive;}
    catch {uncertain();return false;} finally {pending=false;if(alive)publish();}
  }
  return {
    refresh,
    /** No retries of an ambiguous or refused attach; only a new physical surface starts another attempt. @param {any[]} rows */
    async attach(rows){
      if(!alive||pending||!state.available||state.busy||state.uncertain||(state.session && !(state.session.phase==='stopped'&&state.session.ownership==='released')))return;
      const row=rows.find(r=>r.kind==='vm'&&r.backendLifecycle==='active'&&!attempted.has(r.id));
      if(row){attempted.add(row.id);await send({op:'attach',surface_id:row.id});}
    },
    /** Reject saved click handlers and tuples from before a host publication. @param {any} action @param {number} revision @param {any[]} rows */
    async request(action,revision,rows){
      if(!alive||pending||revision!==state.revision)return false;
      const row=rows.find(r=>r.id===action?.surface_id);
      const fresh=graphicalAction(state,row,action?.op,action?.op==='mark'?action.label:action?.point_id);
      if(!fresh||Object.keys(fresh).sort().join(',')!==Object.keys(action).sort().join(',')||Object.entries(fresh).some(([key,value])=>action[key]!==value))return false;
      return send(fresh);
    },
    dispose(){alive=false;unsubscribe?.();},
  };
}
