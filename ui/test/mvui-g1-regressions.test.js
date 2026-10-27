import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as adapters from '../src/core/hostAdapters.js';
import * as catalog from '../src/catalog/catalogModel.js';
import * as tiles from '../src/wall/tileStates.js';
import { deriveTileState } from '../src/wall/tileStates.js';
let serial = 0;
async function component(path, deps) {
  globalThis.__g1Components = deps;
  const { descriptor } = parse(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: `w-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+['"][^'"\n]+['"];?$/gm, '').replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__g1Components[${JSON.stringify(spec)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#w-component-${serial}`)).default;
}
function mountComponent(Component, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: text => ({ text: '' }),
    insert(child, parent) { child.parent = parent; parent.children.push(child); },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: node => node.parent, nextSibling: () => null, patchProp(node, name, _old, value) { node.props[name] = value; },
    querySelector: () => null, setScopeId() {},
  });
  const app = renderer.createApp(Component, props); app.mount(root);
  return { root, close: () => app.unmount() };
}
const allNodes = node => [node, ...(node.children ?? []).flatMap(allNodes)];
const renderedText = node => [node.text ?? '', ...(node.children ?? []).map(renderedText)].join(' ');

function notice(id = 'surface-a', changes = {}) {
  return { frame_ref: { schema: 'frame_ref/v0.2', surface_id: id, generation: 1,
    width: 10, height: 10, tick: 1, ts_ns: 1, capture_us: 1, format: 'rgb24', sha256: 'a'.repeat(64) },
  surface: { schema: 'surface/v0.2', surface_id: id, kind: 'desktop_capsule', display: 'Desktop',
    geometry: { w: 10, h: 10 }, state: 'active', visibility: 'unfolded', control: 'agent', profile_id: 'default', ...changes } };
}


test('authority frames drive every admitted axis and invalid frames produce an error tile', () => {
  let receive, stops = 0;
  const runtime = adapters.createAuthorityRuntime({ subscribeFrames(callback) { receive = callback; return () => stops++; } });
  const view = runtime.projectionView;
  try {
    for (const [changes, tile] of [
      [{ control: 'shared' }, 'live'], [{ visibility: 'folded' }, 'folded'],
      [{ control: 'human' }, 'human-control'], [{ control: 'agent' }, 'agent-acting'],
      [{ state: 'lost' }, 'lost'], [{ state: 'destroyed' }, 'lost'],
    ]) {
      receive(notice('a', changes));
      assert.equal(deriveTileState(view.getSnapshot(), view.getProjection().rows[0]).tile, tile);
    }
    receive(notice('a', { control: 'invented' }));
    assert.equal(deriveTileState(view.getSnapshot(), view.getProjection().rows[0]).tile, 'error');
  } finally { runtime.dispose(); runtime.dispose(); }
  assert.equal(stops, 1);
});

test('distinct raw unknown kinds survive collisions while exact duplicates collapse', () => {
  const kinds = ['', '   ', '!!!', '???', 'foo_bar', 'foo-bar', 'foo_bar-2', 'foo_bar'];
  const { errors } = catalog.normalizeCatalogEntries(kinds);
  assert.deepEqual(errors.map(row => row.kind), kinds.slice(0, -1));
  assert.equal(new Set(errors.map(row => row.key)).size, errors.length);
  for (const row of errors) assert.match(row.key, /^[a-z0-9-]+$/);
});

test('mounted launcher restores only after visible changes to false and renders fixed error copy', async () => {
  let dialog, focused = 0;
  const original = globalThis.document;
  globalThis.document = { activeElement: { isConnected: true, focus() { focused++; } } };
  const stub = vue.defineComponent({ setup(_props, ctx) { dialog = ctx; return () => vue.h('div', {}, ctx.slots.empty?.()); } });
  const Launcher = await component('catalog/CatalogLauncher.vue', {
    '../../.kit/capsule-ui-kit/src/index-shell.js': { NewCapsuleDialog: stub }, './catalogModel.js': catalog,
  });
  const state = vue.reactive({ visible: false });
  const Wrapper = vue.defineComponent({ setup: () => () => vue.h(Launcher, { visible: state.visible, kinds: ['ERR_PRIVATE /secret', '!!!', '???'] }) });
  const mounted = mountComponent(Wrapper, {});
  try {
    state.visible = true; await vue.nextTick();
    dialog.emit('close'); await vue.nextTick(); assert.equal(focused, 0);
    dialog.emit('update:visible', false); await vue.nextTick(); assert.equal(focused, 0);
    state.visible = false; await vue.nextTick(); assert.equal(focused, 1);
    dialog.emit('close'); await vue.nextTick(); assert.equal(focused, 1);
    const rows = allNodes(mounted.root).filter(n => n.tag === 'li');
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map(n => n.props.id)).size, 3);
    for (const row of rows) {
      assert.equal(row.props['data-error-code'], catalog.CATALOG_UNKNOWN_KIND);
      assert.match(row.props['data-semantic-anchor'], /^dialog\/new-capsule\/error-[a-z0-9-]+$/);
    }
    assert.doesNotMatch(renderedText(mounted.root), /ERR_|PRIVATE|secret/);
    assert.equal(allNodes(mounted.root).some(n => n.props?.style), false);
  } finally { mounted.close(); globalThis.document = original; }
});

test('mounted HostOutcome uses closed literals, status roles, anchors and no inline style', async () => {
  const Outcome = await component('core/HostOutcome.vue', { './hostAdapters.js': adapters });
  for (const [code, tone, role, copy] of [
    ['ACTION_ADMITTED', 'success', 'status', 'Action admitted.'],
    ['LOCKED_BY_OTHER', 'refusal', 'alert', 'Another operator controls this surface.'],
    ['ERR_PRIVATE', 'success', 'alert', 'This request is unavailable. Please try again.'],
  ]) {
    const mounted = mountComponent(Outcome, { row: { code, tone, message: 'ERR_PRIVATE /secret' } });
    try {
      const row = allNodes(mounted.root).find(n => n.tag === 'p');
      assert.equal(renderedText(row).trim(), copy);
      assert.equal(row.props.role, role);
      assert.equal(row.props.id, 'mv-host-outcome');
      assert.equal(row.props['data-semantic-anchor'], 'host/outcome');
      assert.equal(row.props['data-outcome-code'], code);
      assert.equal(row.props.style, undefined);
    } finally { mounted.close(); }
  }
});

test('mounted wall maps refusal codes to fixed visible copy and keeps code metadata', async () => {
  const row = { id: 'a', surfaceId: 'a', backendLifecycle: 'active', generation: 1,
    visibility: 'unfolded', control: 'shared', refusal: { code: 'ERR_PRIVATE', message: '/secret' } };
  const snapshot = { status: 'live', stale: false, error: null,
    envelope: { schema: 'surface/v0.1', epoch: 1, revision: 1, query: 'wall', projection: { rows: [row] } } };
  const Panel = vue.defineComponent({ props: ['presentationStatus'], setup: props => () => vue.h('p', props.presentationStatus) });
  const Surface = await component('wall/SurfacePanel.vue', {
    'capsule-ui-kit/CapsulePanel': Panel, './tileStates.js': tiles,
  });
  const mounted = mountComponent(Surface, { capsuleId: 'a', presentationInstance: 'window-a',
    projectionView: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    intentBuilders: { visibility() {}, control() {}, presentation() {} }, controlRegistry: {}, scheduler: {}, tileScheduler: {} });
  try {
    assert.doesNotMatch(renderedText(mounted.root), /ERR_|secret/);
    assert.match(renderedText(mounted.root), /Surface update unavailable/);
    const tile = allNodes(mounted.root).find(n => n.props?.['data-tile-state']);
    assert.equal(tile.props['data-error-code'], 'ERR_PRIVATE');
  } finally { mounted.close(); }
});

test('terminal broker preserves optional close receiver for stale session cleanup', async () => {
  const port = { async open() { return { session: 'a' }; }, async close(spec) {
    assert.equal(this, port); assert.deepEqual(spec, { session: 'a' }); return true;
  } };
  const broker = adapters.createTerminalBroker(port);
  assert.equal(typeof broker.close, 'function');
  assert.equal(await broker.close({ session: 'a' }), true);
  assert.equal(adapters.createTerminalBroker({ open: port.open }).close, null);
});

test('mounted wall follows successive live authority notices without staying connecting', async () => {
  let receive;
  const runtime = adapters.createAuthorityRuntime({ subscribeFrames(callback) { receive = callback; return () => {}; } });
  const Panel = vue.defineComponent({ props: ['presentationStatus'], setup: props => () => vue.h('p', props.presentationStatus) });
  const Surface = await component('wall/SurfacePanel.vue', { 'capsule-ui-kit/CapsulePanel': Panel, './tileStates.js': tiles });
  const mounted = mountComponent(Surface, { capsuleId: 'a', presentationInstance: 'window-a',
    projectionView: runtime.projectionView, intentBuilders: runtime.intentBuilders,
    controlRegistry: {}, scheduler: {}, tileScheduler: {} });
  try {
    for (const [change, expected] of [[{ control: 'shared' }, 'live'], [{ visibility: 'folded' }, 'folded'],
      [{ control: 'human' }, 'human-control'], [{ control: 'agent' }, 'agent-acting'], [{ state: 'lost' }, 'lost']]) {
      receive(notice('a', change)); await vue.nextTick();
      assert.equal(allNodes(mounted.root).find(n => n.props?.['data-tile-state']).props['data-tile-state'], expected);
    }
    receive(notice('a', { control: 'invalid' })); await vue.nextTick();
    assert.equal(allNodes(mounted.root).find(n => n.props?.['data-tile-state']).props['data-tile-state'], 'error');
    assert.doesNotMatch(renderedText(mounted.root), /ERR_/);
  } finally { mounted.close(); runtime.dispose(); }
});
