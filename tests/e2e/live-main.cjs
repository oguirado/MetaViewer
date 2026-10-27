// [TARGET, unit decision] CI Electron host for the real wall component.
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const manifestPath = process.env.MV_E2E_MANIFEST;
const buildDir = process.env.MV_E2E_BUILD;
if (!manifestPath || !existsSync(manifestPath)) {
  process.stderr.write('MV_E2E_MANIFEST missing or unreadable\n');
  process.exit(2);
}
if (!buildDir || !existsSync(join(buildDir, 'index.html'))) {
  process.stderr.write('MV_E2E_BUILD missing index.html\n');
  process.exit(2);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900,
    webPreferences: { preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      additionalArguments: ['--mv-e2e-fixture=' + JSON.stringify({
        capsules: JSON.parse(readFileSync(manifestPath, 'utf8')).capsules,
        crossRoute: process.env.MV_E2E_CROSS_ROUTE === '1',
        advancingFrames: process.env.MV_E2E_ADVANCING_FRAMES === '1',
        stalledTile: process.env.MV_E2E_STALLED_TILE ?? null,
      })] } });
  if (process.env.MV_E2E_TELEMETRY) installTelemetry(win, JSON.parse(process.env.MV_E2E_TELEMETRY));
  await win.loadFile(join(buildDir, 'index.html'));
});

// [TARGET, unit decision] Observe the existing frame tag and permanent body
// visibility. No synthetic frame ticks, DOM mutation, or inferred deliveries.
function installTelemetry(win, config) {
  const errors = [];
  win.webContents.on('console-message', event => {
    if (event.level === 'error' || event.level === 3) errors.push(String(event.message));
  });
  win.webContents.once('did-finish-load', async () => {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const sample = () => win.webContents.executeJavaScript(`(${() =>
      Array.from(document.querySelectorAll('[data-capsule-id]')).map(node => {
        const frameId = node.querySelector('[data-frame-tag]')?.getAttribute('data-frame-tag') ?? null;
        const match = /-gen(\d+)$/.exec(frameId ?? '');
        const body = node.querySelector('[data-frame-tag]');
        return { capsuleId: node.getAttribute('data-capsule-id'), frameId,
          visible: !!body?.checkVisibility(), hidden: body ? !body.checkVisibility() : null,
          generation: match ? Number(match[1]) : null };
      })})()`);
    let report = { schema: 'e2e-ac02-wall-report/v1', phase: 'wall',
      tiles: [], errors, soakMs: config.soakMs };
    try {
      const wanted = JSON.parse(readFileSync(process.env.MV_E2E_MANIFEST, 'utf8')).capsules;
      let initial;
      const deadline = performance.now() + 10000;
      do {
        initial = await sample();
        if (initial.length === wanted.length && initial.every(row => row.visible && row.frameId)) break;
        await pause(25);
      } while (performance.now() < deadline);
      if (initial.length !== wanted.length || initial.some(row => !row.visible || !row.frameId)
          || wanted.some(({ capsuleId }) => !initial.some(row => row.capsuleId === capsuleId))) {
        throw new Error('E2E_PREREQ: telemetry requires all manifest tiles with visible frames');
      }
      const counters = new Map(initial.map(row => [row.capsuleId,
        { first: row.generation, last: row.generation, tag: row.frameId, frames: 0 }]));
      const observe = rows => {
        if (rows.length !== counters.size || new Set(rows.map(row => row.capsuleId)).size !== counters.size) {
          throw new Error('E2E_ROUTING: telemetry tile set changed');
        }
        for (const row of rows) {
          const counter = counters.get(row.capsuleId);
          if (!counter || !Number.isSafeInteger(row.generation) || row.generation < counter.last
              || !row.frameId.startsWith('frame-' + row.capsuleId + '-gen')) {
            throw new Error('E2E_ROUTING: foreign or regressed frame on ' + row.capsuleId);
          }
          if (row.frameId !== counter.tag) counter.frames++;
          counter.last = row.generation;
          counter.tag = row.frameId;
        }
      };
      const start = performance.now();
      let rows;
      do {
        await pause(10);
        rows = await sample();
        observe(rows);
      } while (performance.now() - start < config.soakMs);
      const elapsed = performance.now() - start;
      report.soakMs = Math.round(elapsed);
      report.tiles = rows.map(row => {
        const counter = counters.get(row.capsuleId);
        return { capsuleId: row.capsuleId, visible: row.visible, hidden: row.hidden,
          frameId: row.frameId, fps: counter.frames * 1000 / elapsed,
          genBefore: counter.first, genAfter: counter.last };
      });
      // Capture the visible window before invoking the real kit fold control.
      // Preserve that evidence even if the fixture refuses the fold intent.
      const foldedId = initial[initial.length - 1].capsuleId;
      await win.webContents.executeJavaScript(`(() => {
        const anchor = 'capsule/' + ${JSON.stringify(foldedId)} + '/fold';
        const button = Array.from(document.querySelectorAll('[data-semantic-anchor]'))
          .find(node => node.getAttribute('data-semantic-anchor') === anchor);
        if (!button || button.disabled) throw new Error('E2E_PREREQ: fold control unavailable');
        button.click();
      })()`);
      await pause(100);
      const before = (await sample()).find(row => row.capsuleId === foldedId);
      if (!before?.hidden) throw new Error('E2E_FOLD: fold control did not hide the tile body');
      const foldStart = performance.now();
      do {
        await pause(10);
        rows = await sample();
        observe(rows);
        if (!rows.find(row => row.capsuleId === foldedId)?.hidden) {
          throw new Error('E2E_FOLD: tile became visible during folded sampling');
        }
      } while (performance.now() - foldStart < config.soakMs);
      const after = rows.find(row => row.capsuleId === foldedId);
      if (!after?.hidden) throw new Error('E2E_FOLD: tile did not remain folded');
      Object.assign(report.tiles.find(row => row.capsuleId === foldedId), {
        visible: after.visible, hidden: after.hidden, frameId: after.frameId,
        genBefore: before.generation, genAfter: after.generation,
      });
    } catch (error) {
      errors.push(String(error.stack || error));
    }
    writeFileSync(config.reportPath, JSON.stringify(report) + '\n');
    app.exit(errors.length ? 1 : 0);
  });
}
