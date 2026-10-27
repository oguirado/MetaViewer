// Lane C capture port + reactive state: closed codes, shape-checked replies,
// deterministic request ids, single subscription, dispose. Negative control:
// a contract-violating double is detected by the same acceptance check.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isReactive } from 'vue';
import {
  CAPTURE_REFUSAL_CODES,
  CAPTURE_SCHEMA,
  createCapturePort,
  createCaptureState,
} from '../src/capture/capturePort.js';
import { createCaptureDouble } from '../src/capture/captureDouble.js';
import { MV_RECORDING_PHASES } from '../src/recording/recordingModel.js';

/** Scripted facade: per-method handlers plus subscribe plumbing. */
function scripted(handlers = {}) {
  const calls = { screenshot: [], recordStart: [], recordStop: [], list: 0, subscribe: 0, unsubscribe: 0 };
  const listeners = new Set();
  const facade = {
    calls,
    listeners,
    async screenshot(request) {
      calls.screenshot.push(request);
      return handlers.screenshot ? handlers.screenshot(request) : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    async recordStart(request) {
      calls.recordStart.push(request);
      return handlers.recordStart ? handlers.recordStart(request) : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    async recordStop(request) {
      calls.recordStop.push(request);
      return handlers.recordStop ? handlers.recordStop(request) : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    async list() {
      calls.list += 1;
      return handlers.list ? handlers.list() : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    subscribe(cb) {
      calls.subscribe += 1;
      listeners.add(cb);
      return () => {
        calls.unsubscribe += 1;
        listeners.delete(cb);
      };
    },
  };
  return facade;
}

function healthyHandlers() {
  return {
    screenshot: (request) => ({
      ok: true,
      shot: {
        id: 'shot-1', surface_id: request.surface_id, width: 64, height: 48,
        sha256: 'a'.repeat(64), created_ms: 11,
      },
    }),
    recordStart: () => ({ ok: true, recording_id: 'rec-1' }),
    recordStop: (request) => ({
      ok: true,
      recording: {
        id: request.recording_id, surface_id: 'wall-1', frames: 3,
        duration_ms: 30, sealed: true, sha256: 'b'.repeat(64),
      },
    }),
    list: () => ({
      ok: true,
      rows: [{
        id: 'rec-1', kind: 'recording', surface_id: 'wall-1', phase: 'sealed',
        frames: 3, duration_ms: 30, sealed: true, created_ms: 9,
      }],
    }),
  };
}

/** Acceptance check: passes only against a contract-honouring facade. */
async function expectHealthyCapture(port) {
  assert.equal(port.available, true);
  const shot = await port.screenshot('wall-1');
  assert.equal(shot.ok, true);
  assert.equal(shot.shot.surface_id, 'wall-1');
  const started = await port.recordStart('wall-1');
  assert.equal(started.ok, true);
  assert.ok(started.recording_id.length > 0);
  const stopped = await port.recordStop(started.recording_id);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.recording.sealed, true);
  const listed = await port.list();
  assert.equal(listed.ok, true);
  assert.ok(Array.isArray(listed.rows));
  let seen = 0;
  const off = port.subscribe(() => { seen += 1; });
  assert.equal(typeof off, 'function');
  off();
  assert.equal(seen, 0);
}

describe('capture port construction', () => {
  test('port is frozen and available over a full facade', () => {
    const port = createCapturePort(createCaptureDouble());
    assert.ok(Object.isFrozen(port));
    assert.equal(port.available, true);
    for (const name of ['screenshot', 'recordStart', 'recordStop', 'list', 'subscribe']) {
      assert.equal(typeof port[name], 'function', name);
    }
  });

  test('missing or partial facade reports unavailable, never throws', () => {
    for (const facade of [undefined, null, {}, { list() {} }, { screenshot() {}, recordStart() {}, recordStop() {}, list() {} }]) {
      const port = createCapturePort(facade);
      assert.equal(port.available, false);
      assert.equal(typeof port.subscribe(() => {}), 'function');
    }
  });

  test('closed refusal set matches the host contract', () => {
    assert.deepEqual([...CAPTURE_REFUSAL_CODES].sort(),
      ['ALREADY_RECORDING', 'CAPTURE_UNAVAILABLE', 'LIMIT', 'NESTED_DISPLAY_ONLY', 'NOT_RECORDING', 'SURFACE_UNKNOWN']);
    assert.ok(Object.isFrozen(CAPTURE_REFUSAL_CODES));
    assert.equal(CAPTURE_SCHEMA, 'capture_request/v1');
  });
});

describe('capture request shape and deterministic ids', () => {
  test('requests carry schema, mode ai and deterministic per-port ids', async () => {
    const facade = scripted(healthyHandlers());
    const port = createCapturePort(facade);
    await port.screenshot('wall-1');
    await port.recordStart('wall-2');
    await port.recordStop('rec-1');
    assert.deepEqual(facade.calls.screenshot[0],
      { schema: 'capture_request/v1', request_id: 'mv-capture-1', surface_id: 'wall-1' });
    assert.deepEqual(facade.calls.recordStart[0],
      { schema: 'capture_request/v1', request_id: 'mv-capture-2', surface_id: 'wall-2', mode: 'ai' });
    assert.deepEqual(facade.calls.recordStop[0],
      { schema: 'capture_request/v1', request_id: 'mv-capture-3', recording_id: 'rec-1' });
    for (const id of ['mv-capture-1', 'mv-capture-2', 'mv-capture-3']) {
      assert.ok(id.length <= 64 && /^[\x20-\x7E]+$/.test(id), id);
    }
  });

  test('fresh ports restart the identical id sequence (no randomness)', async () => {
    const first = scripted(healthyHandlers());
    const second = scripted(healthyHandlers());
    const portA = createCapturePort(first);
    await portA.screenshot('a');
    await portA.recordStart('a');
    const portB = createCapturePort(second);
    await portB.screenshot('a');
    await portB.recordStart('a');
    assert.deepEqual(
      [first.calls.screenshot[0].request_id, first.calls.recordStart[0].request_id],
      [second.calls.screenshot[0].request_id, second.calls.recordStart[0].request_id]);
    assert.deepEqual(
      [first.calls.screenshot[0].request_id, first.calls.recordStart[0].request_id],
      ['mv-capture-1', 'mv-capture-2']);
  });

  test('invalid caller ids resolve unavailable without touching the facade', async () => {
    const facade = scripted(healthyHandlers());
    const port = createCapturePort(facade);
    for (const bad of [undefined, null, '', 7, {}, []]) {
      const shot = await port.screenshot(bad);
      const started = await port.recordStart(bad);
      const stopped = await port.recordStop(bad);
      assert.deepEqual(shot, { ok: false, code: 'CAPTURE_UNAVAILABLE' }, String(bad));
      assert.deepEqual(started, { ok: false, code: 'CAPTURE_UNAVAILABLE' }, String(bad));
      assert.deepEqual(stopped, { ok: false, code: 'CAPTURE_UNAVAILABLE' }, String(bad));
    }
    assert.equal(facade.calls.screenshot.length, 0);
    assert.equal(facade.calls.recordStart.length, 0);
    assert.equal(facade.calls.recordStop.length, 0);
  });
});

describe('capture refusals pass through per closed code', () => {
  for (const code of ['SURFACE_UNKNOWN', 'ALREADY_RECORDING', 'NOT_RECORDING', 'CAPTURE_UNAVAILABLE', 'NESTED_DISPLAY_ONLY', 'LIMIT']) {
    test(`refusal ${code} passes through on every method`, async () => {
      const facade = scripted({
        screenshot: (request) => ({ ok: false, code, request_id: request.request_id }),
        recordStart: (request) => ({ ok: false, code, request_id: request.request_id }),
        recordStop: (request) => ({ ok: false, code, request_id: request.request_id }),
        list: () => ({ ok: false, code }),
      });
      const port = createCapturePort(facade);
      assert.deepEqual(await port.screenshot('wall-1'), { ok: false, code });
      assert.deepEqual(await port.recordStart('wall-1'), { ok: false, code });
      assert.deepEqual(await port.recordStop('rec-1'), { ok: false, code });
      assert.deepEqual(await port.list(), { ok: false, code });
    });
  }

  test('unknown or missing refusal codes fail closed', async () => {
    for (const code of ['BOGUS', '', null, 7, undefined, 'lowercase']) {
      const facade = scripted({ screenshot: () => ({ ok: false, code }) });
      const port = createCapturePort(facade);
      assert.deepEqual(await port.screenshot('wall-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' }, String(code));
    }
  });

  test('results are frozen on both ok and refusal paths', async () => {
    const port = createCapturePort(scripted(healthyHandlers()));
    const shot = await port.screenshot('wall-1');
    assert.ok(Object.isFrozen(shot) && Object.isFrozen(shot.shot));
    const listed = await port.list();
    assert.ok(Object.isFrozen(listed) && Object.isFrozen(listed.rows) && Object.isFrozen(listed.rows[0]));
    const down = createCapturePort(undefined);
    assert.ok(Object.isFrozen(await down.screenshot('wall-1')));
  });
});

describe('capture malformed replies map to unavailable', () => {
  const malformed = [null, undefined, 7, 'x', [], {}, { ok: true }, { ok: 'yes' }, { ok: 1 }, []];
  test('malformed screenshot replies never throw into callers', async () => {
    const badShots = [...malformed,
      { ok: true, shot: null },
      { ok: true, shot: { id: 's', surface_id: 'w', width: 0, height: 8, sha256: 'a', created_ms: 1 } },
      { ok: true, shot: { id: 's', surface_id: 'w', width: 8, height: -1, sha256: 'a', created_ms: 1 } },
      { ok: true, shot: { id: '', surface_id: 'w', width: 8, height: 8, sha256: 'a', created_ms: 1 } },
      { ok: true, shot: { id: 's', surface_id: 'w', width: 8, height: 8, sha256: '', created_ms: 1 } },
      { ok: true, shot: { id: 's', surface_id: 'w', width: 8, height: 8, sha256: 'a', created_ms: -5 } },
      { ok: true, shot: { id: 's', surface_id: 'w', width: 8.5, height: 8, sha256: 'a', created_ms: 1 } },
    ];
    for (const reply of badShots) {
      const port = createCapturePort(scripted({ screenshot: () => reply }));
      const result = await port.screenshot('wall-1');
      assert.deepEqual(result, { ok: false, code: 'CAPTURE_UNAVAILABLE' }, JSON.stringify(reply));
    }
  });

  test('malformed recordStart/recordStop replies never throw into callers', async () => {
    for (const reply of [...malformed, { ok: true }, { ok: true, recording_id: '' }, { ok: true, recording_id: 7 }]) {
      const port = createCapturePort(scripted({ recordStart: () => reply }));
      assert.deepEqual(await port.recordStart('wall-1'),
        { ok: false, code: 'CAPTURE_UNAVAILABLE' }, JSON.stringify(reply));
    }
    const badStops = [...malformed,
      { ok: true, recording: null },
      { ok: true, recording: { id: 'r', surface_id: 'w', frames: 1, duration_ms: 2, sealed: false, sha256: 'a' } },
      { ok: true, recording: { id: 'r', surface_id: 'w', frames: -1, duration_ms: 2, sealed: true, sha256: 'a' } },
      { ok: true, recording: { id: 'r', surface_id: '', frames: 1, duration_ms: 2, sealed: true, sha256: 'a' } },
    ];
    for (const reply of badStops) {
      const port = createCapturePort(scripted({ recordStop: () => reply }));
      assert.deepEqual(await port.recordStop('rec-1'),
        { ok: false, code: 'CAPTURE_UNAVAILABLE' }, JSON.stringify(reply));
    }
  });

  test('malformed list replies and rows never throw into callers', async () => {
    const goodRow = {
      id: 'rec-1', kind: 'recording', surface_id: 'w', phase: 'sealed',
      frames: 1, duration_ms: 2, sealed: true, created_ms: 3,
    };
    const badRows = [
      null, {},
      { ...goodRow, kind: 'clip' },
      { ...goodRow, phase: 'archived' },
      { ...goodRow, sealed: 'yes' },
      { ...goodRow, frames: -1 },
      { ...goodRow, id: '' },
    ];
    for (const reply of [...malformed, { ok: true, rows: null }, { ok: true, rows: {} }]) {
      const port = createCapturePort(scripted({ list: () => reply }));
      assert.deepEqual(await port.list(), { ok: false, code: 'CAPTURE_UNAVAILABLE' }, JSON.stringify(reply));
    }
    for (const row of badRows) {
      const port = createCapturePort(scripted({ list: () => ({ ok: true, rows: [goodRow, row] }) }));
      assert.deepEqual(await port.list(), { ok: false, code: 'CAPTURE_UNAVAILABLE' }, JSON.stringify(row));
    }
  });

  test('every MV_RECORDING_PHASES row phase is accepted', async () => {
    for (const phase of MV_RECORDING_PHASES) {
      const port = createCapturePort(scripted({
        list: () => ({
          ok: true,
          rows: [{
            id: 'r', kind: 'recording', surface_id: 'w', phase,
            frames: 0, duration_ms: 0, sealed: false, created_ms: 0,
          }],
        }),
      }));
      const result = await port.list();
      assert.equal(result.ok, true, phase);
    }
  });

  test('throwing or rejecting hosts resolve unavailable, never reject', async () => {
    const bomb = () => { throw new Error('host blew up'); };
    const rejecter = async () => { throw new Error('host rejected'); };
    for (const handlers of [
      { screenshot: bomb, recordStart: bomb, recordStop: bomb, list: bomb },
      { screenshot: rejecter, recordStart: rejecter, recordStop: rejecter, list: rejecter },
    ]) {
      const port = createCapturePort(scripted(handlers));
      await assert.doesNotReject(port.screenshot('w'));
      assert.deepEqual(await port.screenshot('w'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
      assert.deepEqual(await port.recordStart('w'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
      assert.deepEqual(await port.recordStop('r'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
      assert.deepEqual(await port.list(), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    }
  });
});

describe('capture subscribe boundary', () => {
  test('valid events forward, malformed events are dropped', () => {
    const facade = scripted(healthyHandlers());
    const port = createCapturePort(facade);
    const seen = [];
    const off = port.subscribe((event) => seen.push(event));
    const emit = [...facade.listeners][0];
    emit({
      type: 'capture.state', recording_id: 'rec-1', surface_id: 'wall-1',
      phase: 'recording', frames: 4, elapsed_ms: 120,
    });
    for (const bad of [null, {}, { type: 'capture.state' },
      { type: 'capture.state', recording_id: '', surface_id: 'w', phase: 'recording', frames: 0, elapsed_ms: 0 },
      { type: 'capture.state', recording_id: 'r', surface_id: 'w', phase: 'archived', frames: 0, elapsed_ms: 0 },
      { type: 'capture.state', recording_id: 'r', surface_id: 'w', phase: 'recording', frames: -1, elapsed_ms: 0 },
      { type: 'other', recording_id: 'r', surface_id: 'w', phase: 'recording', frames: 0, elapsed_ms: 0 }]) {
      emit(bad);
    }
    assert.equal(seen.length, 1);
    assert.ok(Object.isFrozen(seen[0]));
    off();
    assert.equal(facade.listeners.size, 0);
    for (const live of [...facade.listeners]) {
      live({
        type: 'capture.state', recording_id: 'rec-2', surface_id: 'wall-1',
        phase: 'recording', frames: 0, elapsed_ms: 0,
      });
    }
    assert.equal(seen.length, 1);
  });

  test('subscribe degrades to a safe noop without a facade or listener', () => {
    const down = createCapturePort(undefined);
    assert.equal(typeof down.subscribe(() => {}), 'function');
    down.subscribe(() => {})();
    const port = createCapturePort(scripted(healthyHandlers()));
    for (const bad of [undefined, null, 7, 'x']) {
      assert.equal(typeof port.subscribe(bad), 'function');
      port.subscribe(bad)();
    }
  });

  test('throwing host subscribe/unsubscribe stays a safe noop', () => {
    const throwing = {
      screenshot: async () => ({ ok: false, code: 'LIMIT' }),
      recordStart: async () => ({ ok: false, code: 'LIMIT' }),
      recordStop: async () => ({ ok: false, code: 'LIMIT' }),
      list: async () => ({ ok: false, code: 'LIMIT' }),
      subscribe: () => { throw new Error('no events'); },
    };
    const port = createCapturePort(throwing);
    assert.equal(typeof port.subscribe(() => {}), 'function');
    port.subscribe(() => {})();
    const evilOff = {
      ...throwing,
      subscribe: () => () => { throw new Error('sticky'); },
    };
    const port2 = createCapturePort(evilOff);
    assert.doesNotThrow(() => port2.subscribe(() => {})());
  });
});

describe('capture acceptance and negative control', () => {
  test('healthy double passes the acceptance check', async () => {
    await expectHealthyCapture(createCapturePort(createCaptureDouble()));
  });

  test('negative control: contract-violating double fails the acceptance check', async () => {
    const violator = {
      screenshot: async () => ({ ok: true }),
      recordStart: async () => ({ ok: false, code: 'BOGUS' }),
      recordStop: async () => ({ ok: true, recording: { sealed: 'eventually' } }),
      list: async () => ({ ok: true, rows: [{ kind: 'clip' }] }),
      subscribe: () => () => {},
    };
    await assert.rejects(expectHealthyCapture(createCapturePort(violator)));
  });
});

describe('capture reactive state', () => {
  test('construction requires a port and subscribes exactly once', () => {
    for (const bad of [undefined, null, {}, { list() {} }]) {
      assert.throws(() => createCaptureState(bad), TypeError);
    }
    const facade = scripted(healthyHandlers());
    const state = createCaptureState(createCapturePort(facade));
    assert.equal(facade.calls.subscribe, 1);
    assert.equal(state.available, true);
    assert.ok(isReactive(state));
    assert.ok(isReactive(state.bySurface));
    assert.ok(isReactive(state.rows));
    for (const name of ['toggleRecord', 'screenshot', 'refresh', 'dispose']) {
      assert.equal(typeof state[name], 'function', name);
    }
    assert.deepEqual(state.rows, []);
    assert.equal(state.bySurface['wall-1'], undefined);
    state.dispose();
  });

  test('toggleRecord starts then stops, driving the surface entry', async () => {
    const state = createCaptureState(createCapturePort(createCaptureDouble()));
    const started = await state.toggleRecord('wall-1');
    assert.equal(started.ok, true);
    assert.equal(state.bySurface['wall-1'].phase, 'recording');
    assert.equal(state.bySurface['wall-1'].recordingId, started.recording_id);
    assert.equal(state.bySurface['wall-1'].lastCode, '');
    const stopped = await state.toggleRecord('wall-1');
    assert.equal(stopped.ok, true);
    assert.equal(stopped.recording.sealed, true);
    assert.deepEqual({ ...state.bySurface['wall-1'] },
      { phase: 'idle', recordingId: null, frames: 0, elapsedMs: 0, lastShot: null, lastCode: '' });
    state.dispose();
  });

  test('toggleRecord refusal records lastCode and returns to idle', async () => {
    const state = createCaptureState(createCapturePort(createCaptureDouble({ nested: true })));
    const result = await state.toggleRecord('wall-1');
    assert.deepEqual(result, { ok: false, code: 'NESTED_DISPLAY_ONLY' });
    assert.equal(state.bySurface['wall-1'].phase, 'idle');
    assert.equal(state.bySurface['wall-1'].recordingId, null);
    assert.equal(state.bySurface['wall-1'].lastCode, 'NESTED_DISPLAY_ONLY');
    state.dispose();
  });

  test('stop-time NOT_RECORDING reconciles a stale entry', async () => {
    const facade = scripted({
      recordStart: () => ({ ok: true, recording_id: 'rec-9' }),
      recordStop: () => ({ ok: false, code: 'NOT_RECORDING' }),
    });
    const state = createCaptureState(createCapturePort(facade));
    assert.equal((await state.toggleRecord('wall-1')).ok, true);
    assert.equal(state.bySurface['wall-1'].recordingId, 'rec-9');
    const stopped = await state.toggleRecord('wall-1');
    assert.deepEqual(stopped, { ok: false, code: 'NOT_RECORDING' });
    assert.equal(state.bySurface['wall-1'].phase, 'idle');
    assert.equal(state.bySurface['wall-1'].recordingId, null);
    state.dispose();
  });

  test('screenshot stores lastShot on ok and keeps it across refusals', async () => {
    let flip = true;
    const facade = scripted({
      screenshot: (request) => (flip
        ? healthyHandlers().screenshot(request)
        : { ok: false, code: 'LIMIT' }),
    });
    const state = createCaptureState(createCapturePort(facade));
    const first = await state.screenshot('wall-1');
    assert.equal(first.ok, true);
    assert.equal(state.bySurface['wall-1'].lastShot.id, 'shot-1');
    assert.equal(state.bySurface['wall-1'].lastCode, '');
    flip = false;
    const second = await state.screenshot('wall-1');
    assert.deepEqual(second, { ok: false, code: 'LIMIT' });
    assert.equal(state.bySurface['wall-1'].lastShot.id, 'shot-1');
    assert.equal(state.bySurface['wall-1'].lastCode, 'LIMIT');
    state.dispose();
  });

  test('refresh replaces rows on ok and keeps them on refusal', async () => {
    let flip = true;
    const facade = scripted({
      list: () => (flip ? healthyHandlers().list() : { ok: false, code: 'LIMIT' }),
    });
    const state = createCaptureState(createCapturePort(facade));
    const first = await state.refresh();
    assert.equal(first.ok, true);
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].id, 'rec-1');
    flip = false;
    const second = await state.refresh();
    assert.deepEqual(second, { ok: false, code: 'LIMIT' });
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].id, 'rec-1');
    state.dispose();
  });

  test('host events apply per surface and clear terminal recordings', async () => {
    const double = createCaptureDouble();
    const port = createCapturePort(double);
    const state = createCaptureState(port);
    await port.recordStart('wall-1');
    await port.recordStart('wall-2');
    assert.equal(state.bySurface['wall-1'].phase, 'recording');
    assert.equal(state.bySurface['wall-2'].phase, 'recording');
    assert.notEqual(state.bySurface['wall-1'].recordingId, state.bySurface['wall-2'].recordingId);
    await port.recordStop(state.bySurface['wall-1'].recordingId);
    assert.equal(state.bySurface['wall-1'].phase, 'sealed');
    assert.equal(state.bySurface['wall-1'].recordingId, null);
    assert.equal(state.bySurface['wall-2'].phase, 'recording');
    state.dispose();
  });

  test('malformed host events never create entries', () => {
    const facade = scripted(healthyHandlers());
    const state = createCaptureState(createCapturePort(facade));
    const emit = [...facade.listeners][0];
    emit(null);
    emit({ type: 'capture.state', recording_id: 'r', surface_id: 'ghost', phase: 'archived', frames: 0, elapsed_ms: 0 });
    assert.equal(state.bySurface.ghost, undefined);
    assert.deepEqual(Object.keys(state.bySurface), []);
    state.dispose();
  });

  test('request ids stay deterministic through the store', async () => {
    const run = async () => {
      const facade = scripted(healthyHandlers());
      const state = createCaptureState(createCapturePort(facade));
      await state.toggleRecord('wall-1');
      await state.screenshot('wall-1');
      await state.refresh();
      state.dispose();
      return [
        ...facade.calls.recordStart.map((request) => request.request_id),
        ...facade.calls.screenshot.map((request) => request.request_id),
      ];
    };
    assert.deepEqual(await run(), ['mv-capture-1', 'mv-capture-2']);
    assert.deepEqual(await run(), ['mv-capture-1', 'mv-capture-2']);
  });

  test('dispose releases the single subscription and parks the store', async () => {
    const facade = scripted(healthyHandlers());
    const port = createCapturePort(facade);
    const state = createCaptureState(port);
    assert.equal(facade.calls.subscribe, 1);
    const emit = [...facade.listeners][0];
    state.dispose();
    state.dispose();
    assert.equal(facade.calls.unsubscribe, 1);
    assert.equal(facade.listeners.size, 0);
    emit({
      type: 'capture.state', recording_id: 'rec-1', surface_id: 'wall-1',
      phase: 'recording', frames: 9, elapsed_ms: 90,
    });
    assert.equal(state.bySurface['wall-1'], undefined);
    assert.deepEqual(await state.toggleRecord('wall-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.deepEqual(await state.screenshot('wall-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.deepEqual(await state.refresh(), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.equal(facade.calls.recordStart.length, 0);
    assert.equal(facade.calls.screenshot.length, 0);
    assert.equal(facade.calls.list, 0);
  });

  test('store over a missing facade stays usable and unavailable', async () => {
    const state = createCaptureState(createCapturePort(undefined));
    assert.equal(state.available, false);
    assert.deepEqual(await state.toggleRecord('wall-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.deepEqual(await state.screenshot('wall-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.deepEqual(await state.refresh(), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.equal(state.bySurface['wall-1'].lastCode, 'CAPTURE_UNAVAILABLE');
    state.dispose();
  });
});

describe('capture pending-call regressions', () => {
  for (const action of ['start', 'stop', 'screenshot', 'refresh']) {
    for (const ok of [true, false]) {
      test(`disposed pending ${action} (${ok ? 'success' : 'refusal'}) cannot mutate state`, async () => {
        let resolve;
        const pending = new Promise(done => { resolve = done; });
        const method = { start: 'recordStart', stop: 'recordStop', screenshot: 'screenshot', refresh: 'list' }[action];
        const handlers = healthyHandlers();
        const facade = scripted({ ...handlers, [method]: () => pending });
        const state = createCaptureState(createCapturePort(facade));
        try {
          if (action === 'stop') await state.toggleRecord('wall-1');
          const work = action === 'refresh' ? state.refresh()
            : action === 'screenshot' ? state.screenshot('wall-1') : state.toggleRecord('wall-1');
          state.dispose();
          const before = JSON.stringify({ bySurface: state.bySurface, rows: state.rows });
          resolve(ok ? handlers[method]({ surface_id: 'wall-1', recording_id: 'rec-1' })
            : { ok: false, code: 'LIMIT' });
          assert.deepEqual(await work, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
          assert.equal(JSON.stringify({ bySurface: state.bySurface, rows: state.rows }), before);
        } finally { state.dispose(); }
      });
    }
  }

  for (const action of ['start', 'stop']) {
    test(`pending ${action} refuses duplicate toggles without host calls`, async () => {
      let resolve;
      const pending = new Promise(done => { resolve = done; });
      const method = action === 'start' ? 'recordStart' : 'recordStop';
      const handlers = healthyHandlers();
      const facade = scripted({ ...handlers, [method]: () => pending });
      const state = createCaptureState(createCapturePort(facade));
      try {
        if (action === 'stop') await state.toggleRecord('wall-1');
        const work = state.toggleRecord('wall-1');
        assert.equal(state.bySurface['wall-1'].phase, action === 'start' ? 'starting' : 'stopping');
        const duplicate = state.toggleRecord('wall-1');
        resolve(handlers[method]({ recording_id: 'rec-1' }));
        assert.deepEqual(await duplicate, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
        await work;
        assert.equal(facade.calls[method].length, 1);
      } finally { state.dispose(); }
    });
  }

  for (const phase of ['starting', 'recording', 'stopping', 'sealed', 'error']) {
    test(`start reply preserves pending ${phase} event progress`, async () => {
      let resolve;
      const facade = scripted({ recordStart: () => new Promise(done => { resolve = done; }) });
      const state = createCaptureState(createCapturePort(facade));
      try {
        const work = state.toggleRecord('wall-1');
        [...facade.listeners][0]({ type: 'capture.state', recording_id: 'rec-1',
          surface_id: 'wall-1', phase, frames: 12, elapsed_ms: 120 });
        resolve({ ok: true, recording_id: 'rec-1' });
        await work;
        assert.equal(state.bySurface['wall-1'].phase, phase === 'starting' ? 'recording' : phase);
        assert.equal(state.bySurface['wall-1'].frames, 12);
        assert.equal(state.bySurface['wall-1'].elapsedMs, 120);
        assert.equal(state.bySurface['wall-1'].recordingId,
          ['sealed', 'error'].includes(phase) ? null : 'rec-1');
      } finally { state.dispose(); }
    });
  }
});
