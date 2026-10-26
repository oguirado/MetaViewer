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
 * @property {() => Promise<string|null>} load Read the stored layout text,
 * or null when no profile exists.
 * @property {(json: unknown) => Promise<true>} save Store layout text after
 * the host acknowledges.
 */

/**
 * @typedef {object} PreloadTransport Injected main-side invoke handle.
 * @property {(channel: string, args: ReadonlyArray<unknown>) => Promise<unknown>} invoke
 * Fixed-channel invoke returning the main outcome.
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
  const api = {
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
  };
  const frozen = /** @type {MetaViewerFacade} */ (Object.freeze(api));
  bridge.exposeInMainWorld(FACADE_NAME, frozen);
  return frozen;
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
      /**
       * @param {string} channel Fixed channel.
       * @param {ReadonlyArray<unknown>} args Bounded arguments.
       * @returns {Promise<unknown>} Main outcome.
       */
      invoke: (channel, args) => {
        const call = assertFixedCall(channel, args);
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
