import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import { compileSfc, nodes, flush, text } from './mvui2-terminal-mount.mjs';
import { createFixtureRuntime } from '../src/fixtures/fixtureRuntime.js';
import * as tileStates from '../src/wall/tileStates.js';

const Chrome = vue.defineComponent({ props: ['label'], setup: (p, c) => () => vue.h('div', {},
  [p.label, ...Object.values(c.slots).flatMap(slot => slot?.() ?? [])]) });
const CapsulePanel = await compileSfc('../.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue', {
  '../ui/UiTag.vue': Chrome, '../ui/UiToolbar.vue': Chrome,
});
const SurfacePanel = await compileSfc('wall/SurfacePanel.vue', {
  'capsule-ui-kit/CapsulePanel': CapsulePanel, './tileStates.js': tileStates,
});
let rows = [];
// Real renderer tabs and kit panels share a mounted wall; only Dockview hosting
// and decorative kit children are replaced.
const Workspace = vue.defineComponent({
  props: ['panelComponents', 'tabComponents'],
  setup(p) {
    vue.provide('capsuleWindowPresentation', {
      revision: vue.ref(0), get: () => ({ state: () => ({ hidden: false, floating: false, maximized: false }) }),
    });
    return () => vue.h('main', {}, rows.flatMap(row => {
      const params = { api: { id: `panel-${row.id}`, title: row.title }, params: { capsuleId: row.id } };
      return [vue.h(p.tabComponents.SurfaceTab, { params }), vue.h(p.panelComponents.CapsulePanel, { params })];
    }));
  },
});
const Wall = await compileSfc('wall/WallWorkspace.vue', {
  'capsule-ui-kit/DockWorkspace': Workspace, './SurfacePanel.vue': SurfacePanel,
});
function mount(props) {
  const root = { children: [] };
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, children: [], props: {}, style: {} }),
    createText: text => ({ text }), createComment: () => ({ text: '' }),
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
  const app = renderer.createApp(Wall, props); app.mount(root);
  return { root, close: () => app.unmount() };
}
function uniqueAnchors(controls) {
  const anchors = controls.map(n => n.props['data-semantic-anchor']);
  assert.equal(new Set(anchors).size, anchors.length, anchors.join(', '));
}
function expectedAnchors(controls, expected) {
  for (const row of expected) {
    const found = controls.filter(n => n.props?.['data-semantic-anchor'] === row.anchor);
    if (row.ifPresent && !found.length) continue;
    assert.equal(found.length, 1, row.anchor);
    assert.equal(found[0].props.role ?? (found[0].tag === 'button' ? 'button' : null), row.role, row.anchor);
  }
}
for (const colorScheme of ['light', 'dark']) {
  test(`mounted fixture states, accessible labels and unique anchors (${colorScheme})`, async () => {
    const result = createFixtureRuntime('tile-states'); assert.equal(result.ok, true);
    const { fixture, runtime } = result.mount;
    rows = runtime.projectionView.getProjection().rows;
    const mounted = mount({ ...runtime, workspaceComponent: Workspace, scope: {}, storage: {},
      ownerWindowId: 'main-wall', colorScheme, allowLostSurface: true });
    try {
      await flush();
      const tiles = nodes(mounted.root).filter(n => n.props?.['data-tile-state']);
      assert.deepEqual(tiles.map(n => n.props['data-tile-state']), tileStates.TILE_STATES);
      const labels = ['Connecting', 'Live', 'Folded', 'Human control', 'Agent acting', 'Lost', 'Surface update unavailable'];
      for (const [i, tile] of tiles.entries()) {
        const chip = nodes(tile).find(n => n.props?.class === 'cuk-capsule-panel__chip');
        assert.ok(chip, rows[i].id); assert.equal(chip.props.role, 'status');
        assert.match(text(chip), new RegExp(labels[i]));
        const panel = nodes(tile).find(n => n.props?.['data-capsule-id']);
        assert.equal(panel.props['data-backend-lifecycle'], rows[i].backendLifecycle);
        assert.equal(panel.props['data-attachment-state'], rows[i].attachmentState);
        assert.ok(nodes(tile).some(n => n.props?.role === 'tab' && n.props['aria-label'].includes(rows[i].title)));
      }
      assert.equal(nodes(tiles[2]).find(n => n.props?.['data-permanent-host']).style.display, 'none');
      const controls = nodes(mounted.root).filter(n => n.props?.['data-semantic-anchor']);
      uniqueAnchors(controls);
      for (const row of rows) {
        assert.equal(controls.filter(n => n.props['data-semantic-anchor'] === `capsule/${row.id}/tab`).length, 1);
        assert.equal(controls.filter(n => n.props['data-semantic-anchor'] === `workspace/tab/${row.id}`).length, 1);
        assert.equal(row.controlOwner, row.control === 'shared' ? 'none' : row.control);
      }
      expectedAnchors(controls, fixture.expectedAnchors.filter(row => row.anchor.startsWith('capsule/')));
      assert.throws(() => uniqueAnchors([...controls, controls[0]]));
      assert.throws(() => expectedAnchors(controls, [{ anchor: 'capsule/missing/panel', role: 'region' }]));
      assert.throws(() => expectedAnchors(controls, [{ anchor: 'capsule/cap-01/tab', role: 'button', ifPresent: true }]));
    } finally { mounted.close(); }
  });
}
