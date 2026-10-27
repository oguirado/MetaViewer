// MVUI19 lane C (EVUI-07): capture refresh returns capped stored rows,
// resolves unavailable on post-dispose reject, and keeps unseen-surface
// rows when merging. Bounded fakes plus negative controls.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_ROWS_CAP,
  createCapturePort,
  createCaptureState,
} from '../src/capture/capturePort.js';

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

describe('EVUI-07 refresh returns capped stored rows', () => {
  test('100-row refresh returns 64 capped rows matching state', async () => {
    assert.equal(CAPTURE_ROWS_CAP, 64);
    const rows = [];
    for (let i = 0; i < 100; i += 1) rows.push(recRow(`rec-${i}`, 's1'));
    const facade = scripted({ list: () => ({ ok: true, rows }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const res = await state.refresh();
      assert.equal(res.ok, true);
      assert.equal(res.rows.length, 64, 'return value capped like state');
      assert.equal(state.rows.length, 64);
      assert.equal(res.rows[0].id, 'rec-0');
      assert.equal(res.rows[63].id, 'rec-63');
      assert.deepEqual(res.rows.map((r) => r.id), state.rows.map((r) => r.id));
      assert.ok(Object.isFrozen(res) && Object.isFrozen(res.rows));
    } finally { state.dispose(); }
  });

  test('negative control: unfiltered ordering and cap unchanged', async () => {
    const rows = [];
    for (let i = 0; i < 70; i += 1) rows.push(recRow(`rec-${i}`, 'wall-1'));
    const facade = scripted({ list: () => ({ ok: true, rows }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const res = await state.refresh();
      assert.equal(res.ok, true);
      assert.equal(state.rows.length, 64);
      assert.equal(state.rows[0].id, 'rec-0');
      assert.equal(state.rows[63].id, 'rec-63');
    } finally { state.dispose(); }
  });
});

describe('EVUI-07 filtered refresh keeps unseen-surface rows', () => {
  test('filtered refresh from empty keeps fresh other-surface rows', async () => {
    const facade = scripted({ list: () => ({ ok: true, rows: [recRow('b1', 's-other')] }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal(state.rows.length, 0);
      const res = await state.refresh('s1');
      assert.equal(res.ok, true);
      assert.deepEqual(state.rows.map((r) => r.id), ['b1'], 'unseen rows kept, not dropped');
      assert.deepEqual(res.rows.map((r) => r.id), ['b1']);
    } finally { state.dispose(); }
  });

  test('negative control: stored surfaces keep stored rows, fresh dupes dropped', async () => {
    let rows = [recRow('a1', 'A'), recRow('a2', 'A'), recRow('b1', 'B')];
    const facade = scripted({ list: () => ({ ok: true, rows }) });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.refresh()).ok, true);
      rows = [recRow('a3', 'A'), recRow('b2', 'B')];
      const res = await state.refresh('A');
      assert.equal(res.ok, true);
      assert.deepEqual(state.rows.map((r) => r.id), ['a3', 'b1'],
        'fresh A first, stored B kept, fresh B2 dropped (stable surfaces)');
    } finally { state.dispose(); }
  });
});

describe('EVUI-07 post-dispose reject resolves unavailable', () => {
  test('dispose during pending list then reject resolves unavailable', async () => {
    let rejectList = () => {};
    const pending = new Promise((_res, rej) => { rejectList = rej; });
    const stubPort = {
      available: true,
      async screenshot() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
      async recordStart() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
      async recordStop() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
      list: () => pending,
      subscribe() { return () => {}; },
    };
    const state = createCaptureState(/** @type {any} */ (stubPort));
    const first = state.refresh();
    state.dispose();
    rejectList(new Error('HOST_GONE'));
    const res = await first;
    assert.deepEqual(res, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.equal(state.rows.length, 0);
    state.dispose();
  });

  test('negative control: pre-dispose reject still throws', async () => {
    const badPort = {
      available: true,
      async screenshot() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
      async recordStart() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
      async recordStop() { return { ok: false, code: 'CAPTURE_UNAVAILABLE' }; },
      async list() { throw new Error('HOST_GONE'); },
      subscribe() { return () => {}; },
    };
    const state = createCaptureState(/** @type {any} */ (badPort));
    try {
      await assert.rejects(() => state.refresh(), /HOST_GONE/, 'only post-dispose caught');
    } finally { state.dispose(); }
  });
});

test('mvui19-cap-refresh memory ceiling', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  assert.ok(Date.now() - T0 < 10000, 'test file finishes in < 10 s');
});
