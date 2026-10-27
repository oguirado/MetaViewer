// @ts-check
/**
 * @fileoverview Frame-port router: main-world consumer for brokered surface frame ports.
 *
 * MVUI14 lane F (plan MV-UI7). Preload forwards one MessagePort per
 * (surface_id, surface_generation) stream with
 * `window.postMessage({type:'metaviewer:frame-port', schema:'frame_port/v1',
 * surface_id, surface_generation}, origin, [port])`. This router accepts only
 * same-origin notices of exactly that closed shape with exactly one port,
 * validates each `frame_delivery/v0.2` (closed shape, packed rgb24 geometry,
 * sha256 over the bytes), paints through the bound tile scheduler draw path,
 * and acks every delivery exactly once with a `frame_ack/v0.2` outcome.
 *
 * Newest-only per surface: a delivery replaced before paint is acked
 * SUPERSEDED. Ports close on fold, hide, lost/destroy, unbind, dispose, or
 * when a newer surface_generation notice replaces the stream; late arrivals
 * on a retired port are never painted. The router is dormant until the first
 * valid notice, so it never double-paints with the interim preload painter
 * (whose schemaless notices fail the closed-shape check).
 *
 * The notice surface_generation is ONLY a monotonic stream id: it orders and
 * replaces streams per surface and is never compared with the
 * surfaceGeneration carried inside deliveries. The delivery binding is pinned
 * from the first accepted delivery on a port and required consistent only
 * among deliveries on that same port; every ack echoes the delivery's own
 * identity fields verbatim.
 *
 * The scheduler instance is App-owned, so tiles bind it: SurfaceCanvas calls
 * bindSurface on mount (surfaceId + scheduler + attach-retry hook) and
 * unbindSurface on unmount. Unknown surfaces (no binding) refuse deliveries.
 * Plain JavaScript with JSDoc; no product imports, no timers, no dependencies.
 * @module frames/framePortRouter
 */

/** Notice type posted by preload to the main world. @type {string} */
export const FRAME_PORT_NOTICE_TYPE = 'metaviewer:frame-port';

/** Closed notice schema. @type {string} */
export const FRAME_PORT_NOTICE_SCHEMA = 'frame_port/v1';

/** Delivery envelope schema. @type {string} */
export const FRAME_DELIVERY_SCHEMA = 'frame_delivery/v0.2';

/** Ack envelope schema. @type {string} */
export const FRAME_ACK_SCHEMA = 'frame_ack/v0.2';

/** Terminal per-delivery ack outcomes. */
export const FRAME_OUTCOMES = Object.freeze({
  PRESENTED: 'PRESENTED',
  SUPERSEDED: 'SUPERSEDED',
  FOLD_DRAIN: 'FOLD_DRAIN',
  HIDDEN: 'HIDDEN',
  CONTEXT_LOST: 'CONTEXT_LOST',
  SURFACE_DESTROYED: 'SURFACE_DESTROYED',
  REFUSED: 'REFUSED',
});

/** Outcomes that retire the stream port after the ack. @type {ReadonlySet<string>} */
const PORT_CLOSING_OUTCOMES = new Set([
  FRAME_OUTCOMES.FOLD_DRAIN,
  FRAME_OUTCOMES.HIDDEN,
  FRAME_OUTCOMES.CONTEXT_LOST,
  FRAME_OUTCOMES.SURFACE_DESTROYED,
]);

const NOTICE_KEYS = 'schema,surface_generation,surface_id,type';
const DELIVERY_KEYS = ['schema', 'kind', 'correlation', 'principal', 'epoch',
  'surfaceId', 'surfaceGeneration', 'frameGeneration', 'leaseId', 'width',
  'height', 'format', 'byteLength', 'sha256', 'pixelSpec', 'bytes'].sort().join(',');
const SHA256_RE = /^[0-9a-f]{64}$/;
const NULL_DIGEST = '0'.repeat(64);
const RGB24_FORMAT = 'rgb24';
const RGB24_BYTES_PER_PIXEL = 3;
/** Bounded immediate re-present attempts before a draw-failure refusal. @type {number} */
const PRESENT_ATTEMPTS = 3;

/**
 * @typedef {object} RouterTarget Window-like event target carrying location.origin.
 * @property {{ origin?: unknown }} [location]
 * @property {(type: string, listener: (event: any) => void) => void} addEventListener
 * @property {(type: string, listener: (event: any) => void) => void} removeEventListener
 */

/**
 * @typedef {object} SchedulerBinding Structural tile-scheduler handle.
 * @property {(config: any) => any} registerSurface
 * @property {(frame: any) => any} submitFrame
 * @property {(surfaceId: unknown) => any} presentSurfaceNow
 * @property {(surfaceId: unknown) => any} getInstrumentation
 */

/**
 * @typedef {object} SurfaceBinding Tile-side registration for one surface.
 * @property {string} surfaceId
 * @property {SchedulerBinding} scheduler
 * @property {(notice: { surfaceId: string, surfaceGeneration: number, epoch: number }) => void} [onRegistered]
 */

/**
 * @typedef {object} InstallOptions
 * @property {RouterTarget} target Window-like target to listen on.
 * @property {(bytes: Uint8Array) => Promise<string>} [digestSha256] Hex-digest override (tests); defaults to SubtleCrypto.
 */

/**
 * @typedef {object} FramePortRouter Frozen router handle.
 * @property {(binding: SurfaceBinding) => boolean} bindSurface
 * @property {(surfaceId: unknown) => void} unbindSurface
 * @property {(listener: (notice: { surfaceId: string, surfaceGeneration: number, epoch: number }) => void) => () => void} onSurfaceRegistered
 * @property {(surfaceId?: string) => unknown} getSurfaceStatus
 * @property {() => void} dispose
 */

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
 * Closed-shape check: exact own-key set, data descriptors only.
 * @param {unknown} value
 * @param {string} keys Sorted comma-joined key list.
 * @returns {boolean}
 */
function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Reflect.ownKeys(value).length !== keys.split(',').length) return false;
  if (Object.keys(value).sort().join(',') !== keys) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}

/**
 * Admit a frame-port notice: exactly {type, schema, surface_id,
 * surface_generation} with the pinned type/schema, a non-empty surface id
 * and a positive surface generation. Extra keys refuse.
 * @param {unknown} data Untrusted message data.
 * @returns {boolean}
 */
export function isFramePortNotice(data) {
  if (!hasExactKeys(data, NOTICE_KEYS)) return false;
  const notice = /** @type {Record<string, unknown>} */ (data);
  return notice.type === FRAME_PORT_NOTICE_TYPE
    && notice.schema === FRAME_PORT_NOTICE_SCHEMA
    && isNonEmptyString(notice.surface_id)
    && isPositiveSafeInt(notice.surface_generation);
}

/**
 * Default sha256 over frame bytes via WebCrypto.
 * @param {Uint8Array} bytes Packed rgb24 bytes.
 * @returns {Promise<string>} Lowercase hex digest.
 */
async function defaultDigestSha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('DIGEST_UNAVAILABLE');
  const digest = await subtle.digest('SHA-256', /** @type {BufferSource} */ (/** @type {unknown} */ (bytes)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Install the frame-port router on a window-like target. Live boots only;
 * the caller (main.js) skips fixture boots. Returns null when the target
 * cannot carry the protocol (no listener API or no own origin to pin).
 * @param {InstallOptions} options
 * @returns {FramePortRouter|null}
 */
export function installFramePortRouter(options) {
  const target = /** @type {any} */ (options?.target ?? null);
  if (target === null || typeof target !== 'object') return null;
  if (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') return null;
  const ownOrigin = target.location?.origin;
  if (typeof ownOrigin !== 'string' || ownOrigin.length === 0) return null;
  const digestSha256 = typeof options?.digestSha256 === 'function' ? options.digestSha256 : defaultDigestSha256;

  /** @type {Map<string, any>} surfaceId -> stream entry */
  const streams = new Map();
  /** @type {Map<string, { scheduler: SchedulerBinding, onRegistered?: SurfaceBinding['onRegistered'] }>} */
  const bindings = new Map();
  /** @type {Set<(notice: { surfaceId: string, surfaceGeneration: number, epoch: number }) => void>} */
  const registeredListeners = new Set();
  let disposed = false;

  /**
   * Best-effort close of transferred ports we refuse to adopt.
   * @param {unknown} ports
   * @returns {void}
   */
  function closePorts(ports) {
    if (!Array.isArray(ports)) return;
    for (const port of ports) {
      try { port?.close?.(); } catch { /* A detached port still refuses. */ }
    }
  }

  /**
   * @param {any} entry
   * @returns {void}
   */
  function detachPort(entry) {
    const port = entry.port;
    entry.port = null;
    if (port === null || typeof port !== 'object') return;
    try {
      if (typeof port.removeEventListener === 'function') {
        port.removeEventListener('message', entry.onPortMessage);
        port.removeEventListener('close', entry.onPortClose);
      } else if (typeof port.off === 'function') {
        port.off('message', entry.onPortMessage);
        port.off('close', entry.onPortClose);
      } else if (typeof port.removeListener === 'function') {
        port.removeListener('message', entry.onPortMessage);
        port.removeListener('close', entry.onPortClose);
      }
      if (port.onmessage === entry.onPortMessage) port.onmessage = null;
    } catch { /* Detach never blocks retirement. */ }
    try { port.close?.(); } catch { /* A dead port still retires. */ }
  }

  /**
   * Post one ack; at-most-once per record, failures swallowed (a dead port
   * surfaces through the host ack timeout, never through a throw here).
   * @param {any} port
   * @param {any} raw Delivery the ack answers.
   * @param {string} outcome One of FRAME_OUTCOMES.
   * @returns {void}
   */
  function postAck(port, raw, outcome) {
    if (port === null || typeof port !== 'object' || typeof port.postMessage !== 'function') return;
    try {
      port.postMessage({
        schema: FRAME_ACK_SCHEMA,
        kind: 'ack',
        correlation: raw.correlation,
        principal: raw.principal,
        epoch: raw.epoch,
        surfaceId: raw.surfaceId,
        surfaceGeneration: raw.surfaceGeneration,
        frameGeneration: raw.frameGeneration,
        leaseId: raw.leaseId,
        outcome,
      });
    } catch { /* Ack loss surfaces through the host timeout. */ }
  }

  /**
   * Settle one record exactly once.
   * @param {any} record
   * @param {string} outcome
   * @returns {void}
   */
  function settle(record, outcome) {
    if (record.settled) return;
    record.settled = true;
    postAck(record.port, record.raw, outcome);
  }

  /**
   * Retire a stream: drop it from the map, detach and close its port, and
   * settle every queued record with the terminal outcome. An in-flight
   * record settles when its validation completes (never painted).
   * @param {any} entry
   * @param {string} outcome Outcome for queued records.
   * @returns {void}
   */
  function retireStream(entry, outcome) {
    entry.disposed = true;
    if (streams.get(entry.surfaceId) === entry) streams.delete(entry.surfaceId);
    detachPort(entry);
    for (const queued of entry.queue.splice(0)) settle(queued, outcome);
  }

  /**
   * @param {{ surfaceId: string, surfaceGeneration: number, epoch: number }} notice
   * @returns {void}
   */
  function emitRegistered(notice) {
    for (const listener of [...registeredListeners]) {
      try { listener(notice); } catch { /* Observers never break the stream. */ }
    }
    const binding = bindings.get(notice.surfaceId);
    if (binding?.onRegistered) {
      try { binding.onRegistered(notice); } catch { /* A tile retry never breaks the stream. */ }
    }
  }

  /**
   * Read the ack identity off an untrusted delivery. Null when no valid ack
   * can be built (the arrival is dropped silently: a correlation-less ack
   * matches nothing on the host).
   * @param {any} raw
   * @returns {boolean} True when every ack identity field is well-typed.
   */
  function hasAckIdentity(raw) {
    return raw !== null && typeof raw === 'object'
      && isNonEmptyString(raw.correlation)
      && isNonEmptyString(raw.principal)
      && Number.isSafeInteger(raw.epoch)
      && isNonEmptyString(raw.surfaceId)
      && Number.isSafeInteger(raw.surfaceGeneration)
      && Number.isSafeInteger(raw.frameGeneration)
      && isNonEmptyString(raw.leaseId);
  }

  /**
   * Refuse one arrival: REFUSED when an ack can be built, silent otherwise.
   * @param {any} entry
   * @param {any} raw
   * @returns {void}
   */
  function refuseArrival(entry, raw) {
    if (hasAckIdentity(raw)) postAck(entry.port, raw, FRAME_OUTCOMES.REFUSED);
  }

  /**
   * Validate a delivery against the stream binding and the packed-rgb24
   * shape. Pure of scheduler state except the admitted floor, which advances
   * only for accepted records. The notice stream id is never compared here:
   * the delivery binding (surfaceGeneration) is pinned from the first
   * accepted delivery and required consistent only among deliveries.
   * @param {any} entry
   * @param {any} raw
   * @returns {{ ok: true } | { ok: false }} Refusals ack inside.
   */
  function admitDelivery(entry, raw) {
    const refuse = () => { refuseArrival(entry, raw); return { ok: /** @type {const} */ (false) }; };
    if (raw === null || typeof raw !== 'object') return refuse();
    if (raw.schema !== FRAME_DELIVERY_SCHEMA || raw.kind !== 'frame') return refuse();
    if (!hasExactKeys(raw, DELIVERY_KEYS)) return refuse();
    if (!isNonEmptyString(raw.correlation)) return refuse();
    if (raw.surfaceId !== entry.surfaceId) return refuse();
    if (!isPositiveSafeInt(raw.surfaceGeneration)) return refuse();
    if (!isNonEmptyString(raw.principal) || !isPositiveSafeInt(raw.epoch)) return refuse();
    if (entry.pinned && (raw.principal !== entry.principal || raw.epoch !== entry.epoch
      || raw.surfaceGeneration !== entry.deliveryGeneration)) return refuse();
    if (!isPositiveSafeInt(raw.frameGeneration)) return refuse();
    if (!isNonEmptyString(raw.leaseId)) return refuse();
    if (raw.format !== RGB24_FORMAT) return refuse();
    if (!isPositiveSafeInt(raw.width) || !isPositiveSafeInt(raw.height)) return refuse();
    if (!(raw.bytes instanceof Uint8Array)) return refuse();
    if (!Number.isSafeInteger(raw.byteLength)) return refuse();
    if (raw.byteLength !== raw.bytes.byteLength) return refuse();
    if (raw.byteLength !== raw.width * raw.height * RGB24_BYTES_PER_PIXEL) return refuse();
    if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) return refuse();
    if (raw.sha256 === NULL_DIGEST) return refuse();
    if (raw.pixelSpec === null || typeof raw.pixelSpec !== 'object') return refuse();
    if (raw.frameGeneration <= entry.admittedFloor) return refuse();
    const binding = bindings.get(entry.surfaceId);
    if (!binding) return refuse();
    // First accepted delivery pins the stream identity, before the async
    // digest: a racing second delivery cannot hijack the binding.
    if (!entry.pinned) {
      entry.principal = raw.principal;
      entry.epoch = raw.epoch;
      entry.deliveryGeneration = raw.surfaceGeneration;
      entry.pinned = true;
    }
    entry.admittedFloor = raw.frameGeneration;
    return { ok: /** @type {const} */ (true) };
  }

  /**
   * True when the record may still paint: live stream, current entry, tile
   * still bound, scheduler still reachable.
   * @param {any} entry
   * @returns {boolean}
   */
  function canPaint(entry) {
    if (disposed || entry.disposed) return false;
    if (streams.get(entry.surfaceId) !== entry) return false;
    return bindings.has(entry.surfaceId);
  }

  /**
   * Register the surface on first sha-verified delivery, applying the
   * identity pinned at admit time. The router seeds an eligible presentation
   * state (mounted tile, frame-sized box); the wall refines it through
   * foldSurface/updateSurfaceState afterwards.
   * @param {any} entry
   * @param {any} raw Sha-verified delivery.
   * @returns {{ ok: true } | { ok: false, outcome: string }}
   */
  function ensureRegistered(entry, raw) {
    if (entry.registered) return { ok: /** @type {const} */ (true) };
    const binding = bindings.get(entry.surfaceId);
    if (!binding) return { ok: /** @type {const} */ (false), outcome: FRAME_OUTCOMES.SURFACE_DESTROYED };
    entry.principal = raw.principal;
    entry.epoch = raw.epoch;
    entry.pinned = true;
    /** @type {any} */
    let result = null;
    try {
      result = binding.scheduler.registerSurface({
        surfaceId: entry.surfaceId,
        surfaceGeneration: entry.deliveryGeneration,
        principal: entry.principal,
        epoch: entry.epoch,
        state: {
          panelOpen: true,
          panelSelected: true,
          folded: false,
          width: raw.width,
          height: raw.height,
          x: 0,
          y: 0,
          viewportIntersecting: true,
          windowPresentationAllowed: true,
          contextLost: false,
        },
      });
    } catch {
      return { ok: /** @type {const} */ (false), outcome: FRAME_OUTCOMES.REFUSED };
    }
    if (result?.ok === true) {
      entry.registered = true;
      emitRegistered({ surfaceId: entry.surfaceId, surfaceGeneration: entry.deliveryGeneration, epoch: entry.epoch });
      return { ok: /** @type {const} */ (true) };
    }
    if (result?.reason === 'SURFACE_DESTROYED') {
      return { ok: /** @type {const} */ (false), outcome: FRAME_OUTCOMES.SURFACE_DESTROYED };
    }
    return { ok: /** @type {const} */ (false), outcome: FRAME_OUTCOMES.REFUSED };
  }

  /**
   * Map a submitFrame refusal onto the ack vocabulary.
   * @param {unknown} reason
   * @returns {string}
   */
  function mapSubmitRefusal(reason) {
    if (reason === 'FOLDED_DISPLAY_DISABLED') return FRAME_OUTCOMES.FOLD_DRAIN;
    if (reason === 'HIDDEN_SURFACE') return FRAME_OUTCOMES.HIDDEN;
    if (reason === 'CONTEXT_LOST') return FRAME_OUTCOMES.CONTEXT_LOST;
    if (reason === 'SURFACE_DESTROYED') return FRAME_OUTCOMES.SURFACE_DESTROYED;
    return FRAME_OUTCOMES.REFUSED;
  }

  /**
   * Read the presentation witness for one frame generation.
   * @param {SchedulerBinding} scheduler
   * @param {string} surfaceId
   * @param {number} frameGeneration
   * @returns {boolean}
   */
  function witnessedPresent(scheduler, surfaceId, frameGeneration) {
    /** @type {any} */
    let info = null;
    try {
      info = scheduler.getInstrumentation(surfaceId);
    } catch {
      return false;
    }
    return info !== null && typeof info === 'object'
      && info.lastPresentedFrameGen === frameGeneration
      && typeof info.lastPresentedHandle === 'string'
      && info.lastPresentedHandle.length > 0;
  }

  /**
   * Submit one sha-verified record and drive the immediate draw path. The
   * PRESENTED outcome requires the real scheduler witness (last presented
   * generation plus handle); anything else maps honestly below.
   * @param {any} entry
   * @param {any} record
   * @returns {string} One of FRAME_OUTCOMES.
   */
  function submitAndPresent(entry, record) {
    const binding = bindings.get(entry.surfaceId);
    if (!binding) return FRAME_OUTCOMES.SURFACE_DESTROYED;
    const raw = record.raw;
    /** @type {any} */
    let submitted = null;
    try {
      submitted = binding.scheduler.submitFrame({
        surfaceId: entry.surfaceId,
        surfaceGeneration: entry.deliveryGeneration,
        frameGeneration: raw.frameGeneration,
        leaseId: raw.leaseId,
        byteLength: raw.byteLength,
        width: raw.width,
        height: raw.height,
        bytes: raw.bytes,
        principal: entry.principal,
        epoch: entry.epoch,
        sha256: raw.sha256,
      });
    } catch {
      return FRAME_OUTCOMES.REFUSED;
    }
    if (submitted?.ok !== true) return mapSubmitRefusal(submitted?.reason);
    for (let attempt = 0; attempt < PRESENT_ATTEMPTS; attempt += 1) {
      try {
        binding.scheduler.presentSurfaceNow(entry.surfaceId);
      } catch {
        break;
      }
      if (witnessedPresent(binding.scheduler, entry.surfaceId, raw.frameGeneration)) {
        entry.presentedFrames += 1;
        entry.firstPresented = true;
        return FRAME_OUTCOMES.PRESENTED;
      }
    }
    // Submitted but never witnessed: report the scheduler-observed cause.
    /** @type {any} */
    let info = null;
    try {
      info = binding.scheduler.getInstrumentation(entry.surfaceId);
    } catch {
      info = null;
    }
    if (info !== null && typeof info === 'object') {
      if (info.destroyed === true) return FRAME_OUTCOMES.SURFACE_DESTROYED;
      if (info.folded === true) return FRAME_OUTCOMES.FOLD_DRAIN;
      if (info.contextLost === true) return FRAME_OUTCOMES.CONTEXT_LOST;
      if (info.eligible === false) return FRAME_OUTCOMES.HIDDEN;
    }
    return FRAME_OUTCOMES.REFUSED;
  }

  /**
   * Settle one record and retire the stream when the outcome closes it.
   * @param {any} entry
   * @param {any} record
   * @param {string} outcome
   * @returns {void}
   */
  function settleAndMaybeClose(entry, record, outcome) {
    settle(record, outcome);
    if (PORT_CLOSING_OUTCOMES.has(outcome) && !entry.disposed && streams.get(entry.surfaceId) === entry) {
      retireStream(entry, outcome);
    }
  }

  /**
   * Settle a displaced in-flight record: a replaced stream supersedes it,
   * while unbind/dispose destroys its surface. Never paints.
   * @param {any} entry
   * @param {any} record
   * @returns {void}
   */
  function settleDisplaced(entry, record) {
    const replaced = !disposed && streams.has(entry.surfaceId) && streams.get(entry.surfaceId) !== entry;
    settle(record, replaced ? FRAME_OUTCOMES.SUPERSEDED : FRAME_OUTCOMES.SURFACE_DESTROYED);
  }

  /**
   * Verify one record and paint it. Runs serially per stream; a newer
   * arrival marks the in-flight record superseded, and retirement wins over
   * paint: displaced records settle without touching the canvas.
   * @param {any} entry
   * @param {any} record
   * @returns {Promise<void>}
   */
  async function validateAndPaint(entry, record) {
    /** @type {string|null} */
    let digest = null;
    try {
      digest = await digestSha256(record.raw.bytes);
    } catch {
      digest = null;
    }
    if (!canPaint(entry)) {
      settleDisplaced(entry, record);
      return;
    }
    if (record.superseded) {
      settle(record, FRAME_OUTCOMES.SUPERSEDED);
      return;
    }
    if (typeof digest !== 'string' || digest !== record.raw.sha256) {
      settleAndMaybeClose(entry, record, FRAME_OUTCOMES.REFUSED);
      return;
    }
    const ensured = ensureRegistered(entry, record.raw);
    if (ensured.ok !== true) {
      settleAndMaybeClose(entry, record, ensured.outcome);
      return;
    }
    if (!canPaint(entry)) {
      settleDisplaced(entry, record);
      return;
    }
    if (record.superseded) {
      settle(record, FRAME_OUTCOMES.SUPERSEDED);
      return;
    }
    settleAndMaybeClose(entry, record, submitAndPresent(entry, record));
  }

  /**
   * Drive one stream queue newest-first; every skipped record is replaced
   * before paint and acked SUPERSEDED.
   * @param {any} entry
   * @returns {void}
   */
  function pump(entry) {
    if (disposed || entry.disposed || entry.validating) return;
    while (entry.queue.length > 1) {
      const skipped = entry.queue.shift();
      if (skipped && !skipped.settled) settle(skipped, FRAME_OUTCOMES.SUPERSEDED);
    }
    const head = entry.queue.shift();
    if (!head) return;
    entry.validating = true;
    entry.current = head;
    void validateAndPaint(entry, head).then(
      () => { entry.validating = false; entry.current = null; pump(entry); },
      () => { entry.validating = false; entry.current = null; pump(entry); },
    );
  }

  /**
   * @param {any} event
   * @returns {any}
   */
  function unwrapMessage(event) {
    if (event !== null && typeof event === 'object' && 'data' in event) return event.data;
    return event;
  }

  /**
   * Attach the stream port listeners (browser and node-EventEmitter shapes).
   * @param {any} entry
   * @param {any} port
   * @returns {void}
   */
  function attachPort(entry, port) {
    entry.port = port;
    entry.onPortMessage = (/** @type {any} */ event) => {
      if (disposed || entry.disposed || streams.get(entry.surfaceId) !== entry) return;
      const raw = unwrapMessage(event);
      const admitted = admitDelivery(entry, raw);
      if (admitted.ok !== true) return;
      const record = { raw, port, settled: false, superseded: false };
      if (entry.validating && entry.current) entry.current.superseded = true;
      for (const queued of entry.queue.splice(0)) settle(queued, FRAME_OUTCOMES.SUPERSEDED);
      entry.queue.push(record);
      pump(entry);
    };
    entry.onPortClose = () => {
      if (!entry.disposed && streams.get(entry.surfaceId) === entry) retireStream(entry, FRAME_OUTCOMES.SURFACE_DESTROYED);
    };
    const messageListener = entry.onPortMessage;
    const closeListener = entry.onPortClose;
    if (typeof port.addEventListener === 'function') {
      port.addEventListener('message', messageListener);
      try { port.addEventListener('close', closeListener); } catch { /* Close events are optional. */ }
    } else if (typeof port.on === 'function') {
      port.on('message', messageListener);
      try { port.on('close', closeListener); } catch { /* Close events are optional. */ }
    } else {
      port.onmessage = messageListener;
    }
    try { port.start?.(); } catch { /* Start is best-effort. */ }
  }

  /**
   * Accept one window message as a frame-port notice: same origin, closed
   * shape, exactly one usable port. Anything else is ignored (transferred
   * ports are closed so refused streams leak nothing).
   * @param {any} event
   * @returns {void}
   */
  function onWindowMessage(event) {
    if (disposed) return;
    const ports = event?.ports;
    if (event === null || typeof event !== 'object') {
      closePorts(ports);
      return;
    }
    if (event.origin !== ownOrigin || !isFramePortNotice(event.data)) {
      closePorts(ports);
      return;
    }
    if (!Array.isArray(ports) || ports.length !== 1) {
      closePorts(ports);
      return;
    }
    const port = ports[0];
    if (port === null || typeof port !== 'object' || typeof port.postMessage !== 'function') {
      closePorts(ports);
      return;
    }
    const data = /** @type {{ surface_id: string, surface_generation: number }} */ (event.data);
    const existing = streams.get(data.surface_id);
    if (!existing) {
      const entry = {
        surfaceId: data.surface_id,
        streamId: data.surface_generation,
        deliveryGeneration: 0,
        port: null,
        onPortMessage: null,
        onPortClose: null,
        principal: '',
        epoch: 0,
        pinned: false,
        registered: false,
        queue: [],
        current: null,
        validating: false,
        admittedFloor: 0,
        presentedFrames: 0,
        firstPresented: false,
        disposed: false,
      };
      streams.set(data.surface_id, entry);
      attachPort(entry, port);
      return;
    }
    if (data.surface_generation > existing.streamId) {
      retireStream(existing, FRAME_OUTCOMES.SUPERSEDED);
      if (existing.current && !existing.current.settled) existing.current.superseded = true;
      const entry = {
        surfaceId: data.surface_id,
        streamId: data.surface_generation,
        deliveryGeneration: 0,
        port: null,
        onPortMessage: null,
        onPortClose: null,
        principal: '',
        epoch: 0,
        pinned: false,
        registered: false,
        queue: [],
        current: null,
        validating: false,
        admittedFloor: 0,
        presentedFrames: 0,
        firstPresented: false,
        disposed: false,
      };
      streams.set(data.surface_id, entry);
      attachPort(entry, port);
      return;
    }
    // Same or older generation: the live stream stands; the spare port closes.
    closePorts(ports);
  }

  /**
   * Bind a mounted tile: its scheduler paints this surface's deliveries.
   * @param {SurfaceBinding} binding
   * @returns {boolean} False when the binding is unusable.
   */
  function bindSurface(binding) {
    if (disposed) return false;
    if (binding === null || typeof binding !== 'object') return false;
    if (!isNonEmptyString(binding.surfaceId)) return false;
    const scheduler = /** @type {any} */ (binding.scheduler);
    if (scheduler === null || typeof scheduler !== 'object') return false;
    if (typeof scheduler.registerSurface !== 'function'
      || typeof scheduler.submitFrame !== 'function'
      || typeof scheduler.presentSurfaceNow !== 'function'
      || typeof scheduler.getInstrumentation !== 'function') return false;
    const record = {
      scheduler: /** @type {SchedulerBinding} */ (scheduler),
      onRegistered: typeof binding.onRegistered === 'function' ? binding.onRegistered : undefined,
    };
    bindings.set(binding.surfaceId, record);
    const entry = streams.get(binding.surfaceId);
    if (entry && entry.registered && record.onRegistered) {
      try {
        record.onRegistered({ surfaceId: entry.surfaceId, surfaceGeneration: entry.deliveryGeneration, epoch: entry.epoch });
      } catch { /* A tile retry never breaks the bind. */ }
    }
    return true;
  }

  /**
   * Unbind a tile: its stream closes (lost/destroyed) and can never paint
   * again. The scheduler entry is left to the wall lifecycle (never
   * tombstoned here: a remount must be able to re-register).
   * @param {unknown} surfaceId
   * @returns {void}
   */
  function unbindSurface(surfaceId) {
    if (typeof surfaceId !== 'string') return;
    bindings.delete(surfaceId);
    const entry = streams.get(surfaceId);
    if (entry && !entry.disposed) retireStream(entry, FRAME_OUTCOMES.SURFACE_DESTROYED);
  }

  /**
   * Observe scheduler registrations (canvas attach retries, visibility
   * re-sync). Listeners never receive bytes.
   * @param {(notice: { surfaceId: string, surfaceGeneration: number, epoch: number }) => void} listener
   * @returns {() => void}
   */
  function onSurfaceRegistered(listener) {
    if (typeof listener === 'function') registeredListeners.add(listener);
    return () => { registeredListeners.delete(listener); };
  }

  /**
   * Per-surface first-frame-presented witness plus stream state. With no
   * argument, every live stream. Tiles leave Connecting through the
   * scheduler witness this status mirrors (a PRESENTED frame sets the
   * scheduler's last presented handle, which the wall reads).
   * @param {string} [surfaceId]
   * @returns {unknown}
   */
  function getSurfaceStatus(surfaceId) {
    const describe = (/** @type {any} */ entry) => Object.freeze({
      surfaceId: entry.surfaceId,
      surfaceGeneration: entry.streamId,
      bound: bindings.has(entry.surfaceId),
      portOpen: entry.port !== null && !entry.disposed,
      registered: entry.registered === true,
      presentedFrames: entry.presentedFrames,
      firstPresented: entry.firstPresented === true,
    });
    if (surfaceId !== undefined) {
      const entry = typeof surfaceId === 'string' ? streams.get(surfaceId) : undefined;
      return entry ? describe(entry) : null;
    }
    return Object.freeze([...streams.values()].map(describe));
  }

  /**
   * Tear down the router: drop the window listener, close every port, settle
   * queued records as destroyed. In-flight records settle on completion.
   * @returns {void}
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      target.removeEventListener('message', onWindowMessage);
    } catch { /* Dispose never throws. */ }
    for (const entry of [...streams.values()]) retireStream(entry, FRAME_OUTCOMES.SURFACE_DESTROYED);
    bindings.clear();
    registeredListeners.clear();
  }

  target.addEventListener('message', onWindowMessage);

  return Object.freeze({
    bindSurface,
    unbindSurface,
    onSurfaceRegistered,
    getSurfaceStatus,
    dispose,
  });
}

export default installFramePortRouter;



