// MVUI19 lane A (L3-3): the settled 'Request sent.'/refusal toast
// auto-dismisses after a short timeout and never intercepts pointer events on
// interactive rows. Regression: the toast never dismissed and covered the
// first recording row link in the multislot.
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
import { buildMultislotHideIntent } from '../src/multislot/multislotInputGate.js';

const APP_URL = new URL('../src/App.vue', import.meta.url);
const APP_SOURCE = readFileSync(APP_URL, 'utf8');
const ID = 'surface-a';
const DISMISS_MS = 4000;
let serial = 0;

async function loadApp(captured) {
  const stub = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
  const strip = vue.defineComponent({ props: ['entries'],
    setup: props => { captured.stripEntries = () => props.entries; return () => vue.h('section', { id: 'test-activity' }); } });
  const outcome = vue.defineComponent({ props: ['row'],
    setup: props => { captured.outcome = () => props.row; return () => vue.h('p', { id: 'test-outcome' }); } });
  const slot = vue.defineComponent({ setup: (_, ctx) => { captured.slot = ctx; return () => vue.h('section'); } });
  const wall = vue.defineComponent({ setup: (_, ctx) => {
    captured.wall = ctx;
    ctx.expose({ applyLayoutEcho: () => undefined });
    return () => vue.h('div');
  } });
  globalThis.__mvui19deps = {
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': outcome,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': slot,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './activity/ActivityStrip.vue': strip,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wall,
    './surfaces/SurfaceCanvas.vue': stub,
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(APP_URL, 'utf8'));
  const compiled = compileScript(descriptor, { id: `mvui19-toast-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__mvui19deps[${JSON.stringify(specifier)}];`;
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
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

/** Selective timer double: captures only the dismissal delay, delegates the rest. */
function installTimerDouble() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let timerSerial = 1000;
  const timers = new Map();
  globalThis.setTimeout = (callback, ms, ...rest) => {
    if (ms !== DISMISS_MS) return realSetTimeout(callback, ms, ...rest);
    const id = ++timerSerial;
    timers.set(id, { callback, cleared: false });
    return /** @type {any} */ (id);
  };
  globalThis.clearTimeout = (id) => {
    if (timers.has(id)) { timers.get(id).cleared = true; return; }
    return realClearTimeout(id);
  };
  return {
    timers,
    armed: () => [...timers].filter(([, timer]) => !timer.cleared).map(([id]) => id),
    fire(id) { const timer = timers.get(id); if (timer && !timer.cleared) timer.callback(); },
    restore() { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; },
  };
}

async function mountToast() {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const captured = {};
  const calls = [];
  const authorityHost = createAuthorityAdapter({
    intent: (json) => { const wait = deferred(); calls.push({ json, ...wait }); return wait.promise; },
    propose: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' }),
  });
  const App = await loadApp(captured);
  const root = { children: [] };
  const appHandle = renderer().createApp(App, {
    authorityHost,
    runtime: { projectionView: { getSnapshot: () => ({ envelope: null }),
      getProjection: () => ({ rows: [{ id: ID, generation: 1, visibility: 'unfolded', control: 'human', backendLifecycle: 'active' }] }),
      subscribe: () => () => {} } },
    layout: {}, scope: {}, fixture: { key: 'multislot', ui: {}, capsules: [{ id: ID }] },
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
  });
  appHandle.mount(root);
  await tick();
  return {
    captured, calls,
    feed: () => captured.stripEntries(),
    close() { appHandle.unmount(); globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__mvui19deps; },
  };
}

const wallTake = id => ({ schema: 'ui_intent/v0.2', request_id: `mvui19-toast-${id}`, op: 'take_control', params: { surface_id: ID } });

describe('mvui19 toast auto-dismiss (L3-3)', () => {
  test('settled ack toast dismisses after the timeout without recording', async () => {
    assert.ok(APP_SOURCE.includes('const OUTCOME_DISMISS_MS = 4000;'), 'dismissal delay is pinned');
    const clock = installTimerDouble();
    const f = await mountToast();
    try {
      f.captured.wall.emit('submit-intent', wallTake(1));
      await tick();
      f.calls.at(-1).resolve(true);
      await tick();
      assert.equal(f.captured.outcome()?.code, 'INTENT_ACKNOWLEDGED', 'ack toast shows');
      assert.equal(f.feed().length, 1, 'ack records once');
      const armed = clock.armed();
      assert.equal(armed.length, 1, 'one dismissal timer is armed');
      clock.fire(armed[0]);
      await tick();
      assert.equal(f.captured.outcome(), null, 'toast dismisses');
      assert.equal(f.feed().length, 1, 'dismissal invents no row');
    } finally { f.close(); clock.restore(); }
  });

  test('a newer outcome replaces the pending dismissal; the stale timer cannot clear it', async () => {
    const clock = installTimerDouble();
    const f = await mountToast();
    try {
      f.captured.wall.emit('submit-intent', wallTake(1));
      await tick();
      f.calls.at(-1).resolve(true);
      await tick();
      const [first] = clock.armed();
      assert.ok(first, 'first dismissal armed');
      f.captured.wall.emit('submit-intent', wallTake(2));
      await tick();
      f.calls.at(-1).resolve(true);
      await tick();
      assert.equal(clock.timers.get(first)?.cleared, true, 're-arm clears the stale timer');
      const [second] = clock.armed();
      assert.ok(second && second !== first, 'newer outcome arms its own dismissal');
      clock.fire(first);
      await tick();
      assert.equal(f.captured.outcome()?.code, 'INTENT_ACKNOWLEDGED', 'stale timer cannot clear the newer toast');
      clock.fire(second);
      await tick();
      assert.equal(f.captured.outcome(), null, 'newer toast still dismisses');
      assert.equal(f.feed().length, 2, 'only the two acks recorded');
    } finally { f.close(); clock.restore(); }
  });

  test('transport and guard refusals dismiss the same way', async () => {
    const clock = installTimerDouble();
    const f = await mountToast();
    try {
      f.captured.wall.emit('submit-intent', wallTake('fail'));
      await tick();
      f.calls.at(-1).reject(new Error('closed'));
      await tick();
      assert.equal(f.captured.outcome()?.code, 'HOST_REQUEST_REFUSED');
      const [refusalTimer] = clock.armed();
      assert.ok(refusalTimer, 'refusal arms dismissal');
      clock.fire(refusalTimer);
      await tick();
      assert.equal(f.captured.outcome(), null, 'refusal toast dismisses');
      f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
      await tick();
      assert.equal(f.captured.outcome()?.code, 'ERR_INPUT_MODE_READ', 'READ guard toasts');
      const [guardTimer] = clock.armed();
      assert.ok(guardTimer, 'guard refusal arms dismissal');
      assert.deepEqual(f.feed().map(entry => entry.code), ['HOST_REQUEST_REFUSED', 'ERR_INPUT_MODE_READ']);
      clock.fire(guardTimer);
      await tick();
      assert.equal(f.captured.outcome(), null, 'guard toast dismisses');
      assert.equal(f.feed().length, 2, 'dismissals invent no rows');
    } finally { f.close(); clock.restore(); }
  });

  test('unmount clears the pending dismissal', async () => {
    const clock = installTimerDouble();
    const f = await mountToast();
    let closed = false;
    try {
      f.captured.wall.emit('submit-intent', wallTake(1));
      await tick();
      f.calls.at(-1).resolve(true);
      await tick();
      const [timer] = clock.armed();
      assert.ok(timer, 'dismissal armed');
      f.close();
      closed = true;
      assert.equal(clock.timers.get(timer)?.cleared, true, 'unmount clears the timer');
      clock.fire(timer);
    } finally { if (!closed) f.close(); clock.restore(); }
  });

  test('negative control: no outcome arms no timer', async () => {
    const clock = installTimerDouble();
    const f = await mountToast();
    try {
      assert.equal(f.captured.outcome(), null, 'no toast on mount');
      assert.deepEqual(clock.armed(), [], 'no dismissal without an outcome');
      f.captured.slot.emit('submit-intent', { type: 'hide-surface' }, ID);
      await tick();
      assert.equal(f.captured.outcome(), null, 'local toggles toast nothing');
      assert.deepEqual(clock.armed(), [], 'local toggles arm nothing');
    } finally { f.close(); clock.restore(); }
  });
});

describe('mvui19 toast never intercepts rows (L3-3)', () => {
  /** App-side predicate: the toast override keeps rows clickable. */
  function assertToastNonIntercepting(source) {
    const css = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
    assert.match(css, /#shell-wall\s+#mv-host-outcome\s*\{[^}]*pointer-events\s*:\s*none[^}]*\}/,
      'toast override drops pointer interception inside the wall');
  }

  test('App carries the non-intercepting toast override and keeps the mount', () => {
    assertToastNonIntercepting(APP_SOURCE);
    assert.ok(APP_SOURCE.includes('<HostOutcome :row="hostOutcome" />'), 'toast mount stays byte-identical');
    assert.ok(APP_SOURCE.includes('watch(hostOutcome, (row) => { if (row) armOutcomeDismiss(); });'),
      'dismissal arms on every outcome without touching pinned lines');
  });

  test('negative control: missing or inverted override fails the predicate', () => {
    assertToastNonIntercepting(APP_SOURCE);
    assert.throws(() => assertToastNonIntercepting('<style>#shell-wall #mv-host-outcome { color: red; }</style>'),
      assert.AssertionError, 'missing pointer-events fails');
    assert.throws(() => assertToastNonIntercepting('<style>#shell-wall #mv-host-outcome { pointer-events: auto; }</style>'),
      assert.AssertionError, 'intercepting override fails');
    assert.throws(() => assertToastNonIntercepting('<style>.mv-shell main { color: red; }</style>'),
      assert.AssertionError, 'missing toast rule fails');
  });
});

test('mvui19 toast dismiss: rss stays bounded', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
