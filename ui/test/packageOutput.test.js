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

    // Deterministic barrier: let A publish completely right before B's directory rename fails
    const pubA = await publishStagedPackage(stagedA, workA, finalDir);
    assert.equal(pubA, undefined);

    // If B had already entered the rename phase and clobbered finalManifest before failing on finalDir:
    const stagedB2 = join(workB, 'staged-2');
    await mkdir(stagedB2, { recursive: true });
    await writeFile(join(stagedB2, 'metaviewer'), 'loser-B2-binary', { mode: 0o755 });
    await writeFile(join(stagedB2, 'INSTALL.md'), 'loser-B2-readme\n', { mode: 0o644 });

    // Also test interleaving where A and B both pass initial readdir check via barrier
    const outRace = join(root, 'out-race');
    await mkdir(outRace, { recursive: true });
    const raceFinal = join(outRace, 'MetaViewer-linux-arm64');
    const workW = join(root, 'work-w');
    const stagedW = join(workW, 'staged');
    await mkdir(stagedW, { recursive: true });
    await writeFile(join(stagedW, 'metaviewer'), 'winner-W-binary', { mode: 0o755 });
    await writeFile(join(stagedW, 'INSTALL.md'), 'winner-W-readme\n', { mode: 0o644 });

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
        await loserWroteManifest;
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
    const shaRace = spawnSync('sha256sum', ['-c', `${raceFinal}.sha256`], {
      cwd: raceFinal,
      encoding: 'utf8',
    });
    assert.equal(shaRace.status, 0, shaRace.stderr || shaRace.stdout);

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
