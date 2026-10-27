// @ts-check
/** [TARGET, unit decision] Capture transport seam: a host binding supplies
 * request({op:'capture',method,request}) and optional subscribeCapture(callback).
 * Only metadata crosses this bridge; operational transport failure is unavailable.
 * hostBindings admits this operation over the frozen core transport.
 * Calls without a request (list/subscription) use an empty refusal request_id.
 * [TARGET, unit decision] export({schema:"capture_request/v1",request_id,
 * capture_id,destination:"recording:configured"|null}) returns metadata only.
 * Native bindings must dispatch export via record_request disk_start for the
 * sealed ID, with the main-only configured grant. Core inherits that setting.
 */
import { ContractError } from './preload.js';
export const CAPTURE_CHANNELS = Object.freeze({screenshot:'capture.screenshot',
  recordStart:'capture.record.start',recordStop:'capture.record.stop',export:'capture.export',list:'capture.list',
  subscribe:'capture.subscribe',unsubscribe:'capture.unsubscribe'});
const CAPTURE_CODES = new Set(['SURFACE_UNKNOWN','ALREADY_RECORDING','NOT_RECORDING',
  'CAPTURE_UNAVAILABLE','NESTED_DISPLAY_ONLY','LIMIT','DESTINATION_UNSET',
  'CAPTURE_UNKNOWN','NOT_SEALED','DESTINATION_UNAVAILABLE','DESTINATION_EXISTS']);
const CAPTURE_PHASES = new Set(['idle','starting','recording','stopping','sealed','error']);
/** @param {any} v @param {string} keys */
function captureKeys(v,keys) {
  return v !== null && typeof v==='object' && !Array.isArray(v)
    && Reflect.ownKeys(v).length===keys.split(',').length
    && Object.keys(v).sort().join(',')===keys
    && Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>'value' in d);
}
/** @param {any} v */
const captureId=(v)=>typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
/** @param {any} v */
const captureNumber=(v)=>Number.isSafeInteger(v) && v>=0;
/** @param {string} method @param {readonly unknown[]} args */
export function assertCaptureCall(method,args) {
  if (!Object.hasOwn(CAPTURE_CHANNELS,method)) throw new ContractError('CHANNEL','capture method');
  if (!Array.isArray(args) || args.length!==(['list','subscribe','unsubscribe'].includes(method)?0:1)) throw new ContractError('ARGS','capture arity');
  if (!args.length) return;
  const v=/** @type {any} */(args[0]);
  const keys=method==='export'?'capture_id,destination,request_id,schema':method==='recordStop'?'recording_id,request_id,schema':method==='recordStart'?'mode,request_id,schema,surface_id':'request_id,schema,surface_id';
  if (!captureKeys(v,keys) || v.schema!=='capture_request/v1'
    || typeof v.request_id!=='string' || !/^[\x20-\x7e]{1,64}$/.test(v.request_id)
    || !captureId(method==='export'?v.capture_id:method==='recordStop'?v.recording_id:v.surface_id)
    || (method==='export' && v.destination!==null && v.destination!=='recording:configured')
    || (method==='recordStart' && v.mode!=='ai')) throw new ContractError('PAYLOAD','capture request');
}
/** @param {string} method @param {any} v @param {string} [requestId] */
export function assertCaptureReply(method,v,requestId='') {
  const bad=()=>{throw new ContractError('OUTCOME','capture reply');};
  if (captureKeys(v,'code,ok,request_id') && v.ok===false && CAPTURE_CODES.has(v.code)
    && v.request_id===requestId) return Object.freeze({...v});
  if (!v || v.ok!==true) return bad();
  const row=(/** @type {any} */r)=>captureKeys(r,'created_ms,duration_ms,frames,id,kind,phase,sealed,surface_id')
    && captureId(r.id) && captureId(r.surface_id) && ['shot','recording'].includes(r.kind)
    && CAPTURE_PHASES.has(r.phase) && typeof r.sealed==='boolean'
    && ['frames','duration_ms','created_ms'].every(k=>captureNumber(r[k]));
  const digest=(/** @type {any} */x)=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
  if (method==='list' && captureKeys(v,'ok,rows') && Array.isArray(v.rows) && v.rows.length<=64 && v.rows.every(row)) return Object.freeze({ok:true,rows:Object.freeze(v.rows.map((/** @type {any} */r)=>Object.freeze({...r})))});
  if (method==='export' && captureKeys(v,'export,ok') && captureKeys(v.export,'bytes,id,sha256')
    && captureId(v.export.id) && captureNumber(v.export.bytes) && v.export.bytes>0
    && v.export.bytes<=16*1024*1024 && digest(v.export.sha256)) return Object.freeze({ok:true,export:Object.freeze({...v.export})});
  if (method==='recordStart' && captureKeys(v,'ok,recording_id') && captureId(v.recording_id)) return Object.freeze({...v});
  if (method==='screenshot' && captureKeys(v,'ok,shot') && captureKeys(v.shot,'created_ms,height,id,sha256,surface_id,width')) {
    const r=v.shot;
    if(captureId(r.id) && captureId(r.surface_id) && digest(r.sha256) && captureNumber(r.created_ms)
      && captureNumber(r.width) && r.width>0 && captureNumber(r.height) && r.height>0) return Object.freeze({ok:true,shot:Object.freeze({...r})});
  }
  if (method==='recordStop' && captureKeys(v,'ok,recording') && captureKeys(v.recording,'duration_ms,frames,id,sealed,sha256,surface_id')) {
    const r=v.recording;
    if(captureId(r.id) && captureId(r.surface_id) && digest(r.sha256) && r.sealed===true
      && captureNumber(r.frames) && captureNumber(r.duration_ms)) return Object.freeze({ok:true,recording:Object.freeze({...r})});
  }
  if (['subscribe','unsubscribe'].includes(method) && captureKeys(v,'ok')) return Object.freeze({ok:true});
  return bad();
}
/** @param {any} v */
export function validCaptureState(v) {
  return captureKeys(v,'elapsed_ms,frames,phase,recording_id,surface_id,type')
    && v.type==='capture.state' && captureId(v.recording_id) && captureId(v.surface_id)
    && CAPTURE_PHASES.has(v.phase) && captureNumber(v.frames) && captureNumber(v.elapsed_ms);
}

import { observeSender, PRIVILEGED_ORIGIN } from './main.js';
import { recordingDestination } from './authorityWire.js';

/** @param {any} core @param {string} method @param {any} request */
export async function requestCapture(core,method,request) {
  assertCaptureCall(method,request===undefined?[]:[request]);
  let result;
  try { result=await core.request({op:'capture',method,request}); }
  catch { return {ok:false,code:'CAPTURE_UNAVAILABLE',request_id:request?.request_id??''}; }
  return assertCaptureReply(method,result,request?.request_id??'');
}

/** @param {any} options */
export function installCaptureBridge({ipcMain,contents,core,nested=false,env=process.env}) {
  if(nested) return {async dispose(){}};
  // [TARGET, unit decision] Validate the same main-only grant as authorityWire.
  // Core inherits MV_RECORDING_DESTINATION; no path is supplied by the renderer.
  const destination=recordingDestination(env);
  let disposed=false,subscribed=false;
  /** @type {string[]} */ const installed=[];
  /** @type {()=>void} */ let revoke=()=>{};
  try {
    for(const [method,suffix] of Object.entries(CAPTURE_CHANNELS)) {
      const channel=`metaviewer:${suffix}`;
      ipcMain.handle(channel,async(/** @type {any} */event,/** @type {any[]} */...args)=>{
        if(disposed || observeSender(event,contents,PRIVILEGED_ORIGIN).verdict!=='admit') throw new ContractError('SENDER','capture sender');
        assertCaptureCall(method,args);
        if(nested) return {ok:false,code:'NESTED_DISPLAY_ONLY',request_id:args[0]?.request_id??''};
        if(method==='subscribe' || method==='unsubscribe') {
          subscribed=method==='subscribe';return {ok:true};
        }
        if(method==='export' && (destination===null || args[0].destination===null)) {
          return {ok:false,code:'DESTINATION_UNSET',request_id:args[0].request_id};
        }
        return requestCapture(core,method,args[0]);
      });
      installed.push(channel);
    }
    if(!nested && typeof core.subscribeCapture==='function') revoke=core.subscribeCapture((/** @type {any} */value)=>{
      if(!disposed && subscribed && validCaptureState(value)) contents.send('metaviewer:capture.state',{
        type:value.type,recording_id:value.recording_id,surface_id:value.surface_id,
        phase:value.phase,frames:value.frames,elapsed_ms:value.elapsed_ms,
      });
    });
  } catch(error) {
    for(const channel of installed) ipcMain.removeHandler?.(channel);
    revoke();throw error;
  }
  return {async dispose(){if(disposed)return;disposed=true;subscribed=false;revoke();
    for(const channel of installed)ipcMain.removeHandler?.(channel);
  }};
}
