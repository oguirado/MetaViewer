import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ACQUIRE_CAUSE_CODES,
  FRAME_REASONS,
  createFrameReader,
} from '../electron/frameReader.js';

const BINDING = Object.freeze({
  principal: 'mv-test',
  epoch: 1,
  surfaceId: 'capsule-A',
  surfaceGeneration: 1,
});

const PIXEL_ENV = Object.freeze({
  environmentId: 'test-rig',
  zoom: 1,
  dpr: 1,
});

function makeRgb(width, height) {
  const bytes = new Uint8Array(width * height * 3);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (i * 29 + 13) % 256;
  }
  return bytes;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('createFrameReader admits frames at exact maxWidth, maxHeight, and maxFrameBytes limits', async () => {
  const width = 4;
  const height = 3;
  const exactBytes = width * height * 3;
  const payload = makeRgb(width, height);
  const digest = sha256Hex(payload);

  const reader = createFrameReader({
    binding: BINDING,
    limits: {
      maxFrameBytes: exactBytes,
      maxWidth: width,
      maxHeight: height,
      readTimeoutMs: 1000,
      maxConcurrentReads: 2,
    },
    pixelEnvironment: PIXEL_ENV,
    onReleaseLease() {},
    acquirePublishedLease: async (req) => ({
      identity: {
        ...BINDING,
        frameGeneration: req.frameRef.generation,
        leaseId: `lease-${req.frameRef.generation}`,
      },
      byteLength: exactBytes,
      published: true,
      readOwnedBytes: async () => payload,
      release: async () => {},
    }),
  });

  const baseRef = {
    schema: 'frame_ref/v0.2',
    surface_id: BINDING.surfaceId,
    generation: 1,
    tick: 1,
    ts_ns: 1,
    width,
    height,
    format: 'rgb24',
    ramws_path: '/dev/shm/mv-test/exact.rgb',
    sha256: digest,
    capture_us: 10,
  };

  const admitted = await reader.readFrame(baseRef);
  assert.equal(admitted.ok, true);
  assert.equal(admitted.frame.width, width);
  assert.equal(admitted.frame.height, height);
  assert.equal(admitted.frame.byteLength, exactBytes);

  // Off-by-one above maxWidth, maxHeight, and maxFrameBytes must refuse with SIZE_MISMATCH
  const overWidth = await reader.readFrame({ ...baseRef, generation: 2, width: width + 1 });
  assert.deepEqual(overWidth, {
    ok: false,
    reason: FRAME_REASONS.SIZE_MISMATCH,
    detail: 'exceeds-max-dimensions',
  });

  const overHeight = await reader.readFrame({ ...baseRef, generation: 3, height: height + 1 });
  assert.deepEqual(overHeight, {
    ok: false,
    reason: FRAME_REASONS.SIZE_MISMATCH,
    detail: 'exceeds-max-dimensions',
  });

  const tightBytesReader = createFrameReader({
    binding: BINDING,
    limits: {
      maxFrameBytes: exactBytes - 1,
      maxWidth: width,
      maxHeight: height,
      readTimeoutMs: 1000,
      maxConcurrentReads: 1,
    },
    pixelEnvironment: PIXEL_ENV,
    onReleaseLease() {},
    acquirePublishedLease: async () => {
      throw new Error('must not acquire when expected > maxFrameBytes');
    },
  });
  const overBytes = await tightBytesReader.readFrame(baseRef);
  assert.deepEqual(overBytes, {
    ok: false,
    reason: FRAME_REASONS.SIZE_MISMATCH,
    detail: 'exceeds-max-frame-bytes',
  });

  await reader.closeReader();
  await tightBytesReader.closeReader();
});

test('createFrameReader extracts acquire cause from err.code fallback when causeCode is absent', async () => {
  const payload = makeRgb(2, 2);
  const digest = sha256Hex(payload);
  let nextErr = null;
  let gen = 0;

  const reader = createFrameReader({
    binding: BINDING,
    limits: {
      maxFrameBytes: 4096,
      maxWidth: 64,
      maxHeight: 64,
      readTimeoutMs: 1000,
      maxConcurrentReads: 1,
    },
    pixelEnvironment: PIXEL_ENV,
    onReleaseLease() {},
    acquirePublishedLease: async () => {
      throw nextErr;
    },
  });

  for (const code of Object.keys(ACQUIRE_CAUSE_CODES)) {
    gen += 1;
    nextErr = Object.assign(new Error(`code-only-${code}`), { code });
    const outcome = await reader.readFrame({
      schema: 'frame_ref/v0.2',
      surface_id: BINDING.surfaceId,
      generation: gen,
      tick: gen,
      ts_ns: gen,
      width: 2,
      height: 2,
      format: 'rgb24',
      ramws_path: '/dev/shm/mv-test/cause.rgb',
      sha256: digest,
      capture_us: 1,
    });
    assert.deepEqual(outcome, {
      ok: false,
      reason: FRAME_REASONS.IO_ERROR,
      detail: 'acquire-failed',
      cause: code,
    });
  }

  // Unrecognized err.code does not leak into outcome.cause
  gen += 1;
  nextErr = Object.assign(new Error('unrecognized'), { code: 'ENOENT' });
  const unmapped = await reader.readFrame({
    schema: 'frame_ref/v0.2',
    surface_id: BINDING.surfaceId,
    generation: gen,
    tick: gen,
    ts_ns: gen,
    width: 2,
    height: 2,
    format: 'rgb24',
    ramws_path: '/dev/shm/mv-test/cause.rgb',
    sha256: digest,
    capture_us: 1,
  });
  assert.deepEqual(unmapped, {
    ok: false,
    reason: FRAME_REASONS.IO_ERROR,
    detail: 'acquire-failed',
  });

  await reader.closeReader();
});
