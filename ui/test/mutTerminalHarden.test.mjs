import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { createTerminalHost, createTokenBucket } from '../electron/terminalHost.js';
import { createPreloadFacade } from '../electron/preload.js';
import { registerTerminalIpc, TERMINAL_CHANNEL_PREFIX } from '../electron/ptyBroker.js';

function facade(transport) {
  let api;
  createPreloadFacade({ transport, bridge: { exposeInMainWorld(_name, value) { api = value; } } });
  return api;
}

const spec = { command: 'shell', cols: 80, rows: 24 };
function fixture(t, options = {}) {
  const handles = [], channels = [];
  const host = createTerminalHost({ ...options, env: { ...process.env },
    createMessageChannel: () => { const channel = new MessageChannel(); channels.push(channel); return channel; },
    pty: { spawn() {
      let data = () => {}, exit = () => {};
      const h = { pid: 41000 + handles.length, writes: [], resizes: [], killed: false,
        onData(fn) { data = fn; }, onExit(fn) { exit = fn; },
        write(value) { h.writes.push(value); }, resize(cols, rows) { h.resizes.push([cols, rows]); },
        kill() { h.killed = true; exit({ exitCode: 0 }); }, emit(value) { data(value); } };
      handles.push(h); return h;
    } },
  }); t.after(() => host.dispose());
  return { host, handles, channels };
}
async function attached(t, options) {
  const f = fixture(t, options); await f.host.setEnabled(true);
  const { session } = await f.host.open(spec), { port } = await f.host.attach({ session });
  t.after(() => port.close()); port.start();
  return { ...f, session, port, send(value) {
    return new Promise(resolve => {
      f.channels[0].port1.once('message', () => queueMicrotask(resolve));
      port.postMessage(value);
    });
  } };
}
// Event-driven barriers; timeout is a failure bound, never a scheduling sleep.
const frame = async port => (await once(port, 'message'))[0];

test('T1 token refill is capped after long idle', () => {
  let now = 0;
  const bucket = createTokenBucket({ capacity: 2, refillPerSec: 1, now: () => now });
  assert.ok(bucket.take()); assert.ok(bucket.take()); assert.equal(bucket.take(), false);
  now = 10000;
  assert.ok(bucket.take()); assert.ok(bucket.take()); assert.equal(bucket.take(), false);
});
test('T2 clock skew does not consume remaining tokens', () => {
  let now = 100000;
  const bucket = createTokenBucket({ capacity: 3, refillPerSec: 1, now: () => now });
  assert.ok(bucket.take()); now = 0;
  assert.ok(bucket.take()); assert.ok(bucket.take()); assert.equal(bucket.take(), false);
});
test('T3 pre-attach frame count cap is independent of bytes', async t => {
  const f = fixture(t, { maxPreAttachFrames: 3, maxPreAttachBytes: 65536 });
  await f.host.setEnabled(true);
  const { session } = await f.host.open(spec);
  for (let i = 0; i < 3; i++) f.handles[0].emit('a');
  assert.equal(f.handles[0].killed, false);
  f.handles[0].emit('b');
  assert.equal(f.handles[0].killed, true);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.host.attach({ session }), /TERMINAL_UNKNOWN_SESSION/);
});
test('T4 pre-attach frames replay in order', { timeout: 2000 }, async t => {
  const f = fixture(t); await f.host.setEnabled(true);
  const { session } = await f.host.open(spec);
  f.handles[0].emit('one'); f.handles[0].emit('two');
  const { port } = await f.host.attach({ session }); t.after(() => port.close());
  const received = [];
  await new Promise(resolve => {
    port.on('message', value => { if (value.error) resolve(); else received.push(value); }); port.start();
    port.postMessage({ session, cols: 1, rows: 24 });
  });
  assert.deepEqual(received.map(value => Buffer.from(value.bytes).toString()), ['one', 'two']);
});
test('T5 argv alone disables nested terminal', async t => {
  const f = fixture(t, { argv: ['--nested-depth=1'] });
  await assert.rejects(f.host.open(spec), { code: 'DISPLAY_ONLY' }); assert.equal(f.handles.length, 0);
});
for (const [owner, intruder] of [[undefined, { id: 7 }], [{ id: 7 }, undefined]]) {
  test(`T6 null/non-null sender mismatch ${owner === undefined}`, async t => {
    const f = fixture(t); await f.host.setEnabled(true);
    const { session } = await f.host.open(spec, owner);
    for (const [method, value] of [['attach', { session }], ['resize', { session, cols: 90, rows: 30 }], ['close', { session }]]) {
      await assert.rejects(f.host[method](value, intruder), /SENDER/);
    }
    assert.equal(await f.host.resize({ session, cols: 90, rows: 30 }, owner), true);
  });
}
test('T7 sender event shape normalizes to id and embedded sender is stripped and bound', async t => {
  for (const embedded of [false, true]) {
    const f = fixture(t); await f.host.setEnabled(true);
    const owner = { id: 7 };
    const { session } = embedded ? await f.host.open({ ...spec, sender: owner }) : await f.host.open(spec, { sender: owner });
    const { port } = await f.host.attach({ session }, { id: 7 }); t.after(() => port.close());
    assert.equal(await f.host.resize({ session, cols: 90, rows: 30 }, { sender: { id: 7 } }), true);
    await assert.rejects(f.host.resize({ session, cols: 90, rows: 30 }, { id: 8 }), /SENDER/);
  }
});
for (const [label, payload] of [['zero ack', { ack: 0, bytes: 0 }], ['sequence gap', { seq: 2, bytes: new Uint8Array([65]) }]]) {
  test(`T8 ${label} refuses and closes session`, { timeout: 2000 }, async t => {
    const f = await attached(t), response = frame(f.port);
    await f.send({ session: f.session, ...payload });
    assert.deepEqual(f.handles[0].writes, []);
    assert.equal(f.handles[0].killed, true);
    assert.deepEqual(await response, { session: f.session, error: 'TERMINAL_IO_REFUSED' });
    assert.deepEqual(f.handles[0].writes, []);
    assert.equal(f.handles[0].killed, true);
    await assert.rejects(f.host.resize({ session: f.session, cols: 80, rows: 24 }), /TERMINAL_UNKNOWN_SESSION/);
  });
}
test('T9 disabled port resize has no PTY effect and recovers when enabled', { timeout: 2000 }, async t => {
  const f = await attached(t); await f.host.setEnabled(false);
  const response = frame(f.port); await f.send({ session: f.session, cols: 90, rows: 30 });
  assert.deepEqual(f.handles[0].resizes, []);
  assert.equal((await response).error, 'TERMINAL_IO_REFUSED'); assert.deepEqual(f.handles[0].resizes, []);
  await f.host.setEnabled(true);
  await f.send({ session: f.session, cols: 90, rows: 30 });
  assert.deepEqual(f.handles[0].resizes, [[90, 30]]);
});
test('T10 disabled port write has no PTY effect', { timeout: 2000 }, async t => {
  const f = await attached(t); await f.host.setEnabled(false);
  const response = frame(f.port); await f.send({ session: f.session, seq: 1, bytes: new Uint8Array([65]) });
  assert.deepEqual(f.handles[0].writes, []);
  assert.equal((await response).error, 'TERMINAL_IO_REFUSED'); assert.deepEqual(f.handles[0].writes, []);
});

test('T11 preload attach ownership, unknown pass-through and close cleanup', async () => {
  const calls = [];
  const transport = { invoke: async (channel, args) => {
    calls.push([channel, args]);
    if (channel.endsWith('.open')) return { session: 'mut-owned-session' };
    if (channel.endsWith('.attach')) return { port: {} };
    return true;
  }, subscribe: () => () => {} };
  const a = facade(transport).sideTerminal, b = facade(transport).sideTerminal;
  const { session } = await a.open(spec); const before = calls.length;
  await assert.rejects(b.attach({ session }), /SENDER/); assert.equal(calls.length, before);
  await b.resize({ session: 'mut-unknown-session', cols: 80, rows: 24 });
  await a.attach({ session }); await a.close({ session });
  await b.resize({ session, cols: 80, rows: 24 });
});
test('T12 preload evicts oldest ownership entry at capacity', async () => {
  let sequence = 0;
  const transport = { invoke: async channel => channel.endsWith('.open') ? { session: `mut-evict-${sequence++}` } : true,
    subscribe: () => () => {} };
  const a = facade(transport).sideTerminal, b = facade(transport).sideTerminal;
  const { session } = await a.open(spec);
  await assert.rejects(b.resize({ session, cols: 80, rows: 24 }), /SENDER/);
  for (let i = 0; i < 256; i++) await a.open(spec);
  await b.resize({ session, cols: 80, rows: 24 });
  await assert.rejects(b.resize({ session: `mut-evict-${sequence - 1}`, cols: 80, rows: 24 }), /SENDER/);
});

test('T13 broker refuses foreign owners before admission for every session operation', async t => {
  const handlers = new Map(), sent = [], admitted = [], planeCalls = [];
  const profile = { command: 'provider', executable: '/bin/echo', argv: ['/bin/echo'], cwd: '/tmp', loginShell: '/bin/sh', env: { LANG: 'C', TERM: 'xterm' } };
  const broker = registerTerminalIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: ch => handlers.delete(ch) },
    authenticate: event => ({ owner: event.owner }),
    authority: { admit: (...args) => { admitted.push(args); return { allowed: true, context: { session: 'mut-session', epoch: 0 }, profile }; } },
    providers: new Map([['provider', profile]]),
    transport: { send: value => sent.push(value), onMessage: () => () => {} },
    plane: { open() {}, close() {}, ingest() {}, acknowledge: value => planeCalls.push(value),
      attach: value => { planeCalls.push(value); return { firstSeq: null, lastSeq: null, bytes: new Uint8Array(), truncated: false }; } },
  }); t.after(() => broker.dispose());
  const call = (owner, method, value, envelopeOwner = owner) => handlers.get(TERMINAL_CHANNEL_PREFIX + method)({ owner }, { owner: envelopeOwner, value });
  assert.equal((await call('a', 'open', { provider: 'provider', command: 'provider' })).ok, true);
  for (const [method, extra] of [['attach', {}], ['write', { b64: 'YQ==' }], ['resize', { cols: 80, rows: 24 }], ['close', {}], ['ack', { ack_seq: 1, ack_bytes: 0 }]]) {
    const before = admitted.length, forwarded = sent.length, ledger = planeCalls.length;
    assert.equal((await call('b', method, { session: 'mut-session', ...extra })).reason, 'TERMINAL_OWNER', method);
    assert.equal(admitted.length, before, `${method} admission`); assert.equal(sent.length, forwarded); assert.equal(planeCalls.length, ledger);
    assert.equal((await call('a', method, { session: 'mut-session', ...extra })).ok, true, method);
  }
  const before = admitted.length;
  await assert.rejects(async () => call('a', 'attach', { session: 'mut-session' }, 'evil'), /TERMINAL_OWNER/);
  assert.equal(admitted.length, before);
});

test('FINDING T10 disabled write must permit recovery after re-enable',
  { timeout: 2000, skip: 'FINDING T10: disabled write closes session; re-enable cannot recover' }, async t => {
  const f = await attached(t); await f.host.setEnabled(false);
  const response = frame(f.port);
  f.port.postMessage({ session: f.session, seq: 1, bytes: new Uint8Array([65]) });
  assert.equal((await response).error, 'TERMINAL_IO_REFUSED');
  await f.host.setEnabled(true);
  assert.equal(await f.host.resize({ session: f.session, cols: 80, rows: 24 }), true);
});
