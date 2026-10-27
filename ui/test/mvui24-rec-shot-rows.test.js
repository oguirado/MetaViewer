// MVUI24 lane R (RV9-04 + NEW-03): a colliding sealed shot keeps its source
// id in the table cell (the display id stays disambiguated for document
// uniqueness), and shot export status is keyed by stable source identity
// so recording list changes neither orphan nor misattribute it. Mounted
// panel, bounded fakes, negative controls.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import {
  panelComponent,
  mountPanel,
  panelById,
  fakeStore,
  sealedRow,
  nodes,
  text,
  panelToken,
} from './mvui16-harness.mjs';
import { tick } from './frame-wait.mjs';

const T0 = Date.now();

const flush = async () => { await tick(); await vue.nextTick(); };

function sealedShot(id = 'shot-1', surface = 'cap-01') {
  return {
    id, kind: 'shot', surface_id: surface, phase: 'sealed', frames: 2,
    duration_ms: 7000, sealed: true, created_ms: 9,
  };
}

function shotCell(mounted, rowId) {
  const row = panelById(mounted, rowId);
  assert.ok(row, `shot row renders: ${rowId}`);
  const cell = nodes(row).find((node) => node.tag === 'td');
  assert.ok(cell, 'shot id cell renders');
  return cell;
}

describe('RV9-04 colliding shot keeps source id in table cell', () => {
  test('shot cell text and title show the source id, not the display id', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [sealedRow('cap-1', 'cap-01'), sealedShot('cap-1', 'cap-01')] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: panelToken(),
    });
    try {
      await flush();
      const cell = shotCell(mounted, 'mv-recordings-row-cap-1-shot');
      assert.equal(text(cell).trim(), 'cap-1', 'cell shows the source id');
      assert.equal(cell.props.title, 'cap-1', 'cell title shows the source id');
      const recordRow = panelById(mounted, 'mv-recordings-row-cap-1');
      assert.ok(recordRow, 'recording row keeps its own row');
      const select = panelById(mounted, 'mv-recordings-select-cap-1');
      assert.equal(text(select).trim(), 'cap-1', 'recording select keeps its label');
    } finally { mounted.close(); }
  });

  test('colliding shot export still calls the store with the source id', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [sealedRow('cap-1', 'cap-01'), sealedShot('cap-1', 'cap-01')] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: panelToken(),
    });
    try {
      await flush();
      const button = panelById(mounted, 'mv-recordings-export-cap-1-shot');
      assert.ok(button, 'disambiguated shot export renders');
      await button.props.onClick();
      await flush();
      assert.ok(
        store.calls.some((call) => call[0] === 'exportCapture' && call[1] === 'cap-1'),
        `store receives the source id, saw ${JSON.stringify(store.calls)}`,
      );
    } finally { mounted.close(); }
  });
});

describe('NEW-03 shot export status survives recording list changes', () => {
  test('removing the colliding recording keeps the shot exported badge', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [sealedRow('cap-1', 'cap-01'), sealedShot('cap-1', 'cap-01')] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: panelToken(),
    });
    try {
      await flush();
      await panelById(mounted, 'mv-recordings-export-cap-1-shot').props.onClick();
      await flush();
      assert.equal(
        panelById(mounted, 'mv-recordings-export-status-cap-1-shot').props['data-export-state'],
        'exported',
        'shot shows exported before the list change',
      );
      const doomed = store.rows.findIndex((row) => row.kind === 'recording');
      assert.ok(doomed >= 0, 'recording row present');
      store.rows.splice(doomed, 1);
      await flush();
      assert.ok(panelById(mounted, 'mv-recordings-row-cap-1'), 'shot row reclaims the bare id');
      const status = panelById(mounted, 'mv-recordings-export-status-cap-1');
      assert.ok(status, 'shot status survives the recording removal');
      assert.equal(status.props['data-export-state'], 'exported');
      assert.equal(text(status).trim(), 'Exported cccccccc');
    } finally { mounted.close(); }
  });

  test('a recording added later never inherits the shot export status', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [sealedShot('cap-1', 'cap-01')] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: panelToken(),
    });
    try {
      await flush();
      await panelById(mounted, 'mv-recordings-export-cap-1').props.onClick();
      await flush();
      assert.equal(
        panelById(mounted, 'mv-recordings-export-status-cap-1').props['data-export-state'],
        'exported',
        'shot shows exported before the list change',
      );
      store.rows.unshift(sealedRow('cap-1', 'cap-01'));
      await flush();
      const recordButton = panelById(mounted, 'mv-recordings-export-cap-1');
      assert.ok(recordButton, 'recording export renders under its own id');
      assert.ok(!recordButton.props.disabled, 'recording stays exportable');
      assert.equal(
        panelById(mounted, 'mv-recordings-export-status-cap-1'),
        undefined,
        'no status leaks onto the recording row',
      );
      const shotStatus = panelById(mounted, 'mv-recordings-export-status-cap-1-shot');
      assert.ok(shotStatus, 'shot keeps its own status under the display id');
      assert.equal(shotStatus.props['data-export-state'], 'exported');
    } finally { mounted.close(); }
  });
});

describe('shot rows negative controls', () => {
  test('recording rows render byte-identical without shots', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [sealedRow('rec-1', 'cap-01')] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: panelToken(),
    });
    try {
      await flush();
      const row = panelById(mounted, 'mv-recordings-row-rec-1');
      assert.ok(row, 'recording row renders');
      assert.equal(row.props['data-semantic-anchor'], 'recording/rec-1/row');
      const select = panelById(mounted, 'mv-recordings-select-rec-1');
      assert.equal(select.props['data-semantic-anchor'], 'recording/rec-1/select');
      assert.equal(select.props['aria-label'], 'Select rec-1');
      assert.equal(text(select).trim(), 'rec-1');
      const action = panelById(mounted, 'mv-recordings-export-rec-1');
      assert.equal(action.props['data-semantic-anchor'], 'recording/rec-1/export');
      assert.equal(action.props['aria-label'], 'Export rec-1 to host destination');
    } finally { mounted.close(); }
  });

  test('unclaimed shot keeps its source id in every binding', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [sealedShot('shot-9', 'cap-01')] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: panelToken(),
    });
    try {
      await flush();
      const cell = shotCell(mounted, 'mv-recordings-row-shot-9');
      assert.equal(text(cell).trim(), 'shot-9');
      assert.equal(cell.props.title, 'shot-9');
      const action = panelById(mounted, 'mv-recordings-export-shot-9');
      assert.equal(action.props['data-semantic-anchor'], 'recording/shot-9/export');
      assert.equal(action.props['aria-label'], 'Export shot-9 to host destination');
    } finally { mounted.close(); }
  });

  test('colliding and hostile shot rows keep valid unique DOM ids', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [
      sealedRow('cap-1', 'cap-01'),
      sealedShot('cap-1', 'cap-01'),
      sealedShot('a b/c', 'cap-01'),
    ] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: panelToken(),
    });
    try {
      await flush();
      const ids = nodes(mounted.root).map((node) => node.props?.id).filter(Boolean);
      assert.ok(ids.length > 0, 'controls render');
      for (const id of ids) {
        assert.doesNotMatch(id, /\s/, `DOM id carries no whitespace: ${id}`);
        assert.doesNotMatch(id, /\//, `DOM id carries no slash: ${id}`);
      }
      assert.equal(new Set(ids).size, ids.length, 'DOM ids stay unique');
      assert.ok(panelById(mounted, 'mv-recordings-row-cap-1-shot'), 'colliding shot row renders');
      assert.ok(panelById(mounted, 'mv-recordings-row-unknown-1'), 'hostile shot id falls back');
    } finally { mounted.close(); }
  });
});

test('mvui24-rec-shot-rows memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  assert.ok(Date.now() - T0 < 30000, 'test file finishes in < 30 s');
});
