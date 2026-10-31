<!-- REC-STATE tile recording badge: red dot (wall.css ::before on the
  recording variant), live `Recording mm:ss` that ticks between host events,
  and the typed reason when a capture action was refused or failed. Drop-in
  for the badge span of wall/TileCaptureChrome.vue: same id, anchor, classes,
  role and data-variant. Class-based styling only (strict CSP). -->
<script setup>
import { computed } from 'vue';
import {
  readSurfaceEntry,
  surfaceEntryPhase,
  tileBadgeAnchor,
  tileBadgeDomId,
  tileBadgeVariant,
} from '../wall/tileCapture.js';
import { recordingBadgeCopy } from './recordingBadge.js';
import { useRecordingElapsed } from './useRecordingElapsed.js';

const props = defineProps({
  capsuleId: { type: String, required: true },
  captureState: { type: Object, default: null },
  clock: { type: Object, default: null },
});

const entry = computed(() => readSurfaceEntry(props.captureState, props.capsuleId));
const phase = computed(() => surfaceEntryPhase(entry.value));
const elapsed = useRecordingElapsed(
  () => ({ phase: phase.value, elapsedMs: entry.value?.elapsedMs }),
  () => props.clock,
);
const code = computed(() => {
  const value = entry.value?.lastCode;
  return typeof value === 'string' ? value : '';
});
const copy = computed(() => recordingBadgeCopy({ phase: phase.value, elapsedMs: elapsed.value, code: code.value }));
const variant = computed(() => tileBadgeVariant({ phase: phase.value }));
</script>
<template>
  <span
    :id="tileBadgeDomId(props.capsuleId)"
    class="mv-tile-chrome__badge"
    :data-variant="variant"
    role="status"
    :data-semantic-anchor="tileBadgeAnchor(props.capsuleId)"
    :data-error-code="copy.reason ? code : undefined"
    :title="copy.title"
  >{{ copy.text }}</span>
</template>
