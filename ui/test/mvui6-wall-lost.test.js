// Lane W (MV-7): the live runtime path keeps a Lost tile for a lost surface.
// A lost authority notice must keep the admitted row (never drop the tile)
// and derive the identical lost/Lost decision tile-states draws; recovery
// returns the tile to live. The empty-workspace fallback for this case is
// App-owned (rows filter): this file pins the runtime side of the contract.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveReplayHarness,
  LIVE_REPLAY_SURFACE_ID,
} from '../src/fixtures/liveReplay.js';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { deriveTileState } from '../src/wall/tileStates.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';

function tileStatesLostDecision() {
  const result = createFixtureRuntime('tile-states');
  assert.equal(result.ok, true);
  const view = result.mount.runtime.projectionView;
  const snapshot = view.getSnapshot();
  const row = view.getProjection().rows.find((entry) => entry.id === 'cap-06');
  assert.ok(row, 'tile-states carries a lost reference row');
  return deriveTileState(snapshot, row, row);
}

function liveReplaySnapshotAt(step) {
  const harness = createLiveReplayHarness();
  const runtime = createAuthorityRuntime(harness.port);
  assert.ok(runtime, 'live runtime mounts on the fixture fake port');
  harness.emitUpTo(step);
  const view = runtime.projectionView;
  return { runtime, snapshot: view.getSnapshot(), rows: view.getProjection()?.rows ?? [] };
}

describe('MV-7 live lost-tile parity', () => {
  test('step 7 keeps the lost row and derives lost/Lost like tile-states', () => {
    const { runtime, snapshot, rows } = liveReplaySnapshotAt(7);
    try {
      const row = rows.find((entry) => entry.id === LIVE_REPLAY_SURFACE_ID);
      assert.ok(row, 'the lost surface keeps its admitted row');
      assert.equal(row.backendLifecycle, 'lost');
      const decision = deriveTileState(snapshot, row, row);
      assert.equal(decision.tile, 'lost');
      assert.equal(decision.status, 'Lost');
      const reference = tileStatesLostDecision();
      assert.equal(reference.tile, 'lost');
      assert.equal(reference.status, 'Lost');
      assert.deepEqual(
        { tile: decision.tile, status: decision.status },
        { tile: reference.tile, status: reference.status },
      );
    } finally {
      runtime.dispose();
    }
  });

  test('step 8 recovers the tile to live', () => {
    const { runtime, snapshot, rows } = liveReplaySnapshotAt(8);
    try {
      const row = rows.find((entry) => entry.id === LIVE_REPLAY_SURFACE_ID);
      assert.ok(row);
      const decision = deriveTileState(snapshot, row, row);
      assert.equal(decision.tile, 'live');
      assert.equal(decision.status, 'Live');
    } finally {
      runtime.dispose();
    }
  });

  test('negative controls: empty or live feeds never derive lost', () => {
    const { runtime, snapshot } = liveReplaySnapshotAt(0);
    try {
      assert.equal(snapshot.status, 'unavailable');
      const waiting = deriveTileState(snapshot, null, null);
      assert.equal(waiting.tile, 'connecting');
      assert.equal(waiting.status, 'Waiting');
    } finally {
      runtime.dispose();
    }
    const live = liveReplaySnapshotAt(3);
    try {
      const row = live.rows.find((entry) => entry.id === LIVE_REPLAY_SURFACE_ID);
      assert.ok(row);
      const decision = deriveTileState(live.snapshot, row, row);
      assert.equal(decision.tile, 'live');
      assert.notEqual(decision.tile, 'lost');
    } finally {
      live.runtime.dispose();
    }
  });

  test('negative control: a missing row with no admitted past stays connecting', () => {
    const { runtime, snapshot, rows } = liveReplaySnapshotAt(3);
    try {
      assert.ok(rows.length > 0);
      const decision = deriveTileState(snapshot, null, null);
      assert.equal(decision.tile, 'connecting');
      assert.notEqual(decision.tile, 'lost');
    } finally {
      runtime.dispose();
    }
  });
});
