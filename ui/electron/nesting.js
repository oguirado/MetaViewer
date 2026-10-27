// @ts-check
// [TARGET, unit decision] Packaged spike entry admits only display-only nesting.
// No core, capsule, terminal or socket capability is supplied to this module.
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELECTRON_PIN, PRIVILEGED_ORIGIN, validateRetailLaunch,
  registerPrivilegedScheme, serveBundled, createWindowOptions, attachWindowPolicy, observeSender, CHANNELS } from './main.js';

/**
 * @template T
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {() => Promise<T>} display
 * @returns {Promise<T>}
 */
export async function enterNested(argv, env, display) {
  const verdict = validateRetailLaunch(argv, env);
  if (!verdict.ok) throw new Error(`${verdict.code}: nested launch refused`);
  if (!verdict.nested) throw new Error('NESTED_DEPTH: this display-only build requires --nested-depth=1; depth >= 2 is refused');
  return display();
}

const NESTED_PROFILE_SUFFIX = '-nested-depth-1';

/**
 * Read-only display bootstrap; no core or persistent storage capability.
 * @param {Pick<import('electron').IpcMain, 'handle'>} ipcMain
 * @param {unknown} contents
 * @param {string[]} [registered]
 * @returns {string[]}
 */
export function installReadOnlyLayout(ipcMain, contents, registered = []) {
  // [TARGET, unit decision] The shared renderer awaits these read-only domain
  // channels before mounting. Nested display has fixed depth and no self id,
  // export destination or persisted settings; every privileged action refuses.
  /** @type {Map<string, number|null>} */
  const reads = new Map([
    [CHANNELS.load, null],
    ['metaviewer:nested.depth', 1],
    ['metaviewer:nested.self', null],
    ['metaviewer:recording.destination', null],
    ['metaviewer:settings.load', null],
  ]);
  for (const [channel, value] of reads) {
    ipcMain.handle(channel, (event, ...args) => {
      if (observeSender(event, contents, PRIVILEGED_ORIGIN).verdict !== 'admit' || args.length) {
        throw new Error('DISPLAY_ONLY: layout sender refused');
      }
      return value;
    });
    registered.push(channel);
  }
  for (const channel of [CHANNELS.save, 'metaviewer:settings.save',
    'metaviewer:authority.propose', 'metaviewer:authority.intent',
    'metaviewer:authority.subscribe', 'metaviewer:authority.unsubscribe',
    'metaviewer:side-terminal.open', 'metaviewer:side-terminal.enabled']) {
    ipcMain.handle(channel, () => { throw new Error('DISPLAY_ONLY: layout persistence is disabled; privileged actions are disabled'); });
    registered.push(channel);
  }
  return registered;
}

/** @param {typeof import('electron')} electron */
export async function startDisplay(electron) {
  const { app, BrowserWindow, protocol, session, ipcMain } = electron;
  if (process.versions.electron !== ELECTRON_PIN) throw new Error(`Electron must be ${ELECTRON_PIN}`);
  app.setName('MetaViewer');
  if (typeof app.setPath === 'function') {
    let baseUserData = '';
    if (typeof app.getPath === 'function') {
      try {
        const candidate = app.getPath('userData');
        if (typeof candidate === 'string') baseUserData = candidate;
      } catch {
        baseUserData = '';
      }
    }
    if (!baseUserData && typeof app.getAppPath === 'function') {
      try {
        const candidate = app.getAppPath();
        if (typeof candidate === 'string' && candidate) baseUserData = join(candidate, '.user-data');
      } catch {
        baseUserData = '';
      }
    }
    if (baseUserData) {
      const resolvedUserData = resolve(baseUserData);
      const nestedUserData = resolvedUserData.endsWith(NESTED_PROFILE_SUFFIX)
        ? resolvedUserData
        : `${resolvedUserData}${NESTED_PROFILE_SUFFIX}`;
      app.setPath('userData', nestedUserData);
    }
  }
  if (!app.requestSingleInstanceLock()) throw new Error('SINGLE_INSTANCE: profile already in use');
  // [TARGET, unit decision] Bound the entire startup, including ready/navigation.
  const deadlineMs = 15000;
  /** @type {import('electron').BrowserWindow | null} */
  let win = null;
  /** @type {string[]} */
  const registeredChannels = [];
  /** @type {(() => void) | null} */
  let onWindowAllClosed = null;
  let expired = false;
  const assertAlive = () => {
    if (expired || (win && (win.isDestroyed() || win.webContents.isDestroyed()))) {
      throw new Error('DISPLAY_ONLY: display destroyed or startup deadline exceeded');
    }
  };
  const destroyWindow = () => {
    if (win && !win.isDestroyed()) win.destroy();
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error('DISPLAY_ONLY: startup deadline exceeded'));
    }, deadlineMs);
  });
  const startup = async () => {
    await app.whenReady();
    assertAlive();
    const root = app.getAppPath();
    serveBundled(protocol, join(root, 'dist/renderer'), { styleNonce: true });
    win = new BrowserWindow({ ...createWindowOptions({ width: 1280, height: 720,
      preloadPath: join(root, 'dist/preload/preload.cjs') }), title: 'MetaViewer', autoHideMenuBar: true });
    win.removeMenu();
    attachWindowPolicy(win, session.defaultSession);
    win.webContents.on('render-process-gone', () => app.exit(1));
    win.webContents.on('preload-error', (_event, _path, error) => {
      console.error(error.message);
      app.exit(1);
    });
    installReadOnlyLayout(ipcMain, win.webContents, registeredChannels);
    onWindowAllClosed = () => app.quit();
    app.on('window-all-closed', onWindowAllClosed);
    await win.loadURL(`${PRIVILEGED_ORIGIN}/index.html`);
    assertAlive();
    win.show();
    let settled = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assertAlive();
      settled = await win.webContents.executeJavaScript(`Boolean(
        document.querySelector('.metaviewer[data-wall-settled="true"]') &&
        typeof window.metaviewer?.load === 'function' &&
        typeof window.require === 'undefined'
      )`);
      assertAlive();
      if (settled) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!settled) throw new Error('DISPLAY_ONLY: isolated renderer wall did not settle');
    console.log('METAVIEWER_NESTED_DISPLAY_READY');
    return win;
  };
  try {
    return await Promise.race([startup(), deadline]);
  } catch (error) {
    expired = true;
    const ipcAny = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (ipcMain));
    for (let index = registeredChannels.length - 1; index >= 0; index -= 1) {
      try {
        if (typeof ipcAny.removeHandler === 'function') {
          /** @type {(channel: string) => void} */ (ipcAny.removeHandler).call(ipcMain, registeredChannels[index]);
        }
      } catch {
        /* cleanup best-effort */
      }
    }
    registeredChannels.length = 0;
    const appAny = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (app));
    if (onWindowAllClosed !== null) {
      try {
        if (typeof appAny.removeListener === 'function') {
          /** @type {(event: string, listener: () => void) => void} */ (appAny.removeListener).call(app, 'window-all-closed', onWindowAllClosed);
        } else if (typeof appAny.off === 'function') {
          /** @type {(event: string, listener: () => void) => void} */ (appAny.off).call(app, 'window-all-closed', onWindowAllClosed);
        }
      } catch {
        /* cleanup best-effort */
      }
      onWindowAllClosed = null;
    }
    destroyWindow();
    try {
      if (typeof appAny.releaseSingleInstanceLock === 'function') {
        /** @type {() => void} */ (appAny.releaseSingleInstanceLock).call(app);
      }
    } catch {
      /* cleanup best-effort */
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith('DISPLAY_ONLY:') ? message : `DISPLAY_ONLY: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

if (process.versions.electron) {
  // Resolve Electron and install pre-ready policy before ESM evaluation settles.
  // Readiness itself must remain detached: Electron emits ready after evaluation.
  const electron = await import('electron');
  if (electron.app.isPackaged || (process.argv[1]
      && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
    void enterNested(process.argv.slice(1), process.env, () => {
      if (process.versions.electron !== ELECTRON_PIN) throw new Error(`Electron must be ${ELECTRON_PIN}`);
      electron.app.enableSandbox();
      registerPrivilegedScheme(electron.protocol);
      return startDisplay(electron);
    }).catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      electron.app.exit(1);
    });
  }
}
