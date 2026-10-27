// Lane C capture double: exact host-contract behaviour (arity, schema,
// closed codes, one active recording per surface, LIMIT, nested mode).
// Negative control: every malformed shape throws while the valid baseline
// for the same method does not.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureDouble } from '../src/capture/captureDouble.js';
import { MV_RECORDING_PHASES } from '../src/recording/recordingModel.js';

const SCHEMA = 'capture_request/v1';

function shotRequest(overrides = {}) {
  return { schema: SCHEMA, request_id: 'req-1', surface_id: 'wall-1', ...overrides };
}

function startRequest(overrides = {}) {
  return {
    schema: SCHEMA, request_id: 'req-1', surface_id: 'wall-1', mode: 'ai', ...overrides,
  };
}

function stopRequest(overrides = {}) {
  return { schema: SCHEMA, request_id: 'req-1', recording_id: 'rec-1', ...overrides };
}

describe('capture double contract surface', () => {
  test('facade exposes exactly the five contract methods', () => {
    const double = createCaptureDouble();
    assert.deepEqual(Object.keys(double).sort(),
      ['list', 'recordStart', 'recordStop', 'screenshot', 'subscribe']);
    assert.ok(Object.isFrozen(double));
  });

  test('screenshot resolves a fully-shaped shot and lists it', () => {
    const double = createCaptureDouble();
    const result = double.screenshot(shotRequest());
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.shot).sort(),
      ['created_ms', 'height', 'id', 'sha256', 'surface_id', 'width']);
    assert.equal(result.shot.id, 'shot-1');
    assert.equal(result.shot.surface_id, 'wall-1');
    assert.equal(result.shot.width, 1280);
    assert.equal(result.shot.height, 720);
    assert.match(result.shot.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isFinite(result.shot.created_ms));
    const listed = double.list();
    assert.equal(listed.ok, true);
    assert.equal(listed.rows.length, 1);
    assert.deepEqual(listed.rows[0], {
      id: 'shot-1', kind: 'shot', surface_id: 'wall-1', phase: 'sealed',
      frames: 1, duration_ms: 0, sealed: true, created_ms: result.shot.created_ms,
    });
  });

  test('record start/stop roundtrip seals and emits ordered state events', () => {
    const double = createCaptureDouble();
    const seen = [];
    const off = double.subscribe((event) => seen.push(event));
    const started = double.recordStart(startRequest());
    assert.deepEqual(started, { ok: true, recording_id: 'rec-1' });
    const live = double.list();
    assert.equal(live.rows.length, 1);
    assert.equal(live.rows[0].phase, 'recording');
    assert.equal(live.rows[0].sealed, false);
    const stopped = double.recordStop(stopRequest());
    assert.equal(stopped.ok, true);
    assert.deepEqual(Object.keys(stopped.recording).sort(),
      ['duration_ms', 'frames', 'id', 'sealed', 'sha256', 'surface_id']);
    assert.equal(stopped.recording.sealed, true);
    assert.match(stopped.recording.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(seen.map((event) => event.phase), ['recording', 'sealed']);
    assert.ok(seen.every((event) => event.type === 'capture.state' && event.recording_id === 'rec-1'));
    off();
  });

  test('rows always carry closed kinds and known phases', () => {
    const double = createCaptureDouble();
    double.screenshot(shotRequest());
    double.recordStart(startRequest({ surface_id: 'wall-2' }));
    for (const row of double.list().rows) {
      assert.ok(row.kind === 'shot' || row.kind === 'recording', row.kind);
      assert.ok(MV_RECORDING_PHASES.includes(row.phase), row.phase);
    }
  });

  test('unsubscribe stops delivery', () => {
    const double = createCaptureDouble();
    let seen = 0;
    const off = double.subscribe(() => { seen += 1; });
    double.recordStart(startRequest());
    assert.equal(seen, 1);
    off();
    double.recordStop(stopRequest());
    assert.equal(seen, 1);
  });
});

describe('capture double refusals', () => {
  test('one active recording per surface: ALREADY_RECORDING', () => {
    const double = createCaptureDouble();
    assert.equal(double.recordStart(startRequest()).ok, true);
    assert.deepEqual(double.recordStart(startRequest({ request_id: 'req-2' })),
      { ok: false, code: 'ALREADY_RECORDING', request_id: 'req-2' });
    assert.equal(double.recordStart(startRequest({ request_id: 'req-3', surface_id: 'wall-2' })).ok, true);
  });

  test('unknown or finished recordings: NOT_RECORDING', () => {
    const double = createCaptureDouble();
    assert.deepEqual(double.recordStop(stopRequest()),
      { ok: false, code: 'NOT_RECORDING', request_id: 'req-1' });
    double.recordStart(startRequest());
    assert.equal(double.recordStop(stopRequest({ request_id: 'req-2' })).ok, true);
    assert.deepEqual(double.recordStop(stopRequest({ request_id: 'req-3' })),
      { ok: false, code: 'NOT_RECORDING', request_id: 'req-3' });
  });

  test('closed surface world: SURFACE_UNKNOWN; open world accepts any id', () => {
    const closed = createCaptureDouble({ surfaces: ['wall-1'] });
    assert.deepEqual(closed.screenshot(shotRequest({ surface_id: 'nope' })),
      { ok: false, code: 'SURFACE_UNKNOWN', request_id: 'req-1' });
    assert.deepEqual(closed.recordStart(startRequest({ surface_id: 'nope' })),
      { ok: false, code: 'SURFACE_UNKNOWN', request_id: 'req-1' });
    assert.equal(closed.screenshot(shotRequest()).ok, true);
    const open = createCaptureDouble();
    assert.equal(open.screenshot(shotRequest({ surface_id: 'anything-goes' })).ok, true);
    assert.equal(open.recordStart(startRequest({ surface_id: 'anything-goes' })).ok, true);
  });

  test('concurrency cap: LIMIT', () => {
    const double = createCaptureDouble({ limit: 1 });
    assert.equal(double.recordStart(startRequest()).ok, true);
    assert.deepEqual(double.recordStart(startRequest({ request_id: 'req-2', surface_id: 'wall-2' })),
      { ok: false, code: 'LIMIT', request_id: 'req-2' });
    const zero = createCaptureDouble({ limit: 0 });
    assert.deepEqual(zero.recordStart(startRequest()),
      { ok: false, code: 'LIMIT', request_id: 'req-1' });
  });

  test('nested display-only: mutating calls refuse, reads still work', () => {
    const double = createCaptureDouble({ nested: true });
    assert.deepEqual(double.screenshot(shotRequest()),
      { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: 'req-1' });
    assert.deepEqual(double.recordStart(startRequest()),
      { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: 'req-1' });
    assert.deepEqual(double.recordStop(stopRequest()),
      { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: 'req-1' });
    assert.deepEqual(double.list(), { ok: true, rows: [] });
    let seen = 0;
    const off = double.subscribe(() => { seen += 1; });
    assert.equal(typeof off, 'function');
    off();
    assert.equal(seen, 0);
  });

  test('unavailable switch: every call refuses CAPTURE_UNAVAILABLE', () => {
    const double = createCaptureDouble({ unavailable: true });
    assert.deepEqual(double.screenshot(shotRequest()),
      { ok: false, code: 'CAPTURE_UNAVAILABLE', request_id: 'req-1' });
    assert.deepEqual(double.recordStart(startRequest()),
      { ok: false, code: 'CAPTURE_UNAVAILABLE', request_id: 'req-1' });
    assert.deepEqual(double.recordStop(stopRequest()),
      { ok: false, code: 'CAPTURE_UNAVAILABLE', request_id: 'req-1' });
    assert.deepEqual(double.list(), { ok: false, code: 'CAPTURE_UNAVAILABLE' });
  });

  test('refusals echo the caller request id', () => {
    const double = createCaptureDouble({ surfaces: ['wall-1'] });
    const refusal = double.recordStart(startRequest({ request_id: 'trace-42', surface_id: 'nope' }));
    assert.equal(refusal.request_id, 'trace-42');
  });

  test('double ids are deterministic per instance', () => {
    const first = createCaptureDouble();
    const second = createCaptureDouble();
    for (const double of [first, second]) {
      assert.equal(double.screenshot(shotRequest()).shot.id, 'shot-1');
      assert.equal(double.recordStart(startRequest()).recording_id, 'rec-1');
    }
  });
});

describe('capture double malformed shapes throw', () => {
  const malformed = [
    ['null request', null],
    ['missing schema', { request_id: 'req-1', surface_id: 'wall-1' }],
    ['wrong schema', { schema: 'capture_request/v0', request_id: 'req-1', surface_id: 'wall-1' }],
    ['missing request_id', { schema: SCHEMA, surface_id: 'wall-1' }],
    ['empty request_id', { schema: SCHEMA, request_id: '', surface_id: 'wall-1' }],
    ['oversize request_id', { schema: SCHEMA, request_id: 'r'.repeat(65), surface_id: 'wall-1' }],
    ['non-ascii request_id', { schema: SCHEMA, request_id: 'réc-1', surface_id: 'wall-1' }],
    ['missing surface_id', { schema: SCHEMA, request_id: 'req-1' }],
    ['empty surface_id', { schema: SCHEMA, request_id: 'req-1', surface_id: '' }],
  ];

  test('malformed screenshot/recordStart shapes throw; valid baseline does not', () => {
    for (const [label, shape] of malformed) {
      assert.throws(() => createCaptureDouble().screenshot(shape), TypeError, `screenshot ${label}`);
      assert.throws(() => createCaptureDouble().recordStart(shape), TypeError, `recordStart ${label}`);
    }
    assert.throws(() => createCaptureDouble().recordStart(startRequest({ mode: 'realtime' })), TypeError);
    assert.throws(() => createCaptureDouble().recordStart(startRequest({ mode: undefined })), TypeError);
    assert.doesNotThrow(() => createCaptureDouble().screenshot(shotRequest()), 'valid screenshot baseline');
    assert.doesNotThrow(() => createCaptureDouble().recordStart(startRequest()), 'valid recordStart baseline');
  });

  test('malformed recordStop shapes throw; valid baseline does not', () => {
    for (const shape of [null, {}, { schema: SCHEMA }, { schema: SCHEMA, request_id: 'req-1' },
      stopRequest({ recording_id: '' }), stopRequest({ recording_id: 7 })]) {
      assert.throws(() => createCaptureDouble().recordStop(shape), TypeError, JSON.stringify(shape));
    }
    const double = createCaptureDouble();
    double.recordStart(startRequest());
    assert.doesNotThrow(() => double.recordStop(stopRequest()), 'valid recordStop baseline');
  });

  test('non-function subscribe throws; function baseline does not', () => {
    for (const bad of [undefined, null, 7, 'x', {}]) {
      assert.throws(() => createCaptureDouble().subscribe(bad), TypeError, String(bad));
    }
    assert.doesNotThrow(() => createCaptureDouble().subscribe(() => {})(), 'valid subscribe baseline');
  });
});
