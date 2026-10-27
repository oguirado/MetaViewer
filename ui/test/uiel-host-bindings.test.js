import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, mkdir, chmod, writeFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMainBindings } from '../electron/hostBindings.js';

const surface = { schema: 'surface/v0.2', surface_id: 's1', kind: 'browser', display: ':1',
  geometry: { w: 1, h: 1 }, state: 'active', visibility: 'unfolded', control: 'agent', profile_id: 'test' };
const registration = component => ({ endpoint: { component, instance: component + '-test' }, hello: {
  schema: 'hello/v0.2', contract_version: 'v0.2', component, component_version: '0.1.1',
  component_commit: 'a'.repeat(40), dependencies: [],
} });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { silent = false, helloHook = async () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'uh-'));
  const ram = await mkdtemp('/dev/shm/uiel-host-');
  const sockets = new Set(), requests = [], channels = [];
  const config = { session_id: 'host-test', core: registration('core'), peers: [registration('ui')] };
  const socketPath = join(root, 'metaviewer/core.sock'), configPath = join(root, 'config.json');
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const bytes = Buffer.from([1, 2, 3]), path = join(ram, 'frame.rgb');
  await writeFile(path, bytes, { mode: 0o600 });
  const frame = { schema: 'frame_ref/v0.2', surface_id: 's1', generation: 1, tick: 1, ts_ns: 1,
    width: 1, height: 1, format: 'rgb24', ramws_path: path,
    sha256: createHash('sha256').update(bytes).digest('hex'), capture_us: 1 };
  let peer, seq = 0;
  const send = (body, patch = {}) => peer.write(JSON.stringify({ schema: 'envelope/v0.2',
    msg_id: 'reply-' + (++seq), ts_ns: 0, from: config.core.endpoint, to: config.peers[0].endpoint,
    session_id: config.session_id, seq, nonce: 'nonce-' + seq, body, ...patch }) + '\n');
  const server = createServer(socket => {
    peer = socket; sockets.add(socket);
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      let offset;
      while ((offset = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, offset)); buffer = buffer.slice(offset + 1);
        requests.push(message);
        if (message.body.schema === 'hello/v0.2') {
          void helloHook(socketPath).then(() => send(config.core.hello)).catch(error => socket.destroy(error));
        } else if (!silent && message.body.schema === 'action_proposal/v0.2') {
          send({ schema: 'action_verdict/v0.2', proposal_id: message.body.proposal_id,
            decision: 'refused', reason_code: 'POLICY', core_seq: 1 });
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true }); await rm(ram, { recursive: true, force: true });
  });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  const createMessageChannel = () => {
    const channel = { port1: Object.assign(new EventEmitter(), { postMessage() {}, start() {}, close() {} }), port2: { close() {} } };
    channels.push(channel); return channel;
  };
  return { env: { MV_CORE_CONFIG: configPath, XDG_RUNTIME_DIR: root }, root, path, frame,
    requests, channels, createMessageChannel, send, socketPath,
    waitClosed: () => peer.destroyed ? Promise.resolve() : once(peer, 'close') };
}
async function connect(t, f) {
  const bindings = await createMainBindings(f);
  t.after(() => bindings.core.dispose());
  assert.equal(bindings.core.getStatus().availability, 'live');
  return bindings;
}
async function published(f, bindings) {
  const next = new Promise(resolve => bindings.wire.frames.subscribe(resolve));
  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface } });
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f.frame } });
  return next;
}
const proposal = id => ({ op: 'propose', json: JSON.stringify({ schema: 'action_proposal/v0.2', proposal_id: id }) });

// Mutation: remove (info.mode & 0o022) or info.size > MAX_FRAME in acquirePublishedLease.
test('HB1 valid owner frame leases read and release; writable or oversized publications refuse', { timeout: 5000 }, async t => {
  const f = await fixture(t), bindings = await connect(t, f), entry = await published(f, bindings);
  const acquire = () => entry.readerOptions.acquirePublishedLease({ binding: entry.readerOptions.binding,
    frameRef: entry.frameRef, signal: new AbortController().signal });
  const lease = await acquire();
  assert.deepEqual([...await lease.readOwnedBytes({ maxBytes: 3, signal: new AbortController().signal })], [1, 2, 3]);
  await lease.release(); await lease.release();
  await assert.rejects(lease.readOwnedBytes({ maxBytes: 3, signal: new AbortController().signal }), /CORE_SEAMS_ABSENT/);
  // 0640 is group-readable, not group-writable: it is admitted by the current contract.
  await chmod(f.path, 0o640);
  const readable = await acquire(); await readable.release();
  for (const mode of [0o620, 0o602]) {
    await chmod(f.path, mode); await assert.rejects(acquire(), /CORE_SEAMS_ABSENT/);
  }
  await chmod(f.path, 0o600);
  await truncate(f.path, 64 * 1024 * 1024);
  const boundary = await acquire(); assert.equal(boundary.byteLength, 64 * 1024 * 1024); await boundary.release();
  await truncate(f.path, 64 * 1024 * 1024 + 1);
  await assert.rejects(acquire(), /CORE_SEAMS_ABSENT/);
  assert.equal(bindings.core.getStatus().availability, 'live', 'a bad lease must not destroy the transport');
});

// Mutation: remove listeners.size from subscribe's refusal condition.
test('HB1 duplicate subscribe refuses without replacing the original frame consumer', { timeout: 5000 }, async t => {
  const f = await fixture(t), bindings = await connect(t, f), seen = [];
  let delivered;
  const next = new Promise(resolve => { delivered = resolve; });
  const unsubscribe = bindings.wire.frames.subscribe(entry => { seen.push(entry); delivered(); });
  assert.throws(() => bindings.wire.frames.subscribe(() => assert.fail('second listener ran')), /CORE_SEAMS_ABSENT/);
  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface } });
  f.send({ schema: 'surface_event/v0.2', event: 'frame_ready', data: { frame_ref: f.frame } });
  await next;
  assert.equal(seen.length, 1); assert.equal(bindings.core.getStatus().availability, 'live');
  unsubscribe();
  const release = bindings.wire.frames.subscribe(() => {}); release();
});

// Mutation: change surfaces.size >= MAX_ITEMS to surfaces.size > MAX_ITEMS.
test('HB1 surface capacity admits 64 identities, then shuts down on the next distinct identity', { timeout: 5000 }, async t => {
  const f = await fixture(t), bindings = await connect(t, f);
  const observed = new Set();
  bindings.wire.frames.subscribe(() => {});
  for (let i = 0; i < 64; i++) f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: { ...surface, surface_id: 's' + i } } });
  // A matched proposal is an ordered receive barrier after all created events.
  assert.equal((await bindings.core.request(proposal('barrier'))).reason_code, 'POLICY');
  for (const request of f.requests) if (request.body.op === 'frame_subscribe') observed.add(request.body.params.surface_id);
  assert.equal(observed.size, 64); assert.equal(bindings.core.getStatus().availability, 'live');
  const closed = f.waitClosed();
  f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface: { ...surface, surface_id: 's64' } } });
  await closed;
  assert.equal(bindings.core.getStatus().availability, 'unavailable');
  await assert.rejects(bindings.core.request(proposal('after-cap')), /CORE_SEAMS_ABSENT/);
});

// Mutation: omit shutdown() in the CORE_TIMEOUT callback.
test('HB2 silent requests time out and shut down; responsive proposals return the exact refusal', { timeout: 10000 }, async t => {
  const good = await fixture(t), live = await connect(t, good);
  assert.equal((await live.core.request(proposal('responsive'))).reason_code, 'POLICY');
  assert.equal(live.core.getStatus().availability, 'live');
  const silent = await fixture(t, { silent: true }), bindings = await connect(t, silent);
  await assert.rejects(bindings.core.request(proposal('silent')), /CORE_TIMEOUT/);
  assert.equal(bindings.core.getStatus().availability, 'unavailable');
  await assert.rejects(bindings.core.request(proposal('no-reconnect')), /CORE_SEAMS_ABSENT/);
});

// Mutation: remove receive's env.seq <= received / endpoint equality / nonce grammar guard.
for (const [label, patch] of [['replayed sequence', { seq: 1 }], ['foreign sender', { from: { component: 'core', instance: 'foreign' } }],
  ['bad nonce', { nonce: 'bad nonce' }]]) {
  test('HB2 shuts down on ' + label + ' after a valid hello', { timeout: 5000 }, async t => {
    const f = await fixture(t), bindings = await connect(t, f);
    const closed = f.waitClosed();
    f.send({ schema: 'surface_event/v0.2', event: 'created', data: { surface } }, patch);
    await closed;
    assert.equal(bindings.core.getStatus().availability, 'unavailable');
    await assert.rejects(bindings.core.request(proposal('after-fault')), /CORE_SEAMS_ABSENT/);
  });
}

// Mutation: remove after.mode !== socketInfo.mode from the post-hello socket check.
test('HB2 socket chmod between connection and hello refuses bootstrap; unchanged socket admits', async t => {
  const good = await fixture(t), bindings = await connect(t, good);
  assert.equal((await bindings.core.request(proposal('unchanged'))).decision, 'refused');
  const changed = await fixture(t, { helloHook: path => chmod(path, 0o666) });
  await assert.rejects(createMainBindings(changed), /CORE_SEAMS_ABSENT/);
  await tick();
});

// Mutation: remove after.ino !== socketInfo.ino from the post-hello socket check.
test('HB2 replacing the socket inode during hello refuses bootstrap despite unchanged permissions', { timeout: 5000 }, async t => {
  const replacement = createServer(socket => socket.destroy());
  t.after(async () => { if (replacement.listening) await new Promise(resolve => replacement.close(resolve)); });
  const changed = await fixture(t, { helloHook: async path => {
    await rm(path);
    replacement.listen(path); await once(replacement, 'listening'); await chmod(path, 0o600);
  } });
  await assert.rejects(createMainBindings(changed), /CORE_SEAMS_ABSENT/);
});
