/**
 * MetaViewer bootstrap preload facade (sandbox-loadable).
 * [TARGET, unit decision] Snapshot trusted native lazy exports at the CJS
 * entry; retain accessor rejection for injected installPreload dependencies.
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
 * @property {{screenshot:(req:any)=>Promise<any>,recordStart:(req:any)=>Promise<any>,recordStop:(req:any)=>Promise<any>,export:(req:any)=>Promise<any>,list:()=>Promise<any>,subscribe:(cb:(state:any)=>void)=>(()=>void)}} capture
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
  if (!captureKeys(v,keys) || v.schema!=='capture_request/v1'
    || typeof v.request_id!=='string' || !/^[\x20-\x7e]{1,64}$/.test(v.request_id)
    || !captureId(method==='export'?v.capture_id:method==='recordStop'?v.recording_id:v.surface_id)
    || (method==='export' && v.destination!==null && v.destination!=='recording:configured')
    || (method==='recordStart' && v.mode!=='ai')) throw new ContractError('PAYLOAD','capture request');
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
      const cb=/** @type {(value:any)=>void} */(args[0]);
      const token=Symbol();
      captureCallbacks.add(cb);
      const revoke=transport.subscribe?.('metaviewer:capture.state',value=>{
        if(validCaptureState(value)) cb(Object.freeze({...value}));
      });
      subscriptions.set(token,()=>{captureCallbacks.delete(cb);revoke?.();});
      if (typeof document!=='undefined' && typeof document?.getElementById==='function' && document.getElementById('metaviewer-app')!==null) {
        for (const sid of seededCaptureSurfaces) {
          try { cb(Object.freeze({type:'capture.state',recording_id:'idle',surface_id:sid,phase:'idle',frames:0,elapsed_ms:0})); } catch {}
        }
      }
      void call('subscribe',[]).catch(()=>{subscriptions.get(token)?.();subscriptions.delete(token);});
      return ()=>{const stop=subscriptions.get(token);if(!stop)return;stop();subscriptions.delete(token);
        if(!subscriptions.size)void call('unsubscribe',[]).catch(()=>{});};
    },
  });
}

// [TARGET, unit decision] Closed domain channels; all values are rechecked in main.
const QA_ANCHORS_CHANNEL = 'metaviewer:qa.anchors';
const QA_ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
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
      || !captureId(r.anchor)
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
const WIRE_NAMES = Object.freeze({loadSettings:'settings.load',saveSettings:'settings.save',
  recordingDestination:'recording.destination',nestedDepth:'nested.depth',selfCapsuleId:'nested.self',
  propose:'authority.propose',intent:'authority.intent',subscribeFrames:'authority.subscribe',
  unsubscribeFrames:'authority.unsubscribe',terminalOpen:'side-terminal.open',terminalEnabled:'side-terminal.enabled'});
/** @param {string} channel @param {ReadonlyArray<unknown>} args */
function wireCall(channel,args) {
  if(channel===QA_ANCHORS_CHANNEL) return {channel,args:Object.freeze([assertQaSnapshot(args)])};
  const captureName=Object.entries(CAPTURE_CHANNELS).find(([,suffix])=>channel===`metaviewer:${suffix}`)?.[0];
  if(captureName){assertCaptureCall(captureName,args);return {channel,args:Object.freeze([...args])};}
  const name=Object.entries(WIRE_NAMES).find(([,suffix]) => channel === `metaviewer:${suffix}`)?.[0];
  if (!name) throw new ContractError('CHANNEL','unknown domain channel');
  const arity=['saveSettings','propose','intent','terminalOpen','terminalEnabled'].includes(name) ? 1 : 0;
  if (!Array.isArray(args) || args.length !== arity) throw new ContractError('ARGS','wrong arity');
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
    if (!v || Object.keys(v).sort().join(',') !== 'args,cols,command,rows'
      || typeof v.command !== 'string' || !Array.isArray(v.args) || v.args.length>32
      || !v.args.every((/** @type {unknown} */x)=>typeof x==='string' && utf8Bytes(x)<=4096 && !x.includes('\0'))
      || !Number.isSafeInteger(v.cols) || v.cols<2 || v.cols>500
      || !Number.isSafeInteger(v.rows) || v.rows<2 || v.rows>300) throw new ContractError('PAYLOAD','terminal spec');
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
/** @param {PreloadTransport} transport */
function wireFacade(transport) {
  /** @param {keyof typeof WIRE_NAMES} name @param {unknown[]} args */
  const call=async(name,args) => {
    const admitted=wireCall(`metaviewer:${WIRE_NAMES[name]}`,args);
    const reply=await transport.invoke(admitted.channel,admitted.args);
    if (['saveSettings','intent','subscribeFrames','unsubscribeFrames','terminalEnabled'].includes(name)) return assertSaveReply(reply);
    if (['loadSettings','recordingDestination','selfCapsuleId'].includes(name)) return assertLoadReply(reply);
    if (name==='nestedDepth') {
      if (reply!==null && reply!==0 && reply!==1) throw new ContractError('OUTCOME','nested depth');return reply;
    }
    const value=/** @type {any} */(reply);
    if (name==='terminalOpen') {
      if (!value || Object.keys(value).join(',')!=='session' || typeof value.session!=='string'
          || !/^[A-Za-z0-9._-]{1,128}$/.test(value.session)) throw new ContractError('OUTCOME','session');return Object.freeze({session:value.session});
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
  api.authority=Object.freeze({
    /** @param {...unknown} args */
    propose:(...args)=>call('propose',args),
    /** @param {...unknown} args */
    intent:(...args)=>call('intent',args),
    /** @param {...unknown} args */
    subscribeFrames:(...args)=> {
      if (args.length!==1 || typeof args[0]!=='function' || !transport.subscribe) throw new ContractError('ARGS','frame callback');
      const cb=/** @type {(frame:any)=>void} */(args[0]);
      // Give each subscription its own identity, including repeated callbacks.
      const listener=(/** @type {any} */value)=>cb(value);
      listeners.add(listener);let active=true;
      if(listeners.size===1) {
        const generation=++subscriptionGeneration;
        revokeFrames=transport.subscribe('metaviewer:authority.frames',(value,ports)=> {
          const closePorts=()=>{
            for (const port of ports??[]) {
              // Teardown must attempt every port even if one is already detached.
              try { port.close?.(); } catch { /* Continue releasing unused ports. */ }
            }
          };
          if (!validFrameNotice(value)) { closePorts();return; }
          const sid=value.surface.surface_id;
          const inWallApp=typeof document!=='undefined' && typeof document?.getElementById==='function' && document.getElementById('metaviewer-app')!==null;
          if (inWallApp && !seededCaptureSurfaces.has(sid) && captureId(sid)) {
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
              window.postMessage(
                {type:'metaviewer:frame-port',schema:'frame_port/v1',surface_id:sid,surface_generation:value.frame_ref.generation},
                window.location.origin,
                [ports[0]],
              );
              for (const extra of ports.slice(1)) { try { extra.close?.(); } catch {} }
            } else {
              window.postMessage({type:'metaviewer:frame-port',surface_id:sid},PRIVILEGED_ORIGIN,ports);
            }
          } else {
            closePorts();
          }
          for(const notify of [...listeners]) notify(value);
        });
        void call('subscribeFrames',[]).catch(()=>{
          if(generation!==subscriptionGeneration) return;
          ++subscriptionGeneration;listeners.clear();revokeFrames?.();revokeFrames=null;
        });
      }
      return ()=>{
        if(!active) return;active=false;listeners.delete(listener);
        if(!listeners.size && revokeFrames) {
          ++subscriptionGeneration;revokeFrames();revokeFrames=null;
          void call('unsubscribeFrames',[]).catch(()=>{});
        }
      };

    },
  });
  api.sideTerminal=Object.freeze({
    /** @param {...unknown} args */
    open:(...args)=>call('terminalOpen',args),
    /** @param {...unknown} args */
    setEnabled:(...args)=>call('terminalEnabled',args)});
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
  return createPreloadFacade({
    transport: {
      nested,
      ...(qaEnabled ? { qa: true } : {}),
      subscribe: typeof /** @type {any} */(ipcRenderer).on === 'function' ?
      /** @param {string} channel @param {(value:any,ports?:MessagePort[])=>void} cb */
      (channel,cb) => {
        if (!['metaviewer:authority.frames','metaviewer:capture.state'].includes(channel)) throw new ContractError('CHANNEL','subscription refused');
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
        if (channel === QA_ANCHORS_CHANNEL && !qaEnabled) {
          throw new ContractError('CHANNEL', 'qa channel disabled');
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
}
