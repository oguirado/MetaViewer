// MVUI33 lane S: the closed four-key settings store. Every save sends exactly
// {scheme, density, wallFps, recordingFps}; unknown keys are ignored on load
// and never sent on save; every field falls back to its default
// independently; old two-key files load with the new defaults. Hosted-safe:
// pure doubles only, no electron, socket or filesystem. Every behaviour ships
// with a negative control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MV_SETTINGS_KEYS,
  createHostSettingsStore,
  createMemorySettingsHost,
  decodeStoredSettings,
  defaultMvSettings,
  encodeMvSettings,
} from '../src/settings/settingsModel.js';

const FULL = { scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 12 };
const FULL_JSON = '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12}';

/**
 * @param {Array<{ op: string, json?: string }>} calls
 */
function savedPayloads(calls) {
  return calls.filter(call => call.op === 'save').map(call => /** @type {string} */ (call.json));
}

test('every save sends exactly the four closed keys in canonical order', async () => {
  const host = createMemorySettingsHost();
  const store = createHostSettingsStore(host);
  assert.equal(await store.save({ ...FULL }), true);
  assert.deepEqual(savedPayloads(host.calls), [FULL_JSON]);
  assert.deepEqual(Object.keys(JSON.parse(FULL_JSON)), [...MV_SETTINGS_KEYS]);
  assert.equal(await store.save({ scheme: 'mv-light' }), true);
  assert.deepEqual(
    savedPayloads(host.calls).at(-1),
    '{"scheme":"mv-light","density":"compact","wallFps":30,"recordingFps":3}',
  );
});

test('negative control: a save missing a key still lands whole, proving the shape comes from encode', async () => {
  const host = createMemorySettingsHost();
  const store = createHostSettingsStore(host);
  assert.equal(await store.save({ wallFps: 3 }), true);
  assert.deepEqual(JSON.parse(/** @type {string} */ (savedPayloads(host.calls).at(-1))), {
    scheme: 'mv-light',
    density: 'compact',
    wallFps: 3,
    recordingFps: 3,
  });
  assert.throws(
    () => assert.deepEqual(JSON.parse('{"wallFps":3}'), { scheme: 'mv-light' }),
    assert.AssertionError,
    'a partial expectation can fail',
  );
});

test('unknown keys refuse on load with full-default fallback and never send on save', async () => {
  const host = createMemorySettingsHost(
    '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12,"panel-width":320,"future":true}',
  );
  const store = createHostSettingsStore(host);
  await assert.rejects(store.load(), /ERR_SETTINGS_UNKNOWN_KEY/);
  assert.deepEqual({ ...(await store.load().catch(() => defaultMvSettings())) }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 });
  assert.equal(await store.save({ ...FULL }), true);
  for (const json of savedPayloads(host.calls)) {
    assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ['density', 'recordingFps', 'scheme', 'wallFps']);
  }
  await assert.rejects(store.save({ ...FULL, future: 1 }), /ERR_SETTINGS_UNKNOWN_KEY/);
});

test('negative control: the never-sent audit fails on a planted unknown key', () => {
  assert.throws(
    () => assert.deepEqual(Object.keys(JSON.parse('{"scheme":"mv-dark","future":1}')).sort(),
      ['density', 'recordingFps', 'scheme', 'wallFps']),
    assert.AssertionError,
    'the key audit can fail',
  );
});

test('out-of-range fps falls back per field while valid siblings survive', async () => {
  const cases = [
    ['{"wallFps":24}', { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 }],
    ['{"wallFps":60,"recordingFps":0}', { scheme: 'mv-light', density: 'compact', wallFps: 60, recordingFps: 3 }],
    ['{"wallFps":3,"recordingFps":61}', { scheme: 'mv-light', density: 'compact', wallFps: 3, recordingFps: 3 }],
    ['{"scheme":"mv-dark","wallFps":"30"}', { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 }],
    ['{"density":"comfortable","recordingFps":1.5}', {
      scheme: 'mv-light',
      density: 'comfortable',
      wallFps: 30,
      recordingFps: 3,
    }],
    ['{"recordingFps":1}', { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 1 }],
    ['{"recordingFps":60}', { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 60 }],
  ];
  for (const [text, expected] of cases) {
    const decoded = decodeStoredSettings(text);
    assert.equal(decoded.ok, true, text);
    assert.deepEqual(decoded.ok && { ...decoded.settings }, expected, text);
    const store = createHostSettingsStore(createMemorySettingsHost(text));
    assert.deepEqual({ ...(await store.load()) }, expected, text);
  }
});

test('negative control: in-range edges never fall back, proving the fallback above is selective', async () => {
  for (const text of ['{"wallFps":3}', '{"wallFps":60}', '{"recordingFps":1}', '{"recordingFps":60}']) {
    const store = createHostSettingsStore(createMemorySettingsHost(text));
    const loaded = await store.load();
    assert.deepEqual({ ...loaded }, { ...loaded, scheme: 'mv-light', density: 'compact' }, text);
    assert.notDeepEqual({ ...loaded }, { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 }, text);
  }
});

test('old two-key files load with the new defaults', async () => {
  for (const text of ['{"scheme":"mv-dark","density":"compact"}', '{"scheme":"mv-dark"}', '{}']) {
    const store = createHostSettingsStore(createMemorySettingsHost(text));
    const loaded = await store.load();
    assert.deepEqual(
      { ...loaded },
      {
        scheme: text.includes('mv-dark') ? 'mv-dark' : 'mv-light',
        density: 'compact',
        wallFps: 30,
        recordingFps: 3,
      },
      text,
    );
  }
});

test('negative control: a two-key file with a bad scheme still falls back, proving defaults are per field', async () => {
  const store = createHostSettingsStore(createMemorySettingsHost('{"scheme":"invented","density":"compact"}'));
  assert.deepEqual(
    { ...(await store.load()) },
    { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 },
  );
});

test('restart simulation: a new store instance loads four-key values saved through the double', async () => {
  const host = createMemorySettingsHost();
  const first = createHostSettingsStore(host);
  assert.equal(await first.save({ ...FULL }), true);
  const second = createHostSettingsStore(host);
  assert.deepEqual({ ...(await second.load()) }, FULL);
  assert.equal(encodeMvSettings({ ...FULL }), FULL_JSON);
});
