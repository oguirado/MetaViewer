// Real Electron ASAR filesystem: virtual directory inodes change on each stat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPackage } from '@electron/asar';
import electron from 'electron';
import { sealRendererAssets, stageElectronModules } from '../tools/package.js';

test('packaged ASAR admits repeated index loads and refuses forged requests, changed assets and replaced archives', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-renderer-Música-'));
  try {
    const app = join(scratch, 'app');
    await mkdir(join(app, 'dist/renderer'), { recursive: true });
    await mkdir(join(app, 'dist/preload'), { recursive: true });
    await stageElectronModules(app);
    await writeFile(join(app, 'package.json'), '{"type":"module"}');
    await writeFile(join(app, 'dist/renderer/index.html'), '<html><head></head><body>real UI</body></html>');
    await writeFile(join(app, 'dist/preload/preload.cjs'), '');
    await sealRendererAssets(app);
    const archive = join(scratch, 'app.asar');
    await createPackage(app, archive);
    const script = join(scratch, 'probe.cjs');
    await writeFile(script, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const physical = require('original-fs');
const { pathToFileURL } = require('node:url');
(async () => {
  const archive = process.argv[2];
  const { serveBundled } = await import(pathToFileURL(archive + '/electron/main.js').href);
  const root = archive + '/dist/renderer';
  const a = fs.statSync(root), b = fs.statSync(root);
  assert.notEqual(a.ino, b.ino, 'fixture must exercise Electron virtual inodes');
  let handler;
  serveBundled({ handle: (_, h) => handler = h }, root);
  if (process.argv[3] === 'tampered') {
    assert.equal((await handler({ url: 'app://metaviewer/index.html' })).status, 403);
    return;
  }
  for (let i = 0; i < 3; i++) {
    const response = await handler({ url: 'app://metaviewer/index.html' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /real UI/);
  }
  assert.equal((await handler(null)).status, 403);
  assert.equal((await handler({ get url() { throw new Error('forged'); } })).status, 403);
  for (const url of ['app://foreign/index.html', 'app://metaviewer/%2e%2e/secret', 'app://user@metaviewer/index.html']) {
    assert.equal((await handler({ url })).status, 403);
  }
  // Cache does not excuse replacement: the physical inode and pinned fd bind it.
  physical.renameSync(archive, archive + '.old');
  physical.copyFileSync(archive + '.old', archive);
  assert.equal((await handler({ url: 'app://metaviewer/index.html' })).status, 403);
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    const binary = process.env.ELECTRON_OVERRIDE_DIST_PATH ? join(process.env.ELECTRON_OVERRIDE_DIST_PATH, 'electron') : electron;
    const result = spawnSync(binary, [script, archive], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    // Keep main's sealed digest unchanged while replacing the renderer bytes.
    await writeFile(join(app, 'dist/renderer/index.html'), '<html><head></head><body>forged</body></html>');
    const tampered = join(scratch, 'tampered.asar');
    await createPackage(app, tampered);
    const refusal = spawnSync(binary, [script, tampered, 'tampered'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000 });
    assert.equal(refusal.status, 0, refusal.stderr || refusal.stdout);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
