// MVUI29d lane T: attach/register ordering. No data or exit event from a
// freshly attached port may be emitted before the session is registered in
// the multislot: the slot registers first, then binds the port. Host
// doubles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHost, flush, nodes } from './mvui16-harness.mjs';

/**
 * MessagePort double; optionally fires one frame the moment the client
 * subscribes, modelling a host that delivers inside the attach window.
 */
function makePort({ prime = null } = {}) {
  /** @type {Map<string, Set<(event: { data: unknown }) => void>>} */
  const listeners = new Map();
  const posted = [];
  let primed = false;
  const port = {
    /** @param {unknown} message */
    postMessage(message) { posted.push(message); },
    /** @param {string} type @param {(event: { data: unknown }) => void} receive */
    addEventListener(type, receive) {
      if (typeof receive !== 'function') return;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(receive);
      if (type === 'message' && prime && !primed) {
        primed = true;
        receive({ data: prime });
      }
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
function makeTransport({ session, prime = null } = {}) {
  const calls = [];
  /** @type {Map<string, ReturnType<typeof makePort>>} */
  const ports = new Map();
  return {
    calls,
    ports,
    source: {
      attach: async ({ session: id }) => {
        calls.push(['attach', id]);
        const entry = makePort({ prime: prime && id === session ? { ...prime, session: id } : null });
        ports.set(id, entry);
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

test('a frame arriving during the attach window is delivered, not dropped', async () => {
  const session = 'term-90';
  const transport = makeTransport({ session, prime: { seq: 1, bytes: Uint8Array.from([65]) } });
  const broker = makeBroker(session);
  const f = await mountHost({
    capsuleId: 'cap-01',
    terminalBroker: broker.port,
    terminalSessionPort: transport.source,
    brokerCommands: ['shell', 'provider'],
    inputMode: 'write',
  });
  try {
    await flush();
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [], title: '', kind: '' });
    await flush();
    await flush();
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), [session]);
    const entry = transport.ports.get(session);
    assert.ok(entry, 'transport attach ran');
    assert.deepEqual(entry.posted, [{ session, ack: 1, bytes: 1 }]);
  } finally {
    f.app.unmount();
  }
});

test('an exit landing during the bind keeps its notice and shows no ghost', async () => {
  const session = 'term-91';
  const transport = makeTransport({ session, prime: { exitCode: 0 } });
  const broker = makeBroker(session);
  const f = await mountHost({
    capsuleId: 'cap-01',
    terminalBroker: broker.port,
    terminalSessionPort: transport.source,
    brokerCommands: ['shell', 'provider'],
    inputMode: 'write',
  });
  try {
    await flush();
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [], title: '', kind: '' });
    await flush();
    await flush();
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions, []);
    const notice = nodes(f.root).find((n) => n.props?.id === 'mv-multislot-cap-01-session-notice');
    assert.ok(notice, 'typed exit notice projected');
    assert.equal(notice.props['data-outcome-code'], 'TERMINAL_SESSION_EXITED');
    const alerts = nodes(f.root).filter((n) => n.props?.role === 'alert');
    assert.deepEqual(alerts, [], 'no launch refusal alongside the notice');
  } finally {
    f.app.unmount();
  }
});

test('a quiet port launches with no spurious traffic (negative control)', async () => {
  const session = 'term-92';
  const transport = makeTransport({ session });
  const broker = makeBroker(session);
  const f = await mountHost({
    capsuleId: 'cap-01',
    terminalBroker: broker.port,
    terminalSessionPort: transport.source,
    brokerCommands: ['shell', 'provider'],
    inputMode: 'write',
  });
  try {
    await flush();
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [], title: '', kind: '' });
    await flush();
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), [session]);
    assert.equal(f.children.slot.attrs['attachment-state'], 'live');
    assert.deepEqual(transport.ports.get(session).posted, []);
  } finally {
    f.app.unmount();
  }
});
