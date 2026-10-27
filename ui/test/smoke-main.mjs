// [TARGET, unit decision] Production readiness means the shipped entry loaded
// its admitted bundle with the default socket bindings. The fake core uses the
// same hello/envelope fixture as hostBindings.test.js; it grants no actions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findForbiddenEnv } from '../electron/coreLauncher.js';

const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
if (!dist) throw new Error('Set ELECTRON_OVERRIDE_DIST_PATH to a local Electron dist');
const electron = join(dist, 'electron');
await access(electron);
await access(new URL('../dist/renderer/index.html', import.meta.url));
await access(new URL('../dist/preload/preload.cjs', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.main, 'electron/main.js');
const root = await mkdtemp(join(tmpdir(), 'mv-main-smoke-'));
const registration = component => ({ endpoint: { component, instance: component + '-test' }, hello: {
  schema: 'hello/v0.2', contract_version: 'v0.2', component, component_version: '0.1.1',
  component_commit: 'a'.repeat(40), dependencies: [],
} });
const config = { session_id: 'host-test', core: registration('core'), peers: [registration('ui')] };
const sockets = new Set();
let hellos = 0;
const server = createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  let buffer = '', seq = 0;
  socket.on('data', data => {
    buffer += data;
    let offset;
    while ((offset = buffer.indexOf('\n')) >= 0) {
      const envelope = JSON.parse(buffer.slice(0, offset));
      buffer = buffer.slice(offset + 1);
      if (envelope.body.schema !== 'hello/v0.2') continue;
      assert.deepEqual(envelope.body, config.peers[0].hello);
      hellos++;
      // Exercise a genuinely asynchronous host bootstrap, after Electron ready.
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(JSON.stringify({ schema: 'envelope/v0.2', msg_id: 'reply-' + (++seq),
          ts_ns: 0, from: config.core.endpoint, to: config.peers[0].endpoint,
          session_id: config.session_id, seq, nonce: 'nonce-' + seq, body: config.core.hello }) + '\n');
      }, 100);
    }
  });
});

async function launch(flags, refusal) {
  const profile = await mkdtemp(join(root, 'profile-'));
  const env = { ...process.env, XDG_RUNTIME_DIR: root, MV_CORE_CONFIG: join(root, 'config.json') };
  for (const name of findForbiddenEnv(env)) delete env[name];
  delete env.MV_CORE_BOOTSTRAP;
  const child = spawn('xvfb-run', ['-a', electron,
    // Launch the shipped package entry so app.getAppPath() is the bundle root.
    fileURLToPath(new URL('..', import.meta.url)), `--user-data-dir=${profile}`, ...flags],
  { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', ready = false, stopped = false, timedOut = false, grace;
  const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
  const capture = bytes => {
    process.stdout.write(bytes);
    output = (output + bytes.toString()).slice(-16384);
    if (!refusal && !ready && output.includes('METAVIEWER_MAIN_READY')) {
      ready = true;
      grace = setTimeout(() => { stopped = true; stop(); }, 300);
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const deadline = setTimeout(() => { timedOut = true; stop(); }, 19000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(timedOut, false, 'production entry timed out');
    if (refusal) {
      assert.ok(code !== null && code !== 0 && signal === null, 'retail refusal must exit unsuccessfully');
      assert.match(output, /RETAIL_FLAG/);
      assert.ok(!output.includes('METAVIEWER_MAIN_READY'));
    } else {
      assert.ok(ready && stopped, `production entry exited before readiness: rc=${code}, signal=${signal}\n${output}`);
    }
  } finally { clearTimeout(deadline); clearTimeout(grace); stop(); }
}

try {
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await writeFile(join(root, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  server.listen(join(root, 'metaviewer/core.sock'));
  await once(server, 'listening');
  await chmod(join(root, 'metaviewer/core.sock'), 0o600);
  await launch([], false);
  assert.equal(hellos, 1, 'default host bindings must connect once');
  await launch(['--remote-debugging-port=9222'], true);
  assert.equal(hellos, 1, 'retail refusal must precede host bootstrap');
  console.log('METAVIEWER_MAIN_SMOKE_OK');
} finally {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
