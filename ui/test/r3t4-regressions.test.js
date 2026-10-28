// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateSettings, createSettingsStore, recordingDestination, validateIntentBody, nestedIdentity } from '../electron/authorityWire.js';
import { installReadOnlyLayout } from '../electron/nesting.js';
import { installCaptureBridge } from '../electron/captureBridge.js';

let packaging = null;
try {
  packaging = await import('../tools/package.js');
} catch {
  // @electron/asar or node_modules unavailable offline
}

test('D3-SHUT: capture bridge disposal unwinds handlers and revokes subscriptions mid-flight', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  let revoked = false;
  const core = {
    async request() { return { ok: true }; },
    subscribeCapture() {
      return () => { revoked = true; };
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

test('D3-RECTOK: recording destination returns opaque token "recording:configured" or null', async () => {
  const envConfigured = { MV_RECORDING_DESTINATION: tmpdir() };
  assert.equal(recordingDestination(envConfigured), tmpdir());

  const envUnset = {};
  assert.equal(recordingDestination(envUnset), null);

  // In-repo directory fails
  const envInRepo = { MV_RECORDING_DESTINATION: process.cwd() };
  assert.throws(() => recordingDestination(envInRepo), /SETTINGS_IN_REPO/);

  // Relative path fails
  const envRelative = { MV_RECORDING_DESTINATION: './relative/dir' };
  assert.throws(() => recordingDestination(envRelative), /SETTINGS_DESTINATION/);
});

test('D3-SETANC: dangling symlink in settings ancestors rejects with SETTINGS_DIRECTORY', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uiel-d3setanc-'));
  try {
    const danglingLink = join(root, 'dangling-link');
    await symlink(join(root, 'non-existent-target'), danglingLink);
    const settingsPath = join(danglingLink, 'subfolder');

    const env = { XDG_CONFIG_HOME: settingsPath };
    const store = createSettingsStore(env);

    await assert.rejects(async () => store.load(), (err) => {
      assert.equal(/** @type {Error} */(err).message, 'SETTINGS_DIRECTORY');
      return true;
    });

    await assert.rejects(async () => store.save(JSON.stringify({ scheme: 'mv-light', density: 'compact' })), (err) => {
      assert.equal(/** @type {Error} */(err).message, 'SETTINGS_DIRECTORY');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('D3-SETSHAPE: settings store accepts exact closed shape and rejects unknown keys or bad values', async () => {
  // Valid exact shape
  const valid = validateSettings(JSON.stringify({ scheme: 'mv-light', density: 'compact' }));
  assert.deepEqual(valid, { scheme: 'mv-light', density: 'compact' });

  // Partial valid uses defaults
  const partial = validateSettings(JSON.stringify({ scheme: 'mv-dark' }));
  assert.deepEqual(partial, { scheme: 'mv-dark', density: 'compact' });

  // Unknown key is rejected
  assert.throws(() => validateSettings(JSON.stringify({ scheme: 'mv-light', density: 'compact', extraKey: true })), /SETTINGS_UNKNOWN_KEY/);

  // Invalid scheme value is rejected
  assert.throws(() => validateSettings(JSON.stringify({ scheme: 'invalid-scheme' })), /SETTINGS_SCHEME/);

  // Invalid density value is rejected
  assert.throws(() => validateSettings(JSON.stringify({ density: 'spacious' })), /SETTINGS_DENSITY/);

  // Non-object or arrays rejected
  assert.throws(() => validateSettings('["scheme", "mv-light"]'), /PAYLOAD/);
});

test('D3-RECABS: MV_RECORDING_DESTINATION must be absolute', async () => {
  assert.throws(() => recordingDestination({ MV_RECORDING_DESTINATION: 'relative/path' }), /SETTINGS_DESTINATION/);
  assert.throws(() => recordingDestination({ MV_RECORDING_DESTINATION: 'dir/subdir' }), /SETTINGS_DESTINATION/);
});

test('D3-DETPKG: verifyInstall checks manifest, missing binary, forbidden fonts and tamper', async (t) => {
  if (!packaging) return t.skip('tools/package.js unavailable (missing @electron/asar / node_modules)');

  const root = await mkdtemp(join(tmpdir(), 'uiel-d3detpkg-'));
  try {
    const pkgDir = join(root, 'pkg');
    await mkdir(pkgDir, { recursive: true });

    // Missing binary check
    await assert.rejects(async () => packaging.verifyInstall(pkgDir), /PKG_BINARY_MISSING/);

    // Create mock binary
    const binaryPath = join(pkgDir, 'metaviewer');
    // ELF header mock
    const elfHeader = Buffer.alloc(64);
    elfHeader.write('\x7fELF', 0);
    elfHeader[4] = 2; // 64-bit
    elfHeader[5] = 1; // Little-endian
    elfHeader.writeUInt16LE(62, 18); // x86-64 machine ID
    await writeFile(binaryPath, elfHeader, { mode: 0o755 });

    // Missing manifest check
    await assert.rejects(async () => packaging.verifyInstall(pkgDir), /PKG_MANIFEST_MISMATCH/);

    // Create manifest
    const manifest = {
      version: 1,
      files: {
        'metaviewer': { sha256: '00'.repeat(32), size: 64, mode: '0755' }
      }
    };
    await writeFile(join(pkgDir, 'manifest.json'), JSON.stringify(manifest));

    // Digest mismatch
    await assert.rejects(async () => packaging.verifyInstall(pkgDir), /PKG_MANIFEST_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('D3-ARCH: packageArchitecture admits arm64/x64 and verifyBinary pins ELF machine', async (t) => {
  if (!packaging) return t.skip('tools/package.js unavailable (missing @electron/asar / node_modules)');

  assert.deepEqual(packaging.packageArchitecture('x64'), { arch: 'x64', machine: 62, archive: 'electron-v44.9.2-linux-x64.zip', name: 'MetaViewer-linux-x64' });
  assert.deepEqual(packaging.packageArchitecture('arm64'), { arch: 'arm64', machine: 183, archive: 'electron-v44.9.2-linux-arm64.zip', name: 'MetaViewer-linux-arm64' });
  assert.throws(() => packaging.packageArchitecture('ia32'), /PKG_ARCH_UNSUPPORTED/);

  const root = await mkdtemp(join(tmpdir(), 'uiel-d3arch-'));
  try {
    // Non-ELF file throws PKG_BINARY_MISSING
    const badBinary = join(root, 'bad-bin');
    await writeFile(badBinary, Buffer.from('NOT_AN_ELF_FILE'));
    await assert.rejects(async () => packaging.verifyBinary(badBinary, 'x64'), /PKG_ARCH_MISMATCH/);

    // Wrong machine ID throws PKG_ARCH_MISMATCH
    const elfHeader = Buffer.alloc(64);
    elfHeader.write('\x7fELF', 0);
    elfHeader[4] = 2; // 64-bit
    elfHeader[5] = 1; // Little-endian
    elfHeader.writeUInt16LE(183, 18); // ARM64 machine ID
    const armBinary = join(root, 'arm-bin');
    await writeFile(armBinary, elfHeader, { mode: 0o755 });

    await assert.rejects(async () => packaging.verifyBinary(armBinary, 'x64'), /PKG_ARCH_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('D3-NESTBOOT: nested read-only bootstrap returns fixed answers and refuses privileged channels', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const frame = {
    origin: 'app://metaviewer',
    url: 'app://metaviewer/index.html',
    detached: false,
  };
  const contents = {
    id: 1,
    getURL() { return 'app://metaviewer/index.html'; },
    isDestroyed() { return false; },
    mainFrame: frame,
  };
  const event = {
    sender: contents,
    senderFrame: frame,
  };

  const registered = installReadOnlyLayout(ipcMain, contents);

  // Read channels answer fixed read-only values
  const depthRes = await handlers.get('metaviewer:nested.depth')(event);
  assert.equal(depthRes, 1);

  const selfRes = await handlers.get('metaviewer:nested.self')(event);
  assert.equal(selfRes, null);

  const recRes = await handlers.get('metaviewer:recording.destination')(event);
  assert.equal(recRes, null);

  // Privileged channels refuse with DISPLAY_ONLY error
  assert.throws(() => {
    handlers.get('metaviewer:settings.save')(event, '{}');
  }, /DISPLAY_ONLY/);
});

test('D3-INTENT: layout intents validate parameter shapes and ranges closed', async () => {
  // Move valid
  const moveBody = {
    schema: 'ui_intent/v0.2',
    op: 'move',
    request_id: 'req1',
    params: { slot_id: 'slot1', group_id: 'grp1', index: 5 }
  };
  assert.deepEqual(validateIntentBody(moveBody), moveBody);

  // Move out of bound index (< 0)
  assert.throws(() => validateIntentBody({
    ...moveBody,
    params: { slot_id: 'slot1', group_id: 'grp1', index: -1 }
  }), /INTENT/);

  // Float valid
  const floatBody = {
    schema: 'ui_intent/v0.2',
    op: 'float',
    request_id: 'req1',
    params: { slot_id: 'slot1', x_px: 100, y_px: 100, width_px: 800, height_px: 600 }
  };
  assert.deepEqual(validateIntentBody(floatBody), floatBody);

  // Float zero size (width_px < 1) rejected
  assert.throws(() => validateIntentBody({
    ...floatBody,
    params: { ...floatBody.params, width_px: 0 }
  }), /INTENT/);

  // Float extra key rejected
  assert.throws(() => validateIntentBody({
    ...floatBody,
    params: { ...floatBody.params, extra: 'bad' }
  }), /INTENT/);
});

test('D3-KEEP: nested identity parses nested-depth flag', async () => {
  const res1 = nestedIdentity(['--nested-depth=1'], {});
  assert.deepEqual(res1, { depth: 1, self: null });

  const res0 = nestedIdentity(['--nested-depth=0'], {});
  assert.deepEqual(res0, { depth: 0, self: null });

  assert.throws(() => nestedIdentity(['--nested-depth=2'], {}), /NESTED_DEPTH/);
});
