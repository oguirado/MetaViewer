import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFrameReader, FRAME_REASONS } from '../electron/frameReader.js';

const bytes = Uint8Array.of(1, 2, 3);
const ref = {
  schema: 'frame_ref/v0.2', surface_id: 'lexical-test', generation: 1,
  tick: 0, ts_ns: 0, width: 1, height: 1, format: 'rgb24',
  ramws_path: '/dev/shm/frame.rgb',
  sha256: createHash('sha256').update(bytes).digest('hex'), capture_us: 0,
};

function harness(surfaceId = ref.surface_id) {
  const acquired = [];
  const binding = { principal: 'lexical-test', epoch: 1, surfaceId, surfaceGeneration: 1 };
  const reader = createFrameReader({
    binding,
    limits: { maxFrameBytes: 3, maxWidth: 1, maxHeight: 1,
      readTimeoutMs: 1000, maxConcurrentReads: 1 },
    pixelEnvironment: { environmentId: 'lexical-test', zoom: 1, dpr: 1 },
    onReleaseLease: () => {},
    acquirePublishedLease: async ({ frameRef }) => {
      acquired.push(frameRef);
      return {
        identity: { ...binding, frameGeneration: frameRef.generation, leaseId: 'published' },
        published: true, byteLength: bytes.length,
        readOwnedBytes: async () => bytes, release: async () => {},
      };
    },
  });
  return { reader, acquired };
}

// Observe allocation-triggering iteration, rather than merely the refusal
// (the pre-fix implementation returned the same refusal after allocating).
// Admission is synchronous; restore the prototype before awaiting any I/O.
function observeIteration(value, action) {
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator);
  let iterations = 0;
  Object.defineProperty(String.prototype, Symbol.iterator, {
    ...descriptor,
    value: function () {
      if (String(this) === value) iterations += 1;
      return descriptor.value.call(this);
    },
  });
  try {
    return { result: action(), iterations };
  } finally {
    Object.defineProperty(String.prototype, Symbol.iterator, descriptor);
  }
}

test('ARG-r_ui-3: oversized ASCII path is refused without code-point iteration or acquisition', async () => {
  const { reader, acquired } = harness();
  try {
    const ramws_path = '/dev/shm/' + 'a'.repeat(140000);
    const observed = observeIteration(ramws_path, () => reader.readFrame({ ...ref, ramws_path }));
    assert.equal((await observed.result).reason, FRAME_REASONS.INVALID_PATH);
    assert.equal(observed.iterations, 0);
    const smaller = await reader.readFrame({ ...ref, ramws_path: 'a'.repeat(70000) });
    assert.equal(smaller.ok, false);
    assert.equal(smaller.reason, FRAME_REASONS.INVALID_PATH);
    assert.deepEqual(acquired, []);
  } finally { await reader.closeReader(); }
});

test('ARG-r_ui-3: oversized astral path and former Unicode boundary are refused without iteration', async () => {
  const surface_id = '😀'.repeat(128);
  const { reader, acquired } = harness(surface_id);
  try {
    const ramws_path = '/dev/shm/' + '😀'.repeat(70000);
    const observed = observeIteration(ramws_path, () => reader.readFrame({ ...ref, surface_id, ramws_path }));
    assert.equal((await observed.result).reason, FRAME_REASONS.INVALID_PATH);
    assert.equal(observed.iterations, 0);
    assert.deepEqual(acquired, []);
    const boundary = { ...ref, surface_id,
      ramws_path: '/dev/shm/' + '😀'.repeat(65536 - '/dev/shm/'.length) };
    const boundaryObserved = observeIteration(boundary.ramws_path,
      () => reader.readFrame(boundary));
    assert.equal((await boundaryObserved.result).reason, FRAME_REASONS.INVALID_PATH);
    assert.equal(boundaryObserved.iterations, 0);
    const surfaceOnly = await reader.readFrame({ ...ref, surface_id });
    assert.equal(surfaceOnly.reason, FRAME_REASONS.INVALID_CONTRACT);
    assert.deepEqual(acquired, []);
  } finally { await reader.closeReader(); }
});

test('ARG-r_ui-3: oversized reference surface avoids iteration and shorter invalid surface stays refused', async () => {
  const { reader, acquired } = harness();
  try {
    const surface_id = 's'.repeat(513);
    const observed = observeIteration(surface_id, () => reader.readFrame({ ...ref, surface_id }));
    assert.equal((await observed.result).reason, FRAME_REASONS.INVALID_CONTRACT);
    assert.equal(observed.iterations, 0);
    const shorter = await reader.readFrame({ ...ref, surface_id: 's'.repeat(200) });
    assert.equal(shorter.ok, false);
    assert.equal(shorter.reason, FRAME_REASONS.INVALID_CONTRACT);
    assert.deepEqual(acquired, []);
  } finally { await reader.closeReader(); }
});

test('ARG-r_ui-3: oversized binding surface is refused without code-point iteration', () => {
  const surfaceId = 's'.repeat(513);
  const observed = observeIteration(surfaceId, () => {
    assert.throws(() => harness(surfaceId), { code: FRAME_REASONS.INVALID_BINDING });
  });
  assert.equal(observed.iterations, 0);
});
