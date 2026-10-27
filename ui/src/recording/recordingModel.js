/**
 * MetaViewer recording adapter model (AC-07): RAM-first capture bindings,
 * record-to-disk gating and typed refusal rows.
 *
 * Pure JavaScript with JSDoc; zero imports. Rendering is MetaViewer-owned
 * (`MvRecordingPanel.vue`); the kit `recordingsIntents.js` vocabulary,
 * anchor families and phase semantics are reused. This module owns the
 * record-to-disk gates: disk export exists only when the host advertises
 * a destination, otherwise callers render the typed refusal rows built
 * here. The host owns every sink; nothing here touches disk, network or
 * clipboard.
 *
 * @module recording/recordingModel
 */

/**
 * Record axis phases, mirroring the kit recordings vocabulary.
 * @type {ReadonlyArray<string>}
 */
export const MV_RECORDING_PHASES = Object.freeze(['idle', 'starting', 'recording', 'stopping', 'sealed', 'error']);

/**
 * Screenshot axis states, mirroring the kit recordings vocabulary.
 * @type {ReadonlyArray<string>}
 */
export const MV_SCREENSHOT_STATES = Object.freeze(['idle', 'capturing', 'done', 'error']);

/**
 * Capture store rendered by this lane. RAM only; disk is reached solely
 * through an explicit host-advertised export destination.
 * @type {string}
 */
export const MV_RECORDING_STORE = 'ram';

/**
 * Typed refusal when no host destination is configured.
 * @type {string}
 */
export const MV_EXPORT_WITHOUT_DESTINATION = 'ERR_EXPORT_WITHOUT_DESTINATION';

/**
 * Typed refusal when the recording is not sealed.
 * @type {string}
 */
export const MV_EXPORT_UNSEALED_RECORDING = 'ERR_EXPORT_UNSEALED_RECORDING';

/**
 * Typed refusal when the panel itself reports unavailable.
 * @type {string}
 */
export const MV_RECORDING_UNAVAILABLE = 'ERR_RECORDING_UNAVAILABLE';

/**
 * Literal reason shown when export has no host destination.
 * @type {string}
 */
export const MV_EXPORT_DESTINATION_REASON = 'No export destination advertised by the host';

/**
 * Literal reason shown when export targets a recording that is not sealed.
 * @type {string}
 */
export const MV_EXPORT_UNSEALED_REASON = 'Only sealed recordings can be exported';

/**
 * @param {unknown} phase
 * @returns {string} Known record phase, falling back to `idle`.
 */
export function normalizeMvRecordPhase(phase) {
  return MV_RECORDING_PHASES.includes(/** @type {string} */ (phase))
    ? /** @type {string} */ (phase)
    : 'idle';
}

/**
 * @param {unknown} state
 * @returns {string} Known screenshot state, falling back to `idle`.
 */
export function normalizeMvScreenshotState(state) {
  return MV_SCREENSHOT_STATES.includes(/** @type {string} */ (state))
    ? /** @type {string} */ (state)
    : 'idle';
}

/**
 * A destination is usable only as a bare host token: a non-empty string
 * with no surrounding whitespace. The renderer never invents one.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isPresentDestination(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

/**
 * Panel-level record-to-disk gate. Precedence: a missing destination
 * refuses first (AC-07: record-to-disk exists only when a destination is
 * configured), then an unsealed phase. The kit per-row gate keeps its own
 * precedence; this gate answers the panel-level question.
 * @param {{ destination?: unknown, phase?: unknown }} input
 * @returns {Readonly<{ allowed: boolean, code: string, reason: string }>}
 */
export function recordToDiskGate(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  if (!isPresentDestination(source.destination)) {
    return Object.freeze({
      allowed: false,
      code: MV_EXPORT_WITHOUT_DESTINATION,
      reason: MV_EXPORT_DESTINATION_REASON,
    });
  }
  if (normalizeMvRecordPhase(source.phase) !== 'sealed') {
    return Object.freeze({
      allowed: false,
      code: MV_EXPORT_UNSEALED_RECORDING,
      reason: MV_EXPORT_UNSEALED_REASON,
    });
  }
  return Object.freeze({ allowed: true, code: '', reason: '' });
}

/**
 * Panel-level typed refusal row, or null when the panel shows no refusal.
 * An explicit panel unavailable reason wins over the destination check.
 * @param {{ destination?: unknown, unavailableReason?: unknown }} input
 * @returns {Readonly<{ code: string, reason: string }>|null}
 */
export function panelDiskRefusalFor(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  if (typeof source.unavailableReason === 'string' && source.unavailableReason.length > 0) {
    return Object.freeze({ code: MV_RECORDING_UNAVAILABLE, reason: 'Recording is unavailable' });
  }
  if (!isPresentDestination(source.destination)) {
    return Object.freeze({ code: MV_EXPORT_WITHOUT_DESTINATION, reason: MV_EXPORT_DESTINATION_REASON });
  }
  return null;
}

/**
 * Preserve canonical IDs and encode every UTF-16 unit otherwise. The reserved
 * prefix is encoded too, so an encoded value cannot collide with a host ID.
 * @param {string} value Host identifier.
 * @returns {string} Safe, deterministic DOM/anchor segment.
 */
export function mvRecordingIdSegment(value) {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !value.startsWith('encoded-')) return value;
  let encoded = 'encoded';
  for (let index = 0; index < value.length; index++) {
    encoded += `-${value.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }
  return `${encoded}-end`;
}

/**
 * @param {unknown} value Host-projected label.
 * @returns {string} A single-line display label, or empty when untrusted copy is unsafe.
 */
function mvSafeLabel(value) {
  if (typeof value !== 'string' || /[\r\n\t]|ERR_/i.test(value)) return '';
  const label = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9 -]*$/.test(label) ? label : '';
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Stable DOM id for the MetaViewer recording panel.
 */
export function mvRecordingPanelDomId(capsuleId) {
  return `mv-recording-panel-${mvRecordingIdSegment(capsuleId)}`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Stable DOM id for the record-to-disk refusal row.
 */
export function mvDiskRefusalDomId(capsuleId) {
  return `mv-recording-disk-refusal-${mvRecordingIdSegment(capsuleId)}`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Semantic anchor for the MetaViewer recording panel.
 */
export function mvRecordingPanelAnchor(capsuleId) {
  return `recording/${mvRecordingIdSegment(capsuleId)}/panel`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Semantic anchor for the record-to-disk refusal row.
 */
export function mvDiskRefusalAnchor(capsuleId) {
  return `recording/${mvRecordingIdSegment(capsuleId)}/disk-refusal`;
}

/**
 * @param {{ capsuleLabel?: unknown, capsuleId: string }} input
 * @returns {string} Human label used inside accessible names.
 */
function mvRecordingLabel(input) {
  return mvSafeLabel(input.capsuleLabel) || mvRecordingIdSegment(input.capsuleId);
}

/**
 * @param {{ capsuleLabel?: unknown, capsuleId: string }} input
 * @returns {string} Stable accessible name for the panel region (agent_lane/v1).
 */
export function mvRecordingPanelAccessibleName(input) {
  return `Recordings for ${mvRecordingLabel(input)}`;
}

/**
 * @param {{ capsuleLabel?: unknown, capsuleId: string, reason: string }} input
 * @returns {string} Stable accessible name for the refusal row (agent_lane/v1).
 */
export function mvDiskRefusalAccessibleName(input) {
  return `Record to disk unavailable on ${mvRecordingLabel(input)}: ${input.reason}`;
}

/**
 * Empty-manifest copy: designed neutral text, never a placeholder.
 * @type {string}
 */
export const MV_RECORD_EMPTY_TEXT = 'No recordings yet.';

/**
 * Formats a host-projected elapsed-seconds count as `MM:SS`.
 * Unreadable values render `--:--`, never a fabricated zero.
 * @param {unknown} value
 * @returns {string}
 */
export function formatMvElapsed(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return '--:--';
  }
  const total = Math.floor(value);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Formats a host-projected counter. Unreadable values render `Unknown`.
 * @param {unknown} value
 * @returns {string}
 */
export function formatMvCount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return 'Unknown';
  }
  return String(value);
}

/**
 * Formats a host-projected TTL in seconds. Unreadable values render
 * `Unknown`; a spent TTL renders `Expired`.
 * @param {unknown} value
 * @returns {string}
 */
export function formatMvTtl(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Unknown';
  }
  if (value <= 0) {
    return 'Expired';
  }
  return formatMvElapsed(value);
}

/**
 * @param {unknown} store
 * @returns {string} Store chip label (`RAM` or `Unknown`).
 */
export function mvStoreLabel(store) {
  return store === 'ram' ? 'RAM' : 'Unknown';
}

/**
 * @param {unknown} phase
 * @returns {string} Human phase label for manifest chips.
 */
export function mvPhaseLabel(phase) {
  const normalized = normalizeMvRecordPhase(phase);
  if (normalized === 'starting') return 'Starting';
  if (normalized === 'recording') return 'Recording';
  if (normalized === 'stopping') return 'Stopping';
  if (normalized === 'sealed') return 'Sealed';
  if (normalized === 'error') return 'Error';
  return 'Idle';
}

/**
 * @param {unknown} phase
 * @returns {string} Status tone for the phase chip.
 */
export function mvPhaseTone(phase) {
  const normalized = normalizeMvRecordPhase(phase);
  if (normalized === 'recording' || normalized === 'error') return 'error';
  if (normalized === 'starting' || normalized === 'stopping') return 'warning';
  if (normalized === 'sealed') return 'success';
  return 'neutral';
}

/**
 * @param {unknown} phase
 * @returns {string} Record toggle label for the phase.
 */
export function mvRecordToggleLabel(phase) {
  const normalized = normalizeMvRecordPhase(phase);
  if (normalized === 'recording') return 'Stop';
  if (normalized === 'starting') return 'Starting';
  if (normalized === 'stopping') return 'Stopping';
  if (normalized === 'error') return 'Retry';
  if (normalized === 'sealed') return 'Record again';
  return 'Record for AI';
}

/**
 * @param {unknown} state
 * @returns {string} Screenshot button label for the state.
 */
export function mvScreenshotButtonLabel(state) {
  const normalized = normalizeMvScreenshotState(state);
  if (normalized === 'capturing') return 'Capturing';
  if (normalized === 'done') return 'Captured';
  if (normalized === 'error') return 'Retry capture';
  return 'Screenshot';
}

/**
 * @param {unknown} phase
 * @returns {boolean} True while the host record transition is pending.
 */
export function mvRecordPhaseBusy(phase) {
  const normalized = normalizeMvRecordPhase(phase);
  return normalized === 'starting' || normalized === 'stopping';
}

/**
 * @param {unknown} state
 * @returns {boolean} True while the screenshot capture is in flight.
 */
export function mvScreenshotStateBusy(state) {
  return normalizeMvScreenshotState(state) === 'capturing';
}

/**
 * @param {{ capsuleLabel?: unknown, capsuleId: string, phase?: unknown }} input
 * @returns {string} Stable accessible name for the record toggle (agent_lane/v1).
 */
export function mvRecordToggleAccessibleName(input) {
  const label = mvRecordingLabel(input);
  const phase = normalizeMvRecordPhase(input.phase);
  if (phase === 'recording') return `Stop AI recording on ${label}`;
  if (phase === 'starting' || phase === 'stopping') return `AI recording transition pending on ${label}`;
  if (phase === 'error') return `Retry AI recording on ${label}`;
  return `Record ${label} for AI`;
}

/**
 * @param {{ capsuleLabel?: unknown, capsuleId: string, state?: unknown }} input
 * @returns {string} Stable accessible name for the screenshot control (agent_lane/v1).
 */
export function mvScreenshotAccessibleName(input) {
  const label = mvRecordingLabel(input);
  const state = normalizeMvScreenshotState(input.state);
  if (state === 'capturing') return `Screenshot capture pending on ${label}`;
  if (state === 'done') return `Screenshot captured on ${label}`;
  if (state === 'error') return `Retry screenshot on ${label}`;
  return `Screenshot ${label}`;
}

/**
 * Per-row export gate, mirroring the kit gate precedence: panel
 * unavailable reason, unsealed phase, missing destination, then ready.
 * @param {{ phase?: unknown, destination?: unknown, unavailableReason?: unknown }} input
 * @returns {Readonly<{ disabled: boolean, reason: string, gate: string, gateLabel: string }>}
 */
export function rowExportGateFor(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  if (typeof source.unavailableReason === 'string' && source.unavailableReason.length > 0) {
    return Object.freeze({
      disabled: true,
      reason: 'Recording is unavailable',
      gate: 'unavailable',
      gateLabel: 'Unavailable',
    });
  }
  if (normalizeMvRecordPhase(source.phase) !== 'sealed') {
    return Object.freeze({
      disabled: true,
      reason: MV_EXPORT_UNSEALED_REASON,
      gate: 'sealed-required',
      gateLabel: 'Sealed required',
    });
  }
  if (!isPresentDestination(source.destination)) {
    return Object.freeze({
      disabled: true,
      reason: MV_EXPORT_DESTINATION_REASON,
      gate: 'destination-required',
      gateLabel: 'Destination required',
    });
  }
  return Object.freeze({ disabled: false, reason: '', gate: 'ready', gateLabel: 'Export ready' });
}

/**
 * @param {{ error?: unknown, phase?: unknown }} row
 * @returns {string} Fixed error literal; host diagnostics are never user-facing.
 */
export function mvRowErrorText(row) {
  if (normalizeMvRecordPhase(row.phase) !== 'error') return '';
  return 'Recording failed';
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Stable DOM id for the record toggle control.
 */
export function mvRecordToggleDomId(capsuleId) {
  return `mv-recordings-toggle-${mvRecordingIdSegment(capsuleId)}`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Stable DOM id for the screenshot control.
 */
export function mvScreenshotDomId(capsuleId) {
  return `mv-recordings-screenshot-${mvRecordingIdSegment(capsuleId)}`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Stable DOM id for the phase readout.
 */
export function mvPhaseDomId(capsuleId) {
  return `mv-recordings-phase-${mvRecordingIdSegment(capsuleId)}`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Stable DOM id for the store chip.
 */
export function mvStoreChipDomId(capsuleId) {
  return `mv-recordings-store-${mvRecordingIdSegment(capsuleId)}`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Semantic anchor for the record toggle control.
 */
export function mvRecordToggleAnchor(capsuleId) {
  return `recording/${mvRecordingIdSegment(capsuleId)}/toggle`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Semantic anchor for the screenshot control.
 */
export function mvScreenshotAnchor(capsuleId) {
  return `recording/${mvRecordingIdSegment(capsuleId)}/screenshot`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Semantic anchor for the phase readout.
 */
export function mvPhaseAnchor(capsuleId) {
  return `recording/${mvRecordingIdSegment(capsuleId)}/phase`;
}

/**
 * @param {string} capsuleId Host-issued capsule id.
 * @returns {string} Semantic anchor for the store chip.
 */
export function mvStoreChipAnchor(capsuleId) {
  return `recording/${mvRecordingIdSegment(capsuleId)}/store-chip`;
}

/**
 * @param {string} recordingId Host-issued recording id.
 * @returns {string} Stable DOM id for a manifest row.
 */
export function mvManifestRowDomId(recordingId) {
  return `mv-recordings-row-${mvRecordingIdSegment(recordingId)}`;
}

/**
 * @param {string} recordingId Host-issued recording id.
 * @returns {string} Stable DOM id for a row select control.
 */
export function mvManifestSelectDomId(recordingId) {
  return `mv-recordings-select-${mvRecordingIdSegment(recordingId)}`;
}

/**
 * @param {string} recordingId Host-issued recording id.
 * @returns {string} Stable DOM id for a row export control.
 */
export function mvExportDomId(recordingId) {
  return `mv-recordings-export-${mvRecordingIdSegment(recordingId)}`;
}

/**
 * @param {string} recordingId Host-issued recording id.
 * @returns {string} Stable DOM id for a row export gate readout.
 */
export function mvExportGateDomId(recordingId) {
  return `mv-recordings-gate-${mvRecordingIdSegment(recordingId)}`;
}

/**
 * @param {string} recordingId Host-issued recording id.
 * @returns {string} Semantic anchor for a manifest row.
 */
export function mvManifestRowAnchor(recordingId) {
  return `recording/${mvRecordingIdSegment(recordingId)}/row`;
}

/**
 * @param {string} recordingId Host-issued recording id.
 * @returns {string} Semantic anchor for a row select control.
 */
export function mvManifestSelectAnchor(recordingId) {
  return `recording/${mvRecordingIdSegment(recordingId)}/select`;
}

/**
 * @param {string} recordingId Host-issued recording id.
 * @returns {string} Semantic anchor for a row export control.
 */
export function mvExportAnchor(recordingId) {
  return `recording/${mvRecordingIdSegment(recordingId)}/export`;
}

/**
 * @param {string} recordingId Host-issued recording id.
 * @returns {string} Semantic anchor for a row export gate readout.
 */
export function mvExportGateAnchor(recordingId) {
  return `recording/${mvRecordingIdSegment(recordingId)}/export-gate`;
}

/**
 * @param {{ id?: unknown, capsuleLabel?: unknown, capsuleId?: unknown }} row
 * @returns {string} Human label used inside row accessible names.
 */
function mvRowLabel(row) {
  return mvSafeLabel(row.capsuleLabel) || mvSafeLabel(row.id) || mvSafeLabel(row.capsuleId) || 'recording';
}

/**
 * @param {{ id?: unknown, capsuleLabel?: unknown, capsuleId?: unknown }} row
 * @returns {string} Stable accessible name for the row select control.
 */
export function mvSelectAccessibleName(row) {
  return `Select ${mvRowLabel(row)}`;
}

/**
 * @param {{ id?: unknown, capsuleLabel?: unknown, capsuleId?: unknown }} row
 * @returns {string} Stable accessible name for the row export control.
 */
export function mvExportAccessibleName(row) {
  return `Export ${mvRowLabel(row)} to host destination`;
}

/**
 * Capture-store entry for a surface (MVUI9 lane A). Reads only the
 * preamble store names (`bySurface`); tolerates the store exposing the
 * map as a plain object or a `Map`. Unknown or hostile shapes yield
 * null, never a throw, so bound panels fail closed to idle.
 * @param {unknown} captureState
 * @param {unknown} surfaceId
 * @returns {{ phase?: unknown, recordingId?: unknown, frames?: unknown, elapsedMs?: unknown, lastShot?: unknown, lastCode?: unknown } | null}
 */
export function captureEntryFor(captureState, surfaceId) {
  if (!captureState || typeof captureState !== 'object') return null;
  if (typeof surfaceId !== 'string' || surfaceId.length === 0) return null;
  if (surfaceId === '__proto__' || surfaceId === 'constructor' || surfaceId === 'prototype') return null;
  const bySurface = /** @type {{ bySurface?: unknown }} */ (captureState).bySurface;
  /** @type {unknown} */
  let entry = null;
  if (bySurface instanceof Map) {
    entry = bySurface.get(surfaceId) ?? null;
  } else if (bySurface && typeof bySurface === 'object') {
    entry = /** @type {Record<string, unknown>} */ (bySurface)[surfaceId] ?? null;
  }
  return entry && typeof entry === 'object' ? /** @type {{ phase?: unknown }} */ (entry) : null;
}

/**
 * Panel-shaped manifest rows for a surface from the capture store list
 * (MVUI9 lane A). Keeps `kind: 'recording'` rows for this surface only;
 * screenshots surface through the screenshot control state, never the
 * recordings manifest. Unknown shapes yield an empty frozen list.
 * @param {unknown} captureState
 * @param {unknown} surfaceId
 * @returns {ReadonlyArray<Readonly<Record<string, unknown>>>}
 */
export function captureRowsFor(captureState, surfaceId) {
  if (!captureState || typeof captureState !== 'object') return Object.freeze([]);
  if (typeof surfaceId !== 'string' || surfaceId.length === 0) return Object.freeze([]);
  const rows = /** @type {{ rows?: unknown }} */ (captureState).rows;
  if (!Array.isArray(rows)) return Object.freeze([]);
  /** @type {Array<Readonly<Record<string, unknown>>>} */
  const mapped = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const source = /** @type {{ id?: unknown, kind?: unknown, surface_id?: unknown, phase?: unknown, frames?: unknown, duration_ms?: unknown }} */ (row);
    if (source.kind !== 'recording' || source.surface_id !== surfaceId) continue;
    if (typeof source.id !== 'string' || source.id.length === 0) continue;
    mapped.push(Object.freeze({
      id: source.id,
      capsuleId: surfaceId,
      phase: normalizeMvRecordPhase(source.phase),
      store: MV_RECORDING_STORE,
      elapsedSeconds: typeof source.duration_ms === 'number' && Number.isFinite(source.duration_ms) && source.duration_ms >= 0
        ? Math.floor(source.duration_ms / 1000)
        : null,
      frames: source.frames,
    }));
  }
  return Object.freeze(mapped);
}
