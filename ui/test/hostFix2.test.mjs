import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMainBindings } from '../electron/hostBindings.js';
import { createTerminalHost } from '../electron/terminalHost.js';

test('A3: stale unsubscribe preserves a newer frame subscription reusing the callback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-host-fix2-'));
  const sockets = new Set();
  const server = createServer();
  let host;
  t.after(async () => {
    await host?.core.dispose();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const registration = component => ({
    endpoint: { component, instance: `${component}-test` },
    hello: { schema: 'hello/v0.2', contract_version: 'v0.2', component,
      component_version: '0.1.2', component_commit: 'a'.repeat(40), dependencies: [] },
  });
  const config = { session_id: 'host-fix2', core: registration('core'), peers: [registration('ui')] };
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  const socketPath = join(root, 'metaviewer', 'core.sock');
  server.on('connection', socket => {
    sockets.add(socket);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.body.schema === 'hello/v0.2') {
          socket.write(JSON.stringify({ schema: 'envelope/v0.2', msg_id: 'hello-core',
            ts_ns: 1, from: config.core.endpoint, to: config.peers[0].endpoint,
            session_id: config.session_id, seq: 1, nonce: 'hello-nonce', body: config.core.hello }) + '\n');
        }
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);
  host = await createMainBindings({
    env: { XDG_RUNTIME_DIR: root, MV_CORE_CONFIG: configPath },
    createMessageChannel: () => ({ port1: new EventEmitter(), port2: {} }),
  });
  const frames = host.wire.frames;
  const callback = () => {};
  const old = frames.subscribe(callback);
  old();
  const current = frames.subscribe(callback);
  old();
  old();
  // The host admits only one subscriber; retaining it must keep this gate closed.
  assert.throws(() => frames.subscribe(() => {}));
  current();
  const replacement = frames.subscribe(() => {});
  current();
  assert.throws(() => frames.subscribe(callback));
  replacement();
  frames.subscribe(callback)();
});

test('T10: disabled port write refuses without consuming sequence or closing the session', async (t) => {
  const port1 = new EventEmitter();
  const replies = [];
  Object.assign(port1, { postMessage: value => replies.push(value), start() {}, close() {} });
  const writes = [];
  let killed = false;
  let exited = () => {};
  const host = createTerminalHost({
    env: process.env,
    createMessageChannel: () => ({ port1, port2: {} }),
    pty: { spawn: () => ({ pid: 41001, onData() {}, onExit(fn) { exited = fn; },
      write: value => writes.push(value), resize() {},
      kill() { killed = true; exited({ exitCode: 0 }); } }) },
  });
  t.after(() => host.dispose());
  await host.setEnabled(true);
  const { session } = await host.open({ command: 'shell', cols: 80, rows: 24 });
  await host.attach({ session });
  await host.setEnabled(false);
  const input = { session, seq: 1, bytes: new TextEncoder().encode('recover\n') };
  port1.emit('message', input);
  assert.deepEqual(replies, [{ session, error: 'TERMINAL_IO_REFUSED' }]);
  assert.deepEqual(writes, []);
  assert.equal(killed, false);
  await host.setEnabled(true);
  port1.emit('message', input);
  assert.deepEqual(writes.map(String), ['recover\n']);
  assert.equal(killed, false);
  assert.equal(await host.resize({ session, cols: 100, rows: 30 }), true);
});
