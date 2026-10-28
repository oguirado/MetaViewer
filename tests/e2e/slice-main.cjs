// [TARGET, unit decision] Sandboxed Electron canvas oracle; no host capability.
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const consoleErrors = [];
function failSlice(reason) {
  const detail = consoleErrors.length ? ` (console: ${consoleErrors.join(' | ')})` : '';
  console.error(`SLICE_ERROR: ${reason}${detail}`);
  app.exit(1);
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 3) {
      consoleErrors.push(String(event.message).slice(0, 512));
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    failSlice(`renderer gone: ${JSON.stringify(details)}`);
  });
  await win.loadFile(join(process.env.MV_E2E_BUILD, 'slice.html'));
  const input = JSON.parse(readFileSync(process.env.MV_SLICE_FRAME, 'utf8'));
  const outcome = await win.webContents.executeJavaScript(`(async (input) => {
    try {
      const deadline = Date.now() + 10000;
      while (typeof window.paintFrame !== 'function') {
        if (Date.now() >= deadline) {
          return { ok: false, error: 'E2E_RENDER: window.paintFrame not registered after module load' };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { ok: true, result: await window.paintFrame(input) };
    } catch (err) {
      return { ok: false, error: String((err && err.stack) || err) };
    }
  })(${JSON.stringify(input)})`);
  if (!outcome || !outcome.ok) {
    failSlice(outcome && outcome.error ? outcome.error : 'E2E_RENDER: unknown renderer failure');
    return;
  }
  console.log('SLICE_RENDER:' + JSON.stringify(outcome.result));
  app.exit(0);
}).catch((error) => { failSlice(String((error && error.stack) || error)); });
setTimeout(() => { failSlice('E2E_RENDER: timeout'); }, 15000).unref();
