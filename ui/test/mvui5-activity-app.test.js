// Lane V App wiring: strip mount, bounded feed, authority-only receipts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { createAuthorityAdapter } from '../src/core/hostAdapters.js';
import { MV_ACTIVITY_LIMIT } from '../src/activity/activityModel.js';

const APP_URL = new URL('../src/App.vue', import.meta.url);
const app = readFileSync(APP_URL, 'utf8');

describe('activity mount in App', () => {
  test('strip is imported, fed and docked between the wall body and the status bar', () => {
    assert.ok(app.includes("import ActivityStrip from './activity/ActivityStrip.vue';"),
      'default strip import keeps stub harnesses degrading to an empty slot');
    assert.ok(app.includes('<ActivityStrip v-if="!nestedMode.displayOnly" :entries="activityFeed" />'),
      'strip mounts with the feed and hides in nested display-only mode');
    const mainClose = app.indexOf('</main>');
    const stripAt = app.indexOf('<ActivityStrip');
    const barAt = app.indexOf('<StatusBar');
    assert.ok(mainClose > 0 && stripAt > mainClose, 'strip mounts outside the wall main');
    assert.ok(barAt > stripAt, 'strip docks above the status bar, never over tiles');
  });

  test('shell grid reserves a docked strip row', () => {
    assert.ok(app.includes('minmax(0,1fr) auto var(--cuk-component-app-shell-status-height)'),
      'strip row sits between the wall body and the status bar');
  });

  test('submitHost records authority receipts and dispatch stays untouched', () => {
    const dispatcher = app.match(/function dispatch\(intent\) \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(dispatcher, 'dispatch keeps its pinned shape');
    assert.doesNotMatch(dispatcher, /activityFeed|recordActivity|ActivityStrip/,
      'dispatch references only its pinned free variables');
    assert.ok(dispatcher.includes('submitHost'), 'dispatch still routes through submitHost');
    assert.ok(app.includes('function recordActivity(outcome)'), 'feed recorder exists');
    assert.ok(app.includes("recordActivity(result === true ? { code: 'INTENT_ACKNOWLEDGED' } : result)"),
      'acks and verdicts are recorded');
    assert.ok(app.includes("recordActivity({ code: 'HOST_REQUEST_REFUSED' })"),
      'transport refusals are recorded');
  });

  test('App bound mirrors the model bound', () => {
    const literal = app.match(/const ACTIVITY_LIMIT = (\d+);/)?.[1];
    assert.equal(Number(literal), MV_ACTIVITY_LIMIT, 'inline bound equals MV_ACTIVITY_LIMIT');
  });

  test('negative control: misplaced mount and divergent bounds fail', () => {
    const ordered = (text) => {
      const stripAt = text.indexOf('<ActivityStrip');
      const barAt = text.indexOf('<StatusBar');
      assert.ok(stripAt > text.indexOf('</main>') && barAt > stripAt, 'docked order');
    };
    ordered(app);
    assert.throws(() => ordered('<main><ActivityStrip /></main><StatusBar />'), assert.AssertionError);
    assert.equal(Number(app.match(/const ACTIVITY_LIMIT = (\d+);/)?.[1]), 8);
    assert.throws(() => assert.equal(7, MV_ACTIVITY_LIMIT), assert.AssertionError);
  });
});

let serial = 0;
async function loadApp(captured) {
  const stub = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
  const strip = vue.defineComponent({ props: ['entries'],
    setup: props => { captured.stripEntries = () => props.entries; return () => vue.h('section', { id: 'test-activity' }); } });
  globalThis.__vdeps = {
    './core/HostOutcome.vue': stub,
    './activity/ActivityStrip.vue': strip,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': vue.defineComponent({ setup: (_, ctx) => { captured.wall = ctx; return () => vue.h('div'); } }),
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': vue.defineComponent({ setup: (_, ctx) => { captured.catalog = ctx; return () => vue.h('div'); } }),
    './terminal/SideTerminalOverlay.vue': stub, './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub, './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub, './surfaces/SurfaceCanvas.vue': stub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall }, './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(APP_URL, 'utf8'));
  const compiled = compileScript(descriptor, { id: `v-app-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__vdeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#v-${serial}`)).default;
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
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await vue.nextTick(); };

describe('activity feed behavior', () => {
  test('intent acks, verdicts and refusals append; creative and overflow do not leak', async () => {
    const oldWindow = globalThis.window, oldDocument = globalThis.document;
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
    let appHandle;
    try {
      let verdict = { schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' };
      let failIntent = false;
      const authorityHost = createAuthorityAdapter({
        intent: async () => { if (failIntent) throw new Error('closed'); return true; },
        propose: async () => verdict,
      });
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      const rows = [{ id: 'surface-a', generation: 1, backendLifecycle: 'active' }];
      const runtime = { projectionView: { getSnapshot: () => ({ envelope: null }),
        getProjection: () => ({ rows }), subscribe: () => () => {} } };
      appHandle = renderer().createApp(App, { authorityHost, runtime, layout: {}, scope: {},
        nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
        storage: { readRaw: async () => null, writeAtomic: async () => {} } });
      appHandle.mount(root);
      assert.ok(find(root, node => node.props?.id === 'test-activity'), 'strip mounts outside nested mode');
      assert.deepEqual(captured.stripEntries(), [], 'feed starts empty');

      captured.wall.emit('submit-intent', { op: 'take_control', surfaceId: 'surface-a' });
      await tick();
      assert.deepEqual(captured.stripEntries(), [{ seq: 1, code: 'INTENT_ACKNOWLEDGED' }]);

      verdict = { schema: 'action_verdict/v0.2', proposal_id: 'q', core_seq: 2, decision: 'refused', reason_code: 'LOCKED_BY_OTHER' };
      captured.catalog.emit('create', { kind: 'browser' });
      await tick();
      assert.equal(captured.stripEntries().length, 2);
      assert.deepEqual(captured.stripEntries().at(-1), { seq: 2, code: 'LOCKED_BY_OTHER' });

      failIntent = true;
      captured.wall.emit('submit-intent', { op: 'release_control', surfaceId: 'surface-a' });
      await tick();
      assert.deepEqual(captured.stripEntries().at(-1), { seq: 3, code: 'HOST_REQUEST_REFUSED' });

      captured.wall.emit('submit-intent', { type: 'creative/close' });
      await tick();
      assert.equal(captured.stripEntries().length, 3, 'non-authority outcomes never reach the feed');

      failIntent = false;
      for (let i = 0; i < 10; i += 1) {
        captured.wall.emit('submit-intent', { op: 'take_control', surfaceId: 'surface-a' });
        await tick();
      }
      const feed = captured.stripEntries();
      assert.equal(feed.length, MV_ACTIVITY_LIMIT, 'history stays bounded');
      assert.deepEqual(feed.map(entry => entry.seq), [6, 7, 8, 9, 10, 11, 12, 13]);
      assert.ok(feed.every(entry => entry.code === 'INTENT_ACKNOWLEDGED'));
    } finally {
      appHandle?.unmount();
      globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__vdeps;
    }
  });

  test('strip stays unmounted in nested display-only mode', async () => {
    const oldWindow = globalThis.window, oldDocument = globalThis.document;
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
    let appHandle;
    try {
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      const runtime = { projectionView: { getSnapshot: () => ({ envelope: null }),
        getProjection: () => ({ rows: [] }), subscribe: () => () => {} } };
      appHandle = renderer().createApp(App, { runtime, layout: {}, scope: {},
        nestedHost: { getNestedDepth: () => 1, getSelfCapsuleId: () => null },
        storage: { readRaw: async () => null, writeAtomic: async () => {} } });
      appHandle.mount(root);
      assert.equal(find(root, node => node.props?.id === 'test-activity'), null, 'no strip in nested mode');
    } finally {
      appHandle?.unmount();
      globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__vdeps;
    }
  });
});
