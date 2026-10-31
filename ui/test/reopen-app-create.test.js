// REOPEN-FLOW renderer half: the tile close (x) removes only the dock panel, the capsule row and
// its profile stay bound. Open-browser then comes back SURFACE_PROFILE_BOUND from the host; the
// shell must show the live tile again (never a second create) and surface every other typed
// refusal code (BUSY, TIMEOUT) to the operator.
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
import { wallModule, readyWallWithPanel } from './mvui16-harness.mjs';

const APP_URL = new URL('../src/App.vue', import.meta.url);
const ID = 'surface-a';
let serial = 0;

async function loadApp(captured, mutate = null) {
  const stub = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
  const outcome = vue.defineComponent({ props: ['row'],
    setup: props => { captured.outcome = () => props.row; return () => vue.h('p', { id: 'test-outcome' }); } });
  const emptyWall = vue.defineComponent({ setup: () => { captured.emptyMounted += 1; vue.onBeforeUnmount(() => { captured.emptyMounted -= 1; }); return () => vue.h('section', { id: 'empty-wall' }); } });
  const launcher = vue.defineComponent({ setup: (_, ctx) => { captured.launcher = ctx; return () => vue.h('div'); } });
  const wall = vue.defineComponent({ setup: (_, ctx) => {
    captured.wall = ctx;
    ctx.expose({ applyLayoutEcho: () => undefined, revealSurface: (...args) => { captured.reveals.push(args); return captured.revealResult(...args); } });
    return () => vue.h('div');
  } });
  globalThis.__reopendeps = {
    './demo/DemoDialog.vue': stub,
    './identities/IdentitiesDialog.vue': stub,
    './handoff/HandoffNotice.vue': stub,
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': outcome,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': emptyWall,
    './catalog/CatalogLauncher.vue': launcher,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': stub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wall,
    './surfaces/SurfaceCanvas.vue': stub,
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const original = readFileSync(APP_URL, 'utf8');
  const source = mutate ? mutate(original) : original;
  if (mutate) assert.notEqual(source, original, 'negative control must change the source');
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: `reopen-app-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__reopendeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#t-${serial}`)).default;
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

/** @param {{code?:string,error?:Error}} create what the host createSurface answers
 * @param {Array<object>} rows admitted projection rows */
async function mountReopen(create, rows, mutate = null, ui = {}) {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const captured = { reveals: [], emptyMounted: 0, revealResult: () => ({ ok: true }) };
  captured.emptyShown = () => captured.emptyMounted > 0;
  const creates = [];
  const authorityHost = createAuthorityAdapter({
    createSurface: async () => { creates.push(1); return create.code ? { ok: false, code: create.code } : { ok: true }; },
    intent: async () => true,
    propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
  });
  const App = await loadApp(captured, mutate);
  const root = { children: [] };
  const appHandle = renderer().createApp(App, {
    authorityHost,
    runtime: { projectionView: { getSnapshot: () => ({ envelope: null }), getProjection: () => ({ rows }), subscribe: () => () => {} } },
    layout: {}, scope: {}, fixture: { key: 'multislot', ui, capsules: rows.map(row => ({ id: row.id })) },
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
  });
  appHandle.mount(root);
  await tick();
  return {
    captured, creates,
    async openBrowser() { captured.launcher.attrs.onCreate({ kind: 'browser' }); await tick(); await tick(); },
    close() { appHandle.unmount(); globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__reopendeps; },
  };
}

const liveRow = (id = ID) => ({ id, surfaceId: id, generation: 1, visibility: 'unfolded', control: 'agent', backendLifecycle: 'active', profile_id: 'mv-live-1' });

describe('reopen: open-browser after the tile was closed', () => {
  test('a bound profile shows the live tile again instead of a refusal', async () => {
    const f = await mountReopen({ code: 'SURFACE_PROFILE_BOUND' }, [liveRow()]);
    try {
      await f.openBrowser();
      assert.equal(f.creates.length, 1, 'the host owns the create');
      assert.deepEqual(f.captured.reveals, [[ID, 'tab']]);
      assert.equal(f.captured.outcome()?.code, 'INTENT_ACKNOWLEDGED');
      assert.equal(f.captured.outcome()?.tone, 'success');
    } finally { f.close(); }
  });

  test('a bound profile whose tile cannot be shown stays a typed refusal', async () => {
    const f = await mountReopen({ code: 'SURFACE_PROFILE_BOUND' }, [liveRow()]);
    try {
      f.captured.revealResult = () => ({ ok: false });
      await f.openBrowser();
      assert.equal(f.captured.outcome()?.code, 'SURFACE_PROFILE_BOUND');
      assert.equal(f.captured.outcome()?.tone, 'refusal');
    } finally { f.close(); }
  });

  test('a bound profile with no live row stays a typed refusal and reveals nothing', async () => {
    const f = await mountReopen({ code: 'SURFACE_PROFILE_BOUND' }, []);
    try {
      await f.openBrowser();
      assert.deepEqual(f.captured.reveals, []);
      assert.equal(f.captured.outcome()?.code, 'SURFACE_PROFILE_BOUND');
    } finally { f.close(); }
  });

  for (const code of ['SURFACE_CREATE_BUSY', 'SURFACE_CREATE_TIMEOUT', 'SURFACE_PROFILE_QUARANTINED', 'SURFACE_CREATE_FAILED']) {
    test(`${code} is shown with its code and never reveals a tile`, async () => {
      const f = await mountReopen({ code }, [liveRow()]);
      try {
        await f.openBrowser();
        assert.deepEqual(f.captured.reveals, []);
        assert.equal(f.captured.outcome()?.code, code);
        assert.equal(f.captured.outcome()?.tone, 'refusal');
      } finally { f.close(); }
    });
  }

  test('negative control: a shell without the reopen branch shows the refusal and never reveals', async () => {
    const mutant = src => src.replace("&& reopenLiveSurfaces()", '&& false');
    const f = await mountReopen({ code: 'SURFACE_PROFILE_BOUND' }, [liveRow()], mutant);
    try {
      await f.openBrowser();
      assert.deepEqual(f.captured.reveals, []);
      assert.equal(f.captured.outcome()?.code, 'SURFACE_PROFILE_BOUND');
    } finally { f.close(); }
  });

  test('only live rows are shown; a lost row is never revealed, and the mutant without the filter reveals it', async () => {
    const rows = [liveRow(), { ...liveRow('surface-b'), backendLifecycle: 'lost' }];
    const revealed = async mutate => {
      const f = await mountReopen({ code: 'SURFACE_PROFILE_BOUND' }, rows, mutate, { liveReplay: true });
      try { await f.openBrowser(); return f.captured.reveals.map(call => call[0]); } finally { f.close(); }
    };
    assert.deepEqual(await revealed(null), [ID]);
    const mutant = src => src.replace("if (!['active', 'standby', 'ceded'].includes(row.backendLifecycle)) continue;", '');
    assert.deepEqual(await revealed(mutant), [ID, 'surface-b']);
  });
});

describe('reopen: the wall controller after the panel was closed', () => {
  test('revealSurface after close creates a fresh panel for the still-live row, and refuses a destroyed row', async () => {
    const wall = await wallModule();
    const added = [];
    let present = true;
    const panel = { id: `panel-${ID}`, api: { setActive() {}, close() { present = false; } } };
    const api = { getPanel: id => (present && id === panel.id ? panel : undefined), addPanel: options => { added.push(options); present = true; return panel; }, getGroup: () => undefined };
    const windows = { state: () => ({ hidden: false }), show() {}, hide() {}, float() {}, dock() {} };
    const rows = [{ id: ID, surfaceId: ID, backendLifecycle: 'active', title: 'Browser' }];
    const controller = wall.createWallWorkspaceController({ projectionView: { getProjection: () => ({ rows }) } });
    assert.equal(controller.handleReady({ api, windows }).ok, true);
    assert.equal(controller.applyPresentationIntent({ type: 'close', capsuleId: ID }).ok, true);
    assert.equal(present, false, 'x removes the panel only');
    assert.equal(rows[0].backendLifecycle, 'active', 'x never ends the surface');
    const reveal = controller.revealSurface(ID, 'tab');
    assert.equal(reveal.ok, true);
    assert.equal(added.length, 1);
    assert.equal(added[0].id, `panel-${ID}`);
    assert.deepEqual(added[0].params, { capsuleId: ID });
    // Revealing again while the panel exists never stacks a second panel.
    assert.equal(controller.revealSurface(ID, 'tab').ok, true);
    assert.equal(added.length, 1);
    // A destroyed capsule is refused: no stale tile is resurrected.
    rows[0].backendLifecycle = 'destroyed';
    present = false;
    const gone = controller.revealSurface(ID, 'tab');
    assert.equal(gone.ok, false);
    assert.equal(gone.error.code, 'ERR_SURFACE_GONE');
    assert.equal(added.length, 1);
  });

  test('negative control: a controller that ignores lifecycle would resurrect a destroyed tile', async () => {
    const wall = await wallModule(src => src
      .replace("if (row.backendLifecycle === 'lost' || row.backendLifecycle === 'destroyed') {", 'if (false) {')
      .replace("if (row.backendLifecycle !== 'active' && row.backendLifecycle !== 'standby' && row.backendLifecycle !== 'ceded') {", 'if (false) {'));
    const harness = readyWallWithPanel(wall, ID, [{ id: ID, surfaceId: ID, backendLifecycle: 'destroyed' }]);
    assert.equal(harness.controller.revealSurface(ID, 'tab').ok, true, 'mutant reveals a destroyed row');
  });
});

describe('reopen: the empty-wall hint after every tile was closed', () => {
  test('closing the only tile offers Add capsule; reopening hides the hint again', async () => {
    const f = await mountReopen({ code: 'SURFACE_PROFILE_BOUND' }, [liveRow()], null, {});
    try {
      assert.equal(f.captured.emptyShown(), false, 'a live tile hides the hint');
      f.captured.wall.emit('panel-closed', { capsuleId: ID });
      await tick();
      assert.equal(f.captured.emptyShown(), true, 'closed tiles leave the capsule running but the wall shows the way back');
      await f.openBrowser();
      assert.deepEqual(f.captured.reveals, [[ID, 'tab']]);
      assert.equal(f.captured.emptyShown(), false, 'the tile is back');
    } finally { f.close(); }
  });

  test('closing one of two tiles keeps the wall; closing both shows the hint', async () => {
    const f = await mountReopen({ code: 'SURFACE_PROFILE_BOUND' }, [liveRow(), liveRow('surface-b')], null, {});
    try {
      f.captured.wall.emit('panel-closed', { capsuleId: ID });
      await tick();
      assert.equal(f.captured.emptyShown(), false);
      f.captured.wall.emit('panel-closed', { capsuleId: 'surface-b' });
      await tick();
      assert.equal(f.captured.emptyShown(), true);
    } finally { f.close(); }
  });

  test('negative control: a shell that ignores panel-closed never shows the hint', async () => {
    const mutant = src => src.replace('@panel-closed="onPanelClosed" ', '');
    const f = await mountReopen({ code: 'SURFACE_PROFILE_BOUND' }, [liveRow()], mutant, {});
    try {
      f.captured.wall.emit('panel-closed', { capsuleId: ID });
      await tick();
      assert.equal(f.captured.emptyShown(), false);
    } finally { f.close(); }
  });
});

describe('reopen: the wall controller reports a close to the shell', () => {
  test('a close emits panel-closed once; other verbs and refusals emit nothing', async () => {
    const wall = await wallModule();
    const { controller } = readyWallWithPanel(wall, ID);
    const emitted = [];
    const callbacks = controller.createPanelCallbacks((...args) => emitted.push(args));
    assert.equal(callbacks.onPresentationIntent({ type: 'hide', capsuleId: ID }).ok, true);
    assert.equal(callbacks.onPresentationIntent({ type: 'close', capsuleId: 'surface-unknown' }).ok, false);
    assert.deepEqual(emitted, []);
    assert.equal(callbacks.onPresentationIntent({ type: 'close', capsuleId: ID }).ok, true);
    assert.deepEqual(emitted, [['panel-closed', { capsuleId: ID }]]);
  });

  test('negative control: a controller that never emits leaves the shell blind', async () => {
    const wall = await wallModule(src => src.replace("if (result.ok && result.value.type === 'close') emit(", "if (false) emit("));
    const { controller } = readyWallWithPanel(wall, ID);
    const emitted = [];
    controller.createPanelCallbacks((...args) => emitted.push(args)).onPresentationIntent({ type: 'close', capsuleId: ID });
    assert.deepEqual(emitted, []);
  });
});
