// Lane U1 wall grids: 0/1/2/4/9/9+ tile layouts through the real kit decode.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAndMigrateLayoutProfile } from '../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';
import { createWallLayout, migrateWallLayout, SCOPE } from '../src/wall/layout.js';

function surfaces(count) {
  return Array.from({ length: count }, (unused, index) => ({ id: `cap-${index + 1}` }));
}

/** Collect leaf view ids in grid order, descending into column branches. */
function leafViews(node, out = []) {
  if (node.type === 'leaf') {
    out.push(node.data.views);
    return out;
  }
  for (const child of node.data) leafViews(child, out);
  return out;
}

function columnsOf(root) {
  return root.data.filter((child) => child.type === 'branch');
}

describe('wall tile grids', () => {
  test('empty wall keeps the pinned empty leaf', () => {
    const profile = createWallLayout();
    assert.deepEqual(profile.dockview.panels, {});
    assert.deepEqual(profile.savedWallPlacements, {});
    assert.equal(profile.dockview.grid.root.type, 'branch');
    assert.deepEqual(profile.dockview.grid.root.data[0].data.views, []);
    assert.equal(decodeAndMigrateLayoutProfile(profile, { expectedScope: SCOPE }).ok, true);
  });

  test('one tile fills a single flat leaf', () => {
    const profile = createWallLayout(SCOPE, surfaces(1));
    const root = profile.dockview.grid.root;
    assert.equal(root.data.length, 1);
    assert.equal(root.data[0].type, 'leaf');
    assert.deepEqual(root.data[0].data.views, ['panel-cap-1']);
    assert.equal(profile.dockview.activeGroup, 'wall-group-0');
    assert.equal(decodeAndMigrateLayoutProfile(profile, { expectedScope: SCOPE }).ok, true);
  });

  test('two tiles stay flat side by side', () => {
    const profile = createWallLayout(SCOPE, surfaces(2));
    const root = profile.dockview.grid.root;
    assert.equal(root.data.length, 2);
    assert.ok(root.data.every((child) => child.type === 'leaf'));
    assert.deepEqual(leafViews(root), [['panel-cap-1'], ['panel-cap-2']]);
    assert.equal(decodeAndMigrateLayoutProfile(profile, { expectedScope: SCOPE }).ok, true);
  });

  test('four tiles form a 2x2 grid filled row-major', () => {
    const profile = createWallLayout(SCOPE, surfaces(4));
    const root = profile.dockview.grid.root;
    const columns = columnsOf(root);
    assert.equal(columns.length, 2);
    assert.deepEqual(columns.map((column) => column.data.length), [2, 2]);
    assert.deepEqual(leafViews(root),
      [['panel-cap-1'], ['panel-cap-3'], ['panel-cap-2'], ['panel-cap-4']]);
    assert.equal(decodeAndMigrateLayoutProfile(profile, { expectedScope: SCOPE }).ok, true);
  });

  test('nine tiles form a 3x3 grid with every panel referenced once', () => {
    const profile = createWallLayout(SCOPE, surfaces(9));
    const root = profile.dockview.grid.root;
    const columns = columnsOf(root);
    assert.equal(columns.length, 3);
    assert.deepEqual(columns.map((column) => column.data.length), [3, 3, 3]);
    const views = leafViews(root).flat();
    assert.equal(views.length, 9);
    assert.deepEqual([...views].sort(), Object.keys(profile.dockview.panels).sort());
    for (const [id, panel] of Object.entries(profile.dockview.panels)) {
      assert.equal(panel.contentComponent, 'CapsulePanel');
      assert.equal(panel.renderer, 'always');
      assert.deepEqual(panel.params, { capsuleId: id.slice('panel-'.length) });
      assert.ok(profile.savedWallPlacements[id]);
    }
    assert.equal(profile.dockview.activeGroup, 'wall-group-0');
    assert.equal(decodeAndMigrateLayoutProfile(profile, { expectedScope: SCOPE }).ok, true);
  });

  test('past nine tiles the grid grows rows inside three columns', () => {
    const profile = createWallLayout(SCOPE, surfaces(12));
    const root = profile.dockview.grid.root;
    const columns = columnsOf(root);
    assert.equal(columns.length, 3);
    assert.deepEqual(columns.map((column) => column.data.length), [4, 4, 4]);
    assert.equal(leafViews(root).flat().length, 12);
    assert.equal(decodeAndMigrateLayoutProfile(profile, { expectedScope: SCOPE }).ok, true);
  });

  test('odd counts decode: three tiles stack two plus one', () => {
    const profile = createWallLayout(SCOPE, surfaces(3));
    const root = profile.dockview.grid.root;
    assert.deepEqual(columnsOf(root).map((column) => column.data.length), [2, 1]);
    assert.equal(decodeAndMigrateLayoutProfile(profile, { expectedScope: SCOPE }).ok, true);
  });

  test('valid grid layouts survive migration byte-exact', () => {
    for (const count of [1, 4, 9]) {
      const raw = JSON.stringify(createWallLayout(SCOPE, surfaces(count)));
      assert.equal(migrateWallLayout(raw), raw, `${count} tiles`);
    }
  });

  test('negative controls: bad identities refuse before any grid work', () => {
    assert.throws(() => createWallLayout(SCOPE, [{ id: 'bad id' }]), /identity/);
    assert.throws(() => createWallLayout(SCOPE, [{ id: '' }]), /identity/);
    assert.throws(() => createWallLayout(SCOPE, [{ id: 'same' }, { id: 'same' }]), /Duplicate/);
    assert.throws(() => createWallLayout(SCOPE, [{ id: 'ok' }, { id: 'not ok' }]), /identity/);
  });
});
