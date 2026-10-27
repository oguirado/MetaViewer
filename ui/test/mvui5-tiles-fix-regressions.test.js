// Regression witnesses for the independent tile-state judge findings.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as tiles from '../src/wall/tileStates.js';

const PANEL_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);
const CSS_URL = new URL('../src/wall/wall.css', import.meta.url);
let serial = 0;

async function component(path, deps) {
  globalThis.__mvui5TilesComponents = deps;
  const { descriptor } = parse(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: `t-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content
    .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '')
    .replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      return `const ${binding.trim()} = globalThis.__mvui5TilesComponents[${JSON.stringify(spec)}];`;
    });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#t-component-${serial}`)).default;
}

function mountComponent(Component, props) {
  const root = { children: [] };
  const tracking = vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }),
    createComment: () => ({ text: '' }),
    insert(child, parent) { child.parent = parent; parent.children.push(child); },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; },
    parentNode: (node) => node.parent,
    nextSibling: () => null,
    patchProp(node, name, _old, value) { node.props[name] = value; },
    querySelector: () => null,
    setScopeId() {},
  });
  const liveProps = vue.shallowReactive({ ...props });
  const app = tracking.createApp({ render: () => vue.h(Component, liveProps) });
  app.mount(root);
  return { root, update: (next) => Object.assign(liveProps, next), close: () => app.unmount() };
}

const allNodes = (node) => [node, ...(node.children ?? []).flatMap(allNodes)];
const renderedText = (node) => [node.text ?? '', ...(node.children ?? []).map(renderedText)].join('');
async function flush() {
  await vue.nextTick();
  await vue.nextTick();
  await vue.nextTick();
}

function row(id, overrides = {}) {
  return {
    id, surfaceId: id, backendLifecycle: 'active', generation: 3,
    visibility: 'unfolded', control: 'shared', attachmentState: 'live', ...overrides,
  };
}

function liveSnapshot(rows, overrides = {}) {
  return {
    status: 'live', stale: false, error: null,
    envelope: {
      schema: 'surface/v0.1', epoch: 1, revision: 1, query: 'wall', projection: { rows },
    },
    ...overrides,
  };
}

function createView(snapshot) {
  const listeners = new Set();
  let current = snapshot;
  return {
    view: {
      getSnapshot: () => current,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    emit(next) { current = next; for (const listener of listeners) listener(next); },
  };
}

const Panel = vue.defineComponent({
  props: ['presentationStatus'],
  setup(props, ctx) {
    return () => vue.h('div', {}, [
      vue.h('p', { class: 'stub-status' }, props.presentationStatus),
      ctx.slots.surface?.({}),
    ]);
  },
});

async function mountTile(initial) {
  const feed = createView(initial);
  const Surface = await component('wall/SurfacePanel.vue', {
    'capsule-ui-kit/CapsulePanel': Panel, './tileStates.js': tiles,
  });
  const mounted = mountComponent(Surface, {
    capsuleId: 'a', presentationInstance: 'window-a', projectionView: feed.view,
    intentBuilders: { visibility() {}, control() {}, presentation() {} },
    controlRegistry: {}, scheduler: {}, tileScheduler: {},
  });
  await flush();
  return { mounted, feed };
}

function tileOf(root) {
  return allNodes(root).find((n) => n.props?.['data-tile-state']);
}
function badgeOf(root) {
  return allNodes(root).find((n) => n.props?.class === 'mv-tile-freshness');
}
function statusOf(root) {
  return renderedText(allNodes(root).find((n) => n.props?.class === 'stub-status'));
}


for (const binding of ['capsuleId', 'projectionView']) {
  test(`rebinding ${binding} forgets the previous admitted row`, async () => {
    const { mounted, feed } = await mountTile(liveSnapshot([row('a')]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      const replacement = createView(liveSnapshot([]));
      mounted.update(binding === 'capsuleId' ? { capsuleId: 'b' } : { projectionView: replacement.view });
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'connecting');
      assert.equal(statusOf(mounted.root), 'Waiting');
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      const activeFeed = binding === 'capsuleId' ? feed : replacement;
      const id = binding === 'capsuleId' ? 'b' : 'a';
      activeFeed.emit(liveSnapshot([row(id)]));
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      activeFeed.emit(liveSnapshot([]));
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
    } finally { mounted.close(); }
  });
}

const precedence = [
  { name: 'typed error wins', overrides: { error: { code: 'ERR_PRIVATE', message: '/secret' } }, tile: 'error', status: 'Surface update unavailable' },
  { name: 'error status wins without a code', overrides: { status: 'error' }, tile: 'error', status: 'Surface update unavailable' },
  { name: 'unavailable wins despite a retained envelope and stale flag', overrides: { status: 'unavailable', stale: true }, tile: 'connecting', status: 'Waiting' },
  { name: 'typed error wins over unavailable', overrides: { status: 'unavailable', error: { code: 'ERR_PRIVATE', message: '/secret' } }, tile: 'error', status: 'Surface update unavailable' },
  { name: 'live departure stays lost', overrides: {}, tile: 'lost', status: 'Lost' },
  { name: 'stale departure stays lost', overrides: { status: 'stale', stale: true }, tile: 'lost', status: 'Lost' },
  { name: 'no envelope means waiting', overrides: { envelope: null }, tile: 'connecting', status: 'Waiting' },
];
for (const entry of precedence) {
  test(`departed-row precedence: ${entry.name}`, async () => {
    const { mounted, feed } = await mountTile(liveSnapshot([row('a')]));
    try {
      feed.emit(liveSnapshot([], entry.overrides));
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], entry.tile);
      assert.equal(statusOf(mounted.root), entry.status);
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      assert.doesNotMatch(renderedText(mounted.root), /ERR_PRIVATE|secret/);
      feed.emit(liveSnapshot([row('a')]));
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
    } finally { mounted.close(); }
  });
}

test('control ownership resolves before legacy control; release requires an explicit verb', () => {
  for (const [controlOwner, control, expectedTile] of [
    ['human', 'agent', 'human-control'],
    ['agent', 'human', 'agent-acting'],
    ['agent', 'shared', 'agent-acting'],
    ['human', 'shared', 'human-control'],
    ['none', 'agent', 'agent-acting'],
    [undefined, 'human', 'human-control'],
    ['invalid', 'agent', 'agent-acting'],
  ]) {
    const current = row('a', { controlOwner, control });
    assert.equal(tiles.controlAxisTile(current), expectedTile);
    assert.equal(tiles.controlVerbForRow(current, null), 'take_control');
    assert.equal(tiles.controlVerbForRow(current, 'take_control'), 'take_control');
    assert.equal(tiles.controlVerbForRow(current, 'release_control'), 'release_control');
    assert.equal(tiles.controlVerbForRow(current, 'surface_request.take_control'), 'take_control');
    assert.equal(tiles.controlVerbForRow(current, 'surface_request.release_control'), 'release_control');
  }
  assert.equal(tiles.controlVerbForRow(null, null), 'take_control');
});
