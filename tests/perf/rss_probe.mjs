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

const budgets = JSON.parse(readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'));
const excludes = JSON.parse(process.env.MV_RSS_EXCLUDES || '[]');
const identities = new Map();
const samples = [];
const consoleErrors = [];
export const SETTLE_SELECTORS = ['.metaviewer[data-wall-settled="true"]', '.mv-terminal'];
export const SETTLE_TIMEOUT_MS = 45000;
export const SETTLE_POLL_MS = 100;
const SETTLE_PROBE_SCRIPT = `(() => {
  const selectors = ${JSON.stringify(SETTLE_SELECTORS)};
  const missing = selectors.filter(selector => !document.querySelector(selector));
  return {
    settled: missing.length === 0,
    missing,
    readyState: typeof document?.readyState === 'string' ? document.readyState : 'unknown',
  };
})()`;
let app, BrowserWindow, ipcMain, protocol, session, win, wire, deadline;
if (process.versions.electron) {
  ({ app, BrowserWindow, ipcMain, protocol, session } = createRequire(new URL('../../ui/package.json', import.meta.url))('electron'));
  deadline = setTimeout(() => app.exit(2), 170000);
  registerPrivilegedScheme(protocol);
  void run();
}

export function snapshot(at_ms, io = {}) {
  const readDir = io.readdirSync || readdirSync;
  const readText = io.readFileSync || readFileSync;
  const rootPid = io.rootPid ?? process.pid;
  const excludedRoots = io.excludes ?? excludes;
  const seenIdentities = io.identities ?? identities;
  const recordedSamples = io.samples ?? samples;
  const records = new Map();
  for (const name of readDir('/proc').filter(value => /^[0-9]+$/.test(value))) {
    try {
      const pid = Number(name);
      const fields = statFields(readText(`/proc/${pid}/stat`, 'utf8'));
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
  const included = tree(rootPid);
  for (const root of excludedRoots) {
    if (!included.has(root) || root === rootPid) throw new Error('Capsule root outside recorded app tree');
    for (const pid of tree(root)) included.delete(pid);
  }
  const row = { at_ms, rss_main_bytes: 0, rss_renderer_bytes: 0, rss_utility_bytes: 0, rss_tree_bytes: 0, processes: [] };
  for (const pid of included) {
    const record = records.get(pid);
    if (!record || record.state === 'Z') continue;
    seenIdentities.set(`${pid}:${record.starttime}`, { pid, starttime: record.starttime });
    // Fail closed if an included live process cannot be sampled; a process that
    // disappears mid-sample (ENOENT/ESRCH) is omitted from this instant's row.
    let status, command, after;
    try {
      status = readText(`/proc/${pid}/status`, 'utf8');
      command = readText(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      after = statFields(readText(`/proc/${pid}/stat`, 'utf8'));
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
      throw error;
    }
    if (after[19] !== record.starttime) throw new Error('PID generation changed');
    const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
    if (!match) throw new Error(`VmRSS absent for ${pid}`);
    const rss_bytes = Number(match[1]) * 1024;
    const role = classifyRole(pid, rootPid, command);
    row.rss_tree_bytes += rss_bytes;
    if (role !== 'helper') row[`rss_${role}_bytes`] += rss_bytes;
    row.processes.push({ ...record, role, rss_bytes });
  }
  if (!row.rss_main_bytes || !row.rss_renderer_bytes) throw new Error('Required RSS role absent: ' + JSON.stringify(row));
  recordedSamples.push(row);
}

function normalizeSettleProbe(probe) {
  if (probe === true) {
    return { settled: true, missing: [], readyState: 'complete', consoleErrors: [] };
  }
  if (!probe || typeof probe !== 'object') {
    return { settled: false, missing: [...SETTLE_SELECTORS], readyState: 'unknown', consoleErrors: [] };
  }
  let missing;
  if (Array.isArray(probe.missing)) {
    missing = probe.missing.map(String);
  } else if ('wallSettled' in probe || 'terminal' in probe) {
    missing = [];
    if (!probe.wallSettled) missing.push(SETTLE_SELECTORS[0]);
    if (!probe.terminal) missing.push(SETTLE_SELECTORS[1]);
  } else {
    missing = probe.settled === true ? [] : [...SETTLE_SELECTORS];
  }
  const settledFlag = typeof probe.settled === 'boolean' ? probe.settled && missing.length === 0 : missing.length === 0;
  const readyState = typeof probe.readyState === 'string' && probe.readyState.length > 0 ? probe.readyState : 'unknown';
  const extraErrors = Array.isArray(probe.consoleErrors) ? probe.consoleErrors.map(String) : [];
  return { settled: settledFlag, missing, readyState, consoleErrors: extraErrors };
}

export async function settled(io = {}) {
  const opts = typeof io === 'function' ? { executeJavaScript: io } : io;
  const target = opts.webContents ?? win?.webContents;
  const exec = opts.executeJavaScript ?? (code => target.executeJavaScript(code));
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? SETTLE_POLL_MS;
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const seenErrors = [...(opts.consoleErrors ?? consoleErrors)];
  const onConsole = (event, level, message) => {
    const severity = event?.level ?? level;
    const text = event?.message ?? message;
    if (severity === 'error' || severity === 3) seenErrors.push(String(text));
  };
  const attachTempListener = target && target !== win?.webContents && typeof target.on === 'function';
  if (attachTempListener) target.on('console-message', onConsole);
  const startedAt = now();
  let last = { settled: false, missing: [...SETTLE_SELECTORS], readyState: 'unknown', consoleErrors: [] };
  try {
    for (;;) {
      try {
        last = normalizeSettleProbe(await exec(SETTLE_PROBE_SCRIPT));
        if (!attachTempListener && opts.consoleErrors === undefined && consoleErrors.length > seenErrors.length) {
          for (let i = seenErrors.length; i < consoleErrors.length; i++) seenErrors.push(consoleErrors[i]);
        }
        if (last.settled) return;
      } catch (error) {
        const msg = error?.message || String(error);
        if (!seenErrors.includes(msg)) seenErrors.push(msg);
      }
      const elapsed = now() - startedAt;
      if (elapsed >= timeoutMs) break;
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)));
    }
  } finally {
    if (attachTempListener && typeof target.removeListener === 'function') {
      target.removeListener('console-message', onConsole);
    }
  }
  const allErrors = [...seenErrors, ...last.consoleErrors];
  const missingText = last.missing.length ? last.missing.join(', ') : 'none';
  const errorsText = allErrors.length ? JSON.stringify(allErrors) : 'none';
  throw new Error(
    `Shell did not settle within ${timeoutMs}ms (missingSelectors=[${missingText}], readyState=${last.readyState}, consoleErrors=${errorsText})`
  );
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
    win.webContents.on('console-message', (event, level, message) => {
      const severity = event?.level ?? level;
      const text = event?.message ?? message;
      if (severity === 'error' || severity === 3) consoleErrors.push(String(text));
    });
    win.webContents.on('preload-error', (_event, _path, error) => {
      consoleErrors.push(String(error?.message || error));
    });
    win.webContents.on('render-process-gone', () => app.exit(1));
    await win.loadURL(`${PRIVILEGED_ORIGIN}/index.html`);
    await settled();
    const workload = ['ready'];
    let start = performance.now();
    snapshot(0);
    for (let tick = 1; ; tick++) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, tick * budgets.sampleMs - (performance.now() - start))));
      if (tick === 1) { win.setSize(1100, 800); win.setSize(1280, 900); workload.push('resize'); }
      if (tick === 2) {
        await win.loadURL(`${PRIVILEGED_ORIGIN}/index.html`);
        const settleStart = performance.now();
        await settled();
        start += performance.now() - settleStart;
        workload.push('reload');
      }
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
