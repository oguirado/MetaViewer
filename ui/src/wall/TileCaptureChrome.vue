<!-- MVUI9 tile capture chrome: compact record-for-AI / screenshot / badge rail.
  One instance renders above the kit panel of every wall tile. Driven by the
  capture store passed down from the wall root; a missing store disables the
  controls with the shared unavailable reason instead of throwing. Hidden in
  nested display-only mode. Kit owns the record toggle (SaasRecordButton)
  and the screenshot glyph (SidebarIcon); the lane owns layout and copy. -->
<script setup>
import { computed, shallowRef } from 'vue';
import SaasRecordButton from '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue';
import SidebarIcon from '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue';
import {
  TILE_CAPTURE_UNAVAILABLE_REASON,
  isCaptureUnavailable,
  readSurfaceEntry,
  surfaceEntryPhase,
  tileBadgeAnchor,
  tileBadgeDomId,
  tileBadgeText,
  tileBadgeVariant,
  tileCapturePhaseBusy,
  tileChromeGroupName,
  tileRecordAnchor,
  tileRecordDomId,
  tileScreenshotAnchor,
  tileScreenshotDomId,
  tileShotAccessibleName,
  tileShotLabel,
} from './tileCapture.js';

/**
 * Capture store contract (MVUI9 preamble): `bySurface` entries carry
 * phase/elapsedMs/lastShot; the actions return promises of `{ok}` rows.
 * @typedef {Object} TileCaptureStateLike
 * @property {unknown} [bySurface]
 * @property {(surfaceId: string) => Promise<unknown>} [toggleRecord]
 * @property {(surfaceId: string) => Promise<unknown>} [screenshot]
 */

const props = defineProps({
  capsuleId: { type: String, required: true },
  capsuleLabel: { type: String, default: '' },
  captureState: {
    type: /** @type {import('vue').PropType<TileCaptureStateLike | null>} */ (Object),
    default: null,
  },
  displayOnly: { type: Boolean, default: false },
});

const entry = computed(() => readSurfaceEntry(props.captureState, props.capsuleId));
const phase = computed(() => surfaceEntryPhase(entry.value));
const busy = computed(() => tileCapturePhaseBusy(phase.value));
const unavailable = computed(() => isCaptureUnavailable(props.captureState));

const recordDisabled = computed(() => unavailable.value || busy.value);
const recordReason = computed(() => {
  if (unavailable.value) return TILE_CAPTURE_UNAVAILABLE_REASON;
  if (busy.value) return `Recording is ${phase.value}`;
  return '';
});

// Screenshot is momentary: the in-flight flag is lane-local, the store
// carries only the settled `lastShot`.
const shotCapturing = shallowRef(false);
const shotDisabled = computed(() => unavailable.value || shotCapturing.value);
const shotLabel = computed(() => tileShotLabel({
  capturing: shotCapturing.value,
  lastShot: entry.value?.lastShot,
}));
const shotName = computed(() => tileShotAccessibleName({
  capsuleLabel: props.capsuleLabel,
  capsuleId: props.capsuleId,
  capturing: shotCapturing.value,
  lastShot: entry.value?.lastShot,
}));
const shotReason = computed(() => {
  if (unavailable.value) return TILE_CAPTURE_UNAVAILABLE_REASON;
  if (shotCapturing.value) return 'Screenshot capture is pending';
  return '';
});

const badgeText = computed(() => tileBadgeText({
  phase: phase.value,
  elapsedMs: entry.value?.elapsedMs,
}));
const badgeVariant = computed(() => tileBadgeVariant({ phase: phase.value }));
const badgeTitle = computed(() => `Phase ${phase.value}`);
const groupName = computed(() => tileChromeGroupName({
  capsuleLabel: props.capsuleLabel,
  capsuleId: props.capsuleId,
}));

const recordWrapId = computed(() => tileRecordDomId(props.capsuleId));
const recordAnchor = computed(() => tileRecordAnchor(props.capsuleId));
const shotId = computed(() => tileScreenshotDomId(props.capsuleId));
const shotAnchor = computed(() => tileScreenshotAnchor(props.capsuleId));
const badgeId = computed(() => tileBadgeDomId(props.capsuleId));
const badgeAnchor = computed(() => tileBadgeAnchor(props.capsuleId));

// The kit toggle emits its record intent; the chrome consumes it and drives
// the capture store instead, so the intent never leaves the tile.
function onRecordIntent() {
  if (recordDisabled.value) return;
  const state = props.captureState;
  if (state === null || typeof state.toggleRecord !== 'function') return;
  state.toggleRecord(props.capsuleId);
}

function onShotClick() {
  if (shotDisabled.value) return;
  const state = props.captureState;
  if (state === null || typeof state.screenshot !== 'function') return;
  shotCapturing.value = true;
  const done = () => { shotCapturing.value = false; };
  const result = state.screenshot(props.capsuleId);
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    result.then(done, done);
  } else {
    done();
  }
}
</script>
<template>
  <div v-if="!props.displayOnly" class="mv-tile-chrome" role="group" :aria-label="groupName">
    <span :id="recordWrapId" class="mv-tile-chrome__record" :data-semantic-anchor="recordAnchor">
      <SaasRecordButton
        :capsule-id="props.capsuleId"
        :capsule-label="props.capsuleLabel"
        :phase="phase"
        :disabled="recordDisabled"
        :unavailable-reason="recordReason"
        @submit-intent="onRecordIntent"
      />
    </span>
    <button
      :id="shotId"
      type="button"
      class="mv-tile-chrome__shot"
      :data-semantic-anchor="shotAnchor"
      :aria-label="shotName"
      :title="shotReason || shotName"
      :disabled="shotDisabled"
      :aria-busy="shotCapturing ? 'true' : undefined"
      :data-unavailable-reason="shotReason || undefined"
      @click="onShotClick"
    >
      <SidebarIcon name="box" aria-hidden="true" />
      <span class="mv-tile-chrome__shot-label">{{ shotLabel }}</span>
    </button>
    <span
      :id="badgeId"
      class="mv-tile-chrome__badge"
      :data-variant="badgeVariant"
      role="status"
      :data-semantic-anchor="badgeAnchor"
      :title="badgeTitle"
    >{{ badgeText }}</span>
  </div>
</template>
