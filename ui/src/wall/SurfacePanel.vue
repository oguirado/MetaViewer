<script>
/**
 * @file SurfacePanel pure module: closed panel sets, status derivation, anchors, boxes.
 * Dependency-free plain script: setup code shares this scope, and node:test loads
 * this exact block, so it must stay free of framework calls and external loads.
 */

/** @typedef {{ code: string, message: string }} PanelAdmissionError */
/** @typedef {{ id: string, surfaceId: string, backendLifecycle: string, generation: number, visibility: string, control: string, attachmentState?: string, refusal?: PanelAdmissionError|null, readinessError?: PanelAdmissionError|null }} PanelSurfaceRow */
/** @typedef {{ rows: readonly PanelSurfaceRow[] }} PanelProjectionBody */
/** @typedef {{ schema: string, epoch: number, revision: number, query: string, projection: PanelProjectionBody }} PanelProjectionEnvelope */
/** @typedef {{ status: string, stale: boolean, envelope: PanelProjectionEnvelope|null, error: PanelAdmissionError|null }} PanelProjectionSnapshot */
/** @typedef {{ getSnapshot: () => PanelProjectionSnapshot|null, subscribe: (listener: (snapshot: PanelProjectionSnapshot|null) => void) => () => void }} ProjectionViewLike */
/** @typedef {{ capsuleId: string, verb: string, pinned?: boolean }} PanelVisibilityInput */
/** @typedef {{ capsuleId: string, verb: string }} PanelControlInput */
/** @typedef {{ capsuleId: string, verb: string }} PanelPresentationInput */
/** @typedef {{ visibility: (input: PanelVisibilityInput) => unknown, control: (input: PanelControlInput) => unknown, presentation: (input: PanelPresentationInput) => unknown }} IntentBuildersLike */
/** @typedef {Record<string, unknown>} ControlRegistryLike */
/** @typedef {Record<string, unknown>} SchedulerLike */
/** @typedef {Record<string, unknown>} TileSchedulerLike */
/** @typedef {{ capsuleId: unknown, presentationInstance: unknown, projectionView: unknown, intentBuilders: unknown, controlRegistry: unknown, scheduler: unknown, tileScheduler: unknown }} PanelDepsLike */

/** Backend lifecycle enum: core truth, five states, never extended locally. */
export const BACKEND_LIFECYCLES = Object.freeze(['active', 'standby', 'ceded', 'destroyed', 'lost']);

/** Local UI request phases: pending presentation work, distinct from backend lifecycle. */
export const UI_REQUEST_PHASES = Object.freeze(['idle', 'creating', 'readiness-error', 'folding',
  'unfolding', 'taking-control', 'releasing-control', 'destroying']);

/** Projected session activity states; quiet output never implies done. */
export const AI_SESSION_ACTIVITIES = Object.freeze(['unknown', 'ready', 'busy', 'waiting-input',
  'waiting-permission', 'exited', 'failed']);

/** Multislot attachment states for the bound region. */
export const ATTACHMENT_STATES = Object.freeze(['detached', 'attaching', 'restoring', 'live',
  'disconnected']);

/** Dispatch outcome states for attributed runs. */
export const DISPATCH_OUTCOMES = Object.freeze(['none', 'admitting', 'accepted', 'executing',
  'completed-unverified', 'verified', 'refused', 'uncertain', 'cancelled']);

/** Core refusal codes; rendered distinctly, never collapsed. */
export const REFUSAL_CODES = Object.freeze(['STALE_FRAME', 'SURFACE_NOT_AGENT_CONTROLLED',
  'LOCKED_BY_OTHER', 'BUDGET_EXCEEDED', 'OUT_OF_BOUNDS', 'POLICY']);

/** Wall panel control actions from the allowed control-family inventory. */
export const PANEL_ACTIONS = Object.freeze(['fold', 'pin', 'control', 'close', 'popout',
  'dock-back']);

/** Lifecycles whose frames the canvas host may show; the frames lane keeps final say. */
export const DRAWABLE_LIFECYCLES = Object.freeze(['active', 'standby', 'ceded']);

/** Unavailable-with-reason text for the denied popout action. */
export const POPOUT_UNAVAILABLE_REASON = 'Popout is unavailable: this window denies new windows.';

export const PANEL_INVALID_PROP = 'ERR_PANEL_INVALID_PROP';
export const PANEL_INVALID_ANCHOR = 'ERR_PANEL_INVALID_ANCHOR';

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function panelError(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isKnownLifecycle(value) {
  return typeof value === 'string' && BACKEND_LIFECYCLES.includes(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isKnownRefusalCode(value) {
  return typeof value === 'string' && REFUSAL_CODES.includes(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isKnownPanelAction(value) {
  return typeof value === 'string' && PANEL_ACTIONS.includes(value);
}

/**
 * Validate an exact core-issued capsule id: never invented, indexed, or decorated.
 * @param {unknown} value
 * @param {string} name
 * @param {string} code
 * @returns {string}
 */
function requireCapsuleId(value, name, code) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || /\s/.test(value) || /^\d+$/.test(value)) {
    throw panelError(code, `SurfacePanel: invalid ${name}: exact id required`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function assertObject(value, name) {
  if (typeof value !== 'object' || value === null) {
    throw panelError(PANEL_INVALID_PROP, `SurfacePanel: invalid prop "${name}": object required`);
  }
}

/**
 * @param {unknown} view
 */
function assertProjectionView(view) {
  const candidate = typeof view === 'object' && view !== null
    ? /** @type {Record<string, unknown>} */ (view)
    : null;
  if (candidate === null || typeof candidate.getSnapshot !== 'function'
    || typeof candidate.subscribe !== 'function') {
    throw panelError(PANEL_INVALID_PROP,
      'SurfacePanel: invalid prop "projectionView": getSnapshot/subscribe required');
  }
}

/**
 * @param {unknown} builders
 */
function assertIntentBuilders(builders) {
  const candidate = typeof builders === 'object' && builders !== null
    ? /** @type {Record<string, unknown>} */ (builders)
    : null;
  if (candidate === null || typeof candidate.visibility !== 'function'
    || typeof candidate.control !== 'function' || typeof candidate.presentation !== 'function') {
    throw panelError(PANEL_INVALID_PROP,
      'SurfacePanel: invalid prop "intentBuilders": visibility/control/presentation required');
  }
}

/**
 * Refuse visibly when any required panel dependency is missing or malformed.
 * @param {PanelDepsLike} deps
 * @returns {void}
 */
export function validatePanelDeps(deps) {
  if (typeof deps !== 'object' || deps === null) {
    throw panelError(PANEL_INVALID_PROP, 'SurfacePanel: invalid props: object required');
  }
  requireCapsuleId(deps.capsuleId, 'capsuleId', PANEL_INVALID_PROP);
  if (typeof deps.presentationInstance !== 'string' || deps.presentationInstance.length === 0) {
    throw panelError(PANEL_INVALID_PROP,
      'SurfacePanel: invalid prop "presentationInstance": non-empty string required');
  }
  assertProjectionView(deps.projectionView);
  assertIntentBuilders(deps.intentBuilders);
  assertObject(deps.controlRegistry, 'controlRegistry');
  assertObject(deps.scheduler, 'scheduler');
  // An explicit null permits a scheduler to arrive later; missing or malformed
  // dependencies still fail admission.
  if (deps.tileScheduler !== null) assertObject(deps.tileScheduler, 'tileScheduler');
}

/**
 * Select the exact row for one capsule; id and surfaceId must both match.
 * @param {PanelProjectionSnapshot|null} snapshot
 * @param {string} capsuleId
 * @returns {PanelSurfaceRow|null}
 */
export function findSurfaceRow(snapshot, capsuleId) {
  const rows = snapshot?.envelope?.projection?.rows;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    if (row.id === capsuleId && row.surfaceId === capsuleId) return row;
  }
  return null;
}

/**
 * Derive one display status. Refusal first, backend truth over transport staleness,
 * unknown lifecycles never live, and transport alone never proves live.
 * @deprecated Tile decisions moved to deriveTileState in tileStates.js; this
 * helper stays only for the status-parity tests. New consumers must use
 * deriveTileState plus refusalCodeFor.
 * @param {PanelProjectionSnapshot|null} snapshot
 * @param {PanelSurfaceRow|null} row
 * @returns {string}
 */
export function derivePanelStatus(snapshot, row) {
  const refusal = row?.refusal ?? snapshot?.error ?? null;
  const code = refusal !== null && typeof refusal === 'object' ? refusal.code : null;
  if (typeof code === 'string' && code.length > 0) return `Refused: ${code}`;
  const lifecycle = row?.backendLifecycle ?? null;
  if (lifecycle === 'destroyed') return 'Destroyed';
  if (lifecycle === 'lost') return 'Lost';
  if (typeof lifecycle !== 'string' || !isKnownLifecycle(lifecycle)) return 'Waiting';
  if (snapshot?.status === 'stale' || snapshot?.stale === true) return 'Stale';
  if (snapshot?.status === 'live' && snapshot.envelope !== null && row !== null) return 'Live';
  return 'Waiting';
}

/**
 * @param {PanelSurfaceRow|null} row
 * @returns {boolean}
 */
export function isDrawableRow(row) {
  return row !== null && DRAWABLE_LIFECYCLES.includes(row.backendLifecycle);
}

/**
 * The frame host stays mounted in every state; only the terminal destroyed state
 * collapses it, while status chrome and diagnostics keep rendering.
 * @param {PanelSurfaceRow|null} row
 * @returns {boolean}
 */
export function isSurfaceHostVisible(row) {
  return row === null || row.backendLifecycle !== 'destroyed';
}

/**
 * @param {unknown} capsuleId
 * @param {unknown} action
 * @returns {string}
 */
export function buildSemanticAnchor(capsuleId, action) {
  const id = requireCapsuleId(capsuleId, 'capsuleId', PANEL_INVALID_ANCHOR);
  if (!isKnownPanelAction(action)) {
    throw panelError(PANEL_INVALID_ANCHOR,
      `SurfacePanel: unknown panel action "${String(action)}"`);
  }
  return `capsule/${id}/${String(action)}`;
}

/**
 * @param {unknown} action
 * @returns {Readonly<{ available: boolean, reason?: string }>}
 */
export function actionAvailability(action) {
  if (!isKnownPanelAction(action)) {
    throw panelError(PANEL_INVALID_ANCHOR,
      `SurfacePanel: unknown panel action "${String(action)}"`);
  }
  if (action === 'popout') {
    return Object.freeze({ available: false, reason: POPOUT_UNAVAILABLE_REASON });
  }
  return Object.freeze({ available: true });
}

/**
 * Round a materialized box to integer CSS pixels; hidden or malformed boxes yield
 * null so the registry never stores a fabricated box.
 * @param {unknown} box
 * @returns {Readonly<{ x: number, y: number, width: number, height: number }>|null}
 */
export function roundControlBox(box) {
  if (typeof box !== 'object' || box === null) return null;
  const candidate = /** @type {Record<string, unknown>} */ (box);
  if (candidate.hidden === true) return null;
  const x = candidate.x;
  const y = candidate.y;
  const width = candidate.width;
  const height = candidate.height;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  if (typeof width !== 'number' || !Number.isFinite(width)) return null;
  if (typeof height !== 'number' || !Number.isFinite(height)) return null;
  return Object.freeze({ x: Math.round(x), y: Math.round(y), width: Math.round(width),
    height: Math.round(height) });
}
</script>
<script setup>
import { computed, onBeforeUnmount, provide, shallowRef, watch } from 'vue';
import CapsulePanel from 'capsule-ui-kit/CapsulePanel';
import { deriveTileState, controlVerbForRow, frameFreshnessText, presentedFrameHandle, TILE_ERROR_DISPLAY_STATUS } from './tileStates.js';
import './wall.css';

const props = defineProps({
  capsuleId: { type: String, required: true },
  projectionView: {
    type: /** @type {import('vue').PropType<ProjectionViewLike>} */ (Object),
    required: true,
  },
  intentBuilders: {
    type: /** @type {import('vue').PropType<IntentBuildersLike>} */ (Object),
    required: true,
  },
  controlRegistry: {
    type: /** @type {import('vue').PropType<ControlRegistryLike>} */ (Object),
    required: true,
  },
  scheduler: {
    type: /** @type {import('vue').PropType<SchedulerLike>} */ (Object),
    required: true,
  },
  tileScheduler: {
    type: /** @type {import('vue').PropType<TileSchedulerLike|null>} */ ([Object, null]),
    required: true,
  },
  presentationInstance: { type: String, required: true },
  hasKeyboardOwnership: { type: Boolean, default: false },
  title: { type: String, default: '' },
});

const emit = defineEmits(['submit-intent', 'presentation-intent', 'activate-surface']);

validatePanelDeps({
  capsuleId: props.capsuleId,
  presentationInstance: props.presentationInstance,
  projectionView: props.projectionView,
  intentBuilders: props.intentBuilders,
  controlRegistry: props.controlRegistry,
  scheduler: props.scheduler,
  tileScheduler: props.tileScheduler,
});

// Object dependencies travel by injection: the kit panel reads the view, scheduler
// and registry through its documented inject fallback, and the frames lane reads
// the tile scheduler under the same key it injects.
provide('tileScheduler', props.tileScheduler);
provide('publicProjectionView', props.projectionView);
// Metadata-only authority runtimes can omit these optional kit capabilities.
// Empty placeholders must not masquerade as callable scheduler/registry APIs.
provide('presentationScheduler', typeof props.scheduler.updateSurfaceState === 'function'
  && typeof props.scheduler.foldSurface === 'function' && typeof props.scheduler.unfoldSurface === 'function'
  ? props.scheduler : null);
provide('controlRegistry', typeof props.controlRegistry.register === 'function'
  && typeof props.controlRegistry.markNeedsRevalidation === 'function' ? props.controlRegistry : null);

const snapshot = shallowRef(props.projectionView.getSnapshot());
/** @type {(() => void)|null} */
let unsubscribe = null;
function unbindView() {
  if (typeof unsubscribe === 'function') unsubscribe();
  unsubscribe = null;
}
/** @param {ProjectionViewLike} view */
function bindView(view) {
  unbindView();
  snapshot.value = view.getSnapshot();
  unsubscribe = view.subscribe((/** @type {PanelProjectionSnapshot|null} */ next) => {
    snapshot.value = next;
  });
}
bindView(props.projectionView);
watch(() => props.projectionView, (next) => { bindView(next); });
onBeforeUnmount(() => { unbindView(); });
// Presentation witness revision: the tile scheduler notifies outside the
// projection feed, so the badge re-reads its instrumentation per notice.
// Schedulers without the presentation API keep the legacy badge path.
const presentationRevision = shallowRef(0);
/** @type {unknown} */
let stopPresentation = null;
function unbindPresentation() {
  if (typeof stopPresentation === 'function') stopPresentation();
  stopPresentation = null;
}
/** @param {TileSchedulerLike|null} scheduler */
function bindPresentation(scheduler) {
  unbindPresentation();
  if (typeof scheduler?.subscribePresentation === 'function') {
    stopPresentation = scheduler.subscribePresentation(() => { presentationRevision.value += 1; });
  }
  presentationRevision.value += 1;
}
bindPresentation(props.tileScheduler);
watch(() => props.tileScheduler, (next) => { bindPresentation(next); });
onBeforeUnmount(() => { unbindPresentation(); });

const row = computed(() => findSurfaceRow(snapshot.value, props.capsuleId));
// Last admitted row for this capsule. A missing row with a resident feed
// means the surface departed (lost), not that it never arrived; recovery
// (the row returns) flows through the normal derivation again.
const lastRow = shallowRef(/** @type {PanelSurfaceRow|null} */ (null));
watch([() => props.capsuleId, () => props.projectionView, row],
  ([id, view, current], [previousId, previousView]) => {
    if (id !== previousId || view !== previousView) lastRow.value = null;
    if (current !== null) lastRow.value = current;
  }, { immediate: true });
// Seven tile states share one derivation: the kit status label, the tile-state
// treatment class and the control verb all read this decision, props in only.
const tile = computed(() => {
  const snapshotValue = snapshot.value;
  const decision = deriveTileState(snapshotValue, row.value, lastRow.value);
  const labels = new Map([['folded', 'Folded'], ['human-control', 'Human control'], ['agent-acting', 'Agent acting']]);
  return decision.status === 'Live'
    ? { ...decision, status: labels.get(decision.tile) ?? decision.status }
    : decision;
});
// Latest admitted frame identity on live-axis tiles only: connecting tiles
// keep the placeholder with no frame claim, and lost/error tiles keep the
// typed status row. Plain text (never a live region): it changes per frame.
const freshness = computed(() => {
  void presentationRevision.value;
  const state = tile.value.tile;
  if (state === 'connecting' || state === 'lost' || state === 'error') return '';
  // The scheduler has the final say on presentation: an affirmative
  // nothing-presented witness hides the badge so it never shares the tile
  // with the waiting placeholder; unknowable presentation keeps the
  // admitted-generation badge.
  if (presentedFrameHandle(props.tileScheduler, props.capsuleId,
    (row.value ?? lastRow.value)?.generation, snapshot.value?.envelope?.epoch) === '') {
    return '';
  }
  return frameFreshnessText(lastRow.value);
});
// Single-statement status line: lost tiles always name their state, while
// error tiles defer to the kit readiness banner when the row carries one
// (the banner owns the message) and otherwise state the typed copy once.
const kitBannerShown = computed(() => {
  const readiness = row.value?.readinessError;
  return typeof readiness === 'object' && readiness !== null;
});
const bodyStatus = computed(() => {
  if (tile.value.tile === 'lost') return tile.value.status;
  if (tile.value.tile === 'error' && !kitBannerShown.value) return TILE_ERROR_DISPLAY_STATUS;
  return '';
});
// [TARGET, unit decision] Authoritative visibility drives the display branch;
// pending UI gestures do not fold capture or change core-owned state.
watch(row, (current) => {
  const method = current?.visibility === 'folded' ? props.tileScheduler?.foldSurface : props.tileScheduler?.unfoldSurface;
  if (current && typeof method === 'function') method(current.surfaceId);
}, { immediate: true });
const drawable = computed(() => isDrawableRow(row.value));
const surfaceHostVisible = computed(() => isSurfaceHostVisible(row.value));
const uiPhase = shallowRef('idle');
watch(() => [row.value?.visibility, row.value?.control, row.value?.backendLifecycle],
  () => { uiPhase.value = 'idle'; });

// One gesture emits one intent. Only the kit panel's specialized emits are wired;
// its generic submit-intent stays unwired so a gesture can never submit twice.
// Handlers without an authoritative row stay silent instead of inventing identity.
function onFoldChange() {
  const current = row.value;
  if (current === null) return;
  const verb = current.visibility === 'folded' ? 'unfold' : 'fold';
  uiPhase.value = verb === 'fold' ? 'folding' : 'unfolding';
  emit('submit-intent', props.intentBuilders.visibility({ capsuleId: props.capsuleId, verb }));
}

function onPinChange() {
  const current = row.value;
  if (current === null) return;
  const pinned = current.visibility !== 'pinned';
  emit('submit-intent',
    props.intentBuilders.visibility({ capsuleId: props.capsuleId, verb: 'pin', pinned }));
}

/** @param {unknown} payload */
function onControlRequest(payload) {
  const current = row.value;
  if (current === null) return;
  const record = typeof payload === 'object' && payload !== null
    ? /** @type {Record<string, unknown>} */ (payload)
    : {};
  const asked = record.verb;
  const verb = controlVerbForRow(current, asked);
  uiPhase.value = verb === 'take_control' ? 'taking-control' : 'releasing-control';
  emit('submit-intent', props.intentBuilders.control({ capsuleId: props.capsuleId, verb }));
}

function onClosePanel() {
  emit('presentation-intent',
    props.intentBuilders.presentation({ capsuleId: props.capsuleId, verb: 'close' }));
}

function onDockBack() {
  emit('presentation-intent',
    props.intentBuilders.presentation({ capsuleId: props.capsuleId, verb: 'dock-back' }));
}

function onActivateSurface() {
  emit('activate-surface', Object.freeze({ capsuleId: props.capsuleId }));
}
</script>
<template>
  <div class="mv-tile" :data-tile-state="tile.tile" :data-error-code="row?.refusal?.code ?? snapshot?.error?.code">
  <CapsulePanel
    :capsule-id="props.capsuleId"
    :external-ai-slot="true"
    :presentation-status="tile.tile === 'error' ? 'Surface update unavailable' : tile.status"
    :placeholder-title="props.title"
    :presentation-instance="props.presentationInstance"
    :has-keyboard-ownership="props.hasKeyboardOwnership"
    @activate-surface="onActivateSurface"
    @fold-change="onFoldChange"
    @pin-change="onPinChange"
    @control-request="onControlRequest"
    @close-panel="onClosePanel"
    @dock-back="onDockBack"
  >
    <template #surface>
      <div :hidden="!surfaceHostVisible" class="mv-surface-host">
        <p :hidden="freshness === ''" class="mv-tile-freshness">{{ freshness }}</p>
        <div :hidden="tile.tile === 'lost' || tile.tile === 'error'" class="mv-tile-capture-host">
          <slot name="surface" :capsule-id="props.capsuleId" :surface="row" :drawable="drawable" />
        </div>
        <p :hidden="bodyStatus === ''" role="status" class="mv-tile-status">{{ bodyStatus }}</p>
      </div>
    </template>
  </CapsulePanel>
  </div>
</template>
