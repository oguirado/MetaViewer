/**
 * MetaViewer record-state clock model (REC-STATE, pillars P3/P4).
 *
 * Pure JavaScript with JSDoc; zero imports. The host sends `elapsed_ms` only
 * when a capture event arrives (about one event per delivered frame, and the
 * live source delivers about 2 frames per second [MEASURED, operator P8.1
 * log: adapter capture_p50 318-567 ms]), so a readout that only repaints on
 * events stalls and jumps. This module interpolates between events from the
 * last host `elapsed_ms` with a local monotonic clock, never from the wall
 * clock alone and never from a fabricated zero.
 *
 * [TARGET, unit decision] Display tick 1000 ms; a host event whose elapsed is
 * at most 1000 ms behind the interpolated value never rewinds the readout.
 *
 * @module recording/recordingClock
 */

/**
 * Local display tick while a recording is active, in milliseconds.
 * @type {number}
 */
export const MV_ELAPSED_TICK_MS = 1000;

/**
 * A host elapsed that lags the interpolated value by at most this much is
 * treated as jitter: the readout holds instead of stepping backwards.
 * @type {number}
 */
export const MV_ELAPSED_JITTER_MS = 1000;

/**
 * Stable text shown when elapsed is unknown; never a fabricated zero.
 * @type {string}
 */
export const MV_ELAPSED_UNKNOWN = '--:--';

/**
 * Measured live tile rate for the "up to the source rate" copy.
 * [MEASURED, operator P8.1 log: capture_p50 318-567 ms per frame, about 2 fps]
 * @type {string}
 */
export const MV_RECORD_SOURCE_RATE_NOTE = 'Measured on the reference host: the live tile delivered about 2 frames per second (capture 318 to 567 ms per frame).';

/**
 * @typedef {Readonly<{ baseMs: number, atMs: number }>} ElapsedAnchor
 */

/**
 * @param {unknown} value Candidate host elapsed in milliseconds.
 * @returns {boolean} True for a finite, non-negative number.
 */
export function isHostElapsedMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Interpolated elapsed for an anchor at a local time.
 * @param {ElapsedAnchor | null | undefined} anchor Last host sample.
 * @param {number} nowMs Local monotonic time in milliseconds.
 * @returns {number | null} Elapsed in ms, or null when no anchor exists.
 */
export function liveElapsedMs(anchor, nowMs) {
  if (anchor === null || anchor === undefined) return null;
  if (!isHostElapsedMs(anchor.baseMs) || typeof anchor.atMs !== 'number' || !Number.isFinite(nowMs)) return null;
  return anchor.baseMs + Math.max(0, nowMs - anchor.atMs);
}

/**
 * Anchor for a new host sample while recording.
 * @param {ElapsedAnchor | null | undefined} previous Anchor of the same recording, if any.
 * @param {unknown} hostElapsedMs `elapsed_ms` from the host event.
 * @param {number} nowMs Local monotonic time of the event.
 * @returns {ElapsedAnchor | null} New anchor, or null when the host value is unusable.
 */
export function anchorElapsed(previous, hostElapsedMs, nowMs) {
  if (!isHostElapsedMs(hostElapsedMs) || !Number.isFinite(nowMs)) return null;
  const host = /** @type {number} */ (hostElapsedMs);
  const shown = liveElapsedMs(previous, nowMs);
  const lag = shown === null ? 0 : shown - host;
  const baseMs = lag > 0 && lag <= MV_ELAPSED_JITTER_MS ? /** @type {number} */ (shown) : host;
  return Object.freeze({ baseMs, atMs: nowMs });
}

/**
 * Elapsed to render for one capture entry.
 * @param {{ phase?: unknown, elapsedMs?: unknown }} sample Phase and last host elapsed.
 * @param {ElapsedAnchor | null | undefined} anchor Active anchor.
 * @param {number} nowMs Local monotonic time.
 * @returns {number | null} Milliseconds, or null when unknown.
 */
export function displayElapsedMs(sample, anchor, nowMs) {
  if (sample.phase === 'recording') return liveElapsedMs(anchor, nowMs);
  return isHostElapsedMs(sample.elapsedMs) ? /** @type {number} */ (sample.elapsedMs) : null;
}

/**
 * @param {number | null | undefined} ms Elapsed in milliseconds (floored to whole seconds).
 * @returns {string} `mm:ss`, or `--:--` when unknown.
 */
export function formatElapsedClock(ms) {
  if (!isHostElapsedMs(ms)) return MV_ELAPSED_UNKNOWN;
  const total = Math.floor(/** @type {number} */ (ms) / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
