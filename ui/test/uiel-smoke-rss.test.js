import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findForbiddenEnv } from '../electron/coreLauncher.js';

const execute = promisify(execFile);
const ui = fileURLToPath(new URL('../', import.meta.url));
const LIMIT_BYTES = 200 * 1000 * 1000; // [TARGET] AC-14 main-process RSS, decimal MB.
const LEAK_BYTES = 300 * 1000 * 1000; // [TARGET] retained and touched negative control.
const registration = component => ({ endpoint: { component, instance: component + '-test' }, hello: {
  schema: 'hello/v0.2', contract_version: 'v0.2', component, component_version: '0.1.1',
  component_commit: 'a'.repeat(40), dependencies: [],
} });
function enforceBudget(peak) {
  assert.ok(Number.isSafeInteger(peak) && peak > 0, 'RSS evidence is mandatory');
  assert.ok(peak <= LIMIT_BYTES, `main RSS ${peak} bytes exceeds ${LIMIT_BYTES} bytes`);
}

// Mutation: retain Buffer.alloc(LEAK_BYTES, 1) before mainDirectEntry's readiness marker.
test('U13 production main RSS stays within 200 MB; retaining 300 MB trips the same gate', { timeout: 120000 }, async t => {
  const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  const require = createRequire(import.meta.url);
  let electron;
  if (dist) {
    electron = join(dist, 'electron');
  } else {
    // Preflight the installed binary before importing the wrapper: its missing-binary
    // branch invokes the downloader, which this offline test must never reach.
    const packageDir = dirname(require.resolve('electron'));
    const executable = await readFile(join(packageDir, 'path.txt'), 'utf8');
    await access(join(packageDir, 'dist', executable));
    electron = require('electron');
  }
  await access(electron);
  const root = await mkdtemp(join(tmpdir(), 'ur-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  await mkdir(app);
  await cp(join(ui, 'electron'), join(app, 'electron'), { recursive: true });
  await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module', main: 'electron/main.js' }));
  // Build the actual renderer and preload into this test's private fixture.
  await execute(process.execPath, [join(ui, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', join(app, 'dist/renderer')],
    { cwd: ui, timeout: 60000, maxBuffer: 1024 * 1024 });
  const mainPath = join(app, 'electron/main.js'), original = await readFile(mainPath, 'utf8');
  const marker = "console.log('METAVIEWER_MAIN_READY');";
  assert.equal(original.split(marker).length, 2, 'production readiness marker must be unique');
  const config = { session_id: 'rss-test', core: registration('core'), peers: [registration('ui')] };

  async function measure(leak) {
    const runtime = await mkdtemp(join(root, 'run-')), profile = await mkdtemp(join(root, 'profile-'));
    await mkdir(join(runtime, 'metaviewer'), { mode: 0o700 });
    const configPath = join(runtime, 'config.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    // Instrument only a temporary copy: identify the main, never an xvfb wrapper or renderer.
    const source = original.replace(marker, (leak ? `globalThis.__uielRetainedLeak = Buffer.alloc(${LEAK_BYTES}, 1);\n` : '') + marker)
      + '\nconsole.log("UIEL_RSS_MAIN_PID=" + process.pid);\n';
    await writeFile(mainPath, source);
    const sockets = new Set();
    let hellos = 0;
    const server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      let buffer = '', seq = 0;
      socket.on('data', data => {
        buffer += data;
        let offset;
        while ((offset = buffer.indexOf('\n')) !== -1) {
          const request = JSON.parse(buffer.slice(0, offset)); buffer = buffer.slice(offset + 1);
          if (request.body.schema !== 'hello/v0.2') continue;
          assert.deepEqual(request.body, config.peers[0].hello); hellos++;
          socket.write(JSON.stringify({ schema: 'envelope/v0.2', msg_id: 'hello-' + (++seq), ts_ns: 0,
            from: config.core.endpoint, to: config.peers[0].endpoint, session_id: config.session_id,
            seq, nonce: 'nonce-' + seq, body: config.core.hello }) + '\n');
        }
      });
    });
    const path = join(runtime, 'metaviewer/core.sock');
    server.listen(path); await once(server, 'listening'); await chmod(path, 0o600);
    const env = { ...process.env, XDG_RUNTIME_DIR: runtime, MV_CORE_CONFIG: configPath };
    for (const key of findForbiddenEnv(env)) delete env[key];
    delete env.MV_CORE_BOOTSTRAP;
    const child = spawn(process.env.XVFB_RUN || 'xvfb-run', ['-a', electron, app, `--user-data-dir=${profile}`],
      { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', mainPid, ready = false, peak = 0, samples = 0, timedOut = false, grace;
    const stop = () => {
      if (child.pid && child.pid > 1 && child.pid !== process.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    const capture = bytes => {
      output = (output + bytes.toString()).slice(-32768);
      const pid = output.match(/UIEL_RSS_MAIN_PID=(\d+)/);
      if (pid) mainPid = Number(pid[1]);
      if (!ready && output.includes('METAVIEWER_MAIN_READY')) { ready = true; grace = setTimeout(stop, 600); }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    let reading = false, probeError;
    const probe = setInterval(async () => {
      if (!mainPid || reading) return;
      reading = true;
      try {
        const status = await readFile(`/proc/${mainPid}/status`, 'utf8');
        const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
        if (match) { peak = Math.max(peak, Number(match[1]) * 1024); samples++; }
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') probeError = error; }
      finally { reading = false; }
    }, 20);
    const deadline = setTimeout(() => { timedOut = true; stop(); }, 20000);
    try {
      await once(child, 'exit');
      assert.equal(timedOut, false, output);
      assert.equal(ready, true, output);
      assert.ok(mainPid > 1, output);
      assert.ok(samples > 0, 'main RSS must be sampled from /proc');
      assert.equal(probeError, undefined);
      assert.equal(hellos, 1, 'probe must boot the production socket host');
      return peak;
    } finally {
      clearInterval(probe); clearTimeout(deadline); clearTimeout(grace); stop();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
  const normal = await measure(false);
  enforceBudget(normal);
  const leaking = await measure(true);
  assert.ok(leaking > normal, 'touched retained allocation must increase observed main RSS');
  assert.throws(() => enforceBudget(leaking), /main RSS .* exceeds/);
  t.diagnostic(`main peak RSS: normal=${normal} bytes; retained-leak=${leaking} bytes [MEASURED]`);
});
