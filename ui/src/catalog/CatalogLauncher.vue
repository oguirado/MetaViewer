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
  normalizeCatalogEntries,
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
const pendingIntent = ref(/** @type {any} */ (null));
const profileChoices = ref(/** @type {Array<{role:string,profileId:string,available:boolean,currentMode?:string}>} */ ([]));
const matchingProfiles = computed(() => profileChoices.value);
watch(profileChoice, id => { roleChoice.value = profileChoices.value.find(p => p.profileId === id)?.role || 'agent'; });
function confirmRole() {
  const profile = matchingProfiles.value.find(p => p.profileId === profileChoice.value);
  if (/** @type {any} */ (profile)?.busy) return;
  if (!profile?.available) { roleError.value = profile ? 'PROFILE_ALREADY_BOUND' : 'NO_IDENTITY'; return; }
  emit('create', {...pendingIntent.value,choice:{role:roleChoice.value,profileId:profile.profileId}});
  choosingRole.value = false;
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
  emit('update:visible', value);
}

/** @param {{ type?: { id?: unknown }, placement?: unknown } | null} payload */
async function onCreate(payload) {
  const result = buildCreateIntent({ kind: payload?.type?.id, placement: payload?.placement });
  if (!result.ok) return;
  if (!api || !['browser','identity-browser'].includes(result.intent.kind)) { emit('create', result.intent); return; }
  pendingIntent.value = result.intent; roleChoice.value = 'agent'; roleError.value = '';
  try {
    profileChoices.value = await api.choices();
    if (!Array.isArray(profileChoices.value)) throw Error('IDENTITY_LIST_UNAVAILABLE');
    profileChoice.value = matchingProfiles.value.find(p => p.available)?.profileId ?? '';
  } catch { profileChoices.value = []; roleError.value = 'IDENTITY_LIST_UNAVAILABLE'; }
  choosingRole.value = true;
}

function onClose() {
  emit('close');
}
</script>
<template>
  <div v-if="choosingRole" class="mv-role-dialog" role="dialog" aria-modal="true" aria-label="Capsule role and identity">
    <h2>Capsule role and identity</h2>
    <label>Role <select v-model="roleChoice" autofocus><option value="agent">Agent</option><option value="human">Human</option></select></label>
    <label>Identity <select v-model="profileChoice"><option value="" disabled>Choose an available identity</option><option v-for="profile in matchingProfiles" :key="profile.profileId" :value="profile.profileId" :disabled="!profile.available">{{ profile.profileId }}{{ profile.available ? (profile.currentMode && profile.currentMode !== 'closed' ? ' — ' + profile.currentMode : '') : ' — unavailable' }}</option></select></label>
    <p v-if="roleError" role="alert">{{ roleError }}</p>
    <button type="button" @click="confirmRole">Open capsule</button>
    <button type="button" @click="choosingRole = false; emit('update:visible', false)">Cancel</button>
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
</style>
