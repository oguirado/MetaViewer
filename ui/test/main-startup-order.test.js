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
 *   coreRequest?: (msg: unknown) => Promise<unknown>,
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
  /** @type {Array<unknown>} */
  const coreRequests = [];
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
    request: async (/** @type {unknown} */ msg) => {
      calls.push('core.request');
      coreRequests.push(msg);
      if (typeof options.coreRequest === 'function') {
        return options.coreRequest(msg);
      }
      return { echo: msg };
    },
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
    coreRequests,
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
        const { handles, calls, coreRequests, getWindowsConstructed } = await createStubBootFixture(caseDir, {
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
        assert.equal(calls.includes('core.request'), false);
        assert.equal(coreRequests.length, 0, `${tc.name}: must not issue surface create`);
        assert.equal(calls.includes('adapter.dispose'), true, `${tc.name}: must unwind adapter`);
        assert.equal(calls.includes('core.dispose'), true, `${tc.name}: must unwind core`);
        assert.equal(calls.includes('protocol.unhandle'), true, `${tc.name}: must unhandle scheme`);
      }

      // Positive control with MV_SRF_BIN_DIR set: live adapter with handshakeSeen: true succeeds, issues 1 create, and opens window.
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
        assert.equal(liveFixture.coreRequests.length, 1);
        assert.deepEqual(liveFixture.coreRequests[0], {
          schema: 'surface_request/v0.2',
          op: 'create',
          params: {
            kind: 'browser',
            geometry: { w: 1280, h: 900 },
            profile_id: 'mv-live-1',
          },
        });
        assert.ok(liveFixture.calls.indexOf('adapter.start') < liveFixture.calls.indexOf('core.request'));
        assert.ok(liveFixture.calls.indexOf('core.request') < liveFixture.calls.indexOf('new-BrowserWindow'));
        assert.equal(liveFixture.ipcSent.length, 1);
        assert.equal(liveFixture.ipcSent[0].channel, 'metaviewer:adapter-status');
        assert.equal(
          /** @type {{availability?: string}} */ (liveFixture.ipcSent[0].payload).availability,
          'live',
        );
      } finally {
        await boot.dispose();
      }

      // Optional surface create failure when adapter is live logs typed code and keeps window.
      const createErrDir = join(tempRoot, 'case-create-err');
      await mkdir(createErrDir, { recursive: true });
      /** @type {Array<string>} */
      const logged = [];
      const origError = console.error;
      console.error = (...args) => {
        logged.push(args.map(String).join(' '));
      };
      try {
        const createErrFixture = await createStubBootFixture(createErrDir, {
          env: { MV_SRF_BIN_DIR: srfBinDir },
          adapterStart: async () => ({
            availability: /** @type {const} */ ('live'),
            pid: 5252,
            handshakeSeen: true,
            code: 'ADAPTER_LIVE',
            reason: null,
            userMessage: null,
          }),
          coreRequest: async () => ({
            schema: 'surface_event/v0.2',
            event: 'error',
            data: { surface_id: 's1', code: 'adapter', detail: 'profile already bound' },
          }),
        });
        const bootCreateErr = await bootProductionMain(createErrFixture.handles);
        try {
          assert.equal(createErrFixture.coreRequests.length, 1);
          assert.equal(createErrFixture.getWindowsConstructed(), 1);
          assert.equal(createErrFixture.calls.includes('new-BrowserWindow'), true);
          assert.equal(createErrFixture.calls.includes('core.dispose'), false);
          assert.ok(logged.some((line) => line.includes('METAVIEWER_SURFACE_CREATE_DEGRADED') && line.includes('SURFACE_CREATE_ADAPTER')));
        } finally {
          await bootCreateErr.dispose();
        }
      } finally {
        console.error = origError;
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
        assert.equal(degradedFixture.coreRequests.length, 0);
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
        assert.equal(throwFixture.coreRequests.length, 0);
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
        assert.equal(nestedFixture.coreRequests.length, 0);
        assert.equal(nestedFixture.calls.includes('setUserAgent:MetaViewer --nested-depth=1'), true);
      } finally {
        await bootNested.dispose();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'boot failure after wireBridge installation and shutdown dispose await wireBridge.dispose() in exact unwind order while positive boot keeps bridge alive',
  { timeout: 60000 },
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'mv-startup-wire-unwind-'));
    try {
      /**
       * Build an instrumented boot fixture recording IPC registrations, captureBridge,
       * wireBridge (including an active async frame reader stream), window, protocol,
       * adapter, and core teardown order.
       * @param {string} caseDir
       * @param {{ failLoadUrl?: boolean }} [opts]
       */
      const makeWireUnwindFixture = async (caseDir, opts = {}) => {
        const configHome = join(caseDir, 'config');
        await mkdir(configHome, { recursive: true, mode: 0o700 });
        await chmod(configHome, 0o700);
        const base = await createStubBootFixture(caseDir, {
          env: { XDG_CONFIG_HOME: configHome },
          adapterStart: async () => ({
            availability: /** @type {const} */ ('live'),
            pid: 5252,
            handshakeSeen: true,
            code: 'ADAPTER_LIVE',
            reason: null,
            userMessage: null,
          }),
        });
        const { handles, calls } = base;
        /** @type {Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>} */
        const registeredHandlers = new Map();
        handles.ipcMain = {
          handle: (/** @type {string} */ channel, /** @type {(event: unknown, ...args: unknown[]) => Promise<unknown>} */ listener) => {
            calls.push(`ipc.handle:${channel}`);
            registeredHandlers.set(channel, listener);
          },
          removeHandler: (/** @type {string} */ channel) => {
            calls.push(`ipc.remove:${channel}`);
            registeredHandlers.delete(channel);
          },
        };
        /** @type {Record<string, unknown>} */ (handles.core).subscribeCapture = () => {
          calls.push('capture.subscribe');
          return () => {
            calls.push('capture.dispose');
          };
        };

        /** @type {((entry: unknown) => Promise<void>) | null} */
        let onFrameEntry = null;
        /** @type {Record<string, unknown>} */ (handles).wire = {
          frames: {
            subscribe: (/** @type {(entry: unknown) => Promise<void>} */ cb) => {
              calls.push('wire.frames.subscribe');
              onFrameEntry = cb;
              return () => {
                calls.push('wire.frames.unsubscribe');
              };
            },
          },
          terminal: {
            attach: async () => ({ port: {} }),
            dispose: () => {
              calls.push('wire.terminal.dispose');
            },
          },
        };

        const frame = {
          url: `${PRIVILEGED_ORIGIN}/index.html`,
          origin: PRIVILEGED_ORIGIN,
          parent: null,
          routingId: 10,
          processId: 20,
        };
        /** @type {Record<string, unknown> | null} */
        let capturedContents = null;
        /** @type {unknown} */
        let stageError = null;
        const OrigWindow = handles.BrowserWindow;
        handles.BrowserWindow = class InstrumentedWindow extends OrigWindow {
          constructor() {
            super();
            capturedContents = /** @type {Record<string, unknown>} */ (this.webContents);
            capturedContents.postMessage = () => {};
            capturedContents.loadURL = async (/** @type {string} */ url) => {
              calls.push(`loadURL:${url}`);
              try {
                await stageActiveWireStream();
              } catch (err) {
                stageError = err;
                throw err;
              }
              if (opts.failLoadUrl) {
                throw new Error('simulated loadURL failure after wireBridge install');
              }
            };
          }
        };

        const stageActiveWireStream = async () => {
          const subHandler = registeredHandlers.get('metaviewer:authority.subscribe');
          assert.equal(typeof subHandler, 'function', 'metaviewer:authority.subscribe must be registered');
          assert.notEqual(capturedContents, null);
          const subRes = await /** @type {(event: unknown) => Promise<unknown>} */ (subHandler)({
            sender: capturedContents,
            senderFrame: /** @type {{mainFrame?: unknown}} */ (capturedContents).mainFrame,
          });
          assert.equal(subRes, true);
          assert.equal(typeof onFrameEntry, 'function');
          const binding = {
            principal: 'utility',
            epoch: 1,
            surfaceId: 's1',
            surfaceGeneration: 1,
          };
          void onFrameEntry({
            frameRef: {
              schema: 'frame_ref/v0.2',
              surface_id: 's1',
              generation: 1,
              tick: 1,
              ts_ns: 1,
              width: 1,
              height: 1,
              format: 'rgb24',
              ramws_path: '/dev/shm/mv-s1-1.rgb24',
              sha256: 'a'.repeat(64),
              capture_us: 1,
            },
            state: {
              schema: 'surface/v0.2',
              surface_id: 's1',
              kind: 'browser',
              display: ':99',
              geometry: { w: 1280, h: 900 },
              state: 'active',
              visibility: 'unfolded',
              control: 'agent',
              profile_id: 'mv-live-1',
            },
            readerOptions: {
              binding,
              limits: {
                maxFrameBytes: 4096,
                maxWidth: 64,
                maxHeight: 64,
                readTimeoutMs: 500,
                maxConcurrentReads: 2,
              },
              pixelEnvironment: { environmentId: 'env-1', zoom: 1, dpr: 1 },
              acquirePublishedLease: () => {
                calls.push('wire.stream.acquire');
                return new Promise(() => {});
              },
              onReleaseLease: () => {},
            },
            portOptions: {
              port: {
                on: () => {},
                removeListener: () => {},
                postMessage: () => {},
                close: () => {
                  calls.push('wire.stream.port.close');
                },
              },
              role: 'sender',
              binding,
              limits: {
                maxFrameBytes: 4096,
                ackTimeoutMs: 500,
                maxSurfacesPerPort: 1,
              },
              onReleaseLease: () => {},
              onRevoke: (/** @type {{reason: string}} */ notice) => {
                calls.push(`wire.stream.revoke:${notice.reason}`);
              },
            },
          });
          for (let i = 0; i < 10 && !calls.includes('wire.stream.acquire'); i += 1) {
            await Promise.resolve();
          }
          assert.equal(calls.includes('wire.stream.acquire'), true, 'stream read must be in-flight before unwind');
        };

        return {
          handles,
          calls,
          registeredHandlers,
          getContents: () => capturedContents,
          getStageError: () => stageError,
        };
      };

      const expectedUnwindSequence = [
        `ipc.remove:${CHANNELS.save}`,
        `ipc.remove:${CHANNELS.load}`,
        'capture.dispose',
        'ipc.remove:metaviewer:capture.unsubscribe',
        'wire.frames.unsubscribe',
        'wire.stream.port.close',
        'wire.stream.revoke:SHUTDOWN',
        'wire.terminal.dispose',
        'ipc.remove:metaviewer:settings.load',
        'ipc.remove:metaviewer:authority.propose',
        'ipc.remove:metaviewer:side-terminal.copy',
        'window.destroy',
        'protocol.unhandle',
        'adapter.dispose',
        'core.dispose',
      ];

      /**
       * @param {ReadonlyArray<string>} calls
       * @param {string} label
       */
      const assertExactUnwindOrder = (calls, label) => {
        for (const marker of expectedUnwindSequence) {
          assert.notEqual(calls.indexOf(marker), -1, `${label}: missing unwind marker ${marker}`);
        }
        for (let i = 0; i < expectedUnwindSequence.length - 1; i += 1) {
          const earlier = expectedUnwindSequence[i];
          const later = expectedUnwindSequence[i + 1];
          assert.ok(
            calls.indexOf(earlier) < calls.indexOf(later),
            `${label}: expected ${earlier} (${calls.indexOf(earlier)}) before ${later} (${calls.indexOf(later)})`,
          );
        }
      };

      // 1. Boot failure after wireBridge installation (loadURL rejects) unwinds and awaits wireBridge.dispose() in exact order.
      const failDir = join(tempRoot, 'boot-fail-unwind');
      await mkdir(failDir, { recursive: true });
      const failFixture = await makeWireUnwindFixture(failDir, { failLoadUrl: true });
      await assert.rejects(
        () => bootProductionMain(failFixture.handles),
        (err) => {
          assert.equal(err instanceof MainError, true);
          assert.equal(/** @type {MainError} */ (err).code, 'LOAD');
          return true;
        },
      );
      assert.equal(failFixture.getStageError(), null);
      assertExactUnwindOrder(failFixture.calls, 'boot-failure-unwind');
      assert.equal(failFixture.registeredHandlers.size, 0, 'all IPC handlers must be removed on boot unwind');

      // 2. Positive boot control keeps wireBridge alive until shutdown, then awaits wireBridge.dispose() in exact unwind order.
      const okDir = join(tempRoot, 'boot-ok-dispose');
      await mkdir(okDir, { recursive: true });
      const okFixture = await makeWireUnwindFixture(okDir, { failLoadUrl: false });
      const boot = await bootProductionMain(okFixture.handles);
      try {
        assert.equal(okFixture.getStageError(), null);
        assert.equal(okFixture.calls.includes('wire.frames.subscribe'), true);
        assert.equal(okFixture.calls.includes('wire.stream.acquire'), true);
        assert.equal(okFixture.calls.includes('wire.frames.unsubscribe'), false);
        assert.equal(okFixture.calls.includes('wire.stream.revoke:SHUTDOWN'), false);
        assert.equal(okFixture.calls.includes('wire.terminal.dispose'), false);
        assert.equal(okFixture.calls.includes('capture.dispose'), false);
        assert.equal(okFixture.calls.includes('window.destroy'), false);
        assert.equal(okFixture.calls.includes('protocol.unhandle'), false);
        assert.equal(okFixture.calls.includes('adapter.dispose'), false);
        assert.equal(okFixture.calls.includes('core.dispose'), false);
        assert.equal(okFixture.registeredHandlers.has('metaviewer:authority.propose'), true);
        assert.equal(okFixture.registeredHandlers.has('metaviewer:nested.depth'), true);

        const depthHandler = okFixture.registeredHandlers.get('metaviewer:nested.depth');
        assert.equal(typeof depthHandler, 'function');
        const contents = okFixture.getContents();
        const depthReply = await /** @type {(event: unknown) => Promise<unknown>} */ (depthHandler)({
          sender: contents,
          senderFrame: /** @type {{mainFrame?: unknown} | null} */ (contents)?.mainFrame,
        });
        assert.equal(depthReply, null);
      } finally {
        await boot.dispose();
      }
      assertExactUnwindOrder(okFixture.calls, 'shutdown-dispose-unwind');
      assert.equal(okFixture.registeredHandlers.size, 0, 'all IPC handlers must be removed on shutdown dispose');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
