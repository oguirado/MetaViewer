/**
 * In-memory capture double (MVUI9 lane C): a fake `window.metaviewer.capture`
 * facade honouring the exact host contract, for tests and fixtures.
 *
 * Contract surface (only these six methods): `screenshot`, `recordStart`,
 * `recordStop`, `export`, `list`, `subscribe`. Malformed request shapes
 * throw synchronously; well-formed requests resolve to `{ok:true,...}` or
 * a closed-code refusal `{ok:false, code, request_id}`. One active
 * recording per surface; `LIMIT` when `options.limit` is reached; every
 * mutating call refuses `NESTED_DISPLAY_ONLY` when `options.nested` is
 * set. `export` keeps no disk: it validates the closed shape, then
 * honours the host refusal vocabulary (DESTINATION_UNSET,
 * CAPTURE_UNKNOWN, NOT_SEALED, DESTINATION_UNAVAILABLE,
 * DESTINATION_EXISTS, LIMIT, CAPTURE_UNAVAILABLE) before resolving a
 * deterministic receipt `{id, bytes, sha256}`.
 *
 * Ids are deterministic per-double counters (`shot-1`, `rec-1`, ...).
 * Timestamps use the wall clock, exactly like a live host would.
 *
 * @module capture/captureDouble
 */
import { CAPTURE_SCHEMA } from './capturePort.js';

/**
 * @typedef {object} CaptureDoubleOptions
 * @property {boolean} [nested] Nested display-only mode: mutating calls refuse.
 * @property {boolean} [unavailable] Whole capture unavailable: every call refuses.
 * @property {string[]} [surfaces] Closed surface world; unknown ids refuse
 *   SURFACE_UNKNOWN. Omit for an open world (any non-empty id is known).
 * @property {number} [limit] Max concurrent active recordings (default: none).
 * @property {boolean} [noDestination] Destination unset: export refuses DESTINATION_UNSET.
 * @property {boolean} [destinationUnavailable] Destination I/O failure: export
 *   refuses DESTINATION_UNAVAILABLE.
 * @property {number} [exportLimit] Max successful exports (default: none);
 *   further exports refuse LIMIT.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>} Plain record guard.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Printable ASCII, the request-id alphabet.
 * @type {RegExp}
 */
const REQUEST_ID_ALPHABET = /^[\x20-\x7E]*$/;

/**
 * Validate a mutating request; throws on any malformed shape.
 * @param {unknown} value Raw request.
 * @param {string[]} fields Required non-empty string fields.
 * @returns {Record<string, any>} The validated request.
 */
function requireRequest(value, fields) {
  if (!isRecord(value)) throw new TypeError('captureDouble: request must be an object');
  if (value.schema !== CAPTURE_SCHEMA) throw new TypeError('captureDouble: unknown schema');
  const requestId = value.request_id;
  if (typeof requestId !== 'string'
    || requestId.length === 0
    || requestId.length > 64
    || !REQUEST_ID_ALPHABET.test(requestId)) {
    throw new TypeError('captureDouble: bad request_id');
  }
  for (const field of fields) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new TypeError(`captureDouble: bad ${field}`);
    }
  }
  return value;
}

/**
 * Build an in-memory capture facade honouring the host contract.
 * @param {CaptureDoubleOptions} [options] Double behaviour switches.
 * @returns {{screenshot:(request:unknown)=>any,recordStart:(request:unknown)=>any,recordStop:(request:unknown)=>any,export:(request:unknown)=>any,list:()=>any,subscribe:(cb:unknown)=>()=>void}} Fake facade.
 */
export function createCaptureDouble(options) {
  const opts = isRecord(options) ? options : {};
  const nested = opts.nested === true;
  const unavailable = opts.unavailable === true;
  /** @type {Set<string>|null} */
  const surfaces = Array.isArray(opts.surfaces)
    ? new Set(opts.surfaces.filter((entry) => typeof entry === 'string' && entry.length > 0))
    : null;
  const limit = typeof opts.limit === 'number' && Number.isSafeInteger(opts.limit) && opts.limit >= 0
    ? opts.limit
    : Number.POSITIVE_INFINITY;
  const noDestination = opts.noDestination === true;
  const destinationUnavailable = opts.destinationUnavailable === true;
  const exportLimit = typeof opts.exportLimit === 'number' && Number.isSafeInteger(opts.exportLimit) && opts.exportLimit >= 0
    ? opts.exportLimit
    : Number.POSITIVE_INFINITY;

  let shotSerial = 0;
  let recSerial = 0;
  /** @type {Map<string, {id:string,surface_id:string,frames:number,started_ms:number}>} */
  const active = new Map();
  /** @type {any[]} */
  const sealed = [];
  /** @type {Set<string>} */
  const exported = new Set();
  let exportSerial = 0;
  /** @type {Set<(event:any)=>void>} */
  const listeners = new Set();

  /**
   * @param {string} code Closed refusal code.
   * @param {unknown} requestId Echoed request id.
   * @returns {any} Frozen refusal.
   */
  function refuse(code, requestId) {
    return Object.freeze({ ok: false, code, request_id: requestId });
  }

  /**
   * @param {any} event Frozen event.
   */
  function emit(event) {
    for (const cb of [...listeners]) cb(event);
  }

  /**
   * @param {unknown} request Raw screenshot request.
   * @returns {any} Shot result or refusal.
   */
  function screenshot(request) {
    const req = requireRequest(request, ['surface_id']);
    const surfaceId = /** @type {string} */ (req.surface_id);
    if (nested) return refuse('NESTED_DISPLAY_ONLY', req.request_id);
    if (unavailable) return refuse('CAPTURE_UNAVAILABLE', req.request_id);
    if (surfaces !== null && !surfaces.has(surfaceId)) return refuse('SURFACE_UNKNOWN', req.request_id);
    shotSerial += 1;
    const shot = Object.freeze({
      id: `shot-${shotSerial}`,
      surface_id: surfaceId,
      width: 1280,
      height: 720,
      sha256: '0'.repeat(64),
      created_ms: Date.now(),
    });
    sealed.push(Object.freeze({
      id: shot.id,
      kind: 'shot',
      surface_id: surfaceId,
      phase: 'sealed',
      frames: 1,
      duration_ms: 0,
      sealed: true,
      created_ms: shot.created_ms,
    }));
    return Object.freeze({ ok: true, shot });
  }

  /**
   * @param {unknown} request Raw recordStart request.
   * @returns {any} Recording id result or refusal.
   */
  function recordStart(request) {
    const req = requireRequest(request, ['surface_id']);
    if (req.mode !== 'ai') throw new TypeError('captureDouble: mode must be ai');
    const surfaceId = /** @type {string} */ (req.surface_id);
    if (nested) return refuse('NESTED_DISPLAY_ONLY', req.request_id);
    if (unavailable) return refuse('CAPTURE_UNAVAILABLE', req.request_id);
    if (surfaces !== null && !surfaces.has(surfaceId)) return refuse('SURFACE_UNKNOWN', req.request_id);
    for (const rec of active.values()) {
      if (rec.surface_id === surfaceId) return refuse('ALREADY_RECORDING', req.request_id);
    }
    if (active.size >= limit) return refuse('LIMIT', req.request_id);
    recSerial += 1;
    const id = `rec-${recSerial}`;
    active.set(id, { id, surface_id: surfaceId, frames: 0, started_ms: Date.now() });
    emit(Object.freeze({
      type: 'capture.state',
      recording_id: id,
      surface_id: surfaceId,
      phase: 'recording',
      frames: 0,
      elapsed_ms: 0,
    }));
    return Object.freeze({ ok: true, recording_id: id });
  }

  /**
   * @param {unknown} request Raw recordStop request.
   * @returns {any} Sealed recording result or refusal.
   */
  function recordStop(request) {
    const req = requireRequest(request, ['recording_id']);
    const recordingId = /** @type {string} */ (req.recording_id);
    if (nested) return refuse('NESTED_DISPLAY_ONLY', req.request_id);
    if (unavailable) return refuse('CAPTURE_UNAVAILABLE', req.request_id);
    const rec = active.get(recordingId);
    if (rec === undefined) return refuse('NOT_RECORDING', req.request_id);
    active.delete(recordingId);
    const durationMs = Math.max(0, Date.now() - rec.started_ms);
    const recording = Object.freeze({
      id: rec.id,
      surface_id: rec.surface_id,
      frames: rec.frames,
      duration_ms: durationMs,
      sealed: true,
      sha256: 'f'.repeat(64),
    });
    sealed.push(Object.freeze({
      id: rec.id,
      kind: 'recording',
      surface_id: rec.surface_id,
      phase: 'sealed',
      frames: rec.frames,
      duration_ms: durationMs,
      sealed: true,
      created_ms: rec.started_ms,
    }));
    emit(Object.freeze({
      type: 'capture.state',
      recording_id: rec.id,
      surface_id: rec.surface_id,
      phase: 'sealed',
      frames: rec.frames,
      elapsed_ms: durationMs,
    }));
    return Object.freeze({ ok: true, recording });
  }

  /**
   * @param {unknown} request Raw export request.
   * @returns {any} Export receipt or refusal.
   */
  function exportCapture(request) {
    const req = requireRequest(request, ['capture_id']);
    if (req.destination !== null && req.destination !== 'recording:configured') {
      throw new TypeError('captureDouble: bad destination');
    }
    const captureId = /** @type {string} */ (req.capture_id);
    if (nested) return refuse('NESTED_DISPLAY_ONLY', req.request_id);
    if (unavailable) return refuse('CAPTURE_UNAVAILABLE', req.request_id);
    if (req.destination === null || noDestination) return refuse('DESTINATION_UNSET', req.request_id);
    const sealedRow = sealed.find((row) => row.id === captureId);
    if (sealedRow === undefined) {
      if (active.has(captureId)) return refuse('NOT_SEALED', req.request_id);
      return refuse('CAPTURE_UNKNOWN', req.request_id);
    }
    if (exportSerial >= exportLimit) return refuse('LIMIT', req.request_id);
    if (destinationUnavailable) return refuse('DESTINATION_UNAVAILABLE', req.request_id);
    if (exported.has(captureId)) return refuse('DESTINATION_EXISTS', req.request_id);
    exported.add(captureId);
    exportSerial += 1;
    const receipt = Object.freeze({
      id: captureId,
      bytes: 2048,
      sha256: sealedRow.kind === 'shot' ? '0'.repeat(64) : 'f'.repeat(64),
    });
    return Object.freeze({ ok: true, export: receipt });
  }

  /**
   * @returns {any} Manifest rows (sealed history plus live active rows).
   */
  function list() {
    if (unavailable) return Object.freeze({ ok: false, code: 'CAPTURE_UNAVAILABLE' });
    const now = Date.now();
    /** @type {any[]} */
    const rows = [...sealed];
    for (const rec of active.values()) {
      rows.push(Object.freeze({
        id: rec.id,
        kind: 'recording',
        surface_id: rec.surface_id,
        phase: 'recording',
        frames: rec.frames,
        duration_ms: Math.max(0, now - rec.started_ms),
        sealed: false,
        created_ms: rec.started_ms,
      }));
    }
    return Object.freeze({ ok: true, rows: Object.freeze(rows) });
  }

  /**
   * @param {unknown} cb State listener.
   * @returns {()=>void} Unsubscribe.
   */
  function subscribe(cb) {
    if (typeof cb !== 'function') throw new TypeError('captureDouble: listener must be a function');
    const listener = /** @type {(event:any)=>void} */ (cb);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return Object.freeze({ screenshot, recordStart, recordStop, export: exportCapture, list, subscribe });
}
