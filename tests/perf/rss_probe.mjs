// [TARGET, unit decision] Real built shell, smoke core seams; no capsule fleet.
// Invoke through budget_gate.py under xvfb. Linux /proc is the RSS instrument.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { classifyRole, statFields } from './proc_fields.mjs';
import { performance } from 'node:perf_hooks';
import { createWindowOptions, attachWindowPolicy, registerPrivilegedScheme,
  resolveMainPaths, serveBundled, observeSender, CHANNELS, ELECTRON_PIN,
  PRIVILEGED_ORIGIN } from '../../ui/electron/main.js';
import { installAuthorityWire } from '../../ui/electron/authorityWire.js';

const { app, BrowserWindow, ipcMain, protocol, session } = createRequire(new URL('../../ui/package.json', import.meta.url))('electron');
const budgets = JSON.parse(readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'));
const excludes = JSON.parse(process.env.MV_RSS_EXCLUDES);
const identities = new Map();
const samples = [];
let win;
let wire;
const deadline = setTimeout(() => app.exit(2), 170000);
registerPrivilegedScheme(protocol);
void run();

function snapshot(at_ms) {
  const records = new Map();
  for (const name of readdirSync('/proc').filter(value => /^[0-9]+$/.test(value))) {
    try {
      const pid = Number(name);
      const fields = statFields(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      records.set(pid, { pid, parent: Number(fields[1]), starttime: fields[19], state: fields[0] });
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  function tree(root) {
    const result = new Set([root]);
    let changed;
    do {
      changed = false;
      for (const row of records.values()) {
        if (result.has(row.parent) && !result.has(row.pid)) { result.add(row.pid); changed = true; }
      }
    } while (changed);
    return result;
  }
  const included = tree(process.pid);
  for (const root of excludes) {
    if (!included.has(root) || root === process.pid) throw new Error('Capsule root outside recorded app tree');
    for (const pid of tree(root)) included.delete(pid);
  }
  const row = { at_ms, rss_main_bytes: 0, rss_renderer_bytes: 0, rss_utility_bytes: 0, rss_tree_bytes: 0, processes: [] };
  for (const pid of included) {
    const record = records.get(pid);
    if (!record || record.state === 'Z') continue;
    identities.set(`${pid}:${record.starttime}`, { pid, starttime: record.starttime });
    // Fail closed if an included live process cannot be sampled.
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
    if (!match) throw new Error(`VmRSS absent for ${pid}`);
    const rss_bytes = Number(match[1]) * 1024;
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const role = classifyRole(pid, process.pid, command);
    row.rss_tree_bytes += rss_bytes;
    if (role !== 'helper') row[`rss_${role}_bytes`] += rss_bytes;
    row.processes.push({ ...record, role, rss_bytes });
    const after = statFields(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (after[19] !== record.starttime) throw new Error('PID generation changed');
  }
  if (!row.rss_main_bytes || !row.rss_renderer_bytes) throw new Error('Required RSS role absent: ' + JSON.stringify(row));
  samples.push(row);
}

async function settled() {
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript(`Boolean(document.querySelector('.metaviewer[data-wall-settled="true"]') && document.querySelector('.mv-terminal'))`)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Shell did not settle');
}

async function run() {
  try {
    if (process.versions.electron !== ELECTRON_PIN) throw new Error('Electron pin mismatch');
    await app.whenReady();
    const shellRoot = fileURLToPath(new URL('../../ui/', import.meta.url));
    const paths = resolveMainPaths({ getAppPath: () => shellRoot, getPath: app.getPath.bind(app) }, shellRoot,
      { xdgRuntimeDir: process.env.MV_RSS_PROFILE, uid: process.getuid() });
    serveBundled(protocol, paths.rendererRoot, { styleNonce: true });
    win = new BrowserWindow(createWindowOptions({ ...budgets.viewport, preloadPath: paths.preloadPath }));
    attachWindowPolicy(win, session.defaultSession);
    ipcMain.handle(CHANNELS.load, (event, ...args) => {
      if (observeSender(event, win.webContents, PRIVILEGED_ORIGIN).verdict !== 'admit' || args.length) throw new Error('Layout load refused');
      return null;
    });
    ipcMain.handle(CHANNELS.save, () => { throw new Error('Read-only fixture'); });
    wire = installAuthorityWire({ ipcMain, contents: win.webContents,
      env: { XDG_CONFIG_HOME: process.env.MV_RSS_PROFILE }, argv: [],
      core: { request: async () => ({ schema: 'action_verdict/v0.2', proposal_id: 'rss-probe', decision: 'admitted', core_seq: 1 }) } });
    win.webContents.on('render-process-gone', () => app.exit(1));
    await win.loadURL(`${PRIVILEGED_ORIGIN}/index.html`);
    await settled();
    const workload = ['ready'];
    const start = performance.now();
    snapshot(0);
    for (let tick = 1; ; tick++) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, tick * budgets.sampleMs - (performance.now() - start))));
      if (tick === 1) { win.setSize(1100, 800); win.setSize(1280, 900); workload.push('resize'); }
      if (tick === 2) { await win.loadURL(`${PRIVILEGED_ORIGIN}/index.html`); await settled(); workload.push('reload'); }
      if (tick === 3) {
        const clicked = await win.webContents.executeJavaScript(`(() => { const button = document.querySelector('#shell-terminal'); if (!button) return false; button.click(); button.click(); return true; })()`);
        if (!clicked) throw new Error('Terminal toggle absent');
        workload.push('terminal-toggle');
      }
      snapshot(Math.floor(performance.now() - start));
      if (performance.now() - start >= budgets.gateDurationMs) break;
    }
    const duration_ms = Math.ceil(performance.now() - start);
    await wire.dispose();
    win.destroy();
    workload.push('shutdown');
    const receipt = { schema: 'metaviewer.perf.rss-receipt/v1', basis: '[MEASURED] Linux VmRSS; shared pages counted per process (upper bound)',
      limitation: 'Shell smoke seams; capsule fold/reconnect/context loss workload AUSENTE',
      duration_ms, workload, samples, identities: [...identities.values()], excluded_capsule_roots: excludes,
      conversion: { source: '/proc/PID/status VmRSS kB', bytes_per_kB: 1024 }, viewport: budgets.viewport };
    writeFileSync(process.env.MV_RSS_OUTPUT, JSON.stringify(receipt));
    console.log('MV_RSS_JSON ' + JSON.stringify(receipt));
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
}
