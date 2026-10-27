import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLayoutBridge, CHANNELS } from '../electron/main.js';
import { createWallLayout } from '../src/wall/layout.js';

test('shipped layout storage loads absent as null and roundtrips the real kit contract', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'layout-tést-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = createLayoutBridge({ directory });
  const load = bridge.find(x => x.channel === CHANNELS.load);
  const save = bridge.find(x => x.channel === CHANNELS.save);
  assert.equal(await load.invoke(load.decode(undefined)), null);
  const raw = JSON.stringify(createWallLayout());
  assert.equal(await save.invoke(save.decode(raw)), true);
  assert.equal(await load.invoke(null), raw);
  await assert.rejects(save.invoke('{}'), /LAYOUT_CONTRACT_INVALID/);
  assert.equal(await readFile(join(directory, 'layout.json'), 'utf8'), raw);
  await writeFile(join(directory, 'layout.json'), '{}');
  await assert.rejects(load.invoke(null), /LAYOUT_CONTRACT_INVALID/);
});

test('layout storage refuses foreign scope and linked storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = createLayoutBridge({ directory });
  await assert.rejects(bridge[1].invoke(JSON.stringify(createWallLayout({ product:'other', profileId:'default', workspaceId:'main-wall' }))), /LAYOUT_CONTRACT_INVALID/);
  const { symlink } = await import('node:fs/promises');
  await symlink(join(directory, 'missing'), join(directory, 'layout.json'));
  await assert.rejects(bridge[0].invoke(null));
});

test('direct-entry app capability selects private presentation storage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'layout-app-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const app = { getPath(name) { assert.equal(name, 'userData'); return root; } };
  const bridge = createLayoutBridge({ app });
  assert.equal(await bridge[0].invoke(null), null);
  const raw = JSON.stringify(createWallLayout());
  assert.equal(await bridge[1].invoke(raw), true);
  assert.equal(await readFile(join(root, 'presentation', 'layout.json'), 'utf8'), raw);
});
