import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayoutProfile, decodeAndMigrateLayoutProfile } from '../.kit/capsule-ui-kit/src/workspace/layoutProfile.js';
import { createWallLayout, migrateWallLayout, SCOPE } from '../src/wall/layout.js';

test('product default validates with no demo panels or placements', () => {
  const profile = createWallLayout();
  assert.deepEqual(profile.dockview.panels, {});
  assert.deepEqual(profile.savedWallPlacements, {});
  assert.equal(decodeAndMigrateLayoutProfile(profile, { expectedScope: SCOPE }).ok, true);
  assert.equal(profile.dockview.grid.root.type, 'branch');
  assert.deepEqual(profile.dockview.grid.root.data[0].data.views, []);
});
test('surfaces receive exact identities, titles, params and placements', () => {
  const profile = createWallLayout(SCOPE, [{ id: 'browser', title: 'Research' }, { id: 'editor', title: 'Editor' }]);
  assert.equal(Object.keys(profile.dockview.panels).length, 2);
  for (const id of ['browser', 'editor']) {
    const panel = profile.dockview.panels[`panel-${id}`];
    assert.equal(panel.contentComponent, 'CapsulePanel');
    assert.equal(panel.renderer, 'always');
    assert.deepEqual(panel.params, { capsuleId: id });
    assert.ok(profile.savedWallPlacements[`panel-${id}`]);
  }
  const raw = JSON.stringify(profile);
  assert.equal(migrateWallLayout(raw), raw, 'valid product layout survives byte-exact');
  assert.throws(() => createWallLayout(SCOPE, [{ id: 'bad id' }]), /identity/);
  assert.throws(() => createWallLayout(SCOPE, [{ id: 'same' }, { id: 'same' }]), /Duplicate/);
});
test('demo, retired type, absent params and mismatched ids migrate before restore', () => {
  const demo = JSON.stringify(createDefaultLayoutProfile(SCOPE));
  const clean = JSON.stringify(createWallLayout());
  assert.equal(migrateWallLayout(demo), clean);
  for (const mutate of [
    p => { p.contentComponent = 'Retired'; },
    p => { p.params = {}; },
    p => { p.params.capsuleId = 'another'; },
    p => { p.params.capsuleId = ''; },
  ]) {
    const bad = structuredClone(createWallLayout(SCOPE, [{ id: 'one' }]));
    mutate(bad.dockview.panels['panel-one']);
    assert.equal(migrateWallLayout(JSON.stringify(bad)), clean);
  }
  assert.equal(migrateWallLayout(null), null);
  assert.equal(migrateWallLayout('{broken'), '{broken', 'corruption stays in kit quarantine');
});

test('future schema and foreign scope retain the kit quarantine boundary', () => {
  const future = structuredClone(createDefaultLayoutProfile(SCOPE));
  future.schemaVersion = 999;
  const futureRaw = JSON.stringify(future);
  assert.equal(migrateWallLayout(futureRaw), futureRaw);
  const foreign = JSON.stringify(createDefaultLayoutProfile({ ...SCOPE, product: 'another-product' }));
  assert.equal(migrateWallLayout(foreign), foreign);
});
