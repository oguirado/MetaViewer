// MVUI11 lane E: capture double export. The fake facade honours the closed
// export shape and every host refusal code. Negative control: every
// malformed shape throws while the valid baseline for export does not.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureDouble } from '../src/capture/captureDouble.js';

const SCHEMA = 'capture_request/v1';
const TOKEN = 'recording:configured';

function exportRequest(overrides = {}) {
  return { schema: SCHEMA, request_id: 'req-1', capture_id: 'rec-1', destination: TOKEN, ...overrides };
}

function sealedRecording(double, surface = 'wall-1') {
  const started = double.recordStart({ schema: SCHEMA, request_id: 'req-start', surface_id: surface, mode: 'ai' });
  assert.equal(started.ok, true);
  const stopped = double.recordStop({ schema: SCHEMA, request_id: 'req-stop', recording_id: started.recording_id });
  assert.equal(stopped.ok, true);
  return stopped.recording.id;
}

describe('double export success', () => {
  test('facade exposes export as the sixth contract method', () => {
    const double = createCaptureDouble();
    assert.deepEqual(Object.keys(double).sort(),
      ['export', 'list', 'recordStart', 'recordStop', 'screenshot', 'subscribe']);
    assert.ok(Object.isFrozen(double));
  });

  test('sealed recording exports a frozen receipt with exact keys', () => {
    const double = createCaptureDouble();
    const id = sealedRecording(double);
    const result = double.export(exportRequest({ capture_id: id }));
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.export).sort(), ['bytes', 'id', 'sha256']);
    assert.equal(result.export.id, id);
    assert.equal(result.export.bytes, 2048);
    assert.match(result.export.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.export));
  });

  test('sealed screenshot exports too', () => {
    const double = createCaptureDouble();
    const shot = double.screenshot({ schema: SCHEMA, request_id: 'req-shot', surface_id: 'wall-1' });
    assert.equal(shot.ok, true);
    const result = double.export(exportRequest({ capture_id: shot.shot.id }));
    assert.equal(result.ok, true);
    assert.equal(result.export.id, shot.shot.id);
  });
});

describe('double export refusals honour every code', () => {
  test('null request destination refuses DESTINATION_UNSET', () => {
    const double = createCaptureDouble();
    const id = sealedRecording(double);
    assert.deepEqual(double.export(exportRequest({ capture_id: id, destination: null })),
      { ok: false, code: 'DESTINATION_UNSET', request_id: 'req-1' });
    // Negative control: the same capture with the token exports.
    assert.equal(double.export(exportRequest({ capture_id: id })).ok, true);
  });

  test('noDestination option refuses DESTINATION_UNSET with the token', () => {
    const double = createCaptureDouble({ noDestination: true });
    const id = sealedRecording(double);
    assert.deepEqual(double.export(exportRequest({ capture_id: id })),
      { ok: false, code: 'DESTINATION_UNSET', request_id: 'req-1' });
  });

  test('unknown capture refuses CAPTURE_UNKNOWN', () => {
    const double = createCaptureDouble();
    sealedRecording(double);
    assert.deepEqual(double.export(exportRequest({ capture_id: 'rec-9' })),
      { ok: false, code: 'CAPTURE_UNKNOWN', request_id: 'req-1' });
  });

  test('active recording refuses NOT_SEALED, then exports after stop', () => {
    const double = createCaptureDouble();
    const started = double.recordStart({ schema: SCHEMA, request_id: 'req-start', surface_id: 'wall-1', mode: 'ai' });
    assert.deepEqual(double.export(exportRequest({ capture_id: started.recording_id })),
      { ok: false, code: 'NOT_SEALED', request_id: 'req-1' });
    double.recordStop({ schema: SCHEMA, request_id: 'req-stop', recording_id: started.recording_id });
    assert.equal(double.export(exportRequest({ capture_id: started.recording_id })).ok, true);
  });

  test('second export refuses DESTINATION_EXISTS (no clobber)', () => {
    const double = createCaptureDouble();
    const id = sealedRecording(double);
    assert.equal(double.export(exportRequest({ capture_id: id })).ok, true);
    assert.deepEqual(double.export(exportRequest({ capture_id: id, request_id: 'req-2' })),
      { ok: false, code: 'DESTINATION_EXISTS', request_id: 'req-2' });
  });

  test('destinationUnavailable option refuses DESTINATION_UNAVAILABLE', () => {
    const double = createCaptureDouble({ destinationUnavailable: true });
    const id = sealedRecording(double);
    assert.deepEqual(double.export(exportRequest({ capture_id: id })),
      { ok: false, code: 'DESTINATION_UNAVAILABLE', request_id: 'req-1' });
  });

  test('exportLimit refuses LIMIT past the budget', () => {
    const double = createCaptureDouble({ exportLimit: 1 });
    const first = sealedRecording(double, 'wall-1');
    const second = sealedRecording(double, 'wall-2');
    assert.equal(double.export(exportRequest({ capture_id: first })).ok, true);
    assert.deepEqual(double.export(exportRequest({ capture_id: second, request_id: 'req-2' })),
      { ok: false, code: 'LIMIT', request_id: 'req-2' });
  });

  test('nested and unavailable modes refuse like the other mutating calls', () => {
    for (const [options, code] of [[{ nested: true }, 'NESTED_DISPLAY_ONLY'], [{ unavailable: true }, 'CAPTURE_UNAVAILABLE']]) {
      const double = createCaptureDouble(options);
      assert.deepEqual(double.export(exportRequest()),
        { ok: false, code, request_id: 'req-1' }, JSON.stringify(options));
    }
  });

  test('refusals write nothing: the capture still exports on a healthy double', () => {
    const down = createCaptureDouble({ destinationUnavailable: true });
    const id = sealedRecording(down);
    assert.equal(down.export(exportRequest({ capture_id: id })).ok, false);
    const healthy = createCaptureDouble();
    const same = sealedRecording(healthy);
    assert.equal(same, id, 'deterministic ids across doubles');
    assert.equal(healthy.export(exportRequest({ capture_id: same })).ok, true);
  });
});

describe('double export shape validation', () => {
  test('malformed export requests throw while the valid baseline does not', () => {
    const double = createCaptureDouble();
    const id = sealedRecording(double);
    assert.doesNotThrow(() => double.export(exportRequest({ capture_id: id })));
    for (const bad of [null, undefined, 7, 'x', [],
      { ...exportRequest(), schema: 'capture_request/v0' },
      { ...exportRequest(), request_id: '' },
      { ...exportRequest(), request_id: 'é' },
      { ...exportRequest(), request_id: 'x'.repeat(65) },
      { ...exportRequest(), capture_id: '' },
      { ...exportRequest(), capture_id: 7 },
      { ...exportRequest(), destination: '/tmp/evil' },
      { ...exportRequest(), destination: '' },
      { ...exportRequest(), destination: undefined },
      { ...exportRequest(), destination: 'recording:other' },
    ]) {
      assert.throws(() => double.export(bad), TypeError, JSON.stringify(bad));
    }
  });
});
