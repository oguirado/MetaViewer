<script setup>
import { UiButton } from 'capsule-ui-kit/ui';
import SidebarIcon from '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue';
/**
 * MetaViewer AI multislot host (lane U3): one capsule live surface with its
 * attached real-login-shell terminal, travelling together on the kit
 * AiMultiSlot shell. The host owns the MetaViewer bindings only: provider
 * menu entries from host data, the READ/WRITE operator input mode (READ
 * drops operator keystrokes at the kit lease and at the host writer),
 * Copy-capsule-ID against an injected clipboard, and the facade-to-registry
 * pump. Presentation props supplied by the parent are controlled; omitted props use
 * local presentation state. Intents are emitted for the host journal. Launch requests
 * validate against the advertised broker commands; without a broker they
 * project a typed refusal row, never a crash and never raw broker text.
 * Session outcomes (exited/failed) project as a typed notice row with a
 * dismiss control; a pending row covers the launch window.
 */
import { computed, getCurrentInstance, markRaw, onBeforeUnmount, onMounted, onUpdated, ref, toRaw, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import AiMultiSlot from '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue';
import AiSlotControlBar from '/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue';
import { createStreamRegistry } from 'capsule-ui-kit/TerminalView';
import { createTerminalDocument } from '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js';
import BrokerLaunchControls from '../terminal/BrokerLaunchControls.vue';
import {
  createSideTerminalFacade,
  createSideTerminalBrokerFacade,
  normalizeTerminalOutcome,
  terminalLifecycleRefs,
  toPaneSession,
} from '../terminal/sideTerminalFacade.js';
import {
  createGatedTerminalWriter,
  buildMultislotFoldIntent,
  buildMultislotFloatIntent,
  buildMultislotHideIntent,
  buildMultislotMoveIntent,
  buildMultislotShowIntent,
  buildMultislotTabIntent,
  leaseForInputMode,
  normalizeMultislotInputMode,
  parsePlacementIndex,
  roundFloatBox,
  MULTISLOT_DOCK_GROUP,
  MULTISLOT_DOCK_INDEX,
} from './multislotInputGate.js';
import { MULTISLOT_ATTACH_EPOCH, MULTISLOT_ATTACH_GENERATION, createMultislotPump } from './multislotAttach.js';
import {
  CUSTOM_LAUNCH_ENTRY_ID,
  LAUNCH_REFUSALS,
  PROVIDER_DATA_REFUSAL,
  toKitMenuProviders,
  validateLaunchRequest,
} from './multislotProviders.js';
import { createCopyCapsuleId } from './multislotCopy.js';
import './multislot.css';

/** @typedef {import('vue').PropType<{ session: string, port: MessagePort } | null>} TerminalBindingProp */
/** @typedef {import('vue').PropType<{ writeText: (text: string) => Promise<void> } | null>} ClipboardProp */
/** @typedef {{ sessionId: string, title?: string, kind?: string, activity?: string }} PaneSession */

const props = defineProps({
  terminalBroker: { type: /** @type {import('vue').PropType<ReturnType<typeof import('../core/hostAdapters.js').createTerminalBroker>>} */ (Object), default: null },
  capsuleId: { type: String, required: true },
  capsuleLabel: { type: String, default: '' },
  terminalBinding: { type: /** @type {TerminalBindingProp} */ (Object), default: null },
  hostProviders: { type: /** @type {import('vue').PropType<unknown[]>} */ (Array), default: () => [] },
  brokerCommands: { type: /** @type {import('vue').PropType<string[]>} */ (Array), default: () => [] },
  inputMode: { type: String, default: 'read' },
  folded: { type: Boolean, default: false },
  floating: { type: Boolean, default: false },
  surfaceHidden: { type: Boolean, default: false },
  terminalHidden: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false },
  groupId: { type: String, default: '' },
  placementIndex: { type: Number, default: null },
  // MVUI16 lane P (ARG-pmui-3): dock target displaced by the current float.
  lastDockGroupId: { type: String, default: '' },
  lastDockIndex: { type: Number, default: null },
  floatX: { type: Number, default: null },
  floatY: { type: Number, default: null },
  floatWidth: { type: Number, default: null },
  floatHeight: { type: Number, default: null },
  layoutPending: { type: Boolean, default: false },
  agentControlled: { type: Boolean, default: false },
  measureSlotBox: { type: /** @type {import('vue').PropType<(() => unknown) | null>} */ (Function), default: null },
  attachSide: { type: String, default: 'bottom' },
  surfaceState: { type: String, default: 'live' },
  clipboard: { type: /** @type {ClipboardProp} */ (Object), default: null },
});

const emit = defineEmits([
  'update:inputMode',
  'submit-intent',
  'launch-refused',
  'select-session',
  'close-session',
  'request-attach',
  'request-stop',
  'request-replay',
  'select-target',
  'confirm-staged-paste',
]);

class MvSlotTerminal extends Terminal {
  /** @param {any} options */
  constructor(options) {
    super({ ...options, documentOverride: createTerminalDocument(globalThis.document) });
  }
}

const instance = getCurrentInstance();
const mode = computed(() => normalizeMultislotInputMode(props.inputMode));
const hasLease = computed(() => leaseForInputMode(mode.value));
const foldedRef = ref(props.folded === true);
const floatingRef = ref(props.floating === true);
const surfaceVisibleRef = ref(props.surfaceHidden !== true);
const terminalVisibleRef = ref(props.terminalHidden !== true);
const hiddenRef = ref(props.hidden === true);
const copyState = ref('ready');
/** @type {import('vue').Ref<{ code: string, message: string } | null>} */
const refusal = ref(null);
/** Typed placement refusal row (codes stay in data attributes).
 * @type {import('vue').Ref<{ code: string, message: string } | null>} */
const placementRefusal = ref(null);
/** Placement form state: free-form group plus a 0..255 index. */
const placementGroup = ref('');
const placementIndexInput = ref('');
/** @type {import('vue').Ref<unknown>} */
const slotWrap = ref(null);
/** Local placement gate: pending, agent control, READ mode, then hidden
 * (show is the way out). Fold/unfold keep the hidden check only. Mirrors
 * the App dispatchMultislot guards; parity is pinned by mvui11-layout tests.
 * @param {string} op
 * @returns {{ code: string, message: string } | null} Refusal, or null when allowed.
 */
function placementBarrier(op) {
  const placement = op !== 'fold' && op !== 'unfold';
  if (placement && props.layoutPending === true) {
    return { code: 'ERR_PLACEMENT_PENDING', message: 'Placement request pending.' };
  }
  if (placement && props.agentControlled === true) {
    return { code: 'LAYOUT_INPUT_MODE_READ', message: 'Placement is unavailable while the agent controls this slot.' };
  }
  if (placement && mode.value !== 'write') {
    return { code: 'ERR_INPUT_MODE_READ', message: 'Switch to WRITE mode to place this slot.' };
  }
  if (op === 'show') {
    return hiddenRef.value
      ? null
      : { code: 'LAYOUT_ILLEGAL_TRANSITION', message: 'This placement change is unavailable.' };
  }
  if (hiddenRef.value) {
    return { code: 'LAYOUT_ILLEGAL_TRANSITION', message: 'This placement change is unavailable.' };
  }
  return null;
}
const floatAccess = computed(() => placementBarrier('float'));
const hideAccess = computed(() => placementBarrier('hide'));
const moveAccess = computed(() => placementBarrier('move'));
const showAccess = computed(() => placementBarrier('show'));
/** Typed session-outcome row (exited/failed); codes stay in data attributes.
 * @type {import('vue').Ref<{ type: string, sessionId: string, code: string, message: string, tone: string } | null>} */
const sessionNotice = ref(null);
const lifecycleRefs = computed(() => terminalLifecycleRefs(props.capsuleId));
/** @type {import('vue').Ref<PaneSession[]>} */
const sessions = ref([]);
const selectedSessionId = ref('');
/** @type {import('vue').Ref<'detached'|'attaching'|'restoring'|'live'|'disconnected'>} */
const attachmentState = ref(props.terminalBinding ? 'attaching' : 'detached');
/** @type {import('vue').Ref<'unknown'|'ready'|'busy'|'waiting-input'|'waiting-permission'|'exited'|'failed'>} */
const activityState = ref('unknown');
const launchingRef = ref(false);
/** @type {import('vue').Ref<string[]>} */
const capabilityCommands = ref([]);
const launchFacade = computed(() => createSideTerminalBrokerFacade(props.terminalBroker));
const commandsRef = computed(() => [...new Set([...props.brokerCommands, ...capabilityCommands.value, ...(launchFacade.value?.canOpen && launchFacade.value.state.enabled ? ['shell', 'provider'] : [])])]);
/** @type {import('vue').Ref<Array<{ id: string, label: string, hint: string, argv: readonly string[], command: string | undefined }>>} */
const kitProviders = ref([...toKitMenuProviders([])]);
const menuIds = computed(() => [...kitProviders.value.map((entry) => entry.id), CUSTOM_LAUNCH_ENTRY_ID]);
const refusalId = computed(() => `mv-multislot-${props.capsuleId}-refusal`);
const refusalAnchor = computed(() => `capsule/${props.capsuleId}/launch-refusal`);
const refusalDismissId = computed(() => `mv-multislot-${props.capsuleId}-refusal-dismiss`);
const refusalDismissAnchor = computed(() => `capsule/${props.capsuleId}/launch-refusal-dismiss`);

function refreshProviders() {
  try {
    kitProviders.value = [...toKitMenuProviders(props.hostProviders)];
  } catch {
    kitProviders.value = [...toKitMenuProviders([])];
    refusal.value = { code: PROVIDER_DATA_REFUSAL, message: 'Provider list unavailable.' };
  }
}
refreshProviders();
watch(() => props.hostProviders, refreshProviders);
watch(() => props.hidden, (value) => { hiddenRef.value = value; });
watch(() => props.folded, (value) => { foldedRef.value = value; });
watch(() => props.floating, (value) => { floatingRef.value = value; });
watch(() => props.surfaceHidden, (value) => { surfaceVisibleRef.value = !value; });
watch(() => props.terminalHidden, (value) => { terminalVisibleRef.value = !value; });
// MVUI16 lane P (ARG-pmui-6, memory-safe): the host stays mounted while the
// rail switches capsules, so placement refusal + drafts reset on capsule id.
// Primitive-id getter; the local refs it resets are never read by the getter.
watch(() => props.capsuleId, () => { placementRefusal.value = null; placementGroup.value = ''; placementIndexInput.value = ''; });

/** @type {ReturnType<typeof createSideTerminalFacade> | null} */
let facade = null;
/** @type {ReturnType<typeof createMultislotPump> | null} */
let pump = null;
/** @type {Set<ReturnType<typeof createSideTerminalFacade>>} */
const pendingFacades = new Set();
let bindingGeneration = 0;
let brokerGeneration = 0;
let unmounted = false;

const gatedWriter = createGatedTerminalWriter({
  // The facade reference swaps on rebind; resolve it per write.
  facade: { write: (/** @type {{ session: string, bytes: number[] }} */ input) => facade?.write(input) },
  getInputMode: () => props.inputMode,
});

const registry = markRaw(
  createStreamRegistry({
    TerminalClass: MvSlotTerminal,
    FitAddonClass: FitAddon,
    onSendAuthorizedPtyInput: (/** @type {{ sessionId: string, data: string }} */ payload) => {
      gatedWriter.write({
        session: payload.sessionId,
        bytes: Array.from(new TextEncoder().encode(payload.data)),
      });
    },
  }),
);

/**
 * @param {{ type: string, sessionId: string }} event
 */
function onPumpEvent(event) {
  const outcome = event.type === 'failed' ? 'failed' : 'exited';
  sessionNotice.value = normalizeTerminalOutcome({ type: outcome, sessionId: event.sessionId });
  sessions.value = sessions.value.filter((item) => item.sessionId !== event.sessionId);
  if (selectedSessionId.value === event.sessionId) selectedSessionId.value = sessions.value[0]?.sessionId ?? '';
  attachmentState.value = sessions.value.length ? 'live' : 'disconnected';
  activityState.value = sessions.value.length ? 'unknown' : outcome;
}

function unbind() {
  bindingGeneration++;
  capabilityCommands.value = [];
  launchingRef.value = false;
  try {
    pump?.dispose();
  } catch {
    // Teardown is best-effort; the empty session list is authoritative.
  }
  pump = null;
  try {
    if (facade && !pendingFacades.has(facade)) facade.dispose();
  } catch {
    // Teardown is best-effort; the empty session list is authoritative.
  }
  facade = null;
  sessions.value = [];
  selectedSessionId.value = '';
  sessionNotice.value = null;
}

function bind() {
  const binding = props.terminalBinding ? toRaw(props.terminalBinding) : null;
  unbind();
  const generation = bindingGeneration;
  if (unmounted || !binding || typeof binding.session !== 'string' || !binding.port) {
    attachmentState.value = 'detached';
    activityState.value = 'unknown';
    return;
  }
  attachmentState.value = 'attaching';
  void (async () => {
    const next = markRaw(createSideTerminalFacade({ session: binding.session, port: toRaw(binding.port) }));
    facade = next;
    pendingFacades.add(next);
    const current = () => !unmounted && bindingGeneration === generation;
    try {
      try {
        const capabilities = await next.capabilities();
        if (!current()) return;
        capabilityCommands.value = Array.isArray(capabilities?.commands)
          ? capabilities.commands.filter((/** @type {unknown} */ item) => typeof item === 'string') : [];
      } catch {
        if (!current()) return;
      }
      const attached = /** @type {{ sessions?: Array<Record<string, any>> }} */ (await next.attach());
      if (!current()) return;
      const active = markRaw(createMultislotPump({
        facade: next, registry, capsuleId: props.capsuleId,
        getInputMode: () => props.inputMode, onEvent: onPumpEvent,
      }));
      pump = active;
      for (const item of attached?.sessions ?? []) {
        try { registerSession(active, item); } catch { /* Isolate malformed attachment records. */ }
      }
      attachmentState.value = sessions.value.length ? 'live' : 'disconnected';
      activityState.value = 'unknown';
    } catch {
      if (!current()) return;
      unbind();
      attachmentState.value = 'disconnected';
      activityState.value = 'unknown';
    } finally {
      // Pending operations own teardown until allocation settles.
      pendingFacades.delete(next);
      if (!current()) { try { next.dispose(); } catch { /* Stale attach cleanup. */ } }
    }
  })().catch(() => {
    if (bindingGeneration !== generation || unmounted) return;
    unbind();
    attachmentState.value = 'disconnected';
  });
}

/** @param {ReturnType<typeof createMultislotPump>} active
 * @param {any} item
 */
function registerSession(active, item) {
  const id = active.attachSession(item);
  sessions.value = [...sessions.value, { ...toPaneSession(id, item) }];
  if (!selectedSessionId.value) selectedSessionId.value = id;
  attachmentState.value = 'live';
  sessionNotice.value = null;
}

onMounted(bind);
watch(() => props.terminalBinding, bind);
watch(() => props.terminalBroker, () => {
  brokerGeneration++;
  launchingRef.value = false;
}, { flush: 'sync' });
watch(
  () => props.inputMode,
  () => {
    try {
      pump?.syncLease();
    } catch {
      // The kit prop projection below still gates the next keystroke.
    }
  },
);
onBeforeUnmount(() => {
  unmounted = true;
  unbind();
  // Current kit registry exposes per-session disposal (performed by pump).
  // Honor whole-registry disposal if a future registry adds it.
  const disposable = /** @type {{ dispose?: () => void }} */ (registry);
  disposable.dispose?.();
});

async function runCopy() {
  copyState.value = 'copying';
  const action = createCopyCapsuleId({ clipboard: props.clipboard });
  const outcome = await action.copy(props.capsuleId);
  copyState.value = outcome.state;
}

/**
 * @param {{ type?: unknown }} intent Kit slot intent.
 */
function onSubmitIntent(intent) {
  const type = typeof intent?.type === 'string' ? intent.type : '';
  if (['fold','unfold'].includes(type) && hiddenRef.value) {
    placementRefusal.value = { code:'LAYOUT_ILLEGAL_TRANSITION', message:'Show this slot before changing its placement.' };
    return;
  }
  if (['move','tab','float','dock-back','hide','show'].includes(type)) {
    requestPlacement(type);
    return;
  }
  // Explicit props await parent acceptance. Omitted props retain the local
  // presentation mode for standalone hosts without a controlling parent.
  const supplied = instance?.vnode.props ?? {};
  const controlled = (/** @type {string} */ camel, /** @type {string} */ kebab = camel) =>
    Object.prototype.hasOwnProperty.call(supplied, camel) || Object.prototype.hasOwnProperty.call(supplied, kebab);
  if (type === 'input-mode-read' || type === 'input-mode-write') {
    // MVUI16D lane P (L2-1): input mode is a purely local lease toggle.
    emit('update:inputMode', type === 'input-mode-write' ? 'write' : 'read');
    return;
  }
  if (type === 'copy-id') {
    void runCopy();
    return;
  }
  if (type === 'fold' || type === 'unfold') {
    if (!controlled('folded')) foldedRef.value = type === 'fold';
    // Bind to AiMultiSlot.multislotDomIds().root (pinned by the mounted test),
    // never substitute a surface id for a slot id.
    emit('submit-intent', buildMultislotFoldIntent(type, props.capsuleId), props.capsuleId);
    return;
  }
  // MVUI16D lane P (L2-1): half-view toggles are purely local presentation.
  // Only exact ui_intent/v0.2 bodies (fold, unfold, placement) are host-bound.
  if (type === 'hide-surface' || type === 'show-surface') {
    if (!controlled('surfaceHidden', 'surface-hidden')) surfaceVisibleRef.value = type === 'show-surface';
    return;
  }
  if (type === 'hide-terminal' || type === 'show-terminal') {
    if (!controlled('terminalHidden', 'terminal-hidden')) terminalVisibleRef.value = type === 'show-terminal';
    return;
  }
}

/** Build only admitted closed bodies; never mutate the presentation here.
 * @param {string} type */
function requestPlacement(type) {
  const op = type === 'dock-back' ? 'move' : type;
  const blocked = placementBarrier(op);
  if (blocked) { placementRefusal.value = blocked; return; }
  try {
    let body;
    if (op === 'hide') body = buildMultislotHideIntent(props.capsuleId);
    else if (op === 'show') body = buildMultislotShowIntent(props.capsuleId);
    else if (op === 'float') {
      const root = /** @type {HTMLElement|null} */ (slotWrap.value);
      const box = roundFloatBox(props.measureSlotBox ? props.measureSlotBox() : root?.querySelector?.('.ai-slot')?.getBoundingClientRect());
      body = buildMultislotFloatIntent(props.capsuleId, box);
    // MVUI16 lane P (ARG-pmui-3): dock-back returns to the pre-float dock
    // target when the parent kept one, else the live props, else the default.
    } else if (type === 'dock-back') body = buildMultislotMoveIntent(props.capsuleId,
      props.lastDockGroupId || props.groupId || MULTISLOT_DOCK_GROUP,
      props.lastDockIndex ?? props.placementIndex ?? MULTISLOT_DOCK_INDEX);
    else {
      const build = op === 'tab' ? buildMultislotTabIntent : buildMultislotMoveIntent;
      body = build(props.capsuleId, placementGroup.value, parsePlacementIndex(placementIndexInput.value));
    }
    placementRefusal.value = null;
    emit('submit-intent', body, props.capsuleId);
  } catch {
    placementRefusal.value = { code:'ERR_INVALID_PLACEMENT_INPUT', message:'Choose a valid group and position, then try again.' };
  }
}
// The vendored shell has a second float control without a disabled prop.
// Keep its existing id/anchor and apply the same accessible native gate.
function syncShellPlacementGate() {
  const root = /** @type {HTMLElement|null} */ (slotWrap.value);
  const button = root?.querySelector?.(`[id="cuk-ai-slot-${props.capsuleId}-float"]`);
  if (!button) return;
  if (floatAccess.value) button.setAttribute('disabled', ''); else button.removeAttribute('disabled');
  button.setAttribute('aria-describedby', `mv-multislot-${props.capsuleId}-placement-reason`);
  button.setAttribute('aria-busy', String(props.layoutPending));
}
onMounted(syncShellPlacementGate);
onUpdated(syncShellPlacementGate);

/**
 * @param {{ entryId?: unknown, command?: unknown, args?: unknown, title?: unknown, kind?: unknown } | null | undefined} payload
 */
async function onLaunchRequest(payload) {
  const validated = validateLaunchRequest(payload, { commands: commandsRef.value, menuIds: menuIds.value });
  if (validated.ok === false) {
    refusal.value = validated.refusal;
    emit('launch-refused', validated.refusal);
    return;
  }
  const broker = launchFacade.value?.canOpen ? launchFacade.value : facade;
  const opener = launchFacade.value?.canOpen ? launchFacade.value.open : (
    facade && typeof /** @type {{ open?: unknown }} */ (/** @type {unknown} */ (facade)).open === 'function'
      ? /** @type {(spec: { command: string, args: readonly string[], cols: number, rows: number }) => Promise<unknown>} */ (
          /** @type {{ open: unknown }} */ (/** @type {unknown} */ (facade)).open
        )
      : null);
  if (!opener || !pump) {
    const outcome = { code: LAUNCH_REFUSALS.NO_BROKER, message: 'Launch unavailable.' };
    refusal.value = outcome;
    emit('launch-refused', outcome);
    return;
  }
  const generation = bindingGeneration;
  const active = pump;
  const ownerGeneration = brokerGeneration;
  const current = () => generation === bindingGeneration && ownerGeneration === brokerGeneration && !unmounted && active === pump;
  /** @type {unknown} */
  let openedSession;
  // Keep cleanup on the originating broker, even after replacement or rebind.
  async function closeOpenedSession() {
    const item = /** @type {any} */ (openedSession);
    const id = typeof item === 'string' ? item : item?.session;
    openedSession = undefined;
    if (typeof id === 'string') {
      try { await broker?.close({ session: id }); } catch { /* Host cleanup is best-effort. */ }
    }
  }

  launchingRef.value = true;
  try {
    const opened = /** @type {{ session?: unknown }} */ (await opener.call(broker, { command: validated.launch.command, args: validated.launch.args, cols: 80, rows: 24 }));
    openedSession = opened?.session;
    if (!current()) {
      await closeOpenedSession();
      return;
    }
    if (!openedSession) throw new Error('Missing terminal attachment');
    const item = typeof openedSession === 'string'
      ? { session: openedSession, command: validated.launch.command } : openedSession;
    registerSession(active, item);
    openedSession = undefined;
    refusal.value = null;
  } catch {
    await closeOpenedSession();
    if (!current()) return;
    const outcome = { code: LAUNCH_REFUSALS.COMMAND_UNAVAILABLE, message: 'Launch unavailable.' };
    refusal.value = outcome;
    emit('launch-refused', outcome);
  } finally {
    if (current()) launchingRef.value = false;
  }
}

/**
 * @param {{ sessionId?: unknown }} payload
 */
function onSelectSession(payload) {
  if (typeof payload?.sessionId === 'string' && payload.sessionId.length > 0) {
    selectedSessionId.value = payload.sessionId;
  }
  emit('select-session', payload);
}

/**
 * @param {{ sessionId?: unknown }} payload
 */
function onCloseSession(payload) {
  if (typeof payload?.sessionId === 'string' && payload.sessionId.length > 0) {
    try {
      pump?.closeSession(payload.sessionId);
    } catch {
      // Removal from the visible list below is authoritative.
    }
    sessions.value = sessions.value.filter((item) => item.sessionId !== payload.sessionId);
    if (selectedSessionId.value === payload.sessionId) {
      const remaining = sessions.value.map((item) => item.sessionId);
      selectedSessionId.value = remaining.length > 0 ? /** @type {string} */ (remaining[remaining.length - 1]) : '';
    }
    if (sessions.value.length === 0) attachmentState.value = 'disconnected';
  }
  emit('close-session', payload);
}

/**
 * @param {'request-attach'|'request-stop'|'request-replay'|'select-target'|'confirm-staged-paste'} name
 * @returns {(payload: unknown) => void}
 */
function passThrough(name) {
  return (payload) => emit(name, payload);
}
</script>
<template>
  <div ref="slotWrap" class="mv-multislot-host" :aria-busy="layoutPending" :data-layout-group="groupId" :data-layout-index="props.placementIndex">

    <BrokerLaunchControls v-if="terminalBroker" :broker="terminalBroker" :show-menu="false" :anchor-prefix="`capsule/${capsuleId}`" :id-prefix="`mv-multislot-${capsuleId}-broker`" />
    <div :hidden="hiddenRef" class="mv-multislot-pair">
    <AiMultiSlot
      :capsule-id="capsuleId"
      :capsule-label="capsuleLabel"
      :attach-side="attachSide"
      :folded="foldedRef"
      :surface-hidden="!surfaceVisibleRef"
      :terminal-hidden="!terminalVisibleRef"
      :floating="floatingRef"
      :float-x="floatX" :float-y="floatY" :float-width="floatWidth" :float-height="floatHeight"
      :surface-state="surfaceState"
      :input-mode="mode"
      :sessions="sessions"
      :selected-session-id="selectedSessionId"
      :attachment-state="attachmentState"
      :activity-state="activityState"
      :has-control-lease="hasLease"
      :stream-registry="registry"
      :epoch="MULTISLOT_ATTACH_EPOCH"
      :generation="MULTISLOT_ATTACH_GENERATION"
      :providers="kitProviders"
      :commands="commandsRef"
      :launching="launchingRef"
      @submit-intent="onSubmitIntent"
      @select-session="onSelectSession"
      @close-session="onCloseSession"
      @launch-request="onLaunchRequest"
      @request-attach="passThrough('request-attach')"
      @request-stop="passThrough('request-stop')"
      @request-replay="passThrough('request-replay')"
      @select-target="passThrough('select-target')"
      @confirm-staged-paste="passThrough('confirm-staged-paste')"
    >
      <template #controls>
        <AiSlotControlBar
          :capsule-id="capsuleId"
          :capsule-label="capsuleLabel"
          :input-mode="mode"
          :copy-state="copyState"
          :surface-visible="surfaceVisibleRef"
          :terminal-visible="terminalVisibleRef"
          :folded="foldedRef"
          :floating="floatingRef"
          :fold-disabled="hiddenRef" :fold-reason="hiddenRef ? 'Show this slot before changing its placement.' : ''"
          :float-disabled="Boolean(floatAccess)" :float-reason="floatAccess?.message ?? ''"
          @submit-intent="onSubmitIntent"
        />
      </template>
      <template #surface>
        <slot name="surface" />
      </template>
    </AiMultiSlot>
    </div>
    <section v-if="$slots.record" class="mv-multislot-record" aria-label="Recording"><slot name="record" /></section>
    <p
      v-if="launchingRef"
      :id="lifecycleRefs.pending"
      class="mv-multislot__pending"
      role="status"
      :data-semantic-anchor="lifecycleRefs.pendingAnchor"
    >
      Starting session…
    </p>
    <div
      v-if="sessionNotice"
      :id="lifecycleRefs.notice"
      class="mv-multislot__notice"
      :class="{ 'mv-multislot__notice--error': sessionNotice.tone === 'error' }"
      :role="sessionNotice.tone === 'error' ? 'alert' : 'status'"
      :data-semantic-anchor="lifecycleRefs.noticeAnchor"
      :data-outcome-code="sessionNotice.code"
    >
      <p class="mv-multislot__notice-text">{{ sessionNotice.message }}</p>
      <button
        :id="lifecycleRefs.noticeDismiss"
        type="button"
        class="mv-multislot__notice-dismiss"
        :data-semantic-anchor="lifecycleRefs.noticeDismissAnchor"
        aria-label="Dismiss session notice"
        @click="sessionNotice = null"
      >
        <SidebarIcon name="marker" aria-hidden="true" />
        Dismiss
      </button>
    </div>
    <div
      v-if="refusal"
      :id="refusalId"
      class="mv-multislot__refusal"
      role="alert"
      :data-semantic-anchor="refusalAnchor"
      :data-error-code="refusal.code"
    >
      <p class="mv-multislot__refusal-text">{{ refusal.message }}</p>
      <button
        :id="refusalDismissId"
        type="button"
        class="mv-multislot__refusal-dismiss"
        :data-semantic-anchor="refusalDismissAnchor"
        aria-label="Dismiss launch notice"
        @click="refusal = null"
      >
        <SidebarIcon name="marker" aria-hidden="true" />
        Dismiss
      </button>
    </div>
    <section class="mv-multislot-placement" aria-label="Slot placement">
      <p :id="`mv-multislot-${capsuleId}-placement-reason`" role="status">{{ hiddenRef ? showAccess?.message ?? 'Show this slot before changing its placement.' : moveAccess?.message }}</p>
      <UiButton :id="`mv-multislot-${capsuleId}-visibility`" :data-semantic-anchor="`capsule/${capsuleId}/placement/visibility`" type="button"
        :aria-label="hiddenRef ? 'Show slot' : 'Hide slot'" :disabled="Boolean(hiddenRef ? showAccess : hideAccess)" :aria-describedby="`mv-multislot-${capsuleId}-placement-reason`"
        :label="hiddenRef ? 'Show slot' : 'Hide slot'" :loading="layoutPending" @click="requestPlacement(hiddenRef ? 'show' : 'hide')" />
      <label :for="`mv-multislot-${capsuleId}-group`">Group</label>
      <input :id="`mv-multislot-${capsuleId}-group`" :data-semantic-anchor="`capsule/${capsuleId}/placement/group`" aria-label="Placement group"
        :value="placementGroup" @input="placementGroup = /** @type {HTMLInputElement} */ ($event.target).value" :disabled="Boolean(moveAccess)" :aria-describedby="`mv-multislot-${capsuleId}-placement-reason`" maxlength="128" />
      <label :for="`mv-multislot-${capsuleId}-index`">Position</label>
      <input :id="`mv-multislot-${capsuleId}-index`" :data-semantic-anchor="`capsule/${capsuleId}/placement/index`" aria-label="Placement position"
        :value="placementIndexInput" @input="placementIndexInput = /** @type {HTMLInputElement} */ ($event.target).value" :disabled="Boolean(moveAccess)" :aria-describedby="`mv-multislot-${capsuleId}-placement-reason`" inputmode="numeric" maxlength="3" />
      <UiButton v-for="op in ['move','tab']" :key="op" :id="`mv-multislot-${capsuleId}-${op}`" :data-semantic-anchor="`capsule/${capsuleId}/placement/${op}`" type="button"
        :aria-label="op === 'move' ? 'Move slot' : 'Tab slot'" :disabled="Boolean(moveAccess)" :aria-describedby="`mv-multislot-${capsuleId}-placement-reason`" :label="op === 'move' ? 'Move slot' : 'Tab slot'" :loading="layoutPending" @click="requestPlacement(op)" />
      <p v-if="placementRefusal" :id="`mv-multislot-${capsuleId}-placement-refusal`" :data-semantic-anchor="`capsule/${capsuleId}/placement/refusal`"
        role="alert" :data-error-code="placementRefusal.code">{{ placementRefusal.message }}</p>
    </section>
  </div>
</template>
