// MVUI14 lane W: the agent chip claims 'acting' only with acting evidence.
// Regression: every control==='agent' tile rendered 'Agent acting', even when
// the agent was idle. The tile state derivation is untouched (control axis
// pins stay green); only the chip copy turns honest: 'Agent acting' with a
// busy session or an in-flight proposal — otherwise 'Agent ready'.
// UI-TILE: ownership alone (a live row with no finer signal) no longer reads
// acting; the old fallback pinned the idle-tile 'Agent acting' defect.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import { compileSfc, nodes, flush } from './mvui2-terminal-mount.mjs';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import {
  AGENT_ACTING_ACTIVITIES,
  AGENT_ACTING_OUTCOMES,
  controlAxisTile,
  isAgentActingRow,
} from '../src/wall/tileStates.js';
import * as tileStates from '../src/wall/tileStates.js';
import * as tileCapture from '../src/wall/tileCapture.js';

const Chrome = vue.defineComponent({
  setup: (_, ctx) => () => vue.h('div', {},
    Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
});
const CapsulePanel = await compileSfc('../.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue', {
  '../ui/UiTag.vue': Chrome, '../ui/UiToolbar.vue': Chrome,
});
const SidebarIcon = await compileSfc('../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue', {});
const SaasRecordButton = await compileSfc('../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue', {});
const TileCaptureChrome = await compileSfc('wall/TileCaptureChrome.vue', {
  '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue': SidebarIcon,
  '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue': SaasRecordButton,
  './tileCapture.js': tileCapture,
});
const SurfacePanel = await compileSfc('wall/SurfacePanel.vue', {
  'capsule-ui-kit/CapsulePanel': CapsulePanel,
  './tileStates.js': tileStates,
  './TileCaptureChrome.vue': TileCaptureChrome,
});

function mountComponent(component, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: (tag) => ({ tag, children: [], props: {}, style: {} }),
    createText: (content) => ({ text: content }),
    createComment: (content) => ({ text: content }),
    insert(node, parent, anchor) {
      if (node.parent) this.remove(node);
      node.parent = parent;
      const index = parent.children.indexOf(anchor);
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    },
    remove(node) {
      const list = node.parent?.children;
      if (list) list.splice(list.indexOf(node), 1);
    },
    setText(node, value) { node.text = value; },
    setElementText(node, value) { node.text = value; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: (node) => node.parent,
    nextSibling: () => null,
    setScopeId() {},
  });
  const app = renderer.createApp(component, props);
  app.mount(root);
  return { root, close: () => app.unmount() };
}

function agentRow(overrides = {}) {
  return {
    id: 'surface-a', surfaceId: 'surface-a', backendLifecycle: 'active', generation: 1,
    visibility: 'unfolded', control: 'agent', controlOwner: 'agent',
    attachmentState: 'live', ...overrides,
  };
}

function liveSnapshot(rows) {
  return {
    status: 'live', stale: false,
    envelope: { schema: 'surface/v0.1', epoch: 3, revision: 7, query: 'wall',
      projection: { rows } },
    error: null,
  };
}

function fakeView(snapshot) {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

const fakeBuilders = {
  visibility: () => ({}), control: () => ({}), presentation: () => ({}),
};

async function mountPanel(row) {
  const mounted = mountComponent(SurfacePanel, {
    capsuleId: 'surface-a', projectionView: fakeView(liveSnapshot([row])),
    intentBuilders: fakeBuilders, controlRegistry: {}, scheduler: {},
    tileScheduler: {}, title: 'Agent tile', presentationInstance: 'wall:surface-a',
  });
  await flush();
  return mounted;
}

function chipCopy(root) {
  const chip = nodes(root).find((n) => n.props?.class === 'cuk-capsule-panel__chip');
  assert.ok(chip, 'agent chip mounts');
  assert.equal(chip.props.role, 'status', 'chip keeps role=status');
  return nodes(chip).map((n) => n.text ?? '').join('').replace(/\s+/g, ' ');
}

function tileState(root) {
  return nodes(root).find((n) => n.props?.['data-tile-state']).props['data-tile-state'];
}

describe('acting evidence', () => {
  test('in-flight proposal outcomes are a closed frozen set', () => {
    assert.deepEqual(AGENT_ACTING_OUTCOMES, ['admitting', 'accepted', 'executing']);
    assert.equal(Object.isFrozen(AGENT_ACTING_OUTCOMES), true);
    assert.deepEqual(AGENT_ACTING_ACTIVITIES, ['busy']);
  });

  test('busy sessions and in-flight proposals read acting', () => {
    assert.equal(isAgentActingRow(agentRow({ aiSessionActivity: 'busy' })), true);
    for (const outcome of ['admitting', 'accepted', 'executing']) {
      assert.equal(isAgentActingRow(agentRow(
        { aiSessionActivity: 'ready', dispatchOutcome: outcome })), true, outcome);
    }
    assert.equal(isAgentActingRow(agentRow(
      { control: 'shared', aiSessionActivity: 'busy', dispatchOutcome: 'none' })), true);
  });

  test('idle, waiting, settled and terminal signals read not acting', () => {
    for (const activity of ['unknown', 'ready', 'waiting-input', 'waiting-permission',
      'exited', 'failed']) {
      assert.equal(isAgentActingRow(agentRow(
        { aiSessionActivity: activity, dispatchOutcome: 'none' })), false, activity);
    }
    for (const outcome of ['none', 'completed-unverified', 'verified', 'refused',
      'uncertain', 'cancelled']) {
      assert.equal(isAgentActingRow(agentRow(
        { aiSessionActivity: 'ready', dispatchOutcome: outcome })), false, outcome);
    }
  });

  test('rows without either signal read ready: ownership alone is not motion', () => {
    assert.equal(isAgentActingRow(agentRow()), false);
    const { aiSessionActivity, dispatchOutcome, ...rest } = agentRow();
    assert.equal(aiSessionActivity, undefined);
    assert.equal(dispatchOutcome, undefined);
    assert.equal(isAgentActingRow(rest), false);
    assert.equal(isAgentActingRow({ ...rest, controlOwner: 'human' }), false);
    assert.equal(isAgentActingRow({ ...rest, control: 'shared', controlOwner: 'none' }), false);
  });

  test('negative control: missing and malformed rows never read acting', () => {
    for (const bad of [null, undefined, 7, 'agent', [], {}]) {
      assert.equal(isAgentActingRow(bad), false, JSON.stringify(bad));
    }
  });

  test('control axis derivation is untouched by chip honesty', () => {
    assert.equal(controlAxisTile(agentRow({ aiSessionActivity: 'ready' })), 'agent-acting');
    assert.equal(controlAxisTile(agentRow()), 'agent-acting');
  });
});

describe('mounted agent chip', () => {
  test('busy agent renders Agent acting on the agent-acting tile', async () => {
    const mounted = await mountPanel(agentRow({ aiSessionActivity: 'busy' }));
    try {
      assert.equal(tileState(mounted.root), 'agent-acting');
      assert.match(chipCopy(mounted.root), /Agent acting/);
    } finally { mounted.close(); }
  });

  test('idle agent renders Agent ready without moving the tile state', async () => {
    const mounted = await mountPanel(
      agentRow({ aiSessionActivity: 'ready', dispatchOutcome: 'none' }));
    try {
      assert.equal(tileState(mounted.root), 'agent-acting');
      assert.match(chipCopy(mounted.root), /Agent ready/);
      assert.doesNotMatch(chipCopy(mounted.root), /Agent acting/);
    } finally { mounted.close(); }
  });

  test('executing proposal renders Agent acting; verified renders Agent ready', async () => {
    const acting = await mountPanel(agentRow(
      { aiSessionActivity: 'ready', dispatchOutcome: 'executing' }));
    try {
      assert.match(chipCopy(acting.root), /Agent acting/);
    } finally { acting.close(); }
    const ready = await mountPanel(agentRow(
      { aiSessionActivity: 'ready', dispatchOutcome: 'verified' }));
    try {
      assert.match(chipCopy(ready.root), /Agent ready/);
    } finally { ready.close(); }
  });

  test('live authority rows without signals read Agent ready', async () => {
    let emit;
    const runtime = createAuthorityRuntime({
      subscribeFrames(callback) { emit = callback; return () => {}; },
    });
    emit({
      frame_ref: { schema: 'frame_ref/v0.2', surface_id: 'surface-a', generation: 1,
        tick: 0, ts_ns: 0, capture_us: 0, width: 1, height: 1,
        format: 'rgb24', sha256: 'a'.repeat(64) },
      surface: { schema: 'surface/v0.2', surface_id: 'surface-a', kind: 'desktop_capsule',
        display: 'Desktop', geometry: { w: 1, h: 1 }, profile_id: 'default',
        state: 'active', visibility: 'unfolded', control: 'agent' },
    });
    const mounted = mountComponent(SurfacePanel, {
      capsuleId: 'surface-a', projectionView: runtime.projectionView,
      intentBuilders: fakeBuilders, controlRegistry: {}, scheduler: {},
      tileScheduler: {}, title: 'Desktop', presentationInstance: 'wall:surface-a',
    });
    try {
      await flush();
      assert.equal(tileState(mounted.root), 'agent-acting');
      assert.match(chipCopy(mounted.root), /Agent ready/);
      assert.doesNotMatch(chipCopy(mounted.root), /Agent acting/);
    } finally { mounted.close(); runtime.dispose(); }
  });

  test('negative control: human and shared tiles keep their copy', async () => {
    const human = await mountPanel(agentRow(
      { control: 'human', controlOwner: 'human', aiSessionActivity: 'ready' }));
    try {
      assert.equal(tileState(human.root), 'human-control');
      assert.match(chipCopy(human.root), /Human control/);
    } finally { human.close(); }
    const shared = await mountPanel(agentRow(
      { control: 'shared', controlOwner: 'none', aiSessionActivity: 'ready' }));
    try {
      assert.equal(tileState(shared.root), 'live');
      assert.match(chipCopy(shared.root), /Live/);
    } finally { shared.close(); }
  });
});
