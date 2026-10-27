// [TARGET, unit decision] Run with node --test tools/test_package_clean_install.mjs.
// Real product: node tools/package.js --smoke /external/MetaViewer-linux-arm64.tar.
// All fixtures are outside the checkout; no source mutation or skipped tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createPackage } from '@electron/asar';
import { buildFuseConfig } from '../electron/main.js';
import { createAdapterLauncher } from '../electron/coreLauncher.js';
import { packageArchitecture, verifyBinary, applyFuses, assertSmokeOutput, bundlePackage, sealRendererAssets, verifyInstall, verifySmokeAdapterReceipt, writeFakeSmokeAdapter, writeManifest } from './package.js';

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
  assertSmokeOutput('METAVIEWER_MAIN_SMOKE_OK\n');
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
