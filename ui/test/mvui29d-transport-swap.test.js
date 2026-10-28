// MVUI29d lane T: transport replacement. When terminalSessionPort changes,
// the old lazy pump/facade dispose (closing their ports) and later launches
// use the new transport. Host doubles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHost, flush } from './mvui16-harness.mjs';

/** MessagePort double with close recording. */
function makePort() {
  /** @type {Map<string, Set<(event: { data: unknown }) => void>>} */
  const listeners = new Map();
  const posted = [];
  const closed = [];
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
    close() { closed.push('close'); },
  };
  return {
    port,
    posted,
    closed,
    /** @param {unknown} data */
    deliver(data) {
      for (const receive of [...(listeners.get('message') ?? [])]) receive({ data });
    },
  };
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

test('replacing the transport drops old sessions, closes old ports, uses the new one', async () => {
  const session = 'term-11';
  const first = makeTransport();
  const second = makeTransport();
  const broker = makeBroker(session);
  const f = await mountHost({
    capsuleId: 'cap-01',
    terminalBroker: broker.port,
    terminalSessionPort: first.source,
    brokerCommands: ['shell', 'provider'],
    inputMode: 'write',
  });
  try {
    await flush();
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [], title: '', kind: '' });
    await flush();
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), [session]);
    assert.deepEqual(first.calls.filter(([method]) => method === 'attach'), [['attach', session]]);
    f.props.terminalSessionPort = second.source;
    await flush();
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions, [], 'old transport sessions shed');
    assert.deepEqual(first.ports.get(session).closed, ['close'], 'old port closed');
    f.children.slot.emit('launch-request', { entryId: 'shell', command: 'shell', args: [], title: '', kind: '' });
    await flush();
    await flush();
    assert.deepEqual(second.calls.filter(([method]) => method === 'attach'), [['attach', session]]);
    assert.deepEqual(first.calls.filter(([method]) => method === 'attach').length, 1, 'old transport never reused');
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), [session]);
  } finally {
    f.app.unmount();
  }
});

test('a binding session survives a transport swap (negative control)', async () => {
  const binding = makePort();
  const first = makeTransport();
  const second = makeTransport();
  const f = await mountHost({
    capsuleId: 'cap-01',
    terminalBinding: { session: 'term-00', port: binding.port },
    terminalSessionPort: first.source,
    inputMode: 'write',
  });
  try {
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), ['term-00']);
    f.props.terminalSessionPort = second.source;
    await flush();
    await flush();
    assert.deepEqual(f.children.slot.attrs.sessions.map((s) => s.sessionId), ['term-00']);
    assert.equal(f.children.slot.attrs['attachment-state'], 'live');
  } finally {
    f.app.unmount();
  }
});
