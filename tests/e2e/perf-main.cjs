'use strict';
// Test-owned host, no preload or renderer authority; report goes to scratch.
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
// Electron preserves leading switches in argv on some platforms.
const [build, report, config] = process.argv.slice(-3);
const options = JSON.parse(config);
app.setPath('userData', join(report + '.profile'));
const deadline = setTimeout(() => app.exit(2), ((options.seconds || 10) + 30) * 1000);
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1280, height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false } });
    await win.loadFile(join(build, 'index.html'));
    const method = options.journey === 'launcher' ? 'runLauncherJourney' : 'runPerfSoak';
    const result = await win.webContents.executeJavaScript(`window.${method}(${JSON.stringify(options)})`);
    writeFileSync(report, JSON.stringify(result));
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(String(error));
    clearTimeout(deadline);
    app.exit(1);
  }
});
