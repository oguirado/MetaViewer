// Lane U1 tile states: seven wall tile states, precedence, control verbs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TILE_STATES,
  CAPTURING_LIFECYCLES,
  CONNECTING_ATTACHMENTS,
  CONTROL_VERBS,
  isTileState,
  isCapturingRow,
  controlAxisTile,
  controlVerbForRow,
  deriveTileState,
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

describe('closed tile sets', () => {
  test('seven states, capturing lifecycles and verbs match the ratified lists and freeze', () => {
    assert.deepEqual(TILE_STATES,
      ['connecting', 'live', 'folded', 'human-control', 'agent-acting', 'lost', 'error']);
    assert.deepEqual(CAPTURING_LIFECYCLES, ['active', 'standby', 'ceded']);
    assert.deepEqual(CONNECTING_ATTACHMENTS, ['attaching', 'restoring']);
    assert.deepEqual(CONTROL_VERBS, ['take_control', 'release_control']);
    for (const set of [TILE_STATES, CAPTURING_LIFECYCLES, CONNECTING_ATTACHMENTS, CONTROL_VERBS]) {
      assert.equal(Object.isFrozen(set), true);
      assert.throws(() => set.push('mutant'), TypeError);
    }
  });

  test('state guard admits the seven states only; every mutant refuses', () => {
    for (const state of TILE_STATES) assert.equal(isTileState(state), true);
    for (const bad of ['', 'LIVE', 'fold', 'waiting', 'stale', 'destroyed', 'human', 'agent',
      'connecting ', 7, null, undefined, {}, ['live']]) {
      assert.equal(isTileState(bad), false, JSON.stringify(bad));
    }
  });
});

describe('capture flag', () => {
  test('drawable lifecycles keep capturing; terminal, unknown and missing rows stop', () => {
    for (const lifecycle of ['active', 'standby', 'ceded']) {
      assert.equal(isCapturingRow(tileRow('a', { backendLifecycle: lifecycle })), true, lifecycle);
    }
    for (const lifecycle of ['lost', 'destroyed', 'melted', '', null, undefined]) {
      assert.equal(isCapturingRow(tileRow('a', { backendLifecycle: lifecycle })), false,
        String(lifecycle));
    }
    assert.equal(isCapturingRow(null), false);
  });
});

describe('control axis', () => {
  test('folded wins over ownership; human, agent, then plain live', () => {
    assert.equal(controlAxisTile(tileRow('a', { visibility: 'folded', control: 'agent' })), 'folded');
    assert.equal(controlAxisTile(tileRow('a', { control: 'human' })), 'human-control');
    assert.equal(controlAxisTile(tileRow('a', { control: 'agent' })), 'agent-acting');
    assert.equal(controlAxisTile(tileRow('a', { control: 'shared' })), 'live');
    assert.equal(controlAxisTile(tileRow('a', { control: 'unknown' })), 'live');
    assert.equal(controlAxisTile(null), 'live');
  });
});

describe('control verb resolution', () => {
  test('explicit bare and kit-namespaced verbs win over the row', () => {
    const human = tileRow('a', { control: 'human' });
    const agent = tileRow('a', { control: 'agent' });
    assert.equal(controlVerbForRow(human, 'release_control'), 'release_control');
    assert.equal(controlVerbForRow(agent, 'take_control'), 'take_control');
    assert.equal(controlVerbForRow(human, 'surface_request.release_control'), 'release_control');
    assert.equal(controlVerbForRow(agent, 'surface_request.take_control'), 'take_control');
  });

  test('without an explicit verb every row requests control; release is never inferred', () => {
    assert.equal(controlVerbForRow(tileRow('a', { control: 'agent' }), null), 'take_control');
    assert.equal(controlVerbForRow(tileRow('a', { control: 'agent' }), undefined), 'take_control');
    assert.equal(controlVerbForRow(tileRow('a', { control: 'human' }), null), 'take_control');
    assert.equal(controlVerbForRow(tileRow('a', { control: 'shared' }), { verb: 'fold' }), 'take_control');
    assert.equal(controlVerbForRow(null, null), 'take_control');
  });

  test('negative controls: garbage verbs never leak through; casing is exact', () => {
    const agent = tileRow('a', { control: 'agent' });
    for (const bad of ['', 'TAKE_CONTROL', 'RELEASE_CONTROL', 'surface_request.RELEASE_CONTROL',
      'take control', 'take-control', 'destroy', 7, {}, []]) {
      assert.equal(controlVerbForRow(agent, bad), 'take_control', JSON.stringify(bad));
      assert.equal(controlVerbForRow(tileRow('a', { control: 'human' }), bad), 'take_control',
        JSON.stringify(bad));
    }
  });

  test('negative control: the old agent fallback fails the take-control oracle', async () => {
    const source = readFileSync(new URL('../src/wall/tileStates.js', import.meta.url), 'utf8');
    const mutant = source.replace(/(export function controlVerbForRow\(row, asked\) \{[\s\S]*?)  return 'take_control';\n\}/,
      "$1  return controlAxisTile(row) === 'agent-acting' ? 'release_control' : 'take_control';\n}");
    assert.notEqual(mutant, source, 'mutation must install the old inferred-release defect');
    const legacy = await import(`data:text/javascript;base64,${Buffer.from(mutant).toString('base64')}`);
    const agent = tileRow('a', { control: 'agent' });
    for (const asked of [null, undefined, '', 'RELEASE_CONTROL']) {
      assert.equal(legacy.controlVerbForRow(agent, asked), 'release_control', 'old defect reproduced');
      assert.throws(() => assert.equal(legacy.controlVerbForRow(agent, asked), 'take_control'),
        assert.AssertionError, 'corrected oracle rejects the old defect');
      assert.equal(controlVerbForRow(agent, asked), 'take_control');
    }
  });
});

describe('tile derivation precedence', () => {
  test('typed refusal wins as the error tile with the coded status', () => {
    const row = tileRow('a', { refusal: { code: 'POLICY', message: 'denied' } });
    const decided = deriveTileState(liveSnapshot([row]), row);
    assert.equal(decided.tile, 'error');
    assert.equal(decided.status, 'Refused: POLICY');
    assert.equal(decided.keepsCapturing, true);
    assert.equal(Object.isFrozen(decided), true);
    const snapshotError = liveSnapshot([tileRow('a')],
      { error: { code: 'BUDGET_EXCEEDED', message: 'spent' } });
    const fallback = deriveTileState(snapshotError, tileRow('a'));
    assert.equal(fallback.tile, 'error');
    assert.equal(fallback.status, 'Refused: BUDGET_EXCEEDED');
  });

  test('negative controls: codeless refusals never become the error tile', () => {
    for (const refusal of [null, undefined, {}, { code: '' }, { code: 7 }, 'POLICY']) {
      const row = tileRow('a', { refusal });
      const decided = deriveTileState(liveSnapshot([row]), row);
      assert.equal(decided.tile, 'live', JSON.stringify(refusal));
      assert.equal(decided.status, 'Live', JSON.stringify(refusal));
    }
  });

  test('terminal lifecycles map to the lost tile and stop capture', () => {
    for (const [lifecycle, status] of [['lost', 'Lost'], ['destroyed', 'Destroyed']]) {
      const row = tileRow('a', { backendLifecycle: lifecycle });
      const decided = deriveTileState(liveSnapshot([row]), row);
      assert.equal(decided.tile, 'lost', lifecycle);
      assert.equal(decided.status, status, lifecycle);
      assert.equal(decided.keepsCapturing, false, lifecycle);
    }
  });

  test('unknown lifecycle or missing row is connecting and never live', () => {
    const odd = tileRow('a', { backendLifecycle: 'melted' });
    const decided = deriveTileState(liveSnapshot([odd]), odd);
    assert.deepEqual({ ...decided },
      { tile: 'connecting', status: 'Waiting', controlVerb: 'take_control', keepsCapturing: false });
    const missing = deriveTileState(liveSnapshot([tileRow('a')]), null);
    assert.equal(missing.tile, 'connecting');
    assert.equal(missing.status, 'Waiting');
    assert.equal(missing.keepsCapturing, false);
  });

  test('stale transport keeps the axis tile with a Stale label and capture on', () => {
    const row = tileRow('a', { visibility: 'folded', control: 'human' });
    const decided = deriveTileState(liveSnapshot([row], { status: 'stale', stale: true }), row);
    assert.equal(decided.tile, 'folded');
    assert.equal(decided.status, 'Stale');
    assert.equal(decided.keepsCapturing, true);
    const flagOnly = deriveTileState(liveSnapshot([tileRow('a')], { stale: true }), tileRow('a'));
    assert.equal(flagOnly.status, 'Stale');
  });

  test('non-live transport without staleness is connecting and keeps nothing', () => {
    const row = tileRow('a');
    const decided = deriveTileState(
      { status: 'unavailable', stale: false, envelope: null, error: null }, row);
    assert.equal(decided.tile, 'connecting');
    assert.equal(decided.status, 'Waiting');
    assert.equal(decided.keepsCapturing, false);
  });

  test('attaching and restoring bindings connect; live and detached bind the axis', () => {
    for (const attachment of ['attaching', 'restoring']) {
      const row = tileRow('a', { attachmentState: attachment });
      const decided = deriveTileState(liveSnapshot([row]), row);
      assert.equal(decided.tile, 'connecting', attachment);
      assert.equal(decided.status, 'Connecting', attachment);
      assert.equal(decided.keepsCapturing, true, attachment);
    }
    for (const attachment of ['live', 'detached', 'disconnected', undefined]) {
      const row = tileRow('a', { attachmentState: attachment });
      const decided = deriveTileState(liveSnapshot([row]), row);
      assert.equal(decided.tile, 'live', String(attachment));
      assert.equal(decided.status, 'Live', String(attachment));
    }
  });

  test('live rows follow the fold/control axis with capture on', () => {
    const cases = [
      [{ visibility: 'folded', control: 'agent' }, 'folded'],
      [{ control: 'human' }, 'human-control'],
      [{ control: 'agent' }, 'agent-acting'],
      [{ control: 'shared' }, 'live'],
    ];
    for (const [overrides, tile] of cases) {
      const row = tileRow('a', overrides);
      const decided = deriveTileState(liveSnapshot([row]), row);
      assert.equal(decided.tile, tile, JSON.stringify(overrides));
      assert.equal(decided.status, 'Live', JSON.stringify(overrides));
      assert.equal(decided.keepsCapturing, true, JSON.stringify(overrides));
      assert.equal(Object.isFrozen(decided), true);
    }
  });

  test('status labels stay identical to the panel derivation for every shared case', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/wall/SurfacePanel.vue', import.meta.url), 'utf8');
    const blocks = [...source.matchAll(/<script(\s+setup)?>([\s\S]*?)<\/script>/g)];
    const pure = blocks.filter((match) => !match[1])[0][2];
    const panel = await import(`data:text/javascript;base64,${Buffer.from(pure).toString('base64')}`);
    const rows = [
      tileRow('a'),
      tileRow('b', { backendLifecycle: 'lost' }),
      tileRow('c', { backendLifecycle: 'destroyed' }),
      tileRow('d', { backendLifecycle: 'melted' }),
      tileRow('e', { refusal: { code: 'POLICY', message: 'denied' } }),
    ];
    for (const row of rows) {
      const snapshot = liveSnapshot(rows);
      assert.equal(deriveTileState(snapshot, row).status,
        panel.derivePanelStatus(snapshot, row), row.id);
    }
    const missingRow = deriveTileState(liveSnapshot(rows), null).status;
    assert.equal(missingRow, panel.derivePanelStatus(liveSnapshot(rows), null));
    const stale = liveSnapshot(rows, { status: 'stale', stale: true });
    assert.equal(deriveTileState(stale, rows[0]).status,
      panel.derivePanelStatus(stale, rows[0]));
  });
});
