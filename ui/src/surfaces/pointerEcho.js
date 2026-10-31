/**
 * @fileoverview Local pointer echo for the wall tile: a dot drawn at the last
 * human click so the operator sees the input land before the capsule repaints.
 *
 * [TARGET, unit decision] Design of this module is MetaViewer's own. No reference
 * implementation exists for the hide rule: RustDesk's "1000 ms protection" was
 * dead code giving the controlled-side local user priority (not an echo), and
 * noVNC never hides its local cursor. The rule here is:
 *   - the dot hides when a presented frame carries an `inputTimestampMs`
 *     strictly newer than the echoed click (the frame answers the click);
 *   - otherwise it hides after ECHO_TTL_MS (1000 ms) [TARGET];
 *   - it never draws in the letterbox (shared contain transform);
 *   - it is dropped when the input gate closes (blur, control loss, READ).
 *
 * Plain JavaScript with JSDoc; no DOM access. Timers and the clock are
 * injected so the state machine is deterministic under test.
 * @module surfaces/pointerEcho
 */
import { containFit, mapClientToFrame } from '../input/frameMap.js';

/** Dot lifetime when no newer frame arrives (ms) [TARGET, unit decision]. */
export const ECHO_TTL_MS = 1000;

/** Dot diameter in CSS px [TARGET, unit decision]. */
export const ECHO_DOT_PX = 12;

/**
 * @typedef {Object} EchoPoint
 * @property {number} fx - Frame-space x (sub-pixel, 0 <= fx < frameWidth).
 * @property {number} fy - Frame-space y (sub-pixel, 0 <= fy < frameHeight).
 * @property {number} x - Integer frame pixel (same value mapClientToFrame returns).
 * @property {number} y - Integer frame pixel.
 */

/**
 * Maps a client position to a sub-pixel frame point, or null outside the frame
 * image (letterbox bars, outside the canvas, malformed input). Null-ness is
 * delegated to the production mapper so the echo can never draw where a click
 * would be refused.
 *
 * @param {{ clientX: unknown, clientY: unknown, rect: unknown, frameWidth: unknown, frameHeight: unknown }} input
 * @returns {EchoPoint | null}
 */
export function echoPointFromClient(input) {
  const mapped = mapClientToFrame(input);
  if (mapped === null) return null;
  const rect = /** @type {{ left: number, top: number, width: number, height: number }} */ (input.rect);
  const frameWidth = /** @type {number} */ (input.frameWidth);
  const frameHeight = /** @type {number} */ (input.frameHeight);
  const fit = containFit(rect.width, rect.height, frameWidth, frameHeight);
  if (fit === null) return null;
  const fx = (/** @type {number} */ (input.clientX) - (rect.left + fit.offsetX)) / fit.scale;
  const fy = (/** @type {number} */ (input.clientY) - (rect.top + fit.offsetY)) / fit.scale;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  return {
    fx: Math.max(0, Math.min(frameWidth, fx)),
    fy: Math.max(0, Math.min(frameHeight, fy)),
    x: mapped.x,
    y: mapped.y,
  };
}

/**
 * Display position of a frame point inside the canvas box, in CSS px relative
 * to the box's top-left corner, using the same contain transform as the paint.
 * Null when the box or frame size is invalid or the point lies outside the frame.
 *
 * @param {{ fx: number, fy: number }} point
 * @param {{ width: number, height: number }} box - Canvas box (CSS px).
 * @param {{ width: number, height: number }} frame - Paint-owned frame size (px).
 * @returns {{ left: number, top: number } | null}
 */
export function echoPlacement(point, box, frame) {
  if (point === null || typeof point !== 'object' || box === null || typeof box !== 'object'
    || frame === null || typeof frame !== 'object') return null;
  const { fx, fy } = point;
  if (typeof fx !== 'number' || typeof fy !== 'number' || !Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  const fit = containFit(box.width, box.height, frame.width, frame.height);
  if (fit === null) return null;
  if (fx < 0 || fy < 0 || fx > frame.width || fy > frame.height) return null;
  return { left: fit.offsetX + fx * fit.scale, top: fit.offsetY + fy * fit.scale };
}

/**
 * Originating input timestamp of the latest presented frame, recovered from the
 * scheduler instrumentation (`inputToPresentMs = max(0, presentedAt - inputTs)`
 * and `timingScopes.presentationMs = presentedAt`). Null when the frame carried
 * no input timestamp or the figures are unusable.
 *
 * @param {unknown} instrumentation - `scheduler.getInstrumentation(surfaceId)` result.
 * @returns {number | null}
 */
export function frameInputTimestampMs(instrumentation) {
  if (instrumentation === null || typeof instrumentation !== 'object') return null;
  const info = /** @type {any} */ (instrumentation);
  const sinceInput = info.inputToPresentMs;
  const presentedAt = info.timingScopes?.presentationMs;
  if (typeof sinceInput !== 'number' || !Number.isFinite(sinceInput) || sinceInput < 0) return null;
  if (typeof presentedAt !== 'number' || !Number.isFinite(presentedAt)) return null;
  return presentedAt - sinceInput;
}

/**
 * @typedef {Object} EchoSnapshot
 * @property {number} fx
 * @property {number} fy
 * @property {number} atMs - Clock reading when the click was echoed.
 */

/**
 * @typedef {Object} PointerEchoOptions
 * @property {() => number} [now] - Clock (default Date.now, the scheduler clock domain).
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 * @property {number} [ttlMs] - Lifetime override (positive safe integer).
 * @property {(snapshot: EchoSnapshot | null, cause: string) => void} [onChange]
 */

/**
 * Creates the echo state machine: at most one dot, last click wins.
 *
 * @param {PointerEchoOptions} [options]
 */
export function createPointerEcho(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms);
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (/** @type {any} */ handle) => clearTimeout(handle);
  const ttlMs = Number.isSafeInteger(options.ttlMs) && /** @type {number} */ (options.ttlMs) > 0
    ? /** @type {number} */ (options.ttlMs)
    : ECHO_TTL_MS;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  /** @type {EchoSnapshot | null} */
  let current = null;
  /** @type {unknown} */
  let timer = null;
  let disposed = false;

  function dropTimer() {
    if (timer !== null) {
      try { clearTimer(timer); } catch { /* A broken timer never breaks the tile. */ }
      timer = null;
    }
  }

  /** @param {string} cause */
  function hide(cause) {
    dropTimer();
    if (current === null) return false;
    current = null;
    try { onChange(null, cause); } catch { /* Listener faults never break input. */ }
    return true;
  }

  return Object.freeze({
    /**
     * Echoes one click at a frame point; replaces any dot on screen.
     * @param {{ fx: number, fy: number }} point
     * @returns {boolean} True when the dot is now showing.
     */
    show(point) {
      if (disposed) return false;
      if (point === null || typeof point !== 'object'
        || typeof point.fx !== 'number' || !Number.isFinite(point.fx)
        || typeof point.fy !== 'number' || !Number.isFinite(point.fy)) return false;
      dropTimer();
      current = { fx: point.fx, fy: point.fy, atMs: now() };
      let handle = null;
      try {
        handle = setTimer(() => { timer = null; hide('ttl'); }, ttlMs);
      } catch { /* No timer: a frame or a gate closure still hides the dot. */ }
      if (handle !== null && typeof handle === 'object' && typeof /** @type {any} */ (handle).unref === 'function') {
        try { /** @type {any} */ (handle).unref(); } catch { /* Test loops never hold on the timer. */ }
      }
      timer = handle;
      try { onChange({ ...current }, 'show'); } catch { /* Listener faults never break input. */ }
      return true;
    },
    /**
     * A presented frame arrived: hides the dot only when the frame's input
     * timestamp is strictly newer than the echoed click. Frames without a
     * timestamp (or older ones) never hide it.
     * @param {{ inputTimestampMs?: unknown } | null | undefined} frame
     * @returns {boolean} True when the dot was hidden.
     */
    observeFrame(frame) {
      if (current === null || frame === null || typeof frame !== 'object') return false;
      const stamp = frame.inputTimestampMs;
      if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return false;
      if (!(stamp > current.atMs)) return false;
      return hide('frame');
    },
    /**
     * Drops the dot (gate closure, control loss, surface change).
     * @param {string} [cause]
     * @returns {boolean}
     */
    clear(cause = 'clear') {
      return hide(cause);
    },
    /** @returns {EchoSnapshot | null} */
    current() {
      return current === null ? null : { ...current };
    },
    /** Hides the dot and refuses every later show. */
    dispose() {
      hide('dispose');
      disposed = true;
    },
  });
}
