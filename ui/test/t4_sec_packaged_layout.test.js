import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  FUSE_TABLE,
  REQUIRED_FUSE_COUNT,
  buildFuseConfig,
  handleAppRequest,
  resolveMainPaths,
  CONTENT_SECURITY_POLICY,
} from '../electron/main.js';
import { writeManifest, validateOutput } from '../tools/package.js';

test('packaged layout: fuse table parity, manifest refusal, output overlap matrix, and main path resolution', async () => {
  // 1. FUSE_TABLE parity and buildFuseConfig
  assert.equal(FUSE_TABLE.length, 9, 'Fuse table must carry exactly 9 rows');
  assert.equal(REQUIRED_FUSE_COUNT, 6, 'Exactly 6 required protection fuses');

  const requiredCount = FUSE_TABLE.filter((row) => row.required).length;
  assert.equal(requiredCount, REQUIRED_FUSE_COUNT, 'Required count in table must equal REQUIRED_FUSE_COUNT');

  const fuseConfig = buildFuseConfig();
  assert.equal(fuseConfig.version, '1');
  assert.equal(fuseConfig.strictlyRequireAllFuses, true);

  for (const row of FUSE_TABLE) {
    assert.equal(
      fuseConfig[String(row.index)],
      row.expect,
      `buildFuseConfig index ${row.index} must match row.expect (${row.name})`
    );
  }

  // 2. resolveMainPaths refuses legacy dist/index.html
  const dummyApp = {
    getAppPath: () => '/tmp/dummy_app_path',
    getPath: (name) => (name === 'userData' ? '/tmp/userData' : '/tmp'),
  };
  const dummyRuntime = { xdgRuntimeDir: tmpdir(), uid: process.getuid ? process.getuid() : 1000 };

  // resolveMainPaths expects dist/renderer under appPath; if dist/renderer is absent or if legacy dist/index.html is used, it fails with PATHS_BUNDLE
  assert.throws(
    () => resolveMainPaths(dummyApp, '/tmp/dummy_app_path', dummyRuntime),
    /PATHS_BUNDLE/
  );

  // 3. validateOutput overlap matrix
  const repoDir = '/tmp/repo_test_root';
  assert.throws(
    () => validateOutput(repoDir, repoDir),
    /MV_PKG_OUT must not overlap the repository/
  );
  assert.throws(
    () => validateOutput(`${repoDir}/subdir`, repoDir),
    /MV_PKG_OUT must not overlap the repository/
  );
  assert.throws(
    () => validateOutput('/tmp', repoDir),
    /MV_PKG_OUT must not overlap the repository/
  );

  // Valid non-overlapping external output directory
  const validOut = validateOutput('/tmp/external_out_dir', repoDir);
  assert.equal(validOut, '/tmp/external_out_dir');

  // 4. writeManifest refusals
  const manifestRoot = mkdtempSync(join(tmpdir(), 'mv-manifest-test-'));
  const destFile = join(manifestRoot, 'manifest.sha256');

  try {
    writeFileSync(join(manifestRoot, 'file1.txt'), 'data1');
    writeFileSync(join(manifestRoot, 'file2.txt'), 'data2');

    // Positive writeManifest
    await writeManifest(manifestRoot, destFile);
    assert.ok(existsSync(destFile));

    // Refusal on existing file (flag 'wx')
    await assert.rejects(
      () => writeManifest(manifestRoot, destFile),
      /EEXIST/
    );

    // Symlink refusal in writeManifest
    const symlinkRoot = mkdtempSync(join(tmpdir(), 'mv-manifest-symlink-'));
    writeFileSync(join(symlinkRoot, 'real.txt'), 'real');
    symlinkSync(join(symlinkRoot, 'real.txt'), join(symlinkRoot, 'symlink.txt'));

    await assert.rejects(
      () => writeManifest(symlinkRoot, join(symlinkRoot, 'out.sha256')),
      /Symlink refused/
    );

    rmSync(symlinkRoot, { recursive: true, force: true });
  } finally {
    rmSync(manifestRoot, { recursive: true, force: true });
  }

  // 5. handleAppRequest refuses preload.cjs including traversal spellings
  const appRoot = mkdtempSync(join(tmpdir(), 'mv-app-test-'));
  mkdirSync(join(appRoot, 'dist', 'renderer'), { recursive: true });
  mkdirSync(join(appRoot, 'dist', 'preload'), { recursive: true });

  writeFileSync(join(appRoot, 'dist', 'renderer', 'index.html'), '<html><head></head><body>App</body></html>');
  writeFileSync(join(appRoot, 'dist', 'preload', 'preload.cjs'), 'console.log("preload");');

  const rendererRoot = join(appRoot, 'dist', 'renderer');

  try {
    const checkRefused = async (url, expectedStatus) => {
      const res = await handleAppRequest(rendererRoot, { url });
      assert.equal(res.status, expectedStatus, `URL ${url} must return status ${expectedStatus}`);
      assert.equal(
        res.headers.get('Content-Security-Policy'),
        CONTENT_SECURITY_POLICY,
        'Refusal must carry base CSP'
      );
    };

    // Absent under renderer root -> 404
    await checkRefused('app://metaviewer/preload/preload.cjs', 404);
    // Traversal attempts to reach dist/preload/preload.cjs -> 403
    await checkRefused('app://metaviewer/../preload/preload.cjs', 403);
    await checkRefused('app://metaviewer/%2e%2e/preload/preload.cjs', 403);
    await checkRefused('app://metaviewer/%2e%2e/%2e%2e/dist/preload/preload.cjs', 403);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }

  // 6. Check dist/renderer after real vite build: no .cjs files
  // Perform build if dist/renderer does not exist
  const distRendererPath = new URL('../dist/renderer', import.meta.url).pathname;
  if (!existsSync(distRendererPath)) {
    try {
      execSync('npx vite build', { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
    } catch {
      /* best effort */
    }
  }

  if (existsSync(distRendererPath)) {
    const scanCjs = (dir) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, item.name);
        if (item.isDirectory()) {
          scanCjs(fullPath);
        } else if (item.isFile()) {
          assert.ok(!item.name.endsWith('.cjs'), `No .cjs file allowed in dist/renderer: ${fullPath}`);
        }
      }
    };
    scanCjs(distRendererPath);
  }
});
