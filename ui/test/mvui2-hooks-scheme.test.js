// MV-5 vision hooks: fixture-only ?scheme= override. Executes the real
// entry like mvui-int-boot: valid values override the fixture scheme,
// invalid values refuse boot with the fixed preview copy, live boot
// ignores the parameter entirely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const FIXED_PREVIEW_COPY = 'MetaViewer cannot start: This preview is unavailable.';
let serial = 0;

/**
 * Boots the real entry with a stubbed module map and records the outcome.
 * @param {string} search
 * @param {{ host?: any }} [options]
 */
async function bootEntry(search, { host = null } = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const mount = { textContent: '', dataset: {} };
  let mounted = null;
  const kitSchemes = [];
  globalThis.window = host === null
    ? { location: { search } }
    : { location: { search }, metaviewer: host };
  globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
  globalThis.__mvuiV4Boot = {
    vue: { createApp: (_App, props) => ({ mount: (selector) => { mounted = { props, selector }; } }) },
    './App.vue': {},
    './core/hostAdapters.js': hostAdapters,
    './settings/settingsHost.js': { createSettingsHost },
    './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
    './fixtures/fixtureRuntime.js': { createFixtureRuntime },
    './wall/layout.js': { createWallLayout, migrateWallLayout },
    'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme: (scheme) => kitSchemes.push(scheme) },
  };
  try {
    const code = main
      .replace(
        /^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiV4Boot[${JSON.stringify(specifier)}];`,
      )
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    serial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#v4-scheme-${serial}`);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete globalThis.__mvuiV4Boot;
  }
  return { mount, mounted, kitSchemes };
}

test('explicit ?scheme= overrides the fixture default in both directions', async () => {
  const matrix = [
    ['four', 'mv-dark'],
    ['nested', 'mv-dark'],
    ['one', 'mv-dark'],
    ['settings-dark', 'mv-light'],
    ['four', 'mv-light'],
  ];
  for (const [key, scheme] of matrix) {
    const expected = resolveFixture(key);
    assert.equal(expected.ok, true);
    const { mount, mounted, kitSchemes } = await bootEntry(`?state=${key}&scheme=${scheme}`);
    assert.equal(mount.textContent, '', `${key}+${scheme}`);
    assert.ok(mounted, `${key}+${scheme} mounts`);
    assert.equal(mounted.selector, '#metaviewer-app');
    assert.equal(mounted.props.fixture.key, key);
    assert.equal(mounted.props.fixture.scheme, scheme, 'override reaches the mounted fixture');
    assert.deepEqual(kitSchemes, [scheme], 'kit theme follows the override');
    assert.equal(
      mounted.props.fixture.capsules.length,
      expected.ok ? expected.fixture.capsules.length : -1,
      'override keeps the fixture capsules',
    );
    assert.equal(mounted.props.nestedHost.getNestedDepth(), key === 'nested' ? 1 : 0);
    assert.equal(mounted.props.terminal, null);
    assert.equal(await mounted.props.storage.readRaw(), null);
    // The shared frozen record is never mutated by an override.
    assert.equal(expected.ok ? expected.fixture.scheme : null, key === 'settings-dark' ? 'mv-dark' : 'mv-light');
    assert.ok(Object.isFrozen(mounted.props.fixture));
  }
});

test('absent ?scheme= keeps the fixture default with record identity', async () => {
  for (const key of ['empty', 'one', 'four', 'nine', 'tile-states', 'multislot', 'side-terminal-open', 'recording', 'settings-dark', 'nested']) {
    const expected = resolveFixture(key);
    assert.equal(expected.ok, true);
    const { mount, mounted, kitSchemes } = await bootEntry(`?state=${key}`);
    assert.equal(mount.textContent, '', key);
    assert.ok(mounted, key);
    assert.equal(mounted.props.fixture.scheme, expected.ok ? expected.fixture.scheme : null, key);
    assert.equal(mounted.props.fixture, expected.ok ? expected.fixture : null, `${key}: no copy without override`);
    assert.deepEqual(kitSchemes, [expected.ok ? expected.fixture.scheme : null], key);
  }
});

test('unknown, empty, and repeated ?scheme= refuse boot with the fixed preview copy', async () => {
  const cases = [
    ['?state=four&scheme=dark', 'ERR_UNKNOWN_SCHEME'],
    ['?state=four&scheme=MV-DARK', 'ERR_UNKNOWN_SCHEME'],
    ['?state=four&scheme=mv-darkx', 'ERR_UNKNOWN_SCHEME'],
    ['?state=nested&scheme=mv-light%20', 'ERR_UNKNOWN_SCHEME'],
    ['?state=four&scheme=', 'ERR_INVALID_SCHEME_QUERY'],
    ['?state=four&scheme=mv-dark&scheme=mv-light', 'ERR_INVALID_SCHEME_QUERY'],
  ];
  for (const [search, code] of cases) {
    let liveReads = 0;
    const host = {};
    Object.defineProperty(host, 'load', { get() { liveReads += 1; throw new Error('private host detail'); } });
    const { mount, mounted } = await bootEntry(search, { host });
    assert.equal(mounted, null, `${search} must not mount`);
    assert.equal(mount.textContent, FIXED_PREVIEW_COPY, search);
    assert.equal(mount.dataset.errorCode, code, search);
    assert.doesNotMatch(mount.textContent, /ERR_|private host detail/, search);
    assert.equal(liveReads, 0, `${search} never reaches the host`);
  }
});

test('live boot ignores ?scheme= entirely, including garbage', async () => {
  const host = { load: async () => null, save: async () => true };
  for (const search of ['', '?scheme=mv-dark', '?scheme=bogus', '?scheme=a&scheme=b', '?scheme=']) {
    const { mount, mounted, kitSchemes } = await bootEntry(search, { host });
    assert.equal(mount.textContent, '', `live ${search} mounts`);
    assert.ok(mounted, `live ${search} mounts`);
    assert.equal(mounted.props.fixture, null);
    assert.deepEqual(kitSchemes, ['mv-light'], `live ${search} keeps the default seed`);
  }
});

test('state errors win over scheme errors', async () => {
  const { mount: unknown, mounted: mountedUnknown } = await bootEntry('?state=nope&scheme=bogus');
  assert.equal(mountedUnknown, null);
  assert.equal(unknown.textContent, FIXED_PREVIEW_COPY);
  assert.equal(unknown.dataset.errorCode, 'ERR_UNKNOWN_FIXTURE_STATE');
  const { mount: repeated, mounted: mountedRepeated } = await bootEntry('?state=four&state=one&scheme=bogus');
  assert.equal(mountedRepeated, null);
  assert.equal(repeated.textContent, FIXED_PREVIEW_COPY);
  assert.equal(repeated.dataset.errorCode, 'ERR_INVALID_STATE_QUERY');
});

test('boot keeps the closed stub-map import surface for the scheme hook', () => {
  assert.ok(main.includes("import { parseStateQuery, resolveFixture } from './fixtures/resolveState.js';"));
  assert.ok(main.includes('ERR_UNKNOWN_SCHEME'));
  assert.ok(main.includes('ERR_INVALID_SCHEME_QUERY'));
});
