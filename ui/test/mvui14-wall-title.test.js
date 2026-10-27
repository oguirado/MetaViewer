// MVUI14 lane W: tile titles name the profile, not the raw display.
// Regression: the authority adapter mapped row titles to s.display (an
// X11-style ':100' locator) and dropped profile_id. Titles now come from
// profile_id with the surface id as fallback; display stays on the row as
// secondary metadata and profile_id is kept.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { selectWallSurface } from '../src/core/projection.js';

function notice(id = 'surface-a', surfaceChanges = {}, dropProfileId = false) {
  const surface = {
    schema: 'surface/v0.2', surface_id: id, kind: 'desktop_capsule',
    display: ':100', geometry: { w: 10, h: 10 }, profile_id: 'ops-desk',
    state: 'active', visibility: 'unfolded', control: 'shared', ...surfaceChanges,
  };
  if (dropProfileId) delete surface.profile_id;
  return {
    frame_ref: {
      schema: 'frame_ref/v0.2', surface_id: id, generation: 1,
      width: 10, height: 10, tick: 1, ts_ns: 1, capture_us: 1,
      format: 'rgb24', sha256: 'a'.repeat(64),
    },
    surface,
  };
}

function harness() {
  let emit;
  const runtime = createAuthorityRuntime({
    subscribeFrames(callback) { emit = callback; return () => {}; },
  });
  return { runtime, emit, view: runtime.projectionView };
}

describe('profile titles', () => {
  test('title names the profile; display and profile_id stay on the row', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice());
      assert.equal(view.getSnapshot().status, 'live');
      assert.equal(view.getSnapshot().error, null);
      const row = view.getProjection().rows[0];
      assert.equal(row.title, 'ops-desk');
      assert.equal(row.display, ':100');
      assert.equal(row.profile_id, 'ops-desk');
      const selected = selectWallSurface(view.getSnapshot(), 'surface-a');
      assert.equal(selected.ok, true);
    } finally { runtime.dispose(); }
  });

  test('absent profile_id falls back to the surface id', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice('surface-a', {}, true));
      assert.equal(view.getSnapshot().status, 'live');
      assert.equal(view.getSnapshot().error, null);
      const row = view.getProjection().rows[0];
      assert.equal(row.title, 'surface-a');
      assert.equal(row.display, ':100');
      assert.equal(row.profile_id, '');
    } finally { runtime.dispose(); }
  });

  test('empty profile_id falls back to the surface id', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice('surface-a', { profile_id: '' }));
      assert.equal(view.getSnapshot().status, 'live');
      const row = view.getProjection().rows[0];
      assert.equal(row.title, 'surface-a');
      assert.equal(row.profile_id, '');
    } finally { runtime.dispose(); }
  });
});

describe('profile title negative controls', () => {
  test('malformed profile_id still refuses with ERR_FRAME_NOTICE', () => {
    for (const [label, profileId] of [
      ['non-string', 7],
      ['null', null],
      ['overlong', 'a'.repeat(129)],
    ]) {
      const { runtime, emit, view } = harness();
      try {
        emit(notice('surface-a', { profile_id: profileId }));
        assert.equal(view.getSnapshot().status, 'unavailable', label);
        assert.equal(view.getSnapshot().error?.code, 'ERR_FRAME_NOTICE', label);
      } finally { runtime.dispose(); }
    }
  });

  test('display stays required and the surface shape stays closed', () => {
    const { runtime, emit, view } = harness();
    try {
      const missingDisplay = notice();
      delete missingDisplay.surface.display;
      emit(missingDisplay);
      assert.equal(view.getSnapshot().error?.code, 'ERR_FRAME_NOTICE');
      const extraKey = notice();
      extraKey.surface.extra = true;
      emit(extraKey);
      assert.equal(view.getSnapshot().error?.code, 'ERR_FRAME_NOTICE');
    } finally { runtime.dispose(); }
  });

  test('projection refuses non-string display and profile_id on rows', () => {
    const snapshot = (row) => ({ status: 'live', stale: false,
      envelope: { schema: 's', epoch: 1, revision: 1, query: 'wall',
        projection: { rows: [row] } }, error: null });
    const row = { id: 'a', surfaceId: 'a', backendLifecycle: 'active', generation: 1,
      visibility: 'unfolded', control: 'shared', title: 'ops-desk',
      display: ':100', profile_id: 'ops-desk' };
    assert.equal(selectWallSurface(snapshot(row), 'a').ok, true);
    assert.equal(selectWallSurface(snapshot({ ...row, display: 7 }), 'a').ok, false);
    assert.equal(selectWallSurface(snapshot({ ...row, profile_id: 7 }), 'a').ok, false);
  });
});
