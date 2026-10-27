import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createFrameReader, FRAME_REASONS } from '../electron/frameReader.js';

// Publisher Ref field set: daemon-adapter/internal/frames/publisher.go.
// The contract example deliberately has a null digest; live bytes must bind it.
const fixture = JSON.parse(readFileSync(
  new URL('../../contracts/examples/v0.2/frame_ref.valid.json', import.meta.url), 'utf8'));
const bytes = Uint8Array.from({ length: fixture.width * fixture.height * 3 }, (_, i) => i % 251);
const liveRef = { ...fixture, sha256: createHash('sha256').update(bytes).digest('hex') };

function harness(ref = liveRef) {
  const acquired = [];
  const released = [];
  const binding = { principal: 'adapter-test', epoch: 1,
    surfaceId: ref.surface_id, surfaceGeneration: 1 };
  const reader = createFrameReader({
    binding,
    limits: { maxFrameBytes: bytes.length, maxWidth: fixture.width,
      maxHeight: fixture.height, readTimeoutMs: 1000, maxConcurrentReads: 1 },
    pixelEnvironment: { environmentId: 'adapter-test', zoom: 1, dpr: 1 },
    onReleaseLease: release => released.push(release),
    acquirePublishedLease: async ({ frameRef }) => {
      acquired.push(frameRef);
      return { identity: { ...binding, frameGeneration: frameRef.generation, leaseId: 'published' },
        published: true, byteLength: bytes.length,
        readOwnedBytes: async () => bytes, release: async () => {} };
    },
  });
  return { reader, acquired, released };
}

test('adapter v0.2 reference delivers verified pixels from the contract example shape', async () => {
  const { reader, acquired } = harness();
  try {
    const outcome = await reader.readFrame(liveRef);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.deepEqual(outcome.frame.bytes, bytes);
    assert.equal(outcome.frame.sha256, liveRef.sha256);
    assert.deepEqual(acquired, [liveRef]);
    assert.equal(Object.isFrozen(acquired[0]), true);
  } finally { await reader.closeReader(); }
});

test('v0.2 example null digest remains a typed refusal', async () => {
  const { reader, acquired } = harness();
  assert.deepEqual(await reader.readFrame(fixture), { ok: false, reason: FRAME_REASONS.NULL_DIGEST });
  assert.deepEqual(acquired, []);
  await reader.closeReader();
});

for (const boundary of [0, Number.MAX_SAFE_INTEGER]) {
  test(`v0.2 admits safe witness boundary ${boundary}`, async () => {
    const { reader } = harness();
    try {
      const outcome = await reader.readFrame({ ...liveRef,
        tick: boundary, ts_ns: boundary, capture_us: boundary,
        generation: boundary || 1 });
      assert.equal(outcome.ok, true);
    } finally { await reader.closeReader(); }
  });
}

test('v0.2 admits schema string length boundaries in Unicode code points', async () => {
  const ref = { ...liveRef, surface_id: '😀'.repeat(128),
    ramws_path: '/dev/shm/' + '😀'.repeat(65536 - '/dev/shm/'.length) };
  const { reader, acquired } = harness(ref);
  try {
    assert.equal((await reader.readFrame(ref)).ok, true);
    assert.deepEqual(acquired, [ref]);
    const badSurface = await reader.readFrame({ ...ref, surface_id: ref.surface_id + 'a' });
    assert.equal(badSurface.reason, FRAME_REASONS.INVALID_CONTRACT);
    const badPath = await reader.readFrame({ ...ref, ramws_path: ref.ramws_path + 'a' });
    assert.equal(badPath.reason, FRAME_REASONS.INVALID_PATH);
    assert.equal(acquired.length, 1);
  } finally { await reader.closeReader(); }
});

const invalid = [
  ['v0.1', { ...liveRef, schema: 'frame_ref/v0.1' }, 'INVALID_CONTRACT'],
  ['unknown property', { ...liveRef, extra: true }, 'INVALID_CONTRACT'],
  ['non-hex sha', { ...liveRef, sha256: 'g'.repeat(64) }, 'INVALID_CONTRACT'],
  ['uppercase sha', { ...liveRef, sha256: 'A'.repeat(64) }, 'INVALID_CONTRACT'],
  ['sha trailing newline', { ...liveRef, sha256: liveRef.sha256 + '\n' }, 'INVALID_CONTRACT'],
  ['generation zero', { ...liveRef, generation: 0 }, 'INVALID_GENERATION'],
  ['width zero', { ...liveRef, width: 0 }, 'INVALID_CONTRACT'],
  ['height zero', { ...liveRef, height: 0 }, 'INVALID_CONTRACT'],
  ['path traversal', { ...liveRef, ramws_path: '/dev/shm/../outside.rgb' }, 'INVALID_PATH'],
  ['path length', { ...liveRef, ramws_path: '/dev/shm/' + 'a'.repeat(65536) }, 'INVALID_PATH'],
];
for (const field of Object.keys(liveRef)) {
  const missing = { ...liveRef };
  delete missing[field];
  invalid.push([`missing ${field}`, missing, 'INVALID_CONTRACT']);
}
for (const field of ['tick', 'ts_ns', 'capture_us', 'width', 'height', 'generation']) {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', true, null]) {
    invalid.push([`${field} rejects ${String(value)}`, { ...liveRef, [field]: value },
      field === 'generation' ? 'INVALID_GENERATION' : 'INVALID_CONTRACT']);
  }
}
for (const [name, ref, reason] of invalid) {
  test(`v0.2 rejects ${name} before acquisition`, async () => {
    const { reader, acquired, released } = harness();
    const result = await reader.readFrame(ref);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(acquired, []);
    assert.deepEqual(released, []);
    await reader.closeReader();
  });
}
