// @ts-check
'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALLOWED_ADAPTER_ENV,
  createAdapterLauncher,
  scrubAdapterEnv,
  scrubChildEnv,
  validateKillTarget,
} from '../electron/coreLauncher.js';
import {
  CHANNELS,
  ELECTRON_PIN,
  PRIVILEGED_ORIGIN,
  bootProductionMain,
} from '../electron/main.js';

/**
 * Create a temporary fixture directory with an executable fake adapter binary,
 * a valid 0700 OpenSuperficies directory (`MV_SRF_BIN_DIR`), a 0700 XDG runtime
 * directory, and a minimal renderer/preload bundle for `bootProductionMain`.
 */
function createFullstackFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mv-pkg-fullstack-'));
  const xdg = mkdtempSync(join(tmpdir(), 'mv-pkg-xdg-'));
  chmodSync(xdg, 0o700);
  const stateHome = join(root, 'state');
  const srfBinDir = join(root, 'srf-bin');
  const binDir = join(root, 'bin');
  const rendererDir = join(root, 'dist', 'renderer');
  const preloadDir = join(root, 'dist', 'preload');
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  mkdirSync(srfBinDir, { recursive: true, mode: 0o700 });
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  mkdirSync(rendererDir, { recursive: true });
  mkdirSync(preloadDir, { recursive: true });
  writeFileSync(
    join(rendererDir, 'index.html'),
    '<!doctype html><html><head></head><body>ok</body></html>',
  );
  writeFileSync(join(preloadDir, 'preload.cjs'), '"use strict";\n');
  const adapterBin = join(binDir, 'mv-daemon-adapter');
  writeFileSync(adapterBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(adapterBin, 0o755);

  const sessionId = 'pkg-session-1';
  const sessionEventsDir = join(stateHome, 'metaviewer', 'sessions', sessionId, 'events');
  mkdirSync(sessionEventsDir, { recursive: true, mode: 0o700 });

  const env = {
    LANG: 'C.UTF-8',
    PATH: 'relative/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: root,
    XDG_RUNTIME_DIR: xdg,
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: join(root, 'config'),
    MV_CORE_CONFIG: join(xdg, 'config.json'),
    MV_SESSION_ID: sessionId,
    MV_CORE_INSTANCE: 'core-1',
    MV_DAEMON_INSTANCE: 'daemon-1',
    MV_COMPONENT_COMMIT: 'a'.repeat(40),
    MV_CONTRACT_DIR: join(root, 'contracts', 'v0.2'),
    MV_SRF_BIN_DIR: srfBinDir,
    MV_SRF_STATE_DIR: join(root, 'srf-state'),
    SRF_IDENTITY_STORE_ROOT: join(root, 'srf-identity'),
    SRF_PROXY_REGISTRY: join(root, 'srf-proxy.json'),
    LD_PRELOAD: '/tmp/evil.so',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
    UNLISTED_SECRET: 'should-be-scrubbed',
  };

  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  };

  return { root, xdg, stateHome, srfBinDir, adapterBin, sessionId, sessionEventsDir, env, cleanup };
}

/**
 * Create a controllable fake child process with owned pipes.
 * @param {number} [pid]
 */
function createFakeChild(pid = 5252) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/**
 * Create fake Electron handles for `bootProductionMain`.
 * @param {{root: string, xdg: string, adapter?: any, env?: Record<string, string | undefined>, coreRequest?: (msg: unknown) => Promise<unknown>}} opts
 */
function createBootHandles(opts) {
  /** @type {Array<string>} */
  const calls = [];
  /** @type {Array<unknown>} */
  const coreRequests = [];
  /** @type {Array<{channel: string, payload: unknown}>} */
  const ipcSent = [];
  const appListeners = new Map();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const frame = {
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: false,
  };
  const webContents = {
    id: 7,
    mainFrame: frame,
    isDestroyed: () => false,
    session: {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
    },
    setWindowOpenHandler: () => {},
    on: () => {},
    loadURL: async (/** @type {string} */ url) => {
      calls.push(`loadURL:${url}`);
    },
    send: (/** @type {string} */ channel, /** @type {unknown} */ payload) => {
      ipcSent.push({ channel, payload });
    },
  };
  class FakeWindow {
    constructor() {
      calls.push('new-BrowserWindow');
      this.webContents = webContents;
    }
    once() {}
    show() {
      calls.push('window.show');
    }
    destroy() {
      calls.push('window.destroy');
    }
  }
  const coreStatus = { availability: /** @type {const} */ ('live'), pid: 4141, authority_epoch: 1, reason: null };
  const core = {
    start: async () => {
      calls.push('core.start');
      return coreStatus;
    },
    request: async (/** @type {unknown} */ msg) => {
      calls.push('core.request');
      coreRequests.push(msg);
      if (typeof opts.coreRequest === 'function') {
        return opts.coreRequest(msg);
      }
      return { echo: msg };
    },
    dispose: async () => {
      calls.push('core.dispose');
    },
    getStatus: () => coreStatus,
  };
  const handles = {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: async () => { calls.push('ready'); },
      on: (/** @type {string} */ name, /** @type {Function} */ fn) => { appListeners.set(name, fn); },
      quit: () => { calls.push('app.quit'); },
      getAppPath: () => opts.root,
      getPath: () => join(opts.root, 'user-data'),
    },
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: () => {},
      removeHandler: () => {},
    },
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: () => {},
      unhandle: () => { calls.push('protocol.unhandle'); },
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
      },
    },
    electronVersion: ELECTRON_PIN,
    shellRoot: opts.root,
    argv: ['metaviewer'],
    env: opts.env ?? {},
    runtime: { xdgRuntimeDir: opts.xdg, uid },
    core,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
    bridge: [
      { channel: CHANNELS.load, decode: () => null, invoke: async () => null },
      { channel: CHANNELS.save, decode: (/** @type {unknown} */ v) => v, invoke: async () => true },
    ],
    geometry: { width: 1280, height: 720 },
  };
  return { handles, calls, coreRequests, ipcSent, appListeners };
}

describe('W3-PKG-FULLSTACK bundled adapter supervision next to core', () => {
  it('scrubs adapter environment to the dev-stack subset and strips forbidden/unlisted vars while preserving core MV_RECORDING_DESTINATION', () => {
    const fx = createFullstackFixture();
    try {
      const recDir = join(fx.root, 'recordings');
      mkdirSync(recDir, { recursive: true, mode: 0o700 });
      const envWithRec = { ...fx.env, MV_RECORDING_DESTINATION: recDir };
      const coreScrubbed = scrubChildEnv(envWithRec, fx.xdg);
      assert.equal(coreScrubbed.MV_RECORDING_DESTINATION, recDir);
      const scrubbed = scrubAdapterEnv(envWithRec, fx.xdg);
      assert.ok(Object.isFrozen(scrubbed));
      assert.equal(scrubbed.PATH, '/usr/local/bin:/usr/bin:/bin');
      assert.equal(scrubbed.XDG_RUNTIME_DIR, fx.xdg);
      assert.equal(scrubbed.MV_SRF_BIN_DIR, fx.srfBinDir);
      assert.equal(scrubbed.MV_SESSION_ID, fx.sessionId);
      assert.equal(scrubbed.MV_CORE_INSTANCE, 'core-1');
      assert.equal(scrubbed.MV_DAEMON_INSTANCE, 'daemon-1');
      assert.equal(scrubbed.LD_PRELOAD, undefined);
      assert.equal(scrubbed.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(scrubbed.NODE_OPTIONS, undefined);
      assert.equal(scrubbed.UNLISTED_SECRET, undefined);
      for (const key of Object.keys(scrubbed)) {
        assert.ok(ALLOWED_ADAPTER_ENV.includes(key), `unexpected env key ${key}`);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('starts the fake adapter next to core with owned pipes, observes handshake, and reaps on quit', async () => {
    const fx = createFullstackFixture();
    try {
      /** @type {Array<{command: string, args: ReadonlyArray<string>, opts: Record<string, unknown>}>} */
      const spawned = [];
      /** @type {Array<[number, string]>} */
      const killed = [];
      /** @type {Array<any>} */
      const statuses = [];
      const child = createFakeChild(5252);

      // Write the core Connect journal event when the fake adapter is spawned.
      const launcher = createAdapterLauncher({
        command: fx.adapterBin,
        args: ['--daemon'],
        env: fx.env,
        runtimeDir: fx.xdg,
        selfPid: 100,
        selfPgid: 100,
        spawn: (command, args, opts) => {
          spawned.push({ command, args, opts });
          writeFileSync(join(fx.sessionEventsDir, '1.json'), JSON.stringify({ input: { event: 'Connect' } }));
          return child;
        },
        killFn: (target, sig) => {
          killed.push([target, sig]);
          child.emit('exit', 0, sig);
        },
        callbacks: {
          onStatus: (st) => statuses.push(st),
        },
      });

      const bootEnv = createBootHandles({ root: fx.root, xdg: fx.xdg, adapter: launcher });
      const boot = await bootProductionMain(bootEnv.handles);

      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].command, fx.adapterBin);
      assert.deepEqual(spawned[0].args, ['--daemon']);
      assert.deepEqual(spawned[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(spawned[0].opts.shell, false);
      assert.equal(/** @type {any} */ (spawned[0].opts.env).LD_PRELOAD, undefined);
      assert.equal(/** @type {any} */ (spawned[0].opts.env).MV_SRF_BIN_DIR, fx.srfBinDir);

      const liveStatus = boot.adapter?.getStatus();
      assert.deepEqual(liveStatus, {
        availability: 'live',
        pid: 5252,
        code: 'ADAPTER_LIVE',
        reason: null,
        userMessage: null,
        spawnCount: 1,
        handshakeSeen: true,
      });
      assert.equal(bootEnv.ipcSent.length, 1);
      assert.equal(bootEnv.ipcSent[0].channel, 'metaviewer:adapter-status');
      assert.deepEqual(bootEnv.ipcSent[0].payload, liveStatus);
      assert.equal(bootEnv.coreRequests.length, 1);
      assert.deepEqual(bootEnv.coreRequests[0], {
        schema: 'surface_request/v0.2',
        op: 'create',
        params: {
          kind: 'browser',
          geometry: { w: 1280, h: 900 },
          profile_id: 'mv-live-1',
        },
      });
      assert.ok(bootEnv.calls.indexOf('core.start') < bootEnv.calls.indexOf('core.request'));
      assert.ok(bootEnv.calls.indexOf('core.request') < bootEnv.calls.indexOf('new-BrowserWindow'));

      // Reap on quit via dispose()
      await boot.dispose();
      assert.deepEqual(killed, [[5252, 'SIGTERM']]);
      assert.ok(bootEnv.calls.includes('core.dispose'));
      assert.equal(boot.adapter?.getStatus().availability, 'unavailable');
      assert.equal(boot.adapter?.getStatus().code, 'ADAPTER_DISPOSED');
    } finally {
      fx.cleanup();
    }
  });

  it('starts core-only and reports typed user-visible degraded state when adapter or OpenSuperficies is absent', async () => {
    const fx = createFullstackFixture();
    try {
      // Case 1: OpenSuperficies (MV_SRF_BIN_DIR) is absent
      let spawnedCount = 0;
      const envWithoutSrf = { ...fx.env };
      delete /** @type {any} */ (envWithoutSrf).MV_SRF_BIN_DIR;
      const noSrfLauncher = createAdapterLauncher({
        command: fx.adapterBin,
        env: envWithoutSrf,
        runtimeDir: fx.xdg,
        spawn: () => {
          spawnedCount += 1;
          return createFakeChild(6001);
        },
      });
      const bootEnv1 = createBootHandles({ root: fx.root, xdg: fx.xdg, adapter: noSrfLauncher });
      const boot1 = await bootProductionMain(bootEnv1.handles);
      const st1 = boot1.adapter?.getStatus();
      assert.equal(spawnedCount, 0);
      assert.equal(st1?.availability, 'degraded');
      assert.equal(st1?.code, 'OPENSUPERFICIES_ABSENT');
      assert.equal(st1?.pid, null);
      assert.equal(st1?.spawnCount, 0);
      assert.equal(st1?.handshakeSeen, false);
      assert.match(String(st1?.userMessage), /Degraded mode \(OPENSUPERFICIES_ABSENT\)/);
      assert.equal(bootEnv1.ipcSent[0]?.channel, 'metaviewer:adapter-status');
      assert.deepEqual(bootEnv1.ipcSent[0]?.payload, st1);
      assert.equal(bootEnv1.coreRequests.length, 0);
      assert.equal(boot1.core.getStatus().availability, 'live');
      await boot1.dispose();

      // Case 2: Bundled adapter binary is absent on disk
      const missingBinLauncher = createAdapterLauncher({
        command: join(fx.root, 'bin', 'nonexistent-adapter'),
        env: fx.env,
        runtimeDir: fx.xdg,
        spawn: () => {
          spawnedCount += 1;
          return createFakeChild(6002);
        },
      });
      const bootEnv2 = createBootHandles({ root: fx.root, xdg: fx.xdg, adapter: missingBinLauncher });
      const boot2 = await bootProductionMain(bootEnv2.handles);
      const st2 = boot2.adapter?.getStatus();
      assert.equal(spawnedCount, 0);
      assert.equal(st2?.availability, 'degraded');
      assert.equal(st2?.code, 'ADAPTER_ABSENT');
      assert.equal(st2?.pid, null);
      assert.equal(st2?.spawnCount, 0);
      assert.equal(st2?.handshakeSeen, false);
      assert.match(String(st2?.userMessage), /Degraded mode \(ADAPTER_ABSENT\)/);
      assert.equal(bootEnv2.ipcSent[0]?.channel, 'metaviewer:adapter-status');
      assert.deepEqual(bootEnv2.ipcSent[0]?.payload, st2);
      assert.equal(bootEnv2.coreRequests.length, 0);
      assert.equal(boot2.core.getStatus().availability, 'live');
      await boot2.dispose();
    } finally {
      fx.cleanup();
    }
  });

  it('reports adapter crash as typed degraded state and never respawns in a loop', async () => {
    const fx = createFullstackFixture();
    try {
      let spawns = 0;
      /** @type {Array<[number, string]>} */
      const killed = [];
      /** @type {Array<any>} */
      const statuses = [];
      const child = createFakeChild(7171);

      const launcher = createAdapterLauncher({
        command: fx.adapterBin,
        env: fx.env,
        runtimeDir: fx.xdg,
        selfPid: 100,
        selfPgid: 100,
        spawn: () => {
          spawns += 1;
          setImmediate(() => {
            child.stdout.emit('data', 'ADAPTER_HANDSHAKE_OK\n');
          });
          return child;
        },
        killFn: (target, sig) => {
          killed.push([target, sig]);
        },
        callbacks: {
          onStatus: (st) => statuses.push(st),
        },
      });

      const bootEnv = createBootHandles({ root: fx.root, xdg: fx.xdg, adapter: launcher });
      const boot = await bootProductionMain(bootEnv.handles);
      assert.equal(boot.adapter?.getStatus().availability, 'live');
      assert.equal(spawns, 1);
      assert.equal(bootEnv.coreRequests.length, 1);

      // Simulate unexpected adapter crash after handshake
      child.emit('exit', 137, 'SIGKILL');
      const crashed = boot.adapter?.getStatus();
      assert.equal(crashed?.availability, 'degraded');
      assert.equal(crashed?.code, 'ADAPTER_CRASHED');
      assert.equal(crashed?.spawnCount, 1);
      assert.match(String(crashed?.reason), /code=137/);
      assert.match(String(crashed?.userMessage), /Degraded mode \(ADAPTER_CRASHED\)/);

      // Repeated start() calls must never respawn the crashed adapter
      const retry1 = await launcher.start();
      const retry2 = await launcher.start();
      assert.equal(spawns, 1);
      assert.equal(retry1.availability, 'degraded');
      assert.equal(retry2.availability, 'degraded');
      assert.equal(bootEnv.coreRequests.length, 1);
      assert.equal(boot.core.getStatus().availability, 'live');

      await boot.dispose();
      // Child already exited, so zero signals sent on dispose
      assert.deepEqual(killed, []);

      // Negative control: adapter crashes before handshake (MV_SRF_BIN_DIR unset on handles.env) -> 0 creates
      let crashSpawns = 0;
      const crashChild = createFakeChild(7172);
      const crashLauncher = createAdapterLauncher({
        command: fx.adapterBin,
        env: fx.env,
        runtimeDir: fx.xdg,
        selfPid: 100,
        selfPgid: 100,
        spawn: () => {
          crashSpawns += 1;
          setImmediate(() => {
            crashChild.emit('exit', 2, null);
          });
          return crashChild;
        },
      });
      const crashBootEnv = createBootHandles({ root: fx.root, xdg: fx.xdg, adapter: crashLauncher });
      const crashBoot = await bootProductionMain(crashBootEnv.handles);
      const preHandshakeCrashed = crashBoot.adapter?.getStatus();
      assert.equal(preHandshakeCrashed?.availability, 'degraded');
      assert.equal(preHandshakeCrashed?.code, 'ADAPTER_CRASHED');
      assert.equal(preHandshakeCrashed?.handshakeSeen, false);
      assert.equal(crashBootEnv.coreRequests.length, 0);
      const crashRetry1 = await crashLauncher.start();
      const crashRetry2 = await crashLauncher.start();
      assert.equal(crashSpawns, 1);
      assert.equal(crashRetry1.code, 'ADAPTER_CRASHED');
      assert.equal(crashRetry2.code, 'ADAPTER_CRASHED');
      assert.equal(crashBootEnv.coreRequests.length, 0);
      await crashBoot.dispose();
    } finally {
      fx.cleanup();
    }
  });

  it('logs a typed SURFACE_CREATE_* code and keeps the window when first-surface create fails or times out', async () => {
    const fx = createFullstackFixture();
    const origConsoleError = console.error;
    /** @type {Array<string>} */
    const loggedErrors = [];
    console.error = (...args) => {
      loggedErrors.push(args.map(String).join(' '));
    };
    try {
      // 1. Create rejects with a typed error -> logs SURFACE_CREATE_* and keeps window
      const child1 = createFakeChild(9101);
      const launcher1 = createAdapterLauncher({
        command: fx.adapterBin,
        env: fx.env,
        runtimeDir: fx.xdg,
        selfPid: 100,
        selfPgid: 100,
        spawn: () => {
          setImmediate(() => child1.stdout.emit('data', 'ADAPTER_HANDSHAKE_OK\n'));
          return child1;
        },
        killFn: () => {
          child1.emit('exit', 0, 'SIGTERM');
        },
      });
      const bootEnv1 = createBootHandles({
        root: fx.root,
        xdg: fx.xdg,
        adapter: launcher1,
        env: {
          MV_SRF_BIN_DIR: fx.srfBinDir,
          MV_SRF_PROFILES: JSON.stringify({
            'smoke-browser': {
              Kind: 'browser',
              NativeKind: 'browser',
              RAMRoot: '/dev/shm',
              Display: ':100',
              Width: 1280,
              Height: 900,
            },
          }),
        },
        coreRequest: async () => {
          const err = new Error('create refused by core');
          /** @type {{code?: string}} */ (err).code = 'CORE_REFUSED';
          throw err;
        },
      });
      const boot1 = await bootProductionMain(bootEnv1.handles);
      assert.equal(bootEnv1.coreRequests.length, 1);
      assert.deepEqual(bootEnv1.coreRequests[0], {
        schema: 'surface_request/v0.2',
        op: 'create',
        params: {
          kind: 'browser',
          geometry: { w: 1280, h: 900 },
          profile_id: 'smoke-browser',
        },
      });
      assert.ok(bootEnv1.calls.includes('new-BrowserWindow'));
      assert.ok(loggedErrors.some((line) => line.includes('METAVIEWER_SURFACE_CREATE_DEGRADED') && line.includes('SURFACE_CREATE_CORE_REFUSED')));
      await boot1.dispose();

      // 2. Create hangs past bounded boot budget wait -> logs SURFACE_CREATE_TIMEOUT and keeps window
      loggedErrors.length = 0;
      const child2 = createFakeChild(9102);
      const launcher2 = createAdapterLauncher({
        command: fx.adapterBin,
        env: fx.env,
        runtimeDir: fx.xdg,
        selfPid: 100,
        selfPgid: 100,
        spawn: () => {
          setImmediate(() => child2.stdout.emit('data', 'ADAPTER_HANDSHAKE_OK\n'));
          return child2;
        },
        killFn: () => {
          child2.emit('exit', 0, 'SIGTERM');
        },
      });
      const bootEnv2 = createBootHandles({
        root: fx.root,
        xdg: fx.xdg,
        adapter: launcher2,
        env: {
          MV_SRF_BIN_DIR: fx.srfBinDir,
          MV_PKG_BOOT_BUDGET_MS: '40',
        },
        coreRequest: () => new Promise(() => {}),
      });
      const boot2 = await bootProductionMain(bootEnv2.handles);
      assert.equal(bootEnv2.coreRequests.length, 1);
      assert.ok(bootEnv2.calls.includes('new-BrowserWindow'));
      assert.ok(loggedErrors.some((line) => line.includes('METAVIEWER_SURFACE_CREATE_DEGRADED') && line.includes('SURFACE_CREATE_TIMEOUT')));
      await boot2.dispose();
    } finally {
      console.error = origConsoleError;
      fx.cleanup();
    }
  });

  it('enforces kill-guard rules (int pid > 1 only) and escalates SIGTERM to SIGKILL on hang', async () => {
    const fx = createFullstackFixture();
    try {
      for (const badPid of [0, 1, -1, -500, 1.5, NaN, Infinity, '5000', null, undefined, Object(5000), 100, 200]) {
        assert.equal(validateKillTarget(badPid, 100, 200), false);
      }
      assert.equal(validateKillTarget(2, 100, 200), true);

      /** @type {Array<[number, string]>} */
      const killed = [];
      const child = createFakeChild(8181);
      const launcher = createAdapterLauncher({
        command: fx.adapterBin,
        env: fx.env,
        runtimeDir: fx.xdg,
        selfPid: 100,
        selfPgid: 200,
        limits: {
          maxStdoutLineBytes: 4096,
          maxStderrTailBytes: 4096,
          handshakeTimeoutMs: 1000,
          shutdownTimeoutMs: 25,
        },
        spawn: () => {
          setImmediate(() => child.stdout.emit('data', 'ADAPTER_HANDSHAKE_OK\n'));
          return child;
        },
        ownership: {
          ownedPids: () => /** @type {any} */ ([0, 1, -10, 'bad', 100, 200, 8181, 8182]),
          waitForExit: () => new Promise(() => {}),
        },
        killFn: (target, sig) => {
          killed.push([target, sig]);
        },
      });

      const status = await launcher.start();
      assert.equal(status.availability, 'live');
      await launcher.dispose();
      assert.deepEqual(killed, [
        [8182, 'SIGTERM'],
        [8181, 'SIGTERM'],
        [8182, 'SIGKILL'],
        [8181, 'SIGKILL'],
      ]);
    } finally {
      fx.cleanup();
    }
  });
});
