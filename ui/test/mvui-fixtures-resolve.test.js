// ?state= fixtures: closed key set, frozen pure data, total resolver,
// and kit-admitted expected anchors.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_KEYS, FIXTURES } from '../src/fixtures/states.js';
import { listFixtureKeys, isFixtureKey, parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { auditAnchors } from '../src/agent/agentLane.js';

/** @param {unknown} value */
function assertDeepFrozen(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (entry && typeof entry === 'object') assertDeepFrozen(entry);
    }
  }
}

test('the key set is exactly the room states in order', () => {
  assert.deepEqual(listFixtureKeys(), [
    'empty',
    'one',
    'four',
    'nine',
    'tile-states',
    'multislot',
    'side-terminal-open',
    'recording',
    'settings-dark',
    'nested',
    'creative',
  ]);
  assert.deepEqual(FIXTURE_KEYS, listFixtureKeys());
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...FIXTURE_KEYS].sort());
});

test('every fixture is frozen pure data with a closed shape', () => {
  for (const key of FIXTURE_KEYS) {
    const fixture = FIXTURES[key];
    assert.deepEqual(Object.keys(fixture).sort(), [
      'capsules',
      'density',
      'epoch',
      'expectedAnchors',
      'key',
      'revision',
      'scheme',
      'screen',
      'ui',
    ]);
    assert.equal(fixture.key, key);
    assert.ok(['wall', 'multislot', 'settings', 'nested', 'creative'].includes(fixture.screen), key);
    assert.ok(['mv-light', 'mv-dark'].includes(fixture.scheme), key);
    assert.equal(fixture.density, 'compact', key);
    assertDeepFrozen(fixture);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), JSON.parse(JSON.stringify(FIXTURES[key])), key);
  }
});

test('capsule rows carry immutable identities and projection fields', () => {
  const seen = new Set();
  for (const key of FIXTURE_KEYS) {
    for (const row of FIXTURES[key].capsules) {
      assert.match(row.id, /^cap-\d\d$/, key);
      assert.equal(row.surfaceId, row.id, key);
      assert.ok(row.title.length > 0, key);
      assert.ok(['identity-browser', 'program', 'holdings-app', 'desktop'].includes(row.kind), key);
      assert.ok(Number.isSafeInteger(row.generation) && row.generation > 0, key);
      seen.add(`${key}:${row.id}`);
    }
    const ids = FIXTURES[key].capsules.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate capsule id in ${key}`);
  }
  assert.ok(seen.size > 0);
});

test('tile-states covers the seven tile treatments', () => {
  const rows = FIXTURES['tile-states'].capsules;
  assert.equal(rows.length, 7);
  assert.equal(rows[0]?.attachmentState, 'attaching');
  assert.equal(rows[1]?.attachmentState, 'live');
  assert.equal(rows[2]?.visibility, 'folded');
  assert.equal(rows[2]?.backendLifecycle, 'active');
  assert.equal(rows[3]?.control, 'human');
  assert.equal(rows[4]?.control, 'agent');
  assert.equal(rows[4]?.aiSessionActivity, 'busy');
  assert.equal(rows[5]?.backendLifecycle, 'lost');
  assert.equal(rows[6]?.aiSessionActivity, 'failed');
  assert.equal(rows[6]?.dispatchOutcome, 'refused');
});

test('screen flag fixtures carry their discriminating state', () => {
  assert.equal(FIXTURES.empty.capsules.length, 0);
  assert.equal(FIXTURES.one.capsules.length, 1);
  assert.equal(FIXTURES.four.capsules.length, 4);
  assert.equal(FIXTURES.nine.capsules.length, 9);
  assert.deepEqual(FIXTURES.multislot.ui, {
    provider: 'claude',
    inputMode: 'READ',
    terminalAttached: true,
    terminalSession: 'term-01',
  });
  assert.deepEqual(FIXTURES['side-terminal-open'].ui, {
    sideTerminal: { open: true, width: 420, overlay: true },
  });
  assert.deepEqual(FIXTURES.recording.ui, {
    recording: { ram: true, screenshotArmed: true, disk: { configured: false } },
  });
  assert.equal(FIXTURES['settings-dark'].screen, 'settings');
  assert.equal(FIXTURES['settings-dark'].scheme, 'mv-dark');
  assert.deepEqual(FIXTURES.nested.ui, { nested: { depth: 1, displayOnly: true } });
});

test('nested carries no self-capsule and no control anchors', () => {
  const fixture = FIXTURES.nested;
  assert.ok(fixture.capsules.length > 0);
  for (const row of fixture.capsules) {
    assert.notEqual(row.id, 'self');
  }
  for (const expected of fixture.expectedAnchors) {
    assert.doesNotMatch(expected.anchor, /\/control$/);
  }
});

describe('expected anchors', () => {
  test('every fixture expects anchors with roles', () => {
    for (const key of FIXTURE_KEYS) {
      const expected = FIXTURES[key].expectedAnchors;
      assert.ok(expected.length > 0, key);
      for (const row of expected) {
        assert.ok(row.anchor.length > 0, key);
        assert.ok(row.role.length > 0, key);
      }
      const anchors = expected.map((row) => row.anchor);
      assert.equal(new Set(anchors).size, anchors.length, `duplicate anchor in ${key}`);
    }
  });

  test('multislot and side-terminal pin the published U3 anchors', () => {
    const multislot = FIXTURES.multislot.expectedAnchors.map((row) => row.anchor);
    assert.ok(multislot.includes('capsule/cap-01/slot'));
    assert.ok(multislot.includes('capsule/cap-01/input-mode'));
    assert.ok(multislot.includes('capsule/cap-01/copy-id'));
    assert.ok(multislot.includes('capsule/cap-01/terminal'));
    const overlay = FIXTURES['side-terminal-open'].expectedAnchors.map((row) => row.anchor);
    assert.ok(overlay.includes('terminal/overlay'));
  });

  test('empty expects the launcher anchor; settings-dark expects density', () => {
    const empty = FIXTURES.empty.expectedAnchors.map((row) => row.anchor);
    assert.ok(empty.includes('wall/add-capsule'));
    const settings = FIXTURES['settings-dark'].expectedAnchors.map((row) => row.anchor);
    assert.ok(settings.includes('settings/scheme'));
    assert.ok(settings.includes('settings/density'));
  });

  test('capsule-scoped anchors audit against the kit inventory', () => {
    const rows = auditAnchors(FIXTURES['tile-states'].expectedAnchors);
    const scoped = rows.filter((row) => row.anchor.startsWith('capsule/'));
    assert.ok(scoped.length > 0);
    for (const row of scoped) {
      assert.equal(row.admitted, true, row.anchor);
      assert.equal(row.roleAdmitted, true, row.anchor);
    }
  });
});

describe('parseStateQuery', () => {
  test('resolves every canonical key with and without a leading question mark', () => {
    for (const key of FIXTURE_KEYS) {
      assert.deepEqual(parseStateQuery(`?state=${key}`), { ok: true, key });
      assert.deepEqual(parseStateQuery(`state=${key}`), { ok: true, key });
      assert.deepEqual(parseStateQuery(`?x=1&state=${key}&y=2`), { ok: true, key });
    }
  });

  test('unknown, missing, and malformed queries are typed refusals', () => {
    assert.deepEqual(parseStateQuery('?state=nope'), {
      ok: false,
      error: { code: 'ERR_UNKNOWN_FIXTURE_STATE', message: 'Unknown state nope' },
    });
    assert.deepEqual(parseStateQuery('?state=').ok, false);
    assert.deepEqual(parseStateQuery('').ok, false);
    assert.deepEqual(parseStateQuery('?other=1').ok, false);
    assert.deepEqual(parseStateQuery(null).ok, false);
    assert.deepEqual(parseStateQuery(42).ok, false);
    const missing = parseStateQuery('');
    if (!missing.ok) assert.equal(missing.error.code, 'ERR_MISSING_STATE_PARAM');
    else assert.fail('empty query must refuse');
    const invalid = parseStateQuery(null);
    if (!invalid.ok) assert.equal(invalid.error.code, 'ERR_INVALID_STATE_QUERY');
    else assert.fail('non-string query must refuse');
  });

  test('matching is exact: case and whitespace never coerce', () => {
    assert.equal(parseStateQuery('?state=Nested').ok, false);
    assert.equal(parseStateQuery('?state=%20nested').ok, false);
    assert.equal(isFixtureKey('nested '), false);
    assert.equal(isFixtureKey('NESTED'), false);
    assert.equal(isFixtureKey('nested'), true);
  });
});

describe('resolveFixture', () => {
  test('resolves every key to its frozen record', () => {
    for (const key of FIXTURE_KEYS) {
      const resolved = resolveFixture(key);
      assert.equal(resolved.ok, true);
      if (resolved.ok) {
        assert.equal(resolved.fixture.key, key);
        assert.equal(resolved.fixture, FIXTURES[key]);
      }
    }
  });

  test('unknown keys refuse without throwing', () => {
    for (const key of ['nope', '', null, undefined, 42, {}, []]) {
      const resolved = resolveFixture(key);
      assert.equal(resolved.ok, false);
      if (!resolved.ok) {
        assert.equal(resolved.error.code, 'ERR_UNKNOWN_FIXTURE_STATE');
        assert.ok(Object.isFrozen(resolved.error));
      } else {
        assert.fail(`key ${String(key)} must refuse`);
      }
    }
  });
});
