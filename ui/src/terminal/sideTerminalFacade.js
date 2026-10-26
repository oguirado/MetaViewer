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
      return broker.open(spec);
    },
    /** Host owns process lifetime; close is forwarded only when supplied.
     * @param {{session:string}} request */
    close(request) { return broker.close?.(request); },
  };
  brokerFacades.set(broker, facade);
  return facade;
}
