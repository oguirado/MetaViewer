/** Local Electron app:// + CSP visual/interaction gate. Renderer root and
 * output directory are explicit arguments; no network or production writes. */
import { app, BrowserWindow, protocol, session, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createWindowOptions, attachWindowPolicy, registerPrivilegedScheme, resolveMainPaths,
  serveBundled, CHANNELS, PRIVILEGED_ORIGIN } from '../electron/main.js';
const ui = fileURLToPath(new URL('../', import.meta.url));
const [renderer, output, mode = 'empty'] = process.argv.slice(2);
registerPrivilegedScheme(protocol);
const deadline = setTimeout(() => app.exit(1), 25000);
void run();
async function run() {
  try {
    await app.whenReady();
    const paths = resolveMainPaths({ getAppPath: () => ui, getPath: app.getPath.bind(app) }, ui,
      { xdgRuntimeDir: process.env.XDG_RUNTIME_DIR, uid: process.getuid() });
    serveBundled(protocol, renderer, { styleNonce: true });
    ipcMain.handle(CHANNELS.load, () => null);
    ipcMain.handle(CHANNELS.save, () => true);
    const win = new BrowserWindow(createWindowOptions({ width: 1280, height: 720, preloadPath: paths.preloadPath }));
    attachWindowPolicy(win, session.defaultSession);
    const violations = [];
    win.webContents.on('console-message', event => {
      if (/Refused to|Content Security Policy/.test(event.message)) violations.push(event.message);
    });
    await win.loadURL(`${PRIVILEGED_ORIGIN}/${mode === 'fixture' ? 'test/shellFixture.html' : 'index.html'}`);
    const evaluate = source => win.webContents.executeJavaScript(source);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`!!document.querySelector('[data-wall-settled="true"]')`)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!await evaluate(`!!document.querySelector('[data-wall-settled="true"]')`)) throw new Error('Wall did not settle');
    async function capture(name) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const text = await evaluate('document.body.innerText');
      if (/Missing|retired|unavailable|Reset the workspace layout/i.test(text)) throw new Error(`Forbidden page text: ${text}`);
      if (violations.length) throw new Error(`CSP violation: ${violations.join('\n')}`);
      await writeFile(join(output, name), (await win.webContents.capturePage()).toPNG());
      console.log(`CAPTURE_OK ${join(output, name)}`);
    }
    if (mode === 'fixture') {
      const titles = await evaluate(`Array.from(document.querySelectorAll('.mv-surface-tab')).map(e=>e.textContent)`);
      if (!titles.includes('Research browser') || !titles.includes('Project editor')) throw new Error(`Fixture titles absent: ${titles}`);
    }
    await capture(`${mode === 'fixture' ? 'surfaces' : 'empty'}.png`);
    await evaluate(`document.getElementById('shell-theme').click()`);
    if (await evaluate(`document.documentElement.dataset.themeScheme`) !== 'mv-dark') throw new Error('Theme toggle failed');
    await capture(`${mode}-dark.png`);
    await evaluate(`document.getElementById('shell/topbar/new').click()`);
    await new Promise(resolve => setTimeout(resolve, 900));
    if (!await evaluate(`!!document.getElementById('shell/new-capsule/dialog')`)) throw new Error('Launcher did not open');
    console.log(await evaluate(`JSON.stringify([...document.querySelectorAll('.p-dialog,.p-dialog-mask')].map(e=>({c:e.className,opacity:getComputedStyle(e).opacity,bg:getComputedStyle(e).backgroundColor,z:getComputedStyle(e).zIndex})))`));
    await capture(`${mode}-launcher.png`);
    win.reload();
    await new Promise(resolve => setTimeout(resolve, 600));
    if (await evaluate(`document.documentElement.dataset.themeScheme`) !== 'mv-dark') throw new Error('Theme preference did not restore');
    console.log('SHELL_INTERACTION_OK');
    clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
}
