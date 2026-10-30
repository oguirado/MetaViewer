// Lane V bench hook: fixture-only dispatch handle driving production paths.
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
import { normalizeActivityEntry } from '../src/activity/activityModel.js';

const APP_URL = new URL('../src/App.vue', import.meta.url);
const app = readFileSync(APP_URL, 'utf8');

const PINNED_IMPORTS = [
  'vue',
  './identities/IdentitiesDialog.vue',
  './handoff/HandoffNotice.vue',
  './creative/CreativeCapsule.vue',
  './core/HostOutcome.vue',
  'capsule-ui-kit/DockWorkspace',
  '../.kit/capsule-ui-kit/src/index-shell.js',
  './wall/EmptyWallView.vue',
  './catalog/CatalogLauncher.vue',
  './terminal/SideTerminalOverlay.vue',
  './multislot/MultislotHost.vue',
  './recording/MvRecordingPanel.vue',
  './settings/MvSettingsPanel.vue',
  './agent/AgentLaneHost.vue',
  './activity/ActivityStrip.vue',
  './nested/nested.js',
  'capsule-ui-kit/ui',
  'capsule-ui-kit/theme',
  './wall/WallWorkspace.vue',
  './surfaces/SurfaceCanvas.vue',
  './surfaces/tileScheduler.js',
];

describe('bench hook source shape', () => {
  test('hook exposes the real dispatch paths as a frozen handle', () => {
    assert.ok(app.includes('const benchHook = Object.freeze({ dispatch, dispatchMultislot, createCapsule: onCreateCapsule,\n  openMultislot, openTerminal: openTerminalBench });'),
      'replay steps call the same functions the UI controls call');
    assert.ok(app.includes('function openTerminalBench() { if (!terminalOpen.value) toggleTerminal(); }'),
      'terminal opener is deterministic, never a toggle');
  });

  test('lost-row admission keeps the live path open and the stub scope pinned', () => {
    assert.ok(app.includes('const admitLostRows = computed(() => diagnosticTileStates || !props.fixture || props.fixture.ui?.liveReplay === true);'),
      'live boot and live-replay admit lost rows; stub fixtures stay diagnostic-only');
    assert.ok(app.includes("&& (row.backendLifecycle !== 'lost' || admitLostRows.value)) ?? [];"),
      'rows keep lost exactly when admitted, destroyed never');
    assert.ok(app.includes(':allow-lost-surface="admitLostRows"'),
      'wall admission follows the same flag');
  });

  test('hook installs only with a fixture key and is removed on unmount', () => {
    assert.ok(app.includes('if (benchWindow && props.fixture) benchWindow.__metaviewerBench = benchHook;'),
      'live boot never installs the hook');
    assert.ok(app.includes('if (benchWindow && benchWindow.__metaviewerBench === benchHook) delete benchWindow.__metaviewerBench;'),
      'unmount removes only the installed handle');
  });

  test('App import surface stays closed for the stub harnesses', () => {
    const specifiers = [...app.matchAll(/^import\s+[^\n]+?\s+from\s+(['"])(.*?)\1;?$/gm)]
      .map(match => match[2]);
    assert.deepEqual(specifiers, PINNED_IMPORTS, 'exact admitted imports: boot and app stub maps keep working');
  });

  test('negative control: unguarded install and widened imports fail', () => {
    const guarded = (source) => {
      assert.ok(source.includes('props.fixture) benchWindow.__metaviewerBench = benchHook'),
        'install stays behind the fixture guard');
    };
    guarded(app);
    assert.throws(() => guarded('benchWindow.__metaviewerBench = benchHook;'), assert.AssertionError);
    const specifiers = [...app.matchAll(/^import\s+[^\n]+?\s+from\s+(['"])(.*?)\1;?$/gm)]
      .map(match => match[2]);
    assert.deepEqual(specifiers, PINNED_IMPORTS);
    assert.throws(() => assert.deepEqual([...specifiers, './activity/benchHook.js'], PINNED_IMPORTS),
      assert.AssertionError, 'a new import breaks the pinned surface');
  });
});

let serial = 100;
async function loadApp(captured) {
  const stub = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
  const strip = vue.defineComponent({ props: ['entries'],
    setup: props => { captured.stripEntries = () => props.entries; return () => vue.h('section', { id: 'test-activity' }); } });
  globalThis.__vdeps = {
    './core/HostOutcome.vue': stub,
    './activity/ActivityStrip.vue': strip,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/WallWorkspace.vue': vue.defineComponent({ props: ['allowLostSurface'],
      setup: (props, ctx) => { captured.wall = ctx; captured.wallProps = () => ({ ...props });
        ctx.expose({ revealSurface: (id) => { (captured.revealed ??= []).push(id); return { ok: true }; } });
        return () => vue.h('div'); } }),
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': vue.defineComponent({ setup: (_, ctx) => { captured.catalog = ctx; return () => vue.h('div'); } }),
    './terminal/SideTerminalOverlay.vue': stub, './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub, './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub, './surfaces/SurfaceCanvas.vue': stub,
    './creative/CreativeCapsule.vue': stub,
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './nested/nested.js': { resolveNestedMode, applyNestedWall }, './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(APP_URL, 'utf8'));
  const compiled = compileScript(descriptor, { id: `v-bench-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__vdeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#v-bench-${serial}`)).default;
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
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await vue.nextTick(); };
function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children ?? []) { const result = find(child, predicate); if (result) return result; } return null; }
function stubGlobals(fakeWindow) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = fakeWindow;
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  return () => { globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__vdeps; };
}
const FIXTURE = Object.freeze({ key: 'live-replay', screen: 'wall', scheme: 'mv-light', capsules: [], ui: {} });
function wallRuntime(rows) {
  return { projectionView: { getSnapshot: () => ({ envelope: null }),
    getProjection: () => ({ rows }), subscribe: () => () => {} } };
}
const STORAGE = { readRaw: async () => null, writeAtomic: async () => {} };
const NESTED_LIVE = { getNestedDepth: () => 0, getSelfCapsuleId: () => null };
/** @param {Array<{seq:number,code:string}>|undefined} feed */
function renderedTexts(feed) {
  return (feed ?? []).map(item => normalizeActivityEntry(item)?.text);
}

describe('bench hook behavior', () => {
  test('fixture mount installs the hook; intent, verdict and multislot rows flow through it', async () => {
    const fakeWindow = { addEventListener() {}, removeEventListener() {} };
    const restore = stubGlobals(fakeWindow);
    let appHandle;
    try {
      let verdict = { schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' };
      let failIntent = false;
      const calls = [];
      const authorityHost = createAuthorityAdapter({
        intent: async (json) => { calls.push(json); if (failIntent) throw new Error('closed'); return true; },
        propose: async (json) => { calls.push(json); return verdict; },
      });
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      const rows = [{ id: 'surface-a', generation: 1, backendLifecycle: 'active', visibility: 'unfolded' }];
      appHandle = renderer().createApp(App, { authorityHost, runtime: wallRuntime(rows),
        layout: {}, scope: {}, fixture: FIXTURE, nestedHost: NESTED_LIVE, storage: STORAGE });
      appHandle.mount(root);
      const hook = fakeWindow.__metaviewerBench;
      assert.ok(hook, 'hook installs when a fixture key is present');
      assert.ok(Object.isFrozen(hook), 'handle is closed');
      assert.deepEqual(Object.keys(hook).sort(),
        ['createCapsule', 'dispatch', 'dispatchMultislot', 'openMultislot', 'openTerminal']);
      assert.deepEqual(captured.stripEntries(), [], 'strip starts empty before any submission');

      hook.dispatch({ op: 'take_control', surfaceId: 'surface-a' });
      await tick();
      assert.deepEqual(calls, [], 'bare hook control never reaches the host');
      assert.deepEqual(captured.stripEntries(), [], 'bare control creates no authority activity');

      hook.dispatch({ schema: 'ui_intent/v0.2', request_id: 'bench-take', op: 'take_control', params: { surface_id: 'surface-a' } });
      await tick();
      assert.deepEqual(renderedTexts(captured.stripEntries()), ['Request sent.']);
      assert.equal(calls.length, 1, 'one closed control submits once');
      const wire = JSON.parse(calls[0]);
      assert.match(wire.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        'the authority adapter assigns a fresh wire request id');
      assert.deepEqual(wire, { schema: 'ui_intent/v0.2', request_id: wire.request_id,
        op: 'take_control', params: { surface_id: 'surface-a' } }, 'closed hook control keeps the exact closed wire shape');

      verdict = { schema: 'action_verdict/v0.2', proposal_id: 'q', core_seq: 2, decision: 'refused', reason_code: 'POLICY' };
      hook.dispatch({ action: 'open', target: 'surface-a' });
      await tick();
      assert.deepEqual(renderedTexts(captured.stripEntries()),
        ['Request sent.', 'This action is unavailable under the current policy.']);

      verdict = { schema: 'action_verdict/v0.2', proposal_id: 'r', core_seq: 3, decision: 'admitted' };
      hook.createCapsule({ kind: 'browser' });
      await tick();
      assert.equal(renderedTexts(captured.stripEntries()).at(-1), 'Action admitted.');

      const beforeFold = captured.stripEntries().length;
      const beforeFoldCalls = calls.length;
      for (const [slot_id, capsuleId] of [
        ['slot-1', 'surface-a'], // Old fixture: unbound slot must never be acknowledged.
        ['cuk-ai-slot-surface-b', 'surface-a'],
        ['cuk-ai-slot-surface-b', 'surface-b'], // Bound, but not the selected capsule.
      ]) {
        await hook.dispatchMultislot(
          { schema: 'ui_intent/v0.2', request_id: 'bench-foreign', op: 'fold', params: { slot_id } }, capsuleId);
        await tick();
        assert.equal(calls.length, beforeFoldCalls, 'foreign slot/capsule never reaches the host');
        assert.equal(captured.stripEntries().length, beforeFold, 'refusal cannot invent an ack activity');
      }
      await hook.dispatchMultislot(
        { schema: 'ui_intent/v0.2', request_id: 'bench-1', op: 'fold', params: { slot_id: 'cuk-ai-slot-surface-a' } }, 'surface-a');
      await tick();
      assert.equal(calls.length, beforeFoldCalls + 1, 'selected bound slot submits once');
      const foldWire = JSON.parse(calls.at(-1));
      assert.deepEqual(foldWire, { schema: 'ui_intent/v0.2', request_id: foldWire.request_id,
        op: 'fold', params: { slot_id: 'cuk-ai-slot-surface-a' } });
      assert.equal(captured.stripEntries().length, beforeFold + 1, 'ack appends an activity row');
      assert.equal(renderedTexts(captured.stripEntries()).at(-1), 'Request sent.',
        'acked multislot fold records through the production path');

      failIntent = true;
      await hook.dispatchMultislot(
        { schema: 'ui_intent/v0.2', request_id: 'bench-2', op: 'unfold', params: { slot_id: 'cuk-ai-slot-surface-a' } }, 'surface-a');
      await tick();
      assert.equal(renderedTexts(captured.stripEntries()).at(-1), 'This request is unavailable. Please try again.',
        'refused multislot unfold records through the production path');

      hook.dispatch({ schema: 'ui_intent/v0.2', request_id: 'bench-release', op: 'release_control', params: { surface_id: 'surface-a' } });
      await tick();
      assert.equal(renderedTexts(captured.stripEntries()).at(-1), 'This request is unavailable. Please try again.');
      assert.equal(captured.stripEntries().length, 6);
      assert.deepEqual(captured.stripEntries().map(entry => entry.seq), [1, 2, 3, 4, 5, 6]);
      assert.equal(calls.length, 6, 'every row came from exactly one real port submission');

      appHandle.unmount(); appHandle = null;
      assert.equal(fakeWindow.__metaviewerBench, undefined, 'unmount removes the handle');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });

  test('hook dispatch matches the UI emit path and emit-only intents stay out of the feed', async () => {
    const fakeWindow = { addEventListener() {}, removeEventListener() {} };
    const restore = stubGlobals(fakeWindow);
    let appHandle;
    try {
      const authorityHost = createAuthorityAdapter({ intent: async () => true, propose: async () => ({
        schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }), });
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      const rows = [{ id: 'surface-a', generation: 1, backendLifecycle: 'active', visibility: 'unfolded' }];
      appHandle = renderer().createApp(App, { authorityHost, runtime: wallRuntime(rows),
        layout: {}, scope: {}, fixture: FIXTURE, nestedHost: NESTED_LIVE, storage: STORAGE });
      appHandle.mount(root);
      captured.wall.emit('submit-intent', { schema: 'ui_intent/v0.2', request_id: 'bench-take', op: 'take_control', params: { surface_id: 'surface-a' } });
      await tick();
      fakeWindow.__metaviewerBench.dispatch({ schema: 'ui_intent/v0.2', request_id: 'bench-take', op: 'take_control', params: { surface_id: 'surface-a' } });
      await tick();
      assert.deepEqual(captured.stripEntries().map(entry => entry.code),
        ['INTENT_ACKNOWLEDGED', 'INTENT_ACKNOWLEDGED'], 'hook and UI emit share one dispatch');

      captured.wall.emit('submit-intent', { type: 'fold', capsuleId: 'surface-a' });
      await tick();
      assert.equal(captured.stripEntries().length, 2,
        'renderer-only intents submit nothing, so the strip stays unchanged');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });

  test('live mount never installs the hook', async () => {
    const fakeWindow = { addEventListener() {}, removeEventListener() {} };
    const restore = stubGlobals(fakeWindow);
    let appHandle;
    try {
      const authorityHost = createAuthorityAdapter({ intent: async () => true });
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      const rows = [{ id: 'surface-a', generation: 1, backendLifecycle: 'active' }];
      appHandle = renderer().createApp(App, { authorityHost, runtime: wallRuntime(rows),
        layout: {}, scope: {}, nestedHost: NESTED_LIVE, storage: STORAGE });
      appHandle.mount(root);
      await tick();
      assert.equal(fakeWindow.__metaviewerBench, undefined, 'no fixture key means no hook');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });

  test('nested fixture installs the hook but dispatch stays display-only and empty', async () => {
    const fakeWindow = { addEventListener() {}, removeEventListener() {} };
    const restore = stubGlobals(fakeWindow);
    let appHandle;
    try {
      const calls = [];
      const authorityHost = createAuthorityAdapter({ intent: async (json) => { calls.push(json); return true; } });
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      const nestedFixture = Object.freeze({ ...FIXTURE, key: 'nested' });
      appHandle = renderer().createApp(App, { authorityHost, runtime: wallRuntime([]),
        layout: {}, scope: {}, fixture: nestedFixture, storage: STORAGE });
      appHandle.mount(root);
      assert.ok(fakeWindow.__metaviewerBench, 'hook installs for the nested fixture key');
      fakeWindow.__metaviewerBench.dispatch({ schema: 'ui_intent/v0.2', request_id: 'bench-take', op: 'take_control', params: { surface_id: 'surface-a' } });
      await tick();
      assert.equal(calls.length, 0, 'display-only dispatch submits nothing');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });

  test('negative control: absent hook and unmounted handle fail their predicates', async () => {
    const fakeWindow = { addEventListener() {}, removeEventListener() {} };
    const restore = stubGlobals(fakeWindow);
    let appHandle;
    try {
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      appHandle = renderer().createApp(App, { runtime: wallRuntime([]),
        layout: {}, scope: {}, nestedHost: NESTED_LIVE, storage: STORAGE });
      appHandle.mount(root);
      await tick();
      assert.equal(fakeWindow.__metaviewerBench, undefined);
      assert.throws(() => fakeWindow.__metaviewerBench.dispatch({ op: 'take_control' }), TypeError,
        'calling the absent live hook throws instead of silently succeeding');
      appHandle.unmount(); appHandle = null;
      assert.equal(fakeWindow.__metaviewerBench, undefined, 'nothing lingers after unmount');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });
});

describe('bench openers', () => {
  test('openTerminal and openMultislot drive the real screens deterministically', async () => {
    const fakeWindow = { addEventListener() {}, removeEventListener() {} };
    const restore = stubGlobals(fakeWindow);
    let appHandle;
    try {
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      const rows = [{ id: 'surface-a', generation: 1, backendLifecycle: 'active', visibility: 'unfolded' }];
      appHandle = renderer().createApp(App, { runtime: wallRuntime(rows),
        layout: {}, scope: {}, fixture: FIXTURE, nestedHost: NESTED_LIVE, storage: STORAGE });
      appHandle.mount(root);
      await tick();
      const terminal = () => find(root, node => node.props?.class === 'mv-terminal');
      const multislot = () => find(root, node => node.props?.['aria-label'] === 'Capsule multislot');
      assert.equal(terminal().props.hidden, true, 'terminal starts closed in live-replay');
      assert.equal(multislot(), null, 'multislot starts closed in live-replay');

      fakeWindow.__metaviewerBench.openTerminal();
      await tick();
      assert.equal(terminal().props.hidden, false, 'opener reveals the terminal host');
      fakeWindow.__metaviewerBench.openTerminal();
      await tick();
      assert.equal(terminal().props.hidden, false, 'opening twice never toggles closed');

      fakeWindow.__metaviewerBench.openMultislot();
      await tick();
      assert.ok(multislot(), 'opener shows the multislot screen');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });
});

describe('lost-row admission for lane W', () => {
  const MIXED_ROWS = [
    { id: 'running', title: 'running', backendLifecycle: 'active', visibility: 'unfolded', generation: 1 },
    { id: 'lost', title: 'lost', backendLifecycle: 'lost', visibility: 'unfolded', generation: 1 },
    { id: 'gone', title: 'gone', backendLifecycle: 'destroyed', visibility: 'unfolded', generation: 1 },
  ];

  test('live-replay and live mounts reveal lost tiles; stub fixtures keep the pinned scope', async () => {
    for (const [label, props, expected] of [
      ['live-replay', { fixture: Object.freeze({ key: 'live-replay', screen: 'wall', scheme: 'mv-light', capsules: [], ui: { liveReplay: true } }), nestedHost: NESTED_LIVE }, { allow: true, revealed: ['running', 'lost'] }],
      ['live', { nestedHost: NESTED_LIVE }, { allow: true, revealed: ['running', 'lost'] }],
      ['stub-fixture', { fixture: Object.freeze({ key: 'four', screen: 'wall', scheme: 'mv-light', capsules: [], ui: {} }), nestedHost: NESTED_LIVE }, { allow: false, revealed: ['running'] }],
    ]) {
      const fakeWindow = { addEventListener() {}, removeEventListener() {} };
      const restore = stubGlobals(fakeWindow);
      let appHandle;
      try {
        const captured = {}, App = await loadApp(captured), root = { children: [] };
        appHandle = renderer().createApp(App, { runtime: wallRuntime(MIXED_ROWS),
          layout: {}, scope: {}, storage: STORAGE, ...props });
        appHandle.mount(root);
        await tick();
        assert.equal(captured.wallProps().allowLostSurface, expected.allow, `${label}: wall admission flag`);
        captured.wall.emit('wall-settled');
        await tick();
        assert.deepEqual(captured.revealed, expected.revealed, `${label}: revealed tiles`);
      } finally {
        appHandle?.unmount();
        restore();
      }
    }
  });

  test('negative control: destroyed rows never reveal and stub scope never admits lost', async () => {
    const fakeWindow = { addEventListener() {}, removeEventListener() {} };
    const restore = stubGlobals(fakeWindow);
    let appHandle;
    try {
      const captured = {}, App = await loadApp(captured), root = { children: [] };
      appHandle = renderer().createApp(App, { runtime: wallRuntime(MIXED_ROWS),
        layout: {}, scope: {}, storage: STORAGE,
        fixture: Object.freeze({ key: 'four', screen: 'wall', scheme: 'mv-light', capsules: [], ui: {} }),
        nestedHost: NESTED_LIVE });
      appHandle.mount(root);
      await tick();
      captured.wall.emit('wall-settled');
      await tick();
      assert.deepEqual(captured.revealed, ['running']);
      assert.throws(() => assert.deepEqual(captured.revealed, ['running', 'lost']), assert.AssertionError,
        'stub scope admitting lost fails the pinned contract');
      assert.throws(() => assert.ok(captured.revealed.includes('gone')), assert.AssertionError,
        'revealing destroyed rows fails');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });
});
