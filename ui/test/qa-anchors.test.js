// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ContractError,
  createPreloadFacade,
  installPreload,
} from '../electron/preload.js';
import {
  CHANNELS,
  ELECTRON_PIN,
  MainError,
  PRIVILEGED_ORIGIN,
  bootProductionMain,
  validateRetailLaunch,
} from '../electron/main.js';
import {
  QA_ANCHORS_CHANNEL,
  QA_ANCHORS_FILE,
  QA_ANCHORS_SCHEMA,
  QA_MAX_BYTES,
  QA_MAX_ROWS,
  installQaAnchors,
  resolveQaConfig,
  validateQaRunDir,
  validateQaSnapshot,
  writeQaSnapshot,
} from '../electron/qaAnchors.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Create a private 0700 scratch directory outside the repo.
 * @param {string} prefix Temp prefix.
 * @returns {string} Absolute directory path.
 */
function makeRunDir(prefix = 'mv-qa-anchors-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Remove a scratch directory tree.
 * @param {string} dir Directory path.
 * @returns {void}
 */
function cleanDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a valid baseline QA anchor snapshot.
 * @param {number} [seq=1] Positive sequence number.
 * @returns {{ schema: 'qa_anchors/v1', seq: number, rows: Array<{ anchor: string, role: string, name: string, rect: { x: number, y: number, w: number, h: number } }> }}
 */
function validSnapshot(seq = 1) {
  return {
    schema: QA_ANCHORS_SCHEMA,
    seq,
    rows: [
      {
        anchor: 'wall.tile-1:fold_btn.0',
        role: 'button',
        name: 'Fold capsule',
        rect: { x: 12, y: 34, w: 120, h: 32 },
      },
      {
        anchor: 'toolbar.filter-input',
        role: 'searchbox',
        name: 'Filter capsules',
        rect: { x: 200, y: 16, w: 240, h: 28 },
      },
    ],
  };
}

/**
 * Build fake BrowserWindow/ipcMain/protocol handles for bootProductionMain tests.
 * @param {{ env?: NodeJS.ProcessEnv, argv?: string[], isPackaged?: boolean }} [options]
 */
function makeBootHarness(options = {}) {
  const root = makeRunDir('mv-qa-bundle-');
  const rendererRoot = join(root, 'dist', 'renderer');
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(join(rendererRoot, 'index.html'), '<!doctype html><html><body>ok</body></html>');
  const preloadDir = join(root, 'dist', 'preload');
  mkdirSync(preloadDir, { recursive: true });
  writeFileSync(join(preloadDir, 'preload.cjs'), 'module.exports = {};\n');

  const xdg = makeRunDir('mv-qa-xdg-');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const frame = {
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: false,
  };
  /** @type {string | null} */
  let userAgent = null;
  const webContents = {
    id: 11,
    mainFrame: frame,
    isDestroyed: () => false,
    session: {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
    },
    setWindowOpenHandler: () => {},
    setUserAgent: (/** @type {string} */ ua) => {
      userAgent = ua;
    },
    on: () => {},
    loadURL: async () => {},
  };
  /** @type { unknown[] } */
  const windows = [];
  class FakeWindow {
    /** @param {unknown} opts */
    constructor(opts) {
      this.opts = opts;
      this.webContents = webContents;
      windows.push(this);
    }
    once() {}
    show() {}
    destroy() {}
  }
  /** @type {Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>} */
  const handlers = new Map();
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {(event: unknown, ...args: unknown[]) => Promise<unknown>} */ fn) => {
      handlers.set(ch, fn);
    },
    removeHandler: (/** @type {string} */ ch) => {
      handlers.delete(ch);
    },
  };
  const handles = {
    app: {
      ...(options.isPackaged ? { isPackaged: true } : {}),
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      on: () => {},
      quit: () => {},
      getAppPath: () => root,
      getPath: () => join(root, 'userdata'),
    },
    BrowserWindow: FakeWindow,
    ipcMain,
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: () => {},
      unhandle: () => {},
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
      },
    },
    electronVersion: ELECTRON_PIN,
    shellRoot: root,
    argv: options.argv ?? [],
    env: options.env ?? {},
    runtime: { xdgRuntimeDir: xdg, uid },
    core: {
      start: async () => ({ availability: 'live', socketPath: join(xdg, 'metaviewer', 'core.sock') }),
      request: async () => null,
      dispose: async () => {},
      getStatus: () => ({ availability: 'live' }),
    },
    bridge: [
      { channel: CHANNELS.load, decode: (/** @type {unknown} */ x) => x, invoke: async () => null },
      { channel: CHANNELS.save, decode: (/** @type {unknown} */ x) => x, invoke: async () => true },
    ],
    geometry: { width: 1280, height: 800 },
  };
  const validEvent = {
    sender: webContents,
    senderFrame: frame,
  };
  return {
    root,
    xdg,
    handles,
    handlers,
    windows,
    webContents,
    validEvent,
    getUserAgent: () => userAgent,
    cleanup: () => {
      cleanDir(root);
      cleanDir(xdg);
    },
  };
}

describe('W2-QA-ANCHORS enablement and retail/nested/packaged boundaries', () => {
  it('retail mode: facade has no qa key and main registers no qa.anchors handler', async () => {
    const harness = makeBootHarness({ env: {} });
    try {
      const api = createPreloadFacade({
        transport: { invoke: async () => true, subscribe: () => () => {} },
        bridge: { exposeInMainWorld: () => {} },
      });
      assert.equal('qa' in api, false);
      assert.equal(Object.hasOwn(api, 'qa'), false);
      assert.equal(Object.keys(api).includes('qa'), false);

      const boot = await bootProductionMain(/** @type {any} */ (harness.handles));
      assert.equal(harness.handlers.has(QA_ANCHORS_CHANNEL), false);
      assert.equal(harness.getUserAgent(), null);
      await boot.dispose();
    } finally {
      harness.cleanup();
    }
  });

  it('nested display-only mode: facade has no qa key and main registers nothing even when MV_E2E_LIVE=1', async () => {
    const runDir = makeRunDir('mv-qa-nested-');
    const harness = makeBootHarness({
      argv: ['--nested-depth=1'],
      env: { MV_E2E_LIVE: '1', MV_QA_RUN_DIR: runDir },
    });
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      const api = createPreloadFacade({
        transport: {
          nested: true,
          qa: true,
          invoke: async () => true,
          subscribe: () => () => {},
        },
        bridge: { exposeInMainWorld: () => {} },
      });
      assert.equal('qa' in api, false);
      assert.equal(Object.hasOwn(api, 'qa'), false);

      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: 'MetaViewer --nested-depth=1 --qa-anchors=1' },
        configurable: true,
      });
      const installed = installPreload({
        qa: true,
        contextBridge: { exposeInMainWorld: () => {} },
        ipcRenderer: { invoke: async () => true, on: () => {}, removeListener: () => {} },
      });
      assert.equal('qa' in installed, false);

      const directBridge = installQaAnchors({
        ipcMain: harness.handles.ipcMain,
        contents: harness.webContents,
        env: { MV_E2E_LIVE: '1', MV_QA_RUN_DIR: runDir },
        nested: true,
      });
      assert.equal(directBridge.enabled, false);
      assert.equal(harness.handlers.has(QA_ANCHORS_CHANNEL), false);

      const boot = await bootProductionMain(/** @type {any} */ (harness.handles));
      assert.equal(harness.handlers.has(QA_ANCHORS_CHANNEL), false);
      assert.equal(harness.getUserAgent(), 'MetaViewer --nested-depth=1');
      await boot.dispose();
    } finally {
      if (prevNavigator) {
        Object.defineProperty(globalThis, 'navigator', prevNavigator);
      } else {
        // @ts-ignore
        delete globalThis.navigator;
      }
      cleanDir(runDir);
      harness.cleanup();
    }
  });

  it('packaged launch refuses MV_E2E_LIVE and registers nothing', async () => {
    const runDir = makeRunDir('mv-qa-pkg-');
    const harness = makeBootHarness({
      isPackaged: true,
      env: { MV_E2E_LIVE: '1', MV_QA_RUN_DIR: runDir },
    });
    try {
      const verdict = validateRetailLaunch([], { MV_E2E_LIVE: '1' }, { packaged: true });
      assert.deepEqual(verdict, { ok: false, code: 'RETAIL_ENV' });

      assert.throws(
        () => resolveQaConfig({ env: { MV_E2E_LIVE: '1', MV_QA_RUN_DIR: runDir }, packaged: true }),
        (err) => err instanceof MainError && err.code === 'RETAIL_ENV',
      );

      assert.throws(
        () =>
          installQaAnchors({
            ipcMain: harness.handles.ipcMain,
            contents: harness.webContents,
            env: { MV_E2E_LIVE: '1', MV_QA_RUN_DIR: runDir },
            packaged: true,
          }),
        (err) => err instanceof MainError && err.code === 'RETAIL_ENV',
      );
      assert.equal(harness.handlers.has(QA_ANCHORS_CHANNEL), false);

      await assert.rejects(
        () => bootProductionMain(/** @type {any} */ (harness.handles)),
        (err) => err instanceof MainError && err.code === 'RETAIL_ENV',
      );
      assert.equal(harness.windows.length, 0);
      assert.equal(harness.handlers.has(QA_ANCHORS_CHANNEL), false);
    } finally {
      cleanDir(runDir);
      harness.cleanup();
    }
  });

  it('non-1 values of MV_E2E_LIVE are refused even in unpackaged launches', () => {
    const runDir = makeRunDir('mv-qa-badflag-');
    try {
      for (const bad of ['0', 'true', 'yes', '2']) {
        assert.deepEqual(validateRetailLaunch([], { MV_E2E_LIVE: bad }), {
          ok: false,
          code: 'RETAIL_ENV',
        });
        assert.throws(
          () => resolveQaConfig({ env: { MV_E2E_LIVE: bad, MV_QA_RUN_DIR: runDir } }),
          (err) => err instanceof MainError && err.code === 'RETAIL_ENV',
        );
      }
    } finally {
      cleanDir(runDir);
    }
  });
});

describe('W2-QA-ANCHORS preload fail-fast validation and main revalidation', () => {
  it('preload exposes qa.reportAnchors when enabled and fails fast before invoke on invalid shapes', async () => {
    /** @type {Array<{ channel: string, args: ReadonlyArray<unknown> }>} */
    const invoked = [];
    const api = createPreloadFacade({
      transport: {
        qa: true,
        invoke: async (channel, args) => {
          invoked.push({ channel, args });
          return true;
        },
        subscribe: () => () => {},
      },
      bridge: { exposeInMainWorld: () => {} },
    });
    assert.equal('qa' in api, true);
    assert.equal(typeof api.qa?.reportAnchors, 'function');

    const good = validSnapshot(1);
    const res = await api.qa.reportAnchors(good);
    assert.equal(res, true);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].channel, QA_ANCHORS_CHANNEL);

    const beforeCount = invoked.length;
    /** @type {Array<() => unknown>} */
    const badCalls = [
      () => api.qa.reportAnchors(),
      () => api.qa.reportAnchors(good, good),
      () => api.qa.reportAnchors(null),
      () => api.qa.reportAnchors([]),
      () => api.qa.reportAnchors({ ...good, schema: 'qa_anchors/v2' }),
      () => api.qa.reportAnchors({ ...good, seq: 0 }),
      () => api.qa.reportAnchors({ ...good, seq: -1 }),
      () => api.qa.reportAnchors({ ...good, seq: 1.5 }),
      () => api.qa.reportAnchors({ ...good, extra: true }),
      () => api.qa.reportAnchors({ ...good, path: '/tmp/override.json' }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], extraRowKey: 1 }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], rect: { ...good.rows[0].rect, z: 1 } }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: '' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: '.leading-dot' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: '-leading-dash' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: 'bad/slash' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: 'bad space' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: 'a'.repeat(129) }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], role: '' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], role: 'Button' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], name: 'x'.repeat(129) }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], name: 'bad\0null' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], name: 'lone\uD800surrogate' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], rect: { x: 1.5, y: 0, w: 10, h: 10 } }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], rect: { x: 0, y: 0, w: 0, h: 10 } }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], rect: { x: 0, y: 0, w: 10, h: -1 } }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: Array.from({ length: QA_MAX_ROWS + 1 }, (_, i) => ({
            anchor: `a${i}`,
            role: 'button',
            name: 'ok',
            rect: { x: 0, y: 0, w: 1, h: 1 },
          })),
        }),
    ];

    for (const call of badCalls) {
      assert.throws(call, (err) => err instanceof ContractError);
    }
    // Fail-fast: none of the invalid calls reached transport.invoke.
    assert.equal(invoked.length, beforeCount);
  });

  it('rejects > 64 KiB serialized payloads and hidden/symbol/accessor properties on both preload and main', () => {
    const api = createPreloadFacade({
      transport: {
        qa: true,
        invoke: async () => true,
        subscribe: () => () => {},
      },
      bridge: { exposeInMainWorld: () => {} },
    });

    // <= 512 rows, each valid individually, but combined JSON exceeds 64 KiB (65536 UTF-8 bytes).
    const heavyRows = Array.from({ length: 300 }, (_, i) => ({
      anchor: `anchor.${String(i).padStart(4, '0')}.${'x'.repeat(80)}`,
      role: 'button',
      name: 'é'.repeat(90),
      rect: { x: 100, y: 200, w: 300, h: 40 },
    }));
    const oversizeSnapshot = {
      schema: QA_ANCHORS_SCHEMA,
      seq: 1,
      rows: heavyRows,
    };
    assert.ok(oversizeSnapshot.rows.length <= QA_MAX_ROWS);
    assert.ok(Buffer.byteLength(JSON.stringify(oversizeSnapshot), 'utf8') > QA_MAX_BYTES);

    assert.throws(() => api.qa.reportAnchors(oversizeSnapshot), (err) => err instanceof ContractError && err.code === 'PAYLOAD');
    assert.throws(() => validateQaSnapshot(oversizeSnapshot), (err) => err instanceof MainError && err.code === 'QA_PAYLOAD');

    // Symbol property on snapshot
    const withSymbol = { ...validSnapshot(1), [Symbol('secret')]: 1 };
    assert.throws(() => api.qa.reportAnchors(withSymbol), ContractError);
    assert.throws(() => validateQaSnapshot(withSymbol), MainError);

    // Non-enumerable property on row
    const nonEnumRow = { ...validSnapshot(1).rows[0] };
    Object.defineProperty(nonEnumRow, 'hidden', { value: 'path', enumerable: false });
    const withNonEnum = { schema: QA_ANCHORS_SCHEMA, seq: 1, rows: [nonEnumRow] };
    assert.throws(() => api.qa.reportAnchors(withNonEnum), ContractError);
    assert.throws(() => validateQaSnapshot(withNonEnum), MainError);

    // Getter accessor on rect
    const getterRect = { x: 1, y: 2, w: 3 };
    Object.defineProperty(getterRect, 'h', { get: () => 4, enumerable: true });
    const withGetter = {
      schema: QA_ANCHORS_SCHEMA,
      seq: 1,
      rows: [{ ...validSnapshot(1).rows[0], rect: getterRect }],
    };
    assert.throws(() => api.qa.reportAnchors(withGetter), ContractError);
    assert.throws(() => validateQaSnapshot(withGetter), MainError);
  });
});

describe('W2-QA-ANCHORS atomic 0600 file persistence, sender checks, and path safety', () => {
  it('writes qa-anchors.json atomically with mode 0600 and overwrites without history on subsequent snapshots', async () => {
    const runDir = makeRunDir('mv-qa-live-');
    const harness = makeBootHarness({
      env: { MV_E2E_LIVE: '1', MV_QA_RUN_DIR: runDir },
    });
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      const boot = await bootProductionMain(/** @type {any} */ (harness.handles));
      assert.equal(harness.handlers.has(QA_ANCHORS_CHANNEL), true);
      assert.equal(harness.getUserAgent(), 'MetaViewer --qa-anchors=1');

      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: harness.getUserAgent() },
        configurable: true,
      });

      const handler = harness.handlers.get(QA_ANCHORS_CHANNEL);
      assert.ok(handler);
      const facade = installPreload({
        contextBridge: { exposeInMainWorld: () => {} },
        ipcRenderer: {
          invoke: (/** @type {string} */ channel, /** @type {unknown[]} */ ...args) => {
            assert.equal(channel, QA_ANCHORS_CHANNEL);
            return handler(harness.validEvent, ...args);
          },
          on: () => {},
          removeListener: () => {},
        },
      });
      assert.equal(typeof facade.qa?.reportAnchors, 'function');

      const snap1 = validSnapshot(1);
      assert.equal(await facade.qa.reportAnchors(snap1), true);

      const targetFile = join(runDir, QA_ANCHORS_FILE);
      assert.equal(existsSync(targetFile), true);
      const stat1 = lstatSync(targetFile);
      assert.equal(stat1.isFile(), true);
      assert.equal(stat1.isSymbolicLink(), false);
      assert.equal(stat1.mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(targetFile, 'utf8')), snap1);
      assert.deepEqual(readdirSync(runDir), [QA_ANCHORS_FILE]);

      // Second snapshot overwrites atomically with latest snapshot only (no append, no history).
      const snap2 = {
        schema: QA_ANCHORS_SCHEMA,
        seq: 2,
        rows: [
          {
            anchor: 'dialog.confirm:ok',
            role: 'button',
            name: 'Confirm 😀',
            rect: { x: 400, y: 300, w: 88, h: 36 },
          },
        ],
      };
      assert.equal(await facade.qa.reportAnchors(snap2), true);
      const stat2 = lstatSync(targetFile);
      assert.equal(stat2.mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(targetFile, 'utf8')), snap2);
      assert.deepEqual(readdirSync(runDir), [QA_ANCHORS_FILE]);

      await boot.dispose();
      assert.equal(harness.handlers.has(QA_ANCHORS_CHANNEL), false);
    } finally {
      if (prevNavigator) {
        Object.defineProperty(globalThis, 'navigator', prevNavigator);
      } else {
        // @ts-ignore
        delete globalThis.navigator;
      }
      cleanDir(runDir);
      harness.cleanup();
    }
  });

  it('enforces sender verification on metaviewer:qa.anchors before touching disk', async () => {
    const runDir = makeRunDir('mv-qa-sender-');
    const harness = makeBootHarness({
      env: { MV_E2E_LIVE: '1', MV_QA_RUN_DIR: runDir },
    });
    try {
      const bridge = installQaAnchors({
        ipcMain: harness.handles.ipcMain,
        contents: harness.webContents,
        env: { MV_E2E_LIVE: '1', MV_QA_RUN_DIR: runDir },
      });
      const handler = harness.handlers.get(QA_ANCHORS_CHANNEL);
      assert.ok(handler);
      const snap = validSnapshot(1);

      const badEvents = [
        null,
        {},
        { sender: { id: 999 }, senderFrame: harness.validEvent.senderFrame },
        { sender: harness.webContents, senderFrame: null },
        {
          sender: harness.webContents,
          senderFrame: { origin: 'https://evil.example', url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false },
        },
        {
          sender: harness.webContents,
          senderFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/other.html`, detached: false },
        },
        {
          sender: harness.webContents,
          senderFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: true },
        },
      ];

      for (const badEvent of badEvents) {
        await assert.rejects(
          () => handler(badEvent, snap),
          (err) => err instanceof MainError && err.message.endsWith('sender refused'),
        );
      }
      assert.equal(existsSync(join(runDir, QA_ANCHORS_FILE)), false);
      await bridge.dispose();
    } finally {
      cleanDir(runDir);
      harness.cleanup();
    }
  });

  it('refuses symlinked qa-anchors.json, symlinked runDir, permissive runDir, and in-repo runDir', async () => {
    const baseDir = makeRunDir('mv-qa-symlink-');
    try {
      const realDir = join(baseDir, 'real');
      mkdirSync(realDir, { mode: 0o700 });
      chmodSync(realDir, 0o700);

      // 1. Symlinked runDir is refused
      const linkDir = join(baseDir, 'link-dir');
      symlinkSync(realDir, linkDir);
      assert.throws(
        () => validateQaRunDir(linkDir),
        (err) => err instanceof MainError && err.code === 'QA_RUN_DIR',
      );

      // 2. Permissive 0755 runDir is refused
      const openDir = join(baseDir, 'open-dir');
      mkdirSync(openDir, { mode: 0o755 });
      chmodSync(openDir, 0o755);
      assert.throws(
        () => validateQaRunDir(openDir),
        (err) => err instanceof MainError && err.code === 'QA_RUN_DIR',
      );

      // 3. In-repo runDir is refused
      assert.throws(
        () => validateQaRunDir(join(REPO_ROOT, 'ui')),
        (err) => err instanceof MainError && err.code === 'QA_RUN_DIR',
      );

      // 4. Planted symlink at qa-anchors.json is refused without clobbering victim
      const victimFile = join(baseDir, 'victim.json');
      writeFileSync(victimFile, 'DO_NOT_OVERWRITE', 'utf8');
      symlinkSync(victimFile, join(realDir, QA_ANCHORS_FILE));

      await assert.rejects(
        () => writeQaSnapshot(realDir, validSnapshot(1)),
        (err) => err instanceof MainError && err.code === 'QA_SYMLINK',
      );
      assert.equal(readFileSync(victimFile, 'utf8'), 'DO_NOT_OVERWRITE');
    } finally {
      cleanDir(baseDir);
    }
  });
});
