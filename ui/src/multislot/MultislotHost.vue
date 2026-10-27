<script setup>
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
 */
import { computed, getCurrentInstance, markRaw, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import AiMultiSlot from '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue';
import AiSlotControlBar from '/.kit/capsule-ui-kit/src/multislot/AiSlotControlBar.vue';
import { createStreamRegistry } from 'capsule-ui-kit/TerminalView';
import { createTerminalDocument } from '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js';
import BrokerLaunchControls from '../terminal/BrokerLaunchControls.vue';
import { createSideTerminalFacade, createSideTerminalBrokerFacade } from '../terminal/sideTerminalFacade.js';
import {
  createGatedTerminalWriter,
  buildMultislotFoldIntent,
  leaseForInputMode,
  normalizeMultislotInputMode,
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
const copyState = ref('ready');
/** @type {import('vue').Ref<{ code: string, message: string } | null>} */
const refusal = ref(null);
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
watch(() => props.folded, (value) => { foldedRef.value = value; });
watch(() => props.floating, (value) => { floatingRef.value = value; });
watch(() => props.surfaceHidden, (value) => { surfaceVisibleRef.value = !value; });
watch(() => props.terminalHidden, (value) => { terminalVisibleRef.value = !value; });

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
  sessions.value = [...sessions.value, {
    sessionId: id, title: typeof item?.title === 'string' ? item.title : id,
    kind: typeof item?.kind === 'string' ? item.kind : '', activity: 'unknown',
  }];
  if (!selectedSessionId.value) selectedSessionId.value = id;
  attachmentState.value = 'live';
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
  if (type === 'input-mode-read' || type === 'input-mode-write') {
    emit('update:inputMode', type === 'input-mode-write' ? 'write' : 'read');
  } else if (type === 'copy-id') {
    void runCopy();
  } else {
    // Explicit props await parent acceptance. Omitted props retain the local
    // presentation mode for standalone hosts without a controlling parent.
    const supplied = instance?.vnode.props ?? {};
    const controlled = (/** @type {string} */ camel, /** @type {string} */ kebab = camel) =>
      Object.prototype.hasOwnProperty.call(supplied, camel) || Object.prototype.hasOwnProperty.call(supplied, kebab);
    if (!controlled('folded') && (type === 'fold' || type === 'unfold')) foldedRef.value = type === 'fold';
    if (!controlled('floating') && (type === 'float' || type === 'dock-back')) floatingRef.value = type === 'float';
    if (!controlled('surfaceHidden', 'surface-hidden') && (type === 'hide-surface' || type === 'show-surface')) surfaceVisibleRef.value = type === 'show-surface';
    if (!controlled('terminalHidden', 'terminal-hidden') && (type === 'hide-terminal' || type === 'show-terminal')) terminalVisibleRef.value = type === 'show-terminal';
  }
  // Bind to AiMultiSlot.multislotDomIds().root (pinned by the mounted test),
  // never substitute a surface id for a slot id.
  emit('submit-intent', type === 'fold' || type === 'unfold'
    ? buildMultislotFoldIntent(type, props.capsuleId)
    : intent, props.capsuleId);
}

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
  <div class="mv-multislot-host">
    <BrokerLaunchControls v-if="terminalBroker" :broker="terminalBroker" :show-menu="false" :anchor-prefix="`capsule/${capsuleId}`" :id-prefix="`mv-multislot-${capsuleId}-broker`" />
    <AiMultiSlot
      :capsule-id="capsuleId"
      :capsule-label="capsuleLabel"
      :attach-side="attachSide"
      :folded="foldedRef"
      :surface-hidden="!surfaceVisibleRef"
      :terminal-hidden="!terminalVisibleRef"
      :floating="floatingRef"
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
          @submit-intent="onSubmitIntent"
        />
      </template>
      <template #surface>
        <slot name="surface" />
      </template>
    </AiMultiSlot>
    <section v-if="$slots.record" class="mv-multislot-record" aria-label="Recording"><slot name="record" /></section>
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
        Dismiss
      </button>
    </div>
  </div>
</template>
