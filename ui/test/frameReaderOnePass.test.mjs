// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  FRAME_REASONS,
  SOURCE_RETIRED_REASON,
  createFrameReader,
} from '../electron/frameReader.js';

const SURFACE = 'capsule-1pass';
const BASE_BINDING = Object.freeze({
  principal: 'mv-1pass-test',
  epoch: 1,
  surfaceId: SURFACE,
  surfaceGeneration: 1,
});
const BASE_PIXEL_ENV = Object.freeze({
  environmentId: 'bench-rig',
  zoom: 1,
  dpr: 1,
});

/**
 * @param {number} width
 * @param {number} height
 * @param {number} [seed]
 * @returns {Uint8Array}
 */
function makeRgb24Fixture(width, height, seed = 19) {
  const bytes = new Uint8Array(width * height * 3);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (i * 29 + seed * 13 + (i % 3) * 53) & 0xff;
  }
  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {number} width
 * @param {number} height
 * @param {string} sha256
 * @param {number} [generation]
 * @returns {Record<string, unknown>}
 */
function makeFrameRef(width, height, sha256, generation = 1) {
  return {
    schema: 'frame_ref/v0.2',
    surface_id: SURFACE,
    generation,
    tick: generation,
    ts_ns: generation * 1000,
    width,
    height,
    format: 'rgb24',
    ramws_path: `/dev/shm/mv-1pass/f${generation}.rgb`,
    sha256,
    capture_us: 100,
  };
}

/**
 * Oracle verifying that delivered bytes equal the hashed bytes even when the
 * producer or caller mutates the source buffer immediately after hashing
 * (both during lease.release and after readFrame resolves).
 *
 * @param {typeof createFrameReader} factory
 * @returns {Promise<void>}
 */
async function assertDeliveredEqualsHashedUnderPostHashMutation(factory) {
  const width = 16;
  const height = 12;
  const source = makeRgb24Fixture(width, height, 41);
  const expectedSnapshot = new Uint8Array(source);
  const expectedDigest = sha256Hex(expectedSnapshot);
  const reader = factory({
    binding: { ...BASE_BINDING },
    limits: {
      maxFrameBytes: expectedSnapshot.length,
      maxWidth: width,
      maxHeight: height,
      readTimeoutMs: 1000,
      maxConcurrentReads: 1,
    },
    pixelEnvironment: { ...BASE_PIXEL_ENV },
    onReleaseLease: () => {},
    acquirePublishedLease: async ({ frameRef }) => ({
      identity: {
        ...BASE_BINDING,
        frameGeneration: frameRef.generation,
        leaseId: `lease-${frameRef.generation}`,
      },
      byteLength: expectedSnapshot.length,
      published: true,
      readOwnedBytes: async () => source,
      release: async () => {
        // Mutate the source buffer after readOwnedBytes/hashing during source retirement.
        source[0] ^= 0xff;
        source[source.length - 1] ^= 0xff;
      },
    }),
  });
  try {
    const outcome = await reader.readFrame(makeFrameRef(width, height, expectedDigest, 1));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    // Mutate the source buffer again after readFrame resolves.
    source.fill(0xaa);
    assert.equal(outcome.frame.sha256, expectedDigest);
    assert.equal(sha256Hex(outcome.frame.bytes), expectedDigest);
    assert.deepStrictEqual(outcome.frame.bytes, expectedSnapshot);
    assert.notEqual(outcome.frame.bytes, source);
    assert.notEqual(outcome.frame.bytes.buffer, source.buffer);
  } finally {
    await reader.closeReader();
  }
}

describe('UI-FRAME-1PASS host frameReader single-pass verification', () => {
  it('delivers bytes equal to the hashed bytes in an isolated owned buffer', async () => {
    const width = 8;
    const height = 6;
    const source = makeRgb24Fixture(width, height, 7);
    const expectedSnapshot = new Uint8Array(source);
    const expectedDigest = sha256Hex(expectedSnapshot);
    /** @type {Array<{reason: string}>} */
    const releases = [];
    const reader = createFrameReader({
      binding: { ...BASE_BINDING },
      limits: {
        maxFrameBytes: source.length,
        maxWidth: width,
        maxHeight: height,
        readTimeoutMs: 1000,
        maxConcurrentReads: 1,
      },
      pixelEnvironment: { ...BASE_PIXEL_ENV },
      onReleaseLease: () => {},
      acquirePublishedLease: async ({ frameRef }) => ({
        identity: {
          ...BASE_BINDING,
          frameGeneration: frameRef.generation,
          leaseId: 'lease-owned',
        },
        byteLength: source.length,
        published: true,
        readOwnedBytes: async () => source,
        release: async (req) => {
          releases.push(req);
        },
      }),
    });
    try {
      const outcome = await reader.readFrame(makeFrameRef(width, height, expectedDigest, 1));
      assert.equal(outcome.ok, true);
      assert.ok(outcome.ok);
      assert.equal(outcome.frame.sha256, expectedDigest);
      assert.equal(sha256Hex(outcome.frame.bytes), expectedDigest);
      assert.deepStrictEqual(outcome.frame.bytes, expectedSnapshot);
      assert.notEqual(outcome.frame.bytes, source);
      assert.notEqual(outcome.frame.bytes.buffer, source.buffer);
      assert.deepStrictEqual(releases, [{ reason: SOURCE_RETIRED_REASON }]);
    } finally {
      await reader.closeReader();
    }
  });

  it('keeps delivered frame bytes intact when the source buffer is mutated after admission', async () => {
    await assertDeliveredEqualsHashedUnderPostHashMutation(createFrameReader);
  });

  it('preserves refusal reasons and exact refusal order (size mismatch -> PNG signature -> digest mismatch)', async () => {
    const width = 4;
    const height = 3;
    const expectedBytes = width * height * 3;
    const validPayload = makeRgb24Fixture(width, height, 23);
    const validDigest = sha256Hex(validPayload);
    /** @type {Uint8Array} */
    let currentPayload = validPayload;
    /** @type {Array<unknown>} */
    const droppedNotices = [];

    const reader = createFrameReader({
      binding: { ...BASE_BINDING },
      limits: {
        maxFrameBytes: expectedBytes,
        maxWidth: width,
        maxHeight: height,
        readTimeoutMs: 1000,
        maxConcurrentReads: 1,
      },
      pixelEnvironment: { ...BASE_PIXEL_ENV },
      onReleaseLease: (notice) => {
        droppedNotices.push(notice);
      },
      acquirePublishedLease: async ({ frameRef }) => ({
        identity: {
          ...BASE_BINDING,
          frameGeneration: frameRef.generation,
          leaseId: `lease-${frameRef.generation}`,
        },
        byteLength: expectedBytes,
        published: true,
        readOwnedBytes: async () => currentPayload,
        release: async () => {},
      }),
    });

    try {
      // 1. Wrong size + PNG signature + wrong digest -> SIZE_MISMATCH wins first.
      const shortPng = new Uint8Array(expectedBytes - 1);
      shortPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      currentPayload = shortPng;
      const sizeRefusal = await reader.readFrame(makeFrameRef(width, height, validDigest, 1));
      assert.deepStrictEqual(sizeRefusal, {
        ok: false,
        reason: FRAME_REASONS.SIZE_MISMATCH,
        detail: 'snapshot-length-mismatch',
      });

      // 2. Right size + PNG signature + wrong digest -> INVALID_CONTRACT (PNG check precedes digest check).
      const pngPayload = new Uint8Array(validPayload);
      pngPayload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      currentPayload = pngPayload;
      const pngRefusal = await reader.readFrame(makeFrameRef(width, height, validDigest, 1));
      assert.deepStrictEqual(pngRefusal, {
        ok: false,
        reason: FRAME_REASONS.INVALID_CONTRACT,
        detail: 'png-signature-in-rgb24-payload',
      });

      // 3. Right size + non-PNG + tampered byte -> DIGEST_MISMATCH refused without advancing floor.
      const tampered = new Uint8Array(validPayload);
      tampered[10] ^= 0x01;
      currentPayload = tampered;
      const digestRefusal = await reader.readFrame(makeFrameRef(width, height, validDigest, 1));
      assert.deepStrictEqual(digestRefusal, {
        ok: false,
        reason: FRAME_REASONS.DIGEST_MISMATCH,
      });
      assert.equal(droppedNotices.length, 3);

      // Floor did not advance on refusals: generation 1 still succeeds with valid bytes.
      currentPayload = validPayload;
      const accepted = await reader.readFrame(makeFrameRef(width, height, validDigest, 1));
      assert.equal(accepted.ok, true);
    } finally {
      await reader.closeReader();
    }
  });

  it('named mutation: hashing the source but delivering a buffer mutated after hashing fails the test', async () => {
    const readerPath = fileURLToPath(new URL('../electron/frameReader.js', import.meta.url));
    const sourceCode = readFileSync(readerPath, 'utf8');
    const mutantCode = sourceCode.replace(
      'const snapshot = new Uint8Array(received);',
      'const snapshot = received;',
    );
    assert.notEqual(mutantCode, sourceCode, 'named mutation must modify frameReader.js snapshot copy');
    const mutantModule = await import(
      `data:text/javascript;base64,${Buffer.from(mutantCode, 'utf8').toString('base64')}`
    );
    await assert.rejects(
      () => assertDeliveredEqualsHashedUnderPostHashMutation(mutantModule.createFrameReader),
      assert.AssertionError,
    );
  });

  it(
    'opt-in timing print: p50 main read+verify per 3,456,000-byte frame <= 10 ms [TARGET]',
    { skip: process.env.MV_BENCH !== '1' ? 'skipped unless MV_BENCH=1' : false },
    async (t) => {
      const width = 1280;
      const height = 900;
      const source = makeRgb24Fixture(width, height, 101);
      assert.equal(source.byteLength, 3_456_000);
      const digest = sha256Hex(source);

      const reader = createFrameReader({
        binding: { ...BASE_BINDING },
        limits: {
          maxFrameBytes: source.byteLength,
          maxWidth: width,
          maxHeight: height,
          readTimeoutMs: 1000,
          maxConcurrentReads: 1,
        },
        pixelEnvironment: { ...BASE_PIXEL_ENV },
        onReleaseLease: () => {},
        acquirePublishedLease: async ({ frameRef }) => ({
          identity: {
            ...BASE_BINDING,
            frameGeneration: frameRef.generation,
            leaseId: `bench-${frameRef.generation}`,
          },
          byteLength: source.byteLength,
          published: true,
          readOwnedBytes: async () => source,
          release: async () => {},
        }),
      });

      try {
        const warmupFrames = 3;
        const measuredFrames = 21;
        /** @type {Array<number>} */
        const samplesMs = [];
        for (let gen = 1; gen <= warmupFrames + measuredFrames; gen += 1) {
          const ref = makeFrameRef(width, height, digest, gen);
          const t0 = performance.now();
          const outcome = await reader.readFrame(ref);
          const elapsedMs = performance.now() - t0;
          assert.equal(outcome.ok, true);
          if (gen > warmupFrames) {
            samplesMs.push(elapsedMs);
          }
        }
        samplesMs.sort((a, b) => a - b);
        const p50Ms = samplesMs[Math.floor(samplesMs.length / 2)];
        const msg = `p50 main read+verify per 3,456,000-byte frame: ${p50Ms.toFixed(3)} ms [MEASURED] (target <= 10 ms [TARGET])`;
        t.diagnostic(msg);
        console.log(msg);
        assert.ok(p50Ms <= 10, `expected p50 <= 10 ms [TARGET], got ${p50Ms.toFixed(3)} ms [MEASURED]`);
      } finally {
        await reader.closeReader();
      }
    },
  );
});
