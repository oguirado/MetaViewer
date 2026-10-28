/**
 * MVUI28 lane R: an async input refusal renders as one Activity row.
 *
 * Mounts the REAL App with a REAL input port over a controllable result
 * facade: an async-only refusal (ok reply, refused result event) becomes one
 * typed strip row, an ok event renders nothing, and a duplicate event for
 * the same (surface_id, seq) never grows the row. Each behaviour pairs with
 * a negative control; async waits via frame-wait. Runs under the repository
 * `node --test` gate with the custom renderer only; no DOM is loaded.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { normalizeActivityEntry } from '../src/activity/activityModel.js';
import { createInputPort } from '../src/input/inputPort.js';
import { tick } from './frame-wait.mjs';

const APP_URL = new URL('../src/App.vue', import.meta.url);
let appSerial = 2800;

/**
 * @param {{ stripEntries?: () => unknown[] }} captured
 */
async function loadResultApp(captured) {
  const stub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
  });
  const strip = vue.defineComponent({
    props: ['entries'],
    setup: (props) => {
      captured.stripEntries = () => props.entries;
      return () => vue.h('section');
    },
  });
  const wallStub = vue.defineComponent({
    setup: (_, ctx) => () => vue.h('div', {}, (captured.rows ?? []).map((row) =>
      ctx.slots.surface?.({ surface: row, capsuleId: row.id }) ?? [])),
  });
  globalThis.__mvui28rdeps = {
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': stub,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': strip,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wallStub,
    './surfaces/SurfaceCanvas.vue': stub,
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(APP_URL, 'utf8'));
  const compiled = compileScript(descriptor, { id: `v-r28-${++appSerial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__mvui28rdeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#v-r28-${appSerial}`)).default;
}

function resultRenderer() {
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

/** @param {unknown} port */
async function mountResult(port) {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: undefined };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const captured = {
    rows: [{
      id: 'cap-01', surfaceId: 'cap-01', title: 'cap-01', kind: 'program', backendLifecycle: 'active',
      generation: 1, visibility: 'unfolded', control: 'shared', controlOwner: 'none',
      folded: false, refusal: null, readinessError: null, attachmentState: 'live',
      aiSessionActivity: 'ready', dispatchOutcome: 'none',
    }],
  };
  let handle = null;
  const App = await loadResultApp(captured);
  const root = { children: [] };
  handle = resultRenderer().createApp(App, {
    layout: {}, scope: {},
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
    fixture: null,
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    runtime: {
      projectionView: {
        getSnapshot: () => ({ envelope: { epoch: 1 } }),
        getProjection: () => ({ rows: captured.rows }),
        subscribe: () => () => {},
      },
    },
  });
  handle.provide('inputPort', port);
  handle.mount(root);
  await tick();
  await vue.nextTick();
  const settled = async () => { await tick(); await vue.nextTick(); };
  return {
    feed: () => captured.stripEntries(),
    settled,
    close: () => {
      try { handle?.unmount(); } catch { /* Teardown never fails the gate. */ }
      globalThis.window = oldWindow;
      globalThis.document = oldDocument;
      delete globalThis.__mvui28rdeps;
    },
  };
}

/** Controllable result facade: every send is accepted; results are manual. */
function makeResultFacade() {
  const state = { listeners: [] };
  const facade = {
    send: (batch) => Promise.resolve({ ok: true, accepted: batch.events.length }),
    onResult(cb) {
      state.listeners.push(cb);
      return () => {};
    },
    emit(event) { for (const cb of state.listeners.slice()) cb(event); },
  };
  return { state, facade };
}

/** @returns {{ raf: (cb: (t: number) => void) => unknown, cancelRaf: () => void, fire: () => void }} */
function makeRaf() {
  /** @type {((t: number) => void) | null} */
  let cb = null;
  return {
    raf: (fn) => { cb = fn; return 1; },
    cancelRaf: () => { cb = null; },
    fire: () => { const f = cb; cb = null; if (f) f(0); },
  };
}

describe('mvui28 async refusal activity row (lane R app)', () => {
  test('an async refusal produces one Activity row', async () => {
    const { facade } = makeResultFacade();
    const frames = makeRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const app = await mountResult(port);
    try {
      assert.deepEqual(app.feed(), [], 'no rows before any input');
      port.queue('cap-01', 1, { kind: 'click', x: 1, y: 2, button: 'left' });
      frames.fire();
      await app.settled();
      assert.deepEqual(app.feed(), [], 'the accepted batch renders nothing');
      facade.emit({ surface_id: 'cap-01', seq: 1, ok: false, code: 'LIMIT' });
      await app.settled();
      assert.deepEqual(app.feed(), [{ seq: 1, code: 'LIMIT', count: 1 }], 'exactly one row');
      const entry = normalizeActivityEntry(app.feed()[0]);
      assert.equal(entry?.type, 'request-refused');
      assert.equal(entry?.tone, 'refusal');
      assert.equal(entry?.text, 'Input refused: too many requests (LIMIT).');
    } finally {
      app.close();
      port.dispose();
    }
  });

  test('negative control: an async ok emits no row; a duplicate event stays one row', async () => {
    const { facade } = makeResultFacade();
    const frames = makeRaf();
    const port = createInputPort(facade, { raf: frames.raf, cancelRaf: frames.cancelRaf });
    const app = await mountResult(port);
    try {
      facade.emit({ surface_id: 'cap-01', seq: 9, ok: true, code: null });
      await app.settled();
      assert.deepEqual(app.feed(), [], 'the ok event renders nothing');
      const refusal = { surface_id: 'cap-01', seq: 9, ok: false, code: 'STALE_STREAM' };
      facade.emit(refusal);
      await app.settled();
      assert.deepEqual(app.feed(), [{ seq: 1, code: 'STALE_STREAM', count: 1 }]);
      facade.emit({ ...refusal });
      await app.settled();
      assert.deepEqual(
        app.feed(),
        [{ seq: 1, code: 'STALE_STREAM', count: 1 }],
        'the duplicate event never grows the row',
      );
      facade.emit(null);
      facade.emit({ surface_id: 'cap-01', seq: 9, ok: false, code: 'BOGUS' });
      await app.settled();
      assert.deepEqual(app.feed(), [{ seq: 1, code: 'STALE_STREAM', count: 1 }], 'malformed events render nothing');
    } finally {
      app.close();
      port.dispose();
    }
  });
});
