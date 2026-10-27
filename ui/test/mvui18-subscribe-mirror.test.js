// MVUI18 lane J: kit view subscribe mirroring. Subscribers consuming the
// callback argument must see the mirrored folded boolean, not just readers
// of getSnapshot(). Real SurfacePanel SFC with a stub kit panel capturing
// the injected view. Plain node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as tileStates from '../src/wall/tileStates.js';

const SOURCE_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);
const source = readFileSync(SOURCE_URL, 'utf8');

let serial = 0;
async function compilePanel(capsulePanelStub) {
  const tileCaptureStub = vue.defineComponent({ props: ['capsuleId'], setup: () => () => vue.h('div') });
  const deps = {
    'capsule-ui-kit/CapsulePanel': capsulePanelStub,
    './tileStates.js': tileStates,
    './TileCaptureChrome.vue': tileCaptureStub,
  };
  globalThis.__mvui18PanelDeps = deps;
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `mvui18-panel-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content
    .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '')
    .replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      return `const ${binding.trim()} = globalThis.__mvui18PanelDeps[${JSON.stringify(spec)}];`;
    });
  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui18-panel-${serial}`)).default;
  } finally {
    delete globalThis.__mvui18PanelDeps;
  }
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
  const app = tracking.createApp({ setup: () => () => vue.h(Component, props) });
  app.mount(root);
  return { root, close: () => app.unmount() };
}

async function flush() {
  await vue.nextTick();
  await vue.nextTick();
  await vue.nextTick();
}

function liveRow(overrides = {}) {
  return { id: 'k1', surfaceId: 'k1', title: 'Capsule k1', display: ':100', profile_id: '',
    generation: 1, backendLifecycle: 'active', visibility: 'unfolded', control: 'shared',
    controlOwner: 'none', attachmentState: 'live', ...overrides };
}

function liveSnapshot(rows) {
  return { status: 'live', stale: false,
    envelope: { schema: 'metaviewer.frame-wall/v1', epoch: 1, revision: 7, query: 'authority.frames',
      projection: { rows } },
    error: null };
}

function createSource(initial) {
  const listeners = new Set();
  let current = initial;
  return {
    view: {
      getSnapshot: () => current,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    emit(next) { current = next; for (const listener of listeners) listener(next); },
  };
}

test('mvui18 subscribe mirror: callback argument carries the mirrored folded boolean', async () => {
  const captured = [];
  const KitStub = vue.defineComponent({
    setup() {
      captured.push(vue.inject('publicProjectionView', null));
      return () => vue.h('div');
    },
  });
  const SurfacePanel = await compilePanel(KitStub);
  const feed = createSource(liveSnapshot([liveRow({ visibility: 'unfolded' })]));
  const mounted = mountComponent(SurfacePanel, {
    capsuleId: 'k1', presentationInstance: 'window-k1', projectionView: feed.view,
    intentBuilders: { visibility() {}, control() {}, presentation() {} },
    controlRegistry: {}, scheduler: {}, tileScheduler: null,
  });
  try {
    await flush();
    assert.equal(captured.length, 1);
    const kitView = captured[0];
    assert.ok(kitView && typeof kitView.subscribe === 'function');
    assert.equal(kitView.getSnapshot().envelope.projection.rows[0].folded, false);
    const seen = [];
    const stop = kitView.subscribe((snapshot) => { seen.push(snapshot); });
    try {
      const raw = liveSnapshot([liveRow({ visibility: 'folded' })]);
      assert.equal(raw.envelope.projection.rows[0].folded, undefined);
      feed.emit(raw);
      await flush();
      assert.equal(seen.length, 1);
      assert.equal(seen[0].envelope.projection.rows[0].folded, true);
      assert.equal(raw.envelope.projection.rows[0].folded, undefined, 'the source row is never mutated');
    } finally {
      stop();
    }
  } finally {
    mounted.close();
  }
});

test('mvui18 subscribe mirror negative: raw view stays raw and null passes through', async () => {
  const captured = [];
  const KitStub = vue.defineComponent({
    setup() {
      captured.push(vue.inject('publicProjectionView', null));
      return () => vue.h('div');
    },
  });
  const SurfacePanel = await compilePanel(KitStub);
  const feed = createSource(liveSnapshot([liveRow({ visibility: 'folded' })]));
  const mounted = mountComponent(SurfacePanel, {
    capsuleId: 'k1', presentationInstance: 'window-k1', projectionView: feed.view,
    intentBuilders: { visibility() {}, control() {}, presentation() {} },
    controlRegistry: {}, scheduler: {}, tileScheduler: null,
  });
  try {
    await flush();
    const kitView = captured[0];
    const rawSeen = [];
    const stopRaw = feed.view.subscribe((snapshot) => { rawSeen.push(snapshot); });
    const kitSeen = [];
    const stopKit = kitView.subscribe((snapshot) => { kitSeen.push(snapshot); });
    try {
      feed.emit(liveSnapshot([liveRow({ visibility: 'folded' })]));
      await flush();
      assert.equal(rawSeen[0].envelope.projection.rows[0].folded, undefined);
      assert.equal(kitSeen[0].envelope.projection.rows[0].folded, true);
      feed.emit(null);
      await flush();
      assert.equal(kitSeen[1], null);
      const shaped = Object.freeze({ id: 'k1', surfaceId: 'k1', visibility: 'folded', folded: true });
      const clean = liveSnapshot([shaped]);
      feed.emit(clean);
      await flush();
      assert.equal(kitSeen[2], clean, 'already-correct snapshots keep identity');
    } finally {
      stopRaw();
      stopKit();
    }
  } finally {
    mounted.close();
  }
});

test('mvui18 subscribe mirror: setup wraps the listener with the snapshot mirror', () => {
  const setup = source.slice(source.indexOf('<script setup>'));
  assert.match(setup, /provide\('publicProjectionView', kitProjectionView\)/);
  assert.ok(setup.includes('(s) => listener(mirrorKitFoldedSnapshot(s))'));
  assert.equal(setup.includes('kitViewSource.subscribe(listener)'), false);
});

test('mvui18 subscribe mirror: rss stays bounded', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
