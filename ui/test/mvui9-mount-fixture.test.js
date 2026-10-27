// MVUI9 lane A: tile-chrome alias fixture. The record is frozen pure
// data covering one recording, one screenshot, one human-control and one
// idle tile; the canonical FIXTURES inventory stays untouched (the entry
// aliases the key). The closing composition test boots the real entry
// against the real double/store once lane C lands, and skips loudly
// until then.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { FIXTURE_KEYS, FIXTURES } from '../src/fixtures/states.js';
import { isFixtureKey, parseStateQuery } from '../src/fixtures/resolveState.js';
import { TILE_CHROME_FIXTURE, TILE_CHROME_KEY, fixtureCaptureSeed } from '../src/fixtures/tileChrome.js';

/** @param {unknown} value */
function assertDeepFrozen(value) {
  assert.ok(Object.isFrozen(value));
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (entry && typeof entry === 'object') assertDeepFrozen(entry);
    }
  }
}

describe('tile-chrome alias record', () => {
  test('record is frozen pure data with the closed fixture shape', () => {
    assert.equal(TILE_CHROME_KEY, 'tile-chrome');
    const fixture = TILE_CHROME_FIXTURE;
    assert.deepEqual(Object.keys(fixture).sort(), [
      'capsules', 'density', 'epoch', 'expectedAnchors', 'key', 'revision', 'scheme', 'screen', 'ui',
    ]);
    assert.equal(fixture.key, 'tile-chrome');
    assert.equal(fixture.screen, 'wall');
    assert.equal(fixture.scheme, 'mv-light');
    assert.equal(fixture.density, 'compact');
    assertDeepFrozen(fixture);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), JSON.parse(JSON.stringify(TILE_CHROME_FIXTURE)));
  });

  test('four tiles cover recording, screenshot, human control and idle', () => {
    const capsules = TILE_CHROME_FIXTURE.capsules;
    assert.equal(capsules.length, 4);
    assert.deepEqual(capsules.map(row => row.id), ['cap-01', 'cap-02', 'cap-03', 'cap-04']);
    for (const row of capsules) {
      assert.match(row.id, /^cap-\d\d$/);
      assert.equal(row.surfaceId, row.id);
      assert.ok(row.title.length > 0);
      assert.ok(['identity-browser', 'program', 'holdings-app', 'desktop'].includes(row.kind));
      assert.equal(row.backendLifecycle, 'active');
      assert.equal(row.attachmentState, 'live');
    }
    assert.deepEqual(TILE_CHROME_FIXTURE.ui.capture, { recording: ['cap-01'], screenshot: ['cap-02'] });
    assert.equal(capsules[0].control, 'shared');
    assert.equal(capsules[1].control, 'shared');
    assert.equal(capsules[2].control, 'human');
    assert.equal(capsules[2].controlOwner, 'human');
    assert.equal(capsules[3].control, 'shared');
  });

  test('expected anchors cover chrome, wall and tile-chrome families exactly once', () => {
    const expected = TILE_CHROME_FIXTURE.expectedAnchors;
    assert.ok(expected.length > 0);
    const anchors = expected.map(row => row.anchor);
    assert.equal(new Set(anchors).size, anchors.length, 'anchors unique');
    for (const row of expected) {
      assert.ok(row.anchor.length > 0);
      assert.ok(row.role.length > 0);
    }
    assert.ok(anchors.includes('settings/scheme'));
    assert.ok(anchors.includes('terminal/toggle'));
    for (const id of ['cap-01', 'cap-02', 'cap-03', 'cap-04']) {
      assert.ok(anchors.includes(`capsule/${id}/panel`), id);
      const byAnchor = new Map(expected.map(row => [row.anchor, row.role]));
      assert.equal(byAnchor.get(`tile-${id}-record-ai`), 'button', id);
      assert.equal(byAnchor.get(`tile-${id}-screenshot`), 'button', id);
      assert.equal(byAnchor.get(`tile-${id}-recording-badge`), 'status', id);
    }
  });

  test('negative control: the uniqueness check fails on a planted duplicate', () => {
    const check = rows => {
      const anchors = rows.map(row => row.anchor);
      assert.equal(new Set(anchors).size, anchors.length, 'anchors unique');
    };
    check(TILE_CHROME_FIXTURE.expectedAnchors);
    assert.throws(() => check([...TILE_CHROME_FIXTURE.expectedAnchors, TILE_CHROME_FIXTURE.expectedAnchors[0]]),
      /anchors unique/);
  });

  test('canonical inventory stays untouched; the resolver still refuses the alias', () => {
    assert.deepEqual(FIXTURE_KEYS, [
      'empty', 'one', 'four', 'nine', 'tile-states', 'multislot', 'side-terminal-open',
      'recording', 'settings-dark', 'nested', 'creative',
    ]);
    assert.deepEqual(Object.keys(FIXTURES).sort(), [...FIXTURE_KEYS].sort());
    assert.equal(isFixtureKey('tile-chrome'), false);
    // The resolver refuses; only the entry aliases the key (wiring test boots it).
    assert.deepEqual(parseStateQuery('?state=tile-chrome'), {
      ok: false,
      error: { code: 'ERR_UNKNOWN_FIXTURE_STATE', message: 'Unknown state tile-chrome' },
    });
    assert.deepEqual(parseStateQuery('?state=one'), { ok: true, key: 'one' });
  });
});

describe('fixtureCaptureSeed', () => {
  test('tile-chrome and legacy recording plans; everything else empty', () => {
    assert.deepEqual(fixtureCaptureSeed(TILE_CHROME_FIXTURE), { record: ['cap-01'], shots: ['cap-02'] });
    assert.deepEqual(fixtureCaptureSeed(FIXTURES.recording), { record: ['cap-01'], shots: [] });
    for (const key of ['empty', 'one', 'four', 'nine', 'tile-states', 'multislot',
        'side-terminal-open', 'settings-dark', 'nested', 'creative']) {
      assert.deepEqual(fixtureCaptureSeed(FIXTURES[key]), { record: [], shots: [] }, key);
    }
    const plan = fixtureCaptureSeed(TILE_CHROME_FIXTURE);
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.record) && Object.isFrozen(plan.shots));
  });

  test('hostile inputs yield empty plans without throwing (negative controls)', () => {
    const empty = { record: [], shots: [] };
    for (const hostile of [null, undefined, 42, 'tile-chrome', [], {}, { ui: null },
        { ui: { capture: null } }, { ui: { capture: { recording: 'cap-01' } } },
        { key: 'recording' }, { key: 'recording', capsules: [{ id: '  ' }] }]) {
      const plan = fixtureCaptureSeed(hostile);
      assert.ok(Object.isFrozen(plan), JSON.stringify(hostile));
      assert.deepEqual(plan, empty, JSON.stringify(hostile));
    }
    // Mixed clean/dirty lists keep only clean ids, deduplicated — the
    // survivor case proves the collector is not a tautology.
    assert.deepEqual(
      fixtureCaptureSeed({ ui: { capture: { recording: [42, '', '  ', 'cap-01', 'cap-01'],
        screenshot: [null, 'cap-02', 'cap-02 '] } } }),
      { record: ['cap-01'], shots: ['cap-02'] });
    assert.deepEqual(fixtureCaptureSeed({ ui: { capture: { recording: ['cap-01', 'cap-01'] } } }),
      { record: ['cap-01'], shots: [] });
  });
});

// Real composition: boots the actual entry with the actual fixtureRuntime
// (hence the actual lane C double/store) once those files exist. Skips
// loudly while lane C is unmerged; fails loudly when present but broken.
const capturePresent = existsSync(new URL('../src/capture/capturePort.js', import.meta.url))
  && existsSync(new URL('../src/capture/captureDouble.js', import.meta.url));
/** @type {any} */
let realFixtureRuntime = null;
/** @type {unknown} */
let realImportError = null;
if (capturePresent) {
  try {
    realFixtureRuntime = await import('../src/fixtures/fixtureRuntime.js');
  } catch (error) {
    realImportError = error;
  }
}

test('tile-chrome boots against the real double and store with seeded state', {
  skip: capturePresent ? false : 'capture modules land with lane C (mvui9_C-drop)',
}, async () => {
  if (realImportError) throw realImportError;
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const previousBoot = globalThis.__mvuiBoot;
  const mount = { textContent: '', dataset: {} };
  let mounted = null;
  try {
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const hostAdapters = await import('../src/core/hostAdapters.js');
    const { createSettingsHost } = await import('../src/settings/settingsHost.js');
    const resolveState = await import('../src/fixtures/resolveState.js');
    const layout = await import('../src/wall/layout.js');
    const forbidden = () => { throw new Error('fixture called live preload'); };
    globalThis.window = { location: { search: '?state=tile-chrome' },
      addEventListener() {}, removeEventListener() {},
      metaviewer: { load: forbidden, save: forbidden, nestedDepth: forbidden,
        selfCapsuleId: forbidden, recordingDestination: forbidden } };
    globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
    globalThis.__mvuiBoot = {
      vue: { createApp: (_App, props) => ({ mount: selector => { mounted = { props, selector }; } }) },
      './App.vue': {},
      './core/hostAdapters.js': hostAdapters,
      './settings/settingsHost.js': { createSettingsHost },
      './fixtures/resolveState.js': resolveState,
      './fixtures/fixtureRuntime.js': realFixtureRuntime,
      './wall/layout.js': layout,
      'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
    };
    const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
      (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiBoot[${JSON.stringify(specifier)}];`)
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui9-composition`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mount.textContent, '', 'alias boots against real modules');
    assert.ok(mounted, 'mounted');
    assert.equal(mounted.props.fixture.key, 'tile-chrome');
    assert.equal(mounted.props.captureAvailable, true);
    const store = mounted.props.captureState;
    assert.ok(store && typeof store === 'object', 'store passed');
    for (const name of ['toggleRecord', 'screenshot', 'refresh', 'dispose']) {
      assert.equal(typeof store[name], 'function', `store.${name}`);
    }
    assert.ok(store.bySurface && typeof store.bySurface === 'object', 'store.bySurface');
    assert.ok(Array.isArray(store.rows), 'store.rows');
    const entryFor = id => (store.bySurface instanceof Map ? store.bySurface.get(id) : store.bySurface[id]) ?? null;
    // Bounded settle: the seeded recording/shot land through the real
    // store event path, which may trail the awaited seed calls by a tick.
    let settled = false;
    for (let attempt = 0; attempt < 50 && !settled; attempt += 1) {
      const recording = entryFor('cap-01');
      const shot = entryFor('cap-02');
      settled = !!recording && recording.phase === 'recording' && !!recording.recordingId
        && !!shot && !!shot.lastShot;
      if (!settled) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(settled, true, 'seeded recording on cap-01 and shot on cap-02');
    await store.refresh();
    const kinds = store.rows.filter(row => row.surface_id === 'cap-01' || row.surface_id === 'cap-02')
      .map(row => `${row.surface_id}:${row.kind}`).sort();
    assert.ok(kinds.includes('cap-01:recording'), `rows carry the seeded recording: ${kinds.join(',')}`);
    assert.ok(kinds.includes('cap-02:shot'), `rows carry the seeded shot: ${kinds.join(',')}`);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    if (previousBoot === undefined) delete globalThis.__mvuiBoot;
    else globalThis.__mvuiBoot = previousBoot;
  }
});
