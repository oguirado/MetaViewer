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
  const previous = globalThis.__mvui6WallFixComponents;
  globalThis.__mvui6WallFixComponents = deps;
  const { descriptor } = parse(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: `w-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content
    .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '')
    .replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      return `const ${binding.trim()} = globalThis.__mvui6WallFixComponents[${JSON.stringify(spec)}];`;
    });
  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#wall-fix-${serial}`)).default;
  } finally {
    if (previous === undefined) delete globalThis.__mvui6WallFixComponents;
    else globalThis.__mvui6WallFixComponents = previous;
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
  const reactiveProps = vue.shallowReactive(props);
  const app = tracking.createApp({ setup: () => () => vue.h(Component, reactiveProps) });
  app.mount(root);
  return { root, props: reactiveProps, close: () => app.unmount() };
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

// Tile-scheduler double with the real instrumentation surface. `info` is the
// getInstrumentation answer; presentation listeners fire through `present()`.
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

async function mountTile(initial, tileScheduler, tileDeps = tiles) {
  const feed = createView(initial);
  const Surface = await component('wall/SurfacePanel.vue', {
    'capsule-ui-kit/CapsulePanel': Panel, './tileStates.js': tileDeps,
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


class MethodScheduler {
  listeners = new Set();
  info = null;
  stopped = 0;
  subscribePresentation(listener) {
    this.listeners.add(listener);
    return () => { this.stopped += 1; this.listeners.delete(listener); };
  }
  getInstrumentation() { return this.info; }
  present(info) {
    this.info = info;
    for (const listener of this.listeners) listener();
  }
}

test('presentation subscription preserves the scheduler method receiver', async () => {
  const scheduler = new MethodScheduler();
  const { mounted } = await mountTile(liveSnapshot([row('a')]), scheduler);
  try {
    assert.equal(scheduler.listeners.size, 1);
    assert.equal(badgeOf(mounted.root).props.hidden, true);
    scheduler.present(presentedInfo());
    await flush();
    assert.equal(renderedText(badgeOf(mounted.root)), 'Frame 3');
    assert.equal(badgeOf(mounted.root).props.hidden, false);
  } finally { mounted.close(); }
  assert.equal(scheduler.listeners.size, 0);
  assert.equal(scheduler.stopped, 1);
});

test('null scheduler mounts without throwing and can acquire a presentation feed', async () => {
  const { mounted } = await mountTile(liveSnapshot([row('a')]), null);
  const next = new MethodScheduler();
  try {
    assert.equal(renderedText(badgeOf(mounted.root)), 'Frame 3');
    mounted.props.tileScheduler = next;
    await flush();
    assert.equal(next.listeners.size, 1);
    assert.equal(badgeOf(mounted.root).props.hidden, true);
    next.present(presentedInfo());
    await flush();
    assert.equal(badgeOf(mounted.root).props.hidden, false);
  } finally { mounted.close(); }
  assert.equal(next.listeners.size, 0);
});

test('scheduler replacement releases old feed, observes new notices, and unmounts cleanly', async () => {
  // Arrow doubles let this test detect missing rebinding independently of receiver binding.
  const old = schedulerDouble(null);
  const next = schedulerDouble(null);
  let oldStops = 0;
  let nextStops = 0;
  const oldSubscribe = old.scheduler.subscribePresentation;
  old.scheduler.subscribePresentation = (listener) => {
    const stop = oldSubscribe(listener);
    return () => { oldStops += 1; stop(); };
  };
  const nextSubscribe = next.scheduler.subscribePresentation;
  next.scheduler.subscribePresentation = (listener) => {
    const stop = nextSubscribe(listener);
    return () => { nextStops += 1; stop(); };
  };
  const { mounted } = await mountTile(liveSnapshot([row('a')]), old.scheduler);
  try {
    mounted.props.tileScheduler = next.scheduler;
    await flush();
    assert.equal(oldStops, 1);
    next.present(presentedInfo());
    await flush();
    assert.equal(badgeOf(mounted.root).props.hidden, false);
    next.present(null);
    await flush();
    assert.equal(badgeOf(mounted.root).props.hidden, true);
    mounted.props.tileScheduler = null;
    await flush();
    assert.equal(nextStops, 1);
    old.present(presentedInfo());
    await flush();
    assert.equal(renderedText(badgeOf(mounted.root)), 'Frame 3');
  } finally { mounted.close(); }
  assert.equal(oldStops, 1);
  assert.equal(nextStops, 1);
});

test('presentation witness uses the retained row generation during a projection gap', async () => {
  const double = schedulerDouble(presentedInfo());
  const generations = [];
  const { mounted, feed } = await mountTile(liveSnapshot([row('a')]), double.scheduler, {
    ...tiles,
    // Isolate freshness from Lost's separate badge suppression on row removal.
    deriveTileState: () => ({ tile: 'live', status: 'Live', controlVerb: 'take_control' }),
    presentedFrameHandle(scheduler, id, generation, epoch) {
      generations.push(generation);
      return tiles.presentedFrameHandle(scheduler, id, generation, epoch);
    },
  });
  try {
    feed.emit(liveSnapshot([]));
    await flush();
    assert.equal(generations.at(-1), 3);
    assert.equal(badgeOf(mounted.root).props.hidden, false);
    assert.equal(renderedText(badgeOf(mounted.root)), 'Frame 3');
    double.present(presentedInfo({ surfaceGeneration: 4 }));
    await flush();
    assert.equal(badgeOf(mounted.root).props.hidden, true, 'a stale witness still fails');
  } finally { mounted.close(); }
});
