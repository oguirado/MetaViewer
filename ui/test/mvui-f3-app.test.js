import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

async function loadApp(captured) {
  const stub = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
  const settings = vue.defineComponent({ props: ['settingsHost'], setup: props => () => { captured.host = props.settingsHost; return vue.h('div'); } });
  const overlay = vue.defineComponent({ props: ['open'], setup: props => () => vue.h('aside', { id: 'test-terminal', open: props.open }) });
  globalThis.__f3deps = {
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    'capsule-ui-kit/ui': { UiButton: vue.defineComponent({ props: ['label'], setup: (props, ctx) => () => vue.h('button', ctx.attrs, props.label) }) },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    '../.kit/capsule-ui-kit/src/shell/SettingsModel.js': { SETTINGS_STORAGE_KEYS: { scheme: 'scheme' }, readStoredSetting: (_s, _k, value) => value },
    './wall/WallWorkspace.vue': vue.defineComponent({ setup: () => () => vue.h('div') }), './wall/EmptyWallView.vue': stub, './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': overlay, './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub, './settings/MvSettingsPanel.vue': settings,
    './agent/AgentLaneHost.vue': stub, './surfaces/SurfaceCanvas.vue': stub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall }, './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: 'f3-app', inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__f3deps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
}
function renderer() {
  return vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
    insert(child, parent, anchor) { if (child.parent) this.remove(child); child.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, child); },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) { node.props[key] = value; }, querySelector: () => null, setScopeId() {},
  });
}
function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children ?? []) { const result = find(child, predicate); if (result) return result; } return null; }

test('mounted App injects settings and keeps overlays and expanded controls synchronized', async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  let hostReads = 0, app;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, get metaviewer() { hostReads++; throw new Error('App crossed host boundary'); } };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  try {
    const captured = {}, App = await loadApp(captured), root = { children: [] };
    const settingsHost = vue.markRaw({ loadSettings: async () => null, saveSettings: async () => true });
    const row = { id: 'cap-01', title: 'Capsule', generation: 1, backendLifecycle: 'active' };
    const runtime = { projectionView: { getSnapshot: () => ({ envelope: null }), getProjection: () => ({ rows: [row] }), subscribe: () => () => {} } };
    app = renderer().createApp(App, { settingsHost, runtime, layout: {}, scope: {}, storage: { readRaw: async () => null, writeAtomic: async () => {} } });
    app.mount(root);
    const byId = id => find(root, node => node.props?.id === id);
    const settingsScreen = () => find(root, node => node.props?.class === 'mv-settings-screen');
    const click = async id => { byId(id).props.onClick(); await vue.nextTick(); };
    const expanded = id => byId(id).props['aria-expanded'];
    assert.equal(captured.host, settingsHost);
    assert.equal(hostReads, 0);
    await click('shell-terminal');
    assert.equal(expanded('shell-terminal'), true);
    assert.equal(byId('test-terminal').props.open, true);
    await click('shell-multislot');
    assert.equal(expanded('shell-terminal'), false);
    assert.equal(expanded('shell-multislot'), true);
    assert.equal(byId('test-terminal'), null);
    await click('shell-terminal');
    assert.equal(expanded('shell-terminal'), true);
    assert.equal(expanded('shell-multislot'), false);
    await click('shell-settings');
    assert.equal(expanded('shell-terminal'), false);
    assert.equal(expanded('shell-settings'), true);
    assert.equal(settingsScreen().props.hidden, false);
    await click('shell-multislot');
    assert.equal(expanded('shell-settings'), false);
    assert.equal(settingsScreen().props.hidden, true);
    await click('shell-settings');
    assert.equal(expanded('shell-multislot'), false);
    await click('shell-terminal');
    assert.equal(expanded('shell-settings'), false);
    assert.equal(settingsScreen().props.hidden, true);
    await click('shell-terminal');
    assert.equal(expanded('shell-terminal'), false);
  } finally {
    app?.unmount(); globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__f3deps;
  }
});
