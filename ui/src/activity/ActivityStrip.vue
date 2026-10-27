<script setup>
import { computed, ref } from 'vue';
import { UiButton } from 'capsule-ui-kit/ui';
import {
  MV_ACTIVITY_EMPTY_TEXT,
  MV_ACTIVITY_LIMIT,
  mvActivityListAccessibleName,
  mvActivityListAnchor,
  mvActivityListDomId,
  mvActivityRowAnchor,
  mvActivityRowDomId,
  mvActivityStripAccessibleName,
  mvActivityStripAnchor,
  mvActivityStripDomId,
  mvActivityToggleAnchor,
  mvActivityToggleDomId,
  normalizeActivityEntry,
} from './activityModel.js';
import './activity.css';

/**
 * MetaViewer authority-activity strip (MVUI3 lane V): a compact docked bar
 * listing the latest authority receipts (propose verdicts, intent
 * acknowledgements and refusals) as typed rows. Props in, nothing out; the
 * host adapters own every outcome, this strip only renders closed copies.
 * The bar is docked in the shell grid below the wall, so it never covers
 * tiles; the outcomes list scrolls internally once it passes its cap.
 */

/** @typedef {import('./activityModel.js').ActivityFeedItem} ActivityFeedItem */
const props = defineProps({
  entries: { type: /** @type {import('vue').PropType<ActivityFeedItem[]>} */ (Array), default: () => [] },
});

const stripId = mvActivityStripDomId();
const stripAnchor = mvActivityStripAnchor();
const stripName = mvActivityStripAccessibleName();
const toggleId = mvActivityToggleDomId();
const toggleAnchor = mvActivityToggleAnchor();
const listId = mvActivityListDomId();
const listAnchor = mvActivityListAnchor();
const emptyText = MV_ACTIVITY_EMPTY_TEXT;

const expanded = ref(true);
const rows = computed(() => {
  const feed = Array.isArray(props.entries) ? props.entries : [];
  const normalized = [];
  for (const item of feed.slice(-MV_ACTIVITY_LIMIT)) {
    const entry = normalizeActivityEntry(item);
    if (entry) normalized.push(entry);
  }
  return normalized;
});
const listName = computed(() => mvActivityListAccessibleName(rows.value.length));

function toggle() {
  expanded.value = !expanded.value;
}
</script>
<template>
  <section :id="stripId" class="mv-activity" :data-semantic-anchor="stripAnchor" :aria-label="stripName">
    <div class="mv-activity__bar">
      <UiButton :id="toggleId" :data-semantic-anchor="toggleAnchor" label="Activity" :aria-expanded="expanded" @click="toggle" />
      <span class="mv-activity__count" aria-hidden="true">{{ rows.length }}</span>
    </div>
    <ol v-if="expanded" :id="listId" class="mv-activity__list" :data-semantic-anchor="listAnchor" role="log" tabindex="0" :aria-label="listName">
      <li v-if="!rows.length" class="mv-activity__empty">{{ emptyText }}</li>
      <li v-for="entry in rows" :key="entry.seq" :id="mvActivityRowDomId(entry.seq)" class="mv-activity__row" :data-semantic-anchor="mvActivityRowAnchor(entry.seq)" :data-activity-type="entry.type" :data-activity-tone="entry.tone">{{ entry.text }}</li>
    </ol>
  </section>
</template>
