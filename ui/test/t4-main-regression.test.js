// Regression fixtures adapted from coreLauncher.test.js.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS, CONTENT_SECURITY_POLICY, ELECTRON_PIN, PRIVILEGED_ORIGIN, bootProductionMain,
  createLayoutBridge, createWindowOptions, handleAppRequest, loadMainBindings, resolveMainPaths,
  serveBundled } from '../electron/main.js';
import { createWallLayout } from '../src/wall/layout.js';

function makeTempRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {string} root Directory to remove.
 * @returns {void}
 */
function rmRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Build a minimal bundle fixture: renderer index.html plus preload entry.
 * @returns {{root: string, rendererRoot: string}} Fixture paths.
 */
function makeBundle() {
  const root = makeTempRoot('mv0main-bundle-');
  const rendererRoot = join(root, 'dist', 'renderer');
  mkdirSync(rendererRoot, { recursive: true });
  writeFileSync(join(rendererRoot, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>x</body></html>');
  writeFileSync(join(rendererRoot, 'app.js'), 'console.log(1);\n');
  writeFileSync(join(rendererRoot, 'style.css'), 'body{color:#fff}\n');
  const preloadDir = join(root, 'dist', 'preload');
  mkdirSync(preloadDir, { recursive: true });
  writeFileSync(join(preloadDir, 'preload.cjs'), 'module.exports = {};\n');
  return { root, rendererRoot };
}

/**
 * Build an owner-only XDG runtime fixture.
 * @returns {string} XDG directory.
 */
function makeXdg() {
  const xdg = makeTempRoot('mv0main-xdg-');
  chmodSync(xdg, 0o700);
  return xdg;
}

// Isolated Electron handles: no browser process or real core is started.
function bootWorld(overrides = {}) {
  const calls = [];
  const { root } = makeBundle();
  const xdg = makeXdg();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html`, detached: false };
  const contentsListeners = new Map();
  const winSession = {
    setPermissionRequestHandler: (handler) => {
      calls.push('win-session.request');
      contentsListeners.set('permission-request', handler);
    },
    setPermissionCheckHandler: (handler) => {
      calls.push('win-session.check');
      contentsListeners.set('permission-check', handler);
    },
  };
  const webContents = {
    id: 7,
    mainFrame: frame,
    isDestroyed: () => false,
    session: winSession,
    setWindowOpenHandler: (handler) => {
      calls.push('contents.setWindowOpenHandler');
      contentsListeners.set('window-open', handler);
    },
    on: (name, handler) => {
      calls.push(`contents.on:${name}`);
      contentsListeners.set(name, handler);
    },
    loadURL: async (url) => {
      calls.push(`loadURL:${url}`);
    },
  };
  const constructed = [];
  const windows = [];
  class FakeWindow {
    constructor(opts) {
      calls.push('new-BrowserWindow');
      if (overrides.windowThrows) {
        throw new Error('window boom');
      }
      constructed.push(opts);
      this.webContents = webContents;
      this.readyToShow = null;
      windows.push(this);
    }

    once(name, fn) {
      calls.push(`window.once:${name}`);
      if (name === 'ready-to-show') {
        this.readyToShow = fn;
      }
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
      if (overrides.readyRejects) {
        throw new Error('ready boom');
      }
    },
    on: (name, handler) => {
      calls.push(`app.on:${name}`);
      appListeners.set(name, handler);
    },
    quit: () => {
      calls.push('app.quit');
    },
    exit: (code) => {
      calls.push(`app.exit:${code}`);
    },
    getAppPath: () => root,
    getPath: () => join(root, 'user-data'),
  };
  const ipcMain = {
    handle: (channel, fn) => {
      calls.push(`ipc.handle:${channel}`);
      handlers.set(channel, fn);
    },
    removeHandler: (channel) => {
      calls.push(`ipc.remove:${channel}`);
      handlers.delete(channel);
    },
  };
  const protocol = {
    registerSchemesAsPrivileged: () => {
      calls.push('protocol.privileged');
    },
    handle: (scheme, fn) => {
      calls.push(`protocol.handle:${scheme}`);
      if (overrides.protocolThrows) {
        throw new Error('protocol boom');
      }
    },
    unhandle: (scheme) => {
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
  const coreStatus = overrides.coreStatus ?? { availability: 'live', pid: 4242, authority_epoch: 7, reason: null };
  const core = {
    start: async () => {
      calls.push('core.start');
      if (overrides.startThrows) {
        throw new Error('start boom');
      }
      return coreStatus;
    },
    request: async (message) => ({ echo: message }),
    dispose: async () => {
      calls.push('core.dispose');
    },
    getStatus: () => coreStatus,
  };
  const decoded = [];
  const invoked = [];
  const bridge = overrides.bridge ?? [
    {
      channel: CHANNELS.load,
      decode: (raw) => {
        decoded.push(['load', raw]);
        return null;
      },
      invoke: async (value) => {
        invoked.push(['load', value]);
        return 'layout-json';
      },
    },
    {
      channel: CHANNELS.save,
      decode: (raw) => {
        decoded.push(['save', raw]);
        return raw;
      },
      invoke: async (value) => {
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
    calls, root, xdg, handles, constructed, windows, handlers, appListeners,
    contentsListeners, webContents, frame, decoded, invoked,
    cleanup: () => {
      rmRoot(root);
      rmRoot(xdg);
    },
  };
}

it('R1-051 replacement seam refuses outside bytes', async () => {
  const {root, rendererRoot} = makeBundle();
  try {
    const outside = join(root, 'secret.js'); writeFileSync(outside, 'SECRET');
    const ok = await handleAppRequest(rendererRoot, {url: `${PRIVILEGED_ORIGIN}/app.js`});
    assert.equal(ok.status, 200);
    const result = await handleAppRequest(rendererRoot, {url: `${PRIVILEGED_ORIGIN}/app.js`}, {
      beforeOpen: () => { rmSync(join(rendererRoot, 'app.js')); symlinkSync(outside, join(rendererRoot, 'app.js')); }
    });
    assert.equal(result.status, 403);
    assert.ok(!(await result.text()).includes('SECRET'));
  } finally { rmRoot(root); }
});
it('R1-052 renderer alias cannot contain preload; unsafe preload parents refused', () => {
  const {root, rendererRoot} = makeBundle(); const xdg = makeXdg();
  const app = {getAppPath: () => root, getPath: () => join(root, 'user-data')};
  const runtime = {xdgRuntimeDir: xdg, uid: process.getuid()};
  try {
    assert.ok(resolveMainPaths(app, root, runtime));
    rmSync(rendererRoot, {recursive: true}); symlinkSync(join(root, 'dist'), rendererRoot);
    assert.throws(() => resolveMainPaths(app, root, runtime), {code: 'PRELOAD_CONTAINMENT'});
    rmSync(rendererRoot); mkdirSync(rendererRoot);
    rmSync(join(root, 'dist/preload'), {recursive: true});
    mkdirSync(join(root, 'private')); writeFileSync(join(root, 'private/preload.cjs'), 'private');
    symlinkSync(join(root, 'private'), join(root, 'dist/preload'));
    assert.throws(() => resolveMainPaths(app, root, runtime), {code: 'PRELOAD_CONTAINMENT'});
  } finally { rmRoot(root); rmRoot(xdg); }
});
it('R1-053 IPC rejects malformed positional vectors before bridge calls', async () => {
  const world = bootWorld();
  const boot = await bootProductionMain(world.handles);
  const event = {sender: world.webContents, senderFrame: world.frame};
  try {
    for (const [channel, args] of [[CHANNELS.load, [undefined]], [CHANNELS.load, [undefined, 'EXTRA']],
      [CHANNELS.save, []], [CHANNELS.save, ['{}', 'EXTRA']]]) {
      await assert.rejects(world.handlers.get(channel)(event, ...args), {code: 'LAYOUT_BOUNDS'});
    }
    assert.equal(world.decoded.length, 0); assert.equal(world.invoked.length, 0);
    await world.handlers.get(CHANNELS.load)(event);
    await world.handlers.get(CHANNELS.save)(event, '{}');
    assert.equal(world.invoked.length, 2);
  } finally { await boot.dispose(); world.cleanup(); }
});

it('R1-051 replacement of an intermediate directory is refused', async () => {
  const {root, rendererRoot} = makeBundle();
  try {
    const inside = join(rendererRoot, 'assets'); const outside = join(root, 'outside');
    mkdirSync(inside); mkdirSync(outside);
    writeFileSync(join(inside, 'data.js'), 'public'); writeFileSync(join(outside, 'data.js'), 'SECRET');
    const result = await handleAppRequest(rendererRoot, {url: `${PRIVILEGED_ORIGIN}/assets/data.js`}, {
      beforeOpen: () => {rmSync(inside, {recursive: true}); symlinkSync(outside, inside);}
    });
    assert.equal(result.status, 403); assert.ok(!(await result.text()).includes('SECRET'));
  } finally {rmRoot(root);}
});
it('R1-052 aliased renderer aborts boot before protocol serving', async () => {
  const world = bootWorld();
  try {
    const renderer = join(world.root, 'dist/renderer'); rmSync(renderer, {recursive: true});
    symlinkSync(join(world.root, 'dist'), renderer);
    await assert.rejects(bootProductionMain(world.handles), {code: 'PRELOAD_CONTAINMENT'});
    assert.ok(!world.calls.includes('protocol.handle:app'));
    assert.equal(world.constructed.length, 0);
  } finally {world.cleanup();}
});

it('R2-T4-001 serveBundled pins root identity and refuses swapped root with 403 and base CSP', async () => {
  const scratch = makeTempRoot('mv0main-r2t4001-');
  try {
    const rootA = join(scratch, 'rootA');
    const rootB = join(scratch, 'rootB');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    writeFileSync(join(rootA, 'index.html'), 'AAA');
    writeFileSync(join(rootB, 'secret.txt'), 'BBB');
    let handler = null;
    const protocol = {
      handle: (scheme, fn) => {
        assert.equal(scheme, 'app');
        handler = fn;
      },
    };
    serveBundled(protocol, rootA, { styleNonce: false });
    assert.equal(typeof handler, 'function');

    // Negative control: no swap serves 200 with base CSP.
    const before = await handler({ url: `${PRIVILEGED_ORIGIN}/index.html` });
    assert.equal(before.status, 200);
    assert.equal(before.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
    assert.equal(await before.text(), 'AAA');

    // Swap rootA with a symlink to rootB.
    renameSync(rootA, join(scratch, 'rootA-moved'));
    symlinkSync(rootB, rootA);
    const swappedSecret = await handler({ url: `${PRIVILEGED_ORIGIN}/secret.txt` });
    assert.equal(swappedSecret.status, 403);
    assert.equal(swappedSecret.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
    assert.ok(!(await swappedSecret.text()).includes('BBB'));

    const swappedIndex = await handler({ url: `${PRIVILEGED_ORIGIN}/index.html` });
    assert.equal(swappedIndex.status, 403);
    assert.equal(swappedIndex.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);

    // Swap rootA with a real directory rootB (different dev/ino).
    rmSync(rootA, { force: true });
    renameSync(rootB, rootA);
    const replacedSecret = await handler({ url: `${PRIVILEGED_ORIGIN}/secret.txt` });
    assert.equal(replacedSecret.status, 403);
    assert.equal(replacedSecret.headers.get('Content-Security-Policy'), CONTENT_SECURITY_POLICY);
    assert.ok(!(await replacedSecret.text()).includes('BBB'));
  } finally {
    rmRoot(scratch);
  }
});

it('R2-T4-007 unwind guards throwing bridge dispose and preserves original boot failure', async () => {
  const world = bootWorld();
  try {
    world.handles.core.subscribeCapture = () => () => {
      world.calls.push('capture.revoke');
      throw new Error('capture dispose boom');
    };
    world.handles.wire = {
      frames: {
        subscribe: () => () => {
          world.calls.push('wire.stop');
          throw new Error('wire dispose boom');
        },
      },
    };
    world.webContents.loadURL = async () => {
      world.calls.push('loadURL:fail');
      throw new Error('load boom');
    };
    await assert.rejects(bootProductionMain(world.handles), { name: 'MainError', code: 'LOAD' });
    assert.ok(world.calls.includes('capture.revoke'));
    assert.ok(world.calls.includes('wire.stop'));
    assert.ok(world.calls.includes('window.destroy'));
    assert.ok(world.calls.includes('protocol.unhandle:app'));
    assert.ok(world.calls.includes('core.dispose'));
    assert.equal(world.handlers.has(CHANNELS.load), false);
    assert.equal(world.handlers.has(CHANNELS.save), false);
  } finally {
    world.cleanup();
  }

  // Negative control: clean unwind completes identically and preserves original error.
  const clean = bootWorld();
  try {
    clean.handles.core.subscribeCapture = () => () => {
      clean.calls.push('capture.revoke');
    };
    clean.handles.wire = {
      frames: {
        subscribe: () => () => {
          clean.calls.push('wire.stop');
        },
      },
    };
    clean.webContents.loadURL = async () => {
      clean.calls.push('loadURL:fail');
      throw new Error('load boom');
    };
    await assert.rejects(bootProductionMain(clean.handles), { name: 'MainError', code: 'LOAD' });
    assert.ok(clean.calls.includes('capture.revoke'));
    assert.ok(clean.calls.includes('wire.stop'));
    assert.ok(clean.calls.includes('window.destroy'));
    assert.ok(clean.calls.includes('protocol.unhandle:app'));
    assert.ok(clean.calls.includes('core.dispose'));
    assert.equal(clean.handlers.size, 0);
  } finally {
    clean.cleanup();
  }
});

it('R2-T4-008 loadMainBindings refuses non-owner-only MV_CORE_BOOTSTRAP and admits owner-only regular file', async () => {
  const scratch = makeTempRoot('mv0main-r2t4008-');
  chmodSync(scratch, 0o700);
  try {
    const modPath = join(scratch, 'bootstrap.mjs');
    const source = [
      'export const createMainBindings = async () => ({',
      '  core: {',
      "    start: async () => ({ availability: 'live', pid: 1, authority_epoch: 1, reason: null }),",
      '    request: async () => true,',
      '    dispose: async () => {},',
      "    getStatus: () => ({ availability: 'live', pid: 1, authority_epoch: 1, reason: null }),",
      '  },',
      '  wire: { frames: { subscribe: () => () => {} } },',
      '});',
    ].join('\n');
    writeFileSync(modPath, source, { mode: 0o666 });
    chmodSync(modPath, 0o666);
    await assert.rejects(loadMainBindings({ MV_CORE_BOOTSTRAP: modPath }), {
      name: 'MainError',
      code: 'CORE_SEAMS_ABSENT',
    });

    chmodSync(modPath, 0o600);
    const linkPath = join(scratch, 'bootstrap-link.mjs');
    symlinkSync(modPath, linkPath);
    await assert.rejects(loadMainBindings({ MV_CORE_BOOTSTRAP: linkPath }), {
      name: 'MainError',
      code: 'CORE_SEAMS_ABSENT',
    });

    // Negative control: owner-only regular file loads.
    const bindings = await loadMainBindings({ MV_CORE_BOOTSTRAP: modPath });
    assert.equal(typeof bindings.core.start, 'function');
    await bindings.core.dispose();
  } finally {
    rmRoot(scratch);
  }
});

it('R2-T4-010 createLayoutBridge refuses in-repo userData before mkdir and admits external userData', async () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const inRepoUserData = join(repoRoot, 'ui', 'test', 'in-repo-userdata-r2t4010');
  rmRoot(inRepoUserData);
  try {
    const inRepoBridge = createLayoutBridge({
      app: { getPath: (name) => { assert.equal(name, 'userData'); return inRepoUserData; } },
    });
    const loadInRepo = inRepoBridge.find((x) => x.channel === CHANNELS.load);
    const saveInRepo = inRepoBridge.find((x) => x.channel === CHANNELS.save);
    const validLayout = JSON.stringify(createWallLayout());
    await assert.rejects(loadInRepo.invoke(null), /LAYOUT_/);
    assert.equal(existsSync(inRepoUserData), false);
    await assert.rejects(saveInRepo.invoke(validLayout), /LAYOUT_/);
    assert.equal(existsSync(inRepoUserData), false);

    // Negative control: external userData works.
    const externalUserData = makeTempRoot('mv0main-r2t4010-');
    try {
      const externalBridge = createLayoutBridge({
        app: { getPath: (name) => { assert.equal(name, 'userData'); return externalUserData; } },
      });
      const loadExt = externalBridge.find((x) => x.channel === CHANNELS.load);
      const saveExt = externalBridge.find((x) => x.channel === CHANNELS.save);
      assert.equal(await loadExt.invoke(null), null);
      assert.equal(await saveExt.invoke(validLayout), true);
      assert.equal(await loadExt.invoke(null), validLayout);
    } finally {
      rmRoot(externalUserData);
    }
  } finally {
    rmRoot(inRepoUserData);
  }
});

it('R2-T4-019 createWindowOptions refuses non-enumerable extra keys via Reflect.ownKeys', () => {
  const withHidden = { width: 800, height: 600, preloadPath: '/preload.cjs' };
  Object.defineProperty(withHidden, 'extra', { value: 1, enumerable: false });
  assert.throws(() => createWindowOptions(withHidden), { name: 'MainError', code: 'OPTIONS' });

  const withSymbol = { width: 800, height: 600, preloadPath: '/preload.cjs', [Symbol('extra')]: 1 };
  assert.throws(() => createWindowOptions(withSymbol), { name: 'MainError', code: 'OPTIONS' });

  // Negative control: exact 3-key request is admitted.
  const admitted = createWindowOptions({ width: 800, height: 600, preloadPath: '/preload.cjs' });
  assert.equal(admitted.width, 800);
  assert.equal(admitted.height, 600);
  assert.equal(admitted.webPreferences.preload, '/preload.cjs');
});
