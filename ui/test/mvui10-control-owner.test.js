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

// Mutant view removes only the adapter ownership field, on both initial and
// pushed snapshots. The authoritative control and all other row data survive.
function withoutOwner(view) {
  const mutate = snapshot => ({ ...snapshot, envelope: snapshot.envelope && {
    ...snapshot.envelope, projection: { ...snapshot.envelope.projection,
      rows: snapshot.envelope.projection.rows.map(({ controlOwner, ...row }) => row) },
  } });
  return { getSnapshot: () => mutate(view.getSnapshot()),
    subscribe: listener => view.subscribe(snapshot => listener(mutate(snapshot))) };
}

async function harness(dropMapping = false) {
  let emit;
  const sent = [];
  const port = { subscribeFrames(callback) { emit = callback; return () => {}; },
    async intent(json) { sent.push(JSON.parse(json)); return true; } };
  const runtime = createAuthorityRuntime(port);
  const adapter = createAuthorityAdapter(port);
  emit(notice('agent'));
  const projectionView = dropMapping ? withoutOwner(runtime.projectionView) : runtime.projectionView;
  const mounted = mountComponent(SurfacePanel, { ...runtime, projectionView,
    capsuleId: 'surface-a', title: 'Desktop', presentationInstance: 'wall:surface-a',
    tileScheduler: {}, onSubmitIntent: body => adapter.intent(body) });
  await flush();
  return { runtime, sent, root: mounted.root,
    async update(control) { emit(notice(control)); await flush(); },
    button() {
      const button = nodes(mounted.root).find(n => n.props?.['data-semantic-anchor'] === 'capsule/surface-a/control');
      assert.ok(button, 'real kit control button is mounted through SurfacePanel');
      assert.equal(button.props.disabled, false);
      return button;
    },
    tile() { return nodes(mounted.root).find(n => n.props?.['data-tile-state']).props['data-tile-state']; },
    close() { mounted.app.unmount(); runtime.dispose(); } };
}

function assertButton(h, verb) {
  const button = h.button();
  assert.equal(button.props['aria-label'], `${verb === 'release_control' ? 'Release' : 'Take'} control of default`);
  assert.equal(button.props['aria-pressed'], String(verb === 'release_control'));
}
async function click(h, verb) {
  assertButton(h, verb);
  const count = h.sent.length;
  h.button().props.onClick(); await flush();
  assert.equal(h.sent.length, count + 1, 'one click emits exactly one authority intent');
  assert.equal(h.sent.at(-1).op, verb);
  assert.equal(validates(intentSchema, h.sent.at(-1)), true);
  assert.deepEqual(h.sent.at(-1).params, { surface_id: 'surface-a' });
}

test('MVUI10 real kit button takes, releases and returns to authoritative agent-acting', async () => {
  const h = await harness();
  try {
    assert.equal(h.tile(), 'agent-acting');
    await click(h, 'take_control');
    assertButton(h, 'take_control'); // A true ack does not confer ownership.
    await h.update('human');
    assert.equal(h.tile(), 'human-control');
    assert.ok(nodes(h.root).some(n => n.text === 'Human control'));
    await click(h, 'release_control');
    assertButton(h, 'release_control'); // Release also waits for authority.
    await h.update('agent');
    assert.equal(h.tile(), 'agent-acting', 'release restores authoritative tile state');
    assert.ok(nodes(h.root).some(n => n.text === 'Agent acting'));
    assertButton(h, 'take_control');
    await click(h, 'take_control');
    assert.deepEqual(h.sent.map(body => body.op), ['take_control', 'release_control', 'take_control']);
    const row = h.runtime.projectionView.getProjection().rows[0];
    assert.equal(row.control, 'agent');
    assert.equal(row.controlOwner, 'agent');
    assert.equal(Object.hasOwn(row, 'controlLeaseId'), false, 'no authority lease exists to forward');
  } finally { h.close(); }
});

test('MVUI10 negative control: dropping owner mapping makes the second click take again', async () => {
  const h = await harness(true);
  try {
    await click(h, 'take_control');
    await h.update('human');
    assert.equal(h.tile(), 'human-control', 'legacy control consumers still see authoritative human state');
    assert.throws(() => assertButton(h, 'release_control'), assert.AssertionError);
    await click(h, 'take_control');
    assert.deepEqual(h.sent.map(body => body.op), ['take_control', 'take_control']);
  } finally { h.close(); }
});

test('MVUI10 shared control has no exclusive owner and offers take without inventing a lease', async () => {
  const h = await harness();
  try {
    await h.update('shared');
    const row = h.runtime.projectionView.getProjection().rows[0];
    assert.equal(row.control, 'shared');
    assert.equal(row.controlOwner, 'none');
    assert.equal(Object.hasOwn(row, 'controlLeaseId'), false);
    assert.equal(h.tile(), 'live');
    await click(h, 'take_control');
  } finally { h.close(); }
});
