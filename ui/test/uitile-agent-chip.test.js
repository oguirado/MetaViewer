// UI-TILE: an idle agent-owned tile (control agent, no busy session, no
// in-flight proposal, no authority activity) read 'Agent acting' because
// isAgentActingRow fell back to ownership when the row projected neither
// signal — and the live authority feed never projects either. The chip now
// claims motion only with acting evidence; the tile state stays agent-acting.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import { compileSfc, nodes, flush } from './mvui2-terminal-mount.mjs';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import { controlAxisTile, isAgentActingRow } from '../src/wall/tileStates.js';
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

function liveAuthorityRuntime(control) {
  let emit;
  const runtime = createAuthorityRuntime({
    subscribeFrames(callback) { emit = callback; return () => {}; },
  });
  emit({
    frame_ref: { schema: 'frame_ref/v0.2', surface_id: 'surface-a', generation: 3,
      tick: 0, ts_ns: 0, capture_us: 0, width: 1280, height: 900,
      format: 'rgb24', sha256: 'c'.repeat(64) },
    surface: { schema: 'surface/v0.2', surface_id: 'surface-a', kind: 'browser',
      display: 'mv-live-1', geometry: { w: 1280, h: 900 }, profile_id: 'default',
      state: 'active', visibility: 'unfolded', control },
  });
  return runtime;
}

describe('UI-TILE agent chip', () => {
  test('idle: agent control without any signal reads Agent ready', () => {
    assert.equal(isAgentActingRow(agentRow()), false);
    assert.equal(isAgentActingRow(agentRow({ control: 'agent', controlOwner: undefined })), false);
    assert.equal(controlAxisTile(agentRow()), 'agent-acting', 'tile state unchanged');
  });

  test('busy: a busy session or an in-flight proposal reads Agent acting', () => {
    assert.equal(isAgentActingRow(agentRow({ aiSessionActivity: 'busy' })), true);
    for (const outcome of ['admitting', 'accepted', 'executing']) {
      assert.equal(isAgentActingRow(agentRow({ dispatchOutcome: outcome })), true, outcome);
    }
  });

  test('human control never reads acting', () => {
    assert.equal(isAgentActingRow(agentRow({ control: 'human', controlOwner: 'human' })), false);
    assert.equal(controlAxisTile(agentRow({ control: 'human', controlOwner: 'human' })), 'human-control');
  });

  test('mounted idle live authority tile renders Agent ready', async () => {
    const runtime = liveAuthorityRuntime('agent');
    const row = runtime.projectionView.getProjection().rows[0];
    assert.equal(row.aiSessionActivity, undefined, 'live feed projects no session activity');
    assert.equal(row.dispatchOutcome, undefined, 'live feed projects no dispatch outcome');
    const mounted = mountComponent(SurfacePanel, {
      capsuleId: 'surface-a', projectionView: runtime.projectionView,
      intentBuilders: fakeBuilders, controlRegistry: {}, scheduler: {},
      tileScheduler: {}, title: 'mv-live-1', presentationInstance: 'wall:surface-a',
    });
    try {
      await flush();
      assert.equal(tileState(mounted.root), 'agent-acting');
      assert.match(chipCopy(mounted.root), /Agent ready/);
      assert.doesNotMatch(chipCopy(mounted.root), /Agent acting/);
    } finally { mounted.close(); runtime.dispose(); }
  });

  test('mounted busy tile renders Agent acting', async () => {
    const mounted = await mountPanel(agentRow({ aiSessionActivity: 'busy' }));
    try {
      assert.equal(tileState(mounted.root), 'agent-acting');
      assert.match(chipCopy(mounted.root), /Agent acting/);
    } finally { mounted.close(); }
  });

  test('mounted in-flight proposal renders Agent acting, settled renders Agent ready', async () => {
    const acting = await mountPanel(agentRow({ dispatchOutcome: 'executing' }));
    try { assert.match(chipCopy(acting.root), /Agent acting/); } finally { acting.close(); }
    const settled = await mountPanel(agentRow({ dispatchOutcome: 'verified' }));
    try { assert.match(chipCopy(settled.root), /Agent ready/); } finally { settled.close(); }
  });

  test('mounted human-control tile renders Human control (negative control)', async () => {
    const runtime = liveAuthorityRuntime('human');
    const mounted = mountComponent(SurfacePanel, {
      capsuleId: 'surface-a', projectionView: runtime.projectionView,
      intentBuilders: fakeBuilders, controlRegistry: {}, scheduler: {},
      tileScheduler: {}, title: 'mv-live-1', presentationInstance: 'wall:surface-a',
    });
    try {
      await flush();
      assert.equal(tileState(mounted.root), 'human-control');
      assert.match(chipCopy(mounted.root), /Human control/);
      assert.doesNotMatch(chipCopy(mounted.root), /Agent/);
    } finally { mounted.close(); runtime.dispose(); }
  });
});
