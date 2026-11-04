<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import VendorDialog from 'openvue/dialog';
import { createCspDialog } from '../../.kit/capsule-ui-kit/src/workspace/cspDialog.js';
const Dialog = createCspDialog(VendorDialog);
import SearchIcon from '@openvue/icons/search';
import CheckIcon from '@openvue/icons/check';
import PlusIcon from '@openvue/icons/plus';
import TimesIcon from '@openvue/icons/times';
import UiButton from '../../.kit/capsule-ui-kit/src/ui/UiButton.vue';
import UiTextInput from '../../.kit/capsule-ui-kit/src/ui/UiTextInput.vue';
import UiTag from '../../.kit/capsule-ui-kit/src/ui/UiTag.vue';
import SidebarIcon from '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue';
import {
  NEWCAPSULE_GRID_COLUMNS,
  NEWCAPSULE_PLACEMENTS,
  capsuleCategories,
  filterCapsuleTypes,
  filterCapsuleTypesByCategory,
  moveCapsuleCardIndex,
  normalizeCapsuleCatalog,
} from '../../.kit/capsule-ui-kit/src/shell/NewCapsuleModel.js';

/**
 * Host adaptation of the pinned kit New Capsule dialog, with grouped app sections.
 * Keyboard model, stable IDs, placement and close semantics stay shared.
 * Generic New Capsule launcher dialog. No application names: the host
 * supplies capsule types through the `types` catalog prop and opens the
 * chosen type through its own workspace API on `create`.
 * Cards, categories and placement modes are native buttons so stable ids,
 * pressed state and roving focus reach the DOM; footer actions reuse the
 * kit button wrapper like the command palette.
 * @module shell/NewCapsuleDialog
 */

/**
 * @typedef {import('../../.kit/capsule-ui-kit/src/shell/NewCapsuleModel.js').NewCapsuleType} NewCapsuleType
 * @typedef {import('../../.kit/capsule-ui-kit/src/shell/NewCapsuleModel.js').NewCapsulePlacement} NewCapsulePlacement
 */

const props = defineProps({
  visible: { type: Boolean, default: false },
  types: { type: Array, default: () => [] },
  title: { type: String, default: 'New Capsule' },
  subtitle: { type: String, default: 'Select a capsule type to open in the workspace' },
  categoriesLabel: { type: String, default: 'Categories' },
  allLabel: { type: String, default: 'All capsules' },
  searchLabel: { type: String, default: 'Search capsule types' },
  placeholder: { type: String, default: 'Search capsule types…' },
  emptyText: { type: String, default: 'No capsule types match this search.' },
  placementLabel: { type: String, default: 'Placement' },
  cancelLabel: { type: String, default: 'Cancel' },
  createLabel: { type: String, default: 'Create Capsule' },
});
const emit = defineEmits(['update:visible', 'create', 'close']);

const query = ref('');
const categoryId = ref(/** @type {string|null} */ (null));
const selectedId = ref(/** @type {string|null} */ (null));
const placement = ref(/** @type {NewCapsulePlacement} */ ('tab'));

/** @type {import('vue').ComputedRef<NewCapsuleType[]>} */
const catalog = computed(() => normalizeCapsuleCatalog(props.types));
const categories = computed(() => capsuleCategories(catalog.value));
/** @type {import('vue').ComputedRef<NewCapsuleType[]>} */
const filtered = computed(() => filterCapsuleTypes(
  filterCapsuleTypesByCategory(catalog.value, categoryId.value),
  query.value,
));
const isApp = (/** @type {NewCapsuleType} */ type) => /^(app|recent)-/.test(type.id);
const groups = computed(() => [
  {id:'kinds',label:'Capsule kinds',apps:false,types:filtered.value.filter(type=>!isApp(type))},
  {id:'recent',label:'Recent',apps:true,types:filtered.value.filter(type=>type.id.startsWith('recent-'))},
  {id:'apps',label:'Installed apps',apps:true,types:filtered.value.filter(type=>type.id.startsWith('app-'))},
].filter(group=>group.types.length));
/** @type {import('vue').ComputedRef<NewCapsuleType|null>} */
const selected = computed(() => filtered.value.find((type) => type.id === selectedId.value) ?? null);

const MODE_LABELS = Object.freeze({ tab: 'Tab', split: 'Split', floating: 'Floating' });
/** @param {string} mode */
function modeLabel(mode) {
  return /** @type {Record<string, string>} */ (MODE_LABELS)[mode] ?? mode;
}
/** @param {NewCapsuleType} type */
function selectName(type) {
  return type.id.startsWith('recent-') ? `Select ${type.label} from Recent` : `Select ${type.label}`;
}
/** @param {string} id */
function categoryAnchor(id) {
  return `dialog/new-capsule/category-${id}`;
}
/** @param {string} id */
function typeAnchor(id) {
  return `dialog/new-capsule/type-${id}`;
}
/** Legacy lane anchors, kept one release in `data-anchor-alias` (pl3 R9). @param {string} id */
function categoryAnchorAlias(id) {
  return `shell/navigation/new-capsule-category-${id}`;
}
/** Legacy lane anchors, kept one release in `data-anchor-alias` (pl3 R9). @param {string} id */
function typeAnchorAlias(id) {
  return `shell/navigation/new-capsule-type-${id}`;
}

function reset() {
  query.value = '';
  categoryId.value = null;
  const first = catalog.value[0] ?? null;
  selectedId.value = first?.id ?? null;
  placement.value = first?.opensAs ?? 'tab';
}
async function focusSearch() {
  await nextTick();
  document.getElementById('shell/new-capsule/search')?.focus();
}
/** @param {string} id */
function focusCard(id) {
  document.getElementById(`shell/new-capsule/card-${id}`)?.focus();
}
async function showDialog() {
  emit('update:visible', true);
  await focusSearch();
}
function closeDialog() {
  reset();
  emit('update:visible', false);
  emit('close');
}
/** @param {boolean} open */
function onVisible(open) {
  if (!open) closeDialog();
}
/** @param {string} id */
function selectType(id) {
  selectedId.value = id;
}
function createSelected() {
  const type = selected.value;
  if (!type) return;
  emit('create', { type, placement: placement.value });
  closeDialog();
}
/** @param {KeyboardEvent} event */
function onSearchKey(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const first = filtered.value[0] ?? null;
    if (first) {
      selectedId.value = first.id;
      focusCard(first.id);
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    createSelected();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog();
  }
}
/** @param {KeyboardEvent} event */
function onGridKey(event) {
  const key = event.key;
  if (key === 'Enter') {
    event.preventDefault();
    createSelected();
    return;
  }
  if (key === 'Escape') {
    event.preventDefault();
    closeDialog();
    return;
  }
  if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return;
  event.preventDefault();
  const at = filtered.value.findIndex((type) => type.id === selectedId.value);
  const next = moveCapsuleCardIndex(filtered.value.length, at, key, NEWCAPSULE_GRID_COLUMNS);
  const target = next >= 0 ? filtered.value[next] : undefined;
  if (target) {
    selectedId.value = target.id;
    focusCard(target.id);
  }
}
watch(filtered, (list) => {
  if (!list.some((type) => type.id === selectedId.value)) {
    const first = list[0] ?? null;
    selectedId.value = first?.id ?? null;
  }
});
watch(selected, (type) => {
  placement.value = type?.opensAs ?? 'tab';
});
watch(() => props.visible, (open) => {
  if (open) {
    reset();
    void focusSearch();
  }
});
defineExpose({ openDialog: showDialog, closeDialog });
</script>
<template>
  <Dialog
    id="shell/new-capsule/dialog" data-semantic-anchor="dialog/new-capsule/dialog"
    :visible="visible"
    modal
    :show-header="false"
    :draggable="false"
    :dismissable-mask="true"
    :close-on-escape="true"
    :aria-label="title"
    class="s8n-dialog mv-grouped-launcher"
    @update:visible="onVisible"
    @show="focusSearch"
  >
    <div class="s8n-head">
      <span class="s8n-tile" aria-hidden="true"><PlusIcon /></span>
      <span class="s8n-titles">
        <span class="s8n-title">{{ title }}</span>
        <span class="s8n-subtitle">{{ subtitle }}</span>
      </span>
      <UiButton
        id="shell/new-capsule/close"
        data-semantic-anchor="dialog/new-capsule/close"
        data-anchor-alias="shell/navigation/new-capsule-close"
        label="Close (Esc)"
        aria-label="Close (Esc)"
        class="s8n-esc"
        @click="closeDialog"
      >
        <span aria-hidden="true">Esc</span>
        <TimesIcon aria-hidden="true" />
      </UiButton>
    </div>
    <div class="s8n-search">
      <SearchIcon aria-hidden="true" />
      <UiTextInput
        id="shell/new-capsule/search"
        data-semantic-anchor="dialog/new-capsule/search"
        data-anchor-alias="shell/navigation/new-capsule-search"
        v-model="query"
        :label="searchLabel"
        :placeholder="placeholder"
        aria-controls="shell/new-capsule/grid"
        aria-autocomplete="list"
        @keydown="onSearchKey"
      />
    </div>
    <div class="s8n-body">
      <div id="shell/new-capsule/rail" data-semantic-anchor="dialog/new-capsule/rail" role="group" :aria-label="categoriesLabel" class="s8n-rail">
        <p class="s8n-rail-label" aria-hidden="true">{{ categoriesLabel }}</p>
        <button
          id="shell/new-capsule/category-all"
          type="button"
          data-semantic-anchor="dialog/new-capsule/category-all"
          data-anchor-alias="shell/navigation/new-capsule-category-all"
          :aria-label="`${allLabel}, ${catalog.length} types`"
          :aria-pressed="categoryId === null"
          class="s8n-cat"
          @click="categoryId = null"
        >
          <span class="s8n-cat-label">{{ allLabel }}</span>
          <span class="s8n-count" aria-hidden="true">{{ catalog.length }}</span>
        </button>
        <button
          v-for="category in categories"
          :key="category.id"
          :id="`shell/new-capsule/category-${category.id}`"
          type="button"
          :data-semantic-anchor="categoryAnchor(category.id)"
          :data-anchor-alias="categoryAnchorAlias(category.id)"
          :aria-label="`${category.label}, ${category.count} types`"
          :aria-pressed="categoryId === category.id"
          class="s8n-cat"
          @click="categoryId = category.id"
        >
          <span class="s8n-cat-label">{{ category.label }}</span>
          <span class="s8n-count" aria-hidden="true">{{ category.count }}</span>
        </button>
      </div>
      <div class="s8n-main">
        <div id="shell/new-capsule/grid" data-semantic-anchor="dialog/new-capsule/grid" role="group" :aria-label="searchLabel" class="mv-launcher-groups" @keydown="onGridKey">
          <section v-for="group in groups" :key="group.id" role="group" :aria-label="group.label" :data-semantic-anchor="`dialog/new-capsule/group-${group.id}`">
            <div class="mv-launcher-group-heading"><h3>{{ group.label }}</h3><span v-if="group.apps" :id="`shell/new-capsule/group-${group.id}-warning`" :data-semantic-anchor="`dialog/new-capsule/group-${group.id}-warning`" role="note">Host programs — Not isolated</span></div>
            <div class="s8n-grid">
          <button
            v-for="type in group.types"
            :key="type.id"
            :id="`shell/new-capsule/card-${type.id}`"
            type="button"
            :data-semantic-anchor="typeAnchor(type.id)"
            :data-anchor-alias="typeAnchorAlias(type.id)"
            :aria-label="selectName(type)"
            :aria-describedby="group.apps ? `shell/new-capsule/group-${group.id}-warning` : undefined"
            :aria-pressed="selectedId === type.id"
            class="s8n-card"
            @click="selectType(type.id)"
          >
            <span class="s8n-card-icon" aria-hidden="true">
              <slot name="type-icon" :type="type">
                <SidebarIcon :name="type.icon ?? 'marker'" />
              </slot>
            </span>
            <span class="s8n-card-text">
              <span class="s8n-card-title">{{ type.label }}</span>
              <span class="s8n-card-id">{{ type.id }}</span>
            </span>
            <span v-if="selectedId === type.id" class="s8n-card-check" aria-hidden="true"><CheckIcon /></span>
            <span v-else class="s8n-card-check" aria-hidden="true" />
            <span v-if="!group.apps" class="s8n-card-desc">{{ type.description }}</span>
            <span v-if="!group.apps" class="s8n-card-foot">
              <UiTag :label="`Opens as: ${type.opensAs}`" status="info" />
              <span class="s8n-card-footprint">{{ type.footprint }}</span>
            </span>
          </button>
            </div>
          </section>
        </div>
        <slot name="empty">
          <p v-if="!filtered.length" id="shell/new-capsule/empty" role="status" class="s8n-empty">{{ emptyText }}</p>
        </slot>
        <section v-if="selected" id="shell/new-capsule/detail" data-semantic-anchor="dialog/new-capsule/detail" :aria-label="`Selected capsule: ${selected.label}`" class="s8n-detail">
          <div class="s8n-detail-top">
            <span class="s8n-card-icon" aria-hidden="true"><SidebarIcon :name="selected.icon ?? 'marker'" /></span>
            <span class="s8n-detail-text">
              <span class="s8n-card-title">{{ selected.label }}</span>
              <span v-if="!isApp(selected)" class="s8n-detail-meta">{{ selected.footprint }} · Default opens as {{ selected.opensAs }}</span>
              <span v-else class="s8n-detail-meta">Host program</span>
            </span>
            <span role="group" :aria-label="placementLabel" class="s8n-modes">
              <button
                v-for="mode in NEWCAPSULE_PLACEMENTS"
                :key="mode"
                :id="`shell/new-capsule/mode-${mode}`"
                type="button"
                :data-semantic-anchor="`dialog/new-capsule/mode-${mode}`"
                :data-anchor-alias="`shell/navigation/new-capsule-mode-${mode}`"
                :aria-label="`Open as ${modeLabel(mode)}`"
                :aria-pressed="placement === mode"
                class="s8n-mode"
                @click="placement = mode"
              >
                {{ modeLabel(mode) }}
              </button>
            </span>
          </div>
          <p v-if="!isApp(selected)" class="s8n-detail-desc">{{ selected.description }}</p>
        </section>
      </div>
    </div>
    <div class="s8n-foot">
      <div class="s8n-hints">
        <span><kbd class="s8n-kbd" aria-hidden="true">↑↓←→</kbd> Navigate</span>
        <span><kbd class="s8n-kbd" aria-hidden="true">↵</kbd> Create</span>
        <span><kbd class="s8n-kbd" aria-hidden="true">esc</kbd> Cancel</span>
      </div>
      <div class="s8n-actions">
        <UiButton
          id="shell/new-capsule/cancel"
          data-semantic-anchor="dialog/new-capsule/cancel"
          data-anchor-alias="shell/navigation/new-capsule-cancel"
          :label="cancelLabel"
          :aria-label="cancelLabel"
          class="s8n-cancel"
          @click="closeDialog"
        />
        <UiButton
          id="shell/new-capsule/create"
          data-semantic-anchor="dialog/new-capsule/create"
          data-anchor-alias="shell/navigation/new-capsule-create"
          :label="createLabel"
          :aria-label="createLabel"
          intent="primary"
          class="s8n-create"
          @click="createSelected"
        >
          <PlusIcon aria-hidden="true" />
          <span>{{ createLabel }}</span>
          <kbd class="s8n-kbd" aria-hidden="true">↵</kbd>
        </UiButton>
      </div>
    </div>
  </Dialog>
</template>
<style>
.mv-launcher-groups { display:grid; gap:var(--cuk-semantic-spacing-lg); }
.mv-launcher-group-heading { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:var(--cuk-semantic-spacing-sm); margin-bottom:var(--cuk-semantic-spacing-sm); }
.mv-launcher-group-heading h3 { margin:0; font-size:var(--cuk-semantic-typography-roles-body-sm-font-size); color:var(--cuk-semantic-text-primary); }
.mv-launcher-group-heading [role="note"] { font-size:var(--cuk-semantic-typography-font-size-xs); color:var(--cuk-semantic-text-muted); }

.s8n-dialog{
  width: 94vw; max-width: calc(var(--cuk-component-app-shell-palette-width) * 1.5);
  background: var(--cuk-semantic-surface-panel);
  border: var(--cuk-semantic-border-width) solid var(--cuk-component-dialog-host-border-color);
  border-radius: var(--cuk-component-dialog-host-border-radius);
  box-shadow: var(--cuk-semantic-elevation-s1-floating);
}
/* Viewport-capped panel (pl1-029..032, pl1-038/039): the panel never
   exceeds the viewport; scrolling happens in the rail/grid regions below
   while head, search and footer stay pinned. Doubled specificity beats the
   vendor .p-dialog rule regardless of style order. */
.p-dialog.s8n-dialog{
  max-height: 92vh;
  max-height: 92dvh;
  overflow: hidden;
}
.s8n-dialog .p-dialog-content{
  display: flex; flex-direction: column;
  flex: 1 1 auto; min-height: 0;
  overflow: hidden;
}
/* NEW-1: paint the vendor content region with the kit dialog surface.
   The vendor preset keeps its light scheme while the kit runs dark, so
   without this the dark dialog shows light text on a white panel.
   Triple specificity beats the vendor content rule regardless of order. */
.p-dialog.s8n-dialog .p-dialog-content{
  background: var(--cuk-semantic-surface-panel);
}
.s8n-head,.s8n-search,.s8n-foot{flex: none;}
.s8n-dialog button{font-family: var(--cuk-semantic-typography-font-family-sans);}
.s8n-head{
  display: flex; align-items: center;
  gap: var(--cuk-semantic-spacing-md);
  padding: var(--cuk-semantic-spacing-md) var(--cuk-semantic-spacing-lg);
  border-bottom: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
}
.s8n-tile{
  display: inline-flex; align-items: center; justify-content: center;
  padding: var(--cuk-primitive-space-2);
  background: var(--cuk-semantic-surface-elevated);
  border: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
  border-radius: var(--cuk-semantic-radius-sm);
  color: var(--cuk-semantic-text-accent);
}
.s8n-tile svg{
  width: var(--cuk-semantic-typography-font-size-lg);
  height: var(--cuk-semantic-typography-font-size-lg);
}
.s8n-titles{display: flex; flex-direction: column; min-width: 0;}
.s8n-title{
  font-size: var(--cuk-semantic-typography-roles-headline-sm-font-size);
  font-weight: var(--cuk-semantic-typography-roles-headline-sm-font-weight);
  line-height: var(--cuk-semantic-typography-roles-headline-sm-line-height);
  color: var(--cuk-semantic-text-primary);
}
.s8n-subtitle{
  font-size: var(--cuk-semantic-typography-roles-body-sm-font-size);
  line-height: var(--cuk-semantic-typography-roles-body-sm-line-height);
  color: var(--cuk-semantic-text-muted);
}
.s8n-head .s8n-esc{margin-left: auto;}
.s8n-search{
  display: flex; align-items: center;
  gap: var(--cuk-semantic-spacing-md);
  padding: var(--cuk-semantic-spacing-md) var(--cuk-semantic-spacing-lg);
  border-bottom: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
}
.s8n-search svg{
  width: var(--cuk-semantic-typography-font-size-lg);
  height: var(--cuk-semantic-typography-font-size-lg);
  flex: none; color: var(--cuk-semantic-text-muted);
}
.s8n-search input{
  width: 100%; flex: 1; min-width: 0;
  background: transparent; border-color: transparent;
  font-size: var(--cuk-semantic-typography-roles-body-md-font-size);
  line-height: var(--cuk-semantic-typography-roles-body-md-line-height);
  color: var(--cuk-semantic-text-primary);
}
.s8n-body{display: flex; flex: 1 1 auto; min-height: 0;}
.s8n-rail{
  flex: 0 0 26%; display: flex; flex-direction: column;
  gap: var(--cuk-primitive-space-1);
  padding: var(--cuk-semantic-spacing-sm);
  border-right: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
  overflow-y: auto;
  max-height: 100%;
  min-height: 0;
  overscroll-behavior: contain;
}
.s8n-rail-label{
  margin: 0; padding: var(--cuk-primitive-space-2) var(--cuk-primitive-space-3) 0;
  font-size: var(--cuk-semantic-typography-roles-label-sm-font-size);
  font-weight: var(--cuk-semantic-typography-roles-label-sm-font-weight);
  text-transform: uppercase; color: var(--cuk-semantic-text-muted);
}
.s8n-cat{
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--cuk-semantic-spacing-md);
  width: 100%;
  padding: var(--cuk-primitive-space-3) var(--cuk-primitive-space-4);
  background: transparent;
  border: var(--cuk-semantic-border-width) solid transparent;
  border-radius: var(--cuk-semantic-radius-sm);
  color: var(--cuk-semantic-text-muted);
  font-size: var(--cuk-semantic-typography-roles-label-md-font-size);
  text-align: left; cursor: pointer;
}
.s8n-cat:hover{background: var(--cuk-semantic-surface-interactive-hover); color: var(--cuk-semantic-text-primary);}
.s8n-cat[aria-pressed="true"]{
  background: var(--cuk-semantic-surface-interactive);
  color: var(--cuk-semantic-text-primary);
  font-weight: var(--cuk-semantic-typography-font-weight-medium);
  box-shadow: inset calc(var(--cuk-semantic-border-width) * 2) 0 0 var(--cuk-semantic-accent-primary);
}
/* NEW-1: the selected-row count sits on the selection fill, so it keeps
   the selection pair instead of the rail muted tone (PL5 contrast). */
.s8n-cat[aria-pressed="true"] .s8n-count{
  color: var(--cuk-semantic-text-primary);
}
.s8n-count{
  font-family: var(--cuk-semantic-typography-font-family-mono);
  font-size: var(--cuk-semantic-typography-roles-code-sm-font-size);
  color: var(--cuk-semantic-text-muted);
}
.s8n-main{
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  gap: var(--cuk-semantic-spacing-md);
  padding: var(--cuk-semantic-spacing-md);
  background: var(--cuk-semantic-surface-canvas);
  overflow-y: auto;
  max-height: 100%;
  min-height: 0;
  overscroll-behavior: contain;
}
.s8n-grid{
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--cuk-semantic-spacing-sm);
}
.s8n-card{
  display: grid; align-items: start;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas: "icon text check" "desc desc desc" "foot foot foot";
  gap: var(--cuk-primitive-space-2) var(--cuk-primitive-space-3);
  padding: var(--cuk-semantic-spacing-md);
  background: var(--cuk-semantic-surface-panel);
  border: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
  border-radius: var(--cuk-semantic-radius-sm);
  color: var(--cuk-semantic-text-primary);
  text-align: left; cursor: pointer;
}
.s8n-card:hover{background: var(--cuk-semantic-surface-interactive-hover);}
.s8n-card[aria-pressed="true"]{
  background: var(--cuk-semantic-surface-interactive);
  box-shadow: inset calc(var(--cuk-semantic-border-width) * 2) 0 0 var(--cuk-semantic-accent-primary);
}
.s8n-card-icon{
  grid-area: icon;
  display: inline-flex; align-items: center; justify-content: center;
  padding: var(--cuk-primitive-space-2);
  background: var(--cuk-semantic-surface-elevated);
  border: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
  border-radius: var(--cuk-semantic-radius-xs);
  color: var(--cuk-semantic-text-accent);
}
.s8n-card-text{grid-area: text; display: flex; flex-direction: column; min-width: 0;}
.s8n-card-title{
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--cuk-semantic-typography-roles-label-md-font-size);
  font-weight: var(--cuk-semantic-typography-font-weight-medium);
  color: var(--cuk-semantic-text-primary);
}
.s8n-card-id{
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--cuk-semantic-typography-font-family-mono);
  font-size: var(--cuk-semantic-typography-roles-code-sm-font-size);
  color: var(--cuk-semantic-text-muted);
}
.s8n-card-check{
  grid-area: check;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: var(--cuk-semantic-typography-font-size-lg);
  min-height: var(--cuk-semantic-typography-font-size-lg);
  color: var(--cuk-semantic-text-accent);
}
.s8n-card-check svg{
  width: var(--cuk-semantic-typography-font-size-s1_14);
  height: var(--cuk-semantic-typography-font-size-s1_14);
}
.s8n-card-desc{
  grid-area: desc;
  font-size: var(--cuk-semantic-typography-roles-body-sm-font-size);
  line-height: var(--cuk-semantic-typography-roles-body-sm-line-height);
  color: var(--cuk-semantic-text-muted);
}
.s8n-card-foot{
  grid-area: foot;
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--cuk-semantic-spacing-sm);
  border-top: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
  padding-top: var(--cuk-primitive-space-2);
}
.s8n-card-footprint{
  font-family: var(--cuk-semantic-typography-font-family-mono);
  font-size: var(--cuk-semantic-typography-roles-code-sm-font-size);
  color: var(--cuk-semantic-text-muted);
  white-space: nowrap;
}
.s8n-empty{color: var(--cuk-semantic-text-muted); padding: 0 var(--cuk-semantic-spacing-lg);}
.s8n-detail{
  display: flex; flex-direction: column;
  gap: var(--cuk-semantic-spacing-sm);
  padding: var(--cuk-semantic-spacing-md);
  background: var(--cuk-semantic-surface-panel);
  border: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
  border-radius: var(--cuk-semantic-radius-sm);
}
.s8n-detail-top{display: flex; align-items: flex-start; gap: var(--cuk-semantic-spacing-md);}
.s8n-detail-top .s8n-card-icon{flex: none;}
.s8n-detail-text{flex: 1; min-width: 0; display: flex; flex-direction: column;}
.s8n-detail-meta{
  font-family: var(--cuk-semantic-typography-font-family-mono);
  font-size: var(--cuk-semantic-typography-roles-code-sm-font-size);
  color: var(--cuk-semantic-text-muted);
}
.s8n-detail-desc{
  margin: 0;
  font-size: var(--cuk-semantic-typography-roles-body-sm-font-size);
  color: var(--cuk-semantic-text-muted);
}
.s8n-modes{
  display: inline-flex; align-items: center; flex: none;
  gap: var(--cuk-primitive-space-1);
  padding: var(--cuk-primitive-space-1);
  background: var(--cuk-semantic-surface-elevated);
  border: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
  border-radius: var(--cuk-semantic-radius-sm);
}
.s8n-mode{
  padding: var(--cuk-primitive-space-1) var(--cuk-primitive-space-3);
  background: transparent;
  border: var(--cuk-semantic-border-width) solid transparent;
  border-radius: var(--cuk-semantic-radius-xs);
  color: var(--cuk-semantic-text-muted);
  font-size: var(--cuk-semantic-typography-roles-label-sm-font-size);
  cursor: pointer;
}
.s8n-mode:hover{color: var(--cuk-semantic-text-primary);}
.s8n-mode[aria-pressed="true"]{
  background: var(--cuk-semantic-surface-panel);
  border-color: var(--cuk-semantic-border-subtle);
  color: var(--cuk-semantic-text-primary);
  font-weight: var(--cuk-semantic-typography-font-weight-medium);
}
.s8n-foot{
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--cuk-semantic-spacing-md);
  padding: var(--cuk-semantic-spacing-sm) var(--cuk-semantic-spacing-lg);
  border-top: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
}
.s8n-hints{
  display: flex; align-items: center; flex-wrap: wrap;
  gap: var(--cuk-semantic-spacing-md);
  font-size: var(--cuk-semantic-typography-roles-label-sm-font-size);
  color: var(--cuk-semantic-text-muted);
}
.s8n-hints span{display: inline-flex; align-items: center; gap: var(--cuk-primitive-space-2);}
.s8n-kbd{
  display: inline-flex; align-items: center;
  gap: var(--cuk-primitive-space-1);
  padding: var(--cuk-primitive-space-1) var(--cuk-primitive-space-2);
  background: var(--cuk-semantic-surface-elevated);
  border: var(--cuk-semantic-border-width) solid var(--cuk-semantic-border-subtle);
  border-radius: var(--cuk-semantic-radius-xs);
  font-family: var(--cuk-semantic-typography-font-family-mono);
  font-size: var(--cuk-semantic-typography-font-size-s1_10);
  color: var(--cuk-semantic-text-muted);
  white-space: nowrap;
}
.s8n-actions{display: flex; align-items: center; gap: var(--cuk-semantic-spacing-sm);}
.s8n-dialog :focus-visible{
  outline: var(--cuk-semantic-focus-ring-width) solid var(--cuk-semantic-focus-ring-color);
  outline-offset: var(--cuk-component-app-shell-space-hairline);
}

.cuk-csp-dialog:not([open]) { display: none !important; }
.cuk-csp-dialog { margin: auto; padding: 0; color: var(--cuk-semantic-text-primary); background: var(--cuk-semantic-surface-panel); }
</style>
