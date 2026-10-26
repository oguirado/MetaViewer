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
import { computed, watch } from 'vue';
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
function onCreate(payload) {
  const result = buildCreateIntent({ kind: payload?.type?.id, placement: payload?.placement });
  if (result.ok) emit('create', result.intent);
}

function onClose() {
  emit('close');
}
</script>
<template>
  <NewCapsuleDialog
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
