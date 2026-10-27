// MVUI16 lane P (ARG-pmui-7, P2): per-row export status clears on
// capture-state/capsule change, and a synchronous live guard closes the
// same-tick double-export race (single facade call, final exported).
// Negatives: mutants without the watches / without the guard reproduce the
// stale exported row and the double call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelComponent, mutantPanelComponent, mountPanel, panelFlush, panelById, fakeStore, sealedRow, panelToken, text } from './mvui16-harness.mjs';

const TOKEN = panelToken();
const exportButton = (mounted) => panelById(mounted, 'mv-recordings-export-rec-1');
const exportStatus = (mounted) => panelById(mounted, 'mv-recordings-export-status-rec-1');

async function exportOnce(mounted) {
  await exportButton(mounted).props.onClick();
  await panelFlush();
}

test('export then store swap returns the row to idle and enabled', async () => {
  const Panel = await panelComponent();
  const mounted = mountPanel(Panel, { capsuleId: 'cap-01', captureState: fakeStore({ rows: [sealedRow()] }), captureAvailable: true, exportDestination: TOKEN });
  try {
    await exportOnce(mounted);
    assert.equal(text(exportStatus(mounted)).trim(), 'Exported cccccccc');
    assert.equal(exportButton(mounted).props.disabled, true);
    mounted.props.captureState = fakeStore({ rows: [sealedRow()] });
    await panelFlush();
    assert.equal(exportStatus(mounted), undefined, 'stale outcome clears on store swap');
    assert.equal(exportButton(mounted).props.disabled, false);
    assert.equal(text(exportButton(mounted)).trim(), 'Export');
  } finally { mounted.close(); }
});

test('export then capsule switch returns the row to idle and enabled', async () => {
  const Panel = await panelComponent();
  // Same display id on both surfaces: rows filter by surface, so each view
  // holds exactly one valid rec-1 and the stale key collides across switch.
  const store = fakeStore({ rows: [sealedRow('rec-1', 'cap-01'), sealedRow('rec-1', 'cap-02')] });
  const mounted = mountPanel(Panel, { capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: TOKEN });
  try {
    await exportOnce(mounted);
    assert.equal(text(exportStatus(mounted)).trim(), 'Exported cccccccc');
    mounted.props.capsuleId = 'cap-02';
    await panelFlush();
    assert.equal(exportStatus(mounted), undefined, 'stale outcome clears on capsule switch');
    assert.equal(exportButton(mounted).props.disabled, false);
  } finally { mounted.close(); }
});

test('same-tick double export reaches the facade once and stays exported', async () => {
  const Panel = await panelComponent();
  const store = fakeStore({ rows: [sealedRow()] });
  const mounted = mountPanel(Panel, { capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: TOKEN });
  try {
    const click = exportButton(mounted).props.onClick;
    const first = click();
    const second = click();
    await first;
    await second;
    await panelFlush();
    assert.deepEqual(store.calls, [['exportCapture', 'rec-1']]);
    assert.equal(text(exportStatus(mounted)).trim(), 'Exported cccccccc');
  } finally { mounted.close(); }
});

const dropWatches = (source) => source.replace(
  'watch(() => props.captureState, () => { exportStatus.clear(); });\nwatch(() => props.capsuleId, () => { exportStatus.clear(); });',
  '');

test('negative control: mutant without the watches keeps the stale exported row', async () => {
  const Panel = await mutantPanelComponent(dropWatches);
  const mounted = mountPanel(Panel, { capsuleId: 'cap-01', captureState: fakeStore({ rows: [sealedRow()] }), captureAvailable: true, exportDestination: TOKEN });
  try {
    await exportOnce(mounted);
    mounted.props.captureState = fakeStore({ rows: [sealedRow()] });
    await panelFlush();
    assert.equal(text(exportStatus(mounted)).trim(), 'Exported cccccccc', 'mutant reproduces the stale row');
    assert.equal(exportButton(mounted).props.disabled, true);
  } finally { mounted.close(); }
});

const dropGuard = (source) => source.replace(
  '  const current = exportStatus.get(entry.id)?.state;\n  if (current === \'exporting\' || current === \'exported\') return;\n',
  '');

test('negative control: mutant without the sync guard double-calls the facade', async () => {
  const Panel = await mutantPanelComponent(dropGuard);
  const store = fakeStore({ rows: [sealedRow()] });
  const mounted = mountPanel(Panel, { capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: TOKEN });
  try {
    const click = exportButton(mounted).props.onClick;
    const first = click();
    const second = click();
    await first;
    await second;
    await panelFlush();
    assert.equal(store.calls.filter(([name]) => name === 'exportCapture').length, 2, 'mutant reproduces the race');
  } finally { mounted.close(); }
});

test('mvui16 memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16-export-stale rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
