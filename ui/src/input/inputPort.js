/**
 * @fileoverview Renderer-side human input port for capsule tiles (surface_input/v1).
 *
 * Plain JavaScript with JSDoc; no dependencies, no DOM access, one sibling import (frameMap).
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
 *
 * INPUT-U2 (distillation v2 section 6), decisions marked [TARGET, unit decision]:
 * - Wheel accumulator: a queued scroll that carries the local-only `deltaMode`
 *   (0 pixel, 1 line, 2 page) is converted to pixels (any non-zero mode x19),
 *   accumulated per (surface, axis) and emitted as whole 50 px steps; the
 *   remainder carries over. The emitted wire event holds signed STEP COUNTS in
 *   dx/dy (the wire schema is unchanged: `deltaMode` never reaches the wire).
 *   Scroll events without `deltaMode` keep the legacy caller-defined merge.
 * - release_all: a new closed event kind `{ kind: 'release_all' }`. When a
 *   gate closes (`closeGate`) on a surface that dispatched input since its
 *   last release, one release_all is dispatched immediately under the NEW
 *   epoch (it bypasses the epoch drop and the renderer rate window). It is
 *   key-up only by contract (no press, no lock-key toggles). `closeGate(id,
 *   { release: false })` or the port option `releaseAll: false` suppresses it
 *   (READ switch, tests). A closure raised from inside the facade's own send
 *   is host-driven and never releases. Benign host refusals of a release-only
 *   batch (NOT_IN_CONTROL, INPUT_MODE_READ, STALE_STREAM, SURFACE_UNKNOWN) are
 *   silent; SCHEMA stays loud for unsupported facades.
 *
 * INPUT-COALESCE, decisions marked [TARGET, unit decision]:
 * - Consecutive `type`-only events are held for `TYPE_COALESCE_MS` (40 ms
 *   [TARGET, unit decision], <= 25 type batches/s, well below the 60 batches/s
 *   limit) after a `type` flush and sent as one coalesced `type` event in a
 *   single batch. Non-`type` events (`key`, `click`, `scroll`, `release_all`)
 *   flush pending text before them on the immediate frame to preserve exact
 *   relative order. Closing the gate (`closeGate`) drops and counts pending
 *   events (`droppedCount(surfaceId)`), never sending pending text after
 *   control is gone.
 */

import { containFit, mapClientToFrame } from './frameMap.js';

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

/** Wheel accumulator constants (noVNC core/rfb.js:50-51 [CITED]); step cap is [TARGET, unit decision]. */
export const WHEEL_STEP_PX = 50;
export const WHEEL_LINE_PX = 19;
export const WHEEL_MAX_STEPS_PER_EVENT = 1000;

/** Type-only keystroke coalescing window in ms [TARGET, unit decision]. */
export const TYPE_COALESCE_MS = 40;

/** Host refusals of a release-only batch that carry no operator-facing meaning. */
const BENIGN_RELEASE_REFUSALS = Object.freeze([
  'NOT_IN_CONTROL', 'INPUT_MODE_READ', 'STALE_STREAM', 'SURFACE_UNKNOWN',
]);
/** Refusals proving the host holds no admitted input for the surface. */
const NOT_ADMITTED_REFUSALS = Object.freeze(['NOT_IN_CONTROL', 'INPUT_MODE_READ', 'SURFACE_UNKNOWN']);

/** Scroll events produced by the wheel accumulator (their dx/dy are step counts). */
const WHEEL_STEP_EVENTS = new WeakSet();

/** @type {TextEncoder} */
const textEncoder = new TextEncoder();

/**
 * @typedef {Object} InputEvent
 * @property {string} kind - click | key | type | scroll | release_all.
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
 * @property {boolean} [releaseAll] - false disables the closeGate release_all (default true).
 * @property {number} [typeCoalesceMs] - ms window for holding consecutive type-only events (default TYPE_COALESCE_MS).
 * @property {(cb: (time: number) => void) => unknown} [raf] - frame scheduler.
 * @property {(handle: unknown) => void} [cancelRaf] - frame cancellation.
 * @property {(cb: () => void, ms: number) => unknown} [setTimer] - timer scheduler for type coalescing.
 * @property {(handle: unknown) => void} [clearTimer] - timer cancellation for type coalescing.
 */

/**
 * @typedef {Object} InputPort
 * @property {boolean} available
 * @property {(surfaceId: unknown, streamId: unknown, events: unknown) => Promise<InputSendResult>} send
 * @property {(surfaceId: unknown, streamId: unknown, event: unknown) => void} queue
 * @property {(surfaceId: unknown, options?: { release?: boolean }) => void} closeGate
 * @property {(surfaceId?: unknown) => number} droppedCount
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
/** @type {string[]} */
const RELEASE_KEYS = ['kind'];
/** @type {string[]} Local-only wheel input: scroll plus the DOM deltaMode. */
const WHEEL_INPUT_KEYS = ['kind', 'dx', 'dy', 'x', 'y', 'deltaMode'];

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
  if (kind === 'release_all') {
    return hasOnlyKeys(ev, RELEASE_KEYS);
  }
  return false;
}

/**
 * @param {any} ev
 * @returns {boolean} True when the local scroll input carries a deltaMode key.
 */
function isWheelInput(ev) {
  return ev !== null && typeof ev === 'object' && !Array.isArray(ev)
    && ev.kind === 'scroll' && Object.hasOwn(ev, 'deltaMode');
}

/**
 * Local wheel input check (never a wire shape): scroll plus deltaMode 0|1|2.
 *
 * @param {any} ev
 * @returns {boolean}
 */
export function isValidWheelInput(ev) {
  return hasOnlyKeys(ev, WHEEL_INPUT_KEYS)
    && ev.kind === 'scroll'
    && Number.isSafeInteger(ev.dx)
    && Number.isSafeInteger(ev.dy)
    && isNonNegativeInt(ev.x)
    && isNonNegativeInt(ev.y)
    && (ev.deltaMode === 0 || ev.deltaMode === 1 || ev.deltaMode === 2);
}

/**
 * DOM wheel delta to pixels: pixel mode as is, every other mode (line and
 * page alike) multiplied by 19 (noVNC core/rfb.js:1244-1254 [CITED]).
 *
 * @param {number} delta
 * @param {number} deltaMode
 * @returns {number | null} Pixels, or null for an unsafe or unknown input.
 */
export function wheelDeltaToPixels(delta, deltaMode) {
  if (!Number.isSafeInteger(delta)) return null;
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null;
  const px = deltaMode === 0 ? delta : delta * WHEEL_LINE_PX;
  return Number.isSafeInteger(px) ? px : null;
}

/**
 * Adds pixels to a carried remainder and splits off whole 50 px steps.
 * Sign-preserving: -57 px is -1 step and a -7 px carry.
 *
 * @param {number} carry - Carried pixels (|carry| < 50).
 * @param {number} deltaPx
 * @returns {{ steps: number, carry: number }}
 */
export function accumulateWheel(carry, deltaPx) {
  const total = carry + deltaPx;
  const whole = Math.trunc(total / WHEEL_STEP_PX);
  const rest = total - whole * WHEEL_STEP_PX;
  const steps = Math.max(-WHEEL_MAX_STEPS_PER_EVENT, Math.min(WHEEL_MAX_STEPS_PER_EVENT, whole));
  return { steps: steps === 0 ? 0 : steps, carry: rest === 0 ? 0 : rest };
}

/**
 * Drag-release mapping [TARGET, unit decision; distillation N7]: a press that
 * started inside the frame and is released outside it clamps to the nearest
 * frame pixel, so the release is delivered at the frame edge instead of being
 * dropped as letterbox (a dropped release is a stuck button). Callers use it
 * only for the release of a press armed in-frame; presses stay strict
 * (`mapClientToFrame` -> null in the letterbox).
 *
 * @param {import('./frameMap.js').ClientToFrameInput} input
 * @returns {import('./frameMap.js').FramePoint | null} Null only for invalid geometry.
 */
export function mapClientToFrameClamped(input) {
  if (input === null || typeof input !== 'object') return null;
  /** @type {any} */
  const r = input.rect;
  if (r === null || typeof r !== 'object') return null;
  const fit = containFit(r.width, r.height, /** @type {number} */ (input.frameWidth), /** @type {number} */ (input.frameHeight));
  if (fit === null) return null;
  if (typeof input.clientX !== 'number' || !Number.isFinite(input.clientX)) return null;
  if (typeof input.clientY !== 'number' || !Number.isFinite(input.clientY)) return null;
  const left = r.left + fit.offsetX;
  const top = r.top + fit.offsetY;
  // Half a frame pixel inside the far edge: the mapper's far edge is exclusive.
  const inset = fit.scale / 2;
  const clientX = Math.min(Math.max(input.clientX, left), left + fit.width - inset);
  const clientY = Math.min(Math.max(input.clientY, top), top + fit.height - inset);
  return mapClientToFrame({ ...input, clientX, clientY });
}

/** Pointer default actions the tile must cancel while WRITE is armed (noVNC core/rfb.js:596-601, :1112-1114 [CITED]). */
export const TILE_BLOCKED_DEFAULTS = Object.freeze(['contextmenu', 'auxclick']);

/**
 * @param {unknown} eventType - DOM event type.
 * @param {unknown} writeArmed - True only while human WRITE input is armed.
 * @returns {boolean} True when the tile must call preventDefault (READ leaves the event alone).
 */
export function shouldBlockTileDefault(eventType, writeArmed) {
  return writeArmed === true && typeof eventType === 'string' && TILE_BLOCKED_DEFAULTS.includes(eventType);
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
  const copy = { ...event };
  if (WHEEL_STEP_EVENTS.has(event)) WHEEL_STEP_EVENTS.add(copy);
  return copy;
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
    if (prev !== undefined && prev.kind === 'scroll' && ev.kind === 'scroll'
      && WHEEL_STEP_EVENTS.has(prev) === WHEEL_STEP_EVENTS.has(ev)) {
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
 * @param {() => void} cb
 * @param {number} ms
 * @returns {unknown}
 */
function defaultSetTimer(cb, ms) {
  return setTimeout(cb, ms);
}

/**
 * @param {unknown} handle
 * @returns {void}
 */
function defaultClearTimer(handle) {
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
  const releaseEnabled = options.releaseAll !== false;
  const typeCoalesceMs = typeof options.typeCoalesceMs === 'number'
    && Number.isFinite(options.typeCoalesceMs)
    && options.typeCoalesceMs >= 0
    ? options.typeCoalesceMs
    : TYPE_COALESCE_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  const useCoalesceTimer = options.setTimer !== undefined || options.raf === undefined;

  /** @type {Map<string, number>} */
  const seqBySurface = new Map();
  /** @type {Map<string, number[]>} */
  const stampsBySurface = new Map();
  /** @type {Map<string, PendingItem[]>} */
  const pendingBySurface = new Map();
  /** @type {Map<string, number>} Surface -> timestamp (ms) of the last flushed batch containing type text. */
  const lastTypeFlushBySurface = new Map();
  /** @type {Map<string, unknown>} Surface -> active coalesce timer handle. */
  const coalesceTimerBySurface = new Map();
  /** @type {Map<string, number>} Surface -> count of pending events dropped by closeGate. */
  const droppedBySurface = new Map();
  /**
   * MVUI32 lane I (R3-INPUT-1): per-surface gate epoch. Every queued item is
   * tagged with the current epoch; `closeGate` advances it and purges the
   * queue, and flush sends only items still on the current epoch. Missing
   * entries read as epoch 0.
   * @type {Map<string, number>}
   */
  const gateEpochBySurface = new Map();
  /** @type {Map<string, { streamId: number, cx: number, cy: number }>} Wheel remainders (px) per surface. */
  const wheelCarryBySurface = new Map();
  /** @type {Map<string, number>} Surface -> stream of input dispatched since its last release. */
  const liveStreamBySurface = new Map();
  /** @type {Map<string, boolean>} (surface_id, seq) keys of release-only batches, oldest first. */
  const releaseSeqs = new Map();
  /** Depth of facade send calls on the stack (a closure inside one is host-driven). */
  let sendDepth = 0;
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
    // The host proves it holds no admitted input here: nothing left to release.
    if (NOT_ADMITTED_REFUSALS.includes(code)) liveStreamBySurface.delete(surfaceId);
    if (seenResults.has(key)) return;
    markResultSeen(key);
    if (releaseSeqs.has(key) && BENIGN_RELEASE_REFUSALS.includes(code)) return;
    emitRefusal(surfaceId, code);
  }

  /**
   * @param {InputEvent[]} events
   * @returns {boolean} True when the batch is exactly release_all events.
   */
  function isReleaseOnly(events) {
    return events.length > 0 && events.every((ev) => ev.kind === 'release_all');
  }

  /**
   * Remembers a release-only (surface_id, seq) so benign refusals stay silent.
   *
   * @param {string} surfaceId
   * @param {number} seq
   * @returns {void}
   */
  function markReleaseSeq(surfaceId, seq) {
    releaseSeqs.set(JSON.stringify([surfaceId, seq]), true);
    while (releaseSeqs.size > INPUT_RESULT_DEDUP_LIMIT) {
      const oldest = releaseSeqs.keys().next().value;
      if (oldest === undefined) return;
      releaseSeqs.delete(oldest);
    }
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
      // INPUT-U2: a release-only batch is never dropped by the renderer rate window.
      const releaseOnly = isReleaseOnly(batchEvents);
      if (!releaseOnly && !takeRateSlot(surfaceId, now())) {
        emitRefusal(surfaceId, 'LIMIT');
        continue;
      }
      seqBySurface.set(surfaceId, seq);
      if (releaseOnly) {
        markReleaseSeq(surfaceId, seq);
        liveStreamBySurface.delete(surfaceId);
      } else {
        liveStreamBySurface.set(surfaceId, streamId);
      }
      /** @type {any} */
      let pending;
      sendDepth += 1;
      try {
        pending = sender(batch);
      } catch {
        // MVUI28 lane R: the seq was consumed, so this refusal joins the
        // per-(surface_id, seq) dedup like any other reply refusal.
        emitResultRefusal(surfaceId, seq, 'CORE_UNAVAILABLE');
        continue;
      } finally {
        sendDepth -= 1;
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

  /**
   * @param {string} surfaceId
   * @returns {void}
   */
  function clearSurfaceTimer(surfaceId) {
    const handle = coalesceTimerBySurface.get(surfaceId);
    if (handle === undefined) return;
    coalesceTimerBySurface.delete(surfaceId);
    try {
      clearTimer(handle);
    } catch {
      // Timer cancellation never throws.
    }
  }

  /**
   * @param {string} surfaceId
   * @param {number} remainingMs
   * @returns {void}
   */
  function scheduleSurfaceCoalesce(surfaceId, remainingMs) {
    if (disposed) return;
    if (useCoalesceTimer) {
      if (coalesceTimerBySurface.has(surfaceId)) return;
      const delay = Math.max(1, Math.ceil(remainingMs));
      try {
        const handle = setTimer(() => {
          coalesceTimerBySurface.delete(surfaceId);
          flush();
        }, delay);
        coalesceTimerBySurface.set(surfaceId, handle);
      } catch {
        // Timer failure falls back to next queue/raf.
      }
    } else if (!rafScheduled) {
      rafScheduled = true;
      try {
        rafHandle = raf(flush);
      } catch {
        rafScheduled = false;
        rafHandle = null;
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
      // MVUI32 lane I (R3-INPUT-1): dispatch-time epoch fence — items queued
      // before the latest gate closure are dropped, never sent nor replayed.
      const expectedEpoch = gateEpochBySurface.get(surfaceId) ?? 0;
      const fresh = list.filter((it) => it.epoch === expectedEpoch);
      if (fresh.length === 0) {
        list.length = 0;
        clearSurfaceTimer(surfaceId);
        continue;
      }
      const onlyType = fresh.every((it) => it.event.kind === 'type');
      const lastTypeAt = lastTypeFlushBySurface.get(surfaceId);
      const tNow = now();
      if (onlyType && typeCoalesceMs > 0 && lastTypeAt !== undefined && tNow - lastTypeAt < typeCoalesceMs) {
        if (fresh.length !== list.length) {
          list.splice(0, list.length, ...fresh);
        }
        scheduleSurfaceCoalesce(surfaceId, typeCoalesceMs - (tNow - lastTypeAt));
        continue;
      }
      list.length = 0;
      clearSurfaceTimer(surfaceId);
      if (fresh.some((it) => it.event.kind === 'type')) {
        lastTypeFlushBySurface.set(surfaceId, tNow);
      }
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
      const releaseOnly = isReleaseOnly(batch.events);
      if (!releaseOnly && !takeRateSlot(batch.surface_id, now())) return refused('LIMIT');
      seqBySurface.set(batch.surface_id, seq);
      if (releaseOnly) {
        markReleaseSeq(batch.surface_id, seq);
        liveStreamBySurface.delete(batch.surface_id);
      } else {
        liveStreamBySurface.set(batch.surface_id, batch.stream_id);
      }
      /** @type {any} */
      let reply;
      try {
        /** @type {any} */
        let replyPromise;
        sendDepth += 1;
        try {
          replyPromise = sendFn(batch);
        } finally {
          sendDepth -= 1;
        }
        reply = await replyPromise;
      } catch {
        return refused('CORE_UNAVAILABLE');
      }
      return normalizeReply(reply);
    } catch {
      return refused('CORE_UNAVAILABLE');
    }
  }

  /**
   * Folds one validated wheel input into the per-surface pixel remainders.
   * A remainder from another stream is discarded (stale pixels never leak
   * across streams).
   *
   * @param {string} id
   * @param {number} streamId
   * @param {{ dx: number, dy: number, x: number, y: number, deltaMode: number }} input
   * @returns {InputEvent | null} Step event (dx/dy are step counts), or null below one step.
   */
  function accumulateWheelEvent(id, streamId, input) {
    const pxX = wheelDeltaToPixels(input.dx, input.deltaMode);
    const pxY = wheelDeltaToPixels(input.dy, input.deltaMode);
    if (pxX === null || pxY === null) throw new RangeError('wheel delta not a safe integer');
    let state = wheelCarryBySurface.get(id);
    if (state === undefined || state.streamId !== streamId) {
      state = { streamId, cx: 0, cy: 0 };
      wheelCarryBySurface.set(id, state);
    }
    const ax = accumulateWheel(state.cx, pxX);
    const ay = accumulateWheel(state.cy, pxY);
    state.cx = ax.carry;
    state.cy = ay.carry;
    if (ax.steps === 0 && ay.steps === 0) return null;
    /** @type {InputEvent} */
    const stepEvent = { kind: 'scroll', dx: ax.steps, dy: ay.steps, x: input.x, y: input.y };
    WHEEL_STEP_EVENTS.add(stepEvent);
    return stepEvent;
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
      const wheel = isWheelInput(event);
      if (!isValidSurfaceId(surfaceId) || !isValidStreamId(streamId)
        || !(wheel ? isValidWheelInput(event) : isValidInputEvent(event))) {
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
      /** @type {any} */
      let accepted = event;
      if (wheel) {
        const stepEvent = accumulateWheelEvent(id, /** @type {number} */ (streamId), /** @type {any} */ (event));
        // Sub-step wheel input only grows the carried remainder: nothing to send.
        if (stepEvent === null) return;
        accepted = stepEvent;
      }
      list.push({
        streamId: /** @type {number} */ (streamId),
        event: cloneEvent(accepted),
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
   * INPUT-U2: when the surface dispatched input since its last release (or a
   * release_all was still queued), exactly one release_all is dispatched
   * now under the new epoch, so the drop above never swallows it. The wheel
   * remainder is discarded. `options.release === false` (READ switch) and a
   * closure raised from inside the facade's own send skip the release.
   *
   * @param {unknown} surfaceId
   * @param {{ release?: boolean }} [options]
   * @returns {void}
   */
  function closeGate(surfaceId, options) {
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
    clearSurfaceTimer(id);
    lastTypeFlushBySurface.delete(id);
    const dropped = pendingBySurface.get(id);
    const queuedRelease = dropped?.find((it) => it.event.kind === 'release_all');
    if (dropped !== undefined) {
      const droppedEvents = dropped.filter((it) => it.event.kind !== 'release_all').length;
      if (droppedEvents > 0) {
        droppedBySurface.set(id, (droppedBySurface.get(id) ?? 0) + droppedEvents);
      }
    }
    pendingBySurface.delete(id);
    wheelCarryBySurface.delete(id);
    const live = liveStreamBySurface.get(id);
    liveStreamBySurface.delete(id);
    /** @type {number | undefined} */
    let releaseStream;
    if (queuedRelease !== undefined) {
      releaseStream = queuedRelease.streamId;
    } else if (live !== undefined && releaseEnabled && sendDepth === 0
      && !(options !== null && typeof options === 'object' && options.release === false)) {
      releaseStream = live;
    }
    if (releaseStream === undefined || sendFn === null) return;
    flushRun(id, releaseStream, [{ kind: 'release_all' }], gateEpochBySurface.get(id) ?? 0);
  }

  /**
   * Returns the count of pending input events dropped on gate closure for one
   * surface, or the sum across all surfaces when surfaceId is omitted.
   *
   * @param {unknown} [surfaceId]
   * @returns {number}
   */
  function droppedCount(surfaceId) {
    if (surfaceId === undefined) {
      let total = 0;
      for (const n of droppedBySurface.values()) total += n;
      return total;
    }
    if (!isValidSurfaceId(surfaceId)) return 0;
    return droppedBySurface.get(/** @type {string} */ (surfaceId)) ?? 0;
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
    for (const surfaceId of Array.from(coalesceTimerBySurface.keys())) {
      clearSurfaceTimer(surfaceId);
    }
    pendingBySurface.clear();
    lastTypeFlushBySurface.clear();
    droppedBySurface.clear();
    gateEpochBySurface.clear();
    wheelCarryBySurface.clear();
    liveStreamBySurface.clear();
    releaseSeqs.clear();
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

  return Object.freeze({ available, send, queue, closeGate, droppedCount, onRefusal, dispose });
}
