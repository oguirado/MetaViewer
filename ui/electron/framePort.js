// @ts-check
'use strict';

/**
 * W1-FRAMES-PORT: direct utility<->renderer frame delivery over a brokered port.
 *
 * Main brokers a MessageChannelMain pair after the preload handshake; bulk
 * frame payloads then flow directly over the port and are never relayed
 * through main. Each instance binds one tile lifetime
 * (principal + epoch + surfaceId + surfaceGeneration) and carries at most
 * one sent-but-unacknowledged frame plus one pending replacement: postings
 * supersede locally, so unread frames are never copied across IPC.
 * A mismatch of epoch or a regressing generation is refused; the port is
 * revoked when either endpoint restarts or closes. No Electron import:
 * unit tests run directly under Node with fake ports.
 * Public acceptAck accepts the FrameAck data shape; wire arrivals additionally
 * require their schema and kind envelope. Consumer leases survive supersession
 * and revocation until the consumer settles.
 *
 * @module framePort
 */

/**
 * Typed port wiring failure; a failure admits nothing.
 */
export class FramePortError extends Error {
  /**
   * @param {string} code Stable refusal code.
   * @param {string} message Human detail (never an authority grant).
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'FramePortError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * Shared local refusal vocabulary (reader and port use the same values).
 * Transport refusals only; they never replace core authority reasons.
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
 * Terminal per-frame outcomes carried on ACKs and lease releases.
 */
export const ACK_OUTCOMES = Object.freeze({
  PRESENTED: 'PRESENTED',
  SUPERSEDED: 'SUPERSEDED',
  FOLD_DRAIN: 'FOLD_DRAIN',
  HIDDEN: 'HIDDEN',
  CONTEXT_LOST: 'CONTEXT_LOST',
  SURFACE_DESTROYED: 'SURFACE_DESTROYED',
  REFUSED: 'REFUSED',
});

/**
 * Accepted revocation causes.
 */
export const PORT_REVOKE_REASONS = Object.freeze({
  PORT_REVOKED: 'PORT_REVOKED',
  ENDPOINT_RESTART: 'ENDPOINT_RESTART',
  TIMEOUT: 'TIMEOUT',
  SHUTDOWN: 'SHUTDOWN',
});

/**
 * Wire schema tags for port envelopes (requested v0.2 vocabulary).
 */
export const FRAME_DELIVERY_SCHEMA = 'frame_delivery/v0.2';
export const FRAME_ACK_SCHEMA = 'frame_ack/v0.2';

/**
 * @typedef {object} PortBinding
 * @property {string} principal Bound endpoint identity.
 * @property {number} epoch Bound epoch, a positive safe integer.
 * @property {string} surfaceId Bound tile.
 * @property {number} surfaceGeneration Bound surface lifetime, a positive safe integer.
 */

/**
 * @typedef {object} PortLimits
 * @property {number} maxFrameBytes Largest accepted frame byte length.
 * @property {number} ackTimeoutMs Milliseconds before an unacked send revokes.
 * @property {number} maxSurfacesPerPort Fleet cap sanity witness (>= 1).
 */

/**
 * @typedef {object} VerifiedFrame
 * @property {string} principal
 * @property {number} epoch
 * @property {string} surfaceId
 * @property {number} surfaceGeneration
 * @property {number} frameGeneration
 * @property {string} leaseId
 * @property {number} width
 * @property {number} height
 * @property {string} format Must be 'rgb24'.
 * @property {string} sha256 Lowercase hex over the packed rgb24 bytes.
 * @property {number} byteLength Must equal bytes.byteLength and width*height*3.
 * @property {Record<string, unknown>} pixelSpec Reader-owned layout witness.
 * @property {Uint8Array} bytes Owned packed rgb24 bytes.
 */

/**
 * @typedef {object} FrameAck
 * @property {string} [schema] Optional for the public API; wire ACKs require FRAME_ACK_SCHEMA.
 * @property {string} [kind] Optional for the public API; when present must be 'ack'.
 * @property {string} principal
 * @property {number} epoch
 * @property {string} surfaceId
 * @property {number} surfaceGeneration
 * @property {number} frameGeneration
 * @property {string} leaseId
 * @property {string} correlation Echo of the delivery correlation.
 * @property {string} outcome One of ACK_OUTCOMES.
 */

/**
 * @typedef {object} LeaseRelease
 * @property {string} principal
 * @property {number} epoch
 * @property {string} surfaceId
 * @property {number} surfaceGeneration
 * @property {number} frameGeneration
 * @property {string} leaseId
 * @property {string} reason ACK outcome or revoke cause.
 */

/**
 * @typedef {object} PortRevokeNotice
 * @property {PortBinding} binding Copy of the revoked binding.
 * @property {string} reason One of PORT_REVOKE_REASONS.
 */

/**
 * @typedef {object} BrokeredPort
 * @property {(message: unknown) => void} postMessage
 * @property {(() => void)} [start]
 * @property {(() => void)} [close]
 * @property {(event: string, listener: (...args: Array<any>) => void) => unknown} [on]
 * @property {(event: string, listener: (...args: Array<any>) => void) => unknown} [off]
 * @property {(event: string, listener: (...args: Array<any>) => void) => unknown} [removeListener]
 * @property {(event: string, listener: (...args: Array<any>) => void) => unknown} [addEventListener]
 * @property {(event: string, listener: (...args: Array<any>) => void) => unknown} [removeEventListener]
 */

/**
 * @callback OnFrameFn
 * @param {VerifiedFrame} frame Validated newest frame; wrapper is frozen.
 * @returns {Promise<unknown>} Resolves to { outcome } with an ACK_OUTCOMES value.
 */

/**
 * @callback OnReleaseLeaseFn
 * @param {LeaseRelease} release Exactly-once per held frame.
 * @returns {void}
 */

/**
 * @callback OnRevokeFn
 * @param {PortRevokeNotice} notice Exactly-once per instance.
 * @returns {void}
 */

/**
 * @callback SetTimerFn
 * @param {() => void} callback
 * @param {number} ms
 * @returns {unknown} Opaque handle for the paired clear function.
 */

/**
 * @callback ClearTimerFn
 * @param {unknown} handle
 * @returns {void}
 */

/**
 * @callback ClockFn
 * @returns {number} Milliseconds; used for witness timestamps only.
 */

/**
 * @typedef {object} CreateFramePortOptions
 * @property {BrokeredPort} port Already-brokered MessagePortMain (or test fake).
 * @property {string} role 'sender' or 'receiver'.
 * @property {PortBinding} binding Single bound tile lifetime.
 * @property {PortLimits} limits Transport budget; no defaults.
 * @property {OnReleaseLeaseFn} onReleaseLease Required; must not retain.
 * @property {OnRevokeFn} onRevoke Required; runs once after state is final.
 * @property {OnFrameFn} [onFrame] Required for receivers, forbidden for senders.
 * @property {(ack: { principal: string, epoch: number, surfaceId: string, surfaceGeneration: number, frameGeneration: number, leaseId: string, outcome: string }) => void} [onAck] Optional sender ACK observer.
 * @property {ClockFn} [clock] Timestamp source; defaults to Date.now.
 * @property {SetTimerFn} [setTimer] Timer source; defaults to setTimeout.
 * @property {ClearTimerFn} [clearTimer] Timer sink; defaults to clearTimeout.
 */

/**
 * @typedef {object} PortResult Success carries method-named data; failure is closed.
 * @property {boolean} ok
 * @property {string} [reason] Set when ok is false.
 * @property {string} [detail] Set when ok is false.
 * @property {boolean} [sent] postFrame: bulk bytes crossed the port now.
 * @property {boolean} [queued] postFrame: held as the pending replacement.
 * @property {number} [frameGeneration]
 * @property {string} [leaseId]
 * @property {number|null} [superseded] Replaced pending generation, if any.
 * @property {boolean} [duplicate] acceptAck: idempotent replay, no state change.
 * @property {number|null} [acked] acceptAck: cleared in-flight generation, if any.
 * @property {number|null} [promoted] acceptAck: pending generation just sent, if any.
 */

/**
 * @typedef {object} FramePort Frozen endpoint handle.
 * @property {(frame: VerifiedFrame) => PortResult} postFrame Sender: send or supersede.
 * @property {(ack: FrameAck) => PortResult} acceptAck Sender: clear in-flight by ACK.
 * @property {(reason?: string) => void} revokeFramePort Either role: terminal teardown.
 * @property {() => PortInstrumentation} getInstrumentation Frozen counters snapshot.
 */

/**
 * @typedef {object} PortInstrumentation
 * @property {string} role
 * @property {boolean} revoked
 * @property {string|null} revokeReason
 * @property {number} createdAtMs
 * @property {number|null} revokedAtMs
 * @property {number} acceptedFloor Highest admitted frame generation.
 * @property {number} ackedFloor Highest acknowledged frame generation.
 * @property {number|null} inFlightGeneration
 * @property {number|null} pendingGeneration
 * @property {number|null} heldGeneration
 * @property {number} sent Bulk deliveries posted.
 * @property {number} acked Matched ACKs consumed (sender).
 * @property {number} acksSent ACKs posted (receiver).
 * @property {number} superseded Local replacements released.
 * @property {number} refused Refused postings, ACKs and arrivals.
 * @property {number} released Lease releases emitted.
 * @property {number} timeouts ACK timeouts observed.
 * @property {number} releaseFaults Owner release/revoke callbacks that threw.
 * @property {string|null} lastReleaseFault Most recent owner callback failure.
 */

/**
 * @typedef {object} HeldFrame Validated frame plus its wire correlation.
 * @property {string} principal
 * @property {number} epoch
 * @property {string} surfaceId
 * @property {number} surfaceGeneration
 * @property {number} frameGeneration
 * @property {string} leaseId
 * @property {number} width
 * @property {number} height
 * @property {string} format
 * @property {string} sha256
 * @property {number} byteLength
 * @property {Record<string, unknown>} pixelSpec
 * @property {Uint8Array} bytes
 * @property {string} correlation
 */

const NULL_DIGEST = '0'.repeat(64);
const SHA256_RE = /^[0-9a-f]{64}$/;
const RGB24_FORMAT = 'rgb24';
const RGB24_BYTES_PER_PIXEL = 3;

/** @type {SetTimerFn} */
const defaultSetTimer = (callback, ms) => setTimeout(callback, ms);

/** @type {ClearTimerFn} */
const defaultClearTimer = (handle) => {
  clearTimeout(/** @type {any} */ (handle));
};

/** @type {ClockFn} */
const defaultClock = () => Date.now();

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  throw new FramePortError(code, message);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * @param {string} reason
 * @param {string} detail
 * @returns {PortResult}
 */
function refusal(reason, detail) {
  return { ok: false, reason, detail };
}

/**
 * Identity checks shared by postings, deliveries and ACKs. Field presence
 * is validated before binding comparison so malformed input cannot probe
 * the binding, and no state changes on any refusal path.
 *
 * @param {any} raw Untrusted frame-like or ack-like value.
 * @param {PortBinding} binding Bound tile lifetime.
 * @returns {PortResult|null} Refusal, or null when identity binds.
 */
function checkIdentity(raw, binding) {
  if (raw === null || typeof raw !== 'object') {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'message must be an object');
  }
  if (!isNonEmptyString(raw.principal) || !isNonEmptyString(raw.surfaceId)) {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'principal and surfaceId must be non-empty strings');
  }
  if (typeof raw.epoch !== 'number' || !Number.isSafeInteger(raw.epoch)) {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'epoch must be a safe integer');
  }
  if (typeof raw.surfaceGeneration !== 'number' || !Number.isSafeInteger(raw.surfaceGeneration)) {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'surfaceGeneration must be a safe integer');
  }
  if (raw.principal !== binding.principal || raw.surfaceId !== binding.surfaceId) {
    return refusal(FRAME_REASONS.SURFACE_MISMATCH, 'message is bound to another tile');
  }
  if (raw.epoch !== binding.epoch) {
    return refusal(FRAME_REASONS.STALE_EPOCH, 'message epoch differs from the bound epoch');
  }
  if (raw.surfaceGeneration < binding.surfaceGeneration) {
    return refusal(FRAME_REASONS.STALE_SURFACE_GENERATION, 'message predates the bound surface lifetime');
  }
  if (raw.surfaceGeneration > binding.surfaceGeneration) {
    return refusal(FRAME_REASONS.INVALID_BINDING, 'surface lifetime moved on; rebind the port');
  }
  return null;
}

/**
 * Shape checks for a posted or delivered frame. Size caps are checked
 * before any length-derived product so a hostile length cannot drive
 * allocation; digest presence is checked but digest recomputation stays
 * with the reader, which owns the pixel layout witness.
 *
 * @param {any} raw Untrusted frame-like value with checked identity.
 * @param {PortLimits} limits Transport budget.
 * @returns {PortResult|null} Refusal, or null when the shape holds.
 */
function checkFrameShape(raw, limits) {
  if (!isPositiveSafeInt(raw.frameGeneration)) {
    return refusal(FRAME_REASONS.INVALID_GENERATION, 'frameGeneration must be a positive safe integer');
  }
  if (!isNonEmptyString(raw.leaseId)) {
    return refusal(FRAME_REASONS.LEASE_INVALID, 'leaseId must be a non-empty string');
  }
  if (raw.format !== RGB24_FORMAT) {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'format must be rgb24');
  }
  if (!isPositiveSafeInt(raw.width) || !isPositiveSafeInt(raw.height)) {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'width and height must be positive safe integers');
  }
  if (!(raw.bytes instanceof Uint8Array)) {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'bytes must be a Uint8Array');
  }
  if (raw.byteLength !== raw.bytes.byteLength) {
    return refusal(FRAME_REASONS.SIZE_MISMATCH, 'byteLength disagrees with the carried bytes');
  }
  if (raw.byteLength > limits.maxFrameBytes) {
    return refusal(FRAME_REASONS.SIZE_MISMATCH, 'byteLength exceeds maxFrameBytes');
  }
  if (raw.byteLength !== raw.width * raw.height * RGB24_BYTES_PER_PIXEL) {
    return refusal(FRAME_REASONS.SIZE_MISMATCH, 'byteLength disagrees with packed width*height*3');
  }
  if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'sha256 must be 64 lowercase hex characters');
  }
  if (raw.sha256 === NULL_DIGEST) {
    return refusal(FRAME_REASONS.NULL_DIGEST, 'null-marker digest has no live pixel binding');
  }
  if (raw.pixelSpec === null || typeof raw.pixelSpec !== 'object') {
    return refusal(FRAME_REASONS.INVALID_CONTRACT, 'pixelSpec must be an object');
  }
  return null;
}

/**
 * @param {unknown} outcome
 * @returns {boolean}
 */
function isAckOutcome(outcome) {
  return (
    outcome === ACK_OUTCOMES.PRESENTED ||
    outcome === ACK_OUTCOMES.SUPERSEDED ||
    outcome === ACK_OUTCOMES.FOLD_DRAIN ||
    outcome === ACK_OUTCOMES.HIDDEN ||
    outcome === ACK_OUTCOMES.CONTEXT_LOST ||
    outcome === ACK_OUTCOMES.SURFACE_DESTROYED ||
    outcome === ACK_OUTCOMES.REFUSED
  );
}

/**
 * @param {unknown} reason
 * @returns {boolean}
 */
function isRevokeReason(reason) {
  return (
    reason === PORT_REVOKE_REASONS.PORT_REVOKED ||
    reason === PORT_REVOKE_REASONS.ENDPOINT_RESTART ||
    reason === PORT_REVOKE_REASONS.TIMEOUT ||
    reason === PORT_REVOKE_REASONS.SHUTDOWN
  );
}

/**
 * Create a bound frame port endpoint. The port must already be brokered by
 * main; this factory only binds identity, budget and callbacks, attaches
 * inbound listeners, and starts the port. Invalid wiring throws; runtime
 * refusals return closed Results and never mutate state.
 *
 * @param {CreateFramePortOptions} options Wiring; see the typedef.
 * @returns {FramePort} Frozen endpoint handle.
 */
export function createFramePort(options) {
  const rawOptions = /** @type {any} */ (options);
  if (rawOptions === null || typeof rawOptions !== 'object') {
    fail(FRAME_REASONS.INVALID_CONTRACT, 'options must be an object');
  }
  const rawPort = /** @type {any} */ (rawOptions.port);
  if (rawPort === null || typeof rawPort !== 'object' || typeof rawPort.postMessage !== 'function') {
    fail(FRAME_REASONS.INVALID_CONTRACT, 'port.postMessage must be a function');
  }
  const role = rawOptions.role;
  if (role !== 'sender' && role !== 'receiver') {
    fail(FRAME_REASONS.INVALID_BINDING, 'role must be sender or receiver');
  }
  const rawBinding = rawOptions.binding;
  if (
    rawBinding === null ||
    typeof rawBinding !== 'object' ||
    !isNonEmptyString(rawBinding.principal) ||
    !isPositiveSafeInt(rawBinding.epoch) ||
    !isNonEmptyString(rawBinding.surfaceId) ||
    !isPositiveSafeInt(rawBinding.surfaceGeneration)
  ) {
    fail(FRAME_REASONS.INVALID_BINDING, 'binding needs principal, epoch, surfaceId, surfaceGeneration');
  }
  const rawLimits = rawOptions.limits;
  if (
    rawLimits === null ||
    typeof rawLimits !== 'object' ||
    !isPositiveSafeInt(rawLimits.maxFrameBytes) ||
    typeof rawLimits.ackTimeoutMs !== 'number' ||
    !Number.isFinite(rawLimits.ackTimeoutMs) ||
    rawLimits.ackTimeoutMs <= 0 ||
    !isPositiveSafeInt(rawLimits.maxSurfacesPerPort)
  ) {
    fail(FRAME_REASONS.INVALID_BUDGET, 'limits needs maxFrameBytes, ackTimeoutMs, maxSurfacesPerPort');
  }
  if (typeof rawOptions.onReleaseLease !== 'function' || typeof rawOptions.onRevoke !== 'function') {
    fail(FRAME_REASONS.INVALID_CONTRACT, 'onReleaseLease and onRevoke must be functions');
  }
  if (role === 'receiver' && typeof rawOptions.onFrame !== 'function') {
    fail(FRAME_REASONS.INVALID_CONTRACT, 'receivers need an onFrame callback');
  }
  if (role === 'sender' && rawOptions.onFrame !== undefined) {
    fail(FRAME_REASONS.INVALID_CONTRACT, 'senders must not carry onFrame');
  }
  for (const key of ['clock', 'setTimer', 'clearTimer', 'onAck']) {
    if (rawOptions[key] !== undefined && typeof rawOptions[key] !== 'function') {
      fail(FRAME_REASONS.INVALID_CONTRACT, `${key} must be a function`);
    }
  }

  /** @type {PortBinding} */
  const binding = {
    principal: rawBinding.principal,
    epoch: rawBinding.epoch,
    surfaceId: rawBinding.surfaceId,
    surfaceGeneration: rawBinding.surfaceGeneration,
  };
  /** @type {PortLimits} */
  const limits = {
    maxFrameBytes: rawLimits.maxFrameBytes,
    ackTimeoutMs: rawLimits.ackTimeoutMs,
    maxSurfacesPerPort: rawLimits.maxSurfacesPerPort,
  };
  /** @type {BrokeredPort} */
  const port = rawPort;
  /** @type {OnReleaseLeaseFn} */
  const onReleaseLease = rawOptions.onReleaseLease;
  /** @type {OnRevokeFn} */
  const onRevoke = rawOptions.onRevoke;
  /** @type {OnFrameFn|null} */
  const onFrame = role === 'receiver' ? /** @type {OnFrameFn} */ (rawOptions.onFrame) : null;
  /** @type {((ack: { principal: string, epoch: number, surfaceId: string, surfaceGeneration: number, frameGeneration: number, leaseId: string, outcome: string }) => void) | null} */
  const onAck = role === 'sender' && typeof rawOptions.onAck === 'function' ? rawOptions.onAck : null;
  /** @type {ClockFn} */
  const clock = rawOptions.clock !== undefined ? rawOptions.clock : defaultClock;
  /** @type {SetTimerFn} */
  const setTimer = rawOptions.setTimer !== undefined ? rawOptions.setTimer : defaultSetTimer;
  /** @type {ClearTimerFn} */
  const clearTimer = rawOptions.clearTimer !== undefined ? rawOptions.clearTimer : defaultClearTimer;

  const createdAtMs = clock();
  let revoked = false;
  /** @type {string|null} */
  let revokeReason = null;
  /** @type {number|null} */
  let revokedAtMs = null;
  let acceptedFloor = 0;
  let ackedFloor = 0;
  /** @type {HeldFrame|null} */
  let inFlight = null;
  /** @type {HeldFrame|null} */
  let pending = null;
  /** @type {HeldFrame|null} */
  let held = null;
  /** Active consumer owns its lease until onFrame settles. @type {HeldFrame|null} */
  let consuming = null;
  /** Deferred terminal outcome for the active consumer. @type {string|null} */
  let consumingOutcome = null;
  /** @type {unknown} */
  let ackTimer = null;
  let ackTimerGen = 0;
  let ackTimerToken = 0;
  let ackTimerSeq = 0;
  let sent = 0;
  let acked = 0;
  let acksSent = 0;
  let superseded = 0;
  let refused = 0;
  let released = 0;
  let timeouts = 0;
  let releaseFaults = 0;
  /** @type {string|null} */
  let lastReleaseFault = null;
  /** Receivers consume held frames strictly in admission order. @type {Promise<void>} */
  let receiverChain = Promise.resolve();

  /**
   * Owner callbacks run after state is final; a throwing owner is counted
   * and recorded instead of breaking transport determinism.
   *
   * @param {() => void} invoke Owner callback invocation.
   * @returns {void}
   */
  function guardOwner(invoke) {
    try {
      invoke();
    } catch (error) {
      releaseFaults += 1;
      lastReleaseFault = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * @param {HeldFrame} record
   * @param {string} cause ACK outcome or revoke cause.
   * @returns {void}
   */
  function releaseRecord(record, cause) {
    released += 1;
    /** @type {LeaseRelease} */
    const release = {
      principal: record.principal,
      epoch: record.epoch,
      surfaceId: record.surfaceId,
      surfaceGeneration: record.surfaceGeneration,
      frameGeneration: record.frameGeneration,
      leaseId: record.leaseId,
      reason: cause,
    };
    guardOwner(() => onReleaseLease(release));
  }

  /**
   * @returns {void}
   */
  function disarmAckTimer() {
    if (ackTimer !== null) {
      const handle = ackTimer;
      ackTimer = null;
      ackTimerGen = 0;
      ackTimerToken = 0;
      guardOwner(() => clearTimer(handle));
    }
  }

  /**
   * @param {string} reason One of PORT_REVOKE_REASONS.
   * @returns {void}
   */
  function revokeInternal(reason) {
    if (revoked) {
      return;
    }
    revoked = true;
    revokeReason = reason;
    revokedAtMs = clock();
    disarmAckTimer();
    detachPort();
    // Best-effort close; holdings release below runs regardless.
    if (typeof port.close === 'function') {
      try {
        port.close();
      } catch {
        // A dead port still revokes; counters below stay authoritative.
      }
    }
    if (inFlight !== null) {
      const record = inFlight;
      inFlight = null;
      releaseRecord(record, reason);
    }
    if (pending !== null) {
      const record = pending;
      pending = null;
      releaseRecord(record, reason);
    }
    if (held !== null) {
      const record = held;
      held = null;
      releaseRecord(record, reason);
    }
    if (consuming !== null) {
      consumingOutcome = reason;
    }
    /** @type {PortRevokeNotice} */
    const notice = { binding: { ...binding }, reason };
    guardOwner(() => onRevoke(notice));
  }

  /**
   * @param {number} timerGen
   * @param {number} timerToken
   * @returns {void}
   */
  function onAckTimeout(timerGen, timerToken) {
    if (
      revoked ||
      inFlight === null ||
      ackTimer === null ||
      ackTimerGen !== timerGen ||
      ackTimerToken !== timerToken ||
      inFlight.frameGeneration !== timerGen
    ) {
      return;
    }
    ackTimer = null;
    ackTimerGen = 0;
    ackTimerToken = 0;
    timeouts += 1;
    revokeInternal(PORT_REVOKE_REASONS.TIMEOUT);
  }

  /**
   * Electron wraps arrivals in a MessageEvent; bare-message fakes stay
   * supported so tests do not depend on the Electron runtime.
   *
   * @param {any} event
   * @returns {any}
   */
  function unwrapMessage(event) {
    if (event !== null && typeof event === 'object' && 'data' in event) {
      return event.data;
    }
    return event;
  }

  /**
   * @param {HeldFrame} record
   * @returns {boolean}
   */
  function postDelivery(record) {
    try {
      port.postMessage({
        schema: FRAME_DELIVERY_SCHEMA,
        kind: 'frame',
        correlation: record.correlation,
        principal: record.principal,
        epoch: record.epoch,
        surfaceId: record.surfaceId,
        surfaceGeneration: record.surfaceGeneration,
        frameGeneration: record.frameGeneration,
        leaseId: record.leaseId,
        width: record.width,
        height: record.height,
        format: record.format,
        byteLength: record.byteLength,
        sha256: record.sha256,
        pixelSpec: { ...record.pixelSpec },
        bytes: record.bytes,
      });
      sent += 1;
      if (!revoked && inFlight === record && inFlight.frameGeneration === record.frameGeneration) {
        disarmAckTimer();
        const timerGen = record.frameGeneration;
        const timerToken = (ackTimerSeq += 1);
        ackTimerGen = timerGen;
        ackTimerToken = timerToken;
        ackTimer = setTimer(() => {
          onAckTimeout(timerGen, timerToken);
        }, limits.ackTimeoutMs);
      }
      return true;
    } catch {
      // Covers initial delivery and pending promotion, including timer failure.
      revokeInternal(PORT_REVOKE_REASONS.PORT_REVOKED);
      return false;
    }
  }

  /**
   * Best-effort refusal ACK; a dead port cannot block receiver progress
   * because refused arrivals are never retained.
   *
   * @param {any} raw Echoed identity of the refused arrival.
   * @returns {void}
   */
  function postRefusedAck(raw) {
    if (checkIdentity(raw, binding) !== null || !isPositiveSafeInt(raw.frameGeneration) ||
        !isNonEmptyString(raw.leaseId) || !isNonEmptyString(raw.correlation)) {
      return;
    }
    /** @type {Record<string, unknown>} */
    const ack = {
      schema: FRAME_ACK_SCHEMA,
      kind: 'ack',
      correlation: raw.correlation,
      principal: raw.principal,
      epoch: raw.epoch,
      surfaceId: raw.surfaceId,
      surfaceGeneration: raw.surfaceGeneration,
      frameGeneration: raw.frameGeneration,
      leaseId: raw.leaseId,
      outcome: ACK_OUTCOMES.REFUSED,
    };
    try {
      port.postMessage(ack);
      acksSent += 1;
    } catch {
      // Refusals are never retained, so a failed ACK leaks nothing.
    }
  }

  /**
   * @param {HeldFrame} record
   * @param {string} outcome One of ACK_OUTCOMES.
   * @returns {void}
   */
  function postOutcomeAck(record, outcome) {
    port.postMessage({
      schema: FRAME_ACK_SCHEMA,
      kind: 'ack',
      correlation: record.correlation,
      principal: record.principal,
      epoch: record.epoch,
      surfaceId: record.surfaceId,
      surfaceGeneration: record.surfaceGeneration,
      frameGeneration: record.frameGeneration,
      leaseId: record.leaseId,
      outcome,
    });
    acksSent += 1;
  }

  /**
   * Consume one admitted delivery after validation: the newest frame wins
   * before consume, the ACK follows consume, and a throwing consumer
   * refuses instead of wedging the receiver.
   *
   * @param {HeldFrame} record
   * @returns {Promise<void>}
   */
  async function consumeRecord(record) {
    if (revoked || held !== record || onFrame === null) {
      return;
    }
    held = null;
    consuming = record;
    consumingOutcome = null;
    /** @type {VerifiedFrame} */
    const frame = /** @type {VerifiedFrame} */ (
      Object.freeze({
        principal: record.principal,
        epoch: record.epoch,
        surfaceId: record.surfaceId,
        surfaceGeneration: record.surfaceGeneration,
        frameGeneration: record.frameGeneration,
        leaseId: record.leaseId,
        width: record.width,
        height: record.height,
        format: record.format,
        sha256: record.sha256,
        byteLength: record.byteLength,
        pixelSpec: Object.freeze({ ...record.pixelSpec }),
        bytes: record.bytes,
      })
    );
    /** @type {string} */
    let outcome = ACK_OUTCOMES.PRESENTED;
    try {
      const resolved = await onFrame(frame);
      const rawOutcome =
        resolved !== null && typeof resolved === 'object'
          ? /** @type {any} */ (resolved).outcome
          : undefined;
      outcome = isAckOutcome(rawOutcome) ? /** @type {string} */ (rawOutcome) : ACK_OUTCOMES.REFUSED;
    } catch {
      outcome = ACK_OUTCOMES.REFUSED;
    }
    outcome = consumingOutcome === null ? outcome : consumingOutcome;
    consuming = null;
    consumingOutcome = null;
    if (!revoked) {
      try {
        postOutcomeAck(record, outcome);
      } catch {
        // A dead port surfaces through the sender timeout/revoke notice.
      }
    }
    releaseRecord(record, outcome);
  }

  /**
   * Admit a validated delivery into the single newest-only queue slot. Replaced
   * queued holdings are released and ACKed at once; an active consumer defers
   * its superseded outcome and release until its promise settles.
   *
   * @param {any} raw Delivery with checked identity and shape.
   * @returns {void}
   */
  function admitDelivery(raw) {
    /** @type {HeldFrame} */
    const record = {
      principal: raw.principal,
      epoch: raw.epoch,
      surfaceId: raw.surfaceId,
      surfaceGeneration: raw.surfaceGeneration,
      frameGeneration: raw.frameGeneration,
      leaseId: raw.leaseId,
      width: raw.width,
      height: raw.height,
      format: raw.format,
      sha256: raw.sha256,
      byteLength: raw.byteLength,
      pixelSpec: { ...raw.pixelSpec },
      bytes: raw.bytes,
      correlation: typeof raw.correlation === 'string' && raw.correlation.length > 0
        ? raw.correlation
        : `${binding.surfaceId}#${raw.frameGeneration}#${raw.leaseId}`,
    };
    acceptedFloor = record.frameGeneration;
    if (consuming !== null && consumingOutcome === null) {
      consumingOutcome = ACK_OUTCOMES.SUPERSEDED;
      superseded += 1;
    }
    if (held !== null) {
      const replaced = held;
      releaseRecord(replaced, ACK_OUTCOMES.SUPERSEDED);
      superseded += 1;
      try {
        postOutcomeAck(replaced, ACK_OUTCOMES.SUPERSEDED);
      } catch {
        // The replaced frame is already released; a dead port surfaces
        // through the sender timeout and the revoke notice.
      }
    }
    held = record;
    receiverChain = receiverChain.then(() => consumeRecord(record));
  }

  /**
   * @param {any} event
   * @returns {void}
   */
  function onPortMessage(event) {
    if (revoked) {
      return;
    }
    const raw = unwrapMessage(event);
    if (raw === null || typeof raw !== 'object' || typeof raw.kind !== 'string') {
      refused += 1;
      return;
    }
    if (role === 'sender') {
      if (raw.kind !== 'ack' || raw.schema !== FRAME_ACK_SCHEMA) {
        refused += 1;
        return;
      }
      acceptAckInternal(/** @type {any} */ (raw));
      return;
    }
    if (raw.kind !== 'frame' || raw.schema !== FRAME_DELIVERY_SCHEMA) {
      refused += 1;
      return;
    }
    const identity = checkIdentity(raw, binding);
    if (identity !== null) {
      refused += 1;
      return;
    }
    if (!isNonEmptyString(raw.correlation)) {
      refused += 1;
      return;
    }
    const shape = checkFrameShape(raw, limits);
    if (shape !== null) {
      refused += 1;
      postRefusedAck(raw);
      return;
    }
    if (raw.frameGeneration <= acceptedFloor) {
      refused += 1;
      postRefusedAck(raw);
      return;
    }
    admitDelivery(raw);
  }

  /**
   * The remote end disconnected: this endpoint restarts its binding and
   * must never accept another frame or ACK on it.
   *
   * @returns {void}
   */
  function onPortClose() {
    revokeInternal(PORT_REVOKE_REASONS.ENDPOINT_RESTART);
  }

  /**
   * @param {string} event
   * @param {(...args: Array<any>) => void} listener
   * @returns {void}
   */
  function attachListener(event, listener) {
    if (typeof port.on === 'function') {
      port.on(event, listener);
    } else if (typeof port.addEventListener === 'function') {
      port.addEventListener(event, listener);
    }
  }

  /**
   * @returns {void}
   */
  function detachPort() {
    if (typeof port.off === 'function') {
      port.off('message', onPortMessage);
      port.off('close', onPortClose);
    } else if (typeof port.removeListener === 'function') {
      port.removeListener('message', onPortMessage);
      port.removeListener('close', onPortClose);
    } else if (typeof port.removeEventListener === 'function') {
      port.removeEventListener('message', onPortMessage);
      port.removeEventListener('close', onPortClose);
    }
  }

  /**
   * Shared by the public acceptAck and by sender-side wire arrivals; both
   * paths are idempotent, so a replayed ACK can never free a newer slot.
   *
   * @param {any} raw Untrusted ack-like value.
   * @returns {PortResult}
   */
  function acceptAckInternal(raw) {
    const identity = checkIdentity(raw, binding);
    if (identity !== null) {
      refused += 1;
      return identity;
    }
    if ((raw.kind !== undefined && raw.kind !== 'ack') ||
        (raw.schema !== undefined && raw.schema !== FRAME_ACK_SCHEMA)) {
      refused += 1;
      return refusal(FRAME_REASONS.INVALID_CONTRACT, 'invalid ACK envelope');
    }
    if (!isPositiveSafeInt(raw.frameGeneration)) {
      refused += 1;
      return refusal(FRAME_REASONS.INVALID_GENERATION, 'frameGeneration must be a positive safe integer');
    }
    if (!isNonEmptyString(raw.leaseId)) {
      refused += 1;
      return refusal(FRAME_REASONS.LEASE_INVALID, 'leaseId must be a non-empty string');
    }
    if (typeof raw.correlation !== 'string') {
      refused += 1;
      return refusal(FRAME_REASONS.INVALID_CONTRACT, 'correlation must be a string');
    }
    if (!isAckOutcome(raw.outcome)) {
      refused += 1;
      return refusal(FRAME_REASONS.INVALID_CONTRACT, 'outcome is outside the ACK vocabulary');
    }
    if (
      inFlight !== null &&
      raw.frameGeneration === inFlight.frameGeneration &&
      raw.leaseId === inFlight.leaseId &&
      raw.correlation === inFlight.correlation
    ) {
      const cleared = inFlight;
      inFlight = null;
      disarmAckTimer();
      acked += 1;
      ackedFloor = cleared.frameGeneration;
      releaseRecord(cleared, raw.outcome);
      if (onAck !== null) {
        guardOwner(() =>
          onAck({
            principal: cleared.principal,
            epoch: cleared.epoch,
            surfaceId: cleared.surfaceId,
            surfaceGeneration: cleared.surfaceGeneration,
            frameGeneration: cleared.frameGeneration,
            leaseId: cleared.leaseId,
            outcome: raw.outcome,
          }),
        );
      }
      /** @type {number|null} */
      let promoted = null;
      if (pending !== null) {
        const next = pending;
        pending = null;
        inFlight = next;
        if (!postDelivery(next)) return refusal(FRAME_REASONS.CLOSED, 'transport send failed');
        promoted = next.frameGeneration;
      }
      return { ok: true, acked: cleared.frameGeneration, promoted };
    }
    if (raw.frameGeneration <= ackedFloor) {
      return { ok: true, duplicate: true };
    }
    refused += 1;
    return refusal(
      FRAME_REASONS.LEASE_INVALID,
      'ACK matches no in-flight frame; newer holdings are untouched',
    );
  }

  /**
   * Sender: post a verified frame. The first unacked frame crosses the
   * port immediately; later postings replace the single pending slot and
   * release the replaced lease, so the wire never carries a backlog.
   *
   * @param {VerifiedFrame} frame Verified frame for the bound tile.
   * @returns {PortResult}
   */
  function postFrame(frame) {
    if (revoked) {
      return refusal(FRAME_REASONS.PORT_REVOKED, 'port is revoked');
    }
    if (role !== 'sender') {
      refused += 1;
      return refusal(FRAME_REASONS.INVALID_BINDING, 'receivers cannot post frames');
    }
    const raw = /** @type {any} */ (frame);
    const identity = checkIdentity(raw, binding);
    if (identity !== null) {
      refused += 1;
      return identity;
    }
    const shape = checkFrameShape(raw, limits);
    if (shape !== null) {
      refused += 1;
      return shape;
    }
    if (raw.frameGeneration <= acceptedFloor) {
      refused += 1;
      return refusal(FRAME_REASONS.STALE_FRAME_GENERATION, 'frame generation is not newer than accepted');
    }
    acceptedFloor = raw.frameGeneration;
    /** @type {HeldFrame} */
    const record = {
      principal: raw.principal,
      epoch: raw.epoch,
      surfaceId: raw.surfaceId,
      surfaceGeneration: raw.surfaceGeneration,
      frameGeneration: raw.frameGeneration,
      leaseId: raw.leaseId,
      width: raw.width,
      height: raw.height,
      format: raw.format,
      sha256: raw.sha256,
      byteLength: raw.byteLength,
      pixelSpec: { ...raw.pixelSpec },
      bytes: raw.bytes,
      correlation: `${binding.surfaceId}#${raw.frameGeneration}#${raw.leaseId}`,
    };
    if (inFlight === null) {
      inFlight = record;
      if (!postDelivery(record)) return refusal(FRAME_REASONS.CLOSED, 'transport send failed');
      return { ok: true, sent: true, frameGeneration: record.frameGeneration, leaseId: record.leaseId };
    }
    /** @type {number|null} */
    let supersededGen = null;
    if (pending !== null) {
      supersededGen = pending.frameGeneration;
      releaseRecord(pending, ACK_OUTCOMES.SUPERSEDED);
      superseded += 1;
    }
    pending = record;
    return {
      ok: true,
      sent: false,
      queued: true,
      frameGeneration: record.frameGeneration,
      leaseId: record.leaseId,
      superseded: supersededGen,
    };
  }

  /**
   * Sender: consume an ACK for the in-flight frame. A matching ACK clears
   * the slot and sends the newest pending frame; duplicates are idempotent
   * and wrong ACKs never free a newer holding.
   *
   * @param {FrameAck} ack ACK for the bound tile.
   * @returns {PortResult}
   */
  function acceptAck(ack) {
    if (revoked) {
      return refusal(FRAME_REASONS.PORT_REVOKED, 'port is revoked');
    }
    if (role !== 'sender') {
      refused += 1;
      return refusal(FRAME_REASONS.INVALID_BINDING, 'receivers consume deliveries, not ACKs');
    }
    return acceptAckInternal(/** @type {any} */ (ack));
  }

  /**
   * Terminal teardown for either role: idempotent, detaches listeners,
   * clears the ACK timer, closes the port, releases queued holdings exactly
   * once, and notifies the owner exactly once. An active consumer retains its
   * lease until settlement, then releases it with the revocation cause.
   *
   * @param {string} [reason] One of PORT_REVOKE_REASONS; defaults to PORT_REVOKED.
   * @returns {void}
   */
  function revokeFramePort(reason) {
    const cause = reason === undefined ? PORT_REVOKE_REASONS.PORT_REVOKED : reason;
    if (!isRevokeReason(cause)) {
      fail(FRAME_REASONS.INVALID_CONTRACT, 'revoke reason is outside the revoke vocabulary');
    }
    revokeInternal(cause);
  }

  /**
   * @returns {PortInstrumentation} Frozen counters snapshot.
   */
  function getInstrumentation() {
    return /** @type {PortInstrumentation} */ (
      Object.freeze({
        role,
        revoked,
        revokeReason,
        createdAtMs,
        revokedAtMs,
        acceptedFloor,
        ackedFloor,
        inFlightGeneration: inFlight === null ? null : inFlight.frameGeneration,
        pendingGeneration: pending === null ? null : pending.frameGeneration,
        heldGeneration: held !== null ? held.frameGeneration : consuming === null ? null : consuming.frameGeneration,
        sent,
        acked,
        acksSent,
        superseded,
        refused,
        released,
        timeouts,
        releaseFaults,
        lastReleaseFault,
      })
    );
  }

  attachListener('message', onPortMessage);
  attachListener('close', onPortClose);
  if (typeof port.start === 'function') {
    try {
      port.start();
    } catch (error) {
      detachPort();
      throw error;
    }
  }

  return /** @type {FramePort} */ (
    Object.freeze({ postFrame, acceptAck, revokeFramePort, getInstrumentation })
  );
}
