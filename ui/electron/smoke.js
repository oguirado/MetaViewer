// Dedicated shell integration probe. No production core or persistent writes.
// Launch only through test/smoke.mjs, after a successful renderer build.
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { installAuthorityWire } from './authorityWire.js';
import { createWindowOptions, attachWindowPolicy, registerPrivilegedScheme,
  resolveMainPaths, serveBundled, observeSender, CHANNELS, ELECTRON_PIN, PRIVILEGED_ORIGIN } from './main.js';

const deadline = setTimeout(() => app.exit(1), 15000);
registerPrivilegedScheme(protocol);
// [TARGET, unit decision] Complete ESM evaluation before awaiting app readiness.
// Electron emits ready after its main module has finished loading.
void runSmoke();
async function runSmoke() {
try {
  if (process.versions.electron !== ELECTRON_PIN) throw new Error('Electron version mismatch');
  await app.whenReady();
  if (!process.getuid) throw new Error('Smoke requires a host UID');
  const shellRoot = fileURLToPath(new URL('../', import.meta.url));
  // Direct-file launches use electron/ as getAppPath(). Adapt that launch-only
  // identity to the shell root; keep Electron's real userData path provider.
  const smokeApp = { getAppPath: () => shellRoot, getPath: app.getPath.bind(app) };
  const paths = resolveMainPaths(smokeApp, shellRoot, {
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR, uid: process.getuid(),
  });
  serveBundled(protocol, paths.rendererRoot, { styleNonce: true });
  const win = new BrowserWindow(createWindowOptions({ width: 1280, height: 720,
    preloadPath: paths.preloadPath }));
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
  const wire=installAuthorityWire({ipcMain,contents:win.webContents,
    env:{XDG_CONFIG_HOME:process.env.XDG_RUNTIME_DIR},argv:[],
    core:{request:async()=>({schema:'action_verdict/v0.2',proposal_id:'smoke',decision:'admitted',core_seq:1})}});
  app.once('will-quit',()=>{void wire.dispose();});
  win.webContents.on('render-process-gone', () => app.exit(1));
  await win.loadURL(`${PRIVILEGED_ORIGIN}/index.html`);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await win.webContents.executeJavaScript(`Boolean(
      document.querySelector('.metaviewer[data-wall-settled="true"]') &&
      document.querySelector('.mv-terminal') &&
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
  const wireReady=await win.webContents.executeJavaScript(`(async()=> {
    const api=window.metaviewer;
    return typeof api.authority?.subscribeFrames==='function'
      && typeof api.sideTerminal?.open==='function' && typeof api.sideTerminal?.setEnabled==='function'
      && await api.loadSettings()===null && await api.recordingDestination()===null
      && await api.nestedDepth()===null && await api.selfCapsuleId()===null
      && (await api.authority.propose('{}')).proposal_id==='smoke';
  })()`);
  if(!wireReady) throw new Error('Domain preload facade did not cross contextBridge');
  console.log('METAVIEWER_SMOKE_OK');
  clearTimeout(deadline);
  app.exit(0);
} catch (error) {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
}
}
