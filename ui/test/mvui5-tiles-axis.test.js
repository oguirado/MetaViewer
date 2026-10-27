// Lane T live tile axis: control ownership plus AI activity drive the
// human-control / agent-acting indication; frame identity stays deterministic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_ACTING_ACTIVITIES,
  controlAxisTile,
  deriveTileState,
  frameFreshnessText,
} from '../src/wall/tileStates.js';

function liveSnapshot(rows, overrides = {}) {
  return {
    status: 'live',
    stale: false,
    envelope: {
      schema: 'surface/v0.1', epoch: 3, revision: 7, query: 'wall', projection: { rows },
    },
    error: null,
    ...overrides,
  };
}

function tileRow(id, overrides = {}) {
  return {
    id, surfaceId: id, backendLifecycle: 'active', generation: 1,
    visibility: 'unfolded', control: 'shared', attachmentState: 'live', ...overrides,
  };
}

describe('control-owner axis', () => {
  test('exclusive owner wins when it diverges from the surface control', () => {
    assert.equal(
      controlAxisTile(tileRow('a', { controlOwner: 'human', control: 'agent' })),
      'human-control',
    );
    assert.equal(
      controlAxisTile(tileRow('a', { controlOwner: 'agent', control: 'human' })),
      'agent-acting',
    );
  });

  test('rows without an owner fall back to the surface control', () => {
    assert.equal(controlAxisTile(tileRow('a', { control: 'human' })), 'human-control');
    assert.equal(controlAxisTile(tileRow('a', { control: 'agent' })), 'agent-acting');
    assert.equal(controlAxisTile(tileRow('a', { controlOwner: 'none', control: 'human' })), 'human-control');
    assert.equal(controlAxisTile(tileRow('a', { controlOwner: 'none', control: 'agent' })), 'agent-acting');
    assert.equal(controlAxisTile(tileRow('a', { controlOwner: 'none', control: 'shared' })), 'live');
  });

  test('negative controls: unknown owners and controls never forge a control tile', () => {
    for (const owner of ['root', '', 'HUMAN', 7, {}, []]) {
      assert.equal(
        controlAxisTile(tileRow('a', { controlOwner: owner, control: 'shared' })),
        'live',
        JSON.stringify(owner),
      );
    }
    assert.equal(controlAxisTile(tileRow('a', { controlOwner: null, control: 'shared' })), 'live');
    assert.equal(controlAxisTile(tileRow('a', { control: 'unknown' })), 'live');
    assert.equal(controlAxisTile(null), 'live');
  });
});

describe('AI activity axis', () => {
  test('acting set carries busy only and stays frozen', () => {
    assert.deepEqual(AGENT_ACTING_ACTIVITIES, ['busy']);
    assert.equal(Object.isFrozen(AGENT_ACTING_ACTIVITIES), true);
    assert.throws(() => AGENT_ACTING_ACTIVITIES.push('waiting-input'), TypeError);
  });

  test('a busy session reads agent-acting on shared control', () => {
    const row = tileRow('a', { control: 'shared', controlOwner: 'none', aiSessionActivity: 'busy' });
    assert.equal(controlAxisTile(row), 'agent-acting');
    assert.equal(deriveTileState(liveSnapshot([row]), row).tile, 'agent-acting');
  });

  test('negative controls: waiting, exited and failed sessions are not acting', () => {
    for (const activity of ['unknown', 'ready', 'waiting-input', 'waiting-permission', 'exited', 'failed']) {
      const row = tileRow('a', { control: 'shared', controlOwner: 'none', aiSessionActivity: activity });
      assert.equal(controlAxisTile(row), 'live', activity);
      assert.equal(deriveTileState(liveSnapshot([row]), row).tile, 'live', activity);
    }
    for (const activity of ['', 'BUSY', 'executing', 7, {}, null, undefined]) {
      const row = tileRow('a', { control: 'shared', aiSessionActivity: activity });
      assert.equal(controlAxisTile(row), 'live', JSON.stringify(activity));
    }
  });

  test('an explicit human owner wins over a busy session; folded wins over both', () => {
    assert.equal(
      controlAxisTile(tileRow('a', { controlOwner: 'human', aiSessionActivity: 'busy' })),
      'human-control',
    );
    assert.equal(
      controlAxisTile(tileRow('a', { visibility: 'folded', controlOwner: 'agent', aiSessionActivity: 'busy' })),
      'folded',
    );
  });
});

describe('frame freshness text', () => {
  test('admitted generations render as Frame N', () => {
    assert.equal(frameFreshnessText(tileRow('a', { generation: 1 })), 'Frame 1');
    assert.equal(frameFreshnessText(tileRow('a', { generation: 42 })), 'Frame 42');
  });

  test('negative controls: missing or non-positive generations render nothing', () => {
    assert.equal(frameFreshnessText(null), '');
    assert.equal(frameFreshnessText(undefined), '');
    for (const generation of [0, -1, 1.5, '1', NaN, Infinity, null, {}, []]) {
      assert.equal(frameFreshnessText(tileRow('a', { generation })), '', JSON.stringify(generation));
    }
    const { generation, ...without } = tileRow('a');
    assert.equal(generation, 1);
    assert.equal(frameFreshnessText(without), '');
  });
});
