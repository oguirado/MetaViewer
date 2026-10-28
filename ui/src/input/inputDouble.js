/**
 * @fileoverview In-memory fake host facade for surface_input/v1.
 *
 * Plain JavaScript with JSDoc; test-only double shared by the renderer tests and
 * fixture mode. It honours the contract like the host: closed-schema check, seq
 * strictly increasing per surface from 1, 1..32 events, payload <= 16 KiB, and
 * typed refusals (SURFACE_UNKNOWN/STALE_STREAM from the bound streams plus any
 * closed code via `refuse`). Every received batch is recorded (deep copied) for
 * assertions. It never rejects and never returns off-contract replies.
 * Behind `options.results` (default off) it also exposes `onResult` and
 * emits one frozen result per settled send with a valid surface_id and seq,
 * mirroring the reply outcome exactly like the host receipt.
 */

import {
  INPUT_LIMITS,
  INPUT_SCHEMA,
  inputBatchByteLength,
  isInputRefusalCode,
  isValidInputEvent,
} from './inputPort.js';

/**
 * @typedef {Object} InputDoubleOptions
 * @property {string[]} [surfaces] - Known surface ids; others refuse SURFACE_UNKNOWN.
 * @property {Record<string, number>} [streams] - Expected stream per surface; mismatch refuses STALE_STREAM.
 * @property {string | Record<string, string> | ((batch: any) => unknown)} [refuse] - Constant,
 * per-surface, or dynamic refusal (nullish accepts). Unknown codes throw at creation;
 * a dynamic refusal returning an unknown code resolves to SCHEMA.
 * @property {boolean} [results] - When true, exposes `onResult` and emits one frozen
 * result per settled send with a valid surface_id and seq. Default false, so the
 * facade stays `{ send, batches, reset }`.
 */

/**
 * @typedef {Object} InputDoubleResult
 * @property {string} surface_id
 * @property {number} seq
 * @property {boolean} ok
 * @property {string|null} code - Null when ok, else the reply refusal code.
 */

/**
 * @typedef {Object} InputDouble
 * @property {(batch: any) => Promise<import('./inputPort.js').InputSendResult>} send
 * @property {any[]} batches - Deep copies of received batches, in arrival order.
 * @property {() => void} reset - Clears batches and per-surface seq floors.
 * @property {((cb: (result: InputDoubleResult) => void) => () => void)} [onResult] - Present
 * only with `options.results`; subscribes to settled-send results.
 */

/**
 * Coded facade failure, mirroring the host preload ContractError shape
 * (`name`, `code`, and a `${code}: ${message}` message).
 */
export class ContractError extends Error {
  /**
   * @param {string} code Diagnostic code.
   * @param {string} message Human-readable detail.
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ContractError';
    /** Diagnostic code. @type {string} @readonly */
    this.code = code;
  }
}

/**
 * @param {string} code
 * @returns {import('./inputPort.js').InputSendResult}
 */
function refused(code) {
  return { ok: false, code };
}

/**
 * Creates an in-memory fake `window.metaviewer.input` facade.
 *
 * @param {InputDoubleOptions} [options]
 * @returns {InputDouble} Frozen double.
 */
export function createInputDouble(options = {}) {
  const refuseOpt = options.refuse ?? null;
  if (typeof refuseOpt === 'string' && !isInputRefusalCode(refuseOpt)) {
    throw new Error(`inputDouble: unknown refusal code ${refuseOpt}`);
  }
  if (refuseOpt !== null && typeof refuseOpt === 'object' && !Array.isArray(refuseOpt)) {
    for (const code of Object.values(refuseOpt)) {
      if (!isInputRefusalCode(code)) throw new Error('inputDouble: unknown refusal code in map');
    }
  }
  if (
    refuseOpt !== null
    && typeof refuseOpt !== 'string'
    && typeof refuseOpt !== 'function'
    && (typeof refuseOpt !== 'object' || Array.isArray(refuseOpt))
  ) {
    throw new Error('inputDouble: refuse must be a code, map, or function');
  }
  const knownSurfaces = Array.isArray(options.surfaces) ? options.surfaces.slice() : null;
  const expectedStreams = options.streams !== null
      && typeof options.streams === 'object'
      && !Array.isArray(options.streams)
    ? options.streams
    : null;

  /** @type {any[]} */
  const batches = [];
  /** @type {Map<string, number>} */
  const lastSeq = new Map();
  const emitResults = options.results === true;
  /** @type {Set<(result: InputDoubleResult) => void>} */
  const resultListeners = new Set();

  /**
   * @param {any} batch
   * @returns {void}
   */
  function record(batch) {
    /** @type {any} */
    let copy = null;
    try {
      const json = JSON.stringify(batch);
      copy = json === undefined ? null : JSON.parse(json);
    } catch {
      copy = null;
    }
    batches.push(copy);
  }

  /**
   * @param {any} batch
   * @returns {string | null} Refusal code, or null to accept.
   */
  function resolveRefusal(batch) {
    if (refuseOpt === null || refuseOpt === undefined) return null;
    if (typeof refuseOpt === 'string') return refuseOpt;
    if (typeof refuseOpt === 'function') {
      /** @type {unknown} */
      let code;
      try {
        code = refuseOpt(batch);
      } catch {
        return 'CORE_UNAVAILABLE';
      }
      if (code === null || code === undefined) return null;
      return isInputRefusalCode(code) ? /** @type {string} */ (code) : 'SCHEMA';
    }
    const surfaceId = batch !== null && typeof batch === 'object' ? batch.surface_id : undefined;
    if (typeof surfaceId !== 'string') return null;
    const code = refuseOpt[surfaceId];
    return typeof code === 'string' ? code : null;
  }

  /**
   * Subscribes to settled-send results. Takes exactly one function argument;
   * anything else throws ContractError ARGS, like the host facade.
   *
   * @param {(result: InputDoubleResult) => void} cb
   * @returns {() => void} Idempotent unsubscribe.
   */
  function onResult(cb) {
    if (arguments.length !== 1 || typeof cb !== 'function') {
      throw new ContractError('ARGS', 'onResult takes exactly one function');
    }
    resultListeners.add(cb);
    return () => { resultListeners.delete(cb); };
  }

  /**
   * Delivers one frozen result per settled send with a valid surface_id
   * and seq, mirroring the reply outcome. Listener throws never reach
   * the sender; sends without a usable identity stay silent.
   *
   * @param {any} batch
   * @param {import('./inputPort.js').InputSendResult} outcome
   * @returns {void}
   */
  function emitResult(batch, outcome) {
    if (!emitResults || resultListeners.size === 0) return;
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) return;
    const surfaceId = batch.surface_id;
    const seq = batch.seq;
    if (typeof surfaceId !== 'string' || surfaceId.length < 1) return;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return;
    const result = Object.freeze({
      surface_id: surfaceId,
      seq,
      ok: outcome.ok,
      code: outcome.ok ? null : (typeof outcome.code === 'string' ? outcome.code : 'SCHEMA'),
    });
    for (const cb of Array.from(resultListeners)) {
      try {
        cb(result);
      } catch {
        // One bad listener never breaks the sender or its siblings.
      }
    }
  }

  /**
   * @param {any} batch
   * @returns {Promise<import('./inputPort.js').InputSendResult>}
   */
  async function send(batch) {
    record(batch);
    const outcome = decide(batch);
    emitResult(batch, outcome);
    return outcome;
  }

  /**
   * Settles one batch exactly as before; `send` records and emits around it.
   *
   * @param {any} batch
   * @returns {import('./inputPort.js').InputSendResult}
   */
  function decide(batch) {
    if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) return refused('SCHEMA');
    if (batch.schema !== INPUT_SCHEMA) return refused('SCHEMA');
    const surfaceId = batch.surface_id;
    const streamId = batch.stream_id;
    const seq = batch.seq;
    const events = batch.events;
    if (typeof surfaceId !== 'string' || surfaceId.length < 1) return refused('SCHEMA');
    if (knownSurfaces !== null && !knownSurfaces.includes(surfaceId)) return refused('SURFACE_UNKNOWN');
    if (typeof streamId !== 'number' || !Number.isSafeInteger(streamId) || streamId < 0) {
      return refused('SCHEMA');
    }
    if (
      expectedStreams !== null
      && Object.hasOwn(expectedStreams, surfaceId)
      && expectedStreams[surfaceId] !== streamId
    ) {
      return refused('STALE_STREAM');
    }
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return refused('SCHEMA');
    const last = lastSeq.get(surfaceId);
    if (last !== undefined && seq <= last) return refused('SCHEMA');
    if (!Array.isArray(events) || events.length < 1 || events.length > INPUT_LIMITS.MAX_EVENTS_PER_BATCH) {
      return refused('SCHEMA');
    }
    for (const ev of events) {
      if (!isValidInputEvent(ev)) return refused('SCHEMA');
    }
    if (inputBatchByteLength(batch) > INPUT_LIMITS.MAX_PAYLOAD_BYTES) return refused('LIMIT');
    lastSeq.set(surfaceId, seq);
    const code = resolveRefusal(batch);
    if (code !== null) return refused(code);
    return { ok: true, accepted: events.length };
  }

  /** @returns {void} */
  function reset() {
    batches.length = 0;
    lastSeq.clear();
  }

  if (emitResults) return Object.freeze({ send, onResult, batches, reset });
  return Object.freeze({ send, batches, reset });
}
