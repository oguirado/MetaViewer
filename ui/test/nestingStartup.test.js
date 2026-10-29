import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDisplay } from '../electron/nesting.js';
import { CHANNELS, ELECTRON_PIN, PRIVILEGED_ORIGIN, bootProductionMain } from '../electron/main.js';
import { installPreload } from '../electron/preload.js';

test('ARG-ui_shell-1 pre-ready policy runs during ESM evaluation before the next macrotask', async () => {
  const entry = new URL('../electron/nesting.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    Object.defineProperty(process.versions, 'electron', { value: ${JSON.stringify(ELECTRON_PIN)} });
    process.argv = ['node', 'packaged-entry', '--nested-depth=1'];
    delete process.env.NODE_OPTIONS;
    const calls = globalThis.calls = [];
    let ready = false;
    globalThis.handles = {
      app: { isPackaged: true, enableSandbox() { assert.equal(ready, false); calls.push('sandbox'); },
        setName() {}, requestSingleInstanceLock: () => true,
        whenReady() { return new Promise(() => { setImmediate(() => {
          ready = true;
          assert.deepEqual(calls, ['sandbox', 'scheme', 'evaluated']);
          console.log('ORDER_OK');
          process.exit(0);
        }); }); }, exit() { process.exitCode = 1; } },
      protocol: { registerSchemesAsPrivileged() { assert.equal(ready, false); calls.push('scheme'); } }
    };
    const stub = 'export const app = globalThis.handles.app; export const protocol = globalThis.handles.protocol;';
    registerHooks({ resolve(specifier, context, next) {
      return specifier === 'electron' ? { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true } : next(specifier, context);
    } });
    await import(${JSON.stringify(entry)});
    calls.push('evaluated');
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, env: {} });
  assert.match(result.stdout, /ORDER_OK/);
  assert.equal(result.stderr, '');
});

async function displayFixture({ stalled = false, destroyedAt = Infinity, contentsOnly = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mv-nested-Música-'));
  await mkdir(join(root, 'dist/renderer'), { recursive: true });
  let destroyed = false, attempts = 0, shown = false;
  const webContents = { on() {}, setWindowOpenHandler() {}, isDestroyed: () => destroyed,
    async executeJavaScript() {
      assert.equal(destroyed, false, 'poll must not touch destroyed contents');
      if (++attempts === destroyedAt) { destroyed = true; return false; }
      return attempts >= 3;
    } };
  class Window {
    constructor() { this.webContents = webContents; }
    removeMenu() {}
    isDestroyed() { return contentsOnly ? false : destroyed; }
    destroy() { destroyed = true; }
    async loadURL() { if (stalled) await new Promise(() => {}); }
    show() { shown = true; }
  }
  return { electron: { app: { setName() {}, requestSingleInstanceLock: () => true,
    whenReady: async () => {}, getAppPath: () => root, on() {}, quit() {}, exit() {} },
    BrowserWindow: Window, protocol: { handle() {} }, ipcMain: { handle() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } } },
    state: () => ({ destroyed, attempts, shown }), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('ARG-ui_shell-7 display startup bounds navigation, guards destroyed handles and logs readiness', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: ELECTRON_PIN, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor);
    else delete process.versions.electron;
  });
  for (const contentsOnly of [false, true]) {
    const f = await displayFixture({ destroyedAt: 2, contentsOnly });
    const before = performance.now();
    try {
      await assert.rejects(startDisplay(f.electron), /DISPLAY_ONLY/);
      assert.ok(performance.now() - before < 5000);
      assert.equal(f.state().attempts, 2);
    } finally { await f.cleanup(); }
  }
  const stalled = await displayFixture({ stalled: true });
  const before = performance.now();
  try {
    await assert.rejects(startDisplay(stalled.electron), /DISPLAY_ONLY.*deadline/);
    assert.ok(performance.now() - before <= 20000);
    assert.equal(stalled.state().destroyed, true);
    assert.equal(stalled.state().shown, false);
  } finally { await stalled.cleanup(); }
  const happy = await displayFixture();
  const messages = [], log = console.log;
  console.log = message => messages.push(message);
  try {
    await startDisplay(happy.electron);
    assert.equal(happy.state().shown, true);
    assert.deepEqual(messages, ['METAVIEWER_NESTED_DISPLAY_READY']);
  } finally { console.log = log; await happy.cleanup(); }
});

test('R2-T4-009 normal and nested runs use distinct userData profiles concurrently while same-depth double start refuses', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: ELECTRON_PIN, configurable: true });
  const root = await mkdtemp(join(tmpdir(), 'mv-r2t4-009-'));
  const xdg = await mkdtemp(join(tmpdir(), 'mv-r2t4-009-xdg-'));
  await chmod(xdg, 0o700);
  t.after(async () => {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor);
    else delete process.versions.electron;
    await rm(root, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  });

  await mkdir(join(root, 'dist/renderer'), { recursive: true });
  await mkdir(join(root, 'dist/preload'), { recursive: true });
  await writeFile(join(root, 'dist/renderer/index.html'), '<!doctype html><html><body></body></html>');
  await writeFile(join(root, 'dist/preload/preload.cjs'), '"use strict";\n');

  const baseUserData = join(root, 'profile', 'MetaViewer');
  const lockedProfiles = new Set();

  let normalUserData = baseUserData;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false };
  class NormalWindow {
    constructor() {
      this.webContents = {
        id: 1,
        mainFrame: frame,
        isDestroyed: () => false,
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        setWindowOpenHandler() {},
        on() {},
        loadURL: async () => {},
      };
    }
    once() {}
    show() {}
    destroy() {}
  }
  const coreStatus = { availability: /** @type {const} */ ('live'), pid: 4242, authority_epoch: 1, reason: null };
  const normalBoot = await bootProductionMain({
    app: {
      requestSingleInstanceLock: () => {
        if (lockedProfiles.has(normalUserData)) return false;
        lockedProfiles.add(normalUserData);
        return true;
      },
      whenReady: async () => {},
      on() {},
      quit() {},
      getAppPath: () => root,
      getPath: (name) => (name === 'userData' ? normalUserData : root),
    },
    BrowserWindow: NormalWindow,
    ipcMain: { handle() {}, removeHandler() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle() {}, unhandle() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    electronVersion: ELECTRON_PIN,
    shellRoot: root,
    argv: ['metaviewer'],
    env: {},
    runtime: { xdgRuntimeDir: xdg, uid },
    core: {
      start: async () => coreStatus,
      request: async () => ({}),
      dispose: async () => {},
      getStatus: () => coreStatus,
    },
    bridge: [
      { channel: CHANNELS.load, decode: () => null, invoke: async () => null },
      { channel: CHANNELS.save, decode: (v) => v, invoke: async () => true },
    ],
    geometry: { width: 1280, height: 720 },
  });

  const makeNestedElectron = () => {
    let currentUserData = baseUserData;
    class NestedWindow {
      constructor() {
        this.webContents = {
          on() {},
          setWindowOpenHandler() {},
          isDestroyed: () => false,
          executeJavaScript: async () => true,
        };
      }
      removeMenu() {}
      isDestroyed() { return false; }
      destroy() {}
      async loadURL() {}
      show() {}
    }
    return {
      getUserData: () => currentUserData,
      electron: /** @type {any} */ ({
        app: {
          setName() {},
          getPath: (name) => (name === 'userData' ? currentUserData : root),
          setPath: (name, value) => { if (name === 'userData') currentUserData = String(value); },
          requestSingleInstanceLock: () => {
            if (lockedProfiles.has(currentUserData)) return false;
            lockedProfiles.add(currentUserData);
            return true;
          },
          releaseSingleInstanceLock: () => { lockedProfiles.delete(currentUserData); },
          whenReady: async () => {},
          getAppPath: () => root,
          on() {},
          quit() {},
          exit() {},
        },
        BrowserWindow: NestedWindow,
        protocol: { handle() {} },
        ipcMain: { handle() {}, removeHandler() {} },
        session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      }),
    };
  };

  const log = console.log;
  console.log = () => {};
  try {
    const nested1 = makeNestedElectron();
    await startDisplay(nested1.electron);
    assert.notEqual(nested1.getUserData(), normalUserData, 'nested userData must be distinct from normal userData');
    assert.equal(lockedProfiles.has(normalUserData), true);
    assert.equal(lockedProfiles.has(nested1.getUserData()), true);

    // Negative control: a second concurrent nested instance at the same depth is refused.
    const nested2 = makeNestedElectron();
    await assert.rejects(startDisplay(nested2.electron), /SINGLE_INSTANCE/);
  } finally {
    console.log = log;
    await normalBoot.dispose();
  }
});

test('R2-T4-012 startDisplay prefixes DISPLAY_ONLY only when absent', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: ELECTRON_PIN, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor);
    else delete process.versions.electron;
  });

  // Already-prefixed failure -> single DISPLAY_ONLY: prefix.
  const prePrefixed = await displayFixture({ destroyedAt: 1 });
  try {
    await assert.rejects(
      startDisplay(prePrefixed.electron),
      (/** @type {Error} */ err) => {
        assert.match(err.message, /^DISPLAY_ONLY: /);
        assert.doesNotMatch(err.message, /^DISPLAY_ONLY:\s*DISPLAY_ONLY:/);
        return true;
      },
    );
  } finally {
    await prePrefixed.cleanup();
  }

  // Negative control: raw failure without prefix -> prefixed once.
  const rawFail = await displayFixture();
  rawFail.electron.BrowserWindow = class extends rawFail.electron.BrowserWindow {
    async loadURL() {
      throw new Error('ERR_FAILED');
    }
  };
  try {
    await assert.rejects(
      startDisplay(rawFail.electron),
      (/** @type {Error} */ err) => {
        assert.equal(err.message, 'DISPLAY_ONLY: ERR_FAILED');
        return true;
      },
    );
  } finally {
    await rawFail.cleanup();
  }
});

test('R2-T4-013 startDisplay removes registered IPC handlers and window-all-closed listener on failed startup', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: ELECTRON_PIN, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor);
    else delete process.versions.electron;
  });

  const expectedChannels = [
    'metaviewer:layout.load', 'metaviewer:nested.depth',
    'metaviewer:nested.self', 'metaviewer:recording.destination',
    'metaviewer:settings.load', 'metaviewer:layout.save',
    'metaviewer:settings.save', 'metaviewer:authority.propose',
    'metaviewer:authority.intent', 'metaviewer:authority.subscribe',
    'metaviewer:authority.unsubscribe', 'metaviewer:side-terminal.open',
    'metaviewer:side-terminal.enabled', 'metaviewer:side-terminal.attach',
    'metaviewer:side-terminal.resize', 'metaviewer:side-terminal.close',
    'metaviewer:side-terminal.providers', 'metaviewer:side-terminal.copy',
  ].sort();
  const makeTrackedFixture = async (shouldFailLoad) => {
    const base = await displayFixture();
    const handlers = new Map();
    const removed = [];
    const appListeners = new Map();
    base.electron.ipcMain = {
      handle(channel, fn) {
        handlers.set(channel, fn);
      },
      removeHandler(channel) {
        if (handlers.delete(channel)) removed.push(channel);
      },
    };
    base.electron.app.on = (event, fn) => {
      if (!appListeners.has(event)) appListeners.set(event, new Set());
      appListeners.get(event).add(fn);
    };
    base.electron.app.removeListener = (event, fn) => {
      appListeners.get(event)?.delete(fn);
    };
    if (shouldFailLoad) {
      base.electron.BrowserWindow = class extends base.electron.BrowserWindow {
        async loadURL() {
          throw new Error('ERR_FAILED');
        }
      };
    }
    return { ...base, handlers, getRemoved: () => removed, appListeners };
  };

  // Regression: failed startup -> zero handlers left and window-all-closed listener removed.
  const failed = await makeTrackedFixture(true);
  try {
    await assert.rejects(startDisplay(failed.electron), /^Error: DISPLAY_ONLY: ERR_FAILED$/);
    assert.equal(failed.handlers.size, 0, 'all registered IPC handlers must be removed on failed startup');
    assert.deepEqual(failed.getRemoved().sort(), expectedChannels, 'all 18 read-only layout handlers must be removed');
    assert.equal(failed.appListeners.get('window-all-closed')?.size ?? 0, 0);
  } finally {
    await failed.cleanup();
  }

  // Negative control: successful startup keeps all 18 handlers and the window-all-closed listener.
  const succeeded = await makeTrackedFixture(false);
  const log = console.log;
  console.log = () => {};
  try {
    await startDisplay(succeeded.electron);
    assert.deepEqual([...succeeded.handlers.keys()].sort(), expectedChannels);
    assert.deepEqual(succeeded.getRemoved(), []);
    assert.equal(succeeded.appListeners.get('window-all-closed')?.size ?? 0, 1);
  } finally {
    console.log = log;
    await succeeded.cleanup();
  }
});

test('R3-T4-006 startDisplay propagates --nested-depth=1 userAgent token so preload refuses locally with NESTED_DISPLAY_ONLY and zero IPC', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(process.versions, 'electron', { value: ELECTRON_PIN, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor);
    else delete process.versions.electron;
    if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator);
    else delete /** @type {any} */ (globalThis).navigator;
  });

  for (const initialUa of ['Mozilla/5.0 Chrome/134.0 Electron/44.9.2', '']) {
    const base = await displayFixture();
    const handlers = new Map();
    let currentUa = initialUa;
    let uaAtLoad = '';
    const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false };
    /** @type {any} */
    let contentsRef = null;

    base.electron.ipcMain = {
      handle(channel, fn) {
        handlers.set(channel, fn);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    };
    const BaseWindow = base.electron.BrowserWindow;
    base.electron.BrowserWindow = class extends BaseWindow {
      constructor() {
        super();
        this.webContents.id = 1;
        this.webContents.mainFrame = frame;
        this.webContents.getUserAgent = () => currentUa;
        this.webContents.setUserAgent = (/** @type {string} */ nextUa) => {
          currentUa = nextUa;
        };
        contentsRef = this.webContents;
      }
      async loadURL() {
        uaAtLoad = currentUa;
      }
    };

    const log = console.log;
    console.log = () => {};
    try {
      await startDisplay(base.electron);
      assert.equal(
        uaAtLoad.split(' ').includes('--nested-depth=1'),
        true,
        `expected --nested-depth=1 token in userAgent at loadURL, got ${JSON.stringify(uaAtLoad)}`,
      );

      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: uaAtLoad },
        configurable: true,
      });

      /** @type {Array<{ channel: string, args: unknown[] }>} */
      const ipcCalls = [];
      const facade = installPreload({
        contextBridge: { exposeInMainWorld: () => {} },
        ipcRenderer: {
          invoke: async (/** @type {string} */ channel, /** @type {unknown[]} */ ...args) => {
            ipcCalls.push({ channel, args });
            const handler = handlers.get(channel);
            if (!handler) throw new Error(`missing handler for ${channel}`);
            return handler({ sender: contentsRef, senderFrame: frame }, ...args);
          },
          on: () => {},
          removeListener: () => {},
        },
      });

      assert.equal('qa' in facade, false);
      assert.deepEqual(
        await facade.capture.screenshot({
          schema: 'capture_request/v1',
          request_id: 'req-shot-nested',
          surface_id: 'srf-nested-1',
        }),
        { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: 'req-shot-nested' },
      );
      assert.deepEqual(
        await facade.capture.recordStart({
          schema: 'capture_request/v1',
          request_id: 'req-start-nested',
          surface_id: 'srf-nested-1',
          mode: 'ai',
        }),
        { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: 'req-start-nested' },
      );
      assert.deepEqual(
        await facade.capture.recordStop({
          schema: 'capture_request/v1',
          request_id: 'req-stop-nested',
          recording_id: 'rec-nested-1',
        }),
        { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: 'req-stop-nested' },
      );
      assert.deepEqual(
        await facade.capture.export({
          schema: 'capture_request/v1',
          request_id: 'req-export-nested',
          capture_id: 'shot-nested-1',
          destination: null,
        }),
        { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: 'req-export-nested' },
      );
      assert.deepEqual(
        await facade.capture.list(),
        { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: '' },
      );
      assert.deepEqual(
        await facade.capture.subscribe(() => {}),
        { ok: false, code: 'NESTED_DISPLAY_ONLY', request_id: '' },
      );
      assert.deepEqual(
        await facade.input.send({
          schema: 'surface_input/v1',
          surface_id: 'srf-nested-1',
          stream_id: 1,
          seq: 1,
          events: [{ kind: 'click', x: 10, y: 20, button: 'left' }],
        }),
        { ok: false, code: 'NESTED_DISPLAY_ONLY' },
      );
      assert.equal(ipcCalls.length, 0, 'nested preload must refuse locally with zero IPC calls');

      // Negative control: read-only layout channels succeed while main deny handlers still refuse direct IPC.
      assert.equal(await facade.nestedDepth(), 1);
      assert.equal(await facade.load(), null);
      assert.equal(ipcCalls.length, 2);
      for (const denied of [
        CHANNELS.save,
        'metaviewer:settings.save',
        'metaviewer:authority.propose',
        'metaviewer:authority.intent',
        'metaviewer:side-terminal.open',
      ]) {
        const denyHandler = handlers.get(denied);
        assert.equal(typeof denyHandler, 'function', `expected deny handler for ${denied}`);
        assert.throws(
          () => denyHandler({ sender: contentsRef, senderFrame: frame }),
          /DISPLAY_ONLY: layout persistence is disabled; privileged actions are disabled/,
        );
      }
    } finally {
      console.log = log;
      await base.cleanup();
    }
  }
});
