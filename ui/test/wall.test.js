// WallWorkspace contract: kit DockWorkspace composition, one panel per
// capsuleId, local presentation intents, opaque emit forwarding.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.dirname(testDir);
const sfcPath = path.join(uiDir, 'src', 'wall', 'WallWorkspace.vue');
const tmpDir = path.join(testDir, '.tmp-wall-mv0w1');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readSfc() {
  return readFileSync(sfcPath, 'utf8');
}

function makeRows() {
  return [
    { id: 'cap-1', surfaceId: 'cap-1', backendLifecycle: 'active', generation: 3, visibility: 'unfolded', control: 'human', title: 'First' },
    { id: 'cap-2', surfaceId: 'cap-2', backendLifecycle: 'standby', generation: 1, visibility: 'folded', control: 'agent' },
    { id: 'cap-gone', surfaceId: 'cap-gone', backendLifecycle: 'lost', generation: 9, visibility: 'folded', control: 'human' },
    { id: 'cap-dead', surfaceId: 'cap-dead', backendLifecycle: 'destroyed', generation: 4, visibility: 'folded', control: 'human' },
    { id: 'cap-split', surfaceId: 'cap-split', backendLifecycle: 'ceded', generation: 2, visibility: 'unfolded', control: 'shared', title: '  ' },
  ];
}

function makeProjectionView(rows) {
  return { getProjection: () => ({ rows }) };
}

function makeFakePanel(id) {
  const calls = [];
  return {
    id,
    params: {},
    calls,
    api: {
      close() { calls.push(['close', id]); },
      setActive() { calls.push(['setActive', id]); },
      location: { type: 'grid' },
    },
  };
}

function makeFakeApi() {
  const calls = [];
  const panels = new Map();
  return {
    calls,
    panels,
    getPanel(id) { calls.push(['getPanel', id]); return panels.get(id); },
    addPanel(options) {
      calls.push(['addPanel', options]);
      const panel = makeFakePanel(options.id);
      panel.params = options.params ?? {};
      panels.set(options.id, panel);
      return panel;
    },
  };
}

function makeFakeWindows(hiddenIds = []) {
  const calls = [];
  const hidden = new Set(hiddenIds);
  return {
    calls,
    state: (id) => ({ hidden: hidden.has(id), floating: false, maximized: false }),
    show(id) { calls.push(['show', id]); hidden.delete(id); },
    hide(id) { calls.push(['hide', id]); hidden.add(id); },
    float(id) { calls.push(['float', id]); },
    dock(id) { calls.push(['dock', id]); },
  };
}

describe('WallWorkspace.vue static contract (pinned compiler)', async () => {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc');

  test('SFC parses with module script, setup script and template; no authored TS', () => {
    const { descriptor, errors } = parse(readSfc(), { filename: 'WallWorkspace.vue' });
    assert.equal(errors.length, 0);
    assert.ok(descriptor.script, 'module script exports the testable controller');
    assert.ok(descriptor.scriptSetup, 'setup script wires the kit');
    assert.ok(descriptor.template, 'template instantiates DockWorkspace once');
    for (const block of [descriptor.script, descriptor.scriptSetup, descriptor.template]) {
      assert.ok(!block.lang || block.lang === 'js', 'JavaScript only, no authored TypeScript');
    }
  });

  test('template compiles with zero errors under the pinned compiler', () => {
    const { descriptor } = parse(readSfc(), { filename: 'WallWorkspace.vue' });
    const compiled = compileTemplate({
      source: descriptor.template.content,
      filename: 'WallWorkspace.vue',
      id: 'wall-workspace-test',
    });
    assert.equal(compiled.errors.length, 0);
  });

  test('setup script compiles with inlined template and zero errors', () => {
    const { descriptor } = parse(readSfc(), { filename: 'WallWorkspace.vue' });
    const compiled = compileScript(descriptor, { id: 'wall-workspace-test', inlineTemplate: true });
    assert.ok(compiled.content.length > 0);
  });

  test('emits declare the six kit events plus submit-intent and activate-surface', () => {
    const source = readSfc();
    const declared = source.slice(source.indexOf('defineEmits('), source.indexOf(']);', source.indexOf('defineEmits(')));
    for (const name of ['ready', 'wall-settled', 'layout-saved', 'quarantine-detected',
      'popout-blocked', 'active-panel-change', 'submit-intent', 'activate-surface']) {
      assert.ok(declared.includes(`'${name}'`), `emits declare ${name}`);
    }
    assert.ok(!declared.includes('presentation-intent'), 'presentation-intent is consumed, never re-emitted');
    assert.ok(source.includes('onPresentationIntent'), 'a local presentation handler is wired');
  });

  test('props declare the S05 WORKSPACE contract with light/regular/null defaults', () => {
    const source = readSfc();
    for (const name of ['scope', 'storage', 'ownerWindowId', 'projectionView', 'intentBuilders',
      'controlRegistry', 'scheduler', 'tileScheduler', 'colorScheme', 'density', 'defaultProfile']) {
      assert.ok(source.includes(`${name}:`), `props declare ${name}`);
    }
    assert.match(source, /colorScheme[\s\S]{0,200}default:\s*'light'/);
    assert.match(source, /density[\s\S]{0,200}default:\s*'regular'/);
    assert.match(source, /defaultProfile[\s\S]{0,120}default:\s*null/);
    assert.ok(source.includes('revealSurface'), 'revealSurface is exposed');
  });

  test('SFC imports only vue, the kit DockWorkspace and the sibling SurfacePanel', () => {
    const source = readSfc();
    const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(specifiers)].sort(), ['./SurfacePanel.vue', 'capsule-ui-kit/DockWorkspace', 'vue']);
  });

  test('forbidden effects are absent: no popout, storage, controller or backend calls', () => {
    // Type mirrors in JSDoc comments name kit members; executable code must not.
    const codeOnly = readSfc().replace(/\/\*\*?[\s\S]*?\*\//g, '');
    for (const token of ['window.open', 'localStorage', 'createLayoutProfileController',
      'removePanel', 'surface_request', 'surfaceRequest', 'fromJSON', 'readRaw', 'writeAtomic',
      'dockview-core', 'dockview-vue', 'node:', "require('", 'TODO', 'FIXME']) {
      assert.ok(!codeOnly.includes(token), `SFC code must not contain ${token}`);
    }
  });
});

async function loadWallModule() {
  mkdirSync(tmpDir, { recursive: true });
  const { parse } = await import('@vue/compiler-sfc');
  const { descriptor, errors } = parse(readSfc(), { filename: 'WallWorkspace.vue' });
  assert.equal(errors.length, 0);
  const modulePath = path.join(tmpDir, 'wallWorkspaceModule.mjs');
  writeFileSync(modulePath, descriptor.script.content);
  return import(pathToFileURL(modulePath).href);
}

describe('controller admission (pure module, no DOM)', async () => {
  const wall = await loadWallModule();

  function readyController(rows = makeRows()) {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(rows) });
    const api = makeFakeApi();
    const windows = makeFakeWindows();
    const accepted = controller.handleReady({ api, windows, revision: 1 });
    assert.equal(accepted.ok, true);
    return { controller, api, windows };
  }

  test('reveal before ready refuses and never touches the api (cold restore barrier)', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    const result = controller.revealSurface('cap-1', 'tab');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_NOT_READY');
    assert.equal(api.calls.length, 0);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.error), true);
  });

  test('invalid ready payload refuses without storing a partial api', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    assert.equal(controller.handleReady({ api: {}, windows: makeFakeWindows() }).ok, false);
    assert.equal(controller.handleReady({ api: makeFakeApi(), windows: {} }).ok, false);
    assert.equal(controller.handleReady(null).ok, false);
    assert.equal(controller.revealSurface('cap-1', 'tab').error.code, 'ERR_NOT_READY');
  });

  test('invalid capsule ids refuse before any admission work', () => {
    const { controller, api } = readyController();
    for (const bad of ['', '   ', 'cap 1', ' cap-1', 'cap-1\n', 7, null, undefined, {}, ['cap-1']]) {
      const result = controller.revealSurface(bad, 'tab');
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.equal(result.error.code, 'ERR_INVALID_CAPSULE_ID', JSON.stringify(bad));
    }
    assert.equal(api.calls.length, 0);
  });

  test('unknown placement refuses without side effects', () => {
    const { controller, api } = readyController();
    for (const bad of ['popout', 'grid', '', null, undefined, 0]) {
      const result = controller.revealSurface('cap-1', bad);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_INVALID_PLACEMENT');
    }
    assert.equal(api.calls.length, 0);
  });

  test('missing projection or rows refuses as unavailable', () => {
    for (const view of [{ getProjection: () => null }, { getProjection: () => ({}) },
      { getProjection: () => ({ rows: 'cap-1' }) }, null, undefined, {}]) {
      const controller = wall.createWallWorkspaceController({ projectionView: view });
      controller.handleReady({ api: makeFakeApi(), windows: makeFakeWindows() });
      const result = controller.revealSurface('cap-1', 'tab');
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'ERR_PROJECTION_UNAVAILABLE');
    }
  });

  test('unknown id, id/surfaceId mismatch and bad lifecycles refuse; no panel is added', () => {
    const rows = [...makeRows(),
      { id: 'cap-x', surfaceId: 'cap-y', backendLifecycle: 'active', generation: 1, visibility: 'unfolded', control: 'human' },
      { id: 'cap-odd', surfaceId: 'cap-odd', backendLifecycle: 'melted', generation: 1, visibility: 'unfolded', control: 'human' },
    ];
    const { controller, api } = readyController(rows);
    assert.equal(controller.revealSurface('cap-missing', 'tab').error.code, 'ERR_UNKNOWN_SURFACE');
    assert.equal(controller.revealSurface('cap-y', 'tab').error.code, 'ERR_ROW_IDENTITY_MISMATCH');
    assert.equal(controller.revealSurface('cap-gone', 'tab').error.code, 'ERR_SURFACE_GONE');
    assert.equal(controller.revealSurface('cap-dead', 'floating').error.code, 'ERR_SURFACE_GONE');
    assert.equal(controller.revealSurface('cap-odd', 'tab').error.code, 'ERR_UNKNOWN_LIFECYCLE');
    assert.deepEqual(api.calls, []);
  });
});

describe('controller reveal (real option contract)', async () => {
  const wall = await loadWallModule();

  test('new tab reveal adds one panel with the exact pinned options', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    controller.handleReady({ api, windows: makeFakeWindows() });
    const result = controller.revealSurface('cap-1', 'tab');
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { panelId: 'panel-cap-1' });
    assert.equal(Object.isFrozen(result.value), true);
    const added = api.calls.filter(([name]) => name === 'addPanel');
    assert.equal(added.length, 1);
    assert.deepEqual(added[0][1], {
      id: 'panel-cap-1',
      component: 'CapsulePanel',
      title: 'First',
      params: { capsuleId: 'cap-1' },
      renderer: 'always',
      minimumWidth: 240,
      minimumHeight: 200,
    });
    assert.ok(!('position' in added[0][1]) && !('floating' in added[0][1]));
    const panel = api.panels.get('panel-cap-1');
    assert.deepEqual(panel.calls, [['setActive', 'panel-cap-1']]);
  });

  test('blank title falls back to the capsule id; split adds a right position', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    controller.handleReady({ api, windows: makeFakeWindows() });
    assert.equal(controller.revealSurface('cap-split', 'split').ok, true);
    const added = api.calls.find(([name]) => name === 'addPanel')[1];
    assert.equal(added.title, 'cap-split');
    assert.deepEqual(added.position, { direction: 'right' });
    assert.ok(!('floating' in added));
  });

  test('same id reuses the panel: addPanel runs once across tab, split and floating', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    const windows = makeFakeWindows();
    controller.handleReady({ api, windows });
    assert.deepEqual(controller.revealSurface('cap-1', 'tab').value, { panelId: 'panel-cap-1' });
    assert.deepEqual(controller.revealSurface('cap-1', 'split').value, { panelId: 'panel-cap-1' });
    assert.deepEqual(controller.revealSurface('cap-1', 'floating').value, { panelId: 'panel-cap-1' });
    assert.equal(api.calls.filter(([name]) => name === 'addPanel').length, 1);
    assert.deepEqual(windows.calls, [['float', 'panel-cap-1']]);
  });

  test('floating reveal adds without floating bounds, then floats through the kit', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    const windows = makeFakeWindows();
    controller.handleReady({ api, windows });
    assert.equal(controller.revealSurface('cap-2', 'floating').ok, true);
    const added = api.calls.find(([name]) => name === 'addPanel')[1];
    assert.ok(!('floating' in added) && !('position' in added));
    assert.deepEqual(windows.calls, [['float', 'panel-cap-2']]);
  });

  test('hidden panel is shown instead of duplicated or reactivated', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    const windows = makeFakeWindows(['panel-cap-1']);
    controller.handleReady({ api, windows });
    api.addPanel({ id: 'panel-cap-1', component: 'CapsulePanel', params: { capsuleId: 'cap-1' } });
    api.panels.get('panel-cap-1').calls.length = 0;
    api.calls.length = 0;
    assert.equal(controller.revealSurface('cap-1', 'tab').ok, true);
    assert.deepEqual(windows.calls, [['show', 'panel-cap-1']]);
    assert.deepEqual(api.panels.get('panel-cap-1').calls, []);
    assert.equal(api.calls.filter(([name]) => name === 'addPanel').length, 0);
  });

  test('api failure maps to a coded refusal instead of throwing', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    api.addPanel = () => { throw new Error('boom'); };
    controller.handleReady({ api, windows: makeFakeWindows() });
    const result = controller.revealSurface('cap-1', 'tab');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_REVEAL_FAILED');
  });
});

describe('controller presentation intents (local only, never destructive)', async () => {
  const wall = await loadWallModule();

  function readyWithPanel() {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    const windows = makeFakeWindows();
    controller.handleReady({ api, windows });
    controller.revealSurface('cap-1', 'tab');
    api.calls.length = 0;
    windows.calls.length = 0;
    api.panels.get('panel-cap-1').calls.length = 0;
    return { controller, api, windows };
  }

  test('each verb reaches exactly one local effect', () => {
    const { controller, api, windows } = readyWithPanel();
    const panel = api.panels.get('panel-cap-1');
    assert.deepEqual(controller.applyPresentationIntent({ type: 'hide', capsuleId: 'cap-1' }).value,
      { panelId: 'panel-cap-1', type: 'hide' });
    assert.deepEqual(controller.applyPresentationIntent({ type: 'show', capsuleId: 'cap-1' }).value,
      { panelId: 'panel-cap-1', type: 'show' });
    assert.deepEqual(controller.applyPresentationIntent({ type: 'float', capsuleId: 'cap-1' }).value,
      { panelId: 'panel-cap-1', type: 'float' });
    assert.deepEqual(controller.applyPresentationIntent({ type: 'dock-back', capsuleId: 'cap-1' }).value,
      { panelId: 'panel-cap-1', type: 'dock-back' });
    assert.deepEqual(controller.applyPresentationIntent({ type: 'close', capsuleId: 'cap-1' }).value,
      { panelId: 'panel-cap-1', type: 'close' });
    assert.deepEqual(windows.calls, [['hide', 'panel-cap-1'], ['show', 'panel-cap-1'],
      ['float', 'panel-cap-1'], ['dock', 'panel-cap-1']]);
    assert.deepEqual(panel.calls, [['close', 'panel-cap-1']]);
    assert.equal(api.calls.filter(([name]) => name === 'addPanel').length, 0);
  });

  test('unknown verb, bad shape and unknown panel refuse with zero effects', () => {
    const { controller, api, windows } = readyWithPanel();
    for (const bad of [{ type: 'destroy', capsuleId: 'cap-1' }, { type: 'popout', capsuleId: 'cap-1' },
      { type: 'hide', capsuleId: 'cap-missing' }, { type: 'close', capsuleId: '' },
      { type: 'hide' }, { capsuleId: 'cap-1' }, null, 'hide', []]) {
      const result = controller.applyPresentationIntent(bad);
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.ok(['ERR_UNKNOWN_PRESENTATION', 'ERR_UNKNOWN_PANEL', 'ERR_INVALID_CAPSULE_ID']
        .includes(result.error.code), result.error.code);
    }
    assert.deepEqual(windows.calls, []);
    assert.deepEqual(api.panels.get('panel-cap-1').calls, []);
    assert.equal(api.calls.filter(([name]) => name === 'addPanel').length, 0);
  });

  test('presentation intent before ready refuses without effects', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const result = controller.applyPresentationIntent({ type: 'hide', capsuleId: 'cap-1' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_NOT_READY');
  });
});

describe('controller callbacks, disposal and storage silence', async () => {
  const wall = await loadWallModule();

  test('submit and activate forward opaquely; presentation is consumed locally', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    const windows = makeFakeWindows();
    controller.handleReady({ api, windows });
    controller.revealSurface('cap-1', 'tab');
    const emitted = [];
    const callbacks = controller.createPanelCallbacks((name, payload) => emitted.push([name, payload]));
    const body = Object.freeze({ op: 'fold' });
    const activation = Object.freeze({ capsuleId: 'cap-1' });
    callbacks.onSubmitIntent(body);
    callbacks.onActivateSurface(activation);
    const consumed = callbacks.onPresentationIntent({ type: 'hide', capsuleId: 'cap-1' });
    assert.equal(consumed.ok, true);
    assert.deepEqual(emitted, [['submit-intent', body], ['activate-surface', activation]]);
    assert.ok(emitted[0][1] === body && emitted[1][1] === activation, 'payloads pass by identity');
    assert.deepEqual(windows.calls, [['hide', 'panel-cap-1']]);
  });

  test('dispose clears readiness: late reveal refuses and the api stays quiet', () => {
    const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(makeRows()) });
    const api = makeFakeApi();
    controller.handleReady({ api, windows: makeFakeWindows() });
    controller.dispose();
    const result = controller.revealSurface('cap-1', 'tab');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_NOT_READY');
    assert.equal(api.calls.length, 0);
  });

  test('router capsule id extraction follows the dockview panel props shape', () => {
    assert.equal(wall.resolveRouterCapsuleId({ params: { capsuleId: 'cap-1' }, api: {} }), 'cap-1');
    assert.equal(wall.resolveRouterCapsuleId({ params: {}, api: {} }), null);
    assert.equal(wall.resolveRouterCapsuleId({ params: { capsuleId: '  ' } }), null);
    assert.equal(wall.resolveRouterCapsuleId({ params: { capsuleId: 7 } }), null);
    assert.equal(wall.resolveRouterCapsuleId(null), null);
    assert.equal(wall.resolveRouterCapsuleId('cap-1'), null);
  });

  test('module source never references storage, layout decode or backend verbs', () => {
    const source = readSfc();
    const moduleSource = source.slice(0, source.indexOf('<script setup>'))
      .replace(/\/\*\*?[\s\S]*?\*\//g, '');
    assert.ok(moduleSource.length > 0);
    for (const token of ['readRaw', 'writeAtomic', 'createLayoutProfileController',
      'decodeAndMigrate', 'fromJSON', 'surface_request', 'removePanel',
      'localStorage', 'window.open', 'destroy(', "'destroy'", '"destroy"']) {
      assert.ok(!moduleSource.includes(token), `module code must not contain ${token}`);
    }
  });
});

describe('pinned declarations and real kit behaviour', async () => {
  test('dockview-core is pinned to 8.4.1 and declares the consumed option surface', () => {
    const pkg = JSON.parse(readFileSync(
      path.join(uiDir, 'node_modules', 'dockview-core', 'package.json'), 'utf8'));
    assert.equal(pkg.version, '8.4.1');
    const dts = (file) => readFileSync(
      path.join(uiDir, 'node_modules', 'dockview-core', 'dist', 'cjs', file), 'utf8');
    const options = dts(path.join('dockview', 'options.d.ts'));
    for (const token of ['renderer?: DockviewPanelRenderer', 'inactive?: boolean',
      'initialWidth?: number', 'initialHeight?: number', 'floating: Partial<FloatingGroupOptions>',
      'referencePanel: string | IDockviewPanel', "direction: Omit<Direction, 'within'>"]) {
      assert.ok(options.includes(token), `options.d.ts declares ${token}`);
    }
    const componentApi = dts(path.join('api', 'component.api.d.ts'));
    assert.ok(componentApi.includes('getPanel(id: string): IDockviewPanel | undefined'));
    assert.ok(componentApi.includes('addPanel'));
    assert.ok(componentApi.includes('AddPanelOptions'));
    const constraints = dts(path.join('gridview', 'gridviewPanel.d.ts'));
    assert.ok(constraints.includes('interface Constraints'));
    assert.ok(constraints.includes('minimumWidth?: number'));
    assert.ok(constraints.includes('minimumHeight?: number'));
  });

  test('panel params stay inside the real kit allowlist; pins match the gate', async () => {
    const layout = await import(pathToFileURL(path.join(
      uiDir, '.kit', 'capsule-ui-kit', 'src', 'workspace', 'layoutProfile.js')).href);
    assert.equal(layout.MISSING_PANEL_TYPE, 'MissingPanel');
    assert.ok(layout.DEFAULT_ALLOWED_PANEL_PARAM_KEYS.has('capsuleId'));
    assert.ok(!layout.FORBIDDEN_PARAM_KEYS.has('capsuleId'));
    assert.equal(layout.PINNED_VERSIONS.dockviewVersion, '8.4.1');
    assert.equal(layout.CURRENT_LAYOUT_SCHEMA_VERSION, 2);
  });

  test('real kit decode quarantines corrupt and future profiles and never mutates input', async () => {
    const layout = await import(pathToFileURL(path.join(
      uiDir, '.kit', 'capsule-ui-kit', 'src', 'workspace', 'layoutProfile.js')).href);
    const scope = { product: 'metaviewer', profileId: 'default', workspaceId: 'main-wall' };
    const corrupt = layout.decodeAndMigrateLayoutProfile(
      '{"format":"capsule-ui-kit.layout-profile",', { expectedScope: scope });
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.readOnlyRequired, true);
    assert.equal(corrupt.code, 'CORRUPT_JSON');
    const future = layout.decodeAndMigrateLayoutProfile(JSON.stringify(
      { format: 'capsule-ui-kit.layout-profile', schemaVersion: 999 }), { expectedScope: scope });
    assert.equal(future.ok, false);
    assert.equal(future.readOnlyRequired, true);
    assert.equal(future.code, 'FUTURE_SCHEMA');
    const fresh = layout.createDefaultLayoutProfile(scope);
    assert.equal(layout.decodeAndMigrateLayoutProfile(fresh, { expectedScope: scope }).ok, true);
    const input = { format: 'other', schemaVersion: 2 };
    layout.decodeAndMigrateLayoutProfile(input, { expectedScope: scope });
    assert.deepEqual(input, { format: 'other', schemaVersion: 2 });
  });
});

describe('mounted wiring (real vue runtime, stubbed kit and sibling panel)', async () => {
  const vue = await import('vue');
  const { parse, compileScript } = await import('@vue/compiler-sfc');

  function createTestRenderer() {
    const nodeOps = {
      insert(child, parent, anchor = null) {
        child.parentNode = parent;
        const children = parent.children ?? (parent.children = []);
        if (anchor === null) children.push(child);
        else children.splice(children.indexOf(anchor), 0, child);
      },
      remove(child) {
        const parent = child.parentNode;
        if (parent?.children) parent.children.splice(parent.children.indexOf(child), 1);
        child.parentNode = null;
      },
      createElement(tag) {
        return { nodeType: 'element', tag, props: {}, children: [], parentNode: null };
      },
      createText(text) {
        return { nodeType: 'text', text: String(text), children: [], parentNode: null };
      },
      createComment(text) {
        return { nodeType: 'comment', text: String(text), children: [], parentNode: null };
      },
      setText(node, text) { node.text = String(text); },
      setElementText(node, text) {
        node.children = [{ nodeType: 'text', text: String(text), children: [], parentNode: node }];
      },
      parentNode(node) { return node.parentNode; },
      nextSibling(node) {
        const siblings = node.parentNode?.children ?? [];
        return siblings[siblings.indexOf(node) + 1] ?? null;
      },
      querySelector() { return null; },
      setScopeId() {},
      cloneNode(node) {
        return {
          nodeType: node.nodeType, tag: node.tag, text: node.text,
          props: { ...(node.props ?? {}) }, children: [], parentNode: null,
        };
      },
      insertStaticContent(content, parent, anchor = null) {
        const node = { nodeType: 'static', text: String(content), children: [], parentNode: null };
        nodeOps.insert(node, parent, anchor);
        return [node, node];
      },
    };
    return vue.createRenderer({
      ...nodeOps,
      patchProp(el, key, _prev, next) {
        if (next === null || next === undefined) delete el.props[key];
        else el.props[key] = next;
      },
    });
  }

  function serialize(node) {
    if (node.nodeType === 'text' || node.nodeType === 'static') return node.text;
    if (node.nodeType === 'comment') return '';
    const attrs = Object.entries(node.props ?? {})
      .filter(([key]) => !key.startsWith('on'))
      .map(([key, value]) => ` ${key}="${String(value)}"`).join('');
    const kids = (node.children ?? []).map(serialize).join('');
    return `<${node.tag}${attrs}>${kids}</${node.tag}>`;
  }

  const STUB_DOCKWORKSPACE = `
import { defineComponent, h } from 'vue';
export const capturedProps = [];
export const fakeCalls = [];
export const routerParams = { params: { capsuleId: 'cap-1' }, api: { id: 'panel-cap-1', title: 'First', close() {} } };
export const missingParams = { params: { capsuleId: 'cap-9', originalPanelType: 'FleetPanel', unavailableReason: 'retired in test' }, api: { id: 'panel-cap-9' } };
export const panels = new Map();
function makeFakePanel(id) {
  return { id, params: {}, api: {
    close() { fakeCalls.push(['close', id]); },
    setActive() { fakeCalls.push(['setActive', id]); },
    location: { type: 'grid' } } };
}
export function seedPanel(id) {
  const panel = makeFakePanel(id);
  panels.set(id, panel);
  return panel;
}
export const canaries = {
  ready: { api: null, windows: null, revision: 7 },
  settled: { stub: 'wall-settled' },
  saved: { stub: 'layout-saved' },
  quarantine: { stub: 'quarantine-detected' },
  popout: { stub: 'popout-blocked' },
  active: { stub: 'active-panel-change' },
};
canaries.ready.api = {
  getPanel(id) { fakeCalls.push(['getPanel', id]); return panels.get(id); },
  addPanel(options) { fakeCalls.push(['addPanel', options]); const panel = makeFakePanel(options.id); panels.set(options.id, panel); return panel; },
};
canaries.ready.windows = {
  state: (id) => ({ hidden: false, floating: false, maximized: false }),
  show(id) { fakeCalls.push(['show', id]); },
  hide(id) { fakeCalls.push(['hide', id]); },
  float(id) { fakeCalls.push(['float', id]); },
  dock(id) { fakeCalls.push(['dock', id]); },
};
export function resetStub() {
  capturedProps.length = 0;
  fakeCalls.length = 0;
  panels.clear();
}
export default defineComponent({
  name: 'StubDockWorkspace',
  props: ['scope', 'storage', 'defaultProfile', 'ownerWindowId', 'panelComponents', 'tabComponents', 'defaultTabComponent', 'colorScheme', 'density', 'workspaceTitle', 'initialViewportWidth', 'initialViewportHeight'],
  emits: ['ready', 'wall-settled', 'layout-saved', 'quarantine-detected', 'popout-blocked', 'active-panel-change'],
  setup(props, { emit }) {
    capturedProps.push(props);
    emit('ready', canaries.ready);
    emit('wall-settled', canaries.settled);
    emit('layout-saved', canaries.saved);
    emit('quarantine-detected', canaries.quarantine);
    emit('popout-blocked', canaries.popout);
    emit('active-panel-change', canaries.active);
    return () => h('section', {
      'data-stub': 'dock-workspace',
      'data-scope-product': props.scope?.product,
      'data-viewport': props.initialViewportWidth + 'x' + props.initialViewportHeight,
      'data-color-scheme': props.colorScheme,
      'data-density': props.density,
      'data-workspace-title': props.workspaceTitle,
      'data-owner-window': props.ownerWindowId,
    }, [
      props.panelComponents?.CapsulePanel ? h(props.panelComponents.CapsulePanel, { params: routerParams }) : null,
      props.panelComponents?.MissingPanel ? h(props.panelComponents.MissingPanel, { params: missingParams }) : null,
    ]);
  },
});
`;

  const STUB_SURFACEPANEL = `
import { defineComponent, h } from 'vue';
export const capturedPanelProps = [];
export const panelCanaries = {
  submit: { stub: 'intent-body' },
  activate: { capsuleId: 'cap-1' },
  presentation: { type: 'hide', capsuleId: 'cap-1' },
};
export function resetPanelStub() {
  capturedPanelProps.length = 0;
}
export default defineComponent({
  name: 'StubSurfacePanel',
  props: ['capsuleId', 'projectionView', 'intentBuilders', 'controlRegistry', 'scheduler', 'tileScheduler', 'presentationInstance'],
  emits: ['submit-intent', 'presentation-intent', 'activate-surface'],
  setup(props, { emit, slots }) {
    capturedPanelProps.push({ ...props });
    emit('submit-intent', panelCanaries.submit);
    emit('presentation-intent', panelCanaries.presentation);
    emit('activate-surface', panelCanaries.activate);
    return () => h('div', { 'data-stub': 'surface-panel', 'data-capsule-id': props.capsuleId }, [
      slots.surface?.({ capsuleId: props.capsuleId, surface: { id: props.capsuleId }, drawable: true }),
    ]);
  },
});
`;

  async function loadCompiledWall() {
    mkdirSync(tmpDir, { recursive: true });
    const { descriptor, errors } = parse(readSfc(), { filename: 'WallWorkspace.vue' });
    assert.equal(errors.length, 0);
    const compiled = compileScript(descriptor, { id: 'wall-workspace-test', inlineTemplate: true });
    let code = compiled.content;
    code = code.replace(/(['"])capsule-ui-kit\/DockWorkspace\1/g, "'./stubDockWorkspace.mjs'");
    code = code.replace(/(['"])\.\/SurfacePanel\.vue\1/g, "'./stubSurfacePanel.mjs'");
    assert.ok(!code.includes('capsule-ui-kit/DockWorkspace'), 'kit import is stubbed');
    assert.ok(!code.includes('./SurfacePanel.vue'), 'sibling import is stubbed');
    writeFileSync(path.join(tmpDir, 'stubDockWorkspace.mjs'), STUB_DOCKWORKSPACE);
    writeFileSync(path.join(tmpDir, 'stubSurfacePanel.mjs'), STUB_SURFACEPANEL);
    const compiledPath = path.join(tmpDir, 'wallWorkspace.compiled.mjs');
    writeFileSync(compiledPath, code);
    const [wall, dockStub, panelStub] = await Promise.all([
      import(pathToFileURL(compiledPath).href),
      import(pathToFileURL(path.join(tmpDir, 'stubDockWorkspace.mjs')).href),
      import(pathToFileURL(path.join(tmpDir, 'stubSurfacePanel.mjs')).href),
    ]);
    return { WallWorkspace: wall.default, dockStub, panelStub };
  }

  const shared = {
    scope: Object.freeze({ product: 'metaviewer', profileId: 'default', workspaceId: 'main-wall' }),
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
    ownerWindowId: 'window-main',
    intentBuilders: Object.freeze({}),
    controlRegistry: Object.freeze({}),
    scheduler: Object.freeze({}),
    tileScheduler: Object.freeze({}),
    defaultProfile: Object.freeze({ stub: 'layout-profile' }),
  };

  function mountWall(loaded, { rows, slotSpy, extraProps } = {}) {
    const received = [];
    const wallRef = vue.ref(null);
    const projectionView = makeProjectionView(rows ?? makeRows());
    const Root = vue.defineComponent({
      setup() {
        return () => vue.h(loaded.WallWorkspace, {
          scope: shared.scope,
          storage: shared.storage,
          ownerWindowId: shared.ownerWindowId,
          projectionView,
          intentBuilders: shared.intentBuilders,
          controlRegistry: shared.controlRegistry,
          scheduler: shared.scheduler,
          tileScheduler: shared.tileScheduler,
          defaultProfile: shared.defaultProfile,
          colorScheme: 'light',
          density: 'regular',
          ...(extraProps ?? {}),
          ref: wallRef,
          onReady: (payload) => received.push(['ready', payload]),
          onWallSettled: (payload) => received.push(['wall-settled', payload]),
          onLayoutSaved: (payload) => received.push(['layout-saved', payload]),
          onQuarantineDetected: (payload) => received.push(['quarantine-detected', payload]),
          onPopoutBlocked: (payload) => received.push(['popout-blocked', payload]),
          onActivePanelChange: (payload) => received.push(['active-panel-change', payload]),
          onSubmitIntent: (payload) => received.push(['submit-intent', payload]),
          onActivateSurface: (payload) => received.push(['activate-surface', payload]),
        }, {
          surface: (slotProps) => {
            slotSpy?.(slotProps);
            return vue.h('i', {
              'data-surface-slot': slotProps.capsuleId,
              'data-drawable': String(slotProps.drawable),
            });
          },
        });
      },
    });
    const renderer = createTestRenderer();
    const app = renderer.createApp(Root);
    const container = { nodeType: 'element', tag: 'root', props: {}, children: [], parentNode: null };
    app.mount(container);
    return { app, container, received, wallRef, html: serialize(container) };
  }

  test('kit receives scope, storage identity, viewport, scheme, density and registry', async () => {
    const loaded = await loadCompiledWall();
    loaded.dockStub.resetStub();
    loaded.panelStub.resetPanelStub();
    const { app, html } = mountWall(loaded);
    try {
      assert.equal(loaded.dockStub.capturedProps.length, 1);
      const kitProps = loaded.dockStub.capturedProps[0];
      assert.ok(kitProps.scope === shared.scope);
      assert.ok(kitProps.storage === shared.storage, 'storage passes by identity, never wrapped');
      assert.ok(kitProps.defaultProfile === shared.defaultProfile);
      assert.equal(kitProps.ownerWindowId, 'window-main');
      assert.equal(kitProps.colorScheme, 'light');
      assert.equal(kitProps.density, 'regular');
      assert.equal(kitProps.workspaceTitle, 'MetaViewer');
      assert.equal(kitProps.initialViewportWidth, 1280);
      assert.equal(kitProps.initialViewportHeight, 720);
      assert.ok(kitProps.panelComponents?.CapsulePanel, 'CapsulePanel router is registered');
      assert.deepEqual(Object.keys(kitProps.panelComponents), ['CapsulePanel'], 'only product panel types are registered');
      assert.ok(kitProps.tabComponents?.SurfaceTab, 'product tab is registered');
      assert.ok(html.includes('data-scope-product="metaviewer"'));
      assert.ok(html.includes('data-viewport="1280x720"'));
      assert.ok(html.includes('data-color-scheme="light"'));
      assert.ok(html.includes('data-density="regular"'));
      assert.ok(html.includes('data-workspace-title="MetaViewer"'));
    } finally {
      app.unmount();
    }
  });

  test('scheme and density pass through instead of being hardcoded', async () => {
    const loaded = await loadCompiledWall();
    loaded.dockStub.resetStub();
    loaded.panelStub.resetPanelStub();
    const { app, html } = mountWall(loaded, { extraProps: { colorScheme: 'dark', density: 'compact' } });
    try {
      assert.ok(html.includes('data-color-scheme="dark"'));
      assert.ok(html.includes('data-density="compact"'));
    } finally {
      app.unmount();
    }
  });

  test('router passes the seven required props to the panel and forwards the surface slot', async () => {
    const loaded = await loadCompiledWall();
    loaded.dockStub.resetStub();
    loaded.panelStub.resetPanelStub();
    const seen = [];
    const { app, html } = mountWall(loaded, { slotSpy: (slotProps) => seen.push(slotProps) });
    try {
      assert.equal(loaded.panelStub.capturedPanelProps.length, 1);
      const panelProps = loaded.panelStub.capturedPanelProps[0];
      assert.equal(panelProps.capsuleId, 'cap-1');
      assert.equal(panelProps.presentationInstance, 'panel-cap-1');
      assert.ok(panelProps.projectionView?.getProjection, 'projection view passes through');
      assert.ok(panelProps.intentBuilders === shared.intentBuilders);
      assert.ok(panelProps.controlRegistry === shared.controlRegistry);
      assert.ok(panelProps.scheduler === shared.scheduler);
      assert.ok(panelProps.tileScheduler === shared.tileScheduler);
      assert.ok(html.includes('data-capsule-id="cap-1"'));
      assert.ok(html.includes('data-surface-slot="cap-1"'), 'named surface slot reaches the panel');
      assert.ok(html.includes('data-drawable="true"'));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].capsuleId, 'cap-1');
    } finally {
      app.unmount();
    }
  });

  test('missing capsule id renders an alert and never mounts the panel', async () => {
    const loaded = await loadCompiledWall();
    loaded.dockStub.resetStub();
    loaded.panelStub.resetPanelStub();
    loaded.dockStub.routerParams.params = {};
    try {
      const { app, html } = mountWall(loaded);
      try {
        assert.equal(loaded.panelStub.capturedPanelProps.length, 0);
        assert.ok(html.includes('Missing capsule id'));
        assert.ok(html.includes('role="alert"'));
      } finally {
        app.unmount();
      }
    } finally {
      loaded.dockStub.routerParams.params = { capsuleId: 'cap-1' };
    }
  });

  test('retired panel type cannot enter the product component registry', async () => {
    const loaded = await loadCompiledWall();
    loaded.dockStub.resetStub();
    loaded.panelStub.resetPanelStub();
    const { app, html } = mountWall(loaded);
    try {
      assert.ok(!html.includes('panel-cap-9'), 'foreign panel is never rendered');
      assert.ok(!html.includes('retired in test'), 'migration replaces foreign layouts before mount');
      assert.equal(loaded.dockStub.capturedProps[0].panelComponents.MissingPanel, undefined);
    } finally {
      app.unmount();
    }
  });

  test('all eight emits forward by identity; presentation is consumed, never re-emitted', async () => {
    const loaded = await loadCompiledWall();
    loaded.dockStub.resetStub();
    loaded.panelStub.resetPanelStub();
    loaded.dockStub.seedPanel('panel-cap-1');
    const { app, received } = mountWall(loaded);
    try {
      const byName = new Map(received.map(([name, payload]) => [name, payload]));
      for (const [name, canary] of [
        ['ready', loaded.dockStub.canaries.ready],
        ['wall-settled', loaded.dockStub.canaries.settled],
        ['layout-saved', loaded.dockStub.canaries.saved],
        ['quarantine-detected', loaded.dockStub.canaries.quarantine],
        ['popout-blocked', loaded.dockStub.canaries.popout],
        ['active-panel-change', loaded.dockStub.canaries.active],
        ['submit-intent', loaded.panelStub.panelCanaries.submit],
        ['activate-surface', loaded.panelStub.panelCanaries.activate],
      ]) {
        assert.ok(byName.has(name), `forwards ${name}`);
        assert.ok(byName.get(name) === canary, `${name} payload passes by identity`);
      }
      assert.ok(!byName.has('presentation-intent'), 'presentation intent stays local');
      assert.ok(loaded.dockStub.fakeCalls.some(([name, id]) => name === 'hide' && id === 'panel-cap-1'),
        'presentation hide is applied to the seeded panel');
    } finally {
      app.unmount();
    }
  });

  test('exposed revealSurface drives the real wiring; unmount disposes it', async () => {
    const loaded = await loadCompiledWall();
    loaded.dockStub.resetStub();
    loaded.panelStub.resetPanelStub();
    const { app, wallRef } = mountWall(loaded);
    const exposed = wallRef.value;
    try {
      assert.equal(typeof exposed?.revealSurface, 'function');
      const result = exposed.revealSurface('cap-2', 'split');
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, { panelId: 'panel-cap-2' });
      const added = loaded.dockStub.fakeCalls.find(([name]) => name === 'addPanel')[1];
      assert.equal(added.id, 'panel-cap-2');
      assert.equal(added.renderer, 'always');
      assert.equal(added.minimumWidth, 240);
      assert.equal(added.minimumHeight, 200);
      assert.deepEqual(added.params, { capsuleId: 'cap-2' });
      assert.deepEqual(added.position, { direction: 'right' });
      assert.deepEqual(exposed.revealSurface('cap-2', 'tab').value, { panelId: 'panel-cap-2' });
      assert.equal(loaded.dockStub.fakeCalls.filter(([name]) => name === 'addPanel').length, 1);
      assert.equal(exposed.revealSurface('cap-gone', 'tab').error.code, 'ERR_SURFACE_GONE');
    } finally {
      app.unmount();
    }
    assert.equal(exposed.revealSurface('cap-1', 'tab').error.code, 'ERR_NOT_READY');
  });
});


describe('diagnostic lost tile admission', async () => {
  const wall = await loadWallModule();
  test('only explicit diagnostic mode presents lost surfaces; destroyed and identity mismatches remain refused', () => {
    for (const allowLostSurface of [undefined, false, true]) {
      const rows = [...makeRows(), { id: 'wrong-id', surfaceId: 'cap-mismatch', backendLifecycle: 'lost' }];
      const controller = wall.createWallWorkspaceController({ projectionView: makeProjectionView(rows), allowLostSurface });
      const api = makeFakeApi();
      controller.handleReady({ api, windows: makeFakeWindows() });
      assert.equal(controller.revealSurface('cap-gone', 'tab').ok, allowLostSurface === true);
      assert.equal(controller.revealSurface('cap-dead', 'tab').error.code, 'ERR_SURFACE_GONE');
      assert.equal(controller.revealSurface('cap-mismatch', 'tab').error.code, 'ERR_ROW_IDENTITY_MISMATCH');
      assert.equal(api.panels.size, allowLostSurface === true ? 1 : 0);
    }
  });
});
