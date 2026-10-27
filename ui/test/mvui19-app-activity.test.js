// MVUI19 lane A (L3-2): live intents, acks and refusals reach the activity
// feed and the count advances on every recorded entry. Regression: the live
// app froze at 2 rows because renderer-side refusals of the operator's own
// requests (READ-mode/agent/pending placement guards, missing intent port,
// failed layout echoes, hidden-surface fold) set the toast but skipped
// recordActivity. Only cross-slot confusion and non-authority outcomes stay
// unrecorded (pinned by mvui6/mvui5).
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
import {
  MV_ACTIVITY_LIMIT,
  mvActivityCountText,
  mvActivityFeedTotal,
  normalizeActivityEntry,
} from '../src/activity/activityModel.js';
import {
  buildMultislotFoldIntent,
  buildMultislotHideIntent,
  buildMultislotShowIntent,
} from '../src/multislot/multislotInputGate.js';

const APP_URL = new URL('../src/App.vue', import.meta.url);
const ID = 'surface-a';
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
    ctx.expose({ applyLayoutEcho: (...args) => { captured.echoes.push(args); return captured.echoResult; } });
    return () => vue.h('div');
  } });
  const catalog = vue.defineComponent({ setup: (_, ctx) => { captured.catalog = ctx; return () => vue.h('div'); } });
  globalThis.__mvui19deps = {
    './creative/CreativeCapsule.vue': stub,
    './core/HostOutcome.vue': outcome,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': catalog,
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
  const compiled = compileScript(descriptor, { id: `mvui19-app-${++serial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, specifier) => {
    if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    return `const ${binding.trim()} = globalThis.__mvui19deps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#a-${serial}`)).default;
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

/** Mount App with feed/outcome/slot capture. Intent port is manually deferred. */
async function mountLane(options = {}) {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  const captured = { echoes: [], echoResult: options.echoResult };
  const calls = [];
  const state = { verdict: options.verdict ?? { schema: 'action_verdict/v0.2', proposal_id: 'p', core_seq: 1, decision: 'admitted' } };
  const authorityHost = options.authorityHost ?? createAuthorityAdapter({
    intent: (json) => { const wait = deferred(); calls.push({ json, ...wait }); return wait.promise; },
    propose: async (json) => { calls.push({ json }); return state.verdict; },
  });
  const row = vue.reactive({ id: ID, surfaceId: ID, title: 'Capsule', generation: 1,
    visibility: 'unfolded', control: options.control ?? 'human', backendLifecycle: 'active' });
  const App = await loadApp(captured);
  const root = { children: [] };
  const appHandle = renderer().createApp(App, {
    authorityHost,
    runtime: { projectionView: { getSnapshot: () => ({ envelope: null }), getProjection: () => ({ rows: [row] }), subscribe: () => () => {} } },
    layout: {}, scope: {}, fixture: { key: 'multislot', ui: {}, capsules: [{ id: ID }] },
    nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
    storage: { readRaw: async () => null, writeAtomic: async () => {} },
  });
  appHandle.mount(root);
  await tick();
  return {
    captured, calls, state, row, root,
    feed: () => captured.stripEntries(),
    codes: () => captured.stripEntries().map(entry => entry.code),
    close() { appHandle.unmount(); globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__mvui19deps; },
  };
}

const wallTake = id => ({ schema: 'ui_intent/v0.2', request_id: `mvui19-take-${id}`, op: 'take_control', params: { surface_id: ID } });

describe('mvui19 placement refusals reach the feed (L3-2)', () => {
  test('READ-mode and agent-controlled placements record their refusals', async () => {
    const f = await mountLane();
    try {
      assert.deepEqual(f.feed(), [], 'feed starts empty');
      f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
      await tick();
      assert.equal(f.captured.outcome()?.code, 'ERR_INPUT_MODE_READ', 'READ guard toasts');
      assert.equal(f.calls.length, 0, 'guarded request never reaches the host');
      assert.deepEqual(f.codes(), ['ERR_INPUT_MODE_READ'], 'READ refusal is recorded');
      f.row.control = 'agent';
      await tick();
      f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
      await tick();
      assert.equal(f.captured.outcome()?.code, 'LAYOUT_INPUT_MODE_READ', 'agent guard toasts');
      assert.deepEqual(f.codes(), ['ERR_INPUT_MODE_READ', 'LAYOUT_INPUT_MODE_READ'], 'agent refusal is recorded');
      assert.deepEqual(f.feed().map(entry => entry.seq), [1, 2], 'one sequence per recorded entry');
    } finally { f.close(); }
  });

  test('pending placement records without double submission; ack follows once', async () => {
    const f = await mountLane();
    try {
      f.captured.slot.emit('update:inputMode', 'write');
      await tick();
      f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
      await tick();
      assert.equal(f.calls.length, 1, 'first hide submits');
      f.captured.slot.emit('submit-intent', buildMultislotShowIntent(ID), ID);
      await tick();
      assert.equal(f.calls.length, 1, 'pending show never submits twice');
      assert.equal(f.captured.outcome()?.code, 'ERR_PLACEMENT_PENDING', 'pending guard toasts');
      assert.deepEqual(f.codes(), ['ERR_PLACEMENT_PENDING'], 'pending refusal is recorded first');
      f.calls[0].resolve(true);
      await tick();
      assert.deepEqual(f.codes(), ['ERR_PLACEMENT_PENDING', 'INTENT_ACKNOWLEDGED'], 'ack records exactly once');
      assert.deepEqual(f.feed().map(entry => entry.seq), [1, 2]);
    } finally { f.close(); }
  });

  test('missing intent port records the unavailable refusal', async () => {
    const f = await mountLane({ authorityHost: createAuthorityAdapter({}) });
    try {
      f.captured.slot.emit('update:inputMode', 'write');
      await tick();
      f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
      await tick();
      assert.equal(f.captured.outcome()?.code, 'HOST_REQUEST_REFUSED');
      assert.deepEqual(f.codes(), ['HOST_REQUEST_REFUSED'], 'missing-port refusal is recorded');
    } finally { f.close(); }
  });

  test('failed layout echo records the typed outcome after the ack', async () => {
    const f = await mountLane({ echoResult: { ok: false, error: { code: 'LAYOUT_UNKNOWN_SLOT' } } });
    try {
      f.captured.slot.emit('update:inputMode', 'write');
      await tick();
      f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
      await tick();
      f.calls[0].resolve(true);
      await tick();
      assert.equal(f.captured.outcome()?.code, 'LAYOUT_UNKNOWN_SLOT', 'echo failure toasts typed');
      assert.deepEqual(f.codes(), ['INTENT_ACKNOWLEDGED', 'LAYOUT_UNKNOWN_SLOT'],
        'both settled outcomes are recorded in order');
    } finally { f.close(); }
  });
});

describe('mvui19 fold refusals: own requests record, confusion does not (L3-2)', () => {
  test('hidden-surface fold records; foreign fold still invents nothing', async () => {
    const f = await mountLane();
    try {
      f.captured.slot.emit('update:inputMode', 'write');
      await tick();
      f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
      await tick();
      f.calls[0].resolve(true);
      await tick();
      assert.deepEqual(f.codes(), ['INTENT_ACKNOWLEDGED']);
      const sent = f.calls.length;
      f.captured.slot.emit('submit-intent', buildMultislotFoldIntent('fold', ID), ID);
      await tick();
      assert.equal(f.calls.length, sent, 'hidden fold never reaches the host');
      assert.equal(f.captured.outcome()?.code, 'LAYOUT_ILLEGAL_TRANSITION');
      assert.deepEqual(f.codes(), ['INTENT_ACKNOWLEDGED', 'LAYOUT_ILLEGAL_TRANSITION'],
        'hidden-fold refusal is recorded');
      f.captured.slot.emit('submit-intent',
        { ...buildMultislotFoldIntent('fold', ID), params: { slot_id: 'cuk-ai-slot-surface-b' } }, ID);
      await tick();
      assert.equal(f.calls.length, sent, 'foreign fold never reaches the host');
      assert.equal(f.codes().length, 2, 'foreign confusion invents no row (mvui6 contract)');
      f.captured.slot.emit('submit-intent', buildMultislotShowIntent(ID), ID);
      await tick();
      f.calls.at(-1).resolve(true);
      await tick();
      assert.deepEqual(f.codes(),
        ['INTENT_ACKNOWLEDGED', 'LAYOUT_ILLEGAL_TRANSITION', 'INTENT_ACKNOWLEDGED']);
    } finally { f.close(); }
  });

  test('negative controls: creative, bare control and local toggles stay out', async () => {
    const f = await mountLane();
    try {
      f.captured.wall.emit('submit-intent', { op: 'take_control', surfaceId: ID });
      await tick();
      f.captured.wall.emit('submit-intent', { type: 'creative/close' });
      await tick();
      f.captured.slot.emit('submit-intent', { type: 'hide-surface' }, ID);
      await tick();
      assert.equal(f.calls.length, 0, 'nothing submits');
      assert.deepEqual(f.feed(), [], 'non-authority outcomes never reach the feed');
      f.captured.wall.emit('submit-intent', wallTake(1));
      await tick();
      f.calls[0].resolve(true);
      await tick();
      assert.deepEqual(f.codes(), ['INTENT_ACKNOWLEDGED'], 'control still records after the negatives');
    } finally { f.close(); }
  });
});

describe('mvui19 count advances on every recorded entry (L3-2)', () => {
  test('fourteen mixed requests advance the live total one by one', async () => {
    const f = await mountLane();
    try {
      let expected = 0;
      const checkAdvance = (label) => {
        expected += 1;
        const feed = f.feed();
        assert.equal(mvActivityFeedTotal(feed), expected, `total advances: ${label}`);
        assert.equal(feed.at(-1)?.seq, expected, `sequence advances: ${label}`);
        const shown = Math.min(feed.length, MV_ACTIVITY_LIMIT);
        assert.equal(mvActivityCountText(shown, expected),
          expected > MV_ACTIVITY_LIMIT ? `latest ${shown} of ${expected}` : String(expected),
          `count copy advances: ${label}`);
      };
      const ackTake = async (id) => {
        f.captured.wall.emit('submit-intent', wallTake(id));
        await tick();
        f.calls.at(-1).resolve(true);
        await tick();
      };
      for (let i = 1; i <= 5; i += 1) { await ackTake(i); checkAdvance(`ack ${i}`); }
      for (let i = 1; i <= 4; i += 1) {
        f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
        await tick();
        checkAdvance(`READ refusal ${i}`);
      }
      f.state.verdict = { schema: 'action_verdict/v0.2', proposal_id: 'q', core_seq: 2, decision: 'refused', reason_code: 'POLICY' };
      f.captured.catalog.emit('create', { kind: 'browser' });
      await tick();
      checkAdvance('verdict refusal');
      f.state.verdict = { schema: 'action_verdict/v0.2', proposal_id: 'r', core_seq: 3, decision: 'admitted' };
      f.captured.catalog.emit('create', { kind: 'browser' });
      await tick();
      checkAdvance('verdict admission');
      f.captured.wall.emit('submit-intent', wallTake('fail'));
      await tick();
      f.calls.at(-1).reject(new Error('closed'));
      await tick();
      checkAdvance('transport refusal');
      await ackTake('last');
      checkAdvance('final ack');
      await ackTake('last2');
      checkAdvance('final ack 2');
      const feed = f.feed();
      assert.equal(feed.length, MV_ACTIVITY_LIMIT, 'window stays bounded');
      assert.deepEqual(feed.map(entry => entry.seq), [7, 8, 9, 10, 11, 12, 13, 14]);
      assert.equal(mvActivityCountText(feed.length, mvActivityFeedTotal(feed)), 'latest 8 of 14');
      for (const entry of feed) {
        const text = normalizeActivityEntry(entry)?.text ?? '';
        assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z_]+/, `no raw code in row text: ${text}`);
      }
    } finally { f.close(); }
  });

  test('rendered strip shows the live window label for the recorded feed', async () => {
    const f = await mountLane();
    try {
      for (let i = 1; i <= 10; i += 1) {
        if (i % 2 === 0) {
          f.captured.slot.emit('submit-intent', buildMultislotHideIntent(ID), ID);
          await tick();
        } else {
          f.captured.wall.emit('submit-intent', wallTake(i));
          await tick();
          f.calls.at(-1).resolve(true);
          await tick();
        }
      }
      const feed = f.feed();
      assert.equal(mvActivityFeedTotal(feed), 10);
      const Strip = await loadStrip();
      const props = vue.reactive({ entries: feed });
      const root = { children: [] };
      const app = renderer().createApp({ setup: () => () => vue.h(Strip, props) });
      app.mount(root);
      try {
        await tick();
        const count = find(root, n => typeof n.props?.class === 'string' && n.props.class.includes('mv-activity__count'))?.text;
        assert.equal(count, 'latest 8 of 10', 'strip renders the live count, not the frozen one');
      } finally { app.unmount(); delete globalThis.__mvui19strip; }
    } finally { f.close(); }
  });
});

async function loadStrip() {
  const stubButton = vue.defineComponent({
    props: { id: String, label: String },
    setup: props => () => vue.h('button', { id: props.id }, props.label),
  });
  globalThis.__mvui19strip = {
    'capsule-ui-kit/ui': { UiButton: stubButton },
    './activityModel.js': await import('../src/activity/activityModel.js'),
  };
  const stripUrl = new URL('../src/activity/ActivityStrip.vue', import.meta.url);
  const { descriptor } = parse(readFileSync(stripUrl, 'utf8'));
  let code = compileScript(descriptor, { id: 'mvui19-activity', inlineTemplate: true }).content;
  code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  const require = createRequire(import.meta.url);
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    assert.ok(spec in globalThis.__mvui19strip, `Unmapped SFC dependency: ${spec}`);
    return `const ${bindings.trim()} = globalThis.__mvui19strip[${JSON.stringify(spec)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui19s`)).default;
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

test('mvui19 activity feed: rss stays bounded', () => {
  const rss = process.memoryUsage.rss();
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
