/** Closed headless values. No renderer-selected profile, path, backend or request ID. */
/** @param {any} v @param {string} names */
export const keys = (v, names) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  && Reflect.ownKeys(v).every(k => typeof k === 'string' && 'value' in (Object.getOwnPropertyDescriptor(v,k) ?? {}))
  && Reflect.ownKeys(v).sort().join(',') === names;
/** @param {any} v @param {string} p */
const id = (v,p) => typeof v === 'string' && new RegExp(`^${p}-[a-z0-9][a-z0-9._-]{0,63}$`).test(v);
/** @param {any} n */
export const validN = n => Number.isSafeInteger(n) && n >= 0 && n <= 10000;
/** @param {any} s */
export function validSession(s) {
  if (!keys(s,'backend,generation,isa,job,owner_id,ownership,phase,profile_id,schema,workload_id')
      || s.schema !== 'headless_session/v0.2' || !id(s.workload_id,'workload') || !id(s.owner_id,'actor')
      || !Number.isSafeInteger(s.generation) || s.generation < 1 || s.profile_id !== 'headless-sumsq-v1'
      || s.backend !== 'firecracker' || s.isa !== 'aarch64'
      || !['starting','ready','running','completed','stopping','stopped','uncertain'].includes(s.phase)
      || s.ownership !== (s.phase === 'stopped' ? 'released' : 'held')) return false;
  const j = s.job;
  if (j !== null && (!keys(j,'job_id,n,operation,status,value') || !id(j.job_id,'job') || j.operation !== 'sumsq'
      || !validN(j.n) || !['accepted','completed','unknown'].includes(j.status)
      || (j.status === 'completed' ? j.value !== j.n*(j.n+1)*(2*j.n+1)/6 : j.value !== null))) return false;
  if (['starting','ready'].includes(s.phase)) return j === null;
  if (s.phase === 'running') return j?.status === 'accepted';
  if (s.phase === 'completed') return j?.status === 'completed';
  return j === null || j.status !== 'accepted';
}
/** @param {any} a */
export function validAction(a) {
  if (keys(a,'op')) return a.op === 'create';
  if (keys(a,'generation,op,workload_id')) return a.op === 'stop' && id(a.workload_id,'workload') && Number.isSafeInteger(a.generation) && a.generation > 0;
  return keys(a,'generation,n,op,workload_id') && a.op === 'run' && validN(a.n)
    && id(a.workload_id,'workload') && Number.isSafeInteger(a.generation) && a.generation > 0;
}
/** @param {any} v */
export function validSnapshot(v) {
  return keys(v,'available,busy,code,revision,session,uncertain') && typeof v.available === 'boolean'
    && typeof v.busy === 'boolean' && typeof v.uncertain === 'boolean' && Number.isSafeInteger(v.revision) && v.revision >= 0
    && (v.session === null || validSession(v.session))
    && (v.code === null || ['UNAVAILABLE','BUSY','BAD_REQUEST','OWNER_MISMATCH','UNKNOWN_WORKLOAD','STALE_GENERATION','DUPLICATE_REQUEST','DUPLICATE_JOB','OUT_OF_ORDER','POLICY','OUTCOME_UNKNOWN'].includes(v.code));
}
/** @param {any} v */
export function validEvent(v) {
  if (!keys(v,'data,event,event_id,request_id,schema') || v.schema !== 'headless_event/v0.2'
      || !id(v.event_id,'event') || !id(v.request_id,'request')) return false;
  const d=v.data;
  if (v.event === 'refused') return keys(d,'code,effect,generation,workload_id') && d.effect === 'not_dispatched'
    && ['UNAVAILABLE','BUSY','BAD_REQUEST','OWNER_MISMATCH','UNKNOWN_WORKLOAD','STALE_GENERATION','DUPLICATE_REQUEST','DUPLICATE_JOB','OUT_OF_ORDER','POLICY'].includes(d.code)
    && ((d.workload_id === null && d.generation === null) || (id(d.workload_id,'workload') && Number.isSafeInteger(d.generation) && d.generation > 0));
  if (v.event === 'accepted') return keys(d,'op,session') && ['create','run','stop'].includes(d.op) && validSession(d.session);
  if (v.event === 'outcome_unknown') return keys(d,'code,op,session') && d.code === 'OUTCOME_UNKNOWN' && ['create','run','stop'].includes(d.op) && validSession(d.session);
  return ['completed','state_changed'].includes(v.event) && keys(d,'session') && validSession(d.session);
}
