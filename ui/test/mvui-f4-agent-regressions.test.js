import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAgentControls, createAgentLane, findAnchorOffenders,
  assertAnchoredControls, validateSnapshotShape,
} from '../src/agent/agentLane.js';

function node(id, anchor) {
  return {
    id, tagName: 'BUTTON', textContent: 'Open',
    getAttribute: name => name === 'data-semantic-anchor' ? anchor : null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  };
}
const root = nodes => ({ querySelectorAll: () => nodes });

test('collector trims identities and skips whitespace-only ids and anchors', () => {
  const result = collectAgentControls(root([
    node(' \t ', 'wall/add-capsule'), node('open', ' \n '),
    node(' open ', ' wall/add-capsule '),
  ]));
  assert.deepEqual(result.controls.map(({ id, anchor }) => ({ id, anchor })), [
    { id: 'open', anchor: 'wall/add-capsule' },
  ]);
  assert.deepEqual(result.skipped.map(row => row.reason), ['missing-id', 'empty-anchor']);
});

test('strict gate rejects whitespace identities while admitting trimmed controls', () => {
  for (const invalid of [node(' \t ', 'wall/add-capsule'), node('open', ' \n ')]) {
    assert.equal(findAnchorOffenders([invalid]).length, 1);
    assert.throws(() => assertAnchoredControls([invalid]), { code: 'ERR_AGENT_LANE_ANCHOR' });
  }
  assert.doesNotThrow(() => assertAnchoredControls([node('open', 'wall/add-capsule')]));
});

test('snapshot validation rejects whitespace-only identities', async () => {
  const snapshot = await createAgentLane({ root: root([node('open', 'wall/add-capsule')]) }).snapshot();
  assert.deepEqual(validateSnapshotShape(snapshot), { ok: true });
  for (const field of ['id', 'anchor']) {
    const malformed = { ...snapshot, controls: [{ ...snapshot.controls[0], [field]: ' \n\t ' }] };
    assert.equal(validateSnapshotShape(malformed).ok, false, field);
  }
});

test('throwing custom screen reader falls back without losing controls', async () => {
  const lane = createAgentLane({
    root: root([node('open', 'wall/add-capsule')]),
    screen: () => { throw new Error('untrusted reader failure'); },
  });
  const snapshot = await lane.snapshot();
  assert.equal(snapshot.screen, 'wall');
  assert.equal(snapshot.controls.length, 1);
  assert.deepEqual(validateSnapshotShape(snapshot), { ok: true });
  assert.equal((await createAgentLane({ root: root([]), screen: () => 'settings' }).snapshot()).screen, 'settings');
});
