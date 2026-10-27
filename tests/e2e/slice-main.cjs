// [TARGET, unit decision] Sandboxed Electron canvas oracle; no host capability.
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await win.loadFile(join(process.env.MV_E2E_BUILD, 'slice.html'));
  const input = JSON.parse(readFileSync(process.env.MV_SLICE_FRAME, 'utf8'));
  const result = await win.webContents.executeJavaScript(`window.paintFrame(${JSON.stringify(input)})`);
  console.log('SLICE_RENDER:' + JSON.stringify(result));
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('E2E_RENDER: timeout'); app.exit(1); }, 15000).unref();
