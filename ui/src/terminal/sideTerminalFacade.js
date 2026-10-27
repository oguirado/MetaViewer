/** [TARGET, unit decision] Adapt an injected, already-authorized session port
 * to the kit overlay. No launch capability exists in this handoff. Close only
 * detaches this view; host session ownership and process lifetime stay host-side.
 * The existing client remains the sequence/credit and malformed-frame boundary. */
import { reactive, toRaw } from 'vue';
import { createTerminalClient } from './terminalClient.js';

/** @param {{session:string,port:MessagePort}} binding */
export function createSideTerminalFacade({ session, port }) {
  if (!session || !port || typeof port.postMessage !== 'function') throw new Error('Invalid terminal binding');
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
