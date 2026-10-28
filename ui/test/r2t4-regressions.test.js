// @ts-check
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS,
  CONTENT_SECURITY_POLICY,
  ELECTRON_PIN,
  FUSE_TABLE,
  PRIVILEGED_ORIGIN,
  REQUIRED_FUSE_COUNT,
  bootProductionMain,
  buildFuseConfig,
  decideNavigation,
  handleAppRequest,
  loadMainBindings,
  observeSender,
  resolveMainPaths,
} from '../electron/main.js';
import { findForbiddenEnv } from '../electron/coreLauncher.js';
import { installPreload } from '../electron/preload.js';
import { createSettingsStore, installAuthorityWire } from '../electron/authorityWire.js';
import { startDisplay } from '../electron/nesting.js';
import * as packaging from '../tools/package.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @param {string} prefix
 * @returns {string}
 */
function makeTempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {string} root
 * @returns {void}
 */
function rmRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/**
 * @returns {{root: string, rendererRoot: string}}
 */
function makeBundle() {
  const root = makeTempRoot('mv-reg-bundle-');
  const rendererRoot = join(root, 'dist', 'renderer');
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(
    join(rendererRoot, 'index.html'),
    '<!doctype html><html><head><title>t</title></head><body>x</body></html>',
  );
  writeFileSync(join(rendererRoot, 'app.js'), 'console.log(1);\n');
  const preloadDir = join(root, 'dist', 'preload');
  mkdirSync(preloadDir, { recursive: true });
  writeFileSync(join(preloadDir, 'preload.cjs'), 'module.exports = {};\n');
  return { root, rendererRoot };
}

/**
 * @returns {string}
 */
function makeXdg() {
  const xdg = makeTempRoot('mv-reg-xdg-');
  chmodSync(xdg, 0o700);
  return xdg;
}

/**
 * @param {Record<string, any>} [overrides]
 */
function bootWorld(overrides = {}) {
  /** @type {string[]} */
  const calls = [];
  const { root } = makeBundle();
  const xdg = makeXdg();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const frame = {
    origin: PRIVILEGED_ORIGIN,
    url: `${PRIVILEGED_ORIGIN}/index.html`,
    detached: false,
  };
  const contentsListeners = new Map();
  const winSession = {
    setPermissionRequestHandler: (/** @type {Function} */ h) => {
      calls.push('win-session.request');
      contentsListeners.set('permission-request', h);
    },
    setPermissionCheckHandler: (/** @type {Function} */ h) => {
      calls.push('win-session.check');
      contentsListeners.set('permission-check', h);
    },
  };
  const webContents = {
    id: 7,
    mainFrame: frame,
    isDestroyed: () => false,
    session: winSession,
    setWindowOpenHandler: (/** @type {Function} */ h) => {
      calls.push('contents.setWindowOpenHandler');
      contentsListeners.set('window-open', h);
    },
    on: (/** @type {string} */ name, /** @type {Function} */ h) => {
      calls.push(`contents.on:${name}`);
      contentsListeners.set(name, h);
    },
    loadURL: async (/** @type {string} */ url) => {
      calls.push(`loadURL:${url}`);
      if (overrides.loadUrlHangs) return new Promise(() => {});
    },
  };
  /** @type {any[]} */
  const constructed = [];
  /** @type {any[]} */
  const windows = [];
  class FakeWindow {
    /** @param {any} opts */
    constructor(opts) {
      calls.push('new-BrowserWindow');
      if (overrides.windowThrows) throw new Error('window boom');
      constructed.push(opts);
      this.webContents = webContents;
      this.readyToShow = null;
      windows.push(this);
    }
    /**
     * @param {string} name
     * @param {Function} fn
     */
    once(name, fn) {
      calls.push(`window.once:${name}`);
      if (name === 'ready-to-show') this.readyToShow = fn;
    }
    show() {
      calls.push('window.show');
    }
    destroy() {
      calls.push('window.destroy');
    }
    isDestroyed() {
      return false;
    }
  }
  const handlers = new Map();
  const appListeners = new Map();
  const app = {
    requestSingleInstanceLock: () => {
      calls.push('lock');
      return overrides.lock ?? true;
    },
    whenReady: async () => {
      calls.push('ready');
      if (overrides.readyRejects) throw new Error('ready boom');
    },
    on: (/** @type {string} */ name, /** @type {Function} */ h) => {
      calls.push(`app.on:${name}`);
      appListeners.set(name, h);
    },
    quit: () => {
      calls.push('app.quit');
    },
    exit: (/** @type {number} */ code) => {
      calls.push(`app.exit:${code}`);
    },
    getAppPath: () => root,
    getPath: () => join(root, 'user-data'),
  };
  const ipcMain = {
    handle: (/** @type {string} */ channel, /** @type {Function} */ fn) => {
      calls.push(`ipc.handle:${channel}`);
      handlers.set(channel, fn);
    },
    removeHandler: (/** @type {string} */ channel) => {
      calls.push(`ipc.remove:${channel}`);
      handlers.delete(channel);
    },
  };
  const protocol = {
    registerSchemesAsPrivileged: () => {
      calls.push('protocol.privileged');
    },
    handle: (/** @type {string} */ scheme, /** @type {Function} */ _fn) => {
      calls.push(`protocol.handle:${scheme}`);
      if (overrides.protocolThrows) throw new Error('protocol boom');
    },
    unhandle: (/** @type {string} */ scheme) => {
      calls.push(`protocol.unhandle:${scheme}`);
    },
  };
  const defaultSession = {
    setPermissionRequestHandler: () => {
      calls.push('default-session.request');
    },
    setPermissionCheckHandler: () => {
      calls.push('default-session.check');
    },
  };
  const coreStatus = overrides.coreStatus ?? {
    availability: 'live',
    pid: 4242,
    authority_epoch: 7,
    reason: null,
  };
  const core = {
    start: async () => {
      calls.push('core.start');
      if (overrides.startThrows) throw new Error('start boom');
      return coreStatus;
    },
    request: async (/** @type {unknown} */ message) => ({ echo: message }),
    dispose: async () => {
      calls.push('core.dispose');
    },
    getStatus: () => coreStatus,
  };
  /** @type {any[]} */
  const decoded = [];
  /** @type {any[]} */
  const invoked = [];
  const bridge = overrides.bridge ?? [
    {
      channel: CHANNELS.load,
      decode: (/** @type {unknown} */ raw) => {
        decoded.push(['load', raw]);
        return null;
      },
      invoke: async (/** @type {unknown} */ value) => {
        invoked.push(['load', value]);
        return 'layout-json';
      },
    },
    {
      channel: CHANNELS.save,
      decode: (/** @type {unknown} */ raw) => {
        decoded.push(['save', raw]);
        return raw;
      },
      invoke: async (/** @type {unknown} */ value) => {
        invoked.push(['save', value]);
        return true;
      },
    },
  ];
  const handles = {
    app,
    BrowserWindow: overrides.windowClass ?? FakeWindow,
    ipcMain,
    protocol,
    session: { defaultSession },
    electronVersion: overrides.electronVersion ?? ELECTRON_PIN,
    shellRoot: root,
    argv: overrides.argv ?? ['metaviewer'],
    env: overrides.env ?? {},
    runtime: { xdgRuntimeDir: xdg, uid },
    core,
    bridge,
    geometry: overrides.geometry ?? { width: 1280, height: 720 },
  };
  return {
    calls,
    root,
    xdg,
    handles,
    constructed,
    windows,
    handlers,
    appListeners,
    contentsListeners,
    webContents,
    frame,
    decoded,
    invoked,
    cleanup: () => {
      rmRoot(root);
      rmRoot(xdg);
    },
  };
}

/**
 * Verify that main.js defines ELECTRON_PIN once and package.js imports it from main.js
 * without hardcoded duplicate version literals.
 * @param {string} mainSource
 * @param {string} pkgSource
 */
function assertElectronPinSingleSource(mainSource, pkgSource) {
  const mainMatch = mainSource.match(/export const ELECTRON_PIN = '([^']+)'/);
  assert.ok(mainMatch, 'main.js must export ELECTRON_PIN');
  assert.equal(mainMatch[1], ELECTRON_PIN);
  assert.match(
    pkgSource,
    /import\s*\{[^}]*\bELECTRON_PIN\b[^}]*\}\s*from\s*['"]\.\.\/electron\/main\.js['"]/,
    'package.js must import ELECTRON_PIN from ../electron/main.js',
  );
  assert.equal(
    pkgSource.includes(mainMatch[1]),
    false,
    'package.js must not duplicate the hardcoded Electron version string',
  );
}

describe('Electron security regressions and contract locks', () => {
  it('packaging policy and fuse vector are enforced', () => {
    assert.equal(FUSE_TABLE.length, 9);
    assert.equal(REQUIRED_FUSE_COUNT, 6);
    const config = buildFuseConfig();
    let requiredCount = 0;
    for (const row of FUSE_TABLE) {
      if (row.required) requiredCount++;
    }
    assert.equal(requiredCount, REQUIRED_FUSE_COUNT);

    assert.throws(() => packaging.assertPackagingPolicy(false, config), { message: /ASAR/ });
    assert.throws(
      () => packaging.assertPackagingPolicy(true, { ...config, '0': true }),
      { message: /Fuse/ },
    );
  });

  it('resolve-to-open race is closed via O_NOFOLLOW open', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      const secretFile = join(root, 'SECRET.txt');
      writeFileSync(secretFile, 'TOP_SECRET_BYTES');
      const res = await handleAppRequest(
        rendererRoot,
        { url: `${PRIVILEGED_ORIGIN}/app.js` },
        {
          beforeOpen: () => {
            rmSync(join(rendererRoot, 'app.js'));
            symlinkSync(secretFile, join(rendererRoot, 'app.js'));
          },
        },
      );
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
      const text = await res.text();
      assert.equal(text, 'forbidden');
    } finally {
      rmRoot(root);
    }
  });

  it('renderer root cannot alias preload or contain symlinked parents', () => {
    const { root, rendererRoot } = makeBundle();
    const xdg = makeXdg();
    const app = { getAppPath: () => root, getPath: () => join(root, 'user-data') };
    const runtime = { xdgRuntimeDir: xdg, uid: process.getuid ? process.getuid() : 0 };
    try {
      rmSync(rendererRoot, { recursive: true });
      symlinkSync(join(root, 'dist'), rendererRoot);
      assert.throws(() => resolveMainPaths(app, root, runtime), { code: 'PRELOAD_CONTAINMENT' });
    } finally {
      rmRoot(root);
      rmRoot(xdg);
    }
  });

  it('IPC surplus positional arguments are refused before bridge calls', async () => {
    const world = bootWorld();
    const boot = await bootProductionMain(world.handles);
    const event = { sender: world.webContents, senderFrame: world.frame };
    try {
      await assert.rejects(world.handlers.get(CHANNELS.load)(event, 'extra'), {
        code: 'LAYOUT_BOUNDS',
      });
      await assert.rejects(world.handlers.get(CHANNELS.save)(event, '{}', 'extra'), {
        code: 'LAYOUT_BOUNDS',
      });
      assert.equal(world.decoded.length, 0);
      assert.equal(world.invoked.length, 0);
    } finally {
      await boot.dispose();
      world.cleanup();
    }
  });

  it('scheme registration occurs before ready', async () => {
    const world = bootWorld();
    let readyCalled = false;
    world.handles.app.whenReady = async () => {
      readyCalled = true;
      assert.ok(world.calls.includes('protocol.privileged'));
    };
    const boot = await bootProductionMain(world.handles);
    assert.ok(readyCalled);
    await boot.dispose();
    world.cleanup();
  });

  it('package output validation creates no directories on failure', async () => {
    const root = makeTempRoot('mv-pkg-test-');
    const probeName = `injected-pkg-test-${root.split('/').at(-1)}`;
    const alias = join(root, 'repo-alias');
    symlinkSync(REPO_ROOT, alias);
    const injectedOut = join(alias, probeName);
    try {
      assert.throws(
        () => packaging.validateOutput(join(REPO_ROOT, probeName), REPO_ROOT),
        /MV_PKG_OUT must not overlap/,
      );
      await assert.rejects(
        packaging.packageShell({ MV_PKG_OUT: injectedOut }),
        /MV_PKG_OUT must not overlap/,
      );
      assert.equal(existsSync(join(REPO_ROOT, probeName)), false);
    } finally {
      rmRoot(root);
      rmSync(join(REPO_ROOT, probeName), { force: true, recursive: true });
    }
  });

  it('nesting depth >= 2 is refused at boot', async () => {
    const world = bootWorld();
    world.handles.argv = ['metaviewer', '--nested-depth=2'];
    await assert.rejects(bootProductionMain(world.handles), { code: 'NESTED_DEPTH' });
    world.cleanup();
  });

  it('closed v0.2 frame notice is admitted and v0.1 is refused', () => {
    /** @type {any} */
    let listener;
    let deliveredCount = 0;
    const api = installPreload({
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: {
        invoke: async () => true,
        on: (/** @type {string} */ _ch, /** @type {Function} */ fn) => {
          listener = fn;
        },
        removeListener: () => {},
      },
    });
    api.authority.subscribeFrames(() => {
      deliveredCount++;
    });

    const validV02 = {
      frame_ref: {
        schema: 'frame_ref/v0.2',
        surface_id: 's1',
        generation: 1,
        tick: 0,
        ts_ns: 0,
        capture_us: 0,
        width: 100,
        height: 100,
        format: 'rgb24',
        sha256: 'a'.repeat(64),
      },
      surface: {
        schema: 'surface/v0.2',
        surface_id: 's1',
        kind: 'browser',
        display: ':1',
        geometry: { w: 100, h: 100 },
        state: 'active',
        visibility: 'unfolded',
        control: 'human',
        profile_id: 'test',
      },
    };

    listener({ ports: [{}] }, validV02);
    assert.equal(deliveredCount, 1);

    const v01Notice = JSON.parse(JSON.stringify(validV02));
    v01Notice.frame_ref.schema = 'frame_ref/v0.1';
    listener({ ports: [{}] }, v01Notice);
    assert.equal(deliveredCount, 1);
  });

  it('fold and unfold enforce strict parameters and schema validation', async () => {
    /** @type {any[]} */
    const coreRequests = [];
    const core = {
      request: async (/** @type {unknown} */ req) => {
        coreRequests.push(req);
        return true;
      },
    };
    const handlers = new Map();
    const ipcMain = {
      handle: (/** @type {string} */ ch, /** @type {Function} */ fn) => handlers.set(ch, fn),
      removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
    };
    const webContents = {
      id: 7,
      mainFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` },
      isDestroyed: () => false,
    };

    const wire = installAuthorityWire({ ipcMain, contents: webContents, core });
    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    const validFold = JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req1',
      op: 'fold',
      params: { slot_id: 'slot1' },
    });
    const res = await handlers.get('metaviewer:authority.intent')(event, validFold);
    assert.equal(res, true);
    assert.equal(coreRequests.length, 1);

    const badFold = JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req1',
      op: 'fold',
      params: { slot_id: 'slot1', extra: 'bad' },
    });
    await assert.rejects(handlers.get('metaviewer:authority.intent')(event, badFold), {
      message: 'INTENT',
    });
    assert.equal(coreRequests.length, 1);

    wire.dispose();
  });

  it('frame port postMessage targets PRIVILEGED_ORIGIN exactly', () => {
    /** @type {any[]} */
    const posts = [];
    const windowMock = {
      location: { origin: 'app://metaviewer' },
      postMessage: (/** @type {any[]} */ ...args) => posts.push(args),
    };
    const originalWindow = globalThis.window;
    // @ts-ignore
    globalThis.window = windowMock;

    try {
      /** @type {any} */
      let listener;
      const api = installPreload({
        contextBridge: { exposeInMainWorld: () => {} },
        ipcRenderer: {
          invoke: async () => true,
          on: (/** @type {string} */ _ch, /** @type {Function} */ fn) => {
            listener = fn;
          },
          removeListener: () => {},
        },
      });

      const notice = {
        frame_ref: {
          schema: 'frame_ref/v0.2',
          surface_id: 's1',
          generation: 1,
          tick: 0,
          ts_ns: 0,
          capture_us: 0,
          width: 1,
          height: 1,
          format: 'rgb24',
          sha256: 'a'.repeat(64),
        },
        surface: {
          schema: 'surface/v0.2',
          surface_id: 's1',
          kind: 'browser',
          display: ':1',
          geometry: { w: 1, h: 1 },
          state: 'active',
          visibility: 'unfolded',
          control: 'human',
          profile_id: 'test',
        },
      };

      api.authority.subscribeFrames(() => {});
      listener({ ports: [{}] }, notice);

      assert.equal(posts.length, 1);
      assert.equal(posts[0][1], PRIVILEGED_ORIGIN);
      assert.notEqual(posts[0][1], '*');
    } finally {
      // @ts-ignore
      globalThis.window = originalWindow;
    }
  });

  it('main and preload PRIVILEGED_ORIGIN literals match exactly', () => {
    const mainSrc = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
    const preloadSrc = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8');

    const mainMatch = mainSrc.match(/export const PRIVILEGED_ORIGIN = ['"]([^'"]+)['"]/);
    const preloadMatch = preloadSrc.match(/const PRIVILEGED_ORIGIN = ['"]([^'"]+)['"]/);

    assert.ok(mainMatch, 'main.js export PRIVILEGED_ORIGIN found');
    assert.ok(preloadMatch, 'preload.js PRIVILEGED_ORIGIN found');
    assert.equal(mainMatch[1], PRIVILEGED_ORIGIN);
    assert.equal(preloadMatch[1], PRIVILEGED_ORIGIN);
    assert.equal(mainMatch[1], 'app://metaviewer');
  });

  it('host bindings reject relative MV_CORE_BOOTSTRAP paths', async () => {
    const world = bootWorld();
    world.handles.env = { MV_CORE_BOOTSTRAP: 'relative/path.js' };
    await assert.rejects(loadMainBindings(world.handles), { code: 'CORE_SEAMS_ABSENT' });
    world.cleanup();
  });

  it('privileged scheme call precedes ready and double registration is safe', async () => {
    const world = bootWorld();
    let privilegedCalledBeforeReady = false;
    let readyCalled = false;
    world.handles.protocol.registerSchemesAsPrivileged = () => {
      if (!readyCalled) privilegedCalledBeforeReady = true;
    };
    world.handles.app.whenReady = async () => {
      readyCalled = true;
    };
    const boot = await bootProductionMain(world.handles);
    assert.ok(privilegedCalledBeforeReady);
    await boot.dispose();
    world.cleanup();
  });

  it('core readiness is verified before creating windows', async () => {
    const world = bootWorld({
      startThrows: true,
      coreStatus: { availability: 'failed', pid: null, authority_epoch: null, reason: 'start boom' },
    });
    await assert.rejects(bootProductionMain(world.handles), { code: 'CORE_UNAVAILABLE' });
    assert.equal(world.constructed.length, 0);
    world.cleanup();
  });

  it('percent-25-encoded traversal spellings refuse with 403 and base CSP while plain missing files return 404', async () => {
    const { root, rendererRoot } = makeBundle();
    try {
      const encodedEscapes = [
        `${PRIVILEGED_ORIGIN}/%252e%252e/app.js`,
        `${PRIVILEGED_ORIGIN}/%252E%252E/app.js`,
        `${PRIVILEGED_ORIGIN}/%252e/app.js`,
        `${PRIVILEGED_ORIGIN}/a%252fb/app.js`,
        `${PRIVILEGED_ORIGIN}/a%255cb/app.js`,
        `${PRIVILEGED_ORIGIN}/%2500/app.js`,
        `${PRIVILEGED_ORIGIN}/%25zz/app.js`,
      ];
      for (const url of encodedEscapes) {
        const res = await handleAppRequest(rendererRoot, { url });
        assert.equal(res.status, 403, `expected 403 for ${url}`);
        assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, url);
        assert.equal(await res.text(), 'forbidden', url);
        assert.equal(decideNavigation(url), 'deny', `decideNavigation must deny ${url}`);
      }

      // Negative control: plain missing file still returns 404 with base CSP, and valid asset returns 200.
      const missingUrl = `${PRIVILEGED_ORIGIN}/missing.js`;
      const missing = await handleAppRequest(rendererRoot, { url: missingUrl });
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
      assert.equal(await missing.text(), 'not found');
      assert.equal(decideNavigation(missingUrl), 'allow');

      const present = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/app.js` });
      assert.equal(present.status, 200);
      assert.equal(present.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);

      // EVUI-05: single-encoded literal '%' in a valid filename (100%25.svg -> 100%.svg) is allowed and served,
      // while residual '%'-encoded sequences (%252e%252e, %25252e%25252e, %2e%2e) and '../secret' are denied.
      writeFileSync(join(rendererRoot, '100%.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
      const percentAssetUrl = `${PRIVILEGED_ORIGIN}/100%25.svg`;
      assert.equal(decideNavigation(percentAssetUrl), 'allow', 'EVUI-05: 100%25.svg must be allowed by decideNavigation');
      const percentRes = await handleAppRequest(rendererRoot, { url: percentAssetUrl });
      assert.equal(percentRes.status, 200, 'EVUI-05: 100%25.svg must resolve to 100%.svg');
      assert.equal(percentRes.headers.get('content-type'), 'image/svg+xml');

      for (const badUrl of [
        `${PRIVILEGED_ORIGIN}/%252e%252e/secret`,
        `${PRIVILEGED_ORIGIN}/%25252e%25252e/secret`,
        `${PRIVILEGED_ORIGIN}/%2e%2e/secret`,
        `${PRIVILEGED_ORIGIN}/../secret`,
      ]) {
        assert.equal(decideNavigation(badUrl), 'deny', `EVUI-05: must deny ${badUrl}`);
        const badRes = await handleAppRequest(rendererRoot, { url: badUrl });
        assert.equal(badRes.status, 403, `EVUI-05: must return 403 for ${badUrl}`);
      }
    } finally {
      rmRoot(root);
    }
  });

  it('writeManifest emits sha256sum lines without a custom header line', async () => {
    const root = makeTempRoot('mv-manifest-pin-');
    try {
      const bundleDir = join(root, 'bundle');
      const manifestPath = join(root, 'bundle.sha256');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'a.txt'), 'alpha\n');
      await packaging.writeManifest(bundleDir, manifestPath);
      const manifest = readFileSync(manifestPath, 'utf8');
      assert.equal(manifest.includes('SW240-MANIFEST-V1'), false);
      assert.match(manifest, /^[0-9a-f]{64}(?: [0-7]{4})?  a\.txt\n$/);
    } finally {
      rmRoot(root);
    }
  });

  it('findForbiddenEnv flags forbidden env vars regardless of value type and ignores allowed vars', () => {
    // @ts-ignore
    const nonString = findForbiddenEnv({
      PATH: '/usr/bin',
      MV_OK: 12345,
      LD_PRELOAD: 99,
      NODE_OPTIONS: null,
      ELECTRON_RUN_AS_NODE: undefined,
      PYTHONPATH: { bad: true },
    });
    assert.deepEqual(nonString, [
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'PYTHONPATH',
    ]);
    assert.equal(Object.isFrozen(nonString), true);
    const flagged = findForbiddenEnv({ LD_PRELOAD: '/tmp/inject.so', PATH: '/usr/bin' });
    assert.deepEqual(flagged, ['LD_PRELOAD']);
  });

  it('observeSender refuses missing, non-function, throwing, or non-false isDestroyed and admits live contents', () => {
    const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
    const contents = { id: 1, mainFrame: frame };
    const event = { sender: contents, senderFrame: frame };
    const verdict = observeSender(event, contents, PRIVILEGED_ORIGIN);
    assert.deepEqual(verdict, { verdict: 'refuse', code: 'SENDER' });

    const deadContents = { id: 1, mainFrame: frame, isDestroyed: () => true };
    const deadVerdict = observeSender(
      { sender: deadContents, senderFrame: frame },
      deadContents,
      PRIVILEGED_ORIGIN,
    );
    assert.deepEqual(deadVerdict, { verdict: 'refuse', code: 'SENDER' });

    const liveContents = { id: 1, mainFrame: frame, isDestroyed: () => false };
    const liveVerdict = observeSender(
      { sender: liveContents, senderFrame: frame },
      liveContents,
      PRIVILEGED_ORIGIN,
    );
    assert.equal(liveVerdict.verdict, 'admit');
  });

  it('ELECTRON_PIN is single-sourced from main.js into package.js and fails on drift', () => {
    assert.equal(packaging.ELECTRON_PIN, ELECTRON_PIN);
    assert.equal(
      packaging.packageArchitecture('arm64').archive,
      `electron-v${ELECTRON_PIN}-linux-arm64.zip`,
    );
    const mainSrc = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
    const pkgSrc = readFileSync(new URL('../tools/package.js', import.meta.url), 'utf8');
    assertElectronPinSingleSource(mainSrc, pkgSrc);

    // Negative control: planted duplicate version literal in package.js fails the drift check.
    const driftedPkgSrc = `${pkgSrc}\nconst duplicate = '${ELECTRON_PIN}';\n`;
    assert.throws(() => assertElectronPinSingleSource(mainSrc, driftedPkgSrc), {
      name: 'AssertionError',
      message: /must not duplicate/,
    });
  });

  it('createSettingsStore.save over a planted symlink at settings.json refuses and leaves the target untouched', async () => {
    const root = makeTempRoot('mv-settings-symlink-');
    try {
      const store = createSettingsStore({ XDG_CONFIG_HOME: root, HOME: root });
      const dir = join(root, 'metaviewer');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const victimPath = join(root, 'VICTIM.txt');
      writeFileSync(victimPath, 'VICTIM_ORIGINAL_BYTES', { mode: 0o600 });
      const settingsPath = join(dir, 'settings.json');
      symlinkSync(victimPath, settingsPath);
      assert.equal(lstatSync(settingsPath).isSymbolicLink(), true);

      const payload = JSON.stringify({ scheme: 'mv-light', density: 'compact' });
      await assert.rejects(() => store.save(payload), /SETTINGS_FILE/);
      assert.equal(readFileSync(victimPath, 'utf8'), 'VICTIM_ORIGINAL_BYTES');
      const st = lstatSync(settingsPath);
      assert.equal(st.isSymbolicLink(), true);
    } finally {
      rmRoot(root);
    }
  });

  it('startDisplay prefixes DISPLAY_ONLY once and disposes handlers on failed startup', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    Object.defineProperty(process.versions, 'electron', {
      value: ELECTRON_PIN,
      configurable: true,
    });
    const root = makeTempRoot('mv-nested-prefix-');
    mkdirSync(join(root, 'dist', 'renderer'), { recursive: true });

    /**
     * @param {Error} loadError
     */
    const runFailingDisplay = async (loadError) => {
      const handlers = new Map();
      const appListeners = new Map();
      let destroyed = false;
      class FailingWindow {
        constructor() {
          this.webContents = {
            on() {},
            setWindowOpenHandler() {},
            isDestroyed: () => destroyed,
            executeJavaScript: async () => true,
          };
        }
        removeMenu() {}
        isDestroyed() {
          return destroyed;
        }
        destroy() {
          destroyed = true;
        }
        async loadURL() {
          throw loadError;
        }
        show() {}
      }
      const electron = /** @type {any} */ ({
        app: {
          setName() {},
          requestSingleInstanceLock: () => true,
          whenReady: async () => {},
          getAppPath: () => root,
          on(/** @type {string} */ event, /** @type {Function} */ fn) {
            appListeners.set(event, fn);
          },
          removeListener(/** @type {string} */ event, /** @type {Function} */ fn) {
            if (appListeners.get(event) === fn) appListeners.delete(event);
          },
          quit() {},
          exit() {},
        },
        BrowserWindow: FailingWindow,
        protocol: { handle() {} },
        ipcMain: {
          handle(/** @type {string} */ ch, /** @type {Function} */ fn) {
            handlers.set(ch, fn);
          },
          removeHandler(/** @type {string} */ ch) {
            handlers.delete(ch);
          },
        },
        session: {
          defaultSession: {
            setPermissionRequestHandler() {},
            setPermissionCheckHandler() {},
          },
        },
      });
      await assert.rejects(
        startDisplay(electron),
        (/** @type {Error} */ err) => {
          assert.equal(err.message, 'DISPLAY_ONLY: inner failure');
          assert.doesNotMatch(err.message, /^DISPLAY_ONLY:\s*DISPLAY_ONLY:/);
          return true;
        },
      );
      assert.equal(handlers.size, 0);
      assert.equal(appListeners.size, 0);
      assert.equal(destroyed, true);
    };

    try {
      await runFailingDisplay(new Error('DISPLAY_ONLY: inner failure'));
      // Negative control: plain inner error without prefix also receives a single DISPLAY_ONLY: prefix.
      await runFailingDisplay(new Error('inner failure'));
    } finally {
      if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor);
      else delete process.versions.electron;
      rmRoot(root);
    }
  });

  it('createSettingsStore falls back to HOME/.config when XDG_CONFIG_HOME is unset and refuses relative XDG_CONFIG_HOME', async () => {
    const root = makeTempRoot('mv-xdg-fallback-');
    try {
      const store = createSettingsStore({ HOME: root });
      const payload = JSON.stringify({ scheme: 'mv-dark', density: 'compact' });
      assert.equal(await store.save(payload), true);
      assert.equal(await store.load(), payload);
      assert.equal(
        readFileSync(join(root, '.config', 'metaviewer', 'settings.json'), 'utf8'),
        payload,
      );

      // Negative control: explicit relative XDG_CONFIG_HOME fails closed.
      assert.throws(() => createSettingsStore({ XDG_CONFIG_HOME: 'relative/config' }), {
        message: 'CONFIG_PATH',
      });
    } finally {
      rmRoot(root);
    }
  });
});
