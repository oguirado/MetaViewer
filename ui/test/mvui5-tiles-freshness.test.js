// Lane T tile freshness: a deterministic latest-frame badge on live-axis
// tiles, departed rows keeping a Lost tile, and recovery back to live.
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

describe('mounted freshness badge', () => {
  test('live-axis tiles show the latest admitted frame; connecting shows none', async () => {
    const { mounted, feed } = await mountTile(liveSnapshot([row('a')]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      assert.equal(statusOf(mounted.root), 'Live');
      const badge = badgeOf(mounted.root);
      assert.ok(badge);
      assert.equal(badge.props.hidden, false);
      assert.equal(renderedText(badge), 'Frame 3');
      feed.emit({ status: 'unavailable', stale: false, envelope: null, error: null });
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'connecting');
      assert.equal(badgeOf(mounted.root).props.hidden, true);
    } finally { mounted.close(); }
  });

  test('a departed row keeps a Lost tile and recovery returns to live', async () => {
    const { mounted, feed } = await mountTile(liveSnapshot([row('a')]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      feed.emit(liveSnapshot([], { envelope: { ...liveSnapshot([]).envelope, revision: 2 } }));
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
      assert.equal(statusOf(mounted.root), 'Lost');
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      feed.emit(liveSnapshot([row('a', { generation: 4 })]));
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      assert.equal(statusOf(mounted.root), 'Live');
      assert.equal(renderedText(badgeOf(mounted.root)), 'Frame 4');
    } finally { mounted.close(); }
  });

  test('a missing row before the first frame stays connecting, never lost', async () => {
    const { mounted } = await mountTile(liveSnapshot([]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'connecting');
      assert.equal(statusOf(mounted.root), 'Waiting');
      assert.equal(badgeOf(mounted.root).props.hidden, true);
    } finally { mounted.close(); }
  });

  test('stale transport keeps the axis tile with Stale text and the last frame', async () => {
    const { mounted, feed } = await mountTile(liveSnapshot([row('a')]));
    try {
      feed.emit(liveSnapshot([row('a')], { status: 'stale', stale: true }));
      await flush();
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'live');
      assert.equal(statusOf(mounted.root), 'Stale');
      const badge = badgeOf(mounted.root);
      assert.equal(badge.props.hidden, false);
      assert.equal(renderedText(badge), 'Frame 3');
    } finally { mounted.close(); }
  });

  test('error tiles keep the exact typed copy and hide the badge', async () => {
    const bad = row('a', { refusal: { code: 'ERR_PRIVATE', message: '/secret' } });
    const { mounted } = await mountTile(liveSnapshot([bad]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'error');
      assert.equal(statusOf(mounted.root), 'Surface update unavailable');
      assert.equal(badgeOf(mounted.root).props.hidden, true);
      assert.doesNotMatch(renderedText(mounted.root), /ERR_PRIVATE|secret/);
    } finally { mounted.close(); }
  });

  test('terminal lifecycle rows keep the lost tile without inventing a badge', async () => {
    const { mounted } = await mountTile(liveSnapshot([row('a', { backendLifecycle: 'lost' })]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
      assert.equal(statusOf(mounted.root), 'Lost');
      assert.equal(badgeOf(mounted.root).props.hidden, true);
    } finally { mounted.close(); }
  });
});

describe('tile markup contracts', () => {
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

  test('freshness badge markup ships zero inline-style vectors', () => {
    assert.ok(template.includes('mv-tile-freshness'), 'badge keeps its lane class');
    assert.ok(template.includes('{{ freshness }}'), 'badge renders the derived text');
    assertNoInlineStyleVector(template, 'SurfacePanel template');
    const css = readFileSync(CSS_URL, 'utf8');
    assert.ok(css.includes('.mv-tile-freshness'), 'badge keeps lane-owned CSS');
    assert.ok(css.includes('var(--cuk-'), 'badge builds on kit tokens');
    assertNoInlineStyleVector(css, 'wall.css');
  });

  test('negative control: a planted style attribute fails the CSP predicate', () => {
    assertNoInlineStyleVector(template, 'SurfacePanel template');
    assert.throws(
      () => assertNoInlineStyleVector('<p class="mv-tile-freshness" style="color: red">Frame 1</p>', 'planted'),
      assert.AssertionError,
    );
  });

  test('badge adds zero bare controls and no focus overrides', () => {
    assert.deepEqual(interactiveTags(template), [], 'no lane-owned button/input/select/link');
    assert.doesNotMatch(template, /tabindex/, 'no lane focus order overrides');
  });

  test('negative control: a control without an anchor fails the anchor predicate', () => {
    for (const tag of interactiveTags(template)) assertAnchoredControl(tag);
    assert.throws(
      () => assertAnchoredControl('<button id="tile-freshness-copy">Copy</button>'),
      assert.AssertionError,
    );
  });
});
