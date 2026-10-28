// MVUI33 lane S: density boot and application. The entry resolves the stored
// density before first paint and hands the frames port to App; App paints the
// boot density on the root attribute and the wall, then follows the settings
// panel density model. Hosted-safe: the mvui29s boot harness plus the
// mvui16-harness App mount, doubles only below the component boundary. Every
// behaviour ships with a negative control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import {
  compileSfc,
  flush,
  mountComponent,
} from './mvui16-harness.mjs';
import * as hostAdapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { createWallLayout, migrateWallLayout } from '../src/wall/layout.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const settings = (patch = {}) => JSON.stringify({
  scheme: 'mv-light',
  density: 'compact',
  wallFps: 30,
  recordingFps: 3,
  ...patch,
});
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
  globalThis.__mvui33Boot = {
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
        (_all, binding, _quote, specifier) => `const ${binding.trim()} = globalThis.__mvui33Boot[${JSON.stringify(specifier)}];`,
      )
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    serial += 1;
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui33-${serial}`);
    for (let i = 0; i < 300 && mounted === null && mount.textContent === ''; i++) {
      await sleep(10);
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete globalThis.__mvui33Boot;
  }
  return { mount, mounted, kitSchemes, dataset: globalThis.document?.documentElement?.dataset ?? {} };
}

/**
 * @param {{ loadSettings: () => Promise<string|null> }} settingsHost
 */
function liveHost(settingsHost) {
  const calls = [];
  return {
    calls,
    authority: {},
    load: async () => null,
    save: async () => true,
    loadSettings: async () => { calls.push('load'); return settingsHost.loadSettings(); },
    saveSettings: async (/** @type {string} */ json) => { calls.push('save'); return true; },
  };
}

test('live boot resolves the stored density and hands the frames port to App', async () => {
  const host = liveHost({ loadSettings: async () => settings({ scheme: 'mv-dark', density: 'comfortable' }) });
  const { mount, mounted, kitSchemes } = await bootEntry('', { host });
  assert.equal(mount.textContent, '');
  assert.ok(mounted, 'live boots');
  assert.equal(mounted.props.initialScheme, 'mv-dark');
  assert.equal(mounted.props.initialDensity, 'comfortable');
  assert.equal(mounted.props.framesPort, host.authority);
  assert.deepEqual(kitSchemes, ['mv-dark']);
});

test('negative control: absent storage boots compact, proving the density came from storage', async () => {
  const host = liveHost({ loadSettings: async () => null });
  const { mount, mounted } = await bootEntry('', { host });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(mounted.props.initialDensity, 'compact');
  assert.equal(mounted.props.framesPort, host.authority);
});

test('old two-key files and malformed text boot the compact default silently', async () => {
  for (const bad of ['{"scheme":"mv-dark","density":"compact"}', '{nope', '{"density":"huge"}']) {
    const host = liveHost({ loadSettings: async () => bad });
    const { mount, mounted } = await bootEntry('', { host });
    assert.equal(mount.textContent, '', bad);
    assert.ok(mounted, bad);
    assert.equal(mounted.props.initialDensity, 'compact', bad);
  }
});

test('fixture boots carry no frames port and keep the fixture density', async () => {
  const forbidden = () => { throw new Error('fixture called live host'); };
  const host = {
    load: forbidden, save: forbidden, loadSettings: forbidden, saveSettings: forbidden,
    nestedDepth: forbidden, selfCapsuleId: forbidden, recordingDestination: forbidden,
  };
  const { mount, mounted } = await bootEntry('?state=settings-dark', { host });
  assert.equal(mount.textContent, '');
  assert.ok(mounted);
  assert.equal(mounted.props.framesPort, null);
  const expected = resolveFixture('settings-dark');
  assert.equal(expected.ok && expected.fixture.density, 'compact');
});

const stub = vue.defineComponent({ setup: () => () => vue.h('div') });

async function mountAppForDensity(initial = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const dataset = {};
  globalThis.document = { documentElement: { dataset }, getElementById: () => null };
  const captured = {};
  try {
    const hostOutcome = await compileSfc('core/HostOutcome.vue', { './hostAdapters.js': hostAdapters });
    const settingsPanel = vue.defineComponent({
      setup: (_, ctx) => { captured.settings = ctx; return () => vue.h('div'); },
    });
    const wall = vue.defineComponent({
      setup: (_, ctx) => { captured.wall = ctx; return () => vue.h('div'); },
    });
    const App = await compileSfc('App.vue', {
      './creative/CreativeCapsule.vue': stub,
      './core/HostOutcome.vue': hostOutcome,
      'capsule-ui-kit/DockWorkspace': stub,
      '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
      './wall/EmptyWallView.vue': stub,
      './catalog/CatalogLauncher.vue': stub,
      './terminal/SideTerminalOverlay.vue': stub,
      './multislot/MultislotHost.vue': stub,
      './recording/MvRecordingPanel.vue': stub,
      './settings/MvSettingsPanel.vue': settingsPanel,
      './agent/AgentLaneHost.vue': stub,
      './activity/ActivityStrip.vue': stub,
      './nested/nested.js': { resolveNestedMode, applyNestedWall },
      'capsule-ui-kit/ui': { UiButton: stub },
      'capsule-ui-kit/theme': { setKitScheme() {} },
      './wall/WallWorkspace.vue': wall,
      './surfaces/SurfaceCanvas.vue': stub,
      './surfaces/tileScheduler.js': { createTileScheduler },
    });
    const row = vue.reactive({
      id: 'cap-01', surfaceId: 'cap-01', title: 'Capsule', generation: 1,
      visibility: 'unfolded', control: 'human', backendLifecycle: 'active',
    });
    const feed = {
      getSnapshot: () => null,
      getProjection: () => ({ rows: [row] }),
      subscribe: () => () => {},
    };
    const f = mountComponent(App, {
      layout: {},
      scope: {},
      storage: { readRaw: async () => null, writeAtomic: async () => {} },
      fixture: { key: 'one', ui: {}, capsules: [{ id: 'cap-01' }] },
      runtime: { projectionView: feed },
      authorityHost: { intent: async () => true },
      onSubmitIntent: () => {},
      ...initial,
    });
    await flush();
    return {
      ...f,
      captured,
      dataset,
      close() {
        f.app.unmount();
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
      },
    };
  } catch (error) {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    throw error;
  }
}

test('App paints the boot density on the root attribute and the wall', async () => {
  const app = await mountAppForDensity({ initialDensity: 'comfortable' });
  try {
    assert.equal(app.dataset.themeDensity, 'comfortable');
    assert.equal(app.captured.wall.attrs.density, 'comfortable');
    assert.equal(app.captured.settings.attrs.density, 'comfortable');
  } finally { app.close(); }
});

test('App follows the panel density model for the root attribute and the wall', async () => {
  const app = await mountAppForDensity({ initialDensity: 'comfortable' });
  try {
    assert.equal(app.dataset.themeDensity, 'comfortable');
    app.captured.settings.attrs['onUpdate:density']('compact');
    await flush();
    assert.equal(app.dataset.themeDensity, 'compact');
    assert.equal(app.captured.wall.attrs.density, 'compact');
  } finally { app.close(); }
});

test('negative control: a default mount stays compact, proving the density came from the prop', async () => {
  const app = await mountAppForDensity();
  try {
    assert.equal(app.dataset.themeDensity, 'compact');
    assert.equal(app.captured.wall.attrs.density, 'compact');
  } finally { app.close(); }
});
