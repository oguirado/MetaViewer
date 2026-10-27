// Lane W (MV-8): the Frame badge never shows together with the
// "Connecting to surface" placeholder. The badge claims an admitted frame,
// so it must stay hidden until the tile scheduler affirmatively reports a
// presented frame for the current generation; schedulers without the
// instrumentation API keep the legacy admitted-generation badge.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as tiles from '../src/wall/tileStates.js';

const PANEL_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);
let serial = 0;

async function component(path, deps) {
  globalThis.__mvui6WallComponents = deps;
  const { descriptor } = parse(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'));
  const compiled = compileScript(descriptor, { id: `w-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content
    .replace(/^import\s+['"][^'"\n]+['"];?$/gm, '')
    .replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
      if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      return `const ${binding.trim()} = globalThis.__mvui6WallComponents[${JSON.stringify(spec)}];`;
    });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#w-component-${serial}`)).default;
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

describe('MV-8 presented-frame badge gate', () => {
  test('a live tile hides the Frame badge while nothing is presented', async () => {
    const double = schedulerDouble(null);
    const { mounted } = await mountTile(liveSnapshot([row('a')]), double.scheduler);
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      assert.equal(badgeOf(mounted.root).props.hidden, true);
    } finally { mounted.close(); }
  });

  test('the badge appears with the first presented frame and tracks it', async () => {
    const double = schedulerDouble(null);
    const { mounted } = await mountTile(liveSnapshot([row('a')]), double.scheduler);
    try {
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      double.present(presentedInfo());
      await flush();
      const badge = badgeOf(mounted.root);
      assert.equal(badge.props.hidden, false);
      assert.equal(renderedText(badge), 'Frame 3');
    } finally { mounted.close(); }
  });

  test('negative controls: stale generation, epoch or terminal entry hide the badge', async () => {
    for (const info of [
      presentedInfo({ surfaceGeneration: 2 }),
      presentedInfo({ epoch: 2 }),
      presentedInfo({ destroyed: true }),
      presentedInfo({ contextLost: true }),
      presentedInfo({ lastPresentedHandle: '' }),
    ]) {
      const double = schedulerDouble(info);
      const { mounted } = await mountTile(liveSnapshot([row('a')]), double.scheduler);
      try {
        assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
        assert.equal(badgeOf(mounted.root).props.hidden, true, JSON.stringify(info));
      } finally { mounted.close(); }
    }
  });

  test('schedulers without instrumentation keep the legacy admitted badge', async () => {
    const { mounted } = await mountTile(liveSnapshot([row('a')]), {});
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      const badge = badgeOf(mounted.root);
      assert.equal(badge.props.hidden, false);
      assert.equal(renderedText(badge), 'Frame 3');
    } finally { mounted.close(); }
  });
});

describe('presented-frame helper contract', () => {
  const { presentedFrameHandle } = tiles;

  test('readable instrumentation resolves to the presented handle or empty', () => {
    assert.equal(typeof presentedFrameHandle, 'function');
    assert.equal(presentedFrameHandle({ getInstrumentation: () => presentedInfo() }, 'a', 3, 1), 'frame-handle-1');
    assert.equal(presentedFrameHandle({ getInstrumentation: () => null }, 'a', 3, 1), '');
    assert.equal(presentedFrameHandle({ getInstrumentation: () => presentedInfo({ surfaceGeneration: 2 }) }, 'a', 3, 1), '');
    assert.equal(presentedFrameHandle({ getInstrumentation: () => presentedInfo({ epoch: 9 }) }, 'a', 3, 1), '');
    assert.equal(presentedFrameHandle({ getInstrumentation: () => presentedInfo({ destroyed: true }) }, 'a', 3, 1), '');
    assert.equal(presentedFrameHandle({ getInstrumentation: () => presentedInfo({ contextLost: true }) }, 'a', 3, 1), '');
    assert.equal(presentedFrameHandle({ getInstrumentation: () => presentedInfo({ lastPresentedHandle: '' }) }, 'a', 3, 1), '');
  });

  test('negative controls: unknown or malformed instrumentation never claims a frame', () => {
    assert.equal(presentedFrameHandle(null, 'a', 3, 1), null);
    assert.equal(presentedFrameHandle({}, 'a', 3, 1), null);
    assert.equal(presentedFrameHandle({ getInstrumentation: 'yes' }, 'a', 3, 1), null);
    assert.equal(presentedFrameHandle({ getInstrumentation: () => { throw new Error('boom'); } }, 'a', 3, 1), null);
    assert.equal(presentedFrameHandle({ getInstrumentation: () => 7 }, 'a', 3, 1), null);
    assert.equal(presentedFrameHandle({ getInstrumentation: () => presentedInfo({ lastPresentedHandle: 7 }) }, 'a', 3, 1), null);
  });
});

describe('MV-8 tile markup contracts', () => {
  const source = readFileSync(PANEL_URL, 'utf8');
  const template = source.slice(source.indexOf('<template>'));

  function assertNoInlineStyleVector(text, label) {
    assert.doesNotMatch(text, /style\s*=/, `${label}: no style attribute`);
    assert.doesNotMatch(text, /:style\b/, `${label}: no :style binding`);
    assert.doesNotMatch(text, /v-bind:style/, `${label}: no v-bind:style`);
    assert.doesNotMatch(text, /setAttribute\(\s*['"]style['"]/, `${label}: no setAttribute('style')`);
    assert.doesNotMatch(text, /\.style\b/, `${label}: no element.style write`);
  }

  function interactiveTags(text) {
    const tags = [];
    for (const pattern of [/<button\b[^>]*>/g, /<UiButton\b[^>]*>/gs, /<input\b[^>]*>/g,
      /<select\b[^>]*>/g, /<a\b[^>]*>/g]) {
      tags.push(...(text.match(pattern) ?? []));
    }
    return tags;
  }

  function assertAnchoredControl(tag) {
    assert.match(tag, /\bid="[^"]+"/, `control keeps a stable id: ${tag}`);
    const anchor = tag.match(/\bdata-semantic-anchor="([^"]+)"/);
    assert.ok(anchor, `control keeps a data-semantic-anchor: ${tag}`);
    assert.match(anchor[1], /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
      `anchor is kebab-case and deterministic: ${anchor[1]}`);
  }

  test('badge gate ships zero inline-style vectors', () => {
    assertNoInlineStyleVector(template, 'SurfacePanel template');
  });

  test('negative control: a planted style attribute fails the CSP predicate', () => {
    assert.throws(
      () => assertNoInlineStyleVector('<p class="mv-tile-freshness" style="color: red">Frame 1</p>', 'planted'),
      assert.AssertionError,
    );
  });

  test('badge gate adds zero bare controls', () => {
    for (const tag of interactiveTags(template)) assertAnchoredControl(tag);
  });

  test('negative control: a control without an anchor fails the anchor predicate', () => {
    assert.throws(
      () => assertAnchoredControl('<button id="tile-freshness-copy">Copy</button>'),
      assert.AssertionError,
    );
  });
});
