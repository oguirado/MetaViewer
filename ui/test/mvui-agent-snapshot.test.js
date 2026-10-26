// agent_lane/v1 snapshot producer: DOM collection, lane factory, strict
// anchor gate, kit-inventory audit, and closed-shape validation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_LANE_SCHEMA,
  AGENT_LANE_GLOBAL,
  ANCHORED_SELECTOR,
  INTERACTIVE_SELECTOR,
  collectAgentControls,
  createAgentLane,
  installAgentLane,
  findAnchorOffenders,
  assertAnchoredControls,
  auditAnchors,
  validateSnapshotShape,
  inferRole,
  readName,
  isEnabled,
  isVisible,
  roundRect,
} from '../src/agent/agentLane.js';

/**
 * @param {object} [over]
 * @returns {any}
 */
function fakeEl(over = {}) {
  const {
    tag = 'BUTTON',
    id = '',
    attrs = {},
    text = '',
    rect = { x: 8.4, y: 9.5, width: 120, height: 32 },
    disabled = false,
  } = over;
  const attributes = new Map(Object.entries(attrs));
  return {
    tagName: tag,
    id,
    disabled,
    textContent: text,
    getAttribute: (/** @type {string} */ name) => (attributes.has(name) ? attributes.get(name) : null),
    hasAttribute: (/** @type {string} */ name) => attributes.has(name),
    getBoundingClientRect: () => ({ ...rect }),
  };
}

/**
 * Asserts a call throws a coded lane error.
 * @param {() => void} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(/** @type {any} */ (error).code, code);
    return;
  }
  assert.fail(`expected throw with code ${code}`);
}

/**
 * @param {any[]} nodes
 * @returns {any}
 */
function fakeRoot(nodes) {
  return {
    querySelectorAll: (/** @type {string} */ selector) => {
      assert.equal(selector, ANCHORED_SELECTOR);
      return nodes.filter((node) => node.getAttribute('data-semantic-anchor') !== null);
    },
  };
}

test('schema and global identities are frozen', () => {
  assert.equal(AGENT_LANE_SCHEMA, 'agent_lane/v1');
  assert.equal(AGENT_LANE_GLOBAL, '__agentLane');
  assert.equal(ANCHORED_SELECTOR, '[data-semantic-anchor]');
  assert.ok(INTERACTIVE_SELECTOR.includes('button'));
});

test('collects anchored controls in document order with closed keys', () => {
  const root = fakeRoot([
    fakeEl({ id: 'shell-theme', attrs: { 'data-semantic-anchor': 'settings/scheme', 'aria-label': 'Dark mode' } }),
    fakeEl({ id: 'shell-terminal', attrs: { 'data-semantic-anchor': 'terminal/toggle' }, text: 'Terminal' }),
  ]);
  const { controls, skipped } = collectAgentControls(root);
  assert.equal(controls.length, 2);
  assert.equal(skipped.length, 0);
  assert.deepEqual(Object.keys(controls[0]).sort(), ['anchor', 'enabled', 'id', 'name', 'rect', 'role', 'visible']);
  assert.deepEqual(controls[0], {
    id: 'shell-theme',
    anchor: 'settings/scheme',
    role: 'button',
    name: 'Dark mode',
    enabled: true,
    visible: true,
    rect: { x: 8, y: 10, width: 120, height: 32 },
  });
  assert.equal(controls[1]?.name, 'Terminal');
  assert.ok(Object.isFrozen(controls));
  assert.ok(Object.isFrozen(controls[0]));
});

test('role and name inference cover native controls', () => {
  assert.equal(inferRole(fakeEl({ tag: 'INPUT', attrs: { type: 'checkbox' } })), 'checkbox');
  assert.equal(inferRole(fakeEl({ tag: 'SELECT' })), 'combobox');
  assert.equal(inferRole(fakeEl({ tag: 'TEXTAREA' })), 'textbox');
  assert.equal(inferRole(fakeEl({ tag: 'DIV', attrs: { role: 'region' } })), 'region');
  assert.equal(inferRole(fakeEl({ tag: 'DIV' })), 'generic');
  assert.equal(readName(fakeEl({ text: '  Save   now  ' })), 'Save now');
  assert.equal(readName(fakeEl({ attrs: { placeholder: 'Find…' } })), 'Find…');
  assert.equal(readName(fakeEl({})), '');
});

test('enabled and visible honor disabled/hidden/sizeless nodes', () => {
  assert.equal(isEnabled(fakeEl({ disabled: true })), false);
  assert.equal(isEnabled(fakeEl({ attrs: { 'aria-disabled': 'true' } })), false);
  assert.equal(isEnabled(fakeEl({})), true);
  assert.equal(isVisible(fakeEl({ attrs: { hidden: '' } }), { x: 0, y: 0, width: 4, height: 4 }), false);
  assert.equal(isVisible(fakeEl({ attrs: { 'aria-hidden': 'true' } }), { x: 0, y: 0, width: 4, height: 4 }), false);
  assert.equal(isVisible(fakeEl({}), null), false);
  assert.equal(isVisible(fakeEl({}), { x: 0, y: 0, width: 4, height: 4 }), true);
});

test('anchored nodes without a stable id are skipped with a reason', () => {
  const root = fakeRoot([
    fakeEl({ attrs: { 'data-semantic-anchor': 'dialog/open/create' }, text: 'Create' }),
    fakeEl({ id: 'ok-button', attrs: { 'data-semantic-anchor': 'dialog/open/confirm' }, text: 'OK' }),
  ]);
  const { controls, skipped } = collectAgentControls(root);
  assert.equal(controls.length, 1);
  assert.deepEqual(skipped, [{ anchor: 'dialog/open/create', id: null, reason: 'missing-id' }]);
});

test('collection without a queryable root is a typed error', () => {
  throwsCode(() => collectAgentControls(null), 'ERR_AGENT_LANE_NO_ROOT');
  throwsCode(() => collectAgentControls({}), 'ERR_AGENT_LANE_NO_ROOT');
  throwsCode(() => createAgentLane({ root: null }), 'ERR_AGENT_LANE_NO_ROOT');
});

describe('createAgentLane snapshot()', () => {
  test('returns a frozen agent_lane/v1 snapshot asynchronously', async () => {
    const lane = createAgentLane({ root: fakeRoot([]), screen: 'wall', fixture: 'empty' });
    const snapshot = await lane.snapshot();
    assert.equal(lane.snapshot.constructor.name, 'AsyncFunction');
    assert.equal(snapshot.schema, 'agent_lane/v1');
    assert.equal(snapshot.screen, 'wall');
    assert.deepEqual(snapshot.state, { source: 'dom', fixture: 'empty', collected: 0, skipped: [] });
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.controls));
    assert.ok(Object.isFrozen(snapshot.state));
    assert.deepEqual(validateSnapshotShape(snapshot), { ok: true });
  });

  test('screen falls back to wall and snapshots are deterministic', async () => {
    const nodes = [
      fakeEl({ id: 'a-button', attrs: { 'data-semantic-anchor': 'capsule/cap-01/fold' }, text: 'Fold' }),
    ];
    const lane = createAgentLane({ root: fakeRoot(nodes) });
    const first = await lane.snapshot();
    const second = await lane.snapshot();
    assert.equal(first.screen, 'wall');
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  });

  test('screen readers that misbehave fall back to wall', async () => {
    const lane = createAgentLane({ root: fakeRoot([]), screen: () => 42 });
    const snapshot = await lane.snapshot();
    assert.equal(snapshot.screen, 'wall');
  });
});

describe('installAgentLane', () => {
  test('installs and uninstalls on a plain host object', () => {
    const host = {};
    const uninstall = installAgentLane(host, { root: fakeRoot([]), screen: 'nested' });
    assert.equal(typeof host.__agentLane.snapshot, 'function');
    assert.ok(Object.isFrozen(host.__agentLane));
    uninstall();
    assert.equal(host.__agentLane, undefined);
  });

  test('double installation is a typed error, never a silent overwrite', () => {
    const host = {};
    const uninstall = installAgentLane(host, { root: fakeRoot([]) });
    throwsCode(() => installAgentLane(host, { root: fakeRoot([]) }), 'ERR_AGENT_LANE_MOUNTED');
    uninstall();
    throwsCode(() => installAgentLane(null, { root: fakeRoot([]) }), 'ERR_AGENT_LANE_NO_TARGET');
  });
});

describe('strict id+anchor gate', () => {
  test('clean interactive sets pass', () => {
    assertAnchoredControls([
      fakeEl({ id: 'a', attrs: { 'data-semantic-anchor': 'capsule/cap-01/fold' } }),
      fakeEl({ tag: 'INPUT', id: 'b', attrs: { 'data-semantic-anchor': 'dialog/open/name', type: 'text' } }),
    ]);
    assert.deepEqual(findAnchorOffenders([]), []);
  });

  test('a missing anchor fails the gate with a typed error', () => {
    const offenders = findAnchorOffenders([fakeEl({ tag: 'BUTTON', id: 'naked' })]);
    assert.deepEqual(offenders, [{ tag: 'BUTTON', id: 'naked', anchor: null, reason: 'missing-anchor' }]);
    throwsCode(() => assertAnchoredControls([fakeEl({ tag: 'BUTTON', id: 'naked' })]), 'ERR_AGENT_LANE_ANCHOR');
  });

  test('a missing id fails the gate with a typed error', () => {
    const offenders = findAnchorOffenders([
      fakeEl({ tag: 'BUTTON', attrs: { 'data-semantic-anchor': 'capsule/cap-01/fold' } }),
    ]);
    assert.deepEqual(offenders, [{ tag: 'BUTTON', id: null, anchor: 'capsule/cap-01/fold', reason: 'missing-id' }]);
    throwsCode(
      () => assertAnchoredControls([fakeEl({ attrs: { 'data-semantic-anchor': 'capsule/cap-01/fold' } })]),
      'ERR_AGENT_LANE_ANCHOR',
    );
  });
});

describe('kit-inventory audit', () => {
  test('kit-family anchors audit as admitted with their template', () => {
    const rows = auditAnchors([
      { anchor: 'capsule/cap-01/fold', role: 'button' },
      { anchor: 'capsule/cap-01/input-mode', role: 'switch' },
    ]);
    assert.deepEqual(rows[0], {
      anchor: 'capsule/cap-01/fold',
      admitted: true,
      family: 'capsule/{id}/{fold,pin,control,close,popout,dock-back,float,maximize,hide,show}',
      roleAdmitted: true,
    });
    assert.equal(rows[1]?.admitted, true);
    assert.equal(rows[1]?.roleAdmitted, true);
  });

  test('anchors outside the kit inventory audit as not admitted', () => {
    const rows = auditAnchors([
      { anchor: 'wall/add-capsule', role: 'button' },
      { anchor: 'capsule/cap-01/fold', role: 'textbox' },
    ]);
    assert.deepEqual(rows[0], { anchor: 'wall/add-capsule', admitted: false, family: null, roleAdmitted: false });
    assert.equal(rows[1]?.admitted, true);
    assert.equal(rows[1]?.roleAdmitted, false);
  });
});

describe('validateSnapshotShape', () => {
  test('accepts a minimal closed snapshot', () => {
    assert.deepEqual(
      validateSnapshotShape({
        schema: 'agent_lane/v1',
        controls: [
          { id: 'a', anchor: 'settings/scheme', role: 'button', name: '', enabled: true, visible: false, rect: null },
        ],
        screen: 'settings',
        state: { source: 'dom', fixture: null, collected: 1, skipped: [] },
      }),
      { ok: true },
    );
  });

  test('rejects non-closed or mistyped snapshots', () => {
    const good = {
      schema: 'agent_lane/v1',
      controls: [],
      screen: 'wall',
      state: { source: 'dom', fixture: null, collected: 0, skipped: [] },
    };
    assert.deepEqual(validateSnapshotShape({ ...good, schema: 'agent_lane/v2' }).ok, false);
    assert.deepEqual(validateSnapshotShape({ ...good, controls: [{ id: 'a' }] }).ok, false);
    assert.deepEqual(
      validateSnapshotShape({
        ...good,
        controls: [
          { id: 'a', anchor: 'x', role: 'button', name: '', enabled: true, visible: true, rect: { x: 0, y: 0, width: 0, height: 4 }, extra: 1 },
        ],
      }).ok,
      false,
    );
    assert.deepEqual(validateSnapshotShape(null).ok, false);
    assert.deepEqual(validateSnapshotShape('agent_lane/v1').ok, false);
    for (const result of [
      validateSnapshotShape({ ...good, schema: 'agent_lane/v2' }),
      validateSnapshotShape({ ...good, controls: [{ id: 'a' }] }),
    ]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'ERR_AGENT_LANE_SHAPE');
    }
  });
});

describe('roundRect', () => {
  test('rounds finite boxes and accepts legacy left/top shapes', () => {
    assert.deepEqual(roundRect({ x: 1.4, y: 2.5, width: 10.2, height: 9.6 }), { x: 1, y: 3, width: 10, height: 10 });
    assert.deepEqual(roundRect({ left: 4, top: 5, width: 6, height: 7 }), { x: 4, y: 5, width: 6, height: 7 });
  });

  test('rejects sizeless, non-finite, and non-object boxes', () => {
    assert.equal(roundRect({ x: 0, y: 0, width: 0, height: 4 }), null);
    assert.equal(roundRect({ x: 0, y: 0, width: -1, height: 4 }), null);
    assert.equal(roundRect({ x: NaN, y: 0, width: 4, height: 4 }), null);
    assert.equal(roundRect({ x: 0, y: 0, width: 4 }), null);
    assert.equal(roundRect(null), null);
    assert.equal(roundRect('4x4'), null);
  });
});
