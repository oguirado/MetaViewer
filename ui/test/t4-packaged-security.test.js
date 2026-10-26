import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createPackage, uncache } from '@electron/asar';
import { buildFuseConfig } from '../electron/main.js';
import * as packaging from '../tools/package.js';

// Wire bytes measured from the pinned local Electron distribution.
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const pristine = () => Buffer.concat([Buffer.from('ELF-fixture'), sentinel, Buffer.from([1, 9]), Buffer.from('101100011')]);

test('R1-050 package requires ASAR, applies sole fuse config and verifies finished binary', async () => {
  assert.equal(typeof packaging.applyFuses, 'function');
  const root = await mkdtemp(join(tmpdir(), 'uiel-fuses-'));
  try {
    const app = join(root, 'source'); const built = join(root, 'built');
    await mkdir(join(app, 'dist/renderer'), {recursive: true});
    await mkdir(join(app, 'dist/preload'), {recursive: true});
    await mkdir(join(app, 'electron'), {recursive: true});
    await writeFile(join(app, 'dist/renderer/index.html'), '<html></html>');
    await writeFile(join(app, 'dist/preload/preload.cjs'), 'preload');
    await writeFile(join(app, 'electron/nesting.js'), 'entry');
    for (const name of ['main.js', 'coreLauncher.js']) {
      await copyFile(new URL(`../electron/${name}`, import.meta.url), join(app, 'electron', name));
    }
    await packaging.sealRendererAssets(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({main: 'electron/nesting.js'}));
    await mkdir(join(built, 'resources'), {recursive: true});
    const binary = join(built, 'metaviewer');
    await writeFile(binary, pristine());
    await createPackage(app, join(built, 'resources/app.asar'));
    await assert.rejects(packaging.verifyPackagedSecurity(built), /fuse/i);
    await packaging.applyFuses(binary, buildFuseConfig());
    await packaging.verifyPackagedSecurity(built);
    // Actual Electron ASAR filesystem: a modified archive still has to match
    // the digests embedded in the trusted main module.
    const archive = join(built, 'resources/app.asar');
    const script = `const {handleAppRequest, PRIVILEGED_ORIGIN} = await import(${JSON.stringify('file://' + archive + '/electron/main.js')});
      const response = await handleAppRequest(${JSON.stringify(archive + '/dist/renderer')}, {url: PRIVILEGED_ORIGIN + '/index.html'});
      console.log(response.status);`;
    const serve = () => spawnSync(new URL('../node_modules/electron/dist/electron', import.meta.url).pathname,
      ['--input-type=module', '-e', script], {encoding: 'utf8', env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}});
    const normal = serve(); assert.equal(normal.status, 0, normal.stderr); assert.equal(normal.stdout.trim(), '200');
    await writeFile(join(app, 'dist/renderer/index.html'), 'SECRET');
    await rm(archive); await createPackage(app, archive);
    uncache(archive);
    await assert.rejects(packaging.verifyPackagedSecurity(built), /asset/i);
    const replaced = serve(); assert.equal(replaced.status, 0, replaced.stderr); assert.equal(replaced.stdout.trim(), '403');
    await writeFile(join(app, 'dist/renderer/index.html'), '<html></html>');
    await rm(archive); await createPackage(app, archive);
    assert.equal((await readFile(binary)).subarray(-9).toString(), '010011000');
    assert.throws(() => packaging.assertPackagingPolicy(false, buildFuseConfig()), /ASAR/);
    assert.throws(() => packaging.assertPackagingPolicy(true, {...buildFuseConfig(), 0: true}), /fuse/i);
    const cli = new URL('../tools/package.js', import.meta.url);
    const run = () => spawnSync(process.execPath, [cli.pathname, '--verify', built], {encoding: 'utf8'});
    assert.equal(run().status, 0);
    const tampered = await readFile(binary); tampered[tampered.length - 9] = 49;
    await writeFile(binary, tampered);
    assert.notEqual(run().status, 0, 'tampered fuse must abort CLI');
    await packaging.applyFuses(binary, buildFuseConfig());
    await rm(join(built, 'resources/app.asar'));
    await mkdir(join(built, 'resources/app'));
    assert.notEqual(run().status, 0, 'unpacked application must abort CLI');
    await writeFile(binary, Buffer.concat([pristine(), sentinel]));
    await assert.rejects(packaging.applyFuses(binary, buildFuseConfig()), /fuse/i);
  } finally { await rm(root, {recursive: true, force: true}); }
});
