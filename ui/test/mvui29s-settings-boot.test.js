// MVUI29S lane S: settings load once at boot before first paint of themed UI.
// Executes the real entry like mvui-int-boot: a stored scheme reaches the kit
// and the App before mount (no flash), the panel reuses the settled read,
// failures keep bootable defaults. Every behaviour ships with a negative
// control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const settings = scheme => JSON.stringify({ scheme, density: 'compact', wallFps: 30, recordingFps: 3 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
  globalThis.__mvui29Boot = {
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
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvui29Boot[${JSON.stringify(specifier)}];`,
      )
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    serial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui29s-${serial}`);
    for (let i = 0; i < 300 && mounted === null && mount.textContent === ''; i++) {
      await sleep(10);
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete globalThis.__mvui29Boot;
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

test('live boot paints the stored scheme before mount and reads the host once', async () => {
  let text = settings('mv-dark');
  const host = liveHost({ loadSettings: async () => text }, json => { text = json; });
  const { mount, mounted, kitSchemes } = await bootEntry('', { host });
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'live boots');
  assert.equal(mounted.props.fixture, null);
  assert.equal(mounted.props.initialScheme, 'mv-dark');
  assert.deepEqual(kitSchemes, ['mv-dark'], 'kit follows the stored scheme');
  assert.deepEqual(mounted.kitAtMount, ['mv-dark'], 'scheme is known before mount: no flash');
  assert.deepEqual(host.calls, ['load'], 'one host read at boot');
  assert.equal(await mounted.props.settingsHost.loadSettings(), text, 'panel reuses the settled read');
  assert.deepEqual(host.calls, ['load'], 'the reuse hits no host call');
  await mounted.props.settingsHost.saveSettings(settings('mv-light'));
  assert.equal(await mounted.props.settingsHost.loadSettings(), settings('mv-light'), 'save refreshes the memoized read');
});

test('negative control: absent storage boots the primary scheme, proving the scheme came from storage', async () => {
  const host = liveHost({ loadSettings: async () => null });
  const { mount, mounted, kitSchemes } = await bootEntry('', { host });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(mounted.props.initialScheme, 'mv-light');
  assert.deepEqual(kitSchemes, ['mv-light']);
  assert.deepEqual(host.calls, ['load']);
});

test('malformed stored text boots defaults silently and stays mounted', async () => {
  for (const bad of ['{nope', '{"scheme":"invented"}']) {
    const host = liveHost({ loadSettings: async () => bad });
    const { mount, mounted, kitSchemes } = await bootEntry('', { host });
    assert.equal(mount.textContent, '', bad);
    assert.ok(mounted, bad);
    assert.equal(mounted.props.initialScheme, 'mv-light', bad);
    assert.deepEqual(kitSchemes, ['mv-light'], bad);
  }
});

test('a failed boot read keeps bootable defaults and rethrows typed for the panel', async () => {
  const host = liveHost({ loadSettings: async () => { throw new Error('PRIVATE transport down'); } });
  const { mount, mounted, kitSchemes } = await bootEntry('', { host });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(mounted.props.initialScheme, 'mv-light');
  assert.deepEqual(kitSchemes, ['mv-light']);
  await assert.rejects(mounted.props.settingsHost.loadSettings(), /ERR_SETTINGS_HOST/);
});

test('a missing handler binding retries, then settles the stored scheme', async () => {
  let attempts = 0;
  const host = liveHost({
    loadSettings: async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error('No handler registered for settings.load');
      return settings('mv-dark');
    },
  });
  const { mount, mounted } = await bootEntry('', { host });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(attempts, 3);
  assert.equal(mounted.props.initialScheme, 'mv-dark');
});

test('negative control: other failures never retry; a dead binding stays bounded', async () => {
  let attempts = 0;
  const failing = liveHost({
    loadSettings: async () => { attempts += 1; throw new Error('boom'); },
  });
  const failed = await bootEntry('', { host: failing });
  assert.ok(failed.mounted);
  assert.equal(attempts, 1, 'only a missing binding retries');
  let dead = 0;
  const missing = liveHost({
    loadSettings: async () => { dead += 1; throw new Error('No handler registered for settings.load'); },
  });
  const booted = await bootEntry('', { host: missing });
  assert.ok(booted.mounted);
  assert.equal(booted.mounted.props.initialScheme, 'mv-light');
  assert.equal(dead, 100, 'retries stay bounded like the layout read');
});

test('fixture boots reuse the fixture scheme without touching the host', async () => {
  for (const [key, scheme] of [['one', 'mv-light'], ['settings-dark', 'mv-dark']]) {
    const forbidden = () => { throw new Error('fixture called live host'); };
    const host = {
      load: forbidden, save: forbidden, loadSettings: forbidden, saveSettings: forbidden,
      nestedDepth: forbidden, selfCapsuleId: forbidden, recordingDestination: forbidden,
    };
    const { mount, mounted, kitSchemes } = await bootEntry(`?state=${key}`, { host });
    assert.equal(mount.textContent, '', key);
    assert.ok(mounted, key);
    assert.equal(mounted.props.initialScheme, scheme, key);
    assert.deepEqual(kitSchemes, [scheme], key);
    const expected = resolveFixture(key);
    assert.equal(expected.ok && expected.fixture.scheme, scheme, key);
  }
});
