// MVUI19 lane A (EVUI-08): an empty profile_id ('') counts as a missing one:
// the notice is admitted and the row title falls back to the surface id.
// Malformed profile values (non-string, overlong) still refuse with
// ERR_FRAME_NOTICE, and valid 1..128 profiles keep their title.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';

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

describe('mvui19 empty profile_id falls back like a missing one (EVUI-08)', () => {
  test('empty profile_id is admitted with the surface-id title', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice('surface-a', { profile_id: '' }));
      assert.equal(view.getSnapshot().status, 'live');
      assert.equal(view.getSnapshot().error, null);
      const row = view.getProjection().rows[0];
      assert.equal(row.title, 'surface-a');
      assert.equal(row.profile_id, '');
      assert.equal(row.display, ':100', 'display stays as secondary metadata');
    } finally { runtime.dispose(); }
  });

  test('empty profile_id row is identical to the missing-profile row', () => {
    const first = harness();
    const second = harness();
    try {
      first.emit(notice('surface-a', { profile_id: '' }));
      second.emit(notice('surface-a', {}, true));
      assert.deepEqual(first.view.getProjection().rows, second.view.getProjection().rows,
        'empty and missing profiles project to the same row');
    } finally { first.runtime.dispose(); second.runtime.dispose(); }
  });

  test('valid 1..128 profiles keep their title', () => {
    for (const profile of ['x', 'ops-desk', 'p'.repeat(128)]) {
      const { runtime, emit, view } = harness();
      try {
        emit(notice('surface-a', { profile_id: profile }));
        assert.equal(view.getSnapshot().status, 'live', `length ${profile.length} admits`);
        assert.equal(view.getProjection().rows[0].title, profile, `length ${profile.length} titles`);
        assert.equal(view.getProjection().rows[0].profile_id, profile);
      } finally { runtime.dispose(); }
    }
  });

  test('omitted profile_id still admits with the surface-id title', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice('surface-a', {}, true));
      assert.equal(view.getSnapshot().status, 'live');
      assert.equal(view.getProjection().rows[0].title, 'surface-a');
      assert.equal(view.getProjection().rows[0].profile_id, '');
    } finally { runtime.dispose(); }
  });
});

describe('mvui19 profile negative controls (EVUI-08)', () => {
  test('malformed profile_id still refuses with ERR_FRAME_NOTICE', () => {
    for (const [label, profileId] of [
      ['non-string', 7],
      ['null', null],
      ['object', { id: 'x' }],
      ['overlong', 'a'.repeat(129)],
    ]) {
      const { runtime, emit, view } = harness();
      try {
        emit(notice('surface-a', { profile_id: profileId }));
        assert.equal(view.getSnapshot().status, 'unavailable', label);
        assert.equal(view.getSnapshot().error?.code, 'ERR_FRAME_NOTICE', label);
        assert.equal(view.getProjection(), null, `${label}: no row is admitted`);
      } finally { runtime.dispose(); }
    }
  });

  test('fallback is empty-specific: valid titles are never replaced', () => {
    const { runtime, emit, view } = harness();
    try {
      emit(notice('surface-a', { profile_id: 'ops-desk' }));
      assert.equal(view.getProjection().rows[0].title, 'ops-desk');
      assert.notEqual(view.getProjection().rows[0].title, 'surface-a',
        'a sent profile is not overwritten by the surface id');
    } finally { runtime.dispose(); }
  });

  test('hardening is explicit in the adapter source', () => {
    const source = readFileSync(new URL('../src/core/hostAdapters.js', import.meta.url), 'utf8');
    assert.ok(source.includes("s.profile_id !== ''"), 'empty counts as missing at validation');
    assert.ok(source.includes('s.profile_id.length > 0 ? s.profile_id :'), 'title fallback is explicit');
  });
});

test('mvui19 profile fallback: rss stays bounded', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
