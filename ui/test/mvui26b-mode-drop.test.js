// MVUI26B lane M: the shared input mode drops to READ when control leaves
// human or the selected surface goes away. Mounts the REAL App with stub
// children (wall renders the surface slot per row, canvas stubs expose live
// input props, the multislot stub exposes its live input-mode prop) and
// pushes new projection snapshots through the captured subscribe listener.
// Each behaviour has a negative control; async waits via frame-wait.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { tick } from './frame-wait.mjs';

const APP_URL = new URL('../src/App.vue', import.meta.url);
let appSerial = 2600;

/**
 * Load the real App with stub children.
 * @param {{ canvases?: Array<{ surfaceId: string, inputEnabled: () => unknown }>, slotMode?: () => unknown, wall?: unknown }} captured
 */
async function loadDropApp(captured) {
  const stub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
  });
  const canvasStub = vue.defineComponent({
    props: ['surfaceId', 'inputEnabled', 'streamId'],
    setup: (props) => {
      (captured.canvases ??= []).push({
        surfaceId: props.surfaceId,
        inputEnabled: () => props.inputEnabled,
      });
      return () => vue.h('div');
    },
  });
  const slotStub = vue.defineComponent({
    props: ['inputMode'],
    setup: (props, ctx) => {
      captured.slotMode = () => props.inputMode;
      return () => vue.h('div', {}, ctx.slots.surface?.() ?? []);
    },
  });
  const wallStub = vue.defineComponent({
    setup: (_, ctx) => {
      captured.wall = ctx;
      return () => vue.h('div', {}, (captured.rows ?? []).map((row) =>
        ctx.slots.surface?.({ surface: row, capsuleId: row.id }) ?? []));
    },
  });
  globalThis.__mvui26bdeps = {
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': stub,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': slotStub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': stub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wallStub,
    './surfaces/SurfaceCanvas.vue': canvasStub,
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(APP_URL, 'utf8'));
  const compiled = compileScript(descriptor, { id: `v-drop-${++appSerial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__mvui26bdeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#v-drop-${appSerial}`)).default;
}

function dropRenderer() {
  return vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }),
    createComment: (text) => ({ text }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
    },
    remove(child) { const items = child.parent?.children; if (items) items.splice(items.indexOf(child), 1); },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) { node.props[key] = value; },
    querySelector: () => null,
    setScopeId() {},
  });
}

/**
 * @param {string} id
 * @param {string} control
 */
function dropRow(id, control) {
  return {
    id, surfaceId: id, title: id, kind: 'program', backendLifecycle: 'active',
    generation: 1, visibility: 'unfolded', control, controlOwner: control,
    folded: false, refusal: null, readinessError: null, attachmentState: 'live',
    aiSessionActivity: 'ready', dispatchOutcome: 'none',
  };
}

/**
 * Mount the real App on live rows; push() swaps the rows and delivers a new
 * snapshot through the captured subscribe listener, like the live feed.
 * @param {unknown[]} initialRows
 */
async function mountDrop(initialRows) {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: undefined };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const captured = { canvases: [], rows: initialRows };
  let epoch = 1;
  let snapshot = { envelope: { epoch } };
  const listeners = [];
  let handle = null;
  const App = await loadDropApp(captured);
  const root = { children: [] };
  handle = dropRenderer().createApp(App, {
    layout: {}, scope: {},
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
    fixture: { key: 'multislot', ui: { inputMode: 'WRITE' }, capsules: [{ id: 'cap-01' }] },
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    runtime: {
      projectionView: {
        getSnapshot: () => snapshot,
        getProjection: () => ({ rows: captured.rows }),
        subscribe: (cb) => { listeners.push(cb); return () => {}; },
      },
    },
  });
  handle.mount(root);
  await tick();
  await vue.nextTick();
  return {
    captured,
    /** Latest live inputEnabled getter per surface id. */
    canvasById: (/** @type {string} */ id) => captured.canvases.filter((entry) => entry.surfaceId === id).at(-1),
    slotMode: () => captured.slotMode?.(),
    select: async (/** @type {string} */ id) => {
      captured.wall.emit('activate-surface', { capsuleId: id });
      await tick();
      await vue.nextTick();
    },
    /** @param {unknown[]} nextRows */
    push: async (nextRows) => {
      captured.rows = nextRows;
      epoch += 1;
      snapshot = { envelope: { epoch } };
      for (const cb of listeners) cb(snapshot);
      await tick();
      await vue.nextTick();
      await tick();
    },
    close: () => {
      try { handle?.unmount(); } catch { /* Teardown never fails the gate. */ }
      globalThis.window = oldWindow;
      globalThis.document = oldDocument;
      delete globalThis.__mvui26bdeps;
    },
  };
}

describe('mvui26b mode drops to READ (lane M)', () => {
  test('release drops WRITE: toggle shows READ and every canvas gates off', async () => {
    const app = await mountDrop([dropRow('cap-01', 'human'), dropRow('cap-02', 'human')]);
    try {
      assert.equal(app.slotMode(), 'write', 'multislot starts in WRITE');
      assert.equal(app.canvasById('cap-01')?.inputEnabled(), true, 'selected canvas gated in');
      assert.equal(app.canvasById('cap-02')?.inputEnabled(), true, 'wall canvas gated in');
      await app.push([dropRow('cap-01', 'agent'), dropRow('cap-02', 'human')]);
      assert.equal(app.slotMode(), 'read', 'toggle shows READ after release');
      assert.equal(app.canvasById('cap-01')?.inputEnabled(), false, 'released canvas gates off');
      assert.equal(app.canvasById('cap-02')?.inputEnabled(), false, 'wall canvas gates off with the shared mode');
      assert.throws(() => assert.equal(app.slotMode(), 'write'), assert.AssertionError);
    } finally {
      app.close();
    }
  });

  test('negative control: kept human control keeps WRITE across snapshots', async () => {
    const app = await mountDrop([dropRow('cap-01', 'human'), dropRow('cap-02', 'agent')]);
    try {
      await app.push([dropRow('cap-01', 'human'), dropRow('cap-02', 'agent')]);
      await app.push([dropRow('cap-01', 'human')]);
      assert.equal(app.slotMode(), 'write', 'unrelated feed churn never drops the mode');
      assert.equal(app.canvasById('cap-01')?.inputEnabled(), true);
      assert.throws(() => assert.equal(app.slotMode(), 'read'), assert.AssertionError);
    } finally {
      app.close();
    }
  });

  test('surface going away drops to READ; a human replacement keeps WRITE', async () => {
    const app = await mountDrop([dropRow('cap-01', 'human'), dropRow('cap-02', 'agent')]);
    try {
      await app.push([dropRow('cap-02', 'agent')]);
      assert.equal(app.slotMode(), 'read', 'selection falling through to an agent surface drops');
      assert.equal(app.canvasById('cap-02')?.inputEnabled(), false);
    } finally {
      app.close();
    }
    const kept = await mountDrop([dropRow('cap-01', 'human'), dropRow('cap-02', 'human')]);
    try {
      await app.push([dropRow('cap-02', 'human')]);
      assert.equal(kept.slotMode(), 'write', 'selection falling through to a human surface keeps WRITE');
      assert.equal(kept.canvasById('cap-02')?.inputEnabled(), true);
    } finally {
      kept.close();
    }
  });

  test('empty wall drops to READ and stays READ when a human surface returns', async () => {
    const app = await mountDrop([dropRow('cap-01', 'human')]);
    try {
      await app.push([]);
      await app.push([dropRow('cap-01', 'human')]);
      assert.equal(app.slotMode(), 'read', 'the drop survives the surface going away');
      assert.equal(app.canvasById('cap-01')?.inputEnabled(), false, 'no silent WRITE re-arm');
      assert.throws(() => assert.equal(app.slotMode(), 'write'), assert.AssertionError);
    } finally {
      app.close();
    }
  });

  test('negative control: selecting another surface never drops the mode by itself', async () => {
    const app = await mountDrop([dropRow('cap-01', 'human'), dropRow('cap-02', 'agent')]);
    try {
      await app.select('cap-02');
      assert.equal(app.slotMode(), 'write', 'selection is not a control event');
      assert.equal(app.canvasById('cap-01')?.inputEnabled(), true, 'the human wall tile stays gated in');
      await app.push([dropRow('cap-01', 'shared'), dropRow('cap-02', 'agent')]);
      assert.equal(app.slotMode(), 'read', 'only the feed update drops');
    } finally {
      app.close();
    }
  });

  test('control returning to human never re-arms WRITE', async () => {
    const app = await mountDrop([dropRow('cap-01', 'human')]);
    try {
      await app.push([dropRow('cap-01', 'shared')]);
      assert.equal(app.slotMode(), 'read');
      await app.push([dropRow('cap-01', 'human')]);
      assert.equal(app.slotMode(), 'read', 're-take does not restore WRITE on its own');
    } finally {
      app.close();
    }
  });
});
