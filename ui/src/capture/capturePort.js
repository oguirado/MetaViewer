/**
 * MetaViewer capture port (MVUI9 lane C): renderer-side adapter over the
 * host capture facade `window.metaviewer.capture`.
 *
 * Components and lanes T/A reach the host only through the names exported
 * here; this module is the malformed-reply boundary. Every host reply is
 * shape-checked (closed refusal codes, phases from MV_RECORDING_PHASES);
 * unknown or malformed replies resolve to `{ok:false,
 * code:'CAPTURE_UNAVAILABLE'}` and never throw into components. A missing
 * facade resolves the same way, so tile chrome renders its disabled state.
 *
 * Request ids are deterministic per-port counters (`mv-capture-1`,
 * `mv-capture-2`, ...): no randomness, no wall clock. A store built on a
 * dedicated port therefore has a deterministic per-store id sequence.
 *
 * Plain JS with JSDoc; Vue is used only for the reactive store.
 *
 * @module capture/capturePort
 */
import { reactive } from 'vue';
import { MV_RECORDING_PHASES } from '../recording/recordingModel.js';

/**
 * Closed host refusal codes for the capture facade.
 * @type {ReadonlyArray<string>}
 */
export const CAPTURE_REFUSAL_CODES = Object.freeze([
  'SURFACE_UNKNOWN',
  'ALREADY_RECORDING',
  'NOT_RECORDING',
  'CAPTURE_UNAVAILABLE',
  'NESTED_DISPLAY_ONLY',
  'LIMIT',
]);

/**
 * Closed host refusal codes for capture export replies (MVUI11 lane E).
 * Export travels the same capture namespace but journals its own refusal
 * vocabulary; the record set above stays pinned for the record methods.
 * @type {ReadonlyArray<string>}
 */
export const EXPORT_REFUSAL_CODES = Object.freeze([
  'DESTINATION_UNSET',
  'CAPTURE_UNKNOWN',
  'NOT_SEALED',
  'DESTINATION_UNAVAILABLE',
  'DESTINATION_EXISTS',
  'LIMIT',
  'NESTED_DISPLAY_ONLY',
  'CAPTURE_UNAVAILABLE',
]);

/**
 * Opaque export destination token. The renderer never holds a path: export
 * is offered only when the host advertised a destination, and the request
 * always carries this token. The host re-validates its own grant and
 * refuses DESTINATION_UNSET when nothing is configured.
 * @type {string}
 */
export const EXPORT_DESTINATION_TOKEN = 'recording:configured';

/**
 * Schema tag sent on every capture request.
 * @type {string}
 */
export const CAPTURE_SCHEMA = 'capture_request/v1';

/**
 * Fallback refusal code: missing facade, unknown code, malformed reply,
 * or a host that throws. Never a thrown exception into components.
 * @type {string}
 */
export const CAPTURE_UNAVAILABLE = 'CAPTURE_UNAVAILABLE';

/**
 * @typedef {Readonly<{id:string,surface_id:string,width:number,height:number,sha256:string,created_ms:number}>} CaptureShot
 * @typedef {Readonly<{id:string,surface_id:string,frames:number,duration_ms:number,sealed:true,sha256:string}>} CaptureRecording
 * @typedef {Readonly<{id:string,kind:string,surface_id:string,phase:string,frames:number,duration_ms:number,sealed:boolean,created_ms:number}>} CaptureRow
 * @typedef {Readonly<{type:'capture.state',recording_id:string,surface_id:string,phase:string,frames:number,elapsed_ms:number}>} CaptureStateEvent
 * @typedef {Readonly<{ok:true,shot:CaptureShot}>|Readonly<{ok:false,code:string}>} CaptureScreenshotResult
 * @typedef {Readonly<{ok:true,recording_id:string}>|Readonly<{ok:false,code:string}>} CaptureRecordStartResult
 * @typedef {Readonly<{ok:true,recording:CaptureRecording}>|Readonly<{ok:false,code:string}>} CaptureRecordStopResult
 * @typedef {Readonly<{ok:true,rows:ReadonlyArray<CaptureRow>}>|Readonly<{ok:false,code:string}>} CaptureListResult
 * @typedef {Readonly<{id:string,bytes:number,sha256:string}>} CaptureExport
 * @typedef {Readonly<{ok:true,export:CaptureExport}>|Readonly<{ok:false,code:string}>} CaptureExportResult
 * @typedef {Readonly<{ok:false,code:string}>} CaptureRefusal
 */

/**
 * @typedef {object} CapturePort
 * @property {boolean} available True when a callable facade was injected.
 * @property {(surfaceId:string)=>Promise<CaptureScreenshotResult>} screenshot
 * @property {(surfaceId:string)=>Promise<CaptureRecordStartResult>} recordStart
 * @property {(recordingId:string)=>Promise<CaptureRecordStopResult>} recordStop
 * @property {(captureId:string)=>Promise<CaptureExportResult>} exportCapture
 * @property {()=>Promise<CaptureListResult>} list
 * @property {(cb:(event:CaptureStateEvent)=>void)=>()=>void} subscribe
 */

/**
 * @typedef {object} CaptureSurfaceEntry
 * @property {string} phase One of MV_RECORDING_PHASES.
 * @property {string|null} recordingId Active recording id, else null.
 * @property {number} frames Last known frame count.
 * @property {number} elapsedMs Last known elapsed time in ms.
 * @property {CaptureShot|null} lastShot Last screenshot, else null.
 * @property {string} lastCode Last refusal code, or '' when healthy.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>} Plain record guard for host data.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean} Non-empty string guard.
 */
function isId(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * @param {unknown} value
 * @returns {boolean} Safe non-negative integer guard.
 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {boolean} Finite non-negative millisecond guard.
 */
function isMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {boolean} Lowercase hex sha256 digest guard.
 */
function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Export receipt byte bounds, mirroring the host seam (1..16 MiB).
 * @type {number}
 */
const EXPORT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * @param {unknown} code
 * @returns {boolean} Membership in the closed refusal set.
 */
function isClosedCode(code) {
  return typeof code === 'string' && CAPTURE_REFUSAL_CODES.includes(code);
}

/**
 * @param {string} code
 * @returns {CaptureRefusal} Frozen refusal; unknown codes fail closed.
 */
function refusal(code) {
  return Object.freeze({ ok: false, code: isClosedCode(code) ? code : CAPTURE_UNAVAILABLE });
}

/**
 * @param {unknown} code
 * @returns {boolean} Membership in the closed export refusal set.
 */
function isExportCode(code) {
  return typeof code === 'string' && EXPORT_REFUSAL_CODES.includes(code);
}

/**
 * @param {string} code
 * @returns {CaptureRefusal} Frozen export refusal; unknown codes fail closed.
 */
function exportRefusal(code) {
  return Object.freeze({ ok: false, code: isExportCode(code) ? code : CAPTURE_UNAVAILABLE });
}

/**
 * @returns {CaptureRefusal} Frozen CAPTURE_UNAVAILABLE refusal.
 */
function unavailable() {
  return Object.freeze({ ok: false, code: CAPTURE_UNAVAILABLE });
}

/**
 * @param {unknown} facade
 * @returns {boolean} True when every contract method is callable.
 */
function isCaptureFacade(facade) {
  if (!isRecord(facade)) return false;
  return ['screenshot', 'recordStart', 'recordStop', 'list', 'subscribe']
    .every((name) => typeof facade[name] === 'function');
}

/**
 * @param {unknown} reply Host reply to a screenshot call.
 * @returns {CaptureScreenshotResult|null} Frozen result, or null when malformed.
 */
function checkShotReply(reply) {
  if (!isRecord(reply)) return null;
  if (reply.ok === false) return refusal(/** @type {any} */ (reply.code));
  if (reply.ok !== true || !isRecord(reply.shot)) return null;
  const shot = reply.shot;
  if (!isId(shot.id) || !isId(shot.surface_id) || !isId(shot.sha256)) return null;
  if (!isCount(shot.width) || shot.width <= 0 || !isCount(shot.height) || shot.height <= 0) return null;
  if (!isMs(shot.created_ms)) return null;
  return Object.freeze({
    ok: true,
    shot: Object.freeze({
      id: shot.id,
      surface_id: shot.surface_id,
      width: shot.width,
      height: shot.height,
      sha256: shot.sha256,
      created_ms: shot.created_ms,
    }),
  });
}

/**
 * @param {unknown} reply Host reply to a recordStart call.
 * @returns {CaptureRecordStartResult|null} Frozen result, or null when malformed.
 */
function checkRecordStartReply(reply) {
  if (!isRecord(reply)) return null;
  if (reply.ok === false) return refusal(/** @type {any} */ (reply.code));
  if (reply.ok !== true || !isId(reply.recording_id)) return null;
  return Object.freeze({ ok: true, recording_id: reply.recording_id });
}

/**
 * @param {unknown} reply Host reply to a recordStop call.
 * @returns {CaptureRecordStopResult|null} Frozen result, or null when malformed.
 */
function checkRecordStopReply(reply) {
  if (!isRecord(reply)) return null;
  if (reply.ok === false) return refusal(/** @type {any} */ (reply.code));
  if (reply.ok !== true || !isRecord(reply.recording)) return null;
  const recording = reply.recording;
  if (!isId(recording.id) || !isId(recording.surface_id) || !isId(recording.sha256)) return null;
  if (!isCount(recording.frames) || !isMs(recording.duration_ms)) return null;
  if (recording.sealed !== true) return null;
  return Object.freeze({
    ok: true,
    recording: Object.freeze({
      id: recording.id,
      surface_id: recording.surface_id,
      frames: recording.frames,
      duration_ms: recording.duration_ms,
      sealed: true,
      sha256: recording.sha256,
    }),
  });
}

/**
 * @param {unknown} reply Host reply to an export call.
 * @returns {CaptureExportResult|null} Frozen result, or null when malformed.
 */
function checkExportReply(reply) {
  if (!isRecord(reply)) return null;
  if (reply.ok === false) return exportRefusal(/** @type {any} */ (reply.code));
  if (reply.ok !== true || !isRecord(reply.export)) return null;
  const receipt = reply.export;
  if (!isId(receipt.id) || !isSha256(receipt.sha256)) return null;
  if (!isCount(receipt.bytes) || receipt.bytes <= 0 || receipt.bytes > EXPORT_MAX_BYTES) return null;
  return Object.freeze({
    ok: true,
    export: Object.freeze({
      id: receipt.id,
      bytes: receipt.bytes,
      sha256: receipt.sha256,
    }),
  });
}

/**
 * @param {unknown} row One manifest row from a list reply.
 * @returns {CaptureRow|null} Frozen row, or null when malformed.
 */
function checkListRow(row) {
  if (!isRecord(row)) return null;
  if (!isId(row.id) || !isId(row.surface_id)) return null;
  if (row.kind !== 'shot' && row.kind !== 'recording') return null;
  if (!MV_RECORDING_PHASES.includes(/** @type {string} */ (row.phase))) return null;
  if (!isCount(row.frames) || !isMs(row.duration_ms)) return null;
  if (typeof row.sealed !== 'boolean' || !isMs(row.created_ms)) return null;
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    surface_id: row.surface_id,
    phase: row.phase,
    frames: row.frames,
    duration_ms: row.duration_ms,
    sealed: row.sealed,
    created_ms: row.created_ms,
  });
}

/**
 * @param {unknown} reply Host reply to a list call.
 * @returns {CaptureListResult|null} Frozen result, or null when malformed.
 */
function checkListReply(reply) {
  if (!isRecord(reply)) return null;
  if (reply.ok === false) return refusal(/** @type {any} */ (reply.code));
  if (reply.ok !== true || !Array.isArray(reply.rows)) return null;
  /** @type {CaptureRow[]} */
  const rows = [];
  for (const row of reply.rows) {
    const checked = checkListRow(row);
    if (checked === null) return null;
    rows.push(checked);
  }
  return Object.freeze({ ok: true, rows: Object.freeze(rows) });
}

/**
 * @param {unknown} event Host-sent capture.state event.
 * @returns {CaptureStateEvent|null} Frozen event, or null when malformed.
 */
function checkStateEvent(event) {
  if (!isRecord(event)) return null;
  if (event.type !== 'capture.state') return null;
  if (!isId(event.recording_id) || !isId(event.surface_id)) return null;
  if (!MV_RECORDING_PHASES.includes(/** @type {string} */ (event.phase))) return null;
  if (!isCount(event.frames) || !isMs(event.elapsed_ms)) return null;
  return Object.freeze({
    type: 'capture.state',
    recording_id: event.recording_id,
    surface_id: event.surface_id,
    phase: event.phase,
    frames: event.frames,
    elapsed_ms: event.elapsed_ms,
  });
}

/**
 * Build the renderer capture port over an injected host facade.
 * Never rejects for host refusals, malformed replies, a throwing host, or
 * a missing facade: all of those resolve to `{ok:false, code}`.
 * @param {unknown} facade `window.metaviewer?.capture`, or undefined.
 * @returns {CapturePort} Frozen port.
 */
export function createCapturePort(facade) {
  const bound = isCaptureFacade(facade) ? /** @type {any} */ (facade) : null;
  let serial = 0;
  const nextRequestId = () => {
    serial += 1;
    return `mv-capture-${serial}`;
  };

  /**
   * @param {string} surfaceId
   * @returns {Promise<CaptureScreenshotResult>}
   */
  async function screenshot(surfaceId) {
    if (!isId(surfaceId) || bound === null) return unavailable();
    /** @type {unknown} */
    let reply;
    try {
      reply = await bound.screenshot({
        schema: CAPTURE_SCHEMA,
        request_id: nextRequestId(),
        surface_id: surfaceId,
      });
    } catch {
      return unavailable();
    }
    return checkShotReply(reply) ?? unavailable();
  }

  /**
   * @param {string} surfaceId
   * @returns {Promise<CaptureRecordStartResult>}
   */
  async function recordStart(surfaceId) {
    if (!isId(surfaceId) || bound === null) return unavailable();
    /** @type {unknown} */
    let reply;
    try {
      reply = await bound.recordStart({
        schema: CAPTURE_SCHEMA,
        request_id: nextRequestId(),
        surface_id: surfaceId,
        mode: 'ai',
      });
    } catch {
      return unavailable();
    }
    return checkRecordStartReply(reply) ?? unavailable();
  }

  /**
   * @param {string} recordingId
   * @returns {Promise<CaptureRecordStopResult>}
   */
  async function recordStop(recordingId) {
    if (!isId(recordingId) || bound === null) return unavailable();
    /** @type {unknown} */
    let reply;
    try {
      reply = await bound.recordStop({
        schema: CAPTURE_SCHEMA,
        request_id: nextRequestId(),
        recording_id: recordingId,
      });
    } catch {
      return unavailable();
    }
    return checkRecordStopReply(reply) ?? unavailable();
  }

  /**
   * @param {string} captureId Sealed capture id (shot or recording).
   * @returns {Promise<CaptureExportResult>}
   */
  async function exportCapture(captureId) {
    if (!isId(captureId) || bound === null || typeof bound.export !== 'function') return unavailable();
    /** @type {unknown} */
    let reply;
    try {
      reply = await bound.export({
        schema: CAPTURE_SCHEMA,
        request_id: nextRequestId(),
        capture_id: captureId,
        destination: EXPORT_DESTINATION_TOKEN,
      });
    } catch {
      return unavailable();
    }
    return checkExportReply(reply) ?? unavailable();
  }

  /**
   * @returns {Promise<CaptureListResult>}
   */
  async function list() {
    if (bound === null) return unavailable();
    /** @type {unknown} */
    let reply;
    try {
      reply = await bound.list();
    } catch {
      return unavailable();
    }
    return checkListReply(reply) ?? unavailable();
  }

  /**
   * @param {(event:CaptureStateEvent)=>void} cb Listener for valid events only.
   * @returns {()=>void} Unsubscribe; always callable, never throws.
   */
  function subscribe(cb) {
    const noop = () => {};
    if (typeof cb !== 'function' || bound === null) return noop;
    /** @type {()=>void} */
    let off = noop;
    try {
      const result = bound.subscribe((/** @type {unknown} */ event) => {
        const checked = checkStateEvent(event);
        if (checked !== null) cb(checked);
      });
      if (typeof result === 'function') off = result;
    } catch {
      return noop;
    }
    return () => {
      try {
        off();
      } catch {
        /* Host unsubscribe is best-effort. */
      }
    };
  }

  return Object.freeze({
    available: bound !== null,
    screenshot,
    recordStart,
    recordStop,
    exportCapture,
    list,
    subscribe,
  });
}

/**
 * @returns {CaptureSurfaceEntry} Fresh per-surface entry (idle, empty).
 */
function freshEntry() {
  return { phase: 'idle', recordingId: null, frames: 0, elapsedMs: 0, lastShot: null, lastCode: '' };
}

/**
 * Phases that keep a recording id attached to the surface entry.
 * @type {ReadonlyArray<string>}
 */
const ACTIVE_PHASES = Object.freeze(['starting', 'recording', 'stopping']);

/**
 * Build a Vue-reactive capture store over a port. Subscribes exactly once
 * at creation; `dispose()` releases that subscription, after which actions
 * resolve to CAPTURE_UNAVAILABLE without touching the facade.
 * @param {CapturePort} port Port from `createCapturePort`.
 * @returns {{bySurface:Record<string,CaptureSurfaceEntry>,rows:CaptureRow[],available:boolean,port:CapturePort,toggleRecord:(surfaceId:string)=>Promise<CaptureRecordStartResult|CaptureRecordStopResult>,screenshot:(surfaceId:string)=>Promise<CaptureScreenshotResult>,refresh:()=>Promise<CaptureListResult>,exportCapture:(captureId:string)=>Promise<CaptureExportResult>,dispose:()=>void}} Reactive store.
 */
export function createCaptureState(port) {
  if (!isRecord(port)
    || typeof port.screenshot !== 'function'
    || typeof port.recordStart !== 'function'
    || typeof port.recordStop !== 'function'
    || typeof port.list !== 'function'
    || typeof port.subscribe !== 'function') {
    throw new TypeError('createCaptureState requires a capture port');
  }
  const typed = /** @type {CapturePort} */ (/** @type {unknown} */ (port));
  const bySurface = reactive(/** @type {Record<string, CaptureSurfaceEntry>} */ ({}));
  const rows = reactive(/** @type {CaptureRow[]} */ ([]));
  let disposed = false;
  /** @type {Map<string, CaptureStateEvent|null>} */
  const pendingStarts = new Map();
  /** @type {Set<string>} Capture ids with an export in flight. */
  const exporting = new Set();

  /**
   * @param {string} surfaceId
   * @returns {CaptureSurfaceEntry} Existing or fresh entry.
   */
  function ensureEntry(surfaceId) {
    const known = bySurface[surfaceId];
    if (known !== undefined) return known;
    const entry = freshEntry();
    bySurface[surfaceId] = entry;
    return entry;
  }

  /**
   * @param {CaptureStateEvent} event Validated port event.
   */
  function applyEvent(event) {
    if (disposed) return;
    if (pendingStarts.has(event.surface_id)) pendingStarts.set(event.surface_id, event);
    const entry = ensureEntry(event.surface_id);
    entry.phase = event.phase;
    entry.frames = event.frames;
    entry.elapsedMs = event.elapsed_ms;
    entry.recordingId = ACTIVE_PHASES.includes(event.phase) ? event.recording_id : null;
  }

  const unsubscribe = typed.subscribe(applyEvent);

  /**
   * Start recording when idle, stop the active recording otherwise.
   * @param {string} surfaceId Frame notice surface id.
   * @returns {Promise<CaptureRecordStartResult|CaptureRecordStopResult>}
   */
  async function toggleRecord(surfaceId) {
    if (!isId(surfaceId) || disposed) return unavailable();
    const entry = ensureEntry(surfaceId);
    if (entry.phase === 'starting' || entry.phase === 'stopping') return unavailable();
    if (entry.recordingId !== null) {
      const previousPhase = entry.phase;
      entry.phase = 'stopping';
      const stopped = await typed.recordStop(entry.recordingId);
      if (disposed) return unavailable();
      if (stopped.ok) {
        entry.phase = 'idle';
        entry.recordingId = null;
        entry.frames = 0;
        entry.elapsedMs = 0;
        entry.lastCode = '';
      } else {
        if (entry.phase === 'stopping') entry.phase = previousPhase;
        entry.lastCode = stopped.code;
        if (stopped.code === 'NOT_RECORDING') {
          entry.phase = 'idle';
          entry.recordingId = null;
        }
      }
      return stopped;
    }
    pendingStarts.set(surfaceId, null);
    entry.phase = 'starting';
    const started = await typed.recordStart(surfaceId);
    if (disposed) return unavailable();
    const event = pendingStarts.get(surfaceId);
    pendingStarts.delete(surfaceId);
    if (started.ok) {
      if (event?.recording_id === started.recording_id) {
        if (entry.phase === 'starting') entry.phase = 'recording';
        entry.lastCode = '';
        return started;
      }
      entry.phase = 'recording';
      entry.recordingId = started.recording_id;
      entry.frames = 0;
      entry.elapsedMs = 0;
      entry.lastCode = '';
    } else {
      entry.phase = 'idle';
      entry.lastCode = started.code;
    }
    return started;
  }

  /**
   * @param {string} surfaceId Frame notice surface id.
   * @returns {Promise<CaptureScreenshotResult>}
   */
  async function screenshot(surfaceId) {
    if (!isId(surfaceId) || disposed) return unavailable();
    const entry = ensureEntry(surfaceId);
    const result = await typed.screenshot(surfaceId);
    if (disposed) return unavailable();
    if (result.ok) {
      entry.lastShot = result.shot;
      entry.lastCode = '';
    } else {
      entry.lastCode = result.code;
    }
    return result;
  }

  /**
   * @returns {Promise<CaptureListResult>} Replaces `rows` on success.
   */
  async function refresh() {
    if (disposed) return unavailable();
    const result = await typed.list();
    if (disposed) return unavailable();
    if (result.ok) rows.splice(0, rows.length, ...result.rows);
    return result;
  }

  /**
   * Export a sealed capture to the host-configured destination. At most
   * one export per capture id is in flight; a duplicate resolves to
   * CAPTURE_UNAVAILABLE without touching the facade, like the busy
   * record transitions.
   * @param {string} captureId Sealed capture id (shot or recording).
   * @returns {Promise<CaptureExportResult>}
   */
  async function exportCapture(captureId) {
    if (!isId(captureId) || disposed) return unavailable();
    if (typeof typed.exportCapture !== 'function') return unavailable();
    if (exporting.has(captureId)) return unavailable();
    exporting.add(captureId);
    try {
      const result = await typed.exportCapture(captureId);
      if (disposed) return unavailable();
      return result;
    } finally {
      exporting.delete(captureId);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pendingStarts.clear();
    exporting.clear();
    unsubscribe();
  }

  return reactive({
    bySurface,
    rows,
    available: typed.available,
    port: typed,
    toggleRecord,
    screenshot,
    refresh,
    exportCapture,
    dispose,
  });
}
