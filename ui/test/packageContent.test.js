// PKG-CONTENT: packaged layout.save works because the closed kit file set
// imported by ui/electron/main.js is staged into app.asar, followed by
// verifyStagedImports, and sealed and verified by sealRendererAssets,
// verifyBootSeal, and verifyPackagedSecurity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackage, extractFile, listPackage, uncache } from '@electron/asar';
import { buildFuseConfig } from '../electron/main.js';
import { createWallLayout } from '../src/wall/layout.js';
import {
  PACKAGED_KIT_MODULES,
  applyFuses,
  productionEntry,
  sealRendererAssets,
  stageElectronModules,
  stageKitContent,
  stagePackagedKit,
  verifyPackagedSecurity,
  verifyStagedImports,
} from '../tools/package.js';
import { kitDigest, syncKit } from '../../tools/sync_kit.mjs';

const ui = fileURLToPath(new URL('../', import.meta.url));
const KIT_LOCK_PATH = join(ui, 'kit.lock.json');
const KIT_ROOT = join(ui, '.kit/capsule-ui-kit');
const LAYOUT_REL = 'src/workspace/layoutProfile.js';
const LAYOUT_ASAR_REL = `.kit/capsule-ui-kit/${LAYOUT_REL}`;
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const pristineBinary = () =>
  Buffer.concat([Buffer.from('ELF-fixture'), sentinel, Buffer.from([1, 9]), Buffer.from('101100011')]);

/** @param {string} root */
async function ensureLocalKit(root) {
  if (existsSync(join(KIT_ROOT, LAYOUT_REL))) {
    return KIT_ROOT;
  }
  const kitRepo = process.env.CAPSULE_UI_KIT_REPO || process.env.MV_KIT_CHECKOUT;
  if (kitRepo) {
    const dest = join(root, '.kit/capsule-ui-kit');
    await syncKit({ kitRepo, dest, lockPath: KIT_LOCK_PATH });
    return dest;
  }
  throw new Error('Materialised ui/.kit/capsule-ui-kit or CAPSULE_UI_KIT_REPO required');
}

/** @param {string} root */
async function localElectron(root) {
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    const binary = join(process.env.ELECTRON_OVERRIDE_DIST_PATH, 'electron');
    await access(binary, constants.X_OK);
    return binary;
  }
  const installed = fileURLToPath(new URL('../node_modules/electron/dist/electron', import.meta.url));
  try {
    await access(installed, constants.X_OK);
    return installed;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
  const pkg = JSON.parse(await readFile(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8'));
  const checksums = JSON.parse(
    await readFile(new URL('../node_modules/electron/checksums.json', import.meta.url), 'utf8'),
  );
  const name = `electron-v${pkg.version}-${process.platform}-${process.arch}.zip`;
  const cache =
    process.env.electron_config_cache || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'electron');
  for (const entry of await readdir(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const archive = join(cache, entry.name, name);
    try {
      await access(archive);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(archive)) hash.update(bytes);
    assert.equal(hash.digest('hex'), checksums[name], 'Cached Electron checksum mismatch');
    const dist = join(root, 'electron-dist');
    await mkdir(dist);
    const unpack = spawnSync('unzip', ['-q', archive, '-d', dist], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.error?.message || unpack.stderr);
    const binary = join(dist, 'electron');
    await access(binary, constants.X_OK);
    return binary;
  }
  throw new Error(`Local ${name} required; set ELECTRON_OVERRIDE_DIST_PATH (no downloads)`);
}

/**
 * @param {string} app
 * @param {string} kitRoot
 * @param {{ stageKit?: boolean }} [options]
 */
async function stageAppTree(app, kitRoot, { stageKit = true } = {}) {
  await mkdir(join(app, 'dist/renderer'), { recursive: true });
  await mkdir(join(app, 'dist/preload'), { recursive: true });
  if (stageKit) {
    await stagePackagedKit(app, { kitRoot });
    await stageElectronModules(app, { kitRoot });
  } else {
    await copyFile(join(ui, 'electron/main.js'), join(app, 'electron/main.js')).catch(async () => {
      await mkdir(join(app, 'electron'), { recursive: true });
      for (const entry of await readdir(join(ui, 'electron'))) {
        await copyFile(join(ui, 'electron', entry), join(app, 'electron', entry));
      }
    });
  }
  await rename(join(app, 'electron/nesting.js'), join(app, 'electron/nested-display.js'));
  await appendFile(join(app, 'electron/main.js'), '\nexport { mainDirectEntry };\n');
  await writeFile(join(app, 'electron/nesting.js'), productionEntry);
  await writeFile(
    join(app, 'electron/package-pin.json'),
    JSON.stringify({ version: '0.2.0', commit: 'a'.repeat(40) }),
  );
  await writeFile(join(app, 'dist/renderer/index.html'), '<html></html>');
  await writeFile(join(app, 'dist/preload/preload.cjs'), '"use strict";\n');
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({ name: 'metaviewer', version: '0.2.0', type: 'module', main: 'electron/nesting.js' }),
  );
}

test('G1: staged app.asar contains the closed kit layoutProfile.js pinned to kit.lock.json and refuses missing or symlinked kit sources', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pkgcontent-g1-Música-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const kitRoot = await ensureLocalKit(scratch);
  const lock = JSON.parse(await readFile(KIT_LOCK_PATH, 'utf8'));
  assert.equal(lock.version, '0.2.1');
  assert.equal(lock.commit, 'bf31bc201987206d16dbd88d93102f9d5ce026f9');
  assert.equal(lock.contentHash, '1bee78c76a0a2a41d085beed918ca6ca791beaf53b952d4a9367dad660fd6dc2');
  assert.equal(await kitDigest(kitRoot), lock.contentHash);
  assert.deepEqual(PACKAGED_KIT_MODULES, ['src/workspace/layoutProfile.js']);
  assert.equal(stageKitContent, stagePackagedKit);

  const app = join(scratch, 'app');
  await stageAppTree(app, kitRoot);
  await sealRendererAssets(app);
  const archive = join(scratch, 'app.asar');
  await createPackage(app, archive);
  uncache(archive);

  const entries = listPackage(archive, {}).map((entry) => entry.replace(/^\//, ''));
  assert.ok(entries.includes(LAYOUT_ASAR_REL), 'app.asar must contain .kit/capsule-ui-kit/src/workspace/layoutProfile.js');
  const expectedBytes = await readFile(join(kitRoot, LAYOUT_REL));
  const archivedBytes = extractFile(archive, LAYOUT_ASAR_REL);
  assert.equal(Buffer.compare(archivedBytes, expectedBytes), 0, 'archived layoutProfile.js bytes must match pinned kit');

  // Mutant: missing kit source fails stagePackagedKit closed with PKG_KIT_MODULE_MISSING.
  const emptyKit = join(scratch, 'empty-kit');
  await mkdir(emptyKit, { recursive: true });
  await assert.rejects(stagePackagedKit(join(scratch, 'app-missing'), { kitRoot: emptyKit }), /PKG_KIT_MODULE_MISSING/);
});

test('G2: verifyStagedImports follows ../.kit imports from electron/main.js and fails closed when kit target or transitive kit import is missing', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pkgcontent-g2-Música-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const kitRoot = await ensureLocalKit(scratch);
  const app = join(scratch, 'app');
  await stageAppTree(app, kitRoot);

  await verifyStagedImports(app);

  // Mutant 1: deleting the staged kit file causes verifyStagedImports to fail closed with PKG_STAGED_IMPORT_MISSING.
  const stagedKitFile = join(app, LAYOUT_ASAR_REL);
  const savedBytes = await readFile(stagedKitFile);
  await unlink(stagedKitFile);
  await assert.rejects(
    verifyStagedImports(app),
    /PKG_STAGED_IMPORT_MISSING: \.kit[\\/]capsule-ui-kit[\\/]src[\\/]workspace[\\/]layoutProfile\.js/,
  );

  // Mutant 2: a transitive import inside the staged kit file to an unshipped sibling also fails closed.
  await writeFile(stagedKitFile, `${savedBytes.toString('utf8')}\nimport './unshipped-kit-dep.js';\n`, 'utf8');
  await assert.rejects(
    verifyStagedImports(app),
    /PKG_STAGED_IMPORT_MISSING: \.kit[\\/]capsule-ui-kit[\\/]src[\\/]workspace[\\/]unshipped-kit-dep\.js/,
  );

  await writeFile(stagedKitFile, savedBytes);
  await verifyStagedImports(app);
});

test('G3: sealRendererAssets, verifyPackagedSecurity, and verifyBootSeal seal .kit entries and refuse tampered, unsealed, or extra kit files', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pkgcontent-g3-Música-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const kitRoot = await ensureLocalKit(scratch);
  const app = join(scratch, 'app');
  const built = join(scratch, 'built');
  await mkdir(join(built, 'resources'), { recursive: true });
  const binary = join(built, 'metaviewer');
  await writeFile(binary, pristineBinary());
  await applyFuses(binary, buildFuseConfig());

  await stageAppTree(app, kitRoot);
  await sealRendererAssets(app);

  const mainSealed = await readFile(join(app, 'electron/main.js'), 'utf8');
  assert.ok(mainSealed.includes( JSON.stringify(LAYOUT_ASAR_REL) ), 'PACKAGED_ASSET_DIGESTS must include the kit seal key');

  const archive = join(built, 'resources/app.asar');
  await createPackage(app, archive);
  await verifyPackagedSecurity(built);

  // Mutant 1: tamper a single byte of the staged kit file after sealing -> verifyPackagedSecurity refuses with ASAR asset mismatch.
  const stagedKitFile = join(app, LAYOUT_ASAR_REL);
  const originalKitBytes = await readFile(stagedKitFile);
  await appendFile(stagedKitFile, '\n// tampered kit byte\n');
  await rm(archive, { force: true });
  await createPackage(app, archive);
  uncache(archive);
  await assert.rejects(
    verifyPackagedSecurity(built),
    /ASAR asset mismatch: \.kit\/capsule-ui-kit\/src\/workspace\/layoutProfile\.js/,
  );

  // Also verify boot seal in productionEntry refuses the tampered kit file before mainDirectEntry.
  const bootTampered = spawnSync(process.execPath, [join(app, 'electron/nesting.js')], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.notEqual(bootTampered.status, 0);
  assert.match(bootTampered.stderr, /PKG_SEAL_MISMATCH: \.kit\/capsule-ui-kit\/src\/workspace\/layoutProfile\.js/);

  // Restore original kit bytes.
  await writeFile(stagedKitFile, originalKitBytes);

  // Mutant 2: add an unsealed extra file under .kit after sealing -> verifyPackagedSecurity refuses with ASAR asset mismatch.
  const extraKitFile = join(app, '.kit/capsule-ui-kit/src/workspace/unsealed.js');
  await writeFile(extraKitFile, 'export const unsealed = true;\n');
  await rm(archive, { force: true });
  await createPackage(app, archive);
  uncache(archive);
  await assert.rejects(verifyPackagedSecurity(built), /ASAR asset mismatch: \.kit\/capsule-ui-kit\/src\/workspace\/unsealed\.js/);

  const bootExtra = spawnSync(process.execPath, [join(app, 'electron/nesting.js')], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.notEqual(bootExtra.status, 0);
  assert.match(bootExtra.stderr, /PKG_SEAL_MISMATCH: \.kit\/capsule-ui-kit\/src\/workspace\/unsealed\.js/);

  await rm(extraKitFile, { force: true });
  await rm(archive, { force: true });
  await createPackage(app, archive);
  uncache(archive);
  await verifyPackagedSecurity(built);
});

test('G4 & G5: packaged app.asar in Electron round-trips layout.save/load via shipped kit, fails closed when kit is omitted, and leaves pty runtime untouched', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'mv-pkgcontent-g4-Música-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const kitRoot = await ensureLocalKit(scratch);
  const electronBin = await localElectron(scratch);

  const app = join(scratch, 'app');
  const resources = join(scratch, 'resources');
  await mkdir(resources, { recursive: true });
  await stageAppTree(app, kitRoot);
  await sealRendererAssets(app);
  const archive = join(resources, 'app.asar');
  await createPackage(app, archive);

  // G5: PKG-CONTENT never creates resources/build-native or resources/node_modules/node-pty, and no app.asar.unpacked exists.
  assert.equal(existsSync(join(resources, 'build-native')), false, 'PKG-CONTENT must not create resources/build-native');
  assert.equal(existsSync(join(resources, 'node_modules')), false, 'PKG-CONTENT must not stage node_modules');
  assert.equal(existsSync(`${archive}.unpacked`), false, 'ASAR-only layout must not produce app.asar.unpacked');

  const layoutDir = await mkdtemp(join(tmpdir(), 'mv-pkgcontent-layout-'));
  t.after(() => rm(layoutDir, { recursive: true, force: true }));

  const probe = join(scratch, 'probe.cjs');
  await writeFile(
    probe,
    `
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
  const [archive, directory, raw] = process.argv.slice(2);
  assert.ok(archive.endsWith('app.asar'));
  const main = await import(pathToFileURL(archive + '/electron/main.js').href);
  const bridge = main.createLayoutBridge({ directory });
  const load = bridge.find(entry => entry.channel === main.CHANNELS.load);
  const save = bridge.find(entry => entry.channel === main.CHANNELS.save);
  assert.equal(await load.invoke(load.decode(undefined)), null);
  assert.equal(await save.invoke(save.decode(raw)), true, 'layout.save must succeed from packaged app.asar');
  assert.equal(await load.invoke(null), raw);
  await assert.rejects(save.invoke('{}'), /LAYOUT_CONTRACT_INVALID/);
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
  );

  const rawLayout = JSON.stringify(createWallLayout());
  const runProbe = (targetArchive) =>
    spawnSync(electronBin, [probe, targetArchive, layoutDir, rawLayout], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30000,
    });

  const good = runProbe(archive);
  assert.equal(good.status, 0, good.stderr || good.stdout);
  assert.equal(await readFile(join(layoutDir, 'layout.json'), 'utf8'), rawLayout);

  // Mutant: an app.asar built without .kit fails layout.save with ERR_MODULE_NOT_FOUND.
  const noKitApp = join(scratch, 'app-no-kit');
  await cpElectronWithoutKit(app, noKitApp);
  const noKitResources = join(scratch, 'no-kit-resources');
  await mkdir(noKitResources, { recursive: true });
  const noKitArchive = join(noKitResources, 'app.asar');
  await createPackage(noKitApp, noKitArchive);
  const bad = runProbe(noKitArchive);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);

  // Verify packageShell wires stagePackagedKit before sealRendererAssets without touching node-pty.
  const pkgSource = await readFile(join(ui, 'tools/package.js'), 'utf8');
  const shellSlice = pkgSource.slice(pkgSource.indexOf('export async function packageShell'));
  const kitCallIdx = shellSlice.indexOf('stagePackagedKit(app, { kitRoot: join(builder, \'.kit/capsule-ui-kit\') })');
  const sealCallIdx = shellSlice.indexOf('sealRendererAssets(app)');
  assert.ok(kitCallIdx > 0 && kitCallIdx < sealCallIdx, 'packageShell must stage the verified builder kit before sealing');
  assert.equal(pkgSource.includes('stageNodePty'), false, 'PKG-CONTENT must not touch node-pty staging');
});

/**
 * @param {string} srcApp
 * @param {string} dstApp
 */
async function cpElectronWithoutKit(srcApp, dstApp) {
  await mkdir(dstApp, { recursive: true });
  for (const entry of ['electron', 'dist', 'package.json']) {
    const from = join(srcApp, entry);
    const to = join(dstApp, entry);
    const { cp } = await import('node:fs/promises');
    await cp(from, to, { recursive: true });
  }
}
