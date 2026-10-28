// MVUI25 lane A: ?state=input-write alias fixture. One human-controlled
// wall tile in WRITE; the canonical FIXTURES inventory stays untouched
// (the entry aliases the key like tile-chrome). Every behaviour test has
// a negative control; async waits only via frame-wait.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIXTURE_KEYS, FIXTURES } from '../src/fixtures/states.js';
import { isFixtureKey, parseStateQuery } from '../src/fixtures/resolveState.js';
import { INPUT_WRITE_FIXTURE, INPUT_WRITE_KEY } from '../src/fixtures/inputWrite.js';
import { tick } from './frame-wait.mjs';

/** @param {unknown} value */
function assertDeepFrozen(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (entry && typeof entry === 'object') assertDeepFrozen(entry);
    }
  }
}

describe('input-write alias record', () => {
  test('record is frozen pure data with the closed fixture shape', () => {
    assert.equal(INPUT_WRITE_KEY, 'input-write');
    const fixture = INPUT_WRITE_FIXTURE;
    assert.deepEqual(Object.keys(fixture).sort(), [
      'capsules', 'density', 'epoch', 'expectedAnchors', 'key', 'revision', 'scheme', 'screen', 'ui',
    ]);
    assert.equal(fixture.key, 'input-write');
    assert.equal(fixture.screen, 'wall');
    assert.equal(fixture.scheme, 'mv-light');
    assert.equal(fixture.density, 'compact');
    assertDeepFrozen(fixture);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), JSON.parse(JSON.stringify(INPUT_WRITE_FIXTURE)));
  });

  test('one human-controlled tile in WRITE', () => {
    const capsules = INPUT_WRITE_FIXTURE.capsules;
    assert.equal(capsules.length, 1);
    const row = capsules[0];
    assert.match(row.id, /^cap-\d\d$/);
    assert.equal(row.surfaceId, row.id);
    assert.ok(row.title.length > 0);
    assert.equal(row.backendLifecycle, 'active');
    assert.equal(row.attachmentState, 'live');
    assert.equal(row.control, 'human');
    assert.equal(row.controlOwner, 'human');
    assert.deepEqual(INPUT_WRITE_FIXTURE.ui, { launcherOpen: false, inputMode: 'WRITE' });
  });

  test('negative control: the human+WRITE check fails when control or mode is stripped', () => {
    const check = (fixture) => fixture.capsules.length === 1
      && fixture.capsules[0].control === 'human'
      && fixture.ui?.inputMode === 'WRITE';
    assert.equal(check(INPUT_WRITE_FIXTURE), true);
    assert.equal(check({ ...INPUT_WRITE_FIXTURE, capsules: [{ ...INPUT_WRITE_FIXTURE.capsules[0], control: 'shared' }] }), false);
    assert.equal(check({ ...INPUT_WRITE_FIXTURE, ui: { launcherOpen: false, inputMode: 'READ' } }), false);
  });

  test('expected anchors cover chrome and the wall tile exactly once', () => {
    const expected = INPUT_WRITE_FIXTURE.expectedAnchors;
    assert.ok(expected.length > 0);
    const anchors = expected.map((row) => row.anchor);
    assert.equal(new Set(anchors).size, anchors.length, 'anchors unique');
    for (const row of expected) {
      assert.ok(row.anchor.length > 0);
      assert.ok(row.role.length > 0);
    }
    assert.ok(anchors.includes('settings/scheme'));
    assert.ok(anchors.includes('terminal/toggle'));
    assert.ok(anchors.includes('capsule/cap-01/panel'));
    const byAnchor = new Map(expected.map((row) => [row.anchor, row.role]));
    assert.equal(byAnchor.get('capsule/cap-01/panel'), 'region');
  });

  test('negative control: the uniqueness check fails on a planted duplicate', () => {
    const check = (rows) => new Set(rows.map((row) => row.anchor)).size === rows.length;
    assert.equal(check(INPUT_WRITE_FIXTURE.expectedAnchors), true);
    assert.equal(check([...INPUT_WRITE_FIXTURE.expectedAnchors, INPUT_WRITE_FIXTURE.expectedAnchors[0]]), false);
  });

  test('canonical inventory untouched: input-write is not a FIXTURES key', async () => {
    await tick();
    assert.equal(FIXTURE_KEYS.includes(INPUT_WRITE_KEY), false);
    assert.equal(Object.hasOwn(FIXTURES, INPUT_WRITE_KEY), false);
    assert.equal(isFixtureKey(INPUT_WRITE_KEY), false);
    assert.equal(parseStateQuery('?state=input-write').ok, false);
  });

  test('negative control: the alias check fails for a canonical key', async () => {
    await tick();
    assert.equal(FIXTURE_KEYS.includes('one'), true);
    assert.equal(isFixtureKey('one'), true);
    assert.equal(parseStateQuery('?state=one').ok, true);
  });

  test('App initial mode reads the fixture WRITE flag (shared wall/multislot ref)', () => {
    const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
    assert.ok(app.includes("String(props.fixture?.ui?.inputMode ?? '').toLowerCase() === 'write' ? 'write' : 'read'"),
      'fixture-driven initial mode');
    assert.ok(app.includes('v-model:input-mode="inputMode"'), 'multislot keeps the shared ref');
    // The flag values the init reads: input-write WRITE, multislot READ.
    assert.equal(INPUT_WRITE_FIXTURE.ui.inputMode, 'WRITE');
    assert.equal(FIXTURES.multislot.ui.inputMode, 'READ');
  });

  test('negative control: the init check fails when the fixture flag is dropped', () => {
    const read = (fixture) => String(fixture?.ui?.inputMode ?? '').toLowerCase() === 'write' ? 'write' : 'read';
    assert.equal(read(INPUT_WRITE_FIXTURE), 'write');
    assert.equal(read(FIXTURES.multislot), 'read');
    assert.equal(read(null), 'read');
    assert.throws(() => assert.equal(read({ ui: { inputMode: 'Write ' } }), 'write'), assert.AssertionError);
  });

  test('entry aliases input-write without widening canonical states', () => {
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    for (const snippet of ['INPUT_WRITE_KEY', 'INPUT_WRITE_FIXTURE', 'isInputWrite']) {
      assert.ok(main.includes(snippet), `entry ships: ${snippet}`);
    }
    assert.ok(main.includes('requestedStates[0] === INPUT_WRITE_KEY'), 'alias key match');
  });

  test('rss stays under 512 MiB', () => {
    const rss = process.memoryUsage().rss;
    if (process.env.MVUI16_MEASURE) console.log(`mvui25-mount-fixture rss MiB: ${Math.round(rss / 1048576)}`);
    assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
  });
});
