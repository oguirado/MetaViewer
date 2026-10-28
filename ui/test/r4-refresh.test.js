// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSurfaceInputBatch,
  mapSurfaceInputRefusal,
  recordingDestination,
} from '../electron/authorityWire.js';

test('D7: R4-INPUT surface_input/v1 batch validation and refusal mapping', () => {
  const validClick = {
    schema: 'surface_input/v1',
    surface_id: 'surf1',
    stream_id: 1,
    seq: 1,
    events: [{ kind: 'click', x: 100, y: 200, button: 'left' }],
  };

  const res1 = validateSurfaceInputBatch(validClick);
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.batch.seq, 1);
    assert.equal(res1.batch.events.length, 1);
  }

  const overLimitEvents = Array.from({ length: 33 }, () => ({
    kind: 'click',
    x: 10,
    y: 10,
    button: 'left',
  }));
  const invalidBatch = {
    schema: 'surface_input/v1',
    surface_id: 'surf1',
    stream_id: 1,
    seq: 1,
    events: overLimitEvents,
  };

  const res2 = validateSurfaceInputBatch(invalidBatch);
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.equal(res2.code, 'LIMIT');
  }

  assert.equal(mapSurfaceInputRefusal('LOCKED_BY_OTHER'), 'NOT_IN_CONTROL');
  assert.equal(mapSurfaceInputRefusal('SURFACE_NOT_HUMAN_CONTROLLED'), 'NOT_IN_CONTROL');
  assert.equal(mapSurfaceInputRefusal('SURFACE_NOT_AGENT_CONTROLLED'), 'NOT_IN_CONTROL');
  assert.equal(mapSurfaceInputRefusal('STALE_FRAME'), 'STALE_STREAM');
  assert.equal(mapSurfaceInputRefusal('BUDGET_EXCEEDED'), 'LIMIT');
  assert.equal(mapSurfaceInputRefusal('POLICY'), 'SCHEMA');
  assert.equal(mapSurfaceInputRefusal('UNKNOWN_CODE'), 'CORE_UNAVAILABLE');
});

test('D9: R4-PEER + R4-RV9 + R4-DIAG2 settings destination failure mode', () => {
  assert.throws(
    () => recordingDestination({ MV_RECORDING_DESTINATION: 'relative/path' }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'SETTINGS_DESTINATION');
      return true;
    },
  );
});
