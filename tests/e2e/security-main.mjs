// [TARGET, unit decision] Real Chromium enforcement using the product window,
// navigation policy, scheme handler and sandboxed preload. Assets are inert,
// test-owned local files; no external network request is attempted.
import { app, BrowserWindow, protocol, session } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attachWindowPolicy, CONTENT_SECURITY_POLICY, createWindowOptions,
  registerPrivilegedScheme, serveBundled } from '../../ui/electron/main.js';

const [reportPath, mode] = process.argv.slice(-2);
const root = dirname(reportPath), assets = join(root, 'assets-' + mode);
mkdirSync(assets);
app.setPath('userData', join(root, 'profile-' + mode));
registerPrivilegedScheme(protocol);
let stage = 'module';
const watchdog = setTimeout(() => { console.error('E2E_SECURITY_TIMEOUT: ' + stage); app.exit(2); }, 20000);
async function probe() {
try {
  const preload = join(root, 'preload.cjs');
  const source = readFileSync(new URL('../../ui/electron/preload.js', import.meta.url), 'utf8');
  if (/^import\s|^export\s+(?!const |class |function )/m.test(source)) throw Error('preload bundling contract changed');
  writeFileSync(preload, source.replace(/^export (?=const |class |function )/gm, ''));
  writeFileSync(join(assets, 'index.html'), `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"></head><body>
    <script>window.inlineExecuted=true;</script><script src="./probe.js"></script></body></html>`);
  writeFileSync(join(assets, 'popup.html'), '<!doctype html><title>test popup</title>');
  writeFileSync(join(assets, 'probe.js'), `window.securityReport=(async()=>{
    const report={node:typeof require,process:typeof process,inline:window.inlineExecuted===true,
      facade:Object.keys(window.metaviewer||{}).sort(),
      capture:Object.keys(window.metaviewer?.capture||{}).sort(),
      authority:Object.keys(window.metaviewer?.authority||{}).sort(),
      terminal:Object.keys(window.metaviewer?.sideTerminal||{}).sort(),
      frozen:Object.isFrozen(window.metaviewer),evalBlocked:false,fetchBlocked:false};
    try{eval('1+1')}catch(error){report.evalBlocked=error instanceof EvalError}
    try{await fetch('app://metaviewer/blocked.json')}catch{report.fetchBlocked=true}
    report.popupDenied=window.open('app://metaviewer/popup.html')===null;
    await new Promise(resolve=>setTimeout(resolve,100));
    return report;
  })();`);
  stage = 'waiting-ready';
  await app.whenReady();
  stage = 'ready';
  serveBundled(protocol, assets);
  const options = createWindowOptions({ width: 800, height: 600, preloadPath: preload });
  // Actual unsafe configuration is the negative control, confined to inert assets.
  const prefs = mode === 'unsafe' ? { ...options.webPreferences,
    nodeIntegration: true, sandbox: false } : options.webPreferences;
  const win = new BrowserWindow({ ...options, show: false, webPreferences: prefs });
  attachWindowPolicy(win, session.defaultSession);
  stage = 'loading';
  await win.loadURL('app://metaviewer/index.html');
  stage = 'probe';
  const report = await win.webContents.executeJavaScript('window.securityReport');
  report.preferences = Object.fromEntries(['sandbox', 'contextIsolation', 'nodeIntegration', 'webSecurity']
    .map(key => [key, win.webContents.getLastWebPreferences()[key]]));
  report.windows = BrowserWindow.getAllWindows().length;
  writeFileSync(reportPath, JSON.stringify(report));
  clearTimeout(watchdog);
  app.exit(0);
} catch (error) {
  console.error(String(error));
  clearTimeout(watchdog);
  app.exit(1);
}
}
void probe();
