// Never import the Electron npm wrapper until a local override is supplied:
// its missing-binary branch can download Electron.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) throw new Error('Set ELECTRON_OVERRIDE_DIST_PATH to a local Electron dist');
await access(new URL('../dist/index.html', import.meta.url));
await access(new URL('../dist/preload/preload.cjs', import.meta.url));
await access(join(process.env.ELECTRON_OVERRIDE_DIST_PATH, 'electron'));
const electron = createRequire(import.meta.url)('electron');
const profile = await mkdtemp(join(tmpdir(), 'metaviewer-smoke-'));
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn('xvfb-run', ['-a', electron,
    fileURLToPath(new URL('../electron/smoke.js', import.meta.url)), `--user-data-dir=${profile}`],
    { env, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  let marker = false;
  let stdout = '';
  child.stdout.on('data', bytes => {
    const text = bytes.toString();
    process.stdout.write(text);
    stdout = (stdout + text).slice(-4096);
    marker ||= stdout.includes('METAVIEWER_SMOKE_OK');
  });
  const deadline = setTimeout(() => {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  }, 19000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(signal ? 1 : code));
    });
    if (code !== 0 || !marker) throw new Error(`Electron smoke failed: rc=${code}, ready=${marker}`);
  } finally { clearTimeout(deadline); }
} finally { await rm(profile, { recursive: true, force: true }); }
