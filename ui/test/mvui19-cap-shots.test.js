// MVUI19 lane C (L3-5): sealed screenshots (kind 'shot') listed alongside
// recordings in their own screenshots section with a typed label and no
// path, still bounded. The recordings manifest stays recordings-only.
// Bounded fakes plus negative controls.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/recording/recordingModel.js';
import { createCapturePort, createCaptureState } from '../src/capture/capturePort.js';
import {
  panelComponent,
  mountPanel,
  panelFlush,
  panelById,
  fakeStore,
} from './mvui16-harness.mjs';
import { nodes } from './mvui2-terminal-mount.mjs';

const T0 = Date.now();
const HISTORY_LIMIT = 8;

function capRow(id, surface, kind = 'recording', phase = 'sealed') {
  return {
    id, kind, surface_id: surface, phase, frames: 3, duration_ms: 30000,
    sealed: phase === 'sealed', created_ms: 9,
  };
}

function scripted(handlers = {}) {
  const calls = { list: 0 };
  const listHistory = [];
  const listeners = new Set();
  return {
    calls, listHistory, listeners,
    async screenshot() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
    async recordStart() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
    async recordStop() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
    async list() {
      calls.list += 1;
      listHistory.push(calls.list);
      if (listHistory.length > HISTORY_LIMIT) listHistory.splice(0, listHistory.length - HISTORY_LIMIT);
      return handlers.list ? handlers.list() : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}

const panelText = (root) => nodes(root).map((n) => n.text ?? '').join(' ');
const panelSelects = (mounted) => nodes(mounted.root).filter((n) => n.props?.class === 'mv4-select');

describe('sealed shots listed alongside recordings', () => {
  test('captureShotsFor keeps sealed shots; captureRowsFor stays recordings-only', () => {
    assert.equal(typeof model.captureShotsFor, 'function', 'shots helper exists');
    assert.equal(typeof model.mvCaptureKindLabel, 'function', 'typed label helper exists');
    assert.equal(model.mvCaptureKindLabel('shot'), 'Screenshot');
    assert.equal(model.mvCaptureKindLabel('recording'), 'Recording');
    const store = { rows: [
      capRow('rec-1', 'cap-01', 'recording', 'sealed'),
      capRow('shot-1', 'cap-01', 'shot', 'sealed'),
      capRow('rec-9', 'cap-09', 'recording', 'sealed'),
      capRow('shot-9', 'cap-09', 'shot', 'sealed'),
    ] };
    const recs = model.captureRowsFor(store, 'cap-01');
    assert.deepEqual(recs.map((r) => r.id), ['rec-1'], 'manifest stays recordings-only');
    const shots = model.captureShotsFor(store, 'cap-01');
    assert.equal(shots.length, 1, 'sealed shot listed');
    assert.equal(shots[0].id, 'shot-1');
    assert.equal(shots[0].kind, 'shot');
    assert.equal(model.mvCaptureKindLabel(shots[0].kind), 'Screenshot');
    assert.ok(Object.isFrozen(shots));
  });

  test('panel renders screenshots section with typed label, no path, no shot select', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [
      capRow('rec-1', 'cap-01', 'recording', 'sealed'),
      capRow('shot-1', 'cap-01', 'shot', 'sealed'),
    ] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: '',
    });
    try {
      await panelFlush();
      const text = panelText(mounted.root);
      assert.ok(panelById(mounted, 'mv-recordings-select-rec-1'), 'recording select renders');
      assert.ok(panelById(mounted, 'mv-recordings-row-shot-1'), 'sealed shot row renders');
      assert.ok(panelById(mounted, 'mv-recordings-export-shot-1'), 'shot export renders');
      assert.equal(panelById(mounted, 'mv-recordings-select-shot-1'), undefined, 'shots have no select');
      assert.equal(panelSelects(mounted).length, 1, 'manifest selects stay recordings-only');
      assert.match(text, /Screenshot/, 'typed shot label');
      assert.match(text, /Screenshots/, 'screenshots section header');
      assert.doesNotMatch(text, /\//, 'no path separator in row text');
      assert.doesNotMatch(text, /\.png/i, 'no file extension leak');
    } finally { mounted.close(); }
  });

  test('many captures stay bounded through the store cap', async () => {
    const incoming = [];
    for (let i = 0; i < 40; i += 1) incoming.push(capRow(`rec-${i}`, 'cap-01', 'recording', 'sealed'));
    for (let i = 0; i < 40; i += 1) incoming.push(capRow(`shot-${i}`, 'cap-01', 'shot', 'sealed'));
    const facade = scripted({ list: () => ({ ok: true, rows: incoming }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const res = await state.refresh();
      assert.equal(res.ok, true);
      assert.ok(state.rows.length <= 64, `store capped, saw ${state.rows.length}`);
      const recs = model.captureRowsFor(state, 'cap-01');
      const shots = model.captureShotsFor(state, 'cap-01');
      assert.ok(recs.length + shots.length <= 64, `panel rows bounded, saw ${recs.length + shots.length}`);
      assert.ok(shots.some((r) => r.id === 'shot-0'), 'shots survive the cap');
    } finally { state.dispose(); }
  });
});

describe('shot list negative controls', () => {
  test('unsealed shots and shots without a sealed receipt stay out', () => {
    const shots = model.captureShotsFor({ rows: [
      { id: 'shot-live', kind: 'shot', surface_id: 'cap-01', phase: 'recording', frames: 1, duration_ms: 0, sealed: false, created_ms: 1 },
      { id: 'shot-noseal', kind: 'shot', surface_id: 'cap-01', phase: 'sealed' },
      capRow('shot-1', 'cap-01', 'shot', 'sealed'),
    ] }, 'cap-01');
    assert.deepEqual(shots.map((r) => r.id), ['shot-1'], 'only sealed shots list');
  });

  test('other-surface shots never list for this capsule', () => {
    const shots = model.captureShotsFor({ rows: [
      capRow('shot-9', 'cap-09', 'shot', 'sealed'),
      capRow('shot-1', 'cap-01', 'shot', 'sealed'),
    ] }, 'cap-01');
    assert.deepEqual(shots.map((r) => r.id), ['shot-1']);
  });

  test('legacy recording rows keep their exact shape without kind', () => {
    const rows = model.captureRowsFor({ rows: [
      { id: 'rec-1', kind: 'recording', surface_id: 'cap-01', phase: 'sealed', frames: 12, duration_ms: 61000 },
    ] }, 'cap-01');
    assert.deepEqual(rows, [
      { id: 'rec-1', capsuleId: 'cap-01', phase: 'sealed', store: 'ram', elapsedSeconds: 61, frames: 12 },
    ]);
  });

  test('panel without shots renders recordings only and no screenshots table', async () => {
    const Panel = await panelComponent();
    const store = fakeStore({ rows: [capRow('rec-1', 'cap-01', 'recording', 'sealed')] });
    const mounted = mountPanel(Panel, {
      capsuleId: 'cap-01', captureState: store, captureAvailable: true, exportDestination: '',
    });
    try {
      await panelFlush();
      assert.ok(panelById(mounted, 'mv-recordings-select-rec-1'));
      assert.equal(panelById(mounted, 'mv-recordings-row-shot-1'), undefined);
      assert.equal(panelSelects(mounted).length, 1);
    } finally { mounted.close(); }
  });
});

test('mvui19-cap-shots memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  assert.ok(Date.now() - T0 < 10000, 'test file finishes in < 10 s');
});
