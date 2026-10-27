// MVUI11 lane E: capture export port + reactive state. Closed export bodies,
// deterministic request ids, shape-checked receipts, disposed-store and
// concurrent-call guards. Negative control: malformed replies and hostile
// facades resolve to CAPTURE_UNAVAILABLE while the valid baseline passes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPORT_DESTINATION_TOKEN,
  EXPORT_REFUSAL_CODES,
  createCapturePort,
  createCaptureState,
} from '../src/capture/capturePort.js';
import { createCaptureDouble } from '../src/capture/captureDouble.js';

const DIGEST = 'c'.repeat(64);

function receipt(over = {}) {
  return { ok: true, export: { id: 'rec-1', bytes: 2048, sha256: DIGEST, ...over } };
}

/** Scripted facade with export call recording. */
function scripted(handlers = {}) {
  const calls = { screenshot: [], recordStart: [], recordStop: [], export: [], list: 0 };
  const listeners = new Set();
  return {
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
    async export(request) {
      calls.export.push(request);
      return handlers.export ? handlers.export(request) : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    async list() {
      calls.list += 1;
      return handlers.list ? handlers.list() : { ok: false, code: 'CAPTURE_UNAVAILABLE' };
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

describe('export request shape and deterministic ids', () => {
  test('export sends the exact closed body with the opaque token', async () => {
    const facade = scripted({ export: () => receipt() });
    const port = createCapturePort(facade);
    await port.screenshot('wall-1');
    const result = await port.exportCapture('rec-1');
    assert.equal(result.ok, true);
    assert.deepEqual(facade.calls.export, [{
      schema: 'capture_request/v1',
      request_id: 'mv-capture-2',
      capture_id: 'rec-1',
      destination: 'recording:configured',
    }]);
    assert.equal(EXPORT_DESTINATION_TOKEN, 'recording:configured');
  });

  test('invalid capture ids resolve unavailable without touching the facade', async () => {
    const facade = scripted({ export: () => receipt() });
    const port = createCapturePort(facade);
    for (const bad of [undefined, null, '', 7, {}, []]) {
      assert.deepEqual(await port.exportCapture(bad), { ok: false, code: 'CAPTURE_UNAVAILABLE' }, String(bad));
    }
    assert.equal(facade.calls.export.length, 0);
    // Negative control: no id was consumed — the next valid call is mv-capture-1.
    await port.exportCapture('rec-1');
    assert.equal(facade.calls.export[0].request_id, 'mv-capture-1');
  });

  test('export code set matches the host contract and stays frozen', () => {
    assert.deepEqual([...EXPORT_REFUSAL_CODES].sort(), [...[
      'CAPTURE_UNAVAILABLE',
      'CAPTURE_UNKNOWN',
      'DESTINATION_EXISTS',
      'DESTINATION_UNAVAILABLE',
      'DESTINATION_UNSET',
      'LIMIT',
      'NESTED_DISPLAY_ONLY',
      'NOT_SEALED',
    ]].sort());
    assert.ok(Object.isFrozen(EXPORT_REFUSAL_CODES));
  });
});

describe('export replies pass through per closed code', () => {
  for (const code of ['DESTINATION_UNSET', 'CAPTURE_UNKNOWN', 'NOT_SEALED', 'DESTINATION_UNAVAILABLE',
    'DESTINATION_EXISTS', 'LIMIT', 'NESTED_DISPLAY_ONLY', 'CAPTURE_UNAVAILABLE']) {
    test(`refusal ${code} passes through`, async () => {
      const facade = scripted({ export: (request) => ({ ok: false, code, request_id: request.request_id }) });
      const port = createCapturePort(facade);
      assert.deepEqual(await port.exportCapture('rec-1'), { ok: false, code });
    });
  }

  test('unknown or legacy-record codes fail closed on export', async () => {
    for (const code of ['BOGUS', '', null, 7, undefined, 'SURFACE_UNKNOWN', 'ALREADY_RECORDING', 'NOT_RECORDING']) {
      const facade = scripted({ export: () => ({ ok: false, code }) });
      const port = createCapturePort(facade);
      assert.deepEqual(await port.exportCapture('rec-1'),
        { ok: false, code: 'CAPTURE_UNAVAILABLE' }, String(code));
    }
  });

  test('success receipts pass through frozen', async () => {
    const port = createCapturePort(scripted({ export: () => receipt() }));
    const result = await port.exportCapture('rec-1');
    assert.deepEqual(result, receipt());
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.export));
  });
});

describe('export malformed replies never throw into callers', () => {
  test('malformed receipts resolve unavailable', async () => {
    const malformed = [null, undefined, 7, 'x', [], {}, { ok: true }, { ok: 'yes' },
      { ok: true, export: null },
      { ok: true, export: { id: '', bytes: 8, sha256: DIGEST } },
      { ok: true, export: { id: 'rec-1', bytes: 0, sha256: DIGEST } },
      { ok: true, export: { id: 'rec-1', bytes: -1, sha256: DIGEST } },
      { ok: true, export: { id: 'rec-1', bytes: 8.5, sha256: DIGEST } },
      { ok: true, export: { id: 'rec-1', bytes: 16 * 1024 * 1024 + 1, sha256: DIGEST } },
      { ok: true, export: { id: 'rec-1', bytes: 8, sha256: 'oops' } },
      { ok: true, export: { id: 'rec-1', bytes: 8, sha256: 'C'.repeat(64) } },
      { ok: true, export: { id: 'rec-1', bytes: 8, sha256: DIGEST.slice(1) } },
      { ok: true, export: { id: 'rec-1', bytes: 8 } },
      { ok: true, export: { id: 'rec-1', sha256: DIGEST } },
    ];
    for (const reply of malformed) {
      const port = createCapturePort(scripted({ export: () => reply }));
      const result = await port.exportCapture('rec-1');
      assert.deepEqual(result, { ok: false, code: 'CAPTURE_UNAVAILABLE' }, JSON.stringify(reply));
    }
    // Negative control: the valid baseline for the same shape passes.
    const port = createCapturePort(scripted({ export: () => receipt() }));
    assert.equal((await port.exportCapture('rec-1')).ok, true);
  });

  test('boundary byte counts 1 and 16 MiB pass', async () => {
    for (const bytes of [1, 16 * 1024 * 1024]) {
      const port = createCapturePort(scripted({ export: () => receipt({ bytes }) }));
      const result = await port.exportCapture('rec-1');
      assert.equal(result.ok, true, String(bytes));
      assert.equal(result.export.bytes, bytes);
    }
  });

  test('throwing host, missing facade and legacy facade resolve unavailable', async () => {
    const bomb = () => { throw new Error('host blew up'); };
    const rejecter = async () => { throw new Error('host rejected'); };
    for (const handlers of [{ export: bomb }, { export: rejecter }]) {
      const port = createCapturePort(scripted(handlers));
      await assert.doesNotReject(port.exportCapture('rec-1'));
      assert.deepEqual(await port.exportCapture('rec-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    }
    for (const facade of [undefined, null, {}]) {
      const port = createCapturePort(facade);
      assert.deepEqual(await port.exportCapture('rec-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    }
    const legacy = scripted({ export: () => receipt() });
    // @ts-expect-error legacy facade predates export
    delete legacy.export;
    const legacyPort = createCapturePort(legacy);
    assert.equal(legacyPort.available, true);
    assert.deepEqual(await legacyPort.exportCapture('rec-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
  });
});

describe('export state guards', () => {
  test('disposed store resolves unavailable without touching the facade', async () => {
    const facade = scripted({ export: () => receipt() });
    const state = createCaptureState(createCapturePort(facade));
    state.dispose();
    assert.deepEqual(await state.exportCapture('rec-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.deepEqual(await state.exportCapture(''), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    assert.equal(facade.calls.export.length, 0);
  });

  test('concurrent export of one id collapses to a single host call', async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const facade = scripted({ export: () => pending });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const first = state.exportCapture('rec-1');
      const duplicate = state.exportCapture('rec-1');
      const other = state.exportCapture('rec-2');
      resolve(receipt());
      assert.equal((await first).ok, true);
      assert.deepEqual(await duplicate, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
      assert.equal((await other).ok, true, 'a different id is not blocked');
      assert.equal(facade.calls.export.length, 2);
    } finally { state.dispose(); }
  });

  test('sequential exports both reach the host (guard is not sticky)', async () => {
    const facade = scripted({ export: () => receipt() });
    const state = createCaptureState(createCapturePort(facade));
    try {
      assert.equal((await state.exportCapture('rec-1')).ok, true);
      assert.equal((await state.exportCapture('rec-1')).ok, true);
      assert.equal(facade.calls.export.length, 2);
    } finally { state.dispose(); }
  });

  test('port without exportCapture resolves unavailable without throwing', async () => {
    const legacy = { ...createCapturePort(scripted({ export: () => receipt() })) };
    // @ts-expect-error legacy port predates export
    delete legacy.exportCapture;
    const state = createCaptureState(legacy);
    try {
      assert.deepEqual(await state.exportCapture('rec-1'), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
    } finally { state.dispose(); }
  });

  test('disposed pending export cannot mutate state', async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const facade = scripted({ export: () => pending });
    const state = createCaptureState(createCapturePort(facade));
    try {
      const work = state.exportCapture('rec-1');
      state.dispose();
      resolve(receipt());
      assert.deepEqual(await work, { ok: false, code: 'CAPTURE_UNAVAILABLE' });
      // Negative control: the guard released — after dispose nothing runs, but
      // a fresh store over the same facade exports normally.
      const fresh = createCaptureState(createCapturePort(facade));
      try {
        resolve(receipt());
        assert.equal((await fresh.exportCapture('rec-1')).ok, true);
      } finally { fresh.dispose(); }
    } finally { state.dispose(); }
  });

  test('export roundtrips through the real double', async () => {
    const state = createCaptureState(createCapturePort(createCaptureDouble()));
    try {
      const started = await state.toggleRecord('wall-1');
      assert.equal(started.ok, true);
      const stopped = await state.toggleRecord('wall-1');
      assert.equal(stopped.ok, true);
      const result = await state.exportCapture(stopped.recording.id);
      assert.equal(result.ok, true);
      assert.deepEqual(Object.keys(result.export).sort(), ['bytes', 'id', 'sha256']);
    } finally { state.dispose(); }
  });
});
