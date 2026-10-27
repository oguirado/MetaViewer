import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageShell, validateOutput } from '../tools/package.js';

test('ARG-ui_shell-3 repository alias refuses before mkdir; external destination remains admitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-package-Música-'));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const alias = join(root, 'repo');
  // This target is never created: rejection must precede every repository write.
  const name = `forbidden-${root.split('/').at(-1)}`;
  try {
    await symlink(repo, alias, 'dir');
    await assert.rejects(packageShell({ MV_PKG_OUT: join(alias, name, 'nested') }), /must not overlap/);
    await assert.rejects(access(join(repo, name)), { code: 'ENOENT' });
    assert.equal(validateOutput(join(root, 'outside'), repo), join(root, 'outside'));
    await assert.rejects(packageShell({ MV_PKG_OUT: join(root, 'outside') }), /CAPSULE_UI_KIT_REPO is required/);
    await access(join(root, 'outside'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
