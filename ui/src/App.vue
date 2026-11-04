<script setup>
/** The optional runtime supplies authoritative rows and the tile scheduler.
 * Canvas status reads successful presentation witnesses; bytes stay external.
 * [TARGET, unit decision] The entry supplies a runtime only with an authority
 * subscription. Its presence distinguishes waiting for frames from no runtime;
 * it does not attest transport health or adapter availability.
 */
import { computed, defineComponent, h, inject, markRaw, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import DemoDialog from './demo/DemoDialog.vue';
import IdentitiesDialog from './identities/IdentitiesDialog.vue';
import HandoffNotice from './handoff/HandoffNotice.vue';
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
import BrowserIcon from '@openvue/icons/windowmaximize';
import SidebarIcon from '../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue';
import { setKitScheme } from 'capsule-ui-kit/theme';
import WallWorkspace from './wall/WallWorkspace.vue';
import DesktopWorkspace from './wall/DesktopWorkspace.vue';
import {guestWorkloadTile,validGuestWorkloadTile} from './wall/guestWorkloadTile.js';
import {rewindSnapshot as validRewindSnapshot} from '../electron/rewindValues.js';
import {capsuleCapabilitiesValid} from '../electron/guestCommandValues.js';
import {createDesktopState, desktopRows, MAX_DESKTOPS_PER_VIEW} from '../electron/desktopLayout.js';
import SurfaceCanvas from './surfaces/SurfaceCanvas.vue';
import { createTileScheduler } from './surfaces/tileScheduler.js';
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileEnvelope} LayoutProfile */
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileScope} LayoutScope */
/** @typedef {Pick<InstanceType<typeof WallWorkspace>['$props'], 'projectionView'|'intentBuilders'|'controlRegistry'|'scheduler'|'tileScheduler'>} WallRuntime */
/** @typedef {{readRaw:()=>Promise<string|null>,writeAtomic:(json:string)=>Promise<void>}} LayoutStorage */
const identitiesOpen = ref(false);
const storedDataProfile = ref('');
/** @param {string} profileId */
function openStoredData(profileId) {
  if (typeof profileId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(profileId)) return;
  storedDataProfile.value = profileId;
  identitiesOpen.value = true;
}

const moreOpen = ref(false);
const overlayCoordinator = /** @type {ReturnType<typeof import('./surfaces/overlayCoordinator.js').createOverlayCoordinator>|null} */ (inject('overlayCoordinator', null));
const appOverlayOwner = {};
const moreMenu = ref(/** @type {HTMLElement|null} */ (null));
const morePopup = ref(/** @type {HTMLElement|null} */ (null));
watch(moreOpen, async open => {
  if (!open) { if (morePopup.value?.matches?.(':popover-open')) morePopup.value.hidePopover(); return; }
  await nextTick();
  if (moreOpen.value) /** @type {any} */ (morePopup.value)?.showPopover?.({source:moreMenu.value?.querySelector('button')});
});
/** @param {Event} event */
function closeMore(event) { if (!moreMenu.value?.contains(/** @type {Node|null} */ (event.target))) moreOpen.value = false; }
onMounted(() => globalThis.document?.addEventListener?.('pointerdown', closeMore, true));
onBeforeUnmount(() => globalThis.document?.removeEventListener?.('pointerdown', closeMore, true));
const demoOpen=ref(false);
const props = defineProps({
  rewindHost: {type:Object,default:null},
  rewindPanel: {type:[Object,Function],default:null},
  guestCommandHost: { type: Object, default: null },
  guestCommandPanel: { type: [Object,Function], default: null },
  headlessHost: { type: Object, default: null },
  headlessPanel: { type: [Object,Function], default: null },
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
  initialScheme: { type: /** @type {import('vue').PropType<string|null>} */ (String), default: null },
  initialDensity: { type: /** @type {import('vue').PropType<string|null>} */ (String), default: null },
  framesPort: { type: /** @type {import('vue').PropType<{ subscribeFrames?: (callback: (notice: unknown) => void) => unknown }|null>} */ (Object), default: null },
  preferences: { type: /** @type {import('vue').PropType<Storage|null>} */ (Object), default: null },
  exportDestination: { type: String, default: '' },
  fixture: { type: /** @type {import('vue').PropType<import('./fixtures/states.js').FixtureState|null>} */ (Object), default: null },
  nestedHost: { type: /** @type {import('vue').PropType<import('./nested/nested.js').NestedHost|null>} */ (Object), default: null },
  runtime: { type: /** @type {import('vue').PropType<WallRuntime|null>} */ (Object), default: null },
  terminal: { type: /** @type {import('vue').PropType<{session:string,port:MessagePort}|null>} */ (Object), default: null },
  // MVUI29b lane T: fixed-API terminal session source for the multislot
  // (a prebuilt port on real boots, the fixture double on terminal-live
  // boots). Null keeps the binding-only path.
  terminalSessionPort: { type: Object, default: null },
  // MVUI29b lane T: direct host provider entries and advertised broker
  // commands for the multislot menu. Empty lists keep the transport
  // listing and the broker-derived commands.
  hostProviders: { type: /** @type {import('vue').PropType<unknown[]>} */ (Array), default: () => [] },
  brokerCommands: { type: /** @type {import('vue').PropType<string[]>} */ (Array), default: () => [] },
  // MVUI29b lane T: injected clipboard for Copy-capsule-ID. Null falls
  // back to the session-port copyText, then the ambient clipboard.
  clipboard: { type: /** @type {import('vue').PropType<{ writeText: (text: string) => Promise<void> } | null>} */ (Object), default: null },
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
// MVUI29S: the entry resolves the stored scheme before mount so first paint
// already carries it; direct mounts keep the fixture-or-light default.
const bootScheme = props.initialScheme ?? props.fixture?.scheme ?? 'mv-dark';
const scheme = ref(bootScheme === 'mv-dark' ? 'mv-dark' : 'mv-light');
const applyScheme = /** @type {(scheme:string)=>void} */ (setKitScheme);
applyScheme(scheme.value);
// MVUI33: the entry resolves the stored density before mount like the scheme;
// direct mounts keep the fixture-or-compact default. The wall prop binds this
// ref and the root density attribute follows it, so the settings panel only
// persists the value and mirrors it through the density model.
const bootDensity = props.initialDensity ?? props.fixture?.density ?? 'compact';
const density = ref(bootDensity === 'comfortable' ? 'comfortable' : 'compact');
document.documentElement.dataset.themeDensity = density.value;
watch(density, (next) => { document.documentElement.dataset.themeDensity = next; });
/** @param {string} next */
function onScheme(next) { scheme.value = next === 'mv-dark' ? 'mv-dark' : 'mv-light'; }
const nestedMode = resolveNestedMode(props.nestedHost ?? (props.fixture?.key === 'nested'
  ? { getNestedDepth: () => 1, getSelfCapsuleId: () => null } : null));
const launcherOpen = ref(props.fixture?.ui.launcherOpen === true);
// [TARGET, unit decision] Recheck host availability for every catalog opening.
// Invalidate outstanding reads on close or host replacement.
// The preload validates the closed nested session. This view additionally rejects stale or malformed snapshots.
const validSnapshot=(/** @type {any} */ s)=>s && typeof s==='object' && Object.keys(s).sort().join(',')==='available,busy,code,revision,session,uncertain'
  && typeof s.available==='boolean' && typeof s.busy==='boolean' && typeof s.uncertain==='boolean' && Number.isSafeInteger(s.revision) && s.revision>=0;
const guestCommandSnapshot=ref(/** @type {any} */ ({available:false,busy:false,canCancel:false,code:null,revision:0,session:null,uncertain:false,stdout:'',stderr:''}));
const guestCommandOpen=ref(false);
const rewindSnapshot=ref(/** @type {any} */({available:false,busy:false,code:null,revision:0,session:null,uncertain:false,point_ages_ms:{},stop_target:null}));
watch(()=>props.rewindHost,(host,_,cleanup)=>{
 let active=true;
 const accept=(/** @type {any} */value)=>{if(active&&validRewindSnapshot(value)&&value.revision>=rewindSnapshot.value.revision)rewindSnapshot.value=value;};
 const stop=host?.subscribe?.(accept);void host?.status?.().then(accept).catch(()=>{});cleanup(()=>{active=false;stop?.();});
},{immediate:true});
async function requestRewind(/** @type {any} */action){try{const value=await props.rewindHost?.request?.(action);if(validRewindSnapshot(value)&&value.revision>=rewindSnapshot.value.revision)rewindSnapshot.value=value;}catch{rewindSnapshot.value={...rewindSnapshot.value,uncertain:true,code:'OUTCOME_UNKNOWN'};}}

const arm64Capabilities=ref(/** @type {any} */ (null));
const guestWorkloadTiles=computed(()=>{const tile=guestWorkloadTile(guestCommandSnapshot.value);return tile?[tile]:[];});
watch(()=>props.guestCommandHost,(host,_,cleanup)=>{
 let active=true;
 const accept=(/** @type {any} */ value)=>{if(active&&value&&Number.isSafeInteger(value.revision)&&value.revision>=guestCommandSnapshot.value.revision){guestCommandSnapshot.value=value;if(value.session||value.uncertain)guestCommandOpen.value=true;}};
 const stop=host?.subscribe?.(accept);void host?.status?.().then(accept).catch(()=>{});cleanup(()=>{active=false;stop?.();});
},{immediate:true});
function showGuestConsole(){selectGlobalView('agent');void nextTick(()=>{const tile=guestWorkloadTiles.value[0];if(tile)wall.value?.revealWorkload?.(tile.id);});}
async function guestCommandAction(/** @type {any} */ action){
 guestCommandOpen.value=true;
 try{const result=await props.guestCommandHost?.request?.(action);if(result&&result.revision>=guestCommandSnapshot.value.revision)guestCommandSnapshot.value=result;}
 catch{guestCommandSnapshot.value={...guestCommandSnapshot.value,uncertain:true,code:'OUTCOME_UNKNOWN'};}
}
const headlessSnapshot=ref(/** @type {any} */ ({available:false,busy:false,code:null,revision:0,session:null,uncertain:false}));
const headlessOpen=ref(false);
watch(()=>props.headlessHost,(host,_,cleanup)=>{
  let active=true;
  const accept=(/** @type {any} */ s)=>{if(active && validSnapshot(s) && s.revision>=headlessSnapshot.value.revision){headlessSnapshot.value=s;if(s.session || s.uncertain)headlessOpen.value=true;}};
  const stop=host?.subscribe?.(accept);
  void host?.status?.().then(accept).catch(()=>{});
  cleanup(()=>{active=false;stop?.();});
},{immediate:true});
async function headlessAction(/** @type {string} */ op,/** @type {number|undefined} */ n=undefined){
  const s=headlessSnapshot.value.session;
  const action=op==='create'?{op}:{op,workload_id:s?.workload_id,generation:s?.generation,...(op==='run'?{n}:{})};
  headlessOpen.value=true;
  try {const result=await props.headlessHost?.request?.(action);if(validSnapshot(result) && result.revision>=headlessSnapshot.value.revision)headlessSnapshot.value=result;}
  catch {headlessSnapshot.value={...headlessSnapshot.value,uncertain:true,code:'OUTCOME_UNKNOWN'};}
}
function runHeadlessJob(/** @type {number} */ n){void headlessAction('run',n);}
watch(()=>[launcherOpen.value,props.guestCommandHost],async(_,__,cleanup)=>{
 let current=true;cleanup(()=>{current=false;});
 try{const result=await props.guestCommandHost?.capabilities?.();if(current&&capsuleCapabilitiesValid(result))arm64Capabilities.value=result;}catch{/* Existing unavailable state remains disabled. */}
},{immediate:true});
const vmAvailable = ref(false);
watch(() => [launcherOpen.value, props.authorityHost], async (_, __, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  vmAvailable.value = false;
  if (!launcherOpen.value) return;
  try {
    const available = await props.authorityHost?.vmAvailable?.();
    if (current) vmAvailable.value = available === true;
  } catch { /* Missing or failed availability leaves VM hidden. */ }
}, { immediate: true, flush: 'sync' });
const railOpen = ref(true);
const settingsOpen = ref(props.fixture?.screen === 'settings');
const creativeOpen = ref(props.fixture?.key === 'creative');
const creativeFrames = computed(() => /** @type {unknown[]} */ (props.fixture?.ui.creativeFrames ?? []));
const terminalOpen = ref(props.fixture?.key === 'side-terminal-open');
const terminalDeckOpen = computed(() => terminalOpen.value && !nestedMode.displayOnly && props.fixture?.key !== 'side-terminal-open');
// MVUI29c lane T: the multislot auto-open keeps its fixture-key rule
// (multislot/recording) and additionally opens for the screen that
// renders it: the terminal-live alias declares screen 'multislot' under
// another key and must open. Additive only, so every committed harness
// mounting with a key and no screen sees exactly the previous children.
const multislotOpen = ref(['multislot', 'recording'].includes(props.fixture?.key ?? '') || props.fixture?.screen === 'multislot');
const capturePanelOnly = ref(false);
const selectedCapsuleId = ref(props.fixture?.capsules[0]?.id ?? '');
// MVUI25 lane A: the wall shares this app-level input mode with the
// multislot (v-model below); the input-write fixture starts in WRITE.
// The fixture declares ui.inputMode as READ/WRITE; App works in read/write.
// No new import: the App import surface stays pinned for the stub harnesses.
const inputMode = ref(String(props.fixture?.ui?.inputMode ?? '').toLowerCase() === 'write' ? 'write' : 'read');
// App owns the controlled presentation until the authoritative row changes.
const foldOverrides = ref(/** @type {Record<string, boolean>} */ ({}));
const selectedFolded = computed(() => selectedSurface.value
  ? foldOverrides.value[selectedSurface.value.id] ?? selectedSurface.value.visibility === 'folded' : false);
const selectedSurface = computed(() => rows.value.find(row => row.id === selectedCapsuleId.value) ?? rows.value[0] ?? null);
const pairedTerminalTarget = shallowRef(/** @type {any} */ (null));
const activeTerminalPair = ref(/** @type {string|null} */ (null));
const terminalPreferDock = ref(false);
const terminalDrawerHosts = shallowRef(/** @type {Record<string,{element:HTMLElement,width:number,height:number,visible:boolean}>} */ ({}));
/** Keep the wall cell stable; sufficiently tall visible tiles reserve a row
 * below their live viewport. Unknown geometry stays in the side dock.
 * @param {any} target @param {Record<string,any>} hosts @param {boolean} open @param {boolean} preferDock */
function pairedDrawerTarget(target, hosts, open, preferDock) {
  const host=target && hosts[target.surfaceId];
  return open && !preferDock && host?.visible && host.width >= 400 && host.height >= 600 ? host.element : null;
}
const terminalDrawerTarget = computed(() => pairedDrawerTarget(pairedTerminalTarget.value,terminalDrawerHosts.value,terminalDeckOpen.value,terminalPreferDock.value));
const terminalInDrawer = computed(() => Boolean(terminalDrawerTarget.value));
const terminalDockOpen = computed(() => terminalDeckOpen.value && !terminalInDrawer.value);
watch(activeTerminalPair,(id,previous) => {
  if (previous && terminalInDrawer.value && id !== pairedTerminalTarget.value?.surfaceId) terminalPreferDock.value=true;
});
function toggleTerminalDock() {
  if (terminalInDrawer.value) {terminalPreferDock.value=true;return;}
  toggleTerminal();
}
provide('capsuleTerminal', {
  available: () => !nestedMode.displayOnly && typeof props.terminalBroker?.open === 'function',
  isOpen: (/** @type {string} */ id) => terminalDeckOpen.value && activeTerminalPair.value === id,
  inDrawer: (/** @type {string} */ id) => terminalInDrawer.value && pairedTerminalTarget.value?.surfaceId === id,
  registerDrawer(/** @type {string} */ id, /** @type {HTMLElement|null} */ element, /** @type {{width:number,height:number,visible:boolean}} */ geometry) {
    const previous=terminalDrawerHosts.value[id];
    if (previous?.element===element && previous?.width===geometry.width && previous?.height===geometry.height && previous?.visible===geometry.visible) return;
    const next={...terminalDrawerHosts.value};
    if (element) next[id]={element,...geometry}; else delete next[id];
    terminalDrawerHosts.value=next;
  },
  toggle(/** @type {string} */ id) {
    if (terminalDeckOpen.value && activeTerminalPair.value === id) { terminalOpen.value=false; return; }
    const row=rows.value.find(row=>row.id===id && row.backendLifecycle!=='destroyed' && row.backendLifecycle!=='lost');
    if (!row) return;
    terminalPreferDock.value=false;
    if (!terminalDeckOpen.value) toggleTerminal();
    pairedTerminalTarget.value={surfaceId:row.id,profileId:row.profile_id,title:surfaceLabel(row)};
  },
});
/** Renderer intents remain events until a host supplies an authoritative dispatcher. */
const emit = defineEmits(['submit-intent', 'create-capsule']);
/** HANDOFF F5 (INPUT-ARM): the handoff take-control also selects and reveals
 * the capsule's tile, then takes control through the wall arming path.
 * @param {string} surfaceId */
function takeHandoffControl(surfaceId) {
  revealHandoffSurface(surfaceId);
  if (props.runtime?.intentBuilders) applyWallControl(surfaceId, 'take_control');
}
/** @param {unknown} surfaceId */
function revealHandoffSurface(surfaceId) {
  if (nestedMode.displayOnly || typeof surfaceId !== 'string') return;
  const row = rows.value.find(row => row.id === surfaceId || row.surfaceId === surfaceId);
  if (!row) return;
  selectedCapsuleId.value = row.id;
  // The tile lives on the wall: leave the screens that cover it.
  creativeOpen.value = false;
  settingsOpen.value = false;
  multislotOpen.value = false;
  terminalOpen.value = false;
  if (wall.value?.revealSurface(row.id, 'tab')?.ok === true) markPanelOpen(row.id);
}
/**
 * INPUT-ARM [TARGET, unit decision]: per-capsule wall input arming.
 * Taking control from the wall (the tile Control action, the view-only chip,
 * the handoff notice, or attaching to an already-human surface) routes through
 * `applyWallControl` and arms WRITE for that capsule only; the arm turns
 * interactive once the authoritative row reports human control. Releasing
 * control, a host refusal, a feed update that moves control away from human,
 * or the row departing or going lost disarms it. The host still re-checks
 * every batch (NOT_IN_CONTROL); agent control and nested display-only never
 * enable input. The arm applies to wall tiles only: the multislot keeps its
 * own shared inputMode toggle.
 */
const wallInputArmed = ref(/** @type {Record<string, true>} */ ({}));
const wallInputPending = ref(/** @type {Record<string, true>} */ ({}));
const wallInputEscaped = ref(/** @type {Record<string, true>} */ ({}));
/** @type {Set<string>} */
const seenLiveSurfaces = new Set();
const ARMABLE_LIFECYCLES = Object.freeze(['active', 'standby', 'ceded']);
/** @param {Record<string, true>} record @param {string} id */
function withoutId(record, id) {
  const next = { ...record };
  delete next[id];
  return next;
}
/** @param {unknown} intent @returns {{verb:'take_control'|'release_control', id:string}|null} */
function wallControlRequestOf(intent) {
  const record = /** @type {any} */ (intent);
  if (record === null || typeof record !== 'object') return null;
  const verb = record.op ?? record.type;
  if (verb !== 'take_control' && verb !== 'release_control') return null;
  const raw = record.params?.surface_id ?? record.surfaceId ?? record.capsuleId;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const row = rows.value.find(row => row.id === raw || row.surfaceId === raw);
  return row ? { verb, id: row.id } : null;
}
/** @param {string} id */
function disarmWallInput(id) {
  if (Object.hasOwn(wallInputArmed.value, id)) wallInputArmed.value = withoutId(wallInputArmed.value, id);
  if (Object.hasOwn(wallInputPending.value, id)) wallInputPending.value = withoutId(wallInputPending.value, id);
  if (Object.hasOwn(wallInputEscaped.value, id)) wallInputEscaped.value = withoutId(wallInputEscaped.value, id);
}
/** Arms a human row at once; any other control waits for the host grant.
 * @param {string} id */
function armWallInput(id) {
  if (nestedMode.displayOnly) return;
  const row = rows.value.find(row => row.id === id);
  if (!row || !ARMABLE_LIFECYCLES.includes(row.backendLifecycle)) return;
  if (Object.hasOwn(wallInputEscaped.value, id)) wallInputEscaped.value = withoutId(wallInputEscaped.value, id);
  if (row.control === 'human') {
    wallInputArmed.value = { ...wallInputArmed.value, [id]: true };
    if (Object.hasOwn(wallInputPending.value, id)) wallInputPending.value = withoutId(wallInputPending.value, id);
  } else {
    wallInputPending.value = { ...wallInputPending.value, [id]: true };
  }
}
/** @param {string} id */
function onCanvasEscape(id) {
  if (typeof id !== 'string' || id.length === 0) return;
  const row = rows.value.find(candidate => candidate.id === id);
  if (!row || !(inputEnabledFor(row) || wallArmedFor(row))) return;
  wallInputEscaped.value = { ...wallInputEscaped.value, [id]: true };
}
/** @param {string} id */
function onCanvasFocus(id) {
  if (typeof id !== 'string' || !Object.hasOwn(wallInputEscaped.value, id)) return;
  wallInputEscaped.value = withoutId(wallInputEscaped.value, id);
}
/** Unified wall control path: header Control, chip Take/Release, handoff
 * take-control and attaching to an already-human surface all route here.
 * @param {string} id
 * @param {'take_control'|'release_control'} verb
 * @param {unknown} [prebuiltIntent] */
function applyWallControl(id, verb, prebuiltIntent) {
  if (nestedMode.displayOnly || typeof id !== 'string' || id.length === 0) return;
  const row = rows.value.find(candidate => candidate.id === id || candidate.surfaceId === id);
  const targetId = row ? row.id : id;
  // Native human capsules never enter the agent Control intent builder.
  const roleApi = /** @type {any} */(globalThis).metaviewerRoles;
  if (capsuleModes.value[targetId] === 'human') return;
  if (roleApi && !capsuleModes.value[targetId]) {
    void roleApi.status(targetId).then((/** @type {any} */ status) => {
      if (!['human','agent'].includes(status.role)) return;
      onCapsuleMode({surfaceId:targetId,mode:status.role});
      if (status.role === 'agent') applyWallControl(targetId,verb,prebuiltIntent);
    }).catch(() => {});
    return;
  }
  if (verb === 'release_control') {
    let intent = prebuiltIntent;
    if (intent === undefined) {
      const builders = props.runtime?.intentBuilders;
      if (!builders) return;
      try { intent = builders.control({ capsuleId: targetId, verb: 'release_control' }); }
      catch { hostOutcome.value = { code: 'HOST_REQUEST_REFUSED', message: 'This request is unavailable. Please try again.', tone: 'refusal' }; return; }
    }
    // Keep the human-control affordance until release is acknowledged. A
    // refused release leaves authoritative ownership with the operator.
    if (intent !== null && intent !== undefined) {
      const sent = dispatch(intent);
      if (sent !== undefined) void sent.then(result => {
        if (hostActive && (result === true || (result && typeof result === 'object'
            && /** @type {{tone?:unknown}} */ (result).tone === 'success'))) disarmWallInput(targetId);
      });
    }
    return;
  }
  armWallInput(targetId);
  if (prebuiltIntent === null || (prebuiltIntent === undefined && row?.control === 'human')) return;
  /** @type {unknown} */
  let intent = prebuiltIntent;
  if (intent === undefined) {
    const builders = props.runtime?.intentBuilders;
    if (!builders) {
      disarmWallInput(targetId);
      hostOutcome.value = { code: 'HOST_REQUEST_REFUSED', message: 'This request is unavailable. Please try again.', tone: 'refusal' };
      return;
    }
    try { intent = builders.control({ capsuleId: targetId, verb: 'take_control' }); }
    catch { disarmWallInput(targetId); hostOutcome.value = { code: 'HOST_REQUEST_REFUSED', message: 'This request is unavailable. Please try again.', tone: 'refusal' }; return; }
  }
  const sent = dispatch(intent);
  if (sent !== undefined) {
    const request = { id: targetId, verb };
    void sent.then((result) => {
      // A refused take never arms; an already armed human row stays armed.
      const refused = result === undefined || (result !== null && typeof result === 'object'
        && /** @type {{tone?:unknown}} */ (result).tone === 'refusal');
      if (hostActive && refused && Object.hasOwn(wallInputPending.value, request.id)) {
        wallInputPending.value = withoutId(wallInputPending.value, request.id);
      }
    });
  }
}
/** Feed reconcile: pending arms turn interactive on the human row; armed
 * capsules drop on any non-human, departed or lost row (one-way); newly
 * attached already-human surfaces arm through the unified control path. */
function reconcileWallInput() {
  const port = /** @type {{ available?: unknown } | null} */ (shellInputPort);
  const portAvailable = !nestedMode.displayOnly && port !== null && port.available === true;
  for (const row of rows.value) {
    if (!ARMABLE_LIFECYCLES.includes(row.backendLifecycle) || canvasStateFor(row) !== 'live') continue;
    if (!seenLiveSurfaces.has(row.id)) {
      seenLiveSurfaces.add(row.id);
      if (portAvailable && row.control === 'human') {
        applyWallControl(row.id, 'take_control', null);
      }
    }
  }
  const armed = Object.keys(wallInputArmed.value), pending = Object.keys(wallInputPending.value);
  const escaped = Object.keys(wallInputEscaped.value);
  if (armed.length === 0 && pending.length === 0 && escaped.length === 0) return;
  const byId = new Map(rows.value.map(row => [row.id, row]));
  /** @type {Record<string, true>} */ const nextArmed = {};
  /** @type {Record<string, true>} */ const nextPending = {};
  /** @type {Record<string, true>} */ const nextEscaped = {};
  for (const id of [...new Set([...armed, ...pending, ...escaped])]) {
    const row = byId.get(id);
    if (!row || !ARMABLE_LIFECYCLES.includes(row.backendLifecycle)) continue;
    if (row.control === 'human') {
      nextArmed[id] = true;
      if (wallInputEscaped.value[id] === true) nextEscaped[id] = true;
    } else if (pending.includes(id)) nextPending[id] = true;
  }
  const same = (/** @type {Record<string, true>} */ a, /** @type {Record<string, true>} */ b) =>
    Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n');
  if (!same(nextArmed, wallInputArmed.value)) wallInputArmed.value = nextArmed;
  if (!same(nextPending, wallInputPending.value)) wallInputPending.value = nextPending;
  if (!same(nextEscaped, wallInputEscaped.value)) wallInputEscaped.value = nextEscaped;
}
/** Wall and handoff intents: control verbs route through applyWallControl.
 * @param {unknown} intent */
function onWallIntent(intent) {
  const request = nestedMode.displayOnly ? null : wallControlRequestOf(intent);
  if (request) {
    applyWallControl(request.id, request.verb, intent);
    return;
  }
  dispatch(intent);
}
/** View-only chip: the same take-control gesture as the tile Control action.
 * A capsule already under human control arms locally (no second take).
 * @param {{id:string,control?:unknown}} surface */
function takeWallControl(surface) {
  if (nestedMode.displayOnly || !surface) return;
  applyWallControl(surface.id, 'take_control');
}
/** Interactive chip Release (HANDOFF F3): hands control back and disarms.
 * @param {{id:string}} surface */
function releaseWallControl(surface) {
  if (nestedMode.displayOnly || !surface) return;
  applyWallControl(surface.id, 'release_control');
}
/** @param {unknown} intent @returns {Promise<unknown>|undefined} */
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
    if (submitIntent) return submitHost(() => submitIntent(request));
    else emit('submit-intent', intent);
  } else if (propose) return submitHost(() => { assertLiveProposal(intent); return propose(intent); });
  else emit('submit-intent', intent);
  return undefined;
}
/** Committed placement echoes, keyed by surface; transport acceptance is never optimistic. */
const placements = ref(/** @type {Record<string, {hidden:boolean, floating:boolean, groupId?:string, index?:number, x?:number, y?:number, width?:number, height?:number, lastDockGroupId?:string, lastDockIndex?:number}>} */ ({}));
const placementPending = ref(/** @type {Record<string, boolean>} */ ({}));
/** MVUI32 lane A (R3-APP-1): per-surface lifetime epochs for the post-await
 * layout-echo fence. Bumped whenever an admitted row id departs (destroy or
 * replace), so an echo tells a same-lifetime frame advance (epoch unchanged)
 * from a destroyed or replaced lifetime (epoch changed or row absent). Plain
 * non-reactive Map with a fixed cap; eviction only ever fails a fence
 * closed, so a commit is retained and never misapplied. Surface ids are
 * never revived (scheduler tombstones), so an epoch only ever ends once. */
/** @type {Map<string, number>} */
const surfaceLifetimeEpochs = new Map();
const SURFACE_LIFETIME_EPOCH_LIMIT = 64;
/** @param {string} capsuleId @returns {number} */
function surfaceLifetimeEpochOf(capsuleId) {
  return surfaceLifetimeEpochs.get(capsuleId) ?? 0;
}
/** @param {string} capsuleId */
function bumpSurfaceLifetimeEpoch(capsuleId) {
  if (surfaceLifetimeEpochs.size >= SURFACE_LIFETIME_EPOCH_LIMIT && !surfaceLifetimeEpochs.has(capsuleId)) {
    const oldest = surfaceLifetimeEpochs.keys().next().value;
    if (oldest !== undefined) surfaceLifetimeEpochs.delete(oldest);
  }
  surfaceLifetimeEpochs.set(capsuleId, surfaceLifetimeEpochOf(capsuleId) + 1);
}
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
    // MVUI32 lane A (R3-APP-1): capture the surface lifetime epoch before the
    // authority await. Content frames may advance (g10 -> g11) on the same
    // lifetime while awaiting; only a destroyed or replaced surface ends it.
    const lifetimeEpoch = surfaceLifetimeEpochOf(capsuleId);
    try {
      const result = await submitHost(async () => {
        const reply = /** @type {unknown} */ (await submitIntent(intent));
        if (reply === true || (reply && typeof reply === 'object' && 'tone' in reply && reply.tone === 'refusal')) return reply;
        throw new Error('Host acknowledgement unavailable');
      });
      // This port resolves true only after the core echoes the journaled intent.
      // Refusals, missing acknowledgments, unmounted hosts, and echoes for a
      // destroyed or replaced surface lifetime retain the layout. Same-lifetime
      // frame advances no longer drop the commit (R3-APP-1).
      if (result !== true || !hostActive || surfaceLifetimeEpochOf(capsuleId) !== lifetimeEpoch
        || !rows.value.some(row => row.id === capsuleId)) return;
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
/** @param {any} body */
function assertLiveProposal(body) {
  const row = rows.value.find(row => (row.surfaceId || row.id) === body?.surface_id);
  if (!row || !['active','standby','ceded'].includes(row.backendLifecycle)
      || (row.attachmentState !== undefined && row.attachmentState !== 'live')
      || !Number.isSafeInteger(row.generation) || row.generation < 1
      || row.generation !== body?.based_on_frame?.generation) {
    throw Object.assign(new Error('NO_BROWSER_CAPSULE: no live browser capsule and frame'), {code:'NO_BROWSER_CAPSULE'});
  }
}
// [TARGET, unit decision] Tile close (x) leaves the capsule running, so rows stay admitted while
// their panels are gone. Closed ids are tracked here only to show the empty-wall hint and the
// way back (Add capsule -> open browser reveals the live tile) when every tile was closed.
const desktopState = ref(createDesktopState());
const desktopStateLoaded = ref(false);
/** @param {import('../electron/desktopLayout.js').DesktopState} state */
function onDesktopsChange(state) { desktopState.value = state; desktopStateLoaded.value = true; }
/** @param {string} view */
function selectGlobalView(view) {
  creativeOpen.value = false; settingsOpen.value = false; multislotOpen.value = false;
  moreOpen.value = false; identitiesOpen.value = false;
  launcherOpen.value = false; demoOpen.value = false;
  wall.value?.selectView?.(view);
}
const capsuleModes = ref(/** @type {Record<string,string>} */ ({}));
const stoppedSurfaces = ref(/** @type {Record<string,boolean>} */ ({}));
/** @param {{surfaceId:string,mode:string}} event */
function onCapsuleMode(event) {
  capsuleModes.value = {...capsuleModes.value,[event.surfaceId]:event.mode};
  if (event.mode === 'closed') {
    wall.value?.applyPresentationIntent?.({type:'close',capsuleId:event.surfaceId});
    revealed.delete(event.surfaceId);
    closedPanels.value = closedPanels.value.filter(closed => closed !== event.surfaceId);
    stoppedSurfaces.value = {...stoppedSurfaces.value,[event.surfaceId]:true};
  }
}
// [TARGET, unit decision] Native creation stays successful while presentation is retryable.
/** @param {string} surfaceId */
function reportRevealPending(surfaceId) {
  hostOutcome.value = {code:'CAPSULE_REVEAL_PENDING',tone:'refusal',message:`Capsule ${surfaceId} is running but its tile could not be shown. For a program, open it in Identities; for a window, select it again in Add capsule to retry.`};
}
/** @param {string} surfaceId @param {string} [mode] */
async function revealOpenedIdentity(surfaceId, mode) {
  if (mode && ['human','agent'].includes(mode)) onCapsuleMode({surfaceId,mode});
  await pollNativeSurfaces().catch(() => {});
  try {
    for (let attempt = 0; attempt < 30 && hostActive; attempt++) {
      await wall.value?.followSurface?.(surfaceId,mode);
      if (settled.value && wall.value?.revealSurface(surfaceId,'split')?.ok) { markPanelOpen(surfaceId); return true; }
      await new Promise(resolve => setTimeout(resolve,100));
    }
  } catch { /* Creation is already acknowledged; expose a presentation retry. */ }
  if (hostActive) reportRevealPending(surfaceId);
  return false;
}
/** Remove the ended lifetime's pane only after the host acknowledged Stop/Switch.
 * @param {string} surfaceId */
function onCapsuleStopped(surfaceId) {
  stoppedSurfaces.value = {...stoppedSurfaces.value,[surfaceId]:true};
  wall.value?.applyPresentationIntent?.({type:'close',capsuleId:surfaceId});
  wall.value?.forgetSurface?.(surfaceId);
  const modes = {...capsuleModes.value}; delete modes[surfaceId]; capsuleModes.value = modes;
  closedPanels.value = closedPanels.value.filter(id => id !== surfaceId);
}
/** The tile may unmount on destroy before its replacement reply arrives.
 * @param {{surfaceId:string,completion:Promise<any>}} event */
function onCapsuleLifecycle({surfaceId,completion}) {
  void submitHost(async () => {
    const result = await completion;
    if (!result.ok) throw Object.assign(Error(result.code),{code:result.code,...(typeof result.reason === 'string' && result.reason ? {reason:result.reason} : {})});
    onCapsuleStopped(surfaceId);
    if (result.surfaceId && !await revealOpenedIdentity(result.surfaceId,result.role)) throw Object.assign(Error('TILE_REVEAL_UNPROVEN'),{code:'TILE_REVEAL_UNPROVEN'});
    return true;
  });
}
const pendingModeSwitch = ref(/** @type {any} */ (null));
const browserCreatePending = ref(false);
const browserCreateNotice = ref('');
const modalOpen = computed(() => !nestedMode.displayOnly && Boolean(pendingModeSwitch.value || launcherOpen.value || identitiesOpen.value || demoOpen.value || moreOpen.value || settingsOpen.value || multislotOpen.value || (terminalOpen.value && !terminalDeckOpen.value)));
function syncModalAttr(open = modalOpen.value) {
  if (overlayCoordinator) { overlayCoordinator.set(appOverlayOwner, open); return; }
  const body = /** @type {any} */ (globalThis.document)?.body;
  if (!body) return;
  if (open) {
    if (typeof body.setAttribute === 'function') body.setAttribute('data-mv-modal', 'open');
    if (body.dataset) body.dataset.mvModal = 'open';
  } else {
    if (typeof body.removeAttribute === 'function') body.removeAttribute('data-mv-modal');
    if (body.dataset) delete body.dataset.mvModal;
  }
}
watch(modalOpen, open => { syncModalAttr(open); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { syncModalAttr(false); });
async function confirmModeSwitch() {
  const current = pendingModeSwitch.value; pendingModeSwitch.value = null;
  if (!current) return;
  await submitHost(async () => {
    const result = await /** @type {any} */(globalThis).metaviewerRoles.switchMode(current.surfaceId);
    if (!result.ok) {
      if (result.code === 'SURFACE_CREATE_BUSY' || result.busy) { pendingModeSwitch.value = current; return null; }
      throw Object.assign(Error(result.code),{code:result.code,...(typeof result.reason === 'string' && result.reason ? {reason:result.reason} : {})});
    }
    await revealOpenedIdentity(result.surfaceId,result.role);
    onCapsuleStopped(current.surfaceId);
    return null;
  });
}
const closedPanels = ref(/** @type {string[]} */ ([]));
/** @param {any} payload */
function onPanelClosed(payload) {
  const id = payload?.capsuleId;
  if (typeof id === 'string' && !closedPanels.value.includes(id)) closedPanels.value = [...closedPanels.value, id];
}
/** @param {string} id */
function markPanelOpen(id) {
  if (closedPanels.value.includes(id)) closedPanels.value = closedPanels.value.filter(closed => closed !== id);
}
const visibleRows = computed(() => desktopStateLoaded.value
  ? desktopRows(desktopState.value,rows.value,desktopState.value.activeView,desktopState.value.views[desktopState.value.activeView].active)
  : rows.value);
// The empty desktop offers a direct route to capsules in the other view.
const otherCapsuleView = computed(() => {
  const other = desktopState.value.activeView === 'human' ? 'agent' : 'human';
  return rows.value.some(row => desktopState.value.assignments[row.id]?.view === other) ? other : '';
});
const allTilesClosed = computed(() => visibleRows.value.length > 0 && visibleRows.value.every(row => closedPanels.value.includes(row.id)));
/** Reveals every live admitted surface in the wall (a closed tile's panel is gone, its row is not).
 * @returns {boolean} true when at least one tile is shown. */
function reopenLiveSurfaces() {
  let shown = false;
  for (const row of rows.value) {
    if (!['active', 'standby', 'ceded'].includes(row.backendLifecycle)) continue;
    if (wall.value?.revealSurface(row.id, 'tab')?.ok === true) { shown = true; markPanelOpen(row.id); }
  }
  return shown;
}
/** @param {any} choice */
function openIdentityChoice(choice) {
  if (choice.surfaceId) {
    selectGlobalView(choice.role);
    void revealOpenedIdentity(choice.surfaceId,choice.role);
    return;
  }
  onCreateCapsule({kind:'identity-browser',choice});
}
/** @param {any} body */
async function createProgramCapsule(body) {
  const roles = /** @type {any} */ (globalThis).metaviewerRoles;
  if (!roles?.createProgram) {
    return {
      ok: false,
      code: 'HOST_PROGRAM_UNAVAILABLE',
      reason: 'host_program_unavailable: program launching is not available on this host',
    };
  }
  let programReply;
  if (body.role === 'human' || body.role === 'agent') {
    programReply = await roles.createProgram({ binary: body.binary.trim(), role: body.role, ...(body.kind === 'host-program' || body.hostXpra === true ? {hostXpra:true} : {}) });
  } else {
    const reply = await roles.createProgram({ binary: body.binary.trim() });
    programReply = reply;
  }
  const reply = programReply;
  if (!reply?.ok) {
    const code = typeof reply?.code === 'string' && reply.code.length > 0 ? reply.code : 'HOST_PROGRAM_UNAVAILABLE';
    const reason = typeof reply?.reason === 'string' && reply.reason.length > 0 ? reply.reason : code;
    return { ok: false, code, reason };
  }
  const openedRole = reply.role === 'human' || (reply.role === undefined && body.role === 'human') ? 'human' : 'agent';
  try {
    selectGlobalView(openedRole);
    await nextTick();
    if (reply.surfaceId) {
      await revealOpenedIdentity(reply.surfaceId, openedRole);
    }
  } catch {
    if (reply.surfaceId) reportRevealPending(reply.surfaceId);
  }
  return reply;
}
/** @param {any} body */
async function createWindowCapsule(body) {
  const roles = /** @type {any} */ (globalThis).metaviewerRoles;
  if (!roles?.createWindow) {
    return {
      ok: false,
      code: 'HOST_WINDOW_UNAVAILABLE',
      reason: 'host_window_unavailable: desktop window attaching is not available on this host',
    };
  }
  let reply = await roles.createWindow(body.window);
  if (reply?.ok === false && reply.code === 'PROFILE_ALREADY_BOUND' && reply.surfaceId) {
    reply = {ok:true, reused:true, surfaceId:reply.surfaceId};
  }
  if (!reply?.ok) {
    const code = typeof reply?.code === 'string' && reply.code.length > 0 ? reply.code : 'HOST_WINDOW_UNAVAILABLE';
    const reason = typeof reply?.reason === 'string' && reply.reason.length > 0 ? reply.reason : code;
    return { ok: false, code, reason };
  }
  try {
    selectGlobalView('agent');
    await nextTick();
    if (reply.surfaceId) {
      await revealOpenedIdentity(reply.surfaceId, 'agent');
      if (!reply.reused && props.runtime?.intentBuilders) {
        wallInputPending.value = { ...wallInputPending.value, [reply.surfaceId]: true };
        applyWallControl(reply.surfaceId, 'take_control');
      }
    }
  } catch {
    if (reply.surfaceId) reportRevealPending(reply.surfaceId);
  }
  return reply;
}
/** @param {unknown} intent @param {((outcome: any) => void)|undefined} [settle] */
function onCreateCapsule(intent, settle) {
  if (nestedMode.displayOnly) {
    settle?.({ ok: false, code: 'DISPLAY_ONLY', reason: 'Nested walls are display-only and cannot open new capsules.' });
    return;
  }
  const propose = props.authorityHost?.propose;
  const body = /** @type {any} */ (intent);
  if (body?.kind === 'microvm') {
    selectGlobalView('agent');
    if(guestWorkloadTiles.value.length){launcherOpen.value=false;showGuestConsole();return;}
    if(Object.keys(body).every(k=>['kind','type','placement'].includes(k)) && guestCommandSnapshot.value.available){launcherOpen.value=false;void guestCommandAction({op:'create'});return;}
    if(Object.keys(body).every(k=>['kind','type','placement'].includes(k)) && headlessSnapshot.value.available) {launcherOpen.value=false;void headlessAction('create');}
    return;
  }
  if (body?.kind === 'vm') {
    const valid = Object.keys(body).every(key => ['kind','type','placement'].includes(key))
      && (body.type === undefined || body.type === 'create-capsule')
      && (body.placement === undefined || ['tab','split','floating'].includes(body.placement));
    void submitHost(async () => {
      if (!valid) throw Object.assign(new Error('VM_SELECTOR_INVALID'),{code:'VM_SELECTOR_INVALID'});
      if (!props.authorityHost?.createSurface) throw Object.assign(new Error('VM_UNAVAILABLE'),{code:'VM_UNAVAILABLE'});
      return props.authorityHost.createSurface({kind:'vm'});
    });
    return;
  }
  if (body?.kind === 'program' || body?.kind === 'host-program') {
    if (body.profileId || body.profile_id || body.choice?.profileId || body.choice?.profile_id) {
      const reason = 'Renderer cannot select a profile for a program capsule.';
      settle?.({ ok: false, code: 'PROGRAM_PROFILE_FORBIDDEN', reason });
      hostOutcome.value = /** @type {any} */ ({ code: 'PROGRAM_PROFILE_FORBIDDEN', reason, message: reason, tone: 'refusal' });
      recordActivity({ code: 'PROGRAM_PROFILE_FORBIDDEN', reason });
      return;
    }
    if (body.profile || body.choice?.profile || body.choice) {
      const reason = 'Renderer cannot select a profile for a program capsule.';
      settle?.({ ok: false, code: 'PROGRAM_PROFILE_FORBIDDEN', reason });
      hostOutcome.value = /** @type {any} */ ({ code: 'PROGRAM_PROFILE_FORBIDDEN', reason, message: reason, tone: 'refusal' });
      recordActivity({ code: 'PROGRAM_PROFILE_FORBIDDEN', reason });
      return;
    }
    if (typeof body.binary !== 'string' || body.binary.trim().length === 0) {
      const reason = 'Binary name is required.';
      settle?.({ ok: false, code: 'PROGRAM_BINARY_REQUIRED', reason });
      const legacyNoBrowser = !('binary' in body) && !settle && !(/** @type {any} */ (globalThis).metaviewerRoles);
      const outcomeCode = legacyNoBrowser ? 'NO_BROWSER_CAPSULE' : 'PROGRAM_BINARY_REQUIRED';
      hostOutcome.value = legacyNoBrowser
        ? { code: outcomeCode, message: 'NO_BROWSER_CAPSULE', tone: 'refusal' }
        : /** @type {any} */ ({ code: outcomeCode, reason, message: reason, tone: 'refusal' });
      recordActivity(legacyNoBrowser ? { code: outcomeCode } : { code: outcomeCode, reason });
      return;
    }
    if (body.role !== undefined && body.role !== 'human' && body.role !== 'agent') {
      const reason = 'Invalid capsule role.';
      settle?.({ ok: false, code: 'CAPSULE_ROLE_INVALID', reason });
      hostOutcome.value = /** @type {any} */ ({ code: 'CAPSULE_ROLE_INVALID', reason, message: reason, tone: 'refusal' });
      recordActivity({ code: 'CAPSULE_ROLE_INVALID', reason });
      return;
    }
    const promise = createProgramCapsule(body);
    settle?.(promise);
    void submitHost(async () => {
      const reply = await promise;
      if (!reply?.ok) {
        const code = reply?.code || 'HOST_PROGRAM_UNAVAILABLE';
        const reason = typeof reply?.reason === 'string' && reply.reason.length > 0 ? reply.reason : code;
        throw Object.assign(new Error(reason), { code, reason });
      }
      return null;
    });
    return;
  }
  if (body?.kind === 'desktop-window') {
    if (body.profileId || body.profile_id || body.choice?.profileId || body.choice?.profile_id || body.profile || body.choice?.profile || body.choice) {
      const reason = 'Renderer cannot select a profile for a desktop window capsule.';
      settle?.({ ok: false, code: 'WINDOW_PROFILE_FORBIDDEN', reason });
      hostOutcome.value = /** @type {any} */ ({ code: 'WINDOW_PROFILE_FORBIDDEN', reason, message: reason, tone: 'refusal' });
      recordActivity({ code: 'WINDOW_PROFILE_FORBIDDEN', reason });
      return;
    }
    const win = body.window;
    const xid = Number(win?.xid);
    const witness = typeof win?.witness === 'string' ? win.witness.trim() : '';
    const title = typeof win?.title === 'string' ? win.title.trim() : '';
    const program = typeof win?.program === 'string' ? win.program.trim() : '';
    if (!win || typeof win !== 'object' || !Number.isInteger(xid) || xid <= 0 || !witness || !title || !program) {
      const reason = 'Desktop window selection is required.';
      settle?.({ ok: false, code: 'WINDOW_CHOICE_REQUIRED', reason });
      const legacyNoBrowser = !('window' in body) && !settle && !(/** @type {any} */ (globalThis).metaviewerRoles);
      const outcomeCode = legacyNoBrowser ? 'NO_BROWSER_CAPSULE' : 'WINDOW_CHOICE_REQUIRED';
      hostOutcome.value = legacyNoBrowser
        ? { code: outcomeCode, message: 'NO_BROWSER_CAPSULE', tone: 'refusal' }
        : /** @type {any} */ ({ code: outcomeCode, reason, message: reason, tone: 'refusal' });
      recordActivity(legacyNoBrowser ? { code: outcomeCode } : { code: outcomeCode, reason });
      return;
    }
    const promise = createWindowCapsule(body);
    settle?.(promise);
    void submitHost(async () => {
      const reply = await promise;
      if (!reply?.ok) {
        const code = reply?.code || 'HOST_WINDOW_UNAVAILABLE';
        const reason = typeof reply?.reason === 'string' && reply.reason.length > 0 ? reply.reason : code;
        throw Object.assign(new Error(reason), { code, reason });
      }
      return null;
    });
    return;
  }
  if (props.authorityHost && body?.schema !== 'action_proposal/v0.2') {
    if (!props.authorityHost.createSurface && propose && body?.kind === 'browser' && props.fixture?.key === 'multislot') {
      void submitHost(() => propose({
        schema: 'action_proposal/v0.2',
        proposal_id: 'mv-fixture-propose',
        surface_id: rows.value[0]?.surfaceId || rows.value[0]?.id || 'surface-a',
        based_on_frame: { generation: rows.value[0]?.generation ?? 1, sha256: 'a'.repeat(64) },
        action: { type: 'click', x: 0, y: 0, button: 'left' },
        budget: { max_ms: 100, max_retries: 0 },
      }));
      return;
    }
    void submitHost(async () => {
      if ((body?.kind !== 'browser' && body?.kind !== 'identity-browser') || !props.authorityHost?.createSurface) {
        throw Object.assign(new Error('NO_BROWSER_CAPSULE'), {code:'NO_BROWSER_CAPSULE'});
      }
      let ownsBrowserCreate = false;
      try {
        if (body.choice && /** @type {any} */ (globalThis).metaviewerRoles) {
          if (body.choice.busy || (typeof browserCreatePending !== 'undefined' && browserCreatePending.value)) {
            if (typeof browserCreateNotice !== 'undefined') browserCreateNotice.value = 'Another capsule is already starting. Wait for it to finish, then try again.';
            return null;
          }
          if (typeof browserCreateNotice !== 'undefined') browserCreateNotice.value = '';
          if (typeof browserCreatePending !== 'undefined') { browserCreatePending.value = true; ownsBrowserCreate = true; }
          const reply = await /** @type {any} */ (globalThis).metaviewerRoles.open(body.choice);
          if (!reply.ok && reply.code === 'PROFILE_ALREADY_BOUND' && reply.surfaceId) {
            if (reply.currentMode === 'lost') throw Object.assign(Error('PROFILE_ALREADY_BOUND'),{
              code:'PROFILE_ALREADY_BOUND',reason:'Open Identities and choose Stop lost capsule before reopening this identity.',
            });
            if (!reply.requestedMode || reply.requestedMode === reply.currentMode) {
              selectGlobalView(reply.role || reply.currentMode);
              void revealOpenedIdentity(reply.surfaceId,reply.role || reply.currentMode);
              return null;
            }
            selectGlobalView(body.choice.role);
            pendingModeSwitch.value = reply;
            return null;
          }
          if (!reply.ok && reply.code === 'PROFILE_ALREADY_BOUND') {
            const bound = rows.value.find(row => (/** @type {any} */ (row).profile_id || row.title) === body.choice.profileId);
            if (bound) { void revealOpenedIdentity(bound.id,capsuleModes.value[bound.id]); return null; }
          }
          if (!reply.ok && (reply.code === 'SURFACE_CREATE_BUSY' || reply.busy)) {
            if (typeof browserCreateNotice !== 'undefined') browserCreateNotice.value = 'Another capsule is already starting. Wait for it to finish, then try again.';
            return null;
          }
          if (!reply.ok) throw Object.assign(new Error(reply.code), {code:reply.code, ...(typeof reply.reason === 'string' && reply.reason ? {reason:reply.reason} : {})});
          selectGlobalView(reply.role || reply.currentMode || body.choice.role);
          if (reply.surfaceId) void revealOpenedIdentity(reply.surfaceId,reply.role || reply.currentMode);
          return null;
        }
        return await props.authorityHost.createSurface();
      } catch (error) {
        // [TARGET, unit decision] The tile close (x) is presentation-only: the capsule keeps
        // running under its profile, so a second create is refused as bound. Reopen means
        // showing the live surface again, never a second create.
        if (/** @type {{code?:unknown}} */ (error)?.code === 'SURFACE_PROFILE_BOUND' && reopenLiveSurfaces()) {
          return /** @type {const} */ ({ code: 'INTENT_ACKNOWLEDGED', message: 'Request sent.', tone: 'success' });
        }
        throw error;
      } finally {
        if (ownsBrowserCreate) browserCreatePending.value = false;
      }
    });
    return;
  }
  if (propose) void submitHost(() => {
    assertLiveProposal(intent);
    return propose(intent);
  });
  else emit('create-capsule', intent);
}
const hostOutcome = ref(/** @type {import('./core/hostAdapters.js').OutcomeRow|null} */ (null));
let hostActive = true;
onBeforeUnmount(() => { hostActive = false; });
/** Latest authority receipts (propose verdicts, intent acks/refusals) for
 * the activity strip. Bounded inline so stub harnesses never resolve the
 * model module; the bound mirrors MV_ACTIVITY_LIMIT in
 * activity/activityModel.js and the activity app test pins both literals. */
const activityFeed = ref(/** @type {Array<{seq:number,code:string,count?:number}>} */ ([]));
const ACTIVITY_LIMIT = 8;
let activitySeq = 0;
/** @param {unknown} outcome */
function recordActivity(outcome) {
  if (!hostActive) return;
  activitySeq += 1;
  const record = /** @type {{code?:unknown,reason?:unknown}} */ (outcome);
  const code = typeof record?.code === 'string' ? record.code : '';
  const reason = typeof record?.reason === 'string' && record.reason.length > 0 && record.reason.length <= 256 && !/[\x00-\x1f\x7f]/.test(record.reason)
    ? record.reason
    : undefined;
  activityFeed.value = [...activityFeed.value, Object.freeze(reason ? { seq: activitySeq, code, reason } : { seq: activitySeq, code })].slice(-ACTIVITY_LIMIT);
}
/**
 * MVUI26B lane M: human-input port provided by the entry (`inputPort`); null
 * in hosts without input (fixtures that predate the port, bare mounts).
 * The shell subscribes exactly once for refusal rows; it never sends.
 * @typedef {{ onRefusal: (cb: (refusal: { surfaceId: string, code: string }) => void) => unknown }} ShellInputPort
 */
const shellInputPort = /** @type {ShellInputPort | null} */ (inject('inputPort', null));
const wallInputRefusal = ref(/** @type {Record<string, string>} */ ({}));
/** @type {Map<string, { code: string, at: number }>} */
const wallInputRefusalBurst = new Map();
/** @type {Map<string, unknown>} */
const wallInputRefusalTimers = new Map();
const REFUSAL_BURST_MS = 1000;
const REFUSAL_DISPLAY_MS = 2500;
/** Records one port refusal as a typed strip row and rate-limited chip notice.
 * Consecutive repeats of the same code coalesce into the last row (the sequence
 * stays, only the burst count grows), so a refusal burst is one row with a count
 * instead of feed spam; any other code or activity starts a fresh row.
 * @param {unknown} refusal */
function recordInputRefusal(refusal) {
  if (!hostActive) return;
  const record = /** @type {{surfaceId?:unknown,code?:unknown}} */ (refusal);
  const code = typeof record?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(record.code) ? record.code : '';
  if (code.length === 0) return;
  const surfaceId = typeof record?.surfaceId === 'string' ? record.surfaceId : '';
  if (surfaceId.length > 0) {
    const ts = Date.now();
    const prior = wallInputRefusalBurst.get(surfaceId);
    if (!prior || prior.code !== code || ts - prior.at >= REFUSAL_BURST_MS) {
      wallInputRefusalBurst.set(surfaceId, { code, at: ts });
      wallInputRefusal.value = { ...wallInputRefusal.value, [surfaceId]: `Input refused: ${code}` };
      const existing = wallInputRefusalTimers.get(surfaceId);
      if (existing !== undefined) clearTimeout(/** @type {any} */ (existing));
      const timer = setTimeout(() => {
        wallInputRefusalTimers.delete(surfaceId);
        if (!hostActive) return;
        const next = { ...wallInputRefusal.value };
        delete next[surfaceId];
        wallInputRefusal.value = next;
      }, REFUSAL_DISPLAY_MS);
      wallInputRefusalTimers.set(surfaceId, timer);
    }
  }
  const feed = activityFeed.value;
  const last = feed.length > 0 ? feed[feed.length - 1] : undefined;
  if (last !== undefined && last.code === code && typeof last.count === 'number') {
    activityFeed.value = [...feed.slice(0, -1), Object.freeze({ seq: last.seq, code, count: last.count + 1 })];
    return;
  }
  activitySeq += 1;
  activityFeed.value = [...feed, Object.freeze({ seq: activitySeq, code, count: 1 })].slice(-ACTIVITY_LIMIT);
}
let stopInputRefusals = /** @type {(() => void) | null} */ (null);
try {
  if (shellInputPort !== null && typeof shellInputPort.onRefusal === 'function') {
    const stop = shellInputPort.onRefusal(recordInputRefusal);
    if (typeof stop === 'function') stopInputRefusals = /** @type {() => void} */ (stop);
  }
} catch { /* A broken port never breaks the shell. */ }
onBeforeUnmount(() => {
  for (const timer of wallInputRefusalTimers.values()) clearTimeout(/** @type {any} */ (timer));
  wallInputRefusalTimers.clear();
  wallInputRefusalBurst.clear();
  const stop = stopInputRefusals;
  stopInputRefusals = null;
  if (stop !== null) {
    try { stop(); } catch { /* Teardown never throws. */ }
  }
});
/** @param {()=>Promise<unknown>} action */
async function submitHost(action) {
  try {
    const result = await action();
    if (result === null || result === undefined) return result;
    if (hostActive) hostOutcome.value = result === true
      ? { code: 'INTENT_ACKNOWLEDGED', message: 'Request sent.', tone: 'success' }
      : /** @type {import('./core/hostAdapters.js').OutcomeRow} */ (result);
    if (hostActive) recordActivity(result === true ? { code: 'INTENT_ACKNOWLEDGED' } : result);
    return result;
  } catch (error) {
    const suppliedCode = /** @type {{code?:unknown}} */ (error)?.code;
    const rawMissing = typeof suppliedCode === 'string'
      ? (/^NO_IDENTITY__([A-Z0-9_]{1,48})$/.exec(suppliedCode)?.[1]?.toLowerCase().replace(/__/g, '\0').replace(/_/g, '-').replace(/\0/g, '_')
        ?? /^NO_IDENTITY:([a-z0-9][a-z0-9-]{0,63})$/.exec(suppliedCode)?.[1] ?? null)
      : null;
    const missingId = rawMissing ?? (typeof (/** @type {{missingId?:unknown}} */ (error))?.missingId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(/** @type {string} */ ((/** @type {{missingId?:unknown}} */ (error)).missingId)) ? /** @type {string} */ ((/** @type {{missingId?:unknown}} */ (error)).missingId) : null);
    const normalizedCode = rawMissing !== null ? 'NO_IDENTITY' : suppliedCode;
    const code = ['LAYOUT_UNKNOWN_SLOT','LAYOUT_ILLEGAL_TRANSITION','LAYOUT_INPUT_MODE_READ'].find(code =>
      normalizedCode === code || String(error).includes(code)) ?? (typeof normalizedCode === 'string' && normalizedCode.length > 0 ? normalizedCode : 'HOST_REQUEST_REFUSED');
    const createReasons = {
      NO_BROWSER_CAPSULE: 'No browser capsule with a live frame.',
      CAPSULE_LIMIT_REACHED: 'At most 16 capsules run at once (16 of 16 open). Close a capsule to open another.',
      NO_FREE_PROFILE: 'Every configured capsule profile is already in use. To run more capsules, add profiles to MV_SRF_PROFILES (up to 16 in total) and restart MetaViewer; see "More than one capsule" in the User Guide.',
      NO_IDENTITY: `No free capsule profile has an identity yet. Create an identity (${missingId ?? 'mv-live-2'}) whose id matches a profile in MV_SRF_PROFILES, then press Add capsule again.`,
      IDENTITY_LIST_UNAVAILABLE: 'The identity list could not be read, so no new capsule was opened. Open Identities to check the identity tool, then try again.',
      PICKER_INPUT_INVALID: 'The capsule request could not be prepared. Please try again.',
      SURFACE_PROFILE_BOUND: 'Every configured capsule profile is already bound to a running capsule. Close or reuse the existing capsule, or add another profile to MV_SRF_PROFILES.',
      CAPSULE_SLOT_UNAVAILABLE: 'No free capsule slot. Stop another capsule first (up to 16 run at once).',
      PROFILE_ALREADY_BOUND: 'The selected capsule profile is already bound to a running capsule. Close the running capsule or add another profile to MV_SRF_PROFILES.',
      SURFACE_CAPACITY_OR_QUARANTINE: 'No capsule slot is free or the profile is quarantined. Close a capsule or clear the quarantined profile before trying again.',
      SURFACE_PROFILE_QUARANTINED: 'The capsule profile is quarantined after a previous failure. Clear the quarantine before opening a new capsule.',
      IDENTITY_UNAVAILABLE: 'The capsule identity is unavailable or already held by another capsule. Check Identities and try again.',
      IDENTITY_REFUSED: 'The capsule identity was refused by the host. Check Identities and try again.',
      RAM_ADMISSION_REFUSED: 'Not enough free host memory to start another capsule (one capsule needs 6 GiB: 4 GiB RAM + 2 GiB shm). Close an open capsule or other applications and try again.',
      SURFACE_CREATE_BUSY: 'Another capsule is already starting. Wait for it to finish, then try again.',
      SURFACE_CREATE_TIMEOUT: 'Starting the capsule timed out before it became ready. Try again.',
      SURFACE_CREATE_FAILED: 'The host could not start the capsule. If this is a core-only installation, install and configure the surface runtime with bash scripts/judge/metaviewer-judge.sh install --capsules, then restart MetaViewer. Otherwise check the host logs and choose Add capsule to try again.',
      SURFACE_CREATE_KIND_UNAVAILABLE: 'Only browser capsules can be created on this host.',
      SURFACE_CREATE_INVALID: 'The capsule create request was rejected as invalid. Please try again.',
      DISPLAY_ONLY: 'Nested walls are display-only and cannot open new capsules.',
      ADAPTER_SETUP: 'The surface runtime setup is unavailable. Run bash scripts/judge/metaviewer-judge.sh doctor --capsules, repair the reported prerequisite, then try Add capsule again.',
    ADAPTER_ERROR: 'The surface runtime could not open the capsule. Check that it is installed and configured, then choose Add capsule to try again. A core-only installation cannot run capsules.',
    };
    const fallback = 'This request is unavailable. Please try again.';
    const rawReason = typeof (/** @type {{reason?:unknown}} */ (error))?.reason === 'string'
      ? /** @type {string} */ ((/** @type {{reason?:unknown}} */ (error)).reason).trim()
      : '';
    const safeReason = rawReason.length > 0 && rawReason.length <= 256 && !/[\x00-\x1f\x7f]/.test(rawReason) ? rawReason : '';
    const message = safeReason
      ? (safeReason.startsWith(`${code}:`) ? safeReason : `${code}: ${safeReason}`)
      : (code === 'CAPSULE_SLOT_UNAVAILABLE' ? createReasons.CAPSULE_SLOT_UNAVAILABLE : Object.hasOwn(createReasons, code)
        ? `${code}: ${createReasons[/** @type {keyof typeof createReasons} */ (code)]}`
        : (code === 'HOST_REQUEST_REFUSED' || code.startsWith('LAYOUT_') || code.startsWith('ERR_') ? fallback : `${code}: ${fallback}`));
    const activityCode = code === 'NO_IDENTITY' && missingId && missingId !== 'mv-live-2' ? `NO_IDENTITY:${missingId}` : code;
    if (hostActive) hostOutcome.value = code === 'NO_IDENTITY' && missingId && missingId !== 'mv-live-2'
      ? /** @type {any} */ ({ code, missingId, message, tone: 'refusal' })
      : (safeReason ? /** @type {any} */ ({ code, reason: safeReason, message, tone: 'refusal' }) : { code, message, tone: 'refusal' });
    if (hostActive) {
      if (code === 'HOST_REQUEST_REFUSED') recordActivity({ code: 'HOST_REQUEST_REFUSED' });
      else if (safeReason) recordActivity({ code: activityCode, reason: safeReason });
      else recordActivity({ code: activityCode });
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
  capturePanelOnly.value = false;
  cancelTerminalOpening();
  creativeOpen.value = false;
  if (!selectedSurface.value) return;
  settingsOpen.value = false;
  terminalOpen.value = false;
  multislotOpen.value = true;
}
/** @param {string} capsuleId */
function openCapturePanel(capsuleId) {
  selectCapsule({capsuleId});
  openMultislot();
  capturePanelOnly.value = true;
}
/** @param {string} id */
async function forgetIdentityLayout(id) {
  if(!wall.value?.forgetIdentity)throw Error('LAYOUT_SAVE_REFUSED');
  await wall.value.forgetIdentity(id);
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
const presetError = ref('');
const activeDesktopPreset = computed(() => {
  const group = desktopState.value.views[desktopState.value.activeView];
  return group.desktops.find(desktop => desktop.id === group.active)?.preset ?? null;
});
function setActiveDesktopPreset(/** @type {string|null} */ preset) {
  const state = desktopState.value, group = state.views[state.activeView];
  wall.value?.selectView(state.activeView);
  wall.value?.selectDesktop(group.active);
  const result = wall.value?.setPreset(preset);
  presetError.value = result?.ok ? '' : 'Tile layout is unavailable. Try again after the desktop is ready.';
}
const wall = ref(/** @type {InstanceType<typeof DesktopWorkspace>|null} */ (null));
const activeTileScheduler = /** @type {ReturnType<typeof createTileScheduler>} */ (props.runtime?.tileScheduler ?? tileScheduler);
provide('tileScheduler', activeTileScheduler);
/** Live-only frame-port router provided by the entry; null on fixture/legacy boots. */
const framePortRouter = /** @type {unknown} */ (inject('framePortRouter', null));
/** MVUI30 lane L: canvas state for one projection row. A `lost` backend
 * lifecycle maps to the distinct `lost` canvas state (frozen last frame);
 * every other lifecycle keeps the attachment mapping (`live` only while the
 * binding is live, else `connecting`). Local mirror of `canvasStateForRow`
 * in surfaces/tileScheduler.js — the App import surface stays pinned for
 * the stub harnesses, so the helper cannot be imported; keep the two in
 * sync.
 * @param {{id?:unknown,backendLifecycle?:unknown,attachmentState?:unknown}|null} surface */
function canvasStateFor(surface) {
  if (surface !== null && typeof surface === 'object' && surface.backendLifecycle === 'lost') return 'lost';
  return surface !== null && typeof surface === 'object' && surface.attachmentState === 'live' ? 'live' : 'connecting';
}
/** MVUI25 lane A: per-surface input enablement (UX side; host re-checks).
 * True only for human control plus WRITE; nested display-only never.
 * MVUI30 lane L: lost tiles are frozen and never take input.
 * @param {{id:string,control?:unknown}} surface */
function inputEnabledFor(surface) {
  if (nestedMode.displayOnly === true) return false;
  if (surface === null || typeof surface !== 'object') return false;
  if (/** @type {{ backendLifecycle?: unknown }} */ (surface).backendLifecycle === 'lost') return false;
  return /** @type {{ control?: unknown }} */ (surface).control === 'human' && inputMode.value === 'write';
}
/** INPUT-ARM: wall tiles also take input while armed from the wall, under the
 * same rules: human control only, never lost, nested display-only never. The
 * multislot and nested screens keep exactly the shared-mode gate above.
 * @param {{id:string,control?:unknown}} surface */
function wallArmedFor(surface) {
  if (nestedMode.displayOnly === true) return false;
  if (surface === null || typeof surface !== 'object') return false;
  if (/** @type {{ backendLifecycle?: unknown }} */ (surface).backendLifecycle === 'lost') return false;
  return surface.control === 'human' && wallInputArmed.value[surface.id] === true;
}
/** INPUT-ARM: tile input chip state for the wall: '' (no chip), 'view',
 * 'pending', 'interactive', 'paused' (Escape-blurred) or 'unavailable'.
 * @param {{id:string,control?:unknown,backendLifecycle?:unknown,attachmentState?:unknown}|null} surface */
function wallInputState(surface) {
  if (nestedMode.displayOnly === true || surface === null || typeof surface !== 'object') return '';
  if (!ARMABLE_LIFECYCLES.includes(/** @type {string} */ (surface.backendLifecycle)) || canvasStateFor(surface) !== 'live') return '';
  const port = /** @type {{ available?: unknown } | null} */ (shellInputPort);
  if (port === null || port.available !== true) return 'unavailable';
  if (inputEnabledFor(surface) || wallArmedFor(surface)) {
    return wallInputEscaped.value[surface.id] === true ? 'paused' : 'interactive';
  }
  return wallInputPending.value[surface.id] === true ? 'pending' : 'view';
}
/** @param {{id:string,title?:unknown}} surface */
function surfaceLabel(surface) {
  return typeof surface?.title === 'string' && surface.title.length > 0 ? surface.title : surface?.id ?? '';
}
/** MVUI25 lane A: frame stream id for input batches (router wins, else projection).
 * @param {{id:string,generation?:unknown}} surface */
function surfaceStreamId(surface) {
  try {
    const router = /** @type {{ getSurfaceStatus?: unknown }} */ (framePortRouter);
    const id = surface !== null && typeof surface === 'object'
      ? /** @type {{ id?: unknown }} */ (surface).id : null;
    if (router !== null && typeof router === 'object'
        && typeof router.getSurfaceStatus === 'function' && typeof id === 'string') {
      const status = /** @type {(surfaceId: string) => unknown} */ (router.getSurfaceStatus).call(framePortRouter, id);
      const generation = status !== null && typeof status === 'object'
        ? /** @type {{ surfaceGeneration?: unknown }} */ (status).surfaceGeneration : null;
      if (Number.isSafeInteger(generation) && /** @type {number} */ (generation) > 0) {
        return /** @type {number} */ (generation);
      }
    }
  } catch { /* Router failures fall through to the projection id. */ }
  const fallback = surface !== null && typeof surface === 'object'
    ? Number(/** @type {{ generation?: unknown }} */ (surface).generation) : NaN;
  if (Number.isSafeInteger(fallback) && fallback > 0) return fallback;
  return 1;
}
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
const baseFeed = props.runtime?.projectionView ?? projectionView;
const nativeRows = shallowRef(/** @type {any[]} */([]));
/** Last trusted presentation metadata, retained only for current surface ids. */
const nativeWindowMetadata = new Map();
const nativeListeners = new Set();
let nativeRevision = 0, nativePolling = false, nativeLoaded = false, nativePollFailed = false;
const nativeApi = !props.fixture && !nestedMode.displayOnly ? /** @type {any} */(globalThis).metaviewerRoles : null;
const mergedRows = () => {
  const base = baseFeed.getProjection()?.rows || [];
  const ids = new Set(base.map(row => row.id));
  return [...base.map(row => {
    const native = nativeRows.value.find(item => item.id === row.id && (item.hostWindow || item.hostXpra))
      || (row.backendLifecycle === 'lost' && typeof nativeWindowMetadata !== 'undefined' ? nativeWindowMetadata.get(row.id) : undefined);
    return native ? {...row,title:native.title,hostWindow:native.hostWindow,hostXpra:native.hostXpra,notIsolated:native.notIsolated} : row;
  }),...nativeRows.value.filter(row => !ids.has(row.id))];
};
const nativeSnapshot = () => {
  const base = baseFeed.getSnapshot();
  const stale = base?.stale || !base?.envelope || !nativeLoaded || nativePollFailed;
  if (!nativeRows.value.length) return base ? {...base,stale} : base;
  return {status:'live',stale,error:null,envelope:{schema:'surface/v0.1',epoch:base?.envelope?.epoch || 1,
    revision:nativeRevision,query:'wall',projection:{rows:mergedRows()}}};
};
const feed = nativeApi?.surfaces ? {
  getProjection:() => ({rows:mergedRows()}),getSnapshot:nativeSnapshot,
  subscribe:(/** @type {any} */ listener) => {
    nativeListeners.add(listener);
    const stop = baseFeed.subscribe(() => listener(nativeSnapshot()));
    return () => {nativeListeners.delete(listener);stop();};
  },
} : baseFeed;
async function pollNativeSurfaces() {
  if (nativePolling || !hostActive || !nativeApi?.surfaces) return;
  nativePolling = true;
  try {
    const listed = await nativeApi.surfaces();
    if (!hostActive) return;
    if (!Array.isArray(listed)) throw Error('NATIVE_PROJECTION_UNAVAILABLE');
    const mismatch = listed.find(item => item?.diagnostic === 'SURFACE_AUTHORITY_MISMATCH');
    if (mismatch) hostOutcome.value = {code:'SURFACE_AUTHORITY_MISMATCH',tone:'refusal',
      message:`Capsule ${mismatch.surface?.profile_id || mismatch.surface?.surface_id} is unavailable because its host state changed. Refresh Identities to check its state; other capsules remain available.`};
    const availabilityChanged = !nativeLoaded || nativePollFailed;
    nativeLoaded = true; nativePollFailed = false;
    const admitted = listed.filter(item => item?.schema === 'metaviewer.role_surface/v0.3'
      && (item.role === 'human' || item.role === 'agent' && (item.hostWindow || item.hostXpra))
      && item.surface?.schema === 'surface/v0.2' && item.surface.state === 'active'
      && (item.surface.control === 'human' || (item.hostWindow || item.hostXpra) && item.surface.control === 'agent'));
    const next = admitted.map(({surface:s,hostWindow,hostXpra,role}) => ({id:s.surface_id,surfaceId:s.surface_id,title:hostWindow?.title || s.profile_id,profile_id:s.profile_id,hostWindow,hostXpra,role,
      backendLifecycle:s.state,generation:null,visibility:s.visibility,control:s.control,display:s.display,geometry:s.geometry,
      attachmentState:'live',refusal:null}));
    if (typeof nativeWindowMetadata !== 'undefined') {
      for (const row of next) if (row.hostWindow || row.hostXpra) nativeWindowMetadata.set(row.id,{title:row.title,notIsolated:true});
      const retained = new Set([...next.filter(row => row.hostWindow || row.hostXpra), ...(baseFeed.getProjection()?.rows || []).filter(row => row.backendLifecycle === 'lost')].map(row => row.id));
      for (const id of nativeWindowMetadata.keys()) if (!retained.has(id)) nativeWindowMetadata.delete(id);
    }
    if (!availabilityChanged && JSON.stringify(next) === JSON.stringify(nativeRows.value)) return;
    nativeRows.value = next; nativeRevision++;
    for (const row of next) onCapsuleMode({surfaceId:row.id,mode:row.role});
    for (const listener of nativeListeners) listener(nativeSnapshot());
  } catch {
    nativePollFailed = true;
    for (const listener of nativeListeners) listener(nativeSnapshot());
  } finally { nativePolling = false; }
}
const nativeTimer = nativeApi?.surfaces ? setInterval(() => { void pollNativeSurfaces().catch(() => {}); },250) : undefined;
nativeTimer?.unref?.();
onMounted(() => { void pollNativeSurfaces().catch(() => {}); });
onBeforeUnmount(() => {clearInterval(nativeTimer);nativeListeners.clear();nativeWindowMetadata.clear();});
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
    && !stoppedSurfaces.value[row.id]
    && (row.backendLifecycle !== 'lost' || admitLostRows.value)) ?? [];
  return admitted.filter(row => !nestedMode.displayOnly || applyNestedWall([row], nestedMode).rows.length > 0);
});
/** Pure presentation of admitted projection rows; ownership is never activity.
 * @param {any[]} sourceRows
 * @param {import('../electron/desktopLayout.js').DesktopState} state
 * @param {string[]} pendingIds
 * @param {string[]} minimizedIds
 * @param {{apps:any[],programs:any[],browsers:any[]}} [metadata] */
function buildWorkingTree(sourceRows, state, pendingIds, minimizedIds, metadata = {apps:[],programs:[],browsers:[]}) {
  const pending = new Set(pendingIds), minimized = new Set(minimizedIds);
  return ['human','agent'].map(view => {
    const desktops = state.views[view].desktops.map(desktop => ({id:desktop.id,label:desktop.label || `Desktop ${desktop.id}`,capsules:sourceRows.filter(row => state.assignments[row.id]?.view === view && state.assignments[row.id]?.desktop === desktop.id).map(row => {
      const workload=row.kind==='guest-command' && row.snapshot?.session;
      const program=metadata.programs.find(item=>item.profileId===row.profile_id);
      const binary=program?.binary || (typeof row.hostWindow?.program==='string'?row.hostWindow.program:'');
      const candidates=binary && !binary.includes('/')?metadata.apps.filter(item=>item.binary.split('/').pop()===binary):[];
      const app=binary ? metadata.apps.find(item=>item.binary===binary) || (candidates.length===1?candidates[0]:null) : null;
      const kind=workload?'microvm':program?'program':metadata.browsers.some(item=>item.profileId===row.profile_id)?'browser':'unknown';
      const needsYou = pending.has(row.id);
      const lost = row.backendLifecycle === 'lost';
      const error = Boolean(row.refusal || row.readinessError);
      const connecting = row.attachmentState !== 'live';
      const acting = row.aiSessionActivity === 'busy' || ['admitting','accepted','executing'].includes(row.dispatchOutcome);
      const status = workload ? String(workload.phase) : needsYou ? 'Needs you' : lost ? 'Lost' : error ? 'Error' : connecting ? 'Connecting' : minimized.has(row.id) || row.visibility === 'folded' ? 'Minimized' : acting && view === 'agent' ? 'Acting' : view === 'human' ? 'Human' : 'Agent';
      const tone = needsYou || error ? 'attention' : lost ? 'lost' : connecting ? 'pending' : acting && view === 'agent' ? 'active' : 'quiet';
      return {id:row.id,title:(state.labels && Object.hasOwn(state.labels,row.profile_id || row.id)?state.labels[row.profile_id || row.id]:undefined) || surfaceLabel(row),kind,icon:app?.icon || '',status,tone,needsYou,notIsolated:Boolean(row.hostWindow || row.hostXpra || row.notIsolated),symbol:needsYou || error ? '▲' : row.hostWindow || row.hostXpra ? '⚠' : lost ? '○' : connecting ? '◐' : acting && view === 'agent' ? 'ϟ' : '●'};
    })}));
    return {id:view,label:view === 'human' ? 'Humans' : 'Agents',desktops,count:desktops.reduce((n,d)=>n+d.capsules.length,0),needsYou:desktops.some(d=>d.capsules.some(c=>c.needsYou))};
  });
}
const treeHandoffs = ref(/** @type {string[]} */ ([]));
const treeCollapsed = ref(/** @type {Record<string,boolean>} */ ({}));
const treeMetadata=ref(/** @type {{apps:any[],programs:any[],browsers:any[]}} */ ({apps:[],programs:[],browsers:[]}));
let treeMetadataGeneration=0;
async function refreshTreeMetadata() {
  if(!nativeApi)return;
  const generation=++treeMetadataGeneration;
  const results=await Promise.allSettled([nativeApi.listApps?.(),nativeApi.programs?.(),nativeApi.choices?.()]);
  if(!hostActive || generation!==treeMetadataGeneration)return;
  const values=results.map(result=>result.status==='fulfilled'?result.value:null);
  treeMetadata.value={
    apps:Array.isArray(values[0]?.apps)?values[0].apps.slice(0,256).filter((/** @type {any} */ item)=>item && typeof item.binary==='string' && typeof item.icon==='string' && /^data:image\/(?:png|svg\+xml);base64,/.test(item.icon)):[],
    programs:Array.isArray(values[1])?values[1].filter(item=>item && typeof item.profileId==='string' && typeof item.binary==='string'):[],
    browsers:Array.isArray(values[2])?values[2].filter(item=>item && typeof item.profileId==='string'):[],
  };
}
watch([()=>rows.value.map(row=>row.profile_id || row.id).join('\n'),()=>launcherOpen.value],()=>{if(!launcherOpen.value)void refreshTreeMetadata();},{immediate:true});
const navigationTree = computed(() => buildWorkingTree([...rows.value,...guestWorkloadTiles.value],desktopState.value,treeHandoffs.value,closedPanels.value,treeMetadata.value));
const treeRename=ref(/** @type {any} */ (null));
/** @param {string} kind @param {string} view @param {any} item */
async function beginTreeRename(kind,view,item) {
  const key=`${kind}:${view}:${item.id}`;
  treeRename.value={key,kind,view,id:item.id,value:kind==='desktop'?item.label:item.title,busy:false,error:''};
  await nextTick();document.getElementById(`tree-rename-${key}`)?.focus();
  /** @type {HTMLInputElement|null} */ (document.getElementById(`tree-rename-${key}`))?.select();
}
async function saveTreeRename() {
  const edit=treeRename.value;if(!edit || edit.busy)return;edit.busy=true;edit.error='';
  try {
    const saved=edit.kind==='desktop'?await wall.value?.renameDesktop?.(edit.view,edit.id,edit.value):await wall.value?.renameCapsule?.(edit.id,edit.value);
    if(treeRename.value!==edit)return;
    if(saved){treeRename.value=null;await restoreTreeNameFocus(edit);}else edit.error='Name could not be saved.';
  } catch {if(treeRename.value===edit)edit.error='Name could not be saved.';}
  finally {if(treeRename.value===edit)edit.busy=false;}
}
/** @param {any} edit */
async function restoreTreeNameFocus(edit) {
  await nextTick();if(treeRename.value!==null)return;
  document.getElementById(edit.kind==='desktop'?`desktop-${edit.view}-${edit.id}`:`tree-capsule-${edit.id}`)?.focus();
}
async function cancelTreeRename() {const edit=treeRename.value;if(edit && !edit.busy){treeRename.value=null;await restoreTreeNameFocus(edit);}}


/** @param {string} view @param {number} desktop */
function treeDesktopExpanded(view,desktop) { return !treeCollapsed.value[`${view}/${desktop}`]; }
/** @param {string} view @param {number} desktop */
function toggleTreeDesktop(view,desktop) { const key=`${view}/${desktop}`; treeCollapsed.value={...treeCollapsed.value,[key]:!treeCollapsed.value[key]}; }
/** @param {string} view @param {number} desktop */
function selectTreeDesktop(view,desktop) { selectGlobalView(view); wall.value?.selectDesktop(desktop); treeCollapsed.value={...treeCollapsed.value,[`${view}/${desktop}`]:false}; }
/** @param {string} id */
async function selectTreeCapsule(id) {
  const workload=guestWorkloadTiles.value.find(row=>row.id===id);
  if (!workload && !rows.value.some(row=>row.id === id)) return;
  const home=desktopState.value.assignments[id];
  if (!home) return;
  selectTreeDesktop(home.view,home.desktop);
  await nextTick();
  if(workload){wall.value?.revealWorkload?.(id);selectedCapsuleId.value=id;return;}
  const result=wall.value?.revealSurface(id,'tab');
  if (result?.ok) { markPanelOpen(id); selectedCapsuleId.value=id; }
}
// Reconcile only changed authoritative visibility, retaining pending local
// presentation across unrelated feed updates and removing departed surfaces.
watch(() => rows.value.map(row => /** @type {[string, string]} */ ([row.id, row.visibility])), (next, previous = []) => {
  const prior = new Map(previous);
  foldOverrides.value = Object.fromEntries(next.flatMap(([id, visibility]) =>
    prior.get(id) === visibility && Object.hasOwn(foldOverrides.value, id)
      ? [[id, foldOverrides.value[id]]] : []));
});
// MVUI32 lane A (R3-APP-1): every departed admitted id ends its surface
// lifetime epoch, including a destroy-then-recreate under the same id (which
// id presence alone cannot see). Frame advances keep the id set, so the
// epoch — and only the epoch — distinguishes the two cases for the fence.
watch(() => rows.value.map(row => row.id),
  (next, previous = /** @type {string[]} */ ([])) => {
    const alive = new Set(next);
    for (const id of previous) {
      if (!alive.has(id)) {
        seenLiveSurfaces.delete(id);
        disarmWallInput(id);
        bumpSurfaceLifetimeEpoch(id);
        revealed.delete(id);
        closedPanels.value = closedPanels.value.filter(closed => closed !== id);
        wall.value?.applyPresentationIntent?.({type:'close',capsuleId:id});
      }
    }
  });
// MVUI26B lane M: the shared input mode is only meaningful while the
// selected surface is human-controlled. When an authoritative feed update
// arrives with control anywhere but human (or the selected surface gone),
// WRITE drops back to READ, so the multislot toggle shows READ, every
// canvas becomes non-focusable, and an already focused canvas blurs
// through the SurfaceCanvas gate watcher. One-way: a later human update
// never re-arms WRITE. The trigger is the feed snapshot — the same signal
// every other wall update follows — so in-place row edits that no feed
// delivery carries (stub-harness only) never drop the mode.
watch(() => snapshot.value, () => {
  const selected = selectedSurface.value;
  const control = selected === null ? null : /** @type {{ control?: unknown }} */ (selected).control;
  if (control !== 'human' && inputMode.value !== 'read') {
    inputMode.value = 'read';
  }
}, { immediate: true });
// INPUT-ARM: wall arms follow the same feed signal (one-way on leaving human).
watch(() => snapshot.value, () => { reconcileWallInput(); });
onMounted(() => { reconcileWallInput(); });
// Readiness belongs to the branch actually rendered, including display-only walls.
const wallView = computed(() => nestedMode.displayOnly ? 'nested' : creativeOpen.value ? 'creative' : rows.value.length ? 'workspace' : 'empty');
let firstFrame = 0;
let desktopWallReady = false;
function cancelFirstFrame() { if (firstFrame) window.cancelAnimationFrame(firstFrame); firstFrame = 0; }
watch(wallView, view => {
  settled.value = view === 'workspace' && desktopWallReady;
  revealed.clear(); cancelFirstFrame();
}, { flush: 'sync' });
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
function onWallReady() {
  desktopWallReady = true;
  if (wallView.value === 'workspace') settled.value = true;
  revealRows(); retryPendingEchoes();
}
function onSettled() { settled.value = true; revealRows(); }
/** @param {any} payload */
function openCapsule(payload) {
  if (nestedMode.displayOnly) return;
  const id = payload?.type?.id ?? payload?.id;
  if (id === 'add') { launcherOpen.value = true; return; }
  if (typeof id === 'string') selectedCapsuleId.value = id;
  if (rows.value.some(row => row.id === id)) void wall.value?.followSurface?.(id,capsuleModes.value[id]);
  if (rows.value.some(row => row.id === id) && wall.value?.revealSurface(id, payload?.placement ?? 'tab')?.ok === true) {
    settingsOpen.value = false;
    markPanelOpen(id);
  }
}
const chromeWorkspace = markRaw(defineComponent({
  inheritAttrs: false,
  setup: (_, { attrs }) => () => h(ShellWorkspace, { ...attrs, workspaceComponent: DockWorkspace }),
}));
defineExpose({ openMultislot, selectedSurface, demoOpen });
onMounted(() => {
  const rootEl = typeof document !== 'undefined' && typeof document.querySelector === 'function' ? document.querySelector('.metaviewer') : null;
  if (rootEl) {
    /** @type {any} */ (rootEl).__mvAppApi = { openMultislot, get selectedSurface() { return selectedSurface.value; }, get demoOpen() { return demoOpen.value; }, set demoOpen(v) { demoOpen.value = Boolean(v); } };
  }
});
</script>
<template>
  <div class="metaviewer mv-shell" :data-wall-settled="String(settled)" :class="{ 'mv-shell--nested': nestedMode.displayOnly, 'mv-shell--navigation-open': railOpen, 'mv-shell--terminal-open': terminalDockOpen }">
    <aside v-if="!nestedMode.displayOnly" class="mv-navigation" :class="{ 'mv-navigation--collapsed': !railOpen }" aria-label="Workspace navigation">
      <div class="mv-navigation-brand"><UiButton label="Navigation" id="shell/navigation/toggle" data-semantic-anchor="shell/navigation/toggle" type="button" :aria-expanded="railOpen" :aria-label="railOpen ? 'Collapse navigation' : 'Expand navigation'" @click="railOpen = !railOpen">☰</UiButton><strong v-if="railOpen">MetaViewer</strong></div>
      <div class="mv-navigation-scroll">
        <div class="mv-tree-shortcuts"><UiButton id="sidebar-add-capsule" data-semantic-anchor="sidebar/add-capsule" :label="railOpen ? '+ Add capsule' : '+'" aria-label="Add capsule" title="Add capsule" @click="launcherOpen = true" /></div>
        <div class="mv-views mv-working-tree" role="group" aria-label="Capsule views">
          <section v-for="view in navigationTree" :key="view.id" class="mv-tree-view" :data-view="view.id">
            <div class="mv-tree-heading">
              <UiButton :label="view.label" :id="`view-${view.id}`" :data-semantic-anchor="`wall/view/${view.id}`" class="mv-view-button" :aria-pressed="desktopState.activeView === view.id" :title="`${view.label}: ${view.count} capsules`" @click="selectGlobalView(view.id)">
                <span class="mv-tree-heading-content"><span class="mv-tree-view-name">{{ view.label }}</span><span class="mv-tree-view-short" aria-hidden="true">{{ view.id === 'human' ? 'H' : 'A' }}</span><span class="mv-tree-count">{{ view.count }}</span><span v-if="view.needsYou" class="mv-tree-needs-dot" role="img" aria-label="Needs you" title="Needs you">●</span></span>
              </UiButton>
              <UiButton label="+" :id="desktopState.activeView === view.id ? 'desktop-add' : `desktop-add-${view.id}`" data-semantic-anchor="wall/desktop/add" class="mv-tree-add" :aria-label="`Add ${view.label.toLowerCase()} desktop`" :title="`Add ${view.label.toLowerCase()} desktop`" :disabled="!desktopStateLoaded || view.desktops.length >= MAX_DESKTOPS_PER_VIEW" @click="selectGlobalView(view.id); wall?.addDesktop()">+</UiButton>
            </div>
            <p v-if="treeRename?.error && treeRename.view === view.id" class="mv-tree-rename-error" role="alert">{{ treeRename.error }}</p>
            <div class="mv-tree-desktops" :aria-label="`${view.label} desktops`">
              <section v-for="desktop in view.desktops" :key="desktop.id" class="mv-tree-desktop" :class="{ 'mv-tree-desktop--active': desktopState.activeView === view.id && desktopState.views[view.id].active === desktop.id }">
                <div class="mv-tree-desktop-heading">
                  <UiButton :id="`tree-fold-${view.id}-${desktop.id}`" :data-semantic-anchor="`wall/tree/${view.id}/${desktop.id}/fold`" :label="treeDesktopExpanded(view.id,desktop.id) ? 'Collapse desktop' : 'Expand desktop'" class="mv-tree-fold" :aria-label="`${treeDesktopExpanded(view.id,desktop.id) ? 'Collapse' : 'Expand'} ${view.label} desktop ${desktop.id}`" :aria-expanded="treeDesktopExpanded(view.id,desktop.id)" @click="toggleTreeDesktop(view.id,desktop.id)">{{ treeDesktopExpanded(view.id,desktop.id) ? '▾' : '▸' }}</UiButton>
                  <input v-if="treeRename?.key === `desktop:${view.id}:${desktop.id}`" :id="`tree-rename-${treeRename.key}`" :data-semantic-anchor="`wall/tree/rename/${view.id}/${desktop.id}`" v-model="treeRename.value" class="mv-tree-rename" aria-label="Rename desktop" maxlength="80" :disabled="treeRename.busy" @keydown.enter.stop.prevent="saveTreeRename" @keydown.esc.stop.prevent="cancelTreeRename" />
                  <UiButton v-else :label="desktop.label" :id="`desktop-${view.id}-${desktop.id}`" :data-semantic-anchor="`wall/desktop/${view.id}/${desktop.id}`" class="mv-tree-desktop-button" :aria-pressed="desktopState.activeView === view.id && desktopState.views[view.id].active === desktop.id" @click="selectTreeDesktop(view.id,desktop.id)" @dblclick.stop="beginTreeRename('desktop',view.id,desktop)" @keydown.f2.stop.prevent="beginTreeRename('desktop',view.id,desktop)"><span class="mv-tree-desktop-content"><span>{{ desktop.label }}</span><span class="mv-tree-count">{{ desktop.capsules.length }}</span></span></UiButton>
                </div>
                <ul v-if="treeDesktopExpanded(view.id,desktop.id)" class="mv-tree-capsules" :aria-label="`${view.label} desktop ${desktop.id} capsules`">
                  <li v-for="capsule in desktop.capsules" :key="capsule.id">
                    <span v-if="treeRename?.key === `capsule:${view.id}:${capsule.id}`" class="mv-tree-name-edit"><input :id="`tree-rename-${treeRename.key}`" :data-semantic-anchor="`wall/tree/rename/${capsule.id}`" v-model="treeRename.value" class="mv-tree-rename" aria-label="Rename capsule" maxlength="80" :disabled="treeRename.busy" @keydown.enter.stop.prevent="saveTreeRename" @keydown.esc.stop.prevent="cancelTreeRename" /><span v-if="capsule.notIsolated" class="mv-tree-isolation">Not isolated</span></span>
                    <UiButton v-else :label="capsule.title" :id="`tree-capsule-${capsule.id}`" :data-semantic-anchor="`wall/tree/${capsule.id}`" class="mv-tree-capsule" :class="{ 'mv-tree-capsule--selected': selectedCapsuleId === capsule.id }" :title="`${capsule.title} · ${capsule.status}${capsule.notIsolated ? ' · Not isolated' : ''}`" :aria-label="`${capsule.title}, ${capsule.status}${capsule.notIsolated ? ', Not isolated' : ''}`" @click="selectTreeCapsule(capsule.id)" @dblclick.stop="beginTreeRename('capsule',view.id,capsule)" @keydown.f2.stop.prevent="beginTreeRename('capsule',view.id,capsule)">
                      <span class="mv-tree-capsule-content"><img v-if="capsule.icon" :src="capsule.icon" class="mv-tree-program-icon" alt="" width="18" height="18" /><BrowserIcon v-else-if="capsule.kind === 'browser'" class="mv-tree-program-icon" aria-hidden="true"/><SidebarIcon v-else-if="capsule.kind === 'microvm'" name="box" class="mv-tree-program-icon" /><span v-else class="mv-tree-program-icon" aria-hidden="true">◇</span><span class="mv-tree-signal" :data-tone="capsule.tone" aria-hidden="true">{{ capsule.symbol }}</span><span class="mv-tree-capsule-copy"><span class="mv-tree-capsule-name">{{ capsule.title }}</span><span class="mv-tree-capsule-meta"><span class="mv-tree-capsule-status" :data-tone="capsule.tone">{{ capsule.status }}</span><span v-if="capsule.notIsolated" class="mv-tree-isolation">Not isolated</span></span></span></span>
                    </UiButton>
                  </li>
                  <li v-if="!desktop.capsules.length" class="mv-tree-empty">No capsules</li>
                </ul>
              </section>
              <UiButton v-if="desktopState.activeView === view.id && desktopState.views[view.id].active !== 1" id="desktop-remove" data-semantic-anchor="wall/desktop/remove" label="Remove empty desktop" :disabled="Object.values(desktopState.assignments).some(home => home.view === view.id && home.desktop === desktopState.views[view.id].active)" @click="wall?.removeDesktop(desktopState.views[view.id].active)" />
            </div>
          </section>
        </div>
        <nav aria-label="Workspace tools" class="mv-navigation-tools">
          <UiButton v-if="guestWorkloadTiles.length" id="shell-microvm-console" data-semantic-anchor="microvm/console/show" :label="railOpen ? 'MicroVM console' : 'VM'" aria-label="MicroVM console" title="MicroVM console" @click="showGuestConsole" />
          <UiButton id="shell-identities" data-semantic-anchor="identities/open" :label="railOpen ? 'Identities' : 'ID'" aria-label="Identities" title="Identities" :aria-expanded="identitiesOpen" @click="identitiesOpen = true" />
          <UiButton id="shell-settings" data-semantic-anchor="settings/open" :label="railOpen ? 'Settings' : '⚙'" aria-label="Settings" title="Settings" :aria-expanded="settingsOpen" @click="toggleSettings()" />
          <UiButton v-if="props.fixture" id="shell-creative" data-semantic-anchor="creative/open" :label="railOpen ? 'Storyboard' : '▦'" aria-label="Storyboard" title="Storyboard" :aria-expanded="creativeOpen" :disabled="!selectedSurface" @click="toggleCreative()" />
        </nav>
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

      </div>
      <div class="mv-navigation-foot">
        <HandoffNotice @activity="recordActivity" @take-control="takeHandoffControl" @pending="treeHandoffs = $event" />
        <ActivityStrip :entries="activityFeed" />
        <div class="mv-sidebar-status"><StatusBar :crumbs="[{ id: 'wall', label: 'Main wall', tone: 'strong' }]" :shortcuts="[]"><template #telemetry><span id="shell-feed-status" class="mv-feed-status" role="status"><i aria-hidden="true"></i>{{ snapshot?.envelope ? 'Core connected' : props.runtime ? 'Waiting for capsule frames' : 'Core not connected' }}</span></template><template #shortcuts><span class="mv-shell-caption">{{ rows.length ? `${rows.filter(row => row.backendLifecycle !== 'lost').length} capsules${rows.some(row => row.backendLifecycle === 'lost') ? ` · ${rows.filter(row => row.backendLifecycle === 'lost').length} lost` : ''}` : 'Ready when you are' }}</span></template></StatusBar></div>
      </div>
    </aside>
    <TopBar v-if="!nestedMode.displayOnly" product="MetaViewer" new-label="Add capsule" search-placeholder="Find a capsule…" :nav-expanded="railOpen"
      :palette-items="catalog" @toggle-nav="railOpen = !railOpen" @new-capsule="launcherOpen = true" @open="openCapsule">
      <template #nav><span hidden aria-hidden="true"></span></template><template #identity><span hidden aria-hidden="true"></span></template>
      <template #actions>
      <div v-if="!nestedMode.displayOnly" class="mv-tile-presets" aria-label="Tile layout presets">
        <UiButton id="tile-preset-single" data-semantic-anchor="wall/preset/single" label="1" title="1 tile" aria-label="1 tile" :aria-pressed="activeDesktopPreset === 'single'" :disabled="!desktopStateLoaded" @click="setActiveDesktopPreset('single')" />
        <UiButton id="tile-preset-side-by-side" data-semantic-anchor="wall/preset/side-by-side" label="2" title="2 side by side" aria-label="2 side by side" :aria-pressed="activeDesktopPreset === 'side-by-side'" :disabled="!desktopStateLoaded" @click="setActiveDesktopPreset('side-by-side')" />
        <UiButton id="tile-preset-grid" data-semantic-anchor="wall/preset/grid" label="2×2" :aria-pressed="activeDesktopPreset === 'grid'" :disabled="!desktopStateLoaded" @click="setActiveDesktopPreset('grid')" />
        <UiButton id="tile-preset-grid-3x2" data-semantic-anchor="wall/preset/grid-3x2" label="3×2" :aria-pressed="activeDesktopPreset === 'grid-3x2'" :disabled="!desktopStateLoaded" @click="setActiveDesktopPreset('grid-3x2')" />
        <UiButton id="tile-preset-focus-strip" data-semantic-anchor="wall/preset/focus-strip" label="Focus" title="Focus + strip" aria-label="Focus + strip" :aria-pressed="activeDesktopPreset === 'focus-strip'" :disabled="!desktopStateLoaded" @click="setActiveDesktopPreset('focus-strip')" />
        <UiButton id="tile-preset-floating" data-semantic-anchor="wall/preset/floating" label="Float" aria-label="Floating layout" :aria-pressed="activeDesktopPreset === 'floating'" title="Float every tile in a cascaded window" :disabled="!desktopStateLoaded" @click="setActiveDesktopPreset('floating')" />
        <details id="shell-grid-tools" class="mv-grid-tools"><summary id="shell-grid-tools-toggle" data-semantic-anchor="wall/grid-tools" aria-label="Custom grid" title="Custom grid">⋯</summary></details>
        <span v-if="presetError" role="status">{{ presetError }}</span>
      </div>
      </template>
    </TopBar>
    <div class="mv-shell-body">

      <main id="shell-wall" aria-label="MetaViewer capsule wall">
        <HostOutcome :row="hostOutcome" />
        <p v-if="browserCreatePending" role="status" aria-live="polite">Opening capsule… Please wait for the host.</p>
        <p v-if="browserCreateNotice" role="status" aria-live="polite">{{ browserCreateNotice }}</p>
        <section v-if="nestedMode.displayOnly" class="mv-nested-wall" aria-label="Nested capsule wall">
          <article v-for="surface in rows" :key="surface.id" :aria-label="surface.title || surface.id">
            <SurfaceCanvas :surface-id="surface.id" :generation="surface.generation" :epoch="snapshot?.envelope?.epoch ?? ''" :frame="surfaceWitness(surface).frame" :digest="surfaceWitness(surface).digest" :frame-width="surfaceWitness(surface).width" :frame-height="surfaceWitness(surface).height" :state="canvasStateFor(surface)" :scroll-enabled="!surface.hostWindow" :input-enabled="inputEnabledFor(surface)" :stream-id="surfaceStreamId(surface)" />
          </article>
        </section>
        <DesktopWorkspace v-else :hidden="creativeOpen" :clipboard="props.clipboard" :workload-tiles="guestWorkloadTiles" :validate-workload-tile="validGuestWorkloadTile" :rows="rows" :modes="capsuleModes" @desktops-change="onDesktopsChange" @navigate="selectGlobalView" @layout-error="layoutUnavailable = {code:'LAYOUT_SAVE_REFUSED',saveRefused:true}" ref="wall" :workspace-component="chromeWorkspace" :scope="props.scope" :default-profile="props.layout" :storage="workspaceStorage"
          owner-window-id="main-wall" :projection-view="feed" :capture-state="captureAvailable ? captureState : undefined" :display-only="nestedMode.displayOnly" :allow-lost-surface="admitLostRows" :intent-builders="props.runtime?.intentBuilders ?? intentBuilders"
          :control-registry="props.runtime?.controlRegistry ?? controlRegistry" :scheduler="props.runtime?.scheduler ?? scheduler" :tile-scheduler="props.runtime?.tileScheduler ?? tileScheduler"
          :color-scheme="scheme === 'mv-dark' ? 'dark' : 'light'" :density="density" @ready="onWallReady" @wall-settled="onWorkspaceSettled" @activate-surface="selectCapsule" @panel-closed="onPanelClosed" @submit-intent="onWallIntent">
          <template #workload="{workload}"><component :is="guestCommandPanel" v-if="guestCommandPanel" :snapshot="workload.snapshot" :rewind="rewindSnapshot" :rewind-panel="rewindPanel" @action="guestCommandAction" @rewind-action="requestRewind" /></template>
          <template #surface="{ surface, capsuleId, desktopActive }">
            <template v-if="surface && (!multislotOpen || capsuleId !== selectedSurface?.id)">
            <RoleSurface :presentation-active="desktopActive && !creativeOpen" :label="surfaceLabel(surface)" :surface-id="capsuleId" :control="surface.control" :can-take-control="wallInputState(surface) === 'view'" :recording-available="captureAvailable" @recordings="openCapturePanel(capsuleId)" @take-control="takeWallControl(surface)" @stored-data="openStoredData" @mode="onCapsuleMode" @lifecycle="onCapsuleLifecycle">
            <div v-if="wallInputState(surface) !== ''" class="mv-input-indicator" :data-input-state="wallInputState(surface)" :data-semantic-anchor="`capsule/${capsuleId}/input`">
              <span v-if="wallInputRefusal[capsuleId] && wallInputState(surface) === 'view'" class="mv-input-indicator__text mv-input-indicator__refusal" role="status">{{ wallInputRefusal[capsuleId] }}</span>
              <span v-else-if="wallInputState(surface) === 'pending'" class="mv-input-indicator__text" role="status">{{ wallInputRefusal[capsuleId] ?? 'Taking control…' }}</span>
              <span v-else-if="wallInputState(surface) === 'unavailable'" class="mv-input-indicator__text" role="status">Input unavailable in this window</span>
              <template v-else-if="wallInputState(surface) !== 'view'"><span class="mv-input-indicator__text" role="status">{{ wallInputRefusal[capsuleId] ?? (wallInputState(surface) === 'paused' ? 'Click the tile to type' : surface.hostWindow ? 'Interactive — your clicks and typing go to this window' : 'Interactive') }}</span><UiButton :id="`mv-input-release-${capsuleId}`" :data-semantic-anchor="`capsule/${capsuleId}/input/release`" class="mv-input-indicator__action" :label="surface.hostWindow ? 'Release to agent' : 'Release'" :aria-label="`Release control of ${surfaceLabel(surface)}`" @click="releaseWallControl(surface)" /></template>
            </div>
            <SurfaceCanvas :surface-id="capsuleId" :generation="surface.generation" :epoch="snapshot?.envelope?.epoch ?? ''" :frame="surfaceWitness(surface).frame" :digest="surfaceWitness(surface).digest" :frame-width="surfaceWitness(surface).width" :frame-height="surfaceWitness(surface).height" :state="canvasStateFor(surface)" :scroll-enabled="!surface.hostWindow" :input-enabled="inputEnabledFor(surface) || wallArmedFor(surface)" :stream-id="surfaceStreamId(surface)" @canvas-escape="onCanvasEscape(capsuleId)" @canvas-focus="onCanvasFocus(capsuleId)" />
            </RoleSurface>
            </template>
          </template>
        </DesktopWorkspace>
        <EmptyWallView :hint="otherCapsuleView ? `Your running capsules are in the ${otherCapsuleView === 'agent' ? 'Agents' : 'Humans'} view.` : undefined" v-if="(!visibleRows.length || allTilesClosed) && !guestWorkloadTiles.length && !nestedMode.displayOnly && !creativeOpen && !terminalDeckOpen" @add-capsule="launcherOpen = true">
          <template v-if="otherCapsuleView" #action>
            <UiButton id="empty-wall-other-view" data-semantic-anchor="wall/other-view"
              :label="`Go to ${otherCapsuleView === 'agent' ? 'Agents' : 'Humans'}`"
              @click="selectGlobalView(otherCapsuleView)" />
          </template>
        </EmptyWallView>
        <section v-if="creativeOpen && selectedSurface && !nestedMode.displayOnly" class="mv-creative-screen" aria-label="Creative capsule">
          <CreativeCapsule :capsule-id="selectedSurface.id" :frames="creativeFrames" title="Storyboard" @submit-intent="dispatch" />
        </section>
        <section v-if="multislotOpen && !nestedMode.displayOnly" class="mv-multislot-screen" aria-label="Capsule multislot">
          <UiButton id="multislot-back" data-semantic-anchor="multislot/back" label="Back to wall" @click="multislotOpen = false" />
          <p v-if="!selectedSurface" id="multislot-empty" data-semantic-anchor="multislot/empty" role="status">No capsule is available. Go back to the wall or create one.</p>
          <div v-if="capturePanelOnly && selectedSurface" class="mv-capture-screen"><h2>Recordings and screenshots</h2><MvRecordingPanel :capsule-id="selectedSurface.id" :export-destination="props.exportDestination" :capture-state="captureState" :capture-available="captureAvailable" @submit-intent="dispatch" /></div>
          <MultislotHost v-else-if="selectedSurface" :capsule-id="selectedSurface.id" :capsule-label="selectedSurface.title" :terminal-binding="props.terminal" :terminal-broker="props.terminalBroker" :terminal-session-port="props.terminalSessionPort" :host-providers="props.hostProviders" :broker-commands="props.brokerCommands" :clipboard="props.clipboard" :folded="selectedFolded" :hidden="selectedPlacement.hidden" :floating="selectedPlacement.floating"
            :float-x="selectedPlacement.x" :float-y="selectedPlacement.y" :float-width="selectedPlacement.width" :float-height="selectedPlacement.height"
            :group-id="selectedPlacement.groupId" :placement-index="selectedPlacement.index"
            :last-dock-group-id="selectedPlacement.lastDockGroupId" :last-dock-index="selectedPlacement.lastDockIndex"
            :surface-state="canvasStateFor(selectedSurface)" :layout-pending="placementPending[selectedSurface.id] === true" :agent-controlled="selectedSurface.control === 'agent'" v-model:input-mode="inputMode" @submit-intent="dispatchMultislot">
            <template #surface><SurfaceCanvas :surface-id="selectedSurface.id" :generation="selectedSurface.generation" :epoch="snapshot?.envelope?.epoch ?? ''" :frame="surfaceWitness(selectedSurface).frame" :digest="surfaceWitness(selectedSurface).digest" :frame-width="surfaceWitness(selectedSurface).width" :frame-height="surfaceWitness(selectedSurface).height" :state="canvasStateFor(selectedSurface)" :scroll-enabled="!selectedSurface.hostWindow" :input-enabled="inputEnabledFor(selectedSurface)" :stream-id="surfaceStreamId(selectedSurface)" /></template>
            <template #record><MvRecordingPanel :capsule-id="selectedSurface.id" :export-destination="props.exportDestination" :phase="props.fixture?.key === 'recording' ? 'recording' : 'idle'" :capture-state="captureState" :capture-available="captureAvailable" @submit-intent="dispatch" /></template>
          </MultislotHost>
        </section>
        <section v-if="!nestedMode.displayOnly" :hidden="!settingsOpen" class="mv-settings-screen" aria-label="Settings">
          <UiButton id="settings-back" data-semantic-anchor="settings/back" label="Back to wall" @click="settingsOpen = false" />
          <p>MetaViewer · AGPL-3.0-only · <a id="settings-license-source" data-semantic-anchor="settings/license-source" href="https://github.com/oguirado/MetaViewer" target="_blank" rel="noopener noreferrer">Source</a></p>
          <MvSettingsPanel :settings-host="props.settingsHost ?? {}" v-model:density="density" :frames-port="props.framesPort ?? null" @scheme-change="onScheme" />
        </section>

      </main>
    </div>
    <aside v-if="!nestedMode.displayOnly" class="mv-terminal-dock" :class="{ 'mv-terminal-dock--open': terminalDockOpen }" aria-label="Terminal dock">
      <UiButton label="Terminal" id="shell-terminal" data-semantic-anchor="terminal/toggle" class="mv-terminal-dock-toggle" type="button" :aria-expanded="terminalOpen" :aria-label="terminalDockOpen ? 'Collapse terminal dock' : 'Open terminal dock'" @click="toggleTerminalDock()"><span aria-hidden="true">›_</span><span v-if="terminalDockOpen">Terminal</span><span v-if="terminalDockOpen" aria-hidden="true">×</span></UiButton>
        <section v-if="!nestedMode.displayOnly" :hidden="!terminalDeckOpen || terminalInDrawer" :inert="!terminalDeckOpen ? true : undefined" :aria-hidden="!terminalDeckOpen || terminalInDrawer ? 'true' : undefined" id="mv-terminal-deck-screen" class="mv-terminal-deck-screen" aria-label="Terminal deck" data-semantic-anchor="terminal/deck">
          <Teleport :to="terminalDrawerTarget || 'body'" :disabled="!terminalInDrawer"><TerminalDeckView :compact="terminalInDrawer" @request-dock="terminalPreferDock = true" :open="terminalDeckOpen" :paired-target="pairedTerminalTarget" :terminal-binding="props.terminal" :terminal-broker="props.terminalBroker" :terminal-session-port="props.terminalSessionPort" :host-providers="props.hostProviders" :broker-commands="props.brokerCommands" :clipboard="props.clipboard" :storage="preferences" @pair-focus="activeTerminalPair = $event" @update:open="terminalOpen = $event" /></Teleport>
        </section>
    </aside>
    <div class="mv-terminal" :hidden="!terminalOpen || nestedMode.displayOnly || multislotOpen">
      <SideTerminalOverlay v-if="!nestedMode.displayOnly && !multislotOpen && !creativeOpen" :deck="terminalDeckOpen" :terminal-binding="props.terminal" :terminal-broker="props.terminalBroker" v-model:open="terminalOpen" :storage="preferences" :top-offset="terminalTop" :bottom-offset="terminalBottom" />
    </div>
    <DemoDialog v-if="!nestedMode.displayOnly" :open="demoOpen" @close="demoOpen=false" />
    <div v-if="pendingModeSwitch" class="mv-mode-confirm s1-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Switch capsule mode" @keydown.esc="pendingModeSwitch = null">
      <div class="mv-mode-confirm__panel s1-confirm-panel">
        <h3 class="s1-confirm-title">Switch capsule mode</h3>
        <p class="s1-confirm-body">This identity is open in {{ pendingModeSwitch.currentMode }} mode.</p>
        <div class="mv-mode-confirm__actions s1-confirm-footer">
          <UiButton id="mode-switch-confirm" data-semantic-anchor="capsule/mode/confirm" :label="`Close and reopen in ${pendingModeSwitch.requestedMode} mode`" @click="confirmModeSwitch" />
          <UiButton id="mode-switch-cancel" data-semantic-anchor="capsule/mode/cancel" label="Cancel" @click="pendingModeSwitch = null" />
        </div>
      </div>
    </div>
    <IdentitiesDialog v-if="!nestedMode.displayOnly" :open="identitiesOpen" :initial-profile="storedDataProfile" :before-delete="forgetIdentityLayout" :open-program="createProgramCapsule" @close="identitiesOpen=false; storedDataProfile=''" @open-identity="openIdentityChoice" />
    <CatalogLauncher v-if="!nestedMode.displayOnly" v-model:visible="launcherOpen" :arm64-capabilities="arm64Capabilities" :vm-available="vmAvailable" :guest-command-available="guestCommandSnapshot.available" :headless-available="(guestCommandSnapshot.available && !guestCommandSnapshot.session && !guestCommandSnapshot.uncertain) || (headlessSnapshot.available && !headlessSnapshot.session && !headlessSnapshot.uncertain)" @create="onCreateCapsule" />

    <component :is="headlessPanel" v-if="headlessOpen && headlessPanel && !nestedMode.displayOnly" :snapshot="headlessSnapshot" @run="runHeadlessJob" @stop="headlessAction('stop')" />
    <AgentLaneHost :screen="nestedMode.displayOnly ? 'nested' : creativeOpen ? 'creative' : settingsOpen ? 'settings' : multislotOpen ? 'multislot' : 'wall'" :fixture-key="props.fixture?.key ?? ''" />
  </div>
</template>
<style>
html, body, #metaviewer-app { width:100%; height:100%; margin:0; overflow:hidden; }
body { font-family:var(--cuk-semantic-typography-font-family-sans, system-ui, sans-serif); color:var(--cuk-semantic-text-primary); background:var(--cuk-semantic-surface-canvas); }
.mv-shell { height:100dvh; display:grid; grid-template-columns:48px minmax(0,1fr) 48px; grid-template-rows:var(--cuk-component-app-shell-topbar-height) minmax(0,1fr); background:var(--cuk-semantic-surface-canvas); }
.mv-terminal { position:fixed; inset:0; z-index:var(--cuk-semantic-z-index-overlay); pointer-events:none; }
.mv-terminal[hidden] { display:none; }
.mv-terminal > * { pointer-events:auto; }
.mv-shell-body { grid-column:2; grid-row:2; display:flex; min-width:0; min-height:0; position:relative; }
.mv-shell-rail { width:var(--cuk-semantic-size-rail-collapsed-width); flex:none; position:relative; }
.mv-shell main { position:relative; flex:1; min-height:0; min-width:0; overflow:auto; }
.mv-mode-confirm { position:fixed; inset:0; z-index:var(--cuk-component-dialog-host-z-index); background:var(--cuk-component-dialog-host-backdrop); display:flex; align-items:center; justify-content:center; padding:var(--cuk-semantic-spacing-lg); }
.mv-mode-confirm__panel { background:var(--cuk-semantic-surface-elevated); border:var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-default); border-radius:var(--cuk-component-dialog-host-border-radius); color:var(--cuk-semantic-text-primary); padding:var(--cuk-primitive-space-8); max-width:calc(var(--cuk-primitive-space-16) * 12); width:100%; display:grid; gap:var(--cuk-semantic-spacing-md); }
.mv-mode-confirm__actions { display:flex; justify-content:flex-end; gap:var(--cuk-semantic-spacing-sm); flex-wrap:wrap; }
/* MVUI19 lane A (L3-3): the settled outcome toast is transient and never
   intercepts pointer events on interactive rows beneath it. MVUI22 lane T:
   hoist the toast to the kit overlay layer so wall/multislot overlays (all
   below the overlay token) can never cover it; the corner placement stays. */
#shell-wall #mv-host-outcome { pointer-events:none; z-index:var(--cuk-semantic-z-index-overlay); }
/* Both paragraphs share one flow-sized cell; the reserve never enters the accessibility tree. */
.mv-tile-presets [aria-pressed="true"] { outline:2px solid var(--cuk-semantic-accent-primary); outline-offset:-2px; }
.mv-layout-notice { grid-row:auto; display:grid; min-width:0; }
.mv-layout-notice-reserve, .mv-layout-unavailable { grid-area:1 / 1; margin:0; padding:var(--cuk-semantic-spacing-sm); color:var(--cuk-semantic-text-primary); background:var(--cuk-semantic-surface-canvas); border:var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-default); font-size:var(--cuk-semantic-typography-font-size-sm); }
.mv-layout-notice-reserve { visibility:hidden; }
.mv-shell .cuk-capsule-panel { height:100%; }
.mv-shell .mv-surface-host { width:100%; height:100%; min-height:0; }
.mv-shell .mv-tile-capture-host { display:flex; flex-direction:column; min-height:0; }
.mv-shell .mv-tile-capture-host > .mv-surface { flex:1 1 auto; min-height:0; }
.mv-input-indicator { box-sizing:border-box; width:100%; flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:var(--cuk-semantic-spacing-xs); min-width:0; padding:var(--cuk-semantic-spacing-xs) var(--cuk-semantic-spacing-sm); font-size:var(--cuk-semantic-typography-font-size-xs); line-height:var(--cuk-semantic-typography-line-height-normal); color:var(--cuk-semantic-text-primary); background:var(--cuk-semantic-surface-panel); border-bottom:var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle); }
.mv-input-indicator__text { min-width:0; overflow-wrap:anywhere; }
.mv-input-indicator__action { min-width:0; max-width:100%; }
.mv-tile-capture-host:has(> .mv-input-indicator[data-input-state="view"]) .mv-surface__canvas { cursor:default; }
.mv-tile-capture-host:has(> .mv-input-indicator[data-input-state="interactive"]) { outline:var(--cuk-semantic-focus-ring-width) solid var(--cuk-semantic-accent-primary); outline-offset:calc(var(--cuk-semantic-focus-ring-width) * -1); }
.mv-tile-capture-host:has(> .mv-input-indicator[data-input-state="interactive"]):has(.mv-surface__canvas:focus) { outline-color:var(--cuk-semantic-focus-ring-color); }
.mv-tile-capture-host:has(> .mv-input-indicator[data-input-state="interactive"]) .mv-surface__canvas { cursor:crosshair; }
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
.mv-creative-screen, .mv-multislot-screen, .mv-settings-screen, .mv-terminal-deck-screen { position:absolute; inset:0; z-index:2; overflow:auto; padding:var(--cuk-semantic-spacing-md); background:var(--cuk-semantic-surface-canvas); }
.mv-terminal-deck-screen { padding:0; overflow:hidden; }
.mv-terminal-deck-screen[hidden] { display:none !important; pointer-events:none !important; }
.mv-shell--nested { grid-template-rows:minmax(0,1fr); }
.mv-shell--nested > .mv-shell-body { grid-row:1; }
.mv-nested-wall { display:grid; height:100%; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); }
.mv-nested-wall article { min-width:0; min-height:0; }
</style>

<style>
.mv-capture-screen { padding:20px; }
.mv-more-menu { position:relative; }
.mv-menu-popover { position:absolute; right:0; top:100%; z-index:10000; display:flex; flex-direction:column; min-width:220px; padding:6px; gap:4px; border:1px solid var(--cuk-semantic-border-subtle); border-radius:var(--cuk-semantic-radius-md); background:var(--cuk-semantic-surface-chrome); color:var(--cuk-semantic-text-primary); box-shadow:var(--cuk-semantic-shadow-md); }
.mv-menu-popover button { text-align:left; }
.mv-menu-popover[popover] { margin:0; position:fixed; inset:auto; position-area:bottom span-left; position-try-fallbacks:flip-block,flip-inline; max-height:calc(100vh - 24px); overflow:auto; }
.mv-menu-popover[popover]:not(:popover-open) { display:none; }
.mv-tile { position:relative; }
.mv-tile .cuk-capsule-panel__axes { display:none; }
.mv-tile .cuk-capsule-panel__actions > button:not(.mv-tile-terminal-toggle):not([id^="window-"]):not([data-semantic-anchor$="/close"]) { display:none; }
/* Window-hidden is permanent presentation state, including the entire shell. */
.mv-tile[hidden] { display:none !important; }
.dv-resize-container:has([data-mv-window-hidden="true"]):not(:has([data-mv-window-hidden="false"])), .dv-groupview:has([data-mv-window-hidden="true"]):not(:has([data-mv-window-hidden="false"])) { display:none !important; }
</style>

<style>
.mv-shell { --cuk-component-app-shell-topbar-height:40px; }
.mv-views { display:flex; align-self:stretch; gap:4px; margin-right:12px; }
.mv-view-column { display:flex; flex-direction:column; align-items:flex-start; min-width:88px; }
.mv-view-button, .mv-desktop-numbers button { cursor:pointer; color:var(--cuk-semantic-text-primary); background:transparent; border:1px solid var(--cuk-semantic-border-default); border-radius:5px; padding:4px 10px; font:inherit; }
.mv-view-button[aria-pressed="true"], .mv-desktop-numbers button[aria-pressed="true"] { background:var(--cuk-semantic-surface-canvas); font-weight:700; border-color:currentColor; }
.mv-desktop-numbers { display:flex; gap:3px; margin-top:3px; max-width:240px; overflow-x:auto; }
.mv-desktop-numbers button { padding:1px 6px; flex-shrink:0; }
.mv-desktop-numbers button:disabled { opacity:.4; cursor:default; }
.mv-view-button:focus-visible, .mv-desktop-numbers button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
</style>

<style>
/* Three persistent columns. Side docks participate in layout, never occlusion. */
.mv-shell--navigation-open { grid-template-columns:224px minmax(0,1fr) 48px; }
.mv-shell--terminal-open { grid-template-columns:48px minmax(0,1fr) minmax(320px,35vw); }
.mv-shell--navigation-open.mv-shell--terminal-open { grid-template-columns:224px minmax(0,1fr) minmax(320px,35vw); }
.mv-navigation { grid-column:1; grid-row:1 / -1; min-width:0; min-height:0; display:flex; flex-direction:column; border-right:1px solid var(--cuk-semantic-border-default); background:var(--cuk-semantic-surface-panel); overflow:hidden; }
.mv-navigation-brand { height:40px; flex:none; display:flex; align-items:center; gap:8px; padding:0 8px; border-bottom:1px solid var(--cuk-semantic-border-default); }
.mv-navigation-brand button { min-width:30px; min-height:28px; padding:2px; color:var(--cuk-semantic-text-primary); background:transparent; border:0; cursor:pointer; }
.mv-navigation-scroll { flex:1; min-height:0; overflow:auto; padding:12px 8px; }
.mv-navigation .mv-views { display:flex; flex-direction:column; gap:12px; margin:0 0 16px; }
.mv-navigation .mv-view-column { min-width:0; gap:4px; }
.mv-navigation .mv-view-button { width:100%; text-align:left; }
.mv-navigation .mv-desktop-numbers { max-width:100%; flex-wrap:wrap; overflow:visible; }
.mv-navigation-tools { display:flex; flex-direction:column; gap:6px; }
.mv-navigation-tools button { justify-content:flex-start; width:100%; }
.mv-navigation-foot { flex:none; min-width:0; border-top:1px solid var(--cuk-semantic-border-default); }
.mv-navigation .mv-activity { border:0; }
.mv-sidebar-status { height:auto; min-height:0; display:grid; gap:4px; padding:8px; font-size:11px; color:var(--cuk-semantic-text-muted); }
.mv-navigation .mv-layout-notice { margin-top:12px; font-size:11px; }
.mv-navigation .mv-layout-notice-reserve,.mv-navigation .mv-layout-unavailable { font-size:11px; }
.mv-navigation--collapsed .mv-navigation-scroll { padding:8px 4px; }
.mv-navigation--collapsed .mv-view-button { font-size:0; padding:5px; text-align:center; }
.mv-navigation--collapsed #view-human::after { content:'H'; font-size:12px; }
.mv-navigation--collapsed #view-agent::after { content:'A'; font-size:12px; }
.mv-navigation--collapsed .mv-desktop-numbers { gap:2px; }
.mv-navigation--collapsed .mv-desktop-numbers button { padding:2px 3px; }
.mv-navigation--collapsed .mv-sidebar-status,.mv-navigation--collapsed .mv-layout-notice-reserve { display:none; }
.mv-navigation--collapsed .mv-activity__bar { flex-wrap:wrap; padding:3px; gap:2px; }
.mv-navigation--collapsed .mv-activity__bar .mv-activity__empty { display:none; }
.mv-navigation--collapsed .mv-activity__bar button { font-size:0; }
.mv-navigation--collapsed .mv-activity__bar button::after { content:'≡'; font-size:14px; }
.mv-shell > .s1-topbar { grid-column:2; grid-row:1; min-height:40px; height:40px; padding:0 8px; gap:8px; }
.mv-shell > .s1-topbar .s1-topbar-left { display:none; }
.mv-shell > .s1-topbar .s1-topbar-center { flex:1; min-width:80px; }
.mv-shell > .s1-topbar #shell-command-open { width:100%; max-width:none; }
.mv-shell > .s1-topbar .s1-topbar-right { gap:4px; }
.mv-shell > .s1-topbar .s1-topbar-divider { display:none; }
.mv-shell .mv-tile-presets { display:flex; gap:3px; margin:0; padding:0; flex-wrap:nowrap; }
.mv-shell .mv-tile-presets button { padding:3px 6px; min-height:28px; }
.mv-shell .mv-tile-presets [aria-pressed="true"] { outline:0; background:var(--cuk-semantic-surface-canvas); box-shadow:inset 0 -2px var(--cuk-semantic-accent-primary); }
.mv-terminal-dock { grid-column:3; grid-row:1 / -1; min-width:0; min-height:0; display:flex; flex-direction:column; border-left:1px solid var(--cuk-semantic-border-default); background:var(--cuk-semantic-surface-panel); }
.mv-terminal-dock-toggle { display:flex; align-items:center; justify-content:space-between; gap:8px; flex:none; width:100%; height:40px; padding:0 12px; color:var(--cuk-semantic-text-primary); background:transparent; border:0; border-bottom:1px solid var(--cuk-semantic-border-default); cursor:pointer; }
.mv-terminal-dock .mv-terminal-deck-screen { position:relative; inset:auto; display:flex; flex:1; min-height:0; min-width:0; overflow:hidden; }
.mv-terminal-dock .mv-terminal-deck { min-width:0; width:100%; }
.mv-terminal-dock .mv-terminal-deck__header { flex-wrap:wrap; gap:4px; padding:6px; }
.mv-shell--nested { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr); }
.mv-shell--nested > .mv-shell-body { grid-column:1; grid-row:1; }
@media (max-width:1000px) {
  .mv-shell--navigation-open { grid-template-columns:176px minmax(0,1fr) 48px; }
  .mv-shell--navigation-open.mv-shell--terminal-open { grid-template-columns:176px minmax(0,1fr) 320px; }
  .mv-shell .s1-topbar-kbd,.mv-shell .s1-topbar-new-label { display:none; }
  .mv-shell .mv-tile-presets button { padding:3px; }
}
</style>

<style>
.mv-shell .mv-sidebar-status > .s1-statusbar { display:grid; grid-template-columns:minmax(0,1fr); height:auto; min-height:0; width:100%; box-sizing:border-box; padding:8px; white-space:normal; }
.mv-shell .mv-sidebar-status > .s1-statusbar > * { min-width:0; max-width:100%; white-space:normal; }
.mv-grid-tools summary { list-style:none; cursor:pointer; padding:3px 6px; min-height:24px; color:var(--cuk-semantic-text-primary); }
.mv-grid-tools summary:focus-visible { outline:2px solid var(--cuk-semantic-accent-primary); }
.mv-shell .wall-workspace { position:relative; }
.mv-shell .wall-grid-controls { display:none; position:absolute; top:0; left:0; right:0; z-index:var(--cuk-semantic-z-index-overlay); background:var(--cuk-semantic-surface-panel); border-bottom:1px solid var(--cuk-semantic-border-default); }
.mv-shell:has(#shell-grid-tools[open]) .wall-grid-controls { display:flex; }
</style>

<style>
.mv-tree-shortcuts { margin-bottom:14px; }
.mv-tree-shortcuts button { width:100%; min-height:30px; }
.mv-navigation .mv-working-tree { gap:18px; }
.mv-tree-heading,.mv-tree-desktop-heading { display:flex; align-items:center; min-width:0; gap:4px; }
.mv-tree-heading .mv-view-button { display:flex; align-items:center; gap:6px; flex:1; width:auto; min-width:0; padding:4px; text-transform:uppercase; letter-spacing:.07em; font-size:10px; border:0; background:transparent; }
.mv-tree-view-name { flex:1; text-align:left; }
.mv-tree-view-short { display:none; }
.mv-tree-count { color:var(--cuk-semantic-text-muted); font-variant-numeric:tabular-nums; font-size:10px; }
.mv-tree-add,.mv-tree-fold,.mv-tree-desktop-button,.mv-tree-capsule { font:inherit; color:var(--cuk-semantic-text-primary); background:transparent; border:0; cursor:pointer; }
.mv-tree-add { width:24px; height:24px; border-radius:4px; }
.mv-tree-add:disabled { opacity:.45; cursor:default; }
.mv-tree-desktop { margin-top:4px; padding:3px; border:1px solid transparent; border-radius:6px; }
.mv-tree-desktop--active { border-color:var(--cuk-semantic-border-default); background:var(--cuk-semantic-surface-canvas); }
.mv-tree-fold { width:18px; flex:none; padding:2px; color:var(--cuk-semantic-text-muted); }
.mv-tree-desktop-button { display:flex; align-items:center; justify-content:space-between; flex:1; min-width:0; padding:5px 2px; text-align:left; font-size:12px; }
.mv-tree-desktop-button[aria-pressed="true"] { font-weight:650; }
.mv-tree-capsules { list-style:none; padding:2px 0 2px 9px; margin:0; }
.mv-tree-capsule { display:flex; align-items:center; gap:5px; width:100%; min-width:0; padding:6px 2px; text-align:left; border-radius:4px; font-size:11px; }
.mv-tree-capsule-name { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mv-tree-capsule-status { flex:none; font-size:9px; color:var(--cuk-semantic-text-muted); }
.mv-tree-signal { flex:none; width:10px; font-size:9px; color:var(--cuk-semantic-text-muted); }
.mv-tree-capsule--selected { background:var(--cuk-semantic-surface-panel); box-shadow:inset 2px 0 var(--cuk-semantic-accent-primary); }
.mv-tree-needs-dot,[data-tone="attention"] { color:var(--cuk-semantic-text-primary); font-weight:700; }
.mv-tree-empty { padding:5px 2px; font-size:10px; color:var(--cuk-semantic-text-muted); }
.mv-working-tree button:focus-visible { outline:2px solid var(--cuk-semantic-accent-primary); outline-offset:1px; }
.mv-navigation--collapsed .mv-tree-desktops,.mv-navigation--collapsed .mv-tree-add,.mv-navigation--collapsed .mv-tree-view-name { display:none; }
.mv-navigation--collapsed .mv-tree-view-short { display:inline; font-size:12px; }
.mv-navigation--collapsed .mv-tree-heading .mv-view-button { flex-wrap:wrap; justify-content:center; gap:2px; padding:5px 0; font-size:10px; }
.mv-navigation--collapsed .mv-working-tree #view-human::after,.mv-navigation--collapsed .mv-working-tree #view-agent::after { content:none; }
.mv-navigation--collapsed .mv-tree-needs-dot { flex-basis:100%; font-size:8px; }
</style>

<style src="./design/premium.css"></style>
