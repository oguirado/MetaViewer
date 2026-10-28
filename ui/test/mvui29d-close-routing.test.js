// MVUI29d lane T: close routing. Closing a session closes it only through
// the pump/facade that owns it; the other transport never sees the close.
// Host doubles only; the pump module is wrapped to record close routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import {
  compileSfc,
  mountComponent,
  childStub,
  flush,
  SidebarIcon,
  UiButton,
} from './mvui16-harness.mjs';
import * as gate from '../src/multislot/multislotInputGate.js';
import * as attach from '../src/multislot/multislotAttach.js';
import * as providers from '../src/multislot/multislotProviders.js';
import * as copy from '../src/multislot/multislotCopy.js';
import * as facade from '../src/terminal/sideTerminalFacade.js';

/** Quiet MessagePort double. */
function makePort() {
  /** @type {Map<string, Set<(event: { data: unknown }) => void>>} */
  const listeners = new Map();
  const posted = [];
  const port = {
    /** @param {unknown} message */
    postMessage(message) { posted.push(message); },
    /** @param {string} type @param {(event: { data: unknown }) => void} receive */
    addEventListener(type, receive) {
      if (typeof receive !== 'function') return;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(receive);
    },
    /** @param {string} type @param {(event: { data: unknown }) => void} receive */
    removeEventListener(type, receive) {
      listeners.get(type)?.delete(receive);
    },
    start() {},
    close() {},
  };
  return { port, posted };
}

/** Fixed-API transport double with per-session ports. */
function makeTransport() {
  const calls = [];
  /** @type {Map<string, ReturnType<typeof makePort>>} */
  const ports = new Map();
  return {
    calls,
    ports,
    source: {
      attach: async ({ session }) => {
        calls.push(['attach', session]);
        const entry = makePort();
        ports.set(session, entry);
        return { port: entry.port };
      },
      resize: async (size) => { calls.push(['resize', size]); return true; },
      close: async (request) => { calls.push(['close', request]); return true; },
      listProviders: async () => {
        calls.push(['listProviders']);
        return { entries: [], capabilities: [] };
      },
      copyText: async (request) => { calls.push(['copyText', request]); return true; },
    },
  };
}

/** Broker double without opt-in: already authorized, like an enabled host. */
function makeBroker(session) {
  const calls = [];
  return {
    calls,
    port: {
      open: async (spec) => { calls.push(['open', spec]); return { session }; },
      close: (request) => { calls.push(['close', request]); },
    },
  };
}

/**
 * Mounts MultislotHost with the real modules except a close-recording
 * pump wrapper. The binding facade carries `capabilities`; the port
 * facade does not, which tells the pumps apart.
 */
async function mountWithCloseSpy(initial = {}) {
  const children = {};
  const closeCalls = [];
  const stub = vue.defineComponent({ setup: () => () => vue.h('div') });
  const spiedAttach = {
    ...attach,
    createMultislotPump(options) {
      const pump = attach.createMultislotPump(options);
      const owner = typeof options.facade?.capabilities === 'function' ? 'binding' : 'transport';
      return {
        ...pump,
        closeSession(sessionId) {
          closeCalls.push([owner, sessionId]);
          return pump.closeSession(sessionId);
        },
      };
    },
  };
  const Host = await compileSfc('multislot/MultislotHost.vue', {
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
    '@xterm/xterm': { Terminal: class {} },
    '@xterm/addon-fit': { FitAddon: class {} },
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) },
    '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue': childStub('slot', children),
    '/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue': childStub('bar', children),
    'capsule-ui-kit/TerminalView': {
      createStreamRegistry: () => ({
        createSession() {},
        beginAttach() {},
        applyRestoreSnapshot() {},
        setControlLease() {},
        writeOutputChunk() {},
        disposeSession() {},
        forgetSession() {},
      }),
    },
    '../terminal/BrokerLaunchControls.vue': stub,
    '../terminal/sideTerminalFacade.js': facade,
    './multislotInputGate.js': gate,
    './multislotAttach.js': spiedAttach,
    './multislotProviders.js': providers,
    './multislotCopy.js': copy,
  });
  const f = mountComponent(Host, {
    capsuleId: 'cap-01',
    inputMode: 'write',
    measureSlotBox: () => ({ x: 10, y: 20, width: 300, height: 200 }),
    onSubmitIntent: () => {},
    ...initial,
  });
  await flush();
  return { ...f, children, closeCalls };
}

test('close reaches only the owning pump', async () => {
  const binding = makePort();
  const transport = makeTransport();
  const broker = makeBroker('term-21');
  const closed = [];
  const f = await mountWithCloseSpy({
    terminalBinding: { session: 'term-20', port: binding.port },
    terminalBroker: broker.port,
    terminalSessionPort: transport.source,
    brokerCommands: ['shell', 'provider'],
    'onClose-session': (payload) => closed.push(payload),
  });
  try {
    await flush();
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [], title: '', kind: '' });
    await flush();
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), ['term-20', 'term-21']);
    f.closeCalls.length = 0;
    f.children.slot.emit('close-session', { sessionId: 'term-21' });
    await flush();
    assert.deepEqual(f.closeCalls, [['transport', 'term-21']]);
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), ['term-20']);
    assert.ok(transport.calls.some(([method]) => method === 'close'), 'transport close called');
    f.children.slot.emit('close-session', { sessionId: 'term-20' });
    await flush();
    assert.deepEqual(f.closeCalls, [['transport', 'term-21'], ['binding', 'term-20']]);
    assert.deepEqual(f.children.slot.attrs.sessions, []);
    assert.deepEqual(closed, [{ sessionId: 'term-21' }, { sessionId: 'term-20' }]);
  } finally {
    f.app.unmount();
  }
});

test('closing an unknown session leaves the slot unchanged (negative control)', async () => {
  const binding = makePort();
  const closed = [];
  const f = await mountWithCloseSpy({
    terminalBinding: { session: 'term-20', port: binding.port },
    'onClose-session': (payload) => closed.push(payload),
  });
  try {
    await flush();
    f.children.slot.emit('close-session', { sessionId: 'ghost' });
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), ['term-20']);
    assert.equal(f.children.slot.attrs['attachment-state'], 'live');
    assert.deepEqual(closed, [{ sessionId: 'ghost' }]);
  } finally {
    f.app.unmount();
  }
});
