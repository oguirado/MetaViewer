// Dedicated shell integration probe. No production core or persistent writes.
// Launch only through test/smoke.mjs, after a successful renderer build.
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { createWindowOptions, attachWindowPolicy, registerPrivilegedScheme,
  serveBundled, observeSender, CHANNELS, ELECTRON_PIN, PRIVILEGED_ORIGIN } from './main.js';

const deadline = setTimeout(() => app.exit(1), 15000);
registerPrivilegedScheme(protocol);
// [TARGET, unit decision] Complete ESM evaluation before awaiting app readiness.
// Electron emits ready after its main module has finished loading.
void runSmoke();
async function runSmoke() {
try {
  if (process.versions.electron !== ELECTRON_PIN) throw new Error('Electron version mismatch');
  await app.whenReady();
  serveBundled(protocol, fileURLToPath(new URL('../dist/', import.meta.url)), { styleNonce: true });
  const win = new BrowserWindow(createWindowOptions({ width: 1280, height: 720,
    preloadPath: fileURLToPath(new URL('../dist/preload/preload.cjs', import.meta.url)) }));
  attachWindowPolicy(win, session.defaultSession);
  win.webContents.on('console-message', (event) => console.error('renderer:', event.message));
  win.webContents.on('preload-error', (_event, _path, error) => console.error('preload:', error));
  ipcMain.handle(CHANNELS.load, (event, ...args) => {
    if (observeSender(event, win.webContents, PRIVILEGED_ORIGIN).verdict !== 'admit' || args.length) {
      throw new Error('Smoke layout load refused');
    }
    return null;
  });
  // Saving is outside this read-only smoke fixture.
  ipcMain.handle(CHANNELS.save, () => { throw new Error('Smoke storage is read-only'); });
  win.webContents.on('render-process-gone', () => app.exit(1));
  await win.loadURL(`${PRIVILEGED_ORIGIN}/index.html`);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await win.webContents.executeJavaScript(`Boolean(
      document.querySelector('.metaviewer[data-wall-settled="true"]') &&
      typeof window.metaviewer?.load === 'function' &&
      typeof window.require === 'undefined'
    )`);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(0, 1000)'));
    throw new Error('Renderer wall did not settle with isolated preload');
  }
  console.log('METAVIEWER_SMOKE_OK');
  clearTimeout(deadline);
  app.exit(0);
} catch (error) {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
}
}
