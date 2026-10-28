// MVUI29SC lane S: one stored decode with per-field fallback. A valid scheme
// survives an invalid density and vice versa, unknown keys stay ignored, and
// the boot parser shares the exact store decode so boot never paints a scheme
// the store will then replace. Strict encode on save stays intact. Every
// behaviour ships with a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';
import {
  createHostSettingsStore,
  createMemorySettingsHost,
  decodeStoredSettings,
  encodeMvSettings,
} from '../src/settings/settingsModel.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const settings = scheme => JSON.stringify({ scheme, density: 'compact', wallFps: 30, recordingFps: 3 });

test('stored decode falls back per field and ignores unknown keys', () => {
  assert.deepEqual(decodeStoredSettings('{"scheme":"mv-dark","density":7}'), {
    ok: true,
    settings: { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 },
  });
  assert.deepEqual(decodeStoredSettings('{"scheme":"invented","density":"compact"}'), {
    ok: true,
    settings: { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 },
  });
  assert.deepEqual(decodeStoredSettings('{"scheme":"mv-dark","future":1}'), {
    ok: true,
    settings: { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 },
  });
  assert.deepEqual(decodeStoredSettings({}), {
    ok: true,
    settings: { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 },
  });
  const malformed = decodeStoredSettings('{nope');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.ok === false && malformed.error.code, 'ERR_SETTINGS_MALFORMED');
  const nonObject = decodeStoredSettings('42');
  assert.equal(nonObject.ok, false);
  assert.equal(nonObject.ok === false && nonObject.error.code, 'ERR_SETTINGS_MALFORMED');
});

test('store load keeps a valid scheme paired with an invalid density', async () => {
  const store = createHostSettingsStore(createMemorySettingsHost('{"scheme":"mv-dark","density":7}'));
  assert.deepEqual({ ...(await store.load()) }, { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 });
  const flipped = createHostSettingsStore(createMemorySettingsHost('{"scheme":"invented","density":"compact"}'));
  assert.deepEqual({ ...(await flipped.load()) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
});

test('the entry shares the exact store decode object', () => {
  assert.equal(createSettingsHost.decodeStoredSettings, decodeStoredSettings);
});

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
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
  globalThis.__mvui29scBoot = {
    vue: {
      createApp: (_App, props) => ({
        mount: (selector) => { mounted = { props, selector, kitAtMount: [...kitSchemes] }; },
      }),
    },
    './App.vue': {},
    './core/hostAdapters.js': hostAdapters,
    './settings/settingsHost.js': { createSettingsHost },
    './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
    './fixtures/fixtureRuntime.js': { createFixtureRuntime },
    './wall/layout.js': { createWallLayout, migrateWallLayout },
    'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme: scheme => kitSchemes.push(scheme) },
  };
  try {
    const code = main
      .replace(
        /^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvui29scBoot[${JSON.stringify(specifier)}];`,
      )
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    serial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui29sc-${serial}`);
    for (let i = 0; i < 300 && mounted === null && mount.textContent === ''; i++) {
      await sleep(10);
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete globalThis.__mvui29scBoot;
  }
  return { mount, mounted, kitSchemes };
}

/**
 * @param {{ loadSettings: () => Promise<string|null>, saveText?: (json: string) => void }} settingsHost
 */
function liveHost(settingsHost, saveText = () => {}) {
  const calls = [];
  return {
    calls,
    load: async () => null,
    save: async () => true,
    loadSettings: async () => { calls.push('load'); return settingsHost.loadSettings(); },
    saveSettings: async (/** @type {string} */ json) => { calls.push('save'); saveText(json); return true; },
  };
}

test('boot paints the same scheme the store loads for cross-field payloads', async () => {
  for (const text of ['{"scheme":"mv-dark","density":7}', '{"scheme":"invented","density":"compact"}']) {
    const host = liveHost({ loadSettings: async () => text });
    const { mount, mounted, kitSchemes } = await bootEntry('', { host });
    assert.equal(mount.textContent, '', text);
    assert.ok(mounted, text);
    const loaded = await createHostSettingsStore(createMemorySettingsHost(text)).load();
    assert.equal(mounted.props.initialScheme, loaded.scheme, `boot/store agree for ${text}`);
    assert.deepEqual(kitSchemes, [loaded.scheme], `kit follows the agreed scheme for ${text}`);
  }
});

test('negative control: well-formed payloads already agree, proving the harness can pass', async () => {
  for (const text of [settings('mv-dark'), settings('mv-light')]) {
    const host = liveHost({ loadSettings: async () => text });
    const { mount, mounted, kitSchemes } = await bootEntry('', { host });
    assert.equal(mount.textContent, '', text);
    assert.ok(mounted, text);
    const loaded = await createHostSettingsStore(createMemorySettingsHost(text)).load();
    assert.equal(mounted.props.initialScheme, loaded.scheme, text);
    assert.deepEqual(kitSchemes, [loaded.scheme], text);
  }
});

test('negative control: strict encode still refuses unknown keys and invalid values', async () => {
  assert.throws(
    () => encodeMvSettings({ scheme: 'mv-dark', density: 'compact', future: 1 }),
    /ERR_SETTINGS_UNKNOWN_KEY/,
  );
  const store = createHostSettingsStore(createMemorySettingsHost());
  await assert.rejects(store.save({ scheme: 'invented', density: 'compact' }), /ERR_SETTINGS_UNKNOWN_SCHEME/);
  await assert.rejects(store.save({ scheme: 'mv-dark', density: 'huge' }), /ERR_SETTINGS_UNKNOWN_DENSITY/);
  assert.equal(await store.save({ scheme: 'mv-dark', density: 'compact' }), true);
});
