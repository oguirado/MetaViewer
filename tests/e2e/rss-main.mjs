// [TARGET, unit decision] Complete the perf instrument's host before it boots
// the full product renderer. Capture uses production sender/arity/reply checks;
// this read-only shell workload has no capture backend and refuses operations.
import { createRequire } from 'node:module';
import { installCaptureBridge } from '../../ui/electron/captureBridge.js';

const { app, ipcMain } = createRequire(new URL('../../ui/package.json', import.meta.url))('electron');
// The shared instrument calls app.exit after destroying its window. Successful
// e2e shutdown must let Chromium reap its helpers; immediate exit races the
// gate's live-PID check. Preserve immediate nonzero exits for probe failures.
const exit = app.exit.bind(app);
app.exit = (code = 0) => { if (code === 0) app.quit(); else exit(code); };
app.on('browser-window-created', (_, win) => {
  const bridge = installCaptureBridge({ ipcMain, contents: win.webContents,
    core: { async request() { throw new Error('RSS workload has no capture backend'); } } });
  win.once('closed', () => { void bridge.dispose(); });
});
await import('../perf/rss_probe.mjs');
