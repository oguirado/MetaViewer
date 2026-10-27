<script setup>
/** The optional runtime supplies authoritative rows and the tile scheduler.
 * Canvas status reads successful presentation witnesses; bytes stay external.
 */
import { computed, defineComponent, h, inject, markRaw, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import CreativeCapsule from './creative/CreativeCapsule.vue';
import HostOutcome from './core/HostOutcome.vue';
import DockWorkspace from 'capsule-ui-kit/DockWorkspace';
import { ShellWorkspace, TopBar, Sidebar, StatusBar } from '../.kit/capsule-ui-kit/src/index-shell.js';
import EmptyWallView from './wall/EmptyWallView.vue';
import CatalogLauncher from './catalog/CatalogLauncher.vue';
import SideTerminalOverlay from './terminal/SideTerminalOverlay.vue';
import MultislotHost from './multislot/MultislotHost.vue';
import MvRecordingPanel from './recording/MvRecordingPanel.vue';
import MvSettingsPanel from './settings/MvSettingsPanel.vue';
import AgentLaneHost from './agent/AgentLaneHost.vue';
import ActivityStrip from './activity/ActivityStrip.vue';
import { resolveNestedMode, applyNestedWall } from './nested/nested.js';
import { UiButton } from 'capsule-ui-kit/ui';
import { setKitScheme } from 'capsule-ui-kit/theme';
import WallWorkspace from './wall/WallWorkspace.vue';
import SurfaceCanvas from './surfaces/SurfaceCanvas.vue';
import { createTileScheduler } from './surfaces/tileScheduler.js';
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileEnvelope} LayoutProfile */
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileScope} LayoutScope */
/** @typedef {Pick<InstanceType<typeof WallWorkspace>['$props'], 'projectionView'|'intentBuilders'|'controlRegistry'|'scheduler'|'tileScheduler'>} WallRuntime */
/** @typedef {{readRaw:()=>Promise<string|null>,writeAtomic:(json:string)=>Promise<void>}} LayoutStorage */
const props = defineProps({
  authorityHost: { type: /** @type {import('vue').PropType<ReturnType<typeof import('./core/hostAdapters.js').createAuthorityAdapter>|null>} */ (Object), default: null },
  terminalBroker: { type: /** @type {import('vue').PropType<ReturnType<typeof import('./core/hostAdapters.js').createTerminalBroker>>} */ (Object), default: null },
  // MVUI9 lane A: reactive capture store built by the entry (lane C
  // `createCaptureState` shape, read structurally so App never imports
  // the port). Null keeps the legacy intent path.
  captureState: { type: Object, default: null },
  // MVUI9 lane A: false when no capture facade backs the store (or the
  // store is absent); the wall binding then passes undefined (the wall
  // default null applies, so the wall still sees null) and the panel
  // renders its controls disabled with the fixed unavailable reason.
  captureAvailable: { type: Boolean, default: false },
  settingsHost: { type: /** @type {import('vue').PropType<import('./settings/settingsModel.js').HostSettingsPort|null>} */ (Object), default: null },
  preferences: { type: /** @type {import('vue').PropType<Storage|null>} */ (Object), default: null },
  exportDestination: { type: String, default: '' },
  fixture: { type: /** @type {import('vue').PropType<import('./fixtures/states.js').FixtureState|null>} */ (Object), default: null },
  nestedHost: { type: /** @type {import('vue').PropType<import('./nested/nested.js').NestedHost|null>} */ (Object), default: null },
  runtime: { type: /** @type {import('vue').PropType<WallRuntime|null>} */ (Object), default: null },
  terminal: { type: /** @type {import('vue').PropType<{session:string,port:MessagePort}|null>} */ (Object), default: null },
  layout: { type: /** @type {import('vue').PropType<LayoutProfile>} */ (Object), required: true },
  scope: { type: /** @type {import('vue').PropType<LayoutScope>} */ (Object), required: true },
  storage: { type: /** @type {import('vue').PropType<LayoutStorage>} */ (Object), required: true },
});
const settled = ref(false);
/** @typedef {Readonly<{code:string, saveRefused:boolean}>} LayoutUnavailableRow */
const layoutUnavailable = ref(/** @type {LayoutUnavailableRow|null} */ (null));
// The preload adapter continues to reject failed reads. Only this presentation
// boundary supplies an explicit in-memory default, with a session-long write lock.
// Never turn a failed read into the kit's writable "missing profile" null path.
const workspaceStorage = markRaw({
  readRaw: async () => {
    if (layoutUnavailable.value) return JSON.stringify(props.layout);
    try { return await props.storage.readRaw(); }
    catch (error) {
      const code = String(error).match(/\bLAYOUT_[A-Z_]+\b/)?.[0] ?? 'LAYOUT_LOAD_FAILED';
      const current = /** @type {LayoutUnavailableRow|null} */ (layoutUnavailable.value);
      if (!current?.saveRefused) layoutUnavailable.value = Object.freeze({ code, saveRefused: false });
      return JSON.stringify(props.layout);
    }
  },
  writeAtomic: async (/** @type {string} */ json) => {
    if (layoutUnavailable.value) {
      layoutUnavailable.value = Object.freeze({ code: 'LAYOUT_SAVE_REFUSED', saveRefused: true });
      throw new Error('LAYOUT_SAVE_REFUSED');
    }
    try { await props.storage.writeAtomic(json); }
    catch (error) {
      if (layoutUnavailable.value || /\bLAYOUT_SAVE_REFUSED\b/.test(String(error))) {
        layoutUnavailable.value = Object.freeze({ code: 'LAYOUT_SAVE_REFUSED', saveRefused: true });
      }
      throw error;
    }
  },
});
const unavailable = Object.freeze({ status: 'unavailable', stale: true, envelope: null,
  error: Object.freeze({ code: 'PROJECTION_UNAVAILABLE', message: 'Authoritative surface feed unavailable' }) });
const projectionView = markRaw({
  getProjection: () => null,
  getSnapshot: () => unavailable,
  subscribe: () => () => {},
});
function refuseAuthority() { throw new Error('Authoritative intent gateway unavailable'); }
const intentBuilders = markRaw({ visibility: refuseAuthority, control: refuseAuthority, presentation: refuseAuthority });
const controlRegistry = markRaw({});
const scheduler = markRaw({});
const tileScheduler = markRaw(createTileScheduler({ budget: Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
}) }));
onBeforeUnmount(() => tileScheduler.destroy());
/** Host adapters and optional terminal preferences are supplied by the entry.
 * Launcher reveals admitted rows only; no fabricated core creation API. */
provide('capsuleChromeStyle', 'openvue');
const preferences = props.preferences;
const scheme = ref(props.fixture?.scheme === 'mv-dark' ? 'mv-dark' : 'mv-light');
const applyScheme = /** @type {(scheme:string)=>void} */ (setKitScheme);
applyScheme(scheme.value);
document.documentElement.dataset.themeDensity = 'compact';
/** @param {string} next */
function onScheme(next) { scheme.value = next === 'mv-dark' ? 'mv-dark' : 'mv-light'; }
const nestedMode = resolveNestedMode(props.nestedHost ?? (props.fixture?.key === 'nested'
  ? { getNestedDepth: () => 1, getSelfCapsuleId: () => null } : null));
const launcherOpen = ref(props.fixture?.ui.launcherOpen === true);
const railOpen = ref(false);
const settingsOpen = ref(props.fixture?.screen === 'settings');
const creativeOpen = ref(props.fixture?.key === 'creative');
const creativeFrames = computed(() => /** @type {unknown[]} */ (props.fixture?.ui.creativeFrames ?? []));
const terminalOpen = ref(props.fixture?.key === 'side-terminal-open');
const multislotOpen = ref(['multislot', 'recording'].includes(props.fixture?.key ?? ''));
const selectedCapsuleId = ref(props.fixture?.capsules[0]?.id ?? '');
const inputMode = ref('read');
// App owns the controlled presentation until the authoritative row changes.
const foldOverrides = ref(/** @type {Record<string, boolean>} */ ({}));
const selectedFolded = computed(() => selectedSurface.value
  ? foldOverrides.value[selectedSurface.value.id] ?? selectedSurface.value.visibility === 'folded' : false);
const selectedSurface = computed(() => rows.value.find(row => row.id === selectedCapsuleId.value) ?? rows.value[0] ?? null);
/** Renderer intents remain events until a host supplies an authoritative dispatcher. */
const emit = defineEmits(['submit-intent', 'create-capsule']);
/** @param {unknown} intent */
function dispatch(intent) {
  if (nestedMode.displayOnly) return;
  const record = /** @type {{schema?:string,op?:string,type?:string,capsuleId?:string}} */ (intent);
  // Creative service operations have no authoritative wire schema. Never propose them.
  if (record?.type?.startsWith('creative/')) {
    emit('submit-intent', intent);
    hostOutcome.value = { code: 'CREATIVE_SERVICE_UNAVAILABLE', message: 'Creative service unavailable.', tone: 'refusal' };
    if (record.type === 'creative/close') creativeOpen.value = false;
    return;
  }
  const op = record?.op ?? (['take_control', 'release_control', 'fold', 'unfold'].includes(record?.type ?? '') ? record.type : null);
  const request = intent;
  const submitIntent = props.authorityHost?.intent, propose = props.authorityHost?.propose;
  if (op) {
    // Visibility needs an authoritative slot mapping; surface ids are not slot ids.
    if (record.schema !== 'ui_intent/v0.2') {
      emit('submit-intent', intent);
      return;
    }
    if (submitIntent) void submitHost(() => submitIntent(request));
    else emit('submit-intent', intent);
  } else if (propose) void submitHost(() => propose(intent));
  else emit('submit-intent', intent);
}
/** Committed placement echoes, keyed by surface; transport acceptance is never optimistic. */
const placements = ref(/** @type {Record<string, {hidden:boolean, floating:boolean, groupId?:string, index?:number, x?:number, y?:number, width?:number, height?:number, lastDockGroupId?:string, lastDockIndex?:number}>} */ ({}));
const placementPending = ref(/** @type {Record<string, boolean>} */ ({}));
/** Failed layout echoes awaiting wall readiness (MVUI16 lane P, ARG-pmui-4):
 * one entry per capsule, retried once on wall @ready, then dropped. Plain
 * non-reactive Map with a fixed cap so pre-ready commits cannot grow it. */
/** @type {Map<string, unknown>} */
const pendingEchoRetry = new Map();
const PENDING_ECHO_RETRY_LIMIT = 8;
/** @param {string} capsuleId @param {unknown} body */
function stashLayoutEchoRetry(capsuleId, body) {
  if (pendingEchoRetry.size >= PENDING_ECHO_RETRY_LIMIT && !pendingEchoRetry.has(capsuleId)) {
    // The size guard proves a key exists; narrow the undefined case
    // explicitly instead of casting it away.
    const oldest = pendingEchoRetry.keys().next().value;
    if (oldest !== undefined) pendingEchoRetry.delete(oldest);
  }
  pendingEchoRetry.set(capsuleId, body);
}
function retryPendingEchoes() {
  if (!pendingEchoRetry.size || !wall.value?.applyLayoutEcho) return;
  const pending = [...pendingEchoRetry];
  pendingEchoRetry.clear();
  for (const [capsuleId, body] of pending) {
    try { wall.value.applyLayoutEcho(capsuleId, body); }
    catch { /* Presentation-only; authority truth is already committed. */ }
  }
}
const selectedPlacement = computed(() => placements.value[selectedSurface.value?.id ?? ''] ?? { hidden: false, floating: false });
/** Closed placement boundary, including direct programmatic submissions.
 * @param {unknown} input @param {string} capsuleId */
function validPlacement(input, capsuleId) {
  const b = /** @type {any} */ (input);
  const fields = /** @type {Record<string,string[]>} */ ({ hide:['slot_id'], show:['slot_id'],
    move:['slot_id','group_id','index'], tab:['slot_id','group_id','index'],
    float:['slot_id','x_px','y_px','width_px','height_px'] });
  if (!b || b.schema !== 'ui_intent/v0.2' || typeof b.request_id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(b.request_id)
      || Object.keys(b).sort().join(',') !== 'op,params,request_id,schema'
      || !Object.hasOwn(fields, b.op) || !b.params || Array.isArray(b.params)
      || Object.keys(b.params).sort().join(',') !== [...fields[b.op]].sort().join(',')
      || ![capsuleId, `cuk-ai-slot-${capsuleId}`].includes(b.params.slot_id)) return false;
  return fields[b.op].every(key => {
    const value = b.params[key];
    if (key === 'slot_id' || key === 'group_id') return typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    const dimension = key === 'width_px' || key === 'height_px';
    return Number.isInteger(value) && value >= (dimension ? 1 : 0)
      && value <= (key === 'index' ? 255 : dimension ? 16384 : 16383);
  });
}
/** @param {unknown} intent @param {string} capsuleId */
async function dispatchMultislot(intent, capsuleId) {
  if (nestedMode.displayOnly) return;
  const body = /** @type {any} */ (intent);
  const surface = selectedSurface.value;
  if (['move','tab','float','hide','show'].includes(body?.op)) {
    if (!surface || capsuleId !== surface.id || !validPlacement(body, capsuleId)) {
      hostOutcome.value = { code: 'LAYOUT_ILLEGAL_TRANSITION', message: '', tone: 'refusal' }; return;
    }
    const previous = placements.value[capsuleId] ?? { hidden:false, floating:false };
    const code = placementPending.value[capsuleId] ? 'ERR_PLACEMENT_PENDING'
      : surface.control === 'agent' ? 'LAYOUT_INPUT_MODE_READ'
      : inputMode.value !== 'write' ? 'ERR_INPUT_MODE_READ'
      : previous.hidden !== (body.op === 'show') ? 'LAYOUT_ILLEGAL_TRANSITION' : null;
    if (code) { hostOutcome.value = { code, message:'', tone:'refusal' }; recordActivity({ code }); return; }
    const submitIntent = props.authorityHost?.intent;
    if (!submitIntent) {
      hostOutcome.value = { code:'HOST_REQUEST_REFUSED', message:'', tone:'refusal' }; recordActivity({ code: 'HOST_REQUEST_REFUSED' }); return;
    }
    placementPending.value = { ...placementPending.value, [capsuleId]:true };
    try {
      const result = await submitHost(async () => {
        const reply = /** @type {unknown} */ (await submitIntent(intent));
        if (reply === true || (reply && typeof reply === 'object' && 'tone' in reply && reply.tone === 'refusal')) return reply;
        throw new Error('Host acknowledgement unavailable');
      });
      // This port resolves true only after the core echoes the journaled intent.
      // Refusals, missing acknowledgments and unmounted hosts retain the layout.
      if (result !== true || !hostActive || !rows.value.some(row => row.id === capsuleId && row.generation === surface.generation)) return;
      const p = body.params;
      const next = { ...previous };
      if (body.op === 'hide' || body.op === 'show') next.hidden = body.op === 'hide';
      else if (body.op === 'float') {
        // MVUI16 lane P (ARG-pmui-3): remember the displaced dock target for
        // dock-back; the groupId/index deletions below stay untouched.
        if (previous.groupId !== undefined) next.lastDockGroupId = previous.groupId;
        else delete next.lastDockGroupId;
        if (previous.index !== undefined) next.lastDockIndex = previous.index;
        else delete next.lastDockIndex;
        delete next.groupId; delete next.index;
        Object.assign(next, { floating:true, x:p.x_px, y:p.y_px, width:p.width_px, height:p.height_px });
      } else {
        delete next.x; delete next.y; delete next.width; delete next.height;
        delete next.lastDockGroupId; delete next.lastDockIndex;
        Object.assign(next, { floating:false, groupId:p.group_id, index:p.index });
      }
      // MVUI16 lane P (ARG-pmui-4): the wall echo is presentation-only. A
      // failed echo surfaces a typed outcome (and a single retry on @ready)
      // but never skips the committed placements update: the commit reflects
      // journaled authority truth. Non-object replies (unmounted wall, test
      // stubs returning a count) are not failures.
      const echo = wall.value?.applyLayoutEcho?.(capsuleId, body);
      // MVUI16D lane P (JUDGE_p1 note 1): this new echo supersedes any older
      // failed echo for the capsule, so a stale body can never replay on
      // @ready over the newer commit. A failed new echo re-stashes below.
      pendingEchoRetry.delete(capsuleId);
      placements.value = { ...placements.value, [capsuleId]:next };
      if (echo && typeof echo === 'object' && echo.ok === false) {
        stashLayoutEchoRetry(capsuleId, body);
        if (hostActive) {
          const code = typeof echo.error?.code === 'string' && echo.error.code ? echo.error.code : 'HOST_REQUEST_REFUSED';
          hostOutcome.value = { code, message: '', tone: 'refusal' };
          recordActivity({ code });
        }
      }
    } finally {
      if (hostActive) placementPending.value = { ...placementPending.value, [capsuleId]:false };
    }
    return;
  }
  if (['fold', 'unfold'].includes(body?.op ?? '')) {
    // Multislot visibility belongs to the selected slot, never a caller's
    // independently supplied capsule/slot pair. Refuse before host or override.
    if (!surface || capsuleId !== surface.id || body.schema !== 'ui_intent/v0.2'
        || body.params?.slot_id !== `cuk-ai-slot-${capsuleId}`) {
      hostOutcome.value = { code: 'LAYOUT_ILLEGAL_TRANSITION', message: '', tone: 'refusal' }; return;
    }
    // MVUI16 lane P (ARG-pmui-5): hidden fold/unfold is a typed refusal, never silent.
    // MVUI19 lane A (L3-2): the operator's own refused request reaches the feed.
    // This mirror keeps the pinned guard line below byte-identical; foreign
    // slot/capsule confusion above stays unrecorded (it must not invent rows).
    if (placements.value[capsuleId]?.hidden) recordActivity({ code: 'LAYOUT_ILLEGAL_TRANSITION' });
    if (placements.value[capsuleId]?.hidden) { hostOutcome.value = { code:'LAYOUT_ILLEGAL_TRANSITION', message:'', tone:'refusal' }; return; }
    // MVUI16D lane P (L2-1): fold/unfold forward unchanged. The kit slot id
    // is the pinned wire contract (mvui3/mvui6/mvui12) and the host resolves
    // it (core/src/serve/layout.rs slot_surface strips the kit prefix), so
    // no renderer-side slot mapping belongs here.
    const visibility = surface.visibility;
    const submitIntent = props.authorityHost?.intent;
    const accepted = !props.authorityHost ? (dispatch(intent), true)
      : await submitHost(async () => {
        const result = await submitIntent?.(intent);
        if (result === true || (result && typeof result === 'object')) return result;
        throw new Error('Host acknowledgement unavailable');
      });
    if (accepted === true && hostActive && rows.value.some(row => row.id === surface.id && row.visibility === visibility)) {
      foldOverrides.value = { ...foldOverrides.value, [surface.id]: body.op === 'fold' };
    }
    return;
  }
  // MVUI16D lane P (L2-1): purely local multislot toggles (hide/show surface
  // view, hide/show terminal, input mode, copy id) and unknown bodies never
  // reach the host: op-less, they would fall into authority.propose with a
  // non-action_proposal body. Op computation mirrors dispatch() below: every
  // op-bearing body keeps its dispatch path (exact ui_intent/v0.2 to the
  // intent port, legacy type-events to the local emit boundary pinned by
  // mvui3), as do creative service intents. Placement/fold returned above.
  const record = /** @type {{schema?:string,op?:string,type?:string}} */ (intent);
  const op = record?.op ?? (['take_control', 'release_control', 'fold', 'unfold'].includes(record?.type ?? '') ? record.type : null);
  if (op || record?.type?.startsWith('creative/')) {
    dispatch(intent);
  }
}
/** @param {unknown} intent */
function onCreateCapsule(intent) {
  if (nestedMode.displayOnly) return;
  const propose = props.authorityHost?.propose;
  if (propose) void submitHost(() => propose(intent));
  else emit('create-capsule', intent);
}
const hostOutcome = ref(/** @type {import('./core/hostAdapters.js').OutcomeRow|null} */ (null));
let hostActive = true;
onBeforeUnmount(() => { hostActive = false; });
/** Latest authority receipts (propose verdicts, intent acks/refusals) for
 * the activity strip. Bounded inline so stub harnesses never resolve the
 * model module; the bound mirrors MV_ACTIVITY_LIMIT in
 * activity/activityModel.js and the activity app test pins both literals. */
const activityFeed = ref(/** @type {Array<{seq:number,code:string}>} */ ([]));
const ACTIVITY_LIMIT = 8;
let activitySeq = 0;
/** @param {unknown} outcome */
function recordActivity(outcome) {
  if (!hostActive) return;
  activitySeq += 1;
  const record = /** @type {{code?:unknown}} */ (outcome);
  const code = typeof record?.code === 'string' ? record.code : '';
  activityFeed.value = [...activityFeed.value, Object.freeze({ seq: activitySeq, code })].slice(-ACTIVITY_LIMIT);
}
/** @param {()=>Promise<unknown>} action */
async function submitHost(action) {
  try {
    const result = await action();
    if (hostActive) hostOutcome.value = result === true
      ? { code: 'INTENT_ACKNOWLEDGED', message: 'Request sent.', tone: 'success' }
      : /** @type {import('./core/hostAdapters.js').OutcomeRow} */ (result);
    if (hostActive) recordActivity(result === true ? { code: 'INTENT_ACKNOWLEDGED' } : result);
    return result;
  } catch (error) {
    const suppliedCode = /** @type {{code?:unknown}} */ (error)?.code;
    const code = ['LAYOUT_UNKNOWN_SLOT','LAYOUT_ILLEGAL_TRANSITION','LAYOUT_INPUT_MODE_READ'].find(code =>
      suppliedCode === code || String(error).includes(code)) ?? 'HOST_REQUEST_REFUSED';
    if (hostActive) hostOutcome.value = { code, message: 'This request is unavailable. Please try again.', tone: 'refusal' };
    if (hostActive) {
      if (code === 'HOST_REQUEST_REFUSED') recordActivity({ code: 'HOST_REQUEST_REFUSED' });
      else recordActivity({ code });
    }
  }
}
/** Settled-outcome toast lifetime (MVUI19 lane A, L3-3): every ack/refusal
 * toast auto-dismisses after this delay, so a stale toast can never sit over
 * interactive rows. One bounded timer, re-armed per outcome and cleared on
 * unmount. The watcher only arms the timer (it writes no reactive state);
 * the timer callback clears a stale outcome without recording, so dismissal
 * never moves the activity count. */
const OUTCOME_DISMISS_MS = 4000;
/** Pending dismissal handle; undefined when none is armed. @type {any} */
let outcomeTimer;
function armOutcomeDismiss() {
  if (outcomeTimer !== undefined) clearTimeout(outcomeTimer);
  outcomeTimer = setTimeout(() => {
    outcomeTimer = undefined;
    if (hostActive) hostOutcome.value = null;
  }, OUTCOME_DISMISS_MS);
}
watch(hostOutcome, (row) => { if (row) armOutcomeDismiss(); });
onBeforeUnmount(() => {
  if (outcomeTimer !== undefined) { clearTimeout(outcomeTimer); outcomeTimer = undefined; }
});
/** Fixture-only bench hook (MVUI4L lane V): replay steps drive the real
 * dispatch paths (propose/intent/multislot) through this handle, so every
 * row appears through production code, plus the real openers for the
 * multislot and terminal screens the steps screenshot. Installed only when
 * a fixture key is present; live boot never installs it. Lane R reads it
 * after mount and no-ops when it is absent. */
/** Deterministic bench-only opener: the UI toggles the terminal, the bench opens it. */
function openTerminalBench() { if (!terminalOpen.value) toggleTerminal(); }
const benchHook = Object.freeze({ dispatch, dispatchMultislot, createCapsule: onCreateCapsule,
  openMultislot, openTerminal: openTerminalBench });
const benchWindow = /** @type {any} */ (typeof window !== 'undefined' ? window : null);
onMounted(() => {
  if (benchWindow && props.fixture) benchWindow.__metaviewerBench = benchHook;
});
onBeforeUnmount(() => {
  if (benchWindow && benchWindow.__metaviewerBench === benchHook) delete benchWindow.__metaviewerBench;
});
/** @param {{capsuleId?:unknown}} payload */
function selectCapsule(payload) {
  if (typeof payload?.capsuleId === 'string' && rows.value.some(row => row.id === payload.capsuleId)) selectedCapsuleId.value = payload.capsuleId;
}
let terminalGeneration = 0;
let terminalOpening = false;
function cancelTerminalOpening() { terminalGeneration += 1; terminalOpening = false; }
function toggleCreative() {
  cancelTerminalOpening();
  if (!selectedSurface.value) return;
  creativeOpen.value = !creativeOpen.value;
  settingsOpen.value = false;
  multislotOpen.value = false;
  terminalOpen.value = false;
}
function openMultislot() {
  cancelTerminalOpening();
  creativeOpen.value = false;
  if (!selectedSurface.value) return;
  settingsOpen.value = false;
  terminalOpen.value = false;
  multislotOpen.value = true;
}
function toggleSettings() {
  cancelTerminalOpening();
  creativeOpen.value = false;
  const next = !settingsOpen.value;
  multislotOpen.value = false;
  terminalOpen.value = false;
  settingsOpen.value = next;
}
async function toggleTerminal() {
  const next = !(terminalOpen.value || terminalOpening);
  const generation = ++terminalGeneration;
  terminalOpening = next;
  try {
    // Only replay opts into its fake broker; live access uses explicit enable.
    if (next && props.fixture?.key === 'live-replay' && props.terminalBroker) {
      const { createSideTerminalBrokerFacade } = await import('./terminal/sideTerminalFacade.js');
      if (!hostActive || generation !== terminalGeneration) return;
      const broker = createSideTerminalBrokerFacade(props.terminalBroker);
      if (broker?.canEnable && !broker.state.enabled) await broker.setEnabled(true);
    }
    if (!hostActive || generation !== terminalGeneration) return;
    creativeOpen.value = false;
    multislotOpen.value = false;
    settingsOpen.value = false;
    terminalOpen.value = next;
  } catch {
    if (!hostActive || generation !== terminalGeneration) return;
    hostOutcome.value = { code: 'HOST_REQUEST_REFUSED', message: 'This request is unavailable. Please try again.', tone: 'refusal' };
  } finally {
    if (generation === terminalGeneration) terminalOpening = false;
  }
}

const terminalTop = ref(0), terminalBottom = ref(0);
function measureChrome() {
  terminalTop.value = (document.getElementById('shell/header')?.offsetHeight ?? 0)
    + (document.getElementById('mv-layout-notice')?.offsetHeight ?? 0);
  terminalBottom.value = document.getElementById('shell/statusbar')?.offsetHeight ?? 0;
}
onMounted(() => { measureChrome(); window.addEventListener('resize', measureChrome); });
onBeforeUnmount(() => window.removeEventListener('resize', measureChrome));
const wall = ref(/** @type {InstanceType<typeof WallWorkspace>|null} */ (null));
const activeTileScheduler = /** @type {ReturnType<typeof createTileScheduler>} */ (props.runtime?.tileScheduler ?? tileScheduler);
provide('tileScheduler', activeTileScheduler);
/** Live-only frame-port router provided by the entry; null on fixture/legacy boots. */
const framePortRouter = /** @type {unknown} */ (inject('framePortRouter', null));
const presentationRevision = ref(0);
const stopPresentation = activeTileScheduler.subscribePresentation?.(() => { presentationRevision.value += 1; });
onBeforeUnmount(() => stopPresentation?.());
/** @param {{id:string,generation:number}} surface */
function surfaceWitness(surface) {
  void presentationRevision.value;
  const info = activeTileScheduler.getInstrumentation?.(surface.id);
  const sizeOf = (/** @type {any} */ record) => ({
    width: Number.isSafeInteger(record?.lastPresentedWidth) && record.lastPresentedWidth > 0 ? record.lastPresentedWidth : 0,
    height: Number.isSafeInteger(record?.lastPresentedHeight) && record.lastPresentedHeight > 0 ? record.lastPresentedHeight : 0,
  });
  if (!info || !('lastPresentedHandle' in info) || info.destroyed || info.contextLost) {
    return { frame: '', digest: '', width: 0, height: 0 };
  }
  if (framePortRouter === null
      && (info.surfaceGeneration !== surface.generation || info.epoch !== snapshot.value?.envelope?.epoch)) {
    // Fixture/legacy path only (R1-074): without the frame-port router the
    // projection generation is the surface lifetime authority, so a skewed
    // entry is stale and must not label the tile live.
    return { frame: '', digest: '', width: 0, height: 0 };
  }
  // L3-1 live path: the scheduler entry carries the DELIVERY identity pinned
  // by the frame-port router (delivery surfaceGeneration/epoch), which the
  // contract forbids comparing with projection generations: surface.generation
  // and the snapshot epoch advance independently (e.g. 886+ vs 1/E on the real
  // host), so such a check blanks every live witness and the tile never leaves
  // Connecting. Staleness needs no projection check here: the scheduler resets
  // the witness on lifetime change and reports destroyed/contextLost.
  // L2-8: returning the witness across projection advances also stops the
  // per-frame witness flash; sizes come from the presented delivery.
  return { frame: info.lastPresentedHandle, digest: info.lastPresentedDigest, ...sizeOf(info) };
}
const feed = props.runtime?.projectionView ?? projectionView;
const snapshot = shallowRef(feed.getSnapshot());
const diagnosticTileStates = props.fixture?.key === 'tile-states';
/** Lost-row admission (MVUI4L lane V, for lane W MV-7): the live runtime
 * path (live boot and the live-replay bench) keeps Lost tiles exactly as
 * the tile-states diagnostic does; stub-fixture mounts keep the pinned
 * diagnostic-only scope. */
const admitLostRows = computed(() => diagnosticTileStates || !props.fixture || props.fixture.ui?.liveReplay === true);
const rows = computed(() => {
  void snapshot.value;
  const admitted = feed.getProjection()?.rows.filter(row => row.backendLifecycle !== 'destroyed'
    && (row.backendLifecycle !== 'lost' || admitLostRows.value)) ?? [];
  return admitted.filter(row => !nestedMode.displayOnly || applyNestedWall([row], nestedMode).rows.length > 0);
});
// Reconcile only changed authoritative visibility, retaining pending local
// presentation across unrelated feed updates and removing departed surfaces.
watch(() => rows.value.map(row => /** @type {[string, string]} */ ([row.id, row.visibility])), (next, previous = []) => {
  const prior = new Map(previous);
  foldOverrides.value = Object.fromEntries(next.flatMap(([id, visibility]) =>
    prior.get(id) === visibility && Object.hasOwn(foldOverrides.value, id)
      ? [[id, foldOverrides.value[id]]] : []));
});
// Readiness belongs to the branch actually rendered, including display-only walls.
const wallView = computed(() => nestedMode.displayOnly ? 'nested' : creativeOpen.value ? 'creative' : rows.value.length ? 'workspace' : 'empty');
let firstFrame = 0;
function cancelFirstFrame() { if (firstFrame) window.cancelAnimationFrame(firstFrame); firstFrame = 0; }
watch(wallView, () => { settled.value = false; revealed.clear(); cancelFirstFrame(); }, { flush: 'sync' });
onMounted(() => {
  watch(wallView, view => {
    if (view === 'workspace' || typeof window.requestAnimationFrame !== 'function') return; // The workspace owns its restoration witness.
    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = 0;
        if (wallView.value === view) onSettled();
      });
    });
  }, { immediate: true, flush: 'post' });
});
onBeforeUnmount(cancelFirstFrame);
const stopFeed = feed.subscribe(value => { snapshot.value = value; revealRows(); });
onBeforeUnmount(stopFeed);
const catalog = computed(() => rows.value.map(row => ({ id: row.id, label: row.title || row.id, description: 'Connected surface', category: 'Surfaces', icon: 'grid' })));
const groups = computed(() => [{ label: 'Workspace', items: [{ id: 'add', label: 'Add capsule', icon: 'grid' }, ...catalog.value] }]);
const revealed = new Set();
function revealRows() {
  if (!settled.value) return;
  for (const row of rows.value) {
    if (revealed.has(row.id)) continue;
    const result = wall.value?.revealSurface(row.id, 'split');
    if (result?.ok) revealed.add(row.id);
  }
}
function onWorkspaceSettled() { if (wallView.value === 'workspace') onSettled(); }
/** Wall @ready: reveal admitted rows, then replay layout echoes that failed
 * while the wall was not ready (MVUI16 lane P, ARG-pmui-4). */
function onWallReady() { revealRows(); retryPendingEchoes(); }
function onSettled() { settled.value = true; revealRows(); }
/** @param {any} payload */
function openCapsule(payload) {
  if (nestedMode.displayOnly) return;
  const id = payload?.type?.id ?? payload?.id;
  if (typeof id === 'string') selectedCapsuleId.value = id;
  if (id === 'add') { launcherOpen.value = true; return; }
  if (rows.value.some(row => row.id === id)) wall.value?.revealSurface(id, payload?.placement ?? 'tab');
}
const chromeWorkspace = markRaw(defineComponent({
  inheritAttrs: false,
  setup: (_, { attrs }) => () => h(ShellWorkspace, { ...attrs, workspaceComponent: DockWorkspace }),
}));
</script>
<template>
  <div class="metaviewer mv-shell" :data-wall-settled="String(settled)" :class="{ 'mv-shell--nested': nestedMode.displayOnly }">
    <TopBar v-if="!nestedMode.displayOnly" product="MetaViewer" new-label="Add capsule" search-placeholder="Find a capsule…" :nav-expanded="railOpen"
      :palette-items="catalog" @toggle-nav="railOpen = !railOpen" @new-capsule="launcherOpen = true" @open="openCapsule">
      <template #actions>
        <UiButton id="shell-creative" data-semantic-anchor="creative/open" label="Storyboard" :aria-expanded="creativeOpen" :disabled="!selectedSurface" @click="toggleCreative" />
        <UiButton id="shell-settings" data-semantic-anchor="settings/open" label="Settings" :aria-expanded="settingsOpen" @click="toggleSettings" />
        <UiButton id="shell-multislot" data-semantic-anchor="capsule/open-multislot" label="Open in multislot" :aria-expanded="multislotOpen" :disabled="!selectedSurface" @click="openMultislot" />
        <UiButton id="shell-terminal" data-semantic-anchor="terminal/toggle" label="Terminal" :aria-expanded="terminalOpen" @click="toggleTerminal" />
      </template>
    </TopBar>
    <div v-if="!nestedMode.displayOnly" id="mv-layout-notice" class="mv-layout-notice">
      <!-- Reserve the longest outcome before the wall becomes interactive, including while panels open. -->
      <p class="mv-layout-notice-reserve" aria-hidden="true"><strong>Layout unavailable.</strong> The default layout is shown read-only. Changes will not be saved.</p>
      <p v-if="layoutUnavailable && !creativeOpen && !settingsOpen && !multislotOpen && !nestedMode.displayOnly" id="mv-layout-unavailable" data-semantic-anchor="layout/unavailable"
        class="mv-layout-unavailable" role="alert" :data-error-code="layoutUnavailable.code">
        <strong>Layout unavailable.</strong> {{ layoutUnavailable.saveRefused
          ? 'Changes cannot be saved in this session.'
          : 'The default layout is shown read-only. Changes will not be saved.' }}
      </p>
    </div>
    <div class="mv-shell-body">
      <div v-if="!nestedMode.displayOnly && !creativeOpen" class="mv-shell-rail"><Sidebar :groups="groups" :collapsed="!railOpen" :overlay="true" workspace-label="MetaViewer" @open="openCapsule" /></div>
      <main id="shell-wall" aria-label="MetaViewer capsule wall">
        <HostOutcome :row="hostOutcome" />
        <section v-if="nestedMode.displayOnly" class="mv-nested-wall" aria-label="Nested capsule wall">
          <article v-for="surface in rows" :key="surface.id" :aria-label="surface.title || surface.id">
            <SurfaceCanvas :surface-id="surface.id" :generation="surface.generation" :epoch="snapshot?.envelope?.epoch ?? ''" :frame="surfaceWitness(surface).frame" :digest="surfaceWitness(surface).digest" :frame-width="surfaceWitness(surface).width" :frame-height="surfaceWitness(surface).height" :state="surface.attachmentState === 'live' ? 'live' : 'connecting'" />
          </article>
        </section>
        <WallWorkspace v-else-if="!creativeOpen" :key="wallView" :hidden="!rows.length" ref="wall" :workspace-component="chromeWorkspace" :scope="props.scope" :default-profile="props.layout" :storage="workspaceStorage"
          owner-window-id="main-wall" :projection-view="feed" :capture-state="captureAvailable ? captureState : undefined" :display-only="nestedMode.displayOnly" :allow-lost-surface="admitLostRows" :intent-builders="props.runtime?.intentBuilders ?? intentBuilders"
          :control-registry="props.runtime?.controlRegistry ?? controlRegistry" :scheduler="props.runtime?.scheduler ?? scheduler" :tile-scheduler="props.runtime?.tileScheduler ?? tileScheduler"
          :color-scheme="scheme === 'mv-dark' ? 'dark' : 'light'" density="compact" @ready="onWallReady" @wall-settled="onWorkspaceSettled" @activate-surface="selectCapsule" @submit-intent="dispatch">
          <template #surface="{ surface, capsuleId }">
            <SurfaceCanvas v-if="surface && (!multislotOpen || capsuleId !== selectedSurface?.id)" :surface-id="capsuleId" :generation="surface.generation" :epoch="snapshot?.envelope?.epoch ?? ''" :frame="surfaceWitness(surface).frame" :digest="surfaceWitness(surface).digest" :frame-width="surfaceWitness(surface).width" :frame-height="surfaceWitness(surface).height" :state="surface.attachmentState === 'live' ? 'live' : 'connecting'" />
          </template>
        </WallWorkspace>
        <EmptyWallView v-if="!rows.length && !nestedMode.displayOnly && !creativeOpen" @add-capsule="launcherOpen = true" />
        <section v-if="creativeOpen && selectedSurface && !nestedMode.displayOnly" class="mv-creative-screen" aria-label="Creative capsule">
          <CreativeCapsule :capsule-id="selectedSurface.id" :frames="creativeFrames" title="Storyboard" @submit-intent="dispatch" />
        </section>
        <section v-if="multislotOpen && selectedSurface && !nestedMode.displayOnly" class="mv-multislot-screen" aria-label="Capsule multislot">
          <UiButton id="multislot-back" data-semantic-anchor="multislot/back" label="Back to wall" @click="multislotOpen = false" />
          <MultislotHost :capsule-id="selectedSurface.id" :capsule-label="selectedSurface.title" :terminal-binding="props.terminal" :terminal-broker="props.terminalBroker" :folded="selectedFolded" :hidden="selectedPlacement.hidden" :floating="selectedPlacement.floating"
            :float-x="selectedPlacement.x" :float-y="selectedPlacement.y" :float-width="selectedPlacement.width" :float-height="selectedPlacement.height"
            :group-id="selectedPlacement.groupId" :placement-index="selectedPlacement.index"
            :last-dock-group-id="selectedPlacement.lastDockGroupId" :last-dock-index="selectedPlacement.lastDockIndex"
            :layout-pending="placementPending[selectedSurface.id] === true" :agent-controlled="selectedSurface.control === 'agent'" v-model:input-mode="inputMode" @submit-intent="dispatchMultislot">
            <template #surface><SurfaceCanvas :surface-id="selectedSurface.id" :generation="selectedSurface.generation" :epoch="snapshot?.envelope?.epoch ?? ''" :frame="surfaceWitness(selectedSurface).frame" :digest="surfaceWitness(selectedSurface).digest" :frame-width="surfaceWitness(selectedSurface).width" :frame-height="surfaceWitness(selectedSurface).height" :state="selectedSurface.attachmentState === 'live' ? 'live' : 'connecting'" /></template>
            <template #record><MvRecordingPanel :capsule-id="selectedSurface.id" :export-destination="props.exportDestination" :phase="props.fixture?.key === 'recording' ? 'recording' : 'idle'" :capture-state="captureState" :capture-available="captureAvailable" @submit-intent="dispatch" /></template>
          </MultislotHost>
        </section>
        <section v-if="!nestedMode.displayOnly" :hidden="!settingsOpen" class="mv-settings-screen" aria-label="Settings">
          <UiButton id="settings-back" data-semantic-anchor="settings/back" label="Back to wall" @click="settingsOpen = false" />
          <MvSettingsPanel :settings-host="props.settingsHost ?? {}" @scheme-change="onScheme" />
        </section>
      </main>
    </div>
    <ActivityStrip v-if="!nestedMode.displayOnly" :entries="activityFeed" />
    <!-- L2-7: strong tone keeps the wall crumb at AA on the sunken bar in
      mv-light and mv-dark; the kit accent default measures 4.35:1 rendered. -->
    <StatusBar v-if="!nestedMode.displayOnly" :crumbs="[{ id: 'wall', label: 'Main wall', tone: 'strong' }]" :shortcuts="[]">
      <template #telemetry><span id="shell-feed-status" class="mv-feed-status" role="status"><i aria-hidden="true"></i>{{ snapshot?.envelope ? 'Core connected' : 'Core not connected' }}</span></template>
      <template #shortcuts><span class="mv-shell-caption">{{ rows.length ? `${rows.length} capsules` : 'Ready when you are' }}</span></template>
    </StatusBar>
    <div class="mv-terminal" :hidden="!terminalOpen || nestedMode.displayOnly || multislotOpen">
      <SideTerminalOverlay v-if="!nestedMode.displayOnly && !multislotOpen && !creativeOpen" :terminal-binding="props.terminal" :terminal-broker="props.terminalBroker" v-model:open="terminalOpen" :storage="preferences" :top-offset="terminalTop" :bottom-offset="terminalBottom" />
    </div>
    <CatalogLauncher v-if="!nestedMode.displayOnly" v-model:visible="launcherOpen" @create="onCreateCapsule" />
    <AgentLaneHost :screen="nestedMode.displayOnly ? 'nested' : creativeOpen ? 'creative' : settingsOpen ? 'settings' : multislotOpen ? 'multislot' : 'wall'" :fixture-key="props.fixture?.key ?? ''" />
  </div>
</template>
<style>
html, body, #metaviewer-app { width:100%; height:100%; margin:0; overflow:hidden; }
body { font-family:var(--cuk-semantic-typography-font-family-sans, system-ui, sans-serif); color:var(--cuk-semantic-text-primary); background:var(--cuk-semantic-surface-canvas); }
.mv-shell { height:100dvh; display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:var(--cuk-component-app-shell-topbar-height) auto minmax(0,1fr) auto var(--cuk-component-app-shell-status-height); background:var(--cuk-semantic-surface-canvas); }
.mv-terminal { position:fixed; inset:0; z-index:var(--cuk-semantic-z-index-overlay); pointer-events:none; }
.mv-terminal[hidden] { display:none; }
.mv-terminal > * { pointer-events:auto; }
.mv-shell-body { grid-row:3; display:flex; min-width:0; min-height:0; position:relative; }
.mv-shell-rail { width:var(--cuk-semantic-size-rail-collapsed-width); flex:none; position:relative; }
.mv-shell main { position:relative; flex:1; min-height:0; min-width:0; }
/* MVUI19 lane A (L3-3): the settled outcome toast is transient and never
   intercepts pointer events on interactive rows beneath it. */
#shell-wall #mv-host-outcome { pointer-events:none; }
/* Both paragraphs share one flow-sized cell; the reserve never enters the accessibility tree. */
.mv-layout-notice { grid-row:2; display:grid; min-width:0; }
.mv-layout-notice-reserve, .mv-layout-unavailable { grid-area:1 / 1; margin:0; padding:var(--cuk-semantic-spacing-sm); color:var(--cuk-semantic-text-primary); background:var(--cuk-semantic-surface-canvas); border:var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-default); font-size:var(--cuk-semantic-typography-font-size-sm); }
.mv-layout-notice-reserve { visibility:hidden; }
.mv-shell .cuk-capsule-panel { height:100%; }
.mv-shell .mv-surface-host { width:100%; height:100%; min-height:0; }
.mv-shell .wall-workspace, .mv-shell .cuk-shell-workspace { height:100%; }
.mv-shell #workspace-keyboard-toolbar { display:none; }
.mv-shell .mv-dock-workspace { grid-template-rows:minmax(0,1fr); }
.mv-shell .mv-dock-workspace__stage { grid-row:1; }
.mv-shell .mv-dock-workspace:has(.mv-dock-workspace__quarantine-banner) { grid-template-rows:auto minmax(0,1fr); }
.mv-shell .mv-dock-workspace:has(.mv-dock-workspace__quarantine-banner) .mv-dock-workspace__stage { grid-row:2; }
.mv-shell .s1-hidden:has(.s1-hidden-empty) { display:none; }
.mv-empty-wall { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:var(--cuk-semantic-spacing-lg); background:var(--cuk-semantic-surface-canvas); text-align:center; }
.mv-empty-wall h1 { font-size:clamp(24px,3vw,36px); letter-spacing:-.035em; font-weight:600; margin:0 0 var(--cuk-semantic-spacing-sm); }
.mv-empty-wall p { color:var(--cuk-semantic-text-muted); margin:0 0 var(--cuk-semantic-spacing-lg); font-size:14px; }
.mv-empty-wall .mv-eyebrow { font-size:10px; letter-spacing:.16em; font-weight:600; margin-bottom:var(--cuk-semantic-spacing-md); }
.mv-empty-mark { display:grid; grid-template-columns:repeat(2,20px); gap:5px; margin-bottom:var(--cuk-semantic-spacing-lg); transform:rotate(-6deg); }
.mv-empty-mark span { width:20px; height:20px; border:1px solid var(--cuk-semantic-border-default); border-radius:4px; background:var(--cuk-semantic-surface-panel); }
.mv-empty-mark span:first-child { background:var(--cuk-semantic-accent-primary); border-color:var(--cuk-semantic-accent-primary); }
.mv-feed-status { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--cuk-semantic-text-muted); }
.mv-feed-status i { height:6px; width:6px; border-radius:50%; background:var(--cuk-semantic-text-muted); }
.mv-shell-caption { font-size:11px; color:var(--cuk-semantic-text-muted); }
</style>

<style>
.mv-creative-screen, .mv-multislot-screen, .mv-settings-screen { position:absolute; inset:0; z-index:2; overflow:auto; padding:var(--cuk-semantic-spacing-md); background:var(--cuk-semantic-surface-canvas); }
.mv-shell--nested { grid-template-rows:minmax(0,1fr); }
.mv-shell--nested > .mv-shell-body { grid-row:1; }
.mv-nested-wall { display:grid; height:100%; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); }
.mv-nested-wall article { min-width:0; min-height:0; }
</style>
