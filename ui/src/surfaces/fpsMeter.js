/**
 * @fileoverview Pure painted-frame rate and capture-duration meter for a tile
 * surface (FPS-INDICATOR / U-DEC-0153).
 *
 * Counts only PAINTED frames (where the canvas is actually drawn) over a
 * sliding window of the last 2000 ms [TARGET, unit decision], and formats the
 * latest `frame_ref.capture_us` in milliseconds. Display snapshot updates are
 * throttled to at most 2 times per second (500 ms interval) so text updates
 * never cost frames.
 *
 * Plain JavaScript with JSDoc; no authored TypeScript.
 * @module surfaces/fpsMeter
 */

/** Sliding window length for painted FPS measurement (ms) [TARGET, unit decision]. */
export const FPS_WINDOW_MS = 2000;

/** Minimum interval between display text refreshes (2 times per second) [TARGET, unit decision]. */
export const FPS_UPDATE_INTERVAL_MS = 500;

/** Placeholder shown when no frame arrived/painted in the sliding window. */
export const FPS_PLACEHOLDER = '—';

/**
 * Default monotonic-capable clock in milliseconds.
 * @returns {number}
 */
function defaultClock() {
  if (typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

/**
 * Normalizes a microsecond capture duration (`frame_ref.capture_us`) to a
 * rounded non-negative integer millisecond value, or null when absent/invalid.
 * @param {unknown} captureUs
 * @returns {number | null}
 */
export function normalizeCaptureMs(captureUs) {
  if (typeof captureUs !== 'number' || !Number.isSafeInteger(captureUs) || captureUs < 0) {
    return null;
  }
  return Math.round(captureUs / 1000);
}

/**
 * Formats a microsecond capture duration (`frame_ref.capture_us`) for the tile
 * footer (`<n> ms`, or `—` when absent).
 * @param {unknown} captureUs
 * @returns {string}
 */
export function formatCaptureUs(captureUs) {
  const ms = normalizeCaptureMs(captureUs);
  return ms === null ? FPS_PLACEHOLDER : `${ms} ms`;
}

/**
 * Extracts `capture_us` from a frame_ref, authority frame notice, or delivery
 * object if present and valid.
 * @param {unknown} record
 * @returns {number | null}
 */
export function extractCaptureUs(record) {
  if (typeof record !== 'object' || record === null) return null;
  const candidate = /** @type {{ capture_us?: unknown, captureUs?: unknown, frame_ref?: { capture_us?: unknown } }} */ (record);
  const direct = candidate.capture_us ?? candidate.captureUs ?? candidate.frame_ref?.capture_us;
  if (typeof direct === 'number' && Number.isSafeInteger(direct) && direct >= 0) {
    return direct;
  }
  return null;
}

/**
 * @typedef {Readonly<{
 *   fps: number | null,
 *   fpsText: string,
 *   fpsAttr: string,
 *   captureMs: number | null,
 *   captureText: string,
 *   captureAttr: string,
 *   paintedCount: number,
 *   windowCount: number,
 * }>} FpsMeterSnapshot
 */

/**
 * Creates a pure sliding-window FPS and capture-duration meter with an injected
 * clock.
 *
 * - `recordPaint(meta)` records one PAINTED frame at `clock()` (and optionally
 *   updates `capture_us` when supplied on `meta` or as a numeric argument).
 * - `recordReceived(meta)` records arrival metadata (`capture_us`) WITHOUT
 *   counting a painted frame, so dropped/skipped frames never inflate FPS.
 * - `recordCaptureUs(captureUs)` updates the latest `capture_us` from
 *   `frame_ref` without counting a painted frame.
 * - `read()` prunes timestamps older than `windowMs` from `clock()` and returns
 *   the live `FpsMeterSnapshot`. When the window has no painted frames (before
 *   the first paint or after a stall > `windowMs`), `fpsText` and `captureText`
 *   both read `—`.
 * - `readThrottled()` returns a snapshot that updates at most once every
 *   `updateIntervalMs` (default 500 ms = 2 times/s), except on the transition
 *   from empty (`—`) to the first painted frame or when `reset()` is called.
 *
 * @param {{
 *   clock?: () => number,
 *   now?: () => number,
 *   windowMs?: number,
 *   updateIntervalMs?: number,
 * }} [options]
 * @returns {Readonly<{
 *   recordPaint: (meta?: unknown) => FpsMeterSnapshot,
 *   recordReceived: (meta?: unknown) => void,
 *   recordCaptureUs: (captureUs: unknown) => void,
 *   read: () => FpsMeterSnapshot,
 *   readThrottled: () => FpsMeterSnapshot,
 *   msUntilNextUpdate: () => number,
 *   msUntilStall: () => number,
 *   reset: () => FpsMeterSnapshot,
 * }>}
 */
export function createFpsMeter(options = {}) {
  const clockFn = typeof options.clock === 'function'
    ? options.clock
    : (typeof options.now === 'function' ? options.now : defaultClock);
  const windowMs = typeof options.windowMs === 'number' && Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : FPS_WINDOW_MS;
  const updateIntervalMs = typeof options.updateIntervalMs === 'number'
    && Number.isFinite(options.updateIntervalMs)
    && options.updateIntervalMs >= 0
    ? options.updateIntervalMs
    : FPS_UPDATE_INTERVAL_MS;

  /** @type {number[]} */
  const paintedTimestamps = [];
  /** @type {number | null} */
  let latestCaptureUs = null;
  let totalPainted = 0;

  /** @type {FpsMeterSnapshot | null} */
  let cachedSnapshot = null;
  /** @type {number | null} */
  let lastSnapshotAtMs = null;

  /**
   * Prunes painted frame timestamps outside the half-open sliding window
   * `(now - windowMs, now]` (with 1e-6 ms tolerance for float steps).
   * @param {number} now
   */
  function prune(now) {
    const cutoff = now - windowMs + 1e-6;
    while (paintedTimestamps.length > 0 && /** @type {number} */ (paintedTimestamps[0]) <= cutoff) {
      paintedTimestamps.shift();
    }
  }

  /**
   * Computes a fresh snapshot at timestamp `now`.
   * @param {number} now
   * @returns {FpsMeterSnapshot}
   */
  function computeSnapshot(now) {
    prune(now);
    const count = paintedTimestamps.length;
    const hasFramesInWindow = count > 0;
    const fps = hasFramesInWindow ? Math.round((count * 1000) / windowMs) : null;
    const fpsText = fps !== null ? String(fps) : FPS_PLACEHOLDER;
    const captureMs = normalizeCaptureMs(latestCaptureUs);
    const captureText = captureMs !== null && (hasFramesInWindow || totalPainted === 0)
      ? `${captureMs} ms`
      : FPS_PLACEHOLDER;
    const captureAttr = captureText === FPS_PLACEHOLDER || captureMs === null
      ? FPS_PLACEHOLDER
      : String(captureMs);
    return Object.freeze({
      fps,
      fpsText,
      fpsAttr: fpsText,
      captureMs: captureText === FPS_PLACEHOLDER ? null : captureMs,
      captureText,
      captureAttr,
      paintedCount: totalPainted,
      windowCount: count,
    });
  }

  /**
   * Updates `latestCaptureUs` if a valid non-negative integer is provided.
   * @param {unknown} input
   */
  function ingestCaptureUs(input) {
    if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0) {
      latestCaptureUs = input;
      return;
    }
    const extracted = extractCaptureUs(input);
    if (extracted !== null) {
      latestCaptureUs = extracted;
    }
  }

  return Object.freeze({
    recordPaint(meta) {
      const now = clockFn();
      ingestCaptureUs(meta);
      paintedTimestamps.push(now);
      totalPainted += 1;
      prune(now);
      if (
        cachedSnapshot === null
        || lastSnapshotAtMs === null
        || now - lastSnapshotAtMs >= updateIntervalMs
      ) {
        cachedSnapshot = computeSnapshot(now);
        lastSnapshotAtMs = now;
      }
      return cachedSnapshot;
    },

    recordReceived(meta) {
      ingestCaptureUs(meta);
    },

    recordCaptureUs(captureUs) {
      ingestCaptureUs(captureUs);
      if (cachedSnapshot !== null && cachedSnapshot.captureAttr === FPS_PLACEHOLDER && latestCaptureUs !== null) {
        const now = clockFn();
        if (lastSnapshotAtMs === null || now - lastSnapshotAtMs >= updateIntervalMs || totalPainted <= 1) {
          cachedSnapshot = computeSnapshot(now);
          lastSnapshotAtMs = now;
        }
      }
    },

    read() {
      const now = clockFn();
      return computeSnapshot(now);
    },

    readThrottled() {
      const now = clockFn();
      if (
        cachedSnapshot === null
        || lastSnapshotAtMs === null
        || now - lastSnapshotAtMs >= updateIntervalMs
      ) {
        cachedSnapshot = computeSnapshot(now);
        lastSnapshotAtMs = now;
      }
      return cachedSnapshot;
    },

    msUntilNextUpdate() {
      if (lastSnapshotAtMs === null) return 0;
      const elapsed = clockFn() - lastSnapshotAtMs;
      return elapsed >= updateIntervalMs ? 0 : Math.max(1, Math.ceil(updateIntervalMs - elapsed));
    },

    msUntilStall() {
      const now = clockFn();
      prune(now);
      if (paintedTimestamps.length === 0) return 0;
      const newest = /** @type {number} */ (paintedTimestamps[paintedTimestamps.length - 1]);
      return Math.max(1, Math.ceil(newest + windowMs - now + 1));
    },

    reset() {
      paintedTimestamps.length = 0;
      latestCaptureUs = null;
      totalPainted = 0;
      cachedSnapshot = null;
      lastSnapshotAtMs = null;
      return computeSnapshot(clockFn());
    },
  });
}
