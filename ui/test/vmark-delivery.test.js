import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { createFrameReader, FRAME_REASONS } from '../electron/frameReader.js';
import { createFramePort } from '../electron/framePort.js';

const binding = { principal: 'vmark', epoch: 1, surfaceId: 'capsule-A', surfaceGeneration: 1 };
const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash('sha256').update(bytes).digest('hex');
const legacyKeys = ['schema', 'kind', 'correlation', 'principal', 'epoch',
  'surfaceId', 'surfaceGeneration', 'frameGeneration', 'leaseId', 'width',
  'height', 'format', 'byteLength', 'sha256', 'pixelSpec', 'bytes'];
const markerKeys = [...legacyKeys, 'utilityVerified'];

function reader(t) {
  const handle = createFrameReader({
    binding,
    limits: { maxFrameBytes: 100, maxWidth: 4, maxHeight: 4,
      readTimeoutMs: 1000, maxConcurrentReads: 1 },
    pixelEnvironment: { environmentId: 'vmark-test', zoom: 1, dpr: 1 },
    acquirePublishedLease: async ({ frameRef }) => ({
      identity: { ...binding, frameGeneration: frameRef.generation, leaseId: `L${frameRef.generation}` },
      byteLength: bytes.length,
      published: true,
      readOwnedBytes: async () => bytes,
      release: async () => {},
    }),
    onReleaseLease() {},
  });
  t.after(() => handle.closeReader());
  return handle;
}

function ref(sha256 = digest) {
  return { schema: 'frame_ref/v0.2', surface_id: binding.surfaceId,
    generation: 1, tick: 11, ts_ns: 22, width: 1, height: 1, format: 'rgb24',
    ramws_path: '/dev/shm/vmark-test/f000001.rgb', capture_us: 33, sha256 };
}

function sender(t, realPort) {
  const messages = [];
  const port = realPort ?? { postMessage: message => messages.push(message),
    on() {}, off() {}, start() {}, close() {} };
  const handle = createFramePort({ port, binding, role: 'sender',
    limits: { maxFrameBytes: 100, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 },
    onReleaseLease() {}, onRevoke() {},
    setTimer: () => 1, clearTimer() {},
  });
  t.after(() => handle.revokeFramePort());
  return { handle, messages };
}

it('vmark digest equality yields a frozen marked frame and matching renderer delivery keys', async t => {
  const result = await reader(t).readFrame(ref());
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.frame), true);
  assert.equal(result.frame.utilityVerified, true);
  const { handle, messages } = sender(t);
  assert.equal(handle.postFrame(result.frame).ok, true);
  assert.deepEqual(Object.keys(messages[0]), markerKeys);
  assert.equal(messages[0].utilityVerified, true);

  const renderer = readFileSync(
    fileURLToPath(new URL('../src/frames/framePortRouter.js', import.meta.url)),
    'utf8',
  );
  const declaration = renderer.match(/const DELIVERY_KEYS = \[([\s\S]*?)\]\.sort\(\)\.join\(','\)/);
  assert.ok(declaration, 'renderer legacy key declaration must exist');
  const rendererKeys = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...legacyKeys].sort(), rendererKeys.sort());
  // [TARGET, unit decision] Until the peer lands DELIVERY_KEYS_WITH_MARKER,
  // its admitted contract is the existing renderer key set plus this marker.
  const expectedWithMarker = [...rendererKeys, 'utilityVerified'].sort().join(',');
  if (renderer.includes('const DELIVERY_KEYS_WITH_MARKER')) {
    const extended = renderer.match(/const DELIVERY_KEYS_WITH_MARKER\s*=\s*([^;]+);/);
    assert.ok(extended, 'peer marker key declaration must be readable');
    const markerName = renderer.match(/const FRAME_DELIVERY_MARKER_KEY\s*=\s*'([^']+)'/);
    assert.ok(markerName, 'peer marker name must be explicit');
    // Evaluate only the constant expression with admitted string inputs.
    const actual = Function('DELIVERY_KEYS', 'FRAME_DELIVERY_MARKER_KEY',
      `return (${extended[1]});`)(rendererKeys.join(','), markerName[1]);
    assert.equal(actual, expectedWithMarker);
  } else {
    t.diagnostic('DELIVERY_KEYS_WITH_MARKER absent: using admitted peer key contract');
  }
  assert.equal(Object.keys(messages[0]).sort().join(','), expectedWithMarker);
});

it('vmark digest mismatch produces neither a marker nor a delivery', async t => {
  const { handle, messages } = sender(t);
  const result = await reader(t).readFrame(ref('f'.repeat(64)));
  if (result.ok) handle.postFrame(result.frame);
  assert.equal(result.ok, false);
  assert.equal(result.reason, FRAME_REASONS.DIGEST_MISMATCH);
  assert.equal(Object.hasOwn(result, 'frame'), false);
  assert.equal(Object.hasOwn(result, 'utilityVerified'), false);
  assert.deepEqual(messages, []);
});

it('vmark absent and non-boolean markers preserve the legacy payload', async t => {
  const result = await reader(t).readFrame(ref());
  assert.equal(result.ok, true);
  for (const marker of [undefined, 'true', 1, false]) {
    const { handle, messages } = sender(t);
    const frame = { ...result.frame };
    delete frame.utilityVerified;
    if (marker !== undefined) frame.utilityVerified = marker;
    assert.equal(handle.postFrame(frame).ok, true);
    assert.deepEqual(Object.keys(messages[0]), legacyKeys);
    assert.equal(Object.hasOwn(messages[0], 'utilityVerified'), false);
  }
});

it('vmark newest-only pending promotion preserves the strict marker', async t => {
  const result = await reader(t).readFrame(ref());
  assert.equal(result.ok, true);
  for (const marker of [true, 'true', 1, undefined]) {
    const { handle, messages } = sender(t);
    assert.equal(handle.postFrame(result.frame).sent, true);
    assert.equal(handle.postFrame({ ...result.frame, frameGeneration: 2, leaseId: 'L2',
      utilityVerified: false }).queued, true);
    assert.equal(handle.postFrame({ ...result.frame, frameGeneration: 3, leaseId: 'L3',
      utilityVerified: marker }).queued, true);
    assert.equal(handle.acceptAck({ ...binding, kind: 'ack', correlation: 'capsule-A#1#L1',
      frameGeneration: 1, leaseId: 'L1', outcome: 'PRESENTED' }).ok, true);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].frameGeneration, 3);
    assert.deepEqual(Object.keys(messages[1]), marker === true ? markerKeys : legacyKeys);
  }
});

it('vmark real MessageChannel receives a marked delivery with native event trust', { timeout: 5000 }, async t => {
  const channel = new MessageChannel();
  t.after(() => { channel.port1.close(); channel.port2.close(); });
  const { handle } = sender(t, channel.port1);
  const received = new Promise(resolve => {
    channel.port2.addEventListener('message', resolve, { once: true });
    channel.port2.start();
  });
  const result = await reader(t).readFrame(ref());
  assert.equal(result.ok, true);
  assert.equal(handle.postFrame(result.frame).ok, true);
  const event = await received;
  assert.deepEqual(Object.keys(event.data), markerKeys);
  assert.equal(event.data.utilityVerified, true);
  t.diagnostic(`native MessageEvent.isTrusted=${String(event.isTrusted)}`);
  // Node's native port event reports false on this runtime. Do not forge trust
  // to stand in for an Electron utility-to-renderer measurement.
  assert.equal(event.isTrusted, false);
});
