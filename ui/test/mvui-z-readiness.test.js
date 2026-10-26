import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

let serial = 0;
async function loadApp(captured) {
  const stub = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
  const settings = vue.defineComponent({ props: ['settingsHost'], setup: props => () => { captured.host = props.settingsHost; return vue.h('div'); } });
  const overlay = vue.defineComponent({ props: ['open'], setup: props => () => vue.h('aside', { id: 'test-terminal', open: props.open }) });
  globalThis.__f3deps = {
    './core/HostOutcome.vue': stub,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    'capsule-ui-kit/ui': { UiButton: vue.defineComponent({ props: ['label'], setup: (props, ctx) => () => vue.h('button', ctx.attrs, props.label) }) },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    '../.kit/capsule-ui-kit/src/shell/SettingsModel.js': { SETTINGS_STORAGE_KEYS: { scheme: 'scheme' }, readStoredSetting: (_s, _k, value) => value },
    './wall/WallWorkspace.vue': vue.defineComponent({ setup: (_, ctx) => { captured.wallSettled = () => ctx.emit('wall-settled'); ctx.expose({ revealSurface: () => ({ ok: true }) }); return () => vue.h('div', { id: 'test-wall' }); } }), './wall/EmptyWallView.vue': stub, './catalog/CatalogLauncher.vue': stub,
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
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${++serial}`)).default;
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


function noStyles(node) {
  assert.equal(Object.hasOwn(node.props ?? {}, 'style'), false, 'inline style attribute');
  for (const child of node.children ?? []) noStyles(child);
}

test('readiness follows the visible first frame; terminal host survives closed/open and nested modes', async t => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  try {
    for (const mode of ['empty', 'populated', 'nested', 'fixture-empty', 'fixture-populated', 'fixture-nested']) await t.test(mode, async () => {
      const frames = new Map(); let frameId = 0;
      globalThis.window = { addEventListener() {}, removeEventListener() {},
        requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame(id) { frames.delete(id); } };
      const frame = async () => {
        const callbacks = [...frames.values()]; frames.clear();
        for (const callback of callbacks) callback();
        await vue.nextTick();
      };
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      const populated = mode.endsWith('populated'), nested = mode.endsWith('nested');
      const rows = populated ? [{ id: 'cap-01', generation: 1, backendLifecycle: 'active' }] : [];
      let notify;
      const runtime = { projectionView: { getSnapshot: () => ({ envelope: null }), getProjection: () => ({ rows }),
        subscribe: callback => { notify = callback; return () => {}; } } };
      const app = renderer().createApp(App, { runtime, layout: {}, scope: {},
        nestedHost: nested ? { getNestedDepth: () => 1, getSelfCapsuleId: () => null } : null,
        fixture: mode.startsWith('fixture-') ? { key: nested ? 'nested' : populated ? 'wall' : 'empty', ui: {}, capsules: rows } : null,
        storage: { readRaw: async () => null, writeAtomic: async () => {} } });
      try {
        app.mount(root);
        const shell = () => find(root, n => n.props?.['data-wall-settled'] !== undefined);
        const terminal = () => find(root, n => n.props?.class === 'mv-terminal');
        assert.equal(shell().props['data-wall-settled'], 'false');
        const host = terminal(); assert.ok(host); assert.equal(host.props.hidden, true);
        if (!nested && !populated) { captured.wallSettled(); await vue.nextTick(); }
        assert.equal(shell().props['data-wall-settled'], 'false', 'hidden workspace cannot settle empty view');
        await frame(); assert.equal(shell().props['data-wall-settled'], 'false');
        await frame();
        if (populated) {
          assert.equal(shell().props['data-wall-settled'], 'false', 'frames alone cannot settle workspace');
          captured.wallSettled(); await vue.nextTick();
        }
        assert.equal(shell().props['data-wall-settled'], 'true');
        if (!nested) {
          find(root, n => n.props?.id === 'shell-terminal').props.onClick(); await vue.nextTick();
          assert.equal(terminal(), host); assert.equal(host.props.hidden, false); noStyles(root);
          find(root, n => n.props?.id === 'shell-terminal').props.onClick(); await vue.nextTick();
          assert.equal(terminal(), host); assert.equal(host.props.hidden, true);
        }
        noStyles(root);
        assert.throws(() => noStyles({ props: { style: 'display:none' } }), /inline style/);
        if (mode === 'empty') {
          rows.push({ id: 'arrived', generation: 1, backendLifecycle: 'active' }); notify({ envelope: null });
          await vue.nextTick();
          assert.equal(shell().props['data-wall-settled'], 'false', 'empty witness cannot settle newly mounted workspace');
          captured.wallSettled(); await vue.nextTick(); assert.equal(shell().props['data-wall-settled'], 'true');
          rows.length = 0; notify({ envelope: null }); await vue.nextTick();
          assert.equal(shell().props['data-wall-settled'], 'false');
          await frame(); await frame(); assert.equal(shell().props['data-wall-settled'], 'true');
        }
      } finally { app.unmount(); }
      assert.equal(frames.size, 0, 'unmount cancels queued frames');
    });
  } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__f3deps; }
});
