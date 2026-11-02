// Restored layouts can carry panels of surfaces from an earlier run; the wall
// closes them only after a grace period without a projection row.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sfcPath = path.join(here, '..', 'src', 'wall', 'WallWorkspace.vue');
const dir = path.join(here, '.tmp-p18-orphan');
after(() => rmSync(dir, { recursive: true, force: true }));

async function loadWall() {
  const { parse } = await import('@vue/compiler-sfc');
  const { descriptor, errors } = parse(readFileSync(sfcPath, 'utf8'), { filename: 'WallWorkspace.vue' });
  assert.equal(errors.length, 0);
  mkdirSync(dir, { recursive: true });
  const modulePath = path.join(dir, 'wall.mjs');
  writeFileSync(modulePath, descriptor.script.content);
  return import(pathToFileURL(modulePath).href);
}

function harness(wall, rows) {
  const closed = [];
  const panels = [];
  const api = {
    width: 0, height: 0, groups: [], panels,
    getPanel: id => panels.find(p => p.id === id),
    addPanel: () => { throw new Error('unused'); },
  };
  const add = id => panels.push({ id, api: { close() { closed.push(id); panels.splice(panels.findIndex(p => p.id === id), 1); } } });
  const windows = { state: () => ({}), show() {}, hide() {}, float() {}, dock() {} };
  const projection = { rows };
  const controller = wall.createWallWorkspaceController({ projectionView: { getProjection: () => projection, getSnapshot:()=>({status:'live',stale:false,envelope:{projection}}) } });
  assert.equal(controller.handleReady({ api, windows, revision: 1 }).ok, true);
  return { controller, add, closed, projection };
}

test('a restored panel without a projection row closes only after the grace period', async () => {
  const wall = await loadWall();
  const live = { id: 'surface-live', surfaceId: 'surface-live', backendLifecycle: 'active' };
  const { controller, add, closed } = harness(wall, [live]);
  add('panel-surface-live');
  add('panel-surface-gone');
  controller.refreshPreset(1000);
  controller.refreshPreset(1000 + wall.ORPHAN_GRACE_MS - 1);
  assert.deepEqual(closed, []);
  controller.refreshPreset(1000 + wall.ORPHAN_GRACE_MS);
  assert.deepEqual(closed, ['panel-surface-gone']);
});

test('a panel whose row arrives within the grace period is kept', async () => {
  const wall = await loadWall();
  const { controller, add, closed, projection } = harness(wall, []);
  add('panel-surface-late');
  controller.refreshPreset(0);
  projection.rows = [{ id: 'surface-late', surfaceId: 'surface-late', backendLifecycle: 'active' }];
  controller.refreshPreset(wall.ORPHAN_GRACE_MS + 10);
  assert.deepEqual(closed, []);
});
