import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { FIXTURE_KEYS } from '../src/fixtures/states.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('real entry boot supplies each fixture without calling live preload services', async () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  try {
    for (const key of FIXTURE_KEYS) {
      let mounted = null;
      const forbidden = () => { throw new Error('fixture called live preload'); };
      const mount = { textContent: '' };
      globalThis.window = { location: { search: `?state=${key}` }, metaviewer: {
        load: forbidden, save: forbidden, nestedDepth: forbidden, selfCapsuleId: forbidden, recordingDestination: forbidden,
      } };
      globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
      globalThis.__mvuiBoot = {
        vue: { createApp: (_App, props) => ({ mount: selector => { mounted = { props, selector }; } }) },
        './App.vue': {},
        './core/hostAdapters.js': hostAdapters, './settings/settingsHost.js': { createSettingsHost },
        './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
        './fixtures/fixtureRuntime.js': { createFixtureRuntime },
        './wall/layout.js': { createWallLayout, migrateWallLayout },
        'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
      };
      const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiBoot[${JSON.stringify(specifier)}];`)
        .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
      await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${key}`);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(mount.textContent, '', key);
      assert.ok(mounted, `entry failed to mount ${key}`);
      assert.equal(mounted.selector, '#metaviewer-app');
      assert.equal(mounted.props.fixture.key, key);
      assert.equal(mounted.props.runtime.projectionView.getProjection().rows.length, mounted.props.fixture.capsules.length);
      assert.equal(mounted.props.terminal, null);
      assert.equal(await mounted.props.storage.readRaw(), null);
      assert.equal(mounted.props.nestedHost.getNestedDepth(), key === 'nested' ? 1 : 0);
    }
  } finally {
    globalThis.window = previousWindow; globalThis.document = previousDocument;
    delete globalThis.__mvuiBoot;
  }
});

// Execute the entry itself: rejected fixture requests must never reach preload.
test('invalid fixture keys refuse boot before any live host access with fixed copy', async () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  try {
    for (const search of ['?state=unknown', '?state=', '?state=wall&state=recording']) {
      let liveReads = 0, mounts = 0;
      const mount = { textContent: '', dataset: {} };
      globalThis.window = { location: { search }, get metaviewer() { liveReads++; throw new Error('private host detail'); } };
      globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
      globalThis.__mvuiBoot = {
        vue: { createApp: () => { mounts++; throw new Error('unexpected mount'); } },
        './App.vue': {}, './core/hostAdapters.js': hostAdapters, './settings/settingsHost.js': { createSettingsHost },
        './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
        './fixtures/fixtureRuntime.js': { createFixtureRuntime },
        './wall/layout.js': { createWallLayout, migrateWallLayout },
        'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
      };
      const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiBoot[${JSON.stringify(specifier)}];`)
        .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
      await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#refuse-${search}`);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(liveReads, 0);
      assert.equal(mounts, 0);
      assert.equal(mount.textContent, 'MetaViewer cannot start: This preview is unavailable.');
      assert.match(mount.dataset.errorCode, /^ERR_/);
      assert.doesNotMatch(mount.textContent, /ERR_|private host detail/);
    }
  } finally {
    globalThis.window = previousWindow; globalThis.document = previousDocument;
    delete globalThis.__mvuiBoot;
  }
});

test('resolver refusal after parsing cannot fall through, and arbitrary startup errors stay private', async () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  try {
    for (const preview of [true, false]) {
      let liveReads = 0;
      const mount = { textContent: '', dataset: {} };
      globalThis.window = { location: { search: preview ? '?state=wall-empty' : '' }, get metaviewer() { liveReads++; throw new Error('ERR_PRIVATE_HOST: /private/startup/path'); } };
      globalThis.document = { documentElement: { dataset: {} }, querySelector: () => mount };
      globalThis.__mvuiBoot = {
        vue: { createApp: () => { throw new Error('unexpected mount'); } }, './App.vue': {},
        './core/hostAdapters.js': hostAdapters, './settings/settingsHost.js': { createSettingsHost },
        './fixtures/resolveState.js': { parseStateQuery: preview ? () => ({ ok: true, key: 'unresolved' }) : parseStateQuery, resolveFixture },
        './fixtures/fixtureRuntime.js': { createFixtureRuntime }, './wall/layout.js': { createWallLayout, migrateWallLayout },
        'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
      };
      const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvuiBoot[${JSON.stringify(specifier)}];`)
        .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
      await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#resolver-${preview}`);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(liveReads, preview ? 0 : 1);
      assert.equal(mount.textContent, preview ? 'MetaViewer cannot start: This preview is unavailable.'
        : 'MetaViewer cannot start: The application is unavailable. Please try again.');
      assert.equal(mount.dataset.errorCode, preview ? 'ERR_UNKNOWN_FIXTURE_STATE' : 'ERR_STARTUP_UNAVAILABLE');
      assert.doesNotMatch(mount.textContent, /ERR_|private|startup\/path/);
    }
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; delete globalThis.__mvuiBoot; }
});
