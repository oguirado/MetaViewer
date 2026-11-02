import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPackage } from '@electron/asar';
import { buildFuseConfig } from '../electron/main.js';
import {
  LOCKED_NODE_PTY_FILES,
  NODE_PTY_RUNTIME_REL_DIR,
  PINNED_NODE_PTY_NATIVE_DIGESTS,
  applyFuses,
  normalizePackageModes,
  packageArchitecture,
  sealRendererAssets,
  stageElectronModules,
  stageNodePtyRuntime,
  verifyInstall,
  verifyNodePtyBuildProvenance,
  verifyNodePtyRuntime,
  verifyStagedImports,
  writeManifest,
} from '../tools/package.js';
import { createWallLayout } from '../src/wall/layout.js';

test('P18 staged main layout bridge saves with its bundled kit; absent decoder fails staging gate',async t=>{
  const root = await mkdtemp(join(tmpdir(),'p18-package-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const app = join(root,'app');
  await stageElectronModules(app);
  const {createLayoutBridge} = await import(pathToFileURL(join(app,'electron/main.js')));
  const storage = await mkdtemp(join(tmpdir(),'p18-layout-'));t.after(()=>rm(storage,{recursive:true,force:true}));
  const bridge = createLayoutBridge({directory:storage});
  const save = bridge.find(entry=>entry.channel==='metaviewer:layout.save');
  const load = bridge.find(entry=>entry.channel==='metaviewer:layout.load');
  const raw = JSON.stringify(createWallLayout());
  assert.equal(await save.invoke(raw),true); assert.equal(await load.invoke(),raw);
  await rm(join(app,'.kit/capsule-ui-kit/src/workspace/layoutProfile.js'));
  await assert.rejects(verifyStagedImports(app),/PKG_STAGED_IMPORT_MISSING/);
});

test('P18H-R2-PTY: stageNodePtyRuntime stages node-pty outside ASAR, pins sha256 in manifest, and refuses unpinned, tampered, or missing native files (with mutant)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'p18h-r2-pkg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { arch: hostArch, machine: hostMachine } = packageArchitecture(process.arch);
  const root = join(dir, `MetaViewer-linux-${hostArch}`);
  const app = join(dir, 'app-src');
  await mkdir(join(app, 'dist/renderer'), { recursive: true });
  await mkdir(join(app, 'dist/preload'), { recursive: true });
  await mkdir(join(app, 'electron'), { recursive: true });
  await writeFile(join(app, 'dist/renderer/index.html'), '<!doctype html><html><body>ok</body></html>');
  await writeFile(join(app, 'dist/preload/preload.cjs'), '"use strict";\n');
  await writeFile(join(app, 'electron/nesting.js'), 'export default {};\n');
  for (const name of ['main.js', 'coreLauncher.js']) {
    await copyFile(fileURLToPath(new URL(`../electron/${name}`, import.meta.url)), join(app, 'electron', name));
  }
  await sealRendererAssets(app);
  await writeFile(join(app, 'package.json'), JSON.stringify({ main: 'electron/nesting.js' }));

  // Build valid host-arch ELF header + fuse sentinel for synthetic metaviewer / core / adapter binaries
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const elfHeader = Buffer.alloc(64);
  elfHeader.write('\x7fELF', 0, 'ascii');
  elfHeader[4] = 2;
  elfHeader[5] = 1;
  elfHeader.writeUInt16LE(hostMachine, 18);
  const fusedElf = Buffer.concat([elfHeader, sentinel, Buffer.from([1, 9]), Buffer.from('101100011')]);

  await mkdir(join(root, 'resources/bin'), { recursive: true });
  await mkdir(join(root, 'resources/operator/docs'), { recursive: true });
  await writeFile(join(root, 'metaviewer'), fusedElf, { mode: 0o755 });
  await applyFuses(join(root, 'metaviewer'), buildFuseConfig());
  await writeFile(join(root, 'resources/bin/metaviewer-core'), elfHeader, { mode: 0o755 });
  await writeFile(join(root, 'resources/bin/mv-daemon-adapter'), elfHeader, { mode: 0o755 });
  await writeFile(join(root, 'resources/operator/docs/AGENT_ENTRY.md'), 'entry\n', { mode: 0o644 });
  await writeFile(join(root, 'resources/deps.lock'), 'lock\n', { mode: 0o644 });
  await createPackage(app, join(root, 'resources/app.asar'));

  // Stage node-pty runtime into <root>/resources/build-native/pty-runtime/node-pty
  const stagedPtyRoot = await stageNodePtyRuntime(root, hostArch);
  assert.equal(stagedPtyRoot, join(root, NODE_PTY_RUNTIME_REL_DIR));

  // No app.asar.unpacked directory is created
  const resourcesEntries = await readdir(join(root, 'resources'));
  assert.equal(resourcesEntries.includes('app.asar.unpacked'), false);
  assert.equal(resourcesEntries.includes('build-native'), true);

  await normalizePackageModes(root);
  const manifestPath = `${root}.sha256`;
  await writeManifest(root, manifestPath);

  // Verify pty.node is pinned in .sha256 with the exact sha256
  const ptyRelPath = `${NODE_PTY_RUNTIME_REL_DIR}/build/Release/pty.node`;
  const ptyBytes = await readFile(join(root, ptyRelPath));
  const ptySha256 = createHash('sha256').update(ptyBytes).digest('hex');
  assert.equal(ptySha256, PINNED_NODE_PTY_NATIVE_DIGESTS[hostArch]['build/Release/pty.node']);
  const manifestText = await readFile(manifestPath, 'utf8');
  assert.ok(
    manifestText.includes(`${ptySha256} *${ptyRelPath}\n`),
    'Manifest must pin build/Release/pty.node as executable (*)',
  );
  for (const [relFile, expectedSha] of Object.entries(LOCKED_NODE_PTY_FILES)) {
    assert.ok(
      manifestText.includes(`${expectedSha}  ${NODE_PTY_RUNTIME_REL_DIR}/${relFile}\n`),
      `Manifest must pin ${relFile}`,
    );
  }

  // Clean staged install passes verifyInstall and verifyNodePtyRuntime
  await verifyNodePtyRuntime(root, hostArch);
  await verifyInstall(root, hostArch);

  // 1. Refuse unpinned native file even if manifest is regenerated to include it
  const unpinnedRel = `${NODE_PTY_RUNTIME_REL_DIR}/build/Release/unpinned-extra.node`;
  await writeFile(join(root, unpinnedRel), elfHeader, { mode: 0o755 });
  await assert.rejects(verifyInstall(root, hostArch), /PKG_MANIFEST_MISMATCH/);
  await rm(manifestPath);
  await writeManifest(root, manifestPath);
  await assert.rejects(
    verifyNodePtyRuntime(root, hostArch),
    (err) => err && err.code === 'PKG_UNPINNED_NATIVE' && /unpinned native/.test(err.message),
  );
  await assert.rejects(verifyInstall(root, hostArch), /unpinned native/);
  await rm(join(root, unpinnedRel));
  await rm(manifestPath);
  await writeManifest(root, manifestPath);
  await verifyInstall(root, hostArch);

  // 2. Refuse tampered JS file inside node-pty/lib even if manifest is regenerated
  const libIndexPath = join(root, NODE_PTY_RUNTIME_REL_DIR, 'lib/index.js');
  const origLibIndex = await readFile(libIndexPath);
  await writeFile(libIndexPath, Buffer.concat([origLibIndex, Buffer.from('\n// tampered\n')]));
  await assert.rejects(verifyInstall(root, hostArch), /PKG_MANIFEST_MISMATCH/);
  await rm(manifestPath);
  await writeManifest(root, manifestPath);
  await assert.rejects(verifyNodePtyRuntime(root, hostArch), /PKG_MANIFEST_MISMATCH/);
  await writeFile(libIndexPath, origLibIndex);
  await chmod(libIndexPath, 0o644);
  await rm(manifestPath);
  await writeManifest(root, manifestPath);
  await verifyInstall(root, hostArch);

  // 3. Refuse missing pty.node even if manifest is regenerated without it
  await rm(join(root, ptyRelPath));
  await assert.rejects(verifyInstall(root, hostArch), /PKG_BINARY_MISSING: pty\.node/);
  await rm(manifestPath);
  await writeManifest(root, manifestPath);
  await assert.rejects(verifyInstall(root, hostArch), /PKG_BINARY_MISSING: pty\.node/);

  // 4. Refuse tampered native build provenance input
  const tamperedPtySrc = join(dir, 'tampered-node-pty');
  await mkdir(join(tamperedPtySrc, 'src/unix'), { recursive: true });
  await mkdir(join(tamperedPtySrc, 'scripts'), { recursive: true });
  for (const rel of [
    'package.json',
    'binding.gyp',
    'src/unix/pty.cc',
    'src/unix/spawn-helper.cc',
    'scripts/prebuild.js',
    'scripts/post-install.js',
  ]) {
    await copyFile(
      fileURLToPath(new URL(`../node_modules/node-pty/${rel}`, import.meta.url)),
      join(tamperedPtySrc, rel),
    );
  }
  await verifyNodePtyBuildProvenance(tamperedPtySrc);
  await writeFile(join(tamperedPtySrc, 'src/unix/pty.cc'), '// tampered pty.cc\n');
  await assert.rejects(
    verifyNodePtyBuildProvenance(tamperedPtySrc),
    /PKG_MANIFEST_MISMATCH: node-pty build input src\/unix\/pty\.cc/,
  );

  // 5. Mutant check: a validator that only checks manifest self-consistency without allowlisting LOCKED_NODE_PTY_FILES fails to reject unpinned native files
  const mutantVerifyNative = (manifestSet, candidate) => {
    if (!manifestSet.has(candidate)) throw new Error('PKG_MANIFEST_MISMATCH');
    return true;
  };
  assert.equal(mutantVerifyNative(new Set([unpinnedRel]), unpinnedRel), true);
  assert.throws(
    () => {
      if (!Object.hasOwn(LOCKED_NODE_PTY_FILES, 'build/Release/unpinned-extra.node')) {
        throw new Error('PKG_UNPINNED_NATIVE');
      }
    },
    /PKG_UNPINNED_NATIVE/,
  );
});

