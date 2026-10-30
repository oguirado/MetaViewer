/**
 * MetaViewer bootstrap preload facade (sandbox-loadable).
 * [TARGET, unit decision] Snapshot trusted native lazy exports at the CJS
 * entry; retain accessor rejection for injected installPreload dependencies.
 * [TARGET, unit decision] Bound per-surface input queues to 64 entries and
 * evict unknown/unadmitted surface IDs on SURFACE_UNKNOWN refusal.
 * [TARGET, unit decision] Expose metaviewer.frames.reportDiag({rehashSkipped, rehashDone})
 * with closed two-integer validation and optional rehash counters on frame_diag_preload/v1.
 *
 * A closed two-method facade over injected transport/bridge handles for the
 * starter layout only: the renderer receives narrow load/save domain methods
 * and no invoke, channel, path or handle capability. Every ingress argument
 * is shaped fail-fast (exact arity, string type, UTF-8 byte cap) and every
 * channel is refused outside the fixed set at the native boundary, before
 * the underlying invoke runs. Shaping only; the main side re-validates every
 * field and owns persistence routing, so preload never authorizes.
 *
 * Single-file layout: factory, guards and the guarded entry below live here
 * so the bundle stays one file with no relative loads. The entry installs
 * only when loaded as bundled CommonJS; importing this ESM source (tests,
 * typecheck) never installs and never touches the electron module.
 */

/**
 * @typedef {object} MetaViewerFacade Narrow renderer API.
 * @property {() => Promise<string|null>} loadSettings
 * @property {(json:string) => Promise<true>} saveSettings
 * @property {() => Promise<string|null>} recordingDestination
 * @property {() => Promise<0|1|null>} nestedDepth
 * @property {() => Promise<string|null>} selfCapsuleId
 * @property {{propose:(json:string)=>Promise<any>,intent:(json:string)=>Promise<true>,subscribeFrames:(cb:(frame:any)=>void)=>(()=>void)}} authority
 * @property {{send:(batch:any)=>Promise<{ok:true,accepted:number}|{ok:false,code:string}>,onResult:(cb:(result:{surface_id:string,seq:number,ok:boolean,code:string|null})=>void)=>(()=>void)}} input
 * @property {{screenshot:(req:any)=>Promise<any>,recordStart:(req:any)=>Promise<any>,recordStop:(req:any)=>Promise<any>,export:(req:any)=>Promise<any>,list:()=>Promise<any>,subscribe:(cb:(state:any)=>void)=>(()=>void)}} capture
 * @property {{reportDiag:(diag:{rehashSkipped:number,rehashDone:number})=>Promise<true>}} frames
 * @property {{open:(spec:any)=>Promise<{session:string}>,setEnabled:(value:boolean)=>Promise<true>}} sideTerminal
 * @property {{reportAnchors:(snapshot:any)=>Promise<true>}} [qa]
 * @property {() => Promise<string|null>} load Read the stored layout text,
 * or null when no profile exists.
 * @property {(json: unknown) => Promise<true>} save Store layout text after
 * the host acknowledges.
 */

/**
 * @typedef {object} PreloadTransport Injected main-side invoke handle.
 * @property {(channel: string, args: ReadonlyArray<unknown>) => Promise<unknown>} invoke
 * Fixed-channel invoke returning the main outcome.
 * @property {boolean} [nested]
 * @property {boolean} [qa]
 * @property {boolean} [frameDiag]
 * @property {(channel:string,cb:(message:any,ports?:MessagePort[])=>void)=>(()=>void)} [subscribe]
 */

/**
 * @typedef {object} PreloadBridge Injected exposure handle.
 * @property {(name: string, api: MetaViewerFacade) => void} exposeInMainWorld
 * Expose the frozen facade under the fixed name.
 */

/** Fixed exposure name in the renderer main world. */
export const FACADE_NAME = 'metaviewer';

/**
 * Fixed channels behind the two facade methods. Mirrored by the main side,
 * which duplicates these literals instead of loading this file.
 * @type {Readonly<{ load: string, save: string }>}
 */
export const CHANNELS = Object.freeze({
  load: 'metaviewer:layout.load',
  save: 'metaviewer:layout.save',
});

/**
 * Fixed preload method names. No other method may be exposed.
 * @type {ReadonlyArray<string>}
 */
export const PRELOAD_METHODS = Object.freeze(['load', 'save']);

/**
 * Frozen IPC bounds. Layout text is capped in UTF-8 bytes, checked on
 * ingress and on string replies; multibyte input must fail even when its
 * character count looks acceptable.
 * @type {Readonly<{ maxLayoutBytes: number }>}
 */
export const IPC_BOUNDS = Object.freeze({ maxLayoutBytes: 256 * 1024 });

/** Private allowlist; exports stay frozen literals so no consumer can widen it. */
const CHANNEL_SET = new Set(Object.values(CHANNELS));
const PRIVILEGED_ORIGIN = 'app://metaviewer';

/**
 * Coded preload failure. Local codes (DEPS, CHANNEL, ARGS, PAYLOAD, OUTCOME)
 * are distinct from core refusal reasons.
 */
export class ContractError extends Error {
  /**
   * @param {string} code Diagnostic code.
   * @param {string} message Human-readable detail.
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ContractError';
    /** Diagnostic code. @type {string} @readonly */
    this.code = code;
  }
}

/**
 * Count UTF-8 bytes without host text utilities, so the guard runs inside
 * the sandboxed preload. Lone surrogates count as the replacement
 * character, matching the platform encoder.
 * @param {string} value Text to measure.
 * @returns {number} UTF-8 byte length.
 */
function utf8Bytes(value) {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Admit a layout string: exact type plus the UTF-8 byte cap.
 * @param {unknown} value Alleged layout text.
 * @param {string} what Value label for diagnostics.
 * @returns {string} The admitted text.
 */
function assertLayoutString(value, what) {
  if (typeof value !== 'string') {
    throw new ContractError('PAYLOAD', `${what} must be a string`);
  }
  if (utf8Bytes(value) > IPC_BOUNDS.maxLayoutBytes) {
    throw new ContractError('PAYLOAD', `${what} exceeds the UTF-8 byte cap`);
  }
  return value;
}

/**
 * Require a callable data property, walking the prototype chain. Accessor
 * properties are refused so a getter cannot smuggle a handle past validation.
 * @param {unknown} holder Alleged holder object.
 * @param {string} name Property name.
 * @param {string} label Diagnostic label.
 * @returns {void}
 */
function assertCallableMethod(holder, name, label) {
  let cursor = holder;
  while (cursor !== null && (typeof cursor === 'object' || typeof cursor === 'function')) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor !== undefined) {
      if ('value' in descriptor && typeof descriptor.value === 'function') {
        return;
      }
      throw new ContractError('DEPS', `${label} must be a function`);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new ContractError('DEPS', `${label} must be a function`);
}

/**
 * Validate injected handles: own-data {transport, bridge} exactly, no symbol
 * keys, no accessor tricks, callable methods. Callers keep method-call form
 * so receiver binding is preserved.
 * @param {unknown} deps Alleged handles.
 * @returns {{ transport: PreloadTransport, bridge: PreloadBridge }} The handles.
 */
function assertDeps(deps) {
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new ContractError('DEPS', 'deps must be an object');
  }
  if (Object.getOwnPropertySymbols(deps).length !== 0) {
    throw new ContractError('DEPS', 'deps must not carry symbol keys');
  }
  const keys = Object.keys(deps).sort();
  if (keys.join(',') !== 'bridge,transport') {
    throw new ContractError('DEPS', 'deps must be exactly {transport, bridge}');
  }
  for (const key of ['transport', 'bridge']) {
    const descriptor = Object.getOwnPropertyDescriptor(deps, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ContractError('DEPS', `deps.${key} must be a data property`);
    }
  }
  const holders = /** @type {Record<string, unknown>} */ (deps);
  const transport = holders.transport;
  const bridge = holders.bridge;
  if (transport === null || (typeof transport !== 'object' && typeof transport !== 'function')) {
    throw new ContractError('DEPS', 'transport must be an object');
  }
  if (bridge === null || (typeof bridge !== 'object' && typeof bridge !== 'function')) {
    throw new ContractError('DEPS', 'bridge must be an object');
  }
  assertCallableMethod(transport, 'invoke', 'transport.invoke');
  assertCallableMethod(bridge, 'exposeInMainWorld', 'bridge.exposeInMainWorld');
  return /** @type {{ transport: PreloadTransport, bridge: PreloadBridge }} */ ({ transport, bridge });
}

/**
 * Admit one fixed call: channel membership, array form, per-method arity and
 * the matching string shape. Returns a fresh frozen vector, never the
 * caller array. Both facade methods and the native adapter pass this check.
 * @param {unknown} channel Alleged channel.
 * @param {unknown} args Alleged argument vector.
 * @returns {{ channel: string, args: ReadonlyArray<unknown> }} The admitted call.
 */
export function assertFixedCall(channel, args) {
  if (typeof channel !== 'string' || !CHANNEL_SET.has(channel)) {
    throw new ContractError('CHANNEL', 'channel outside the fixed preload set');
  }
  if (!Array.isArray(args)) {
    throw new ContractError('ARGS', 'invoke args must be an array');
  }
  if (channel === CHANNELS.load) {
    if (args.length !== 0) {
      throw new ContractError('ARGS', 'load takes no arguments');
    }
    return { channel, args: Object.freeze([]) };
  }
  if (args.length !== 1) {
    throw new ContractError('ARGS', 'save takes exactly one argument');
  }
  const admitted = assertLayoutString(args[0], 'save payload');
  return { channel, args: Object.freeze([admitted]) };
}

/**
 * Admit a load outcome: null means a genuinely absent profile; any other
 * non-string, oversize string or transport failure stays a rejection.
 * @param {unknown} reply Main outcome.
 * @returns {string|null} The admitted layout text or null.
 */
function assertLoadReply(reply) {
  if (reply === null) {
    return null;
  }
  if (typeof reply !== 'string') {
    throw new ContractError('OUTCOME', 'load reply must be a bounded string or null');
  }
  if (utf8Bytes(reply) > IPC_BOUNDS.maxLayoutBytes) {
    throw new ContractError('OUTCOME', 'load reply exceeds the UTF-8 byte cap');
  }
  return reply;
}

/**
 * Admit a save outcome: only the literal true acknowledges.
 * @param {unknown} reply Main outcome.
 * @returns {true} The acknowledgement.
 */
function assertSaveReply(reply) {
  if (reply !== true) {
    throw new ContractError('OUTCOME', 'save reply must be the literal true');
  }
  return true;
}

/**
 * Create the narrow facade and expose it once under the fixed name.
 * @param {unknown} deps Injected transport/bridge handles.
 * @returns {MetaViewerFacade} The frozen exposed API.
 */
export function createPreloadFacade(deps) {
  const { transport, bridge } = assertDeps(deps);
  /** @type {MetaViewerFacade} */
  const api = /** @type {MetaViewerFacade} */ ({
    /**
     * @param {...unknown} args Must be empty; any argument is refused.
     * @returns {Promise<string|null>} Stored layout text or null.
     */
    load: (...args) => {
      const call = assertFixedCall(CHANNELS.load, args);
      return transport.invoke(call.channel, call.args).then(assertLoadReply);
    },
    /**
     * @param {...unknown} args Exactly one bounded layout string.
     * @returns {Promise<true>} Host acknowledgement.
     */
    save: (...args) => {
      const call = assertFixedCall(CHANNELS.save, args);
      return transport.invoke(call.channel, call.args).then(assertSaveReply);
    },
  });
  // [TARGET, unit decision] Retain the enumerable legacy layout inventory;
  // domain additions are own, immutable properties. Native transports supporting
  // subscriptions enumerate them so contextBridge copies the complete facade.
  Object.defineProperties(api, Object.fromEntries(Object.entries(wireFacade(transport))
    .map(([name,value]) => [name,{value,enumerable:name === 'qa' || typeof transport.subscribe === 'function'}])));
  const frozen = /** @type {MetaViewerFacade} */ (Object.freeze(api));
  bridge.exposeInMainWorld(FACADE_NAME, frozen);
  return frozen;
}

// [TARGET, unit decision] Capture metadata exposes no host paths or pixel bytes.
const CAPTURE_CHANNELS = Object.freeze({screenshot:'capture.screenshot',
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
function assertCaptureCall(method,args) {
  if (!Object.hasOwn(CAPTURE_CHANNELS,method)) throw new ContractError('CHANNEL','capture method');
  if (!Array.isArray(args) || args.length!==(['list','subscribe','unsubscribe'].includes(method)?0:1)) throw new ContractError('ARGS','capture arity');
  if (!args.length) return;
  const v=/** @type {any} */(args[0]);
  const keys=method==='export'?'capture_id,destination,request_id,schema':method==='recordStop'?'recording_id,request_id,schema':method==='recordStart'?'mode,request_id,schema,surface_id':'request_id,schema,surface_id';
  const keysWithFps=method==='export'?'capture_id,destination,max_fps,request_id,schema':method==='recordStart'?'max_fps,mode,request_id,schema,surface_id':null;
  const hasFps=keysWithFps!==null && captureKeys(v,keysWithFps);
  if ((!captureKeys(v,keys) && !hasFps) || v.schema!=='capture_request/v1'
    || typeof v.request_id!=='string' || !/^[\x20-\x7e]{1,64}$/.test(v.request_id)
    || !captureId(method==='export'?v.capture_id:method==='recordStop'?v.recording_id:v.surface_id)
    || (method==='export' && v.destination!==null && v.destination!=='recording:configured')
    || (method==='recordStart' && v.mode!=='ai')
    || (hasFps && (!Number.isSafeInteger(v.max_fps) || v.max_fps<1 || v.max_fps>60))) throw new ContractError('PAYLOAD','capture request');
}
/** @param {string} method @param {any} v @param {string} [requestId] */
function assertCaptureReply(method,v,requestId='') {
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
function validCaptureState(v) {
  return captureKeys(v,'elapsed_ms,frames,phase,recording_id,surface_id,type')
    && v.type==='capture.state' && captureId(v.recording_id) && captureId(v.surface_id)
    && CAPTURE_PHASES.has(v.phase) && captureNumber(v.frames) && captureNumber(v.elapsed_ms);
}
/** @param {PreloadTransport} transport @param {Set<(value:any)=>void>} [captureCallbacks] @param {Set<string>} [seededCaptureSurfaces] */
function captureFacade(transport, captureCallbacks = new Set(), seededCaptureSurfaces = new Set()) {
  /** @param {string} name @param {unknown[]} args */
  const call=(name,args)=>{
    assertCaptureCall(name,args);
    const requestId=/** @type {any} */(args[0])?.request_id??'';
    if (transport.nested) return Promise.resolve(Object.freeze({ok:false,code:'NESTED_DISPLAY_ONLY',request_id:requestId}));
    return transport.invoke(`metaviewer:${CAPTURE_CHANNELS[/** @type {keyof typeof CAPTURE_CHANNELS} */(name)]}`,args)
      .then(reply=>assertCaptureReply(name,reply,requestId));
  };
  /** @type {Map<symbol,()=>void>} */ const subscriptions=new Map();
  return Object.freeze({
    /** @param {...unknown} args */ screenshot:(...args)=>call('screenshot',args),
    /** @param {...unknown} args */ recordStart:(...args)=>call('recordStart',args),
    /** @param {...unknown} args */ recordStop:(...args)=>call('recordStop',args),
    /** @param {...unknown} args */ export:(...args)=>call('export',args),
    /** @param {...unknown} args */ list:(...args)=>call('list',args),
    /** @param {...unknown} args */ subscribe:(...args)=>{
      if(args.length!==1 || typeof args[0]!=='function' || (!transport.nested && !transport.subscribe)) throw new ContractError('ARGS','capture callback');
      // Preserve the callable unsubscribe API; awaiting it yields the local refusal.
      if(transport.nested) return Object.assign(()=>{}, {then:(/** @type {any} */resolve)=>Promise.resolve({ok:false,code:'NESTED_DISPLAY_ONLY',request_id:''}).then(resolve)});
      if(subscriptions.size>=64) throw new ContractError('LIMIT','capture subscription cap');
      const cb=/** @type {(value:any)=>void} */(args[0]);
      const token=Symbol();
      let revoked=false;
      const deliver=(/** @type {any} */frozen)=>{
        if(revoked || !subscriptions.has(token)) return;
        cb(frozen);
      };
      const revoke=transport.subscribe?.('metaviewer:capture.state',value=>{
        if(revoked || !subscriptions.has(token)) return;
        if(validCaptureState(value)) deliver(Object.freeze({...value}));
      });
      subscriptions.set(token,()=>{revoked=true;captureCallbacks.delete(deliver);revoke?.();});
      captureCallbacks.add(deliver);
      if (typeof document!=='undefined' && typeof document?.getElementById==='function' && document.getElementById('metaviewer-app')!==null) {
        for (const sid of seededCaptureSurfaces) {
          try { deliver(Object.freeze({type:'capture.state',recording_id:'idle',surface_id:sid,phase:'idle',frames:0,elapsed_ms:0})); } catch {}
        }
      }
      void call('subscribe',[]).catch(()=>{subscriptions.get(token)?.();subscriptions.delete(token);});
      return ()=>{const stop=subscriptions.get(token);if(!stop)return;subscriptions.delete(token);stop();
        if(!subscriptions.size)void call('unsubscribe',[]).catch(()=>{});};
    },
  });
}

// [TARGET, unit decision] Closed domain channels; all values are rechecked in main.
const QA_ANCHORS_CHANNEL = 'metaviewer:qa.anchors';
const FRAME_DIAG_CHANNEL = 'metaviewer:frame.diag';
const FRAME_REPORT_DIAG_CHANNEL = 'metaviewer:frames.reportDiag';
const SURFACE_INPUT_CHANNEL = 'metaviewer:authority.intent';
const QA_ANCHOR_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const QA_ANCHOR_RE = /^(?=.{1,200}$)[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}){0,5}$/;
const QA_ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** @param {unknown} v @returns {v is string} */
function qaAnchorId(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 200 || !QA_ANCHOR_RE.test(v)) return false;
  const parts = v.split('/');
  return parts.length >= 1 && parts.length <= 6
    && parts.every((seg) => seg.length >= 1 && seg.length <= 64 && seg !== '.' && seg !== '..' && QA_ANCHOR_SEGMENT_RE.test(seg));
}
/** @param {string} text */
function isWellFormedName(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = text.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) i += 1;
      else return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
/** @param {readonly unknown[]} args */
function assertQaSnapshot(args) {
  if (!Array.isArray(args) || args.length !== 1) throw new ContractError('ARGS','qa.reportAnchors arity');
  const v = /** @type {any} */(args[0]);
  if (!captureKeys(v,'rows,schema,seq')
    || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
    || v.schema !== 'qa_anchors/v1'
    || !Number.isSafeInteger(v.seq) || v.seq < 1
    || !Array.isArray(v.rows) || Object.getPrototypeOf(v.rows) !== Array.prototype
    || v.rows.length > 512 || Reflect.ownKeys(v.rows).length !== v.rows.length + 1) {
    throw new ContractError('PAYLOAD','qa snapshot shape');
  }
  const rows = [];
  for (let i = 0; i < v.rows.length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(v.rows, i);
    if (!desc || !('value' in desc)) throw new ContractError('PAYLOAD','qa row descriptor');
    const r = desc.value;
    if (!captureKeys(r,'anchor,name,rect,role')
      || (Object.getPrototypeOf(r) !== Object.prototype && Object.getPrototypeOf(r) !== null)
      || !qaAnchorId(r.anchor)
      || typeof r.role !== 'string' || !QA_ROLE_RE.test(r.role)
      || typeof r.name !== 'string' || r.name.length > 128 || r.name.includes('\0') || !isWellFormedName(r.name)
      || !captureKeys(r.rect,'h,w,x,y')
      || (Object.getPrototypeOf(r.rect) !== Object.prototype && Object.getPrototypeOf(r.rect) !== null)
      || !Number.isSafeInteger(r.rect.x) || !Number.isSafeInteger(r.rect.y)
      || !Number.isSafeInteger(r.rect.w) || r.rect.w <= 0
      || !Number.isSafeInteger(r.rect.h) || r.rect.h <= 0) {
      throw new ContractError('PAYLOAD','qa row shape');
    }
    rows.push(Object.freeze({
      anchor: r.anchor,
      role: r.role,
      name: r.name,
      rect: Object.freeze({ x: r.rect.x, y: r.rect.y, w: r.rect.w, h: r.rect.h }),
    }));
  }
  const normalized = Object.freeze({ schema: 'qa_anchors/v1', seq: v.seq, rows: Object.freeze(rows) });
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined || utf8Bytes(encoded) > 64 * 1024) throw new ContractError('PAYLOAD','qa snapshot byte cap');
  return normalized;
}
/** @param {readonly unknown[]} args */
function assertFrameReportDiag(args) {
  if (!Array.isArray(args) || args.length !== 1) throw new ContractError('ARGS','frames.reportDiag arity');
  const v = /** @type {any} */(args[0]);
  if (!captureKeys(v, 'rehashDone,rehashSkipped')
    || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
    || !captureNumber(v.rehashSkipped)
    || !captureNumber(v.rehashDone)) {
    throw new ContractError('PAYLOAD','frames.reportDiag payload shape');
  }
  return Object.freeze({ rehashSkipped: v.rehashSkipped, rehashDone: v.rehashDone });
}
/** @param {readonly unknown[]} args */
function assertFrameDiagPreload(args) {
  if (!Array.isArray(args) || args.length !== 1) throw new ContractError('ARGS','frame.diag arity');
  const v = /** @type {any} */(args[0]);
  if (v === null || typeof v !== 'object' || Array.isArray(v)
    || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
    || Reflect.ownKeys(v).length !== Object.keys(v).length
    || !Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d)) {
    throw new ContractError('PAYLOAD','frame.diag payload shape');
  }
  const baseKeys = Object.keys(v).filter(k => k !== 'rehashSkipped' && k !== 'rehashDone').sort().join(',');
  const keys = 'domStripText,domSurfaceState,domWaitingText,framesReceived,inWallApp,invalidNotices,lastFrameGeneration,lastSurfaceGeneration,lastSurfaceId,legacyNoticesForwarded,noticesForwarded,origin,portsClosed,portsReceived,schema';
  const prevKeys = 'domStripText,domSurfaceState,domWaitingText,framesReceived,inWallApp,invalidNotices,lastSurfaceGeneration,lastSurfaceId,legacyNoticesForwarded,noticesForwarded,origin,portsClosed,portsReceived,schema';
  const legacyKeys = 'framesReceived,inWallApp,invalidNotices,lastSurfaceGeneration,lastSurfaceId,legacyNoticesForwarded,noticesForwarded,origin,portsClosed,portsReceived,schema';
  if ((baseKeys !== keys && baseKeys !== prevKeys && baseKeys !== legacyKeys)
    || v.schema !== 'frame_diag_preload/v1'
    || !['framesReceived','invalidNotices','portsReceived','noticesForwarded','legacyNoticesForwarded','portsClosed'].every(k => captureNumber(v[k]))
    || (v.rehashSkipped !== undefined && !captureNumber(v.rehashSkipped))
    || (v.rehashDone !== undefined && !captureNumber(v.rehashDone))
    || (v.inWallApp !== null && typeof v.inWallApp !== 'boolean')
    || typeof v.origin !== 'string' || v.origin.length > 256 || v.origin.includes('\0')
    || (v.lastSurfaceId !== null && !captureId(v.lastSurfaceId))
    || (v.lastSurfaceGeneration !== null && (!Number.isSafeInteger(v.lastSurfaceGeneration) || v.lastSurfaceGeneration < 1))
    || (v.lastFrameGeneration !== undefined && v.lastFrameGeneration !== null && (!Number.isSafeInteger(v.lastFrameGeneration) || v.lastFrameGeneration < 1))
    || !['domSurfaceState','domWaitingText','domStripText'].every(k => v[k] === undefined || v[k] === null || (typeof v[k] === 'string' && v[k].length <= 512 && !v[k].includes('\0')))) {
    throw new ContractError('PAYLOAD','frame.diag payload shape');
  }
  return Object.freeze({ ...v });
}
const HUMAN_KEY_TOKEN_RE = /^[A-Za-z0-9_+]{1,32}$/;
const INPUT_REFUSAL_CODES = new Set([
  'NOT_IN_CONTROL',
  'SURFACE_UNKNOWN',
  'STALE_STREAM',
  'LIMIT',
  'NESTED_DISPLAY_ONLY',
  'SCHEMA',
  'CORE_UNAVAILABLE',
]);
const SURFACE_INPUT_MAX_EVENTS = 32;
const SURFACE_INPUT_MAX_BYTES = 16 * 1024;
const SURFACE_INPUT_MAX_TEXT = 1024;
const SURFACE_INPUT_MAX_QUEUE_EVENTS = 256;
const SURFACE_INPUT_TYPE_COALESCE_MS = 20;
const SURFACE_INPUT_MAX_SURFACES = 64;
/** @param {unknown} raw @returns {{ok:true,batch:any}|{ok:false,code:'SCHEMA'|'LIMIT'}} */
function validateSurfaceInputBatch(raw) {
  if (!captureKeys(raw, 'events,schema,seq,stream_id,surface_id')
      || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) {
    return { ok: false, code: 'SCHEMA' };
  }
  const rec = /** @type {Record<string, any>} */ (raw);
  if ((rec.schema !== 'surface_input/v1' && rec.schema !== 'surface_input/v0.2')
      || !captureId(rec.surface_id)
      || !Number.isSafeInteger(rec.stream_id) || rec.stream_id < 0
      || !Number.isSafeInteger(rec.seq) || rec.seq < 1
      || !Array.isArray(rec.events) || Object.getPrototypeOf(rec.events) !== Array.prototype
      || rec.events.length < 1 || Reflect.ownKeys(rec.events).length !== rec.events.length + 1) {
    return { ok: false, code: 'SCHEMA' };
  }
  const inspectCount = Math.min(rec.events.length, 256);
  const events = [];
  let hasOverlongTypeText = false;
  for (let i = 0; i < inspectCount; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(rec.events, i);
    if (!desc || !('value' in desc)) return { ok: false, code: 'SCHEMA' };
    const ev = desc.value;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)
        || (Object.getPrototypeOf(ev) !== Object.prototype && Object.getPrototypeOf(ev) !== null)) {
      return { ok: false, code: 'SCHEMA' };
    }
    if (ev.kind === 'click') {
      if (!captureKeys(ev, 'button,kind,x,y')
          || !Number.isSafeInteger(ev.x) || ev.x < 0 || ev.x > 65535
          || !Number.isSafeInteger(ev.y) || ev.y < 0 || ev.y > 65535
          || !['left', 'middle', 'right'].includes(ev.button)) {
        return { ok: false, code: 'SCHEMA' };
      }
      events.push(Object.freeze({ kind: 'click', x: ev.x, y: ev.y, button: ev.button }));
    } else if (ev.kind === 'key') {
      if (!captureKeys(ev, 'keys,kind')
          || !Array.isArray(ev.keys) || Object.getPrototypeOf(ev.keys) !== Array.prototype
          || ev.keys.length < 1 || ev.keys.length > 8
          || Reflect.ownKeys(ev.keys).length !== ev.keys.length + 1) {
        return { ok: false, code: 'SCHEMA' };
      }
      const maxTokenLen = ev.keys.length === 1 ? 32 : ev.keys.length === 2 ? 15 : ev.keys.length <= 4 ? 7 : 3;
      const keys = [];
      for (let j = 0; j < ev.keys.length; j += 1) {
        const kDesc = Object.getOwnPropertyDescriptor(ev.keys, j);
        if (!kDesc || !('value' in kDesc) || typeof kDesc.value !== 'string'
            || kDesc.value.length > maxTokenLen || !HUMAN_KEY_TOKEN_RE.test(kDesc.value)) {
          return { ok: false, code: 'SCHEMA' };
        }
        keys.push(kDesc.value);
      }
      const chord = keys.join('+');
      if (chord.length < 1 || chord.length > 32 || !HUMAN_KEY_TOKEN_RE.test(chord)) {
        return { ok: false, code: 'SCHEMA' };
      }
      events.push(Object.freeze({ kind: 'key', keys: Object.freeze(keys) }));
    } else if (ev.kind === 'type') {
      if (!captureKeys(ev, 'kind,text')
          || typeof ev.text !== 'string' || ev.text.length < 1
          || ev.text.includes('\0') || !isWellFormedName(ev.text)) {
        return { ok: false, code: 'SCHEMA' };
      }
      if (Array.from(ev.text).length > 1024) hasOverlongTypeText = true;
      events.push(Object.freeze({ kind: 'type', text: ev.text }));
    } else if (ev.kind === 'scroll') {
      if (!captureKeys(ev, 'dx,dy,kind,x,y')
          || !Number.isSafeInteger(ev.dx) || ev.dx < -2147483648 || ev.dx > 2147483647
          || !Number.isSafeInteger(ev.dy) || ev.dy < -2147483648 || ev.dy > 2147483647
          || !Number.isSafeInteger(ev.x) || ev.x < 0 || ev.x > 65535
          || !Number.isSafeInteger(ev.y) || ev.y < 0 || ev.y > 65535) {
        return { ok: false, code: 'SCHEMA' };
      }
      events.push(Object.freeze({ kind: 'scroll', dx: ev.dx, dy: ev.dy, x: ev.x, y: ev.y }));
    } else {
      return { ok: false, code: 'SCHEMA' };
    }
  }
  if (rec.events.length > SURFACE_INPUT_MAX_EVENTS) {
    return { ok: false, code: 'LIMIT' };
  }
  const batch = Object.freeze({
    schema: rec.schema,
    surface_id: rec.surface_id,
    stream_id: rec.stream_id,
    seq: rec.seq,
    events: Object.freeze(events),
  });
  const encoded = JSON.stringify(batch);
  if (encoded === undefined || utf8Bytes(encoded) > SURFACE_INPUT_MAX_BYTES) {
    return { ok: false, code: 'LIMIT' };
  }
  if (hasOverlongTypeText) {
    return { ok: false, code: 'SCHEMA' };
  }
  return { ok: true, batch };
}
/** @param {any} reply @param {number} maxAccepted */
function assertSurfaceInputReply(reply, maxAccepted) {
  if (captureKeys(reply, 'accepted,ok') && reply.ok === true
      && Number.isSafeInteger(reply.accepted) && reply.accepted >= 1 && reply.accepted <= maxAccepted) {
    return Object.freeze({ ok: true, accepted: reply.accepted });
  }
  if (captureKeys(reply, 'code,ok') && reply.ok === false && INPUT_REFUSAL_CODES.has(reply.code)) {
    return Object.freeze({ ok: false, code: reply.code });
  }
  throw new ContractError('OUTCOME', 'surface input reply');
}
const WIRE_NAMES = Object.freeze({loadSettings:'settings.load',saveSettings:'settings.save',
  recordingDestination:'recording.destination',nestedDepth:'nested.depth',selfCapsuleId:'nested.self',
  propose:'authority.propose',intent:'authority.intent',subscribeFrames:'authority.subscribe',
  unsubscribeFrames:'authority.unsubscribe',terminalOpen:'side-terminal.open',terminalEnabled:'side-terminal.enabled',
  terminalAttach:'side-terminal.attach',terminalResize:'side-terminal.resize',
  terminalClose:'side-terminal.close',terminalProviders:'side-terminal.providers',
  terminalCopy:'side-terminal.copy'});
/** @param {string} channel @param {ReadonlyArray<unknown>} args */
function wireCall(channel,args) {
  if(channel===QA_ANCHORS_CHANNEL) return {channel,args:Object.freeze([assertQaSnapshot(args)])};
  if(channel===FRAME_DIAG_CHANNEL) return {channel,args:Object.freeze([assertFrameDiagPreload(args)])};
  if(channel===FRAME_REPORT_DIAG_CHANNEL) return {channel,args:Object.freeze([assertFrameReportDiag(args)])};
  const captureName=Object.entries(CAPTURE_CHANNELS).find(([,suffix])=>channel===`metaviewer:${suffix}`)?.[0];
  if(captureName){assertCaptureCall(captureName,args);return {channel,args:Object.freeze([...args])};}
  const name=Object.entries(WIRE_NAMES).find(([,suffix]) => channel === `metaviewer:${suffix}`)?.[0];
  if (!name) throw new ContractError('CHANNEL','unknown domain channel');
  const arity=['saveSettings','propose','intent','terminalOpen','terminalEnabled','terminalAttach','terminalResize','terminalClose','terminalCopy'].includes(name) ? 1 : 0;
  if (!Array.isArray(args) || args.length !== arity) throw new ContractError('ARGS','wrong arity');
  if (name==='intent' && args[0] !== null && typeof args[0] === 'object') {
    const checked = validateSurfaceInputBatch(args[0]);
    if (!checked.ok) throw new ContractError('PAYLOAD', checked.code);
    return {channel,args:Object.freeze([checked.batch])};
  }
  if (arity) {
    const encoded=JSON.stringify(args[0]);
    if (encoded === undefined || utf8Bytes(typeof args[0] === 'string' ? args[0] : encoded)>IPC_BOUNDS.maxLayoutBytes) throw new ContractError('PAYLOAD','byte cap');
  }
  if (['saveSettings','propose','intent'].includes(name)) {
    const value=args[0];
    if (typeof value !== 'string' || utf8Bytes(value)>IPC_BOUNDS.maxLayoutBytes) throw new ContractError('PAYLOAD','expected JSON text');
    const parsed=JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ContractError('PAYLOAD','expected object');
  }
  if (name==='terminalEnabled' && typeof args[0] !== 'boolean') throw new ContractError('PAYLOAD','expected boolean');
  if (name==='terminalOpen') {
    const v=/** @type {any} */(args[0]);
    if (!v || (!captureKeys(v,'cols,command,rows') && !captureKeys(v,'args,cols,command,rows'))
      || typeof v.command !== 'string'
      || (v.args !== undefined && (!Array.isArray(v.args) || v.args.length>32 || !v.args.every((/** @type {unknown} */x)=>typeof x==='string' && utf8Bytes(x)<=4096 && !x.includes('\0'))))
      || !Number.isSafeInteger(v.cols) || v.cols<2 || v.cols>500
      || !Number.isSafeInteger(v.rows) || v.rows<2 || v.rows>300) throw new ContractError('PAYLOAD','terminal spec');
  }
  if (name==='terminalAttach' || name==='terminalClose') {
    const v=/** @type {any} */(args[0]);
    if (!captureKeys(v,'session') || typeof v.session !== 'string') throw new ContractError('TERMINAL_IO_REFUSED','terminal session');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(v.session)) throw new ContractError('TERMINAL_UNKNOWN_SESSION','unknown session');
  }
  if (name==='terminalResize') {
    const v=/** @type {any} */(args[0]);
    if (!captureKeys(v,'cols,rows,session') || typeof v.session !== 'string'
      || !Number.isSafeInteger(v.cols) || v.cols<2 || v.cols>500
      || !Number.isSafeInteger(v.rows) || v.rows<2 || v.rows>300) throw new ContractError('TERMINAL_IO_REFUSED','terminal resize');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(v.session)) throw new ContractError('TERMINAL_UNKNOWN_SESSION','unknown session');
  }
  if (name==='terminalCopy') {
    const v=/** @type {any} */(args[0]);
    if (!captureKeys(v,'text') || typeof v.text !== 'string' || v.text.length<1 || v.text.length>128 || !captureId(v.text)) {
      throw new ContractError('ERR_CLIPBOARD_INVALID','clipboard text');
    }
  }
  return {channel,args:Object.freeze([...args])};
}
/** @param {any} value @returns {boolean} */
function validFrameNotice(value) {
  if (!value || Object.keys(value).sort().join(',')!=='frame_ref,surface') return false;
  const f=value.frame_ref,s=value.surface;
  if (!f || !s || Object.keys(f).sort().join(',')!=='capture_us,format,generation,height,schema,sha256,surface_id,tick,ts_ns,width'
    || Object.keys(s).sort().join(',')!=='control,display,geometry,kind,profile_id,schema,state,surface_id,visibility'
    || f.schema!=='frame_ref/v0.2' || f.format!=='rgb24'
    || typeof f.sha256!=='string' || f.sha256.length!==64 || !/^[a-f0-9]{64}$/.test(f.sha256)
    || typeof f.surface_id!=='string' || !f.surface_id.length || f.surface_id.length>128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(f.surface_id)
    || f.width>16384 || f.height>16384
    || !['generation','width','height'].every(key=>Number.isSafeInteger(f[key]) && f[key]>0)
    || !['tick','ts_ns','capture_us'].every(key=>Number.isSafeInteger(f[key]) && f[key]>=0)
    || s.schema!=='surface/v0.2' || s.surface_id!==f.surface_id
    || !['desktop_capsule','browser','game_capsule','vm'].includes(s.kind)
    || typeof s.display!=='string' || !s.display.length || s.display.length>65536
    || !s.geometry || Object.keys(s.geometry).sort().join(',')!=='h,w'
    || !Number.isSafeInteger(s.geometry.w) || s.geometry.w<1 || !Number.isSafeInteger(s.geometry.h) || s.geometry.h<1
    || !['active','standby','ceded','destroyed','lost'].includes(s.state)
    || !['folded','unfolded','pinned'].includes(s.visibility) || !['agent','human','shared'].includes(s.control)
    || typeof s.profile_id!=='string' || !s.profile_id.length || s.profile_id.length>128) return false;
  return utf8Bytes(JSON.stringify(value))<=IPC_BOUNDS.maxLayoutBytes;
}
/** @type {Map<string, symbol>} */
const TERMINAL_SESSION_SENDERS = new Map();
/** @param {PreloadTransport} transport */
function wireFacade(transport) {
  /** @type {Map<string, any>} */ const terminalPorts=new Map();
  const terminalSenderToken=Symbol('terminal-sender');
  let terminalPortSubscribed=false;
  const ensureTerminalPortSubscription=()=>{
    if (transport.nested || terminalPortSubscribed || typeof transport.subscribe !== 'function') return;
    terminalPortSubscribed=true;
    try {
      transport.subscribe('metaviewer:side-terminal.port',(value,ports)=>{
        if (value && typeof value.session === 'string' && Array.isArray(ports) && ports[0]) {
          terminalPorts.set(value.session,ports[0]);
        }
      });
    } catch {
      // Transport double only supports authority.frames subscription.
    }
  };
  /** @param {keyof typeof WIRE_NAMES} name @param {unknown[]} args */
  const call=async(name,args) => {
    if (name==='intent' && args.length===1 && typeof args[0]!=='string') throw new ContractError('PAYLOAD','expected JSON text');
    if (transport.nested && name.startsWith('terminal')) {
      throw new ContractError('DISPLAY_ONLY','side-terminal is disabled in nested display');
    }
    if (name==='terminalAttach') ensureTerminalPortSubscription();
    const admitted=wireCall(`metaviewer:${WIRE_NAMES[name]}`,args);
    if (name==='terminalAttach' || name==='terminalResize' || name==='terminalClose') {
      const reqSession=/** @type {any} */(admitted.args[0]).session;
      const ownerToken=TERMINAL_SESSION_SENDERS.get(reqSession);
      if (ownerToken!==undefined && ownerToken!==terminalSenderToken) {
        throw new ContractError('TERMINAL_IO_REFUSED','SENDER');
      }
    }
    const reply=await transport.invoke(admitted.channel,admitted.args);
    if (['saveSettings','intent','subscribeFrames','unsubscribeFrames','terminalEnabled','terminalResize','terminalClose','terminalCopy'].includes(name)) {
      const out=assertSaveReply(reply);
      if (name==='terminalClose') {
        const reqSession=/** @type {any} */(admitted.args[0]).session;
        TERMINAL_SESSION_SENDERS.delete(reqSession);
      }
      return out;
    }
    if (['loadSettings','recordingDestination','selfCapsuleId'].includes(name)) return assertLoadReply(reply);
    if (name==='nestedDepth') {
      if (reply!==null && reply!==0 && reply!==1) throw new ContractError('OUTCOME','nested depth');return reply;
    }
    const value=/** @type {any} */(reply);
    if (name==='terminalOpen') {
      if (!value || Object.keys(value).join(',')!=='session' || typeof value.session!=='string'
          || !/^[A-Za-z0-9._-]{1,128}$/.test(value.session)) throw new ContractError('OUTCOME','session');
      if (TERMINAL_SESSION_SENDERS.size>=256) {
        const oldest=TERMINAL_SESSION_SENDERS.keys().next().value;
        if (oldest!==undefined) TERMINAL_SESSION_SENDERS.delete(oldest);
      }
      TERMINAL_SESSION_SENDERS.set(value.session,terminalSenderToken);
      return Object.freeze({session:value.session});
    }
    if (name==='terminalAttach') {
      const reqSession=/** @type {any} */(admitted.args[0]).session;
      const queuedPort=terminalPorts.get(reqSession);
      terminalPorts.delete(reqSession);
      const port=value?.port ?? queuedPort;
      if (!port || typeof port !== 'object') throw new ContractError('OUTCOME','terminal port');
      return Object.freeze({port});
    }
    if (name==='terminalProviders') {
      if (!captureKeys(value,'capabilities,entries') || !Array.isArray(value.entries) || !Array.isArray(value.capabilities)
          || !value.entries.some((/** @type {any} */e)=>e?.id==='shell')
          || !value.entries.every((/** @type {any} */e)=>captureKeys(e,'hint,id,label') && typeof e.id==='string' && e.id.length>0 && typeof e.label==='string' && e.label.length>0 && typeof e.hint==='string')
          || !value.capabilities.every((/** @type {any} */c)=>(captureKeys(c,'available,id') || captureKeys(c,'available,id,reason')) && typeof c.id==='string' && c.id.length>0 && typeof c.available==='boolean' && (c.reason===undefined || typeof c.reason==='string'))) {
        throw new ContractError('OUTCOME','terminal providers');
      }
      return Object.freeze({
        entries:Object.freeze(value.entries.map((/** @type {any} */e)=>Object.freeze({id:e.id,label:e.label,hint:e.hint}))),
        capabilities:Object.freeze(value.capabilities.map((/** @type {any} */c)=>Object.freeze({id:c.id,available:c.available,reason:c.reason ?? ''}))),
      });
    }
    const refused=value?.decision==='refused';
    if (!value || value.schema!=='action_verdict/v0.2' || typeof value.proposal_id!=='string'
      || !value.proposal_id.length || value.proposal_id.length>128 || !Number.isSafeInteger(value.core_seq) || value.core_seq<1
      || !['admitted','refused'].includes(value.decision)
      || Object.keys(value).sort().join(',') !== (refused?'core_seq,decision,proposal_id,reason_code,schema':'core_seq,decision,proposal_id,schema')
      || (refused && !['STALE_FRAME','SURFACE_NOT_AGENT_CONTROLLED','LOCKED_BY_OTHER','BUDGET_EXCEEDED','OUT_OF_BOUNDS','POLICY'].includes(value.reason_code))) throw new ContractError('OUTCOME','verdict');
    return Object.freeze({...value});
  };
  /** @type {Record<string,any>} */ const api={};
  /** @type {Set<(value:any)=>void>} */ const captureCallbacks=new Set();
  /** @type {Set<string>} */ const seededCaptureSurfaces=new Set();
  api.capture=captureFacade(transport,captureCallbacks,seededCaptureSurfaces);
  for (const name of ['loadSettings','saveSettings','recordingDestination','nestedDepth','selfCapsuleId']) {
    /** @param {...unknown} args */
    api[name]=(...args)=>call(/** @type {keyof typeof WIRE_NAMES} */(name),args);
  }
  /** @type {Set<(frame:any)=>void>} */ const listeners=new Set();
  /** @type {null|(()=>void)} */ let revokeFrames=null;
  let subscriptionGeneration=0;
  let diagFramesReceived=0,diagInvalidNotices=0,diagPortsReceived=0,diagNoticesForwarded=0,diagLegacyNoticesForwarded=0,diagPortsClosed=0;
  let diagRehashSkipped=0,diagRehashDone=0;
  /** @type {boolean|null} */ let diagInWallApp=null;
  let diagOrigin='';
  /** @type {string|null} */ let diagLastSurfaceId=null;
  /** @type {number|null} */ let diagLastSurfaceGeneration=null;
  /** @type {number|null} */ let diagLastFrameGeneration=null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let diagTimer=null;
  const reportFrameDiag=()=>{
    if(transport.frameDiag!==true || transport.nested) return;
    try {
      const surfaceEl=globalThis.document?.querySelector?.('.mv-surface') ?? null;
      const domSurfaceState=typeof surfaceEl?.getAttribute==='function' ? surfaceEl.getAttribute('data-state') : null;
      const domWaitingText=surfaceEl?.querySelector?.('.mv-surface__waiting strong')?.textContent ?? null;
      const domStripText=surfaceEl?.querySelector?.('.mv-surface__strip')?.textContent?.trim?.() ?? null;
      const admitted=wireCall(FRAME_DIAG_CHANNEL,[Object.freeze({
        schema:'frame_diag_preload/v1',
        framesReceived:diagFramesReceived,
        invalidNotices:diagInvalidNotices,
        portsReceived:diagPortsReceived,
        noticesForwarded:diagNoticesForwarded,
        legacyNoticesForwarded:diagLegacyNoticesForwarded,
        portsClosed:diagPortsClosed,
        rehashSkipped:diagRehashSkipped,
        rehashDone:diagRehashDone,
        inWallApp:diagInWallApp,
        origin:diagOrigin,
        lastSurfaceId:diagLastSurfaceId,
        lastSurfaceGeneration:diagLastSurfaceGeneration,
        lastFrameGeneration:diagLastFrameGeneration,
        domSurfaceState:typeof domSurfaceState==='string'?domSurfaceState:null,
        domWaitingText:typeof domWaitingText==='string'?domWaitingText.slice(0,128):null,
        domStripText:typeof domStripText==='string'?domStripText.slice(0,256):null,
      })]);
      void Promise.resolve(transport.invoke(admitted.channel,admitted.args)).catch(()=>{});
    } catch {}
  };
  const clearFrameDiagTimer=()=>{
    if(diagTimer!==null && typeof globalThis.clearTimeout==='function') globalThis.clearTimeout(diagTimer);
    diagTimer=null;
  };
  const scheduleFrameDiag=()=>{
    reportFrameDiag();
    if(transport.frameDiag===true && !transport.nested && typeof globalThis.setTimeout==='function') {
      clearFrameDiagTimer();
      diagTimer=globalThis.setTimeout(()=>{diagTimer=null;reportFrameDiag();},250);
    }
  };
  /** @type {Map<string,{lastSeq:number,inFlightMaxSeq:number,draining:boolean,lastIpcAt:number,ipcStamps:number[],queue:Array<{batch:any,resolve:(value:any)=>void}>}>} */ const surfaceInputQueues=new Map();
  /** @type {Set<(result:any)=>void>} */ const inputResultListeners=new Set();
  /** @param {string|null} sid @param {number|null} seq @param {{ok:boolean,code?:string}} out */
  const emitInputResult=(sid,seq,out)=>{
    if (sid===null || seq===null || !inputResultListeners.size) return;
    const payload=Object.freeze({surface_id:sid,seq,ok:out.ok,code:out.ok?null:(out.code??'CORE_UNAVAILABLE')});
    for (const notify of [...inputResultListeners]) {
      try { notify(payload); } catch {}
    }
  };
  /** @param {ReadonlyArray<any>} baseEvents @param {ReadonlyArray<any>} nextEvents */
  const mergeTypeEvents=(baseEvents,nextEvents)=>{
    const merged=baseEvents.map(ev=>({kind:'type',text:ev.text}));
    for (const ev of nextEvents) {
      if (merged.length>0 && Array.from(merged[merged.length-1].text).length+Array.from(ev.text).length<=SURFACE_INPUT_MAX_TEXT) {
        merged[merged.length-1].text+=ev.text;
      } else {
        merged.push({kind:'type',text:ev.text});
      }
    }
    return merged;
  };
  /** @param {string} sid */
  const drainSurfaceInputQueue=async(sid)=>{
    const qState=surfaceInputQueues.get(sid);
    if (!qState || qState.draining) return;
    qState.draining=true;
    try {
      while (qState.queue.length>0) {
        await Promise.resolve();
        if (qState.queue.length===0) break;
        const first=qState.queue[0];
        const firstTypeOnly=first.batch.events.every((/** @type {any} */ev)=>ev.kind==='type');
        if (firstTypeOnly && qState.lastIpcAt>0) {
          const elapsed=Date.now()-qState.lastIpcAt;
          if (elapsed<SURFACE_INPUT_TYPE_COALESCE_MS) {
            await new Promise(r=>globalThis.setTimeout(r,SURFACE_INPUT_TYPE_COALESCE_MS-elapsed));
          }
          const now=Date.now();
          qState.ipcStamps=qState.ipcStamps.filter(t=>now-t<1000);
          if (qState.ipcStamps.length>=50) {
            const waitMs=1005-(now-qState.ipcStamps[0]);
            if (waitMs>0) await new Promise(r=>globalThis.setTimeout(r,waitMs));
          }
        }
        if (qState.queue.length===0) break;
        const head=qState.queue[0];
        const headTypeOnly=head.batch.events.every((/** @type {any} */ev)=>ev.kind==='type');
        /** @type {Array<{batch:any,resolve:(value:any)=>void}>} */
        const batchGroup=[];
        /** @type {Array<any>} */
        let wireEvents=[];
        let wireTextBytes=0;
        if (!headTypeOnly) {
          batchGroup.push(/** @type {any} */(qState.queue.shift()));
          wireEvents=head.batch.events;
        } else {
          const streamId=head.batch.stream_id;
          while (qState.queue.length>0) {
            const candidate=qState.queue[0];
            if (candidate.batch.stream_id!==streamId || !candidate.batch.events.every((/** @type {any} */ev)=>ev.kind==='type')) {
              break;
            }
            const candText=candidate.batch.events.map((/** @type {any} */ev)=>ev.text).join('');
            const candBytes=utf8Bytes(candText);
            if (batchGroup.length>0 && wireTextBytes+candBytes>14336) {
              break;
            }
            const nextMerged=mergeTypeEvents(wireEvents,candidate.batch.events);
            if (nextMerged.length>SURFACE_INPUT_MAX_EVENTS) {
              break;
            }
            if (batchGroup.length>0) {
              const candWireBytes=utf8Bytes(JSON.stringify({
                schema:candidate.batch.schema,
                surface_id:sid,
                stream_id:candidate.batch.stream_id,
                seq:candidate.batch.seq,
                events:nextMerged,
              }));
              if (candWireBytes>SURFACE_INPUT_MAX_BYTES) {
                break;
              }
            }
            qState.queue.shift();
            batchGroup.push(candidate);
            wireEvents=nextMerged;
            wireTextBytes+=candBytes;
          }
        }
        const lastItem=batchGroup[batchGroup.length-1];
        const wireBatch=batchGroup.length===1 && !headTypeOnly
          ? head.batch
          : Object.freeze({
              schema:lastItem.batch.schema,
              surface_id:sid,
              stream_id:lastItem.batch.stream_id,
              seq:lastItem.batch.seq,
              events:Object.freeze(wireEvents.map(ev=>Object.freeze({...ev}))),
            });
        qState.inFlightMaxSeq=wireBatch.seq;
        const invokeAt=Date.now();
        qState.lastIpcAt=invokeAt;
        qState.ipcStamps=qState.ipcStamps.filter(t=>invokeAt-t<1000);
        qState.ipcStamps.push(invokeAt);
        let out;
        try {
          const reply=await transport.invoke(SURFACE_INPUT_CHANNEL,Object.freeze([wireBatch]));
          out=assertSurfaceInputReply(reply,wireBatch.events.length);
        } catch {
          out=Object.freeze({ok:false,code:'CORE_UNAVAILABLE'});
        } finally {
          qState.inFlightMaxSeq=0;
        }
        if (out.ok) {
          qState.lastSeq=Math.max(qState.lastSeq,wireBatch.seq);
          for (const item of batchGroup) {
            const itemOut=Object.freeze({ok:true,accepted:item.batch.events.length});
            emitInputResult(sid,item.batch.seq,itemOut);
            item.resolve(itemOut);
          }
        } else {
          if (qState.lastSeq===0 && qState.queue.length===0) {
            surfaceInputQueues.delete(sid);
          }
          const failOut=Object.freeze({ok:false,code:out.code});
          for (const item of batchGroup) {
            emitInputResult(sid,item.batch.seq,failOut);
            item.resolve(failOut);
          }
        }
      }
    } finally {
      qState.draining=false;
      if (qState.lastSeq===0 && qState.queue.length===0 && qState.inFlightMaxSeq===0) {
        surfaceInputQueues.delete(sid);
      }
    }
  };
  api.input=Object.freeze({
    /** @param {...unknown} args */
    send:async(...args)=>{
      const raw=args.length===1 && args[0] && typeof args[0]==='object' && !Array.isArray(args[0]) ? /** @type {any} */(args[0]) : null;
      const rawSid=raw && captureId(raw.surface_id) ? raw.surface_id : null;
      const rawSeq=raw && Number.isSafeInteger(raw.seq) && raw.seq>=1 ? raw.seq : null;
      if (args.length!==1) {
        const out=Object.freeze({ok:false,code:'SCHEMA'});
        emitInputResult(rawSid,rawSeq,out);
        return out;
      }
      const checked=validateSurfaceInputBatch(args[0]);
      if (!checked.ok) {
        const out=Object.freeze({ok:false,code:checked.code});
        emitInputResult(rawSid,rawSeq,out);
        return out;
      }
      const sid=checked.batch.surface_id;
      const seq=checked.batch.seq;
      if (transport.nested) {
        const out=Object.freeze({ok:false,code:'NESTED_DISPLAY_ONLY'});
        emitInputResult(sid,seq,out);
        return out;
      }
      let qState=surfaceInputQueues.get(sid);
      if (!qState) {
        if (surfaceInputQueues.size>=SURFACE_INPUT_MAX_SURFACES) {
          let evicted=false;
          for (const [k,v] of surfaceInputQueues) {
            if (!v.draining && v.queue.length===0 && v.inFlightMaxSeq===0 && v.lastSeq===0) {
              surfaceInputQueues.delete(k);
              evicted=true;
              break;
            }
          }
          if (!evicted) {
            for (const [k,v] of surfaceInputQueues) {
              if (!v.draining && v.queue.length===0 && v.inFlightMaxSeq===0) {
                surfaceInputQueues.delete(k);
                evicted=true;
                break;
              }
            }
          }
          if (!evicted) {
            const oldest=surfaceInputQueues.keys().next().value;
            if (oldest!==undefined) surfaceInputQueues.delete(oldest);
          }
        }
        qState={lastSeq:0,inFlightMaxSeq:0,draining:false,lastIpcAt:0,ipcStamps:[],queue:[]};
        surfaceInputQueues.set(sid,qState);
      }
      const highestQueuedSeq=qState.queue.length>0?qState.queue[qState.queue.length-1].batch.seq:0;
      const prevSeq=Math.max(qState.lastSeq,qState.inFlightMaxSeq,highestQueuedSeq);
      if (seq<=prevSeq) {
        const out=Object.freeze({ok:false,code:'SCHEMA'});
        emitInputResult(sid,seq,out);
        return out;
      }
      let queuedEvents=0;
      for (const item of qState.queue) queuedEvents+=item.batch.events.length;
      if (queuedEvents+checked.batch.events.length>SURFACE_INPUT_MAX_QUEUE_EVENTS) {
        const out=Object.freeze({ok:false,code:'LIMIT'});
        emitInputResult(sid,seq,out);
        return out;
      }
      return new Promise((resolve)=>{
        qState.queue.push({batch:checked.batch,resolve});
        if (!qState.draining) {
          void drainSurfaceInputQueue(sid);
        }
      });
    },
    /** @param {...unknown} args */
    onResult:(...args)=>{
      if (args.length!==1 || typeof args[0]!=='function') throw new ContractError('ARGS','input result callback');
      const cb=/** @type {(result:any)=>void} */(args[0]);
      let active=true;
      const listener=(/** @type {any} */value)=>{
        if (!active || !inputResultListeners.has(listener)) return;
        cb(value);
      };
      inputResultListeners.add(listener);
      return ()=>{
        if (!active) return;
        active=false;
        inputResultListeners.delete(listener);
      };
    },
  });
  api.authority=Object.freeze({
    /** @param {...unknown} args */
    propose:(...args)=>call('propose',args),
    /** @param {...unknown} args */
    intent:(...args)=>call('intent',args),
    /** @param {...unknown} args */
    subscribeFrames:(...args)=> {
      if (args.length!==1 || typeof args[0]!=='function' || !transport.subscribe) throw new ContractError('ARGS','frame callback');
      const cb=/** @type {(frame:any)=>void} */(args[0]);
      let active=true;
      // Give each subscription its own identity, including repeated callbacks.
      const listener=(/** @type {any} */value)=>{
        if (!active || !listeners.has(listener)) return;
        cb(value);
      };
      listeners.add(listener);
      if(listeners.size===1) {
        const generation=++subscriptionGeneration;
        revokeFrames=transport.subscribe('metaviewer:authority.frames',(value,ports)=> {
          const closePorts=()=>{
            for (const port of ports??[]) {
              // Teardown must attempt every port even if one is already detached.
              try { port.close?.(); } catch { /* Continue releasing unused ports. */ }
            }
          };
          if (!validFrameNotice(value)) {
            diagInvalidNotices+=1;
            if (ports?.length) diagPortsClosed+=1;
            closePorts();
            reportFrameDiag();
            return;
          }
          const sid=value.surface.surface_id;
          const inWallApp=typeof document!=='undefined' && typeof document?.getElementById==='function' && document.getElementById('metaviewer-app')!==null;
          diagFramesReceived+=1;
          diagInWallApp=inWallApp;
          diagOrigin=typeof window!=='undefined' && typeof window.location?.origin==='string' ? window.location.origin : '';
          diagLastSurfaceId=captureId(sid) ? sid : null;
          diagLastFrameGeneration=value.frame_ref.generation;
          if (ports?.length) diagPortsReceived+=1;
          if (['destroyed','lost'].includes(value.surface.state)) {
            surfaceInputQueues.delete(sid);
            seededCaptureSurfaces.delete(sid);
          } else if (inWallApp && !seededCaptureSurfaces.has(sid) && captureId(sid)) {
            if (seededCaptureSurfaces.size>=SURFACE_INPUT_MAX_SURFACES) {
              const oldest=seededCaptureSurfaces.values().next().value;
              if (oldest!==undefined) seededCaptureSurfaces.delete(oldest);
            }
            seededCaptureSurfaces.add(sid);
            const initCapture=Object.freeze({type:'capture.state',recording_id:'idle',surface_id:sid,phase:'idle',frames:0,elapsed_ms:0});
            for (const notifyCapture of [...captureCallbacks]) {
              try { notifyCapture(initCapture); } catch {}
            }
          }
          // Validate once before forwarding either the notice or its byte-plane ports.
          if (ports?.length && typeof window !== 'undefined' && window.location.origin===PRIVILEGED_ORIGIN) {
            if (inWallApp) {
              // [TARGET, unit decision] Forward live-wall frame ports to the renderer main world under frame_port/v1.
              const surfaceGeneration=value.frame_ref.generation;
              window.postMessage(
                {type:'metaviewer:frame-port',schema:'frame_port/v1',surface_id:sid,surface_generation:surfaceGeneration},
                window.location.origin,
                [ports[0]],
              );
              diagLastSurfaceGeneration=surfaceGeneration;
              diagNoticesForwarded+=1;
              for (const extra of ports.slice(1)) { try { extra.close?.(); } catch {} }
            } else {
              window.postMessage({type:'metaviewer:frame-port',surface_id:sid},PRIVILEGED_ORIGIN,ports);
              diagLegacyNoticesForwarded+=1;
            }
          } else {
            if (ports?.length) diagPortsClosed+=1;
            closePorts();
          }
          for(const notify of [...listeners]) notify(value);
          scheduleFrameDiag();
        });
        void call('subscribeFrames',[]).catch(()=>{
          if(generation!==subscriptionGeneration) return;
          ++subscriptionGeneration;listeners.clear();clearFrameDiagTimer();revokeFrames?.();revokeFrames=null;
        });
      }
      return ()=>{
        if(!active) return;active=false;listeners.delete(listener);
        if(!listeners.size && revokeFrames) {
          ++subscriptionGeneration;clearFrameDiagTimer();revokeFrames();revokeFrames=null;
          void call('unsubscribeFrames',[]).catch(()=>{});
        }
      };

    },
  });
  api.frames=Object.freeze({
    /** @param {...unknown} args */
    reportDiag:async(...args)=>{
      const admitted=wireCall(FRAME_REPORT_DIAG_CHANNEL,args);
      const report=/** @type {{rehashSkipped:number,rehashDone:number}} */(admitted.args[0]);
      const reply=await transport.invoke(admitted.channel,admitted.args);
      assertSaveReply(reply);
      diagRehashSkipped=Math.max(diagRehashSkipped,report.rehashSkipped);
      diagRehashDone=Math.max(diagRehashDone,report.rehashDone);
      scheduleFrameDiag();
      return true;
    },
  });
  api.sideTerminal=Object.freeze({
    /** @param {...unknown} args */
    open:(...args)=>call('terminalOpen',args),
    /** @param {...unknown} args */
    setEnabled:(...args)=>call('terminalEnabled',args),
    /** @param {...unknown} args */
    attach:(...args)=>call('terminalAttach',args),
    /** @param {...unknown} args */
    resize:(...args)=>call('terminalResize',args),
    /** @param {...unknown} args */
    close:(...args)=>call('terminalClose',args),
    /** @param {...unknown} args */
    listProviders:(...args)=>call('terminalProviders',args),
    /** @param {...unknown} args */
    copyText:(...args)=>call('terminalCopy',args)});
  if (transport.qa === true && !transport.nested) {
    api.qa = Object.freeze({
      /** @param {...unknown} args */
      reportAnchors: (...args) => {
        const admitted = wireCall(QA_ANCHORS_CHANNEL, args);
        return transport.invoke(admitted.channel, admitted.args).then(assertSaveReply);
      },
    });
  }
  return api;
}

/**
 * Read a data property off the electron handles, refusing accessors.
 * @param {unknown} holder Alleged electron module object.
 * @param {string} name Property name.
 * @param {string} label Diagnostic label.
 * @returns {unknown} The property value.
 */
function readElectronHandle(holder, name, label) {
  let cursor = holder;
  while (cursor !== null && (typeof cursor === 'object' || typeof cursor === 'function')) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor !== undefined) {
      if ('value' in descriptor) {
        return descriptor.value;
      }
      throw new ContractError('DEPS', `${label} must be a data property`);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new ContractError('DEPS', `${label} is missing`);
}

/**
 * Install the facade onto real electron handles: validate the bridge and
 * renderer, wrap the native invoke with the fixed-call guard, and expose
 * once through the factory. The native adapter refuses off-set channels,
 * non-array vectors and misshaped payloads before the native call runs.
 * @param {unknown} electron Alleged electron module object.
 * @returns {MetaViewerFacade} The frozen exposed API.
 */
export function installPreload(electron) {
  if (electron === null || (typeof electron !== 'object' && typeof electron !== 'function')) {
    throw new ContractError('DEPS', 'electron handles must be an object');
  }
  const contextBridge = readElectronHandle(electron, 'contextBridge', 'electron.contextBridge');
  const ipcRenderer = readElectronHandle(electron, 'ipcRenderer', 'electron.ipcRenderer');
  if (contextBridge === null || (typeof contextBridge !== 'object' && typeof contextBridge !== 'function')) {
    throw new ContractError('DEPS', 'electron.contextBridge must be an object');
  }
  if (ipcRenderer === null || (typeof ipcRenderer !== 'object' && typeof ipcRenderer !== 'function')) {
    throw new ContractError('DEPS', 'electron.ipcRenderer must be an object');
  }
  assertCallableMethod(contextBridge, 'exposeInMainWorld', 'contextBridge.exposeInMainWorld');
  assertCallableMethod(ipcRenderer, 'invoke', 'ipcRenderer.invoke');
  const renderer = /** @type {Record<string, (...args: Array<unknown>) => Promise<unknown>>} */ (ipcRenderer);
  const nested = typeof navigator !== 'undefined' && navigator.userAgent.split(' ').includes('--nested-depth=1');
  const qaDesc = Object.getOwnPropertyDescriptor(electron, 'qa');
  if (qaDesc !== undefined && !('value' in qaDesc)) {
    throw new ContractError('DEPS', 'electron.qa must be a data property');
  }
  const qaEnabled = !nested && (
    qaDesc?.value === true ||
    (typeof navigator !== 'undefined' && navigator.userAgent.split(' ').includes('--qa-anchors=1'))
  );
  const frameDiagDesc = Object.getOwnPropertyDescriptor(electron, 'frameDiag');
  if (frameDiagDesc !== undefined && !('value' in frameDiagDesc)) {
    throw new ContractError('DEPS', 'electron.frameDiag must be a data property');
  }
  const frameDiagEnabled = !nested && (
    frameDiagDesc?.value === true ||
    (typeof navigator !== 'undefined' && navigator.userAgent.split(' ').includes('--frame-diag=1'))
  );
  return createPreloadFacade({
    transport: {
      nested,
      ...(qaEnabled ? { qa: true } : {}),
      ...(frameDiagEnabled ? { frameDiag: true } : {}),
      subscribe: typeof /** @type {any} */(ipcRenderer).on === 'function' ?
      /** @param {string} channel @param {(value:any,ports?:MessagePort[])=>void} cb */
      (channel,cb) => {
        if (nested && channel === 'metaviewer:side-terminal.port') throw new ContractError('DISPLAY_ONLY','side-terminal is disabled in nested display');
        if (!['metaviewer:authority.frames','metaviewer:capture.state','metaviewer:side-terminal.port'].includes(channel)) throw new ContractError('CHANNEL','subscription refused');
        const native = /** @type {any} */(ipcRenderer);
        const listener = (/** @type {any} */event,/** @type {any} */value) => {
          // The facade validates this authenticated host channel before transfer.
          cb(value,event.ports);
        };
        native.on(channel,listener);
        return () => native.removeListener(channel,listener);
      } : undefined,
      /**
       * @param {string} channel Fixed channel.
       * @param {ReadonlyArray<unknown>} args Bounded arguments.
       * @returns {Promise<unknown>} Main outcome.
       */
      invoke: (channel, args) => {
        if (nested && channel.startsWith('metaviewer:side-terminal.')) {
          throw new ContractError('DISPLAY_ONLY', 'side-terminal is disabled in nested display');
        }
        if (channel === QA_ANCHORS_CHANNEL && !qaEnabled) {
          throw new ContractError('CHANNEL', 'qa channel disabled');
        }
        if (channel === FRAME_DIAG_CHANNEL && !frameDiagEnabled) {
          throw new ContractError('CHANNEL', 'frame diag channel disabled');
        }
        const call = channel.startsWith('metaviewer:layout.') ? assertFixedCall(channel, args) : wireCall(channel,args);
        return renderer.invoke(call.channel, ...call.args);
      },
    },
    bridge: /** @type {PreloadBridge} */ (contextBridge),
  });
}

// Guarded entry: `module`/`require` exist only in the bundled CommonJS
// preload, so ESM import short-circuits here with no side effects.
if (typeof module !== 'undefined' && module !== null && typeof require === 'function') {
  // [TARGET, unit decision] Electron's trusted sandbox module exports lazy
  // accessors. Snapshot only the native handles here; injected callers of
  // installPreload still have to supply data properties.
  const { contextBridge, ipcRenderer } = require('electron');
  installPreload({ contextBridge, ipcRenderer });
  // Private native handshake after the index document and its resources load.
  // No renderer-world method is exposed for this channel.
  if (typeof navigator === 'undefined' || !navigator.userAgent.split(' ').includes('--nested-depth=1')) {
    globalThis.addEventListener('load', () => {
      void ipcRenderer.invoke('metaviewer:renderer-ready').catch(() => {});
    }, { once: true });
  }
}
