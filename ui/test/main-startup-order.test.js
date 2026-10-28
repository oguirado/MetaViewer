import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  bootProductionMain,
  CHANNELS,
  ELECTRON_PIN,
  MainError,
  PRIVILEGED_ORIGIN,
  registerPrivilegedScheme,
} from '../electron/main.js';

test('direct entry registers synchronously before a delayed host bootstrap and registers only once', { timeout: 60000 }, async () => {
  const source = await readFile(fileURLToPath(new URL('../electron/main.js', import.meta.url)), 'utf8');
  const direct = source.slice(source.indexOf('async function mainDirectEntry()'), source.lastIndexOf('\nif (typeof process'));
  const events = [];
  let ready = false, release;
  const host = new Promise(resolve => { release = resolve; });
  const protocol = { registerSchemesAsPrivileged(specs) {
    assert.equal(ready, false, 'Electron rejects registration after ready');
    events.push('register');
    assert.deepEqual(specs, [{ scheme: 'app', privileges: { standard: true, secure: true } }]);
  } };
  const electron = { protocol, app: { exit() { events.push('exit'); } } };
  const promise = runInNewContext(direct.replaceAll('import.meta.url', 'entryURL') + '\nmainDirectEntry()', {
    entryURL: new URL('../electron/main.js', import.meta.url).href, URL,
    createRequire: () => () => electron,
    process: { argv: ['electron', '/app/main.js'], env: {}, versions: { electron: ELECTRON_PIN } },
    console: { error(message) { events.push(message); }, log() {} },
    MainError, ELECTRON_PIN, registerPrivilegedScheme,
    validateRetailLaunch: () => ({ ok: true }),
    loadMainBindings: () => { events.push('bindings'); return host; },
    bootProductionMain: async () => { registerPrivilegedScheme(protocol); events.push('boot'); },
    fileURLToPath: () => '/app/ui', DEFAULT_GEOMETRY: {}, createLayoutBridge: () => ({}),
  });
  assert.deepEqual(events, ['register', 'bindings']);
  ready = true;
  release({ core: {}, wire: {} });
  await promise;
  assert.deepEqual(events, ['register', 'bindings', 'boot']);
});

test('failed privilege registration remains retryable and never admits a boot', { timeout: 60000 }, () => {
  let refuse = true, calls = 0;
  const protocol = { registerSchemesAsPrivileged() { calls++; if (refuse) throw new Error('refused'); } };
  assert.throws(() => registerPrivilegedScheme(protocol), /refused/);
  refuse = false;
  registerPrivilegedScheme(protocol);
  registerPrivilegedScheme(protocol);
  assert.equal(calls, 2);
});

/**
 * Stage a minimal mkdtemp-backed shell tree and stub handles for bootProductionMain.
 * @param {string} baseDir
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   argv?: ReadonlyArray<string>,
 *   adapterStart?: () => Promise<import('../electron/coreLauncher.js').AdapterStatus>,
 *   adapterStatus?: () => import('../electron/coreLauncher.js').AdapterStatus,
 * }} [options]
 */
async function createStubBootFixture(baseDir, options = {}) {
  const root = join(baseDir, 'shell');
  const xdg = join(baseDir, 'xdg');
  await mkdir(join(root, 'dist', 'renderer'), { recursive: true });
  await mkdir(join(root, 'dist', 'preload'), { recursive: true });
  await writeFile(join(root, 'dist', 'renderer', 'index.html'), '<!doctype html><title>MetaViewer</title>', 'utf8');
  await writeFile(join(root, 'dist', 'preload', 'preload.cjs'), '"use strict";\n', 'utf8');
  await mkdir(xdg, { recursive: true, mode: 0o700 });
  await chmod(xdg, 0o700);

  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  /** @type {Array<string>} */
  const calls = [];
  /** @type {Array<{channel: string, payload: unknown}>} */
  const ipcSent = [];
  let windowsConstructed = 0;

  const frame = {
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    origin: PRIVILEGED_ORIGIN,
    parent: null,
    routingId: 10,
    processId: 20,
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
    setUserAgent: (/** @type {string} */ ua) => {
      calls.push(`setUserAgent:${ua}`);
    },
    loadURL: async (/** @type {string} */ url) => {
      calls.push(`loadURL:${url}`);
    },
    send: (/** @type {string} */ channel, /** @type {unknown} */ payload) => {
      ipcSent.push({ channel, payload });
    },
  };
  class StubWindow {
    constructor() {
      windowsConstructed += 1;
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
  const coreStatus = {
    availability: /** @type {const} */ ('live'),
    pid: 4141,
    authority_epoch: 1,
    reason: null,
  };
  const core = {
    start: async () => {
      calls.push('core.start');
      return coreStatus;
    },
    request: async (/** @type {unknown} */ msg) => ({ echo: msg }),
    dispose: async () => {
      calls.push('core.dispose');
    },
    getStatus: () => coreStatus,
  };
  const defaultAdapterStatus = /** @type {import('../electron/coreLauncher.js').AdapterStatus} */ ({
    availability: 'unavailable',
    pid: null,
    handshakeSeen: false,
    code: 'ADAPTER_DISPOSED',
    reason: 'adapter not started',
    userMessage: null,
  });
  let latestAdapterStatus = options.adapterStatus ? options.adapterStatus() : defaultAdapterStatus;
  const adapter = {
    start: async () => {
      calls.push('adapter.start');
      if (options.adapterStart) {
        latestAdapterStatus = await options.adapterStart();
        return latestAdapterStatus;
      }
      return latestAdapterStatus;
    },
    dispose: async () => {
      calls.push('adapter.dispose');
    },
    getStatus: () => (options.adapterStatus ? options.adapterStatus() : latestAdapterStatus),
  };

  const handles = {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: async () => {
        calls.push('ready');
      },
      on: () => {},
      quit: () => {
        calls.push('app.quit');
      },
      getAppPath: () => root,
      getPath: () => join(root, 'user-data'),
    },
    BrowserWindow: StubWindow,
    ipcMain: {
      handle: () => {},
      removeHandler: () => {},
    },
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: () => {},
      unhandle: () => {
        calls.push('protocol.unhandle');
      },
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
      },
    },
    electronVersion: ELECTRON_PIN,
    shellRoot: root,
    argv: options.argv ?? ['metaviewer'],
    env: options.env ?? {},
    runtime: { xdgRuntimeDir: xdg, uid },
    core,
    adapter,
    bridge: [
      { channel: CHANNELS.load, decode: () => null, invoke: async () => null },
      { channel: CHANNELS.save, decode: (/** @type {unknown} */ v) => v, invoke: async () => true },
    ],
    geometry: { width: 1280, height: 720 },
  };
  return {
    handles,
    calls,
    ipcSent,
    getWindowsConstructed: () => windowsConstructed,
  };
}

test(
  'when MV_SRF_BIN_DIR is set, degraded, unavailable, or throwing adapter.start() aborts boot with typed ADAPTER_* error before window construction and unwinds core',
  { timeout: 60000 },
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'mv-startup-order-'));
    try {
      const srfBinDir = join(tempRoot, 'srf-bin');
      await mkdir(srfBinDir, { recursive: true, mode: 0o700 });

      const failureCases = [
        {
          name: 'degraded ADAPTER_CRASHED',
          expectedCode: 'ADAPTER_CRASHED',
          adapterStart: async () => ({
            availability: /** @type {const} */ ('degraded'),
            pid: null,
            handshakeSeen: false,
            code: 'ADAPTER_CRASHED',
            reason: 'adapter exited with code 2',
            userMessage: 'degraded',
          }),
        },
        {
          name: 'degraded OPENSUPERFICIES_ABSENT mapped to ADAPTER_OPENSUPERFICIES_ABSENT',
          expectedCode: 'ADAPTER_OPENSUPERFICIES_ABSENT',
          adapterStart: async () => ({
            availability: /** @type {const} */ ('degraded'),
            pid: null,
            handshakeSeen: false,
            code: 'OPENSUPERFICIES_ABSENT',
            reason: 'MV_SRF_BIN_DIR is absent',
            userMessage: 'degraded',
          }),
        },
        {
          name: 'unavailable ADAPTER_DISPOSED',
          expectedCode: 'ADAPTER_DISPOSED',
          adapterStart: async () => ({
            availability: /** @type {const} */ ('unavailable'),
            pid: null,
            handshakeSeen: false,
            code: 'ADAPTER_DISPOSED',
            reason: 'adapter launcher disposed',
            userMessage: null,
          }),
        },
        {
          name: 'adapter.start() throws',
          expectedCode: 'ADAPTER_DISPOSED',
          adapterStart: async () => {
            throw new Error('adapter start exploded');
          },
        },
      ];

      for (let i = 0; i < failureCases.length; i += 1) {
        const tc = failureCases[i];
        const caseDir = join(tempRoot, `case-${i}`);
        await mkdir(caseDir, { recursive: true });
        const { handles, calls, getWindowsConstructed } = await createStubBootFixture(caseDir, {
          env: { MV_SRF_BIN_DIR: srfBinDir },
          adapterStart: tc.adapterStart,
        });

        await assert.rejects(
          () => bootProductionMain(handles),
          (err) => {
            assert.equal(err instanceof MainError, true, `${tc.name}: expected MainError`);
            assert.match(/** @type {MainError} */ (err).code, /^ADAPTER_/);
            assert.equal(/** @type {MainError} */ (err).code, tc.expectedCode);
            return true;
          },
        );
        assert.equal(getWindowsConstructed(), 0, `${tc.name}: must not construct BrowserWindow`);
        assert.equal(calls.includes('new-BrowserWindow'), false);
        assert.equal(calls.includes('core.start'), true);
        assert.equal(calls.includes('adapter.start'), true);
        assert.equal(calls.includes('adapter.dispose'), true, `${tc.name}: must unwind adapter`);
        assert.equal(calls.includes('core.dispose'), true, `${tc.name}: must unwind core`);
        assert.equal(calls.includes('protocol.unhandle'), true, `${tc.name}: must unhandle scheme`);
      }

      // Positive control with MV_SRF_BIN_DIR set: live adapter with handshakeSeen: true succeeds and opens window.
      const liveDir = join(tempRoot, 'case-live');
      await mkdir(liveDir, { recursive: true });
      const liveFixture = await createStubBootFixture(liveDir, {
        env: { MV_SRF_BIN_DIR: srfBinDir },
        adapterStart: async () => ({
          availability: /** @type {const} */ ('live'),
          pid: 5252,
          handshakeSeen: true,
          code: 'ADAPTER_LIVE',
          reason: null,
          userMessage: null,
        }),
      });
      const boot = await bootProductionMain(liveFixture.handles);
      try {
        assert.equal(liveFixture.getWindowsConstructed(), 1);
        assert.equal(liveFixture.calls.includes('new-BrowserWindow'), true);
        assert.equal(liveFixture.calls.includes('core.dispose'), false);
        assert.equal(liveFixture.ipcSent.length, 1);
        assert.equal(liveFixture.ipcSent[0].channel, 'metaviewer:adapter-status');
        assert.equal(
          /** @type {{availability?: string}} */ (liveFixture.ipcSent[0].payload).availability,
          'live',
        );
      } finally {
        await boot.dispose();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'negative control: when MV_SRF_BIN_DIR is unset, degraded or throwing adapter keeps core-only boot and opens window; --nested-depth=1 display-only path is unchanged',
  { timeout: 60000 },
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'mv-startup-neg-'));
    try {
      // 1. Degraded adapter with MV_SRF_BIN_DIR unset -> core-only boot succeeds and window opens.
      const degradedDir = join(tempRoot, 'unset-degraded');
      await mkdir(degradedDir, { recursive: true });
      const degradedStatus = {
        availability: /** @type {const} */ ('degraded'),
        pid: null,
        handshakeSeen: false,
        code: 'ADAPTER_CRASHED',
        reason: 'adapter exited with code 2',
        userMessage: 'degraded core-only',
      };
      const degradedFixture = await createStubBootFixture(degradedDir, {
        env: {},
        adapterStart: async () => degradedStatus,
        adapterStatus: () => degradedStatus,
      });
      const bootDegraded = await bootProductionMain(degradedFixture.handles);
      try {
        assert.equal(degradedFixture.getWindowsConstructed(), 1);
        assert.equal(degradedFixture.calls.includes('new-BrowserWindow'), true);
        assert.equal(degradedFixture.calls.includes('core.dispose'), false);
        assert.equal(degradedFixture.ipcSent.length, 1);
        assert.equal(
          /** @type {{availability?: string}} */ (degradedFixture.ipcSent[0].payload).availability,
          'degraded',
        );
      } finally {
        await bootDegraded.dispose();
      }

      // 2. Throwing adapter.start() with MV_SRF_BIN_DIR unset -> core-only boot still opens window.
      const throwDir = join(tempRoot, 'unset-throw');
      await mkdir(throwDir, { recursive: true });
      const throwFixture = await createStubBootFixture(throwDir, {
        env: {},
        adapterStart: async () => {
          throw new Error('adapter failed');
        },
        adapterStatus: () => degradedStatus,
      });
      const bootThrow = await bootProductionMain(throwFixture.handles);
      try {
        assert.equal(throwFixture.getWindowsConstructed(), 1);
        assert.equal(throwFixture.calls.includes('new-BrowserWindow'), true);
        assert.equal(throwFixture.calls.includes('core.dispose'), false);
      } finally {
        await bootThrow.dispose();
      }

      // 3. Display-only path (--nested-depth=1) stays unchanged even when MV_SRF_BIN_DIR is set.
      const nestedDir = join(tempRoot, 'nested-display');
      const srfBinDir = join(tempRoot, 'srf-bin');
      await mkdir(nestedDir, { recursive: true });
      await mkdir(srfBinDir, { recursive: true, mode: 0o700 });
      const nestedFixture = await createStubBootFixture(nestedDir, {
        argv: ['metaviewer', '--nested-depth=1'],
        env: { MV_SRF_BIN_DIR: srfBinDir },
        adapterStart: async () => {
          throw new Error('adapter.start must not run in nested display-only mode');
        },
      });
      const bootNested = await bootProductionMain(nestedFixture.handles);
      try {
        assert.equal(nestedFixture.getWindowsConstructed(), 1);
        assert.equal(nestedFixture.calls.includes('core.start'), false);
        assert.equal(nestedFixture.calls.includes('adapter.start'), false);
        assert.equal(nestedFixture.calls.includes('setUserAgent:MetaViewer --nested-depth=1'), true);
      } finally {
        await bootNested.dispose();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
