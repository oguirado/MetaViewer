// @ts-check
'use strict';

/**
 * W1-FRAMES-READER: verify immutable rgb24 frame generations before publishing.
 *
 * Runs in an Electron utility process. Consumes `frame_ref/v0.1` references,
 * acquires the published source through the injected trusted producer
 * capability, copies a bounded private snapshot, declares the C-PIXEL layout
 * before hashing, and verifies packed size plus SHA-256 before returning an
 * owned `VerifiedFrame`. Never reads an unpublished or under-write buffer.
 *
 * Split of duties (REPORT_S02): the producer capability guarantees
 * publication, path safety (symlink ancestry, owner, type) and retention;
 * this reader enforces the closed contract shape, lexical path bounds, byte
 * budget, digest, null-digest fail-closed, and the per-surface generation
 * floor. Source and delivery leases are separate: on success the source
 * retires via `lease.release()` and the delivery lease stays alive downstream
 * (the port owns its release), so `onReleaseLease` fires only for leases the
 * reader drops without delivering. Callback and producer-release faults
 * propagate loudly; reader state stays consistent either way.
 *
 * mmap / native-shm reads are ABSENT; the bounded owned copy is the target.
 * Per-frame epoch / pixel-environment wire witnesses await the v0.2 producer
 * reference (ABSENT, never invented): the configured contract-reviewed
 * `pixelEnvironment` is stamped into every verified `pixelSpec`.
 *
 * @module frameReader
 */

import { createHash } from 'node:crypto';

/**
 * @typedef {object} ReaderBinding Local identity bound at factory time.
 * @property {string} principal Owning principal.
 * @property {number} epoch Bound epoch, positive safe integer.
 * @property {string} surfaceId Bound surface id.
 * @property {number} surfaceGeneration Bound surface generation, positive safe integer.
 */

/**
 * @typedef {object} ReaderLimits Explicit bounds, no defaults.
 * @property {number} maxFrameBytes Maximum verified payload bytes.
 * @property {number} maxWidth Maximum frame width.
 * @property {number} maxHeight Maximum frame height.
 * @property {number} readTimeoutMs Per-read acquire/read deadline.
 * @property {number} maxConcurrentReads Maximum in-flight reads.
 */

/**
 * @typedef {object} PixelEnvironment Contract-reviewed capture environment.
 * @property {string} environmentId Capture environment identity.
 * @property {number} zoom Capture zoom factor.
 * @property {number} dpr Capture device pixel ratio.
 */

/**
 * @typedef {object} FrameRef Admitted `frame_ref/v0.1` fields.
 * @property {string} schema Must equal `frame_ref/v0.1`.
 * @property {string} surface_id Surface identity.
 * @property {number} generation Frame generation, integer >= 1.
 * @property {number} tick Source tick.
 * @property {number} ts_ns Source timestamp.
 * @property {number} width Frame width.
 * @property {number} height Frame height.
 * @property {string} format Must equal `rgb24`.
 * @property {string} ramws_path Source path under `/dev/shm/`.
 * @property {string} sha256 Lowercase hex digest of the packed rgb24 bytes.
 * @property {number} capture_us Capture duration.
 */

/**
 * @typedef {object} FrameIdentity Identity carried by verified frames.
 * @property {string} principal Owning principal.
 * @property {number} epoch Bound epoch.
 * @property {string} surfaceId Bound surface id.
 * @property {number} surfaceGeneration Bound surface generation.
 * @property {number} frameGeneration Verified frame generation.
 * @property {string} leaseId Producer lease identity.
 */

/**
 * @typedef {object} PixelSpec Declared layout, fixed before hashing.
 * @property {string} format `rgb24`.
 * @property {string} channelOrder `RGB`.
 * @property {number} bytesPerPixel 3.
 * @property {string} strideFormula `width * 3`.
 * @property {string} orientation `top-left`.
 * @property {string} alpha `none`.
 * @property {string} colorSpace `sRGB`.
 * @property {number} width Frame width witness.
 * @property {number} height Frame height witness.
 * @property {number} strideBytes Tightly packed row stride (`width * 3`).
 * @property {string} environmentId Capture environment witness.
 * @property {number} zoom Capture zoom witness.
 * @property {number} dpr Capture device-pixel-ratio witness.
 */

/**
 * @typedef {object} VerifiedFrame Owned verified snapshot for the port.
 * @property {string} principal Owning principal.
 * @property {number} epoch Bound epoch.
 * @property {string} surfaceId Bound surface id.
 * @property {number} surfaceGeneration Bound surface generation.
 * @property {number} frameGeneration Verified frame generation.
 * @property {string} leaseId Delivery lease identity.
 * @property {number} width Frame width.
 * @property {number} height Frame height.
 * @property {string} format `rgb24`.
 * @property {string} sha256 Verified digest.
 * @property {number} byteLength Verified payload length.
 * @property {PixelSpec} pixelSpec Frozen declared layout.
 * @property {Uint8Array} bytes Owned private snapshot, never shared memory.
 */

/**
 * @typedef {object} LeaseRelease Single-object release notice to the owner.
 * @property {string} principal Owning principal.
 * @property {number} epoch Bound epoch.
 * @property {string} surfaceId Bound surface id.
 * @property {number} surfaceGeneration Bound surface generation.
 * @property {number} frameGeneration Frame generation of the dropped lease.
 * @property {string} leaseId Dropped lease identity.
 * @property {string} reason Frozen refusal reason for the drop.
 */

/**
 * @typedef {object} PublishedLease Trusted producer handle (injected).
 * @property {FrameIdentity} identity Producer-pinned identity.
 * @property {number} byteLength Declared immutable payload length.
 * @property {boolean} published True only for sealed, published sources.
 * @property {(request: {maxBytes: number, signal: AbortSignal}) => Promise<Uint8Array>} readOwnedBytes Bounded owned read.
 * @property {(request: {reason: string}) => Promise<void>} release Retire the source once.
 */

/**
 * @typedef {object} CreateReaderOptions Factory options, closed shape.
 * @property {ReaderBinding} binding Bound local identity.
 * @property {ReaderLimits} limits Explicit bounds.
 * @property {PixelEnvironment} pixelEnvironment Contract-reviewed capture environment.
 * @property {(request: {binding: ReaderBinding, frameRef: FrameRef, signal: AbortSignal}) => Promise<PublishedLease>} acquirePublishedLease Trusted producer capability.
 * @property {(release: LeaseRelease) => void} onReleaseLease Owner notice for dropped leases.
 */

/**
 * @typedef {object} ReadSuccess Verified outcome.
 * @property {true} ok Success marker.
 * @property {VerifiedFrame} frame Owned verified frame.
 */

/**
 * @typedef {object} ReadRefusal Refused outcome.
 * @property {false} ok Refusal marker.
 * @property {string} reason Frozen `FRAME_REASONS` value.
 * @property {string} [detail] Free-form diagnostic, never a second vocabulary.
 */

/**
 * @typedef {ReadSuccess|ReadRefusal} ReadOutcome Closed read outcome.
 */

/**
 * @typedef {object} FrameReader Frozen reader handle.
 * @property {(frameRef: unknown, options?: {signal?: AbortSignal}) => Promise<ReadOutcome>} readFrame Verify one frame reference.
 * @property {() => Promise<void>} closeReader Abort in-flight reads; idempotent.
 */

/**
 * C-PIXEL declaration for raw rgb24 (channel order, stride, orientation,
 * alpha, color space fixed before any digest is computed). Dimensions and
 * environment are stamped per frame into `pixelSpec`; there is no DPR
 * default.
 * @type {Readonly<{format: string, channelOrder: string, bytesPerPixel: number, strideFormula: string, orientation: string, alpha: string, colorSpace: string}>}
 */
export const C_PIXEL_RGB24_SPEC = Object.freeze({
  format: 'rgb24',
  channelOrder: 'RGB',
  bytesPerPixel: 3,
  strideFormula: 'width * 3',
  orientation: 'top-left',
  alpha: 'none',
  colorSpace: 'sRGB',
});

/**
 * Frozen refusal vocabulary shared by reader and port. The reader emits the
 * subset it can observe; epoch and port-lifetime codes belong to the port.
 * @type {Readonly<{INVALID_CONTRACT: string, INVALID_BUDGET: string, INVALID_BINDING: string, INVALID_GENERATION: string, INVALID_PATH: string, UNPUBLISHED: string, LEASE_INVALID: string, SIZE_MISMATCH: string, DIGEST_MISMATCH: string, NULL_DIGEST: string, SURFACE_MISMATCH: string, STALE_EPOCH: string, STALE_SURFACE_GENERATION: string, STALE_FRAME_GENERATION: string, PORT_REVOKED: string, TIMEOUT: string, IO_ERROR: string, CLOSED: string}>}
 */
export const FRAME_REASONS = Object.freeze({
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

/**
 * Local source-retirement cause passed to `lease.release()` after a snapshot
 * verifies. The producer reclaim protocol is ABSENT, so this string stays a
 * local detail, never a wire outcome.
 * @type {string}
 */
export const SOURCE_RETIRED_REASON = 'SNAPSHOT_VERIFIED';

/** Null-marker digest: test-mode refs carry no live pixel binding. */
const NULL_DIGEST = '0'.repeat(64);

/** Expected schema tag of consumed frame references. */
const FRAME_REF_SCHEMA = 'frame_ref/v0.1';

/** Only root the reader accepts lexically; deeper checks are the capability's. */
const SHM_PREFIX = '/dev/shm/';

/** Pinned PNG signature: declared rgb24 must never carry it. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Largest delay the platform timer accepts without overflow. */
const MAX_TIMER_MS = 2147483647;

/** Closed key sets, sorted once so literals cannot drift. */
const FRAME_REF_KEYS = Object.freeze(
  ['schema', 'surface_id', 'generation', 'tick', 'ts_ns', 'width', 'height',
    'format', 'ramws_path', 'sha256', 'capture_us'].slice().sort().join(','),
);
const OPTIONS_KEYS = Object.freeze(
  ['binding', 'limits', 'pixelEnvironment', 'acquirePublishedLease', 'onReleaseLease']
    .slice().sort().join(','),
);
const BINDING_KEYS = Object.freeze(
  ['principal', 'epoch', 'surfaceId', 'surfaceGeneration'].slice().sort().join(','),
);
const LIMITS_KEYS = Object.freeze(
  ['maxFrameBytes', 'maxWidth', 'maxHeight', 'readTimeoutMs', 'maxConcurrentReads']
    .slice().sort().join(','),
);
const PIXEL_ENV_KEYS = Object.freeze(
  ['environmentId', 'zoom', 'dpr'].slice().sort().join(','),
);

/**
 * Typed factory/configuration failure; a failure admits nothing.
 */
export class FrameReaderError extends Error {
  /**
   * @param {string} code Frozen `FRAME_REASONS` value.
   * @param {string} message Human-readable detail.
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'FrameReaderError';
    /** @type {string} */
    this.code = code;
  }
}

/** Internal abort marker carrying the abort origin. */
class ReadAborted extends Error {
  /**
   * @param {string} abortCause One of `timeout`, `caller`, `closed`.
   */
  constructor(abortCause) {
    super(`aborted: ${abortCause}`);
    this.name = 'ReadAborted';
    /** @type {string} */
    this.abortCause = abortCause;
  }
}

/**
 * @param {string} reason Frozen refusal reason.
 * @param {string} [detail] Free-form diagnostic.
 * @returns {ReadRefusal} The refusal outcome.
 */
function refusal(reason, detail) {
  if (detail === undefined) {
    return { ok: false, reason };
  }
  return { ok: false, reason, detail };
}

/**
 * @param {unknown} value Alleged record.
 * @returns {boolean} True for a non-array object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value Alleged record with exactly the expected own keys.
 * @param {string} expected Sorted-join literal of the closed key set.
 * @returns {boolean} True when the shape is closed and complete.
 */
function hasClosedKeys(value, expected) {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(/** @type {Record<string, unknown>} */ (value)).sort().join(',') === expected;
}

/**
 * A dropped lease is reported to the owner only when its identity is fully
 * typed; values may still mismatch the binding (reported honestly with the
 * refusal reason), but malformed shapes never reach the callback.
 * @param {unknown} value Alleged frame identity.
 * @returns {boolean} True for a fully typed identity shape.
 */
function isWellTypedIdentity(value) {
  if (!isRecord(value)) {
    return false;
  }
  const identity = /** @type {Record<string, unknown>} */ (value);
  return typeof identity.principal === 'string' && identity.principal.length > 0
    && typeof identity.surfaceId === 'string' && identity.surfaceId.length > 0
    && typeof identity.leaseId === 'string' && identity.leaseId.length > 0
    && Number.isSafeInteger(identity.epoch) && Number.isSafeInteger(identity.surfaceGeneration)
    && Number.isSafeInteger(identity.frameGeneration);
}

/**
 * @param {unknown} value Alleged positive safe integer.
 * @returns {boolean} True for integers in `[1, 2^53 - 1]`.
 */
function isPositiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * @param {unknown} value Alleged non-negative safe integer.
 * @returns {boolean} True for integers in `[0, 2^53 - 1]`.
 */
function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Lexical ramws path bounds: `/dev/shm/` root, no NUL, no `..` segment.
 * Symlink ancestry, ownership and file type stay with the trusted capability.
 * @param {unknown} value Alleged source path.
 * @returns {ReadRefusal|null} Refusal on violation, else null.
 */
function checkRamwsPath(value) {
  if (typeof value !== 'string') {
    return refusal(FRAME_REASONS.INVALID_PATH, 'bad-path');
  }
  if (!value.startsWith(SHM_PREFIX) || value.length === SHM_PREFIX.length) {
    return refusal(FRAME_REASONS.INVALID_PATH, 'wrong-root');
  }
  if (value.includes('\0')) {
    return refusal(FRAME_REASONS.INVALID_PATH, 'nul-byte');
  }
  if (value.split('/').includes('..')) {
    return refusal(FRAME_REASONS.INVALID_PATH, 'traversal');
  }
  return null;
}

/**
 * Admit a closed `frame_ref/v0.1` object into a fresh copy. Never returns the
 * caller object, so later caller mutation cannot widen an admitted read.
 * @param {unknown} frameRef Alleged frame reference.
 * @returns {{ok: true, ref: FrameRef}|{ok: false, outcome: ReadRefusal}} Admitted copy or refusal.
 */
function admitFrameRef(frameRef) {
  if (!hasClosedKeys(frameRef, /** @type {string} */ (FRAME_REF_KEYS))) {
    return { ok: false, outcome: refusal(FRAME_REASONS.INVALID_CONTRACT, 'unknown-or-missing-keys') };
  }
  const raw = /** @type {Record<string, unknown>} */ (frameRef);
  if (raw.schema !== FRAME_REF_SCHEMA) {
    return { ok: false, outcome: refusal(FRAME_REASONS.INVALID_CONTRACT, 'bad-schema') };
  }
  if (typeof raw.surface_id !== 'string' || raw.surface_id.length < 1 || raw.surface_id.length > 128) {
    return { ok: false, outcome: refusal(FRAME_REASONS.INVALID_CONTRACT, 'bad-surface-id') };
  }
  if (!isPositiveInt(raw.generation)) {
    return { ok: false, outcome: refusal(FRAME_REASONS.INVALID_GENERATION, 'bad-generation') };
  }
  if (!isNonNegativeInt(raw.tick) || !isNonNegativeInt(raw.ts_ns) || !isNonNegativeInt(raw.capture_us)) {
    return { ok: false, outcome: refusal(FRAME_REASONS.INVALID_CONTRACT, 'bad-witness') };
  }
  if (!isPositiveInt(raw.width) || !isPositiveInt(raw.height)) {
    return { ok: false, outcome: refusal(FRAME_REASONS.INVALID_CONTRACT, 'bad-dimensions') };
  }
  if (raw.format !== 'rgb24') {
    return { ok: false, outcome: refusal(FRAME_REASONS.INVALID_CONTRACT, 'bad-format') };
  }
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    return { ok: false, outcome: refusal(FRAME_REASONS.INVALID_CONTRACT, 'bad-sha256') };
  }
  const pathOutcome = checkRamwsPath(raw.ramws_path);
  if (pathOutcome !== null) {
    return { ok: false, outcome: pathOutcome };
  }
  const ref = Object.freeze({
    schema: FRAME_REF_SCHEMA,
    surface_id: /** @type {string} */ (raw.surface_id),
    generation: /** @type {number} */ (raw.generation),
    tick: /** @type {number} */ (raw.tick),
    ts_ns: /** @type {number} */ (raw.ts_ns),
    width: /** @type {number} */ (raw.width),
    height: /** @type {number} */ (raw.height),
    format: 'rgb24',
    ramws_path: /** @type {string} */ (raw.ramws_path),
    sha256: /** @type {string} */ (raw.sha256),
    capture_us: /** @type {number} */ (raw.capture_us),
  });
  return { ok: true, ref: /** @type {FrameRef} */ (ref) };
}

/**
 * @param {unknown} value Alleged reader options.
 * @returns {{binding: ReaderBinding, limits: ReaderLimits, pixelEnvironment: PixelEnvironment, acquirePublishedLease: CreateReaderOptions['acquirePublishedLease'], onReleaseLease: CreateReaderOptions['onReleaseLease']}} Validated handles.
 */
function assertReaderOptions(value) {
  if (!isRecord(value)) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_CONTRACT, 'options must be an object');
  }
  const options = /** @type {Record<string, unknown>} */ (value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_CONTRACT, 'options must not carry symbol keys');
  }
  if (!hasClosedKeys(value, /** @type {string} */ (OPTIONS_KEYS))) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_CONTRACT, 'options must be exactly {binding, limits, pixelEnvironment, acquirePublishedLease, onReleaseLease}');
  }
  if (!hasClosedKeys(options.binding, /** @type {string} */ (BINDING_KEYS))) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_BINDING, 'binding has unknown or missing keys');
  }
  const binding = /** @type {Record<string, unknown>} */ (options.binding);
  if (typeof binding.principal !== 'string' || binding.principal.length === 0) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_BINDING, 'binding.principal must be a non-empty string');
  }
  if (typeof binding.surfaceId !== 'string' || binding.surfaceId.length === 0 || binding.surfaceId.length > 128) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_BINDING, 'binding.surfaceId must be a 1..128 character string');
  }
  if (!isPositiveInt(binding.epoch) || !isPositiveInt(binding.surfaceGeneration)) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_BINDING, 'binding epoch and surfaceGeneration must be positive safe integers');
  }
  if (!hasClosedKeys(options.limits, /** @type {string} */ (LIMITS_KEYS))) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_BUDGET, 'limits has unknown or missing keys');
  }
  const limits = /** @type {Record<string, unknown>} */ (options.limits);
  for (const key of ['maxFrameBytes', 'maxWidth', 'maxHeight', 'readTimeoutMs', 'maxConcurrentReads']) {
    if (!isPositiveInt(limits[key])) {
      throw new FrameReaderError(FRAME_REASONS.INVALID_BUDGET, `limits.${key} must be a positive safe integer`);
    }
  }
  if (/** @type {number} */ (limits.readTimeoutMs) > MAX_TIMER_MS) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_BUDGET, 'limits.readTimeoutMs exceeds the platform timer range');
  }
  if (!hasClosedKeys(options.pixelEnvironment, /** @type {string} */ (PIXEL_ENV_KEYS))) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_CONTRACT, 'pixelEnvironment has unknown or missing keys');
  }
  const pixelEnvironment = /** @type {Record<string, unknown>} */ (options.pixelEnvironment);
  if (typeof pixelEnvironment.environmentId !== 'string' || pixelEnvironment.environmentId.length === 0) {
    throw new FrameReaderError(FRAME_REASONS.INVALID_CONTRACT, 'pixelEnvironment.environmentId must be a non-empty string');
  }
  for (const key of ['zoom', 'dpr']) {
    const entry = pixelEnvironment[key];
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) {
      throw new FrameReaderError(FRAME_REASONS.INVALID_CONTRACT, `pixelEnvironment.${key} must be a finite number above zero`);
    }
  }
  if (typeof options.acquirePublishedLease !== 'function') {
    throw new FrameReaderError(FRAME_REASONS.INVALID_CONTRACT, 'acquirePublishedLease must be a function');
  }
  if (typeof options.onReleaseLease !== 'function') {
    throw new FrameReaderError(FRAME_REASONS.INVALID_CONTRACT, 'onReleaseLease must be a function');
  }
  return {
    binding: /** @type {ReaderBinding} */ ({
      principal: binding.principal,
      epoch: binding.epoch,
      surfaceId: binding.surfaceId,
      surfaceGeneration: binding.surfaceGeneration,
    }),
    limits: /** @type {ReaderLimits} */ ({
      maxFrameBytes: limits.maxFrameBytes,
      maxWidth: limits.maxWidth,
      maxHeight: limits.maxHeight,
      readTimeoutMs: limits.readTimeoutMs,
      maxConcurrentReads: limits.maxConcurrentReads,
    }),
    pixelEnvironment: /** @type {PixelEnvironment} */ ({
      environmentId: pixelEnvironment.environmentId,
      zoom: pixelEnvironment.zoom,
      dpr: pixelEnvironment.dpr,
    }),
    acquirePublishedLease: /** @type {CreateReaderOptions['acquirePublishedLease']} */ (options.acquirePublishedLease),
    onReleaseLease: /** @type {CreateReaderOptions['onReleaseLease']} */ (options.onReleaseLease),
  };
}

/**
 * Read the abort origin set by this module; foreign reasons stay opaque.
 * @param {AbortSignal} signal Aborted signal.
 * @returns {string} `timeout`, `caller`, `closed`, or `aborted`.
 */
function abortCauseOf(signal) {
  return typeof signal.reason === 'string' ? signal.reason : 'aborted';
}

/**
 * Await a settlement unless the read aborts first. The race subscribes to
 * the promise, so a late settlement after abort never escapes unhandled.
 * @param {unknown} pending Promise or direct value from the capability.
 * @param {AbortSignal} signal Read-scoped abort signal.
 * @returns {Promise<unknown>} The settlement value.
 */
function awaitUnlessAborted(pending, signal) {
  if (signal.aborted) {
    return Promise.reject(new ReadAborted(abortCauseOf(signal)));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new ReadAborted(abortCauseOf(signal)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(pending).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Create a single-surface frame reader. All options are explicit; nothing
 * is defaulted and every shape is closed, so integration mistakes throw at
 * construction instead of widening a read.
 * @param {unknown} options Closed factory options.
 * @returns {FrameReader} Frozen `{readFrame, closeReader}` handle.
 */
export function createFrameReader(options) {
  const asserted = assertReaderOptions(options);
  const principal = asserted.binding.principal;
  const epoch = asserted.binding.epoch;
  const surfaceId = asserted.binding.surfaceId;
  const surfaceGeneration = asserted.binding.surfaceGeneration;
  const maxFrameBytes = asserted.limits.maxFrameBytes;
  const maxWidth = asserted.limits.maxWidth;
  const maxHeight = asserted.limits.maxHeight;
  const readTimeoutMs = asserted.limits.readTimeoutMs;
  const maxConcurrentReads = asserted.limits.maxConcurrentReads;
  const environmentId = asserted.pixelEnvironment.environmentId;
  const zoom = asserted.pixelEnvironment.zoom;
  const dpr = asserted.pixelEnvironment.dpr;
  const acquirePublishedLease = asserted.acquirePublishedLease;
  const onReleaseLease = asserted.onReleaseLease;
  const boundIdentity = Object.freeze({ principal, epoch, surfaceId, surfaceGeneration });

  /** @type {{closed: boolean, lastAccepted: number, inflight: number, active: Set<AbortController>, pending: Set<Promise<ReadOutcome>>}} */
  const state = {
    closed: false,
    lastAccepted: 0,
    inflight: 0,
    active: new Set(),
    pending: new Set(),
  };

  /**
   * Notify the owner that an admitted lease drops without delivery. Faults
   * propagate loudly; the caller decides what an integration bug means.
   * @param {FrameIdentity} identity Admitted lease identity.
   * @param {string} reason Frozen refusal reason for the drop.
   * @returns {void}
   */
  function notifyRelease(identity, reason) {
    onReleaseLease({
      principal: identity.principal,
      epoch: identity.epoch,
      surfaceId: identity.surfaceId,
      surfaceGeneration: identity.surfaceGeneration,
      frameGeneration: identity.frameGeneration,
      leaseId: identity.leaseId,
      reason,
    });
  }

  /**
   * Validate an acquired lease against the binding and the admitted ref.
   * @param {unknown} leased Alleged lease from the capability.
   * @param {FrameRef} ref Admitted frame reference.
   * @param {number} expected Expected packed byte length.
   * @returns {{ok: true, lease: PublishedLease}|{ok: false, outcome: ReadRefusal}} Admitted lease or refusal.
   */
  function admitLease(leased, ref, expected) {
    if (!isRecord(leased)) {
      return { ok: false, outcome: refusal(FRAME_REASONS.LEASE_INVALID, 'malformed-lease') };
    }
    const candidate = /** @type {Record<string, unknown>} */ (leased);
    if (typeof candidate.readOwnedBytes !== 'function' || typeof candidate.release !== 'function') {
      return { ok: false, outcome: refusal(FRAME_REASONS.LEASE_INVALID, 'bad-capability') };
    }
    if (!isRecord(candidate.identity)) {
      return { ok: false, outcome: refusal(FRAME_REASONS.LEASE_INVALID, 'bad-identity') };
    }
    const identity = /** @type {Record<string, unknown>} */ (candidate.identity);
    if (identity.principal !== principal || identity.epoch !== epoch
      || identity.surfaceId !== surfaceId || identity.surfaceGeneration !== surfaceGeneration) {
      return { ok: false, outcome: refusal(FRAME_REASONS.LEASE_INVALID, 'identity-mismatch') };
    }
    if (identity.frameGeneration !== ref.generation) {
      return { ok: false, outcome: refusal(FRAME_REASONS.LEASE_INVALID, 'generation-mismatch') };
    }
    if (typeof identity.leaseId !== 'string' || identity.leaseId.length === 0) {
      return { ok: false, outcome: refusal(FRAME_REASONS.LEASE_INVALID, 'bad-lease-id') };
    }
    if (candidate.published !== true) {
      return { ok: false, outcome: refusal(FRAME_REASONS.UNPUBLISHED, 'not-published') };
    }
    if (candidate.byteLength !== expected) {
      return { ok: false, outcome: refusal(FRAME_REASONS.SIZE_MISMATCH, 'lease-length-mismatch') };
    }
    return { ok: true, lease: /** @type {PublishedLease} */ (leased) };
  }

  /**
   * Execute one admitted read: acquire, snapshot, verify, then either retire
   * the source and deliver or drop the lease exactly once without advancing
   * the accepted floor.
   * @param {FrameRef} ref Admitted frame reference.
   * @param {number} expected Expected packed byte length.
   * @param {AbortSignal|undefined} callerSignal Optional caller abort.
   * @returns {Promise<ReadOutcome>} Verification outcome.
   */
  async function executeRead(ref, expected, callerSignal) {
    const internal = new AbortController();
    state.active.add(internal);
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {PublishedLease|null} */
    let lease = null;
    /** @type {unknown} */
    let acquirePending = null;
    /** @type {boolean} */
    let acquired = false;
    /** Terminal retire attempted; further faults propagate without remap or retry. */
    let dropped = false;
    const onCallerAbort = () => {
      internal.abort('caller');
    };
    /**
     * Drop the admitted lease exactly once with the terminal reason.
     * @param {string} reason Frozen refusal reason for the drop.
     * @returns {Promise<void>} Resolves once retired and reported.
     */
    async function dropAdmitted(reason) {
      if (dropped || lease === null) {
        return;
      }
      dropped = true;
      const held = lease;
      await held.release({ reason });
      notifyRelease(held.identity, reason);
    }
    try {
      if (callerSignal !== undefined) {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
      timer = setTimeout(() => {
        internal.abort('timeout');
      }, readTimeoutMs);
      acquirePending = acquirePublishedLease({
        binding: /** @type {ReaderBinding} */ (boundIdentity),
        frameRef: ref,
        signal: internal.signal,
      });
      acquired = true;
      const leased = await awaitUnlessAborted(acquirePending, internal.signal);
      const admitted = admitLease(leased, ref, expected);
      if (!admitted.ok) {
        if (isRecord(leased)) {
          const partial = /** @type {Record<string, unknown>} */ (leased);
          const releasable = typeof partial.release === 'function';
          const identity = /** @type {unknown} */ (partial.identity);
          if (releasable) {
            dropped = true;
            await /** @type {PublishedLease} */ (leased)
              .release({ reason: admitted.outcome.reason });
            if (isWellTypedIdentity(identity)) {
              notifyRelease(/** @type {FrameIdentity} */ (identity), admitted.outcome.reason);
            }
          }
        }
        return admitted.outcome;
      }
      lease = admitted.lease;
      const received = await awaitUnlessAborted(
        lease.readOwnedBytes(Object.freeze({ maxBytes: expected, signal: internal.signal })),
        internal.signal,
      );
      if (!(received instanceof Uint8Array)) {
        await dropAdmitted(FRAME_REASONS.LEASE_INVALID);
        return refusal(FRAME_REASONS.LEASE_INVALID, 'bytes-not-uint8');
      }
      if (!(received.buffer instanceof ArrayBuffer)) {
        await dropAdmitted(FRAME_REASONS.LEASE_INVALID);
        return refusal(FRAME_REASONS.LEASE_INVALID, 'bytes-shared');
      }
      if (received.length !== expected) {
        await dropAdmitted(FRAME_REASONS.SIZE_MISMATCH);
        return refusal(FRAME_REASONS.SIZE_MISMATCH, 'snapshot-length-mismatch');
      }
      if (received.length >= PNG_SIGNATURE.length
        && PNG_SIGNATURE.every((magic, index) => received[index] === magic)) {
        await dropAdmitted(FRAME_REASONS.INVALID_CONTRACT);
        return refusal(FRAME_REASONS.INVALID_CONTRACT, 'png-signature-in-rgb24-payload');
      }
      const snapshot = new Uint8Array(received);
      const pixelSpec = /** @type {PixelSpec} */ (Object.freeze({
        ...C_PIXEL_RGB24_SPEC,
        width: ref.width,
        height: ref.height,
        strideBytes: ref.width * 3,
        environmentId,
        zoom,
        dpr,
      }));
      const digest = createHash('sha256').update(snapshot).digest('hex');
      if (digest !== ref.sha256) {
        await dropAdmitted(FRAME_REASONS.DIGEST_MISMATCH);
        return refusal(FRAME_REASONS.DIGEST_MISMATCH);
      }
      const frame = /** @type {VerifiedFrame} */ (Object.freeze({
        principal,
        epoch,
        surfaceId,
        surfaceGeneration,
        frameGeneration: ref.generation,
        leaseId: lease.identity.leaseId,
        width: ref.width,
        height: ref.height,
        format: 'rgb24',
        sha256: ref.sha256,
        byteLength: expected,
        pixelSpec,
        bytes: snapshot,
      }));
      dropped = true;
      await lease.release({ reason: SOURCE_RETIRED_REASON });
      state.lastAccepted = ref.generation;
      return { ok: true, frame };
    } catch (error) {
      if (dropped) {
        throw error;
      }
      if (error instanceof ReadAborted) {
        const outcome = error.abortCause === 'closed'
          ? refusal(FRAME_REASONS.CLOSED)
          : refusal(FRAME_REASONS.TIMEOUT, error.abortCause === 'caller' ? 'aborted' : 'read-timeout');
        if (lease !== null) {
          await dropAdmitted(outcome.reason);
        } else if (acquired) {
          releaseLateLease(acquirePending, outcome.reason);
        }
        return outcome;
      }
      const outcome = refusal(FRAME_REASONS.IO_ERROR, acquired && lease === null ? 'acquire-failed' : 'read-failed');
      if (lease !== null) {
        await dropAdmitted(outcome.reason);
      } else if (acquired) {
        releaseLateLease(acquirePending, outcome.reason);
      }
      return outcome;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (callerSignal !== undefined) {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
      state.active.delete(internal);
      state.inflight -= 1;
    }
  }

  /**
   * Safety net for a producer that settles an acquisition after the read
   * already terminated: retire the late lease so it never leaks. The lease
   * was never admitted, so the owner gets no release notice for it.
   * @param {unknown} pending Late acquisition settlement.
   * @param {string} reason Terminal reason of the settled read.
   * @returns {void}
   */
  function releaseLateLease(pending, reason) {
    Promise.resolve(pending).then(
      (late) => {
        if (isRecord(late)) {
          const candidate = /** @type {Record<string, unknown>} */ (late);
          if (typeof candidate.release === 'function') {
            Promise.resolve()
              .then(() => /** @type {PublishedLease} */ (late).release({ reason }))
              .then(undefined, () => undefined);
          }
        }
      },
      () => undefined,
    );
  }

  /**
   * Verify one frame reference. Pre-acquisition refusals touch neither the
   * producer nor the accepted floor; post-acquisition failures drop the
   * lease exactly once, still without advancing the floor.
   * @param {unknown} frameRef Alleged `frame_ref/v0.1` object.
   * @param {{signal?: AbortSignal}} [options] Optional caller abort.
   * @returns {Promise<ReadOutcome>} Verification outcome.
   */
  async function readFrame(frameRef, options = {}) {
    if (state.closed) {
      return refusal(FRAME_REASONS.CLOSED);
    }
    if (!isRecord(options) || !['', 'signal'].includes(Object.keys(options).sort().join(','))) {
      return refusal(FRAME_REASONS.INVALID_CONTRACT, 'bad-options');
    }
    const callerSignal = /** @type {{signal?: AbortSignal}} */ (options).signal;
    if (callerSignal !== undefined
      && (typeof callerSignal !== 'object' || callerSignal === null
        || typeof callerSignal.aborted !== 'boolean'
        || typeof callerSignal.addEventListener !== 'function'
        || typeof callerSignal.removeEventListener !== 'function')) {
      return refusal(FRAME_REASONS.INVALID_CONTRACT, 'bad-signal');
    }
    if (callerSignal !== undefined && callerSignal.aborted) {
      return refusal(FRAME_REASONS.TIMEOUT, 'aborted');
    }
    const admitted = admitFrameRef(frameRef);
    if (!admitted.ok) {
      return admitted.outcome;
    }
    const ref = admitted.ref;
    if (ref.surface_id !== surfaceId) {
      return refusal(FRAME_REASONS.SURFACE_MISMATCH);
    }
    if (ref.sha256 === NULL_DIGEST) {
      return refusal(FRAME_REASONS.NULL_DIGEST);
    }
    if (!(ref.generation > state.lastAccepted)) {
      return refusal(FRAME_REASONS.STALE_FRAME_GENERATION);
    }
    if (ref.width > maxWidth || ref.height > maxHeight) {
      return refusal(FRAME_REASONS.SIZE_MISMATCH, 'exceeds-max-dimensions');
    }
    const expected = ref.width * ref.height * 3;
    if (!Number.isSafeInteger(expected) || expected <= 0) {
      return refusal(FRAME_REASONS.SIZE_MISMATCH, 'dimension-product-overflow');
    }
    if (expected > maxFrameBytes) {
      return refusal(FRAME_REASONS.SIZE_MISMATCH, 'exceeds-max-frame-bytes');
    }
    if (state.inflight >= maxConcurrentReads) {
      return refusal(FRAME_REASONS.TIMEOUT, 'no-read-slot');
    }
    state.inflight += 1;
    const task = executeRead(ref, expected, callerSignal);
    state.pending.add(task);
    const settle = () => {
      state.pending.delete(task);
    };
    task.then(settle, settle);
    return task;
  }

  /**
   * Abort every in-flight read and refuse all later ones. In-flight reads
   * settle as `CLOSED` and drop their leases exactly once; repeated calls
   * are free. Never unlinks a source.
   * @returns {Promise<void>} Resolves once in-flight reads settle.
   */
  async function closeReader() {
    if (state.closed) {
      return;
    }
    state.closed = true;
    for (const controller of state.active) {
      controller.abort('closed');
    }
    await Promise.allSettled([...state.pending]);
  }

  return /** @type {FrameReader} */ (Object.freeze({ readFrame, closeReader }));
}
