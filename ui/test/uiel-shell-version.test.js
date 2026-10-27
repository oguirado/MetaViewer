import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLoginShell, buildShellSpawn, runBroker, registerTerminalIpc,
  createTerminalFacade, TERMINAL_CHANNEL_PREFIX } from '../electron/ptyBroker.js';

// Mutation: replace resolveLoginShell's return value with LOGIN_SHELL_FALLBACK.
test('U06 resolves absolute SHELL and explicit override; invalid paths use pinned fallback', t => {
  const previous = process.env.SHELL;
  t.after(() => { if (previous === undefined) delete process.env.SHELL; else process.env.SHELL = previous; });
  for (const value of [undefined, '', 'relative/sh', '/bin/sh', '/bin/zsh', '/bin/bash']) {
    if (value === undefined) delete process.env.SHELL; else process.env.SHELL = value;
    assert.equal(resolveLoginShell(), value?.startsWith('/') ? value : '/bin/bash');
    assert.equal(resolveLoginShell('/opt/shell/bin/bash'), '/opt/shell/bin/bash');
  }
  for (const bad of [null, false, 17, '', 'bash', '/bin/sh\0', '/' + 'x'.repeat(4096)]) {
    assert.equal(resolveLoginShell(bad), '/bin/bash');
  }
});

// Mutation: remove the !isBash ARGS_SHELL guard (or the ARGS_FLAG guard).
test('U06 hermetic flags reach only bash; unknown flags and non-bash hermetic requests refuse', () => {
  for (const shell of ['/bin/bash', '/opt/bin/bash']) {
    assert.deepEqual(buildShellSpawn(['--noprofile', '--norc'], shell),
      { file: shell, args: ['--noprofile', '--norc', '-l', '-i'] });
  }
  assert.deepEqual(buildShellSpawn([], '/bin/sh'), { file: '/bin/sh', args: ['-l', '-i'] });
  for (const flag of ['--noprofile', '--norc']) {
    assert.throws(() => buildShellSpawn([flag], '/bin/sh'), { code: 'ARGS_SHELL' });
  }
  assert.throws(() => buildShellSpawn(['--command'], '/bin/bash'), { code: 'ARGS_FLAG' });
  assert.throws(() => buildShellSpawn(['--norc\0'], '/bin/bash'), { code: 'ARGS_ITEM' });
});

const profile = { command: 'provider', executable: '/bin/echo', argv: ['/bin/echo'], cwd: '/tmp',
  loginShell: '/bin/sh', env: { LANG: 'C', TERM: 'xterm' } };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Mutation: remove route's msg.version !== TERMINAL_WIRE_VERSION branch.
test('U07 child ingress refuses unsupported versions without spawning or tombstoning the session', async t => {
  let receive, spawns = 0;
  const sent = [], writes = [];
  const broker = runBroker({ profiles: new Map([['provider', profile]]),
    processes: { record() {}, async reapOwned() {} },
    transport: { send: value => sent.push(value), onMessage(fn) { receive = fn; return () => {}; } },
    pty: { spawn() { spawns++; return { pid: 123, onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }, kill() {}, write: value => writes.push(value),
      resize() {}, pause() {}, resume() {} }; } } });
  t.after(() => broker.dispose());
  const open = { op: 'open', id: 'session', provider: 'provider', command: 'provider', generation: 1 };
  for (const version of [0, 2, 999]) {
    receive({ ...open, version }); await tick();
    assert.equal(sent.at(-1).code, 'BAD_VERSION');
    assert.equal(spawns, 0);
  }
  receive({ ...open, version: 1 }); await tick();
  assert.equal(spawns, 1);
  assert.equal(sent.at(-1).ev, 'open');
  for (const version of [0, 2, 999]) {
    receive({ version, generation: 1, op: 'write', id: 'session', b64: 'YQ==' }); await tick();
    assert.equal(sent.at(-1).code, 'BAD_VERSION');
    assert.deepEqual(writes, []);
  }
  receive({ version: 1, generation: 1, op: 'write', id: 'session', b64: 'YQ==' }); await tick();
  assert.equal(writes.length, 1);
});

// Mutation: remove registerTerminalIpc's event.version guard.
// Adaptation: facade API is owner/value, not wire-versioned; it receives typed faults.
test('U07 host ingress publishes BAD_VERSION through the facade without closing a live session', async t => {
  let receive, listener;
  const handlers = new Map(), closed = [], ingested = [], sent = [], events = [];
  const host = registerTerminalIpc({
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    authenticate: () => ({ owner: 'owner' }),
    authority: { admit: () => ({ allowed: true, context: { session: 'session', epoch: 0 }, profile }) },
    providers: new Map([['provider', profile]]), publish: value => listener?.(value),
    transport: { send: value => sent.push(value), onMessage(fn) { receive = fn; return () => {}; } },
    plane: { open() {}, close: value => closed.push(value), ingest: value => ingested.push(value),
      attach: () => ({ firstSeq: null, lastSeq: null, bytes: new Uint8Array(), truncated: false }), acknowledge() {} },
  });
  const facade = createTerminalFacade({
    request: (method, value) => handlers.get(TERMINAL_CHANNEL_PREFIX + method)({}, value),
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
  });
  t.after(async () => { facade.dispose(); await host.dispose(); });
  facade.onExit(value => events.push(value));
  assert.equal((await facade.capabilities()).ok, true);
  assert.equal((await facade.open({ provider: 'provider', command: 'provider' })).ok, true);
  for (const version of [0, 2, 999]) {
    receive({ version, generation: 1, ev: 'exit', id: 'session', exitCode: 0 });
    assert.deepEqual(events.at(-1), { kind: 'fault', code: 'BAD_VERSION' });
    assert.deepEqual(closed, []); assert.deepEqual(ingested, []);
    assert.equal((await facade.attach({ session: 'session' })).ok, true);
  }
  receive({ version: 1, generation: 1, ev: 'exit', id: 'session', exitCode: 0 });
  assert.equal(closed.length, 1);
  assert.equal(events.at(-1).kind, 'exit');
  assert.equal((await facade.attach({ session: 'session' })).reason, 'SESSION_CLOSED');
});
