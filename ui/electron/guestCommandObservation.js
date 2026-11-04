import {createHash} from 'node:crypto';
import {gcValid} from './guestCommandValues.js';
import {observationValid} from './guestCommandObservationValues.js';

const MAX=Number.MAX_SAFE_INTEGER;
/** @param {any} value @param {string[]} names */
const keys=(value,names)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
 &&[Object.prototype,null].includes(Object.getPrototypeOf(value))
 &&Reflect.ownKeys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k)
 &&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)??{},'value'));
/** @param {any} value */
const scalar=value=>typeof value==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
/** @param {any} value @param {string} prefix */
const id=(value,prefix)=>scalar(value)&&new RegExp(`^${prefix}-[a-z0-9][a-z0-9._-]{0,63}$(?![\\s\\S])`).test(value);
/** @param {any} value */
const integer=value=>Number.isSafeInteger(value)&&value>=1;
/** @param {any} value */
const endpoint=value=>keys(value,['component','instance'])&&scalar(value.instance)&&value.instance.length>=1&&value.instance.length<=128;
/** @param {any} a @param {any} b */
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** @param {any} s @param {any} r */
const tuple=(s,r)=>[s.owner_id,s.workload_id,s.generation,r];
/** @param {any} s @param {any} r @param {any} expected */
const sameTuple=(s,r,expected)=>equal(tuple(s,r),expected);
/** @param {any} value */
const copy=value=>structuredClone(value);
const observationKeys=['schema','event_id','event','accepted_event_id','request_id','reservation_id','owner_id','workload_id','generation','job_id','requester','command_utf8','cwd','timeout_ms'];

/** Closed presentation metadata; never an executable request. @param {any} v */
export function validGuestCommandObservation(v){
 return keys(v,observationKeys)&&observationValid(v)&&v.schema==='guest_command_observation/v0.2'&&v.event==='accepted_run'
 &&id(v.event_id,'event')&&id(v.accepted_event_id,'event')&&v.event_id!==v.accepted_event_id
 &&id(v.request_id,'request')&&id(v.reservation_id,'reservation')&&id(v.owner_id,'actor')
 &&id(v.workload_id,'workload')&&id(v.job_id,'job')&&integer(v.generation)
 &&endpoint(v.requester)&&['ui','agent'].includes(v.requester.component)
 &&scalar(v.command_utf8)&&Buffer.byteLength(v.command_utf8)>=1&&Buffer.byteLength(v.command_utf8)<=16384&&!v.command_utf8.includes('\0')
 &&scalar(v.cwd)&&Buffer.byteLength(v.cwd)<=1024&&!/[\x00-\x1f\x7f]/.test(v.cwd)
 &&(!v.cwd||!v.cwd.startsWith('/')&&v.cwd.split('/').every((/** @type {string} */ p)=>p!==''&&p!=='.'&&p!=='..'&&Buffer.byteLength(p)<=255))
 &&integer(v.timeout_ms)&&v.timeout_ms<=60000;
}

/** Pure readonly projection. Gateway must authenticate these metadata values before
 * calling this module; matching strings here cannot prove socket authentication.
 * No send, local pending promise, control authority or epoch is produced.
 * @param {any} options */
export function createGuestCommandObservation({sessionId,coreInstance,uiInstance,agentInstance,session,reservationId}){
 if(![sessionId,coreInstance,uiInstance,agentInstance].every(v=>scalar(v)&&v.length>0&&v.length<=128)
 ||!gcValid('guest_command_session.schema.json',session)||session.phase!=='ready'||session.ownership!=='held'
 ||!id(reservationId,'reservation'))throw Error('OBSERVATION_BINDING');
 const expectedOwner='actor-'+createHash('sha256').update('agent:'+agentInstance).digest('hex');
 if(session.owner_id!==expectedOwner)throw Error('OBSERVATION_OWNER');
 let binding=tuple(session,reservationId),uncertain=false,lastSeq=0,jobsStarted=session.jobs_started;
 /** @type {any} */ let staged=null;
 /** @type {any} */ let active=null;
 const events=new Set(),requests=new Set();
 /** @type {any[]} */ const history=[];
 const snapshot=()=>copy({staged:staged?{request_id:staged.value.request_id,job_id:staged.value.job_id}:null,
  active:active?{...active.value,state:active.state,stdout:active.output.stdout,stderr:active.output.stderr}:null,history,uncertain,generation:binding[2]});
 const fail=()=>{uncertain=true;staged=null;if(active)active.state='unknown';throw Error('OBSERVATION_PROTOCOL');};
 /** @param {any} m */
 function meta(m){
  if(!keys(m,['session_id','from','to','seq'])||m.session_id!==sessionId||!endpoint(m.from)||!endpoint(m.to)
   ||m.from.component!=='core'||m.from.instance!==coreInstance||m.to.component!=='ui'||m.to.instance!==uiInstance
   ||!integer(m.seq)||m.seq<=lastSeq)return fail();
 }
 /** @param {any} e */
 function eventFresh(e){if(!id(e.event_id,'event')||events.has(e.event_id)||events.size>=8192)return fail();}
 /** @param {any} e @param {any} m */
 function remember(e,m){events.add(e.event_id);lastSeq=m.seq;}
 /** @param {any} value @param {any} m */
 function observe(value,m){
  meta(m);eventFresh(value);
  if(uncertain||staged||active||!validGuestCommandObservation(value)||!sameTuple(value,value.reservation_id,binding)
   ||events.has(value.accepted_event_id)||requests.has(value.request_id)||requests.size>=64
   ||value.requester.instance!==(value.requester.component==='agent'?agentInstance:uiInstance))return fail();
  staged={value:copy(value),seq:m.seq};requests.add(value.request_id);remember(value,m);return snapshot();
 }
 /** @param {any} e @param {any} m */
 function receive(e,m){
  meta(m);eventFresh(e);
  if(uncertain||!gcValid('guest_command_event.schema.json',e)||!sameTuple(e.session??{},e.reservation_id,binding)
   ||e.owner_id!==binding[0]||e.session.ownership!=='held')return fail();
  if(e.event==='accepted'){
   const o=staged?.value;
   if(!o||active||m.seq!==staged.seq+1||e.event_id!==o.accepted_event_id||e.request_id!==o.request_id
    ||e.data.op!=='run'||e.session.job?.job_id!==o.job_id||e.session.job.state!=='running'
    ||!['running','stopping'].includes(e.session.phase)||e.session.jobs_started!==jobsStarted+1
    ||e.session.job.stdout_bytes!==0||e.session.job.stderr_bytes!==0||e.session.job.output_complete)return fail();
   if(e.session.phase==='stopping'&&e.session.controls.stop===null)return fail();
   active={value:copy(o),state:e.session.phase,indices:{stdout:0,stderr:0},counts:{stdout:0,stderr:0},
    hashes:{stdout:createHash('sha256'),stderr:createHash('sha256')},output:{stdout:'',stderr:''},decoders:{stdout:new TextDecoder(),stderr:new TextDecoder()}};
   jobsStarted=e.session.jobs_started;staged=null;remember(e,m);return snapshot();
  }
  if(!active||e.request_id!==active.value.request_id||e.session.job?.job_id!==active.value.job_id)return fail();
  if(e.event==='outcome_unknown'){remember(e,m);return fail();}
  if(e.event==='output'){
   const d=e.data,stream=d.stream,bytes=Buffer.from(d.data_b64,'base64');
   if(d.job_id!==active.value.job_id||!['stdout','stderr'].includes(stream)||bytes.toString('base64')!==d.data_b64
    ||bytes.length<1||bytes.length>16384||d.chunk_index!==active.indices[stream]
    ||active.counts.stdout+active.counts.stderr+bytes.length>65536||!['running','cancelling','stopping'].includes(e.session.phase))return fail();
   const next={...active.counts,[stream]:active.counts[stream]+bytes.length};
   if(e.session.job.stdout_bytes!==next.stdout||e.session.job.stderr_bytes!==next.stderr)return fail();
   active.indices[stream]++;active.counts=next;active.hashes[stream].update(bytes);active.output[stream]+=active.decoders[stream].decode(bytes,{stream:true});
  }else if(e.event==='job_finished'){
   const d=e.data;
   if(d.job_id!==active.value.job_id||!['ready','stopping','awaiting_control'].includes(e.session.phase)
    ||['running','cancelling','unknown'].includes(e.session.job.state)||!e.session.job.output_complete)return fail();
   for(const stream of ['stdout','stderr'])if(d[stream+'_sent_bytes']!==active.counts[stream]
    ||e.session.job[stream+'_bytes']!==active.counts[stream]||d[stream+'_sha256']!==active.hashes[stream].copy().digest('hex'))return fail();
   for(const stream of ['stdout','stderr'])active.output[stream]+=active.decoders[stream].decode();
   history.push({...active.value,state:e.session.job.state,stdout:active.output.stdout,stderr:active.output.stderr});
   // Only completed history may be evicted; current/unknown work is never dropped.
   while(history.length>8||Buffer.byteLength(JSON.stringify(history))>262144)history.shift();
   active=null;
  }else return fail();
  remember(e,m);return snapshot();
 }
 /** @param {any} next @param {number} previousGeneration */
 function retire(next,previousGeneration){
  if(staged||active||!gcValid('guest_command_session.schema.json',next)||next.phase!=='ready'||next.ownership!=='held'
   ||next.owner_id!==binding[0]||next.workload_id!==binding[1]||!integer(previousGeneration)
   ||previousGeneration<binding[2]||previousGeneration>=MAX||next.generation!==previousGeneration+1)return fail();
  binding=tuple(next,reservationId);jobsStarted=next.jobs_started;uncertain=false;return snapshot();
 }
 function lost(){uncertain=true;staged=null;if(active)active.state='unknown';return snapshot();}
 return Object.freeze({observe,receive,retire,lost,snapshot});
}
