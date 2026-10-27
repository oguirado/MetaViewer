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
  ANCHOR,
  QA_ANCHOR_RE,
  QA_ANCHOR_SEGMENT_RE,
  QA_ANCHORS_CHANNEL,
  QA_ANCHORS_FILE,
  QA_ANCHORS_SCHEMA,
  QA_MAX_ANCHOR_CHARS,
  QA_MAX_ANCHOR_SEGMENT_CHARS,
  QA_MAX_ANCHOR_SEGMENTS,
  QA_MAX_BYTES,
  QA_MAX_ROWS,
  installQaAnchors,
  isValidAnchor,
  isValidQaAnchor,
  resolveQaConfig,
  validateQaAnchor,
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
        anchor: 'capsule/srf-id-4cf09207d83e/record',
        role: 'button',
        name: 'Record capsule',
        rect: { x: 8, y: 12, w: 96, h: 28 },
      },
      {
        anchor: 'wall/main/fold',
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
          rows: [{ ...good.rows[0], anchor: 'bad//slash' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: '/leading/slash' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: 'trailing/slash/' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: 'capsule/../record' }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{ ...good.rows[0], anchor: 'a/b/c/d/e/f/g' }],
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
          rows: [{ ...good.rows[0], anchor: 'a'.repeat(65) }],
        }),
      () =>
        api.qa.reportAnchors({
          schema: QA_ANCHORS_SCHEMA,
          seq: 1,
          rows: [{
            ...good.rows[0],
            anchor: `${'a'.repeat(50)}/${'b'.repeat(50)}/${'c'.repeat(50)}/${'d'.repeat(48)}`,
          }],
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
      anchor: `capsule/srf-${String(i).padStart(4, '0')}/${'x'.repeat(40)}/${'y'.repeat(40)}`,
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

describe('W2-QA-ANCHOR-GRAMMAR hierarchical anchor grammar, facade/main parity, and reverted-mutation proof', () => {
  const exact200Anchor = `${'a'.repeat(50)}/${'b'.repeat(50)}/${'c'.repeat(50)}/${'d'.repeat(47)}`;
  const over201Anchor = `${'a'.repeat(50)}/${'b'.repeat(50)}/${'c'.repeat(50)}/${'d'.repeat(48)}`;

  const positiveAnchors = [
    'capsule/srf-id-4cf09207d83e/record',
    'capsule/srf_01.main:slot-2/screenshot',
    'wall/main/fold',
    'screenshot',
    'wall.tile-1:fold_btn.0',
    'a',
    '9',
    'a'.repeat(64),
    'seg1/seg2',
    's1/s2/s3',
    's1/s2/s3/s4',
    's1/s2/s3/s4/s5',
    's1/s2/s3/s4/s5/s6',
    exact200Anchor,
  ];

  const negativeAnchors = [
    '',
    '//',
    'capsule//record',
    'a//b/c',
    '.',
    '..',
    './record',
    '../record',
    'capsule/./record',
    'capsule/../record',
    'capsule/.',
    'capsule/..',
    '/',
    '/capsule/srf-id-4cf09207d83e/record',
    '/wall/main/fold',
    'capsule/srf-id-4cf09207d83e/record/',
    'wall/main/fold/',
    's1/s2/s3/s4/s5/s6/s7',
    over201Anchor,
    'a'.repeat(65),
    `capsule/${'a'.repeat(65)}/record`,
    'capsule/srf\0id/record',
    'capsule/srf\nid/record',
    'capsule/srf\rid/record',
    'capsule/srf\tid/record',
    'capsule/\x1f/record',
    'capsule/\x7f/record',
    '.leading-dot',
    '-leading-dash',
    '_leading-underscore',
    ':leading-colon',
    'capsule/.hidden/record',
    'capsule/-dash/record',
    'capsule/bad space/record',
    'capsule\\record',
    'capsule/ümlaut/record',
  ];

  it('exports ANCHOR / QA_ANCHOR_RE grammar constants and validator functions with exact bounds', () => {
    assert.equal(ANCHOR instanceof RegExp, true);
    assert.equal(QA_ANCHOR_RE, ANCHOR);
    assert.equal(QA_ANCHOR_SEGMENT_RE instanceof RegExp, true);
    assert.equal(QA_MAX_ANCHOR_CHARS, 200);
    assert.equal(QA_MAX_ANCHOR_SEGMENTS, 6);
    assert.equal(QA_MAX_ANCHOR_SEGMENT_CHARS, 64);
    assert.equal(isValidAnchor, isValidQaAnchor);
    assert.equal(exact200Anchor.length, 200);
    assert.equal(over201Anchor.length, 201);
  });

  it('admits all positive hierarchical and single-segment anchors in regex, validator, main, and preload facade', async () => {
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

    for (const candidate of positiveAnchors) {
      assert.equal(ANCHOR.test(candidate), true, `ANCHOR regex should admit ${candidate}`);
      assert.equal(isValidQaAnchor(candidate), true, `isValidQaAnchor should admit ${candidate}`);
      assert.equal(validateQaAnchor(candidate), candidate);

      const snapshot = {
        schema: QA_ANCHORS_SCHEMA,
        seq: 1,
        rows: [
          {
            anchor: candidate,
            role: 'button',
            name: 'Action',
            rect: { x: 10, y: 20, w: 80, h: 24 },
          },
        ],
      };
      const mainValidated = validateQaSnapshot(snapshot);
      assert.equal(mainValidated.rows[0].anchor, candidate);
      assert.equal(await api.qa.reportAnchors(snapshot), true);
    }
    assert.equal(invoked.length, positiveAnchors.length);
  });

  it('refuses all negative anchors (empty, //, ., .., leading/trailing /, 7 segments, 201 chars, 65-char segment, control chars) in regex, validator, main, and preload facade', () => {
    /** @type {Array<unknown>} */
    const invoked = [];
    const api = createPreloadFacade({
      transport: {
        qa: true,
        invoke: async (... call) => {
          invoked.push(call);
          return true;
        },
        subscribe: () => () => {},
      },
      bridge: { exposeInMainWorld: () => {} },
    });

    for (const invalid of negativeAnchors) {
      assert.equal(ANCHOR.test(invalid), false, `ANCHOR regex must reject ${JSON.stringify(invalid)}`);
      assert.equal(isValidQaAnchor(invalid), false, `isValidQaAnchor must reject ${JSON.stringify(invalid)}`);
      assert.throws(
        () => validateQaAnchor(invalid),
        (err) => err instanceof MainError && err.code === 'QA_PAYLOAD',
        `validateQaAnchor must reject ${JSON.stringify(invalid)}`,
      );

      const snapshot = {
        schema: QA_ANCHORS_SCHEMA,
        seq: 1,
        rows: [
          {
            anchor: invalid,
            role: 'button',
            name: 'Action',
            rect: { x: 10, y: 20, w: 80, h: 24 },
          },
        ],
      };
      assert.throws(
        () => validateQaSnapshot(snapshot),
        (err) => err instanceof MainError && err.code === 'QA_PAYLOAD',
        `validateQaSnapshot must reject ${JSON.stringify(invalid)}`,
      );
      assert.throws(
        () => api.qa.reportAnchors(snapshot),
        (err) => err instanceof ContractError && err.code === 'PAYLOAD',
        `preload qa.reportAnchors must reject ${JSON.stringify(invalid)}`,
      );
    }

    for (const nonString of [null, undefined, 42, {}, ['wall/main/fold']]) {
      assert.equal(isValidQaAnchor(nonString), false);
      assert.throws(
        () => validateQaAnchor(nonString),
        (err) => err instanceof MainError && err.code === 'QA_PAYLOAD',
      );
    }
    assert.equal(invoked.length, 0);
  });

  it('keeps preload capture surface/recording id regex strict (no slashes) while qa.reportAnchors accepts hierarchical anchors', () => {
    const api = createPreloadFacade({
      transport: {
        qa: true,
        invoke: async () => ({
          ok: true,
          shot: {
            id: 'shot-1',
            surface_id: 'srf-id-4cf09207d83e',
            sha256: 'a'.repeat(64),
            created_ms: 1,
            width: 100,
            height: 100,
          },
        }),
        subscribe: () => () => {},
      },
      bridge: { exposeInMainWorld: () => {} },
    });

    assert.throws(
      () =>
        api.capture.screenshot({
          schema: 'capture_request/v1',
          request_id: 'req-1',
          surface_id: 'capsule/srf-id-4cf09207d83e/record',
        }),
      (err) => err instanceof ContractError && err.code === 'PAYLOAD',
    );
  });

  it('reverted-mutation proof: legacy single-segment regex and weakened bounds fail the oracle', () => {
    /**
     * Run the grammar oracle against a candidate validator.
     * @param {(v: unknown) => boolean} candidate
     */
    const runOracle = (candidate) => {
      for (const good of positiveAnchors) {
        assert.equal(candidate(good), true, `expected positive ${good}`);
      }
      for (const bad of negativeAnchors) {
        assert.equal(candidate(bad), false, `expected negative ${JSON.stringify(bad)}`);
      }
    };

    // Shipped implementation passes the oracle.
    runOracle(isValidQaAnchor);
    runOracle((v) => typeof v === 'string' && ANCHOR.test(v));

    // Mutant 1 (reverted legacy single-segment regex): rejects capsule/<id>/record and wall/main/fold.
    const legacyMutant = (/** @type {unknown} */ v) =>
      typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
    assert.throws(() => runOracle(legacyMutant), /capsule\/srf-id-4cf09207d83e\/record/);

    // Mutant 2 (missing 6-segment cap): admits 7 segments.
    const sevenSegMutant = (/** @type {unknown} */ v) =>
      typeof v === 'string' &&
      /^(?=.{1,200}$)[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}){0,6}$/.test(v);
    assert.throws(() => runOracle(sevenSegMutant), /s1\/s2\/s3\/s4\/s5\/s6\/s7/);

    // Mutant 3 (missing <= 200 total char cap): admits 201-char 4-segment anchor.
    const noTotalCapMutant = (/** @type {unknown} */ v) =>
      typeof v === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}){0,5}$/.test(v);
    assert.throws(() => runOracle(noTotalCapMutant));

    // Mutant 4 (allowing '.' or '..' or empty segments): admits traversal or empty segment.
    const dotSegmentMutant = (/** @type {unknown} */ v) =>
      typeof v === 'string' && v.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(v);
    assert.throws(() => runOracle(dotSegmentMutant));
  });
});
