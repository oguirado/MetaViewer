import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSfc, mount, slotStub, ui, byId, nodes, vue } from './mvui3-creative-harness.js';
import { parseStateQuery, resolveFixture } from '../src/fixtures/resolveState.js';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import * as adapters from '../src/core/hostAdapters.js';
import { createAgentLane } from '../src/agent/agentLane.js';

async function appComponent(captured) {
  const Capsule = await loadSfc('creative/CreativeCapsule.vue', { 'capsule-ui-kit/ui': ui });
  const Outcome = await loadSfc('core/HostOutcome.vue', { './hostAdapters.js': adapters });
  const wall = vue.defineComponent({ props: ['allowLostSurface'], setup: (p, ctx) => {
    captured.wall = ctx; captured.wallProps = p;
    ctx.expose({ revealSurface: id => { (captured.revealed ??= []).push(id); return { ok: true }; } });
    return () => vue.h('div');
  } });
  const agent = vue.defineComponent({ props: ['screen'], setup: p => () => { captured.screen = p.screen; return vue.h('aside'); } });
  const catalog = vue.defineComponent({ setup: (_p, ctx) => { captured.catalog = ctx; return () => vue.h('div'); } });
  return loadSfc('App.vue', {
    './creative/CreativeCapsule.vue': Capsule, './core/HostOutcome.vue': Outcome,
    'capsule-ui-kit/DockWorkspace': slotStub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: slotStub, TopBar: slotStub, Sidebar: slotStub, StatusBar: slotStub },
    'capsule-ui-kit/ui': ui, 'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wall, './wall/EmptyWallView.vue': vue.defineComponent({
      setup: () => () => vue.h('section', { id: 'empty-wall' }),
    }),
    './catalog/CatalogLauncher.vue': catalog, './terminal/SideTerminalOverlay.vue': slotStub,
    './multislot/MultislotHost.vue': slotStub, './recording/MvRecordingPanel.vue': slotStub,
    './settings/MvSettingsPanel.vue': slotStub, './agent/AgentLaneHost.vue': agent,
    './surfaces/SurfaceCanvas.vue': slotStub, './nested/nested.js': { resolveNestedMode, applyNestedWall },
    './surfaces/tileScheduler.js': { createTileScheduler },
  });
}
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };

for (const key of ['tile-states', 'four']) test(`App lost-row admission is scoped to the diagnostic fixture: ${key}`, async () => {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  let view;
  try {
    const rows = ['running', 'lost', 'destroyed'].map(backendLifecycle => ({
      id: backendLifecycle, title: backendLifecycle, backendLifecycle, visibility: 'unfolded', generation: 1,
    }));
    const captured = {}, App = await appComponent(captured);
    view = mount(App, { fixture: { key, ui: {}, capsules: rows }, layout: {}, scope: {},
      storage: { readRaw: async () => null, writeAtomic: async () => {} },
      runtime: { projectionView: { getProjection: () => ({ rows }), getSnapshot: () => ({}), subscribe: () => () => {} } },
    });
    await tick();
    assert.equal(captured.wallProps.allowLostSurface, key === 'tile-states');
    captured.wall.emit('wall-settled'); await tick();
    assert.deepEqual(captured.revealed, key === 'tile-states' ? ['running', 'lost'] : ['running']);
  } finally {
    view?.close(); globalThis.window = previous.window; globalThis.document = previous.document;
  }
});

test('creative toggle without a selected surface preserves the empty wall', async () => {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  let view;
  try {
    const captured = {}, App = await appComponent(captured);
    view = mount(App, { fixture: { key: 'empty', ui: {}, capsules: [] }, layout: {}, scope: {},
      storage: { readRaw: async () => null, writeAtomic: async () => {} } });
    await tick();
    assert.ok(byId(view.root, 'empty-wall'));
    const button = byId(view.root, 'shell-creative');
    assert.equal(button.props.disabled, true);
    button.props.onClick(); await tick();
    assert.ok(byId(view.root, 'empty-wall'), 'direct handler invocation also preserves the empty view');
    assert.equal(captured.screen, 'wall');
    assert.equal(byId(view.root, 'shell-creative').props['aria-expanded'], false);
  } finally {
    view?.close(); globalThis.window = previous.window; globalThis.document = previous.document;
  }
});
function agentRoot(root) {
  return { querySelectorAll: () => nodes(root).filter(n => n.props?.['data-semantic-anchor']).map(n => ({
    id: n.props.id, tagName: n.tag.toUpperCase(), textContent: n.text ?? '',
    getAttribute: key => n.props[key] == null ? null : String(n.props[key]),
    hasAttribute: key => Object.hasOwn(n.props, key),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  })) };
}

test('creative fixture boots, publishes controls, and routes creative requests to a typed unavailable row', async () => {
  assert.deepEqual(parseStateQuery('?state=creative'), { ok: true, key: 'creative' });
  assert.equal(parseStateQuery('?state=Creative').ok, false);
  const resolved = resolveFixture('creative');
  assert.equal(resolved.ok, true);
  const result = createFixtureRuntime(resolved.fixture);
  assert.equal(result.ok, true);
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  let view;
  try {
    const captured = {}, App = await appComponent(captured), events = [], hostCalls = [];
    view = mount(App, { ...result.mount, layout: {}, scope: {}, storage: { readRaw: async () => null, writeAtomic: async () => {} },
      authorityHost: { intent: async body => { hostCalls.push(body); return true; }, propose: async body => { hostCalls.push(body); return true; } },
      onSubmitIntent: intent => events.push(intent),
    });
    assert.equal(captured.screen, 'creative');
    const lane = createAgentLane({ root: agentRoot(view.root), screen: captured.screen, fixture: 'creative' });
    const snapshot = await lane.snapshot();
    for (const expected of resolved.fixture.expectedAnchors) {
      assert.ok(snapshot.controls.some(c => c.anchor === expected.anchor && c.role === expected.role), expected.anchor);
    }
    const prefix = 'capsule/cap-01/creative';
    for (const [id, expected] of [
      [`${prefix}/frame/frame-1/select`, { type: 'creative/select-frame', capsuleId: 'cap-01', frameId: 'frame-1' }],
      [`${prefix}/regenerate`, { type: 'creative/regenerate', capsuleId: 'cap-01' }],
    ]) {
      byId(view.root, id).props.onClick(); await tick();
      assert.deepEqual(events.at(-1), expected);
      const outcome = byId(view.root, 'mv-host-outcome');
      assert.equal(outcome.props['data-outcome-code'], 'CREATIVE_SERVICE_UNAVAILABLE');
      assert.match(outcome.text, /unavailable/i);
      assert.equal(hostCalls.length, 0, 'creative requests never cross the unsupported host boundary');
    }
    byId(view.root, 'shell-creative').props.onClick(); await tick();
    captured.wall.emit('submit-intent', { type: 'take_control', capsuleId: 'cap-01' }); await tick();
    assert.deepEqual(hostCalls, [{ op: 'take_control', surfaceId: 'cap-01' }]);
    assert.equal(byId(view.root, 'mv-host-outcome').props['data-outcome-code'], 'INTENT_ACKNOWLEDGED');
    captured.catalog.emit('create', { schema: 'proposal/v0.1', action: 'existing-catalog-event' }); await tick();
    assert.deepEqual(hostCalls.at(-1), { schema: 'proposal/v0.1', action: 'existing-catalog-event' });
    byId(view.root, 'shell-creative').props.onClick(); await tick();
    byId(view.root, `${prefix}/close`).props.onClick(); await tick();
    assert.equal(byId(view.root, `${prefix}/regenerate`), undefined);
    assert.deepEqual(events.at(-1), { type: 'creative/close', capsuleId: 'cap-01' });
    byId(view.root, 'shell-creative').props.onClick(); await tick();
    assert.ok(byId(view.root, `${prefix}/regenerate`));
    byId(view.root, 'shell-settings').props.onClick(); await tick();
    assert.equal(byId(view.root, `${prefix}/regenerate`), undefined);
    // A schema-looking unsupported creative event must still not reach a host.
    const count = hostCalls.length;
    captured.wall.emit('submit-intent', { type: 'creative/regenerate', op: 'take_control', capsuleId: 'cap-01' }); await tick();
    assert.equal(hostCalls.length, count);
    assert.equal(byId(view.root, 'mv-host-outcome').props['data-outcome-code'], 'CREATIVE_SERVICE_UNAVAILABLE');
  } finally {
    view?.close(); globalThis.window = previous.window; globalThis.document = previous.document;
  }
});

test('hostless creative requests remain observable and nested presentation has no creative controls', async () => {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  try {
    for (const nested of [false, true]) {
      const captured = {}, App = await appComponent(captured), events = [];
      const fixture = createFixtureRuntime('creative').mount;
      const view = mount(App, { ...fixture, nestedHost: nested ? { getNestedDepth: () => 1, getSelfCapsuleId: () => 'self' } : null,
        layout: {}, scope: {}, storage: { readRaw: async () => null, writeAtomic: async () => {} }, onSubmitIntent: v => events.push(v) });
      try {
        if (nested) {
          assert.equal(byId(view.root, 'shell-creative'), undefined);
          captured.wall?.emit('submit-intent', { type: 'creative/regenerate', capsuleId: 'cap-01' }); await tick();
          assert.deepEqual(events, []);
        } else {
          byId(view.root, 'capsule/cap-01/creative/regenerate').props.onClick(); await tick();
          assert.equal(events.length, 1);
          assert.equal(byId(view.root, 'mv-host-outcome').props['data-outcome-code'], 'CREATIVE_SERVICE_UNAVAILABLE');
        }
      } finally { view.close(); }
    }
  } finally { globalThis.window = previous.window; globalThis.document = previous.document; }
});
