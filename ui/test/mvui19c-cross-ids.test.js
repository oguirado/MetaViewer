// MVUI19C lane R: cross-section id/anchor uniqueness between the
// recordings manifest and the screenshots section. displayShots used to
// resolve counts/used/`unknown-${index}` independently of displayRows
// while sharing the mvManifestRow*/mvExport* helpers and the
// exportStatus map, so a recording and a screenshot with the same id (or
// two unknown fallbacks) rendered duplicate DOM ids/anchors and shared
// export state. Shots now resolve against the rows' claimed ids
// (colliding valid shots take a `-shot` suffix, fallbacks stay seeded),
// so the bare display id keys each section's export status without
// sharing; recording rows stay byte-identical.
// Bounded fakes plus a mutant negative control.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  panelComponent,
  mutantPanelComponent,
  mountPanel,
  panelFlush,
  panelById,
  fakeStore,
} from './mvui16-harness.mjs';
import { nodes } from './mvui2-terminal-mount.mjs';

const T0 = Date.now();
const DESTINATION = 'host-advertised';

function recRow(id, surface = 'cap-01') {
  return {
    id, kind: 'recording', surface_id: surface, phase: 'sealed',
    frames: 3, duration_ms: 30000, sealed: true, created_ms: 7,
  };
}

function shotRow(id, surface = 'cap-01') {
  return {
    id, kind: 'shot', surface_id: surface, phase: 'sealed',
    frames: 2, duration_ms: 7000, sealed: true, created_ms: 9,
  };
}

function mountWith(Panel, rows) {
  const store = fakeStore({ rows });
  const mounted = mountPanel(Panel, {
    capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: DESTINATION,
  });
  return { store, mounted };
}

const domIds = (mounted) => nodes(mounted.root)
  .map((n) => n.props?.id).filter((v) => typeof v === 'string');
const anchors = (mounted) => nodes(mounted.root)
  .map((n) => n.props?.['data-semantic-anchor']).filter((v) => typeof v === 'string');
const countOf = (list, value) => list.filter((v) => v === value).length;

function assertUnique(list, label) {
  assert.equal(new Set(list).size, list.length, `${label} stay unique: ${JSON.stringify(list)}`);
}

describe('mvui19c cross-section id uniqueness', () => {
  test('colliding host id: recording byte-identical, shot disambiguates, all unique', async () => {
    const Panel = await panelComponent();
    const { mounted } = mountWith(Panel, [recRow('dup-1'), shotRow('dup-1')]);
    try {
      await panelFlush();
      const recRowNode = panelById(mounted, 'mv-recordings-row-dup-1');
      assert.ok(recRowNode, 'recording row keeps its id');
      assert.equal(recRowNode.props['data-semantic-anchor'], 'recording/dup-1/row');
      assert.ok(panelById(mounted, 'mv-recordings-select-dup-1'), 'recording select keeps its id');
      const recExport = panelById(mounted, 'mv-recordings-export-dup-1');
      assert.ok(recExport, 'recording export keeps its id');
      assert.equal(recExport.props['data-semantic-anchor'], 'recording/dup-1/export');
      const shotRowNode = panelById(mounted, 'mv-recordings-row-dup-1-shot');
      assert.ok(shotRowNode, 'colliding shot disambiguates with a -shot suffix');
      assert.equal(shotRowNode.props['data-semantic-anchor'], 'recording/dup-1-shot/row');
      const shotExport = panelById(mounted, 'mv-recordings-export-dup-1-shot');
      assert.ok(shotExport, 'colliding shot keeps its own export control');
      assert.equal(shotExport.props.disabled, false, 'disambiguated shot stays exportable');
      assertUnique(domIds(mounted), 'DOM ids');
      assertUnique(anchors(mounted), 'anchors');
    } finally { mounted.close(); }
  });

  test('two unknown-id items per section: rows keep fallbacks, shots seed off them', async () => {
    const Panel = await panelComponent();
    const { mounted } = mountWith(Panel, [
      recRow('Bad Rec A'), recRow('Bad Rec B'), shotRow('Bad Shot A'), shotRow('Bad Shot B'),
    ]);
    try {
      await panelFlush();
      assert.ok(panelById(mounted, 'mv-recordings-row-unknown-0'), 'recording fallback unknown-0 kept');
      assert.ok(panelById(mounted, 'mv-recordings-row-unknown-1'), 'recording fallback unknown-1 kept');
      assert.ok(panelById(mounted, 'mv-recordings-row-unknown-0-0'), 'shot fallback seeds off the rows');
      assert.ok(panelById(mounted, 'mv-recordings-row-unknown-1-0'), 'shot fallback seeds off the rows');
      assert.equal(countOf(domIds(mounted), 'mv-recordings-row-unknown-0'), 1, 'no fallback duplicate');
      assertUnique(domIds(mounted), 'DOM ids');
      assertUnique(anchors(mounted), 'anchors');
    } finally { mounted.close(); }
  });

  test('export status is independent across the colliding pair', async () => {
    const Panel = await panelComponent();
    const { store, mounted } = mountWith(Panel, [recRow('dup-1'), shotRow('dup-1')]);
    try {
      await panelFlush();
      const recExport = panelById(mounted, 'mv-recordings-export-dup-1');
      const shotExport = panelById(mounted, 'mv-recordings-export-dup-1-shot');
      assert.equal(recExport.props.disabled, false, 'recording export enabled');
      assert.equal(shotExport.props.disabled, false, 'shot export enabled');
      await recExport.props.onClick();
      await panelFlush();
      const recStatus = panelById(mounted, 'mv-recordings-export-status-dup-1');
      assert.ok(recStatus, 'recording status renders after its export');
      assert.equal(recStatus.props['data-export-state'], 'exported');
      assert.equal(
        panelById(mounted, 'mv-recordings-export-status-dup-1-shot'), undefined,
        'shot shows no status after the recording export',
      );
      await shotExport.props.onClick();
      await panelFlush();
      const shotStatus = panelById(mounted, 'mv-recordings-export-status-dup-1-shot');
      assert.ok(shotStatus, 'shot status renders after its own export');
      assert.equal(shotStatus.props['data-export-state'], 'exported');
      assert.ok(panelById(mounted, 'mv-recordings-export-status-dup-1'), 'recording status still distinct');
      const exports = store.calls.filter((c) => c[0] === 'exportCapture');
      assert.equal(exports.length, 2, 'one store export per section');
      assertUnique(domIds(mounted), 'DOM ids');
      assertUnique(anchors(mounted), 'anchors');
    } finally { mounted.close(); }
  });

  test('non-colliding sections keep byte-identical shot ids', async () => {
    const Panel = await panelComponent();
    const { mounted } = mountWith(Panel, [recRow('rec-1'), shotRow('shot-1')]);
    try {
      await panelFlush();
      assert.ok(panelById(mounted, 'mv-recordings-row-shot-1'), 'shot row id unchanged off-collision');
      const shotExport = panelById(mounted, 'mv-recordings-export-shot-1');
      assert.ok(shotExport, 'shot export id unchanged off-collision');
      assert.equal(shotExport.props['data-semantic-anchor'], 'recording/shot-1/export');
    } finally { mounted.close(); }
  });

  test('negative control: pre-fix resolution reproduces the collision', async () => {
    const Mutant = await mutantPanelComponent((source) => {
      assert.ok(source.includes('const used = new Set([...claimed, ...counts.keys()]);'),
        'mutant targets the seeded set');
      assert.ok(source.includes('} else if (claimed.has(sourceId)) {'),
        'mutant targets the shot disambiguation');
      let out = source.replace(
        'const used = new Set([...claimed, ...counts.keys()]);',
        'const used = new Set(counts.keys());',
      );
      out = out.replace('} else if (claimed.has(sourceId)) {', '} else if (false) {');
      assert.notEqual(out, source, 'mutant reverts the cross-section fix');
      return out;
    });
    const store = fakeStore({ rows: [recRow('dup-1'), shotRow('dup-1')] });
    const mounted = mountPanel(Mutant, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: DESTINATION,
    });
    try {
      await panelFlush();
      assert.equal(countOf(domIds(mounted), 'mv-recordings-row-dup-1'), 2, 'pre-fix row id duplicates');
      assert.equal(countOf(anchors(mounted), 'recording/dup-1/export'), 2, 'pre-fix export anchor duplicates');
      assert.ok(panelById(mounted, 'mv-recordings-row-dup-1'), 'witness renders');
      await panelById(mounted, 'mv-recordings-export-dup-1').props.onClick();
      await panelFlush();
      assert.equal(countOf(domIds(mounted), 'mv-recordings-export-status-dup-1'), 2,
        'pre-fix shares export status across sections');
    } finally { mounted.close(); }
    const fallbackStore = fakeStore({ rows: [recRow('Bad Rec A'), shotRow('Bad Shot A')] });
    const fallbackMounted = mountPanel(Mutant, {
      capsuleId: 'cap-01', captureState: fallbackStore, captureAvailable: true, exportDestination: DESTINATION,
    });
    try {
      await panelFlush();
      assert.equal(countOf(domIds(fallbackMounted), 'mv-recordings-row-unknown-0'), 2,
        'pre-fix fallback duplicates');
    } finally { fallbackMounted.close(); }
  });
});

test('mvui19c-cross-ids memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  assert.ok(Date.now() - T0 < 10000, 'test file finishes in < 10 s');
});
