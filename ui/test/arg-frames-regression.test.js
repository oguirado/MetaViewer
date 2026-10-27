import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createFramePort, FRAME_DELIVERY_SCHEMA, FRAME_ACK_SCHEMA } from '../electron/framePort.js';
import { createBytePlane } from '../electron/bytePlane.js';
import { createFrameReader } from '../electron/frameReader.js';
import { createHash } from 'node:crypto';

const binding = { principal: 'worker', epoch: 1, surfaceId: 's', surfaceGeneration: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const frame = (gen = 1) => ({ ...binding, frameGeneration: gen, leaseId: `L${gen}`,
  width: 1, height: 1, format: 'rgb24', bytes: new Uint8Array([1, 2, 3]),
  byteLength: 3, sha256: 'ab'.repeat(32), pixelSpec: { format: 'rgb24' } });
const delivery = (gen = 1) => ({ ...frame(gen), schema: FRAME_DELIVERY_SCHEMA,
  kind: 'frame', correlation: `s#${gen}#L${gen}` });
const ack = () => ({ ...binding, frameGeneration: 1, leaseId: 'L1',
  correlation: 's#1#L1', outcome: 'PRESENTED' });
function endpoint(role, onFrame = async () => ({ outcome: 'PRESENTED' })) {
  const messages = [], releases = [], listeners = new Map();
  const port = { postMessage: m => messages.push(m), on: (event, fn) => listeners.set(event, fn),
    off: event => listeners.delete(event), close() {}, start() {} };
  const handle = createFramePort({ port, role, binding,
    limits: { maxFrameBytes: 100, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
    onReleaseLease: r => releases.push(r), onRevoke() {}, setTimer: () => 1, clearTimer() {},
    ...(role === 'receiver' ? { onFrame } : {}) });
  return { handle, messages, releases, emit: m => listeners.get('message')?.({ data: m }) };
}

it('ARG-2 rejects wrong/missing wire schemas and accepts matching schemas', async () => {
  const r = endpoint('receiver');
  for (const schema of ['frame_delivery/v0.1', undefined]) r.emit({ ...delivery(), schema });
  await tick();
  assert.equal(r.messages.length, 0);
  assert.equal(r.handle.getInstrumentation().acceptedFloor, 0);
  r.emit(delivery());
  await tick();
  assert.equal(r.messages[0].outcome, 'PRESENTED');
  const s = endpoint('sender');
  s.handle.postFrame(frame());
  for (const schema of ['frame_ack/v0.1', undefined]) s.emit({ ...ack(), kind: 'ack', schema });
  assert.equal(s.handle.getInstrumentation().inFlightGeneration, 1);
  s.emit({ ...ack(), kind: 'ack', schema: FRAME_ACK_SCHEMA });
  assert.equal(s.handle.getInstrumentation().inFlightGeneration, null);
});

it('ARG-2 public typedef-shaped ACK clears in-flight; wrong correlation does not', () => {
  const s = endpoint('sender');
  s.handle.postFrame(frame());
  assert.equal(s.handle.acceptAck({ ...ack(), correlation: 'foreign' }).ok, false);
  assert.equal(s.handle.getInstrumentation().inFlightGeneration, 1);
  assert.equal(s.handle.acceptAck(ack()).acked, 1);
  assert.equal(s.releases.length, 1);
});

it('ARG-3 refuses unbound or uncorrelatable arrivals silently, preserving sender', () => {
  const s = endpoint('sender'), r = endpoint('receiver');
  s.handle.postFrame(frame());
  for (const patch of [{ principal: 'foreign' }, { surfaceId: 'foreign' }, { epoch: 2 },
    { surfaceGeneration: 2 }, { frameGeneration: 0 }, { leaseId: '' },
    { correlation: '' }, { correlation: undefined }, { correlation: 7 }]) {
    r.emit({ ...delivery(), ...patch });
  }
  for (const message of r.messages) s.emit(message);
  assert.equal(r.messages.length, 0);
  assert.equal(s.handle.getInstrumentation().inFlightGeneration, 1);
  assert.equal(s.releases.length, 0);
  // A bound, correlatable but malformed payload can receive a refusal ACK.
  r.emit({ ...delivery(), byteLength: 99 });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].outcome, 'REFUSED');
});

it('ARG-4 revoke defers active release until consumer settlement', async () => {
  const gate = deferred();
  const r = endpoint('receiver', () => gate.promise);
  r.emit(delivery());
  await tick();
  r.handle.revokeFramePort('SHUTDOWN');
  assert.equal(r.releases.length, 0);
  gate.resolve({ outcome: 'PRESENTED' });
  await tick();
  assert.deepEqual(r.releases.map(x => x.reason), ['SHUTDOWN']);
  assert.equal(r.messages.length, 0);
  r.handle.revokeFramePort('SHUTDOWN');
  assert.equal(r.releases.length, 1);
});

it('ARG-4 supersession releases queued frames immediately and active frames after settlement', async () => {
  const gate = deferred(), seen = [];
  const r = endpoint('receiver', f => {
    seen.push(f.frameGeneration);
    return f.frameGeneration === 1 ? gate.promise : Promise.resolve({ outcome: 'PRESENTED' });
  });
  r.emit(delivery());
  await tick();
  r.emit(delivery(2)); r.emit(delivery(3));
  await tick();
  assert.deepEqual(seen, [1]);
  assert.deepEqual(r.releases.map(x => x.frameGeneration), [2]);
  gate.resolve({ outcome: 'PRESENTED' });
  await tick();
  assert.deepEqual(seen, [1, 3]);
  assert.deepEqual(r.releases.map(x => [x.frameGeneration, x.reason]),
    [[2, 'SUPERSEDED'], [1, 'SUPERSEDED'], [3, 'PRESENTED']]);
});

it('ARG-4 freezes pixelSpec before the consumer runs', async () => {
  let captured;
  const r = endpoint('receiver', async f => { captured = f; return { outcome: 'PRESENTED' }; });
  r.emit(delivery()); await tick();
  assert.equal(Object.isFrozen(captured.pixelSpec), true);
  assert.throws(() => { captured.pixelSpec.format = 'unsafe'; }, TypeError);
});

const context = (attachmentGeneration = 0) => ({ session: 's', direction: 'output',
  serviceGeneration: 1, epoch: 1, attachmentGeneration });
function plane() {
  const resumes = [], faults = [];
  const p = createBytePlane({ limits: { maxFrameBytes: 4, highWaterBytes: 4, lowWaterBytes: 2,
    maxPendingBytes: 16, maxPendingFrames: 8, replayBytes: 4, maxSessionOutputBytes: 1000 },
  onPause() {}, onResume: c => resumes.push(c), onFault: (c, code) => faults.push(code) });
  p.open(context());
  return { p, resumes, faults };
}
const ingest = (p, seq, bytes, ctx = context()) => p.ingest(ctx, { seq, b64: Buffer.from(bytes).toString('base64') });

it('ARG-5 replay sequence bounds describe retained bytes across empty frames', () => {
  const { p } = plane();
  ingest(p, 1, [1, 2, 3, 4]); ingest(p, 2, []); ingest(p, 3, [5, 6, 7, 8]); ingest(p, 4, []);
  const suffix = p.attach(context(1));
  assert.equal(suffix.firstSeq, 3); assert.equal(suffix.lastSeq, 3);
  assert.deepEqual([...suffix.bytes], [5, 6, 7, 8]);
});

it('ARG-5 empty acknowledged stream leaves no replay entries', () => {
  const { p } = plane();
  for (let seq = 1; seq <= 1000; seq++) {
    ingest(p, seq, []); p.acknowledge(context(), { seq, bytes: 0 });
  }
  assert.deepEqual(p.attach(context(1)), { firstSeq: null, lastSeq: null, bytes: new Uint8Array(), truncated: false });
});

it('ARG-6 stale close fails without destroying current generation', () => {
  const { p } = plane();
  p.attach(context(1));
  assert.throws(() => p.close(context()), { code: 'stale-generation' });
  assert.equal(ingest(p, 1, [1], context(1)).byteLength, 1);
  p.close(context(1));
  assert.throws(() => ingest(p, 2, [2], context(1)), { code: 'closed' });
});

it('ARG-6 close and fatal failure release pending state', () => {
  for (const fatal of [false, true]) {
    const { p } = plane();
    ingest(p, 1, [1, 2, 3, 4]);
    assert.equal(p.snapshot(context()).pendingFrames, 1);
    if (fatal) assert.throws(() => ingest(p, 3, [1]), { code: 'seq-gap' });
    else p.close(context());
    assert.equal(p.snapshot(context()).pendingFrames, 0);
    assert.equal(p.snapshot(context()).paused, false);
    assert.throws(() => p.attach(context(1)), { code: 'closed' });
    p.close(context());
  }
});

it('ARG-6 resumes exactly at low watermark and remains paused above it', () => {
  const { p, resumes } = plane();
  ingest(p, 1, [1]); ingest(p, 2, [2]); ingest(p, 3, [3, 4]);
  p.acknowledge(context(), { seq: 1, bytes: 1 });
  assert.equal(p.snapshot(context()).paused, true); assert.equal(resumes.length, 0);
  p.acknowledge(context(), { seq: 2, bytes: 2 });
  assert.equal(p.snapshot(context()).paused, false); assert.equal(resumes.length, 1);
  p.acknowledge(context(), { seq: 3, bytes: 4 });
  assert.equal(resumes.length, 1);
});

const bytes = new Uint8Array([1, 2, 3]);
const ref = path => ({ schema: 'frame_ref/v0.2', surface_id: 's', generation: 1, tick: 1,
  ts_ns: 1, width: 1, height: 1, format: 'rgb24', ramws_path: path,
  sha256: createHash('sha256').update(bytes).digest('hex'), capture_us: 1 });
function reader(acquirePublishedLease) {
  return createFrameReader({ binding,
    limits: { maxFrameBytes: 100, maxWidth: 10, maxHeight: 10, readTimeoutMs: 1000, maxConcurrentReads: 1 },
    pixelEnvironment: { environmentId: 'test', zoom: 1, dpr: 1 },
    acquirePublishedLease, onReleaseLease() {} });
}
it('ARG-7 noncanonical paths refuse lexically before acquisition', async () => {
  let acquires = 0;
  const r = reader(async () => { acquires++; return null; });
  for (const path of ['/dev/shm/.', '/dev/shm///', '/dev/shm/./frame', '/dev/shm/dir/', '/dev/shm/dir//frame']) {
    const result = await r.readFrame(ref(path));
    assert.equal(result.reason, 'INVALID_PATH', path);
  }
  assert.equal(acquires, 0);
  assert.equal((await r.readFrame(ref('/dev/shm/dir/frame'))).reason, 'LEASE_INVALID');
  assert.equal(acquires, 1);
});

it('ARG-7 existing late-acquire cleanup releases once after abort', async () => {
  const gate = deferred(), releases = [];
  const r = reader(() => gate.promise);
  const pending = r.readFrame(ref('/dev/shm/dir/frame'));
  await r.closeReader();
  assert.equal((await pending).reason, 'CLOSED');
  gate.resolve({ release: async request => releases.push(request) });
  await tick(); await tick();
  assert.deepEqual(releases, [{ reason: 'CLOSED' }]);
});
