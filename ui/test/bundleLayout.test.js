import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMainPaths, handleAppRequest, PRIVILEGED_ORIGIN } from '../electron/main.js';

const ui = fileURLToPath(new URL('../', import.meta.url));
const vite = join(ui, 'node_modules/vite/bin/vite.js');

test('bundleLayout: real Vite output resolves with a private sibling preload, including package staging', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'mv-bundle-layout-'));
  const runtime = { xdgRuntimeDir: temporary, uid: process.getuid() };
  try {
    // The first build uses the production config unchanged. The second mirrors
    // package.js, whose absolute --outDir must relocate both output roots.
    for (const root of [ui, join(temporary, 'app')]) {
      const args = [vite, 'build'];
      if (root !== ui) args.push('--outDir', join(root, 'dist/renderer'));
      execFileSync(process.execPath, args, { cwd: ui, stdio: 'pipe', timeout: 60000 });
      const app = { getAppPath: () => root, getPath: () => join(temporary, 'userData') };
      const paths = resolveMainPaths(app, root, runtime);
      assert.equal(paths.rendererRoot, realpathSync(join(root, 'dist/renderer')));
      assert.ok(existsSync(join(paths.rendererRoot, 'index.html')));
      assert.ok(existsSync(paths.preloadPath));
      const preloadRelative = relative(paths.rendererRoot, realpathSync(paths.preloadPath));
      assert.ok(preloadRelative.startsWith(`..${sep}`) || isAbsolute(preloadRelative));
      assert.equal(existsSync(join(paths.rendererRoot, 'preload/preload.cjs')), false);
      const index = await handleAppRequest(paths.rendererRoot,
        { url: `${PRIVILEGED_ORIGIN}/index.html` }, { styleNonce: false });
      assert.equal(index.status, 200);
      const preload = await handleAppRequest(paths.rendererRoot,
        { url: `${PRIVILEGED_ORIGIN}/preload/preload.cjs` }, { styleNonce: false });
      assert.notEqual(preload.status, 200);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('bundleLayout: legacy dist/index.html alone fails PATHS_BUNDLE', () => {
  const root = mkdtempSync(join(tmpdir(), 'mv-legacy-bundle-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist/index.html'), '<!doctype html><html></html>');
    const app = { getAppPath: () => root, getPath: () => join(root, 'userData') };
    assert.throws(() => resolveMainPaths(app, root,
      { xdgRuntimeDir: root, uid: process.getuid() }), { code: 'PATHS_BUNDLE' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
