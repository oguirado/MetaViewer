// Lane W (MV-9): folded tiles collapse, error tiles state their message
// once, and the connecting tile placeholder is never clipped. Live rows
// must carry the same fold presentation axis tile-states draws; the error
// body line must defer to the kit readiness banner when it owns the
// message; the connecting capture host must scroll instead of clipping.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as tiles from '../src/wall/tileStates.js';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { LIVE_REPLAY_SCRIPT } from '../src/fixtures/liveReplay.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';

const PANEL_URL = new URL('../src/wall/SurfacePanel.vue', import.meta.url);
const CSS_URL = new URL('../src/wall/wall.css', import.meta.url);
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
function statusLineOf(root) {
  return allNodes(root).find((n) => n.props?.class === 'mv-tile-status');
}

// One closed v0.2 notice through the real authority runtime.
function liveRowForNotice(notice) {
  const port = {
    subscribeFrames(callback) {
      callback(JSON.parse(JSON.stringify(notice)));
      return () => {};
    },
  };
  const runtime = createAuthorityRuntime(/** @type {never} */ (port));
  assert.ok(runtime);
  try {
    const rows = runtime.projectionView.getProjection()?.rows ?? [];
    assert.equal(rows.length, 1);
    return rows[0];
  } finally {
    runtime.dispose();
  }
}

describe('MV-9 folded presentation parity', () => {
  function decisionFor(liveRow) {
    return tiles.deriveTileState(
      { status: 'live', stale: false, envelope: { projection: { rows: [liveRow] } }, error: null },
      liveRow, liveRow,
    );
  }

  test('live folded notices derive the folded tile tile-states draws', () => {
    const notice = JSON.parse(JSON.stringify(LIVE_REPLAY_SCRIPT[1].notice));
    notice.surface.visibility = 'folded';
    const live = liveRowForNotice(notice);
    assert.equal(live.visibility, 'folded');
    assert.equal(decisionFor(live).tile, 'folded');
    const result = createFixtureRuntime('tile-states');
    assert.equal(result.ok, true);
    const reference = result.mount.runtime.projectionView.getProjection().rows
      .find((entry) => entry.id === 'cap-03');
    assert.ok(reference);
    assert.equal(reference.visibility, 'folded');
    assert.equal(decisionFor(reference).tile, 'folded');
  });

  test('negative control: unfolded live notices derive live, never folded', () => {
    const live = liveRowForNotice(LIVE_REPLAY_SCRIPT[1].notice);
    assert.equal(live.visibility, 'unfolded');
    assert.equal(decisionFor(live).tile, 'live');
  });

  test('folded tiles collapse their lane body in CSS', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    assert.match(css, /\.mv-tile\[data-tile-state="folded"\]/);
    assert.match(css, /\.mv-tile\[data-tile-state="folded"\][^{]*\{[^}]*height:\s*auto/);
    assert.match(css, /\.mv-tile\[data-tile-state="folded"\][\s\S]*?\.mv-tile-capture-host[\s\S]*?display:\s*none/);
  });
});

describe('MV-9 error message stated once', () => {
  const MESSAGE = 'Surface update unavailable';

  // Rendered text only: hidden subtrees never reach pixels.
  function visibleText(node, hidden = false) {
    if (hidden || node.props?.hidden === true) return '';
    return [node.text ?? '', ...(node.children ?? []).map((child) => visibleText(child, false))].join('');
  }

  function occurrences(root) {
    return visibleText(root).split(MESSAGE).length - 1;
  }

  test('a kit-owned readiness message hides the duplicate body line', async () => {
    const bad = row('a', {
      refusal: { code: 'ERR_FIXTURE_SURFACE', message: MESSAGE },
      readinessError: { code: 'ERR_FIXTURE_SURFACE', message: MESSAGE },
    });
    const { mounted } = await mountTile(liveSnapshot([bad]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'error');
      assert.equal(statusLineOf(mounted.root).props.hidden, true);
      assert.equal(occurrences(mounted.root), 1);
    } finally { mounted.close(); }
  });

  test('without a kit banner the body line stays the single statement', async () => {
    const bad = row('a', { refusal: { code: 'ERR_PRIVATE', message: '/secret' } });
    const { mounted } = await mountTile(liveSnapshot([bad]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'error');
      const line = statusLineOf(mounted.root);
      assert.equal(line.props.hidden, false);
      assert.equal(renderedText(line), MESSAGE);
      // Chip badge plus the single body statement, nothing else.
      assert.equal(occurrences(mounted.root), 2);
      assert.doesNotMatch(renderedText(mounted.root), /ERR_PRIVATE|secret/);
    } finally { mounted.close(); }
  });

  test('negative control: lost tiles keep their body status line', async () => {
    const { mounted } = await mountTile(liveSnapshot([row('a', { backendLifecycle: 'lost' })]));
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'lost');
      const line = statusLineOf(mounted.root);
      assert.equal(line.props.hidden, false);
      assert.equal(renderedText(line), 'Lost');
    } finally { mounted.close(); }
  });
});

describe('MV-9 connecting placeholder never clipped', () => {
  test('connecting tiles scroll their capture host instead of clipping', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    assert.match(css, /\.mv-tile\[data-tile-state="connecting"\][\s\S]*?\.mv-tile-capture-host[\s\S]*?overflow:\s*auto/);
  });

  test('connecting tiles keep the capture host mounted', async () => {
    const { mounted } = await mountTile(
      liveSnapshot([row('a', { attachmentState: 'attaching' })]),
    );
    try {
      assert.equal(tileOf(mounted.root).props['data-tile-state'], 'connecting');
      const host = allNodes(mounted.root).find((n) => n.props?.class === 'mv-tile-capture-host');
      assert.ok(host, 'capture host stays mounted for the waiting canvas');
      assert.equal(host.props.hidden, false);
    } finally { mounted.close(); }
  });

  test('negative control: a planted style attribute fails the CSP predicate', () => {
    const css = readFileSync(CSS_URL, 'utf8');
    assert.doesNotMatch(css, /style\s*=/);
    assert.throws(
      () => assert.doesNotMatch(
        '<div class="mv-tile-capture-host" style="overflow: auto"></div>', /style\s*=/,
      ),
      assert.AssertionError,
    );
  });
});
