// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS,
  createSettingsStore,
  decodeSettingsV02,
  installAuthorityWire,
  validateSettings,
  WIRE_CHANNELS,
} from '../electron/authorityWire.js';
import {
  FRAME_DIAG_CHANNEL,
  FRAME_DIAG_PRELOAD_SCHEMA,
  FRAME_REPORT_DIAG_CHANNEL,
  installFrameDiag,
} from '../electron/frameDiag.js';
import { createMainBindings } from '../electron/hostBindings.js';
import { PRIVILEGED_ORIGIN } from '../electron/main.js';
import {
  decodeMvSettings,
  decodeStoredSettings,
  defaultMvSettings,
} from '../src/settings/settingsModel.js';

const PARITY_FIXTURE_PATH = fileURLToPath(
  new URL('../../tests/fixtures/settings_parity.json', import.meta.url),
);

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

/**
 * Create a hosted-safe unix-socket core fixture in a private temp directory.
 * @param {import('node:test').TestContext} t
 */
async function createUnixCoreFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mv-settings-mut-'));
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
  const config = { session_id: 'mut-fps', core: reg('core'), peers: [reg('ui')] };
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
  return { root, configHome, destDir, env, requests };
}

test('MUT-S1: settings.load hydrates requestedWallFps, recordingFps, and core.setRecordingFps on restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-mut-s1-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {} };
  const event = { sender: contents, senderFrame: frame };

  // 1. Four-key payload at wall 60 and recording 18 hydrates wire getters and calls core.setRecordingFps(18).
  const xdgFour = join(root, 'xdg-four');
  const dirFour = join(xdgFour, 'metaviewer');
  await mkdir(xdgFour, { mode: 0o700 });
  await chmod(xdgFour, 0o700);
  await mkdir(dirFour, { mode: 0o700 });
  await chmod(dirFour, 0o700);
  const fourPayload = JSON.stringify({
    scheme: 'mv-dark',
    density: 'comfortable',
    wallFps: 60,
    recordingFps: 18,
  });
  await writeFile(join(dirFour, 'settings.json'), fourPayload, { mode: 0o600 });
  await chmod(join(dirFour, 'settings.json'), 0o600);

  const handlersFour = new Map();
  /** @type {number[]} */
  const coreCallsFour = [];
  const wireFour = installAuthorityWire({
    ipcMain: {
      handle: (ch, fn) => handlersFour.set(ch, fn),
      removeHandler: (ch) => handlersFour.delete(ch),
    },
    contents,
    env: { XDG_CONFIG_HOME: xdgFour },
    argv: ['--nested-depth=0'],
    core: {
      request: async () => true,
      setRecordingFps: (fps) => coreCallsFour.push(fps),
    },
  });
  t.after(() => wireFour.dispose());

  assert.equal(wireFour.requestedWallFps, 30);
  assert.equal(wireFour.recordingFps, 3);
  assert.deepEqual(coreCallsFour, []);

  const loadedFour = await handlersFour.get(WIRE_CHANNELS.loadSettings)(event);
  assert.equal(loadedFour, fourPayload);
  assert.equal(wireFour.requestedWallFps, 60);
  assert.equal(wireFour.recordingFps, 18);
  assert.deepEqual(coreCallsFour, [18]);

  // 2. Legacy two-key file hydrates to wall 30 and recording 3 and notifies core with 3.
  const xdgLegacy = join(root, 'xdg-legacy');
  const dirLegacy = join(xdgLegacy, 'metaviewer');
  await mkdir(xdgLegacy, { mode: 0o700 });
  await chmod(xdgLegacy, 0o700);
  await mkdir(dirLegacy, { mode: 0o700 });
  await chmod(dirLegacy, 0o700);
  const legacyPayload = JSON.stringify({ scheme: 'mv-dark', density: 'compact' });
  await writeFile(join(dirLegacy, 'settings.json'), legacyPayload, { mode: 0o600 });
  await chmod(join(dirLegacy, 'settings.json'), 0o600);

  const handlersLegacy = new Map();
  /** @type {number[]} */
  const coreCallsLegacy = [];
  const wireLegacy = installAuthorityWire({
    ipcMain: {
      handle: (ch, fn) => handlersLegacy.set(ch, fn),
      removeHandler: (ch) => handlersLegacy.delete(ch),
    },
    contents,
    env: { XDG_CONFIG_HOME: xdgLegacy },
    argv: ['--nested-depth=0'],
    core: {
      request: async () => true,
      setRecordingFps: (fps) => coreCallsLegacy.push(fps),
    },
  });
  t.after(() => wireLegacy.dispose());

  const loadedLegacy = await handlersLegacy.get(WIRE_CHANNELS.loadSettings)(event);
  assert.equal(loadedLegacy, legacyPayload);
  assert.equal(wireLegacy.requestedWallFps, 30);
  assert.equal(wireLegacy.recordingFps, 3);
  assert.deepEqual(coreCallsLegacy, [3]);

  // 3. No file on disk: load returns null and actively fans out defaults, including over stale memory.
  const xdgEmpty = join(root, 'xdg-empty');
  await mkdir(xdgEmpty, { mode: 0o700 });
  await chmod(xdgEmpty, 0o700);

  const handlersEmpty = new Map();
  /** @type {number[]} */
  const coreCallsEmpty = [];
  const wireEmpty = installAuthorityWire({
    ipcMain: {
      handle: (ch, fn) => handlersEmpty.set(ch, fn),
      removeHandler: (ch) => handlersEmpty.delete(ch),
    },
    contents,
    env: { XDG_CONFIG_HOME: xdgEmpty },
    argv: ['--nested-depth=0'],
    core: {
      request: async () => true,
      setRecordingFps: (fps) => coreCallsEmpty.push(fps),
    },
  });
  t.after(() => wireEmpty.dispose());

  const loadedEmpty = await handlersEmpty.get(WIRE_CHANNELS.loadSettings)(event);
  assert.equal(loadedEmpty, null);
  assert.equal(wireEmpty.requestedWallFps, 30);
  assert.equal(wireEmpty.recordingFps, 3);
  assert.deepEqual(coreCallsEmpty, [3]);

  await handlersEmpty.get(WIRE_CHANNELS.saveSettings)(event, fourPayload);
  assert.equal(wireEmpty.requestedWallFps, 60);
  assert.equal(wireEmpty.recordingFps, 18);
  await rm(join(xdgEmpty, 'metaviewer', 'settings.json'));
  assert.equal(await handlersEmpty.get(WIRE_CHANNELS.loadSettings)(event), null);
  assert.equal(wireEmpty.requestedWallFps, 30);
  assert.equal(wireEmpty.recordingFps, 3);
  assert.deepEqual(coreCallsEmpty, [3, 18, 3]);
});

test('MUT-S2: settings.save fans out to all six cadence consumers and frames.onCadence validates input', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mv-mut-s2-'));
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

  const realDiag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: diagDir },
    runDir: diagDir,
  });
  t.after(() => realDiag.dispose());

  /** @type {Array<{ wallFps: number }>} */
  const framesRequestCadence = [];
  /** @type {Array<{ wallFps: number }>} */
  const framesSetCadence = [];
  /** @type {Array<{ wallFps: number }>} */
  const coreRequestCadence = [];
  /** @type {Array<{ wallFps: number }>} */
  const coreSetCadence = [];
  /** @type {number[]} */
  const coreSetRecordingFps = [];
  /** @type {Array<{ wallFps: number }>} */
  const diagRecordCadence = [];
  /** @type {((cadence: any) => void) | null} */
  let onCadenceListener = null;
  let cadenceUnsubscribed = false;

  const diagDouble = {
    recordCadence: (/** @type {{ wallFps: number }} */ c) => {
      diagRecordCadence.push(c);
      realDiag.recordCadence(c);
    },
  };

  const wire = installAuthorityWire({
    ipcMain,
    contents,
    env: { XDG_CONFIG_HOME: root },
    argv: ['--nested-depth=0'],
    core: {
      request: async () => true,
      requestCadence: (c) => coreRequestCadence.push(c),
      setCadence: (c) => coreSetCadence.push(c),
      setRecordingFps: (fps) => coreSetRecordingFps.push(fps),
    },
    frames: {
      subscribe: () => () => {},
      requestCadence: (c) => framesRequestCadence.push(c),
      setCadence: (c) => framesSetCadence.push(c),
      onCadence: (cb) => {
        onCadenceListener = cb;
        return () => {
          cadenceUnsubscribed = true;
        };
      },
    },
    frameDiag: diagDouble,
  });
  t.after(() => wire.dispose());

  assert.equal(typeof onCadenceListener, 'function');

  // 1. Save a four-key payload and assert all 6 emissions fire once.
  const saveHandler = handlers.get(WIRE_CHANNELS.saveSettings);
  await saveHandler(
    event,
    JSON.stringify({ scheme: 'mv-dark', density: 'comfortable', wallFps: 3, recordingFps: 42 }),
  );

  assert.deepEqual(framesRequestCadence, [{ wallFps: 3 }]);
  assert.deepEqual(framesSetCadence, [{ wallFps: 3 }]);
  assert.deepEqual(coreRequestCadence, [{ wallFps: 3 }]);
  assert.deepEqual(coreSetCadence, [{ wallFps: 3 }]);
  assert.deepEqual(coreSetRecordingFps, [42]);
  assert.deepEqual(diagRecordCadence, [{ wallFps: 3 }]);
  assert.equal(wire.requestedWallFps, 3);
  assert.equal(wire.recordingFps, 42);
  assert.equal(realDiag.requestedWallFps, 3);
  assert.equal(realDiag.getSnapshot().requestedWallFps, 3);

  // 2. Drive frames.onCadence with wall 60 and assert wire.requestedWallFps and frameDiag snapshot follow.
  /** @type {(cadence: any) => void} */ (onCadenceListener)({ wallFps: 60 });
  assert.equal(wire.requestedWallFps, 60);
  assert.equal(realDiag.requestedWallFps, 60);
  assert.equal(realDiag.getSnapshot().requestedWallFps, 60);
  assert.equal(/** @type {any} */ (realDiag.getSnapshot().main).requestedWallFps, 60);
  assert.deepEqual(diagRecordCadence.at(-1), { wallFps: 60 });

  // 3. Every malformed or unrepresentable cadence is refused atomically at the wire.
  const consumers = () => structuredClone({
    framesRequestCadence, framesSetCadence, coreRequestCadence, coreSetCadence,
    coreSetRecordingFps, diagRecordCadence,
  });
  const beforeBad = consumers();
  for (const [badCadence, error] of [
    ...['60', 30.5, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 1, 25, 45, 61]
      .map((wallFps) => [{ wallFps, recordingFps: 18 }, /SETTINGS_WALL_FPS/]),
    [null, /PAYLOAD/], [undefined, /PAYLOAD/], [{}, /SETTINGS_WALL_FPS/],
    [{ wallFps: 30, extra: true }, /SETTINGS_UNKNOWN_KEY/],
    ...[0, 61, 1.5, '18', null].map((recordingFps) => [
      { wallFps: 30, recordingFps }, /SETTINGS_RECORDING_FPS/,
    ]),
  ]) {
    assert.throws(() => /** @type {(cadence: any) => void} */ (onCadenceListener)(badCadence),
      /** @type {RegExp} */ (error));
    assert.equal(wire.requestedWallFps, 60);
    assert.equal(wire.recordingFps, 42);
    assert.equal(realDiag.requestedWallFps, 60);
    assert.equal(realDiag.getSnapshot().requestedWallFps, 60);
    assert.equal(/** @type {any} */ (realDiag.getSnapshot().main).requestedWallFps, 60);
    assert.deepEqual(consumers(), beforeBad);
  }

  wire.dispose();
  assert.equal(cadenceUnsubscribed, true);
  /** @type {(cadence: any) => void} */ (onCadenceListener)({ wallFps: 3 });
  assert.equal(wire.requestedWallFps, 60);
});

test('MUT-S3: capture max_fps/maxFps override parser pins camelCase alias, both-keys refusal, and 1..60 boundary edges', async (t) => {
  const { env, requests } = await createUnixCoreFixture(t);
  const bindings = await createMainBindings({
    env,
    createMessageChannel: () => {
      throw new Error('no frames');
    },
  });
  t.after(() => bindings.core.dispose());

  // 1. camelCase maxFps: 24 yields effective max_fps 24 on recordStart and export.
  await bindings.core.request({
    op: 'capture',
    method: 'recordStart',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-camel-start',
      surface_id: 's1',
      mode: 'ai',
      maxFps: 24,
    },
  });
  assert.equal(requests.at(-1).body.op, 'ram_start');
  assert.equal(requests.at(-1).body.params.max_fps, 24);

  await bindings.core.request({
    op: 'capture',
    method: 'export',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-camel-export',
      capture_id: 'rec-1',
      destination: 'recording:configured',
      maxFps: 24,
    },
  });
  assert.equal(requests.at(-1).body.op, 'disk_start');
  assert.equal(requests.at(-1).body.params.max_fps, 24);

  // 2. Request carrying both max_fps and maxFps at once is refused on both recordStart and export.
  await assert.rejects(
    bindings.core.request({
      op: 'capture',
      method: 'recordStart',
      request: {
        schema: 'capture_request/v1',
        request_id: 'req-both-start',
        surface_id: 's1',
        mode: 'ai',
        max_fps: 24,
        maxFps: 24,
      },
    }),
    /CORE_SEAMS_ABSENT/,
  );
  await assert.rejects(
    bindings.core.request({
      op: 'capture',
      method: 'export',
      request: {
        schema: 'capture_request/v1',
        request_id: 'req-both-export',
        capture_id: 'rec-1',
        destination: 'recording:configured',
        max_fps: 24,
        maxFps: 24,
      },
    }),
    /CORE_SEAMS_ABSENT/,
  );

  // 3. Boundary overrides 1 and 60 are accepted on both recordStart and export (snake_case and camelCase).
  for (const boundary of [1, 60]) {
    await bindings.core.request({
      op: 'capture',
      method: 'recordStart',
      request: {
        schema: 'capture_request/v1',
        request_id: `req-start-snake-${boundary}`,
        surface_id: 's1',
        mode: 'ai',
        max_fps: boundary,
      },
    });
    assert.equal(requests.at(-1).body.params.max_fps, boundary);

    await bindings.core.request({
      op: 'capture',
      method: 'recordStart',
      request: {
        schema: 'capture_request/v1',
        request_id: `req-start-camel-${boundary}`,
        surface_id: 's1',
        mode: 'ai',
        maxFps: boundary,
      },
    });
    assert.equal(requests.at(-1).body.params.max_fps, boundary);

    await bindings.core.request({
      op: 'capture',
      method: 'export',
      request: {
        schema: 'capture_request/v1',
        request_id: `req-export-snake-${boundary}`,
        capture_id: 'rec-1',
        destination: 'recording:configured',
        max_fps: boundary,
      },
    });
    assert.equal(requests.at(-1).body.params.max_fps, boundary);

    await bindings.core.request({
      op: 'capture',
      method: 'export',
      request: {
        schema: 'capture_request/v1',
        request_id: `req-export-camel-${boundary}`,
        capture_id: 'rec-1',
        destination: 'recording:configured',
        maxFps: boundary,
      },
    });
    assert.equal(requests.at(-1).body.params.max_fps, boundary);
  }

  // 4. Out-of-bounds and non-integer overrides (0, 61, -1, floats, strings, null, booleans) are refused.
  for (const badOverride of [0, 61, -1, 1.5, 30.5, Number.NaN, '30', null, true, false]) {
    await assert.rejects(
      bindings.core.request({
        op: 'capture',
        method: 'recordStart',
        request: {
          schema: 'capture_request/v1',
          request_id: 'req-bad-start-snake',
          surface_id: 's1',
          mode: 'ai',
          max_fps: badOverride,
        },
      }),
      /CORE_SEAMS_ABSENT/,
    );
    await assert.rejects(
      bindings.core.request({
        op: 'capture',
        method: 'recordStart',
        request: {
          schema: 'capture_request/v1',
          request_id: 'req-bad-start-camel',
          surface_id: 's1',
          mode: 'ai',
          maxFps: badOverride,
        },
      }),
      /CORE_SEAMS_ABSENT/,
    );
    await assert.rejects(
      bindings.core.request({
        op: 'capture',
        method: 'export',
        request: {
          schema: 'capture_request/v1',
          request_id: 'req-bad-export-snake',
          capture_id: 'rec-1',
          destination: 'recording:configured',
          max_fps: badOverride,
        },
      }),
      /CORE_SEAMS_ABSENT/,
    );
    await assert.rejects(
      bindings.core.request({
        op: 'capture',
        method: 'export',
        request: {
          schema: 'capture_request/v1',
          request_id: 'req-bad-export-camel',
          capture_id: 'rec-1',
          destination: 'recording:configured',
          maxFps: badOverride,
        },
      }),
      /CORE_SEAMS_ABSENT/,
    );
  }
});

test('MUT-S4: in-memory recordingFps wins over disk edits, restart hydrates, and direct setters validate bounds', async (t) => {
  const { configHome, env, requests } = await createUnixCoreFixture(t);
  const bindings = await createMainBindings({
    env,
    createMessageChannel: () => {
      throw new Error('no frames');
    },
  });
  t.after(() => bindings.core.dispose());

  const settingsDir = join(configHome, 'metaviewer');
  const settingsFile = join(settingsDir, 'settings.json');
  await mkdir(settingsDir, { mode: 0o700 });
  await chmod(settingsDir, 0o700);

  // 1. A disk edit after bootstrap cannot change capture cadence, even before an explicit setter.
  await writeFile(
    settingsFile,
    JSON.stringify({ scheme: 'mv-dark', density: 'compact', wallFps: 60, recordingFps: 25 }),
    { mode: 0o600 },
  );
  await chmod(settingsFile, 0o600);

  await bindings.core.request({
    op: 'capture',
    method: 'recordStart',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-disk-25',
      surface_id: 's1',
      mode: 'ai',
    },
  });
  assert.equal(requests.at(-1).body.params.max_fps, 3);
  assert.equal(bindings.core.recordingFps, 3);
  assert.equal(bindings.core.requestedWallFps, 30);
  await bindings.core.request({
    op: 'capture', method: 'export', request: {
      schema: 'capture_request/v1', request_id: 'req-disk-25-export',
      capture_id: 'rec-1', destination: 'recording:configured',
    },
  });
  assert.equal(requests.at(-1).body.params.max_fps, 3);
  assert.equal(bindings.core.recordingFps, 3);
  assert.equal(bindings.core.requestedWallFps, 30);

  // Bootstrap is an admitted hydration point: a fresh binding reads the persisted 25/60.
  const restarted = await createMainBindings({
    env, createMessageChannel: () => { throw new Error('no frames'); },
  });
  t.after(() => restarted.core.dispose());
  assert.equal(restarted.core.recordingFps, 25);
  assert.equal(restarted.core.requestedWallFps, 60);
  for (const method of ['recordStart', 'export']) {
    await restarted.core.request({
      op: 'capture', method, request: {
        schema: 'capture_request/v1', request_id: `req-restart-${method}`,
        ...(method === 'recordStart' ? { surface_id: 's1', mode: 'ai' }
          : { capture_id: 'rec-1', destination: 'recording:configured' }),
      },
    });
    assert.equal(requests.at(-1).body.params.max_fps, 25);
    assert.equal(restarted.core.recordingFps, 25);
    assert.equal(restarted.core.requestedWallFps, 60);
  }
  restarted.core.dispose();

  // 2. Save recording 18 through the wire, then rewrite disk to 9: effective stays 18.
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

  await handlers.get(WIRE_CHANNELS.saveSettings)(
    event,
    JSON.stringify({ scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 18 }),
  );
  assert.equal(bindings.core.recordingFps, 18);

  // Rewrite settings.json on disk behind the explicit set to recordingFps 9.
  await writeFile(
    settingsFile,
    JSON.stringify({ scheme: 'mv-light', density: 'compact', wallFps: 3, recordingFps: 9 }),
    { mode: 0o600 },
  );
  await chmod(settingsFile, 0o600);

  await bindings.core.request({
    op: 'capture',
    method: 'recordStart',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-explicit-wins-start',
      surface_id: 's1',
      mode: 'ai',
    },
  });
  assert.equal(requests.at(-1).body.params.max_fps, 18);
  assert.equal(bindings.core.recordingFps, 18);
  assert.equal(bindings.core.requestedWallFps, 30);

  await bindings.core.request({
    op: 'capture',
    method: 'export',
    request: {
      schema: 'capture_request/v1',
      request_id: 'req-explicit-wins-export',
      capture_id: 'rec-1',
      destination: 'recording:configured',
    },
  });
  assert.equal(requests.at(-1).body.params.max_fps, 18);
  assert.equal(bindings.core.recordingFps, 18);
  assert.equal(bindings.core.requestedWallFps, 30);

  // 3. Direct setRecordingFps and op: 'cadence' / setCadence / requestCadence accept 1 and 60 and throw on 0 and 61.
  bindings.core.setRecordingFps(1);
  assert.equal(bindings.core.recordingFps, 1);
  bindings.core.setRecordingFps(60);
  assert.equal(bindings.core.recordingFps, 60);

  assert.equal(await bindings.core.request({ op: 'cadence', wallFps: 3, recordingFps: 1 }), true);
  assert.equal(bindings.core.requestedWallFps, 3);
  assert.equal(bindings.core.recordingFps, 1);

  assert.equal(await bindings.core.request({ op: 'cadence', wallFps: 60, recordingFps: 60 }), true);
  assert.equal(bindings.core.requestedWallFps, 60);
  assert.equal(bindings.core.recordingFps, 60);

  for (const badRecFps of [0, 61, -1, 1.5, '18', null]) {
    assert.throws(
      () => bindings.core.setRecordingFps(/** @type {any} */ (badRecFps)),
      /SETTINGS_RECORDING_FPS/,
    );
    await assert.rejects(
      bindings.core.request({ op: 'cadence', recordingFps: badRecFps }),
      /SETTINGS_RECORDING_FPS/,
    );
    assert.throws(
      () => bindings.core.setCadence(/** @type {any} */ ({ recordingFps: badRecFps })),
      /SETTINGS_RECORDING_FPS/,
    );
    assert.throws(
      () => bindings.core.requestCadence(/** @type {any} */ ({ recordingFps: badRecFps })),
      /SETTINGS_RECORDING_FPS/,
    );
  }

  for (const badWallFps of [0, 1, 15, 45, 61, 30.5, '30', null]) {
    await assert.rejects(
      bindings.core.request({ op: 'cadence', wallFps: badWallFps }),
      /SETTINGS_WALL_FPS/,
    );
    assert.throws(
      () => bindings.core.setCadence(/** @type {any} */ ({ wallFps: badWallFps })),
      /SETTINGS_WALL_FPS/,
    );
    assert.throws(
      () => bindings.core.requestCadence(/** @type {any} */ ({ wallFps: badWallFps })),
      /SETTINGS_WALL_FPS/,
    );
  }
  assert.throws(() => bindings.core.setCadence(/** @type {any} */ (null)), /PAYLOAD/);
});

test('MUT-S5: reportDiag keeps per-session monotonic max, frame.diag merges without zeroing, and disabled path enforces checks', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'mv-mut-s5-'));
  await chmod(runDir, 0o700);
  t.after(() => rm(runDir, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
  };
  const frame = { origin: PRIVILEGED_ORIGIN, url: `${PRIVILEGED_ORIGIN}/index.html` };
  const contents = { id: 10, mainFrame: frame, isDestroyed: () => false };
  const validEvent = { sender: contents, senderFrame: frame };

  const diag = installFrameDiag({
    ipcMain,
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: runDir },
    runDir,
  });
  t.after(() => diag.dispose());

  // 1. Interleave two sender sessions A and B:
  // A reports (4, 9), B reports (6, 12), then A reporting (5, 10) is admitted while A reporting (3, 3) is refused.
  const sessionA = { id: 101 };
  const sessionB = { id: 202 };

  assert.deepEqual(
    diag.recordRehashDiag({ rehashSkipped: 4, rehashDone: 9 }, sessionA),
    { rehashSkipped: 4, rehashDone: 9 },
  );
  assert.deepEqual(
    diag.recordRehashDiag({ rehashSkipped: 6, rehashDone: 12 }, sessionB),
    { rehashSkipped: 6, rehashDone: 12 },
  );
  // Session A increasing from (4, 9) to (5, 10) must succeed even though session B is at (6, 12).
  assert.deepEqual(
    diag.recordRehashDiag({ rehashSkipped: 5, rehashDone: 10 }, sessionA),
    { rehashSkipped: 5, rehashDone: 10 },
  );
  // Session A decreasing from (5, 10) to (3, 3) must fail with FRAME_DIAG_DECREASE.
  assert.throws(
    () => diag.recordRehashDiag({ rehashSkipped: 3, rehashDone: 3 }, sessionA),
    /FRAME_DIAG_DECREASE/,
  );
  // Session B decreasing from (6, 12) to (5, 12) must fail with FRAME_DIAG_DECREASE.
  assert.throws(
    () => diag.recordRehashDiag({ rehashSkipped: 5, rehashDone: 12 }, sessionB),
    /FRAME_DIAG_DECREASE/,
  );

  // 2. frame.diag merge without zeroing:
  // Install a fresh diag collector, report (4, 9) via reportDiag, then post a full frame.diag snapshot without rehash keys.
  const mergeDir = await mkdtemp(join(tmpdir(), 'mv-mut-s5-merge-'));
  await chmod(mergeDir, 0o700);
  t.after(() => rm(mergeDir, { recursive: true, force: true }));

  const mergeHandlers = new Map();
  const mergeDiag = installFrameDiag({
    ipcMain: {
      handle: (ch, fn) => mergeHandlers.set(ch, fn),
      removeHandler: (ch) => mergeHandlers.delete(ch),
    },
    contents,
    env: { MV_FRAME_DIAG: '1', MV_FRAME_DIAG_DIR: mergeDir },
    runDir: mergeDir,
  });
  t.after(() => mergeDiag.dispose());

  const reportHandler = mergeHandlers.get(FRAME_REPORT_DIAG_CHANNEL);
  const frameDiagHandler = mergeHandlers.get(FRAME_DIAG_CHANNEL);
  assert.equal(typeof reportHandler, 'function');
  assert.equal(typeof frameDiagHandler, 'function');

  assert.equal(await reportHandler(validEvent, { rehashSkipped: 4, rehashDone: 9 }), true);
  assert.equal(/** @type {any} */ (mergeDiag.getSnapshot()).preload.rehashSkipped, 4);
  assert.equal(/** @type {any} */ (mergeDiag.getSnapshot()).preload.rehashDone, 9);

  // Full snapshot without rehashSkipped/rehashDone is admitted and keeps (4, 9).
  assert.equal(await frameDiagHandler(validEvent, { ...BASE_PRELOAD_DIAG }), true);
  assert.equal(/** @type {any} */ (mergeDiag.getSnapshot()).preload.rehashSkipped, 4);
  assert.equal(/** @type {any} */ (mergeDiag.getSnapshot()).preload.rehashDone, 9);

  // Full snapshot with only rehashSkipped: 10 merges to (10, 9), never zeroing rehashDone.
  assert.equal(
    await frameDiagHandler(validEvent, { ...BASE_PRELOAD_DIAG, rehashSkipped: 10 }),
    true,
  );
  assert.equal(/** @type {any} */ (mergeDiag.getSnapshot()).preload.rehashSkipped, 10);
  assert.equal(/** @type {any} */ (mergeDiag.getSnapshot()).preload.rehashDone, 9);

  // Explicit decrease on frame.diag is refused.
  await assert.rejects(
    frameDiagHandler(validEvent, { ...BASE_PRELOAD_DIAG, rehashSkipped: 9 }),
    /FRAME_DIAG_DECREASE/,
  );
  await assert.rejects(
    frameDiagHandler(validEvent, { ...BASE_PRELOAD_DIAG, rehashDone: 8 }),
    /FRAME_DIAG_DECREASE/,
  );

  // 3. Disabled install: recordRehashDiag refuses decrease and handleReportDiag refuses untrusted sender and decrease.
  const disabledHandlers = new Map();
  const disabledDiag = installFrameDiag({
    ipcMain: {
      handle: (ch, fn) => disabledHandlers.set(ch, fn),
      removeHandler: (ch) => disabledHandlers.delete(ch),
    },
    contents,
    env: { MV_FRAME_DIAG: '0' },
  });
  t.after(() => disabledDiag.dispose());

  assert.equal(disabledDiag.enabled, false);
  assert.deepEqual(
    disabledDiag.recordRehashDiag({ rehashSkipped: 4, rehashDone: 9 }),
    { rehashSkipped: 4, rehashDone: 9 },
  );
  assert.throws(
    () => disabledDiag.recordRehashDiag({ rehashSkipped: 3, rehashDone: 9 }),
    /FRAME_DIAG_DECREASE/,
  );

  assert.equal(
    await disabledDiag.handleReportDiag(validEvent, { rehashSkipped: 6, rehashDone: 11 }),
    true,
  );
  await assert.rejects(
    disabledDiag.handleReportDiag(validEvent, { rehashSkipped: 5, rehashDone: 11 }),
    /FRAME_DIAG_DECREASE/,
  );

  const untrustedFrame = { origin: 'https://evil.example', url: 'https://evil.example/index.html' };
  const otherContents = { id: 999, mainFrame: frame, isDestroyed: () => false };
  for (const badEvent of [
    { sender: contents, senderFrame: untrustedFrame },
    { sender: otherContents, senderFrame: frame },
    null,
  ]) {
    await assert.rejects(
      disabledDiag.handleReportDiag(badEvent, { rehashSkipped: 7, rehashDone: 12 }),
      /SENDER|ORIGIN|sender refused/,
    );
  }
});

test('PARITY-JS-BASELINE: shared fixture vectors for 1..60 bounds, defaults, and strict unknown-key refusals', async () => {
  const vectors = JSON.parse(await readFile(PARITY_FIXTURE_PATH, 'utf8'));

  assert.equal(DEFAULT_SETTINGS.recordingFps, vectors.contract_bounds.defaults.js_recording_fps);
  assert.equal(DEFAULT_SETTINGS.wallFps, vectors.contract_bounds.defaults.js_wall_fps);
  assert.equal(defaultMvSettings().recordingFps, vectors.contract_bounds.defaults.js_recording_fps);
  assert.equal(defaultMvSettings().wallFps, vectors.contract_bounds.defaults.js_wall_fps);

  for (const fps of vectors.d2_ceiling_sixty_vs_one_twenty.accepted_1_to_60) {
    const text = JSON.stringify({
      scheme: 'mv-light',
      density: 'compact',
      wallFps: 30,
      recordingFps: fps,
    });
    assert.equal(validateSettings(text).recordingFps, fps);
    const decoded = decodeMvSettings(text);
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.equal(decoded.settings.recordingFps, fps);
  }

  for (const badFps of vectors.d2_ceiling_sixty_vs_one_twenty.out_of_contract_fps) {
    const text = JSON.stringify({
      scheme: 'mv-light',
      density: 'compact',
      wallFps: 30,
      recordingFps: badFps,
    });
    assert.throws(() => validateSettings(text), /SETTINGS_RECORDING_FPS/);
    assert.equal(decodeMvSettings(text).ok, false);
  }

  for (const rawJson of [
    vectors.d4_unknown_keys.ui_prefs_unknown_key_json,
    vectors.d4_unknown_keys.ui_prefs_with_contract_limits_json,
  ]) {
    assert.throws(() => validateSettings(rawJson), /SETTINGS_UNKNOWN_KEY/);
    const decoded = decodeMvSettings(rawJson);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) assert.equal(decoded.error.code, 'ERR_SETTINGS_UNKNOWN_KEY');
  }
});

test(
  'PARITY-D2: recordingFps and capture max_fps accept contract-valid 61..120 per contracts/v0.2',
  { skip: 'FINDING D2' },
  async (t) => {
    const vectors = JSON.parse(await readFile(PARITY_FIXTURE_PATH, 'utf8'));
    const { env, requests } = await createUnixCoreFixture(t);
    const bindings = await createMainBindings({
      env,
      createMessageChannel: () => {
        throw new Error('no frames');
      },
    });
    t.after(() => bindings.core.dispose());

    for (const fps of vectors.d2_ceiling_sixty_vs_one_twenty.contract_valid_61_to_120) {
      const text = JSON.stringify({
        scheme: 'mv-light',
        density: 'compact',
        wallFps: 30,
        recordingFps: fps,
      });
      const decoded = decodeMvSettings(text);
      assert.equal(decoded.ok, true);
      assert.equal(validateSettings(text).recordingFps, fps);

      await bindings.core.request({
        op: 'capture',
        method: 'recordStart',
        request: {
          schema: 'capture_request/v1',
          request_id: `req-d2-${fps}`,
          surface_id: 's1',
          mode: 'ai',
          max_fps: fps,
        },
      });
      assert.equal(requests.at(-1).body.params.max_fps, fps);
    }
  },
);

test(
  'PARITY-D3 renderer FINDING: JSON float lexeme 30.0 is refused for recordingFps and wallFps per strict integer contract',
  { skip: 'FINDING D3' },
  async () => {
    const vectors = JSON.parse(await readFile(PARITY_FIXTURE_PATH, 'utf8'));
    const recFloatJson = vectors.d3_float_lexeme.ui_prefs_recording_30_0_json;
    const wallFloatJson = vectors.d3_float_lexeme.ui_prefs_wall_30_0_json;

    assert.equal(decodeMvSettings(recFloatJson).ok, false);

    assert.equal(decodeMvSettings(wallFloatJson).ok, false);
  },
);

test(
  'PARITY-D4: decodeStoredSettings refuses unknown keys and contract limits key like strict decode',
  { skip: 'FINDING D4' },
  async () => {
    const vectors = JSON.parse(await readFile(PARITY_FIXTURE_PATH, 'utf8'));
    for (const rawJson of [
      vectors.d4_unknown_keys.ui_prefs_unknown_key_json,
      vectors.d4_unknown_keys.ui_prefs_with_contract_limits_json,
    ]) {
      const stored = decodeStoredSettings(rawJson);
      assert.equal(stored.ok, false);
      if (!stored.ok) assert.equal(stored.error.code, 'ERR_SETTINGS_UNKNOWN_KEY');
    }
  },
);

test(
  'PARITY-D5 renderer FINDING: settings decode frozen settings/v0.2 limits.max_fps documents',
  { skip: 'FINDING D5' },
  async () => {
    const vectors = JSON.parse(await readFile(PARITY_FIXTURE_PATH, 'utf8'));
    for (const entry of vectors.d5_settings_limits.valid_settings_v02) {
      const rawJson = JSON.stringify(entry.doc);
      const decoded = decodeMvSettings(rawJson);
      assert.equal(decoded.ok, true);
    }
    for (const entry of vectors.d5_settings_limits.invalid_settings_v02) {
      const rawJson = JSON.stringify(entry.doc);
      assert.equal(decodeMvSettings(rawJson).ok, false);
    }
  },
);


test('PARITY-D3 host: integer lexemes survive JSON parsing', () => {
  for (const [key, code] of [['recordingFps', 'SETTINGS_RECORDING_FPS'], ['wallFps', 'SETTINGS_WALL_FPS']]) {
    for (const lexeme of ['30.0', '3e1', '30E+0', '30.000']) {
      assert.throws(() => validateSettings(`{"${key}":${lexeme}}`), new RegExp(code));
    }
    assert.equal(validateSettings(`{"${key}":30}`)[key], 30);
    assert.equal(validateSettings(`{"${key}":30.0,"${key}":30}`)[key], 30);
    assert.throws(() => validateSettings(`{"${key}":30,"${key}":30.0}`), new RegExp(code));
  }
  assert.throws(() => validateSettings('{"recording\\u0046ps":30.0}'), /SETTINGS_RECORDING_FPS/);
});

test('PARITY-D4 host: unknown stored keys default with typed diagnostic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mv-settings-load-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createSettingsStore({ XDG_CONFIG_HOME: root });
  await store.save(JSON.stringify({ recordingFps: 18 }));
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const notifications = [];
  const stop = store.subscribe(settings => notifications.push(settings));
  t.after(stop);
  const vectors = JSON.parse(await readFile(PARITY_FIXTURE_PATH, 'utf8'));
  for (const text of [vectors.d4_unknown_keys.ui_prefs_unknown_key_json,
    vectors.d4_unknown_keys.ui_prefs_with_contract_limits_json]) {
    await writeFile(join(root, 'metaviewer', 'settings.json'), text, { mode: 0o600 });
    assert.equal(await store.load(), null);
    assert.deepEqual(notifications.at(-1), { wallFps: DEFAULT_SETTINGS.wallFps, recordingFps: DEFAULT_SETTINGS.recordingFps });
    assert.match(warnings.at(-1), /SETTINGS_UNKNOWN_KEY/);
  }
});

test('PARITY-D5 host: decode complete frozen settings/v0.2 documents', async () => {
  const vectors = JSON.parse(await readFile(PARITY_FIXTURE_PATH, 'utf8'));
  for (const { doc } of vectors.d5_settings_limits.valid_settings_v02) {
    assert.deepEqual(decodeSettingsV02(JSON.stringify(doc)), doc);
    assert.equal(validateSettings(JSON.stringify(doc)).recordingFps, doc.limits.max_fps);
  }
  for (const { doc } of vectors.d5_settings_limits.invalid_settings_v02) {
    assert.throws(() => decodeSettingsV02(JSON.stringify(doc)));
    assert.throws(() => validateSettings(JSON.stringify(doc)));
  }
  const base = vectors.d5_settings_limits.valid_settings_v02[1].doc;
  const provider = { id: 'local:1', label: 'Local', enabled: true, model: 'model' };
  assert.deepEqual(decodeSettingsV02(JSON.stringify({ ...base, providers: [provider] })).providers, [provider]);
  const invalid = [
    { ...base, extra: true }, { ...base, schema: 'settings/v0.3' },
    { ...base, theme: 'mv-dark' }, { ...base, providers: Array(33).fill(provider) },
    ...[null, { ...provider, extra: 1 }, { ...provider, enabled: 1 },
      { ...provider, id: 'bad\n' }, { ...provider, label: '' },
      { ...provider, model: 'x'.repeat(257) }].map(p => ({ ...base, providers: [p] })),
    ...[{ capability_id: 'a', path: 'relative' }, { capability_id: 'a', path: '/bad\n' },
      { capability_id: 'a', path: '/ok', extra: 1 }].map(d => ({ ...base, recording_destination: d })),
    ...['memory_bytes', 'max_fps', 'ring_bytes'].flatMap(key =>
      [0, true, null, '30', 1073741825].map(value => ({ ...base, limits: { ...base.limits, [key]: value } }))),
    { ...base, limits: { ...base.limits, extra: 1 } },
  ];
  for (const doc of invalid) assert.throws(() => decodeSettingsV02(JSON.stringify(doc)));
  for (const key of ['memory_bytes', 'max_fps', 'ring_bytes']) {
    const text = JSON.stringify({ ...base, limits: { ...base.limits, [key]: 30 } });
    assert.throws(() => decodeSettingsV02(text.replace(`"${key}":30`, `"${key}":30.0`)));
  }
});
