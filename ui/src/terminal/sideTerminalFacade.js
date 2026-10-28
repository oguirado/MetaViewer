/** [TARGET, unit decision] Adapt an injected, already-authorized session port
 * to the kit overlay. No launch capability exists in this handoff. Close only
 * detaches this view; host session ownership and process lifetime stay host-side.
 * The existing client remains the sequence/credit and malformed-frame boundary. */
import { reactive, toRaw } from 'vue';
import { createTerminalClient } from './terminalClient.js';
export { useKitGeometry as useTerminalChromeGeometry } from '../../.kit/capsule-ui-kit/src/workspace/useKitGeometry.js';

/** @param {{session:string,port:MessagePort}} binding */
export function createSideTerminalFacade({ session, port }) {
  if (typeof session !== 'string' || !TERMINAL_SESSION_ID_RE.test(session)
      || !port || typeof port.postMessage !== 'function') {
    throw Object.assign(new Error('Invalid terminal binding'), { code: 'TERMINAL_BINDING_REFUSED' });
  }
  /** @type {Set<(frame:any)=>void>} */
  const dataListeners = new Set();
  /** @type {Set<(event:any)=>void>} */
  const exitListeners = new Set();
  /** @type {Map<number,{done:()=>void,bytes:number}>} */
  const pending = new Map();
  let seq = 0, totalBytes = 0, detached = false;
  /** @type {ReturnType<typeof createTerminalClient>|null} */
  let client = null;
  function dispose() { detached = true; client?.dispose(); pending.clear(); }
  /** @param {string} id */
  function requireSession(id) { if (id !== session || detached) throw new Error('Terminal binding refused'); }
  return {
    capabilities: async () => ({ developerMode: true, commands: [] }),
    attach: async () => {
      requireSession(session);
      if (client) throw new Error('Terminal already attached');
      client = createTerminalClient({ session, port,
        write(bytes, done) {
          totalBytes += bytes.length;
          pending.set(++seq, { done, bytes: totalBytes });
          for (const receive of dataListeners) receive({ session, seq, bytes: Array.from(bytes), byteLength: bytes.length });
        },
        onStatus(status) {
          dispose();
          for (const receive of exitListeners) receive({ session, reason: status });
        },
      });
      return { enabled: true, sessions: [{ session, command: 'session', title: 'Session terminal', seq: 0, ackedSeq: 0, bytes: 0, replay: [] }] };
    },
    /** @param {(frame:any)=>void} receive */
    onData(receive) { dataListeners.add(receive); return () => dataListeners.delete(receive); },
    /** @param {(event:any)=>void} receive */
    onExit(receive) { exitListeners.add(receive); return () => exitListeners.delete(receive); },
    /** @param {{session:string,seq:number,bytes:number}} ack */
    ack(ack) {
      requireSession(ack.session);
      const credit = pending.get(ack.seq);
      if (!credit || credit.bytes !== ack.bytes) throw new Error('Terminal credit refused');
      for (const [index, item] of pending) {
        if (index <= ack.seq) { item.done(); pending.delete(index); }
      }
    },
    /** @param {{session:string,bytes:number[]}} input */
    write(input) { requireSession(input.session); client?.input(Uint8Array.from(input.bytes)); },
    /** @param {{session:string,cols:number,rows:number}} size */
    resize(size) { requireSession(size.session); port.postMessage(size); },
    /** @param {{session:string}} request */
    close(request) { requireSession(request.session); dispose(); },
    dispose,
  };
}


/** No-core empty-state facade for the kit side-terminal model.
 * Answers the attach/capabilities contract with zero sessions and typed
 * refusals, so an open panel without a core/broker binding projects the
 * designed empty state instead of JS exception text. Structurally matches
 * the session facade so the overlay can hand either to the kit panel.
 */
export function createEmptySideTerminalFacade() {
  return {
    capabilities: async () => ({ developerMode: false, commands: [] }),
    attach: async () => ({ enabled: false, sessions: [] }),
    /** @param {(frame:any)=>void} _receive */
    onData(_receive) { return () => true; },
    /** @param {(event:any)=>void} _receive */
    onExit(_receive) { return () => true; },
    /** @param {{session:string,seq:number,bytes:number}} _ack */
    ack: async (_ack) => { throw new Error('Terminal session unavailable'); },
    /** @param {{session:string,bytes:number[]}} _input */
    write: async (_input) => { throw new Error('Terminal session unavailable'); },
    /** @param {{session:string,cols:number,rows:number}} _size */
    resize: async (_size) => { throw new Error('Terminal session unavailable'); },
    /** @param {{session:string}} _request */
    close(_request) {},
    /** @param {boolean} _enabled */
    setEnabled: async (_enabled) => { throw new Error('Terminal access unavailable'); },
    /** @param {{command:string,args:readonly string[],cols:number,rows:number}} _spec */
    open: async (_spec) => { throw new Error('Terminal launch unavailable'); },
    dispose() {},
  };
}

/** @typedef {{open?: ((spec: {command:string,args:readonly string[],cols:number,rows:number}) => Promise<any>) | null,
 * setEnabled?: ((enabled:boolean) => Promise<unknown>) | null,
 * close?: ((request:{session:string}) => unknown) | null}} SideTerminalBroker */
/** Broker identity owns opt-in state across views and overlay toggles. */
/** @type {WeakMap<SideTerminalBroker, {state:{enabled:boolean,busy:boolean},canEnable:boolean,canOpen:boolean,setEnabled:(enabled:boolean)=>Promise<void>,open:(spec:{command:string,args:readonly string[],cols:number,rows:number})=>Promise<any>,close:(request:{session:string})=>unknown}>} */
const brokerFacades = new WeakMap();

/** Route launch authority through this facade, separately from session-port IO.
 * Host methods keep their receiver. An absent opt-in method means the injected
 * broker is already authorized; a present method must acknowledge before launch.
 * @param {SideTerminalBroker | null | undefined} source
 */
export function createSideTerminalBrokerFacade(source) {
  if (!source) return null;
  const broker = toRaw(source);
  if (brokerFacades.has(broker)) return brokerFacades.get(broker);
  const state = reactive({ enabled: typeof broker.setEnabled !== 'function', busy: false });
  const facade = {
    state,
    canEnable: typeof broker.setEnabled === 'function',
    canOpen: typeof broker.open === 'function',
    /** @param {boolean} enabled */
    async setEnabled(enabled) {
      if (!broker.setEnabled || state.busy) throw new Error('Terminal access unavailable');
      state.busy = true;
      try { await broker.setEnabled(enabled); state.enabled = enabled; }
      finally { state.busy = false; }
    },
    /** @param {{command:string,args:readonly string[],cols:number,rows:number}} spec */
    async open(spec) {
      if (!broker.open || !state.enabled || state.busy) throw new Error('Terminal launch unavailable');
      state.busy = true;
      try { return await broker.open(spec); }
      finally { state.busy = false; }
    },
    /** Host owns process lifetime; close is forwarded only when supplied.
     * @param {{session:string}} request */
    close(request) { return broker.close?.(request); },
  };
  brokerFacades.set(broker, facade);
  return facade;
}

/**
 * Typed terminal-session lifecycle rows for the MetaViewer multislot and side
 * terminal (lane M). Pure helpers with no DOM, framework or host calls. The kit
 * owns tab ids/anchors (`cui-terminal-tab-<sessionId>`,
 * `terminal/session/<id>/tab`); this section keeps the host-owned half honest:
 * pane session records carry the broker session id verbatim (never invented,
 * never renamed), and session outcomes (exited/failed) project as typed rows
 * with designed messages. Host error strings and exit codes never reach
 * visible text; the typed code travels in a data attribute only.
 */

/** Closed session-id grammar, mirroring the broker adapter. */
export const TERMINAL_SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Closed host `copyText` grammar (MVUI29c lane T): the host accepts only
 * this shape and refuses anything else with `ERR_CLIPBOARD_INVALID`. The
 * renderer checks the same pattern before calling, so the typed code is
 * projected without a host round-trip.
 */
export const TERMINAL_COPYTEXT_TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Typed session-outcome codes surfaced as designed rows. */
export const TERMINAL_SESSION_OUTCOMES = Object.freeze({
  EXITED: 'TERMINAL_SESSION_EXITED',
  FAILED: 'TERMINAL_SESSION_FAILED',
});

/** Designed outcome messages. No host text, no codes, no ids in text. */
const TERMINAL_OUTCOME_MESSAGES = Object.freeze({
  exited: 'Session ended.',
  failed: 'Session ended unexpectedly.',
});

/**
 * @typedef {object} TerminalSessionOutcome
 * @property {'exited'|'failed'} type Normalized outcome.
 * @property {string} sessionId Affected session id (broker-issued).
 * @property {string} code Typed outcome code for data attributes.
 * @property {string} message Designed visible message (no raw host text).
 * @property {'info'|'error'} tone Row tone: info renders status, error alert.
 */

/**
 * Normalizes one pump/exit event into a typed outcome row. Unknown shapes fail
 * closed to `failed`; nothing from the host reaches the message.
 *
 * @param {unknown} outcome Pump event (`{type:'exited'|'failed',sessionId}`)
 * or facade exit (`{session}`).
 * @returns {TerminalSessionOutcome} Typed outcome.
 */
export function normalizeTerminalOutcome(outcome) {
  const record =
    outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome)
      ? /** @type {Record<string, unknown>} */ (outcome)
      : {};
  const rawType = record.type;
  const rawSession = record.sessionId ?? record.session;
  const type = rawType === 'exited' ? 'exited' : 'failed';
  const sessionId = typeof rawSession === 'string' ? rawSession : '';
  return {
    type,
    sessionId,
    code:
      type === 'exited'
        ? TERMINAL_SESSION_OUTCOMES.EXITED
        : TERMINAL_SESSION_OUTCOMES.FAILED,
    message: type === 'exited' ? TERMINAL_OUTCOME_MESSAGES.exited : TERMINAL_OUTCOME_MESSAGES.failed,
    tone: type === 'exited' ? 'info' : 'error',
  };
}

/**
 * @typedef {object} TerminalPaneSessionRecord
 * @property {string} sessionId Broker session id, verbatim.
 * @property {string} title Carried title, else the raw session id (never invented).
 * @property {string} kind Session kind, else ''.
 * @property {'unknown'} activity Fresh records start unknown; outcomes arrive via events.
 */

/**
 * Builds one terminal-pane session record from an attached broker session. The
 * id is carried verbatim so kit tabs keep stable ids/anchors per session.
 *
 * @param {string} sessionId Attached broker session id.
 * @param {{ title?: unknown, kind?: unknown } | null | undefined} item Attachment record.
 * @returns {TerminalPaneSessionRecord} Pane record.
 */
export function toPaneSession(sessionId, item) {
  const title = typeof item?.title === 'string' ? item.title : sessionId;
  const kind = typeof item?.kind === 'string' ? item.kind : '';
  return { sessionId, title, kind, activity: 'unknown' };
}

/**
 * Stable DOM ids and semantic anchors for the multislot lifecycle rows of one
 * capsule slot. Deterministic derivations of the capsule id; no randomness.
 *
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {{ pending: string, pendingAnchor: string, notice: string, noticeAnchor: string, noticeDismiss: string, noticeDismissAnchor: string }}
 */
export function terminalLifecycleRefs(capsuleId) {
  const id = typeof capsuleId === 'string' ? capsuleId : '';
  return {
    pending: `mv-multislot-${id}-launch-pending`,
    pendingAnchor: `capsule/${id}/launch-pending`,
    notice: `mv-multislot-${id}-session-notice`,
    noticeAnchor: `capsule/${id}/session-notice`,
    noticeDismiss: `mv-multislot-${id}-session-notice-dismiss`,
    noticeDismissAnchor: `capsule/${id}/session-notice-dismiss`,
  };
}

/**
 * Fixed-API session transport (lane T, MVUI29b): the renderer port for the
 * host terminal methods on `window.metaviewer.sideTerminal`. `attach`
 * returns the session MessagePort that carries the terminalClient wire, so
 * writes, acks, data and exit all travel on that port and NO separate
 * write/ack/onData/onExit host methods exist. `resize`/`close`/`copyText`
 * resolve literal `true`; `listProviders` resolves
 * `{entries:[{id,label,hint}],capabilities:[{id,available,reason}]}` with
 * `shell` always present. Pure adapter: no DOM, no framework, no host
 * calls. The injected source keeps its receiver; an absent method means the
 * host path is unavailable (capability flags below), never an exception.
 * Present-but-not-callable methods throw, so a malformed injection fails
 * fast instead of degrading into a silent half-session.
 */

/** Fixed-API methods admitted on the injected source. */
export const TERMINAL_TRANSPORT_METHODS = Object.freeze([
  'attach',
  'resize',
  'close',
  'listProviders',
  'copyText',
]);

/**
 * @typedef {object} TerminalProviderListing
 * @property {readonly {id:string,label:string,hint:string}[]} entries Reference-only provider rows.
 * @property {readonly {id:string,available:boolean,reason:string}[]} capabilities Host-reported availability per id.
 */

/**
 * @typedef {object} TerminalSessionTransport
 * @property {true} available The source passed validation.
 * @property {boolean} canAttach attach({session}) -> {port} is available.
 * @property {boolean} canResize resize({session,cols,rows}) -> true is available.
 * @property {boolean} canClose close({session}) -> true is available.
 * @property {boolean} canListProviders listProviders() is available.
 * @property {boolean} canCopy copyText({text}) -> true is available.
 * @property {((request:{session:string})=>Promise<Record<string, any>>)|undefined} [attach]
 * @property {((size:{session:string,cols:number,rows:number})=>Promise<true>)|undefined} [resize]
 * @property {((request:{session:string})=>Promise<true>)|undefined} [close]
 * @property {(()=>Promise<TerminalProviderListing>)|undefined} [listProviders]
 * @property {((request:{text:string})=>Promise<true>)|undefined} [copyText]
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isTransportRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates an injected fixed-API source and binds its methods with their
 * receiver. Request shapes and reply shapes are checked so a malformed
 * host reply fails here instead of corrupting the pump. Acknowledgements
 * are literal `true`, never truthy coercions.
 *
 * @param {unknown} source Injected fixed-API source, or null when the host
 * offers no session transport.
 * @returns {TerminalSessionTransport|null} Frozen transport, or null.
 */
export function createSessionTransport(source) {
  if (source === null || source === undefined) return null;
  if (!isTransportRecord(source) && typeof source !== 'function') {
    throw new TypeError('Terminal session transport must be an object');
  }
  const holder = /** @type {Record<string, any>} */ (/** @type {unknown} */ (source));
  for (const name of TERMINAL_TRANSPORT_METHODS) {
    const candidate = holder[name];
    if (candidate !== undefined && candidate !== null && typeof candidate !== 'function') {
      throw new TypeError(`Terminal session transport.${name} must be a function`);
    }
  }
  /** @type {Record<string, any>} */
  const bound = {};
  for (const name of TERMINAL_TRANSPORT_METHODS) {
    if (typeof holder[name] === 'function') bound[name] = holder[name].bind(holder);
  }
  const has = (/** @type {string} */ name) => typeof bound[name] === 'function';
  /** @type {TerminalSessionTransport} */
  const transport = {
    available: true,
    canAttach: has('attach'),
    canResize: has('resize'),
    canClose: has('close'),
    canListProviders: has('listProviders'),
    canCopy: has('copyText'),
  };
  if (has('attach')) {
    transport.attach = async (/** @type {{session:string}} */ request) => {
      if (!isTransportRecord(request) || typeof request.session !== 'string'
          || !TERMINAL_SESSION_ID_RE.test(request.session)) {
        throw new Error('Terminal session unavailable');
      }
      const reply = await bound.attach({ session: request.session });
      const port = isTransportRecord(reply) ? reply.port : undefined;
      if (port === null || port === undefined || typeof port !== 'object'
          || typeof port.postMessage !== 'function') {
        throw new Error('Terminal session unavailable');
      }
      return Object.freeze({ ...reply });
    };
  }
  if (has('resize')) {
    transport.resize = async (/** @type {{session:string,cols:number,rows:number}} */ size) => {
      if (!isTransportRecord(size) || typeof size.session !== 'string'
          || !TERMINAL_SESSION_ID_RE.test(size.session)
          || !Number.isSafeInteger(size.cols) || !Number.isSafeInteger(size.rows)) {
        throw new Error('Terminal session unavailable');
      }
      const outcome = await bound.resize({ session: size.session, cols: size.cols, rows: size.rows });
      if (outcome !== true) throw new Error('Terminal session unavailable');
      return true;
    };
  }
  if (has('close')) {
    transport.close = async (/** @type {{session:string}} */ request) => {
      if (!isTransportRecord(request) || typeof request.session !== 'string'
          || !TERMINAL_SESSION_ID_RE.test(request.session)) {
        throw new Error('Terminal session unavailable');
      }
      const outcome = await bound.close({ session: request.session });
      if (outcome !== true) throw new Error('Terminal session unavailable');
      return true;
    };
  }
  if (has('listProviders')) {
    transport.listProviders = async () => {
      const reply = await bound.listProviders();
      if (!isTransportRecord(reply) || !Array.isArray(reply.entries) || !Array.isArray(reply.capabilities)) {
        throw new Error('Terminal providers unavailable');
      }
      /** @type {Array<{id:string,label:string,hint:string}>} */
      const entries = [];
      for (const entry of reply.entries) {
        if (!isTransportRecord(entry) || typeof entry.id !== 'string'
            || typeof entry.label !== 'string' || typeof entry.hint !== 'string') {
          throw new Error('Terminal providers unavailable');
        }
        entries.push(Object.freeze({ id: entry.id, label: entry.label, hint: entry.hint }));
      }
      /** @type {Array<{id:string,available:boolean,reason:string}>} */
      const capabilities = [];
      for (const capability of reply.capabilities) {
        if (!isTransportRecord(capability) || typeof capability.id !== 'string'
            || typeof capability.available !== 'boolean' || typeof capability.reason !== 'string') {
          throw new Error('Terminal providers unavailable');
        }
        capabilities.push(Object.freeze({
          id: capability.id, available: capability.available, reason: capability.reason,
        }));
      }
      // The host guarantees `shell` in capabilities; the renderer menu
      // prepends the shell row unconditionally, so the menu invariant holds
      // even if a host omits it. Nothing is invented here.
      return Object.freeze({
        entries: Object.freeze(entries),
        capabilities: Object.freeze(capabilities),
      });
    };
  }
  if (has('copyText')) {
    transport.copyText = async (/** @type {{text:string}} */ request) => {
      if (!isTransportRecord(request) || typeof request.text !== 'string') {
        throw new Error('Terminal clipboard unavailable');
      }
      // MVUI29c lane T: the renderer checks the host grammar before
      // calling; off-grammar text projects the host's typed code, never a
      // round-trip and never visible text.
      if (!TERMINAL_COPYTEXT_TEXT_RE.test(request.text)) {
        throw new Error('Terminal clipboard refused: ERR_CLIPBOARD_INVALID');
      }
      const outcome = await bound.copyText({ text: request.text });
      if (outcome !== true) throw new Error('Terminal clipboard unavailable');
      return true;
    };
  }
  return Object.freeze(transport);
}

/**
 * Adapts an attachable session transport to the pump facade shape
 * (`{onData,onExit,write,ack,resize,close}`), one facade feeding every
 * transport-backed session of a slot. Each session attaches once through
 * `transport.attach({session})`; the returned port carries the
 * terminalClient wire, so writes, acks, data and exit all travel on that
 * port. Frame, credit and exit projection mirror
 * `createSideTerminalFacade` per session id. Requires `canAttach`;
 * `resize` throws a typed error and `close` degrades to a local detach
 * when the host omits those methods.
 *
 * @param {{transport: TerminalSessionTransport|null|undefined}} options
 * @returns {{attach:(request:{session:string})=>Promise<{session:string}>,onData:(receive:(frame:any)=>void)=>()=>void,onExit:(receive:(event:any)=>void)=>()=>void,write:(input:{session:string,bytes:number[]})=>void,ack:(credit:{session:string,seq:number,bytes:number})=>void,resize:(size:{session:string,cols:number,rows:number})=>Promise<true>,close:(request:{session:string})=>void,dispose:()=>void}}
 */
export function createPortSessionFacade({ transport }) {
  if (!transport || transport.available !== true || transport.canAttach !== true
      || typeof transport.attach !== 'function') {
    throw new TypeError('createPortSessionFacade requires an attachable session transport');
  }
  const attachFn = transport.attach;
  /** @type {Set<(frame:any)=>void>} */
  const dataListeners = new Set();
  /** @type {Set<(event:any)=>void>} */
  const exitListeners = new Set();
  /**
   * @typedef {object} PortSessionEntry
   * @property {unknown} port Attached session port.
   * @property {ReturnType<typeof createTerminalClient>|null} client Client bound to the port.
   * @property {number} seq Last delivered output sequence.
   * @property {number} bytes Cumulative output bytes.
   * @property {Map<number,{done:()=>void,bytes:number}>} pending Unacknowledged output credits.
   * @property {Uint8Array[]} queue Inputs held while the port attaches.
   * @property {Promise<void>|null} attaching In-flight attach, if any.
   */
  /** @type {Map<string, PortSessionEntry>} */
  const sessions = new Map();
  let disposed = false;
  /**
   * @param {unknown} session
   * @returns {string} Validated session id.
   */
  function requireSession(session) {
    if (typeof session !== 'string' || !TERMINAL_SESSION_ID_RE.test(session)) {
      throw new Error('Terminal session unavailable');
    }
    return session;
  }
  /**
   * @param {string} id
   * @returns {PortSessionEntry} Live entry for the session.
   */
  function entryFor(id) {
    let entry = sessions.get(id);
    if (!entry) {
      entry = { port: null, client: null, seq: 0, bytes: 0, pending: new Map(), queue: [], attaching: null };
      sessions.set(id, entry);
    }
    return entry;
  }
  /**
   * @param {{session:string,seq:number,bytes:number[],byteLength:number}} frame
   */
  function emitData(frame) {
    if (disposed) return;
    for (const receive of [...dataListeners]) receive(frame);
  }
  /**
   * @param {string} id
   * @param {unknown} reason
   */
  function emitExit(id, reason) {
    if (disposed) return;
    const event = { session: id, reason };
    for (const receive of [...exitListeners]) receive(event);
  }
  /**
   * Best-effort port shutdown. Real session ports carry `close`; doubles
   * without one simply detach through the client above.
   * @param {unknown} port
   */
  function closePortLike(port) {
    if (port === null || port === undefined) return;
    if (typeof port !== 'object' && typeof port !== 'function') return;
    const candidate = /** @type {{ close?: unknown }} */ (port).close;
    if (typeof candidate !== 'function') return;
    try {
      /** @type {() => void} */ (candidate).call(port);
    } catch {
      // Port teardown is best-effort; entry removal is authoritative.
    }
  }
  /**
   * @param {string} id
   */
  function release(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    try {
      entry.client?.dispose();
    } catch {
      // Client teardown is best-effort; removal here is authoritative.
    }
    closePortLike(entry.port);
  }
  /**
   * Attaches the session port on first use. A failed attach drops the
   * entry and emits one exit so a pump-registered session projects its
   * typed outcome; unregistered ids are ignored downstream. A session
   * closed while its attach is in flight keeps the deletion close()
   * performed: the late port is closed and no exit is emitted for it.
   * @param {string} id
   * @returns {Promise<void>} Resolves once the client is bound.
   */
  async function ensureAttached(id) {
    if (disposed) throw new Error('Terminal session unavailable');
    const entry = entryFor(id);
    if (entry.client) return;
    if (!entry.attaching) {
      entry.attaching = (async () => {
        try {
          const reply = await attachFn({ session: id });
          if (disposed || sessions.get(id) !== entry) {
            closePortLike(reply?.port);
            throw new Error('Terminal session unavailable');
          }
          entry.port = reply.port;
          entry.client = createTerminalClient({
            session: id,
            port: reply.port,
            write(bytes, done) {
              if (disposed || sessions.get(id) !== entry) return;
              entry.seq += 1;
              entry.bytes += bytes.length;
              entry.pending.set(entry.seq, { done, bytes: entry.bytes });
              emitData({ session: id, seq: entry.seq, bytes: Array.from(bytes), byteLength: bytes.length });
            },
            onStatus(status) {
              release(id);
              emitExit(id, status);
            },
          });
          for (const queued of entry.queue.splice(0)) {
            try {
              entry.client.input(queued);
            } catch {
              // Queued input is best-effort; the session stays attached.
            }
          }
        } catch (error) {
          // Only a still-registered entry drops and emits here; a session
          // closed mid-attach already left the map and stays exit-free.
          if (sessions.get(id) === entry) {
            sessions.delete(id);
            emitExit(id, 'Terminal session unavailable');
          }
          throw error;
        }
      })();
    }
    return entry.attaching;
  }
  return {
    /**
     * @param {{session:string}} request
     * @returns {Promise<{session:string}>} Attached session id.
     */
    async attach(request) {
      const id = requireSession(request?.session);
      if (disposed) throw new Error('Terminal session unavailable');
      await ensureAttached(id);
      return Object.freeze({ session: id });
    },
    /** @param {(frame:any)=>void} receive */
    onData(receive) {
      if (typeof receive !== 'function') throw new TypeError('Terminal listener must be a function');
      if (disposed) return () => {};
      dataListeners.add(receive);
      return () => { dataListeners.delete(receive); };
    },
    /** @param {(event:any)=>void} receive */
    onExit(receive) {
      if (typeof receive !== 'function') throw new TypeError('Terminal listener must be a function');
      if (disposed) return () => {};
      exitListeners.add(receive);
      return () => { exitListeners.delete(receive); };
    },
    /** @param {{session:string,bytes:number[]}} input */
    write(input) {
      const id = requireSession(input?.session);
      if (disposed) throw new Error('Terminal session unavailable');
      if (!Array.isArray(input.bytes)) throw new Error('Terminal session unavailable');
      const bytes = Uint8Array.from(input.bytes);
      const entry = entryFor(id);
      if (entry.client) {
        entry.client.input(bytes);
        return;
      }
      entry.queue.push(bytes);
      void ensureAttached(id).catch(() => {});
    },
    /** @param {{session:string,seq:number,bytes:number}} credit */
    ack(credit) {
      const id = requireSession(credit?.session);
      if (disposed) throw new Error('Terminal session unavailable');
      const entry = sessions.get(id);
      const item = entry?.pending.get(credit.seq);
      if (!entry || !item || item.bytes !== credit.bytes) throw new Error('Terminal credit refused');
      for (const [index, row] of entry.pending) {
        if (index <= credit.seq) { row.done(); entry.pending.delete(index); }
      }
    },
    /** @param {{session:string,cols:number,rows:number}} size */
    resize(size) {
      const id = requireSession(size?.session);
      if (disposed) throw new Error('Terminal session unavailable');
      const resizeFn = transport.resize;
      if (typeof resizeFn !== 'function') throw new Error('Terminal session unavailable');
      if (!Number.isSafeInteger(size.cols) || !Number.isSafeInteger(size.rows)) {
        throw new Error('Terminal session unavailable');
      }
      return resizeFn({ session: id, cols: size.cols, rows: size.rows });
    },
    /** @param {{session:string}} request */
    close(request) {
      if (typeof request?.session !== 'string' || !TERMINAL_SESSION_ID_RE.test(request.session)) return;
      release(request.session);
      const closeFn = transport.close;
      if (typeof closeFn !== 'function') return;
      try {
        const outcome = closeFn({ session: request.session });
        if (outcome !== null && (typeof outcome === 'object' || typeof outcome === 'function')
            && typeof /** @type {{catch?:unknown}} */ (outcome).catch === 'function') {
          /** @type {Promise<unknown>} */ (outcome).catch(() => {});
        }
      } catch {
        // Detach is best-effort; removal from the pump is authoritative.
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...sessions.keys()]) release(id);
      dataListeners.clear();
      exitListeners.clear();
    },
  };
}
