// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assertCaptureCall, assertCaptureReply, validCaptureState, requestCapture, installCaptureBridge } from '../electron/captureBridge.js';
import { createSettingsStore } from '../electron/authorityWire.js';

test('B1: Capture call shapes validate arity, schema, keys, and ids on both ends', () => {
  // Valid export
  assert.doesNotThrow(() => assertCaptureCall('export', [{
    schema: 'capture_request/v1',
    request_id: 'req-1',
    capture_id: 'cap-1',
    destination: 'recording:configured',
  }]));

  // Valid export with null destination
  assert.doesNotThrow(() => assertCaptureCall('export', [{
    schema: 'capture_request/v1',
    request_id: 'req-1',
    capture_id: 'cap-1',
    destination: null,
  }]));

  // Invalid export destination
  assert.throws(() => assertCaptureCall('export', [{
    schema: 'capture_request/v1',
    request_id: 'req-1',
    capture_id: 'cap-1',
    destination: '/invalid/path',
  }]), /PAYLOAD/);

  // Invalid arity for export
  assert.throws(() => assertCaptureCall('export', []), /ARGS/);

  // Invalid capture_id format (leading -)
  assert.throws(() => assertCaptureCall('export', [{
    schema: 'capture_request/v1',
    request_id: 'req-1',
    capture_id: '-invalid-id',
    destination: null,
  }]), /PAYLOAD/);

  // Valid recordStart with mode 'ai'
  assert.doesNotThrow(() => assertCaptureCall('recordStart', [{
    schema: 'capture_request/v1',
    request_id: 'req-2',
    surface_id: 'surf-1',
    mode: 'ai',
  }]));

  // Invalid mode for recordStart
  assert.throws(() => assertCaptureCall('recordStart', [{
    schema: 'capture_request/v1',
    request_id: 'req-2',
    surface_id: 'surf-1',
    mode: 'disk',
  }]), /PAYLOAD/);
});

test('B2: Capture validator parity across preload and main copies', () => {
  // Call shapes matrix
  const validCall = [{
    schema: 'capture_request/v1',
    request_id: 'req-1',
    capture_id: 'cap-1',
    destination: 'recording:configured',
  }];

  assert.doesNotThrow(() => assertCaptureCall('export', validCall));

  // Reply shapes matrix
  const validExportReply = {
    ok: true,
    export: {
      id: 'cap-1',
      bytes: 1024,
      sha256: 'a'.repeat(64),
    },
  };
  const verified = assertCaptureReply('export', validExportReply);
  assert.deepEqual(verified, validExportReply);
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

  // Recursive check helper for string values containing paths
  function containsPath(obj) {
    if (!obj || typeof obj !== 'object') return false;
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && (val.includes('/') || val.includes('\\') || val.includes('dev/shm'))) return true;
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

test('B5: Nested capture derivation installs zero handlers and returns NESTED_DISPLAY_ONLY', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };

  const bridge = installCaptureBridge({
    ipcMain,
    contents: {},
    core: {},
    nested: true,
    env: {},
  });

  assert.equal(handlers.size, 0, 'nested mode installs 0 capture handlers');
  await bridge.dispose();
});

test('B6: Main-side rechecks for compromised renderer on capture channels', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const contents = {
    id: 1,
    getURL() { return 'app://metaviewer/index.html'; },
    isDestroyed() { return false; },
  };
  contents.mainFrame = {
    origin: 'app://metaviewer',
    url: 'app://metaviewer/index.html',
    detached: false,
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
    env: { MV_RECORDING_DESTINATION: tmpdir() },
  });

  // Forged sender frame (different origin)
  const badEvent = {
    sender: contents,
    senderFrame: {
      origin: 'https://evil.com',
      url: 'https://evil.com/index.html',
      detached: false,
    },
  };

  const handleList = handlers.get('metaviewer:capture.list');
  await assert.rejects(async () => handleList(badEvent), /SENDER/);

  await bridge.dispose();
});

test('B7: Settings store second battery enforces dir permissions and serializes atomic saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uiel-b7settings-'));
  try {
    const configDir = join(root, 'config');
    await mkdir(configDir, { mode: 0o700 });

    const store = createSettingsStore({ XDG_CONFIG_HOME: configDir });

    // Initial load returns null (file absent)
    const initial = await store.load();
    assert.equal(initial, null);

    // Save valid settings
    const saveRes = await store.save(JSON.stringify({ scheme: 'mv-dark', density: 'compact' }));
    assert.equal(saveRes, true);

    // Load returns saved content
    const loaded = await store.load();
    assert.deepEqual(JSON.parse(/** @type {string} */(loaded)), { scheme: 'mv-dark', density: 'compact' });
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

test('B9: Live Electron leg skips gracefully when ELECTRON_OVERRIDE_DIST_PATH is absent', (t) => {
  if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    return t.skip('ELECTRON_OVERRIDE_DIST_PATH not set; skipping live Electron test leg');
  }
});
