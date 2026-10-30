// [TARGET, unit decision] Run with node --test tools/test_package_clean_install.mjs.
// Real product: node tools/package.js --smoke /external/MetaViewer-linux-arm64.tar.
// All fixtures are outside the checkout; no source mutation or skipped tests.
import { test as nodeTest } from 'node:test';
const test = process.env.MV_CHECK_CLEAN_CI_PREREQ_ONLY === '1' ? () => {} : nodeTest;
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createPackage } from '@electron/asar';
import { buildFuseConfig, ELECTRON_PIN as MAIN_ELECTRON_PIN } from '../electron/main.js';
import { createAdapterLauncher } from '../electron/coreLauncher.js';
import * as packaging from './package.js';
import {
  LOCKED_ELECTRON_NPM_FILES,
  LOCKED_ELECTRON_PACKAGE_INTEGRITY,
  SMOKE_DIAGNOSTIC_TAIL_CHARS,
  computeElectronDistTreeDigest,
  defaultElectronZipCandidates,
  packageArchitecture,
  verifyBinary,
   verifyElectronDist,
  verifyElectronLockfileBinding,
  verifyElectronZip,
  applyFuses,
  assertSmokeOutput,
  bundlePackage,
  createSmokeDiagnosticError,
  formatSmokeDiagnostics,
  runSmokeCommand,
  sealRendererAssets,
  verifyInstall,
  verifyPackagedSecurity,
  verifySmokeAdapterReceipt,
  writeFakeSmokeAdapter,
  writeFdSync,
  writeManifest,
} from './package.js';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(run) {
  const temporary=await fs.mkdtemp(join(tmpdir(),'mv-pkg-test-'));
  const root=join(temporary,'MetaViewer-linux-arm64');
  try {
    await fs.mkdir(join(root,'resources/bin'),{recursive:true});
    const elf=Buffer.alloc(64);
    elf.write('\x7fELF');elf[4]=2;elf[5]=1;elf.writeUInt16LE(183,18);
    const binary=Buffer.concat([elf,Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),Buffer.from([1,9]),Buffer.from('101100011')]);
    for (const name of ['metaviewer','resources/bin/metaviewer-core','resources/bin/mv-daemon-adapter']) {
      await fs.writeFile(join(root,name),binary,{mode:0o755});
    }
    await applyFuses(join(root,'metaviewer'),buildFuseConfig());
    const app=join(temporary,'app');
    for (const name of ['electron','dist/renderer','dist/preload']) await fs.mkdir(join(app,name),{recursive:true});
    await fs.copyFile(new URL('../electron/main.js',import.meta.url),join(app,'electron/main.js'));
    await fs.writeFile(join(app,'electron/nesting.js'),'fixture entry');
    await fs.writeFile(join(app,'dist/renderer/index.html'),'<html>fixture</html>');
    await fs.writeFile(join(app,'dist/preload/preload.cjs'),'fixture preload');
    await fs.writeFile(join(app,'package.json'),JSON.stringify({main:'electron/nesting.js'}));
    await sealRendererAssets(app);
    await createPackage(app,join(root,'resources/app.asar'));
    await writeManifest(root,`${root}.sha256`);
    await verifyInstall(root, 'arm64');
    await run(root,app);
  } finally {await fs.rm(temporary,{recursive:true,force:true});}
}

test('complete inventory rejects tampered bytes, extra entries and missing files',async () => {
  await fixture(async root => {
    const file=join(root,'resources/bin/mv-daemon-adapter');
    const original=await fs.readFile(file);
    await fs.appendFile(file,'tampered');
    await assert.rejects(verifyInstall(root, 'arm64'),/PKG_MANIFEST_MISMATCH/);
    await fs.writeFile(file,original);
    await fs.writeFile(join(root,'extra'),'unlisted');
    await assert.rejects(verifyInstall(root, 'arm64'),/PKG_MANIFEST_MISMATCH/);
    await fs.rm(join(root,'extra'));
    await fs.rm(file);
    await assert.rejects(verifyInstall(root, 'arm64'),/PKG_BINARY_MISSING: mv-daemon-adapter/);
  });
});

test('font files fail even when included in a regenerated manifest or ASAR',async () => {
  await fixture(async (root,app) => {
    const font=join(root,'planted.woff2');
    await fs.writeFile(font,'wOF2planted');
    await fs.rm(`${root}.sha256`);await writeManifest(root,`${root}.sha256`);
    await assert.rejects(verifyInstall(root, 'arm64'),/PKG_FONT_FORBIDDEN/);
    await fs.rm(font);
    await fs.writeFile(join(app,'disguised.bin'),'wOFFfont');
    await createPackage(app,join(root,'resources/app.asar'));
    await fs.rm(`${root}.sha256`);await writeManifest(root,`${root}.sha256`);
    await assert.rejects(verifyInstall(root, 'arm64'),/PKG_FONT_FORBIDDEN/);
  });
});

test('wrong architecture fails with typed reason',async () => {
  await fixture(async root => {
    const file=join(root,'resources/bin/metaviewer-core');
    const bytes=await fs.readFile(file);bytes.writeUInt16LE(62,18);await fs.writeFile(file,bytes);
    await assert.rejects(verifyInstall(root, 'arm64'),/PKG_ARCH_MISMATCH/);
  });
});

test('ASAR modification and manifest path escapes are rejected',async () => {
  await fixture(async (root,app) => {
    await fs.writeFile(join(app,'dist/renderer/index.html'),'tampered renderer');
    await createPackage(app,join(root,'resources/app.asar'));
    await fs.rm(`${root}.sha256`);await writeManifest(root,`${root}.sha256`);
    await assert.rejects(verifyInstall(root, 'arm64'),/ASAR asset mismatch/);
    await fs.writeFile(`${root}.sha256`,'0'.repeat(64)+'  ../escape\n');
    await assert.rejects(verifyInstall(root, 'arm64'),/PKG_MANIFEST_INVALID/);
  });
});

test('zero exit without exact smoke marker is insufficient',() => {
  assert.throws(() => assertSmokeOutput('METAVIEWER_MAIN_READY\n'),/PKG_SMOKE_MARKER_MISSING/);
  assert.throws(() => assertSmokeOutput('prefix METAVIEWER_MAIN_SMOKE_OK\n'),/PKG_SMOKE_MARKER_MISSING/);
  assert.throws(() => assertSmokeOutput('METAVIEWER_MAIN_SMOKE_OK\n'), /PKG_SMOKE_MARKER_MISSING/);
  assertSmokeOutput('METAVIEWER_MAIN_SMOKE_OK\nMETAVIEWER_RENDERER_READY\n');
});

test('archive bytes ignore mtimes and preserve pinned file bytes',async () => {
  await fixture(async root => {
    const first=await bundlePackage(root, 'arm64');
    await fs.utimes(join(root,'metaviewer'),new Date(),new Date());
    const second=await bundlePackage(root, 'arm64');
    assert.equal(first.artifact_sha256,second.artifact_sha256);
    assert.equal(first.size_bytes,second.size_bytes);
  });
});


test('native runner mapping selects archive, package name and ELF machine; unknown fails', async () => {
  for (const [arch, machine] of [['arm64', 183], ['x64', 62]]) {
    assert.deepEqual(packageArchitecture(arch), {arch, machine,
      name: `MetaViewer-linux-${arch}`, archive: `electron-v44.9.2-linux-${arch}.zip`});
    const directory = await fs.mkdtemp(join(tmpdir(), 'mv-arch-'));
    try {
      const file = join(directory, 'binary');
      const bytes = Buffer.alloc(64);
      bytes.write('\x7fELF'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(machine, 18);
      await fs.writeFile(file, bytes, {mode: 0o755});
      await verifyBinary(file, arch);
      await assert.rejects(verifyBinary(file, arch === 'arm64' ? 'x64' : 'arm64'), /PKG_ARCH_MISMATCH/);
    } finally { await fs.rm(directory, {recursive: true, force: true}); }
  }
  assert.equal(packageArchitecture().arch, process.arch);
  assert.throws(() => packageArchitecture('riscv64'), /PKG_ARCH_UNSUPPORTED/);
});

test('clean-install smoke fake adapter starts, completes core hello handshake, and is reaped on quit', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'mv-smoke-adapter-'));
  try {
    const runtime = join(dir, 'runtime');
    const srfBinDir = join(dir, 'srf-bin');
    const stateHome = join(dir, 'state');
    await fs.mkdir(join(runtime, 'metaviewer'), { recursive: true, mode: 0o700 });
    await fs.mkdir(srfBinDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(stateHome, { recursive: true, mode: 0o700 });
    const sessionId = 'pkg-smoke-test-session';
    const commit = 'a'.repeat(40);
    const config = {
      session_id: sessionId,
      core: {
        endpoint: { component: 'core', instance: 'core-1' },
        hello: { schema: 'hello/v0.2', contract_version: 'v0.2', component: 'core', component_version: '0.1.1', component_commit: commit, dependencies: [] },
      },
      peers: [{
        endpoint: { component: 'daemon', instance: 'daemon-1' },
        hello: { schema: 'hello/v0.2', contract_version: 'v0.2', component: 'daemon', component_version: '0.1.1', component_commit: commit, dependencies: [] },
      }],
    };
    const configPath = join(runtime, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const sockPath = join(runtime, 'metaviewer/core.sock');
    let serverHelloSeen = false;
    const server = createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\n')) {
          const msg = JSON.parse(buf.split('\n')[0]);
          if (msg.from?.component === 'daemon' && msg.body?.schema === 'hello/v0.2') {
            serverHelloSeen = true;
            conn.write(JSON.stringify({
              schema: 'envelope/v0.2',
              msg_id: 'core-hello',
              ts_ns: 0,
              from: config.core.endpoint,
              to: msg.from,
              session_id: sessionId,
              seq: 1,
              nonce: 'core-nonce',
              body: config.core.hello,
            }) + '\n');
          }
        }
      });
    });
    await new Promise((resolve) => server.listen(sockPath, resolve));
    try {
      const adapterBin = join(dir, 'mv-daemon-adapter');
      const receiptPath = join(dir, 'adapter-receipt.json');
      await writeFakeSmokeAdapter(adapterBin, receiptPath);
      await assert.rejects(verifySmokeAdapterReceipt(receiptPath, srfBinDir), /PKG_SMOKE_ADAPTER_RECEIPT_MISSING/);
      const launcher = createAdapterLauncher({
        command: adapterBin,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          MV_CORE_CONFIG: configPath,
          MV_SESSION_ID: sessionId,
          MV_CORE_INSTANCE: 'core-1',
          MV_DAEMON_INSTANCE: 'daemon-1',
          MV_SRF_BIN_DIR: srfBinDir,
          XDG_STATE_HOME: stateHome,
        },
        runtimeDir: runtime,
      });
      const status = await launcher.start();
      assert.equal(status.availability, 'live');
      assert.equal(status.handshakeSeen, true);
      assert.equal(serverHelloSeen, true);
      await launcher.dispose();
      const receipt = await verifySmokeAdapterReceipt(receiptPath, srfBinDir);
      assert.equal(receipt.handshake, true);
      assert.equal(receipt.reaped, true);
      await assert.rejects(verifySmokeAdapterReceipt(receiptPath, '/wrong/srf'), /PKG_SMOKE_ADAPTER_ENV_MISMATCH/);
      await fs.writeFile(receiptPath, JSON.stringify({ ...receipt, pid: 1 }));
      await assert.rejects(verifySmokeAdapterReceipt(receiptPath, srfBinDir), /PKG_SMOKE_ADAPTER_PID_INVALID/);
      await fs.writeFile(receiptPath, JSON.stringify({ ...receipt, handshake: false }));
      await assert.rejects(verifySmokeAdapterReceipt(receiptPath, srfBinDir), /PKG_SMOKE_ADAPTER_HANDSHAKE_MISSING/);
      await fs.writeFile(receiptPath, JSON.stringify({ ...receipt, reaped: false }));
      await assert.rejects(verifySmokeAdapterReceipt(receiptPath, srfBinDir), /PKG_SMOKE_ADAPTER_NOT_REAPED/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('R2-T4-002 extended seal covers executed JS and boot self-check refuses tampered non-renderer entry before mainDirectEntry', async () => {
  assert.equal(typeof packaging.productionEntry, 'string');
  await fixture(async (root, app) => {
    await fs.writeFile(
      join(app, 'package.json'),
      JSON.stringify({ name: 'metaviewer', version: '0.1.2', type: 'module', main: 'electron/nesting.js' }),
    );
    await fs.writeFile(
      join(app, 'electron/coreLauncher.js'),
      'export function scrubChildEnv(env) { return { ...env }; }\nexport function validateKillTarget() { return false; }\n',
    );
    await fs.writeFile(
      join(app, 'electron/package-pin.json'),
      JSON.stringify({ version: '0.1.2', commit: 'a'.repeat(40) }),
    );
    await fs.writeFile(
      join(app, 'electron/main.js'),
      [
        'const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({}));',
        'export function validateRetailLaunch() { return { ok: true }; }',
        'export async function mainDirectEntry() { console.log("BOOT_MAIN_DIRECT_ENTRY_OK"); setTimeout(() => { console.log("METAVIEWER_MAIN_READY"); console.log("METAVIEWER_RENDERER_READY"); }, 10); return { dispose: async () => {} }; }',
        'export { PACKAGED_ASSET_DIGESTS };',
        '',
      ].join('\n'),
    );
    await fs.writeFile(join(app, 'electron/nesting.js'), packaging.productionEntry);
    await sealRendererAssets(app);
    await createPackage(app, join(root, 'resources/app.asar'));
    await fs.rm(`${root}.sha256`);
    await writeManifest(root, `${root}.sha256`);
    await verifyInstall(root, 'arm64');

    const stagedApp = join(root, 'resources/staged-app');
    await fs.cp(app, stagedApp, { recursive: true });
    const realCore = join(root, 'resources/bin/metaviewer-core');
    const savedCore = await fs.readFile(realCore);
    const fakeCore = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(join(process.env.XDG_RUNTIME_DIR, 'metaviewer/core.sock'), '');\nsetInterval(() => {}, 1000);\n`;
    await fs.writeFile(realCore, fakeCore, { mode: 0o755 });
    try {
      // Negative control: intact sealed package boots and reaches mainDirectEntry.
      const intactRun = spawnSync(process.execPath, [join(stagedApp, 'electron/nesting.js')], {
        encoding: 'utf8',
        env: { ...process.env, MV_PACKAGE_SMOKE: '1', MV_SRF_BIN_DIR: '' },
        timeout: 10000,
      });
      assert.equal(intactRun.status, 0, intactRun.stderr || intactRun.stdout);
      assert.match(intactRun.stdout, /BOOT_MAIN_DIRECT_ENTRY_OK/);

      // Regression: tamper non-renderer executed JS (coreLauncher.js and preload.cjs) -> refused at verify AND at boot before mainDirectEntry.
      for (const target of ['electron/coreLauncher.js', 'dist/preload/preload.cjs']) {
        const file = join(stagedApp, target);
        const orig = await fs.readFile(file);
        try {
          await fs.appendFile(file, '\n// tampered\n');
          const tamperedBoot = spawnSync(process.execPath, [join(stagedApp, 'electron/nesting.js')], {
            encoding: 'utf8',
            env: { ...process.env, MV_PACKAGE_SMOKE: '1', MV_SRF_BIN_DIR: '' },
            timeout: 10000,
          });
          assert.notEqual(tamperedBoot.status, 0, `tampered ${target} must refuse boot`);
          assert.doesNotMatch(tamperedBoot.stdout, /BOOT_MAIN_DIRECT_ENTRY_OK/);
          assert.match(tamperedBoot.stderr, /PKG_SEAL_MISMATCH/);

          await fs.appendFile(join(app, target), '\n// tampered\n');
          await createPackage(app, join(root, 'resources/app.asar'));
          await assert.rejects(verifyPackagedSecurity(root), /ASAR asset mismatch/);
        } finally {
          await fs.writeFile(file, orig);
          await fs.writeFile(join(app, target), orig);
          await createPackage(app, join(root, 'resources/app.asar'));
        }
      }
    } finally {
      await fs.rm(stagedApp, { recursive: true, force: true });
      await fs.writeFile(realCore, savedCore, { mode: 0o755 });
    }
  });
});

test('R2-T4-021 / T7R3-008 writeManifest emits stock sha256sum -c grammar (* for 0755, space for 0644) and verifyInstall rejects mode-only drift', async () => {
  await fixture(async (root) => {
    await verifyInstall(root, 'arm64');
    const manifestBefore = await fs.readFile(`${root}.sha256`, 'utf8');
    assert.match(manifestBefore, /^[0-9a-f]{64} \*metaviewer$/m);
    assert.match(manifestBefore, /^[0-9a-f]{64} \*resources\/bin\/metaviewer-core$/m);
    assert.match(manifestBefore, /^[0-9a-f]{64} \*resources\/bin\/mv-daemon-adapter$/m);
    assert.match(manifestBefore, /^[0-9a-f]{64}  resources\/app\.asar$/m);

    const shaCheck = spawnSync('sha256sum', ['-c', `${root}.sha256`], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(shaCheck.status, 0, shaCheck.stderr || shaCheck.stdout);

    const adapter = join(root, 'resources/bin/mv-daemon-adapter');
    await fs.chmod(adapter, 0o700);
    await assert.rejects(verifyInstall(root, 'arm64'), /PKG_MANIFEST_MISMATCH: resources\/bin\/mv-daemon-adapter/);

    const altManifest = `${root}.alt.sha256`;
    await writeManifest(root, altManifest);
    const manifestAfter = await fs.readFile(altManifest, 'utf8');
    await fs.rm(altManifest);
    assert.notEqual(manifestAfter, manifestBefore);

    await fs.chmod(adapter, 0o755);
    await verifyInstall(root, 'arm64');

    const asarFile = join(root, 'resources/app.asar');
    const origAsarMode = (await fs.lstat(asarFile)).mode & 0o777;
    await fs.chmod(asarFile, 0o600);
    await assert.rejects(verifyInstall(root, 'arm64'), /PKG_MANIFEST_MISMATCH: resources\/app\.asar/);
    await fs.chmod(asarFile, origAsarMode);
    await verifyInstall(root, 'arm64');
  });
});

test('R2-T4-022 package.js imports and re-exports ELECTRON_PIN from main.js without literal version duplication', async () => {
  assert.equal(packaging.ELECTRON_PIN, MAIN_ELECTRON_PIN);
  for (const arch of ['arm64', 'x64']) {
    assert.equal(
      packageArchitecture(arch).archive,
      `electron-v${MAIN_ELECTRON_PIN}-linux-${arch}.zip`,
    );
  }
  const pkgSource = await fs.readFile(new URL('./package.js', import.meta.url), 'utf8');
  assert.match(pkgSource, /import\s*\{[^}]*\bELECTRON_PIN\b[^}]*\}\s*from\s*['"]\.\.\/electron\/main\.js['"]/);
  assert.equal(pkgSource.includes(MAIN_ELECTRON_PIN), false, 'package.js must not repeat literal Electron version');
  const mainSource = await fs.readFile(new URL('../electron/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, new RegExp(`export const ELECTRON_PIN = '${MAIN_ELECTRON_PIN.replace(/\./g, '\\.')}';`));
});

test('R2-T4-024 packaged boot enforces one total budget across socket wait and hello while preserving fast path', async () => {
  assert.equal(typeof packaging.runPackagedBootWait, 'function');
  // Virtual clock simulation of the exact report scenario: 10 s total budget, socket at 9.9 s + 2.9 s hello -> bounded at 10 s.
  let virtualNow = 0;
  let helloTimeoutMs = null;
  await assert.rejects(
    packaging.runPackagedBootWait({
      socketPath: '/nonexistent/core.sock',
      budgetMs: 10000,
      pollMs: 100,
      now: () => virtualNow,
      sleep: async (ms) => { virtualNow += ms; },
      checkSocket: async () => {
        if (virtualNow < 9900) throw new Error('ENOENT');
      },
      isFailed: () => false,
      startMain: async (remainingMs) => {
        helloTimeoutMs = remainingMs;
        virtualNow += 2900;
        throw new Error('PKG_CORE_START_FAILED');
      },
    }),
    /PKG_CORE_START_FAILED/,
  );
  assert.equal(helloTimeoutMs, 100, 'remaining budget after 9.9 s socket wait must be 100 ms, not a fresh 3 s budget');

  // Real timer test: socket appears at 160 ms of a 220 ms total budget, slow hello takes 200 ms -> rejected near 220 ms.
  const dir = await fs.mkdtemp(join(tmpdir(), 'mv-budget-'));
  try {
    const sock = join(dir, 'core.sock');
    setTimeout(() => { void fs.writeFile(sock, ''); }, 160);
    const t0 = Date.now();
    await assert.rejects(
      packaging.runPackagedBootWait({
        socketPath: sock,
        budgetMs: 220,
        pollMs: 20,
        isFailed: () => false,
        startMain: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 200)),
      }),
      /PKG_CORE_START_FAILED/,
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 340, `total boot wait must be bounded by single budget, got ${elapsed}ms`);

    // Negative control: fast path completes well within total budget.
    const fastResult = await packaging.runPackagedBootWait({
      socketPath: sock,
      budgetMs: 1000,
      pollMs: 10,
      isFailed: () => false,
      startMain: async () => ({ boot: 'ok' }),
    });
    assert.deepEqual(fastResult, { boot: 'ok' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // Exercise productionEntry itself under a 250 ms total boot budget when socket wait + mainDirectEntry exceed 250 ms.
  await fixture(async (root, app) => {
    await fs.writeFile(
      join(app, 'package.json'),
      JSON.stringify({ name: 'metaviewer', version: '0.1.2', type: 'module', main: 'electron/nesting.js' }),
    );
    await fs.writeFile(
      join(app, 'electron/coreLauncher.js'),
      'export function scrubChildEnv(env) { return { ...env }; }\nexport function validateKillTarget() { return false; }\n',
    );
    await fs.writeFile(
      join(app, 'electron/package-pin.json'),
      JSON.stringify({ version: '0.1.2', commit: 'a'.repeat(40) }),
    );
    await fs.writeFile(
      join(app, 'electron/main.js'),
      [
        'const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({}));',
        'export function validateRetailLaunch() { return { ok: true }; }',
        'export async function mainDirectEntry() { await new Promise(r => setTimeout(r, 200)); console.log("METAVIEWER_MAIN_READY"); console.log("METAVIEWER_RENDERER_READY"); return { dispose: async () => {} }; }',
        'export { PACKAGED_ASSET_DIGESTS };',
        '',
      ].join('\n'),
    );
    await fs.writeFile(join(app, 'electron/nesting.js'), packaging.productionEntry);
    await sealRendererAssets(app);
    const stagedApp = join(root, 'resources/staged-app');
    await fs.cp(app, stagedApp, { recursive: true });
    const realCore = join(root, 'resources/bin/metaviewer-core');
    const savedCore = await fs.readFile(realCore);
    const delayedCore = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nsetTimeout(() => { writeFileSync(join(process.env.XDG_RUNTIME_DIR, 'metaviewer/core.sock'), ''); }, 150);\nsetInterval(() => {}, 1000);\n`;
    await fs.writeFile(realCore, delayedCore, { mode: 0o755 });
    try {
      // 150ms socket + 200ms mainDirectEntry > 250ms total budget -> fails with PKG_CORE_START_FAILED.
      const overBudget = spawnSync(process.execPath, [join(stagedApp, 'electron/nesting.js')], {
        encoding: 'utf8',
        env: { ...process.env, MV_PACKAGE_SMOKE: '1', MV_SRF_BIN_DIR: '', MV_PKG_BOOT_BUDGET_MS: '250' },
        timeout: 5000,
      });
      assert.notEqual(overBudget.status, 0);
      assert.match(overBudget.stderr, /PKG_CORE_START_FAILED/);

      // Negative control: 150ms socket + 200ms mainDirectEntry < 1500ms total budget -> succeeds.
      const withinBudget = spawnSync(process.execPath, [join(stagedApp, 'electron/nesting.js')], {
        encoding: 'utf8',
        env: { ...process.env, MV_PACKAGE_SMOKE: '1', MV_SRF_BIN_DIR: '', MV_PKG_BOOT_BUDGET_MS: '1500' },
        timeout: 5000,
      });
      assert.equal(withinBudget.status, 0, withinBudget.stderr || withinBudget.stdout);
      assert.match(withinBudget.stdout, /METAVIEWER_MAIN_SMOKE_OK/);
    } finally {
      await fs.rm(stagedApp, { recursive: true, force: true });
      await fs.writeFile(realCore, savedCore, { mode: 0o755 });
    }
  });
});

test('T7R2C-006 sealRendererAssets sorts readdir entries and emits deterministic bytes when sealed twice or under shuffled readdir', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'mv-seal-order-'));
  try {
    const setupApp = async (name) => {
      const app = join(dir, name);
      for (const sub of ['dist/renderer/sub', 'dist/preload', 'electron']) {
        await fs.mkdir(join(app, sub), { recursive: true });
      }
      await fs.copyFile(new URL('../electron/main.js', import.meta.url), join(app, 'electron/main.js'));
      await fs.writeFile(join(app, 'electron/nesting.js'), packaging.productionEntry || 'entry');
      await fs.writeFile(join(app, 'dist/preload/preload.cjs'), 'preload-bytes');
      await fs.writeFile(join(app, 'dist/renderer/z.js'), 'console.log("z");');
      await fs.writeFile(join(app, 'dist/renderer/a.js'), 'console.log("a");');
      await fs.writeFile(join(app, 'dist/renderer/index.html'), '<html></html>');
      await fs.writeFile(join(app, 'dist/renderer/sub/m.css'), 'body{}');
      await fs.writeFile(join(app, 'dist/renderer/sub/b.css'), 'div{}');
      return app;
    };
    const appA = await setupApp('appA');
    const appB = await setupApp('appB');

    const forwardReaddir = async (target, opts) => {
      const list = await fs.readdir(target, opts);
      return [...list].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    };
    const reversedReaddir = async (target, opts) => {
      const list = await fs.readdir(target, opts);
      return [...list].sort((x, y) => (x.name > y.name ? -1 : x.name < y.name ? 1 : 0));
    };

    await sealRendererAssets(appA, { readdir: forwardReaddir });
    const mainAfterFirst = await fs.readFile(join(appA, 'electron/main.js'), 'utf8');
    // Seal twice on the same directory (idempotence + determinism).
    await sealRendererAssets(appA, { readdir: forwardReaddir });
    const mainAfterSecond = await fs.readFile(join(appA, 'electron/main.js'), 'utf8');
    assert.equal(mainAfterSecond, mainAfterFirst);

    // Negative control / shuffled readdir double: reverse directory entry order yields byte-identical output.
    await sealRendererAssets(appB, { readdir: reversedReaddir });
    const mainShuffled = await fs.readFile(join(appB, 'electron/main.js'), 'utf8');
    assert.equal(mainShuffled, mainAfterFirst);

    const prefix = 'const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze(';
    const sealedJson = mainShuffled.split(prefix)[1].split('));')[0];
    const keys = Object.keys(JSON.parse(sealedJson));
    assert.deepEqual(keys, [...keys].sort());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('W3-PKG-SMOKE2 diagnostics on PKG_SMOKE_MARKER_MISSING and non-zero child exit carry code, signal and last 3000 chars of stdout/stderr', async () => {
  assert.equal(SMOKE_DIAGNOSTIC_TAIL_CHARS, 3000);
  const droppedStdoutPrefix = 'DROPPED_STDOUT_HEAD_' + 'A'.repeat(480);
  const retainedStdoutTail = 'KEPT_STDOUT_TAIL_' + 'B'.repeat(3000 - 'KEPT_STDOUT_TAIL_'.length);
  const droppedStderrPrefix = 'DROPPED_STDERR_HEAD_' + 'C'.repeat(480);
  const retainedStderrTail = 'KEPT_STDERR_TAIL_' + 'D'.repeat(3000 - 'KEPT_STDERR_TAIL_'.length);
  assert.equal(retainedStdoutTail.length, 3000);
  assert.equal(retainedStderrTail.length, 3000);
  const longStdout = droppedStdoutPrefix + retainedStdoutTail;
  const longStderr = droppedStderrPrefix + retainedStderrTail;

  // 1. PKG_SMOKE_MARKER_MISSING (child exited 0, signal null, marker absent) carries code, signal, and last 3000 chars of stdout/stderr.
  await assert.rejects(
    runSmokeCommand(async () => ({
      code: 0,
      signal: null,
      stdout: longStdout,
      stderr: longStderr,
    })),
    (err) => {
      assert.match(err.message, /^PKG_SMOKE_MARKER_MISSING:/);
      assert.equal(err.code, 0);
      assert.equal(err.signal, null);
      assert.equal(err.stdout, retainedStdoutTail);
      assert.equal(err.stderr, retainedStderrTail);
      assert.equal(err.message.includes(retainedStdoutTail), true);
      assert.equal(err.message.includes(retainedStderrTail), true);
      assert.equal(err.message.includes('DROPPED_STDOUT_HEAD_'), false);
      assert.equal(err.message.includes('DROPPED_STDERR_HEAD_'), false);
      const parsed = JSON.parse(err.message.slice('PKG_SMOKE_MARKER_MISSING: '.length));
      assert.deepEqual(parsed, {
        code: 0,
        signal: null,
        stdout: retainedStdoutTail,
        stderr: retainedStderrTail,
      });
      return true;
    },
  );

  // Direct assertSmokeOutput also carries code, signal, and last 3000 chars of stdout/stderr.
  assert.throws(
    () => assertSmokeOutput(longStdout, { code: 0, signal: null, stderr: longStderr }),
    (err) => {
      assert.match(err.message, /^PKG_SMOKE_MARKER_MISSING:/);
      assert.equal(err.code, 0);
      assert.equal(err.signal, null);
      assert.equal(err.stdout, retainedStdoutTail);
      assert.equal(err.stderr, retainedStderrTail);
      return true;
    },
  );

  // 2. Non-zero child exit (rejected execFile error with exit code 1, signal null) carries code, signal, and last 3000 chars of stdout/stderr.
  await assert.rejects(
    runSmokeCommand(async () => {
      const childErr = Object.assign(new Error('Command failed: metaviewer'), {
        code: 1,
        signal: null,
        stdout: longStdout,
        stderr: longStderr,
      });
      throw childErr;
    }),
    (err) => {
      assert.match(err.message, /^PKG_SMOKE_CHILD_FAILED:/);
      assert.equal(err.code, 1);
      assert.equal(err.signal, null);
      assert.equal(err.stdout, retainedStdoutTail);
      assert.equal(err.stderr, retainedStderrTail);
      assert.equal(err.message.includes(retainedStdoutTail), true);
      assert.equal(err.message.includes(retainedStderrTail), true);
      assert.equal(err.message.includes('DROPPED_STDOUT_HEAD_'), false);
      assert.equal(err.message.includes('DROPPED_STDERR_HEAD_'), false);
      const parsed = JSON.parse(err.message.slice('PKG_SMOKE_CHILD_FAILED: '.length));
      assert.deepEqual(parsed, {
        code: 1,
        signal: null,
        stdout: retainedStdoutTail,
        stderr: retainedStderrTail,
      });
      return true;
    },
  );

  // 3. Signal-terminated child exit (code null, signal SIGABRT) carries code, signal, and last 3000 chars of stdout/stderr.
  await assert.rejects(
    runSmokeCommand(async () => {
      const sigErr = Object.assign(new Error('Command terminated by signal'), {
        code: null,
        signal: 'SIGABRT',
        stdout: longStdout,
        stderr: longStderr,
      });
      throw sigErr;
    }),
    (err) => {
      assert.match(err.message, /^PKG_SMOKE_CHILD_FAILED:/);
      assert.equal(err.code, null);
      assert.equal(err.signal, 'SIGABRT');
      assert.equal(err.stdout, retainedStdoutTail);
      assert.equal(err.stderr, retainedStderrTail);
      const parsed = JSON.parse(err.message.slice('PKG_SMOKE_CHILD_FAILED: '.length));
      assert.deepEqual(parsed, {
        code: null,
        signal: 'SIGABRT',
        stdout: retainedStdoutTail,
        stderr: retainedStderrTail,
      });
      return true;
    },
  );

  // 4. Negative control: zero exit with exact METAVIEWER_MAIN_SMOKE_OK marker succeeds.
  const okResult = await runSmokeCommand(async () => ({
    code: 0,
    signal: null,
    stdout: `${longStdout}\nMETAVIEWER_MAIN_SMOKE_OK\nMETAVIEWER_RENDERER_READY\n`,
    stderr: longStderr,
  }));
  assert.equal(okResult.code, 0);
  assert.equal(okResult.signal, null);
});

test('W3-PKG-SMOKE2 productionEntry flushes smoke marker and errors to non-TTY pipes before immediate app.exit', async () => {
  await fixture(async (root, app) => {
    const loaderPath = join(root, 'resources/electron-pipe-loader.mjs');
    // Loader simulates Electron's immediate C++ Browser::Exit on app.exit(code) when Node's
    // user-space stdout/stderr stream buffers are corked/unflushed on a non-TTY pipe, and
    // emits window-all-closed during boot.dispose() to exercise the teardown race.
    const loaderSource = [
      'export async function resolve(specifier, context, nextResolve) {',
      '  if (specifier === "electron") {',
      '    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent([',
      '      "import { EventEmitter } from \\"node:events\\";",',
      '      "const emitter = new EventEmitter();",',
      '      "export const app = {",',
      '      "  on: (ev, fn) => emitter.on(ev, fn),",',
      '      "  removeAllListeners: (ev) => emitter.removeAllListeners(ev),",',
      '      "  emit: (ev, ...args) => emitter.emit(ev, ...args),",',
      '      "  quit: () => {",',
      '      "    let prevented = false;",',
      '      "    emitter.emit(\\"will-quit\\", { preventDefault: () => { prevented = true; } });",',
      '      "    if (!prevented) { process.kill(process.pid, \\"SIGKILL\\"); }",',
      '      "  },",',
      '      "  exit: (code) => {",',
      '      "    process.stdout.cork();",',
      '      "    process.stderr.cork();",',
      '      "    if (process.stdout._writableState) process.stdout._writableState.length = 0;",',
      '      "    if (process.stderr._writableState) process.stderr._writableState.length = 0;",',
      '      "    process.exit(code);",',
      '      "  },",',
      '      "};",',
      '      "export const protocol = { registerSchemesAsPrivileged: () => {} };",',
      '    ].join("\\n")) };',
      '  }',
      '  return nextResolve(specifier, context);',
      '}',
      '',
    ].join('\n');
    await fs.writeFile(loaderPath, loaderSource, 'utf8');

    await fs.writeFile(
      join(app, 'package.json'),
      JSON.stringify({ name: 'metaviewer', version: '0.1.2', type: 'module', main: 'electron/nesting.js' }),
    );
    await fs.writeFile(
      join(app, 'electron/coreLauncher.js'),
      'export function scrubChildEnv(env) { return { ...env }; }\nexport function validateKillTarget() { return false; }\n',
    );
    await fs.writeFile(
      join(app, 'electron/package-pin.json'),
      JSON.stringify({ version: '0.1.2', commit: 'a'.repeat(40) }),
    );
    await fs.writeFile(
      join(app, 'electron/main.js'),
      [
        'import { writeSync } from "node:fs";',
        'const PACKAGED_ASSET_DIGESTS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({}));',
        'export function validateRetailLaunch(argv) {',
        '  if (argv.includes("--remote-debugging-port=9222")) return { ok: false, code: "RETAIL_FLAG" };',
        '  return { ok: true };',
        '}',
        'export function registerPrivilegedScheme() {}',
        'export async function mainDirectEntry() {',
        '  const { app } = await import("electron");',
        '  if (process.stdout.isTTY || process.stderr.isTTY) throw new Error("EXPECTED_NON_TTY_PIPE");',
        '  process.stdout.cork();',
        '  process.stderr.cork();',
        '  writeSync(1, "NON_TTY_STDOUT_PIPE=" + String(Boolean(process.stdout.isTTY)) + "\\n");',
        '  app.on("window-all-closed", () => { app.quit(); });',
        '  setTimeout(() => { console.log("METAVIEWER_MAIN_READY"); console.log("METAVIEWER_RENDERER_READY"); }, 10);',
        '  return {',
        '    adapter: process.env.MV_TEST_ADAPTER_FAIL === "1"',
        '      ? { getStatus: () => ({ availability: "degraded", handshakeSeen: false }) }',
        '      : { getStatus: () => ({ availability: "live", handshakeSeen: true }) },',
        '    dispose: async () => {',
        '      app.emit("window-all-closed");',
        '      await new Promise(r => setTimeout(r, 20));',
        '    },',
        '  };',
        '}',
        'export { PACKAGED_ASSET_DIGESTS };',
        '',
      ].join('\n'),
    );
    await fs.writeFile(join(app, 'electron/nesting.js'), packaging.productionEntry);
    await sealRendererAssets(app);

    const stagedApp = join(root, 'resources/staged-app');
    await fs.cp(app, stagedApp, { recursive: true });
    const realCore = join(root, 'resources/bin/metaviewer-core');
    const savedCore = await fs.readFile(realCore);
    const fakeCore = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(join(process.env.XDG_RUNTIME_DIR, 'metaviewer/core.sock'), '');\nsetInterval(() => {}, 1000);\n`;
    await fs.writeFile(realCore, fakeCore, { mode: 0o755 });

    const runPipedChild = (extraArgs = [], extraEnv = {}) => new Promise((resolveRun, rejectRun) => {
      const registerScript = `import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register(pathToFileURL(${JSON.stringify(loaderPath)}).href);`;
      const child = spawn(
        process.execPath,
        ['--import', `data:text/javascript,${encodeURIComponent(registerScript)}`, join(stagedApp, 'electron/nesting.js'), ...extraArgs],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, MV_PACKAGE_SMOKE: '1', MV_SRF_BIN_DIR: '/tmp/srf-bin', ...extraEnv },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', rejectRun);
      child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
    });

    try {
      // 1. Positive piped run: stdout is a non-TTY pipe, corked before app.exit(0), window-all-closed fires during dispose,
      // and METAVIEWER_MAIN_SMOKE_OK still reaches the parent pipe before exit 0.
      const passRun = await runPipedChild();
      assert.equal(passRun.code, 0, `expected exit 0, got code=${passRun.code} signal=${passRun.signal} stderr=${passRun.stderr}`);
      assert.equal(passRun.signal, null);
      assert.match(passRun.stdout, /^NON_TTY_STDOUT_PIPE=false$/m);
      assert.match(passRun.stdout, /^METAVIEWER_MAIN_READY$/m);
      assert.match(passRun.stdout, /^METAVIEWER_MAIN_SMOKE_OK$/m);
      assertSmokeOutput(passRun.stdout, passRun);

      // 2. Negative control A (adapter failure before app.exit(1) on corked non-TTY pipe):
      // PKG_ADAPTER_START_FAILED reaches stderr pipe and METAVIEWER_MAIN_SMOKE_OK is absent.
      const failAdapterRun = await runPipedChild([], { MV_TEST_ADAPTER_FAIL: '1' });
      assert.equal(failAdapterRun.code, 1);
      assert.equal(failAdapterRun.signal, null);
      assert.match(failAdapterRun.stderr, /PKG_ADAPTER_START_FAILED/);
      assert.doesNotMatch(failAdapterRun.stdout, /METAVIEWER_MAIN_SMOKE_OK/);
      assert.throws(() => assertSmokeOutput(failAdapterRun.stdout, failAdapterRun), /PKG_SMOKE_MARKER_MISSING/);

      // 3. Negative control B (retail flag refusal before app.exit(1) on corked non-TTY pipe):
      // RETAIL_FLAG reaches stderr pipe before app.exit(1).
      const failRetailRun = await runPipedChild(['--remote-debugging-port=9222']);
      assert.equal(failRetailRun.code, 1);
      assert.equal(failRetailRun.signal, null);
      assert.match(failRetailRun.stderr, /RETAIL_FLAG: retail launch refused/);
      assert.doesNotMatch(failRetailRun.stdout, /METAVIEWER_MAIN_SMOKE_OK/);

      // 4. Negative control C (pre-fix console.log without synchronous fd write loses marker on buffered pipe before app.exit(0)):
      const unpatchedEntry = packaging.productionEntry
        .replace("writeFdSync(1, format(...args));", "process.stdout.write(format(...args) + '\\n');")
        .replace("writeFdSync(1, 'METAVIEWER_MAIN_SMOKE_OK\\n');", "process.stdout.write('METAVIEWER_MAIN_SMOKE_OK\\n');");
      await fs.writeFile(join(app, 'electron/nesting.js'), unpatchedEntry);
      await sealRendererAssets(app);
      await fs.cp(app, stagedApp, { recursive: true, force: true });
      const unpatchedRun = await runPipedChild();
      assert.equal(unpatchedRun.code, 0);
      assert.doesNotMatch(unpatchedRun.stdout, /^METAVIEWER_MAIN_SMOKE_OK$/m);
      assert.throws(() => assertSmokeOutput(unpatchedRun.stdout, unpatchedRun), /^Error: PKG_SMOKE_MARKER_MISSING:/);
    } finally {
      await fs.rm(stagedApp, { recursive: true, force: true });
      await fs.rm(loaderPath, { force: true });
      await fs.writeFile(realCore, savedCore, { mode: 0o755 });
    }
  });
});

test('W3-PKG-SMOKE2 cleanInstallSmoke keeps marker, adapter receipt and source-access trace mandatory and builds byte-deterministically', async () => {
  const pkgSource = await fs.readFile(fileURLToPath(new URL('./package.js', import.meta.url)), 'utf8');
  assert.match(pkgSource, /assertSmokeOutput\(/);
  assert.match(pkgSource, /await verifySmokeAdapterReceipt\(receiptPath,\s*srfBinDir\)/);
  assert.match(pkgSource, /throw new Error\('PKG_SOURCE_ACCESS'\)/);

  await fixture(async (root) => {
    const dirA = await fs.mkdtemp(join(tmpdir(), 'mv-det-a-'));
    const dirB = await fs.mkdtemp(join(tmpdir(), 'mv-det-b-'));
    try {
      const rootA = join(dirA, 'MetaViewer-linux-arm64');
      const rootB = join(dirB, 'MetaViewer-linux-arm64');
      await fs.cp(root, rootA, { recursive: true });
      await fs.cp(root, rootB, { recursive: true });
      await fs.copyFile(`${root}.sha256`, `${rootA}.sha256`);
      await fs.copyFile(`${root}.sha256`, `${rootB}.sha256`);
      await fs.utimes(join(rootB, 'metaviewer'), new Date(1700000000000), new Date(1700000000000));

      const buildA = await bundlePackage(rootA, 'arm64');
      const buildB = await bundlePackage(rootB, 'arm64');
      assert.equal(buildA.artifact_sha256, buildB.artifact_sha256);
      const [bytesA, bytesB] = await Promise.all([
        fs.readFile(buildA.artifact),
        fs.readFile(buildB.artifact),
      ]);
      assert.equal(Buffer.compare(bytesA, bytesB), 0);
    } finally {
      await fs.rm(dirA, { recursive: true, force: true });
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });

});

test('W3-CI-JS-ASAR ci.yml js job primes locked ui npm dependencies before running tests/ci regressions', async () => {
  const ciPath = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
  const ciText = await fs.readFile(ciPath, 'utf8');
  const checkJsOrder = (workflowText) => {
    const jsAfter = workflowText.split('\n  js:\n')[1];
    if (!jsAfter) return false;
    const jsBlock = jsAfter.split(/\n  [a-z][\w-]*:\n/)[0];
    const primeMatch = /      - name: Prime locked npm cache\n        working-directory: ui\n        run: \|\n(?:          .*\n)+/.exec(jsBlock);
    const regressionsIndex = jsBlock.indexOf('      - name: Test CI admission regressions\n');
    const runGatesIndex = jsBlock.indexOf('      - name: Run JS gates\n');
    if (!primeMatch || regressionsIndex < 0 || runGatesIndex < 0) return false;
    if (!primeMatch[0].includes('npm ci --ignore-scripts --no-audit --no-fund')) return false;
    return primeMatch.index < regressionsIndex && regressionsIndex < runGatesIndex;
  };
  assert.equal(checkJsOrder(ciText), true, 'js job must install ui dependencies before Test CI admission regressions');

  // Negative control: moving Prime locked npm cache after Test CI admission regressions is rejected.
  const jsAfter = ciText.split('\n  js:\n')[1];
  const jsBlock = jsAfter.split(/\n  [a-z][\w-]*:\n/)[0];
  const primeBlock = /      - name: Prime locked npm cache\n        working-directory: ui\n        run: \|\n(?:          .*\n)+/.exec(jsBlock)[0];
  const regBlock = /      - name: Test CI admission regressions\n        run: \|\n(?:          .*\n)+/.exec(jsBlock)[0];
  const mutatedJsBlock = jsBlock.replace(primeBlock, '').replace(regBlock, regBlock + primeBlock);
  const mutatedCiText = ciText.replace(jsBlock, mutatedJsBlock);
  assert.notEqual(mutatedCiText, ciText);
  assert.equal(checkJsOrder(mutatedCiText), false, 'regression order check must reject unprimed tests/ci execution');
});

test('W3-ADOPT-J7-R2 verifyElectronZip and verifyElectronDist bind zip and lockfile-installed dist and print expected/actual identity on PKG_ELECTRON_CHECKSUM', async () => {
  const createHash = (await import('node:crypto')).createHash;
  const dir = await fs.mkdtemp(join(tmpdir(), 'mv-j7r2-bind-'));
  try {
    for (const [arch, machine] of /** @type {const} */ ([['arm64', 183], ['x64', 62]])) {
      const archDir = join(dir, arch);
      const distDir = join(archDir, 'node_modules/electron/dist');
      const zipDir = join(archDir, 'zips');
      const xdgCache = join(archDir, 'xdg-cache');
      await fs.mkdir(distDir, { recursive: true });
      await fs.mkdir(zipDir, { recursive: true });

      const elf = Buffer.alloc(64);
      elf.write('\x7fELF');
      elf[4] = 2;
      elf[5] = 1;
      elf.writeUInt16LE(machine, 18);
      await fs.writeFile(join(distDir, 'electron'), elf, { mode: 0o755 });
      await fs.writeFile(join(distDir, 'version'), `${MAIN_ELECTRON_PIN}\n`, { mode: 0o644 });
      await fs.writeFile(join(distDir, 'resources.pak'), `pristine-pak-${arch}`, { mode: 0o644 });

      const { archive } = packageArchitecture(arch);
      const zipPath = join(zipDir, archive);
      const zipRun = spawnSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: distDir });
      assert.equal(zipRun.status, 0, zipRun.stderr?.toString() || 'zip failed');
      const zipBytes = await fs.readFile(zipPath);
      const expectedZipSha = createHash('sha256').update(zipBytes).digest('hex');
      const { treeSha256: expectedTreeSha } = await computeElectronDistTreeDigest(distDir);

      // Copy locked npm wrapper files into archDir/node_modules/electron and package-lock.json into archDir.
      const uiRoot = fileURLToPath(new URL('../', import.meta.url));
      await fs.copyFile(join(uiRoot, 'package-lock.json'), join(archDir, 'package-lock.json'));
      const wrapperDir = join(archDir, 'node_modules/electron');
      for (const fileName of Object.keys(LOCKED_ELECTRON_NPM_FILES)) {
        await fs.copyFile(join(uiRoot, 'node_modules/electron', fileName), join(wrapperDir, fileName));
      }

      const customChecksumsPath = join(archDir, 'custom-checksums.json');
      await fs.writeFile(
        customChecksumsPath,
        JSON.stringify({
          [archive]: expectedZipSha,
          'electron.d.ts': LOCKED_ELECTRON_NPM_FILES['electron.d.ts'],
        }),
      );

      // 1. Source A: Zip directory binding (MV_ELECTRON_ZIP_DIR / verifyElectronZip).
      const zipVerified = await verifyElectronZip(zipDir, arch, { checksumsPath: customChecksumsPath });
      assert.equal(zipVerified.archive, archive);
      assert.equal(zipVerified.archiveSha256, expectedZipSha);

      // Negative control (tampered zip in zipDir): fails with PKG_ELECTRON_CHECKSUM and prints expected & actual SHA-256.
      const tamperedZipBytes = Buffer.from(zipBytes);
      tamperedZipBytes[tamperedZipBytes.length - 1] ^= 0xff;
      const tamperedZipSha = createHash('sha256').update(tamperedZipBytes).digest('hex');
      await fs.writeFile(zipPath, tamperedZipBytes);
      await assert.rejects(
        verifyElectronZip(zipDir, arch, { checksumsPath: customChecksumsPath }),
        (err) => {
          assert.equal(err.code, 'PKG_ELECTRON_CHECKSUM');
          assert.equal(err.expected, expectedZipSha);
          assert.equal(err.actual, tamperedZipSha);
          assert.match(err.message, /^PKG_ELECTRON_CHECKSUM:/);
          assert.equal(err.message.includes(`expected=${expectedZipSha}`), true);
          assert.equal(err.message.includes(`actual=${tamperedZipSha}`), true);
          return true;
        },
      );
      await fs.writeFile(zipPath, zipBytes);

      // 2. Source B: Unpacked dist installed by lockfile, verified via @electron/get release URL cache (hosted x64 & arm64 path).
      const releaseUrl = `https://github.com/electron/electron/releases/download/v${MAIN_ELECTRON_PIN}`;
      const urlHash = createHash('sha256').update(releaseUrl).digest('hex');
      const cachedZipDir = join(xdgCache, 'electron', urlHash);
      await fs.mkdir(cachedZipDir, { recursive: true });
      const cachedZipPath = join(cachedZipDir, archive);
      await fs.copyFile(zipPath, cachedZipPath);

      const candidates = defaultElectronZipCandidates(archive, { XDG_CACHE_HOME: xdgCache });
      assert.equal(candidates[0], cachedZipPath);

      const distVerified = await verifyElectronDist(distDir, arch, {
        checksumsPath: customChecksumsPath,
        lockfilePath: join(archDir, 'package-lock.json'),
        ignorePinnedTrees: true,
        env: { XDG_CACHE_HOME: xdgCache },
      });
      assert.equal(distVerified.archiveSha256, expectedZipSha);
      assert.equal(distVerified.treeSha256, expectedTreeSha);

      // Negative control (tampered dist file): fails with PKG_ELECTRON_CHECKSUM and prints expected & actual tree/file digests.
      await fs.writeFile(join(distDir, 'resources.pak'), `tampered-pak-${arch}`, { mode: 0o644 });
      const { treeSha256: tamperedTreeSha } = await computeElectronDistTreeDigest(distDir);
      assert.notEqual(tamperedTreeSha, expectedTreeSha);
      await assert.rejects(
        verifyElectronDist(distDir, arch, {
          checksumsPath: customChecksumsPath,
          lockfilePath: join(archDir, 'package-lock.json'),
          ignorePinnedTrees: true,
          env: { XDG_CACHE_HOME: xdgCache },
        }),
        (err) => {
          assert.equal(err.code, 'PKG_ELECTRON_CHECKSUM');
          assert.equal(err.expected, expectedTreeSha);
          assert.equal(err.actual, tamperedTreeSha);
          assert.match(err.message, /^PKG_ELECTRON_CHECKSUM:/);
          assert.equal(err.message.includes('file=resources.pak'), true);
          assert.equal(err.message.includes(`expected=${expectedTreeSha}`), true);
          assert.equal(err.message.includes(`actual=${tamperedTreeSha}`), true);
          return true;
        },
      );
      await fs.writeFile(join(distDir, 'resources.pak'), `pristine-pak-${arch}`, { mode: 0o644 });

      // Negative control (tampered cached zip for unpacked dist): fails with PKG_ELECTRON_CHECKSUM and prints expected & actual zip SHA-256.
      await fs.writeFile(cachedZipPath, tamperedZipBytes);
      await assert.rejects(
        verifyElectronDist(distDir, arch, {
          checksumsPath: customChecksumsPath,
          lockfilePath: join(archDir, 'package-lock.json'),
          zipCandidates: [cachedZipPath],
        }),
        (err) => {
          assert.equal(err.code, 'PKG_ELECTRON_CHECKSUM');
          assert.equal(err.expected, expectedZipSha);
          assert.equal(err.actual, tamperedZipSha);
          assert.match(err.message, /^PKG_ELECTRON_CHECKSUM:/);
          assert.equal(err.message.includes(`expected=${expectedZipSha}`), true);
          assert.equal(err.message.includes(`actual=${tamperedZipSha}`), true);
          return true;
        },
      );
      await fs.writeFile(cachedZipPath, zipBytes);

      // Negative control (tampered lockfile integrity): fails with PKG_ELECTRON_CHECKSUM and prints expected & actual integrity.
      const tamperedLockPath = join(archDir, 'tampered-package-lock.json');
      const lockObj = JSON.parse(await fs.readFile(join(archDir, 'package-lock.json'), 'utf8'));
      lockObj.packages['node_modules/electron'].integrity = 'sha512-tampered';
      await fs.writeFile(tamperedLockPath, JSON.stringify(lockObj));
      await assert.rejects(
        verifyElectronLockfileBinding(distDir, null, { lockfilePath: tamperedLockPath }),
        (err) => {
          assert.equal(err.code, 'PKG_ELECTRON_CHECKSUM');
          assert.equal(err.expected, LOCKED_ELECTRON_PACKAGE_INTEGRITY);
          assert.equal(err.actual, 'sha512-tampered');
          assert.equal(err.message.includes(`expected=${LOCKED_ELECTRON_PACKAGE_INTEGRITY}`), true);
          assert.equal(err.message.includes('actual=sha512-tampered'), true);
          return true;
        },
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

export async function checkCleanCiReproPrerequisites(env = process.env) {
  const { dirname } = await import('node:path');
  const uiRoot = fileURLToPath(new URL('../', import.meta.url));
  const { archive } = packageArchitecture(process.arch);
  const prevHome = process.env.HOME;
  let zipCandidates;
  try {
    if (env !== process.env && typeof env.HOME === 'string') {
      process.env.HOME = env.HOME;
    }
    zipCandidates = defaultElectronZipCandidates(archive, env);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }

  let existingCachedZip = null;
  for (const candidate of zipCandidates) {
    const st = await fs.stat(candidate).catch(() => null);
    if (st?.isFile()) {
      existingCachedZip = candidate;
      break;
    }
  }

  const fallbackDist =
    env.ELECTRON_OVERRIDE_DIST_PATH !== undefined
      ? env.ELECTRON_OVERRIDE_DIST_PATH
      : join(uiRoot, 'node_modules/electron/dist');
  let hasFallbackDist = false;
  if (fallbackDist) {
    const requiredFiles = ['electron', 'version', 'resources.pak'];
    const checks = await Promise.all(
      requiredFiles.map((name) =>
        fs
          .stat(join(fallbackDist, name))
          .then((st) => st.isFile())
          .catch(() => false),
      ),
    );
    hasFallbackDist = checks.every(Boolean);
  }

  if (!existingCachedZip && !hasFallbackDist) {
    const detail = `CLEAN_CI_REPRO_PREREQ: PKG_CLEAN_CI_PREREQ_ELECTRON_MISSING archive=${archive} fallbackDist=${fallbackDist || 'none'}`;
    writeFdSync(2, detail);
    return {
      ok: false,
      code: 'PKG_CLEAN_CI_PREREQ_ELECTRON_MISSING',
      reason: detail,
      existingCachedZip: null,
      fallbackDist: fallbackDist || null,
    };
  }

  const npmCacheDir =
    env.npm_config_cache ||
    env.NPM_CONFIG_CACHE ||
    (env.HOME ? join(env.HOME, '.npm') : '');
  const contentRoot = npmCacheDir ? join(npmCacheDir, '_cacache/content-v2/sha512') : '';
  const lockRaw = await fs.readFile(join(uiRoot, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(lockRaw);
  const missingPackages = [];
  for (const [pkgPath, entry] of Object.entries(lock.packages || {})) {
    if (!pkgPath || !entry || typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      continue;
    }
    if (entry.optional && Array.isArray(entry.os) && !entry.os.includes('linux')) continue;
    if (entry.optional && Array.isArray(entry.cpu) && !entry.cpu.includes(process.arch)) continue;
    const hex = Buffer.from(entry.integrity.slice('sha512-'.length), 'base64').toString('hex');
    const blobPath = contentRoot ? join(contentRoot, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)) : '';
    const st = blobPath ? await fs.stat(blobPath).catch(() => null) : null;
    if (!st?.isFile()) {
      missingPackages.push(pkgPath);
    }
  }
  if (missingPackages.length > 0) {
    const detail = `CLEAN_CI_REPRO_PREREQ: PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING cache=${npmCacheDir || 'none'} missing=${missingPackages.length} first=${missingPackages[0]}`;
    writeFdSync(2, detail);
    return {
      ok: false,
      code: 'PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING',
      reason: detail,
      existingCachedZip,
      fallbackDist: hasFallbackDist ? fallbackDist : null,
      missingPackages,
    };
  }

  const npmCandidates = [join(dirname(process.execPath), 'npm'), 'npm'];
  let npmBin = 'npm';
  for (const candidate of npmCandidates) {
    try {
      await fs.access(candidate);
      npmBin = candidate;
      break;
    } catch {}
  }

  const detail = `CLEAN_CI_REPRO_PREREQ: PKG_CLEAN_CI_PREREQ_OK zip=${existingCachedZip || 'none'} dist=${hasFallbackDist ? fallbackDist : 'none'} cache=${npmCacheDir}`;
  writeFdSync(2, detail);
  return {
    ok: true,
    code: 'PKG_CLEAN_CI_PREREQ_OK',
    reason: detail,
    existingCachedZip,
    fallbackDist: hasFallbackDist ? fallbackDist : null,
    npmCacheDir,
    npmBin,
  };
}

export async function runHostedCleanNpmCiRepro(env = process.env) {
  const prereq = await checkCleanCiReproPrerequisites(env);
  assert.equal(prereq.ok, true, `${prereq.code}: ${prereq.reason}`);
  const { dirname } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const uiRoot = fileURLToPath(new URL('../', import.meta.url));
  const tempRoot = await fs.mkdtemp(join(tmpdir(), 'mv-j7r2-npmci-'));
  try {
    const tempUi = join(tempRoot, 'ui');
    await fs.mkdir(tempUi, { recursive: true });
    await fs.copyFile(join(uiRoot, 'package.json'), join(tempUi, 'package.json'));
    await fs.copyFile(join(uiRoot, 'package-lock.json'), join(tempUi, 'package-lock.json'));

    const npmCandidates = [join(dirname(process.execPath), 'npm'), 'npm'];
    let npmBin = 'npm';
    for (const candidate of npmCandidates) {
      try {
        await fs.access(candidate);
        npmBin = candidate;
        break;
      } catch {}
    }

    const childEnv = {
      ...env,
      PATH: `${dirname(process.execPath)}:${env.PATH || process.env.PATH || ''}`,
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    };
    const ciRun = spawnSync(
      npmBin,
      ['--prefix', tempUi, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        encoding: 'utf8',
        env: childEnv,
        timeout: 60000,
      },
    );
    assert.equal(ciRun.status, 0, `npm ci --offline failed: ${ciRun.stderr || ciRun.stdout}`);

    const { archive } = packageArchitecture(process.arch);
    const existingCachedZip = prereq.existingCachedZip;

    const tempDist = join(tempUi, 'node_modules/electron/dist');
    if (existingCachedZip) {
      // Exact hosted workflow step: run node_modules/electron/install.js offline against @electron/get's local cache.
      const installRun = spawnSync(process.execPath, [join(tempUi, 'node_modules/electron/install.js')], {
        cwd: tempUi,
        encoding: 'utf8',
        env: { ...env, ELECTRON_OVERRIDE_DIST_PATH: '' },
        timeout: 60000,
      });
      assert.equal(installRun.status, 0, `electron/install.js failed: ${installRun.stderr || installRun.stdout}`);
    } else {
      const fallbackDist = env.ELECTRON_OVERRIDE_DIST_PATH || join(uiRoot, 'node_modules/electron/dist');
      await fs.cp(fallbackDist, tempDist, { recursive: true });
    }

    // 1. Default verification (uses pinned tree + lockfile wrapper check + cached zip check).
    const verifiedPinned = await verifyElectronDist(tempDist, process.arch, {
      lockfilePath: join(tempUi, 'package-lock.json'),
      requireLockfileWrapper: true,
    });
    assert.match(verifiedPinned.archiveSha256, /^[0-9a-f]{64}$/);
    assert.match(verifiedPinned.treeSha256, /^[0-9a-f]{64}$/);

    // 2. Hosted runner reproduction (ignorePinnedTrees: true forces the hosted x64 path that unpacks and compares the @electron/get cached zip).
    if (existingCachedZip) {
      const verifiedHostedPath = await verifyElectronDist(tempDist, process.arch, {
        lockfilePath: join(tempUi, 'package-lock.json'),
        requireLockfileWrapper: true,
        ignorePinnedTrees: true,
      });
      assert.equal(verifiedHostedPath.archiveSha256, verifiedPinned.archiveSha256);
      assert.equal(verifiedHostedPath.treeSha256, verifiedPinned.treeSha256);
    }

    // 3. Negative control on the clean npm ci --offline dist: tampering a file in dist fails with PKG_ELECTRON_CHECKSUM and prints expected/actual identity.
    const pakPath = join(tempDist, 'resources.pak');
    const origPak = await fs.readFile(pakPath);
    try {
      await fs.appendFile(pakPath, 'tampered');
      const { treeSha256: actualTamperedTree } = await computeElectronDistTreeDigest(tempDist);
      await assert.rejects(
        verifyElectronDist(tempDist, process.arch, {
          lockfilePath: join(tempUi, 'package-lock.json'),
          requireLockfileWrapper: true,
        }),
        (err) => {
          assert.equal(err.code, 'PKG_ELECTRON_CHECKSUM');
          assert.equal(err.expected, verifiedPinned.treeSha256);
          assert.equal(err.actual, actualTamperedTree);
          assert.equal(err.message.includes(`expected=${verifiedPinned.treeSha256}`), true);
          assert.equal(err.message.includes(`actual=${actualTamperedTree}`), true);
          return true;
        },
      );
    } finally {
      await fs.writeFile(pakPath, origPak);
    }

    // 4. Negative control on a zip in tempRoot: tampered zip fails verifyElectronZip with PKG_ELECTRON_CHECKSUM and prints expected/actual identity.
    const fakeZipDir = join(tempRoot, 'zip-dir');
    await fs.mkdir(fakeZipDir, { recursive: true });
    const fakeZipPath = join(fakeZipDir, archive);
    const badBytes = Buffer.from('not-a-valid-electron-release-zip');
    const badSha = createHash('sha256').update(badBytes).digest('hex');
    await fs.writeFile(fakeZipPath, badBytes);
    await assert.rejects(
      verifyElectronZip(fakeZipDir, process.arch, {
        checksumsPath: join(tempUi, 'node_modules/electron/checksums.json'),
      }),
      (err) => {
        assert.equal(err.code, 'PKG_ELECTRON_CHECKSUM');
        assert.equal(err.expected, verifiedPinned.archiveSha256);
        assert.equal(err.actual, badSha);
        assert.equal(err.message.includes(`expected=${verifiedPinned.archiveSha256}`), true);
        assert.equal(err.message.includes(`actual=${badSha}`), true);
        return true;
      },
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('W3-ADOPT-J7-R2 prerequisite check fails closed with typed codes when Electron dist/cache or offline npm cache is absent', async () => {
  const tempRoot = await fs.mkdtemp(join(tmpdir(), 'mv-j7r2-prereq-'));
  try {
    const emptyHome = join(tempRoot, 'empty-home');
    await fs.mkdir(emptyHome, { recursive: true });
    const envNoElectron = {
      ...process.env,
      HOME: emptyHome,
      XDG_CACHE_HOME: join(emptyHome, '.cache'),
      electron_config_cache: join(emptyHome, '.cache/electron'),
      ELECTRON_OVERRIDE_DIST_PATH: join(emptyHome, 'missing-dist'),
      npm_config_cache: join(emptyHome, '.npm'),
    };
    const prereqNoElectron = await checkCleanCiReproPrerequisites(envNoElectron);
    assert.equal(prereqNoElectron.ok, false);
    assert.equal(prereqNoElectron.code, 'PKG_CLEAN_CI_PREREQ_ELECTRON_MISSING');
    await assert.rejects(runHostedCleanNpmCiRepro(envNoElectron), /PKG_CLEAN_CI_PREREQ_ELECTRON_MISSING/);

    const fakeDist = join(tempRoot, 'fake-dist');
    await fs.mkdir(fakeDist, { recursive: true });
    await fs.writeFile(join(fakeDist, 'electron'), 'stub');
    await fs.writeFile(join(fakeDist, 'version'), `${MAIN_ELECTRON_PIN}\n`);
    await fs.writeFile(join(fakeDist, 'resources.pak'), 'stub-pak');
    const envNoNpmCache = {
      ...envNoElectron,
      ELECTRON_OVERRIDE_DIST_PATH: fakeDist,
    };
    const prereqNoNpm = await checkCleanCiReproPrerequisites(envNoNpmCache);
    assert.equal(prereqNoNpm.ok, false);
    assert.equal(prereqNoNpm.code, 'PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING');
    assert.equal(Array.isArray(prereqNoNpm.missingPackages) && prereqNoNpm.missingPackages.length > 0, true);
    await assert.rejects(runHostedCleanNpmCiRepro(envNoNpmCache), /PKG_CLEAN_CI_PREREQ_NPM_CACHE_MISSING/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

const shouldRunCleanNpmCiRepro =
  process.env.MV_CHECK_CLEAN_CI_PREREQ_ONLY === '1'
    ? false
    : process.env.MV_REQUIRE_CLEAN_CI_REPRO === '1' || process.env.MV_RUN_CLEAN_NPM_CI_REPRO === '1'
      ? true
      : process.env.MV_RUN_CLEAN_NPM_CI_REPRO === '0'
        ? false
        : (await checkCleanCiReproPrerequisites(process.env)).ok;

if (shouldRunCleanNpmCiRepro) {
  test('W3-ADOPT-J7-R2 reproduce hosted case locally with a dist from a clean npm ci --offline in a temp copy', async () => {
    await runHostedCleanNpmCiRepro(process.env);
  });
}

test(
  'W2-AC01-PKGSTART cleanInstallSmoke runs real Go mv-daemon-adapter leg with /dev/shm MV_SRF_PROFILES, enforces negative control without MV_SRF_PROFILES, and removes /dev/shm dir in every exit path',
  { timeout: 120000 },
  async () => {
    const listShmDirs = async () => {
      const entries = await fs.readdir('/dev/shm').catch(() => []);
      return new Set(entries.filter((name) => name.startsWith('mv-pkg-')));
    };

    const tempRoot = await fs.mkdtemp(join(tmpdir(), 'mv-w2-pkgstart-'));
    const beforeShm = await listShmDirs();
    try {
      const arch = process.arch;
      const { name: pkgName } = packageArchitecture(arch);
      const root = join(tempRoot, pkgName);
      const app = join(tempRoot, 'app');
      const daemonAdapterSrc = fileURLToPath(new URL('../../daemon-adapter', import.meta.url));
      const contractsSrc = fileURLToPath(new URL('../../contracts/v0.2', import.meta.url));
      const electronSrc = fileURLToPath(new URL('../electron', import.meta.url));

      await fs.mkdir(join(root, 'resources/bin'), { recursive: true });
      await fs.cp(contractsSrc, join(root, 'resources/contracts/v0.2'), { recursive: true });
      await fs.writeFile(join(root, 'INSTALL.md'), '# MetaViewer Test Install\n', { mode: 0o644 });

      // 1. Build the real Go mv-daemon-adapter binary into resources/bin/mv-daemon-adapter.
      const goBin = process.env.GO || 'go';
      const goBuild = spawnSync(
        goBin,
        [
          'build',
          '-trimpath',
          '-buildvcs=false',
          '-ldflags=-buildid=',
          '-o',
          join(root, 'resources/bin/mv-daemon-adapter'),
          './cmd/mv-daemon-adapter',
        ],
        {
          cwd: daemonAdapterSrc,
          env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
          encoding: 'utf8',
          timeout: 60000,
        },
      );
      assert.equal(goBuild.status, 0, `go build failed: ${goBuild.stderr || goBuild.error?.message || ''}`);

      // 2. Compile small C ELF launchers for metaviewer (with fuse wire) and metaviewer-core.
      const ccBin = process.env.CC || 'cc';
      const metaviewerC = join(tempRoot, 'metaviewer.c');
      const coreC = join(tempRoot, 'metaviewer-core.c');
      await fs.writeFile(
        metaviewerC,
        [
          '#include <limits.h>',
          '#include <stdio.h>',
          '#include <stdlib.h>',
          '#include <string.h>',
          '#include <unistd.h>',
          '__attribute__((used)) static const unsigned char fuse_wire[] =',
          '  "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\\x01\\x09" "101100011";',
          'int main(int argc, char **argv) {',
          '  if (fuse_wire[0] == 0) return 99;',
          '  char self[PATH_MAX];',
          '  ssize_t n = readlink("/proc/self/exe", self, sizeof(self) - 1);',
          '  if (n <= 0) return 98;',
          '  self[n] = \'\\0\';',
          '  char *slash = strrchr(self, \'/\');',
          '  if (!slash) return 97;',
          '  *slash = \'\\0\';',
          '  char script[PATH_MAX];',
          '  snprintf(script, sizeof(script), "%s/resources/staged-app/electron/nesting.js", self);',
          '  char **new_argv = calloc((size_t)argc + 2, sizeof(char *));',
          '  if (!new_argv) return 96;',
          `  new_argv[0] = ${JSON.stringify(process.execPath)};`,
          '  new_argv[1] = script;',
          '  for (int i = 1; i < argc; i++) new_argv[i + 1] = argv[i];',
          '  new_argv[argc + 1] = NULL;',
          `  execv(${JSON.stringify(process.execPath)}, new_argv);`,
          '  return 95;',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        coreC,
        [
          '#include <limits.h>',
          '#include <stdio.h>',
          '#include <stdlib.h>',
          '#include <string.h>',
          '#include <unistd.h>',
          'int main(void) {',
          '  char self[PATH_MAX];',
          '  ssize_t n = readlink("/proc/self/exe", self, sizeof(self) - 1);',
          '  if (n <= 0) return 98;',
          '  self[n] = \'\\0\';',
          '  char *slash = strrchr(self, \'/\');',
          '  if (!slash) return 97;',
          '  *slash = \'\\0\';',
          '  char script[PATH_MAX];',
          '  snprintf(script, sizeof(script), "%s/../staged-app/fake-core.mjs", self);',
          `  char *new_argv[] = { ${JSON.stringify(process.execPath)}, script, NULL };`,
          `  execv(${JSON.stringify(process.execPath)}, new_argv);`,
          '  return 95;',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      const ccMain = spawnSync(ccBin, ['-O2', '-o', join(root, 'metaviewer'), metaviewerC], {
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.equal(ccMain.status, 0, `cc metaviewer failed: ${ccMain.stderr || ''}`);
      const ccCore = spawnSync(
        ccBin,
        ['-O2', '-o', join(root, 'resources/bin/metaviewer-core'), coreC],
        { encoding: 'utf8', timeout: 60000 },
      );
      assert.equal(ccCore.status, 0, `cc metaviewer-core failed: ${ccCore.stderr || ''}`);
      await applyFuses(join(root, 'metaviewer'), buildFuseConfig());

      // 3. Stage app with the real ui/electron/main.js and ui/electron/coreLauncher.js.
      for (const dir of ['electron', 'dist/renderer', 'dist/preload']) {
        await fs.mkdir(join(app, dir), { recursive: true });
      }
      await fs.writeFile(join(app, 'dist/renderer/index.html'), '<!doctype html><html><head><title>MetaViewer</title></head><body>MetaViewer</body></html>', 'utf8');
      await fs.writeFile(join(app, 'dist/preload/preload.cjs'), '"use strict";\n', 'utf8');
      await fs.copyFile(join(electronSrc, 'main.js'), join(app, 'electron/main.js'));
      await fs.appendFile(join(app, 'electron/main.js'), '\nexport { mainDirectEntry };\n');
      await fs.copyFile(join(electronSrc, 'coreLauncher.js'), join(app, 'electron/coreLauncher.js'));
      await fs.writeFile(
        join(app, 'electron/hostBindings.js'),
        [
          'export async function createMainBindings() {',
          '  const coreStatus = { availability: "live", pid: process.pid, authority_epoch: 1, reason: null };',
          '  return {',
          '    core: {',
          '      start: async () => coreStatus,',
          '      request: async () => ({}),',
          '      dispose: async () => {},',
          '      getStatus: () => coreStatus,',
          '    },',
          '    wire: { frames: { subscribe: () => () => {} } },',
          '  };',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        join(app, 'electron/authorityWire.js'),
        'export function installAuthorityWire() { return { dispose: async () => {} }; }\n',
        'utf8',
      );
      await fs.writeFile(
        join(app, 'electron/captureBridge.js'),
        'export function installCaptureBridge() { return { dispose: async () => {} }; }\n',
        'utf8',
      );
      const commit = 'a'.repeat(40);
      await fs.writeFile(
        join(app, 'electron/package-pin.json'),
        JSON.stringify({ version: '0.1.2', commit }),
        'utf8',
      );
      await fs.writeFile(join(app, 'electron/nesting.js'), packaging.productionEntry, 'utf8');
      await fs.writeFile(
        join(app, 'package.json'),
        JSON.stringify({ name: 'metaviewer', version: '0.1.2', type: 'module', main: 'electron/nesting.js' }),
        'utf8',
      );
      await sealRendererAssets(app);
      await createPackage(app, join(root, 'resources/app.asar'));

      // 4. Populate resources/staged-app so the ELF wrappers run outside the repo with zero source access.
      const stagedApp = join(root, 'resources/staged-app');
      await fs.cp(app, stagedApp, { recursive: true });
      const electronModDir = join(stagedApp, 'node_modules/electron');
      await fs.mkdir(electronModDir, { recursive: true });
      await fs.writeFile(
        join(electronModDir, 'package.json'),
        JSON.stringify({ name: 'electron', version: MAIN_ELECTRON_PIN, main: 'index.cjs' }),
        'utf8',
      );
      await fs.writeFile(
        join(electronModDir, 'index.cjs'),
        [
          '"use strict";',
          'const { EventEmitter } = require("node:events");',
          'const { resolve } = require("node:path");',
          `Object.defineProperty(process.versions, "electron", { value: ${JSON.stringify(MAIN_ELECTRON_PIN)}, configurable: true });`,
          'Object.defineProperty(process, "resourcesPath", { value: resolve(__dirname, "../../.."), configurable: true });',
          'const emitter = new EventEmitter();',
          'const app = {',
          '  isPackaged: true,',
          '  requestSingleInstanceLock: () => true,',
          '  whenReady: async () => {},',
          '  on: (ev, fn) => { emitter.on(ev, fn); },',
          '  removeAllListeners: (ev) => { emitter.removeAllListeners(ev); },',
          '  emit: (ev, ...args) => emitter.emit(ev, ...args),',
          '  quit: () => { emitter.emit("will-quit", { preventDefault: () => {} }); },',
          '  exit: (code) => { process.exit(code); },',
          '  getAppPath: () => resolve(__dirname, "../.."),',
          '  getPath: () => resolve(__dirname, "../../user-data"),',
          '};',
          'let protocolHandler;',
          'const ipcHandlers = new Map();',
          'const contentsListeners = new Map();',
          'const protocol = {',
          '  registerSchemesAsPrivileged: () => {},',
          '  handle: (_, handler) => { protocolHandler = handler; },',
          '  unhandle: () => {},',
          '};',
          'const session = {',
          '  defaultSession: {',
          '    setPermissionRequestHandler: () => {},',
          '    setPermissionCheckHandler: () => {},',
          '  },',
          '};',
          'const ipcMain = {',
          '  handle: (channel, handler) => { ipcHandlers.set(channel, handler); },',
          '  removeHandler: () => {},',
          '};',
          'class BrowserWindow {',
          '  constructor() {',
          '    this.webContents = {',
          '      id: 1,',
          '      mainFrame: {',
          '        url: "app://metaviewer/index.html",',
          '        origin: "app://metaviewer",',
          '        parent: null,',
          '        routingId: 1,',
          '        processId: 1,',
          '      },',
          '      isDestroyed: () => false,',
          '      session: {',
          '        setPermissionRequestHandler: () => {},',
          '        setPermissionCheckHandler: () => {},',
          '      },',
          '      setWindowOpenHandler: () => {},',
          '      on: (name, handler) => { contentsListeners.set(name, handler); },',
          '      setUserAgent: () => {},',
          '      loadURL: async (url) => {',
          '        await protocolHandler({ url });',
          '        contentsListeners.get("did-finish-load")?.();',
          '        ipcHandlers.get("metaviewer:renderer-ready")?.({ sender: this.webContents, senderFrame: this.webContents.mainFrame });',
          '      },',
          '      send: () => {},',
          '    };',
          '  }',
          '  once(ev, fn) { if (ev === "ready-to-show" && typeof fn === "function") fn(); }',
          '  show() {}',
          '  destroy() {}',
          '}',
          'module.exports = { app, protocol, session, ipcMain, BrowserWindow };',
          '',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        join(stagedApp, 'fake-core.mjs'),
        [
          'import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createServer } from "node:net";',
          'import { join } from "node:path";',
          'const config = JSON.parse(readFileSync(process.env.MV_CORE_CONFIG, "utf8"));',
          'const daemonPeer = config.peers.find((p) => p.endpoint.component === "daemon");',
          'const sockPath = join(process.env.XDG_RUNTIME_DIR, "metaviewer/core.sock");',
          'const eventsDir = join(process.env.XDG_STATE_HOME, "metaviewer", "sessions", config.session_id, "events");',
          'const server = createServer((conn) => {',
          '  let buf = "";',
          '  conn.on("data", (chunk) => {',
          '    buf += chunk.toString("utf8");',
          '    if (!buf.includes("\\n")) return;',
          '    const line = buf.split("\\n")[0];',
          '    buf = "";',
          '    const msg = JSON.parse(line);',
          '    if (',
          '      msg.from?.component !== "daemon" ||',
          '      msg.body?.schema !== "hello/v0.2" ||',
          '      msg.body?.component !== daemonPeer.hello.component ||',
          '      msg.body?.component_version !== daemonPeer.hello.component_version ||',
          '      msg.body?.component_commit !== daemonPeer.hello.component_commit ||',
          '      msg.body?.contract_version !== daemonPeer.hello.contract_version',
          '    ) {',
          '      conn.destroy();',
          '      return;',
          '    }',
          '    conn.write(JSON.stringify({',
          '      schema: "envelope/v0.2",',
          '      msg_id: "core-hello-1",',
          '      ts_ns: 1,',
          '      from: config.core.endpoint,',
          '      to: msg.from,',
          '      session_id: config.session_id,',
          '      seq: 1,',
          '      nonce: "core-nonce-1",',
          '      body: config.core.hello,',
          '    }) + "\\n", () => {',
          '      mkdirSync(eventsDir, { recursive: true, mode: 0o700 });',
          '      writeFileSync(join(eventsDir, "1.json"), JSON.stringify({ seq: 1, event: "Connect", component: "daemon" }) + "\\n", { mode: 0o600 });',
          '    });',
          '  });',
          '});',
          'server.listen(sockPath, () => {',
          '  try { chmodSync(sockPath, 0o600); } catch {}',
          '});',
          'process.on("SIGTERM", () => { server.close(() => process.exit(0)); });',
          'process.on("SIGINT", () => { server.close(() => process.exit(0)); });',
          '',
        ].join('\n'),
        'utf8',
      );

      await packaging.normalizePackageModes(root);
      await writeManifest(root, `${root}.sha256`);
      const { artifact } = await bundlePackage(root, arch);

      // 5. Run the full cleanInstallSmoke(artifact), exercising:
      //    - fake-adapter smoke leg
      //    - real Go mv-daemon-adapter smoke leg with /dev/shm/mv-pkg-* MV_SRF_PROFILES
      //    - negative control without MV_SRF_PROFILES (fails with configuration error and no METAVIEWER_MAIN_SMOKE_OK)
      //    - retail flag refusal leg
      const smokeResult = await packaging.cleanInstallSmoke(artifact);
      assert.deepEqual(smokeResult, {
        marker: 'METAVIEWER_MAIN_SMOKE_OK',
        source_access: false,
        negative_controls: 'PASS',
      });

      // MUT-RENDERER-FORBIDDEN: mutate the real protocol handler, not a marker.
      const stagedMain = join(stagedApp, 'electron/main.js');
      const savedMain = await fs.readFile(stagedMain, 'utf8');
      const mutantMain = savedMain.replace('export async function handleAppRequest(rendererRoot, request, options) {',
        'export async function handleAppRequest(rendererRoot, request, options) { return new Response("forbidden", { status: 403 });');
      assert.notEqual(mutantMain, savedMain);
      try {
        await fs.writeFile(stagedMain, mutantMain);
        await sealRendererAssets(stagedApp);
        await fs.rm(`${root}.sha256`, { force: true });
        await writeManifest(root, `${root}.sha256`);
        await fs.rm(artifact, { force: true });
        await bundlePackage(root, arch);
        await assert.rejects(() => packaging.cleanInstallSmoke(artifact), err => {
          assert.match(err.message, /PKG_RENDERER_READY_TIMEOUT/);
          assert.doesNotMatch(String(err.stdout ?? ''), /^METAVIEWER_RENDERER_READY$/m);
          assert.doesNotMatch(String(err.stdout ?? ''), /^METAVIEWER_MAIN_SMOKE_OK$/m);
          return true;
        });
      } finally {
        await fs.writeFile(stagedMain, savedMain);
        await sealRendererAssets(stagedApp);
        await fs.rm(`${root}.sha256`, { force: true });
        await writeManifest(root, `${root}.sha256`);
        await fs.rm(artifact, { force: true });
        await bundlePackage(root, arch);
      }

      const afterPassShm = await listShmDirs();
      for (const name of afterPassShm) {
        assert.equal(beforeShm.has(name), true, `leaked /dev/shm/${name} after passing cleanInstallSmoke`);
      }

      // 5b. Direct negative control against the real Go mv-daemon-adapter without MV_SRF_PROFILES:
      //     fails with configuration: profile map or live profile/root required, ADAPTER_CRASHED,
      //     and no METAVIEWER_MAIN_SMOKE_OK.
      const negSrfBin = await fs.mkdtemp(join(tempRoot, 'direct-neg-srf-bin-'));
      const negSrfState = await fs.mkdtemp(join(tempRoot, 'direct-neg-srf-state-'));
      const negSrfIdentity = await fs.mkdtemp(join(tempRoot, 'direct-neg-srf-id-'));
      for (const d of [negSrfBin, negSrfState, negSrfIdentity]) await fs.chmod(d, 0o700);
      const directNoProfiles = spawnSync(
        join(root, 'metaviewer'),
        [`--user-data-dir=${join(tempRoot, 'direct-neg-profile')}`],
        {
          cwd: tempRoot,
          env: {
            PATH: process.env.PATH,
            HOME: tempRoot,
            LANG: 'C.UTF-8',
            MV_PACKAGE_SMOKE: '1',
            MV_SRF_BIN_DIR: negSrfBin,
            MV_SRF_STATE_DIR: negSrfState,
            SRF_IDENTITY_STORE_ROOT: negSrfIdentity,
          },
          encoding: 'utf8',
          timeout: 60000,
        },
      );
      assert.notEqual(directNoProfiles.status, 0);
      assert.match(
        `${directNoProfiles.stderr}\n${directNoProfiles.stdout}`,
        /configuration:\s*profile map or live profile\/root required/,
      );
      assert.match(`${directNoProfiles.stderr}\n${directNoProfiles.stdout}`, /ADAPTER_CRASHED/);
      assert.doesNotMatch(String(directNoProfiles.stdout ?? ''), /^METAVIEWER_MAIN_SMOKE_OK$/m);

      // 6. Verify /dev/shm/mv-pkg-* cleanup on failure path as well:
      //    Replace resources/bin/mv-daemon-adapter with a binary that exits 1 with stderr error,
      //    re-bundle, and confirm cleanInstallSmoke rejects with PKG_ADAPTER_START_FAILED / ADAPTER_CRASHED
      //    and still removes its /dev/shm/mv-pkg-* directory.
      const failingAdapterC = join(tempRoot, 'failing-adapter.c');
      await fs.writeFile(
        failingAdapterC,
        '#include <stdio.h>\nint main(void) { fprintf(stderr, "simulated adapter failure\\n"); return 2; }\n',
        'utf8',
      );
      const ccFailAdapter = spawnSync(
        ccBin,
        ['-O2', '-o', join(root, 'resources/bin/mv-daemon-adapter'), failingAdapterC],
        { encoding: 'utf8', timeout: 60000 },
      );
      assert.equal(ccFailAdapter.status, 0);
      await fs.rm(`${root}.sha256`, { force: true });
      await fs.rm(artifact, { force: true });
      await packaging.normalizePackageModes(root);
      await writeManifest(root, `${root}.sha256`);
      const { artifact: failingArtifact } = await bundlePackage(root, arch);

      await assert.rejects(
        () => packaging.cleanInstallSmoke(failingArtifact),
        (err) => {
          assert.match(err.message, /^PKG_SMOKE_CHILD_FAILED:/);
          assert.match(err.message, /ADAPTER_CRASHED|PKG_ADAPTER_START_FAILED/);
          assert.doesNotMatch(String(err.stdout ?? ''), /^METAVIEWER_MAIN_SMOKE_OK$/m);
          return true;
        },
      );

      const afterFailShm = await listShmDirs();
      for (const name of afterFailShm) {
        assert.equal(beforeShm.has(name), true, `leaked /dev/shm/${name} after failing cleanInstallSmoke`);
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
