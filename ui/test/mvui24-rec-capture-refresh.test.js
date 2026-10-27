// MVUI24 lane R (RV9-05): a filtered (per-surface) refresh merges fresh rows
// for that surface ahead of the kept rows for the other surfaces, so
// per-surface callers never drop rows they did not ask about. Stored rows
// merge BEFORE unseen-surface seeding, and seeding only fills remaining
// capacity when no fresh row named the filter (EVUI-07 empty-seed kept).
// Bounded fakes plus negative controls.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_ROWS_CAP,
  createCapturePort,
  createCaptureState,
} from '../src/capture/capturePort.js';
import { tick } from './frame-wait.mjs';

const T0 = Date.now();
const HISTORY_LIMIT = 8;

function recRow(id, surface, phase = 'sealed', kind = 'recording') {
  return {
    id, kind, surface_id: surface, phase, frames: 3, duration_ms: 30,
    sealed: phase === 'sealed', created_ms: 9,
  };
}

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
  };
  return facade;
}

describe('RV9-05 filtered refresh retains stored rows at cap', () => {
  test('filtered refresh for an empty surface retains 64 stored rows', async () => {
    assert.equal(CAPTURE_ROWS_CAP, 64);
    const stored = [];
    for (let i = 0; i < 64; i += 1) stored.push(recRow(`stored-${i}`, 'surf-stored'));
    const unseen = [];
    for (let i = 0; i < 64; i += 1) unseen.push(recRow(`unseen-${i}`, 'surf-unseen'));
    let reply = stored;
    const facade = scripted({ list: () => ({ ok: true, rows: reply }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      assert.equal(state.rows.length, 64);
      reply = unseen;
      const res = await state.refresh('surf-empty');
      await tick();
      assert.equal(res.ok, true);
      assert.equal(state.rows.length, 64, 'cap kept');
      assert.deepEqual(
        state.rows.map((row) => row.id),
        stored.map((row) => row.id),
        'stored rows of unfiltered surfaces survive a no-match refresh',
      );
    } finally { state.dispose(); }
  });

  test('partial store keeps stored rows first, unseen fills the remainder', async () => {
    const stored = [recRow('kept-0', 'surf-stored'), recRow('kept-1', 'surf-stored')];
    const unseen = [];
    for (let i = 0; i < 70; i += 1) unseen.push(recRow(`fresh-${i}`, 'surf-unseen'));
    let reply = stored;
    const facade = scripted({ list: () => ({ ok: true, rows: reply }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      reply = unseen;
      const res = await state.refresh('surf-empty');
      await tick();
      assert.equal(res.ok, true);
      assert.equal(state.rows.length, 64, 'cap kept');
      assert.deepEqual(
        state.rows.slice(0, 2).map((row) => row.id),
        ['kept-0', 'kept-1'],
        'stored rows merge ahead of unseen fills',
      );
      assert.equal(state.rows[2].id, 'fresh-0', 'remaining capacity seeds unseen rows');
    } finally { state.dispose(); }
  });
});

describe('RV9-05 negative controls', () => {
  test('unfiltered refresh still replaces every row at cap', async () => {
    const rows = [];
    for (let i = 0; i < 70; i += 1) rows.push(recRow(`rec-${i}`, 'wall-1'));
    const facade = scripted({ list: () => ({ ok: true, rows }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const res = await state.refresh();
      await tick();
      assert.equal(res.ok, true);
      assert.equal(state.rows.length, 64);
      assert.equal(state.rows[0].id, 'rec-0');
      assert.equal(state.rows[63].id, 'rec-63');
    } finally { state.dispose(); }
  });

  test('empty store still seeds unseen rows on a no-match filtered refresh', async () => {
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('b1', 's-other')] }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal(state.rows.length, 0);
      const res = await state.refresh('s1');
      await tick();
      assert.equal(res.ok, true);
      assert.deepEqual(state.rows.map((row) => row.id), ['b1'], 'EVUI-07 empty-seed kept');
    } finally { state.dispose(); }
  });

  test('filter-matched refresh stays narrow and ignores unseen rows', async () => {
    let reply = [recRow('b0', 'B')];
    const facade = scripted({ list: () => ({ ok: true, rows: reply }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      reply = [recRow('a1', 'A'), recRow('c1', 'C-unseen')];
      const res = await state.refresh('A');
      await tick();
      assert.equal(res.ok, true);
      assert.deepEqual(
        state.rows.map((row) => row.id),
        ['a1', 'b0'],
        'fresh filter rows plus kept stored rows only',
      );
    } finally { state.dispose(); }
  });

  test('refusal still keeps the previous rows', async () => {
    let flip = true;
    const facade = scripted({
      list: () => (flip
        ? { ok: true, rows: [recRow('rec-1', 'wall-1')] }
        : { ok: false, code: 'LIMIT' }),
    });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      flip = false;
      assert.deepEqual(await state.refresh('wall-1'), { ok: false, code: 'LIMIT' });
      await tick();
      assert.deepEqual(state.rows.map((row) => row.id), ['rec-1']);
    } finally { state.dispose(); }
  });
});

test('mvui24-rec-capture-refresh memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  assert.ok(Date.now() - T0 < 10000, 'test file finishes in < 10 s');
});
