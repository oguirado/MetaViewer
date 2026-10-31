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
  // MVUI25 lane C: frame stream id the tile is bound to (the same value the
  // frame router uses); forwarded verbatim on every queued input event.
  streamId: { type: Number, default: 0 },
});

const emit = defineEmits(['canvas-ready', 'canvas-released']);

/** @type {{ attachCanvas: (args: any) => { ok: boolean, token?: symbol }, detachCanvas: (id: string, token: symbol | null) => void, getInstrumentation: (surfaceId: unknown) => any, evictSurface: (surfaceId: unknown) => unknown } | null} */
const scheduler = /** @type {any} */ (inject('tileScheduler', null));
/** Live-only frame-port router provided by the entry; null keeps the legacy path. */
const framePortRouter = /** @type {{ bindSurface?: (binding: any) => boolean, unbindSurface?: (surfaceId: unknown, bindToken?: unknown, options?: { keepStream?: boolean }) => void, getSurfaceStatus?: (surfaceId?: string) => unknown } | null} */ (inject('framePortRouter', null));
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
const showWitness = computed(() => effectiveFrame.value.length > 0
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
  const port = /** @type {any} */ (inputPort);
  if (port === null || typeof port.closeGate !== 'function') return;
  try {
    port.closeGate(typeof surfaceId === 'string' ? surfaceId : props.surfaceId);
  } catch { /* Gate closure never breaks the tile. */ }
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
}

/**
 * Wheel capture: sent only for positions inside the frame with a nonzero
 * delta; page scroll is prevented only when an event is queued.
 * @param {WheelEvent} event
 */
function onCanvasWheel(event) {
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

// Losing the gate releases focus, so a stale focused canvas can never keep
// capturing after a control handoff or a READ switch.
// MVUI32 lane I (R3-INPUT-1): the gate closure also drops queued input.
watch(() => props.inputEnabled, (enabled) => {
  if (enabled !== true) {
    activePress = null;
    blurCanvas();
    closeInputGate(props.surfaceId);
  }
});

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

onMounted(attachCanvas);
onMounted(bindFramePort);

watch(() => [props.surfaceId, props.generation, props.epoch], (_current, previous) => {
  // Only a surface change rebinds the router: generation/epoch-only updates
  // refresh the canvas attach while the live binding (and its port) stands.
  const surfaceChanged = props.surfaceId !== previous[0];
  if (surfaceChanged) {
    // MVUI32 lane I (R3-INPUT-1): the old surface's gate closes with the
    // tile — input queued for it is dropped, never dispatched.
    closeInputGate(String(previous[0]));
    unbindFramePort(previous[0]);
    // L3-1: the pinned delivery identity belongs to the old surface; the
    // rebind below receives a fresh notice for the new one.
    registeredIdentity = null;
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
  }
});

onBeforeUnmount(() => {
  // MVUI32 lane I (R3-INPUT-1): unmount closes the gate — drop queued input.
  closeInputGate(props.surfaceId);
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
    :aria-label="accessibleName"
  >
    <canvas ref="canvasRef" :hidden="resolvedState !== 'live' && resolvedState !== 'stale' && !showFrozen" class="mv-surface__canvas" :id="props.inputEnabled && resolvedState !== 'lost' ? inputAnchor : undefined" :data-semantic-anchor="props.inputEnabled && resolvedState !== 'lost' ? inputAnchor : undefined" :tabindex="canvasFocusable ? 0 : undefined" :aria-hidden="canvasFocusable ? undefined : 'true'" :aria-label="props.inputEnabled && resolvedState !== 'lost' ? inputName : undefined" @focus="onCanvasFocus" @blur="onCanvasBlur" @keydown="onCanvasKeyDown" @pointerdown="onCanvasPointerDown" @pointerup="onCanvasPointerUp" @pointercancel="onCanvasPointerCancel" @click="onCanvasClick" @wheel="onCanvasWheel" />
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
  overflow: hidden;
  width: 100%;
  height: 100%;
  background: var(--cuk-semantic-surface-canvas);
  color: var(--cuk-semantic-text-primary);
}
.mv-surface__canvas {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 0;
  object-fit: contain;
  background-color: var(--mv-primitive-color-neutral-1100, #000000);
}
.mv-surface__canvas[hidden] {
  display: none;
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
</style>
