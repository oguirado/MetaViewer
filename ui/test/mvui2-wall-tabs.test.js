// Lane V2 dock tabs (MV-2): every capsule dock tab carries a stable id and a
// capsule-scoped semantic anchor through the renderer's own tab component.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { matchControlFamily } from '../.kit/capsule-ui-kit/src/agent/controlRegistry.js';
import {
  assertAnchoredControls,
  collectAgentControls,
} from '../src/agent/agentLane.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(testDir, '.tmp-wall-mv2v2');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Import the WallWorkspace module script untouched (pattern of wall.test.js). */
async function loadWallModule() {
  mkdirSync(tmpDir, { recursive: true });
  const source = readFileSync(new URL('../src/wall/WallWorkspace.vue', import.meta.url), 'utf8');
  const { descriptor, errors } = parse(source, { filename: 'WallWorkspace.vue' });
  assert.equal(errors.length, 0);
  const modulePath = path.join(tmpDir, 'wallWorkspaceModule.mjs');
  writeFileSync(modulePath, descriptor.script.content);
  return import(pathToFileURL(modulePath).href);
}

describe('dock tab description (pure module)', async () => {
  const wall = await loadWallModule();

  test('capsule params resolve a stable id, anchor and title', () => {
    const tab = wall.describeDockTab({
      params: { capsuleId: 'cap-01' },
      api: { id: 'panel-cap-01', title: 'Research browser' },
    });
    assert.deepEqual({ ...tab }, {
      capsuleId: 'cap-01',
      id: 'wall-tab-cap-01',
      anchor: 'workspace/tab/cap-01',
      title: 'Research browser',
    });
    assert.notEqual(tab.anchor, `capsule/${tab.capsuleId}/tab`);
    assert.ok(Object.isFrozen(tab));
  });

  test('panel id re-derives the capsule when params are absent', () => {
    const tab = wall.describeDockTab({
      params: {},
      api: { id: 'panel-cap-02', title: 'Holdings board' },
    });
    assert.equal(tab.capsuleId, 'cap-02');
    assert.equal(tab.id, 'wall-tab-cap-02');
    assert.equal(tab.anchor, 'workspace/tab/cap-02');
    assert.notEqual(tab.anchor, `capsule/${tab.capsuleId}/tab`);
    assert.equal(tab.title, 'Holdings board');
  });

  test('params win over a mismatched panel id', () => {
    const tab = wall.describeDockTab({
      params: { capsuleId: 'cap-01' },
      api: { id: 'panel-cap-99', title: 'Stale' },
    });
    assert.equal(tab.capsuleId, 'cap-01');
    assert.equal(tab.id, 'wall-tab-cap-01');
  });

  test('blank titles fall back to the capsule id; missing titles to Capsule', () => {
    assert.equal(wall.resolveDockTabTitle({ api: { title: '  ' } }, 'cap-01'), 'cap-01');
    assert.equal(wall.resolveDockTabTitle({ api: {} }, 'cap-01'), 'cap-01');
    assert.equal(wall.resolveDockTabTitle({ api: {} }, null), 'Capsule');
    assert.equal(wall.DOCK_TAB_FALLBACK_TITLE, 'Capsule');
    assert.equal(wall.DOCK_TAB_ID_PREFIX, 'wall-tab-');
  });

  test('negative controls: invalid identities never anchor', () => {
    for (const tabProps of [null, undefined, {}, { params: {} },
      { params: { capsuleId: '' } }, { params: { capsuleId: 'has space' } },
      { params: { capsuleId: ' padded ' } }, { params: { capsuleId: 7 } },
      { api: { id: 'panel-' } }, { api: { id: 'panel-has space' } },
      { api: { id: 'dv-tab-3' } }]) {
      const tab = wall.describeDockTab(tabProps);
      assert.equal(tab.capsuleId, null, JSON.stringify(tabProps));
      assert.equal(tab.id, null, JSON.stringify(tabProps));
      assert.equal(tab.anchor, null, JSON.stringify(tabProps));
      assert.equal(typeof tab.title, 'string', JSON.stringify(tabProps));
    }
  });

  test('ids and anchors are deterministic kebab-case', () => {
    const anchorRe = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
    const first = wall.describeDockTab({ params: { capsuleId: 'cap-01' }, api: {} });
    const second = wall.describeDockTab({ params: { capsuleId: 'cap-01' }, api: {} });
    assert.equal(first.id, second.id);
    assert.equal(first.anchor, second.anchor);
    assert.match(first.anchor, anchorRe);
    assert.doesNotMatch(first.id, /\s/);
    // Negative control: distinct capsules never share an id or anchor.
    const other = wall.describeDockTab({ params: { capsuleId: 'cap-02' }, api: {} });
    assert.notEqual(first.id, other.id);
    assert.notEqual(first.anchor, other.anchor);
  });

  test('tab anchors match the kit capsule tab family', () => {
    const rule = matchControlFamily('capsule/cap-01/tab');
    assert.ok(rule);
    assert.equal(rule.template, 'capsule/{id}/tab');
    // Negative control: numeric-only segments never match the inventory.
    assert.equal(matchControlFamily('capsule/123/tab'), null);
  });
});

/** Minimal DOM double for one rendered tab span. */
function fakeTabNode({ id, anchor, title }) {
  return {
    id,
    tagName: 'SPAN',
    textContent: title,
    getAttribute(name) {
      if (name === 'data-semantic-anchor') return anchor;
      return null;
    },
    getBoundingClientRect: () => ({ x: 40, y: 39, width: 102, height: 24 }),
  };
}

describe('dock tab lane visibility', () => {
  test('an anchored tab span is collected by the lane producer', () => {
    const root = {
      querySelectorAll: () => [
        fakeTabNode({ id: 'wall-tab-cap-01', anchor: 'capsule/cap-01/tab', title: 'Research browser' }),
      ],
    };
    const { controls, skipped } = collectAgentControls(root);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].id, 'wall-tab-cap-01');
    assert.equal(controls[0].anchor, 'capsule/cap-01/tab');
    assert.equal(controls[0].name, 'Research browser');
    assert.equal(controls[0].enabled, true);
    assert.equal(controls[0].visible, true);
    assert.equal(skipped.length, 0);
  });

  test('negative control: unanchored or id-less tab spans fail the lane gate', () => {
    const root = {
      querySelectorAll: () => [
        fakeTabNode({ id: 'wall-tab-cap-01', anchor: null, title: 'Research browser' }),
        fakeTabNode({ id: '', anchor: 'capsule/cap-02/tab', title: 'Holdings board' }),
      ],
    };
    const { controls, skipped } = collectAgentControls(root);
    assert.equal(controls.length, 0);
    assert.deepEqual(skipped.map((row) => row.reason), ['empty-anchor', 'missing-id']);
    assert.throws(
      () => assertAnchoredControls(root.querySelectorAll()),
      /id\+anchor rule/,
      'the strict gate fails on a missing anchor',
    );
  });
});

let serial = 0;

/** Compile the WallWorkspace SFC with stubbed kit/sibling imports. */
async function compileWall(deps) {
  globalThis.__v2WallDeps = deps;
  const source = readFileSync(new URL('../src/wall/WallWorkspace.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source, { filename: 'WallWorkspace.vue' });
  const compiled = compileScript(descriptor, { id: `v2-wall-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^[ \t]*import\s*['"][^'"\n]+['"];?$/gm, '').replace(/^[ \t]*import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__v2WallDeps[${JSON.stringify(spec)}];`;
  });
  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#v2-wall-${serial}`)).default;
  } finally {
    delete globalThis.__v2WallDeps;
  }
}

function mountComponent(Component, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }),
    createComment: () => ({ text: '' }),
    insert(child, parent) { child.parent = parent; parent.children.push(child); },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; },
    parentNode: (node) => node.parent ?? null,
    nextSibling: () => null,
    patchProp(node, name, _old, value) { node.props[name] = value; },
    querySelector: () => null,
    setScopeId() {},
  });
  const app = renderer.createApp(Component, props);
  app.mount(root);
  return { root, close: () => app.unmount() };
}

const allNodes = (node) => [node, ...(node.children ?? []).flatMap(allNodes)];

/** Mount the wall once and return the registered product tab component. */
async function loadSurfaceTab() {
  const seen = [];
  const dockStub = vue.defineComponent({
    name: 'StubDockWorkspace',
    props: ['tabComponents', 'defaultTabComponent'],
    setup(props) { seen.push(props); return () => vue.h('section'); },
  });
  const panelStub = vue.defineComponent({ name: 'StubSurfacePanel', setup: () => () => vue.h('div') });
  const WallWorkspace = await compileWall({
    'capsule-ui-kit/DockWorkspace': dockStub,
    './SurfacePanel.vue': panelStub,
  });
  const wallApp = mountComponent(WallWorkspace, {
    scope: { product: 'metaviewer', profileId: 'default', workspaceId: 'main-wall' },
    storage: {},
    ownerWindowId: 'window-main',
    projectionView: { getProjection: () => ({ rows: [] }) },
    intentBuilders: {},
    controlRegistry: {},
    scheduler: {},
    tileScheduler: {},
  });
  try {
    assert.equal(seen.length, 1);
    const SurfaceTab = seen[0].tabComponents?.SurfaceTab;
    assert.ok(SurfaceTab, 'product tab is registered');
    return SurfaceTab;
  } finally {
    wallApp.close();
  }
}

describe('SurfaceTab render contract', () => {
  test('tab component stays registered as the default dock tab', () => {
    const source = readFileSync(new URL('../src/wall/WallWorkspace.vue', import.meta.url), 'utf8');
    assert.ok(source.includes("name: 'SurfaceTab'"));
    assert.ok(source.includes('describeDockTab(tabProps.params)'));
    assert.ok(source.includes('default-tab-component="SurfaceTab"'));
    assert.ok(source.includes(':tab-components="tabComponents"'));
  });

  test('capsule tabs render the anchored span with the panel title', async () => {
    const SurfaceTab = await loadSurfaceTab();
    const tabApp = mountComponent(SurfaceTab, {
      params: {
        params: { capsuleId: 'cap-01' },
        api: { id: 'panel-cap-01', title: 'Research browser' },
      },
    });
    try {
      const spans = allNodes(tabApp.root).filter((node) => node.tag === 'span');
      assert.equal(spans.length, 1);
      assert.equal(spans[0].props.class, 'mv-surface-tab');
      assert.equal(spans[0].props.id, 'wall-tab-cap-01');
      assert.equal(spans[0].props['data-semantic-anchor'], 'workspace/tab/cap-01');
      assert.notEqual(spans[0].props['data-semantic-anchor'], 'capsule/cap-01/tab');
      assert.equal(spans[0].text, 'Research browser');
    } finally {
      tabApp.close();
    }
  });

  test('negative control: tabs without capsule identity render unanchored', async () => {
    const SurfaceTab = await loadSurfaceTab();
    const tabApp = mountComponent(SurfaceTab, {
      params: { params: {}, api: { id: 'dv-tab-9' } },
    });
    try {
      const spans = allNodes(tabApp.root).filter((node) => node.tag === 'span');
      assert.equal(spans.length, 1);
      assert.equal(spans[0].props.class, 'mv-surface-tab');
      assert.equal(spans[0].props.id, undefined);
      assert.ok(!('data-semantic-anchor' in spans[0].props));
      assert.equal(spans[0].text, 'Capsule');
    } finally {
      tabApp.close();
    }
  });
});

/** Fail-closed source predicate: any inline-style vector throws. */
function assertNoInlineStyleVector(source, label) {
  assert.doesNotMatch(source, /style\s*=/, `${label}: no style attribute`);
  assert.doesNotMatch(source, /:style\b/, `${label}: no :style binding`);
  assert.doesNotMatch(source, /v-bind:style/, `${label}: no v-bind:style`);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style['"]/, `${label}: no setAttribute('style')`);
  assert.doesNotMatch(source, /\.style\b/, `${label}: no element.style write`);
  assert.doesNotMatch(source, /element\.style/, `${label}: no element.style reference`);
}

describe('lane CSP surface (V2 additions)', () => {
  test('touched files carry zero inline-style vectors', () => {
    for (const file of ['../src/wall/WallWorkspace.vue', '../src/wall/tileStates.js',
      '../src/wall/SurfacePanel.vue', '../src/catalog/catalogModel.js']) {
      assertNoInlineStyleVector(readFileSync(new URL(file, import.meta.url), 'utf8'), file);
    }
  });

  test('negative control: a planted style attribute fails the predicate', () => {
    assertNoInlineStyleVector('<span class="mv-surface-tab">Research browser</span>', 'clean');
    assert.throws(
      () => assertNoInlineStyleVector('<span style="color:red">planted</span>', 'planted'),
      assert.AssertionError,
    );
  });
});
