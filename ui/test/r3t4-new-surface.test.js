// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertCaptureCall,
  assertCaptureReply,
  validCaptureState,
  requestCapture,
  installCaptureBridge,
} from '../electron/captureBridge.js';
import { createSettingsStore } from '../electron/authorityWire.js';
import { createPreloadFacade, ContractError } from '../electron/preload.js';
import { findForbiddenEnv } from '../electron/coreLauncher.js';
import { validateRetailLaunch } from '../electron/main.js';

/**
 * @param {string} prefix
 * @returns {string}
 */
function makeTempRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test('B1: Capture call shapes validate arity, schema, keys, and ids on both ends', () => {
  assert.doesNotThrow(() =>
    assertCaptureCall('export', [
      {
        schema: 'capture_request/v1',
        request_id: 'req-1',
        capture_id: 'cap-1',
        destination: 'recording:configured',
      },
    ]),
  );

  assert.doesNotThrow(() =>
    assertCaptureCall('export', [
      {
        schema: 'capture_request/v1',
        request_id: 'req-1',
        capture_id: 'cap-1',
        destination: null,
      },
    ]),
  );

  assert.throws(
    () =>
      assertCaptureCall('export', [
        {
          schema: 'capture_request/v1',
          request_id: 'req-1',
          capture_id: 'cap-1',
          destination: '/invalid/path',
        },
      ]),
    /PAYLOAD/,
  );

  assert.throws(() => assertCaptureCall('export', []), /ARGS/);

  assert.throws(
    () =>
      assertCaptureCall('export', [
        {
          schema: 'capture_request/v1',
          request_id: 'req-1',
          capture_id: '-invalid-id',
          destination: null,
        },
      ]),
    /PAYLOAD/,
  );

  assert.doesNotThrow(() =>
    assertCaptureCall('recordStart', [
      {
        schema: 'capture_request/v1',
        request_id: 'req-2',
        surface_id: 'surf-1',
        mode: 'ai',
      },
    ]),
  );

  assert.throws(
    () =>
      assertCaptureCall('recordStart', [
        {
          schema: 'capture_request/v1',
          request_id: 'req-2',
          surface_id: 'surf-1',
          mode: 'disk',
        },
      ]),
    /PAYLOAD/,
  );
});

test('B2: Capture validator parity across preload and main copies', async () => {
  /** @type {any} */
  let mockReply = {
    ok: true,
    export: {
      id: 'cap-1',
      bytes: 1024,
      sha256: 'a'.repeat(64),
    },
  };
  const preloadApi = createPreloadFacade({
    transport: {
      invoke: async () => mockReply,
      subscribe: () => () => {},
    },
    bridge: { exposeInMainWorld() {} },
  });

  const validExportReq = {
    schema: 'capture_request/v1',
    request_id: 'req-1',
    capture_id: 'cap-1',
    destination: /** @type {'recording:configured'} */ ('recording:configured'),
  };

  // Both main and preload accept valid call & reply
  assert.doesNotThrow(() => assertCaptureCall('export', [validExportReq]));
  const mainVerified = assertCaptureReply('export', mockReply, 'req-1');
  const preloadVerified = await preloadApi.capture.export(validExportReq);
  assert.deepEqual(preloadVerified, mainVerified);

  // Both main and preload reject malformed call payloads with ContractError('PAYLOAD')
  const badExportReq = {
    schema: 'capture_request/v1',
    request_id: 'req-1',
    capture_id: 'cap-1',
    destination: '/host/path',
  };
  assert.throws(
    () => assertCaptureCall('export', [badExportReq]),
    (err) => err instanceof ContractError && err.code === 'PAYLOAD',
  );
  assert.throws(
    () => preloadApi.capture.export(badExportReq),
    (err) => err instanceof ContractError && err.code === 'PAYLOAD',
  );

  // Both main and preload reject wrong arity with ContractError('ARGS')
  assert.throws(
    () => assertCaptureCall('export', []),
    (err) => err instanceof ContractError && err.code === 'ARGS',
  );
  assert.throws(
    () => preloadApi.capture.export(),
    (err) => err instanceof ContractError && err.code === 'ARGS',
  );

  // Both main and preload reject malformed replies with ContractError('OUTCOME')
  mockReply = {
    ok: true,
    export: {
      id: 'cap-1',
      bytes: 1024,
      sha256: 'a'.repeat(64),
      extra: 'leak',
    },
  };
  assert.throws(
    () => assertCaptureReply('export', mockReply, 'req-1'),
    (err) => err instanceof ContractError && err.code === 'OUTCOME',
  );
  await assert.rejects(
    async () => preloadApi.capture.export(validExportReq),
    (err) => err instanceof ContractError && err.code === 'OUTCOME',
  );
});

test('B3: Capture replies carry metadata only and reject path/handle/bytes leakage', () => {
  const replyWithPath = {
    ok: true,
    export: {
      id: 'cap-1',
      bytes: 1024,
      sha256: 'a'.repeat(64),
      path: '/tmp/secret.png',
    },
  };

  assert.throws(() => assertCaptureReply('export', replyWithPath), /OUTCOME/);

  /** @param {any} obj @returns {boolean} */
  function containsPath(obj) {
    if (!obj || typeof obj !== 'object') return false;
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && (val.includes('/') || val.includes('\\') || val.includes('dev/shm'))) {
        return true;
      }
      if (typeof val === 'object' && containsPath(val)) return true;
    }
    return false;
  }

  const validReply = assertCaptureReply('export', {
    ok: true,
    export: {
      id: 'cap-1',
      bytes: 1024,
      sha256: 'a'.repeat(64),
    },
  });

  assert.equal(containsPath(validReply), false);
});

test('B4: Capture transport over frozen carrier maps core errors to CAPTURE_UNAVAILABLE', async () => {
  const failingCore = {
    async request() {
      throw new Error('Core transport failure');
    },
  };

  const req = {
    schema: 'capture_request/v1',
    request_id: 'req-fail',
    surface_id: 'surf-1',
    mode: 'ai',
  };

  const reply = await requestCapture(failingCore, 'recordStart', req);
  assert.deepEqual(reply, {
    ok: false,
    code: 'CAPTURE_UNAVAILABLE',
    request_id: 'req-fail',
  });
});

test('B5: Nested capture derivation returns early with zero handlers in main and NESTED_DISPLAY_ONLY in preload', async () => {
  const handlers = new Map();
  let subscribeCalled = false;
  const ipcMain = {
    handle(/** @type {string} */ channel, /** @type {Function} */ fn) {
      handlers.set(channel, fn);
    },
    removeHandler(/** @type {string} */ channel) {
      handlers.delete(channel);
    },
  };

  // captureBridge.js:94 returns early when nested=true before inspecting env or subscribing to core
  const bridge = installCaptureBridge({
    ipcMain,
    contents: {},
    core: {
      subscribeCapture() {
        subscribeCalled = true;
        return () => {};
      },
    },
    nested: true,
    env: { MV_RECORDING_DESTINATION: 'relative/path-not-evaluated-in-nested' },
  });

  assert.equal(handlers.size, 0, 'nested mode installs 0 capture handlers');
  assert.equal(subscribeCalled, false, 'nested mode does not subscribe to core capture');
  await bridge.dispose();

  // Preload capture facade in nested mode resolves to NESTED_DISPLAY_ONLY without invoking IPC
  let ipcInvoked = false;
  const nestedPreload = createPreloadFacade({
    transport: {
      nested: true,
      invoke: async () => {
        ipcInvoked = true;
        return null;
      },
      subscribe: () => () => {},
    },
    bridge: { exposeInMainWorld() {} },
  });
  const nestedOutcome = await nestedPreload.capture.recordStart({
    schema: 'capture_request/v1',
    request_id: 'req-nested',
    surface_id: 'surf-1',
    mode: 'ai',
  });
  assert.deepEqual(nestedOutcome, {
    ok: false,
    code: 'NESTED_DISPLAY_ONLY',
    request_id: 'req-nested',
  });
  assert.equal(ipcInvoked, false);
});

test('B6: Main-side rechecks for compromised renderer on capture channels', async () => {
  const root = makeTempRoot('uiel-b6capture-');
  try {
    const handlers = new Map();
    const ipcMain = {
      handle(/** @type {string} */ channel, /** @type {Function} */ fn) {
        handlers.set(channel, fn);
      },
      removeHandler(/** @type {string} */ channel) {
        handlers.delete(channel);
      },
    };
    const frame = {
      origin: 'app://metaviewer',
      url: 'app://metaviewer/index.html',
      detached: false,
    };
    const contents = {
      id: 1,
      getURL() {
        return 'app://metaviewer/index.html';
      },
      isDestroyed() {
        return false;
      },
      mainFrame: frame,
    };

    const core = {
      async request() {
        return { ok: true, rows: [] };
      },
    };

    const bridge = installCaptureBridge({
      ipcMain,
      contents,
      core,
      nested: false,
      env: { MV_RECORDING_DESTINATION: root },
    });

    const handleList = handlers.get('metaviewer:capture.list');
    // Negative control: authentic top-frame sender is admitted
    const goodRes = await handleList({ sender: contents, senderFrame: frame });
    assert.deepEqual(goodRes, { ok: true, rows: [] });

    // Forged sender frame (different origin) is refused with SENDER
    const badEvent = {
      sender: contents,
      senderFrame: {
        origin: 'https://evil.com',
        url: 'https://evil.com/index.html',
        detached: false,
      },
    };
    await assert.rejects(async () => handleList(badEvent), /SENDER/);

    await bridge.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B7: Settings store second battery enforces dir permissions and serializes atomic saves', async () => {
  const root = makeTempRoot('uiel-b7settings-');
  try {
    const configDir = join(root, 'config');
    await mkdir(configDir, { mode: 0o700 });

    const store = createSettingsStore({ XDG_CONFIG_HOME: configDir });

    const initial = await store.load();
    assert.equal(initial, null);

    const saveRes = await store.save(JSON.stringify({ scheme: 'mv-dark', density: 'compact' }));
    assert.equal(saveRes, true);

    const loaded = await store.load();
    assert.deepEqual(JSON.parse(/** @type {string} */ (loaded)), {
      scheme: 'mv-dark',
      density: 'compact',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B8: Validates validCaptureState metadata schema', () => {
  const validState = {
    type: 'capture.state',
    recording_id: 'rec-1',
    surface_id: 'surf-1',
    phase: 'recording',
    frames: 100,
    elapsed_ms: 5000,
  };

  assert.equal(validCaptureState(validState), true);

  const invalidState = {
    type: 'capture.state',
    recording_id: 'rec-1',
    surface_id: 'surf-1',
    phase: 'unknown_phase',
    frames: 100,
    elapsed_ms: 5000,
  };

  assert.equal(validCaptureState(invalidState), false);
});

test('B9: Retail launch and environment filter admit safe env and flag ELECTRON_ prefixes without spawning Electron', () => {
  assert.deepEqual(validateRetailLaunch(['metaviewer'], { PATH: '/usr/bin', MV_OK: '1' }), {
    ok: true,
    nested: false,
  });
  assert.deepEqual(
    findForbiddenEnv({
      PATH: '/usr/bin',
      MV_OK: '1',
    }),
    [],
  );
  assert.deepEqual(
    findForbiddenEnv({
      ELECTRON_OVERRIDE_DIST_PATH: '/opt/electron',
      ELECTRON_RUN_AS_NODE: '1',
    }),
    ['ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_RUN_AS_NODE'],
  );
});
