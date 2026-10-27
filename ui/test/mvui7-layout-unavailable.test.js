import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadSfc, mount, slotStub, ui, byId, text, vue } from './mvui3-creative-harness.js';
import { createWallLayout, migrateWallLayout, SCOPE } from '../src/wall/layout.js';
import { createLayoutProfileController } from '../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import * as adapters from '../src/core/hostAdapters.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime, createLiveReplayMount, LIVE_REPLAY_FIXTURE } from '../src/fixtures/fixtureRuntime.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
function storageFor(facade) {
  const start = main.indexOf('function createLayoutStorage(');
  const end = main.indexOf('\n/**', start);
  return runInNewContext(`${main.slice(start, end)}\ncreateLayoutStorage(facade)`, {
    facade, migrateWallLayout, requireAck: adapters.requireAck,
    HANDLER_NOT_INSTALLED: 'No handler registered', READ_ATTEMPTS: 100, READ_RETRY_MS: 20,
    setTimeout: fn => { fn(); },
  });
}
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };
async function mountApp(storage, scheme = 'mv-light') {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const captured = {};
  try {
    const wall = vue.defineComponent({ props: ['storage', 'defaultProfile', 'scope'], setup(p, ctx) {
      ctx.expose({ revealSurface: () => ({ ok: true }) });
      captured.storage = p.storage;
      captured.controller = createLayoutProfileController({ storage: p.storage, defaultProfile: p.defaultProfile, scope: p.scope, ownerWindowId: 'main-wall' });
      captured.ready = captured.controller.restore().then(result => {
        captured.restored = result;
        captured.controller.markSettled();
        ctx.emit('wall-settled');
      });
      return () => vue.h('div', { id: 'mounted-layout' }, captured.restored?.status ?? 'restoring');
    } });
    const App = await loadSfc('App.vue', {
      './creative/CreativeCapsule.vue': slotStub, './core/HostOutcome.vue': slotStub,
      'capsule-ui-kit/DockWorkspace': slotStub,
      '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: slotStub, TopBar: slotStub, Sidebar: slotStub, StatusBar: slotStub },
      'capsule-ui-kit/ui': ui, 'capsule-ui-kit/theme': { setKitScheme() {} },
      './wall/WallWorkspace.vue': wall, './wall/EmptyWallView.vue': slotStub,
      './catalog/CatalogLauncher.vue': slotStub, './terminal/SideTerminalOverlay.vue': slotStub,
      './multislot/MultislotHost.vue': slotStub, './recording/MvRecordingPanel.vue': slotStub,
      './settings/MvSettingsPanel.vue': slotStub, './agent/AgentLaneHost.vue': slotStub,
      './activity/ActivityStrip.vue': slotStub,
      './surfaces/SurfaceCanvas.vue': slotStub, './nested/nested.js': { resolveNestedMode, applyNestedWall },
      './surfaces/tileScheduler.js': { createTileScheduler },
    });
    const fixture = resolveFixture('one').fixture;
    const layout = createWallLayout(SCOPE, [...fixture.capsules]);
    const view = mount(App, { fixture: { ...fixture, scheme }, layout, scope: SCOPE, storage,
      runtime: createFixtureRuntime(fixture).mount.runtime });
    await captured.ready; await tick();
    return { ...captured, view, layout, close() { view.close(); globalThis.window = oldWindow; globalThis.document = oldDocument; } };
  } catch (error) { globalThis.window = oldWindow; globalThis.document = oldDocument; throw error; }
}

for (const scheme of ['mv-light', 'mv-dark']) test(`load failure renders defaults and refuses every save visibly (${scheme})`, async () => {
  let saves = 0, reads = 0;
  const storage = storageFor({ load: async () => { reads++; throw new Error('LAYOUT_CONTRACT_ABSENT private/path'); }, save: async () => { saves++; return true; } });
  const app = await mountApp(storage, scheme);
  try {
    const row = byId(app.view.root, 'mv-layout-unavailable');
    assert.equal(row.props.role, 'alert');
    assert.equal(row.props['data-semantic-anchor'], 'layout/unavailable');
    assert.equal(row.props['data-error-code'], 'LAYOUT_CONTRACT_ABSENT');
    assert.match(text(row), /Layout unavailable\./);
    assert.match(text(row), /default layout.*read-only/);
    assert.doesNotMatch(text(row), /LAYOUT_|private/);
    assert.ok(byId(app.view.root, 'mounted-layout'));
    assert.deepEqual(app.restored.profile, app.layout);
    assert.equal(app.restored.status, 'restored', 'explicit default bytes, never writable missing-profile null');
    const changed = structuredClone(app.layout);
    changed.dockview.panels['panel-cap-01'].title = 'Changed layout';
    await assert.rejects(app.controller.saveOnGesture(changed), /LAYOUT_SAVE_REFUSED/);
    await tick();
    assert.match(text(byId(app.view.root, 'mv-layout-unavailable')), /Changes cannot be saved in this session\./);
    assert.equal(byId(app.view.root, 'mv-layout-unavailable').props['data-error-code'], 'LAYOUT_SAVE_REFUSED');
    await assert.rejects(app.controller.recoverExplicitly(changed), /LAYOUT_SAVE_REFUSED/);
    assert.deepEqual(JSON.parse(await app.storage.readRaw()), app.layout, 'remount cannot retry into writable state');
    await assert.rejects(storage.writeAtomic('{}'), /LAYOUT_SAVE_REFUSED/);
    assert.equal(saves, 0);
    assert.equal(reads, 1);
  } finally { app.close(); }
});

test('preload adapter still rejects genuine load errors, invalid payloads and exhausted retries', async () => {
  for (const load of [async () => { throw new Error('LAYOUT_CONTRACT_ABSENT'); }, async () => ({}), async () => { throw new Error('No handler registered'); }]) {
    let saves = 0;
    const storage = storageFor({ load, save: async () => { saves++; return true; } });
    await assert.rejects(storage.readRaw());
    await assert.rejects(storage.writeAtomic('{}'), /LAYOUT_SAVE_REFUSED/);
    assert.equal(saves, 0);
  }
});

test('handler installation retry preserves successful read and write behavior', async () => {
  let loads = 0, saves = 0;
  const storage = storageFor({ load: async () => { if (++loads < 3) throw new Error('No handler registered'); return null; }, save: async () => { saves++; return true; } });
  assert.equal(await storage.readRaw(), null);
  await storage.writeAtomic('{}');
  assert.equal(loads, 3);
  assert.equal(saves, 1);
});

test('successful saved and missing profiles have no row and persist changed layouts', async () => {
  for (const raw of [null, JSON.stringify(createWallLayout(SCOPE))]) {
    const saved = [];
    const app = await mountApp(storageFor({ load: async () => raw, save: async json => { saved.push(json); return true; } }));
    try {
      assert.equal(byId(app.view.root, 'mv-layout-unavailable'), undefined);
      assert.equal(app.restored.status, raw === null ? 'default-initialized' : 'restored');
      const changed = structuredClone(app.layout);
      changed.dockview.panels['panel-cap-01'].title = 'Changed';
      assert.equal((await app.controller.saveOnGesture(changed)).ok, true);
      assert.equal(saved.length, 1);
      assert.equal(JSON.parse(saved[0]).dockview.panels['panel-cap-01'].title, 'Changed');
    } finally { app.close(); }
  }
});

test('corrupt and future profiles keep the kit quarantine, never become load-failure defaults', async () => {
  for (const raw of ['broken json', JSON.stringify({ schemaVersion: '999.0' })]) {
    let saves = 0;
    const app = await mountApp(storageFor({ load: async () => raw, save: async () => { saves++; return true; } }));
    try {
      assert.equal(byId(app.view.root, 'mv-layout-unavailable'), undefined);
      assert.equal(app.restored.status, 'quarantined-safe-fallback');
      assert.equal((await app.controller.saveOnGesture(app.layout)).ok, false);
      assert.equal(saves, 0);
    } finally { app.close(); }
  }
});

let serial = 0;
async function bootFixture(search) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  let props;
  const target = { textContent: '', dataset: {} };
  globalThis.window = { location: { search }, get metaviewer() { throw new Error('fixture crossed live boundary'); } };
  globalThis.document = { documentElement: { dataset: {} }, querySelector: () => target };
  globalThis.__mvui7Boot = {
    vue: { createApp: (_App, p) => ({ mount() { props = p; } }) }, './App.vue': {},
    './core/hostAdapters.js': adapters, './settings/settingsHost.js': { createSettingsHost },
    './fixtures/resolveState.js': { parseStateQuery, resolveFixture },
    './fixtures/fixtureRuntime.js': { createFixtureRuntime, createLiveReplayMount, LIVE_REPLAY_FIXTURE },
    './wall/layout.js': { createWallLayout, migrateWallLayout },
    'capsule-ui-kit/theme': { installKitTheme() {}, setKitScheme() {} },
  };
  try {
    const code = main.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
      (_all, binding, _quote, spec) => `const ${binding.trim()} = globalThis.__mvui7Boot[${JSON.stringify(spec)}];`)
      .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '');
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#layout-${++serial}`);
    await tick();
    return { props, target };
  } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__mvui7Boot; }
}

test('layout-unavailable fixture reaches the real failure path in both schemes; other fixtures unchanged', async () => {
  for (const scheme of ['mv-light', 'mv-dark']) {
    const { props, target } = await bootFixture(`?state=layout-unavailable&scheme=${scheme}`);
    assert.equal(target.textContent, '');
    assert.equal(props.fixture.key, 'layout-unavailable');
    assert.equal(props.fixture.scheme, scheme);
    const app = await mountApp(props.storage, scheme);
    try { assert.ok(byId(app.view.root, 'mv-layout-unavailable')); } finally { app.close(); }
  }
  const ordinary = await bootFixture('?state=one');
  assert.equal(await ordinary.props.storage.readRaw(), null);
  await ordinary.props.storage.writeAtomic('{}');
  for (const search of ['?state=Layout-unavailable', '?state=layout-unavailable&state=one', '?state=layout-unavailable&scheme=unknown']) {
    const bad = await bootFixture(search);
    assert.equal(bad.props, undefined);
    assert.match(bad.target.textContent, /preview is unavailable/);
  }
});

function luminance(hex) {
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(c => c + c).join('');
  const c = hex.match(/\w\w/g).map(n => parseInt(n, 16) / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(a, b) { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + 0.05) / (values[1] + 0.05); }
test('status overlay preserves wall geometry and AA contrast in both schemes; negative control rejects low contrast', () => {
  const rule = appSource.match(/\.mv-layout-unavailable \{([^}]+)\}/)[1];
  assert.match(rule, /position:absolute/);
  assert.match(rule, /z-index:5/);
  assert.match(rule, /color:var\(--cuk-semantic-text-primary\)/);
  assert.match(rule, /background:var\(--cuk-semantic-surface-canvas\)/);
  const theme = readFileSync(new URL('../.kit/capsule-ui-kit/src/design/theme.css', import.meta.url), 'utf8');
  for (const scheme of ['mv-light', 'mv-dark']) {
    const block = theme.split(`:root[data-theme-scheme="${scheme}"][data-theme-contrast="normal"] {`)[1].split('}')[0];
    const resolveColor = token => {
      const primitive = block.match(new RegExp(`${token}: var\\((--[^)]+)\\)`))[1];
      return theme.match(new RegExp(`${primitive}:\\s*(#[\\da-f]+)`))[1];
    };
    const foreground = resolveColor('--cuk-semantic-text-primary');
    const background = resolveColor('--cuk-semantic-surface-canvas');
    assert.ok(contrast(foreground, background) >= 4.5);
  }
  assert.ok(contrast('#777777', '#888888') < 4.5);
});

for (const ordering of ['write-first', 'read-first']) test(`disabled adapter refusal remains visible: ${ordering}`, async () => {
  let disabled = false, saves = 0, rejectRead;
  const app = await mountApp({
    readRaw: async () => disabled ? await new Promise((_resolve, reject) => { rejectRead = reject; }) : JSON.stringify(createWallLayout(SCOPE)),
    writeAtomic: async () => { if (disabled) throw new Error('LAYOUT_SAVE_REFUSED'); saves++; },
  });
  try {
    disabled = true;
    const read = app.storage.readRaw();
    if (ordering === 'read-first') { rejectRead(new Error('LAYOUT_LOAD_FAILED')); await read; }
    await assert.rejects(app.storage.writeAtomic('{}'), /LAYOUT_SAVE_REFUSED/);
    if (ordering === 'write-first') { rejectRead(new Error('LAYOUT_LOAD_FAILED')); await read; }
    await tick();
    assert.equal(byId(app.view.root, 'mv-layout-unavailable').props['data-error-code'], 'LAYOUT_SAVE_REFUSED');
    assert.match(text(byId(app.view.root, 'mv-layout-unavailable')), /Changes cannot be saved/);
    await assert.rejects(app.storage.writeAtomic('{}'), /LAYOUT_SAVE_REFUSED/);
    assert.equal(saves, 0);
  } finally { app.close(); }
});
test('layout alert hides on unrelated screens and returns with the wall', async () => {
  const app = await mountApp({ readRaw: async () => { throw new Error('LAYOUT_LOAD_FAILED'); }, writeAtomic: async () => assert.fail('save crossed lock') });
  try {
    for (const opener of ['shell-creative', 'shell-settings', 'shell-multislot']) {
      assert.ok(byId(app.view.root, 'mv-layout-unavailable'));
      byId(app.view.root, opener).props.onClick(); await tick();
      assert.equal(byId(app.view.root, 'mv-layout-unavailable'), undefined);
      if (opener !== 'shell-settings') { byId(app.view.root, 'shell-settings').props.onClick(); await tick(); }
      byId(app.view.root, 'shell-settings').props.onClick(); await tick();
      assert.ok(byId(app.view.root, 'mv-layout-unavailable'));
    }
  } finally { app.close(); }
});
