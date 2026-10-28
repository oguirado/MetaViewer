/**
 * @fileoverview In-memory fake host facade for surface_input/v1.
 *
 * Plain JavaScript with JSDoc; test-only double shared by the renderer tests and
 * fixture mode. It honours the contract like the host: closed-schema check, seq
 * strictly increasing per surface from 1, 1..32 events, payload <= 16 KiB, and
 * typed refusals (SURFACE_UNKNOWN/STALE_STREAM from the bound streams plus any
 * closed code via `refuse`). Every received batch is recorded (deep copied) for
 * assertions. It never rejects and never returns off-contract replies.
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
 */

/**
 * @typedef {Object} InputDouble
 * @property {(batch: any) => Promise<import('./inputPort.js').InputSendResult>} send
 * @property {any[]} batches - Deep copies of received batches, in arrival order.
 * @property {() => void} reset - Clears batches and per-surface seq floors.
 */

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
   * @param {any} batch
   * @returns {Promise<import('./inputPort.js').InputSendResult>}
   */
  async function send(batch) {
    record(batch);
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

  return Object.freeze({ send, batches, reset });
}
