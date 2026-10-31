/**
 * REC-STATE: reactive elapsed readout that keeps ticking between host
 * capture events. [TARGET, unit decision] A local interval runs only while the
 * phase is `recording`; it is cleared on any other phase and on scope
 * disposal. The clock is injectable (`now`, `setInterval`, `clearInterval`)
 * so tests drive it deterministically; defaults are the platform timers.
 *
 * @module recording/useRecordingElapsed
 */
import { computed, getCurrentScope, onScopeDispose, shallowRef, watch } from 'vue';
import {
  MV_ELAPSED_TICK_MS,
  anchorElapsed,
  displayElapsedMs,
} from './recordingClock.js';

/**
 * @typedef {Object} RecordingClock
 * @property {() => number} [now] Monotonic milliseconds.
 * @property {(callback: () => void, ms: number) => unknown} [setInterval] Timer start.
 * @property {(handle: unknown) => void} [clearInterval] Timer stop.
 * @property {number} [tickMs] Display tick, default MV_ELAPSED_TICK_MS.
 */

/**
 * @param {RecordingClock | null | undefined} clock Optional injected clock.
 * @returns {Required<RecordingClock>} Complete clock.
 */
function resolveClock(clock) {
  const given = clock !== null && typeof clock === 'object' ? clock : {};
  return {
    now: typeof given.now === 'function' ? given.now : () => performance.now(),
    setInterval: typeof given.setInterval === 'function' ? given.setInterval : (cb, ms) => setInterval(cb, ms),
    clearInterval: typeof given.clearInterval === 'function' ? given.clearInterval : (h) => clearInterval(/** @type {any} */ (h)),
    tickMs: typeof given.tickMs === 'number' && given.tickMs > 0 ? given.tickMs : MV_ELAPSED_TICK_MS,
  };
}

/**
 * @param {() => { phase?: unknown, elapsedMs?: unknown }} source Reactive phase and host elapsed.
 * @param {() => RecordingClock | null | undefined} [getClock] Clock accessor, read once.
 * @returns {import('vue').ComputedRef<number | null>} Elapsed in ms, null when unknown.
 */
export function useRecordingElapsed(source, getClock) {
  const clock = resolveClock(typeof getClock === 'function' ? getClock() : null);
  /** @type {import('vue').ShallowRef<import('./recordingClock.js').ElapsedAnchor | null>} */
  const anchor = shallowRef(null);
  const tick = shallowRef(clock.now());
  /** @type {unknown} */
  let handle = null;
  let running = false;

  function stopTimer() {
    if (!running) return;
    running = false;
    clock.clearInterval(handle);
    handle = null;
  }
  function startTimer() {
    if (running) return;
    running = true;
    handle = clock.setInterval(() => { tick.value = clock.now(); }, clock.tickMs);
    const unref = /** @type {{ unref?: () => void } | null} */ (handle)?.unref;
    if (typeof unref === 'function') /** @type {any} */ (handle).unref();
  }

  // Single primitive key so the watcher never walks a reactive object; sync
  // flush stamps the local time at the moment the host event is observed.
  watch(
    () => {
      const sample = source();
      return `${String(sample.phase)}|${String(sample.elapsedMs)}`;
    },
    () => {
      const sample = source();
      const nowMs = clock.now();
      tick.value = nowMs;
      if (sample.phase === 'recording') {
        anchor.value = anchorElapsed(anchor.value, sample.elapsedMs, nowMs);
        startTimer();
      } else {
        anchor.value = null;
        stopTimer();
      }
    },
    { immediate: true, flush: 'sync' },
  );
  if (getCurrentScope()) onScopeDispose(stopTimer);

  return computed(() => displayElapsedMs(source(), anchor.value, tick.value));
}
