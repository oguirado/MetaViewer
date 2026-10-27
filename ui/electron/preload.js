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
 * @property {{open:(spec:any)=>Promise<{session:string}>,setEnabled:(value:boolean)=>Promise<true>}} sideTerminal
 * @property {() => Promise<string|null>} load Read the stored layout text,
 * or null when no profile exists.
 * @property {(json: unknown) => Promise<true>} save Store layout text after
 * the host acknowledges.
 */

/**
 * @typedef {object} PreloadTransport Injected main-side invoke handle.
 * @property {(channel: string, args: ReadonlyArray<unknown>) => Promise<unknown>} invoke
 * Fixed-channel invoke returning the main outcome.
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
const PRIVILEGED_ORIGIN = 'metaviewer://app';

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
    .map(([name,value]) => [name,{value,enumerable:typeof transport.subscribe === 'function'}])));
  const frozen = /** @type {MetaViewerFacade} */ (Object.freeze(api));
  bridge.exposeInMainWorld(FACADE_NAME, frozen);
  return frozen;
}

// [TARGET, unit decision] Closed domain channels; all values are rechecked in main.
const WIRE_NAMES = Object.freeze({loadSettings:'settings.load',saveSettings:'settings.save',
  recordingDestination:'recording.destination',nestedDepth:'nested.depth',selfCapsuleId:'nested.self',
  propose:'authority.propose',intent:'authority.intent',subscribeFrames:'authority.subscribe',
  unsubscribeFrames:'authority.unsubscribe',terminalOpen:'side-terminal.open',terminalEnabled:'side-terminal.enabled'});
/** @param {string} channel @param {ReadonlyArray<unknown>} args */
function wireCall(channel,args) {
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
          if (!validFrameNotice(value)) return;
          // Validate once before forwarding either the notice or its byte-plane ports.
          if (ports?.length && typeof window !== 'undefined' && window.location.origin===PRIVILEGED_ORIGIN) {
            window.postMessage({type:'metaviewer:frame-port',surface_id:value.surface.surface_id},PRIVILEGED_ORIGIN,ports);
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
  return createPreloadFacade({
    transport: {
      subscribe: typeof /** @type {any} */(ipcRenderer).on === 'function' ?
      /** @param {string} channel @param {(value:any,ports?:MessagePort[])=>void} cb */
      (channel,cb) => {
        if (channel !== 'metaviewer:authority.frames') throw new ContractError('CHANNEL','subscription refused');
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
