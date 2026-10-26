<script setup>
/** [TARGET, unit decision] Missing live projection/gateway handoff: mount the
 * real wall against an unavailable view. No invented surfaces or generations.
 * Live capabilities remain unavailable until the conductor supplies the feed.
 */
import { computed, defineComponent, h, markRaw, onBeforeUnmount, onMounted, provide, ref, shallowRef } from 'vue';
import DockWorkspace from 'capsule-ui-kit/DockWorkspace';
import { ShellWorkspace, TopBar, Sidebar, StatusBar, NewCapsuleDialog } from '../.kit/capsule-ui-kit/src/index-shell.js';
import SideTerminalPanel from '../.kit/capsule-ui-kit/src/side-terminal/SideTerminalPanel.vue';
import { UiButton } from 'capsule-ui-kit/ui';
import { setKitScheme } from 'capsule-ui-kit/theme';
import { SETTINGS_STORAGE_KEYS, readStoredSetting, writeStoredSetting } from '../.kit/capsule-ui-kit/src/shell/SettingsModel.js';
import WallWorkspace from './wall/WallWorkspace.vue';
import SurfaceCanvas from './surfaces/SurfaceCanvas.vue';
import { createSideTerminalFacade } from './terminal/sideTerminalFacade.js';
import { createTileScheduler } from './surfaces/tileScheduler.js';
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileEnvelope} LayoutProfile */
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileScope} LayoutScope */
/** @typedef {Pick<InstanceType<typeof WallWorkspace>['$props'], 'projectionView'|'intentBuilders'|'controlRegistry'|'scheduler'|'tileScheduler'>} WallRuntime */
/** @typedef {{readRaw:()=>Promise<string|null>,writeAtomic:(json:string)=>Promise<void>}} LayoutStorage */
const props = defineProps({
  runtime: { type: /** @type {import('vue').PropType<WallRuntime|null>} */ (Object), default: null },
  terminal: { type: /** @type {import('vue').PropType<{session:string,port:MessagePort}|null>} */ (Object), default: null },
  layout: { type: /** @type {import('vue').PropType<LayoutProfile>} */ (Object), required: true },
  scope: { type: /** @type {import('vue').PropType<LayoutScope>} */ (Object), required: true },
  storage: { type: /** @type {import('vue').PropType<LayoutStorage>} */ (Object), required: true },
});
const settled = ref(false);
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
/** [TARGET, unit decision] Layout-only preload: kit settings use local storage.
 * Launcher reveals admitted rows only; no fabricated core creation API. */
provide('capsuleChromeStyle', 'openvue');
let preferences = /** @type {Storage|null} */ (null);
try { preferences = globalThis.localStorage; } catch { /* settings store absent */ }
const storedScheme = readStoredSetting(preferences, SETTINGS_STORAGE_KEYS.scheme, 'mv-light');
const scheme = ref(storedScheme === 'mv-dark' ? 'mv-dark' : 'mv-light');
const applyScheme = /** @type {(scheme:string)=>void} */ (setKitScheme);
applyScheme(scheme.value);
document.documentElement.dataset.themeDensity = 'compact';
function toggleScheme() {
  scheme.value = scheme.value === 'mv-light' ? 'mv-dark' : 'mv-light';
  applyScheme(scheme.value);
  writeStoredSetting(preferences, SETTINGS_STORAGE_KEYS.scheme, scheme.value);
}
const launcherOpen = ref(false);
const railOpen = ref(false);
const terminalOpen = ref(false);
const terminalTop = ref(0), terminalBottom = ref(0);
function measureChrome() {
  terminalTop.value = document.getElementById('shell/header')?.offsetHeight ?? 0;
  terminalBottom.value = document.getElementById('shell/statusbar')?.offsetHeight ?? 0;
}
onMounted(() => { measureChrome(); window.addEventListener('resize', measureChrome); });
onBeforeUnmount(() => window.removeEventListener('resize', measureChrome));
const terminalFacade = props.terminal ? markRaw(createSideTerminalFacade(props.terminal)) : null;
onBeforeUnmount(() => terminalFacade?.dispose());
const wall = ref(/** @type {InstanceType<typeof WallWorkspace>|null} */ (null));
const feed = props.runtime?.projectionView ?? projectionView;
const snapshot = shallowRef(feed.getSnapshot());
const rows = computed(() => {
  void snapshot.value;
  return feed.getProjection()?.rows.filter(row => !['lost', 'destroyed'].includes(row.backendLifecycle)) ?? [];
});
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
function onSettled() { settled.value = true; revealRows(); }
/** @param {any} payload */
function openCapsule(payload) {
  const id = payload?.type?.id ?? payload?.id;
  if (id === 'add') { launcherOpen.value = true; return; }
  if (rows.value.some(row => row.id === id)) wall.value?.revealSurface(id, payload?.placement ?? 'tab');
}
const chromeWorkspace = markRaw(defineComponent({
  inheritAttrs: false,
  setup: (_, { attrs }) => () => h(ShellWorkspace, { ...attrs, workspaceComponent: DockWorkspace }),
}));
</script>
<template>
  <div class="metaviewer mv-shell" :data-wall-settled="String(settled)">
    <TopBar product="MetaViewer" new-label="Add capsule" search-placeholder="Find a capsule…" :nav-expanded="railOpen"
      :palette-items="catalog" @toggle-nav="railOpen = !railOpen" @new-capsule="launcherOpen = true" @open="openCapsule">
      <template #actions>
        <UiButton id="shell-theme" data-semantic-anchor="settings/scheme" :label="scheme === 'mv-light' ? 'Dark mode' : 'Light mode'" @click="toggleScheme" />
        <UiButton id="shell-terminal" data-semantic-anchor="terminal/toggle" label="Terminal" :aria-expanded="terminalOpen" @click="terminalOpen = !terminalOpen" />
      </template>
    </TopBar>
    <div class="mv-shell-body">
      <div class="mv-shell-rail"><Sidebar :groups="groups" :collapsed="!railOpen" :overlay="true" workspace-label="MetaViewer" @open="openCapsule" /></div>
      <main id="shell-wall" aria-label="MetaViewer capsule wall">
        <WallWorkspace ref="wall" :workspace-component="chromeWorkspace" :scope="props.scope" :default-profile="props.layout" :storage="props.storage"
          owner-window-id="main-wall" :projection-view="feed" :intent-builders="props.runtime?.intentBuilders ?? intentBuilders"
          :control-registry="props.runtime?.controlRegistry ?? controlRegistry" :scheduler="props.runtime?.scheduler ?? scheduler" :tile-scheduler="props.runtime?.tileScheduler ?? tileScheduler"
          :color-scheme="scheme === 'mv-dark' ? 'dark' : 'light'" density="compact" @ready="revealRows" @wall-settled="onSettled">
          <template #surface="{ surface, capsuleId }">
            <SurfaceCanvas v-if="surface" :surface-id="capsuleId" :generation="surface.generation" :epoch="String(feed.getSnapshot()?.envelope?.epoch ?? '')" :state="surface.attachmentState === 'live' ? 'live' : 'connecting'" />
          </template>
        </WallWorkspace>
        <Teleport v-if="settled" to=".cuk-shell-workspace">
        <section v-if="!rows.length" class="mv-empty-wall" aria-labelledby="empty-wall-title">
          <div class="mv-empty-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <p class="mv-eyebrow">YOUR WORKSPACE</p>
          <h1 id="empty-wall-title">A clear view of your work.</h1>
          <p>Add a capsule to bring your surfaces together in one wall.</p>
          <UiButton id="empty-wall-add" data-semantic-anchor="wall/add-capsule" label="Add capsule" intent="primary" @click="launcherOpen = true" />
        </section>
        </Teleport>
      </main>
    </div>
    <StatusBar :crumbs="[{ id: 'wall', label: 'Main wall' }]" :shortcuts="[]">
      <template #telemetry><span id="shell-feed-status" class="mv-feed-status" role="status"><i aria-hidden="true"></i>{{ snapshot?.envelope ? 'Core connected' : 'Core not connected' }}</span></template>
      <template #shortcuts><span class="mv-shell-caption">{{ rows.length ? `${rows.length} capsules` : 'Ready when you are' }}</span></template>
    </StatusBar>
    <SideTerminalPanel class="mv-terminal" :facade="terminalFacade ?? undefined" v-model:open="terminalOpen" :storage="preferences" :top-offset="terminalTop" :bottom-offset="terminalBottom" />
    <NewCapsuleDialog v-model:visible="launcherOpen" :types="catalog" title="Add capsule" subtitle="Choose a surface to open in your wall" empty-text="Connected surfaces will appear here when the core is ready." @create="openCapsule" />
  </div>
</template>
<style>
html, body, #metaviewer-app { width:100%; height:100%; margin:0; overflow:hidden; }
body { font-family:var(--cuk-semantic-typography-font-family-sans, system-ui, sans-serif); color:var(--cuk-semantic-text-primary); background:var(--cuk-semantic-surface-canvas); }
.mv-shell { height:100dvh; display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:var(--cuk-component-app-shell-topbar-height) minmax(0,1fr) var(--cuk-component-app-shell-status-height); background:var(--cuk-semantic-surface-canvas); }
.mv-shell-body { display:flex; min-width:0; min-height:0; position:relative; }
.mv-shell-rail { width:var(--cuk-semantic-size-rail-collapsed-width); flex:none; position:relative; }
.mv-shell main { position:relative; flex:1; min-height:0; min-width:0; }
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
