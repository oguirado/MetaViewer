<script setup>
/**
 * MetaViewer New Capsule launcher (AC-03): catalog model over the kit
 * NewCapsuleDialog overlay. Valid kinds render as kit cards; unknown or
 * malformed entries render as designed typed error rows in the dialog
 * `empty` slot (only provided while errors exist, so clean catalogs keep
 * exact kit behaviour). Keyboard flow is kit-native (search, grid arrows,
 * Enter, Escape); this wrapper adds invoker focus return on close and
 * translates the kit choice into a create intent payload.
 */
import { computed, ref, watch } from 'vue';
import { NewCapsuleDialog } from '../../.kit/capsule-ui-kit/src/index-shell.js';
import {
  CATALOG_KIND_IDS,
  buildCreateIntent,
  createInvokerFocus,
  filterWindowCandidates,
  normalizeCatalogEntries,
  normalizeWindowList,
} from './catalogModel.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  kinds: { type: Array, default: () => [...CATALOG_KIND_IDS] },
  title: { type: String, default: 'Add capsule' },
  subtitle: { type: String, default: 'Choose a capsule kind to open in your wall' },
  emptyText: { type: String, default: 'No capsule kinds match this search.' },
});
const emit = defineEmits(['update:visible', 'create', 'close']);

const api = /** @type {any} */ (globalThis).metaviewerRoles;
const roleChoice = ref('agent'), profileChoice = ref(''), choosingRole = ref(false), roleError = ref('');
const roleEdited = ref(false);
const editedRoleChoice = ref('agent');
const choosingProgram = ref(false), programBinary = ref(''), programRole = ref('human'), programError = ref(''), programBusy = ref(false);
const choosingWindow = ref(false), windowSearch = ref(''), windowChoices = ref(/** @type {Array<{xid:number,witness:string,title:string,program:string,width:number,height:number}>} */ ([]));
const windowChoiceXid = ref(0), windowError = ref(''), windowBusy = ref(false);
const filteredWindows = computed(() => filterWindowCandidates(windowChoices.value, windowSearch.value));
const selectedWindow = computed(() => filteredWindows.value.find(w => w.xid === windowChoiceXid.value) || null);
let choiceGeneration = 0;
watch(() => props.visible,visible=>{if(!visible){choiceGeneration++;choosingRole.value=false;choosingProgram.value=false;programRole.value='human';programError.value='';choosingWindow.value=false;windowError.value='';windowChoiceXid.value=0;windowSearch.value='';}});
const pendingIntent = ref(/** @type {any} */ (null));
const profileChoices = ref(/** @type {Array<{role:string,profileId:string,available:boolean,currentMode?:string}>} */ ([]));
const matchingProfiles = computed(() => profileChoices.value);
watch(profileChoice, id => { if (!roleEdited.value) roleChoice.value = profileChoices.value.find(p => p.profileId === id)?.role || 'agent'; });
function confirmRole() {
  const profile = matchingProfiles.value.find(p => p.profileId === profileChoice.value);
  if (/** @type {any} */ (profile)?.busy) { roleError.value = 'SURFACE_CREATE_BUSY: A capsule is already starting. Wait for it to finish, then try again.'; return; }
  if (!profile?.available) { roleError.value = profile ? 'PROFILE_ALREADY_BOUND: Check this identity in Identities and stop or reuse its existing capsule.' : 'NO_IDENTITY: Open Identities to add or check an available identity, then try Add capsule again.'; return; }
  emit('create', {...pendingIntent.value,choice:{role:roleChoice.value,profileId:profile.profileId}});
  choosingRole.value = false;
  emit('update:visible', false);
}
async function confirmProgram() {
  const result = buildCreateIntent({
    kind: pendingIntent.value?.kind || 'program',
    placement: pendingIntent.value?.placement,
    binary: programBinary.value,
    ...(typeof programRole !== 'undefined' && programRole?.value ? { role: programRole.value } : {}),
  });
  if (!result.ok) {
    programError.value = result.error.message;
    return;
  }
  programError.value = '';
  programBusy.value = true;
  let settledByListener = false;
  /** @type {any} */
  let outcome = null;
  const settle = (/** @type {any} */ reply) => {
    settledByListener = true;
    outcome = reply;
  };
  try {
    emit('create', result.intent, settle);
    if (!settledByListener) {
      programError.value = 'Program launch was not handled by the host.';
      return;
    }
    if (outcome && typeof outcome.then === 'function') {
      outcome = await outcome;
    }
    if (outcome && outcome.ok === false) {
      programError.value = outcome.reason || outcome.message || outcome.code || 'Program could not be started.';
      return;
    }
    if (!outcome || outcome.ok !== true) {
      programError.value = 'Program could not be started.';
      return;
    }
    choosingProgram.value = false;
    emit('update:visible', false);
  } catch (err) {
    const e = /** @type {any} */ (err);
    programError.value = e?.reason || e?.message || e?.code || 'Program could not be started.';
  } finally {
    programBusy.value = false;
  }
}
function cancelProgram() {
  if (programBusy.value) return;
  choosingProgram.value = false;
  programError.value = '';
  emit('update:visible', false);
}
function selectWindowRow(/** @type {number} */ xid) {
  if (typeof windowChoiceXid !== 'undefined') windowChoiceXid.value = Number(xid) || 0;
  if (typeof windowError !== 'undefined') windowError.value = '';
}
async function confirmWindow() {
  if (typeof choosingWindow === 'undefined') return;
  const chosen = selectedWindow.value;
  const result = buildCreateIntent({
    kind: 'desktop-window',
    placement: pendingIntent.value?.placement,
    window: chosen,
  });
  if (!result.ok) {
    windowError.value = result.error.message;
    return;
  }
  windowError.value = '';
  windowBusy.value = true;
  let settledByListener = false;
  /** @type {any} */
  let outcome = null;
  const settle = (/** @type {any} */ reply) => {
    settledByListener = true;
    outcome = reply;
  };
  try {
    emit('create', result.intent, settle);
    if (!settledByListener) {
      windowError.value = 'Desktop window attach was not handled by the host.';
      return;
    }
    if (outcome && typeof outcome.then === 'function') {
      outcome = await outcome;
    }
    if (outcome && outcome.ok === false) {
      windowError.value = outcome.reason || outcome.message || outcome.code || 'Desktop window could not be attached.';
      return;
    }
    if (!outcome || outcome.ok !== true) {
      windowError.value = 'Desktop window could not be attached.';
      return;
    }
    choosingWindow.value = false;
    windowChoiceXid.value = 0;
    emit('update:visible', false);
  } catch (err) {
    const e = /** @type {any} */ (err);
    windowError.value = e?.reason || e?.message || e?.code || 'Desktop window could not be attached.';
  } finally {
    windowBusy.value = false;
  }
}
function cancelWindow() {
  if (windowBusy.value) return;
  if (typeof choosingWindow !== 'undefined') choosingWindow.value = false;
  if (typeof windowChoiceXid !== 'undefined') windowChoiceXid.value = 0;
  if (typeof windowError !== 'undefined') windowError.value = '';
  emit('update:visible', false);
}
const normalized = computed(() => normalizeCatalogEntries(props.kinds));
const dialogTypes = computed(() => [...normalized.value.types]);
const catalogErrors = computed(() => normalized.value.errors);

const invokerFocus = createInvokerFocus();
// Capture before the dialog can move focus; restore after its close update.
watch(() => props.visible, (open) => {
  if (typeof document === 'undefined') return;
  if (open) invokerFocus.capture(document.activeElement);
}, { immediate: true });
watch(() => props.visible, (open, previous) => {
  if (!open && previous) invokerFocus.restore();
}, { flush: 'post' });

/** @param {boolean} value */
function forwardVisible(value) {
  // The kit dialog closes itself right after `create`: that close must not end the role, program or window step.
  if (!value && (choosingRole.value || (typeof choosingProgram !== 'undefined' && choosingProgram.value) || (typeof choosingWindow !== 'undefined' && choosingWindow.value))) return;
  if(!value){choiceGeneration++;choosingRole.value=false;if(typeof choosingProgram!=='undefined')choosingProgram.value=false;if(typeof choosingWindow!=='undefined')choosingWindow.value=false;}
  emit('update:visible', value);
}

/** @param {{ type?: { id?: unknown }, placement?: unknown, binary?: unknown, role?: unknown } | null} payload */
async function onCreate(payload) {
  if (payload?.type?.id === 'program' || payload?.type?.id === 'host-program') {
    pendingIntent.value = { kind: payload.type.id, placement: payload?.placement };
    if (typeof choosingProgram !== 'undefined') {
      programBinary.value = typeof payload?.binary === 'string' ? payload.binary : '';
      if (typeof programRole !== 'undefined') programRole.value = payload?.role === 'agent' ? 'agent' : 'human';
      programError.value = '';
      choosingProgram.value = true;
    }
    return;
  }
  if (payload?.type?.id === 'desktop-window') {
    const generation = ++choiceGeneration;
    pendingIntent.value = { kind: 'desktop-window', placement: payload?.placement };
    if (typeof choosingWindow !== 'undefined') {
      windowSearch.value = '';
      windowChoices.value = [];
      windowChoiceXid.value = 0;
      windowError.value = '';
      choosingWindow.value = true;
      try {
        const hostApi = (typeof api !== 'undefined' && api) ? api : (/** @type {any} */ (globalThis).metaviewerRoles);
        if (!hostApi || typeof hostApi.listWindows !== 'function') {
          throw Error('host_window_unavailable: window listing unavailable');
        }
        const rawList = await hostApi.listWindows();
        if (!props.visible || generation !== choiceGeneration) return;
        if (rawList && typeof rawList === 'object' && !Array.isArray(rawList) && rawList.ok === false) {
          throw Error(rawList.reason || rawList.message || 'host_window_unavailable: window listing failed');
        }
        const entries = Array.isArray(rawList) ? rawList : (Array.isArray(rawList?.windows) ? rawList.windows : null);
        const admitted = normalizeWindowList(entries);
        if (!admitted.ok) {
          throw Error('host_window_unavailable: invalid or ambiguous window list');
        }
        windowChoices.value = [...admitted.windows];
      } catch (err) {
        if (!props.visible || generation !== choiceGeneration) return;
        windowChoices.value = [];
        const e = /** @type {any} */ (err);
        windowError.value = e?.reason || e?.message || 'host_window_unavailable: window listing failed';
      }
    }
    return;
  }
  const result = buildCreateIntent({ kind: payload?.type?.id, placement: payload?.placement });
  if (!result.ok) return;
  if (!api || !['browser','identity-browser'].includes(result.intent.kind)) { emit('create', result.intent); return; }
  const generation = ++choiceGeneration;
  pendingIntent.value = result.intent; roleChoice.value = 'agent'; roleError.value = '';
  if (typeof roleEdited !== 'undefined') roleEdited.value = false;
  profileChoices.value = []; profileChoice.value = '';
  choosingRole.value = true;
  try {
    const choices = await api.choices();
    if (!props.visible || generation !== choiceGeneration) { choosingRole.value = false; return; }
    profileChoices.value = choices;
    if (!Array.isArray(profileChoices.value)) throw Error('IDENTITY_LIST_UNAVAILABLE');
    profileChoice.value = matchingProfiles.value.find(p => p.available)?.profileId ?? '';
    roleChoice.value = profileChoices.value.find(p=>p.profileId === profileChoice.value)?.role || 'agent';
  } catch {if(!props.visible || generation !== choiceGeneration){choosingRole.value=false;return;}profileChoices.value = []; roleError.value = 'IDENTITY_LIST_UNAVAILABLE'; }
  if (typeof roleEdited !== 'undefined' && roleEdited.value) roleChoice.value = editedRoleChoice.value;
}

function onClose() {
  if (choosingRole.value || (typeof choosingProgram !== 'undefined' && choosingProgram.value) || (typeof choosingWindow !== 'undefined' && choosingWindow.value)) return;
  choiceGeneration++;
  emit('close');
}
</script>
<template>
  <div v-if="choosingRole" class="mv-role-dialog" role="dialog" aria-modal="true" aria-label="Capsule role and identity">
    <h2>Capsule role and identity</h2>
    <label>Role <select v-model="roleChoice" autofocus @change="roleEdited = true; editedRoleChoice = roleChoice"><option value="agent">Agent</option><option value="human">Human</option></select></label>
    <label>Identity <select v-model="profileChoice"><option value="" disabled>Choose an available identity</option><option v-for="profile in matchingProfiles" :key="profile.profileId" :value="profile.profileId" :disabled="!profile.available">{{ profile.profileId }}{{ profile.available ? (profile.currentMode && profile.currentMode !== 'closed' ? ' — ' + profile.currentMode : '') : ' — unavailable' }}</option></select></label>
    <p v-if="roleError" role="alert">{{ roleError === 'IDENTITY_LIST_UNAVAILABLE' ? 'IDENTITY_LIST_UNAVAILABLE: Open Identities to check the identity list, then try Add capsule again.' : roleError }}</p>
    <button type="button" @click="confirmRole">Open capsule</button>
    <button type="button" @click="choosingRole = false; emit('update:visible', false)">Cancel</button>
  </div>
  <div
    v-else-if="choosingProgram"
    id="shell/new-capsule/program-dialog"
    data-semantic-anchor="dialog/new-capsule/program-dialog"
    class="mv-role-dialog"
    role="dialog"
    aria-modal="true"
    aria-label="Program capsule"
  >
    <h2>{{ pendingIntent?.kind === 'host-program' ? 'Host program' : 'Program' }}</h2>
    <p v-if="pendingIntent?.kind === 'host-program'">Runs on your computer — not isolated. Browsers use a fresh temporary profile in RAM, never your personal profile.</p>
    <label for="shell/new-capsule/program-role">Role</label>
    <select
      id="shell/new-capsule/program-role"
      data-semantic-anchor="dialog/new-capsule/program-role"
      v-model="programRole"
    >
      <option value="human">Human</option>
      <option value="agent">Agent</option>
    </select>
    <label for="shell/new-capsule/program-binary">Binary name</label>
    <input
      id="shell/new-capsule/program-binary"
      data-semantic-anchor="dialog/new-capsule/program-binary"
      v-model="programBinary"
      type="text"
      placeholder="gedit"
      required
      autofocus
    />
    <p
      v-if="programError"
      id="shell/new-capsule/program-error"
      data-semantic-anchor="dialog/new-capsule/program-error"
      role="alert"
    >{{ programError }}</p>
    <button
      id="shell/new-capsule/program-start"
      data-semantic-anchor="dialog/new-capsule/program-start"
      type="button"
      :disabled="programBusy || !programBinary.trim()"
      @click="confirmProgram"
    >Start</button>
    <button
      id="shell/new-capsule/program-cancel"
      data-semantic-anchor="dialog/new-capsule/program-cancel"
      type="button"
      :disabled="programBusy"
      @click="cancelProgram"
    >Cancel</button>
  </div>
  <div
    v-else-if="choosingWindow"
    id="shell/new-capsule/window-dialog"
    data-semantic-anchor="dialog/new-capsule/window-dialog"
    class="mv-role-dialog"
    role="dialog"
    aria-modal="true"
    aria-label="Desktop window capsule"
  >
    <h2>Desktop window</h2>
    <label for="shell/new-capsule/window-search">Search open windows</label>
    <input
      id="shell/new-capsule/window-search"
      data-semantic-anchor="dialog/new-capsule/window-search"
      v-model="windowSearch"
      type="search"
      placeholder="Filter by title or program"
      autofocus
    />
    <ul
      id="shell/new-capsule/window-list"
      data-semantic-anchor="dialog/new-capsule/window-list"
      class="mv-window-list"
      role="listbox"
      aria-label="Open desktop windows"
    >
      <li
        v-for="win in filteredWindows"
        :key="win.xid"
        role="presentation"
      >
      <button
        type="button"
        :id="`shell/new-capsule/window-row-${win.xid}`"
        :data-semantic-anchor="`dialog/new-capsule/window-row-${win.xid}`"
        role="option"
        :aria-selected="windowChoiceXid === win.xid"
        class="mv-window-row"
        :class="{ 'mv-window-row--selected': windowChoiceXid === win.xid }"
        @click="selectWindowRow(win.xid)"
      >
        <span class="mv-window-row__title">{{ win.title }}</span>
        <span class="mv-window-row__program">{{ win.program }}</span>
      </button>
      </li>
    </ul>
    <p
      v-if="!filteredWindows.length && !windowError"
      id="shell/new-capsule/window-empty"
      data-semantic-anchor="dialog/new-capsule/window-empty"
      class="mv-window-empty"
    >No open desktop windows match this filter.</p>
    <p
      v-if="windowError"
      id="shell/new-capsule/window-error"
      data-semantic-anchor="dialog/new-capsule/window-error"
      role="alert"
    >{{ windowError }}</p>
    <button
      id="shell/new-capsule/window-add"
      data-semantic-anchor="dialog/new-capsule/window-add"
      type="button"
      :disabled="windowBusy || !selectedWindow"
      @click="confirmWindow"
    >Add</button>
    <button
      id="shell/new-capsule/window-cancel"
      data-semantic-anchor="dialog/new-capsule/window-cancel"
      type="button"
      :disabled="windowBusy"
      @click="cancelWindow"
    >Cancel</button>
  </div>
  <NewCapsuleDialog v-else
    :visible="visible"
    :types="dialogTypes"
    :title="title"
    :subtitle="subtitle"
    :empty-text="emptyText"
    @update:visible="forwardVisible"
    @create="onCreate"
    @close="onClose"
  >
    <template v-if="catalogErrors.length" #empty>
      <ul class="mv-catalog-errors" aria-label="Unavailable capsule kinds">
        <li
          v-for="row in catalogErrors"
          :key="row.key"
          :id="`catalog-launcher/error-${row.key}`"
          :data-semantic-anchor="`dialog/new-capsule/error-${row.key}`"
          :data-error-code="row.code"
          class="mv-catalog-errors__row"
        >
          <span class="mv-catalog-errors__code mv-catalog-errors__text">{{ row.code === 'ERR_CATALOG_UNKNOWN_KIND' ? 'This capsule kind is unavailable.' : 'This catalog entry is unavailable.' }}</span>
        </li>
      </ul>
    </template>
  </NewCapsuleDialog>
</template>
<style src="./catalog.css" scoped></style>

<style scoped>
.mv-role-dialog { position:fixed; z-index:100; inset:25% 25% auto; padding:1.5rem; background:Canvas; color:CanvasText; border:1px solid currentColor; border-radius:0.5rem; display:grid; gap:1rem; }
.mv-window-list { list-style:none; margin:0; padding:0; display:grid; gap:0.5rem; max-height:40vh; overflow:auto; }
.mv-window-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; width:100%; padding:0.75rem; border:2px solid transparent; border-radius:0.35rem; background:Canvas; color:CanvasText; font:inherit; text-align:left; cursor:pointer; }
.mv-window-row:not(.mv-window-row--selected):hover { background:color-mix(in srgb, CanvasText 8%, Canvas); }
.mv-window-row--selected { border-color:Highlight; background:Highlight; color:HighlightText; }
.mv-window-row:focus-visible { outline:2px solid Highlight; outline-offset:2px; }
.mv-window-row__title { font-weight:600; overflow-wrap:anywhere; }
.mv-window-row__program { font-size:0.9em; overflow-wrap:anywhere; }
</style>
