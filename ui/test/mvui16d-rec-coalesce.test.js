// MVUI16D lane R (judge p2 notes 1-3): recordings refresh coalescing.
// (1) A refresh queued with a different filter than the queued run widens
// the queued run to the full list, so neither surface drops rows.
// (2) Panel mount lists unless the store holds rows for the ACTIVE
// capsule: an earlier auto-refresh for A must not suppress the B mount.
// (3) Swapping captureState on a mounted panel relists when the new store
// is listable but holds no rows for the active capsule.
// Bounded scripted facades plus mutant and behavioral negatives.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createCapturePort, createCaptureState } from '../src/capture/capturePort.js';
import { captureRowsFor } from '../src/recording/recordingModel.js';
import {
  panelComponent,
  mutantPanelComponent,
  mountPanel,
  panelFlush,
  panelById,
  fakeStore,
  sealedRow,
} from './mvui16-harness.mjs';

const T0 = Date.now();
const HISTORY_LIMIT = 8;
const SETTLE_TRIES = 40;

/** Deterministic manifest row factory (host-validated shape). */
function recRow(id, surface, phase = 'sealed', kind = 'recording') {
  return {
    id, kind, surface_id: surface, phase, frames: 3, duration_ms: 30,
    sealed: phase === 'sealed', created_ms: 9,
  };
}

/** Bounded scripted facade: list calls counted, history capped. */
function scripted(handlers = {}) {
  const calls = { list: 0, subscribe: 0 };
  const listHistory = [];
  const listeners = new Set();
  const facade = {
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
    subscribe(cb) {
      calls.subscribe += 1;
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    emit(event) {
      for (const cb of [...listeners]) cb(event);
    },
  };
  return facade;
}

function sealedEvent(recordingId, surfaceId) {
  return {
    type: 'capture.state', recording_id: recordingId, surface_id: surfaceId,
    phase: 'sealed', frames: 3, elapsed_ms: 30,
  };
}

/** Bounded settle: poll a condition across setImmediate ticks. */
async function settleUntil(cond, tries = SETTLE_TRIES) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (cond()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return cond();
}

let mutantPortSerial = 0;
async function mutantCapturePort(mutate) {
  const url = new URL('../src/capture/capturePort.js', import.meta.url);
  const original = readFileSync(url, 'utf8');
  const changed = mutate(original);
  assert.notEqual(changed, original, 'negative control must change the source');
  const require = createRequire(import.meta.url);
  const code = changed
    .replace(`from 'vue'`, `from ${JSON.stringify(pathToFileURL(require.resolve('vue')).href)}`)
    .replace(`from '../recording/recordingModel.js'`,
      `from ${JSON.stringify(new URL('../src/recording/recordingModel.js', import.meta.url).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui16dport${mutantPortSerial++}`);
}

let panelCached = null;
async function panel() {
  if (panelCached === null) panelCached = await panelComponent();
  return panelCached;
}

const mountProps = (capsuleId, captureState) => ({
  capsuleId, captureState, captureAvailable: true, exportDestination: '',
});

describe('coalesced refresh widens on filter mismatch (note 1)', () => {
  test('queued run widens to the full list when a second surface coalesces', async () => {
    let release;
    const pending = new Promise((done) => { release = done; });
    let calls = 0;
    const facade = scripted({
      list: () => {
        calls += 1;
        if (calls === 1) return pending;
        return { ok: true, rows: [recRow('a1', 'A'), recRow('b1', 'B')] };
      },
    });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const first = state.refresh('A');
      const queuedA = state.refresh('A');
      const queuedB = state.refresh('B');
      await panelFlush();
      assert.equal(facade.calls.list, 1, 'one in flight while the first pends');
      release({ ok: true, rows: [recRow('a1', 'A')] });
      const [r1, r2, r3] = await Promise.all([first, queuedA, queuedB]);
      assert.equal(facade.calls.list, 2, 'exactly one queued follow-up');
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal(r3.ok, true);
      assert.deepEqual(state.rows.map((row) => row.id).sort(), ['a1', 'b1'],
        'widened queued run keeps both surfaces');
      assert.equal(captureRowsFor(state, 'B').length, 1);
      assert.ok(facade.listHistory.length <= HISTORY_LIMIT, 'bounded list history');
    } finally { state.dispose(); }
  });

  test('negative control: mutant without widening drops the later surface', async () => {
    const mutant = await mutantCapturePort((source) => source.replace(
      '    } else if (filter === undefined || filter !== refreshQueuedFilter) {',
      '    } else if (filter === undefined) {'));
    let release;
    const pending = new Promise((done) => { release = done; });
    let calls = 0;
    const facade = scripted({
      list: () => {
        calls += 1;
        if (calls === 1) return pending;
        return { ok: true, rows: [recRow('a1', 'A'), recRow('b1', 'B')] };
      },
    });
    const state = mutant.createCaptureState(mutant.createCapturePort(facade));
    try {
      const first = state.refresh('A');
      const queuedA = state.refresh('A');
      const queuedB = state.refresh('B');
      await panelFlush();
      release({ ok: true, rows: [recRow('a1', 'A')] });
      await Promise.all([first, queuedA, queuedB]);
      assert.deepEqual(state.rows.map((row) => row.id), ['a1'],
        'mutant reproduces the dropped surface');
      assert.equal(captureRowsFor(state, 'B').length, 0);
    } finally { state.dispose(); }
  });

  test('negative control: coalesced callers for the SAME surface stay narrow', async () => {
    let rows = [recRow('b0', 'B')];
    let release;
    const pending = new Promise((done) => { release = done; });
    let calls = 0;
    const facade = scripted({
      list: () => {
        calls += 1;
        if (calls === 2) return pending;
        return { ok: true, rows };
      },
    });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      assert.deepEqual(state.rows.map((row) => row.id), ['b0']);
      const first = state.refresh('A');
      const queuedA = state.refresh('A');
      const queuedA2 = state.refresh('A');
      await panelFlush();
      assert.equal(facade.calls.list, 2, 'one in flight while the first pends');
      rows = [recRow('a2', 'A'), recRow('b9', 'B')];
      release({ ok: true, rows: [recRow('a1', 'A')] });
      await Promise.all([first, queuedA, queuedA2]);
      assert.equal(facade.calls.list, 3, 'exactly one queued follow-up');
      assert.deepEqual(state.rows.map((row) => row.id), ['a2', 'b0'],
        'narrow queued run keeps stored B rows and ignores fresh non-A rows');
    } finally { state.dispose(); }
  });
});

describe('mount lists unless the ACTIVE capsule has rows (note 2)', () => {
  test('mount on B after an A-only auto-refresh lists and shows B rows', async () => {
    const Panel = await panel();
    const facade = scripted({
      list: () => ({ ok: true, rows: [recRow('a1', 'A'), recRow('b1', 'B')] }),
    });
    const state = createCaptureState(createCapturePort(facade));
    facade.emit(sealedEvent('rec-9', 'A'));
    assert.equal(await settleUntil(() => facade.calls.list >= 1), true, 'auto-refresh lists');
    assert.equal(await settleUntil(() => state.rows.length === 1), true, 'A row stored');
    assert.equal(state.rows[0].surface_id, 'A', 'prior refresh stored A only');
    const before = facade.calls.list;
    const mounted = mountPanel(Panel, mountProps('B', state));
    try {
      assert.equal(await settleUntil(() => facade.calls.list > before), true, 'mount on B lists');
      assert.equal(await settleUntil(() => captureRowsFor(state, 'B').length === 1), true, 'B rows fill');
      await panelFlush();
      assert.ok(panelById(mounted, 'mv-recordings-select-b1'), 'B row renders');
      assert.equal(panelById(mounted, 'mv-recordings-select-a1'), undefined, 'A row filters out');
    } finally { mounted.close(); state.dispose(); }
  });

  test('negative control: mount skips the list when the ACTIVE capsule has rows', async () => {
    const Panel = await panel();
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('a1', 'A')] }) });
    const state = createCaptureState(createCapturePort(facade));
    assert.equal((await state.refresh()).ok, true);
    const before = facade.calls.list;
    const mounted = mountPanel(Panel, mountProps('A', state));
    try {
      await panelFlush();
      await panelFlush();
      assert.equal(facade.calls.list, before, 'populated mount never relists');
      assert.ok(panelById(mounted, 'mv-recordings-select-a1'));
    } finally { mounted.close(); state.dispose(); }
  });

  test('negative control: mutant with the any-rows guard suppresses the B mount', async () => {
    const Panel = await mutantPanelComponent((source) => source.replace(
      '  if (!Array.isArray(store.rows)) return;\n  if (hasActiveCapsuleRows(store)) return;',
      '  if (!Array.isArray(store.rows) || store.rows.length > 0) return;'));
    const facade = scripted({
      list: () => ({ ok: true, rows: [recRow('a1', 'A'), recRow('b1', 'B')] }),
    });
    const state = createCaptureState(createCapturePort(facade));
    facade.emit(sealedEvent('rec-9', 'A'));
    assert.equal(await settleUntil(() => state.rows.length === 1), true, 'A row stored');
    const before = facade.calls.list;
    const mounted = mountPanel(Panel, mountProps('B', state));
    try {
      await panelFlush();
      await panelFlush();
      assert.equal(facade.calls.list, before, 'mutant reproduces the suppression');
      assert.equal(panelById(mounted, 'mv-recordings-select-b1'), undefined);
    } finally { mounted.close(); state.dispose(); }
  });
});

describe('store swap relists an empty listable store (note 3)', () => {
  test('captureState swap to an empty listable store triggers a list', async () => {
    const Panel = await panel();
    const facade1 = scripted({ list: () => ({ ok: true, rows: [recRow('a1', 'A')] }) });
    const state1 = createCaptureState(createCapturePort(facade1));
    const mounted = mountPanel(Panel, mountProps('A', state1));
    try {
      assert.equal(await settleUntil(() => facade1.calls.list >= 1), true, 'mount lists store1');
      assert.equal(await settleUntil(() => state1.rows.length === 1), true, 'store1 rows fill');
      await panelFlush();
      assert.ok(panelById(mounted, 'mv-recordings-select-a1'));
      const facade2 = scripted({ list: () => ({ ok: true, rows: [recRow('a2', 'A')] }) });
      const state2 = createCaptureState(createCapturePort(facade2));
      try {
        mounted.props.captureState = state2;
        assert.equal(await settleUntil(() => facade2.calls.list >= 1), true, 'swap lists store2');
        assert.equal(await settleUntil(() => state2.rows.length === 1), true, 'store2 rows fill');
        await panelFlush();
        assert.ok(panelById(mounted, 'mv-recordings-select-a2'), 'new store row renders');
      } finally { state2.dispose(); }
    } finally { mounted.close(); state1.dispose(); }
  });

  test('negative control: swap to a store holding active-capsule rows never lists', async () => {
    const Panel = await panel();
    const facade1 = scripted({ list: () => ({ ok: true, rows: [recRow('a1', 'A')] }) });
    const state1 = createCaptureState(createCapturePort(facade1));
    const mounted = mountPanel(Panel, mountProps('A', state1));
    try {
      assert.equal(await settleUntil(() => state1.rows.length === 1), true, 'store1 rows fill');
      const facade2 = scripted({ list: () => ({ ok: true, rows: [recRow('a2', 'A')] }) });
      const state2 = createCaptureState(createCapturePort(facade2));
      try {
        assert.equal((await state2.refresh()).ok, true);
        const before = facade2.calls.list;
        mounted.props.captureState = state2;
        await panelFlush();
        await panelFlush();
        assert.equal(facade2.calls.list, before, 'populated swap never relists');
        await panelFlush();
        assert.ok(panelById(mounted, 'mv-recordings-select-a2'));
      } finally { state2.dispose(); }
    } finally { mounted.close(); state1.dispose(); }
  });

  test('negative control: swap to a static fake or null never lists and never throws', async () => {
    const Panel = await panel();
    const facade1 = scripted({ list: () => ({ ok: true, rows: [recRow('a1', 'A')] }) });
    const state1 = createCaptureState(createCapturePort(facade1));
    const mounted = mountPanel(Panel, mountProps('A', state1));
    try {
      assert.equal(await settleUntil(() => state1.rows.length === 1), true, 'store1 rows fill');
      const fake = fakeStore({ rows: [sealedRow('f1', 'A')] });
      mounted.props.captureState = fake;
      await panelFlush();
      await panelFlush();
      assert.deepEqual(fake.calls, [], 'static fake untouched');
      mounted.props.captureState = null;
      await panelFlush();
      assert.ok(panelById(mounted, 'mv-recordings-select-a1') === undefined, 'unbound view clears');
    } finally { mounted.close(); state1.dispose(); }
  });

  test('negative control: mutant without the swap watcher never lists on swap', async () => {
    const Panel = await mutantPanelComponent((source) => source.replace(
      'watch(() => props.captureState, (next) => {\n'
      + '  if (typeof next?.refresh !== \'function\') return;\n'
      + '  if (typeof next?.port?.list !== \'function\') return;\n'
      + '  if (hasActiveCapsuleRows(next)) return;\n'
      + '  requestListRefresh();\n'
      + '});',
      ''));
    const facade1 = scripted({ list: () => ({ ok: true, rows: [recRow('a1', 'A')] }) });
    const state1 = createCaptureState(createCapturePort(facade1));
    const mounted = mountPanel(Panel, mountProps('A', state1));
    try {
      assert.equal(await settleUntil(() => state1.rows.length === 1), true, 'store1 rows fill');
      const facade2 = scripted({ list: () => ({ ok: true, rows: [recRow('a2', 'A')] }) });
      const state2 = createCaptureState(createCapturePort(facade2));
      try {
        mounted.props.captureState = state2;
        await panelFlush();
        await panelFlush();
        assert.equal(facade2.calls.list, 0, 'mutant reproduces the silence');
      } finally { state2.dispose(); }
    } finally { mounted.close(); state1.dispose(); }
  });
});

test('mvui16d memory ceiling and file budget', () => {
  const rss = process.memoryUsage().rss;
  if (process.env.MVUI16_MEASURE) console.log(`mvui16d-rec-coalesce rss MiB: ${Math.round(rss / 1048576)}`);
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  assert.ok(Date.now() - T0 < 10000, 'test file finishes in < 10 s');
});
