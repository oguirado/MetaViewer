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

/**
 * Read-only in-memory layout service; no core or persistent storage capability.
 * @param {Pick<import('electron').IpcMain, 'handle'>} ipcMain
 * @param {unknown} contents
 */
export function installReadOnlyLayout(ipcMain, contents) {
  ipcMain.handle(CHANNELS.load, (event, ...args) => {
    if (observeSender(event, contents, PRIVILEGED_ORIGIN).verdict !== 'admit' || args.length) {
      throw new Error('DISPLAY_ONLY: layout sender refused');
    }
    return null;
  });
  ipcMain.handle(CHANNELS.save, () => { throw new Error('DISPLAY_ONLY: layout persistence is disabled'); });
}

/** @param {typeof import('electron')} electron */
export async function startDisplay(electron) {
  const { app, BrowserWindow, protocol, session, ipcMain } = electron;
  if (process.versions.electron !== ELECTRON_PIN) throw new Error(`Electron must be ${ELECTRON_PIN}`);
  app.setName('MetaViewer');
  app.enableSandbox();
  registerPrivilegedScheme(protocol);
  if (!app.requestSingleInstanceLock()) throw new Error('SINGLE_INSTANCE: profile already in use');
  await app.whenReady();
  const root = app.getAppPath();
  serveBundled(protocol, join(root, 'dist'), { styleNonce: true });
  const win = new BrowserWindow({ ...createWindowOptions({ width: 1280, height: 720,
    preloadPath: join(root, 'dist/preload/preload.cjs') }), title: 'MetaViewer', autoHideMenuBar: true });
  win.removeMenu();
  attachWindowPolicy(win, session.defaultSession);
  win.webContents.on('render-process-gone', () => app.exit(1));
  win.webContents.on('preload-error', (_event, _path, error) => {
    console.error(error.message);
    app.exit(1);
  });
  installReadOnlyLayout(ipcMain, win.webContents);
  app.on('window-all-closed', () => app.quit());
  await win.loadURL(`${PRIVILEGED_ORIGIN}/index.html`);
  win.show();
  let settled = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    settled = await win.webContents.executeJavaScript(`Boolean(
      document.querySelector('.metaviewer[data-wall-settled="true"]') &&
      typeof window.metaviewer?.load === 'function' &&
      typeof window.require === 'undefined'
    )`);
    if (settled) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!settled) throw new Error('DISPLAY_ONLY: isolated renderer wall did not settle');
  console.log('METAVIEWER_NESTED_DISPLAY_READY');
  return win;
}

if (process.versions.electron) {
  // Do not await readiness at ESM top level: Electron emits ready after evaluation.
  void import('electron').then(async electron => {
    if (!electron.app.isPackaged && (!process.argv[1]
        || resolve(process.argv[1]) !== fileURLToPath(import.meta.url))) return;
    try {
      await enterNested(process.argv.slice(1), process.env, async () => startDisplay(electron));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      electron.app.exit(1);
    }
  });
}
