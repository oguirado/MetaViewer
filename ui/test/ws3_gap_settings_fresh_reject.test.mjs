import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSettingsStore} from '../electron/authorityWire.js';

test('fresh invalid settings save creates no directory; valid save creates store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mv-ws3-settings-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const dir = join(root, 'metaviewer');
  const store = createSettingsStore({XDG_CONFIG_HOME: root});
  for (const invalid of ['{broken', '{"unknown":true}', '{"scheme":"invalid"}']) {
    await assert.rejects(store.save(invalid));
    await assert.rejects(stat(dir), {code: 'ENOENT'});
  }
  assert.equal(await store.save('{}'), true);
  assert.equal((await stat(dir)).isDirectory(), true);
  assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), '{}');
});
