import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsStore } from '../electron/authorityWire.js';
import { scrubChildEnv, validateKillTarget } from '../electron/coreLauncher.js';
import {
  ELECTRON_PIN,
   computeElectronDistTreeDigest,
  createPackagedBootLifecycle,
  packageArchitecture,
  packageShell,
  publishBundle,
  publishStagedPackage,
  resolvePackagedConfigHome,
  validateOutput,
  verifyElectronDist,
  writeManifest,
} from '../tools/package.js';

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

test('R3-T4-001 / R1-096 verifyElectronDist rejects unanchored external dist with self-consistent sibling checksums.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-r3-t4-001-'));
  try {
    for (const [arch, machine] of /** @type {const} */ ([['arm64', 183], ['x64', 62]])) {
      const extWrapper = join(root, `ext-${arch}`);
      const dist = join(extWrapper, 'dist');
      await mkdir(dist, { recursive: true });
      const elf = Buffer.alloc(64);
      elf.write('\x7fELF');
      elf[4] = 2;
      elf[5] = 1;
      elf.writeUInt16LE(machine, 18);
      await writeFile(join(dist, 'electron'), elf, { mode: 0o755 });
      await writeFile(join(dist, 'version'), `${ELECTRON_PIN}\n`, { mode: 0o644 });
      await writeFile(join(dist, 'tampered-payload.bin'), `untrusted-${arch}-payload`, { mode: 0o644 });

      const { archive } = packageArchitecture(arch);
      const { treeSha256, files } = await computeElectronDistTreeDigest(dist);
      const forgedChecksums = JSON.stringify({
        [archive]: 'a'.repeat(64),
        [`${archive}:tree`]: treeSha256,
        [`${archive}:files`]: Object.fromEntries(files.entries()),
      });
      // Write forged self-authenticating checksums.json both in parent dir and inside dist
      await writeFile(join(extWrapper, 'checksums.json'), forgedChecksums);
      await writeFile(join(dist, 'checksums.json'), forgedChecksums);

      await assert.rejects(
        () => verifyElectronDist(dist, arch),
        (err) => {
          assert.equal(err.code, 'PKG_ELECTRON_CHECKSUM');
          assert.match(err.message, /^PKG_ELECTRON_CHECKSUM:/);
          return true;
        },
      );

      // Even if a forged package.json is placed in parent dir,LOCKED_ELECTRON_NPM_FILES rejects it
      await writeFile(join(extWrapper, 'package.json'), JSON.stringify({ name: 'electron', version: ELECTRON_PIN }));
      await assert.rejects(
        () => verifyElectronDist(dist, arch),
        (err) => {
          assert.equal(err.code, 'PKG_ELECTRON_CHECKSUM');
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R3-T4-008 (T20) packaged boot cleans runtime on early ENV_PATH throw, normal quit, and guards late signals with virtual clock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-r3-t4-008-'));
  try {
    // 1. Early boot failure (relative PATH -> ENV_PATH refusal in scrubChildEnv) cleans up runtime dir
    await assert.rejects(
      () =>
        createPackagedBootLifecycle({
          tmpRoot: root,
          env: { PATH: 'relative', HOME: root, LANG: 'C.UTF-8' },
          scrubChildEnv,
          validateKillTarget,
        }),
      /ENV_PATH/,
    );
    const leakedAfterEarlyThrow = (await readdir(root)).filter((name) => name.startsWith('mv-pkg-'));
    assert.deepEqual(leakedAfterEarlyThrow, []);

    // 2. Normal quit (will-quit / exit) cleans up runtime dir and guards signals when child already exited
    /** @type {Array<[number, string | number | undefined]>} */
    const signals = [];
    /** @type {Array<{ fn: () => void, ms: number, cleared: boolean }>} */
    const timers = [];
    const appListeners = new Map();
    const procListeners = new Map();
    const fakeChild = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: /** @type {number | null} */ (null),
      signalCode: /** @type {string | null} */ (null),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    const lifecycle = await createPackagedBootLifecycle({
      tmpRoot: root,
      env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8' },
      scrubChildEnv,
      validateKillTarget,
      spawn: () => /** @type {any} */ (fakeChild),
      kill: (pid, sig) => {
        signals.push([pid, sig]);
      },
      setTimeout: /** @type {any} */ ((fn, ms) => {
        const handle = { fn, ms, cleared: false };
        timers.push(handle);
        return handle;
      }),
      clearTimeout: /** @type {any} */ ((handle) => {
        if (handle) handle.cleared = true;
      }),
      app: {
        on: (event, fn) => appListeners.set(event, fn),
        removeAllListeners: (event) => {
          if (event) appListeners.delete(event);
        },
        exit: () => {},
      },
      processObj: {
        pid: 1000,
        on: (event, fn) => procListeners.set(event, fn),
        exit: () => {},
      },
    });

    await access(lifecycle.runtime);

    // Simulate child already exited before will-quit / exit hooks run: zero signals may be sent (PID-reuse guard)
    fakeChild.exitCode = 0;
    appListeners.get('will-quit')?.({});
    procListeners.get('exit')?.();
    assert.deepEqual(signals, []);
    await assert.rejects(access(lifecycle.runtime), { code: 'ENOENT' });

    // 3. Virtual clock 1500 ms SIGKILL escalation in stop() when child is live and hangs
    const fakeChildHang = Object.assign(new EventEmitter(), {
      pid: 5353,
      exitCode: /** @type {number | null} */ (null),
      signalCode: /** @type {string | null} */ (null),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const lifecycleHang = await createPackagedBootLifecycle({
      tmpRoot: root,
      env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8' },
      scrubChildEnv,
      validateKillTarget,
      spawn: () => /** @type {any} */ (fakeChildHang),
      kill: (pid, sig) => {
        signals.push([pid, sig]);
        if (sig === 'SIGKILL') {
          fakeChildHang.signalCode = 'SIGKILL';
          fakeChildHang.emit('exit', null, 'SIGKILL');
        }
      },
      setTimeout: /** @type {any} */ ((fn, ms) => {
        const handle = { fn, ms, cleared: false };
        timers.push(handle);
        return handle;
      }),
      clearTimeout: /** @type {any} */ ((handle) => {
        if (handle) handle.cleared = true;
      }),
      processObj: { pid: 1000, on: () => {}, exit: () => {} },
    });

    const stopPromise = lifecycleHang.stop();
    // Wait one microtask turn so stop() registers the exit listener and 1500 ms timer
    await Promise.resolve();
    assert.deepEqual(signals, [[5353, 'SIGTERM']]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 1500);
    // Fire the virtual 1500 ms timer immediately without sleeping
    timers[0].fn();
    await stopPromise;
    assert.deepEqual(signals, [
      [5353, 'SIGTERM'],
      [5353, 'SIGKILL'],
    ]);
    assert.equal(timers[0].cleared, true);
    await assert.rejects(access(lifecycleHang.runtime), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R3-T4-009 (T21) packaged settings persist across two launches in caller XDG_CONFIG_HOME and survive runtime cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-r3-t4-009-'));
  try {
    const persistentConfigHome = join(root, 'user-config');
    const appRoot = join(root, 'app-root');
    await mkdir(appRoot, { recursive: true });

    // Launch 1: boot packaged lifecycle, save settings via authorityWire settings store, then stop()
    const env1 = {
      PATH: '/usr/bin:/bin',
      HOME: root,
      XDG_CONFIG_HOME: persistentConfigHome,
      LANG: 'C.UTF-8',
    };
    const fakeChild1 = Object.assign(new EventEmitter(), {
      pid: 6101,
      exitCode: 0,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const launch1 = await createPackagedBootLifecycle({
      tmpRoot: root,
      appRoot,
      env: env1,
      scrubChildEnv,
      validateKillTarget,
      spawn: () => /** @type {any} */ (fakeChild1),
    });
    assert.equal(launch1.configHome, persistentConfigHome);
    assert.equal(env1.XDG_CONFIG_HOME, persistentConfigHome);

    const store1 = createSettingsStore(env1);
    const savedPayload = {
      scheme: 'mv-dark',
      density: 'compact',
    };
    await store1.save(JSON.stringify(savedPayload));
    await launch1.stop();
    await assert.rejects(access(launch1.runtime), { code: 'ENOENT' });

    // Launch 2: fresh packaged boot with same caller XDG_CONFIG_HOME reads back Launch 1 settings
    const env2 = {
      PATH: '/usr/bin:/bin',
      HOME: root,
      XDG_CONFIG_HOME: persistentConfigHome,
      LANG: 'C.UTF-8',
    };
    const fakeChild2 = Object.assign(new EventEmitter(), {
      pid: 6102,
      exitCode: 0,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const launch2 = await createPackagedBootLifecycle({
      tmpRoot: root,
      appRoot,
      env: env2,
      scrubChildEnv,
      validateKillTarget,
      spawn: () => /** @type {any} */ (fakeChild2),
    });
    assert.notEqual(launch2.runtime, launch1.runtime);
    assert.equal(launch2.configHome, persistentConfigHome);

    const store2 = createSettingsStore(env2);
    const loadedPayload = await store2.load();
    assert.deepEqual(JSON.parse(loadedPayload), savedPayload);
    await launch2.stop();
    await assert.rejects(access(launch2.runtime), { code: 'ENOENT' });

    // Fallback check: if XDG_CONFIG_HOME points inside runtime or is relative, resolvePackagedConfigHome falls back safely
    const sampleRuntime = join(root, 'mv-pkg-xyz');
    assert.equal(
      resolvePackagedConfigHome({ XDG_CONFIG_HOME: 'relative/config' }, sampleRuntime, appRoot),
      join(sampleRuntime, 'config'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R3-T4-010 / R1-097 (T26) concurrent publishBundle rollback preserves winner and recovers half-published crash state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-r3-t4-010-'));
  try {
    assert.equal(publishBundle, publishStagedPackage);
    const outputDir = join(root, 'out');
    await mkdir(outputDir, { recursive: true });
    const finalDir = join(outputDir, 'MetaViewer-linux-arm64');

    // Stage Winner A and Loser B with distinct payloads
    const workA = join(root, 'work-a');
    const stagedA = join(workA, 'staged');
    await mkdir(stagedA, { recursive: true });
    await writeFile(join(stagedA, 'metaviewer'), 'winner-A-binary', { mode: 0o755 });
    await writeFile(join(stagedA, 'INSTALL.md'), 'winner-A-readme\n', { mode: 0o644 });

    const workB = join(root, 'work-b');
    const stagedB = join(workB, 'staged');
    await mkdir(stagedB, { recursive: true });
    await writeFile(join(stagedB, 'metaviewer'), 'loser-B-binary', { mode: 0o755 });
    await writeFile(join(stagedB, 'INSTALL.md'), 'loser-B-readme\n', { mode: 0o644 });

    // Deterministic barrier: let A publish completely, then verify B is refused with typed EEXIST
    const pubA = await publishStagedPackage(stagedA, workA, finalDir);
    assert.equal(pubA, undefined);
    await assert.rejects(
      () => publishStagedPackage(stagedB, workB, finalDir),
      (err) => {
        assert.equal(err.code, 'EEXIST');
        assert.match(err.message, /Package destination already exists/);
        return true;
      },
    );
    assert.equal(await readFile(join(finalDir, 'INSTALL.md'), 'utf8'), 'winner-A-readme\n');
    const shaA = spawnSync('sha256sum', ['-c', `${finalDir}.sha256`], {
      cwd: finalDir,
      encoding: 'utf8',
    });
    assert.equal(shaA.status, 0, shaA.stderr || shaA.stdout);

    // Interleaving 1 (rendezvous barrier): both A and B pass pre-checks and reach rename;
    // loser B2 renames finalManifest first, then winner W renames finalManifest and finalDir,
    // then loser B2 fails on finalDir.
    const stagedB2 = join(workB, 'staged-2');
    await mkdir(stagedB2, { recursive: true });
    await writeFile(join(stagedB2, 'metaviewer'), 'loser-B2-binary', { mode: 0o755 });
    await writeFile(join(stagedB2, 'INSTALL.md'), 'loser-B2-readme\n', { mode: 0o644 });

    const outRace = join(root, 'out-race');
    await mkdir(outRace, { recursive: true });
    const raceFinal = join(outRace, 'MetaViewer-linux-arm64');
    const workW = join(root, 'work-w');
    const stagedW = join(workW, 'staged');
    await mkdir(stagedW, { recursive: true });
    await writeFile(join(stagedW, 'metaviewer'), 'winner-W-binary', { mode: 0o755 });
    await writeFile(join(stagedW, 'INSTALL.md'), 'winner-W-readme\n', { mode: 0o644 });

    let markWinnerReady;
    const winnerReadyForRename = new Promise((resolve) => {
      markWinnerReady = resolve;
    });
    let releaseLoserDirRename;
    const loserCanTryDirRename = new Promise((resolve) => {
      releaseLoserDirRename = resolve;
    });
    let releaseWinner;
    const loserWroteManifest = new Promise((resolve) => {
      releaseWinner = resolve;
    });

    const winnerPromise = publishStagedPackage(stagedW, workW, raceFinal, {
      rename: async (src, dst) => {
        if (dst === `${raceFinal}.sha256`) {
          markWinnerReady();
          await loserWroteManifest;
        }
        const res = await import('node:fs/promises').then((m) => m.rename(src, dst));
        if (dst === raceFinal) {
          releaseLoserDirRename();
        }
        return res;
      },
    });

    const loserPromise = publishStagedPackage(stagedB2, workB, raceFinal, {
      rename: async (src, dst) => {
        if (dst === `${raceFinal}.sha256`) {
          await winnerReadyForRename;
          const res = await import('node:fs/promises').then((m) => m.rename(src, dst));
          releaseWinner();
          return res;
        }
        await loserCanTryDirRename;
        return import('node:fs/promises').then((m) => m.rename(src, dst));
      },
    });

    await Promise.all([
      winnerPromise,
      assert.rejects(loserPromise, /ENOTEMPTY|EEXIST|already exists/),
    ]);

    // Winner's directory AND winner's manifest must both survive intact and pass sha256sum -c!
    assert.equal(await readFile(join(raceFinal, 'INSTALL.md'), 'utf8'), 'winner-W-readme\n');
    await assert.rejects(access(join(outRace, '.pkg-commit-MetaViewer-linux-arm64')), { code: 'ENOENT' });
    const shaRace = spawnSync('sha256sum', ['-c', `${raceFinal}.sha256`], {
      cwd: raceFinal,
      encoding: 'utf8',
    });
    assert.equal(shaRace.status, 0, shaRace.stderr || shaRace.stdout);

    // Interleaving 2 (loser's manifest lands on disk BEFORE winner runs its existence pre-check):
    const outPre = join(root, 'out-precheck');
    await mkdir(outPre, { recursive: true });
    const preFinal = join(outPre, 'MetaViewer-linux-arm64');
    const workW2 = join(root, 'work-w2');
    const stagedW2 = join(workW2, 'staged');
    await mkdir(stagedW2, { recursive: true });
    await writeFile(join(stagedW2, 'metaviewer'), 'winner-W2-binary', { mode: 0o755 });
    await writeFile(join(stagedW2, 'INSTALL.md'), 'winner-W2-readme\n', { mode: 0o644 });
    const workL2 = join(root, 'work-l2');
    const stagedL2 = join(workL2, 'staged');
    await mkdir(stagedL2, { recursive: true });
    await writeFile(join(stagedL2, 'metaviewer'), 'loser-L2-binary', { mode: 0o755 });
    await writeFile(join(stagedL2, 'INSTALL.md'), 'loser-L2-readme\n', { mode: 0o644 });

    let notifyLoserManifestLanded;
    const loserManifestLanded = new Promise((resolve) => {
      notifyLoserManifestLanded = resolve;
    });
    let releaseLoser2DirRename;
    const loser2CanTryDirRename = new Promise((resolve) => {
      releaseLoser2DirRename = resolve;
    });

    const loser2Promise = publishStagedPackage(stagedL2, workL2, preFinal, {
      rename: async (src, dst) => {
        if (dst === `${preFinal}.sha256`) {
          const res = await import('node:fs/promises').then((m) => m.rename(src, dst));
          notifyLoserManifestLanded();
          return res;
        }
        await loser2CanTryDirRename;
        return import('node:fs/promises').then((m) => m.rename(src, dst));
      },
    });

    await loserManifestLanded;
    const winner2Promise = publishStagedPackage(stagedW2, workW2, preFinal, {
      rename: async (src, dst) => {
        const res = await import('node:fs/promises').then((m) => m.rename(src, dst));
        if (dst === preFinal) {
          releaseLoser2DirRename();
        }
        return res;
      },
    });

    await Promise.all([
      winner2Promise,
      assert.rejects(loser2Promise, /ENOTEMPTY|EEXIST|already exists/),
    ]);
    assert.equal(await readFile(join(preFinal, 'INSTALL.md'), 'utf8'), 'winner-W2-readme\n');
    await assert.rejects(access(join(outPre, '.pkg-commit-MetaViewer-linux-arm64')), { code: 'ENOENT' });
    const shaPre = spawnSync('sha256sum', ['-c', `${preFinal}.sha256`], {
      cwd: preFinal,
      encoding: 'utf8',
    });
    assert.equal(shaPre.status, 0, shaPre.stderr || shaPre.stdout);

    // Interleaving 3 (winner renames manifest first, loser clobbers manifest, winner renames dir and repairs manifest):
    const outClobber = join(root, 'out-clobber');
    await mkdir(outClobber, { recursive: true });
    const clobberFinal = join(outClobber, 'MetaViewer-linux-arm64');
    const workW3 = join(root, 'work-w3');
    const stagedW3 = join(workW3, 'staged');
    await mkdir(stagedW3, { recursive: true });
    await writeFile(join(stagedW3, 'metaviewer'), 'winner-W3-binary', { mode: 0o755 });
    await writeFile(join(stagedW3, 'INSTALL.md'), 'winner-W3-readme\n', { mode: 0o644 });
    const workL3 = join(root, 'work-l3');
    const stagedL3 = join(workL3, 'staged');
    await mkdir(stagedL3, { recursive: true });
    await writeFile(join(stagedL3, 'metaviewer'), 'loser-L3-binary', { mode: 0o755 });
    await writeFile(join(stagedL3, 'INSTALL.md'), 'loser-L3-readme\n', { mode: 0o644 });

    let notifyWinner3WroteManifest;
    const winner3WroteManifest = new Promise((resolve) => {
      notifyWinner3WroteManifest = resolve;
    });
    let notifyLoser3ClobberedManifest;
    const loser3ClobberedManifest = new Promise((resolve) => {
      notifyLoser3ClobberedManifest = resolve;
    });
    let releaseLoser3DirRename;
    const loser3CanTryDirRename = new Promise((resolve) => {
      releaseLoser3DirRename = resolve;
    });

    const winner3Promise = publishStagedPackage(stagedW3, workW3, clobberFinal, {
      rename: async (src, dst) => {
        if (dst === `${clobberFinal}.sha256`) {
          const res = await import('node:fs/promises').then((m) => m.rename(src, dst));
          notifyWinner3WroteManifest();
          return res;
        }
        await loser3ClobberedManifest;
        const res = await import('node:fs/promises').then((m) => m.rename(src, dst));
        releaseLoser3DirRename();
        return res;
      },
    });

    const loser3Promise = publishStagedPackage(stagedL3, workL3, clobberFinal, {
      rename: async (src, dst) => {
        if (dst === `${clobberFinal}.sha256`) {
          await winner3WroteManifest;
          const res = await import('node:fs/promises').then((m) => m.rename(src, dst));
          notifyLoser3ClobberedManifest();
          return res;
        }
        await loser3CanTryDirRename;
        return import('node:fs/promises').then((m) => m.rename(src, dst));
      },
    });

    await Promise.all([
      winner3Promise,
      assert.rejects(loser3Promise, /ENOTEMPTY|EEXIST|already exists/),
    ]);
    assert.equal(await readFile(join(clobberFinal, 'INSTALL.md'), 'utf8'), 'winner-W3-readme\n');
    await assert.rejects(access(join(outClobber, '.pkg-commit-MetaViewer-linux-arm64')), { code: 'ENOENT' });
    const shaClobber = spawnSync('sha256sum', ['-c', `${clobberFinal}.sha256`], {
      cwd: clobberFinal,
      encoding: 'utf8',
    });
    assert.equal(shaClobber.status, 0, shaClobber.stderr || shaClobber.stdout);

    // Single-writer fsyncDir failure rolls back owned directory and manifest
    const outFsync = join(root, 'out-fsync');
    await mkdir(outFsync, { recursive: true });
    const fsyncFinal = join(outFsync, 'MetaViewer-linux-arm64');
    const workF = join(root, 'work-f');
    const stagedF = join(workF, 'staged');
    await mkdir(stagedF, { recursive: true });
    await writeFile(join(stagedF, 'INSTALL.md'), 'fsync-test\n', { mode: 0o644 });
    await assert.rejects(
      () =>
        publishStagedPackage(stagedF, workF, fsyncFinal, {
          fsyncDir: async () => {
            throw new Error('SIMULATED_FSYNC_ERROR');
          },
        }),
      /SIMULATED_FSYNC_ERROR/,
    );
    await assert.rejects(access(fsyncFinal), { code: 'ENOENT' });
    await assert.rejects(access(`${fsyncFinal}.sha256`), { code: 'ENOENT' });

    // Crash recovery: half-published state (.pkg-commit-* + orphan .sha256) is cleaned on next publish
    const outCrash = join(root, 'out-crash');
    await mkdir(outCrash, { recursive: true });
    const crashFinal = join(outCrash, 'MetaViewer-linux-arm64');
    await writeFile(join(outCrash, '.pkg-commit-MetaViewer-linux-arm64'), '99999\n');
    await writeFile(`${crashFinal}.sha256`, `${'0'.repeat(64)}  orphan\n`);

    const workC = join(root, 'work-c');
    const stagedC = join(workC, 'staged');
    await mkdir(stagedC, { recursive: true });
    await writeFile(join(stagedC, 'metaviewer'), 'recovered-bin', { mode: 0o755 });
    await chmod(join(stagedC, 'metaviewer'), 0o755);
    await writeFile(join(stagedC, 'INSTALL.md'), 'recovered-readme\n', { mode: 0o644 });
    await publishStagedPackage(stagedC, workC, crashFinal);
    assert.equal(await readFile(join(crashFinal, 'INSTALL.md'), 'utf8'), 'recovered-readme\n');
    await assert.rejects(access(join(outCrash, '.pkg-commit-MetaViewer-linux-arm64')), { code: 'ENOENT' });
    const shaCrash = spawnSync('sha256sum', ['-c', `${crashFinal}.sha256`], {
      cwd: crashFinal,
      encoding: 'utf8',
    });
    assert.equal(shaCrash.status, 0, shaCrash.stderr || shaCrash.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('T7R3-008 & T7R3-009 manifest stock sha256sum -c grammar and cargo --offline --locked enforcement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mv-t7r3-008-009-'));
  try {
    const dir = join(root, 'pkg');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'readme.txt'), 'hello\n', { mode: 0o644 });
    await chmod(join(dir, 'readme.txt'), 0o644);
    await writeFile(join(dir, 'sub/run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(join(dir, 'sub/run.sh'), 0o755);

    const manifestPath = join(root, 'pkg.sha256');
    await writeManifest(dir, manifestPath);
    const manifestText = await readFile(manifestPath, 'utf8');
    assert.match(manifestText, /^[0-9a-f]{64}  readme\.txt$/m);
    assert.match(manifestText, /^[0-9a-f]{64} \*sub\/run\.sh$/m);

    const sha = spawnSync('sha256sum', ['-c', manifestPath], { cwd: dir, encoding: 'utf8' });
    assert.equal(sha.status, 0, sha.stderr || sha.stdout);

    // Verify --locked is present on cargo --offline in ui/tools/package.js and tests/supervisor/run_process_gate.sh
    const pkgJs = await readFile(new URL('../tools/package.js', import.meta.url), 'utf8');
    assert.match(pkgJs, /\['build',\s*'--offline',\s*'--locked',\s*'--release',\s*'--bin',\s*'metaviewer-core'\]/);
    const gateSh = await readFile(new URL('../../tests/supervisor/run_process_gate.sh', import.meta.url), 'utf8');
    assert.match(gateSh, /test\s+--offline\s+--locked\s+--manifest-path\s+tests\/supervisor\/Cargo\.toml/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
