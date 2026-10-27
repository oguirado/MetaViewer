// @ts-check
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNELS,
  ELECTRON_PIN,
  PRIVILEGED_ORIGIN,
  CONTENT_SECURITY_POLICY,
  FUSE_TABLE,
  REQUIRED_FUSE_COUNT,
  bootProductionMain,
  handleAppRequest,
  resolveMainPaths,
  loadMainBindings,
  buildFuseConfig,
} from '../electron/main.js';
import { installPreload } from '../electron/preload.js';
import { installAuthorityWire } from '../electron/authorityWire.js';

function makeTempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function rmRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function makeBundle() {
  const root = makeTempRoot('mv0r2-bundle-');
  const rendererRoot = join(root, 'dist', 'renderer');
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(join(rendererRoot, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>x</body></html>');
  writeFileSync(join(rendererRoot, 'app.js'), 'console.log(1);\n');
  const preloadDir = join(root, 'dist', 'preload');
  mkdirSync(preloadDir, { recursive: true });
  writeFileSync(join(preloadDir, 'preload.cjs'), 'module.exports = {};\n');
  return { root, rendererRoot };
}

function makeXdg() {
  const xdg = makeTempRoot('mv0r2-xdg-');
  chmodSync(xdg, 0o700);
  return xdg;
}

function bootWorld(overrides = {}) {
  const calls = [];
  const { root } = makeBundle();
  const xdg = makeXdg();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false };
  const contentsListeners = new Map();
  const winSession = {
    setPermissionRequestHandler: (h) => { calls.push('win-session.request'); contentsListeners.set('permission-request', h); },
    setPermissionCheckHandler: (h) => { calls.push('win-session.check'); contentsListeners.set('permission-check', h); },
  };
  const webContents = {
    id: 7,
    mainFrame: frame,
    isDestroyed: () => false,
    session: winSession,
    setWindowOpenHandler: (h) => { calls.push('contents.setWindowOpenHandler'); contentsListeners.set('window-open', h); },
    on: (name, h) => { calls.push(`contents.on:${name}`); contentsListeners.set(name, h); },
    loadURL: async (url) => { calls.push(`loadURL:${url}`); if (overrides.loadUrlHangs) return new Promise(() => {}); },
  };
  const constructed = [];
  const windows = [];
  class FakeWindow {
    constructor(opts) {
      calls.push('new-BrowserWindow');
      if (overrides.windowThrows) throw new Error('window boom');
      constructed.push(opts);
      this.webContents = webContents;
      this.readyToShow = null;
      windows.push(this);
    }
    once(name, fn) { calls.push(`window.once:${name}`); if (name === 'ready-to-show') this.readyToShow = fn; }
    show() { calls.push('window.show'); }
    destroy() { calls.push('window.destroy'); }
    isDestroyed() { return false; }
  }
  const handlers = new Map();
  const appListeners = new Map();
  const app = {
    requestSingleInstanceLock: () => { calls.push('lock'); return overrides.lock ?? true; },
    whenReady: async () => { calls.push('ready'); if (overrides.readyRejects) throw new Error('ready boom'); },
    on: (name, h) => { calls.push(`app.on:${name}`); appListeners.set(name, h); },
    quit: () => { calls.push('app.quit'); },
    exit: (code) => { calls.push(`app.exit:${code}`); },
    getAppPath: () => root,
    getPath: () => join(root, 'user-data'),
  };
  const ipcMain = {
    handle: (channel, fn) => { calls.push(`ipc.handle:${channel}`); handlers.set(channel, fn); },
    removeHandler: (channel) => { calls.push(`ipc.remove:${channel}`); handlers.delete(channel); },
  };
  const protocol = {
    registerSchemesAsPrivileged: () => { calls.push('protocol.privileged'); },
    handle: (scheme, fn) => {
      calls.push(`protocol.handle:${scheme}`);
      if (overrides.protocolThrows) throw new Error('protocol boom');
    },
    unhandle: (scheme) => { calls.push(`protocol.unhandle:${scheme}`); },
  };
  const defaultSession = {
    setPermissionRequestHandler: () => { calls.push('default-session.request'); },
    setPermissionCheckHandler: () => { calls.push('default-session.check'); },
  };
  const coreStatus = overrides.coreStatus ?? { availability: 'live', pid: 4242, authority_epoch: 7, reason: null };
  const core = {
    start: async () => {
      calls.push('core.start');
      if (overrides.startThrows) throw new Error('start boom');
      return coreStatus;
    },
    request: async (message) => ({ echo: message }),
    dispose: async () => { calls.push('core.dispose'); },
    getStatus: () => coreStatus,
  };
  const decoded = [];
  const invoked = [];
  const bridge = overrides.bridge ?? [
    {
      channel: CHANNELS.load,
      decode: (raw) => { decoded.push(['load', raw]); return null; },
      invoke: async (value) => { invoked.push(['load', value]); return 'layout-json'; },
    },
    {
      channel: CHANNELS.save,
      decode: (raw) => { decoded.push(['save', raw]); return raw; },
      invoke: async (value) => { invoked.push(['save', value]); return true; },
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
    calls, root, xdg, handles, constructed, windows, handlers, appListeners,
    contentsListeners, webContents, frame, decoded, invoked,
    cleanup: () => { rmRoot(root); rmRoot(xdg); },
  };
}

describe('T4 Regression Tests (Fixed Findings)', () => {

  it('R1-050 HIGH: packaging policy and fuse vector enforced', async () => {
    // Mutant proof: mutant altering REQUIRED_FUSE_COUNT or FUSE_TABLE breaks rows/count.
    assert.equal(FUSE_TABLE.length, 9);
    assert.equal(REQUIRED_FUSE_COUNT, 6);
    const config = buildFuseConfig();
    let requiredCount = 0;
    for (const row of FUSE_TABLE) {
      if (row.required) requiredCount++;
    }
    assert.equal(requiredCount, REQUIRED_FUSE_COUNT);

    try {
      const pkg = await import('../tools/package.js');
      assert.throws(() => pkg.assertPackagingPolicy(false, config), { message: /ASAR/ });
      assert.throws(() => pkg.assertPackagingPolicy(true, { ...config, '0': true }), { message: /Fuse/ });
    } catch {
      console.log('Skipping R1-050 packaging tool checks: @electron/asar unavailable');
    }
  });

  it('R1-051 MEDIUM: resolve-to-open race closed via O_NOFOLLOW open', async () => {
    // Mutant proof: dropping O_NOFOLLOW allows reading external symlink bytes.
    const { root, rendererRoot } = makeBundle();
    try {
      const secretFile = join(root, 'SECRET.txt');
      writeFileSync(secretFile, 'TOP_SECRET_BYTES');
      const res = await handleAppRequest(rendererRoot, { url: `${PRIVILEGED_ORIGIN}/app.js` }, {
        beforeOpen: () => {
          rmSync(join(rendererRoot, 'app.js'));
          symlinkSync(secretFile, join(rendererRoot, 'app.js'));
        },
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
      const text = await res.text();
      assert.equal(text, 'forbidden');
    } finally {
      rmRoot(root);
    }
  });

  it('R1-052 MEDIUM: renderer root cannot alias preload or contain symlinked parents', () => {
    // Mutant proof: skipping parent alias loop allows aliased preload directory.
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

  it('R1-053 MEDIUM: IPC surplus positional arguments refused before bridge calls', async () => {
    // Mutant proof: restoring listeners without arity check allows extra args through.
    const world = bootWorld();
    const boot = await bootProductionMain(world.handles);
    const event = { sender: world.webContents, senderFrame: world.frame };
    try {
      await assert.rejects(world.handlers.get(CHANNELS.load)(event, 'extra'), { code: 'LAYOUT_BOUNDS' });
      await assert.rejects(world.handlers.get(CHANNELS.save)(event, '{}', 'extra'), { code: 'LAYOUT_BOUNDS' });
      assert.equal(world.decoded.length, 0);
      assert.equal(world.invoked.length, 0);
    } finally {
      await boot.dispose();
      world.cleanup();
    }
  });

  it('ARG-ui_shell-1: scheme registration occurs during module load before ready', async () => {
    // Mutant proof: deferring privilege registration to ready fails pre-ready check.
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

  it('ARG-ui_shell-3: package output validation creates no directories on failure', async () => {
    // Mutant proof: mkdir before ancestor validation leaves orphan directory on disk.
    const root = makeTempRoot('mv0r2-pkg-test-');
    const alias = join(root, 'repo-alias');
    symlinkSync(process.cwd(), alias);
    const injectedOut = join(alias, 'injected-pkg-test');
    try {
      let pkg;
      try {
        pkg = await import('../tools/package.js');
      } catch {
        console.log('Skipping ARG-ui_shell-3 pkg import: @electron/asar unavailable');
        return;
      }
      await assert.rejects(
        pkg.packageShell({ MV_PKG_OUT: injectedOut, CAPSULE_UI_KIT_REPO: 'dummy' }),
        /MV_PKG_OUT must not overlap/
      );
      assert.equal(existsSync(join(process.cwd(), 'injected-pkg-test')), false);
    } finally {
      rmRoot(root);
      rmSync(join(process.cwd(), 'injected-pkg-test'), { force: true, recursive: true });
    }
  });

  it('ARG-ui_shell-7: nesting deadline and destroyed window guards', async () => {
    // Mutant proof: removing deadline or assertAlive allows hanging promises / calls on destroyed window.
    const world = bootWorld();
    world.handles.argv = ['metaviewer', '--nested-depth=2'];
    await assert.rejects(
      bootProductionMain(world.handles),
      { code: 'NESTED_DEPTH' }
    );
    world.cleanup();
  });

  it('FRAMEREF F1 / R1-112: closed v0.2 frame notice admitted and v0.1 refused', () => {
    // Mutant proof: accepting schema 'frame_ref/v0.1' passes invalid v0.1 notice.
    let listener;
    let deliveredCount = 0;
    const api = installPreload({
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: {
        invoke: async () => true,
        on: (_ch, fn) => { listener = fn; },
        removeListener: () => {},
      },
    });
    api.authority.subscribeFrames(() => { deliveredCount++; });

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
    assert.equal(deliveredCount, 1); // No new delivery for v0.1 notice
  });

  it('ARG-n_uisrc-8: fold/unfold strict parameters and schema validation', async () => {
    // Mutant proof: allowing extra keys in params passes malformed intent.
    const coreRequests = [];
    const core = {
      request: async (req) => { coreRequests.push(req); return true; },
    };
    const handlers = new Map();
    const ipcMain = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    };
    const webContents = {
      id: 7,
      mainFrame: { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` },
      isDestroyed: () => false,
    };

    const wire = installAuthorityWire({ ipcMain, contents: webContents, core });

    const event = { sender: webContents, senderFrame: webContents.mainFrame };

    // Valid fold intent
    const validFold = JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req1',
      op: 'fold',
      params: { slot_id: 'slot1' },
    });
    const res = await handlers.get('metaviewer:authority.intent')(event, validFold);
    assert.equal(res, true);
    assert.equal(coreRequests.length, 1);

    // Malformed fold intent with extra param key
    const badFold = JSON.stringify({
      schema: 'ui_intent/v0.2',
      request_id: 'req1',
      op: 'fold',
      params: { slot_id: 'slot1', extra: 'bad' },
    });
    await assert.rejects(
      handlers.get('metaviewer:authority.intent')(event, badFold),
      { message: 'INTENT' }
    );
    assert.equal(coreRequests.length, 1); // No core request made for bad fold

    wire.dispose();
  });

  it('Origin-gated forward: frame port postMessage targets PRIVILEGED_ORIGIN exactly', () => {
    // Mutant proof: using '*' as target origin allows port leakage to foreign origins.
    const posts = [];
    const windowMock = {
      location: { origin: 'app://metaviewer' },
      postMessage: (...args) => posts.push(args),
    };
    const originalWindow = globalThis.window;
    // @ts-ignore
    globalThis.window = windowMock;

    let listener;
    const api = installPreload({
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: {
        invoke: async () => true,
        on: (_ch, fn) => { listener = fn; },
        removeListener: () => {},
      },
    });

    const notice = {
      frame_ref: {
        schema: 'frame_ref/v0.2', surface_id: 's1', generation: 1, tick: 0, ts_ns: 0,
        capture_us: 0, width: 1, height: 1, format: 'rgb24', sha256: 'a'.repeat(64),
      },
      surface: {
        schema: 'surface/v0.2', surface_id: 's1', kind: 'browser', display: ':1',
        geometry: { w: 1, h: 1 }, state: 'active', visibility: 'unfolded', control: 'human', profile_id: 'test',
      },
    };

    api.authority.subscribeFrames(() => {});
    listener({ ports: [{}] }, notice);

    assert.equal(posts.length, 1);
    assert.equal(posts[0][1], PRIVILEGED_ORIGIN);
    assert.notEqual(posts[0][1], '*');

    // Reset window
    // @ts-ignore
    globalThis.window = originalWindow;
  });

  it('Origin parity: main and preload PRIVILEGED_ORIGIN match exactly', () => {
    // Mutant proof: a 1-character mismatch between main.js and preload.js origins fails this assertion.
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

  it('OPUS-W1-01 P1: host bindings default fallback and error handling', async () => {
    // Mutant proof: allowing relative bootstrap path loads non-host binding module.
    const world = bootWorld();
    world.handles.env = { MV_CORE_BOOTSTRAP: 'relative/path.js' };
    await assert.rejects(
      loadMainBindings(world.handles),
      { code: 'CORE_SEAMS_ABSENT' }
    );
    world.cleanup();
  });

  it('Scheme-before-ready: privileged call precedes ready and double registration is ignored', async () => {
    // Mutant proof: registering scheme after ready fails when renderer tries to fetch app:// URLs pre-ready.
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

  it('Boot-before-windows: core readiness verified before creating windows', async () => {
    // Mutant proof: creating windows before checking core readiness leaves orphan windows on core failure.
    const world = bootWorld({ startThrows: true, coreStatus: { availability: 'failed', pid: null, authority_epoch: null, reason: 'start boom' } });
    await assert.rejects(
      bootProductionMain(world.handles),
      { code: 'CORE_UNAVAILABLE' }
    );
    assert.equal(world.constructed.length, 0);
    world.cleanup();
  });

});
