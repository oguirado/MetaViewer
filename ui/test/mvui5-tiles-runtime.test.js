// Lane T authority honesty: out-of-order frame duplicates keep last-good
// without an error flash, and control ownership stays a closed axis.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { selectWallSurface } from '../src/core/projection.js';
import { deriveTileState } from '../src/wall/tileStates.js';

function notice(id = 'surface-a', generation = 1, changes = {}) {
  return {
    frame_ref: {
      schema: 'frame_ref/v0.2', surface_id: id, generation,
      tick: generation, ts_ns: generation, capture_us: 0, width: 1, height: 1,
      format: 'rgb24', sha256: 'a'.repeat(64),
    },
    surface: {
      schema: 'surface/v0.2', surface_id: id, kind: 'desktop_capsule',
      display: 'Desktop', geometry: { w: 1, h: 1 }, profile_id: 'default',
      state: 'active', visibility: 'unfolded', control: 'shared', ...changes,
    },
  };
}

function harness() {
  let emit;
  const runtime = createAuthorityRuntime({
    subscribeFrames(callback) { emit = callback; return () => {}; },
  });
  return { runtime, emit, view: runtime.projectionView };
}

describe('older-generation duplicates', () => {
  test('a duplicate keeps last-good live with no error and unchanged rows', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice('surface-a', 2));
      const admitted = view.getProjection().rows;
      assert.equal(view.getSnapshot().status, 'live');
      emit(notice('surface-a', 1));
      assert.equal(view.getSnapshot().status, 'live');
      assert.equal(view.getSnapshot().stale, false);
      assert.equal(view.getSnapshot().error, null);
      assert.deepEqual(view.getProjection().rows, admitted);
      assert.equal(view.getProjection().rows[0].generation, 2);
      const decided = deriveTileState(view.getSnapshot(), view.getProjection().rows[0]);
      assert.equal(decided.tile, 'live');
      assert.equal(decided.status, 'Live');
    } finally { runtime.dispose(); }
  });

  test('generations still advance after an ignored duplicate', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice('surface-a', 2));
      emit(notice('surface-a', 1));
      emit(notice('surface-a', 3));
      assert.equal(view.getSnapshot().status, 'live');
      assert.equal(view.getSnapshot().error, null);
      assert.equal(view.getProjection().rows[0].generation, 3);
    } finally { runtime.dispose(); }
  });

  test('negative control: a malformed notice still raises the typed error tile', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice('surface-a', 2));
      const invalid = notice('surface-a', 3);
      invalid.frame_ref.format = 'rgba32';
      emit(invalid);
      assert.equal(view.getSnapshot().error.code, 'ERR_FRAME_NOTICE');
      const decided = deriveTileState(view.getSnapshot(), view.getProjection().rows[0]);
      assert.equal(decided.tile, 'error');
      emit(notice('surface-a', 3));
      assert.equal(view.getSnapshot().error, null);
      assert.equal(deriveTileState(view.getSnapshot(), view.getProjection().rows[0]).tile, 'live');
    } finally { runtime.dispose(); }
  });

  test('the surface cap still refuses admission past 256 rows', () => {
    const { runtime, emit, view } = harness();
    try {
      for (let n = 1; n <= 256; n += 1) emit(notice(`surface-${n}`, 1));
      assert.equal(view.getSnapshot().status, 'live');
      assert.equal(view.getProjection().rows.length, 256);
      emit(notice('surface-257', 1));
      assert.equal(view.getSnapshot().error.code, 'ERR_FRAME_NOTICE');
      assert.equal(view.getProjection().rows.length, 256);
    } finally { runtime.dispose(); }
  });
});

describe('controlOwner admission', () => {
  function snapshotWith(row) {
    return {
      status: 'live',
      envelope: { projection: { rows: [row] } },
    };
  }

  function wallRow(id, overrides = {}) {
    return {
      id, surfaceId: id, backendLifecycle: 'active', generation: 1,
      visibility: 'unfolded', control: 'shared', ...overrides,
    };
  }

  test('the closed owner axis admits agent, human and none', () => {
    for (const controlOwner of ['agent', 'human', 'none']) {
      const outcome = selectWallSurface(snapshotWith(wallRow('a', { controlOwner })), 'a');
      assert.equal(outcome.ok, true);
      assert.equal(outcome.value.controlOwner, controlOwner);
    }
  });

  test('negative controls: invented owners refuse the row', () => {
    for (const controlOwner of ['root', '', 'HUMAN', 'shared', 7, null, {}, []]) {
      const outcome = selectWallSurface(snapshotWith(wallRow('a', { controlOwner })), 'a');
      assert.equal(outcome.ok, false, JSON.stringify(controlOwner));
      assert.equal(outcome.error.code, 'ERR_MALFORMED_ROW', JSON.stringify(controlOwner));
    }
  });
});
