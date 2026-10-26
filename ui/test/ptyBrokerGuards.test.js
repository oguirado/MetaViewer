import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTerminalIpc, runBroker, validateProviderEnv, validateSpawnEnv,
  MAX_ENV_VALUE_BYTES, MAX_WRITE_BYTES, TERMINAL_CHANNEL_PREFIX } from '../electron/ptyBroker.js';

const profile = { command: 'provider', executable: '/bin/echo', argv: ['/bin/echo'], cwd: '/tmp', loginShell: '/bin/sh', env: { LANG: 'C', TERM: 'xterm' } };
const admission = () => ({ allowed: true, context: { session: 'session', epoch: 0 }, profile });
const tick = () => new Promise(resolve => setImmediate(resolve));
function bridge({ admit = admission, probe = null } = {}) {
  const handlers = new Map(), sent = [], opened = [], closed = [], attached = [], acked = [];
  let receive;
  const instance = registerTerminalIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    authenticate: () => ({ owner: 'owner' }), authority: { admit },
    providers: new Map([['provider', profile]]), capabilitiesProvider: probe,
    transport: { send: message => sent.push(message), onMessage(fn) { receive = fn; return () => {}; } },
    plane: { open: ctx => opened.push(ctx), close: ctx => closed.push(ctx), ingest() {},
      attach(ctx) { attached.push(ctx); return { firstSeq: null, lastSeq: null, bytes: new Uint8Array(), truncated: false }; },
      acknowledge: ctx => acked.push(ctx) },
  });
  return { ...instance, sent, opened, closed, attached, acked,
    call: (method, value) => handlers.get(TERMINAL_CHANNEL_PREFIX + method)({}, method === 'capabilities' ? null : { owner: 'owner', value }),
    event: value => receive({ version: 1, generation: 1, ...value }) };
}
const open = f => f.call('open', { provider: 'provider', command: 'provider' });

test('ARG-ui_pty-1 refused open closes ledger and tombstones session; started errors stay live', async () => {
  const f = bridge();
  try {
    assert.equal((await open(f)).ok, true);
    f.event({ ev: 'error', id: 'session', code: 'SPAWN_FAILED' });
    assert.equal(f.closed.length, 1);
    assert.equal((await f.call('attach', { session: 'session' })).reason, 'SESSION_CLOSED');
    assert.equal((await open(f)).reason, 'SESSION_CLOSED');
  } finally { await f.dispose(); }
  const live = bridge();
  try {
    await open(live); live.event({ ev: 'open', id: 'session', pid: 123 });
    live.event({ ev: 'error', id: 'session', code: 'WRITE_FAILED' });
    assert.equal((await live.call('attach', { session: 'session' })).ok, true);
    assert.equal(live.closed.length, 0);
  } finally { await live.dispose(); }
});

test('ARG-ui_pty-2 late admission after dispose cannot open ledger or forward', async () => {
  let release;
  const f = bridge({ admit: () => new Promise(resolve => { release = resolve; }) });
  const pending = open(f); await f.dispose(); release(admission());
  assert.equal((await pending).reason, 'BRIDGE_DISPOSED');
  assert.deepEqual(f.opened, []); assert.deepEqual(f.sent, []);
});

test('ARG-ui_pty-2 all resumed session methods and capability probes refuse after dispose', async () => {
  for (const [method, value] of [['attach', {}], ['close', {}], ['write', { b64: 'YQ==' }], ['resize', { cols: 80, rows: 24 }], ['ack', { ack_seq: 0, ack_bytes: 0 }]]) {
    let release, delayed = false;
    const f = bridge({ admit: () => delayed ? new Promise(resolve => { release = resolve; }) : admission() });
    await open(f); delayed = true;
    const pending = f.call(method, { session: 'session', ...value });
    await f.dispose(); release(admission());
    assert.equal((await pending).reason, 'BRIDGE_DISPOSED', method);
    assert.equal(f.sent.length, 1); assert.deepEqual(f.attached, []); assert.deepEqual(f.acked, []);
  }
  let release;
  const f = bridge({ probe: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.call('capabilities'); await f.dispose(); release([]);
  assert.equal((await pending).reason, 'BRIDGE_DISPOSED');
});

test('ARG-ui_pty-3 admission must match every provider profile field; env key order is irrelevant', async () => {
  for (const patch of [{ command: 'shell', argv: [] }, { executable: '/bin/false', argv: ['/bin/false'] }, { argv: ['/bin/echo', 'extra'] }, { cwd: '/' }, { loginShell: '/bin/bash' }, { env: { LANG: 'other' } }]) {
    const f = bridge({ admit: () => ({ ...admission(), profile: { ...profile, ...patch } }) });
    try {
      assert.equal((await open(f)).reason, 'PROFILE_REFUSED');
      assert.deepEqual(f.sent, []); assert.deepEqual(f.opened, []);
    } finally { await f.dispose(); }
  }
  const f = bridge({ admit: () => ({ ...admission(), profile: { ...profile, env: { TERM: 'xterm', LANG: 'C' } } }) });
  try { assert.equal((await open(f)).ok, true); } finally { await f.dispose(); }
});

test('ARG-ui_pty-4 UTF-8 environment truncation respects byte cap without replacement', () => {
  for (const character of ['é', '€', '😀']) {
    const text = 'a'.repeat(MAX_ENV_VALUE_BYTES - 1) + character;
    const env = validateProviderEnv({ LANG: text }, ['LANG']);
    assert.ok(Buffer.byteLength(env.LANG) <= MAX_ENV_VALUE_BYTES);
    assert.equal(env.LANG, 'a'.repeat(MAX_ENV_VALUE_BYTES - 1));
    assert.deepEqual(validateSpawnEnv(env), env);
  }
  assert.equal(validateProviderEnv({ LANG: 'é'.repeat(MAX_ENV_VALUE_BYTES / 2) }, ['LANG']).LANG, 'é'.repeat(MAX_ENV_VALUE_BYTES / 2));
});

test('ARG-ui_pty-5 decoded write cap refuses before admission; exact cap succeeds', async () => {
  let calls = 0;
  const f = bridge({ admit: () => { calls++; return admission(); } });
  try {
    await open(f); const before = calls;
    assert.equal((await f.call('write', { session: 'session', b64: Buffer.alloc(MAX_WRITE_BYTES + 1).toString('base64') })).reason, 'WRITE_TOO_LARGE');
    assert.equal(calls, before); assert.equal(f.sent.length, 1);
    assert.equal((await f.call('write', { session: 'session', b64: Buffer.alloc(MAX_WRITE_BYTES).toString('base64') })).ok, true);
  } finally { await f.dispose(); }
});

function child({ throwing = false, cap = 10 } = {}) {
  let receive, data;
  const sent = [];
  const engine = runBroker({ profiles: new Map([['provider', profile]]), limits: { sessionByteCap: cap },
    processes: { record() {}, async reapOwned() {} },
    transport: { send: value => sent.push(value), onMessage(fn) { receive = fn; return () => {}; } },
    pty: { spawn() {
      if (throwing) throw new Error('spawn refused');
      return { pid: 123, onData(fn) { data = fn; return { dispose() {} }; }, onExit() { return { dispose() {} }; },
        kill() {}, write() {}, resize() {}, pause() {}, resume() {} };
    } } });
  return { ...engine, sent, data: value => data(value), send: message => receive({ version: 1, generation: 1, ...message }) };
}
test('ARG-ui_pty-1 child failed open cannot reuse session identity', async () => {
  const f = child({ throwing: true });
  try {
    f.send({ op: 'open', id: 'session', provider: 'provider', command: 'provider' }); await tick();
    assert.equal(f.sent.at(-1).code, 'SPAWN_FAILED');
    f.send({ op: 'write', id: 'session', b64: 'YQ==' }); await tick();
    assert.equal(f.sent.at(-1).code, 'SESSION_CLOSED');
  } finally { await f.dispose(); }
});
test('ARG-ui_pty-6 output never exceeds lifetime cap; under-cap output stays open', async () => {
  const f = child();
  try {
    f.send({ op: 'open', id: 'session', provider: 'provider', command: 'provider' }); await tick();
    f.data(Buffer.from('1234')); await tick();
    assert.equal(f.sent.some(m => m.ev === 'exit'), false);
    f.data(Buffer.from('567890ABC')); await tick();
    assert.equal(Buffer.concat(f.sent.filter(m => m.ev === 'data').map(m => Buffer.from(m.b64, 'base64'))).toString(), '1234567890');
    assert.equal(f.sent.at(-1).reason, 'SESSION_CAP');
  } finally { await f.dispose(); }
});
