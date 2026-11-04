<script setup>
import {computed, provide, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import WallWorkspace from './WallWorkspace.vue';
import {createWallLayout} from './layout.js';
import {decodeAndMigrateLayoutProfile} from '../../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';
import {DESKTOP_SCHEMA, VIEWS, createDesktopState, validateDesktopState, addDesktop as appendDesktop,
  assignSurface, desktopRows, removeDesktop as deleteDesktop, pruneDesktopLayout, normalizeDesktopLayout, renumberDesktops, moveSurface as relocateSurface} from '../../electron/desktopLayout.js';
import {desktopShortcut} from '../../electron/desktopShortcuts.js';
defineOptions({inheritAttrs:false});
const props = defineProps({
  storage:{type:Object,required:true}, scope:{type:/** @type {import('vue').PropType<import('capsule-ui-kit/layout').LayoutProfileScope>} */ (Object),required:true}, defaultProfile:{type:Object,required:true},
  projectionView:{type:Object,required:true},
  workloadTiles:{type:/** @type {import('vue').PropType<Array<any>>} */ (Array),default:()=>[]},
  intentBuilders:{type:Object,required:true}, controlRegistry:{type:Object,required:true}, scheduler:{type:Object,required:true}, tileScheduler:{type:Object,required:true}, rows:{type:/** @type {import('vue').PropType<Array<{id:string,[key:string]:any}>>} */ (Array),default:()=>[]}, modes:{type:Object,default:()=>({})},
});
const emit = defineEmits(['ready','wall-settled','desktops-change','layout-error','navigate','activate-surface','panel-closed','submit-intent']);
const state = ref(createDesktopState()), loaded = ref(false);
const walls = new Map(), ready = new Set(), adapters = new Map(), listeners = new Set();
const revealed = new Map();
let alive = true, readOnly = false, dirty = false, saving = /** @type {Promise<void>|null} */ (null), pruneTimer = /** @type {ReturnType<typeof setTimeout>|undefined} */ (undefined);
// [TARGET, unit decision] Fresh sessions may follow the first reported agent role.
// Saved layouts and explicit navigation close this startup-only choice.
let initialViewPending = true;
let requestedView = /** @type {string|null} */ (null);
const desktopKeys = new WeakMap(), usedKeys = new Set();
/** @param {string} view @param {number} id */
const keyOf = (view,id) => {
  const desktop = state.value.views[view].desktops.find(d=>d.id === id);
  if (!desktop) return `${view}-${id}`;
  if (!desktopKeys.has(desktop)) {
    let key = `${view}-${id}`;
    while (usedKeys.has(key)) key += '-next';
    usedKeys.add(key); desktopKeys.set(desktop,key);
  }
  return desktopKeys.get(desktop);
};
const desktops = computed(() => VIEWS.flatMap(view => state.value.views[view].desktops.map(desktop => ({view,desktop,key:keyOf(view,desktop.id)}))));
/** @param {string} view @param {number} id */
const isActive = (view,id) => state.value.activeView === view && state.value.views[view].active === id;
/** @param {string} id */
const homeOf = id => state.value.assignments[id];
const activeKey = () => keyOf(state.value.activeView,state.value.views[state.value.activeView].active);
function announce() {
  emit('desktops-change',state.value);
  for (const listener of listeners) listener();
}
/** @param {import("../../electron/desktopLayout.js").DesktopState} value */
function cleanLayouts(value) {
  for (const view of VIEWS) for (const desktop of value.views[view].desktops) {
    desktop.layout = pruneDesktopLayout(desktop.layout,id => value.assignments[id]?.view === view && value.assignments[id]?.desktop === desktop.id,desktop.preset === 'grid' || desktop.preset === 'grid-3x2');
  }
  return value;
}
function persist() {
  if (!loaded.value || !alive) return Promise.resolve();
  if (readOnly) return Promise.reject(Error('LAYOUT_SAVE_REFUSED'));
  dirty = true;
  if (!saving) saving = Promise.resolve().then(async () => {
    while (dirty && alive && !readOnly) {
      dirty = false;
      await props.storage.writeAtomic(JSON.stringify(cleanLayouts(JSON.parse(JSON.stringify(state.value)))));
    }
  }).catch(error => {emit('layout-error',error); throw error;}).finally(() => {
    saving = null;
    if (dirty && alive && !readOnly) void persist().catch(() => {});
  });
  return saving;
}
function reconcile() {
  if (!loaded.value) return;
  for (const row of [...props.rows,...props.workloadTiles]) {
    const view = props.modes[row.id] || 'agent';
    if (VIEWS.includes(view)) assignSurface(state.value,row.id,view);
  }
  if (initialViewPending && props.rows.length > 0
      && props.rows.every(row => props.modes[row.id] === 'agent')) {
    state.value.activeView = 'agent';
    initialViewPending = false;
  }
  for (const [key,seen] of revealed) for (const id of seen) {
    const home = homeOf(id);
    if (!home || keyOf(home.view,home.desktop) !== key) seen.delete(id);
  }
}
/** @param {string} view @param {number} id */
function adapter(view,id) {
  const key = keyOf(view,id);
  if (adapters.has(key)) return adapters.get(key);
  const owner = state.value.views[view].desktops.find(d=>d.id === id);
  const rows = () => desktopRows(state.value,props.rows,view,owner?.id ?? -1);
  const snapshot = () => {
    const base = props.projectionView.getSnapshot();
    return base?.envelope ? {...base,envelope:{...base.envelope,projection:{...base.envelope.projection,rows:rows()}}} : base;
  };
  const value = markRaw({
    feed:{getProjection:() => ({rows:rows()}),getSnapshot:snapshot,subscribe:(/** @type {(snapshot:any)=>void} */ listener) => {
      const update = () => listener(snapshot()); listeners.add(update);
      return () => listeners.delete(update);
    }},
    storage:{readRaw:async () => {
      const desktop = owner;
      return desktop?.layout ? JSON.stringify(desktop.layout) : null;
    },writeAtomic:async (/** @type {string} */ json) => {
      const desktop = owner;
      if (!desktop) return;
      desktop.layout = JSON.parse(json);
      // [TARGET, unit decision] Bounded identity hints outlive stopped surface IDs.
      const grid = desktop.snapGrid ?? {cols:2,rows:2};
      for (const group of desktop.layout.dockview?.floatingGroups ?? []) {
        const position = group.position;
        if (!position) continue;
        const layout = desktop.layout.dockview;
        const col = Math.round(position.left*grid.cols/layout.grid.width), row = Math.round(position.top*grid.rows/layout.grid.height);
        if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue;
        for (const panelId of group.data?.views ?? []) {
          const surfaceId = layout.panels[panelId]?.params?.capsuleId;
          const profile = props.rows.find(r=>r.id === surfaceId)?.profile_id;
          if (!profile || ['__proto__','constructor','prototype'].includes(profile) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) continue;
          desktop.identityCells ??= {};
          delete desktop.identityCells[profile];
          desktop.identityCells[profile] = {col,row};
          while (Object.keys(desktop.identityCells).length > 256) delete desktop.identityCells[Object.keys(desktop.identityCells)[0]];
        }
      }
      await persist();
    }},
    defaultProfile:createWallLayout(props.scope),
  });
  adapters.set(key,value); return value;
}
/** @param {string} key */
function revealAll(key) {
  if (!ready.has(key)) return;
  const entry = desktops.value.find(d => d.key === key);
  if (!entry) return;
  if (!revealed.has(key)) revealed.set(key,new Set());
  const seen = revealed.get(key);
  for (const row of desktopRows(state.value,props.rows,entry.view,entry.desktop.id)) {
    if (seen.has(row.id)) continue;
    if (walls.get(key)?.revealSurface(row.id,'split')?.ok) seen.add(row.id);
  }
}
/** @param {string} key */
function wallReady(key) {
  ready.add(key);
  const entry = desktops.value.find(d => d.key === key);
  walls.get(key)?.setPreset(entry?.desktop.preset ?? null);
  revealAll(key); emit('ready');
}
/** @param {string} view */
function selectView(view) {
  if (!VIEWS.includes(view)) return;
  initialViewPending = false;
  if (!loaded.value) { requestedView = view; return; }
  state.value.activeView = view;
}
/** @param {number} id */
function selectDesktop(id) {
  initialViewPending = false;
  const group = state.value.views[state.value.activeView];
  if (group.desktops.some(d => d.id === id)) group.active = id;
}
function addDesktop() { if (loaded.value) {try {return appendDesktop(state.value);} catch(error) {emit('layout-error',error);}} }
/** @param {number} id */
function removeDesktop(id) {
  const key = keyOf(state.value.activeView,id);
  if (!deleteDesktop(state.value,state.value.activeView,id)) return false;
  ready.delete(key); adapters.delete(key); revealed.delete(key);
  return true;
}
/** @param {string} id @param {string} [mode] */
async function followSurface(id, mode) {
  initialViewPending = false;
  if (!loaded.value) return;
  if (mode && VIEWS.includes(mode)) assignSurface(state.value,id,mode);
  const home = homeOf(id); if (!home) return;
  state.value.activeView = home.view; state.value.views[home.view].active = home.desktop;
  await nextTick();
}
/** @param {string} id @param {unknown} placement */
function revealSurface(id,placement) {
  const home = homeOf(id); if (!home) return {ok:false};
  return walls.get(keyOf(home.view,home.desktop))?.revealSurface(id,placement) ?? {ok:false};
}
/** @param {any} intent */
function applyPresentationIntent(intent) {
  const home = homeOf(intent.capsuleId);
  return home ? walls.get(keyOf(home.view,home.desktop))?.applyPresentationIntent(intent) : undefined;
}
/** @param {string} id @param {unknown} body */
function applyLayoutEcho(id,body) {
  const home = homeOf(id); return home ? walls.get(keyOf(home.view,home.desktop))?.applyLayoutEcho(id,body) : undefined;
}
/** @param {string|null} preset */
function setPreset(preset) {
  if (!loaded.value || !ready.has(activeKey())) return {ok:false,code:'ERR_NOT_READY'};
  if (readOnly) return {ok:false,code:'LAYOUT_SAVE_REFUSED'};
  const group = state.value.views[state.value.activeView];
  const desktop = group.desktops.find(d => d.id === group.active);
  const result = walls.get(activeKey())?.setPreset(preset);
  if (!desktop || !result?.ok) return result ?? {ok:false,code:'ERR_NOT_READY'};
  desktop.preset = preset;
  if (preset === 'grid-3x2') desktop.snapGrid = {cols:3,rows:2};
  if (preset === 'grid') desktop.snapGrid = {cols:2,rows:2};
  return result;
}
// Transfer tokens are local ownership handoffs, never backend lifecycle verbs.
const transfers = new Map();
function activateTile(/** @type {any} */ payload) { emit('activate-surface',payload); }
function resizeTile(/** @type {string} */ id, /** @type {string} */ action) {
  const home = homeOf(id);
  return home ? walls.get(keyOf(home.view,home.desktop))?.resizeTile(id,action) : {ok:false};
}
async function moveTile(/** @type {string} */ id, /** @type {number|'new'} */ destination, follow = false) {
  if (!loaded.value || readOnly) return {ok:false};
  const home = homeOf(id); if (!home) return {ok:false};
  const source = keyOf(home.view,home.desktop), group = state.value.views[home.view];
  let target = destination;
  if (target === 'new') {const active = group.active;try {target = appendDesktop(state.value,home.view);} catch {return {ok:false,code:'DESKTOP_LIMIT'};} group.active = active;}
  if (!group.desktops.some(d=>d.id === target)) return {ok:false};
  if (home.desktop === target) { if (follow) await followSurface(id); return {ok:true}; }
  const native = /** @type {any} */ (globalThis).metaviewerRoles;
  if (native) { const reply = await native.visibility(id,false); if (!reply?.ok) return reply; }
  transfers.set(id,{});
  const closed = walls.get(source)?.applyPresentationIntent({type:'close',capsuleId:id});
  if (!closed?.ok) {transfers.delete(id);return closed ?? {ok:false};}
  revealed.get(source)?.delete(id);
  relocateSurface(state.value,id,/** @type {number} */ (target),follow);
  cleanLayouts(state.value); announce();
  await nextTick();
  revealAll(keyOf(home.view,home.desktop));
  await persist();
  if (follow) emit('navigate',home.view);
  return {ok:true};
}
provide('tileLayoutActions',{
  resize:resizeTile, move:moveTile, transfers, focus:(/** @type {string} */ id)=>revealSurface(id,'tab'),
  desktops:(/** @type {string} */ id)=> {const home = homeOf(id);return home ? state.value.views[home.view].desktops.map(d=>({id:d.id,current:d.id === home.desktop})) : [];},
});
/** @param {{type:string,desktop?:number,action?:string,capsuleId?:string}|null} chord */
function shortcut(chord) {
  if (chord?.type === 'resize') {
    if (chord.capsuleId) resizeTile(chord.capsuleId,chord.action || '');
    else walls.get(activeKey())?.resizeFocused(chord.action);
  }
  else if (chord?.type === 'toggle') selectView(state.value.activeView === 'human' ? 'agent' : 'human');
  else if (chord?.type === 'select') selectDesktop(chord.desktop ?? -1);
  if (chord) emit('navigate',state.value.activeView);
}
const capturedKeys = new Set();
/** @param {KeyboardEvent} event */
function onKey(event) {
  const chord = desktopShortcut(event), code = event.code || event.key;
  if (!chord && !capturedKeys.has(code)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.type === 'keyup') { capturedKeys.delete(code); return; }
  capturedKeys.add(code); if (chord) shortcut(chord);
}
/** @param {Event} event */
const onNativeShortcut = event => shortcut(/** @type {CustomEvent} */(event).detail);
watch(() => [props.rows,props.modes,props.workloadTiles], () => {reconcile(); announce(); for (const key of ready) revealAll(key);}, {deep:true});
watch(state, () => {announce(); void persist().catch(() => {});}, {deep:true});
onMounted(async () => {
  try {
    const raw = await props.storage.readRaw();
    if (!alive) return;
    if (raw !== null) {
      initialViewPending = false;
      const value = JSON.parse(raw);
      if (value?.schema === DESKTOP_SCHEMA) {
        if (!validateDesktopState(value,layout => decodeAndMigrateLayoutProfile(layout,{expectedScope:props.scope}).ok)) throw Error('LAYOUT_CONTRACT_INVALID');
        for (const view of VIEWS) {
          for (const desktop of value.views[view].desktops) desktop.layout = normalizeDesktopLayout(desktop.layout);
          renumberDesktops(value,view);
        }
        state.value = value;
      } else {
        const checked = decodeAndMigrateLayoutProfile(value,{expectedScope:props.scope});
        if (!checked.ok) throw Error('LAYOUT_CONTRACT_INVALID');
        // Legacy mixed wall becomes two filtered copies; stale references are
        // removed at serialization and by the existing orphan prune in each wall.
        for (const view of VIEWS) state.value.views[view].desktops[0].layout = normalizeDesktopLayout(checked.profile);
      }
    }
  } catch (error) { initialViewPending = false; readOnly = true; emit('layout-error',error); }
  if (!alive) return;
  if (requestedView) state.value.activeView = requestedView;
  loaded.value = true; reconcile(); announce();
  // Same startup grace as the existing wall orphan gate: never prune while
  // native surfaces are still filling the authoritative projection.
  let projectionSince = /** @type {number|null} */ (null);
  const prune = () => {
    if (!alive) return;
    const snapshot = props.projectionView.getSnapshot?.();
    const projection = snapshot?.envelope?.projection;
    if (!projection || snapshot.stale !== false || snapshot.status !== 'live' || !Array.isArray(projection.rows)) {
      projectionSince = null;
    } else {
      projectionSince ??= Date.now();
      if (Date.now() - projectionSince >= 5000) {
        const ids = new Set(projection.rows.filter((/** @type {any} */ row)=>row.backendLifecycle !== 'destroyed').map((/** @type {any} */ row)=>row.id));
        for(const row of props.workloadTiles)ids.add(row.id);
        for (const id of Object.keys(state.value.assignments)) if (!ids.has(id)) {
          delete state.value.assignments[id];
          for (const seen of revealed.values()) seen.delete(id);
        }
        cleanLayouts(state.value);
        return;
      }
    }
    pruneTimer = setTimeout(prune,250);
  };
  pruneTimer = setTimeout(prune,5000);
  window.addEventListener('keydown',onKey,true); window.addEventListener('keyup',onKey,true);
  window.addEventListener('metaviewer:desktop-shortcut',onNativeShortcut);
});
onBeforeUnmount(() => {
  alive = false; clearTimeout(pruneTimer); listeners.clear();
  window.removeEventListener('keydown',onKey,true); window.removeEventListener('keyup',onKey,true);
  window.removeEventListener('metaviewer:desktop-shortcut',onNativeShortcut);
});
function forgetSurface(/** @type {string} */ id) {
  delete state.value.assignments[id];
  for (const seen of revealed.values()) seen.delete(id);
  cleanLayouts(state.value);
}
/** @param {string} id */
function revealWorkload(id){const home=homeOf(id);if(!home)return;state.value.activeView=home.view;state.value.views[home.view].active=home.desktop;announce();return walls.get(keyOf(home.view,home.desktop))?.revealWorkload?.(id);}
defineExpose({revealWorkload,moveTile,resizeTile,forgetSurface,revealSurface,followSurface,applyPresentationIntent,applyLayoutEcho,setPreset,selectView,selectDesktop,addDesktop,removeDesktop});
</script>
<template>
  <div class="mv-desktop-workspace" :hidden="$attrs.hidden === true">
    <template v-if="loaded">
      <WallWorkspace v-for="{view,desktop,key} in desktops" :key="key" :ref="el => el ? walls.set(key,el) : walls.delete(key)"
        v-bind="$attrs" :hidden="!isActive(view,desktop.id)" :data-desktop="key"
        :intent-builders="/** @type {any} */ (intentBuilders)" :control-registry="controlRegistry" :scheduler="scheduler" :tile-scheduler="/** @type {any} */ (tileScheduler)"
        :scope="scope" :default-profile="adapter(view,desktop.id).defaultProfile" :storage="adapter(view,desktop.id).storage"
        :identity-cells="desktop.identityCells" :snap-grid="desktop.snapGrid" @custom-layout="desktop.preset = $event ?? null" @snap-grid-change="desktop.snapGrid = $event"
        :workload-tiles="props.workloadTiles.filter(row=>homeOf(row.id)?.view===view&&homeOf(row.id)?.desktop===desktop.id)" :projection-view="adapter(view,desktop.id).feed" :owner-window-id="`main-wall-${key}`"
        @ready="wallReady(key)" @wall-settled="emit('wall-settled')" @activate-surface="activateTile($event)"
        @layout-error="emit('layout-error',$event)" @panel-closed="emit('panel-closed',$event)" @submit-intent="emit('submit-intent',$event)">
        <template #surface="slotProps"><slot name="surface" v-bind="slotProps" :desktop-active="isActive(view,desktop.id)" /></template>
        <template #workload="slotProps"><slot name="workload" v-bind="slotProps" /></template>
      </WallWorkspace>
    </template>
  </div>
</template>
<style>
.mv-desktop-workspace { width:100%; height:100%; min-height:0; position:relative; }
.mv-desktop-workspace[hidden], .mv-desktop-workspace > .wall-workspace[hidden] { display:none !important; }
.mv-desktop-workspace > .wall-workspace { position:absolute; inset:0; }
</style>
