// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSettingsStore,
  installAuthorityWire,
  validateCadence,
  WIRE_CHANNELS,
} from '../electron/authorityWire.js';
import {
  FRAME_DIAG_CHANNEL,
  FRAME_DIAG_FILE,
  FRAME_DIAG_PRELOAD_SCHEMA,
  FRAME_REPORT_DIAG_CHANNEL,
  installFrameDiag,
} from '../electron/frameDiag.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';

/**
 * Start a minimal fake core unix socket server for hostBindings tests.
 * @param {import('node:test').TestContext} t
 * @param {string} root
 */
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

test('F1: wire onCadence validates closed {wallFps, recordingFps} integers and refuses unrepresentable wallFps or unknown keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-setharden-f1-'));
  await chmod(root, 0o700);
  const diagDir = join(root, 'diag');
  await mkdir(diagDir, { mode: 0o700 });
  await chmod(diagDir, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {any} */ fn) => handlers.set(ch, fn),
    removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };

  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: diagDir },
    runDir: diagDir,
  });
  t.after(() => diag.dispose());

  /** @type {((c: any) => void) | null} */
  let cadenceSubscriber = null;
  /** @type {number[]} */
  const coreRecFps = [];
  const wire = installAuthorityWire({
    ipcMain,
    contents,
    env: { XDG_CONFIG_HOME: root },
    argv: ['--nested-depth=0'],
    core: {
      request: async () => true,
      setRecordingFps: (/** @type {number} */ fps) => coreRecFps.push(fps),
    },
    frames: {
      subscribe: () => () => {},
      onCadence: (/** @type {(c: any) => void} */ cb) => {
        cadenceSubscriber = cb;
        return () => {
          cadenceSubscriber = null;
        };
      },
    },
    frameDiag: diag,
  });
  t.after(() => wire.dispose());

  assert.equal(typeof cadenceSubscriber, 'function');
  const emit = /** @type {(c: any) => void} */ (cadenceSubscriber);

  emit({ wallFps: 60 });
  assert.equal(wire.requestedWallFps, 60);
  assert.equal(diag.requestedWallFps, 60);

  for (const invalidWall of [45, 0, -30, 15, 120, 30.5, '30', null]) {
    assert.throws(() => emit({ wallFps: invalidWall }), /SETTINGS_WALL_FPS/);
    assert.equal(wire.requestedWallFps, 60);
    assert.equal(diag.requestedWallFps, 60);
  }

  assert.throws(() => emit({ wallFps: 30, extra: 1 }), /SETTINGS_UNKNOWN_KEY/);
  assert.throws(() => emit({ op: 'cadence', wallFps: 30 }), /SETTINGS_UNKNOWN_KEY/);
  assert.throws(() => emit({}), /SETTINGS_WALL_FPS/);
  assert.throws(() => emit({ recordingFps: 0 }), /SETTINGS_RECORDING_FPS/);
  assert.throws(() => emit({ recordingFps: 61 }), /SETTINGS_RECORDING_FPS/);
  assert.equal(wire.requestedWallFps, 60);
  assert.equal(diag.requestedWallFps, 60);

  emit({ wallFps: 3, recordingFps: 24 });
  assert.equal(wire.requestedWallFps, 3);
  assert.equal(diag.requestedWallFps, 3);
  assert.equal(wire.recordingFps, 24);
  assert.deepEqual(coreRecFps, [24]);
});

test('F2: loadSettings fans out cadence to core/frames/diag and resets memory to defaults on corrupt or absent file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-setharden-f2-'));
  await chmod(root, 0o700);
  const diagDir = join(root, 'diag');
  await mkdir(diagDir, { mode: 0o700 });
  await chmod(diagDir, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {any} */ fn) => handlers.set(ch, fn),
    removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };

  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: diagDir },
    runDir: diagDir,
  });
  t.after(() => diag.dispose());

  /** @type {Array<{ wallFps: number }>} */
  const frameCadences = [];
  /** @type {Array<{ wallFps: number }>} */
  const coreCadences = [];
  /** @type {number[]} */
  const coreRecordingFps = [];

  const wire = installAuthorityWire({
    ipcMain,
    contents,
    env: { XDG_CONFIG_HOME: root },
    argv: ['--nested-depth=0'],
    core: {
      request: async () => true,
      requestCadence: (/** @type {{ wallFps: number }} */ c) => coreCadences.push(c),
      setRecordingFps: (/** @type {number} */ fps) => coreRecordingFps.push(fps),
    },
    frames: {
      subscribe: () => () => {},
      requestCadence: (/** @type {{ wallFps: number }} */ c) => frameCadences.push(c),
    },
    frameDiag: diag,
  });
  t.after(() => wire.dispose());

  const store = createSettingsStore({ XDG_CONFIG_HOME: root });
  const storedJson = JSON.stringify({
    scheme: 'mv-dark',
    density: 'comfortable',
    wallFps: 60,
    recordingFps: 20,
  });
  await store.save(storedJson);

  const loadHandler = handlers.get(WIRE_CHANNELS.loadSettings);
  assert.equal(await loadHandler(event), storedJson);
  assert.equal(wire.requestedWallFps, 60);
  assert.equal(wire.recordingFps, 20);
  assert.equal(diag.requestedWallFps, 60);
  assert.deepEqual(frameCadences, [{ wallFps: 60 }]);
  assert.deepEqual(coreCadences, [{ wallFps: 60 }]);
  assert.deepEqual(coreRecordingFps, [20]);

  // Corrupt the on-disk file; loadSettings must return null AND reset in-memory state + fan out defaults.
  const filePath = join(root, 'metaviewer', 'settings.json');
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await writeFile(filePath, '{corrupt-json', { mode: 0o600 });
    await chmod(filePath, 0o600);
    assert.equal(await loadHandler(event), null);
  } finally {
    console.warn = origWarn;
  }

  assert.equal(wire.requestedWallFps, 30);
  assert.equal(wire.recordingFps, 3);
  assert.equal(diag.requestedWallFps, 30);
  assert.deepEqual(frameCadences, [{ wallFps: 60 }, { wallFps: 30 }]);
  assert.deepEqual(coreCadences, [{ wallFps: 60 }, { wallFps: 30 }]);
  assert.deepEqual(coreRecordingFps, [20, 3]);
});

test('F3: capture recordStart and export use in-memory recordingFps without re-reading disk or mutating requestedWallFps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-setharden-f3-'));
  await chmod(root, 0o700);
  const configHome = join(root, 'config');
  await mkdir(configHome, { mode: 0o700 });
  await chmod(configHome, 0o700);
  const destDir = join(root, 'exports');
  await mkdir(destDir, { mode: 0o700 });
  await chmod(destDir, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = createSettingsStore({ XDG_CONFIG_HOME: configHome });
  await store.save(
    JSON.stringify({ scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 12 }),
  );

  const { runtimeDir, configPath, requests } = await startFakeCoreServer(t, root);
  const env = {
    MV_CORE_CONFIG: configPath,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: configHome,
    MV_RECORDING_DESTINATION: destDir,
  };
  const bindings = await createMainBindings({
    env,
    createMessageChannel: () => {
      throw new Error('no frames');
    },
  });
  t.after(() => bindings.core.dispose());

  /** @type {Array<{ wallFps: number }>} */
  const cadenceNotices = [];
  bindings.wire.frames.onCadence((c) => cadenceNotices.push(c));

  assert.equal(bindings.core.requestedWallFps, 30);
  assert.equal(bindings.core.recordingFps, 12);

  // Mutate disk directly out-of-band without going through loadSettings or saveSettings.
  const diskFile = join(configHome, 'metaviewer', 'settings.json');
  await writeFile(
    diskFile,
    JSON.stringify({ scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 45 }),
    { mode: 0o600 },
  );
  await chmod(diskFile, 0o600);

  await bindings.core.request({
    op: 'capture',
    method: 'recordStart',
    request: { schema: 'capture_request/v1', request_id: 'req-f3-start', surface_id: 's1', mode: 'ai' },
  });
  assert.equal(requests.at(-1).body.op, 'ram_start');
  assert.equal(requests.at(-1).body.params.max_fps, 12);
  assert.equal(bindings.core.requestedWallFps, 30);
  assert.equal(bindings.wire.frames.requestedWallFps, 30);
  assert.deepEqual(cadenceNotices, []);

  await bindings.core.request({
    op: 'capture',
    method: 'export',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-f3-export',
      capture_id: 'rec-1',
      destination: 'recording:configured',
    },
  });
  assert.equal(requests.at(-1).body.op, 'disk_start');
  assert.equal(requests.at(-1).body.params.max_fps, 12);
  assert.equal(bindings.core.requestedWallFps, 30);
  assert.deepEqual(cadenceNotices, []);
});

test('F4: frameDiag session rehash max is isolated per session so a fresh renderer reporting {0,0} is accepted', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'mv-setharden-f4-'));
  await chmod(runDir, 0o700);
  t.after(() => rm(runDir, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {any} */ fn) => handlers.set(ch, fn),
    removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };

  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: runDir },
    runDir,
  });
  t.after(() => diag.dispose());

  const sessionA = { id: 'session-a' };
  const sessionB = { id: 'session-b' };

  assert.deepEqual(diag.recordRehashDiag({ rehashSkipped: 5, rehashDone: 11 }, sessionA), {
    rehashSkipped: 5,
    rehashDone: 11,
  });
  assert.throws(
    () => diag.recordRehashDiag({ rehashSkipped: 4, rehashDone: 11 }, sessionA),
    /FRAME_DIAG_DECREASE/,
  );

  // Fresh session B starting at {0, 0} must be accepted despite session A's higher floor.
  assert.deepEqual(diag.recordRehashDiag({ rehashSkipped: 0, rehashDone: 0 }, sessionB), {
    rehashSkipped: 0,
    rehashDone: 0,
  });
  assert.deepEqual(diag.recordRehashDiag({ rehashSkipped: 2, rehashDone: 3 }, sessionB), {
    rehashSkipped: 2,
    rehashDone: 3,
  });
  assert.throws(
    () => diag.recordRehashDiag({ rehashSkipped: 1, rehashDone: 3 }, sessionB),
    /FRAME_DIAG_DECREASE/,
  );

  // Session A still retains its own independent floor of {5, 11}.
  assert.throws(
    () => diag.recordRehashDiag({ rehashSkipped: 5, rehashDone: 10 }, sessionA),
    /FRAME_DIAG_DECREASE/,
  );
  assert.deepEqual(diag.recordRehashDiag({ rehashSkipped: 6, rehashDone: 12 }, sessionA), {
    rehashSkipped: 6,
    rehashDone: 12,
  });
});

test('F5: handleReportDiag coalesces snapshot writes to only on change and at most once per second per session', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'mv-setharden-f5-'));
  await chmod(runDir, 0o700);
  t.after(() => rm(runDir, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {any} */ fn) => handlers.set(ch, fn),
    removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };

  let clockMs = 10_000;
  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: runDir },
    runDir,
    now: () => clockMs,
  });
  t.after(() => diag.dispose());

  await diag.flush();
  assert.equal(diag.getSnapshot().seq, 1);

  const reportHandler = handlers.get(FRAME_REPORT_DIAG_CHANNEL);
  assert.equal(typeof reportHandler, 'function');

  // Repeats of initial {0, 0} do not write at all.
  for (let i = 0; i < 5; i += 1) {
    clockMs += 500;
    await reportHandler(event, { rehashSkipped: 0, rehashDone: 0 });
  }
  assert.equal(diag.getSnapshot().seq, 1);

  // First actual change writes immediately (seq -> 2).
  clockMs = 20_000;
  await reportHandler(event, { rehashSkipped: 1, rehashDone: 2 });
  assert.equal(diag.getSnapshot().seq, 2);

  // Duplicate reports of {1, 2} do not write even after > 1 second.
  for (const delta of [50, 200, 1500, 3000]) {
    clockMs = 20_000 + delta;
    await reportHandler(event, { rehashSkipped: 1, rehashDone: 2 });
  }
  assert.equal(diag.getSnapshot().seq, 2);

  // A burst of 10 distinct increases inside a 1-second window writes once at the leading edge (seq -> 3)
  // and coalesces the remaining 9 changes without additional fsync writes during the window.
  clockMs = 30_000;
  for (let step = 1; step <= 10; step += 1) {
    clockMs = 30_000 + (step - 1) * 50;
    await reportHandler(event, { rehashSkipped: 1 + step, rehashDone: 2 + step });
  }
  assert.equal(diag.getSnapshot().seq, 3);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashSkipped, 11);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashDone, 12);

  // Once 1000 ms have elapsed for this session, the next report performs at most one write (seq -> 4).
  clockMs = 31_000;
  await reportHandler(event, { rehashSkipped: 12, rehashDone: 13 });
  assert.equal(diag.getSnapshot().seq, 4);

  await diag.flush();
  const persisted = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(persisted.preload.rehashSkipped, 12);
  assert.equal(persisted.preload.rehashDone, 13);
});

test('F6: createMainBindings surfaces SETTINGS_FILE and SETTINGS_DIRECTORY mode violations instead of swallowing them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-setharden-f6-'));
  await chmod(root, 0o700);
  const configHome = join(root, 'config');
  const mvConfigDir = join(configHome, 'metaviewer');
  const settingsFile = join(mvConfigDir, 'settings.json');
  await mkdir(mvConfigDir, { recursive: true, mode: 0o700 });
  await chmod(configHome, 0o700);
  await chmod(mvConfigDir, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const { runtimeDir, configPath } = await startFakeCoreServer(t, root);
  const env = {
    MV_CORE_CONFIG: configPath,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: configHome,
  };

  await writeFile(
    settingsFile,
    JSON.stringify({ scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 18 }),
    { mode: 0o600 },
  );

  // 1. Unsafe file mode (0644) must refuse with SETTINGS_FILE.
  await chmod(settingsFile, 0o644);
  await assert.rejects(
    createMainBindings({
      env,
      createMessageChannel: () => {
        throw new Error('no frames');
      },
    }),
    /SETTINGS_FILE/,
  );

  // 2. Unsafe directory mode (0755) must refuse with SETTINGS_DIRECTORY.
  await chmod(settingsFile, 0o600);
  await chmod(mvConfigDir, 0o755);
  await assert.rejects(
    createMainBindings({
      env,
      createMessageChannel: () => {
        throw new Error('no frames');
      },
    }),
    /SETTINGS_DIRECTORY/,
  );

  // 3. Restoring 0700/0600 allows boot and loads the stored settings.
  await chmod(mvConfigDir, 0o700);
  const bindings = await createMainBindings({
    env,
    createMessageChannel: () => {
      throw new Error('no frames');
    },
  });
  t.after(() => bindings.core.dispose());
  assert.equal(bindings.core.requestedWallFps, 60);
  assert.equal(bindings.core.recordingFps, 18);
});

test('F7: op:"cadence" and cadence methods enforce closed keys and refuse unknown keys, op leaks, and empty cadence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-setharden-f7-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const { runtimeDir, configPath } = await startFakeCoreServer(t, root);
  const bindings = await createMainBindings({
    env: {
      MV_CORE_CONFIG: configPath,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    createMessageChannel: () => {
      throw new Error('no frames');
    },
  });
  t.after(() => bindings.core.dispose());

  // Valid cadence requests via op:'cadence' and direct methods succeed.
  assert.equal(await bindings.core.request({ op: 'cadence', wallFps: 60 }), true);
  assert.equal(bindings.core.requestedWallFps, 60);
  assert.equal(await bindings.core.request({ op: 'cadence', recordingFps: 25 }), true);
  assert.equal(bindings.core.recordingFps, 25);
  assert.equal(await bindings.core.request({ op: 'cadence', wallFps: 3, recordingFps: 10 }), true);
  assert.equal(bindings.core.requestedWallFps, 3);
  assert.equal(bindings.core.recordingFps, 10);

  // Empty cadence is refused everywhere.
  await assert.rejects(bindings.core.request({ op: 'cadence' }), /SETTINGS_WALL_FPS/);
  assert.throws(() => bindings.core.requestCadence(/** @type {any} */ ({})), /SETTINGS_WALL_FPS/);
  assert.throws(() => bindings.wire.frames.setCadence(/** @type {any} */ ({})), /SETTINGS_WALL_FPS/);
  assert.throws(() => validateCadence({}), /SETTINGS_WALL_FPS/);

  // Unknown keys are refused on op:'cadence' and on direct cadence methods.
  await assert.rejects(
    bindings.core.request({ op: 'cadence', wallFps: 30, extra: 1 }),
    /SETTINGS_UNKNOWN_KEY/,
  );
  assert.throws(
    () => bindings.core.requestCadence(/** @type {any} */ ({ wallFps: 30, extra: 1 })),
    /SETTINGS_UNKNOWN_KEY/,
  );
  assert.throws(
    () => bindings.wire.frames.requestCadence(/** @type {any} */ ({ wallFps: 30, extra: 1 })),
    /SETTINGS_UNKNOWN_KEY/,
  );

  // Direct cadence entry points refuse an 'op' leak.
  assert.throws(
    () => bindings.core.requestCadence(/** @type {any} */ ({ op: 'cadence', wallFps: 30 })),
    /SETTINGS_UNKNOWN_KEY/,
  );
  assert.throws(
    () => bindings.core.setCadence(/** @type {any} */ ({ op: 'cadence', wallFps: 30 })),
    /SETTINGS_UNKNOWN_KEY/,
  );
  assert.throws(
    () => bindings.wire.frames.requestCadence(/** @type {any} */ ({ op: 'cadence', wallFps: 30 })),
    /SETTINGS_UNKNOWN_KEY/,
  );
  assert.throws(
    () => bindings.wire.frames.setCadence(/** @type {any} */ ({ op: 'cadence', wallFps: 30 })),
    /SETTINGS_UNKNOWN_KEY/,
  );
  assert.throws(() => validateCadence({ op: 'cadence', wallFps: 30 }), /SETTINGS_UNKNOWN_KEY/);

  // Invalid fps values are refused without mutating state.
  await assert.rejects(
    bindings.core.request({ op: 'cadence', wallFps: 45 }),
    /SETTINGS_WALL_FPS/,
  );
  await assert.rejects(
    bindings.core.request({ op: 'cadence', recordingFps: 0 }),
    /SETTINGS_RECORDING_FPS/,
  );
  assert.equal(bindings.core.requestedWallFps, 3);
  assert.equal(bindings.core.recordingFps, 10);
});

test('D1: frame.diag preload channel and recordCadence coalesce writes to on-change and at most once per second per session', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'mv-setharden-d1-'));
  await chmod(runDir, 0o700);
  t.after(() => rm(runDir, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {any} */ fn) => handlers.set(ch, fn),
    removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };

  let clockMs = 10_000;
  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: runDir },
    runDir,
    now: () => clockMs,
  });
  t.after(() => diag.dispose());

  await diag.flush();
  assert.equal(diag.getSnapshot().seq, 1);

  // Repeated recordCadence with unchanged wallFps performs no extra write.
  diag.recordCadence({ wallFps: 30 });
  diag.recordCadence({ wallFps: 30 });
  await diag.flush();
  assert.equal(diag.getSnapshot().seq, 1);

  const frameDiagHandler = handlers.get(FRAME_DIAG_CHANNEL);
  assert.equal(typeof frameDiagHandler, 'function');

  const basePayload = {
    schema: FRAME_DIAG_PRELOAD_SCHEMA,
    framesReceived: 1,
    invalidNotices: 0,
    portsReceived: 1,
    noticesForwarded: 1,
    legacyNoticesForwarded: 0,
    portsClosed: 0,
    rehashSkipped: 2,
    rehashDone: 4,
    inWallApp: true,
    origin: PRIVILEGED_ORIGIN,
    lastSurfaceId: 'surface-1',
    lastSurfaceGeneration: 1,
    lastFrameGeneration: 1,
    domSurfaceState: 'live',
    domWaitingText: null,
    domStripText: 'surface-1',
  };

  // First preload snapshot change writes on the leading edge (seq -> 2).
  clockMs = 20_000;
  await frameDiagHandler(event, basePayload);
  assert.equal(diag.getSnapshot().seq, 2);

  // Identical preload snapshots do not write even after > 1 second.
  for (const delta of [100, 500, 1500, 3000]) {
    clockMs = 20_000 + delta;
    await frameDiagHandler(event, { ...basePayload });
  }
  assert.equal(diag.getSnapshot().seq, 2);

  // A burst of 8 distinct frame.diag reports inside a 1s window writes once on the leading edge (seq -> 3)
  // and coalesces the remaining 7 updates without additional writes during the window.
  clockMs = 30_000;
  for (let step = 1; step <= 8; step += 1) {
    clockMs = 30_000 + (step - 1) * 50;
    await frameDiagHandler(event, {
      ...basePayload,
      framesReceived: 1 + step,
      rehashSkipped: 2 + step,
      rehashDone: 4 + step,
      lastFrameGeneration: 1 + step,
    });
  }
  assert.equal(diag.getSnapshot().seq, 3);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.framesReceived, 9);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashSkipped, 10);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashDone, 12);

  await diag.flush();
  assert.equal(diag.getSnapshot().seq, 4);
  const persisted = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(persisted.preload.framesReceived, 9);
  assert.equal(persisted.preload.rehashSkipped, 10);
  assert.equal(persisted.preload.rehashDone, 12);

  // Alternating valid cadence must share the preload/reportDiag write budget.
  clockMs = 40_000;
  diag.recordCadence({ wallFps: 60 });
  const cadenceSeq = diag.getSnapshot().seq;
  for (let step = 0; step < 8; step += 1) {
    clockMs += 50;
    diag.recordCadence({ wallFps: step % 2 === 0 ? 3 : 60 });
    await frameDiagHandler(event, { ...basePayload, rehashSkipped: 10, rehashDone: 12 });
  }
  assert.equal(diag.getSnapshot().seq, cadenceSeq);
  assert.equal(diag.requestedWallFps, 60);
  await diag.dispose();
  const cadenceDisk = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(cadenceDisk.main.requestedWallFps, 60);
  assert.equal(cadenceDisk.seq, cadenceSeq + 1);
});

test('D2: global preloadState rehash counters never regress when a fresh session reports lower counters', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'mv-setharden-d2-'));
  await chmod(runDir, 0o700);
  t.after(() => rm(runDir, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {any} */ fn) => handlers.set(ch, fn),
    removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };

  let clockMs = 10_000;
  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: runDir },
    runDir,
    now: () => clockMs,
  });
  t.after(() => diag.dispose());

  const sessionA = { id: 'session-a' };
  const sessionB = { id: 'session-b' };

  // Session A reports {5, 11}; persisted preloadState must reach {5, 11}.
  diag.recordRehashDiag({ rehashSkipped: 5, rehashDone: 11 }, sessionA);
  await diag.flush();
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashSkipped, 5);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashDone, 11);
  let persisted = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(persisted.preload.rehashSkipped, 5);
  assert.equal(persisted.preload.rehashDone, 11);

  // Fresh session B reporting {0, 0} and {2, 3} is admitted for B, but global preloadState must NOT regress below {5, 11}.
  clockMs = 12_000;
  assert.deepEqual(diag.recordRehashDiag({ rehashSkipped: 0, rehashDone: 0 }, sessionB), {
    rehashSkipped: 0,
    rehashDone: 0,
  });
  clockMs = 14_000;
  assert.deepEqual(diag.recordRehashDiag({ rehashSkipped: 2, rehashDone: 3 }, sessionB), {
    rehashSkipped: 2,
    rehashDone: 3,
  });
  await diag.flush();
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashSkipped, 5);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashDone, 11);
  persisted = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(persisted.preload.rehashSkipped, 5);
  assert.equal(persisted.preload.rehashDone, 11);

  // When session B advances one counter past session A ({2, 15}), global preloadState takes per-counter max {5, 15}.
  clockMs = 16_000;
  assert.deepEqual(diag.recordRehashDiag({ rehashSkipped: 2, rehashDone: 15 }, sessionB), {
    rehashSkipped: 2,
    rehashDone: 15,
  });
  await diag.flush();
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashSkipped, 5);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashDone, 15);
  persisted = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(persisted.preload.rehashSkipped, 5);
  assert.equal(persisted.preload.rehashDone, 15);
});

test('D3/N1: dispose() flushes pending coalesced reportDiag state to disk and performs no extra write when clean', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'mv-setharden-d3-'));
  await chmod(runDir, 0o700);
  t.after(() => rm(runDir, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (/** @type {string} */ ch, /** @type {any} */ fn) => handlers.set(ch, fn),
    removeHandler: (/** @type {string} */ ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };

  let clockMs = 10_000;
  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: runDir },
    runDir,
    now: () => clockMs,
  });

  await diag.flush();
  assert.equal(diag.getSnapshot().seq, 1);

  const reportHandler = handlers.get(FRAME_REPORT_DIAG_CHANNEL);
  assert.equal(typeof reportHandler, 'function');

  // 1. Report a change on the leading edge (writes immediately, seq -> 2).
  clockMs = 20_000;
  await reportHandler(event, { rehashSkipped: 3, rehashDone: 7 });
  assert.equal(diag.getSnapshot().seq, 2);

  // 2. Report a second change inside the 1000ms throttle window (dirty, not yet written to disk, seq stays 2).
  clockMs = 20_250;
  await reportHandler(event, { rehashSkipped: 9, rehashDone: 14 });
  assert.equal(diag.getSnapshot().seq, 2);
  const beforeDisposeDisk = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(beforeDisposeDisk.preload.rehashSkipped, 3);
  assert.equal(beforeDisposeDisk.preload.rehashDone, 7);

  // 3. Call dispose() directly WITHOUT flush(); disk must hold the final coalesced counters {9, 14} (seq -> 3).
  await diag.dispose();
  assert.equal(diag.getSnapshot().seq, 3);
  const afterDisposeDisk = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(afterDisposeDisk.seq, 3);
  assert.equal(afterDisposeDisk.preload.rehashSkipped, 9);
  assert.equal(afterDisposeDisk.preload.rehashDone, 14);

  // 4. Negative control: dispose() on an instance with no dirty state performs no extra write.
  const cleanDir = await mkdtemp(join(tmpdir(), 'mv-setharden-d3-clean-'));
  await chmod(cleanDir, 0o700);
  t.after(() => rm(cleanDir, { recursive: true, force: true }));

  const cleanHandlers = new Map();
  const cleanDiag = installFrameDiag({
    ipcMain: {
      handle: (/** @type {string} */ ch, /** @type {any} */ fn) => cleanHandlers.set(ch, fn),
      removeHandler: (/** @type {string} */ ch) => cleanHandlers.delete(ch),
    },
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: cleanDir },
    runDir: cleanDir,
    now: () => clockMs,
  });
  await cleanDiag.flush();
  assert.equal(cleanDiag.getSnapshot().seq, 1);

  clockMs = 50_000;
  await cleanHandlers.get(FRAME_REPORT_DIAG_CHANNEL)(event, { rehashSkipped: 4, rehashDone: 6 });
  assert.equal(cleanDiag.getSnapshot().seq, 2);

  await cleanDiag.dispose();
  assert.equal(cleanDiag.getSnapshot().seq, 2);
  const cleanDisk = JSON.parse(await readFile(join(cleanDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(cleanDisk.seq, 2);
  assert.equal(cleanDisk.preload.rehashSkipped, 4);
  assert.equal(cleanDisk.preload.rehashDone, 6);
});
