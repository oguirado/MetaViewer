<script>
/**
 * @fileoverview Wall tile canvas for one bound surface.
 * Hosts the live canvas element plus a read-only frame/generation/digest
 * witness strip. The `frame` prop is an opaque scheduler handle string;
 * pixel bytes never enter Vue reactivity. Drawing happens only inside a
 * scheduler turn through the injected scheduler; prop arrival never draws.
 * Plain JavaScript with JSDoc; no authored TypeScript.
 * @module surfaces/SurfaceCanvas
 */
</script>
<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  formatFrameStrip,
  mapClientToFrame,
  mapKeyboardEvent,
  normalizeSurfaceState,
  resolveSurfaceDimensions,
  shouldEvictSchedulerEntry,
  surfaceCanvasAccessibleName,
  surfaceCanvasAnchor,
  surfaceCanvasDomId,
  surfaceInputAccessibleName,
  surfaceInputFocusAnchor,
  surfaceLostBadgeAccessibleName,
  surfaceLostBadgeAnchor,
} from './tileScheduler.js';

const props = defineProps({
  surfaceId: { type: String, required: true },
  generation: { type: [Number, String], default: '' },
  epoch: { type: [Number, String], default: '' },
  frame: { type: String, default: '' },
  digest: { type: String, default: '' },
  state: { type: String, default: 'empty' },
  frameWidth: { type: Number, default: 0 },
  frameHeight: { type: Number, default: 0 },
  // MVUI25 lane C: true only while this surface is human-controlled AND the
  // app input mode is WRITE (computed by App.vue). Gates the focusable
  // canvas, the input capture handlers, and the strip READ-ONLY label.
  inputEnabled: { type: Boolean, default: false },
  // [TARGET, unit decision] Desktop windows have no scroll CLI action.
  scrollEnabled: { type: Boolean, default: true },
  // MVUI25 lane C: frame stream id the tile is bound to (the same value the
  // frame router uses); forwarded verbatim on every queued input event.
  streamId: { type: Number, default: 0 },
  // FPS-INDICATOR (U-DEC-0153): optional latest frame_ref.capture_us (or a
  // frame_ref object carrying capture_us) for the tile footer CAP readout,
  // plus an optional injected clock (() => number | { now: () => number })
  // for deterministic sliding-window FPS tests.
  captureUs: { type: Number, default: null },
  frameRef: { type: Object, default: null },
  fpsClock: { type: [Function, Object], default: null },
});

const emit = defineEmits(['canvas-ready', 'canvas-released', 'canvas-escape', 'canvas-focus']);

// INPUT-U3: local click echo (see ./pointerEcho.js, [TARGET, unit decision]).
// The SFC keeps its closed static dependency map (vue plus ./tileScheduler.js:
// MVUI25B pins it, and many harnesses compile this file with that closed map),
// so the echo module loads lazily. A failed load (harness without the module,
// chunk error) leaves the tile fully functional with no echo.
/** @type {any} */
let echoModule = null;
/** @type {any} */
let echoController = null;
let unmounted = false;
/** Echo dot position in section CSS px; null while no dot shows. */
const echoDot = ref(/** @type {{ left: number, top: number } | null} */ (null));
/** @type {{ attachCanvas: (args: any) => { ok: boolean, token?: symbol }, detachCanvas: (id: string, token: symbol | null) => void, getInstrumentation: (surfaceId: unknown) => any, evictSurface: (surfaceId: unknown) => unknown, subscribePresentation?: (listener: () => void) => () => void } | null} */
const scheduler = /** @type {any} */ (inject('tileScheduler', null));
/** Live-only frame-port router provided by the entry; null keeps the legacy path. */
const framePortRouter = /** @type {{ bindSurface?: (binding: any) => boolean, unbindSurface?: (surfaceId: unknown, bindToken?: unknown, options?: { keepStream?: boolean }) => void, getSurfaceStatus?: (surfaceId?: string) => unknown } | null} */ (inject('framePortRouter', null));
/** Unverified 20-30 fps DISPLAY port router (injected by test harnesses or loaded lazily on mount). */
const injectedDisplayPortRouter = /** @type {any} */ (inject('displayPortRouter', null));
/** @type {any} */
let activeDisplayRouter = injectedDisplayPortRouter;
const displayBindToken = Symbol('mv-display-binding');
/** @type {import('vue').Ref<'absent' | 'active' | 'stale'>} */
const displayMode = ref(/** @type {'absent' | 'active' | 'stale'} */ ('absent'));
const displayActive = computed(() => displayMode.value === 'active' || displayMode.value === 'stale');
/**
 * MVUI25 lane C: human-input port provided by the entry (`inputPort`); null
 * in hosts without input (fixtures that predate the port, bare mounts).
 * The component never touches `window.metaviewer` directly.
 * @typedef {{ available: boolean, send: (surfaceId: string, streamId: number, events: object[]) => Promise<object>, queue: (surfaceId: string, streamId: number, event: object) => void, onRefusal: (cb: (refusal: object) => void) => () => void, dispose: () => void }} SurfaceInputPort
 */
const inputPort = /** @type {SurfaceInputPort | null} */ (inject('inputPort', null));
/** @type {symbol | null} */
let canvasToken = null;
/**
 * MVUI20: this tile's router binding identity. Wall and multislot tiles
 * share one surfaceId; the token unbind removes only this tile's entry so
 * the other tile keeps painting on the shared stream.
 * @type {symbol}
 */
const bindToken = Symbol('mv-surface-binding');
/**
 * L3-1: delivery identity pinned by the frame-port router notice
 * (surfaceGeneration/epoch from deliveries, e.g. 1/E on the real host).
 * The PROJECTION props (generation/epoch, e.g. 886+/snapshot epoch) never
 * match the scheduler entry the router registered, so the canvas attaches
 * with this identity once known. Null keeps the legacy props path.
 * @type {{ surfaceGeneration: number, epoch: number } | null}
 */
let registeredIdentity = null;

/** @type {{ value: HTMLCanvasElement | null }} */
const canvasRef = ref(/** @type {HTMLCanvasElement | null} */ (null));

// L2-8: retain the last painted witness per surface. The projection
// generation advances before the async port frame arrives; without the
// retain the tile flashes to the waiting placeholder at a different scale.
// Only a surface change resets: generation/epoch gaps keep the last frame.
// Intrinsic canvas size is owned by the scheduler paint path (RV9-02): no
// reactive width/height binding may clear a painted frame.
const retainedFrame = ref(props.frame.length > 0 ? props.frame : '');
const retainedDigest = ref(props.frame.length > 0 && typeof props.digest === 'string' ? props.digest : '');

/**
 * RV9-03: true when a blanked witness must drop the retained frame: the
 * scheduler entry reports destroyed/contextLost (either path), or — legacy
 * path only — the entry is skewed against the projection identity, mirroring
 * App surfaceWitness R1-074 (props carry surface.generation/snapshot epoch).
 * The live path (L3-1) never compares delivery/projection identities, and an
 * unknown entry keeps L2-8 retention.
 * @param {unknown} surfaceId
 * @returns {boolean}
 */
function retainedWitnessStale(surfaceId) {
  if (scheduler === null || typeof scheduler.getInstrumentation !== 'function') return false;
  let info = null;
  try {
    info = scheduler.getInstrumentation(surfaceId);
  } catch {
    return false;
  }
  if (info === null || typeof info !== 'object') return false;
  if (info.destroyed === true || info.contextLost === true) return true;
  if (framePortRouter !== null) return false;
  return info.surfaceGeneration !== props.generation || info.epoch !== props.epoch;
}

watch(() => [props.surfaceId, props.frame, props.digest],
  (current, previous) => {
    if (!Array.isArray(current)) return;
    const [surfaceId, frame, digest] = current;
    if (previous !== undefined && Array.isArray(previous) && surfaceId !== previous[0]) {
      retainedFrame.value = '';
      retainedDigest.value = '';
    }
    if (typeof frame === 'string' && frame.length > 0) {
      retainedFrame.value = frame;
      retainedDigest.value = typeof digest === 'string' ? digest : '';
    } else if (typeof frame === 'string' && frame.length === 0 && retainedFrame.value.length > 0
        && retainedWitnessStale(surfaceId)) {
      // A blank over a dead surface drops the retained witness so no stale
      // frame renders as live; healthy live gaps keep it (L2-8).
      retainedFrame.value = '';
      retainedDigest.value = '';
    }
  });

const effectiveFrame = computed(() => props.frame.length > 0 ? props.frame : retainedFrame.value);
const effectiveDigest = computed(() => props.frame.length > 0 ? props.digest : retainedDigest.value);

// Live display requires a presented witness: a live claim with no frame
// handle degrades to connecting instead of rendering a fake-live tile.
// A retained handle from the same surface keeps the last painted frame.
const resolvedState = computed(() => {
  const normalized = props.state === 'stale' ? 'stale' : normalizeSurfaceState(props.state);
  if (normalized === 'lost') return 'lost';
  if (displayMode.value === 'stale') return 'stale';
  if (displayMode.value === 'active') return 'live';
  if (normalized === 'live' && effectiveFrame.value.length === 0) {
    return 'connecting';
  }
  return normalized;
});
// MVUI30 lane L: a lost tile with a retained witness keeps its last
// presented frame visible (frozen) with the Lost badge; a lost tile without
// a frame falls through to the waiting placeholder Lost branch below.
const showFrozen = computed(() => resolvedState.value === 'lost' && effectiveFrame.value.length > 0);
// The witness strip follows resolved live/stale only (R2-16): a frozen tile
// names its frame through the Lost badge and the panel Frame badge instead.
const showWitness = computed(() => (effectiveFrame.value.length > 0 || displayActive.value)
  && (resolvedState.value === 'live' || resolvedState.value === 'stale'));

/**
 * True while the canvas may take focus: gated in with a provided port that
 * is available. tabindex, aria exposure, the focus ring and the strip
 * READ-ONLY label all key off this; an unavailable port (host without
 * window.metaviewer.input) behaves exactly like no port. MVUI30 lane L: a
 * lost tile is frozen and never takes focus, even when gated in.
 */
const canvasFocusable = computed(() => props.inputEnabled === true && inputPort !== null && inputPort.available === true
  && resolvedState.value !== 'lost');

const strip = computed(() => formatFrameStrip({
  frame: effectiveFrame.value,
  generation: props.generation,
  digest: effectiveDigest.value,
  // MVUI25 lane C: gated-in tiles are WRITE-capable, so the strip must not
  // claim READ-ONLY; every other state renders exactly as before.
  readOnly: canvasFocusable.value ? false : undefined,
}));

const domId = computed(() => surfaceCanvasDomId(props.surfaceId));
const anchor = computed(() => surfaceCanvasAnchor(props.surfaceId));
const surfaceGeometry = computed(() => resolveSurfaceDimensions({
  frameWidth: props.frameWidth,
  frameHeight: props.frameHeight,
}));
const accessibleName = computed(() => surfaceCanvasAccessibleName({
  surfaceId: props.surfaceId,
  state: resolvedState.value,
}));
const stripName = computed(() => {
  const parts = [];
  if (strip.value.frameText.length > 0) parts.push(`Frame ${strip.value.frameText}`);
  if (strip.value.generationText.length > 0) parts.push(`generation ${strip.value.generationText}`);
  if (strip.value.digestText.length > 0) parts.push(`digest ${strip.value.digestText}`);
  if (strip.value.readOnlyText.length > 0) parts.push(strip.value.readOnlyText);
  return parts.length > 0 ? parts.join(', ') : 'Frame state unavailable';
});

// ---------------------------------------------------------------------------
// FPS-INDICATOR (U-DEC-0153): delivered painted FPS over a 2 s sliding window
// [TARGET, unit decision] and latest frame_ref.capture_us in ms. Counts ONLY
// painted frames (where the scheduler actually painted onto the canvas and
// advanced presentCount / lastPresentedHandle), never received or dropped
// frames. Updates the displayed text at most 2 times per second (every 500 ms)
// so footer text refreshes never cost frames.
// ---------------------------------------------------------------------------

const FPS_WINDOW_MS = 2000;
const FPS_UPDATE_INTERVAL_MS = 500;
const FPS_PLACEHOLDER = '—';

/** @returns {number} */
function readFpsClock() {
  const custom = props.fpsClock;
  if (typeof custom === 'function') {
    const val = /** @type {() => number} */ (custom)();
    if (typeof val === 'number' && Number.isFinite(val)) return val;
  }
  if (typeof custom === 'object' && custom !== null && typeof /** @type {{ now?: unknown }} */ (custom).now === 'function') {
    const val = /** @type {{ now: () => number }} */ (custom).now();
    if (typeof val === 'number' && Number.isFinite(val)) return val;
  }
  if (typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

/** @type {number[]} */
const paintedTimes = [];
/** @type {number | null} */
let latestCaptureUs = null;
let totalPaintedFrames = 0;
/** @type {number | null} */
let lastFpsFlushAtMs = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let fpsFlushTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let fpsStallTimer = null;
/** @type {number} */
let lastObservedPresentCount = 0;
/** @type {string} */
let lastObservedPresentedHandle = '';

const fpsDisplayText = ref(FPS_PLACEHOLDER);
const fpsDisplayAttr = ref(FPS_PLACEHOLDER);
const capDisplayText = ref(FPS_PLACEHOLDER);
const capDisplayAttr = ref(FPS_PLACEHOLDER);

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseCaptureUsValue(raw) {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'object' && raw !== null) {
    const rec = /** @type {{ capture_us?: unknown, captureUs?: unknown, frame_ref?: { capture_us?: unknown } }} */ (raw);
    const val = rec.capture_us ?? rec.captureUs ?? rec.frame_ref?.capture_us;
    if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) return val;
  }
  return null;
}

/**
 * @param {number} now
 */
function prunePaintedTimes(now) {
  const cutoff = now - FPS_WINDOW_MS + 1e-6;
  while (paintedTimes.length > 0 && /** @type {number} */ (paintedTimes[0]) <= cutoff) {
    paintedTimes.shift();
  }
}

function clearFpsTimers() {
  if (fpsFlushTimer !== null) {
    try { clearTimeout(fpsFlushTimer); } catch { /* ignore */ }
    fpsFlushTimer = null;
  }
  if (fpsStallTimer !== null) {
    try { clearTimeout(fpsStallTimer); } catch { /* ignore */ }
    fpsStallTimer = null;
  }
}

/**
 * @param {ReturnType<typeof setTimeout> | null} timer
 */
function unrefTimer(timer) {
  if (timer !== null && typeof timer === 'object' && typeof /** @type {{ unref?: unknown }} */ (timer).unref === 'function') {
    try { /** @type {{ unref: () => void }} */ (timer).unref(); } catch { /* ignore */ }
  }
}

/**
 * @param {number} now
 */
function flushFpsDisplay(now) {
  prunePaintedTimes(now);
  lastFpsFlushAtMs = now;
  const count = paintedTimes.length;
  const hasWindowFrames = count > 0;
  const fpsVal = hasWindowFrames ? Math.round((count * 1000) / FPS_WINDOW_MS) : null;
  fpsDisplayText.value = fpsVal !== null ? String(fpsVal) : FPS_PLACEHOLDER;
  fpsDisplayAttr.value = fpsDisplayText.value;
  const capMs = latestCaptureUs !== null ? Math.round(latestCaptureUs / 1000) : null;
  if (capMs !== null && (hasWindowFrames || totalPaintedFrames === 0)) {
    capDisplayText.value = `${capMs} ms`;
    capDisplayAttr.value = String(capMs);
  } else {
    capDisplayText.value = FPS_PLACEHOLDER;
    capDisplayAttr.value = FPS_PLACEHOLDER;
  }
}

function armFpsStallTimer() {
  if (fpsStallTimer !== null) {
    try { clearTimeout(fpsStallTimer); } catch { /* ignore */ }
    fpsStallTimer = null;
  }
  const now = readFpsClock();
  prunePaintedTimes(now);
  if (paintedTimes.length === 0) return;
  const newest = /** @type {number} */ (paintedTimes[paintedTimes.length - 1]);
  const waitMs = Math.max(1, Math.ceil(newest + FPS_WINDOW_MS - now + 1));
  try {
    fpsStallTimer = setTimeout(() => {
      fpsStallTimer = null;
      const at = readFpsClock();
      prunePaintedTimes(at);
      if (paintedTimes.length === 0) {
        flushFpsDisplay(at);
      } else {
        flushFpsDisplay(at);
        armFpsStallTimer();
      }
    }, waitMs);
    unrefTimer(fpsStallTimer);
  } catch {
    fpsStallTimer = null;
  }
}

/**
 * Schedules or performs a throttled footer text update (at most 2 times/s).
 * @param {boolean} [forceImmediate]
 */
function scheduleFpsDisplayUpdate(forceImmediate = false) {
  const now = readFpsClock();
  if (
    forceImmediate
    || lastFpsFlushAtMs === null
    || now - lastFpsFlushAtMs >= FPS_UPDATE_INTERVAL_MS
  ) {
    if (fpsFlushTimer !== null) {
      try { clearTimeout(fpsFlushTimer); } catch { /* ignore */ }
      fpsFlushTimer = null;
    }
    flushFpsDisplay(now);
    return;
  }
  if (fpsFlushTimer === null) {
    const remaining = Math.max(1, Math.ceil(FPS_UPDATE_INTERVAL_MS - (now - lastFpsFlushAtMs)));
    try {
      fpsFlushTimer = setTimeout(() => {
        fpsFlushTimer = null;
        flushFpsDisplay(readFpsClock());
      }, remaining);
      unrefTimer(fpsFlushTimer);
    } catch {
      fpsFlushTimer = null;
    }
  }
}

/**
 * Records one painted frame on this tile's canvas.
 * @param {unknown} [captureHint]
 */
function onFramePainted(captureHint) {
  const cap = parseCaptureUsValue(captureHint);
  if (cap !== null) latestCaptureUs = cap;
  const now = readFpsClock();
  paintedTimes.push(now);
  totalPaintedFrames += 1;
  prunePaintedTimes(now);
  const wasPlaceholder = fpsDisplayAttr.value === FPS_PLACEHOLDER;
  scheduleFpsDisplayUpdate(wasPlaceholder);
  armFpsStallTimer();
}

/**
 * Updates latest capture_us from frame_ref without counting a painted frame.
 * @param {unknown} rawCapture
 */
function onCaptureUsUpdated(rawCapture) {
  const cap = parseCaptureUsValue(rawCapture);
  if (cap === null) return;
  const hadNone = latestCaptureUs === null;
  latestCaptureUs = cap;
  scheduleFpsDisplayUpdate(hadNone && capDisplayAttr.value === FPS_PLACEHOLDER);
}

function resetFpsState() {
  clearFpsTimers();
  paintedTimes.length = 0;
  latestCaptureUs = null;
  totalPaintedFrames = 0;
  lastFpsFlushAtMs = null;
  lastObservedPresentCount = 0;
  lastObservedPresentedHandle = '';
  const initialCap = parseCaptureUsValue(props.captureUs) ?? parseCaptureUsValue(props.frameRef);
  if (initialCap !== null) latestCaptureUs = initialCap;
  flushFpsDisplay(readFpsClock());
}

{
  const initialCap = parseCaptureUsValue(props.captureUs) ?? parseCaptureUsValue(props.frameRef);
  if (initialCap !== null) {
    latestCaptureUs = initialCap;
    flushFpsDisplay(readFpsClock());
  }
}

watch(() => [props.captureUs, props.frameRef], () => {
  const nextCap = parseCaptureUsValue(props.captureUs) ?? parseCaptureUsValue(props.frameRef);
  if (nextCap !== null) onCaptureUsUpdated(nextCap);
});

/**
 * Inspects scheduler instrumentation for this surface and records a painted
 * frame only when the scheduler actually painted onto the canvas
 * (`presentCount` / `lastPresentedHandle` advanced).
 */
function checkSchedulerPresentation() {
  if (scheduler === null || typeof scheduler.getInstrumentation !== 'function') return;
  let info = null;
  try {
    info = scheduler.getInstrumentation(props.surfaceId);
  } catch {
    return;
  }
  if (info === null || typeof info !== 'object' || info.destroyed === true) return;
  const presentCount = typeof info.presentCount === 'number' && Number.isSafeInteger(info.presentCount)
    ? info.presentCount
    : 0;
  const handle = typeof info.lastPresentedHandle === 'string' ? info.lastPresentedHandle : '';
  const capHint = parseCaptureUsValue(info);
  if (presentCount > lastObservedPresentCount) {
    const delta = presentCount - lastObservedPresentCount;
    lastObservedPresentCount = presentCount;
    if (handle.length > 0) lastObservedPresentedHandle = handle;
    for (let i = 0; i < delta; i += 1) {
      onFramePainted(capHint);
    }
  } else if (handle.length > 0 && handle !== lastObservedPresentedHandle && presentCount > 0) {
    lastObservedPresentedHandle = handle;
    onFramePainted(capHint);
  } else if (lastObservedPresentCount > 0) {
    const now = readFpsClock();
    prunePaintedTimes(now);
    if (paintedTimes.length === 0 && fpsDisplayAttr.value !== FPS_PLACEHOLDER) {
      flushFpsDisplay(now);
    } else {
      scheduleFpsDisplayUpdate(false);
    }
  }
}

/** @type {(() => void) | null} */
let stopSchedulerPresentation = null;
if (scheduler !== null && typeof scheduler.subscribePresentation === 'function') {
  try {
    const stop = scheduler.subscribePresentation(checkSchedulerPresentation);
    if (typeof stop === 'function') stopSchedulerPresentation = /** @type {() => void} */ (stop);
  } catch { /* Subscription is best-effort. */ }
}

/** @type {(() => void) | null} */
let stopAuthorityFrames = null;
function subscribeAuthorityCaptureUs() {
  if (stopAuthorityFrames !== null) {
    try { stopAuthorityFrames(); } catch { /* ignore */ }
    stopAuthorityFrames = null;
  }
  const injectedPort = /** @type {{ subscribeFrames?: unknown } | null} */ (inject('framesPort', null));
  const globalAuth = /** @type {{ subscribeFrames?: unknown } | null} */ (
    (/** @type {Record<string, any>} */ (globalThis))?.window?.['metaviewer']?.['authority'] ?? null
  );
  const source = typeof injectedPort?.subscribeFrames === 'function'
    ? injectedPort
    : (typeof globalAuth?.subscribeFrames === 'function' ? globalAuth : null);
  if (source === null) return;
  try {
    const stop = /** @type {(cb: (notice: unknown) => void) => unknown} */ (source.subscribeFrames).call(
      source,
      (notice) => {
        if (typeof notice !== 'object' || notice === null) return;
        const rec = /** @type {{ frame_ref?: { surface_id?: unknown, capture_us?: unknown }, surface?: { surface_id?: unknown } }} */ (notice);
        const sid = rec.frame_ref?.surface_id ?? rec.surface?.surface_id;
        if (sid !== props.surfaceId) return;
        onCaptureUsUpdated(rec.frame_ref?.capture_us);
      },
    );
    if (typeof stop === 'function') stopAuthorityFrames = /** @type {() => void} */ (stop);
  } catch { /* Best-effort subscription. */ }
}
subscribeAuthorityCaptureUs();

// ---------------------------------------------------------------------------
// MVUI25 lane C: human keyboard/pointer capture on the canvas.
// UX-side gating only (the host re-checks): capture and send happen only
// while the tile is gated in (human control + WRITE mode, via inputEnabled)
// AND a provided port is available AND the canvas has focus. Key, pointer-up
// and wheel handlers return before any preventDefault or port call when the
// gate is closed. MVUI27 lane S: pointerdown and click ALWAYS prevent the
// default action — even on a non-focusable canvas — so a tile-canvas press
// never scrolls the page in any mode; a non-focusable canvas still takes no
// focus and queues nothing (no tabindex, aria-hidden canvas).
// ---------------------------------------------------------------------------

/** True while the canvas element holds DOM focus (tracked, never queried). */
const canvasFocused = ref(false);

/** DOM id AND data-semantic-anchor value for the input canvas. */
const inputAnchor = computed(() => surfaceInputFocusAnchor(props.surfaceId));

/** Accessible name for the input canvas while gated in. */
const inputName = computed(() => surfaceInputAccessibleName({ surfaceId: props.surfaceId }));

/** MVUI30 lane L: DOM id AND data-semantic-anchor value for the Lost badge. */
const lostBadgeAnchor = computed(() => surfaceLostBadgeAnchor(props.surfaceId));

/** MVUI30 lane L: accessible name for the Lost badge. */
const lostBadgeName = computed(() => surfaceLostBadgeAccessibleName());

/**
 * @returns {boolean} True only when an input event may be captured and sent:
 * gated in, port provided and available, canvas focused, and never lost
 * (MVUI30 lane L: frozen tiles queue nothing even when focused).
 */
function inputGateOpen() {
  return props.inputEnabled === true && inputPort !== null && inputPort.available === true && canvasFocused.value === true
    && resolvedState.value !== 'lost';
}

/**
 * MVUI32 lane I (R3-INPUT-1): closes the input gate for one surface on the
 * provided port, dropping input queued before the closure so it can never
 * dispatch on a later frame nor replay when the gate reopens. Ports that
 * predate the gate API (fixtures, stub doubles) are skipped silently, and
 * closure never breaks the tile.
 * @param {unknown} surfaceId
 * @returns {void}
 */
function closeInputGate(surfaceId) {
  // INPUT-U3: every gate closure (blur, READ, control loss, lost, stream or
  // surface change, unmount) also drops the local echo dot.
  clearEcho('gate');
  const port = /** @type {any} */ (inputPort);
  if (port === null || typeof port.closeGate !== 'function') return;
  try {
    port.closeGate(typeof surfaceId === 'string' ? surfaceId : props.surfaceId);
  } catch { /* Gate closure never breaks the tile. */ }
}

/**
 * INPUT-U3: loads the echo module and builds the controller. Optional by design:
 * any failure leaves input capture untouched and simply draws no dot.
 */
function loadEcho() {
  import('./pointerEcho.js').then((module) => {
    if (unmounted) return;
    echoModule = module;
    echoController = module.createPointerEcho({
      onChange: (/** @type {any} */ snapshot) => {
        if (snapshot === null) echoDot.value = null;
      },
    });
  }).catch(() => { /* The echo is optional; the tile works without it. */ });
}

/** @param {string} cause */
function clearEcho(cause) {
  echoDot.value = null;
  if (echoController !== null) {
    try { echoController.clear(cause); } catch { /* Echo faults never break input. */ }
  }
}

/**
 * INPUT-U3: echoes one queued click. Draws only at an in-frame point (the
 * letterbox maps to null), through the same contain transform as the paint.
 * @param {{ clientX: number, clientY: number }} point
 */
function showEcho(point) {
  const canvas = canvasRef.value;
  if (echoController === null || echoModule === null || canvas === null) return;
  try {
    const rect = canvas.getBoundingClientRect();
    const framePoint = echoModule.echoPointFromClient({
      clientX: point.clientX,
      clientY: point.clientY,
      rect,
      frameWidth: canvas.width,
      frameHeight: canvas.height,
    });
    if (framePoint === null) return;
    const placement = echoModule.echoPlacement(framePoint,
      { width: rect.width, height: rect.height },
      { width: canvas.width, height: canvas.height });
    if (placement === null) return;
    if (!echoController.show(framePoint)) return;
    echoDot.value = {
      left: (Number.isFinite(canvas.offsetLeft) ? canvas.offsetLeft : 0) + placement.left,
      top: (Number.isFinite(canvas.offsetTop) ? canvas.offsetTop : 0) + placement.top,
    };
  } catch { /* Echo faults never break input. */ }
}

/**
 * INPUT-U3: a presented frame arrived; a frame whose input timestamp is newer
 * than the echoed click retires the dot.
 */
function observeEchoFrame() {
  if (echoController === null || echoModule === null || scheduler === null) return;
  try {
    const stamp = echoModule.frameInputTimestampMs(scheduler.getInstrumentation(props.surfaceId));
    echoController.observeFrame({ inputTimestampMs: stamp });
  } catch { /* Echo faults never break painting. */ }
}

/** PointerEvent.button index to contract button name; other buttons ignored. */
const POINTER_BUTTONS = ['left', 'middle', 'right'];

/**
 * Maps a client position onto frame pixels through the paint-owned canvas
 * size (canvas.width/height, never the projection props) with letterboxing
 * removed.
 * @param {{ clientX: number, clientY: number }} point
 * @returns {{ x: number, y: number } | null} Frame point, or null outside it.
 */
function clientToFramePoint(point) {
  const canvas = canvasRef.value;
  if (canvas === null) return null;
  // MVUI25D lane C: fail closed when the mapper import failed (see above).
  try {
    return mapClientToFrame({
      clientX: point.clientX,
      clientY: point.clientY,
      rect: canvas.getBoundingClientRect(),
      frameWidth: canvas.width,
      frameHeight: canvas.height,
    });
  } catch {
    return null;
  }
}

/** @param {FocusEvent} _event */
function onCanvasFocus(_event) {
  canvasFocused.value = true;
  emit('canvas-focus', props.surfaceId);
}

/** @param {FocusEvent} _event */
function onCanvasBlur(_event) {
  canvasFocused.value = false;
  activePress = null;
  // MVUI32 lane I (R3-INPUT-1): blur closes the gate — drop queued input.
  closeInputGate(props.surfaceId);
}

/**
 * Focuses the canvas only when the DOM method exists, never scrolling the
 * page (MVUI26B lane S: focus({ preventScroll: true }); the fallback keeps
 * fake-DOM harnesses and legacy focus() implementations working).
 * Focusing a tile must never move the MetaViewer page.
 */
function focusCanvas() {
  const el = canvasRef.value;
  if (el === null || typeof el.focus !== 'function') return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}

/**
 * Blurs the canvas only when the DOM method exists (see focusCanvas).
 */
function blurCanvas() {
  const el = canvasRef.value;
  if (el !== null && typeof el.blur === 'function') el.blur();
}

/**
 * Key capture: mapped keys are prevented and queued; unmapped keys
 * (Dead/IME/unidentified) pass through untouched; Escape releases focus and
 * is never forwarded.
 * @param {KeyboardEvent} event
 */
function onCanvasKeyDown(event) {
  if (!inputGateOpen()) return;
  if (event.key === 'Escape') {
    blurCanvas();
    emit('canvas-escape', props.surfaceId);
    return;
  }
  // MVUI25D lane C: a failed mapper import must fail closed inside DOM
  // listeners — never throw, never queue.
  let mapped = null;
  try {
    mapped = mapKeyboardEvent(event);
  } catch {
    return;
  }
  if (mapped === null) return;
  event.preventDefault();
  inputPort?.queue(props.surfaceId, props.streamId, mapped);
}

/**
 * MVUI26 lane I (frames RV10-04): the press armed by the latest gated
 * pointerdown (identifier, button, in-frame flag), or null when no press
 * is active. A pointerup queues a click only for a matching active press.
 * @type {{ pointerId: unknown, button: unknown, inFrame: boolean } | null}
 */
let activePress = null;

/**
 * Pointer capture: pointerdown on the canvas always prevents the default
 * action (MVUI27 lane S: a tile-canvas press never scrolls the page in any
 * mode — the mousedown default would otherwise shift focus to the focusable
 * kit surface wrapper and scroll it into view). A focusable canvas then
 * takes focus without scrolling and arms the press; pointerup sends one
 * click at frame coordinates only for a matching press started inside the
 * frame. No pointer-move forwarding. A non-focusable canvas never takes
 * focus and never arms a press, so it queues nothing.
 * @param {PointerEvent} event
 */
function onCanvasPointerDown(event) {
  event.preventDefault();
  if (!(props.inputEnabled === true && inputPort !== null && inputPort.available === true)) return;
  focusCanvas();
  // MVUI30 lane L: a frozen tile never arms a press (focusCanvas above is a
  // no-op: a lost canvas carries no tabindex).
  if (resolvedState.value === 'lost') return;
  emit('canvas-focus', props.surfaceId);
  activePress = {
    pointerId: event.pointerId,
    button: event.button,
    inFrame: clientToFramePoint(event) !== null,
  };
}

/**
 * A cancelled press never becomes a click.
 * @param {PointerEvent} _event
 */
function onCanvasPointerCancel(_event) {
  activePress = null;
}

/**
 * Click capture (MVUI26B lane S, MVUI27 lane S): a click on the canvas
 * always prevents the default action so the page never scrolls in any
 * mode. Focus was already taken without scrolling by pointerdown on a
 * focusable canvas; this handler queues nothing and never takes focus.
 * @param {PointerEvent} event
 */
function onCanvasClick(event) {
  event.preventDefault();
}

/**
 * @param {PointerEvent} event
 */
function onCanvasPointerUp(event) {
  if (!inputGateOpen()) return;
  const press = activePress;
  activePress = null;
  if (press === null || press.inFrame !== true
    || press.pointerId !== event.pointerId || press.button !== event.button) return;
  const button = event.button >= 0 && event.button < POINTER_BUTTONS.length
    ? POINTER_BUTTONS[event.button]
    : undefined;
  if (button === undefined) return;
  const point = clientToFramePoint(event);
  if (point === null) return;
  inputPort?.queue(props.surfaceId, props.streamId, { kind: 'click', x: point.x, y: point.y, button });
  showEcho(event);
}

/**
 * INPUT-U3 (distillation N8): while input is armed, the context menu and the
 * auxiliary-button click on the tile belong to the capsule, never to
 * Electron/Chromium. Right and middle presses already travel as clicks;
 * preventDefault on pointerdown alone does not stop either default. READ and
 * every non-armed state leave both events untouched.
 * @param {Event} event
 */
function onCanvasButtonDefault(event) {
  if (!canvasFocusable.value) return;
  event.preventDefault();
}

/**
 * Wheel capture: sent only for positions inside the frame with a nonzero
 * delta; page scroll is prevented only when an event is queued.
 * @param {WheelEvent} event
 */
function onCanvasWheel(event) {
  if (!props.scrollEnabled) return;
  if (!inputGateOpen()) return;
  const point = clientToFramePoint(event);
  if (point === null) return;
  const dx = Math.round(event.deltaX);
  const dy = Math.round(event.deltaY);
  if (dx === 0 && dy === 0) return;
  // MVUI26 lane I (frames NEW-02): prevent only on the queue path, so
  // letterbox and zero-delta wheels keep page scroll.
  event.preventDefault();
  inputPort?.queue(props.surfaceId, props.streamId, { kind: 'scroll', dx, dy, x: point.x, y: point.y });
}

function isTypingInTextField() {
  const doc = typeof globalThis.document === 'object' && globalThis.document !== null
    ? /** @type {{ activeElement?: unknown }} */ (globalThis.document)
    : null;
  const active = /** @type {{ tagName?: unknown, isContentEditable?: unknown, contentEditable?: unknown } | null | undefined} */ (doc?.activeElement);
  if (!active || typeof active !== 'object' || active === canvasRef.value) return false;
  if (active.isContentEditable === true || active.contentEditable === 'true') return true;
  const tag = typeof active.tagName === 'string' ? active.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'CANVAS';
}

function focusCanvasOnEnable() {
  if (unmounted || props.inputEnabled !== true || resolvedState.value === 'lost') return;
  if (inputPort === null || inputPort.available !== true || isTypingInTextField()) return;
  focusCanvas();
}

// Losing the gate releases focus, so a stale focused canvas can never keep
// capturing after a control handoff or a READ switch. Enabling input focuses
// the canvas unless the operator is typing in another field or canvas.
// MVUI32 lane I (R3-INPUT-1): the gate closure also drops queued input.
watch(() => props.inputEnabled, (enabled, previous) => {
  if (enabled !== true) {
    if (previous !== undefined) {
      activePress = null;
      blurCanvas();
      closeInputGate(props.surfaceId);
    }
    return;
  }
  if (previous === false) {
    focusCanvasOnEnable();
    void Promise.resolve().then(focusCanvasOnEnable);
  } else if (typeof globalThis.document === 'object' && globalThis.document !== null) {
    void Promise.resolve().then(focusCanvasOnEnable);
  }
}, { immediate: true });

// MVUI32 lane I (R3-INPUT-1): a stream change closes the previous stream's
// gate — input queued under the old stream is dropped, never dispatched.
watch(() => props.streamId, (next, previous) => {
  if (next !== previous) closeInputGate(props.surfaceId);
});

// MVUI30 lane L: the lost transition releases the scheduler binding, so no
// later present can paint over the frozen frame; the canvas element keeps
// its bitmap. Input state resets too: a frozen tile never captures.
watch(resolvedState, (next) => {
  if (next === 'lost') {
    activePress = null;
    blurCanvas();
    // MVUI32 lane I (R3-INPUT-1): a frozen tile never captures — drop queued input.
    closeInputGate(props.surfaceId);
    if (scheduler !== null) {
      scheduler.detachCanvas(props.surfaceId, canvasToken);
      canvasToken = null;
    }
  }
});

/** @param {number | string} value */
function bindingNumber(value) {
  if (value === '') return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : NaN;
}

function attachCanvas() {
  if (scheduler !== null && canvasRef.value !== null) {
    // L3-1: attach with the identity the router registered, verbatim from
    // its notice; the scheduler's identity check stays intact. Only the
    // legacy path (no router notice yet) uses the projection props.
    const identity = registeredIdentity;
    const result = scheduler.attachCanvas({ surfaceId: props.surfaceId,
      surfaceGeneration: identity !== null ? identity.surfaceGeneration : bindingNumber(props.generation),
      epoch: identity !== null ? identity.epoch : bindingNumber(props.epoch),
      canvas: canvasRef.value });
    if (result?.ok === true) {
      canvasToken = result.token ?? null;
      checkSchedulerPresentation();
      // MVUI30 lane L: a tile mounting already lost keeps the synchronous
      // retained repaint above and immediately releases the binding, so no
      // later present can paint over the frozen frame.
      if (resolvedState.value === 'lost') {
        scheduler.detachCanvas(props.surfaceId, canvasToken);
        canvasToken = null;
      }
      emit('canvas-ready', { surfaceId: props.surfaceId });
      return;
    }
  }
  emit('canvas-released', { surfaceId: props.surfaceId });
}

/**
 * Bind this tile to the frame-port router so validated deliveries paint
 * through the injected scheduler. The router notifies when it registers
 * the surface, retrying the canvas attach that fails while the surface is
 * still unregistered. Without a router (fixtures, legacy) this is a no-op.
 */
function bindFramePort() {
  if (framePortRouter === null || scheduler === null) return;
  if (typeof framePortRouter.bindSurface !== 'function') return;
  try {
    framePortRouter.bindSurface({
      surfaceId: props.surfaceId,
      scheduler,
      bindToken,
      onRegistered: (/** @type {{ surfaceId: string, surfaceGeneration: number, epoch: number }} */ notice) => {
        if (notice.surfaceId !== props.surfaceId) return;
        // L3-1: pin the delivery identity for every later attach (including
        // the generation/epoch-only prop refresh below); malformed notices
        // keep the legacy props attach instead of bricking the tile.
        if (Number.isSafeInteger(notice.surfaceGeneration) && Number.isSafeInteger(notice.epoch)) {
          const changed = registeredIdentity === null
            || registeredIdentity.surfaceGeneration !== notice.surfaceGeneration
            || registeredIdentity.epoch !== notice.epoch;
          registeredIdentity = { surfaceGeneration: notice.surfaceGeneration, epoch: notice.epoch };
          if (changed) {
            // MVUI18D: a NEW delivery identity on this surfaceId starts a new
            // stream, so the previous stream's retained witness is dropped:
            // without this the recreated surface reports the old handle/size
            // as 'live' before its first frame arrives.
            retainedFrame.value = '';
            retainedDigest.value = '';
            resetFpsState();
          }
          // MVUI18C: a newer stream re-registers with ITS delivery identity
          // and the scheduler drops the old canvas binding; the re-attach
          // below reclaims it, otherwise the present finds no canvas and
          // the delivery acks REFUSED.
        }
        // MVUI20: always re-attach. Registration and bind replay attach the
        // standing canvas; when the active tile unbinds, the router restores
        // this tile by re-firing this hook, and the re-attach reclaims the
        // scheduler canvas with an immediate retained repaint. The detach is
        // a no-op while unattached or after a superseding attach replaced
        // this tile's token.
        if (scheduler !== null) {
          scheduler.detachCanvas(props.surfaceId, canvasToken);
          canvasToken = null;
        }
        attachCanvas();
      },
    });
  } catch { /* Binding failures keep the legacy path. */ }
}

/**
 * @param {unknown} surfaceId
 * @param {boolean} [keepStream] Unmount passes true: the App swaps wall and
 * multislot tiles through remount gaps, so the shared stream stays open for
 * the tile that mounts next. A surface change leaves it false so the old
 * stream retires once its tile was the last binding.
 */
function unbindFramePort(surfaceId, keepStream = false) {
  if (framePortRouter === null || typeof framePortRouter.unbindSurface !== 'function') return;
  try {
    framePortRouter.unbindSurface(surfaceId, bindToken, keepStream === true ? { keepStream: true } : undefined);
  } catch { /* Unbind never breaks teardown. */ }
}

/**
 * NEW-02: delay of the deferred post-unmount evict re-check. Past the
 * router keepStream grace (500 ms default), so a permanently unmounted
 * surface has retired by the time the check fires, while a same-flush
 * remount rebinds far earlier and keeps its entry.
 */
const SURFACE_EVICT_DELAY_MS = 1200;

/**
 * NEW-02: evict a scheduler entry only once its surface fully retired (the
 * router reports no stream) and no canvas is attached. Live, grace-held,
 * and canvas-attached entries always survive; without a router (legacy
 * fixtures) this is a no-op. Best-effort: never breaks teardown.
 * @param {unknown} surfaceId
 */
function maybeEvictSurface(surfaceId) {
  if (scheduler === null || framePortRouter === null) return;
  if (typeof framePortRouter.getSurfaceStatus !== 'function') return;
  let status = null;
  try {
    status = framePortRouter.getSurfaceStatus(/** @type {string} */ (surfaceId));
  } catch {
    return;
  }
  if (status !== null) return;
  let info = null;
  try {
    info = scheduler.getInstrumentation(surfaceId);
  } catch {
    return;
  }
  if (info === null || typeof info !== 'object') return;
  if (!shouldEvictSchedulerEntry({ streamRetired: true, canvasAttached: info.canvasAttached === true })) return;
  try {
    scheduler.evictSurface(surfaceId);
  } catch { /* Eviction never breaks teardown. */ }
}

/**
 * Bind this tile to the unverified DISPLAY port router.
 * @param {any} router
 */
function bindDisplayRouterInstance(router) {
  if (!router || typeof router.bindSurface !== 'function') return;
  try {
    router.bindSurface({
      surfaceId: props.surfaceId,
      bindToken: displayBindToken,
      getCanvas: () => canvasRef.value,
      isVisible: () => !unmounted && normalizeSurfaceState(props.state) !== 'lost',
      onFrame: (/** @type {any} */ frame) => {
        if (unmounted || frame.surfaceId !== props.surfaceId) return false;
        if (normalizeSurfaceState(props.state) === 'lost') return false;
        displayMode.value = 'active';
        onFramePainted();
        return true;
      },
      onState: (/** @type {{ surfaceId: string, state: 'active' | 'stale' | 'absent' }} */ notice) => {
        if (unmounted || notice.surfaceId !== props.surfaceId) return;
        displayMode.value = notice.state;
      },
    });
  } catch { /* Display binding is optional and never breaks VERIFIED rendering. */ }
}

function bindDisplayPort() {
  if (activeDisplayRouter !== null) {
    bindDisplayRouterInstance(activeDisplayRouter);
    return;
  }
  import('../frames/displayPortRouter.js').then((module) => {
    if (unmounted) return;
    activeDisplayRouter = module.getSharedDisplayPortRouter();
    bindDisplayRouterInstance(activeDisplayRouter);
  }).catch(() => { /* Optional in isolated SFC compile harnesses. */ });
}

/** @param {unknown} surfaceId */
function unbindDisplayPort(surfaceId) {
  if (activeDisplayRouter === null || typeof activeDisplayRouter.unbindSurface !== 'function') return;
  try {
    activeDisplayRouter.unbindSurface(String(surfaceId), displayBindToken);
  } catch { /* Teardown never throws. */ }
}

onMounted(attachCanvas);
onMounted(bindFramePort);
onMounted(bindDisplayPort);
onMounted(loadEcho);

// INPUT-U3: a newly presented frame may answer the echoed click.
watch(() => [props.frame, props.digest], observeEchoFrame);

watch(() => [props.surfaceId, props.generation, props.epoch], (_current, previous) => {
  // Only a surface change rebinds the router: generation/epoch-only updates
  // refresh the canvas attach while the live binding (and its port) stands.
  const surfaceChanged = props.surfaceId !== previous[0];
  if (surfaceChanged) {
    // MVUI32 lane I (R3-INPUT-1): the old surface's gate closes with the
    // tile — input queued for it is dropped, never dispatched.
    closeInputGate(String(previous[0]));
    unbindFramePort(previous[0]);
    unbindDisplayPort(previous[0]);
    displayMode.value = 'absent';
    // L3-1: the pinned delivery identity belongs to the old surface; the
    // rebind below receives a fresh notice for the new one.
    registeredIdentity = null;
    resetFpsState();
  }
  if (!surfaceChanged && registeredIdentity !== null && canvasToken !== null) {
    // MVUI18D: the canvas is bound with the pinned delivery identity, which a
    // projection generation/epoch-only update never changes, so detaching and
    // re-attaching here is per-frame churn with a mid-update window where a
    // presentation finds no canvas. Only a surfaceId change or a new
    // registered identity re-attaches.
    return;
  }
  if (scheduler === null) return;
  scheduler.detachCanvas(String(previous[0]), canvasToken);
  canvasToken = null;
  attachCanvas();
  if (surfaceChanged) {
    // NEW-02: the old surface unbound without keepStream above, so a last
    // binding retired it synchronously and its entry can go now; a surface
    // that other tiles still bind stays live and is kept.
    maybeEvictSurface(String(previous[0]));
    bindFramePort();
    bindDisplayPort();
  }
});

onBeforeUnmount(() => {
  clearFpsTimers();
  if (stopSchedulerPresentation !== null) {
    try { stopSchedulerPresentation(); } catch { /* ignore */ }
    stopSchedulerPresentation = null;
  }
  if (stopAuthorityFrames !== null) {
    try { stopAuthorityFrames(); } catch { /* ignore */ }
    stopAuthorityFrames = null;
  }
  // MVUI32 lane I (R3-INPUT-1): unmount closes the gate — drop queued input.
  closeInputGate(props.surfaceId);
  unmounted = true;
  if (echoController !== null) {
    try { echoController.dispose(); } catch { /* Echo faults never break teardown. */ }
    echoController = null;
  }
  unbindDisplayPort(props.surfaceId);
  unbindFramePort(props.surfaceId, true);
  if (scheduler !== null) {
    scheduler.detachCanvas(props.surfaceId, canvasToken);
    canvasToken = null;
  }
  // NEW-02: the keepStream unbind above retires the stream only past its
  // grace, so check now (an already-retired stream evicts immediately) and
  // once more past the grace; a rebound stream skips both checks.
  maybeEvictSurface(props.surfaceId);
  const evictTimer = /** @type {any} */ (setTimeout(() => {
    maybeEvictSurface(props.surfaceId);
  }, SURFACE_EVICT_DELAY_MS));
  if (evictTimer !== null && typeof evictTimer === 'object' && typeof evictTimer.unref === 'function') {
    try { evictTimer.unref(); } catch { /* A test loop never holds teardown. */ }
  }
  emit('canvas-released', { surfaceId: props.surfaceId });
});
</script>
<template>
  <section
    class="mv-surface"
    :id="domId"
    :data-anchor="anchor"
    :data-state="resolvedState"
    :data-aspect-ratio="surfaceGeometry.aspectRatio"
    :data-display-state="displayActive ? displayMode : undefined"
    :aria-label="accessibleName"
  >
    <canvas ref="canvasRef" :hidden="resolvedState !== 'live' && resolvedState !== 'stale' && !showFrozen" class="mv-surface__canvas" :id="props.inputEnabled && resolvedState !== 'lost' ? inputAnchor : undefined" :data-semantic-anchor="props.inputEnabled && resolvedState !== 'lost' ? inputAnchor : undefined" :tabindex="canvasFocusable ? 0 : undefined" :aria-hidden="canvasFocusable ? undefined : 'true'" :aria-label="props.inputEnabled && resolvedState !== 'lost' ? inputName : undefined" @focus="onCanvasFocus" @blur="onCanvasBlur" @keydown="onCanvasKeyDown" @pointerdown="onCanvasPointerDown" @pointerup="onCanvasPointerUp" @pointercancel="onCanvasPointerCancel" @click="onCanvasClick" @wheel="onCanvasWheel" @contextmenu="onCanvasButtonDefault" @auxclick="onCanvasButtonDefault" />
    <svg v-if="echoDot !== null" class="mv-surface__echo" aria-hidden="true" focusable="false"><circle class="mv-surface__echo-dot" :cx="echoDot.left" :cy="echoDot.top" r="5" /></svg>
    <div v-if="showFrozen" :id="lostBadgeAnchor" class="mv-surface__lost" role="status" :data-semantic-anchor="lostBadgeAnchor" :aria-label="lostBadgeName">
      <span class="mv-surface__lost-badge">Lost</span>
      <span class="mv-surface__lost-note">Showing the last frame.</span>
    </div>
    <div v-if="resolvedState !== 'live' && resolvedState !== 'stale' && !showFrozen" class="mv-surface__waiting" role="status">
      <span class="mv-surface__connection-mark" aria-hidden="true">◌</span>
      <strong>{{ resolvedState === 'connecting' ? 'Connecting to surface' : resolvedState === 'lost' ? 'Lost' : 'Waiting for surface' }}</strong>
      <span>{{ resolvedState === 'lost' ? 'No frames were presented for this surface.' : 'The surface will appear here when it is ready.' }}</span>
    </div>
    <p v-if="showWitness" class="mv-surface__state" aria-hidden="true">{{ resolvedState }}</p>
    <div v-if="showWitness" class="mv-surface__strip" role="group" :aria-label="stripName">
      <span class="mv-surface__key">FRAME: {{ strip.frameText.length > 0 ? strip.frameText : '—' }}</span>
      <span class="mv-surface__key">GEN: {{ strip.generationText.length > 0 ? strip.generationText : '—' }}</span>
      <span class="mv-surface__key">SHA256: {{ strip.digestText.length > 0 ? strip.digestText : '—' }}</span>
      <span class="mv-surface__key" :data-fps="fpsDisplayAttr">FPS: {{ fpsDisplayText }}</span>
      <span class="mv-surface__key" :data-capture-ms="capDisplayAttr">CAP: {{ capDisplayText }}</span>
      <span v-if="displayActive" class="mv-surface__display-chip" data-display-chip="unverified">DISPLAY · unverified</span>
      <span v-if="strip.readOnlyText.length > 0" class="mv-surface__guard">{{ strip.readOnlyText }}</span>
    </div>
  </section>
</template>
<style scoped>
.mv-surface {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  width: 100%;
  height: 100%;
  background: var(--cuk-semantic-surface-canvas);
  color: var(--cuk-semantic-text-primary);
}
.mv-surface:has(> .mv-surface__strip) {
  width: min(100cqw, calc((100cqh - 23px) * 1280 / 900));
  height: min(100cqh, calc(100cqw * 900 / 1280 + 23px));
}
.mv-surface__canvas {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 0;
  aspect-ratio: 1280 / 900;
  object-fit: contain;
  background-color: var(--mv-primitive-color-neutral-1100, #000000);
}
.mv-surface__canvas[hidden] {
  display: none;
}
/* INPUT-U3: local click echo. A full-tile SVG layer positioned by circle
 * attributes (cx, cy), so no inline style is ever written (strict CSP). */
.mv-surface__echo {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
}
.mv-surface__echo-dot {
  fill: var(--cuk-semantic-accent-primary);
  fill-opacity: 0.35;
  stroke: var(--cuk-semantic-accent-primary);
  stroke-width: 2;
}
.mv-surface__canvas:focus-visible {
  outline-width: var(--cuk-semantic-focus-ring-width);
  outline-style: var(--cuk-semantic-focus-ring-style);
  outline-color: var(--cuk-semantic-focus-ring-color);
  outline-offset: calc(var(--cuk-semantic-focus-ring-offset) * -1);
}
.mv-surface__waiting { flex:1; min-height:200px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--cuk-semantic-spacing-sm); padding:var(--cuk-semantic-spacing-lg); text-align:center; color:var(--cuk-semantic-text-muted); font-size:12px; }
.mv-surface__waiting strong { color:var(--cuk-semantic-text-primary); font-size:14px; font-weight:500; }
.mv-surface__connection-mark { font-size:32px; color:var(--cuk-semantic-accent-primary); }
.mv-surface__lost {
  display: flex;
  align-items: center;
  gap: var(--cuk-semantic-spacing-xs);
  padding: var(--cuk-semantic-spacing-xs) var(--cuk-semantic-spacing-sm);
  background: var(--mv-component-badge-background);
  color: var(--mv-component-badge-text);
  font-size: var(--cuk-semantic-typography-font-size-xs);
  line-height: var(--cuk-semantic-typography-line-height-normal);
}
.mv-surface__lost-badge {
  font-weight: 700;
}
.mv-surface__lost-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* UI-TILE: the state word sits at the start of the witness strip line (both
 * render together under showWitness) instead of taking its own row, so the
 * canvas keeps that height. */
.mv-surface__state {
  position: absolute;
  left: 0;
  bottom: 0;
  z-index: 1;
  box-sizing: border-box;
  width: 48px;
  margin: 0;
  padding: 0 8px;
  font-size: 11px;
  line-height: 23px;
  color: var(--mv-primitive-color-neutral-300, #ced0d4);
}
.mv-surface__strip {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 22px;
  padding: 0 8px 0 48px;
  overflow: hidden;
  white-space: nowrap;
  border-top: 1px solid var(--mv-primitive-color-neutral-600, #525b66);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--mv-primitive-color-neutral-400, #a9b2bc);
}
.mv-surface__key {
  overflow: hidden;
  text-overflow: ellipsis;
}
.mv-surface__guard {
  flex: none;
  margin-left: auto;
  font-weight: 600;
  color: var(--mv-primitive-color-amber-300, #f2c14e);
}
.mv-surface__display-chip {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--mv-component-badge-background);
  color: var(--mv-component-badge-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  pointer-events: none;
}
/* The strip is part of the frame's flex height: wrapping consumes body space
 * without overlapping pixels or clipping the safety labels mid word. */
@container tile-chrome (max-width: 499px) {
  .mv-surface:has(> .mv-surface__strip) { width:100%; height:100%; }
  .mv-surface__strip {
    flex-wrap:wrap;
    gap:2px 8px;
    padding:2px 8px;
    white-space:normal;
    overflow:visible;
  }
  .mv-surface__key { white-space:nowrap; }
  .mv-surface__guard { margin-left:0; flex:0 1 auto; overflow-wrap:normal; }
  .mv-surface__display-chip { flex:0 1 auto; overflow-wrap:normal; }
  .mv-surface__state { display:none; }
}
</style>
