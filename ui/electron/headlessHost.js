import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validAction, validEvent} from './headlessValues.js';

/** Same authenticated core connection; no native execution or reconnect. */
/** @param {{send:(body:any)=>void,available:()=>boolean,ownerId:string,timeoutMs?:number}} options */
export function createHeadlessHost({send, available, ownerId, timeoutMs=35000}) {
  /** @type {any} */ let session=null;
  /** @type {any} */ let pending=null;
  /** @type {any} */ let retired=null;
  let uncertain=false, consumed=false, jobAttempted=false, revision=0, closed=false;
  /** @type {string|null} */ let code=null;
  /** @type {Set<(snapshot:any)=>void>} */ const listeners=new Set();
  const seen=new Set();
  /** @param {any} v */
  const copy=v=>structuredClone(v);
  const status=()=>copy({available:!closed && available()===true,busy:pending!==null,code,revision,session,uncertain});
  const publish=()=>{revision++;const s=status();for(const cb of listeners){try{cb(copy(s));}catch{listeners.delete(cb);}}return s;};
  function disconnect(){
    closed=true;
    if(pending){clearTimeout(pending.timer);const p=pending;pending=null;uncertain=true;code='OUTCOME_UNKNOWN';p.resolve(publish());}
    else {if(session?.ownership==='held') {uncertain=true;code='OUTCOME_UNKNOWN';}publish();}
  }
  /** @param {any} action */
  async function request(action) {
    if(!validAction(action)) throw Error('BAD_REQUEST');
    if(closed || !available()) {code='UNAVAILABLE';return publish();}
    if(pending) {code='BUSY';return publish();}
    if(action.op==='create' ? consumed : !session || session.ownership!=='held'
      || action.workload_id!==session.workload_id || action.generation!==session.generation) {code='OUT_OF_ORDER';return publish();}
    if(action.op==='run' && (uncertain || jobAttempted || session.phase!=='ready')) {code='OUT_OF_ORDER';return publish();}
    if(action.op==='stop' && !uncertain && !['ready','completed','uncertain'].includes(session.phase)) {code='OUT_OF_ORDER';return publish();}
    const op=action.op, params=op==='create'?{template:'headless-sumsq'}:{workload_id:session.workload_id,generation:session.generation,
      ...(op==='run'?{job_id:'job-'+randomUUID(),operation:'sumsq',n:action.n}:{})};
    const body={schema:'headless_request/v0.2',request_id:'request-'+randomUUID(),op,params};
    if(op==='create')consumed=true;
    if(op==='run')jobAttempted=true;
    code=null;
    return new Promise(resolve=>{
      /** @type {any} */ const p={body,resolve,accepted:false,timer:null};pending=p;
      p.timer=setTimeout(()=>{if(pending!==p)return;pending=null;retired=p;uncertain=true;code='OUTCOME_UNKNOWN';resolve(publish());},timeoutMs);
      publish();
      try {send(body);} catch {clearTimeout(p.timer);pending=null;uncertain=true;code='OUTCOME_UNKNOWN';resolve(publish());}
    });
  }
  /** Adopt only an authenticated core lifecycle for this already-owned workload.
   * No request is sent and no renderer authority is manufactured. @param {any} event */
  function adoptExternal(event) {
    const d=event.data, op=d.op, next=d.session;
    if(pending || !session || session.ownership!=='held' || retired?.body.request_id===event.request_id
      || !['accepted','outcome_unknown'].includes(event.event) || !['run','stop'].includes(op))return null;
    if(op==='run') {
      if(uncertain || jobAttempted || session.phase!=='ready' || session.job!==null
        || !next.job || next.job.status!==(event.event==='accepted'?'accepted':'unknown') || next.job.value!==null)throw Error('HEADLESS_JOB');
    } else {
      if(!['ready','completed','uncertain'].includes(session.phase) && !uncertain)throw Error('HEADLESS_ORDER');
      if(!isDeepStrictEqual(next.job,session.job)) {
        const old=session.job, job=next.job;
        if(!uncertain || !old || !job || job.status!=='unknown' || job.value!==null
          || job.job_id!==old.job_id || job.n!==old.n || job.operation!==old.operation)throw Error('HEADLESS_JOB');
      }
    }
    if(next.ownership!=='held' || next.phase!==(event.event==='outcome_unknown'?'uncertain':op==='run'?'running':'stopping'))throw Error('HEADLESS_ORDER');
    const body={schema:'headless_request/v0.2',request_id:event.request_id,op,
      params:{workload_id:session.workload_id,generation:session.generation,
        ...(op==='run'?{job_id:next.job.job_id,operation:'sumsq',n:next.job.n}:{})}};
    const p={body,accepted:false,resolve:()=>{},timer:/** @type {ReturnType<typeof setTimeout>|null} */(null)};
    p.timer=setTimeout(()=>{if(pending!==p)return;pending=null;retired=p;uncertain=true;code='OUTCOME_UNKNOWN';publish();},timeoutMs);
    if(op==='run')jobAttempted=true;
    pending=p;code=null;return p;
  }
  /** @param {any} event */
  function receive(event) {
    if(closed || !validEvent(event))throw Error('HEADLESS_PROTOCOL');
    if(seen.has(event.event_id) || seen.size>=32)throw Error('HEADLESS_REPLAY');
    const incoming=event.data.session;
    if(incoming && (incoming.owner_id!==ownerId || (session && (incoming.workload_id!==session.workload_id || incoming.generation!==session.generation))))throw Error('HEADLESS_OWNER');
    const p=pending ?? adoptExternal(event);
    if(!p || event.request_id!==p.body.request_id) {
      // A late outcome never revives a timed-out operation or grants a new attempt.
      if(uncertain && !p && retired && event.request_id===retired.body.request_id && event.data?.session) {
        const s=event.data.session;
          if(s.owner_id!==ownerId || (session && (s.workload_id!==session.workload_id || s.generation!==session.generation)))throw Error('HEADLESS_OWNER');
          // Retain a late authoritative tuple for cleanup only. Never turn a timeout into successful completion.
          if(retired.body.op==='create' ? s.job!==null : retired.body.op==='run' && (s.job?.job_id!==retired.body.params.job_id || s.job?.n!==retired.body.params.n))throw Error('HEADLESS_JOB');
          if(event.event==='accepted') {
            if(event.data.op!==retired.body.op || s.phase!==(retired.body.op==='create'?'starting':retired.body.op==='run'?'running':'stopping'))throw Error('HEADLESS_ORDER');
            session=copy(s);publish();
          } else if(event.event==='outcome_unknown') {
            if(event.data.op!==retired.body.op || s.phase!=='uncertain')throw Error('HEADLESS_ORDER');
            session=copy(s);publish();
          }
        seen.add(event.event_id);return;
      }
      throw Error('HEADLESS_CORRELATION');
    }
    const d=event.data, op=p.body.op;
    if(event.event==='refused') {
      if(p.accepted || (session ? d.workload_id!==session.workload_id || d.generation!==session.generation : d.workload_id!==null || d.generation!==null))throw Error('HEADLESS_REFUSAL');
      code=d.code;clearTimeout(p.timer);pending=null;p.resolve(publish());return;
    }
    const s=d.session;
    if(s.owner_id!==ownerId || (session && (s.workload_id!==session.workload_id || s.generation!==session.generation)))throw Error('HEADLESS_OWNER');
    if(op==='run' && (s.job?.job_id!==p.body.params.job_id || s.job?.n!==p.body.params.n))throw Error('HEADLESS_JOB');
    if(op==='create' && s.job!==null)throw Error('HEADLESS_JOB');
    if(op==='stop' && !isDeepStrictEqual(s.job,session?.job)) {
      const old=session?.job, next=s.job;
      if(!uncertain || !old || !next || next.status!=='unknown' || next.value!==null
        || next.job_id!==old.job_id || next.n!==old.n || next.operation!==old.operation)throw Error('HEADLESS_JOB');
    }
    if(event.event==='accepted') {
      if(p.accepted || d.op!==op || s.phase!==(op==='create'?'starting':op==='run'?'running':'stopping'))throw Error('HEADLESS_ORDER');
      p.accepted=true;session=copy(s);seen.add(event.event_id);publish();return;
    }
    if(event.event==='outcome_unknown') {
      if(d.op!==op || s.phase!=='uncertain')throw Error('HEADLESS_ORDER');
      retired=p;uncertain=true;code='OUTCOME_UNKNOWN';
    } else {
      if(!p.accepted || (op==='run' ? event.event!=='completed'||s.phase!=='completed' : event.event!=='state_changed'||s.phase!==(op==='create'?'ready':'stopped')))throw Error('HEADLESS_ORDER');
      uncertain=false;code=null;
    }
    session=copy(s);seen.add(event.event_id);clearTimeout(p.timer);pending=null;p.resolve(publish());
  }
  return Object.freeze({status,request,receive,disconnect,subscribe(/** @type {(snapshot:any)=>void} */ cb){listeners.add(cb);cb(status());return()=>listeners.delete(cb);}});
}
