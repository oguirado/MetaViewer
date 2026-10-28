// MVUI30 lane L: the wall panel keeps the frozen frame of a lost tile — the
// capture host stays mounted and the Frame badge keeps the frame identity —
// while lost tiles without a presented frame keep the existing typed Lost
// row. Hosted-safe: the REAL SurfacePanel SFC (compiled with
// @vue/compiler-sfc, inline template, same stub map as the committed panel
// harnesses) on a stub renderer. Plain node:test, no Electron, no sockets,
// no host paths.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as tiles from '../src/wall/tileStates.js';

let serial = 0;

async function component(path, deps) {
  globalThis.__mvui30WallComponents = deps;
  const { descriptor } = parse(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: `mvui30-w-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content
    .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '')
    .replace(/^[ \t]*import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      return `const ${binding.trim()} = globalThis.__mvui30WallComponents[${JSON.stringify(spec)}];`;
    });
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui30-w-${serial}`);
  delete globalThis.__mvui30WallComponents;
  return loaded.default;
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
  const app = tracking.createApp(Component, props);
  app.mount(root);
  return { root, close: () => app.unmount() };
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

function lostRow(id, overrides = {}) {
  return row(id, { backendLifecycle: 'lost', attachmentState: 'disconnected', ...overrides });
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

function schedulerDouble(info) {
  const listeners = new Set();
  let current = info;
  return {
    scheduler: {
      getInstrumentation: () => current,
      subscribePresentation: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    present(next) { current = next; for (const listener of listeners) listener(); },
  };
}

function presentedInfo(overrides = {}) {
  return {
    surfaceId: 'a', surfaceGeneration: 3, epoch: 1, destroyed: false,
    contextLost: false, lastPresentedHandle: 'frame-handle-1',
    lastPresentedDigest: 'ab'.repeat(32), ...overrides,
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

async function mountTile(initial, tileScheduler) {
  const feed = createView(initial);
  const Surface = await component('wall/SurfacePanel.vue', {
    'capsule-ui-kit/CapsulePanel': Panel, './tileStates.js': tiles,
  });
  const mounted = mountComponent(Surface, {
    capsuleId: 'a', presentationInstance: 'window-a', projectionView: feed.view,
    intentBuilders: { visibility() {}, control() {}, presentation() {} },
    controlRegistry: {}, scheduler: {}, tileScheduler,
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
function hostOf(root) {
  return allNodes(root).find((n) => n.props?.class === 'mv-tile-capture-host');
}
function statusOf(root) {
  return allNodes(root).find((n) => n.props?.class === 'mv-tile-status');
}

describe('mvui30 lost panel keeps the frozen frame', () => {
  test('a lost tile with a presented frame keeps its canvas host and frame identity', async () => {
    const double = schedulerDouble(presentedInfo());
    const { mounted } = await mountTile(liveSnapshot([lostRow('a')]), double.scheduler);
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
      assert.equal(hostOf(mounted.root).props.hidden, false, 'frozen capture host stays mounted');
      const badge = badgeOf(mounted.root);
      assert.equal(badge.props.hidden, false);
      assert.equal(renderedText(badge), 'Frame 3');
      const status = statusOf(mounted.root);
      assert.equal(status.props.hidden, false);
      assert.equal(renderedText(status), 'Lost');
    } finally { mounted.close(); }
  });

  test('the frozen tile follows the presentation witness', async () => {
    const double = schedulerDouble(null);
    const { mounted } = await mountTile(liveSnapshot([lostRow('a')]), double.scheduler);
    try {
      assert.equal(hostOf(mounted.root).props.hidden, true);
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      double.present(presentedInfo());
      await flush();
      assert.equal(hostOf(mounted.root).props.hidden, false);
      assert.equal(renderedText(badgeOf(mounted.root)), 'Frame 3');
      double.present(null);
      await flush();
      assert.equal(hostOf(mounted.root).props.hidden, true, 'a lost witness hides the host again');
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      assert.equal(renderedText(statusOf(mounted.root)), 'Lost');
    } finally { mounted.close(); }
  });

  test('negative control: lost without a presented frame keeps the typed Lost row', async () => {
    const double = schedulerDouble(null);
    const { mounted } = await mountTile(liveSnapshot([lostRow('a')]), double.scheduler);
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
      assert.equal(hostOf(mounted.root).props.hidden, true);
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      const status = statusOf(mounted.root);
      assert.equal(status.props.hidden, false);
      assert.equal(renderedText(status), 'Lost');
    } finally { mounted.close(); }
  });

  test('negative controls: terminal scheduler entries never freeze a lost tile', async () => {
    for (const info of [presentedInfo({ destroyed: true }), presentedInfo({ contextLost: true }),
      presentedInfo({ lastPresentedHandle: '' }), presentedInfo({ surfaceGeneration: 2 })]) {
      const double = schedulerDouble(info);
      const { mounted } = await mountTile(liveSnapshot([lostRow('a')]), double.scheduler);
      try {
        assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
        assert.equal(hostOf(mounted.root).props.hidden, true, JSON.stringify(info));
        assert.equal(badgeOf(mounted.root).props.hidden, true, JSON.stringify(info));
        assert.equal(renderedText(statusOf(mounted.root)), 'Lost');
      } finally { mounted.close(); }
    }
  });

  test('negative control: a destroyed row never shows the frozen view', async () => {
    const double = schedulerDouble(presentedInfo());
    const { mounted } = await mountTile(
      liveSnapshot([row('a', { backendLifecycle: 'destroyed', attachmentState: 'disconnected' })]),
      double.scheduler);
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
      assert.equal(hostOf(mounted.root).props.hidden, true);
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      const status = statusOf(mounted.root);
      assert.equal(status.props.hidden, false);
      assert.equal(renderedText(status), 'Destroyed');
    } finally { mounted.close(); }
  });

  test('negative control: a departed row blanks the frame identity', async () => {
    const double = schedulerDouble(presentedInfo());
    const { mounted, feed } = await mountTile(liveSnapshot([row('a')]), double.scheduler);
    try {
      assert.equal(renderedText(badgeOf(mounted.root)), 'Frame 3');
      feed.emit(liveSnapshot([]));
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
      assert.equal(hostOf(mounted.root).props.hidden, true);
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      assert.equal(renderedText(statusOf(mounted.root)), 'Lost');
    } finally { mounted.close(); }
  });

  test('positive control: a live tile with a presented frame is unchanged', async () => {
    const double = schedulerDouble(presentedInfo());
    const { mounted } = await mountTile(liveSnapshot([row('a')]), double.scheduler);
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      assert.equal(hostOf(mounted.root).props.hidden, false);
      assert.equal(renderedText(badgeOf(mounted.root)), 'Frame 3');
    } finally { mounted.close(); }
  });
});
