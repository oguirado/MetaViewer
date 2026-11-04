import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cleanInstallSmoke} from '../tools/package.js';

test('overlong smoke runtime is refused before archive access with socket fix hint', async () => {
  const previous = process.env.TMPDIR;
  const base = await mkdtemp(join(tmpdir(), 'mv-path-'));
  try {
    const {mkdir} = await import('node:fs/promises');
    const long = join(base, 'long-home-'.repeat(12));
    await mkdir(long);
    process.env.TMPDIR = long;
    await assert.rejects(cleanInstallSmoke('/unused.tar'), /PKG_SMOKE_SOCKET_PATH.*TMPDIR/);
    assert.deepEqual(await readdir(long), [], 'early refusal still cleans its allocation');
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(base, {recursive:true, force:true});
  }
});
