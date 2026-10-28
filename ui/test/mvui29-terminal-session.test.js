// MVUI29c lane T: fixed-API session transport and port facade. The host
// surface is exactly attach/resize/close/listProviders/copyText: no
// separate write/ack/onData/onExit host methods. Doubles sit at the host
// boundary only; every behaviour below has a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL_COPYTEXT_TEXT_RE,
  TERMINAL_TRANSPORT_METHODS,
  createPortSessionFacade,
  createSessionTransport,
} from '../src/terminal/sideTerminalFacade.js';

/** Minimal MessagePort double with harness-driven delivery. */
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
  };
  return {
    port,
    posted,
    /** @param {unknown} data */
    deliver(data) {
      for (const receive of [...(listeners.get('message') ?? [])]) receive({ data });
    },
  };
}

function fullSource(over = {}) {
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
      ...over,
    },
  };
}

test('the host surface is exactly the five fixed methods (negative: no IO methods)', () => {
  assert.deepEqual([...TERMINAL_TRANSPORT_METHODS], [
    'attach',
    'resize',
    'close',
    'listProviders',
    'copyText',
  ]);
  const transport = createSessionTransport(fullSource({
    write: async () => true,
    ack: async () => true,
    onData: () => () => {},
    onExit: () => () => {},
  }).source);
  assert.equal(transport.write, undefined);
  assert.equal(transport.ack, undefined);
  assert.equal(transport.onData, undefined);
  assert.equal(transport.onExit, undefined);
});

test('null source yields null transport; non-objects and non-function methods throw', () => {
  assert.equal(createSessionTransport(null), null);
  assert.equal(createSessionTransport(undefined), null);
  for (const bad of [42, 'x', [], true]) {
    assert.throws(() => createSessionTransport(bad), TypeError);
  }
  assert.throws(() => createSessionTransport({ attach: 42 }), /transport\.attach must be a function/);
  assert.throws(() => createSessionTransport({ copyText: 'x' }), /transport\.copyText must be a function/);
  const { source } = fullSource();
  const transport = createSessionTransport(source);
  assert.equal(transport.available, true);
  assert.ok(Object.isFrozen(transport));
});

test('capability flags mirror the present methods; absent methods stay undefined', () => {
  const resize = async () => true;
  const transport = createSessionTransport({ resize });
  assert.equal(transport.canResize, true);
  assert.equal(transport.canAttach, false);
  assert.equal(transport.canClose, false);
  assert.equal(transport.canListProviders, false);
  assert.equal(transport.canCopy, false);
  assert.equal(transport.attach, undefined);
  assert.equal(transport.close, undefined);
  const full = createSessionTransport(fullSource().source);
  for (const name of TERMINAL_TRANSPORT_METHODS) {
    assert.equal(typeof full[name], 'function', name);
  }
  assert.equal(full.canAttach, true);
  assert.equal(full.canCopy, true);
});

test('methods keep their receiver and copy argument vectors', async () => {
  let receiver = null;
  const seen = [];
  const source = {
    attach(request) {
      receiver = this;
      seen.push(request);
      return { port: makePort().port };
    },
  };
  const transport = createSessionTransport(source);
  const input = { session: 's1' };
  await transport.attach(input);
  assert.equal(receiver, source);
  assert.deepEqual(seen, [{ session: 's1' }]);
  assert.notEqual(seen[0], input);
});

test('attach admits shaped replies and refuses malformed ones', async () => {
  const good = createSessionTransport(fullSource().source);
  const attached = await good.attach({ session: 's1' });
  assert.equal(typeof attached.port.postMessage, 'function');
  assert.ok(Object.isFrozen(attached));
  await assert.rejects(good.attach({ session: 'has space' }), /Terminal session unavailable/);
  await assert.rejects(good.attach(null), /Terminal session unavailable/);
  const badReply = createSessionTransport(fullSource({ attach: async () => ({ nope: 1 }) }).source);
  await assert.rejects(badReply.attach({ session: 's1' }), /Terminal session unavailable/);
  const badPort = createSessionTransport(fullSource({ attach: async () => ({ session: 's1', port: {} }) }).source);
  await assert.rejects(badPort.attach({ session: 's1' }), /Terminal session unavailable/);
  const nullReply = createSessionTransport(fullSource({ attach: async () => null }).source);
  await assert.rejects(nullReply.attach({ session: 's1' }), /Terminal session unavailable/);
});

test('resize and close resolve literal true and refuse anything else', async () => {
  const { source, calls } = fullSource();
  const good = createSessionTransport(source);
  assert.equal(await good.resize({ session: 's1', cols: 80, rows: 24 }), true);
  assert.equal(await good.close({ session: 's1' }), true);
  assert.deepEqual(calls[0], ['resize', { session: 's1', cols: 80, rows: 24 }]);
  assert.deepEqual(calls[1], ['close', { session: 's1' }]);
  await assert.rejects(good.resize({ session: 'bad id', cols: 80, rows: 24 }), /Terminal session unavailable/);
  await assert.rejects(good.resize({ session: 's1', cols: 1.5, rows: 24 }), /Terminal session unavailable/);
  await assert.rejects(good.close(null), /Terminal session unavailable/);
  for (const outcome of [1, 'yes', undefined, 0]) {
    const loose = createSessionTransport(fullSource({
      resize: async () => outcome,
      close: async () => outcome,
    }).source);
    await assert.rejects(loose.resize({ session: 's1', cols: 80, rows: 24 }), /Terminal session unavailable/);
    await assert.rejects(loose.close({ session: 's1' }), /Terminal session unavailable/);
  }
  const refused = createSessionTransport(fullSource({
    close: async () => { throw new Error('TERMINAL_UNKNOWN_SESSION'); },
  }).source);
  await assert.rejects(refused.close({ session: 'ghost' }), /TERMINAL_UNKNOWN_SESSION/);
});

test('listProviders projects reference-only rows and refuses malformed ones', async () => {
  const entries = [{ id: 'a', label: 'A', hint: '', argv: ['a'] }];
  const capabilities = [{ id: 'a', available: true, reason: '' }];
  const good = createSessionTransport(fullSource({ listProviders: async () => ({ entries, capabilities }) }).source);
  const listed = await good.listProviders();
  assert.deepEqual(listed.entries, [{ id: 'a', label: 'A', hint: '' }]);
  assert.deepEqual(listed.capabilities, capabilities);
  assert.ok(Object.isFrozen(listed));
  assert.ok(Object.isFrozen(listed.entries));
  for (const bad of [
    fullSource({ listProviders: async () => ({ entries: [] }) }).source,
    fullSource({ listProviders: async () => ({ entries: [], capabilities: [{ id: 'a' }] }) }).source,
    fullSource({ listProviders: async () => [] }).source,
    fullSource({ listProviders: async () => ({ entries: [{ id: 'a' }], capabilities: [] }) }).source,
  ]) {
    await assert.rejects(createSessionTransport(bad).listProviders(), /Terminal providers unavailable/);
  }
});

test('copyText checks the host grammar before calling (negative: host never sees it)', async () => {
  const { source, calls } = fullSource();
  const good = createSessionTransport(source);
  assert.equal(await good.copyText({ text: 'cap-01' }), true);
  assert.deepEqual(calls, [['copyText', { text: 'cap-01' }]]);
  assert.equal(TERMINAL_COPYTEXT_TEXT_RE.test('a'.repeat(128)), true);
  for (const bad of ['has space', 'cap/01', '', '-lead', 'x'.repeat(129)]) {
    assert.equal(TERMINAL_COPYTEXT_TEXT_RE.test(bad), false, bad);
    await assert.rejects(good.copyText({ text: bad }), /ERR_CLIPBOARD_INVALID/);
  }
  assert.equal(calls.length, 1, 'off-grammar text never reaches the host');
  await assert.rejects(good.copyText({ text: 42 }), /Terminal clipboard unavailable/);
  await assert.rejects(good.copyText(null), /Terminal clipboard unavailable/);
  const loose = createSessionTransport(fullSource({ copyText: async () => 1 }).source);
  await assert.rejects(loose.copyText({ text: 'cap-01' }), /Terminal clipboard unavailable/);
});

test('port facade requires an attachable transport', () => {
  assert.throws(() => createPortSessionFacade({ transport: null }), TypeError);
  assert.throws(
    () => createPortSessionFacade({ transport: createSessionTransport({ resize: async () => true }) }),
    TypeError,
  );
  const facade = createPortSessionFacade({ transport: createSessionTransport(fullSource().source) });
  for (const method of ['attach', 'onData', 'onExit', 'write', 'resize', 'ack', 'close', 'dispose']) {
    assert.equal(typeof facade[method], 'function', method);
  }
  facade.dispose();
});

test('port facade attach binds the wire; data, acks, input and exit route by session', async () => {
  const { source, calls, ports } = fullSource();
  const facade = createPortSessionFacade({ transport: createSessionTransport(source) });
  const frames = [];
  const exits = [];
  facade.onData((frame) => frames.push(frame));
  facade.onExit((event) => exits.push(event));
  try {
    assert.deepEqual(await facade.attach({ session: 's1' }), { session: 's1' });
    assert.deepEqual(calls[0], ['attach', 's1']);
    ports.get('s1').deliver({ session: 's1', seq: 1, bytes: Uint8Array.from([65]) });
    assert.deepEqual(frames, [{ session: 's1', seq: 1, bytes: [65], byteLength: 1 }]);
    facade.ack({ session: 's1', seq: 1, bytes: 1 });
    assert.deepEqual(ports.get('s1').posted, [{ session: 's1', ack: 1, bytes: 1 }]);
    facade.write({ session: 's1', bytes: [66] });
    assert.equal(ports.get('s1').posted.length, 2);
    assert.deepEqual(
      { session: ports.get('s1').posted[1].session, seq: ports.get('s1').posted[1].seq },
      { session: 's1', seq: 1 },
    );
    assert.deepEqual([...ports.get('s1').posted[1].bytes], [66]);
    ports.get('s1').deliver({ session: 's1', exitCode: 0 });
    assert.deepEqual(exits, [{ session: 's1', reason: 'Exited (0)' }]);
  } finally {
    facade.dispose();
  }
});

test('port facade validates ids and shapes at every entry (negative controls)', async () => {
  const facade = createPortSessionFacade({ transport: createSessionTransport(fullSource().source) });
  try {
    await assert.rejects(facade.attach({ session: 'bad id' }), /Terminal session unavailable/);
    await assert.rejects(facade.attach(null), /Terminal session unavailable/);
    assert.throws(() => facade.write({ session: 'bad id', bytes: [] }), /Terminal session unavailable/);
    assert.throws(() => facade.write({ session: 's1', bytes: 'x' }), /Terminal session unavailable/);
    assert.throws(() => facade.ack({ session: 's1', seq: 1, bytes: 1 }), /Terminal credit refused/);
    assert.throws(() => facade.resize({ session: 's1', cols: 1.5, rows: 24 }), /Terminal session unavailable/);
    assert.equal(await facade.resize({ session: 's1', cols: 80, rows: 24 }), true);
    const noResize = createPortSessionFacade({
      transport: createSessionTransport(fullSource({ resize: undefined }).source),
    });
    try {
      assert.throws(() => noResize.resize({ session: 's1', cols: 80, rows: 24 }), /Terminal session unavailable/);
    } finally {
      noResize.dispose();
    }
    assert.throws(() => facade.onData('x'), TypeError);
    assert.throws(() => facade.onExit('x'), TypeError);
  } finally {
    facade.dispose();
  }
});

test('port facade close detaches best-effort and dispose revokes listeners', async () => {
  const received = [];
  const { source, ports } = fullSource({ close: async () => { throw new Error('host gone'); } });
  const facade = createPortSessionFacade({ transport: createSessionTransport(source) });
  const offData = facade.onData((frame) => received.push(frame));
  await facade.attach({ session: 's1' });
  assert.doesNotThrow(() => facade.close({ session: 's1' }));
  facade.close({ session: 'bad id' });
  facade.close(null);
  offData();
  const offExit = facade.onExit(() => received.push('exit'));
  facade.dispose();
  offExit();
  ports.get('s1')?.deliver({ session: 's1', seq: 1, bytes: Uint8Array.from([65]) });
  assert.deepEqual(received, []);
  assert.throws(() => facade.write({ session: 's1', bytes: [] }), /Terminal session unavailable/);
  await assert.rejects(facade.attach({ session: 's2' }), /Terminal session unavailable/);
});

test('a failed attach drops the entry and emits one exit (negative control)', async () => {
  const facade = createPortSessionFacade({
    transport: createSessionTransport(fullSource({
      attach: async () => { throw new Error('TERMINAL_UNKNOWN_SESSION'); },
    }).source),
  });
  const exits = [];
  facade.onExit((event) => exits.push(event));
  try {
    await assert.rejects(facade.attach({ session: 'ghost' }), /TERMINAL_UNKNOWN_SESSION/);
    assert.deepEqual(exits, [{ session: 'ghost', reason: 'Terminal session unavailable' }]);
  } finally {
    facade.dispose();
  }
});
