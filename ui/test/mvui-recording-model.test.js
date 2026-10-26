// MetaViewer recording adapter model (AC-07): disk gating, typed refusal
// rows, stable ids and semantic anchors. Every behaviour ships with a
// negative control proving the assertion can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MV_EXPORT_DESTINATION_REASON,
  MV_EXPORT_UNSEALED_REASON,
  MV_EXPORT_UNSEALED_RECORDING,
  MV_EXPORT_WITHOUT_DESTINATION,
  MV_RECORDING_UNAVAILABLE,
  MV_RECORD_EMPTY_TEXT,
  formatMvCount,
  formatMvElapsed,
  formatMvTtl,
  isPresentDestination,
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
} from '../src/recording/recordingModel.js';

test('phase and screenshot normalizers keep known values and fall back to idle', () => {
  assert.equal(normalizeMvRecordPhase('sealed'), 'sealed');
  assert.equal(normalizeMvScreenshotState('capturing'), 'capturing');
  for (const unknown of [undefined, null, '', 'stale', 'LIVE', 42, {}, []]) {
    assert.equal(normalizeMvRecordPhase(unknown), 'idle');
    assert.equal(normalizeMvScreenshotState(unknown), 'idle');
  }
});

test('destination presence requires a bare host token', () => {
  assert.equal(isPresentDestination('host-picker'), true);
  // Kit parity: only surrounding whitespace disqualifies; interior content
  // is the host's business, matching the kit per-row export gate.
  assert.equal(isPresentDestination('has space'), true);
  for (const bad of [undefined, null, '', '  ', ' padded', 'padded ', 7, {}, []]) {
    assert.equal(isPresentDestination(bad), false);
  }
});

test('record-to-disk gate refuses without a destination even when sealed', () => {
  for (const destination of [undefined, null, '', '   ', ' outer ']) {
    const gate = recordToDiskGate({ destination, phase: 'sealed' });
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, MV_EXPORT_WITHOUT_DESTINATION);
    assert.equal(gate.reason, MV_EXPORT_DESTINATION_REASON);
    assert.equal(Object.isFrozen(gate), true);
  }
  const missing = recordToDiskGate(/** @type {any} */ (null));
  assert.equal(missing.allowed, false);
  assert.equal(missing.code, MV_EXPORT_WITHOUT_DESTINATION);
});

test('record-to-disk gate refuses unsealed recordings that have a destination', () => {
  for (const phase of ['idle', 'starting', 'recording', 'stopping', 'error', 'bogus']) {
    const gate = recordToDiskGate({ destination: 'host-picker', phase });
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, MV_EXPORT_UNSEALED_RECORDING);
    assert.equal(gate.reason, MV_EXPORT_UNSEALED_REASON);
  }
});

test('record-to-disk gate allows a sealed recording with a destination', () => {
  const gate = recordToDiskGate({ destination: 'host-picker', phase: 'sealed' });
  assert.deepEqual({ ...gate }, { allowed: true, code: '', reason: '' });
});

test('panel refusal row appears only without a destination; unavailable wins', () => {
  assert.equal(panelDiskRefusalFor({ destination: 'host-picker' }), null);
  const missing = panelDiskRefusalFor({ destination: '' });
  assert.deepEqual(
    { ...missing },
    { code: MV_EXPORT_WITHOUT_DESTINATION, reason: MV_EXPORT_DESTINATION_REASON },
  );
  const held = panelDiskRefusalFor({ destination: 'host-picker', unavailableReason: 'Held by host' });
  assert.deepEqual({ ...held }, { code: MV_RECORDING_UNAVAILABLE, reason: 'Recording is unavailable' });
  const heldFirst = panelDiskRefusalFor({ destination: '', unavailableReason: 'Held by host' });
  assert.equal(heldFirst?.code, MV_RECORDING_UNAVAILABLE);
});

test('recording ids and anchors are stable, deterministic and capsule-scoped', () => {
  assert.equal(mvRecordingPanelDomId('cap-7'), 'mv-recording-panel-cap-7');
  assert.equal(mvDiskRefusalDomId('cap-7'), 'mv-recording-disk-refusal-cap-7');
  assert.equal(mvRecordingPanelAnchor('cap-7'), 'recording/cap-7/panel');
  assert.equal(mvDiskRefusalAnchor('cap-7'), 'recording/cap-7/disk-refusal');
  assert.equal(mvRecordingPanelAnchor('cap-7'), mvRecordingPanelAnchor('cap-7'));
  assert.notEqual(mvRecordingPanelAnchor('cap-7'), mvRecordingPanelAnchor('cap-8'));
  assert.notEqual(mvDiskRefusalDomId('cap-7'), mvDiskRefusalDomId('cap-8'));
  for (const anchor of [mvRecordingPanelAnchor('cap-7'), mvDiskRefusalAnchor('cap-7')]) {
    assert.match(anchor, /^[a-z0-9]+(?:\/[a-z0-9-]+)+$/);
  }
});

test('formatters render host projections without fabricating values', () => {
  assert.equal(formatMvElapsed(125), '02:05');
  assert.equal(formatMvElapsed(0), '00:00');
  for (const bad of [undefined, null, -1, NaN, Infinity, '5', {}, []]) {
    assert.equal(formatMvElapsed(bad), '--:--');
  }
  assert.equal(formatMvCount(3750), '3750');
  for (const bad of [undefined, null, -1, 1.5, NaN, '5']) {
    assert.equal(formatMvCount(bad), 'Unknown');
  }
  assert.equal(formatMvTtl(600), '10:00');
  assert.equal(formatMvTtl(0), 'Expired');
  assert.equal(formatMvTtl(-3), 'Expired');
  for (const bad of [undefined, null, NaN, '5']) {
    assert.equal(formatMvTtl(bad), 'Unknown');
  }
  assert.equal(mvStoreLabel('ram'), 'RAM');
  assert.equal(mvStoreLabel('disk'), 'Unknown');
  assert.equal(MV_RECORD_EMPTY_TEXT, 'No recordings yet.');
});

test('phase labels, tones and control labels follow the phase', () => {
  assert.deepEqual(
    ['idle', 'starting', 'recording', 'stopping', 'sealed', 'error'].map(mvPhaseLabel),
    ['Idle', 'Starting', 'Recording', 'Stopping', 'Sealed', 'Error'],
  );
  assert.equal(mvPhaseLabel('bogus'), 'Idle');
  assert.deepEqual(
    ['idle', 'starting', 'recording', 'stopping', 'sealed', 'error'].map(mvPhaseTone),
    ['neutral', 'warning', 'error', 'warning', 'success', 'error'],
  );
  assert.deepEqual(
    ['idle', 'starting', 'recording', 'stopping', 'sealed', 'error'].map(mvRecordToggleLabel),
    ['Record for AI', 'Starting', 'Stop', 'Stopping', 'Record again', 'Retry'],
  );
  assert.deepEqual(
    ['idle', 'capturing', 'done', 'error'].map(mvScreenshotButtonLabel),
    ['Screenshot', 'Capturing', 'Captured', 'Retry capture'],
  );
  assert.equal(mvRecordPhaseBusy('starting'), true);
  assert.equal(mvRecordPhaseBusy('stopping'), true);
  assert.equal(mvRecordPhaseBusy('recording'), false);
  assert.equal(mvScreenshotStateBusy('capturing'), true);
  assert.equal(mvScreenshotStateBusy('done'), false);
});

test('toggle and screenshot accessible names track phase and state', () => {
  assert.equal(
    mvRecordToggleAccessibleName({ capsuleLabel: 'Research', capsuleId: 'cap-7', phase: 'idle' }),
    'Record Research for AI',
  );
  assert.equal(
    mvRecordToggleAccessibleName({ capsuleId: 'cap-7', phase: 'recording' }),
    'Stop AI recording on cap-7',
  );
  assert.equal(
    mvRecordToggleAccessibleName({ capsuleId: 'cap-7', phase: 'starting' }),
    'AI recording transition pending on cap-7',
  );
  assert.equal(
    mvRecordToggleAccessibleName({ capsuleId: 'cap-7', phase: 'error' }),
    'Retry AI recording on cap-7',
  );
  assert.equal(
    mvScreenshotAccessibleName({ capsuleId: 'cap-7', state: 'capturing' }),
    'Screenshot capture pending on cap-7',
  );
  assert.equal(
    mvScreenshotAccessibleName({ capsuleId: 'cap-7', state: 'done' }),
    'Screenshot captured on cap-7',
  );
  assert.equal(mvScreenshotAccessibleName({ capsuleId: 'cap-7', state: 'error' }), 'Retry screenshot on cap-7');
  assert.equal(mvScreenshotAccessibleName({ capsuleId: 'cap-7' }), 'Screenshot cap-7');
});

test('row export gate follows unavailable, sealed, destination precedence', () => {
  const held = rowExportGateFor({ phase: 'idle', destination: '', unavailableReason: 'Held' });
  assert.deepEqual({ ...held }, { disabled: true, reason: 'Recording is unavailable', gate: 'unavailable', gateLabel: 'Unavailable' });
  const unsealed = rowExportGateFor({ phase: 'recording', destination: 'host-picker' });
  assert.deepEqual(
    { ...unsealed },
    { disabled: true, reason: MV_EXPORT_UNSEALED_REASON, gate: 'sealed-required', gateLabel: 'Sealed required' },
  );
  const noDest = rowExportGateFor({ phase: 'sealed', destination: '' });
  assert.deepEqual(
    { ...noDest },
    {
      disabled: true,
      reason: MV_EXPORT_DESTINATION_REASON,
      gate: 'destination-required',
      gateLabel: 'Destination required',
    },
  );
  const ready = rowExportGateFor({ phase: 'sealed', destination: 'host-picker' });
  assert.deepEqual({ ...ready }, { disabled: false, reason: '', gate: 'ready', gateLabel: 'Export ready' });
  assert.equal(Object.isFrozen(ready), true);
});

test('row error text maps all host errors to a fixed safe literal', () => {
  assert.equal(mvRowErrorText({ phase: 'error', error: 'Host says no' }), 'Recording failed');
  assert.equal(mvRowErrorText({ phase: 'error', error: '  ' }), 'Recording failed');
  assert.equal(mvRowErrorText({ phase: 'error' }), 'Recording failed');
  assert.equal(mvRowErrorText({ phase: 'sealed', error: 'Host says no' }), '');
});

test('control and row ids and anchors are stable and capsule-scoped', () => {
  assert.equal(mvRecordToggleDomId('cap-7'), 'mv-recordings-toggle-cap-7');
  assert.equal(mvScreenshotDomId('cap-7'), 'mv-recordings-screenshot-cap-7');
  assert.equal(mvPhaseDomId('cap-7'), 'mv-recordings-phase-cap-7');
  assert.equal(mvStoreChipDomId('cap-7'), 'mv-recordings-store-cap-7');
  assert.equal(mvRecordToggleAnchor('cap-7'), 'recording/cap-7/toggle');
  assert.equal(mvScreenshotAnchor('cap-7'), 'recording/cap-7/screenshot');
  assert.equal(mvPhaseAnchor('cap-7'), 'recording/cap-7/phase');
  assert.equal(mvStoreChipAnchor('cap-7'), 'recording/cap-7/store-chip');
  assert.equal(mvManifestRowDomId('rec-1'), 'mv-recordings-row-rec-1');
  assert.equal(mvManifestSelectDomId('rec-1'), 'mv-recordings-select-rec-1');
  assert.equal(mvExportDomId('rec-1'), 'mv-recordings-export-rec-1');
  assert.equal(mvExportGateDomId('rec-1'), 'mv-recordings-gate-rec-1');
  assert.equal(mvManifestRowAnchor('rec-1'), 'recording/rec-1/row');
  assert.equal(mvManifestSelectAnchor('rec-1'), 'recording/rec-1/select');
  assert.equal(mvExportAnchor('rec-1'), 'recording/rec-1/export');
  assert.equal(mvExportGateAnchor('rec-1'), 'recording/rec-1/export-gate');
  assert.equal(mvSelectAccessibleName({ id: 'rec-1' }), 'Select rec-1');
  assert.equal(mvSelectAccessibleName({ capsuleLabel: 'Research', id: 'rec-1' }), 'Select Research');
  assert.equal(mvExportAccessibleName({ id: 'rec-1' }), 'Export rec-1 to host destination');
  assert.equal(mvSelectAccessibleName({}), 'Select recording');
});

test('accessible names use the label and fall back to the capsule id', () => {
  assert.equal(
    mvRecordingPanelAccessibleName({ capsuleLabel: 'Research', capsuleId: 'cap-7' }),
    'Recordings for Research',
  );
  assert.equal(mvRecordingPanelAccessibleName({ capsuleLabel: '  ', capsuleId: 'cap-7' }), 'Recordings for cap-7');
  assert.equal(
    mvDiskRefusalAccessibleName({ capsuleLabel: '', capsuleId: 'cap-7', reason: MV_EXPORT_DESTINATION_REASON }),
    `Record to disk unavailable on cap-7: ${MV_EXPORT_DESTINATION_REASON}`,
  );
});
