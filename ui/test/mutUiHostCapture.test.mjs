import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../electron/preload.js';
import { assertCaptureReply, validCaptureState } from '../electron/captureBridge.js';

const DIGEST = 'a'.repeat(64);

function makeShot(overrides = {}) {
  return {
    id: 'shot-1',
    surface_id: 's1',
    width: 1,
    height: 1,
    sha256: DIGEST,
    created_ms: 0,
    ...overrides,
  };
}

function makeRow(index = 0, overrides = {}) {
  return {
    id: `cap-${index}`,
    surface_id: 's1',
    kind: 'shot',
    phase: 'sealed',
    sealed: true,
    frames: 1,
    duration_ms: 0,
    created_ms: index,
    ...overrides,
  };
}

test('assertCaptureReply screenshot requires positive integer width and height', () => {
  const valid = { ok: true, shot: makeShot({ width: 1, height: 1 }) };
  assert.deepEqual(assertCaptureReply('screenshot', valid), valid);

  for (const bad of [
    { width: 0, height: 1 },
    { width: 1, height: 0 },
    { width: -1, height: 1 },
    { width: 1, height: -1 },
  ]) {
    assert.throws(
      () => assertCaptureReply('screenshot', { ok: true, shot: makeShot(bad) }),
      ContractError,
    );
  }
});

test('assertCaptureReply recordStop requires sealed === true and non-negative counters', () => {
  const valid = {
    ok: true,
    recording: {
      id: 'rec-1',
      surface_id: 's1',
      frames: 0,
      duration_ms: 0,
      sealed: true,
      sha256: DIGEST,
    },
  };
  assert.deepEqual(assertCaptureReply('recordStop', valid), valid);

  for (const overrides of [
    { sealed: false },
    { sealed: 1 },
    { sealed: 'true' },
    { frames: -1 },
    { duration_ms: -1 },
  ]) {
    assert.throws(
      () =>
        assertCaptureReply('recordStop', {
          ok: true,
          recording: { ...valid.recording, ...overrides },
        }),
      ContractError,
    );
  }
});

test('assertCaptureReply list admits 64 rows and refuses 65 rows or negative counters', () => {
  const rows64 = Array.from({ length: 64 }, (_, i) => makeRow(i));
  const admitted = assertCaptureReply('list', { ok: true, rows: rows64 });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.rows.length, 64);

  const rows65 = Array.from({ length: 65 }, (_, i) => makeRow(i));
  assert.throws(
    () => assertCaptureReply('list', { ok: true, rows: rows65 }),
    ContractError,
  );

  for (const field of ['frames', 'duration_ms', 'created_ms']) {
    assert.throws(
      () => assertCaptureReply('list', { ok: true, rows: [makeRow(0, { [field]: -1 })] }),
      ContractError,
    );
  }
});

test('validCaptureState requires non-negative safe integer frames and elapsed_ms', () => {
  const valid = {
    type: 'capture.state',
    recording_id: 'rec-1',
    surface_id: 's1',
    phase: 'recording',
    frames: 0,
    elapsed_ms: 0,
  };
  assert.equal(validCaptureState(valid), true);
  assert.equal(validCaptureState({ ...valid, frames: 12, elapsed_ms: 345 }), true);

  for (const overrides of [
    { frames: -1 },
    { elapsed_ms: -1 },
    { frames: 1.5 },
    { elapsed_ms: 1.5 },
    { frames: Number.NaN },
    { elapsed_ms: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(validCaptureState({ ...valid, ...overrides }), false);
  }
});
