// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  installAuthorityWire,
   validateSettings,
  WIRE_CHANNELS,
} from '../electron/authorityWire.js';
import {
  FRAME_DIAG_FILE,
  FRAME_DIAG_PRELOAD_SCHEMA,
  FRAME_REPORT_DIAG_CHANNEL,
  installFrameDiag,
  validateFrameDiagPreload,
} from '../electron/frameDiag.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';
import { createPreloadFacade } from '../electron/preload.js';

const BASE_PRELOAD_DIAG = Object.freeze({
  schema: FRAME_DIAG_PRELOAD_SCHEMA,
  framesReceived: 3,
  invalidNotices: 0,
  portsReceived: 1,
  noticesForwarded: 1,
  legacyNoticesForwarded: 0,
  portsClosed: 0,
  inWallApp: true,
  origin: PRIVILEGED_ORIGIN,
  lastSurfaceId: 'surface-1',
  lastSurfaceGeneration: 1,
  lastFrameGeneration: 3,
  domSurfaceState: 'active',
  domWaitingText: null,
  domStripText: 'surface-1',
});

test('HOST-FPS-1: validateSettings admits closed {scheme, density, wallFps, recordingFps} set and rejects invalid values or unknown keys', () => {
  assert.deepEqual(validateSettings('{}'), {
    scheme: 'mv-light',
    density: 'compact',
    wallFps: 30,
    recordingFps: 3,
  });
  assert.deepEqual(DEFAULT_SETTINGS, {
    scheme: 'mv-light',
    density: 'compact',
    wallFps: 30,
    recordingFps: 3,
  });

  for (const scheme of ['mv-light', 'mv-dark']) {
    for (const density of ['compact', 'comfortable']) {
      for (const wallFps of [3, 30, 60]) {
        for (const recordingFps of [1, 3, 30, 60]) {
          const parsed = validateSettings(JSON.stringify({ scheme, density, wallFps, recordingFps }));
          assert.deepEqual(parsed, { scheme, density, wallFps, recordingFps });
        }
      }
    }
  }

  assert.throws(
    () => validateSettings(JSON.stringify({ scheme: 'mv-light', density: 'compact', extra: 1 })),
    /SETTINGS_UNKNOWN_KEY/,
  );
  assert.throws(
    () => validateSettings(JSON.stringify({ unknown: true })),
    /SETTINGS_UNKNOWN_KEY/,
  );

  for (const badScheme of ['invalid', '', 123, null, true]) {
    assert.throws(
      () => validateSettings(JSON.stringify({ scheme: badScheme })),
      /SETTINGS_SCHEME/,
    );
  }

  for (const badDensity of ['spacious', '', 123, null, false]) {
    assert.throws(
      () => validateSettings(JSON.stringify({ density: badDensity })),
      /SETTINGS_DENSITY/,
    );
  }

  for (const badWallFps of [0, -30, 1, 2, 15, 24, 29, 31, 59, 61, 120, 30.5, '30', null, true]) {
    assert.throws(
      () => validateSettings(JSON.stringify({ wallFps: badWallFps })),
      /SETTINGS_WALL_FPS/,
    );
  }

  for (const badRecordingFps of [0, -1, -3, 61, 120, 3.5, '3', null, false]) {
    assert.throws(
      () => validateSettings(JSON.stringify({ recordingFps: badRecordingFps })),
      /SETTINGS_RECORDING_FPS/,
    );
  }

  for (const nonObject of ['[]', '123', '"text"', 'null', '{bad']) {
    assert.throws(() => validateSettings(nonObject), /PAYLOAD|SyntaxError/);
  }
});

test('HOST-FPS-2: createSettingsStore reads old files without wallFps/recordingFps back with defaults and preserves atomic 0600/0700 symlink hardening', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-host-fps-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = createSettingsStore({ XDG_CONFIG_HOME: root });
  assert.equal(await store.load(), null);

  const dir = join(root, 'metaviewer');
  const filePath = join(dir, 'settings.json');
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(filePath, JSON.stringify({ scheme: 'mv-dark', density: 'compact' }), { mode: 0o600 });
  await chmod(filePath, 0o600);

  const loadedLegacy = await store.load();
  assert.equal(loadedLegacy, JSON.stringify({ scheme: 'mv-dark', density: 'compact' }));
  assert.deepEqual(validateSettings(/** @type {string} */ (loadedLegacy)), {
    scheme: 'mv-dark',
    density: 'compact',
    wallFps: 30,
    recordingFps: 3,
  });

  const firstStat = await lstat(filePath);
  assert.equal(firstStat.mode & 0o777, 0o600);

  const updated = {
    scheme: 'mv-light',
    density: 'comfortable',
    wallFps: 60,
    recordingFps: 24,
  };
  assert.equal(await store.save(JSON.stringify(updated)), true);
  const secondStat = await lstat(filePath);
  assert.equal(secondStat.mode & 0o777, 0o600);
  assert.notEqual(secondStat.ino, firstStat.ino);
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(/** @type {string} */ (await store.load())), updated);

  await rm(filePath);
  const target = join(root, 'outside-target.json');
  await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, filePath);
  await assert.rejects(store.load());
  await assert.rejects(store.save(JSON.stringify(updated)), /SETTINGS_FILE/);
});

test('HOST-FPS-3: settings.save emits host-internal cadence request {wallFps} to host bindings and exposes requestedWallFps on frameDiag snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-host-fps-cadence-'));
  await chmod(root, 0o700);
  const diagDir = join(root, 'diag');
  await mkdir(diagDir, { mode: 0o700 });
  await chmod(diagDir, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
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
  /** @type {Array<number>} */
  const coreRecordingFps = [];

  const wire = installAuthorityWire({
    ipcMain,
    contents,
    env: { XDG_CONFIG_HOME: root },
    argv: ['--nested-depth=0'],
    core: {
      request: async () => true,
      requestCadence: (c) => coreCadences.push(c),
      setRecordingFps: (fps) => coreRecordingFps.push(fps),
    },
    frames: {
      subscribe: () => () => {},
      requestCadence: (c) => frameCadences.push(c),
    },
    frameDiag: diag,
  });
  t.after(() => wire.dispose());

  assert.equal(diag.requestedWallFps, 30);
  assert.equal(diag.getSnapshot().requestedWallFps, 30);
  assert.equal(/** @type {any} */ (diag.getSnapshot().main).requestedWallFps, 30);

  const saveHandler = handlers.get(WIRE_CHANNELS.saveSettings);
  const loadHandler = handlers.get(WIRE_CHANNELS.loadSettings);
  assert.equal(typeof saveHandler, 'function');
  assert.equal(typeof loadHandler, 'function');

  await saveHandler(
    event,
    JSON.stringify({ scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 15 }),
  );

  assert.deepEqual(frameCadences, [{ wallFps: 60 }]);
  assert.deepEqual(coreCadences, [{ wallFps: 60 }]);
  assert.deepEqual(coreRecordingFps, [15]);
  assert.equal(wire.requestedWallFps, 60);
  assert.equal(wire.recordingFps, 15);
  assert.equal(diag.requestedWallFps, 60);
  assert.equal(diag.getSnapshot().requestedWallFps, 60);
  assert.equal(/** @type {any} */ (diag.getSnapshot().main).requestedWallFps, 60);

  await diag.flush();
  const persisted = JSON.parse(await readFile(join(diagDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(persisted.requestedWallFps, 60);
  assert.equal(persisted.main.requestedWallFps, 60);

  await assert.rejects(
    saveHandler(event, JSON.stringify({ scheme: 'mv-dark', density: 'compact', wallFps: 45, recordingFps: 10 })),
    /SETTINGS_WALL_FPS/,
  );
  assert.deepEqual(frameCadences, [{ wallFps: 60 }]);
  assert.equal(diag.requestedWallFps, 60);
});

test('HOST-FPS-4: frame_diag_preload/v1 optional rehash counters and metaviewer.frames.reportDiag accept/refuse cases', async (t) => {
  const withoutRehash = validateFrameDiagPreload(BASE_PRELOAD_DIAG);
  assert.equal(withoutRehash.rehashSkipped, 0);
  assert.equal(withoutRehash.rehashDone, 0);

  const withRehash = validateFrameDiagPreload({
    ...BASE_PRELOAD_DIAG,
    rehashSkipped: 9,
    rehashDone: 14,
  });
  assert.equal(withRehash.rehashSkipped, 9);
  assert.equal(withRehash.rehashDone, 14);

  assert.throws(
    () => validateFrameDiagPreload({ ...BASE_PRELOAD_DIAG, rehashSkipped: -1, rehashDone: 0 }),
    { code: 'FRAME_DIAG_PAYLOAD' },
  );
  assert.throws(
    () => validateFrameDiagPreload({ ...BASE_PRELOAD_DIAG, rehashSkipped: 0, rehashDone: 1.5 }),
    { code: 'FRAME_DIAG_PAYLOAD' },
  );
  assert.throws(
    () => validateFrameDiagPreload({ ...BASE_PRELOAD_DIAG, rehashSkipped: 0, rehashDone: 0, extra: 1 }),
    { code: 'FRAME_DIAG_PAYLOAD' },
  );

  const runDir = await mkdtemp(join(tmpdir(), 'mv-host-fps-rehash-'));
  await chmod(runDir, 0o700);
  t.after(() => rm(runDir, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 7, mainFrame: frame, isDestroyed: () => false };
  const validEvent = { sender: contents, senderFrame: frame };

  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: runDir },
    runDir,
  });
  t.after(() => diag.dispose());

  const api = createPreloadFacade({
    transport: {
      invoke: (channel, args) => {
        const handler = handlers.get(channel);
        assert.equal(typeof handler, 'function', `expected handler for ${channel}`);
        return handler(validEvent, ...args);
      },
      subscribe: () => () => {},
    },
    bridge: { exposeInMainWorld() {} },
  });

  assert.equal(await api.frames.reportDiag({ rehashSkipped: 0, rehashDone: 1 }), true);
  assert.equal(await api.frames.reportDiag({ rehashSkipped: 4, rehashDone: 1 }), true);
  assert.equal(await api.frames.reportDiag({ rehashSkipped: 4, rehashDone: 9 }), true);
  assert.equal(await api.frames.reportDiag({ rehashSkipped: 4, rehashDone: 9 }), true);

  const snapAfterAccept = /** @type {any} */ (diag.getSnapshot());
  assert.equal(snapAfterAccept.preload.rehashSkipped, 4);
  assert.equal(snapAfterAccept.preload.rehashDone, 9);

  // Refuse decreases on either counter while keeping the max per renderer session.
  await assert.rejects(
    api.frames.reportDiag({ rehashSkipped: 3, rehashDone: 9 }),
    /FRAME_DIAG_DECREASE/,
  );
  await assert.rejects(
    api.frames.reportDiag({ rehashSkipped: 4, rehashDone: 8 }),
    /FRAME_DIAG_DECREASE/,
  );
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashSkipped, 4);
  assert.equal(/** @type {any} */ (diag.getSnapshot()).preload.rehashDone, 9);

  // Refuse non-ints, negative values, extra keys, missing keys, bad arity, non-plain objects.
  for (const badPayload of [
    { rehashSkipped: -1, rehashDone: 9 },
    { rehashSkipped: 4, rehashDone: -1 },
    { rehashSkipped: 4.5, rehashDone: 9 },
    { rehashSkipped: '4', rehashDone: 9 },
    { rehashSkipped: 4, rehashDone: null },
    { rehashSkipped: 4, rehashDone: 9, extra: 1 },
    { rehashSkipped: 4 },
    { rehashDone: 9 },
    {},
    null,
    [4, 9],
    Object.create({ rehashSkipped: 4, rehashDone: 9 }),
  ]) {
    await assert.rejects(
      () => api.frames.reportDiag(/** @type {any} */ (badPayload)),
      /PAYLOAD|FRAME_DIAG_PAYLOAD/,
    );
    await assert.rejects(
      () => handlers.get(FRAME_REPORT_DIAG_CHANNEL)(validEvent, badPayload),
      /FRAME_DIAG_PAYLOAD/,
    );
  }

  await assert.rejects(() => api.frames.reportDiag(), /ARGS/);
  await assert.rejects(
    () => api.frames.reportDiag({ rehashSkipped: 4, rehashDone: 9 }, { extra: true }),
    /ARGS/,
  );
  await assert.rejects(() => handlers.get(FRAME_REPORT_DIAG_CHANNEL)(validEvent), /FRAME_DIAG_ARGS/);

  // Refuse calls from untrusted senders (observeSender rules).
  const untrustedOriginFrame = { origin: 'https://evil.example', url: 'https://evil.example/index.html' };
  const otherContents = { id: 99, mainFrame: frame, isDestroyed: () => false };
  const subFrame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  for (const badEvent of [
    { sender: contents, senderFrame: untrustedOriginFrame },
    { sender: otherContents, senderFrame: frame },
    { sender: contents, senderFrame: subFrame },
    null,
  ]) {
    await assert.rejects(
      () => handlers.get(FRAME_REPORT_DIAG_CHANNEL)(badEvent, { rehashSkipped: 5, rehashDone: 10 }),
      /SENDER|ORIGIN|SUBFRAME|sender refused/,
    );
  }

  // Subsequent valid increase still succeeds after refused attempts.
  assert.equal(await api.frames.reportDiag({ rehashSkipped: 6, rehashDone: 12 }), true);
  await diag.flush();
  const persisted = JSON.parse(await readFile(join(runDir, FRAME_DIAG_FILE), 'utf8'));
  assert.equal(persisted.preload.rehashSkipped, 6);
  assert.equal(persisted.preload.rehashDone, 12);
});

test('HOST-FPS-5: recording requests use default max_fps 3, update from saved recordingFps, and honor per-request max_fps override', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-host-fps-rec-'));
  await chmod(root, 0o700);
  const configHome = join(root, 'config');
  await mkdir(configHome, { mode: 0o700 });
  await chmod(configHome, 0o700);
  const destDir = join(root, 'exports');
  await mkdir(destDir, { mode: 0o700 });
  await chmod(destDir, 0o700);

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
  const config = { session_id: 'fps-rec', core: reg('core'), peers: [reg('ui')] };
  await mkdir(join(root, 'metaviewer'), { mode: 0o700 });
  await writeFile(join(root, 'config.json'), JSON.stringify(config), { mode: 0o600 });

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
    });
  });
  server.listen(join(root, 'metaviewer/core.sock'));
  await once(server, 'listening');
  await chmod(join(root, 'metaviewer/core.sock'), 0o600);
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const env = {
    MV_CORE_CONFIG: join(root, 'config.json'),
    XDG_RUNTIME_DIR: root,
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

  const handlers = new Map();
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };
  const wire = installAuthorityWire({
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    },
    contents,
    core: bindings.core,
    frames: bindings.wire.frames,
    env,
    argv: ['--nested-depth=0'],
  });
  t.after(() => wire.dispose());

  // 1. Default max_fps is 3 when renderer does not pass one.
  await bindings.core.request({
    op: 'capture',
    method: 'recordStart',
    request: { schema: 'capture_request/v1', request_id: 'req-default', surface_id: 's1', mode: 'ai' },
  });
  assert.equal(requests.at(-1).body.op, 'ram_start');
  assert.equal(requests.at(-1).body.params.max_fps, 3);

  await bindings.core.request({
    op: 'capture',
    method: 'export',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-export-default',
      capture_id: 'rec-1',
      destination: 'recording:configured',
    },
  });
  assert.equal(requests.at(-1).body.op, 'disk_start');
  assert.equal(requests.at(-1).body.params.max_fps, 3);

  // 2. Per-request max_fps override takes precedence over default 3.
  await bindings.core.request({
    op: 'capture',
    method: 'recordStart',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-override-24',
      surface_id: 's1',
      mode: 'ai',
      max_fps: 24,
    },
  });
  assert.equal(requests.at(-1).body.params.max_fps, 24);

  // 3. Saving recordingFps via settings.save updates the default max_fps for subsequent requests.
  await handlers.get(WIRE_CHANNELS.saveSettings)(
    event,
    JSON.stringify({ scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 18 }),
  );
  await bindings.core.request({
    op: 'capture',
    method: 'recordStart',
    request: { schema: 'capture_request/v1', request_id: 'req-saved-18', surface_id: 's1', mode: 'ai' },
  });
  assert.equal(requests.at(-1).body.params.max_fps, 18);

  // 4. Per-request max_fps override still overrides saved recordingFps.
  await bindings.core.request({
    op: 'capture',
    method: 'recordStart',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-override-48',
      surface_id: 's1',
      mode: 'ai',
      max_fps: 48,
    },
  });
  assert.equal(requests.at(-1).body.params.max_fps, 48);

  // 5. Out-of-range max_fps override is refused.
  await assert.rejects(
    bindings.core.request({
      op: 'capture',
      method: 'recordStart',
      request: {
        schema: 'capture_request/v1',
        request_id: 'req-bad-fps',
        surface_id: 's1',
        mode: 'ai',
        max_fps: 61,
      },
    }),
  );
});
