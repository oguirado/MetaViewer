// Built-renderer regression gate. Run with the local Electron binary after build.
const { app, BrowserWindow, protocol } = require('electron');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
const assert = require('node:assert/strict');
const path = require('node:path');
const deadline = setTimeout(() => app.exit(1), 60000);
const failures = [];
async function probe(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
void app.whenReady().then(async () => {
  const { serveBundled } = await import('../electron/main.js');
  serveBundled(protocol, path.join(__dirname, '../dist/renderer'), { styleNonce: true });
  const win = new BrowserWindow({ width: 1280, height: 720, useContentSize: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  async function load(query, selector) {
    await win.loadURL('app://metaviewer/index.html?' + new URLSearchParams(query));
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (await win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Renderer readiness timed out: ${selector}`);
  }
  const evaluate = fn => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  try {
    await load({ state: 'live-replay', step: 'terminal-pending' }, '[data-semantic-anchor="terminal/pending"]');
    await probe('MV-11 replay starts a pending session', async () => {
      const state = await evaluate(() => {
        const rows = document.querySelectorAll('[data-semantic-anchor="terminal/pending"]');
        const row = rows[0];
        return { count: rows.length, copy: row?.textContent.trim(), role: row?.getAttribute('role'),
          visible: !!row?.getBoundingClientRect().height,
          above: !!row && (() => { const r = row.getBoundingClientRect(); return row.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })() };
      });
      assert.deepEqual(state, { count: 1, copy: 'Starting session…', role: 'status', visible: true, above: true });
    });
    await probe('MV-11 overlay paints above intersecting wall tiles without reflow', async () => {
      const state = await evaluate(() => {
        const panel = document.querySelector('.cui-side-terminal__body');
        const rect = panel.getBoundingClientRect();
        const tiles = [...document.querySelectorAll('.mv-tile')];
        const tile = tiles.find(tile => {
          const r = tile.getBoundingClientRect();
          return r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
        });
        if (!tile) return { intersects: false };
        const r = tile.getBoundingClientRect();
        const x = (Math.max(rect.left, r.left) + Math.min(rect.right, r.right)) / 2;
        const y = (Math.max(rect.top, r.top) + Math.min(rect.bottom, r.bottom)) / 2;
        const top = document.elementFromPoint(x, y);
        const before = JSON.stringify(tiles.map(t => t.getBoundingClientRect().toJSON()));
        document.querySelector('[data-semantic-anchor="terminal/toggle"]').click();
        return new Promise(resolve => requestAnimationFrame(() => resolve({ intersects: true,
          above: !!top?.closest('.mv-terminal'),
          stable: before === JSON.stringify(tiles.map(t => t.getBoundingClientRect().toJSON())) })));
      });
      assert.deepEqual(state, { intersects: true, above: true, stable: true });
    });
    await load({ state: 'live-replay', step: 'terminal-attached' }, '.ms2-plate button');
    await probe('MV-10 absent metadata produces no visible unknown pills', async () => {
      const state = await evaluate(() => {
        const plate = document.querySelector('.ms2-plate');
        return { exists: !!plate, unknown: [...plate.querySelectorAll('.ms2-plate-chip-unknown')]
          .filter(n => n.getBoundingClientRect().width && n.getBoundingClientRect().height).length,
          copy: !!plate.querySelector('button') };
      });
      assert.deepEqual(state, { exists: true, unknown: 0, copy: true });
    });
    await load({ state: 'tile-states' }, '[data-tile-state="connecting"] .mv-surface__waiting');
    await probe('MV-9 connecting copy fits at 1280x720', async () => {
      const state = await evaluate(() => {
        const waiting = document.querySelector('[data-tile-state="connecting"] .mv-surface__waiting');
        const line = waiting?.lastElementChild;
        if (!line) return { exists: false };
        let fits = true;
        const r = line.getBoundingClientRect();
        for (let parent = line.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) fits &&= r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1;
        }
        return { exists: true, fits, copy: line.textContent.trim() };
      });
      assert.deepEqual(state, { exists: true, fits: true, copy: 'The surface will appear here when it is ready.' });
    });
  } finally { win.destroy(); clearTimeout(deadline); app.exit(failures.length ? 1 : 0); }
}).catch(error => { console.error(error); app.exit(1); });
