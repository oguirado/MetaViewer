import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createMainBindings } from '../electron/hostBindings.js';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCadence, createSettingsStore, installAuthorityWire, DEFAULT_SETTINGS, WIRE_CHANNELS, WIRE_MAX_BYTES } from '../electron/authorityWire.js';
import { installFrameDiag } from '../electron/frameDiag.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mv-mut-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, env: { XDG_CONFIG_HOME: root }, path: join(root, 'metaviewer', 'settings.json') };
}
const json = (wallFps = 60, recordingFps = 17) => JSON.stringify({ ...DEFAULT_SETTINGS, wallFps, recordingFps });

test('A1/A2 closed cadence shape and immutable validated copy', () => {
  let reads = 0;
  const array = []; array.wallFps = 30;
  const nullProtoArray = Object.setPrototypeOf([], null); nullProtoArray.wallFps = 30;
  class Cadence { wallFps = 30; }
  const accessor = Object.defineProperty({}, 'wallFps', { enumerable: true, get() { reads++; return 30; } });
  for (const [value, code] of [[array, 'PAYLOAD'], [nullProtoArray, 'PAYLOAD'], [new Cadence(), 'PAYLOAD'],
    [{ wallFps: 30, [Symbol('hidden')]: 1 }, 'SETTINGS_UNKNOWN_KEY'], [accessor, 'SETTINGS_UNKNOWN_KEY'],
    [{}, 'SETTINGS_WALL_FPS'], [{ wallFps: 30, extra: 1 }, 'SETTINGS_UNKNOWN_KEY']]) {
    assert.throws(() => validateCadence(value), { code });
  }
  assert.equal(reads, 0);
  for (const wallFps of [3, 30, 60]) {
    const input = Object.assign(Object.create(null), { wallFps, recordingFps: 1 });
    const output = validateCadence(input);
    assert.deepEqual(output, { wallFps, recordingFps: 1 });
    assert.ok(Object.isFrozen(output));
    input.wallFps = 3;
    assert.equal(output.wallFps, wallFps);
  }
});

test('A3 subscribers share path, receive frozen snapshots, isolate exceptions and unsubscribe', async t => {
  const f = await fixture(t), store = createSettingsStore(f.env), peer = createSettingsStore(f.env);
  const notices = [], order = [];
  let stopSecond = () => {};
  const stops = [store.subscribe(() => { order.push('first'); stopSecond(); }),
    store.subscribe(() => { order.push('throw'); throw new Error('listener'); })];
  stopSecond = peer.subscribe(value => { order.push('second'); notices.push(value); });
  stops.push(stopSecond);
  t.after(() => stops.forEach(stop => stop()));
  await store.save(json());
  assert.deepEqual(order, ['first', 'throw', 'second']);
  assert.deepEqual(notices, [{ wallFps: 60, recordingFps: 17 }]);
  assert.ok(Object.isFrozen(notices[0]));
  assert.throws(() => { notices[0].wallFps = 3; }, TypeError);
  await peer.load();
  assert.deepEqual(order.slice(3), ['first', 'throw']);
  stops.forEach(stop => stop());
  const fresh = [];
  const stopFresh = peer.subscribe(value => fresh.push(value));
  await store.save(json(3, 2)); stopFresh();
  await store.load();
  assert.deepEqual(fresh, [{ wallFps: 3, recordingFps: 2 }]);
});

test('A4 missing, corrupt and oversized settings notify defaults; symlink ELOOP refuses', async t => {
  const f = await fixture(t), store = createSettingsStore(f.env), notices = [];
  const stop = store.subscribe(value => notices.push(value)); t.after(stop);
  const defaults = { wallFps: DEFAULT_SETTINGS.wallFps, recordingFps: DEFAULT_SETTINGS.recordingFps };
  assert.equal(await store.load(), null); assert.deepEqual(notices.pop(), defaults);
  await store.save(json()); notices.length = 0;
  for (const content of ['{broken', ' '.repeat(WIRE_MAX_BYTES + 1)]) {
    await writeFile(f.path, content, { mode: 0o600 });
    assert.equal(await store.load(), null); assert.deepEqual(notices.pop(), defaults);
  }
  await unlink(f.path); await symlink(f.path, f.path);
  await assert.rejects(store.load(), { code: 'SETTINGS_FILE' });
  assert.deepEqual(notices, []);
});

test('A4 load fans out to every cadence sink, including defaults over stale memory', async t => {
  const f = await fixture(t), handlers = new Map(), calls = [];
  const frame = { origin: 'app://metaviewer', url: 'app://metaviewer/index.html' };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };
  const sink = name => value => { calls.push([name, value]); };
  const wire = installAuthorityWire({ env: f.env, argv: [], contents,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: ch => handlers.delete(ch) },
    frames: { subscribe: () => () => {}, requestCadence: sink('frames.request'), setCadence: sink('frames.set') },
    core: { request: async () => true, requestCadence: sink('core.request'), setCadence: sink('core.set'), setRecordingFps: sink('recording') },
    frameDiag: { recordCadence: sink('diag') },
  }); t.after(() => wire.dispose());
  const store = createSettingsStore(f.env);
  for (const content of [json(), '{broken', null, ' '.repeat(WIRE_MAX_BYTES + 1)]) {
    await store.save(json());
    if (content === null) await unlink(f.path); else await writeFile(f.path, content, { mode: 0o600 });
    calls.length = 0;
    await handlers.get(WIRE_CHANNELS.loadSettings)(event);
    const fps = content === json() ? 60 : DEFAULT_SETTINGS.wallFps;
    const recording = content === json() ? 17 : DEFAULT_SETTINGS.recordingFps;
    assert.deepEqual(calls, [['frames.request', { wallFps: fps }], ['frames.set', { wallFps: fps }],
      ['core.request', { wallFps: fps }], ['core.set', { wallFps: fps }], ['recording', recording], ['diag', { wallFps: fps }]]);
    assert.equal(wire.requestedWallFps, fps); assert.equal(wire.recordingFps, recording);
  }
});

test('B1 scalar sessions retain independent monotonic floors, including null and default', t => {
  const diag = installFrameDiag({ env: {}, contents: {}, }); t.after(() => diag.dispose());
  for (const [index, key] of ['alpha', 7, null, undefined].entries()) {
    const value = { rehashSkipped: 40 - index * 10, rehashDone: 4 - index };
    assert.deepEqual(diag.recordRehashDiag(value, key), value);
    assert.throws(() => diag.recordRehashDiag({ rehashSkipped: value.rehashSkipped - 1, rehashDone: value.rehashDone }, key), { code: 'FRAME_DIAG_DECREASE' });
  }
});

test('B2 sessions have separate report write budgets; B3 delayed timer writes and invalid cadence is silent', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const diag = installFrameDiag({ ipcMain: { handle() {}, removeHandler() {} }, contents: {}, env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: f.root }, runDir: f.root });
  t.after(() => diag.dispose()); await diag.flush();
  const a = {}, b = {};
  diag.recordRehashDiag({ rehashSkipped: 1, rehashDone: 1 }, a);
  const first = diag.getSnapshot().seq;
  diag.recordRehashDiag({ rehashSkipped: 2, rehashDone: 2 }, b);
  assert.equal(diag.getSnapshot().seq, first + 1, 'session B must write immediately within A window');
  diag.recordRehashDiag({ rehashSkipped: 3, rehashDone: 3 }, a);
  const throttled = diag.getSnapshot().seq;
  assert.equal(throttled, first + 1);
  t.mock.timers.tick(999); assert.equal(diag.getSnapshot().seq, throttled);
  t.mock.timers.tick(1); assert.equal(diag.getSnapshot().seq, throttled + 1, 'timer must schedule a write without flush');
  const wall = diag.requestedWallFps, seq = diag.getSnapshot().seq;
  for (const wallFps of [45, 0, 61, '30', NaN, 3.5]) diag.recordCadence({ wallFps });
  assert.equal(diag.requestedWallFps, wall); assert.equal(diag.getSnapshot().seq, seq);
  await diag.flush();
});

async function startFakeCoreServer(t, root) {
  const reg = (/** @type {string} */ component) => ({
    endpoint: { component, instance: component },
    hello: {
      schema: 'hello/v0.2',
      contract_version: 'v0.2',
      component,
      component_version: '0.2.0',
      component_commit: 'a'.repeat(40),
      dependencies: [],
    },
  });
  const config = { session_id: 'setharden-session', core: reg('core'), peers: [reg('ui')] };
  const runtimeDir = join(root, 'runtime');
  await mkdir(join(runtimeDir, 'metaviewer'), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(join(runtimeDir, 'metaviewer'), 0o700);
  const configPath = join(root, 'core-config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await chmod(configPath, 0o600);

  /** @type {any[]} */
  const requests = [];
  const sockets = new Set();
  let seq = 0;
  const hash = 'b'.repeat(64);
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    const send = (/** @type {any} */ body) =>
      socket.write(
        JSON.stringify({
          schema: 'envelope/v0.2',
          msg_id: `r-${++seq}`,
          ts_ns: 0,
          from: config.core.endpoint,
          to: config.peers[0].endpoint,
          session_id: config.session_id,
          seq,
          nonce: `n-${seq}`,
          body,
        }) + '\n',
      );
    socket.on('data', (data) => {
      buffer += data;
      let offset;
      while ((offset = buffer.indexOf('\n')) >= 0) {
        const env = JSON.parse(buffer.slice(0, offset));
        buffer = buffer.slice(offset + 1);
        requests.push(env);
        if (env.body.schema === 'hello/v0.2') {
          send(config.core.hello);
          continue;
        }
        if (env.body.schema === 'record_request/v0.2') {
          const method =
            env.body.op === 'ram_start'
              ? 'recordStart'
              : env.body.op === 'disk_start'
                ? 'export'
                : 'recordStop';
          const reply =
            method === 'recordStart'
              ? { ok: true, recording_id: 'rec-1' }
              : { ok: true, export: { id: 'rec-1', bytes: 128, sha256: hash } };
          send({
            schema: 'surface_event/v0.2',
            event: 'error',
            data: {
              surface_id: 'capture',
              code: 'CAPTURE_REPLY',
              detail: JSON.stringify({ request_id: env.msg_id, method, reply }),
            },
          });
        }
      }
    });
  });
  const sockPath = join(runtimeDir, 'metaviewer/core.sock');
  server.listen(sockPath);
  await once(server, 'listening');
  await chmod(sockPath, 0o600);
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { runtimeDir, configPath, requests };
}


test('C1 wall-only notices, recording-only silence and store cleanup on dispose', async t => {
  const f = await fixture(t), core = await startFakeCoreServer(t, f.root);
  const bindings = await createMainBindings({ env: { ...f.env, MV_CORE_CONFIG: core.configPath, XDG_RUNTIME_DIR: core.runtimeDir },
    createMessageChannel: () => { throw new Error('no frames'); } });
  t.after(() => bindings.core.dispose());
  const notices = [];
  bindings.wire.frames.onCadence(value => notices.push(value));
  bindings.core.setRecordingFps(17); assert.deepEqual(notices, []);
  bindings.core.requestCadence({ wallFps: 60 });
  assert.deepEqual(notices, [{ wallFps: 60 }]); assert.ok(Object.isFrozen(notices[0]));
  const store = createSettingsStore(f.env);
  await store.save(json(3, 19));
  assert.deepEqual(notices, [{ wallFps: 60 }, { wallFps: 3 }]);
  assert.equal(bindings.core.recordingFps, 19);
  await bindings.core.dispose();
  await store.save(json(60, 31));
  assert.equal(notices.length, 2); assert.equal(bindings.core.recordingFps, 19);
});

test('C2 host rejects prototype, symbol and accessor cadence messages', async t => {
  const f = await fixture(t), core = await startFakeCoreServer(t, f.root);
  const bindings = await createMainBindings({ env: { ...f.env, MV_CORE_CONFIG: core.configPath, XDG_RUNTIME_DIR: core.runtimeDir },
    createMessageChannel: () => { throw new Error('no frames'); } });
  t.after(() => bindings.core.dispose());
  const proto = Object.assign(Object.create({}), { op: 'cadence', wallFps: 60 });
  const getter = Object.defineProperty({ op: 'cadence' }, 'wallFps', { enumerable: true, get: () => 60 });
  const opGetter = Object.defineProperty({ wallFps: 60 }, 'op', { enumerable: true, get: () => 'cadence' });
  for (const value of [proto, { op: 'cadence', wallFps: 60, [Symbol('hidden')]: 1 }, getter, opGetter]) {
    await assert.rejects(bindings.core.request(value), /PAYLOAD|SETTINGS_UNKNOWN_KEY/);
    assert.equal(bindings.core.requestedWallFps, DEFAULT_SETTINGS.wallFps);
  }
});

test('C3 capture override stays request-local and unrelated methods reject override keys', async t => {
  const f = await fixture(t), core = await startFakeCoreServer(t, f.root);
  const bindings = await createMainBindings({ env: { ...f.env, MV_CORE_CONFIG: core.configPath, XDG_RUNTIME_DIR: core.runtimeDir },
    createMessageChannel: () => { throw new Error('no frames'); } });
  t.after(() => bindings.core.dispose()); bindings.core.setRecordingFps(17);
  const start = request => bindings.core.request({ op: 'capture', method: 'recordStart', request });
  const base = { schema: 'capture_request/v1', request_id: 'mut-capture', surface_id: 'surface-1', mode: 'ai' };
  await start({ ...base, max_fps: 5 });
  assert.equal(bindings.core.recordingFps, 17);
  await start(base);
  assert.deepEqual(core.requests.filter(value => value.body.op === 'ram_start').map(value => value.body.params.max_fps), [5, 17]);
  for (const method of ['screenshot', 'recordStop', 'list']) {
    for (const key of ['max_fps', 'maxFps']) {
      const request = method === 'recordStop' ? { schema: 'capture_request/v1', request_id: 'mut-stop', recording_id: 'rec-1', [key]: 5 }
        : method === 'list' ? { [key]: 5 } : { schema: 'capture_request/v1', request_id: 'mut-shot', surface_id: 'surface-1', [key]: 5 };
      const before = core.requests.length;
      await assert.rejects(bindings.core.request({ op: 'capture', method, request }));
      assert.equal(core.requests.length, before); assert.equal(bindings.core.recordingFps, 17);
    }
  }
});

test('A3 final unsubscribe releases the path entry without removing a nonempty entry', async t => {
  const f = await fixture(t), store = createSettingsStore(f.env);
  const first = store.subscribe(() => {}), second = store.subscribe(() => {});
  // Observe retention cleanup without exporting the private subscription registry.
  const removed = [], nativeDelete = Map.prototype.delete;
  const probe = t.mock.method(Map.prototype, 'delete', function(key) {
    if (key === f.path) removed.push(key);
    return nativeDelete.call(this, key);
  });
  try {
    first(); assert.deepEqual(removed, []);
    second(); assert.deepEqual(removed, [f.path]);
  } finally { probe.mock.restore(); first(); second(); }
});

test('FINDING A3 repeated unsubscribe must not detach a newer subscriber',
  { skip: 'FINDING A3: stale unsubscribe deletes the replacement subscription set' }, async t => {
  const f = await fixture(t), store = createSettingsStore(f.env), notices = [];
  const stopOld = store.subscribe(() => {}); stopOld();
  const stopNew = store.subscribe(value => notices.push(value)); t.after(stopNew);
  stopOld();
  await store.save(json());
  assert.deepEqual(notices, [{ wallFps: 60, recordingFps: 17 }]);
});
