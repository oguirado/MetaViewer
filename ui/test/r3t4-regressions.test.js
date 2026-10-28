// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  validateSettings,
  createSettingsStore,
  recordingDestination,
  validateIntentBody,
  nestedIdentity,
} from '../electron/authorityWire.js';
import { installReadOnlyLayout } from '../electron/nesting.js';
import { installCaptureBridge } from '../electron/captureBridge.js';
import * as packaging from '../tools/package.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @param {string} prefix
 * @returns {string}
 */
function makeTempRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test('D3-SHUT: capture bridge disposal unwinds handlers and revokes subscriptions mid-flight', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(/** @type {string} */ channel, /** @type {Function} */ fn) {
      handlers.set(channel, fn);
    },
    removeHandler(/** @type {string} */ channel) {
      handlers.delete(channel);
    },
  };
  let revoked = false;
  const core = {
    async request() {
      return { ok: true };
    },
    subscribeCapture() {
      return () => {
        revoked = true;
      };
    },
  };
  const contents = {
    send() {},
  };

  const bridge = installCaptureBridge({
    ipcMain,
    contents,
    core,
    nested: false,
    env: {},
  });

  assert.equal(handlers.size, 7, 'all 7 capture channels installed');
  await bridge.dispose();
  assert.equal(handlers.size, 0, 'all capture channels removed on dispose');
  assert.equal(revoked, true, 'core capture subscription revoked on dispose');

  // Double dispose is idempotent
  await bridge.dispose();
  assert.equal(handlers.size, 0);
});

test('D3-RECTOK: recording destination resolves canonical external directory or null and refuses repo paths', async () => {
  const root = makeTempRoot('uiel-d3rectok-');
  try {
    const envConfigured = { MV_RECORDING_DESTINATION: root };
    assert.equal(recordingDestination(envConfigured), root);
    assert.equal(recordingDestination({ MV_RECORDING_DESTINATION: tmpdir() }), realpathSync(tmpdir()));

    const envUnset = {};
    assert.equal(recordingDestination(envUnset), null);

    // In-repo directory fails (explicit repo root via import.meta.url, never process.cwd())
    const envInRepo = { MV_RECORDING_DESTINATION: REPO_ROOT };
    assert.throws(() => recordingDestination(envInRepo), /SETTINGS_IN_REPO/);

    // Relative path fails
    const envRelative = { MV_RECORDING_DESTINATION: './relative/dir' };
    assert.throws(() => recordingDestination(envRelative), /SETTINGS_DESTINATION/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('D3-SETANC: dangling symlink in settings ancestors rejects with SETTINGS_DIRECTORY', async () => {
  const root = makeTempRoot('uiel-d3setanc-');
  try {
    const danglingLink = join(root, 'dangling-link');
    await symlink(join(root, 'non-existent-target'), danglingLink);
    const settingsPath = join(danglingLink, 'subfolder');

    const env = { XDG_CONFIG_HOME: settingsPath };
    const store = createSettingsStore(env);

    await assert.rejects(async () => store.load(), (err) => {
      assert.equal(/** @type {Error} */ (err).message, 'SETTINGS_DIRECTORY');
      return true;
    });

    await assert.rejects(
      async () => store.save(JSON.stringify({ scheme: 'mv-light', density: 'compact' })),
      (err) => {
        assert.equal(/** @type {Error} */ (err).message, 'SETTINGS_DIRECTORY');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('D3-SETSHAPE: settings store accepts exact closed shape and rejects unknown keys or bad values', async () => {
  const valid = validateSettings(JSON.stringify({ scheme: 'mv-light', density: 'compact' }));
  assert.deepEqual(valid, { scheme: 'mv-light', density: 'compact' });

  const partial = validateSettings(JSON.stringify({ scheme: 'mv-dark' }));
  assert.deepEqual(partial, { scheme: 'mv-dark', density: 'compact' });

  assert.throws(
    () => validateSettings(JSON.stringify({ scheme: 'mv-light', density: 'compact', extraKey: true })),
    /SETTINGS_UNKNOWN_KEY/,
  );

  assert.throws(() => validateSettings(JSON.stringify({ scheme: 'invalid-scheme' })), /SETTINGS_SCHEME/);
  assert.throws(() => validateSettings(JSON.stringify({ density: 'spacious' })), /SETTINGS_DENSITY/);
  assert.throws(() => validateSettings('["scheme", "mv-light"]'), /PAYLOAD/);
});

test('D3-RECABS: MV_RECORDING_DESTINATION must be absolute', async () => {
  assert.throws(() => recordingDestination({ MV_RECORDING_DESTINATION: 'relative/path' }), /SETTINGS_DESTINATION/);
  assert.throws(() => recordingDestination({ MV_RECORDING_DESTINATION: 'dir/subdir' }), /SETTINGS_DESTINATION/);
});

test('D3-ARCH: packageArchitecture admits arm64/x64 and verifyBinary pins ELF machine', async () => {
  assert.deepEqual(packaging.packageArchitecture('x64'), {
    arch: 'x64',
    machine: 62,
    archive: 'electron-v44.9.2-linux-x64.zip',
    name: 'MetaViewer-linux-x64',
  });
  assert.deepEqual(packaging.packageArchitecture('arm64'), {
    arch: 'arm64',
    machine: 183,
    archive: 'electron-v44.9.2-linux-arm64.zip',
    name: 'MetaViewer-linux-arm64',
  });
  assert.throws(() => packaging.packageArchitecture('ia32'), /PKG_ARCH_UNSUPPORTED/);

  const root = makeTempRoot('uiel-d3arch-');
  try {
    // Non-executable file throws PKG_BINARY_MISSING
    const nonExec = join(root, 'non-exec');
    await writeFile(nonExec, Buffer.from('NOT_EXECUTABLE'), { mode: 0o644 });
    await assert.rejects(async () => packaging.verifyBinary(nonExec, 'x64'), /PKG_BINARY_MISSING/);

    // Executable non-ELF file throws PKG_ARCH_MISMATCH
    const badBinary = join(root, 'bad-bin');
    await writeFile(badBinary, Buffer.from('NOT_AN_ELF_FILE'), { mode: 0o755 });
    await assert.rejects(async () => packaging.verifyBinary(badBinary, 'x64'), /PKG_ARCH_MISMATCH/);

    // Wrong machine ID throws PKG_ARCH_MISMATCH, matching machine ID succeeds
    const elfHeader = Buffer.alloc(64);
    elfHeader.write('\x7fELF', 0);
    elfHeader[4] = 2;
    elfHeader[5] = 1;
    elfHeader.writeUInt16LE(183, 18);
    const armBinary = join(root, 'arm-bin');
    await writeFile(armBinary, elfHeader, { mode: 0o755 });

    await assert.rejects(async () => packaging.verifyBinary(armBinary, 'x64'), /PKG_ARCH_MISMATCH/);
    await assert.doesNotReject(async () => packaging.verifyBinary(armBinary, 'arm64'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('D3-NESTBOOT: nested read-only bootstrap returns fixed answers and refuses privileged channels', async () => {
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
  const event = {
    sender: contents,
    senderFrame: frame,
  };

  installReadOnlyLayout(ipcMain, contents);

  const depthRes = await handlers.get('metaviewer:nested.depth')(event);
  assert.equal(depthRes, 1);

  const selfRes = await handlers.get('metaviewer:nested.self')(event);
  assert.equal(selfRes, null);

  const recRes = await handlers.get('metaviewer:recording.destination')(event);
  assert.equal(recRes, null);

  assert.throws(() => {
    handlers.get('metaviewer:settings.save')(event, '{}');
  }, /DISPLAY_ONLY/);
});

test('D3-INTENT: layout intents validate parameter shapes and ranges closed', async () => {
  const moveBody = {
    schema: 'ui_intent/v0.2',
    op: 'move',
    request_id: 'req1',
    params: { slot_id: 'slot1', group_id: 'grp1', index: 5 },
  };
  assert.deepEqual(validateIntentBody(moveBody), moveBody);

  assert.throws(
    () =>
      validateIntentBody({
        ...moveBody,
        params: { slot_id: 'slot1', group_id: 'grp1', index: -1 },
      }),
    /INTENT/,
  );

  const floatBody = {
    schema: 'ui_intent/v0.2',
    op: 'float',
    request_id: 'req1',
    params: { slot_id: 'slot1', x_px: 100, y_px: 100, width_px: 800, height_px: 600 },
  };
  assert.deepEqual(validateIntentBody(floatBody), floatBody);

  assert.throws(
    () =>
      validateIntentBody({
        ...floatBody,
        params: { ...floatBody.params, width_px: 0 },
      }),
    /INTENT/,
  );

  assert.throws(
    () =>
      validateIntentBody({
        ...floatBody,
        params: { ...floatBody.params, extra: 'bad' },
      }),
    /INTENT/,
  );
});

test('D3-KEEP: nested identity parses nested-depth flag', async () => {
  const res1 = nestedIdentity(['--nested-depth=1'], {});
  assert.deepEqual(res1, { depth: 1, self: null });

  const res0 = nestedIdentity(['--nested-depth=0'], {});
  assert.deepEqual(res0, { depth: 0, self: null });

  assert.throws(() => nestedIdentity(['--nested-depth=2'], {}), /NESTED_DEPTH/);
});
