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
 * unbindSurface on unmount. MVUI23: deliveries for a live stream that was
 * never registered and whose surface has no binding yet (notice + first
 * frames beat the Vue mount) are HELD, newest-only per stream (replaced
 * ones ack SUPERSEDED), un-acked within a bounded window, then registered
 * + attached + painted as soon as the binding appears. MVUI23C: a held
 * delivery whose window expires unclaimed is sha-verified: a mismatch
 * settles REFUSED and drops it, while a valid delivery settles HIDDEN
 * (frees the host inFlight before its 10 s timeout) but is KEPT as the
 * stream's latest frame; the late binding registers with the kept
 * identity and paints it with no second ack. A newer delivery replaces
 * the kept one. REFUSED stays for genuinely invalid input and for
 * remount-gap deliveries on registered streams.
 * MVUI20: several tiles may bind the same surface (wall + multislot), so
 * bindings form a stack per surface: the most recently bound entry is
 * active. A token unbind removes only its own entry: unbinding an inactive
 * entry never touches the active one, while unbinding the active one
 * restores the previous entry (its attach hook re-fires so its canvas
 * becomes active again and repaints the retained frame). Removing the last
 * entry retires the stream unless the caller keeps it across a bounded
 * remount grace (MVUI22): when no tile rebinds within the grace, the stream
 * retires and pending deliveries settle per contract. The token-less unbind
 * keeps the historical teardown (drop every binding and retire the stream).
 * Plain JavaScript with JSDoc; no product imports, no dependencies; the only
 * timers are one bounded grace timer per kept stream and one bounded hold
 * timer per stream with an unbound delivery.
 * MVUI31: a delivery may carry the host-set utilityVerified marker; on a
 * trusted port event the marker skips the redundant re-hash, otherwise the
 * digest runs exactly as before (malformed markers hash too).
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

/**
 * Utility-verified marker key (MVUI31): the host sets `utilityVerified` to
 * exactly true on deliveries whose digest equality already held at the
 * utility read, so the renderer can skip its redundant re-hash.
 * @type {string}
 */
export const FRAME_DELIVERY_MARKER_KEY = 'utilityVerified';

/** Closed delivery key set with the utility-verified marker. @type {string} */
const DELIVERY_KEYS_WITH_MARKER = ['schema', 'kind', 'correlation', 'principal', 'epoch',
  'surfaceId', 'surfaceGeneration', 'frameGeneration', 'leaseId', 'width',
  'height', 'format', 'byteLength', 'sha256', 'pixelSpec', 'bytes',
  'utilityVerified'].sort().join(',');
const SHA256_RE = /^[0-9a-f]{64}$/;
const NULL_DIGEST = '0'.repeat(64);
const RGB24_FORMAT = 'rgb24';
const RGB24_BYTES_PER_PIXEL = 3;
/** Bounded immediate re-present attempts before a draw-failure refusal. @type {number} */
const PRESENT_ATTEMPTS = 3;

/**
 * Default grace keeping a stream open after its last binding unbinds with
 * keepStream (MVUI22): the App wall/multislot swap remounts in the same Vue
 * flush, far inside this window, while a permanently unmounted surface stops
 * holding its port. Overridable per install for tests.
 * @type {number}
 */
export const KEEP_STREAM_GRACE_MS = 500;

/**
 * Default window a delivery for an unbound surface stays held (un-acked)
 * while the tile mounts (MVUI23): far above mount gaps, well below the
 * host's 10 s ack timeout. Overridable per install for tests.
 * @type {number}
 */
export const PENDING_UNBOUND_MS = 2000;

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
 * @property {unknown} [bindToken] Tile-owned unbind identity (MVUI20): a
 * later unbindSurface carrying this token removes only this entry.
 */

/**
 * @typedef {object} InstallOptions
 * @property {RouterTarget} target Window-like target to listen on.
 * @property {(bytes: Uint8Array) => Promise<string>} [digestSha256] Hex-digest override (tests); defaults to SubtleCrypto.
 * @property {number} [keepStreamGraceMs] Keep-stream grace override in ms (tests); defaults to KEEP_STREAM_GRACE_MS.
 * @property {number} [pendingUnboundMs] Unbound-hold window override in ms (tests); defaults to PENDING_UNBOUND_MS.
 */

/**
 * @typedef {object} FramePortRouter Frozen router handle.
 * @property {(binding: SurfaceBinding) => boolean} bindSurface
 * @property {(surfaceId: unknown, bindToken?: unknown, options?: { keepStream?: boolean }) => void} unbindSurface
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
 * True when the delivery carries a well-formed utility-verified marker. The
 * comparison is strict: any forged or malformed value (1, 'true', {}, ...)
 * counts as absent and the digest runs as before.
 * @param {unknown} raw Delivery under test.
 * @returns {boolean}
 */
function hasUtilityVerifiedMarker(raw) {
  if (raw === null || typeof raw !== 'object') return false;
  return /** @type {Record<string, unknown>} */ (raw).utilityVerified === true;
}

/**
 * True when the record may skip the renderer re-hash: a well-formed marker
 * AND a trusted port event. Trustedness is captured from the UA-set
 * read-only isTrusted flag at receipt, which page-content forgeries cannot
 * set, so a marker replayed through a synthetic event still hashes.
 * @param {{ raw: unknown, trusted?: unknown }} record Delivery record.
 * @returns {boolean}
 */
function isMarkerVerifiedDelivery(record) {
  return record.trusted === true && hasUtilityVerifiedMarker(record.raw);
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
  const graceOption = options?.keepStreamGraceMs;
  const keepStreamGraceMs = typeof graceOption === 'number' && Number.isSafeInteger(graceOption) && graceOption > 0
    ? graceOption : KEEP_STREAM_GRACE_MS;
  const pendingOption = options?.pendingUnboundMs;
  const pendingUnboundMs = typeof pendingOption === 'number' && Number.isSafeInteger(pendingOption) && pendingOption > 0
    ? pendingOption : PENDING_UNBOUND_MS;

  /** @type {Map<string, any>} surfaceId -> stream entry */
  const streams = new Map();
  /** @type {Map<string, Array<{ scheduler: SchedulerBinding, onRegistered?: SurfaceBinding['onRegistered'], bindToken?: unknown }>>} surfaceId -> binding stack, last entry active */
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
    clearKeepStreamGrace(entry);
    clearPendingTimer(entry);
    entry.disposed = true;
    if (streams.get(entry.surfaceId) === entry) streams.delete(entry.surfaceId);
    detachPort(entry);
    for (const queued of entry.queue.splice(0)) settle(queued, outcome);
    if (entry.pending !== null && entry.pending !== undefined) {
      const held = entry.pending;
      entry.pending = null;
      settle(held, outcome);
    }
    if (entry.retained !== null && entry.retained !== undefined) {
      // Already acked HIDDEN at expiry: drop silently, never re-acked.
      entry.retained = null;
    }
  }

  /**
   * Cancel a pending keep-stream grace retire. Every stream retirement path
   * funnels through retireStream, so at most one armed timer per kept stream
   * stays bounded and nothing outlives dispose.
   * @param {any} entry
   * @returns {void}
   */
  function clearKeepStreamGrace(entry) {
    if (entry.graceTimer !== null && entry.graceTimer !== undefined) {
      try { clearTimeout(entry.graceTimer); } catch { /* A dead timer still clears. */ }
      entry.graceTimer = null;
    }
  }

  /**
   * Arm the bounded grace retire after the last binding left with keepStream.
   * A rebind (bindSurface) cancels it; otherwise the stream retires and its
   * queued records settle, while an in-flight record settles when its
   * validation completes (never painted).
   * @param {any} entry
   * @returns {void}
   */
  function armKeepStreamGrace(entry) {
    clearKeepStreamGrace(entry);
    const surfaceId = entry.surfaceId;
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      if (disposed || entry.disposed) return;
      if (streams.get(surfaceId) !== entry) return;
      if (hasBinding(surfaceId)) return;
      retireStream(entry, FRAME_OUTCOMES.SURFACE_DESTROYED);
    }, keepStreamGraceMs);
  }

  /**
   * Cancel a pending unbound-hold expiry. At most one armed timer per stream
   * stays bounded and nothing outlives dispose (retireStream funnels here).
   * @param {any} entry
   * @returns {void}
   */
  function clearPendingTimer(entry) {
    if (entry.pendingTimer !== null && entry.pendingTimer !== undefined) {
      try { clearTimeout(entry.pendingTimer); } catch { /* A dead timer still clears. */ }
      entry.pendingTimer = null;
    }
  }

  /**
   * Arm the bounded unbound-hold window for the currently held delivery. A
   * bind drains the hold; otherwise the delivery is sha-verified off the
   * hot path (MVUI23C): a mismatch settles REFUSED and drops it, while a
   * valid delivery settles HIDDEN (frees the host inFlight before its 10 s
   * timeout) and is KEPT as the stream's latest frame for the late tile.
   * The stream stays open either way.
   * @param {any} entry
   * @returns {void}
   */
  function armPendingTimer(entry) {
    clearPendingTimer(entry);
    const surfaceId = entry.surfaceId;
    entry.pendingTimer = setTimeout(() => {
      entry.pendingTimer = null;
      if (disposed || entry.disposed) return;
      if (streams.get(surfaceId) !== entry) return;
      if (entry.pending === null || entry.pending === undefined) return;
      if (hasBinding(surfaceId)) {
        drainHeldOnBind(entry);
        return;
      }
      const held = entry.pending;
      entry.pending = null;
      entry.expiring = held;
      void verifyHeldDelivery(entry, held);
    }, pendingUnboundMs);
  }

  /**
   * Settle one expired held delivery (MVUI23C): replaced-before-paint acks
   * SUPERSEDED, a sha mismatch acks REFUSED and drops the bytes, and a
   * valid delivery acks HIDDEN but is KEPT (bytes + identity) as the
   * stream's latest frame. A bind that landed during verification paints
   * the kept frame immediately with no second ack.
   * @param {any} entry
   * @param {any} held Taken (un-acked) held record.
   * @returns {Promise<void>}
   */
  async function verifyHeldDelivery(entry, held) {
    const markerVerified = isMarkerVerifiedDelivery(held);
    let digest = null;
    if (!markerVerified) {
      try {
        digest = await digestSha256(held.raw.bytes);
      } catch {
        digest = null;
      }
    }
    if (entry.expiring === held) entry.expiring = null;
    if (disposed || entry.disposed || streams.get(entry.surfaceId) !== entry) {
      settle(held, FRAME_OUTCOMES.SURFACE_DESTROYED);
      return;
    }
    const pendingGen = entry.pending?.raw?.frameGeneration ?? 0;
    if (pendingGen > held.raw.frameGeneration || entry.admittedFloor >= held.raw.frameGeneration) {
      // A newer delivery arrived (or drained) during verification: the
      // expired one was replaced before paint.
      settle(held, FRAME_OUTCOMES.SUPERSEDED);
      return;
    }
    if (!markerVerified && (typeof digest !== 'string' || digest !== held.raw.sha256)) {
      settle(held, FRAME_OUTCOMES.REFUSED);
      return;
    }
    entry.admittedFloor = Math.max(entry.admittedFloor, held.raw.frameGeneration);
    // An older kept frame drops silently: it was already acked at expiry.
    entry.retained = { raw: held.raw, trusted: held.trusted === true };
    settle(held, FRAME_OUTCOMES.HIDDEN);
    if (hasBinding(entry.surfaceId) && !entry.registered) {
      drainRetained(entry);
    }
  }

  /**
   * @param {string} surfaceId
   * @returns {boolean} True when at least one tile binds the surface.
   */
  function hasBinding(surfaceId) {
    return (bindings.get(surfaceId)?.length ?? 0) > 0;
  }

  /**
   * @param {string} surfaceId
   * @returns {{ scheduler: SchedulerBinding } | undefined} Most recently bound entry.
   */
  function activeBinding(surfaceId) {
    const stack = bindings.get(surfaceId);
    return stack !== undefined && stack.length > 0 ? stack[stack.length - 1] : undefined;
  }

  /**
   * @param {{ surfaceId: string, surfaceGeneration: number, epoch: number }} notice
   * @returns {void}
   */
  function emitRegistered(notice) {
    for (const listener of [...registeredListeners]) {
      try { listener(notice); } catch { /* Observers never break the stream. */ }
    }
    for (const binding of [...(bindings.get(notice.surfaceId) ?? [])]) {
      if (binding?.onRegistered) {
        try { binding.onRegistered(notice); } catch { /* A tile retry never breaks the stream. */ }
      }
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
   * Pure shape + stream-identity + floor check shared by the bound admit
   * path and the MVUI23 unbound hold path. The notice stream id is never
   * compared here: the delivery binding (surfaceGeneration) is pinned from
   * the first accepted delivery and required consistent only among
   * deliveries. No side effects (no ack, no pin, no floor advance).
   * @param {any} entry
   * @param {any} raw
   * @returns {boolean} True when the delivery is well-formed for this stream.
   */
  function deliveryShapeOk(entry, raw) {
    if (raw === null || typeof raw !== 'object') return false;
    if (raw.schema !== FRAME_DELIVERY_SCHEMA || raw.kind !== 'frame') return false;
    if (!hasExactKeys(raw, DELIVERY_KEYS) && !hasExactKeys(raw, DELIVERY_KEYS_WITH_MARKER)) return false;
    if (!isNonEmptyString(raw.correlation)) return false;
    if (raw.surfaceId !== entry.surfaceId) return false;
    if (!isPositiveSafeInt(raw.surfaceGeneration)) return false;
    if (!isNonEmptyString(raw.principal) || !isPositiveSafeInt(raw.epoch)) return false;
    if (entry.pinned && (raw.principal !== entry.principal || raw.epoch !== entry.epoch
      || raw.surfaceGeneration !== entry.deliveryGeneration)) return false;
    if (!isPositiveSafeInt(raw.frameGeneration)) return false;
    if (!isNonEmptyString(raw.leaseId)) return false;
    if (raw.format !== RGB24_FORMAT) return false;
    if (!isPositiveSafeInt(raw.width) || !isPositiveSafeInt(raw.height)) return false;
    if (!(raw.bytes instanceof Uint8Array)) return false;
    if (!Number.isSafeInteger(raw.byteLength)) return false;
    if (raw.byteLength !== raw.bytes.byteLength) return false;
    if (raw.byteLength !== raw.width * raw.height * RGB24_BYTES_PER_PIXEL) return false;
    if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) return false;
    if (raw.sha256 === NULL_DIGEST) return false;
    if (raw.pixelSpec === null || typeof raw.pixelSpec !== 'object') return false;
    if (raw.frameGeneration <= entry.admittedFloor) return false;
    return true;
  }

  /**
   * Validate a delivery against the stream binding and the packed-rgb24
   * shape. Pure of scheduler state except the admitted floor, which advances
   * only for accepted records.
   * @param {any} entry
   * @param {any} raw
   * @returns {{ ok: true } | { ok: false }} Refusals ack inside.
   */
  function admitDelivery(entry, raw) {
    const refuse = () => { refuseArrival(entry, raw); return { ok: /** @type {const} */ (false) }; };
    if (!deliveryShapeOk(entry, raw)) return refuse();
    if (!hasBinding(entry.surfaceId)) return refuse();
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
   * Hold a delivery for a never-registered stream whose surface has no
   * binding yet (MVUI23 startup race): newest-only per stream, older held
   * deliveries acked SUPERSEDED immediately, the newest un-acked within the
   * bounded window until bindSurface drains it. Invalid shapes refuse
   * exactly as on the bound path (never held). The admitted floor advances
   * at drain or at a valid expiry, so a held delivery no tile ever claims
   * never blocks its generation. MVUI23C: a newer arrival while a kept
   * frame exists is held in a fresh window; it replaces the kept frame
   * once verified (expiry) or painted (bind). Registered streams keep the
   * gap-refuse path in the caller.
   * @param {any} entry
   * @param {any} raw
   * @param {boolean} [trusted] Port-event trust captured at receipt.
   * @returns {{ ok: true } | { ok: false }} Refusals ack inside.
   */
  function holdDelivery(entry, raw, trusted = false) {
    const refuse = () => { refuseArrival(entry, raw); return { ok: /** @type {const} */ (false) }; };
    if (!deliveryShapeOk(entry, raw)) return refuse();
    if (entry.pending !== null && entry.pending !== undefined
      && raw.frameGeneration <= entry.pending.raw.frameGeneration) return refuse();
    // MVUI23C: a duplicate/older arrival never disturbs the delivery under
    // expiry verification nor the kept frame (explicit while the admitted
    // floor has not advanced past them yet).
    if (entry.expiring !== null && entry.expiring !== undefined
      && raw.frameGeneration <= entry.expiring.raw.frameGeneration) return refuse();
    if (entry.retained !== null && entry.retained !== undefined
      && raw.frameGeneration <= entry.retained.raw.frameGeneration) return refuse();
    if (!entry.pinned) {
      entry.principal = raw.principal;
      entry.epoch = raw.epoch;
      entry.deliveryGeneration = raw.surfaceGeneration;
      entry.pinned = true;
    }
    if (entry.pending !== null && entry.pending !== undefined) {
      clearPendingTimer(entry);
      const replaced = entry.pending;
      entry.pending = null;
      settle(replaced, FRAME_OUTCOMES.SUPERSEDED);
    }
    if (entry.expiring !== null && entry.expiring !== undefined
      && raw.frameGeneration > entry.expiring.raw.frameGeneration) {
      // MVUI26 RV10-01: a newer arrival supersedes the delivery under expiry
      // verification immediately; the later async completion no-ops on the
      // settled guard.
      settle(entry.expiring, FRAME_OUTCOMES.SUPERSEDED);
    }
    entry.pending = { raw, port: entry.port, settled: false, superseded: false, trusted: trusted === true };
    armPendingTimer(entry);
    return { ok: /** @type {const} */ (true) };
  }

  /**
   * Drain the held delivery now that a binding exists: re-admit through the
   * bound path (floor advance, queue, async digest, register + attach +
   * paint). Runs synchronously inside bindSurface.
   * @param {any} entry
   * @returns {void}
   */
  function drainPending(entry) {
    if (entry.pending === null || entry.pending === undefined) return;
    const held = entry.pending;
    entry.pending = null;
    clearPendingTimer(entry);
    if (disposed || entry.disposed || streams.get(entry.surfaceId) !== entry) {
      settle(held, FRAME_OUTCOMES.SURFACE_DESTROYED);
      return;
    }
    const admitted = admitDelivery(entry, held.raw);
    if (admitted.ok !== true) return;
    enqueueRecord(entry, held.raw, held.port, held.trusted === true);
  }

  /**
   * Drain the unbound hold now that a binding exists (MVUI23C): the newest
   * held delivery drains through the bound path while an older kept frame
   * drops silently (already acked HIDDEN at expiry, never re-acked). With
   * no held delivery, the kept frame paints with no second ack.
   * @param {any} entry
   * @returns {void}
   */
  function drainHeldOnBind(entry) {
    if (entry.pending !== null && entry.pending !== undefined) {
      entry.retained = null;
      drainPending(entry);
      return;
    }
    drainRetained(entry);
  }

  /**
   * Paint the kept (already HIDDEN-acked) frame now that a binding exists:
   * register with the kept identity, attach and paint immediately through
   * the shared validate+paint path. The record is settled from birth so no
   * second ack can ever be emitted for it.
   * @param {any} entry
   * @returns {void}
   */
  function drainRetained(entry) {
    if (entry.retained === null || entry.retained === undefined) return;
    const kept = entry.retained;
    entry.retained = null;
    if (disposed || entry.disposed || streams.get(entry.surfaceId) !== entry) return;
    if (!hasBinding(entry.surfaceId)) {
      entry.retained = kept;
      return;
    }
    if (entry.validating && entry.current) {
      // MVUI26 NEW-01: a live record is already painting: the kept frame
      // stays dropped and the queued work is left intact.
      return;
    }
    for (const queued of entry.queue) {
      if (queued.raw.frameGeneration > kept.raw.frameGeneration) {
        // MVUI26 NEW-01: a newer frame is already queued: the older kept
        // frame drops instead of superseding it.
        return;
      }
    }
    const record = { raw: kept.raw, port: entry.port, settled: true, superseded: false, trusted: kept.trusted === true };
    for (const queued of entry.queue.splice(0)) settle(queued, FRAME_OUTCOMES.SUPERSEDED);
    entry.queue.push(record);
    pump(entry);
  }

  /**
   * Enqueue one admitted delivery newest-only: a replaced in-flight record
   * is marked superseded and every queued record settles SUPERSEDED.
   * @param {any} entry
   * @param {any} raw Admitted delivery.
   * @param {any} port Stream port the ack answers on.
   * @param {boolean} [trusted] Port-event trust captured at receipt.
   * @returns {void}
   */
  function enqueueRecord(entry, raw, port, trusted = false) {
    const record = { raw, port, settled: false, superseded: false, trusted: trusted === true };
    if (entry.validating && entry.current) entry.current.superseded = true;
    for (const queued of entry.queue.splice(0)) settle(queued, FRAME_OUTCOMES.SUPERSEDED);
    entry.queue.push(record);
    pump(entry);
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
    return hasBinding(entry.surfaceId);
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
    const binding = activeBinding(entry.surfaceId);
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
    const binding = activeBinding(entry.surfaceId);
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
    const markerVerified = isMarkerVerifiedDelivery(record);
    /** @type {string|null} */
    let digest = null;
    if (!markerVerified) {
      try {
        digest = await digestSha256(record.raw.bytes);
      } catch {
        digest = null;
      }
    }
    if (!canPaint(entry)) {
      settleDisplaced(entry, record);
      return;
    }
    if (record.superseded) {
      settle(record, FRAME_OUTCOMES.SUPERSEDED);
      return;
    }
    if (!markerVerified && (typeof digest !== 'string' || digest !== record.raw.sha256)) {
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
      const trusted = event !== null && typeof event === 'object' && event.isTrusted === true;
      if (!hasBinding(entry.surfaceId) && !entry.registered) {
        holdDelivery(entry, raw, trusted);
        return;
      }
      const admitted = admitDelivery(entry, raw);
      if (admitted.ok !== true) return;
      enqueueRecord(entry, raw, port, trusted);
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
        graceTimer: null,
        pending: null,
        pendingTimer: null,
        retained: null,
        expiring: null,
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
        graceTimer: null,
        pending: null,
        pendingTimer: null,
        retained: null,
        expiring: null,
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
   * Bindings stack per surface; the most recent bind is active. Rebinding
   * the same token moves it to the top instead of duplicating it. A delivery
   * held while the surface was unbound (MVUI23) drains immediately: register
   * + attach + paint without waiting for the next frame. MVUI23C: a delivery
   * kept past its window paints the same way, with no second ack.
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
      bindToken: binding.bindToken ?? undefined,
    };
    const stack = bindings.get(binding.surfaceId) ?? [];
    const again = record.bindToken !== undefined
      ? stack.findIndex((entry) => entry.bindToken === record.bindToken)
      : -1;
    if (again >= 0) stack.splice(again, 1);
    stack.push(record);
    bindings.set(binding.surfaceId, stack);
    const entry = streams.get(binding.surfaceId);
    if (entry !== undefined) clearKeepStreamGrace(entry);
    if (entry && entry.registered && record.onRegistered) {
      try {
        record.onRegistered({ surfaceId: entry.surfaceId, surfaceGeneration: entry.deliveryGeneration, epoch: entry.epoch });
      } catch { /* A tile retry never breaks the bind. */ }
    }
    if (entry !== undefined) drainHeldOnBind(entry);
    return true;
  }

  /**
   * Unbind a tile. With a bind token, only that tile's entry leaves the
   * stack (an unknown token is a no-op): removing an inactive entry never
   * touches the active one, while removing the active one restores the
   * previous entry by re-firing its attach hook with the pinned delivery
   * identity. Removing the last entry retires the stream, unless
   * `options.keepStream` keeps it open across a bounded remount grace: the
   * stream retires when no tile rebinds within the grace (MVUI22). Without a
   * token, every binding drops and the stream retires (lost/destroyed),
   * the historical teardown. The scheduler entry is left to the wall
   * lifecycle (never tombstoned here: a remount must re-register).
   * @param {unknown} surfaceId
   * @param {unknown} [bindToken]
   * @param {{ keepStream?: boolean }} [options]
   * @returns {void}
   */
  function unbindSurface(surfaceId, bindToken, options) {
    if (typeof surfaceId !== 'string') return;
    if (bindToken === undefined || bindToken === null) {
      bindings.delete(surfaceId);
      const entry = streams.get(surfaceId);
      if (entry && !entry.disposed) retireStream(entry, FRAME_OUTCOMES.SURFACE_DESTROYED);
      return;
    }
    const stack = bindings.get(surfaceId);
    if (!stack) return;
    const at = stack.findIndex((entry) => entry.bindToken === bindToken);
    if (at < 0) return;
    const wasActive = at === stack.length - 1;
    stack.splice(at, 1);
    if (stack.length === 0) {
      bindings.delete(surfaceId);
      const entry = streams.get(surfaceId);
      if (entry && !entry.disposed) {
        if (options?.keepStream === true) {
          armKeepStreamGrace(entry);
        } else {
          retireStream(entry, FRAME_OUTCOMES.SURFACE_DESTROYED);
        }
      }
      return;
    }
    if (wasActive) {
      const stream = streams.get(surfaceId);
      const restored = stack[stack.length - 1];
      if (stream?.registered === true && typeof restored?.onRegistered === 'function') {
        try {
          restored.onRegistered({
            surfaceId,
            surfaceGeneration: stream.deliveryGeneration,
            epoch: stream.epoch,
          });
        } catch { /* A tile retry never breaks the unbind. */ }
      }
    }
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
      bound: hasBinding(entry.surfaceId),
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



