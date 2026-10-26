<script setup>
import { computed } from 'vue';
import {
  buildRecordAiIntent,
  buildRecordingExportIntent,
  buildRecordingSelectIntent,
  buildScreenshotIntent,
} from '../../.kit/capsule-ui-kit/src/recordings/recordingsIntents.js';
import {
  MV_RECORD_EMPTY_TEXT,
  formatMvCount,
  formatMvElapsed,
  formatMvTtl,
  mvDiskRefusalAccessibleName,
  mvDiskRefusalAnchor,
  mvDiskRefusalDomId,
  mvExportAccessibleName,
  mvExportAnchor,
  mvExportDomId,
  mvExportGateAnchor,
  mvExportGateDomId,
  mvManifestRowAnchor,
  mvManifestRowDomId,
  mvManifestSelectAnchor,
  mvManifestSelectDomId,
  mvPhaseAnchor,
  mvPhaseDomId,
  mvPhaseLabel,
  mvPhaseTone,
  mvRecordToggleAccessibleName,
  mvRecordToggleAnchor,
  mvRecordToggleDomId,
  mvRecordToggleLabel,
  mvRecordingPanelAccessibleName,
  mvRecordingPanelAnchor,
  mvRecordingPanelDomId,
  mvRowErrorText,
  mvScreenshotAccessibleName,
  mvScreenshotAnchor,
  mvScreenshotButtonLabel,
  mvScreenshotDomId,
  mvScreenshotStateBusy,
  mvSelectAccessibleName,
  mvRecordPhaseBusy,
  mvStoreChipAnchor,
  mvStoreChipDomId,
  mvStoreLabel,
  normalizeMvRecordPhase,
  normalizeMvScreenshotState,
  panelDiskRefusalFor,
  recordToDiskGate,
  rowExportGateFor,
} from './recordingModel.js';

/**
 * MetaViewer recording panel (AC-07): RAM record-for-AI toggle,
 * screenshot control and recordings manifest with sealed /
 * destination-gated export, emitting kit `submit-intent` payloads.
 * Rendering is MetaViewer-owned; the kit intent vocabulary, anchor
 * families and phase semantics are reused. Props in, `submit-intent`
 * out; the host owns every sink.
 */

const props = defineProps({
  capsuleId: { type: String, required: true },
  capsuleLabel: { type: String, default: '' },
  phase: { type: String, default: 'idle' },
  elapsedSeconds: { type: Number, default: null },
  store: { type: String, default: 'ram' },
  screenshotState: { type: String, default: 'idle' },
  recordings: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  exportDestination: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  unavailableReason: { type: String, default: '' },
});

const emit = defineEmits(['submit-intent']);

const panelId = computed(() => mvRecordingPanelDomId(props.capsuleId));
const panelAnchor = computed(() => mvRecordingPanelAnchor(props.capsuleId));
const panelName = computed(() =>
  mvRecordingPanelAccessibleName({ capsuleLabel: props.capsuleLabel, capsuleId: props.capsuleId }),
);
const barName = computed(() => {
  return `Record controls for ${panelName.value.slice('Recordings for '.length)}`;
});

const phaseN = computed(() => normalizeMvRecordPhase(props.phase));
const shotN = computed(() => normalizeMvScreenshotState(props.screenshotState));
const toggleBusy = computed(() => mvRecordPhaseBusy(props.phase));
const shotBusy = computed(() => mvScreenshotStateBusy(props.screenshotState));
const toggleDisabled = computed(() => props.disabled || toggleBusy.value);
const shotDisabled = computed(() => props.disabled || shotBusy.value);
const toggleLabel = computed(() => mvRecordToggleLabel(props.phase));
const shotLabel = computed(() => mvScreenshotButtonLabel(props.screenshotState));
const toggleName = computed(() =>
  mvRecordToggleAccessibleName({
    capsuleLabel: props.capsuleLabel,
    capsuleId: props.capsuleId,
    phase: props.phase,
  }),
);
const shotName = computed(() =>
  mvScreenshotAccessibleName({
    capsuleLabel: props.capsuleLabel,
    capsuleId: props.capsuleId,
    state: props.screenshotState,
  }),
);
const toggleReason = computed(() => {
  if (props.unavailableReason) return 'Recording is unavailable';
  if (toggleBusy.value) return `Recording is ${phaseN.value}`;
  return '';
});
const shotReason = computed(() => {
  if (props.unavailableReason) return 'Recording is unavailable';
  if (shotBusy.value) return 'Screenshot capture is pending';
  return '';
});
const elapsedLabel = computed(() => formatMvElapsed(props.elapsedSeconds));
const storeText = computed(() => mvStoreLabel(props.store));

const hasRows = computed(() => Array.isArray(props.recordings) && props.recordings.length > 0);
const rowCount = computed(() => (Array.isArray(props.recordings) ? props.recordings.length : 0));

const displayRows = computed(() => {
  if (!Array.isArray(props.recordings)) return [];
  const counts = new Map();
  for (const row of props.recordings) {
    const id = row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? row.id.trim() : '';
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const used = new Set(counts.keys());
  return props.recordings.map((row, index) => {
    const source = /** @type {Record<string, any>} */ (row !== null && typeof row === 'object' ? row : {});
    const sourceId = typeof source.id === 'string' ? source.id.trim() : '';
    const validId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sourceId) && counts.get(sourceId) === 1 && sourceId === source.id;
    let id = sourceId;
    if (!validId) {
      id = `unknown-${index}`;
      // At most the number of reserved IDs can collide with a fallback.
      for (let suffix = 0; used.has(id) && suffix <= props.recordings.length; suffix++) {
        id = `unknown-${index}-${suffix}`;
      }
      used.add(id);
    }
    const gate = rowExportGateFor({
      phase: source.phase,
      destination: props.exportDestination,
      unavailableReason: props.unavailableReason,
    });
    const held = props.disabled && !gate.disabled;
    return {
      source,
      validId,
      key: id,
      id,
      selected: validId && props.selectedId === id,
      rowDomId: mvManifestRowDomId(id),
      rowAnchor: mvManifestRowAnchor(id),
      selectDomId: mvManifestSelectDomId(id),
      selectAnchor: mvManifestSelectAnchor(id),
      selectName: mvSelectAccessibleName({ id }),
      exportDomId: mvExportDomId(id),
      exportAnchor: mvExportAnchor(id),
      exportName: mvExportAccessibleName({ id }),
      gateDomId: mvExportGateDomId(id),
      gateAnchor: mvExportGateAnchor(id),
      gate: held ? 'unavailable' : gate.gate,
      gateLabel: held ? 'Unavailable' : gate.gateLabel,
      exportDisabled: !validId || gate.disabled || props.disabled,
      exportReason: gate.reason || (props.unavailableReason ? 'Recording is unavailable' : ''),
      phaseText: mvPhaseLabel(source.phase),
      phaseTone: mvPhaseTone(source.phase),
      storeText: mvStoreLabel(source.store),
      elapsedText: formatMvElapsed(source.elapsedSeconds),
      framesText: formatMvCount(source.frames),
      droppedText: formatMvCount(source.dropped),
      duplicatedText: formatMvCount(source.duplicated),
      ttlText: formatMvTtl(source.ttlSeconds),
      errorText: mvRowErrorText(source),
      errorCode: normalizeMvRecordPhase(source.phase) === 'error' ? 'ERR_RECORDING_FAILED' : undefined,
    };
  });
});

const refusal = computed(() =>
  panelDiskRefusalFor({ destination: props.exportDestination, unavailableReason: props.unavailableReason }),
);
const refusalId = computed(() => mvDiskRefusalDomId(props.capsuleId));
const refusalAnchor = computed(() => mvDiskRefusalAnchor(props.capsuleId));
const refusalName = computed(() =>
  refusal.value === null
    ? ''
    : mvDiskRefusalAccessibleName({
        capsuleLabel: props.capsuleLabel,
        capsuleId: props.capsuleId,
        reason: refusal.value.reason,
      }),
);

function onToggleClick() {
  if (toggleDisabled.value) return;
  emit('submit-intent', buildRecordAiIntent({ capsuleId: props.capsuleId, phase: props.phase }));
}

function onScreenshotClick() {
  if (shotDisabled.value) return;
  emit('submit-intent', buildScreenshotIntent({ capsuleId: props.capsuleId }));
}

/**
 * @param {{ source: Record<string, any>, validId: boolean }} entry Display row to select.
 */
function onSelect(entry) {
  if (props.disabled || !entry.validId) return;
  const row = entry.source;
  emit(
    'submit-intent',
    buildRecordingSelectIntent({
      capsuleId: typeof row.capsuleId === 'string' ? row.capsuleId : props.capsuleId,
      recordingId: row.id,
    }),
  );
}

/**
 * @param {{ source: Record<string, any>, exportDisabled: boolean }} entry Row to export.
 */
function onExport(entry) {
  if (entry.exportDisabled) return;
  const row = entry.source;
  const gate = recordToDiskGate({ destination: props.exportDestination, phase: row.phase });
  if (!gate.allowed) return;
  emit(
    'submit-intent',
    buildRecordingExportIntent({
      capsuleId: typeof row.capsuleId === 'string' ? row.capsuleId : props.capsuleId,
      recordingId: row.id,
      phase: row.phase,
      destination: props.exportDestination,
    }),
  );
}
</script>

<template>
  <section :id="panelId" class="mv4-rec" role="region" :aria-label="panelName" :data-semantic-anchor="panelAnchor">
    <div class="mv4-bar" role="group" :aria-label="barName">
      <button
        :id="mvRecordToggleDomId(capsuleId)"
        type="button"
        :class="'mv4-btn mv4-toggle' + (phaseN === 'recording' ? ' mv4-toggle-recording' : '')"
        :data-semantic-anchor="mvRecordToggleAnchor(capsuleId)"
        :aria-label="toggleName"
        :title="toggleReason || toggleName"
        :disabled="toggleDisabled"
        :aria-busy="toggleBusy ? 'true' : undefined"
        :data-unavailable-reason="toggleReason || undefined"
        @click="onToggleClick"
      >
        <span class="mv4-toggle-dot" aria-hidden="true"></span>
        <span>{{ toggleLabel }}</span>
      </button>
      <span
        :id="mvPhaseDomId(capsuleId)"
        class="mv4-chip"
        role="status"
        :data-semantic-anchor="mvPhaseAnchor(capsuleId)"
        :title="'Phase ' + phaseN"
      >{{ phaseN }}</span>
      <span class="mv4-elapsed" :title="'Elapsed ' + elapsedLabel">{{ elapsedLabel }}</span>
      <span
        :id="mvStoreChipDomId(capsuleId)"
        class="mv4-chip"
        role="status"
        :data-semantic-anchor="mvStoreChipAnchor(capsuleId)"
        :title="'Store ' + storeText"
      >{{ storeText }}</span>
      <button
        :id="mvScreenshotDomId(capsuleId)"
        type="button"
        class="mv4-btn"
        :data-semantic-anchor="mvScreenshotAnchor(capsuleId)"
        :aria-label="shotName"
        :title="shotReason || shotName"
        :disabled="shotDisabled"
        :aria-busy="shotBusy ? 'true' : undefined"
        :data-unavailable-reason="shotReason || undefined"
        @click="onScreenshotClick"
      >
        {{ shotLabel }}
      </button>
    </div>
    <p v-if="!hasRows" class="mv4-empty" role="status">{{ MV_RECORD_EMPTY_TEXT }}</p>
    <table v-else class="mv4-table" aria-label="RAM recordings manifest">
      <thead>
        <tr>
          <th scope="col">Recording</th>
          <th scope="col">Phase</th>
          <th scope="col">Store</th>
          <th scope="col">Elapsed</th>
          <th scope="col">Frames</th>
          <th scope="col">TTL</th>
          <th scope="col">Export gate</th>
          <th scope="col"><span class="mv4-visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in displayRows"
          :key="entry.key"
          :id="entry.rowDomId"
          :class="'mv4-row' + (entry.selected ? ' mv4-row-selected' : '')"
          :data-semantic-anchor="entry.rowAnchor"
          :aria-selected="entry.selected ? 'true' : undefined"
        >
          <td>
            <button
              :id="entry.selectDomId"
              type="button"
              class="mv4-select"
              :data-semantic-anchor="entry.selectAnchor"
              :aria-label="entry.selectName"
              :title="entry.selectName"
              :disabled="disabled || !entry.validId"
              @click="onSelect(entry)"
            >
              {{ entry.id }}
            </button>
            <span v-if="entry.errorText" class="mv4-row-error" :data-error-code="entry.errorCode" :title="entry.errorText">{{ entry.errorText }}</span>
          </td>
          <td>
            <span :class="'mv4-chip mv4-tone-' + entry.phaseTone" :title="'Phase ' + entry.phaseText">{{
              entry.phaseText
            }}</span>
          </td>
          <td>
            <span class="mv4-chip" :title="'Store ' + entry.storeText">{{ entry.storeText }}</span>
          </td>
          <td class="mv4-mono">
            {{ entry.elapsedText }}
          </td>
          <td class="mv4-mono" :title="'Dropped ' + entry.droppedText + ', duplicated ' + entry.duplicatedText">
            {{ entry.framesText }}
          </td>
          <td class="mv4-mono">
            {{ entry.ttlText }}
          </td>
          <td>
            <span
              :id="entry.gateDomId"
              :class="'mv4-chip mv4-gate mv4-gate-' + entry.gate"
              role="status"
              :data-semantic-anchor="entry.gateAnchor"
              :title="entry.exportReason || entry.gateLabel"
            >{{ entry.gateLabel }}</span>
          </td>
          <td>
            <button
              :id="entry.exportDomId"
              type="button"
              class="mv4-btn mv4-export"
              :data-semantic-anchor="entry.exportAnchor"
              :aria-label="entry.exportName"
              :title="entry.exportReason || entry.exportName"
              :disabled="entry.exportDisabled"
              :data-unavailable-reason="entry.exportReason || undefined"
              @click="onExport(entry)"
            >
              Export
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p
      v-if="refusal !== null"
      :id="refusalId"
      class="mv4-refusal"
      role="status"
      :data-semantic-anchor="refusalAnchor"
      :data-refusal-code="refusal.code"
      :aria-label="refusalName"
      :title="refusal.reason"
    >
      {{ refusal.reason }}
    </p>
  </section>
</template>

<style scoped src="./recording.css"></style>
