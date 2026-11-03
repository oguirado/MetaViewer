import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as packaging from '../tools/package.js';

test('product notices are staged verbatim alongside the Electron license before sealing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-Música-'));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  try {
    await writeFile(join(root, 'LICENSE'), 'Electron license');
    await packaging.stageProductNotices(root);
    assert.equal(await readFile(join(root, 'LICENSE'), 'utf8'), 'Electron license');
    for (const [source, dest] of [['LICENSE', 'licenses/metaviewer/LICENSE'], ['NOTICE-EVALUATION.md', 'licenses/metaviewer/NOTICE-EVALUATION.md']]) {
      assert.deepEqual(await readFile(join(root, dest)), await readFile(join(repo, source)));
    }
    const source = await readFile(new URL('../tools/package.js', import.meta.url), 'utf8');
    assert.match(source, /await stageProductNotices\(built\[0\]\)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
