// [TARGET, unit decision] CI Electron host for the real wall component.
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900,
    webPreferences: { preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      additionalArguments: ['--mv-e2e-fixture=' + JSON.stringify({
        capsules: JSON.parse(readFileSync(process.env.MV_E2E_MANIFEST, 'utf8')).capsules,
        crossRoute: process.env.MV_E2E_CROSS_ROUTE === '1',
      })] } });
  await win.loadFile(join(process.env.MV_E2E_BUILD, 'index.html'));
});
