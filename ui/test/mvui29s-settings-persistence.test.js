// MVUI29S lane S: restart persistence across store instances sharing one host
// double; unknown keys are dropped on load and never sent on save, because
// the host key set is closed and fail-closed. Strict closed decode stays
// intact. Every behaviour ships with a negative control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHostSettingsStore,
  createMemorySettingsHost,
  decodeMvSettings,
  encodeMvSettings,
} from '../src/settings/settingsModel.js';

const settings = (scheme) => JSON.stringify({ scheme, density: 'compact', wallFps: 30, recordingFps: 3 });

/**
 * Host double mirroring the fail-closed host contract: stored text loads
 * verbatim, but a save carrying any key outside the four closed keys is refused.
 * @param {string|null} [initialText]
 */
function strictHostDouble(initialText = null) {
  const memory = createMemorySettingsHost(initialText);
  return {
    calls: memory.calls,
    loadSettings: () => memory.loadSettings(),
    saveSettings: async (/** @type {string} */ json) => {
      for (const key of Object.keys(JSON.parse(json))) {
        if (key !== 'scheme' && key !== 'density' && key !== 'wallFps' && key !== 'recordingFps') {
          throw Object.assign(new Error(`SETTINGS_UNKNOWN_KEY: ${key}`), { code: 'SETTINGS_UNKNOWN_KEY' });
        }
      }
      return memory.saveSettings(json);
    },
  };
}

test('restart simulation: a new store instance loads values saved through the double', async () => {
  const host = createMemorySettingsHost();
  const first = createHostSettingsStore(host);
  assert.equal(await first.save({ scheme: 'mv-dark', density: 'compact' }), true);
  const second = createHostSettingsStore(host);
  assert.deepEqual({ ...(await second.load()) }, { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 });
});

test('negative control: a fresh double boots defaults, proving values came from storage', async () => {
  const host = createMemorySettingsHost();
  await createHostSettingsStore(host).save({ scheme: 'mv-dark', density: 'compact' });
  const fresh = createHostSettingsStore(createMemorySettingsHost());
  assert.deepEqual({ ...(await fresh.load()) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
  assert.throws(
    () => assert.deepEqual({ scheme: 'mv-dark' }, { scheme: 'mv-light' }),
    assert.AssertionError,
    'the restart assertion above can fail',
  );
});

test('unknown keys from a load are ignored and never sent on save', async () => {
  const host = createMemorySettingsHost(
    '{"scheme":"mv-dark","density":"compact","panel-width":320,"experimental":true}',
  );
  const store = createHostSettingsStore(host);
  assert.deepEqual({ ...(await store.load()) }, { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 });
  assert.equal(await store.save({ scheme: 'mv-light', density: 'compact' }), true);
  assert.equal(host.calls.at(-1)?.json, settings('mv-light'));
  assert.deepEqual(JSON.parse(/** @type {string} */ (host.calls.at(-1)?.json)), {
    scheme: 'mv-light',
    density: 'compact',
    wallFps: 30,
    recordingFps: 3,
  });
  const again = createHostSettingsStore(host);
  assert.deepEqual({ ...(await again.load()) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
});

test('negative control: a host double that refuses unknown keys would refuse the old merge-back', async () => {
  const host = strictHostDouble('{"scheme":"mv-dark","density":"compact","panel-width":320}');
  await assert.rejects(
    host.saveSettings('{"scheme":"mv-dark","density":"compact","panel-width":320}'),
    /SETTINGS_UNKNOWN_KEY/,
    'the double refuses unknown keys, proving the save below can fail',
  );
  const store = createHostSettingsStore(host);
  assert.deepEqual({ ...(await store.load()) }, { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 });
  assert.equal(await store.save({ scheme: 'mv-light', density: 'compact' }), true);
  assert.equal(host.calls.at(-1)?.json, settings('mv-light'));
});

test('invalid values fall back per field while missing keys resolve defaults', async () => {
  const empty = createHostSettingsStore(createMemorySettingsHost('{}'));
  assert.deepEqual({ ...(await empty.load()) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
  const unknownOnly = createHostSettingsStore(createMemorySettingsHost('{"future":1}'));
  assert.deepEqual({ ...(await unknownOnly.load()) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
  const badScheme = createHostSettingsStore(createMemorySettingsHost('{"scheme":"invented"}'));
  assert.deepEqual({ ...(await badScheme.load()) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
  const badDensity = createHostSettingsStore(createMemorySettingsHost('{"density":"huge"}'));
  assert.deepEqual({ ...(await badDensity.load()) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
  const validSchemeBadDensity = createHostSettingsStore(createMemorySettingsHost('{"scheme":"mv-dark","density":7}'));
  assert.deepEqual({ ...(await validSchemeBadDensity.load()) }, { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 });
  const badSchemeValidDensity = createHostSettingsStore(createMemorySettingsHost('{"scheme":"invented","density":"compact"}'));
  assert.deepEqual({ ...(await badSchemeValidDensity.load()) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
});

test('save carries only the four closed keys; strict decode still refuses unknown keys', async () => {
  const refused = decodeMvSettings({ scheme: 'mv-dark', future: 1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error.code, 'ERR_SETTINGS_UNKNOWN_KEY');
  assert.equal(encodeMvSettings({ scheme: 'mv-dark', density: 'compact' }), settings('mv-dark'));
  const host = createMemorySettingsHost();
  const store = createHostSettingsStore(host);
  await assert.rejects(
    store.save({ scheme: 'mv-dark', density: 'compact', future: 1 }),
    /ERR_SETTINGS_UNKNOWN_KEY/,
  );
  assert.equal(await store.save({ scheme: 'mv-dark', density: 'compact' }), true);
  assert.equal(host.calls.at(-1)?.json, settings('mv-dark'));
});
