/**
 * Tests for W1-FRAMES-READER (`ui/electron/frameReader.js`).
 *
 * Runs under the repository `node --test` gate with an injected fake producer
 * capability only; no Electron runtime and no filesystem reads. Every
 * behaviour pairs a positive witness with negative controls that must fail:
 * malformed refs are refused before acquisition (zero producer calls),
 * tampered or disguised payloads fail verification without advancing the
 * accepted generation floor, and every acquired lease is retired exactly
 * once. Null-digest refs fail closed: they carry no live pixel binding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  C_PIXEL_RGB24_SPEC,
  FRAME_REASONS,
  FrameReaderError,
  SOURCE_RETIRED_REASON,
  createFrameReader,
} from '../electron/frameReader.js';

const NULL_DIGEST = '0'.repeat(64);
const SURFACE = 'capsule-A';

const BASE_BINDING = Object.freeze({
  principal: 'mv-test',
  epoch: 7,
  surfaceId: SURFACE,
  surfaceGeneration: 3,
});
const BASE_LIMITS = Object.freeze({
  maxFrameBytes: 4096,
  maxWidth: 64,
  maxHeight: 64,
  readTimeoutMs: 1000,
  maxConcurrentReads: 4,
});
const BASE_PIXEL_ENV = Object.freeze({ environmentId: 'test-rig', zoom: 1, dpr: 1 });

/**
 * @param {number} width Frame width.
 * @param {number} height Frame height.
 * @param {number} seed Pattern seed.
 * @returns {Uint8Array} Deterministic asymmetric rgb24 bytes.
 */
function rgbBytes(width, height, seed = 7) {
  const bytes = new Uint8Array(width * height * 3);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (i * 31 + seed * 17 + (i % 3) * 61) % 256;
  }
  return bytes;
}

/**
 * @param {Uint8Array} bytes Payload to hash.
 * @returns {string} Lowercase hex SHA-256, computed independently of the reader.
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {object} [overrides] Field overrides.
 * @returns {Record<string, unknown>} Fresh closed `frame_ref/v0.2` object.
 */
function validRef(overrides = {}) {
  const bytes = rgbBytes(4, 3);
  return {
    schema: 'frame_ref/v0.2',
    surface_id: SURFACE,
    generation: 1,
    tick: 11,
    ts_ns: 22,
    width: 4,
    height: 3,
    format: 'rgb24',
    ramws_path: '/dev/shm/mv-test/f000001.rgb',
    sha256: sha256Hex(bytes),
    capture_us: 33,
    ...overrides,
  };
}

/**
 * @typedef {object} LeaseSpies
 * @property {Array<unknown>} reads Captured `readOwnedBytes` requests.
 * @property {Array<unknown>} releases Captured `release` requests.
 */

/**
 * @param {{bytes?: any, identity?: any, byteLength?: any, published?: any, readImpl?: any, releaseImpl?: any, lease?: any}} [overrides] Lease knobs.
 * @returns {{lease: any, spies: LeaseSpies}} Fake lease plus spies.
 */
function makeLease(overrides = {}) {
  /** @type {LeaseSpies} */
  const spies = { reads: [], releases: [] };
  const bytes = overrides.bytes !== undefined ? overrides.bytes : rgbBytes(4, 3);
  const lease = {
    identity: {
      principal: BASE_BINDING.principal,
      epoch: BASE_BINDING.epoch,
      surfaceId: BASE_BINDING.surfaceId,
      surfaceGeneration: BASE_BINDING.surfaceGeneration,
      frameGeneration: 1,
      leaseId: 'lease-1',
      ...(overrides.identity === undefined ? {} : overrides.identity),
    },
    byteLength: overrides.byteLength !== undefined ? overrides.byteLength : 36,
    published: overrides.published !== undefined ? overrides.published : true,
    readOwnedBytes:
      overrides.readImpl !== undefined
        ? overrides.readImpl
        : /** @param {unknown} request @returns {Promise<unknown>} */ async (request) => {
          spies.reads.push(request);
          return bytes;
        },
    release:
      overrides.releaseImpl !== undefined
        ? overrides.releaseImpl
        : /** @param {unknown} request @returns {Promise<void>} */ async (request) => {
          spies.releases.push(request);
        },
    ...(overrides.lease === undefined ? {} : overrides.lease),
  };
  return { lease, spies };
}

/**
 * @param {unknown} leaseOrFn Lease, lease promise, or per-request factory.
 * @param {Array<unknown>} acquired Capture vector.
 * @returns {import('../electron/frameReader.js').CreateReaderOptions['acquirePublishedLease']} Recording acquire fake.
 */
function recordingAcquire(leaseOrFn, acquired) {
  return /** @type {import('../electron/frameReader.js').CreateReaderOptions['acquirePublishedLease']} */ (
    async (request) => {
      acquired.push(request);
      if (typeof leaseOrFn === 'function') {
        return /** @type {import('../electron/frameReader.js').PublishedLease} */ (
          await /** @type {(request: unknown) => unknown} */ (leaseOrFn)(request)
        );
      }
      return /** @type {import('../electron/frameReader.js').PublishedLease} */ (leaseOrFn);
    }
  );
}

/**
 * @param {{binding?: any, limits?: any, pixelEnvironment?: any, acquireImpl?: any, releaseCallback?: any, lease?: any}} [overrides] Reader knobs.
 * @returns {{reader: import('../electron/frameReader.js').FrameReader, acquired: Array<unknown>, released: Array<unknown>}} Reader plus spies.
 */
function makeReader(overrides = {}) {
  /** @type {Array<unknown>} */
  const acquired = [];
  /** @type {Array<unknown>} */
  const released = [];
  const { lease } = makeLease(overrides.lease === undefined ? {} : overrides.lease);
  const reader = createFrameReader({
    binding: /** @type {import('../electron/frameReader.js').ReaderBinding} */ ({
      ...BASE_BINDING,
      ...(overrides.binding === undefined ? {} : overrides.binding),
    }),
    limits: /** @type {import('../electron/frameReader.js').ReaderLimits} */ ({
      ...BASE_LIMITS,
      ...(overrides.limits === undefined ? {} : overrides.limits),
    }),
    pixelEnvironment: /** @type {import('../electron/frameReader.js').PixelEnvironment} */ ({
      ...BASE_PIXEL_ENV,
      ...(overrides.pixelEnvironment === undefined ? {} : overrides.pixelEnvironment),
    }),
    acquirePublishedLease:
      overrides.acquireImpl !== undefined
        ? /** @type {import('../electron/frameReader.js').CreateReaderOptions['acquirePublishedLease']} */ (
          overrides.acquireImpl
        )
        : recordingAcquire(lease, acquired),
    onReleaseLease: /** @param {unknown} notice */ (notice) => {
      released.push(notice);
      if (overrides.releaseCallback !== undefined) {
        /** @type {(notice: unknown) => void} */ (overrides.releaseCallback)(notice);
      }
    },
  });
  return { reader, acquired, released };
}

/**
 * @param {string} code Expected `FrameReaderError` code.
 * @returns {(error: unknown) => boolean} Throws-validator for factory misuse.
 */
function throwsCode(code) {
  return (error) => error instanceof FrameReaderError && error.code === code;
}

/**
 * @param {number} ms Sleep duration.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('frameReader constants', () => {
  it('freezes the exact C-PIXEL rgb24 declaration', () => {
    assert.deepStrictEqual(C_PIXEL_RGB24_SPEC, {
      format: 'rgb24',
      channelOrder: 'RGB',
      bytesPerPixel: 3,
      strideFormula: 'width * 3',
      orientation: 'top-left',
      alpha: 'none',
      colorSpace: 'sRGB',
    });
    assert.equal(Object.isFrozen(C_PIXEL_RGB24_SPEC), true);
  });

  it('fails an altered pixel declaration against the frozen export', () => {
    assert.throws(() => {
      assert.deepStrictEqual(
        { ...C_PIXEL_RGB24_SPEC, channelOrder: 'BGR', strideFormula: 'width * 4' },
        C_PIXEL_RGB24_SPEC,
      );
    });
  });

  it('freezes the exact shared refusal vocabulary', () => {
    assert.deepStrictEqual(FRAME_REASONS, {
      INVALID_CONTRACT: 'INVALID_CONTRACT',
      INVALID_BUDGET: 'INVALID_BUDGET',
      INVALID_BINDING: 'INVALID_BINDING',
      INVALID_GENERATION: 'INVALID_GENERATION',
      INVALID_PATH: 'INVALID_PATH',
      UNPUBLISHED: 'UNPUBLISHED',
      LEASE_INVALID: 'LEASE_INVALID',
      SIZE_MISMATCH: 'SIZE_MISMATCH',
      DIGEST_MISMATCH: 'DIGEST_MISMATCH',
      NULL_DIGEST: 'NULL_DIGEST',
      SURFACE_MISMATCH: 'SURFACE_MISMATCH',
      STALE_EPOCH: 'STALE_EPOCH',
      STALE_SURFACE_GENERATION: 'STALE_SURFACE_GENERATION',
      STALE_FRAME_GENERATION: 'STALE_FRAME_GENERATION',
      PORT_REVOKED: 'PORT_REVOKED',
      TIMEOUT: 'TIMEOUT',
      IO_ERROR: 'IO_ERROR',
      CLOSED: 'CLOSED',
    });
    assert.equal(Object.isFrozen(FRAME_REASONS), true);
  });

  it('pins the local source-retirement cause', () => {
    assert.equal(SOURCE_RETIRED_REASON, 'SNAPSHOT_VERIFIED');
  });
});

describe('createFrameReader factory', () => {
  it('returns a frozen handle with exactly readFrame and closeReader', () => {
    const { reader } = makeReader();
    assert.deepStrictEqual(Object.keys(reader).sort(), ['closeReader', 'readFrame']);
    assert.equal(Object.isFrozen(reader), true);
  });

  it('throws INVALID_CONTRACT for malformed options shapes', () => {
    for (const bad of [null, 42, 'x', [], [{ }]]) {
      assert.throws(() => createFrameReader(bad), throwsCode('INVALID_CONTRACT'));
    }
    const { lease } = makeLease();
    const good = {
      binding: { ...BASE_BINDING },
      limits: { ...BASE_LIMITS },
      pixelEnvironment: { ...BASE_PIXEL_ENV },
      acquirePublishedLease: async () => lease,
      onReleaseLease: () => {},
    };
    const { binding, ...missingBinding } = good;
    assert.ok(binding);
    assert.throws(() => createFrameReader(missingBinding), throwsCode('INVALID_CONTRACT'));
    assert.throws(
      () => createFrameReader({ ...good, extra: 1 }),
      throwsCode('INVALID_CONTRACT'),
    );
    assert.throws(
      () => createFrameReader({ ...good, [Symbol('s')]: 1 }),
      throwsCode('INVALID_CONTRACT'),
    );
    assert.throws(
      () => createFrameReader({ ...good, acquirePublishedLease: null }),
      throwsCode('INVALID_CONTRACT'),
    );
    assert.throws(
      () => createFrameReader({ ...good, onReleaseLease: 'no' }),
      throwsCode('INVALID_CONTRACT'),
    );
  });

  it('throws INVALID_BINDING for malformed bindings', () => {
    const cases = [
      { principal: '' },
      { principal: 7 },
      { surfaceId: '' },
      { surfaceId: 'x'.repeat(129) },
      { epoch: 0 },
      { epoch: 1.5 },
      { epoch: Number.MAX_SAFE_INTEGER + 1 },
      { surfaceGeneration: -1 },
      { surfaceGeneration: Number.NaN },
    ];
    for (const patch of cases) {
      assert.throws(
        () => makeReader({ binding: { ...BASE_BINDING, ...patch } }),
        throwsCode('INVALID_BINDING'),
      );
    }
    assert.throws(
      () => makeReader({ binding: { ...BASE_BINDING, extra: 1 } }),
      throwsCode('INVALID_BINDING'),
    );
  });

  it('throws INVALID_BUDGET for missing, non-positive, or timer-breaking limits', () => {
    for (const key of ['maxFrameBytes', 'maxWidth', 'maxHeight', 'readTimeoutMs', 'maxConcurrentReads']) {
      for (const bad of [0, -3, 1.5, Number.NaN, '8']) {
        assert.throws(
          () => makeReader({ limits: { ...BASE_LIMITS, [key]: bad } }),
          throwsCode('INVALID_BUDGET'),
        );
      }
    }
    assert.throws(
      () => makeReader({ limits: { ...BASE_LIMITS, readTimeoutMs: 2147483648 } }),
      throwsCode('INVALID_BUDGET'),
    );
    /** @type {any} */
    const partial = { ...BASE_LIMITS };
    delete partial.maxFrameBytes;
    const { lease } = makeLease();
    assert.throws(
      () => createFrameReader({
        binding: { ...BASE_BINDING },
        limits: partial,
        pixelEnvironment: { ...BASE_PIXEL_ENV },
        acquirePublishedLease: async () => lease,
        onReleaseLease: () => {},
      }),
      throwsCode('INVALID_BUDGET'),
    );
  });

  it('throws INVALID_CONTRACT for malformed pixel environments', () => {
    for (const patch of [
      { environmentId: '' },
      { environmentId: 9 },
      { zoom: 0 },
      { zoom: Number.POSITIVE_INFINITY },
      { dpr: -1 },
      { dpr: Number.NaN },
    ]) {
      assert.throws(
        () => makeReader({ pixelEnvironment: { ...BASE_PIXEL_ENV, ...patch } }),
        throwsCode('INVALID_CONTRACT'),
      );
    }
  });

  it('captures configuration by value, immune to later caller mutation', async () => {
    /** @type {import('../electron/frameReader.js').ReaderBinding} */
    const binding = { ...BASE_BINDING };
    /** @type {import('../electron/frameReader.js').ReaderLimits} */
    const limits = { ...BASE_LIMITS };
    /** @type {import('../electron/frameReader.js').PixelEnvironment} */
    const pixelEnvironment = { ...BASE_PIXEL_ENV };
    const { lease } = makeLease();
    /** @type {Array<unknown>} */
    const acquired = [];
    const reader = createFrameReader({
      binding,
      limits,
      pixelEnvironment,
      acquirePublishedLease: recordingAcquire(lease, acquired),
      onReleaseLease: () => {},
    });
    binding.surfaceId = 'capsule-B';
    binding.epoch = 99;
    pixelEnvironment.environmentId = 'hacked';
    pixelEnvironment.dpr = 3;
    limits.maxFrameBytes = 1;
    const outcome = await reader.readFrame(validRef());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.frame.surfaceId, SURFACE);
    assert.equal(outcome.ok && outcome.frame.pixelSpec.environmentId, 'test-rig');
    assert.equal(outcome.ok && outcome.frame.pixelSpec.dpr, 1);
  });
});

describe('readFrame valid path', () => {
  it('verifies a valid rgb24 frame and retires the source exactly once', async () => {
    const bytes = rgbBytes(4, 3);
    const parts = makeLease({ bytes });
    /** @type {Array<unknown>} */
  const acquired = [];
    /** @type {Array<unknown>} */
    const released = [];
    const reader = createFrameReader({
      binding: { ...BASE_BINDING },
      limits: { ...BASE_LIMITS },
      pixelEnvironment: { ...BASE_PIXEL_ENV },
      acquirePublishedLease: recordingAcquire(parts.lease, acquired),
      onReleaseLease: /** @param {unknown} notice */ (notice) => {
        released.push(notice);
      },
    });
    const outcome = await reader.readFrame(validRef());
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok);
    const frame = outcome.frame;
    assert.equal(frame.principal, 'mv-test');
    assert.equal(frame.epoch, 7);
    assert.equal(frame.surfaceId, SURFACE);
    assert.equal(frame.surfaceGeneration, 3);
    assert.equal(frame.frameGeneration, 1);
    assert.equal(frame.leaseId, 'lease-1');
    assert.equal(frame.width, 4);
    assert.equal(frame.height, 3);
    assert.equal(frame.format, 'rgb24');
    assert.equal(frame.sha256, sha256Hex(bytes));
    assert.equal(frame.byteLength, 36);
    assert.deepStrictEqual(frame.pixelSpec, {
      ...C_PIXEL_RGB24_SPEC,
      width: 4,
      height: 3,
      strideBytes: 12,
      environmentId: 'test-rig',
      zoom: 1,
      dpr: 1,
    });
    assert.ok(frame.bytes instanceof Uint8Array);
    assert.deepStrictEqual(frame.bytes, bytes);
    assert.notEqual(frame.bytes, bytes);
    assert.equal(Object.isFrozen(frame), true);
    assert.equal(Object.isFrozen(frame.pixelSpec), true);
    assert.equal(acquired.length, 1);
    assert.equal(parts.spies.reads.length, 1);
    assert.deepStrictEqual(parts.spies.releases, [{ reason: SOURCE_RETIRED_REASON }]);
    assert.deepStrictEqual(released, []);
  });

  it('passes frozen copies and exact request shapes to the capability', async () => {
    const parts = makeLease();
    /** @type {Array<unknown>} */
  const acquired = [];
    const { reader } = makeReader({ acquireImpl: recordingAcquire(parts.lease, acquired) });
    const callerRef = validRef();
    await reader.readFrame(callerRef);
    assert.equal(acquired.length, 1);
    const request = /** @type {Record<string, unknown>} */ (acquired[0]);
    assert.deepStrictEqual(Object.keys(request).sort(), ['binding', 'frameRef', 'signal']);
    assert.deepStrictEqual(request.binding, BASE_BINDING);
    assert.equal(Object.isFrozen(request.binding), true);
    assert.deepStrictEqual(request.frameRef, callerRef);
    assert.equal(Object.isFrozen(request.frameRef), true);
    assert.notEqual(request.frameRef, callerRef);
    assert.ok(request.signal instanceof AbortSignal);
    const readRequest = /** @type {Record<string, unknown>} */ (parts.spies.reads[0]);
    assert.deepStrictEqual(Object.keys(readRequest).sort(), ['maxBytes', 'signal']);
    assert.equal(readRequest.maxBytes, 36);
    assert.ok(readRequest.signal instanceof AbortSignal);
  });

  it('accepts a nested /dev/shm path through the full pipeline', async () => {
    const { reader, acquired } = makeReader();
    const outcome = await reader.readFrame(validRef({ ramws_path: '/dev/shm/mv/a/b/f.rgb' }));
    assert.equal(outcome.ok, true);
    assert.equal(acquired.length, 1);
  });
});

describe('readFrame contract refusals', () => {
  it('refuses non-objects, open shapes, and bad scalar fields before acquiring', async () => {
    const { reader, acquired, released } = makeReader();
    /** @type {Array<any>} */
    const badRefs = [];
    badRefs.push(null, 7, 'ref', []);
    const extra = validRef();
    extra.extra = 1;
    badRefs.push(extra);
    const missing = validRef();
    delete missing.capture_us;
    badRefs.push(missing);
    badRefs.push(validRef({ schema: 'frame_ref/v0.1' }));
    badRefs.push(validRef({ schema: 'frame_ref/v0.2 ' }));
    badRefs.push(validRef({ surface_id: '' }));
    badRefs.push(validRef({ surface_id: 'x'.repeat(129) }));
    badRefs.push(validRef({ surface_id: 7 }));
    badRefs.push(validRef({ tick: -1 }));
    badRefs.push(validRef({ ts_ns: 1.5 }));
    badRefs.push(validRef({ capture_us: Number.NaN }));
    badRefs.push(validRef({ width: 0 }));
    badRefs.push(validRef({ height: true }));
    badRefs.push(validRef({ width: 2.5 }));
    badRefs.push(validRef({ format: 'rgb32' }));
    badRefs.push(validRef({ format: 'RGB24' }));
    badRefs.push(validRef({ sha256: 'A'.repeat(64) }));
    badRefs.push(validRef({ sha256: 'g'.repeat(64) }));
    badRefs.push(validRef({ sha256: 'ab12' }));
    for (const bad of badRefs) {
      const outcome = await reader.readFrame(/** @type {never} */ (bad));
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok);
      assert.equal(outcome.reason, FRAME_REASONS.INVALID_CONTRACT);
    }
    assert.deepStrictEqual(acquired, []);
    assert.deepStrictEqual(released, []);
  });

  it('refuses malformed generations with INVALID_GENERATION', async () => {
    const { reader, acquired } = makeReader();
    for (const generation of [0, -2, true, 1.5, Number.NaN, 2 ** 53, '1']) {
      const outcome = await reader.readFrame(validRef({ generation }));
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok);
      assert.equal(outcome.reason, FRAME_REASONS.INVALID_GENERATION);
    }
    assert.deepStrictEqual(acquired, []);
  });

  it('refuses foreign surfaces without touching the producer', async () => {
    const { reader, acquired, released } = makeReader();
    const outcome = await reader.readFrame(validRef({ surface_id: 'capsule-B' }));
    assert.deepStrictEqual(outcome, { ok: false, reason: FRAME_REASONS.SURFACE_MISMATCH });
    assert.deepStrictEqual(acquired, []);
    assert.deepStrictEqual(released, []);
  });

  it('fails closed on the null-marker digest without acquiring', async () => {
    const { reader, acquired, released } = makeReader();
    const outcome = await reader.readFrame(validRef({ sha256: NULL_DIGEST }));
    assert.deepStrictEqual(outcome, { ok: false, reason: FRAME_REASONS.NULL_DIGEST });
    assert.deepStrictEqual(acquired, []);
    assert.deepStrictEqual(released, []);
  });

  it('refuses every path violation lexically before acquiring', async () => {
    const { reader, acquired } = makeReader();
    for (const ramws_path of [
      '/tmp/mv-test/f.rgb',
      'dev/shm/f.rgb',
      '/dev/shm/',
      '/dev/shm',
      '/dev/shm/a\0b',
      '/dev/shm/../escape.rgb',
      '/dev/shm/a/../../escape.rgb',
      42,
      null,
    ]) {
      const outcome = await reader.readFrame(validRef({ ramws_path }));
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok);
      assert.equal(outcome.reason, FRAME_REASONS.INVALID_PATH);
    }
    assert.deepStrictEqual(acquired, []);
  });

  it('refuses oversize dimensions and overflowing byte products', async () => {
    const { reader } = makeReader();
    const wide = await reader.readFrame(validRef({ width: 65 }));
    assert.ok(!wide.ok && wide.reason === FRAME_REASONS.SIZE_MISMATCH);
    const tall = await reader.readFrame(validRef({ height: 100 }));
    assert.ok(!tall.ok && tall.reason === FRAME_REASONS.SIZE_MISMATCH);
    const big = makeReader({ limits: { ...BASE_LIMITS, maxFrameBytes: 100 } });
    const over = await big.reader.readFrame(validRef({ width: 8, height: 8 }));
    assert.ok(!over.ok && over.reason === FRAME_REASONS.SIZE_MISMATCH);
    const huge = makeReader({
      limits: {
        ...BASE_LIMITS,
        maxFrameBytes: Number.MAX_SAFE_INTEGER,
        maxWidth: 2 ** 31,
        maxHeight: 2 ** 31,
      },
    });
    const overflow = await huge.reader.readFrame(validRef({ width: 2 ** 30, height: 2 ** 30 }));
    assert.ok(!overflow.ok && overflow.reason === FRAME_REASONS.SIZE_MISMATCH);
    assert.equal(overflow.ok, false);
    assert.ok(!overflow.ok);
    assert.equal(overflow.detail, 'dimension-product-overflow');
  });

  it('refuses malformed read options and foreign signals', async () => {
    const { reader, acquired } = makeReader();
    for (const options of ['x', 7, { signal: 42 }, { signal: null }, { extra: 1 }]) {
      const outcome = await reader.readFrame(validRef(), /** @type {never} */ (options));
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok);
      assert.equal(outcome.reason, FRAME_REASONS.INVALID_CONTRACT);
    }
    assert.deepStrictEqual(acquired, []);
  });
});

describe('readFrame generation floor', () => {
  it('refuses regressions and duplicates but accepts advances', async () => {
    /** @type {Array<unknown>} */
  const acquired = [];
    const { reader } = makeReader({
      acquireImpl: recordingAcquire(
        /** @param {unknown} request @returns {Promise<unknown>} */
        (request) => makeLeaseForGeneration(request),
        acquired,
      ),
    });
    const first = await reader.readFrame(validRef({ generation: 2 }));
    assert.equal(first.ok, true);
    const duplicate = await reader.readFrame(validRef({ generation: 2 }));
    assert.ok(!duplicate.ok && duplicate.reason === FRAME_REASONS.STALE_FRAME_GENERATION);
    const regression = await reader.readFrame(validRef({ generation: 1 }));
    assert.ok(!regression.ok && regression.reason === FRAME_REASONS.STALE_FRAME_GENERATION);
    assert.equal(acquired.length, 1);
    const advance = await reader.readFrame(validRef({ generation: 3 }));
    assert.equal(advance.ok, true);
    assert.equal(acquired.length, 2);
  });

  it('leaves the floor untouched when verification fails', async () => {
    const good = rgbBytes(4, 3);
    const bad = new Uint8Array(good);
    bad[0] = (bad[0] + 1) % 256;
    let calls = 0;
    const { reader } = makeReader({
      acquireImpl: async () => {
        calls += 1;
        return makeLease({
          bytes: calls === 1 ? bad : good,
          identity: { frameGeneration: 5 },
        }).lease;
      },
    });
    const ref = validRef({ generation: 5 });
    const failed = await reader.readFrame(ref);
    assert.ok(!failed.ok && failed.reason === FRAME_REASONS.DIGEST_MISMATCH);
    const retry = await reader.readFrame(validRef({ generation: 5 }));
    assert.equal(retry.ok, true);
  });
});

/**
 * @param {unknown} request Acquire request carrying the admitted ref.
 * @returns {Promise<unknown>} Matching fake lease for the requested generation.
 */
async function makeLeaseForGeneration(request) {
  const ref = /** @type {{generation: number}} */ (
    /** @type {Record<string, unknown>} */ (request).frameRef
  );
  const { lease } = makeLease({ identity: { frameGeneration: ref.generation } });
  return lease;
}

describe('readFrame lease faults', () => {
  it('maps capability failures to IO_ERROR with no lease to drop', async () => {
    const throwing = makeReader({
      acquireImpl: () => {
        throw new Error('spawn gone');
      },
    });
    const syncFailed = await throwing.reader.readFrame(validRef());
    assert.ok(!syncFailed.ok && syncFailed.reason === FRAME_REASONS.IO_ERROR);
    const rejecting = makeReader({
      acquireImpl: async () => {
        throw new Error('bridge gone');
      },
    });
    const asyncFailed = await rejecting.reader.readFrame(validRef());
    assert.ok(!asyncFailed.ok && asyncFailed.reason === FRAME_REASONS.IO_ERROR);
    assert.deepStrictEqual(rejecting.released, []);
  });

  it('refuses malformed leases without release or notice', async () => {
    for (const malformed of [null, 7, 'lease', []]) {
      /** @type {Array<unknown>} */
    const released = [];
      const reader = createFrameReader({
        binding: { ...BASE_BINDING },
        limits: { ...BASE_LIMITS },
        pixelEnvironment: { ...BASE_PIXEL_ENV },
        acquirePublishedLease: async () => /** @type {never} */ (malformed),
        onReleaseLease: /** @param {unknown} notice */ (notice) => {
          released.push(notice);
        },
      });
      const outcome = await reader.readFrame(validRef());
      assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.LEASE_INVALID);
      assert.deepStrictEqual(released, []);
    }
  });

  it('refuses leases without callable capabilities and never notifies', async () => {
    const { lease } = makeLease({ lease: { release: null } });
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(lease, []),
    });
    const outcome = await reader.readFrame(validRef());
    assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.LEASE_INVALID);
    assert.deepStrictEqual(released, []);
  });

  it('retires but never reports leases with malformed identity', async () => {
    const parts = makeLease({ lease: { identity: 'not-an-identity' } });
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(parts.lease, []),
    });
    const outcome = await reader.readFrame(validRef());
    assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.LEASE_INVALID);
    assert.equal(parts.spies.releases.length, 1);
    assert.deepStrictEqual(released, []);
  });

  it('reports mismatched but well-typed identities honestly with LEASE_INVALID', async () => {
    const parts = makeLease({ identity: { surfaceId: 'capsule-B' } });
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(parts.lease, []),
    });
    const outcome = await reader.readFrame(validRef());
    assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.LEASE_INVALID);
    assert.deepStrictEqual(parts.spies.releases, [{ reason: FRAME_REASONS.LEASE_INVALID }]);
    assert.deepStrictEqual(released, [{
      principal: 'mv-test',
      epoch: 7,
      surfaceId: 'capsule-B',
      surfaceGeneration: 3,
      frameGeneration: 1,
      leaseId: 'lease-1',
      reason: FRAME_REASONS.LEASE_INVALID,
    }]);
  });

  it('refuses generation-mismatched, unpublished, and misdeclared leases', async () => {
    const mismatched = makeLease({ identity: { frameGeneration: 99 } });
    const { reader: readerA, released: noticesA } = makeReader({
      acquireImpl: recordingAcquire(mismatched.lease, []),
    });
    const outcomeA = await readerA.readFrame(validRef({ generation: 1 }));
    assert.ok(!outcomeA.ok && outcomeA.reason === FRAME_REASONS.LEASE_INVALID);
    assert.equal(mismatched.spies.releases.length, 1);
    assert.equal(noticesA.length, 1);

    const unsealed = makeLease({ published: false });
    const { reader: readerB, released: noticesB } = makeReader({
      acquireImpl: recordingAcquire(unsealed.lease, []),
    });
    const outcomeB = await readerB.readFrame(validRef());
    assert.ok(!outcomeB.ok && outcomeB.reason === FRAME_REASONS.UNPUBLISHED);
    assert.deepStrictEqual(unsealed.spies.releases, [{ reason: FRAME_REASONS.UNPUBLISHED }]);
    assert.equal(noticesB.length, 1);

    const misdeclared = makeLease({ byteLength: 35 });
    const { reader: readerC } = makeReader({
      acquireImpl: recordingAcquire(misdeclared.lease, []),
    });
    const outcomeC = await readerC.readFrame(validRef());
    assert.ok(!outcomeC.ok && outcomeC.reason === FRAME_REASONS.SIZE_MISMATCH);
    assert.equal(misdeclared.spies.releases.length, 1);
  });

  it('maps read failures to IO_ERROR and drops the held lease once', async () => {
    const parts = makeLease({
      readImpl: async () => {
        throw new Error('shm torn');
      },
    });
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(parts.lease, []),
    });
    const outcome = await reader.readFrame(validRef());
    assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.IO_ERROR);
    assert.deepStrictEqual(parts.spies.releases, [{ reason: FRAME_REASONS.IO_ERROR }]);
    assert.equal(released.length, 1);
    assert.equal(released.length, 1);
    assert.equal(
      /** @type {{reason: string}} */ (released[0]).reason,
      FRAME_REASONS.IO_ERROR,
    );
  });
});

describe('readFrame pixel integrity', () => {
  it('refuses non-Uint8Array and shared-memory payloads', async () => {
    for (const bytes of [
      Array.from(rgbBytes(4, 3)),
      new DataView(rgbBytes(4, 3).buffer),
      'bytes',
      new Uint8Array(new SharedArrayBuffer(36)),
    ]) {
      const parts = makeLease({ bytes });
      const { reader, released } = makeReader({
        acquireImpl: recordingAcquire(parts.lease, []),
      });
      const outcome = await reader.readFrame(validRef());
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok);
      assert.equal(outcome.reason, FRAME_REASONS.LEASE_INVALID);
      assert.equal(parts.spies.releases.length, 1);
      assert.equal(released.length, 1);
    }
  });

  it('refuses short and long payloads with SIZE_MISMATCH', async () => {
    for (const bytes of [rgbBytes(4, 3).slice(0, 35), new Uint8Array(37)]) {
      const parts = makeLease({ bytes });
      const { reader } = makeReader({
        acquireImpl: recordingAcquire(parts.lease, []),
      });
      const outcome = await reader.readFrame(validRef());
      assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.SIZE_MISMATCH);
      assert.equal(parts.spies.releases.length, 1);
    }
  });

  it('refuses disguised PNG bytes even when their digest matches', async () => {
    const bytes = rgbBytes(4, 3);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const parts = makeLease({ bytes });
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(parts.lease, []),
    });
    const outcome = await reader.readFrame(validRef({ sha256: sha256Hex(bytes) }));
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, FRAME_REASONS.INVALID_CONTRACT);
    assert.equal(outcome.detail, 'png-signature-in-rgb24-payload');
    assert.equal(parts.spies.releases.length, 1);
    assert.equal(released.length, 1);
  });

  it('refuses tampered bytes with DIGEST_MISMATCH and keeps the floor', async () => {
    const bytes = rgbBytes(4, 3);
    const tampered = new Uint8Array(bytes);
    tampered[17] = (tampered[17] + 1) % 256;
    const parts = makeLease({ bytes: tampered });
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(parts.lease, []),
    });
    const outcome = await reader.readFrame(validRef());
    assert.deepStrictEqual(outcome, { ok: false, reason: FRAME_REASONS.DIGEST_MISMATCH });
    assert.deepStrictEqual(parts.spies.releases, [{ reason: FRAME_REASONS.DIGEST_MISMATCH }]);
    assert.equal(released.length, 1);
  });

  it('fails a bypass mutant that would accept tampered bytes', async () => {
    const bytes = rgbBytes(4, 3);
    const tampered = new Uint8Array(bytes);
    tampered[0] = (tampered[0] + 1) % 256;
    assert.throws(() => {
      assert.deepStrictEqual(tampered, bytes);
    });
    assert.notEqual(sha256Hex(tampered), sha256Hex(bytes));
  });
});

describe('readFrame timeout, concurrency, and close', () => {
  it('times out a stalled acquisition promptly with TIMEOUT', async () => {
    /** @type {Array<unknown>} */
  const acquired = [];
    const { reader, released } = makeReader({
      limits: { ...BASE_LIMITS, readTimeoutMs: 25 },
      acquireImpl: recordingAcquire(new Promise(() => {}), acquired),
    });
    const started = Date.now();
    const outcome = await reader.readFrame(validRef());
    const elapsed = Date.now() - started;
    assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.TIMEOUT);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.equal(outcome.detail, 'read-timeout');
    assert.ok(elapsed < 2000, `timeout took ${elapsed}ms`);
    assert.equal(acquired.length, 1);
    assert.deepStrictEqual(released, []);
  });

  it('retires a lease that settles after the read already timed out', async () => {
    const parts = makeLease();
    const { reader, released } = makeReader({
      limits: { ...BASE_LIMITS, readTimeoutMs: 20 },
      acquireImpl: async () => {
        await sleep(60);
        return parts.lease;
      },
    });
    const outcome = await reader.readFrame(validRef());
    assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.TIMEOUT);
    await sleep(150);
    assert.deepStrictEqual(parts.spies.releases, [{ reason: FRAME_REASONS.TIMEOUT }]);
    assert.deepStrictEqual(parts.spies.reads, []);
    assert.deepStrictEqual(released, []);
  });

  it('refuses a pre-aborted caller signal without acquiring', async () => {
    const controller = new AbortController();
    controller.abort();
    const { reader, acquired } = makeReader();
    const outcome = await reader.readFrame(validRef(), { signal: controller.signal });
    assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.TIMEOUT);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.equal(outcome.detail, 'aborted');
    assert.deepStrictEqual(acquired, []);
  });

  it('aborts a mid-flight read on caller abort and drops nothing admitted', async () => {
    /** @type {(value: unknown) => void} */
    let releaseLease = () => {};
    const gate = new Promise((resolve) => {
      releaseLease = resolve;
    });
    const parts = makeLease();
    /** @type {Array<unknown>} */
  const acquired = [];
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(
        gate.then(() => parts.lease),
        acquired,
      ),
    });
    const controller = new AbortController();
    const pending = reader.readFrame(validRef(), { signal: controller.signal });
    controller.abort();
    const outcome = await pending;
    assert.ok(!outcome.ok && outcome.reason === FRAME_REASONS.TIMEOUT);
    assert.equal(acquired.length, 1);
    releaseLease(undefined);
    await sleep(20);
    assert.deepStrictEqual(parts.spies.releases, [{ reason: FRAME_REASONS.TIMEOUT }]);
    assert.deepStrictEqual(released, []);
  });

  it('refuses reads beyond the concurrency bound without disturbing the first', async () => {
    /** @type {(value: unknown) => void} */
    let resolveAcquire = () => {};
    const gate = new Promise((resolve) => {
      resolveAcquire = resolve;
    });
    const parts = makeLease();
    const { reader } = makeReader({
      limits: { ...BASE_LIMITS, maxConcurrentReads: 1 },
      acquireImpl: recordingAcquire(
        gate.then(() => parts.lease),
        [],
      ),
    });
    const first = reader.readFrame(validRef({ generation: 1 }));
    const saturated = await reader.readFrame(validRef({ generation: 2 }));
    assert.ok(!saturated.ok && saturated.reason === FRAME_REASONS.TIMEOUT);
    assert.equal(saturated.ok, false);
    assert.ok(!saturated.ok);
    assert.equal(saturated.detail, 'no-read-slot');
    resolveAcquire(undefined);
    const outcome = await first;
    assert.equal(outcome.ok, true);
  });

  it('closes idempotently and refuses later reads with CLOSED', async () => {
    const { reader, acquired } = makeReader();
    await reader.closeReader();
    await reader.closeReader();
    const outcome = await reader.readFrame(validRef());
    assert.deepStrictEqual(outcome, { ok: false, reason: FRAME_REASONS.CLOSED });
    assert.deepStrictEqual(acquired, []);
  });

  it('aborts an in-flight acquisition on close and retires the late lease', async () => {
    /** @type {(value: unknown) => void} */
    let resolveAcquire = () => {};
    const gate = new Promise((resolve) => {
      resolveAcquire = resolve;
    });
    const parts = makeLease();
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(
        gate.then(() => parts.lease),
        [],
      ),
    });
    const pending = reader.readFrame(validRef());
    await reader.closeReader();
    const outcome = await pending;
    assert.deepStrictEqual(outcome, { ok: false, reason: FRAME_REASONS.CLOSED });
    resolveAcquire(undefined);
    await sleep(20);
    assert.deepStrictEqual(parts.spies.releases, [{ reason: FRAME_REASONS.CLOSED }]);
    assert.deepStrictEqual(released, []);
  });

  it('aborts an in-flight payload read on close and drops the held lease', async () => {
    const parts = makeLease({
      readImpl: () => new Promise(() => {}),
    });
    const { reader, released } = makeReader({
      acquireImpl: recordingAcquire(parts.lease, []),
    });
    const pending = reader.readFrame(validRef());
    await sleep(10);
    await reader.closeReader();
    const outcome = await pending;
    assert.deepStrictEqual(outcome, { ok: false, reason: FRAME_REASONS.CLOSED });
    assert.deepStrictEqual(parts.spies.releases, [{ reason: FRAME_REASONS.CLOSED }]);
    assert.equal(released.length, 1);
    assert.deepStrictEqual(released[0], {
      principal: 'mv-test',
      epoch: 7,
      surfaceId: SURFACE,
      surfaceGeneration: 3,
      frameGeneration: 1,
      leaseId: 'lease-1',
      reason: FRAME_REASONS.CLOSED,
    });
  });
});

describe('readFrame loud integration faults', () => {
  it('propagates a failing source release without advancing the floor', async () => {
    const parts = makeLease({
      releaseImpl: async () => {
        throw new Error('producer retire failed');
      },
    });
    let calls = 0;
    const fixed = makeLease();
    const { reader } = makeReader({
      acquireImpl: async () => {
        calls += 1;
        return calls === 1 ? parts.lease : fixed.lease;
      },
    });
    await assert.rejects(reader.readFrame(validRef({ generation: 1 })), /producer retire failed/);
    const retry = await reader.readFrame(validRef({ generation: 1 }));
    assert.equal(retry.ok, true);
  });

  it('propagates a throwing owner callback after the single release', async () => {
    const bytes = rgbBytes(4, 3);
    const tampered = new Uint8Array(bytes);
    tampered[5] = (tampered[5] + 1) % 256;
    const parts = makeLease({ bytes: tampered });
    /** @type {Array<unknown>} */
    const released = [];
    const reader = createFrameReader({
      binding: { ...BASE_BINDING },
      limits: { ...BASE_LIMITS },
      pixelEnvironment: { ...BASE_PIXEL_ENV },
      acquirePublishedLease: recordingAcquire(parts.lease, []),
      onReleaseLease: /** @param {unknown} notice */ (notice) => {
        released.push(notice);
        throw new Error('owner accounting down');
      },
    });
    await assert.rejects(reader.readFrame(validRef()), /owner accounting down/);
    assert.deepStrictEqual(parts.spies.releases, [{ reason: FRAME_REASONS.DIGEST_MISMATCH }]);
    assert.equal(released.length, 1);
  });
});
