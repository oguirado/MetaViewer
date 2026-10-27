import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { deriveTileState } from '../src/wall/tileStates.js';

function notice() {
  return {
    frame_ref: {
      schema: 'frame_ref/v0.2', surface_id: 'surface-a', generation: 1,
      tick: 0, ts_ns: 0, capture_us: 0, width: 1, height: 1,
      format: 'rgb24', sha256: '0123456789abcdef'.repeat(4),
    },
    surface: {
      schema: 'surface/v0.2', surface_id: 'surface-a', kind: 'desktop_capsule',
      display: 'Desktop', geometry: { w: 1, h: 1 }, profile_id: 'default',
      state: 'active', visibility: 'unfolded', control: 'shared',
    },
  };
}

function harness() {
  let emit;
  const runtime = createAuthorityRuntime({ subscribeFrames(callback) {
    emit = callback;
    return () => {};
  } });
  return { runtime, emit, view: runtime.projectionView };
}

test('frame_ref/v0.2 metadata drives a live tile row without exposing frame metadata', () => {
  const { runtime, emit, view } = harness();
  try {
    emit(notice());
    assert.equal(view.getSnapshot().status, 'live');
    assert.equal(view.getSnapshot().error, null);
    assert.deepEqual(view.getProjection().rows, [{
      id: 'surface-a', surfaceId: 'surface-a', title: 'Desktop', generation: 1,
      backendLifecycle: 'active', visibility: 'unfolded', control: 'shared', controlOwner: 'none', attachmentState: 'live',
    }]);
    assert.equal(deriveTileState(view.getSnapshot(), view.getProjection().rows[0]).tile, 'live');
    assert.doesNotMatch(JSON.stringify(view.getSnapshot()), /frame_ref|sha256|ramws_path|capture_us/);
  } finally { runtime.dispose(); }
});

const refused = [
  ['legacy frame_ref/v0.1', n => { n.frame_ref.schema = 'frame_ref/v0.1'; }],
  ['renderer path', n => { n.frame_ref.ramws_path = '/dev/shm/frame.rgb'; }],
  ['extra frame key', n => { n.frame_ref.extra = true; }],
  ['extra notice key', n => { n.extra = true; }],
  ['wrong format', n => { n.frame_ref.format = 'rgba32'; }],
  ['uppercase digest', n => { n.frame_ref.sha256 = 'A'.repeat(64); }],
  ['non-hex digest', n => { n.frame_ref.sha256 = 'g'.repeat(64); }],
  ['short digest', n => { n.frame_ref.sha256 = 'a'.repeat(63); }],
  ['long digest', n => { n.frame_ref.sha256 = 'a'.repeat(65); }],
  ['non-string digest', n => { n.frame_ref.sha256 = ['a'.repeat(64)]; }],
  ['empty surface id', n => { n.frame_ref.surface_id = n.surface.surface_id = ''; }],
  ['long surface id', n => { n.frame_ref.surface_id = n.surface.surface_id = 'a'.repeat(129); }],
  ['non-string surface id', n => { n.frame_ref.surface_id = n.surface.surface_id = 1; }],
];
for (const key of Object.keys(notice().frame_ref)) {
  refused.push([`missing ${key}`, n => { delete n.frame_ref[key]; }]);
}
for (const key of ['generation', 'width', 'height', 'tick', 'ts_ns', 'capture_us']) {
  const minimum = ['generation', 'width', 'height'].includes(key) ? 1 : 0;
  for (const bad of [minimum - 1, 1.5, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    refused.push([`${key} rejects ${String(bad)} (${typeof bad})`, n => { n.frame_ref[key] = bad; }]);
  }
}

for (const [label, mutate] of refused) {
  test(`frame notice refuses ${label} with ERR_FRAME_NOTICE and preserves the tile row`, () => {
    const { runtime, emit, view } = harness();
    try {
      const invalid = notice(); mutate(invalid);
      emit(invalid);
      assert.equal(view.getSnapshot().status, 'unavailable');
      assert.equal(view.getSnapshot().envelope, null);
      assert.deepEqual(view.getSnapshot().error, {
        code: 'ERR_FRAME_NOTICE', message: 'Surface update unavailable.',
      });
      emit(notice());
      const rows = view.getProjection().rows;
      emit(invalid);
      assert.equal(view.getSnapshot().stale, true);
      assert.equal(view.getSnapshot().error.code, 'ERR_FRAME_NOTICE');
      assert.deepEqual(view.getProjection().rows, rows);
      assert.equal(deriveTileState(view.getSnapshot(), rows[0]).tile, 'error');
      emit(notice());
      assert.equal(view.getSnapshot().error, null);
      assert.equal(deriveTileState(view.getSnapshot(), rows[0]).tile, 'live');
    } finally { runtime.dispose(); }
  });
}
