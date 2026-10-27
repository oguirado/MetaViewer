import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';
import { parse } from '@vue/compiler-sfc';
import { compileSfc, mountComponent, nodes, flush } from './mvui2-terminal-mount.mjs';
import { installAgentLane } from '../src/agent/agentLane.js';
import { buildMultislotFoldIntent, multislotSlotId } from '../src/multislot/multislotInputGate.js';

const Empty = vue.defineComponent({ setup: () => () => null });
const Wrap = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, ctx.slots.default?.()) });
const Button = vue.defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => vue.h('button', ctx.attrs) });
const kitFile = new URL('../.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue', import.meta.url);
const kitScript = parse(readFileSync(kitFile, 'utf8')).descriptor.script.content;
const kitHelpers = await import(`data:text/javascript;base64,${Buffer.from(kitScript).toString('base64')}`);
test('shared multislot slot identity is pinned to the kit registry', () => {
  for (const id of ['cap-01', 'capsule-with-hyphens', 'cap_02']) {
    assert.equal(multislotSlotId(id), kitHelpers.multislotDomIds(id).root);
    assert.equal(buildMultislotFoldIntent('unfold', id).params.slot_id, multislotSlotId(id));
  }
});
const Slot = vue.defineComponent({
  props: ['folded', 'capsuleId'], emits: ['submit-intent'],
  setup: (props, ctx) => () => vue.h('button', {
    id: kitHelpers.multislotDomIds(props.capsuleId).fold,
    'data-semantic-anchor': `capsule/${props.capsuleId}/fold`,
    'aria-expanded': !props.folded,
    onClick: () => ctx.emit('submit-intent', { type: props.folded ? 'unfold' : 'fold' }),
  }),
});
async function compile(file, overrides = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const deps = {};
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g)) {
    const spec = match[2];
    if (spec === 'vue') continue;
    if (spec in overrides) deps[spec] = overrides[spec];
    else if (spec.endsWith('.js') && spec.startsWith('.')) deps[spec] = await import(new URL(spec, new URL(`../src/${file}`, import.meta.url)));
    else if (match[1].trim().startsWith('{')) deps[spec] = new Proxy({}, { get: () => () => {} });
    else deps[spec] = Empty;
  }
  return compileSfc(file, deps);
}

for (const withHost of [true, false]) test(`App multislot fold/unfold with host=${withHost}`, async () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let mounted;
  try {
    const Multislot = await compile('multislot/MultislotHost.vue', {
      '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue': Slot,
      '@xterm/xterm': { Terminal: class {} },
      'capsule-ui-kit/TerminalView': { createStreamRegistry: () => ({}) },
    });
    assert.equal(globalThis.__mvui2v1Deps, undefined, 'compile dependency global is cleaned');
    const App = await compile('App.vue', {
      './multislot/MultislotHost.vue': Multislot,
      '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: Wrap, TopBar: Wrap, Sidebar: Empty, StatusBar: Empty },
      'capsule-ui-kit/ui': { UiButton: Button },
    });
    const calls = [];
    const row = { id: 'cap-01', title: 'Capsule', visibility: 'unfolded', generation: 1 };
    const feed = { getProjection: () => ({ rows: [row] }), getSnapshot: () => ({}), subscribe: () => () => {} };
    mounted = mountComponent(App, {
      fixture: { key: 'multislot', ui: {}, capsules: [row] }, layout: {}, scope: {}, storage: {},
      runtime: { projectionView: feed },
      authorityHost: withHost ? { intent: async body => { calls.push(body); return true; } } : null,
    });
    await flush();
    const button = () => nodes(mounted.root).find(n => n.props?.id === 'cuk-ai-slot-cap-01-fold');
    assert.equal(button().props['aria-expanded'], true);
    button().props.onClick(); await flush();
    assert.equal(button().props['aria-expanded'], false, 'fold changes the controlled presentation');
    button().props.onClick(); await flush();
    assert.equal(button().props['aria-expanded'], true, 'unfold restores presentation');
    if (withHost) {
      assert.deepEqual(calls.map(c => c.op), ['fold', 'unfold']);
      const schema = JSON.parse(readFileSync(new URL('../../contracts/v0.2/ui_intent.schema.json', import.meta.url)));
      for (const body of calls) {
        const branch = schema.oneOf.find(b => b.properties.op.const === body.op);
        assert.deepEqual(Object.keys(body).sort(), [...branch.required].sort());
        assert.equal(body.schema, branch.properties.schema.const);
        assert.match(body.request_id, new RegExp(branch.properties.request_id.pattern));
        assert.deepEqual(Object.keys(body.params), branch.properties.params.required);
        assert.equal(body.params.slot_id, kitHelpers.multislotDomIds(row.id).root);
        assert.match(body.params.slot_id, new RegExp(branch.properties.params.properties.slot_id.pattern));
      }
      assert.notEqual(calls[0].request_id, calls[1].request_id);
    }
  } finally {
    mounted?.app.unmount(); Object.assign(globalThis, previous);
  }
});

for (const reply of ['false', 'undefined', 'truthy', 'typed', 'reject', 'true', 'no-port']) {
  test(`App waits for literal host acknowledgement before unfolding: ${reply}`, async () => {
    const previous = { document: globalThis.document, window: globalThis.window };
    globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    let mounted;
    try {
      const Multislot = await compile('multislot/MultislotHost.vue', {
        '/.kit/capsule-ui-kit/src/multislot/AiMultiSlot.vue': Slot,
        '@xterm/xterm': { Terminal: class {} },
        'capsule-ui-kit/TerminalView': { createStreamRegistry: () => ({}) },
      });
      const HostOutcome = await compile('core/HostOutcome.vue');
      const App = await compile('App.vue', {
        './core/HostOutcome.vue': HostOutcome,
        './multislot/MultislotHost.vue': Multislot,
        '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: Wrap, TopBar: Wrap, Sidebar: Empty, StatusBar: Empty },
        'capsule-ui-kit/ui': { UiButton: Button },
      });
      let settle;
      const pending = new Promise((resolve, reject) => { settle = () => reply === 'reject'
        ? reject(new Error('wire refusal')) : resolve(({ false: false, undefined: undefined, truthy: 1,
          typed: { code: 'POLICY', tone: 'refusal', message: 'Refused' }, true: true })[reply]); });
      const calls = [];
      const row = { id: 'cap-01', title: 'Capsule', visibility: 'folded', generation: 1 };
      let publish;
      const feed = { getProjection: () => ({ rows: [row] }), getSnapshot: () => ({}),
        subscribe: callback => { publish = callback; return () => {}; } };
      mounted = mountComponent(App, {
        fixture: { key: 'multislot', ui: {}, capsules: [row] }, layout: {}, scope: {}, storage: {},
        runtime: { projectionView: feed },
        authorityHost: reply === 'no-port' ? {} : { intent: body => { calls.push(body); return pending; } },
      });
      await flush();
      const button = () => nodes(mounted.root).find(n => n.props?.id === kitHelpers.multislotDomIds(row.id).fold);
      assert.equal(button().props['aria-expanded'], false);
      button().props.onClick(); await flush();
      assert.equal(button().props['aria-expanded'], false, 'pending request keeps authoritative folded presentation');
      if (reply !== 'no-port') {
        assert.equal(calls.length, 1);
        assert.equal(calls[0].op, 'unfold');
        settle(); await flush();
      }
      assert.equal(button().props['aria-expanded'], reply === 'true');
      const outcome = nodes(mounted.root).find(n => n.props?.id === 'mv-host-outcome');
      assert.ok(outcome, 'typed outcome row is rendered');
      assert.equal(outcome.props['data-outcome-code'], reply === 'true' ? 'INTENT_ACKNOWLEDGED' : 'HOST_REQUEST_REFUSED');
      assert.equal(outcome.props.role, reply === 'true' ? 'status' : 'alert');
      publish({}); await flush();
      assert.equal(button().props['aria-expanded'], reply === 'true', 'unchanged authority feed cannot create divergence after refusal');
      row.visibility = 'unfolded'; publish({}); await flush();
      row.visibility = 'folded'; publish({}); await flush();
      assert.equal(button().props['aria-expanded'], false, 'authoritative changes clear acknowledged overrides');
    } finally {
      mounted?.app.unmount(); Object.assign(globalThis, previous);
    }
  });
}

test('AgentLaneHost preserves identity and bench sequence across screen transitions', async () => {
  const previous = globalThis.document;
  globalThis.document = { querySelectorAll: () => [] };
  let mounted;
  try {
    const Host = await compileSfc('agent/AgentLaneHost.vue', { './agentLane.js': { installAgentLane } });
    mounted = mountComponent(Host, { enabled: true, fixtureKey: 'multislot', screen: 'wall' });
    const lane = globalThis.__agentLane;
    const ids = [];
    for (const screen of ['wall', 'multislot', 'settings', 'wall']) {
      mounted.props.screen = screen; await flush();
      assert.equal(globalThis.__agentLane, lane);
      assert.equal((await lane.snapshot()).screen, screen);
      ids.push(globalThis.__benchCaptureFrame({ raw_sha256: 'a'.repeat(64) }).snapshot);
    }
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    mounted?.app.unmount(); globalThis.document = previous;
  }
  assert.equal(globalThis.__agentLane, undefined);
});
