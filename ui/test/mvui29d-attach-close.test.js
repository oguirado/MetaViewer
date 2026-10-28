// MVUI29d lane T: close during in-flight attach. The late attach reply's
// port is closed and released, and no exit event is emitted for the
// already-closed session. Doubles at the host boundary only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPortSessionFacade,
  createSessionTransport,
} from '../src/terminal/sideTerminalFacade.js';

/** MessagePort double with harness-driven delivery and close recording. */
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

/** Fixed-API source whose attach hangs until released. */
function deferredSource(over = {}) {
  const calls = [];
  let releaseAttach = null;
  const gate = new Promise((resolve) => { releaseAttach = resolve; });
  const entry = makePort();
  return {
    calls,
    entry,
    releaseAttach,
    source: {
      attach: async ({ session }) => {
        calls.push(['attach', session]);
        await gate;
        return { port: entry.port };
      },
      resize: async (size) => { calls.push(['resize', size]); return true; },
      close: async (request) => { calls.push(['close', request]); return true; },
      listProviders: async () => {
        calls.push(['listProviders']);
        return { entries: [], capabilities: [] };
      },
      copyText: async (request) => { calls.push(['copyText', request]); return true; },
      ...over,
    },
  };
}

test('close during in-flight attach closes the late port and emits no exit', async () => {
  const { source, calls, entry, releaseAttach } = deferredSource();
  const facade = createPortSessionFacade({ transport: createSessionTransport(source) });
  const exits = [];
  facade.onExit((event) => exits.push(event));
  try {
    const attaching = facade.attach({ session: 's9' });
    facade.close({ session: 's9' });
    releaseAttach();
    await assert.rejects(attaching, /Terminal session unavailable/);
    assert.deepEqual(entry.closed, ['close']);
    assert.deepEqual(exits, []);
    assert.ok(calls.some(([method]) => method === 'close'), 'close reaches the transport');
    entry.deliver({ session: 's9', seq: 1, bytes: Uint8Array.from([65]) });
    assert.deepEqual(exits, [], 'the late port stays detached');
  } finally {
    facade.dispose();
  }
});

test('a failed attach without close still emits exactly one exit (negative control)', async () => {
  const { source } = deferredSource({
    attach: async () => { throw new Error('TERMINAL_UNKNOWN_SESSION'); },
  });
  const facade = createPortSessionFacade({ transport: createSessionTransport(source) });
  const exits = [];
  facade.onExit((event) => exits.push(event));
  try {
    await assert.rejects(facade.attach({ session: 'ghost' }), /TERMINAL_UNKNOWN_SESSION/);
    assert.deepEqual(exits, [{ session: 'ghost', reason: 'Terminal session unavailable' }]);
  } finally {
    facade.dispose();
  }
});
