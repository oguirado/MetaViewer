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
 * `closeGate` advances one surface's gate epoch and drops its queued batches,
 * so input buffered before a READ switch, blur, unmount, stream change or
 * control loss is never sent nor replayed.
 * When the facade exposes `onResult`, async input results join the same
 * refusal emitter, deduped per (surface_id, seq) against replies (either
 * order, at most one emission); ok results are silent.
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

/** Closed input-result code set: the host result event codes (the renderer-side INPUT_MODE_READ never arrives). */
export const INPUT_RESULT_CODES = Object.freeze([
  'NOT_IN_CONTROL',
  'SURFACE_UNKNOWN',
  'STALE_STREAM',
  'LIMIT',
  'NESTED_DISPLAY_ONLY',
  'SCHEMA',
  'CORE_UNAVAILABLE',
]);

/** Reply/event dedup memory: the last N (surface_id, seq) keys kept per port. */
export const INPUT_RESULT_DEDUP_LIMIT = 256;

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
 * @typedef {Object} InputResult
 * @property {string} surface_id
 * @property {number} seq
 * @property {boolean} ok
 * @property {string|null} code - Null when ok, else an INPUT_RESULT_CODES code.
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
 * @property {(surfaceId: unknown) => void} closeGate
 * @property {(cb: (refusal: InputRefusal) => void) => () => void} onRefusal
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} PendingItem
 * @property {number} streamId
 * @property {InputEvent} event
 * @property {number} epoch - Gate epoch at queue time; flush sends only current-epoch items.
 */

/**
 * @param {unknown} code
 * @returns {boolean} True only for a closed-set refusal code.
 */
export function isInputRefusalCode(code) {
  return typeof code === 'string' && INPUT_REFUSALS.includes(code);
}

/**
 * @param {unknown} code
 * @returns {boolean} True only for a host result-event code (INPUT_MODE_READ excluded).
 */
export function isInputResultCode(code) {
  return typeof code === 'string' && INPUT_RESULT_CODES.includes(code);
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
      // MVUI26 lane I (input RV10-02): an unsafe sum stays two events, so the
      // batch never carries a SCHEMA-invalid delta. Position still merges to
      // the latest (x, y): pinned by the committed scroll-merge test.
      const dx = (prev.dx ?? 0) + (ev.dx ?? 0);
      const dy = (prev.dy ?? 0) + (ev.dy ?? 0);
      if (Number.isSafeInteger(dx) && Number.isSafeInteger(dy)) {
        prev.dx = dx;
        prev.dy = dy;
        prev.x = ev.x;
        prev.y = ev.y;
        continue;
      }
    }
    merged.push(cloneEvent(ev));
  }
  /** @type {InputEvent[]} */
  const split = [];
  for (const ev of merged) {
    if (ev.kind === 'type' && typeof ev.text === 'string' && ev.text.length > INPUT_LIMITS.MAX_TYPE_CHARS) {
      // MVUI26 lane I (input RV10-03): never slice a surrogate pair across
      // the 1024-unit boundary; back the end off by one unit instead.
      for (let i = 0; i < ev.text.length;) {
        let end = i + INPUT_LIMITS.MAX_TYPE_CHARS;
        if (end < ev.text.length) {
          const tail = ev.text.charCodeAt(end - 1);
          const head = ev.text.charCodeAt(end);
          if (tail >= 0xD800 && tail <= 0xDBFF && head >= 0xDC00 && head <= 0xDFFF) {
            end -= 1;
          }
        }
        split.push({ kind: 'type', text: ev.text.slice(i, end) });
        i = end;
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
 * When the facade exposes `onResult`, the port subscribes exactly once for
 * async input results; facades without it behave exactly as before.
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
    // MVUI26 lane I (input RV10-01): keep the facade receiver; a bare send
    // reference breaks method-style facades that read `this`.
    ? (batch) => /** @type {any} */ (facade).send(batch)
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
  /**
   * MVUI32 lane I (R3-INPUT-1): per-surface gate epoch. Every queued item is
   * tagged with the current epoch; `closeGate` advances it and purges the
   * queue, and flush sends only items still on the current epoch. Missing
   * entries read as epoch 0.
   * @type {Map<string, number>}
   */
  const gateEpochBySurface = new Map();
  /** @type {Set<(refusal: InputRefusal) => void>} */
  const refusalListeners = new Set();
  /** @type {Map<string, boolean>} Seen (surface_id, seq) refusal keys, oldest first. */
  const seenResults = new Map();
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
   * Marks one (surface_id, seq) refusal as emitted, evicting the oldest
   * keys past the bound so the memory never grows without limit.
   *
   * @param {string} key
   * @returns {void}
   */
  function markResultSeen(key) {
    seenResults.set(key, true);
    while (seenResults.size > INPUT_RESULT_DEDUP_LIMIT) {
      const oldest = seenResults.keys().next().value;
      if (oldest === undefined) return;
      seenResults.delete(oldest);
    }
  }

  /**
   * Emits one refusal unless this (surface_id, seq) already emitted one,
   * whether the first copy came from the reply or the result event.
   *
   * @param {string} surfaceId
   * @param {number} seq
   * @param {string} code
   * @returns {void}
   */
  function emitResultRefusal(surfaceId, seq, code) {
    const key = JSON.stringify([surfaceId, seq]);
    if (seenResults.has(key)) return;
    markResultSeen(key);
    emitRefusal(surfaceId, code);
  }

  /**
   * Async input-result handler: shape-checked, never throws. ok results
   * are silent; refused results join the same per-(surface_id, seq) dedup
   * as replies, so a refusal is emitted at most once in either order.
   *
   * @param {any} event
   * @returns {void}
   */
  function handleResult(event) {
    try {
      if (disposed) return;
      if (event === null || typeof event !== 'object' || Array.isArray(event)) return;
      const surfaceId = event.surface_id;
      const seq = event.seq;
      const ok = event.ok;
      if (!isValidSurfaceId(surfaceId)) return;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return;
      if (ok === true) return;
      if (ok !== false) return;
      if (!isInputResultCode(event.code)) return;
      emitResultRefusal(surfaceId, seq, event.code);
    } catch {
      // Malformed or hostile events never break the port.
    }
  }

  /** @type {(() => void) | null} */
  let stopResults = null;
  try {
    if (
      facade !== null
      && (typeof facade === 'object' || typeof facade === 'function')
      && typeof /** @type {any} */ (facade).onResult === 'function'
    ) {
      // MVUI28 lane R: exactly one subscription, as a method call so
      // receiver-style facades keep `this`; a throw means "no results".
      const stop = /** @type {any} */ (facade).onResult(handleResult);
      if (typeof stop === 'function') stopResults = /** @type {() => void} */ (stop);
    }
  } catch {
    stopResults = null;
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
   * @param {number} expectedEpoch - Gate epoch the run was queued under; a
   * re-entrant gate closure mid-run drops the remaining batches silently.
   * @returns {void}
   */
  function flushRun(surfaceId, streamId, events, expectedEpoch) {
    const sender = sendFn;
    if (sender === null) {
      emitRefusal(surfaceId, 'CORE_UNAVAILABLE');
      return;
    }
    const batches = packBatches(surfaceId, streamId, coalesceEvents(events));
    for (const batchEvents of batches) {
      // MVUI32 lane I (R3-INPUT-1): dispatch-time epoch fence — never send
      // a batch queued under a gate epoch that has since closed.
      if ((gateEpochBySurface.get(surfaceId) ?? 0) !== expectedEpoch) return;
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
        // MVUI28 lane R: the seq was consumed, so this refusal joins the
        // per-(surface_id, seq) dedup like any other reply refusal.
        emitResultRefusal(surfaceId, seq, 'CORE_UNAVAILABLE');
        continue;
      }
      Promise.resolve(pending).then(
        /** @param {any} reply @returns {void} */ (reply) => {
          const result = normalizeReply(reply);
          if (!result.ok && typeof result.code === 'string') {
            emitResultRefusal(surfaceId, seq, result.code);
          }
        },
        () => { emitResultRefusal(surfaceId, seq, 'CORE_UNAVAILABLE'); },
      );
    }
  }

  /**
   * @param {string} surfaceId
   * @param {PendingItem[]} items - Already fenced to `expectedEpoch` by flush.
   * @param {number} expectedEpoch
   * @returns {void}
   */
  function flushSurface(surfaceId, items, expectedEpoch) {
    let runStart = 0;
    for (let i = 1; i <= items.length; i += 1) {
      if (i === items.length || items[i].streamId !== items[runStart].streamId) {
        const run = items.slice(runStart, i).map((it) => it.event);
        flushRun(surfaceId, items[runStart].streamId, run, expectedEpoch);
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
      const items = list.splice(0, list.length);
      // MVUI32 lane I (R3-INPUT-1): dispatch-time epoch fence — items queued
      // before the latest gate closure are dropped, never sent nor replayed.
      const expectedEpoch = gateEpochBySurface.get(surfaceId) ?? 0;
      const fresh = items.filter((it) => it.epoch === expectedEpoch);
      if (fresh.length === 0) continue;
      flushSurface(surfaceId, fresh, expectedEpoch);
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
      // MVUI26 lane I (input RV10-06): clone each event (queue parity), so a
      // caller mutation across the send await never reaches the facade.
      /** @type {InputBatch} */
      const batch = {
        schema: INPUT_SCHEMA,
        surface_id: /** @type {string} */ (surfaceId),
        stream_id: /** @type {number} */ (streamId),
        seq,
        events: events.map(cloneEvent),
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
    // MVUI26 lane I (MVVR10-NEW-01): hostile getters refuse as SCHEMA, never
    // throw; the file contract promises queue never throws on input.
    try {
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
      list.push({
        streamId: /** @type {number} */ (streamId),
        event: cloneEvent(event),
        epoch: gateEpochBySurface.get(id) ?? 0,
      });
    } catch {
      emitRefusal(typeof surfaceId === 'string' ? surfaceId : '', 'SCHEMA');
      return;
    }
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
   * Closes the capture gate for one surface: advances its gate epoch and
   * drops every queued batch, silently. Batches queued before the closure
   * are never sent to `sendFn` nor replayed when the gate reopens; batches
   * queued after it dispatch normally. Unknown, invalid or already-closed
   * surfaces and a disposed port are silent no-ops; never throws.
   *
   * @param {unknown} surfaceId
   * @returns {void}
   */
  function closeGate(surfaceId) {
    if (disposed) return;
    if (!isValidSurfaceId(surfaceId)) return;
    const id = /** @type {string} */ (surfaceId);
    const next = (gateEpochBySurface.get(id) ?? 0) + 1;
    if (next > Number.MAX_SAFE_INTEGER) {
      // Unreachable in practice; resetting keeps the fence exact (stale
      // items carry MAX_SAFE_INTEGER, fresh items carry 0).
      gateEpochBySurface.delete(id);
    } else {
      gateEpochBySurface.set(id, next);
    }
    pendingBySurface.delete(id);
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
    gateEpochBySurface.clear();
    refusalListeners.clear();
    seenResults.clear();
    const stop = stopResults;
    stopResults = null;
    if (stop !== null) {
      try {
        stop();
      } catch {
        // Teardown never throws.
      }
    }
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

  return Object.freeze({ available, send, queue, closeGate, onRefusal, dispose });
}
