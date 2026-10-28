/**
 * @fileoverview Renderer-side human input port for capsule tiles (surface_input/v1).
 *
 * Plain JavaScript with JSDoc; no dependencies, no DOM access, no product imports.
 * The port owns the per-surface batch sequence, enforces the closed schema and the
 * contract limits (1..32 events per batch, payload <= 16 KiB, <= 60 batches/s per
 * surface), coalesces type text and scroll deltas per animation frame, and maps
 * every host outcome onto the closed refusal set. It never rejects and never
 * throws on input: malformed local calls resolve to SCHEMA/LIMIT and transport
 * failures resolve to CORE_UNAVAILABLE.
 *
 * `send` is a single fire-and-await batch; `queue` buffers one event for the next
 * animation frame and reports its outcome through `onRefusal` (success is silent).
 */

/** Closed wire schema id. */
export const INPUT_SCHEMA = 'surface_input/v1';

/** Closed refusal set, exactly as the contract. */
export const INPUT_REFUSALS = Object.freeze([
  'NOT_IN_CONTROL',
  'INPUT_MODE_READ',
  'SURFACE_UNKNOWN',
  'STALE_STREAM',
  'LIMIT',
  'NESTED_DISPLAY_ONLY',
  'SCHEMA',
  'CORE_UNAVAILABLE',
]);

/** Contract limits [TARGET] plus internal packing headroom. */
export const INPUT_LIMITS = Object.freeze({
  MAX_EVENTS_PER_BATCH: 32,
  MAX_PAYLOAD_BYTES: 16 * 1024,
  MAX_BATCHES_PER_SECOND: 60,
  MAX_TYPE_CHARS: 1024,
  RATE_WINDOW_MS: 1000,
  MAX_PENDING_PER_SURFACE: 1024,
});

/** @type {TextEncoder} */
const textEncoder = new TextEncoder();

/**
 * @typedef {Object} InputEvent
 * @property {string} kind - click | key | type | scroll.
 * @property {string} [text] - type payload.
 * @property {string[]} [keys] - key chord.
 * @property {number} [x] - click/scroll frame x.
 * @property {number} [y] - click/scroll frame y.
 * @property {number} [dx] - scroll delta x.
 * @property {number} [dy] - scroll delta y.
 * @property {string} [button] - click button.
 */

/**
 * @typedef {Object} InputBatch
 * @property {string} schema
 * @property {string} surface_id
 * @property {number} stream_id
 * @property {number} seq
 * @property {InputEvent[]} events
 */

/**
 * @typedef {Object} InputSendResult
 * @property {boolean} ok
 * @property {number} [accepted]
 * @property {string} [code]
 */

/**
 * @typedef {Object} InputRefusal
 * @property {string} surfaceId
 * @property {string} code
 */

/**
 * @typedef {Object} InputPortOptions
 * @property {() => number} [now] - ms clock (default Date.now).
 * @property {(cb: (time: number) => void) => unknown} [raf] - frame scheduler.
 * @property {(handle: unknown) => void} [cancelRaf] - frame cancellation.
 */

/**
 * @typedef {Object} InputPort
 * @property {boolean} available
 * @property {(surfaceId: unknown, streamId: unknown, events: unknown) => Promise<InputSendResult>} send
 * @property {(surfaceId: unknown, streamId: unknown, event: unknown) => void} queue
 * @property {(cb: (refusal: InputRefusal) => void) => () => void} onRefusal
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} PendingItem
 * @property {number} streamId
 * @property {InputEvent} event
 */

/**
 * @param {unknown} code
 * @returns {boolean} True only for a closed-set refusal code.
 */
export function isInputRefusalCode(code) {
  return typeof code === 'string' && INPUT_REFUSALS.includes(code);
}

/**
 * UTF-8 byte length of the JSON batch as sent on the wire.
 *
 * @param {any} batch
 * @returns {number} Byte length, or Infinity when unserializable.
 */
export function inputBatchByteLength(batch) {
  try {
    const json = JSON.stringify(batch);
    if (typeof json !== 'string') return Number.POSITIVE_INFINITY;
    return textEncoder.encode(json).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * @param {any} obj
 * @param {string[]} keys
 * @returns {boolean} True only when obj carries exactly these own keys.
 */
function hasOnlyKeys(obj, keys) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const actual = Object.keys(obj);
  if (actual.length !== keys.length) return false;
  return keys.every((k) => Object.hasOwn(obj, k));
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} surfaceId
 * @returns {boolean}
 */
function isValidSurfaceId(surfaceId) {
  return typeof surfaceId === 'string' && surfaceId.length >= 1 && surfaceId.length <= 256;
}

/**
 * @param {unknown} streamId
 * @returns {boolean} Safe integer generation (>= 0; staleness is a host check).
 */
function isValidStreamId(streamId) {
  return typeof streamId === 'number' && Number.isSafeInteger(streamId) && streamId >= 0;
}

/** @type {string[]} */
const CLICK_KEYS = ['kind', 'x', 'y', 'button'];
/** @type {string[]} */
const KEY_KEYS = ['kind', 'keys'];
/** @type {string[]} */
const TYPE_KEYS = ['kind', 'text'];
/** @type {string[]} */
const SCROLL_KEYS = ['kind', 'dx', 'dy', 'x', 'y'];

/**
 * Closed-schema event check (renderer and host share it; frame bounds stay host-side).
 *
 * @param {any} ev
 * @returns {boolean}
 */
export function isValidInputEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return false;
  const kind = ev.kind;
  if (kind === 'click') {
    return hasOnlyKeys(ev, CLICK_KEYS)
      && isNonNegativeInt(ev.x)
      && isNonNegativeInt(ev.y)
      && (ev.button === 'left' || ev.button === 'middle' || ev.button === 'right');
  }
  if (kind === 'key') {
    if (!hasOnlyKeys(ev, KEY_KEYS) || !Array.isArray(ev.keys)) return false;
    if (ev.keys.length < 1 || ev.keys.length > 8) return false;
    return ev.keys.every(
      /** @param {any} k @returns {boolean} */ (k) => typeof k === 'string' && k.length >= 1 && k.length <= 32,
    );
  }
  if (kind === 'type') {
    return hasOnlyKeys(ev, TYPE_KEYS)
      && typeof ev.text === 'string'
      && ev.text.length >= 1
      && ev.text.length <= INPUT_LIMITS.MAX_TYPE_CHARS;
  }
  if (kind === 'scroll') {
    return hasOnlyKeys(ev, SCROLL_KEYS)
      && Number.isSafeInteger(ev.dx)
      && Number.isSafeInteger(ev.dy)
      && isNonNegativeInt(ev.x)
      && isNonNegativeInt(ev.y);
  }
  return false;
}

/**
 * @param {string} code
 * @returns {InputSendResult}
 */
function refused(code) {
  return { ok: false, code };
}

/**
 * Normalizes a host reply; malformed or unknown replies become CORE_UNAVAILABLE.
 *
 * @param {any} reply
 * @returns {InputSendResult}
 */
function normalizeReply(reply) {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
    return refused('CORE_UNAVAILABLE');
  }
  if (reply.ok === true) {
    if (typeof reply.accepted === 'number' && Number.isSafeInteger(reply.accepted) && reply.accepted >= 0) {
      return { ok: true, accepted: reply.accepted };
    }
    return refused('CORE_UNAVAILABLE');
  }
  if (reply.ok === false && isInputRefusalCode(reply.code)) {
    return refused(reply.code);
  }
  return refused('CORE_UNAVAILABLE');
}

/**
 * @param {any} event Validated event.
 * @returns {InputEvent} Detached copy.
 */
function cloneEvent(event) {
  if (event.kind === 'key' && Array.isArray(event.keys)) {
    return { kind: 'key', keys: event.keys.slice() };
  }
  return { ...event };
}

/**
 * Merges consecutive type/scroll runs; splits type text over 1024 chars.
 *
 * @param {InputEvent[]} events
 * @returns {InputEvent[]}
 */
function coalesceEvents(events) {
  /** @type {InputEvent[]} */
  const merged = [];
  for (const ev of events) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (prev !== undefined && prev.kind === 'type' && ev.kind === 'type') {
      prev.text = `${prev.text ?? ''}${ev.text ?? ''}`;
      continue;
    }
    if (prev !== undefined && prev.kind === 'scroll' && ev.kind === 'scroll') {
      prev.dx = (prev.dx ?? 0) + (ev.dx ?? 0);
      prev.dy = (prev.dy ?? 0) + (ev.dy ?? 0);
      prev.x = ev.x;
      prev.y = ev.y;
      continue;
    }
    merged.push(cloneEvent(ev));
  }
  /** @type {InputEvent[]} */
  const split = [];
  for (const ev of merged) {
    if (ev.kind === 'type' && typeof ev.text === 'string' && ev.text.length > INPUT_LIMITS.MAX_TYPE_CHARS) {
      for (let i = 0; i < ev.text.length; i += INPUT_LIMITS.MAX_TYPE_CHARS) {
        split.push({ kind: 'type', text: ev.text.slice(i, i + INPUT_LIMITS.MAX_TYPE_CHARS) });
      }
    } else {
      split.push(ev);
    }
  }
  return split;
}

/**
 * @param {(time: number) => void} cb
 * @returns {unknown}
 */
function defaultRaf(cb) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(() => { cb(Date.now()); }, 16);
}

/**
 * @param {unknown} handle
 * @returns {void}
 */
function defaultCancelRaf(handle) {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(/** @type {any} */ (handle));
    return;
  }
  clearTimeout(/** @type {any} */ (handle));
}

/**
 * Creates the renderer-side surface_input/v1 port.
 *
 * @param {unknown} facade `window.metaviewer?.input` or undefined.
 * @param {InputPortOptions} [options]
 * @returns {InputPort} Frozen port.
 */
export function createInputPort(facade, options = {}) {
  /** @type {((batch: InputBatch) => Promise<any>) | null} */
  const sendFn = facade !== null
    && (typeof facade === 'object' || typeof facade === 'function')
    && typeof /** @type {any} */ (facade).send === 'function'
    ? /** @type {any} */ (facade).send
    : null;
  const available = sendFn !== null;
  const now = options.now ?? Date.now;
  const raf = options.raf ?? defaultRaf;
  const cancelRaf = options.cancelRaf ?? defaultCancelRaf;

  /** @type {Map<string, number>} */
  const seqBySurface = new Map();
  /** @type {Map<string, number[]>} */
  const stampsBySurface = new Map();
  /** @type {Map<string, PendingItem[]>} */
  const pendingBySurface = new Map();
  /** @type {Set<(refusal: InputRefusal) => void>} */
  const refusalListeners = new Set();
  let disposed = false;
  let rafScheduled = false;
  /** @type {unknown} */
  let rafHandle = null;

  /**
   * @param {string} surfaceId
   * @param {string} code
   * @returns {void}
   */
  function emitRefusal(surfaceId, code) {
    if (refusalListeners.size === 0) return;
    const refusal = { surfaceId, code };
    for (const cb of Array.from(refusalListeners)) {
      try {
        cb(refusal);
      } catch {
        // One bad listener never breaks the port or its siblings.
      }
    }
  }

  /**
   * Sliding 1000 ms window: at most 60 sent batches per surface.
   *
   * @param {string} surfaceId
   * @param {number} t
   * @returns {boolean} True when a slot was taken.
   */
  function takeRateSlot(surfaceId, t) {
    let stamps = stampsBySurface.get(surfaceId);
    if (stamps === undefined) {
      stamps = [];
      stampsBySurface.set(surfaceId, stamps);
    }
    const floor = t - INPUT_LIMITS.RATE_WINDOW_MS;
    let kept = 0;
    for (let i = 0; i < stamps.length; i += 1) {
      if (stamps[i] > floor) {
        stamps[kept] = stamps[i];
        kept += 1;
      }
    }
    stamps.length = kept;
    if (stamps.length >= INPUT_LIMITS.MAX_BATCHES_PER_SECOND) return false;
    stamps.push(t);
    return true;
  }

  /**
   * Packs one stream run into <= 32-event, <= 16 KiB batches (order kept).
   * Single events that alone exceed the budget are dropped with LIMIT.
   *
   * @param {string} surfaceId
   * @param {number} streamId
   * @param {InputEvent[]} events
   * @returns {InputEvent[][]}
   */
  function packBatches(surfaceId, streamId, events) {
    /** @type {InputEvent[][]} */
    const batches = [];
    /** @type {InputEvent[]} */
    let current = [];
    // Headroom keeps the seq digits from ever pushing a packed batch over 16 KiB.
    const budget = INPUT_LIMITS.MAX_PAYLOAD_BYTES - 64;
    const measure = /** @param {InputEvent[]} list @returns {number} */ (list) => inputBatchByteLength({
      schema: INPUT_SCHEMA, surface_id: surfaceId, stream_id: streamId, seq: 1, events: list,
    });
    for (const ev of events) {
      current.push(ev);
      const overCount = current.length > INPUT_LIMITS.MAX_EVENTS_PER_BATCH;
      const overSize = !overCount && measure(current) > budget;
      if (!overCount && !overSize) continue;
      current.pop();
      if (current.length === 0) {
        emitRefusal(surfaceId, 'LIMIT');
        continue;
      }
      batches.push(current);
      current = [ev];
      if (measure(current) > budget) {
        current = [];
        emitRefusal(surfaceId, 'LIMIT');
      }
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  /**
   * @param {string} surfaceId
   * @param {number} streamId
   * @param {InputEvent[]} events
   * @returns {void}
   */
  function flushRun(surfaceId, streamId, events) {
    const sender = sendFn;
    if (sender === null) {
      emitRefusal(surfaceId, 'CORE_UNAVAILABLE');
      return;
    }
    const batches = packBatches(surfaceId, streamId, coalesceEvents(events));
    for (const batchEvents of batches) {
      const seq = (seqBySurface.get(surfaceId) ?? 0) + 1;
      /** @type {InputBatch} */
      const batch = {
        schema: INPUT_SCHEMA, surface_id: surfaceId, stream_id: streamId, seq, events: batchEvents,
      };
      if (inputBatchByteLength(batch) > INPUT_LIMITS.MAX_PAYLOAD_BYTES) {
        emitRefusal(surfaceId, 'LIMIT');
        continue;
      }
      if (!takeRateSlot(surfaceId, now())) {
        emitRefusal(surfaceId, 'LIMIT');
        continue;
      }
      seqBySurface.set(surfaceId, seq);
      /** @type {any} */
      let pending;
      try {
        pending = sender(batch);
      } catch {
        emitRefusal(surfaceId, 'CORE_UNAVAILABLE');
        continue;
      }
      Promise.resolve(pending).then(
        /** @param {any} reply @returns {void} */ (reply) => {
          const result = normalizeReply(reply);
          if (!result.ok && typeof result.code === 'string') emitRefusal(surfaceId, result.code);
        },
        () => { emitRefusal(surfaceId, 'CORE_UNAVAILABLE'); },
      );
    }
  }

  /**
   * @param {string} surfaceId
   * @param {PendingItem[]} items
   * @returns {void}
   */
  function flushSurface(surfaceId, items) {
    let runStart = 0;
    for (let i = 1; i <= items.length; i += 1) {
      if (i === items.length || items[i].streamId !== items[runStart].streamId) {
        const run = items.slice(runStart, i).map((it) => it.event);
        flushRun(surfaceId, items[runStart].streamId, run);
        runStart = i;
      }
    }
  }

  /** @returns {void} */
  function flush() {
    rafScheduled = false;
    rafHandle = null;
    if (disposed) return;
    for (const [surfaceId, list] of pendingBySurface) {
      if (list.length === 0) continue;
      flushSurface(surfaceId, list.splice(0, list.length));
    }
  }

  /**
   * Sends one batch now; never rejects.
   *
   * @param {unknown} surfaceId
   * @param {unknown} streamId
   * @param {unknown} events
   * @returns {Promise<InputSendResult>}
   */
  async function send(surfaceId, streamId, events) {
    try {
      if (disposed || sendFn === null) return refused('CORE_UNAVAILABLE');
      if (!isValidSurfaceId(surfaceId) || !isValidStreamId(streamId) || !Array.isArray(events)) {
        return refused('SCHEMA');
      }
      if (events.length < 1 || events.length > INPUT_LIMITS.MAX_EVENTS_PER_BATCH) return refused('SCHEMA');
      for (const ev of events) {
        if (!isValidInputEvent(ev)) return refused('SCHEMA');
      }
      const seq = (seqBySurface.get(/** @type {string} */ (surfaceId)) ?? 0) + 1;
      /** @type {InputBatch} */
      const batch = {
        schema: INPUT_SCHEMA,
        surface_id: /** @type {string} */ (surfaceId),
        stream_id: /** @type {number} */ (streamId),
        seq,
        events: events.slice(),
      };
      if (inputBatchByteLength(batch) > INPUT_LIMITS.MAX_PAYLOAD_BYTES) return refused('LIMIT');
      if (!takeRateSlot(batch.surface_id, now())) return refused('LIMIT');
      seqBySurface.set(batch.surface_id, seq);
      /** @type {any} */
      let reply;
      try {
        reply = await sendFn(batch);
      } catch {
        return refused('CORE_UNAVAILABLE');
      }
      return normalizeReply(reply);
    } catch {
      return refused('CORE_UNAVAILABLE');
    }
  }

  /**
   * Buffers one event for the next animation frame; outcomes via onRefusal.
   *
   * @param {unknown} surfaceId
   * @param {unknown} streamId
   * @param {unknown} event
   * @returns {void}
   */
  function queue(surfaceId, streamId, event) {
    if (disposed) return;
    if (!isValidSurfaceId(surfaceId) || !isValidStreamId(streamId) || !isValidInputEvent(event)) {
      emitRefusal(typeof surfaceId === 'string' ? surfaceId : '', 'SCHEMA');
      return;
    }
    if (sendFn === null) {
      emitRefusal(/** @type {string} */ (surfaceId), 'CORE_UNAVAILABLE');
      return;
    }
    const id = /** @type {string} */ (surfaceId);
    let list = pendingBySurface.get(id);
    if (list === undefined) {
      list = [];
      pendingBySurface.set(id, list);
    }
    if (list.length >= INPUT_LIMITS.MAX_PENDING_PER_SURFACE) {
      emitRefusal(id, 'LIMIT');
      return;
    }
    list.push({ streamId: /** @type {number} */ (streamId), event: cloneEvent(event) });
    if (!rafScheduled) {
      rafScheduled = true;
      try {
        rafHandle = raf(flush);
      } catch {
        rafScheduled = false;
        rafHandle = null;
      }
    }
  }

  /**
   * @param {(refusal: InputRefusal) => void} cb
   * @returns {() => void} Unsubscribe.
   */
  function onRefusal(cb) {
    if (typeof cb !== 'function') return () => {};
    refusalListeners.add(cb);
    return () => { refusalListeners.delete(cb); };
  }

  /** @returns {void} */
  function dispose() {
    if (disposed) return;
    disposed = true;
    pendingBySurface.clear();
    refusalListeners.clear();
    if (rafScheduled) {
      rafScheduled = false;
      try {
        cancelRaf(rafHandle);
      } catch {
        // Teardown never throws.
      }
    }
    rafHandle = null;
  }

  return Object.freeze({ available, send, queue, onRefusal, dispose });
}
