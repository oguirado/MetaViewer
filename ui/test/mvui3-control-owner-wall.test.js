import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import { compileSfc, nodes, flush } from './mvui2-terminal-mount.mjs';
import { createAuthorityRuntime, createAuthorityAdapter } from '../src/core/hostAdapters.js';
import * as tileStates from '../src/wall/tileStates.js';
import * as tileCapture from '../src/wall/tileCapture.js';
import { intentSchema, validates } from './mvui-x-schema.js';

// Only decorative children and Dockview hosting are replaced. The control
// inventory, projection reader, button and event handler are the real kit SFC.
const Chrome = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {},
  Object.values(ctx.slots).flatMap(slot => slot?.() ?? [])) });
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
  'capsule-ui-kit/CapsulePanel': CapsulePanel, './tileStates.js': tileStates,
  './TileCaptureChrome.vue': TileCaptureChrome,
});
const Workspace = vue.defineComponent({
  props: ['panelComponents'],
  setup: props => () => vue.h(props.panelComponents.CapsulePanel, {
    params: { api: { id: 'capsule:surface-a', title: 'Desktop' }, params: { capsuleId: 'surface-a' } },
  }),
});
const Wall = await compileSfc('wall/WallWorkspace.vue', {
  'capsule-ui-kit/DockWorkspace': Workspace, './SurfacePanel.vue': SurfacePanel,
});

// v-show in the real CapsulePanel needs an element style object. Keep this
// renderer local instead of changing the shared terminal test harness.
function mountComponent(component, props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, children: [], props: {}, style: {} }),
    createText: text => ({ text }), createComment: text => ({ text }),
    insert(node, parent, anchor) {
      if (node.parent) this.remove(node);
      node.parent = parent;
      const index = parent.children.indexOf(anchor);
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    },
    remove(node) { const list = node.parent?.children; if (list) list.splice(list.indexOf(node), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    patchProp(node, key, _old, value) { node.props[key] = value; },
    parentNode: node => node.parent, nextSibling: () => null, setScopeId() {},
  });
  const app = renderer.createApp(component, props);
  app.mount(root);
  return { root, app };
}

function notice(control, state = 'active') {
  return {
    frame_ref: { schema: 'frame_ref/v0.2', surface_id: 'surface-a', generation: 1,
      tick: 0, ts_ns: 0, capture_us: 0, width: 1, height: 1,
      format: 'rgb24', sha256: 'a'.repeat(64) },
    surface: { schema: 'surface/v0.2', surface_id: 'surface-a', kind: 'desktop_capsule',
      display: 'Desktop', geometry: { w: 1, h: 1 }, profile_id: 'default',
      state, visibility: 'unfolded', control },
  };
}

async function harness(initial) {
  let emit;
  const sent = [];
  const port = { subscribeFrames(callback) { emit = callback; return () => {}; },
    async intent(json) { sent.push(JSON.parse(json)); return true; } };
  const runtime = createAuthorityRuntime(port);
  const adapter = createAuthorityAdapter(port);
  if (initial) emit(initial);
  const mounted = mountComponent(Wall, {
    workspaceComponent: Workspace, scope: {}, storage: {}, ownerWindowId: 'main-wall',
    ...runtime, tileScheduler: {}, onSubmitIntent: body => adapter.intent(body),
  });
  await flush();
  return { runtime, sent, emit, root: mounted.root,
    buttons: () => nodes(mounted.root).filter(n => n.props?.['data-semantic-anchor'] === 'capsule/surface-a/control'),
    close() { mounted.app.unmount(); runtime.dispose(); } };
}

test('authority notices drive real kit owner, pressed state and schema-valid take/release without a lease', async () => {
  const h = await harness(notice('agent'));
  try {
    for (const [control, owner, tile, op] of [
      ['agent', 'agent', 'agent-acting', 'take_control'],
      ['human', 'human', 'human-control', 'release_control'],
      ['shared', 'none', 'live', 'take_control'],
      ['human', 'human', 'human-control', 'release_control'],
    ]) {
      h.emit(notice(control)); await flush();
      const row = h.runtime.projectionView.getProjection().rows[0];
      assert.equal(row.control, control);
      assert.equal(row.controlOwner, owner);
      assert.equal(Object.hasOwn(row, 'controlLeaseId'), false);
      assert.equal(nodes(h.root).find(n => n.props?.['data-tile-state']).props['data-tile-state'], tile);
      const shot = nodes(h.root).find(n => n.props?.['data-semantic-anchor'] === 'tile-surface-a-screenshot');
      assert.ok(shot, 'real tile capture chrome mounts alongside ownership controls');
      assert.equal(shot.props.disabled, true, 'missing capture store disables screenshot');
      assert.ok(nodes(shot).some(n => n.tag === 'svg'), 'real kit screenshot icon mounts');
      const buttons = h.buttons();
      assert.ok(buttons.length > 0);
      for (const button of buttons) {
        assert.equal(button.props['aria-pressed'], String(owner === 'human'));
        assert.equal(button.props['aria-label'], `${owner === 'human' ? 'Release' : 'Take'} control of default`);
        assert.equal(button.props.disabled, false);
      }
      const count = h.sent.length;
      buttons[0].props.onClick(); await flush();
      assert.equal(h.sent.length, count + 1, 'one gesture submits exactly once');
      const body = h.sent.at(-1);
      assert.equal(validates(intentSchema, body), true);
      assert.equal(body.op, op);
      assert.deepEqual(body.params, { surface_id: 'surface-a' });
      assert.equal(validates(intentSchema, { ...body, params: { ...body.params, controlLeaseId: 'invented' } }), false);
    }
    assert.equal(new Set(h.sent.map(body => body.request_id)).size, h.sent.length);
  } finally { h.close(); }
});

test('invalid ownership and invented leases cannot overwrite admitted control', async () => {
  const h = await harness(notice('agent'));
  try {
    for (const bad of [notice('none'), notice(null), { ...notice('human'),
      surface: { ...notice('human').surface, controlLeaseId: 'invented' } }]) {
      const rows = h.runtime.projectionView.getProjection().rows;
      h.emit(bad); await flush();
      assert.equal(h.runtime.projectionView.getSnapshot().error.code, 'ERR_FRAME_NOTICE');
      assert.deepEqual(h.runtime.projectionView.getProjection().rows, rows);
      assert.ok(h.buttons().every(b => b.props['aria-pressed'] === 'false'));
      assert.equal(h.sent.length, 0);
    }
  } finally { h.close(); }
});

test('missing rows and terminal surfaces disable the kit control button', async () => {
  const h = await harness();
  try {
    for (const update of [null, notice('human', 'lost'), notice('human', 'destroyed')]) {
      if (update) h.emit(update);
      await flush();
      assert.ok(h.buttons().length > 0);
      assert.ok(h.buttons().every(b => b.props.disabled === true));
      h.buttons()[0].props.onClick(); await flush();
      assert.equal(h.sent.length, 0);
    }
  } finally { h.close(); }
});
