// MVUI26B lane M: input-port refusals reach the Activity strip as short
// typed rows naming the closed code; a burst coalesces into one row with a
// count. Model checks pin the exact row copy; App checks mount the REAL App
// with a fake input port (subscribe-once, feed capture, unmount disposal).
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
import {
  MV_ACTIVITY_LIMIT,
  MV_ACTIVITY_TONES,
  MV_ACTIVITY_TYPES,
  normalizeActivityEntry,
} from '../src/activity/activityModel.js';
import { tick } from './frame-wait.mjs';

const REFUSAL_COPY = {
  NOT_IN_CONTROL: 'Input refused: control released (NOT_IN_CONTROL).',
  INPUT_MODE_READ: 'Input refused: read-only mode (INPUT_MODE_READ).',
  SURFACE_UNKNOWN: 'Input refused: surface unavailable (SURFACE_UNKNOWN).',
  STALE_STREAM: 'Input refused: stream changed (STALE_STREAM).',
  LIMIT: 'Input refused: too many requests (LIMIT).',
  NESTED_DISPLAY_ONLY: 'Input refused: display only (NESTED_DISPLAY_ONLY).',
  SCHEMA: 'Input refused: invalid input (SCHEMA).',
  CORE_UNAVAILABLE: 'Input refused: core unavailable (CORE_UNAVAILABLE).',
};

describe('mvui26b refusal rows (lane M model)', () => {
  test('every closed refusal code renders a typed human-readable row with its code', () => {
    assert.equal(Object.keys(REFUSAL_COPY).length, 8, 'the contract closed set, exactly');
    for (const [code, text] of Object.entries(REFUSAL_COPY)) {
      const entry = normalizeActivityEntry({ seq: 3, code });
      assert.deepEqual(entry, { seq: 3, type: 'request-refused', tone: 'refusal', text }, code);
      assert.ok(MV_ACTIVITY_TYPES.includes(entry.type), 'typed in the closed set');
      assert.ok(MV_ACTIVITY_TONES.includes(entry.tone), 'toned in the closed set');
      assert.ok(Object.isFrozen(entry), 'rows stay frozen');
    }
  });

  test('burst counts suffix the row; malformed counts read as one', () => {
    assert.equal(
      normalizeActivityEntry({ seq: 1, code: 'LIMIT', count: 3 })?.text,
      'Input refused: too many requests (LIMIT) ×3.',
    );
    assert.equal(
      normalizeActivityEntry({ seq: 1, code: 'NOT_IN_CONTROL', count: 1 })?.text,
      REFUSAL_COPY.NOT_IN_CONTROL,
      'a lone refusal carries no count',
    );
    for (const count of [0, -2, 1.5, '3', NaN, null, undefined]) {
      assert.equal(
        normalizeActivityEntry({ seq: 1, code: 'SCHEMA', count })?.text,
        REFUSAL_COPY.SCHEMA,
        `malformed count reads as one: ${String(count)}`,
      );
    }
  });

  test('negative control: the count never leaks into authority or fallback rows', () => {
    assert.deepEqual(normalizeActivityEntry({ seq: 2, code: 'ACTION_ADMITTED', count: 5 }),
      { seq: 2, type: 'verdict-admitted', tone: 'success', text: 'Action admitted.' });
    assert.deepEqual(normalizeActivityEntry({ seq: 2, code: 'NOPE', count: 5 }),
      { seq: 2, type: 'request-refused', tone: 'refusal', text: 'This request is unavailable. Please try again.' });
    assert.throws(() => assert.match(
      normalizeActivityEntry({ seq: 2, code: 'NOPE', count: 5 })?.text ?? '', /×5/),
      assert.AssertionError);
  });

  test('negative control: closed sets and bounds stay pinned', () => {
    assert.deepEqual([...MV_ACTIVITY_TYPES], ['intent-ack', 'verdict-admitted', 'verdict-refused', 'request-refused']);
    assert.deepEqual([...MV_ACTIVITY_TONES], ['success', 'refusal']);
    assert.equal(MV_ACTIVITY_LIMIT, 8);
    for (const bad of [null, undefined, 7, { seq: 0, code: 'LIMIT' }, { code: 'LIMIT' }]) {
      assert.equal(normalizeActivityEntry(bad), null, `malformed input stays unrendered: ${JSON.stringify(bad)}`);
    }
  });
});

const APP_URL = new URL('../src/App.vue', import.meta.url);
let appSerial = 2700;

/**
 * @param {{ stripEntries?: () => unknown[] }} captured
 */
async function loadRefusalApp(captured) {
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
  globalThis.__mvui26brdeps = {
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
  const compiled = compileScript(descriptor, { id: `v-ref-${++appSerial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__mvui26brdeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#v-ref-${appSerial}`)).default;
}

function refusalRenderer() {
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

/** @param {unknown} [port] */
async function mountRefusal(port) {
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
  const App = await loadRefusalApp(captured);
  const root = { children: [] };
  handle = refusalRenderer().createApp(App, {
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
  if (port !== undefined) handle.provide('inputPort', port);
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
      delete globalThis.__mvui26brdeps;
    },
  };
}

function refusalPort() {
  const state = { subscribes: 0, unsubscribes: 0, listener: null };
  const port = {
    available: true,
    onRefusal(/** @type {(refusal: unknown) => void} */ cb) {
      state.subscribes += 1;
      state.listener = cb;
      return () => { state.unsubscribes += 1; };
    },
    emit(/** @type {unknown} */ refusal) { state.listener?.(refusal); },
  };
  return { state, port };
}

describe('mvui26b refusal subscription and feed (lane M app)', () => {
  test('app subscribes once; each refusal becomes a typed feed row', async () => {
    const { state, port } = refusalPort();
    const app = await mountRefusal(port);
    try {
      assert.equal(state.subscribes, 1, 'exactly one subscription');
      assert.deepEqual(app.feed(), [], 'no rows before any refusal');
      port.emit({ surfaceId: 'cap-01', code: 'NOT_IN_CONTROL' });
      await app.settled();
      assert.deepEqual(app.feed(), [{ seq: 1, code: 'NOT_IN_CONTROL', count: 1 }]);
      const entry = normalizeActivityEntry(app.feed()[0]);
      assert.equal(entry?.type, 'request-refused');
      assert.equal(entry?.tone, 'refusal');
      assert.equal(entry?.text, REFUSAL_COPY.NOT_IN_CONTROL);
    } finally {
      app.close();
    }
  });

  test('a burst of same-code refusals coalesces into one row with a count', async () => {
    const { port } = refusalPort();
    const app = await mountRefusal(port);
    try {
      port.emit({ surfaceId: 'cap-01', code: 'LIMIT' });
      port.emit({ surfaceId: 'cap-01', code: 'LIMIT' });
      port.emit({ surfaceId: 'cap-02', code: 'LIMIT' });
      await app.settled();
      assert.deepEqual(app.feed(), [{ seq: 1, code: 'LIMIT', count: 3 }], 'one row, sequence kept');
      assert.equal(
        normalizeActivityEntry(app.feed()[0])?.text,
        'Input refused: too many requests (LIMIT) ×3.',
      );
      port.emit({ surfaceId: 'cap-01', code: 'STALE_STREAM' });
      await app.settled();
      assert.deepEqual(app.feed(), [
        { seq: 1, code: 'LIMIT', count: 3 },
        { seq: 2, code: 'STALE_STREAM', count: 1 },
      ], 'a new code starts a fresh row');
    } finally {
      app.close();
    }
  });

  test('negative control: malformed refusals record nothing; unknown codes fall back', async () => {
    const { port } = refusalPort();
    const app = await mountRefusal(port);
    try {
      for (const bad of [null, undefined, 7, 'x', [], {}, { code: 7 }, { code: '' }, { surfaceId: 'cap-01' }]) {
        port.emit(bad);
      }
      await app.settled();
      assert.deepEqual(app.feed(), [], 'malformed refusals never reach the strip');
      port.emit({ surfaceId: 'cap-01', code: 'NOPE' });
      await app.settled();
      assert.equal(app.feed().length, 1, 'unknown codes still record');
      assert.equal(
        normalizeActivityEntry(app.feed()[0])?.text,
        'This request is unavailable. Please try again.',
        'unknown codes render as the generic refusal',
      );
    } finally {
      app.close();
    }
  });

  test('unmount disposes the subscription; late refusals never render', async () => {
    const { state, port } = refusalPort();
    const app = await mountRefusal(port);
    try {
      port.emit({ surfaceId: 'cap-01', code: 'SCHEMA' });
      await app.settled();
      assert.equal(app.feed().length, 1);
    } finally {
      app.close();
    }
    assert.equal(state.unsubscribes, 1, 'disposed on unmount');
    assert.doesNotThrow(
      () => port.emit({ surfaceId: 'cap-01', code: 'SCHEMA' }),
      'a late refusal after teardown stays silent',
    );
  });

  test('negative control: no port means no subscription and no rows', async () => {
    const app = await mountRefusal(undefined);
    try {
      await app.settled();
      assert.deepEqual(app.feed(), [], 'bare mounts stay silent');
    } finally {
      app.close();
    }
    const broken = await mountRefusal({});
    try {
      await broken.settled();
      assert.deepEqual(broken.feed(), [], 'a port without onRefusal never breaks the shell');
    } finally {
      broken.close();
    }
    const throwing = await mountRefusal({ onRefusal() { throw new Error('port down'); } });
    try {
      await throwing.settled();
      assert.deepEqual(throwing.feed(), [], 'a throwing subscribe never breaks the shell');
    } finally {
      throwing.close();
    }
  });

  test('refusal rows respect the strip bound', async () => {
    const { port } = refusalPort();
    const app = await mountRefusal(port);
    try {
      const codes = Object.keys(REFUSAL_COPY);
      for (let i = 0; i < 20; i += 1) {
        port.emit({ surfaceId: 'cap-01', code: codes[i % codes.length] });
      }
      await app.settled();
      assert.equal(app.feed().length, MV_ACTIVITY_LIMIT, 'the feed never outgrows the strip');
      assert.deepEqual(app.feed().map((entry) => entry.seq), [13, 14, 15, 16, 17, 18, 19, 20]);
    } finally {
      app.close();
    }
  });
});
