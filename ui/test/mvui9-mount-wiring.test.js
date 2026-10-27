// MVUI9 lane A: entry capture wiring. main.js keeps its closed stub-map
// import surface (new names travel through the fixtureRuntime
// re-export), builds port/store per mode, seeds fixture captures, and
// passes captureState/captureAvailable to App; App forwards them to the
// wall and the recording panel. Boots below run the real entry against
// a fake module map (the int-boot pattern) with the real tileChrome.js
// values, so no lane C file is required.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { TILE_CHROME_FIXTURE, TILE_CHROME_KEY, fixtureCaptureSeed } from '../src/fixtures/tileChrome.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');

/** @param {string} source */
function staticImportSpecifiers(source) {
  return [...source.matchAll(/^import\s+[^\n]+?\s+from\s+(['"])(.*?)\1;?$/gm)].map(match => match[2]);
}

describe('entry source shape', () => {
  test('main.js keeps its closed stub-map import surface', () => {
    assert.deepEqual(staticImportSpecifiers(main), [
      'vue',
      './App.vue',
      './core/hostAdapters.js',
      './settings/settingsHost.js',
      './fixtures/resolveState.js',
      './fixtures/fixtureRuntime.js',
      './wall/layout.js',
      'capsule-ui-kit/theme',
    ]);
    for (const name of ['TILE_CHROME_FIXTURE', 'TILE_CHROME_KEY', 'fixtureCaptureSeed',
        'createCapturePort', 'createCaptureState', 'createCaptureDouble']) {
      assert.ok(main.includes(name), `re-exported name wired: ${name}`);
    }
  });

  test('negative control: the surface check fails on a planted direct import', () => {
    assert.deepEqual(staticImportSpecifiers(main).length, 8);
    assert.throws(() => assert.deepEqual(
      staticImportSpecifiers(`${main}\nimport { x } from './capture/capturePort.js';`).length, 8),
      assert.AssertionError);
  });

  test('live capture wraps host.capture without fresh window reads', () => {
    assert.ok(main.includes('host?.capture'), 'facade reached through the pinned host read');
    assert.ok(main.includes('fixture ? captureDouble : host?.capture'), 'double backs fixtures, host backs live');
    const liveReads = main.replaceAll('__metaviewerBench', '').match(/\.metaviewer\b/g) ?? [];
    assert.equal(liveReads.length, 1, 'the single host read (layout uses bracket access)');
  });

  test('negative control: the read pin fails on a planted window read', () => {
    const count = source => (source.replaceAll('__metaviewerBench', '').match(/\.metaviewer\b/g) ?? []).length;
    assert.equal(count(main), 1);
    assert.throws(() => assert.equal(count(`${main}\nconst c = window.metaviewer.capture;`), 1),
      assert.AssertionError);
  });

  test('entry builds, seeds, passes and disposes capture', () => {
    for (const snippet of [
      "typeof createCaptureDouble === 'function' ? createCaptureDouble() : null",
      'fixture ? captureDouble !== null : true',
      'createCapturePort(',
      'createCaptureState(capturePort)',
      'capturePort.available === true',
      'fixtureCaptureSeed(fixture)',
      'await captureState.toggleRecord(surfaceId)',
      'await captureState.screenshot(surfaceId)',
      'captureState, captureAvailable,',
      'captureState?.dispose?.()',
      'isTileChrome',
    ]) {
      assert.ok(main.includes(snippet), `entry ships: ${snippet}`);
    }
  });
});

describe('App capture forwarding', () => {
  test('App declares capture props and forwards them to the wall and the panel', () => {
    assert.ok(appSource.includes('captureState: { type: Object, default: null }'), 'store prop');
    assert.ok(appSource.includes('captureAvailable: { type: Boolean, default: false }'), 'availability prop');
    assert.ok(appSource.includes(':capture-state="captureAvailable ? captureState : undefined" :display-only="nestedMode.displayOnly"'),
      'wall receives undefined without a facade (its null default applies) plus display-only mode');
    assert.ok(appSource.includes(':capture-state="captureState" :capture-available="captureAvailable"'),
      'panel receives the store plus availability');
  });

  test('negative control: the forwarding check fails when bindings are stripped', () => {
    const forwarded = source => source.includes(':capture-state="captureAvailable ? captureState : undefined"')
      && source.includes(':capture-state="captureState" :capture-available="captureAvailable"');
    assert.equal(forwarded(appSource), true);
    assert.equal(forwarded(appSource.replaceAll(':capture-state=', ':data-capture-state=')), false);
  });

  test('dispatch stays capture-free: routing lives in the bound panel', () => {
    const dispatcher = appSource.match(/function dispatch\(intent\) \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(dispatcher, 'dispatch keeps its pinned shape');
    assert.doesNotMatch(dispatcher, /capture/i, 'dispatch never references capture');
  });
});

/**
 * @param {{ available?: boolean, factories?: boolean }} [over]
 */
function fakeCapture(over = {}) {
  const calls = [];
  const double = Object.freeze({ kind: 'double' });
  const port = { available: over.available !== false, calls };
  const store = {
    bySurface: {}, rows: [], calls,
    async toggleRecord(surfaceId) { calls.push(['toggleRecord', surfaceId]); return { ok: true }; },
    async screenshot(surfaceId) { calls.push(['screenshot', surfaceId]); return { ok: true }; },
    async refresh() { calls.push(['refresh']); return { ok: true }; },
    dispose() { calls.push(['dispose']); },
  };
  const factories = over.factories === false ? {} : {
    createCaptureDouble: () => { calls.push(['createDouble']); return double; },
    createCapturePort: facade => { calls.push(['createPort', facade === double]); return port; },
    createCaptureState: candidate => { calls.push(['createState', candidate === port]); return store; },
  };
  return { calls, double, port, store, factories };
}

/**
 * Boot the real entry with a fake module map (int-boot pattern).
 * @param {string} search
 * @param {{ fixtureRuntimeExtra?: object, windowExtra?: object }} [over]
 */
async function bootEntry(search, over = {}) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const previousBoot = globalThis.__mvuiBoot;
  const mount = { textContent: '', dataset: {} };
  let mounted = null;
  try {
    const forbidden = () => { throw new Error('fixture called live preload'); };
    globalThis.window = { location: { search }, addEventListener() {}, removeEventListener() {},
      metaviewer: { load: forbidden, save: forbidden, nestedDepth: forbidden,
        selfCapsuleId: forbidden, recordingDestination: forbidden }, ...over.windowExtra };
    globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
    globalThis.__mvuiBoot = {
      vue: { createApp: (_App, props) => ({ mount: selector => { mounted = { props, selector }; } }) },
      './App.vue': {},
      './core/hostAdapters.js': hostAdapters,
      './settings/settingsHost.js': { createSettingsHost },
      './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
      './fixtures/fixtureRuntime.js': {
        createFixtureRuntime: fixture => ({ ok: true, mount: { fixture,
          runtime: { projectionView: { getProjection: () => ({ rows: fixture.capsules }),
            getSnapshot: () => ({ envelope: { epoch: 1 } }), subscribe: () => () => {} } },
          calls: [], terminal: null } }),
        TILE_CHROME_KEY, TILE_CHROME_FIXTURE, fixtureCaptureSeed,
        ...over.fixtureRuntimeExtra,
      },
      './wall/layout.js': { createWallLayout, migrateWallLayout },
      'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
    };
    const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
      (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiBoot[${JSON.stringify(specifier)}];`)
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    bootSerial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui9-${bootSerial}`);
    await new Promise(resolve => setImmediate(resolve));
    return { mounted, mount };
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    if (previousBoot === undefined) delete globalThis.__mvuiBoot;
    else globalThis.__mvuiBoot = previousBoot;
  }
}
let bootSerial = 0;

describe('entry boot behavior', () => {
  test('?state=tile-chrome mounts four tiles with a seeded store', async () => {
    const capture = fakeCapture();
    const { mounted, mount } = await bootEntry('?state=tile-chrome', { fixtureRuntimeExtra: capture.factories });
    assert.equal(mount.textContent, '');
    assert.ok(mounted, 'alias boots');
    assert.equal(mounted.selector, '#metaviewer-app');
    assert.equal(mounted.props.fixture.key, 'tile-chrome');
    assert.equal(mounted.props.fixture.capsules.length, 4);
    assert.equal(mounted.props.captureState, capture.store);
    assert.equal(mounted.props.captureAvailable, true);
    assert.deepEqual(capture.calls, [
      ['createDouble'],
      ['createPort', true],
      ['createState', true],
      ['toggleRecord', 'cap-01'],
      ['screenshot', 'cap-02'],
    ]);
  });

  test('?state=tile-chrome honours the scheme override', async () => {
    const capture = fakeCapture();
    const { mounted } = await bootEntry('?state=tile-chrome&scheme=mv-dark', { fixtureRuntimeExtra: capture.factories });
    assert.ok(mounted, 'alias boots');
    assert.equal(mounted.props.fixture.key, 'tile-chrome');
    assert.equal(mounted.props.fixture.scheme, 'mv-dark');
  });

  test('?state=recording seeds the first capsule; ?state=one stays unseeded', async () => {
    const recording = fakeCapture();
    const booted = await bootEntry('?state=recording', { fixtureRuntimeExtra: recording.factories });
    assert.ok(booted.mounted, 'recording boots');
    assert.equal(booted.mounted.props.captureAvailable, true);
    assert.deepEqual(recording.calls, [['createDouble'], ['createPort', true], ['createState', true], ['toggleRecord', 'cap-01']]);
    const one = fakeCapture();
    const single = await bootEntry('?state=one', { fixtureRuntimeExtra: one.factories });
    assert.ok(single.mounted, 'one boots');
    assert.deepEqual(one.calls, [['createDouble'], ['createPort', true], ['createState', true]]);
  });

  test('an unavailable port still passes the store with captureAvailable false', async () => {
    const capture = fakeCapture({ available: false });
    const { mounted } = await bootEntry('?state=one', { fixtureRuntimeExtra: capture.factories });
    assert.ok(mounted, 'boots');
    assert.equal(mounted.props.captureState, capture.store, 'store still passed for the bound-disabled path');
    assert.equal(mounted.props.captureAvailable, false);
  });

  test('negative control: missing factories degrade to null without refusing boot', async () => {
    const { mounted, mount } = await bootEntry('?state=one', { fixtureRuntimeExtra: {} });
    assert.equal(mount.textContent, '');
    assert.ok(mounted, 'boots without capture names (stub-harness shape)');
    assert.equal(mounted.props.captureState, null);
    assert.equal(mounted.props.captureAvailable, false);
  });

  test('unknown and repeated states still refuse; the alias widens nothing', async () => {
    for (const search of ['?state=nope', '?state=', '?state=one&state=four', '?state=tile-chrome&state=one']) {
      const { mounted, mount } = await bootEntry(search, { fixtureRuntimeExtra: fakeCapture().factories });
      assert.equal(mounted, null, `no mount for ${search}`);
      assert.equal(mount.textContent, 'MetaViewer cannot start: This preview is unavailable.', search);
      assert.match(mount.dataset.errorCode, /^ERR_/, search);
    }
  });
});

test('non-replay fixture and plain boot register capture pagehide disposal', async () => {
  for (const query of ['?state=one', '']) {
    const capture = fakeCapture();
    let pagehide;
    const removals = [];
    await bootEntry(query, { fixtureRuntimeExtra: capture.factories, windowExtra: {
      metaviewer: { load: async () => null, save: async () => ({ ok: true }) },
      addEventListener(name, callback) { if (name === 'pagehide') pagehide = callback; },
    } });
    assert.equal(typeof pagehide, 'function', query);
    const previous = globalThis.window;
    globalThis.window = { removeEventListener: (...args) => removals.push(args) };
    try { pagehide(); } finally { globalThis.window = previous; }
    assert.deepEqual(capture.calls.at(-1), ['dispose']);
    assert.equal(removals[0][0], 'pagehide');
  }
});
