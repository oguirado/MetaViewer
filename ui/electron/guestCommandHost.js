import {createHash,randomUUID} from 'node:crypto';
import {gcAction,gcValid} from './guestCommandValues.js';
/** One host actor for the authenticated guest-command stream. No native execution. */
/** @param {{send:(v:any)=>void,available:()=>boolean,ownerId:string,sessionId:string,timeoutMs?:number}} options */
export function createGuestCommandHost({send,available,ownerId,sessionId,timeoutMs=65000}) {
 /** @type {any} */ let session=null;
 /** @type {string|null} */ let code=null;
 /** @type {string|null} */ let createId=null;
 /** @type {string|null} */ let reservation=null;
 let revision=0,uncertain=false,consumed=false,closed=false,total=0;
 let stdout='',stderr='';
 let decoders={stdout:new TextDecoder(),stderr:new TextDecoder()},indices={stdout:0,stderr:0},counts={stdout:0,stderr:0},hashes={stdout:createHash('sha256'),stderr:createHash('sha256')};
 const pending=new Map(),seen=new Set(),listeners=new Set();
 const copy=(/** @type {any} */ v)=>structuredClone(v);
 const status=()=>copy({available:!closed&&available(),busy:pending.size>0,canCancel:[...pending.values()].some(p=>p.body.op==='run'&&p.accepted)&&![...pending.values()].some(p=>['cancel','stop'].includes(p.body.op))&&!uncertain&&!session?.controls?.cancel&&!session?.controls?.stop,code,revision,session,uncertain,stdout,stderr});
 const publish=()=>{revision++;const s=status();for(const f of listeners){try{f(copy(s));}catch{listeners.delete(f);}}return s;};
 const settle=(/** @type {any} */ p)=>{clearTimeout(p.timer);pending.delete(p.body.request_id);p.resolve(publish());};
 const lose=()=>{uncertain=true;code='OUTCOME_UNKNOWN';if(session?.ownership==='held'){session={...session,phase:'uncertain',job:session.job&&['running','cancelling'].includes(session.job.state)?{...session.job,state:'unknown'}:session.job};}const old=[...pending.values()];pending.clear();const snapshot=publish();for(const p of old){clearTimeout(p.timer);p.resolve(snapshot);}return snapshot;};
 const token=(/** @type {string} */ id)=>{const s=Buffer.from(sessionId),r=Buffer.from(id);const len=(/** @type {number} */ n)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};return 'reservation-'+createHash('sha256').update(Buffer.concat([Buffer.from('MetaViewer/guest-command/reservation/v1\0'),len(s.length),s,len(r.length),r])).digest('hex');};
 /** @param {any} action */
 async function request(action){
  if(!gcAction(action))throw Error('BAD_REQUEST');
  if(closed||!available()){code='UNAVAILABLE';return publish();}
  const op=action.op;
  if(op==='create' ? consumed : !session || session.ownership!=='held' || action.workload_id!==session.workload_id || action.generation!==session.generation){code='OUT_OF_ORDER';return publish();}
  if(op==='run'&&(uncertain||session.phase!=='ready'||pending.size)){code='BUSY';return publish();}
  if(op==='cancel'&&(!status().canCancel||action.job_id!==session.job?.job_id)){code='BUSY';return publish();}
  if(op==='stop'&&[...pending.values()].some(p=>p.body.op==='stop')){code='BUSY';return publish();}
  const id='request-'+randomUUID();
  const params=op==='create'?{profile_id:'guest-command-arm64-v1'}:{workload_id:session.workload_id,generation:session.generation,...(op==='run'?{job_id:'job-'+randomUUID(),command_utf8:action.command_utf8,cwd:action.cwd,stdin_b64:action.stdin_b64,timeout_ms:action.timeout_ms}:op==='cancel'?{job_id:action.job_id}:{})};
  const body={schema:'guest_command_request/v0.2',request_id:id,op,params};
  if(!gcValid('guest_command_request.schema.json',body))throw Error('BAD_REQUEST');
  if(op==='create'){consumed=true;createId=id;reservation=token(id);}
  if(op==='run'){stdout='';stderr='';total=0;decoders={stdout:new TextDecoder(),stderr:new TextDecoder()};indices={stdout:0,stderr:0};counts={stdout:0,stderr:0};hashes={stdout:createHash('sha256'),stderr:createHash('sha256')};}
  code=null;
  return new Promise(resolve=>{/** @type {any} */ const p={body,resolve,accepted:false,timer:/** @type {ReturnType<typeof setTimeout>|null} */(null)};pending.set(id,p);p.timer=setTimeout(()=>{if(pending.has(id))lose();},timeoutMs);publish();try{send(body);}catch{lose();}});
 }
 /** Incoming control records may only refer to this host's pending or observed intent.
  * @param {any} next @param {any} accepting */
 function controlWitnesses(next,accepting=null){
  return ['cancel','stop'].every(op=>{
   const control=next.controls[op];if(control===null)return true;
   const local=[...pending.values()].find(item=>item.body.op===op&&item.body.request_id===control.request_id);
   if(local)return control.ack===(local===accepting||local.accepted?'accepted':'pending');
   const old=session?.controls?.[op];return old?.request_id===control.request_id&&old.ack===control.ack;
  });
 }
 /** @param {any} event */
 function receive(event){
  if(!gcValid('guest_command_event.schema.json',event)||event.owner_id!==ownerId||event.reservation_id!==reservation||seen.has(event.event_id)||seen.size>=8192)throw Error('GUEST_COMMAND_PROTOCOL');
  const p=pending.get(event.request_id),s=event.session,kind=event.event;
  if(s&&(s.owner_id!==ownerId||session&&(s.workload_id!==session.workload_id||s.generation!==session.generation)))throw Error('GUEST_COMMAND_OWNER');
  // Create may fail before the core can provide a workload tuple. Keep the consumed intent.
  if(kind==='outcome_unknown'&&event.request_id===createId&&event.data.op==='create'&&s===null&&session===null&&(p?.body.op==='create'||uncertain)){seen.add(event.event_id);lose();return;}
  // An idle native failure is a resource update on the original create, not a rewritten job.
  const idle=kind==='outcome_unknown'&&event.request_id===createId&&event.data.op==='create'&&session?.ownership==='held';
  if(!p&&!idle){if(uncertain&&event.request_id===createId&&s){session=copy(s);publish();return;}throw Error('GUEST_COMMAND_CORRELATION');}
  if(kind==='refused'){
   if(!p||p.accepted||event.data.op!==p.body.op)throw Error('GUEST_COMMAND_ORDER');
   if(s!==null)session=copy(s);
   seen.add(event.event_id);code=event.data.code;settle(p);return;
  }
  if(!s)throw Error('GUEST_COMMAND_SESSION');
  if(p?.body.op==='run'&&s.job?.job_id!==p.body.params.job_id)throw Error('GUEST_COMMAND_JOB');
  if(uncertain&&kind!=='outcome_unknown'&&p?.body.op!=='stop'){session=copy(s);publish();return;}
  if(kind==='accepted'){
   if(!p||p.accepted||event.data.op!==p.body.op)throw Error('GUEST_COMMAND_ORDER');
   const expected=/** @type {Record<string,string>} */({create:'starting',run:'running',cancel:'cancelling',stop:'stopping'})[p.body.op];
   let projected=expected;
   if(p.body.op==='run'&&s.controls.stop!==null)projected='stopping';
   if(p.body.op==='cancel'&&s.controls.stop!==null)projected='stopping';
   if(p.body.op==='stop'&&![...pending.values()].some(item=>item.body.op==='run')&&s.controls.cancel?.ack==='pending')projected='awaiting_control';
   if(s.phase!==projected||(projected!==expected&&!controlWitnesses(s,p)))throw Error('GUEST_COMMAND_ORDER');
   if(p.body.op==='cancel'&&(s.job?.job_id!==p.body.params.job_id||s.controls.cancel?.request_id!==p.body.request_id||s.controls.cancel.ack!=='accepted'))throw Error('GUEST_COMMAND_JOB');
   if(p.body.op==='stop'&&(s.controls.stop?.request_id!==p.body.request_id||s.controls.stop.ack!=='accepted'))throw Error('GUEST_COMMAND_ORDER');
   p.accepted=true;
  }else if(kind==='outcome_unknown'){
   if(p&&event.data.op!==p.body.op||s.phase!=='uncertain'||s.ownership!=='held')throw Error('GUEST_COMMAND_ORDER');
   session=copy(s);seen.add(event.event_id);lose();return;
  }else if(kind==='output'){
   if(!p||p.body.op!=='run'||!p.accepted||event.data.job_id!==p.body.params.job_id)throw Error('GUEST_COMMAND_ORDER');
   const bytes=Buffer.from(event.data.data_b64,'base64');
   if(bytes.toString('base64')!==event.data.data_b64||bytes.length<1||bytes.length>16384||(total+=bytes.length)>65536)throw Error('GUEST_COMMAND_OUTPUT');
   const stream=/** @type {'stdout'|'stderr'} */(event.data.stream);if(event.data.chunk_index!==indices[stream]++||!['running','cancelling','stopping'].includes(s.phase))throw Error('GUEST_COMMAND_OUTPUT');counts[stream]+=bytes.length;hashes[stream].update(bytes);if(s.job?.stdout_bytes!==counts.stdout||s.job?.stderr_bytes!==counts.stderr)throw Error('GUEST_COMMAND_OUTPUT');
   if(stream==='stdout')stdout+=decoders.stdout.decode(bytes,{stream:true});else stderr+=decoders.stderr.decode(bytes,{stream:true});
  }else if(!p||!p.accepted||!(/** @type {Record<string,string>} */({create:'ready',run:'job_finished',cancel:'refused',stop:'stopped'})[p.body.op]===kind))throw Error('GUEST_COMMAND_ORDER');
  if(kind==='ready'&&(s.job!==null||!controlWitnesses(s)||s.phase!==(['cancel','stop'].some(op=>s.controls[op]?.ack==='pending')?'awaiting_control':s.controls.stop!==null?'stopping':'ready'))||kind==='stopped'&&(s.phase!=='stopped'||s.ownership!=='released'))throw Error('GUEST_COMMAND_ORDER');
  if(kind==='job_finished'){if(!['ready','stopping','awaiting_control'].includes(s.phase)||!s.job||['running','cancelling','unknown'].includes(s.job.state)||event.data.stdout_sent_bytes!==counts.stdout||event.data.stderr_sent_bytes!==counts.stderr||event.data.stdout_sha256!==hashes.stdout.copy().digest('hex')||event.data.stderr_sha256!==hashes.stderr.copy().digest('hex'))throw Error('GUEST_COMMAND_OUTPUT');stdout+=decoders.stdout.decode();stderr+=decoders.stderr.decode();}
  session=copy(s);seen.add(event.event_id);
  if(p&&['ready','job_finished','stopped'].includes(kind)){if(kind==='stopped')uncertain=false;settle(p);}else if(p?.body.op==='cancel'&&kind==='accepted')settle(p);else publish();
 }
 return Object.freeze({status,request,receive,disconnect(){closed=true;lose();},subscribe(/** @type {(s:any)=>void} */ cb){listeners.add(cb);cb(status());return()=>listeners.delete(cb);}});
}
