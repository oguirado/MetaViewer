// MetaViewer settings model (mvui33): closed decode, strict encode, host
// store, memory double, actual-fps meter and typed refusals. Every behaviour
// ships with a negative control proving the assertion can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MV_DEFAULT_RECORDING_FPS,
  MV_DEFAULT_WALL_FPS,
  MV_DENSITIES,
  MV_DENSITY,
  MV_PRIMARY_SCHEME,
  MV_RECORDING_FPS_MAX,
  MV_RECORDING_FPS_MIN,
  MV_SCHEMES,
  MV_SETTINGS_ANCHORS,
  MV_SETTINGS_IDS,
  MV_SETTINGS_KEYS,
  MV_WALL_FPS_VALUES,
  createHostSettingsStore,
  createMemorySettingsHost,
  createWallFpsMeter,
  decodeMvSettings,
  defaultMvSettings,
  encodeMvSettings,
  formatWallFpsLine,
  isMvDensity,
  isMvRecordingFps,
  isMvScheme,
  isMvWallFps,
  mvDensityOptionAnchor,
  mvDensityOptionDomId,
  mvSchemeOptionAnchor,
  mvSchemeOptionDomId,
  mvWallFpsOptionAnchor,
  mvWallFpsOptionDomId,
  normalizeDensity,
  normalizeRecordingFps,
  normalizeScheme,
  normalizeWallFps,
  settingsRefusalFor,
} from '../src/settings/settingsModel.js';

test('scheme vocabulary is the closed mv-light/mv-dark set, light primary', () => {
  assert.deepEqual([...MV_SCHEMES], ['mv-light', 'mv-dark']);
  assert.equal(MV_PRIMARY_SCHEME, 'mv-light');
  assert.equal(MV_DENSITY, 'compact');
  assert.equal(isMvScheme('mv-light'), true);
  assert.equal(isMvScheme('mv-dark'), true);
  for (const bad of [undefined, null, '', 'light', 'dark', 'system', 'MV-LIGHT', 0]) {
    assert.equal(isMvScheme(bad), false);
  }
  assert.equal(normalizeScheme('mv-dark'), 'mv-dark');
  assert.equal(normalizeScheme('dark'), 'mv-light');
  assert.equal(normalizeScheme('dark', 'mv-dark'), 'mv-dark');
  assert.equal(normalizeScheme('dark', 'bogus'), 'mv-light');
});

test('density vocabulary is the closed compact/comfortable set, compact default', () => {
  assert.deepEqual([...MV_DENSITIES], ['compact', 'comfortable']);
  assert.equal(isMvDensity('compact'), true);
  assert.equal(isMvDensity('comfortable'), true);
  for (const bad of [undefined, null, '', 'regular', 'huge', 'COMPACT', 0]) {
    assert.equal(isMvDensity(bad), false);
  }
  assert.equal(normalizeDensity('comfortable'), 'comfortable');
  assert.equal(normalizeDensity('regular'), 'compact');
  assert.equal(normalizeDensity('regular', 'comfortable'), 'comfortable');
  assert.equal(normalizeDensity('regular', 'bogus'), 'compact');
});

test('fps vocabularies are the closed wall presets and the 1..60 recording range', () => {
  assert.deepEqual([...MV_WALL_FPS_VALUES], [3, 30, 60]);
  assert.equal(MV_DEFAULT_WALL_FPS, 30);
  assert.equal(MV_RECORDING_FPS_MIN, 1);
  assert.equal(MV_RECORDING_FPS_MAX, 60);
  assert.equal(MV_DEFAULT_RECORDING_FPS, 3);
  for (const good of [3, 30, 60]) assert.equal(isMvWallFps(good), true);
  for (const bad of [undefined, null, 0, 1, 2, 4, 29, 31, 59, 61, 30.5, '30', Number.NaN]) {
    assert.equal(isMvWallFps(bad), false);
  }
  for (const good of [1, 3, 30, 60]) assert.equal(isMvRecordingFps(good), true);
  for (const bad of [undefined, null, 0, 61, -1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isMvRecordingFps(bad), false);
  }
  assert.equal(normalizeWallFps(60), 60);
  assert.equal(normalizeWallFps(24), 30);
  assert.equal(normalizeWallFps(24, 60), 60);
  assert.equal(normalizeWallFps(24, 24), 30);
  assert.equal(normalizeRecordingFps(12), 12);
  assert.equal(normalizeRecordingFps(0), 3);
  assert.equal(normalizeRecordingFps(99, 12), 12);
  assert.equal(normalizeRecordingFps(99, 99), 3);
});

test('the closed key set is exactly scheme, density, wallFps and recordingFps', () => {
  assert.deepEqual([...MV_SETTINGS_KEYS], ['scheme', 'density', 'wallFps', 'recordingFps']);
});

test('default settings are frozen light/compact/30/3', () => {
  assert.deepEqual(
    { ...defaultMvSettings() },
    { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 },
  );
  assert.equal(Object.isFrozen(defaultMvSettings()), true);
});

test('closed decode accepts objects, JSON text and partial values', () => {
  assert.deepEqual(decodeMvSettings({ scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 12 }), {
    ok: true,
    settings: { scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 12 },
  });
  assert.deepEqual(decodeMvSettings('{"scheme":"mv-dark"}'), {
    ok: true,
    settings: { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 },
  });
  assert.deepEqual(decodeMvSettings({}), {
    ok: true,
    settings: { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 },
  });
});

test('closed decode refuses unknown keys, values and malformed input', () => {
  const unknownKey = decodeMvSettings({ scheme: 'mv-dark', font: 'x' });
  assert.equal(unknownKey.ok, false);
  assert.equal(unknownKey.ok === false && unknownKey.error.code, 'ERR_SETTINGS_UNKNOWN_KEY');
  const badScheme = decodeMvSettings({ scheme: 'dark' });
  assert.equal(badScheme.ok === false && badScheme.error.code, 'ERR_SETTINGS_UNKNOWN_SCHEME');
  const badDensity = decodeMvSettings({ density: 'regular' });
  assert.equal(badDensity.ok === false && badDensity.error.code, 'ERR_SETTINGS_UNKNOWN_DENSITY');
  const badWallFps = decodeMvSettings({ wallFps: 24 });
  assert.equal(badWallFps.ok === false && badWallFps.error.code, 'ERR_SETTINGS_UNKNOWN_WALL_FPS');
  const badRecordingFps = decodeMvSettings({ recordingFps: 0 });
  assert.equal(badRecordingFps.ok === false && badRecordingFps.error.code, 'ERR_SETTINGS_UNKNOWN_RECORDING_FPS');
  for (const malformed of ['{nope', '42', 'null', '[]', 42, null, undefined, [], ['mv-dark']]) {
    const decoded = decodeMvSettings(malformed);
    assert.equal(decoded.ok, false, `expected refusal for ${String(malformed)}`);
    assert.equal(decoded.ok === false && decoded.error.code, 'ERR_SETTINGS_MALFORMED');
  }
});

test('strict encode is canonical and throws coded errors on invalid input', () => {
  assert.equal(
    encodeMvSettings({ scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 12 }),
    '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12}',
  );
  assert.equal(
    encodeMvSettings({ scheme: 'mv-dark' }),
    '{"scheme":"mv-dark","density":"compact","wallFps":30,"recordingFps":3}',
  );
  assert.throws(() => encodeMvSettings({ scheme: 'dark' }), /ERR_SETTINGS_UNKNOWN_SCHEME/);
  assert.throws(() => encodeMvSettings({ wallFps: 24 }), /ERR_SETTINGS_UNKNOWN_WALL_FPS/);
  assert.throws(() => encodeMvSettings({ recordingFps: 61 }), /ERR_SETTINGS_UNKNOWN_RECORDING_FPS/);
  assert.throws(() => encodeMvSettings(null), /ERR_SETTINGS_MALFORMED/);
});

test('store creation validates the injected host shape eagerly', () => {
  const host = createMemorySettingsHost();
  assert.equal(typeof createHostSettingsStore(host).load, 'function');
  for (const bad of [null, undefined, {}, { loadSettings: async () => null }, { saveSettings: async () => true }]) {
    assert.throws(() => createHostSettingsStore(/** @type {any} */ (bad)), /ERR_SETTINGS_HOST/);
  }
});

test('store loads defaults when absent and decodes stored text', async () => {
  const empty = createHostSettingsStore(createMemorySettingsHost());
  assert.deepEqual(
    { ...(await empty.load()) },
    { scheme: 'mv-light', density: 'compact', wallFps: 30, recordingFps: 3 },
  );
  const stored = createHostSettingsStore(createMemorySettingsHost('{"scheme":"mv-dark"}'));
  assert.deepEqual(
    { ...(await stored.load()) },
    { scheme: 'mv-dark', density: 'compact', wallFps: 30, recordingFps: 3 },
  );
  const broken = createHostSettingsStore(createMemorySettingsHost('{nope'));
  await assert.rejects(broken.load(), /ERR_SETTINGS_MALFORMED/);
  const foreign = createHostSettingsStore({ loadSettings: async () => 42, saveSettings: async () => true });
  await assert.rejects(foreign.load(), /ERR_SETTINGS_MALFORMED/);
});

test('store saves canonical JSON and refuses invalid values and nacks', async () => {
  const host = createMemorySettingsHost();
  const store = createHostSettingsStore(host);
  assert.equal(
    await store.save({ scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 12 }),
    true,
  );
  assert.deepEqual(host.calls, [
    { op: 'save', json: '{"scheme":"mv-dark","density":"comfortable","wallFps":60,"recordingFps":12}' },
  ]);
  assert.deepEqual(
    { ...(await store.load()) },
    { scheme: 'mv-dark', density: 'comfortable', wallFps: 60, recordingFps: 12 },
  );
  await assert.rejects(store.save({ scheme: 'dark' }), /ERR_SETTINGS_UNKNOWN_SCHEME/);
  await assert.rejects(store.save({ wallFps: 24 }), /ERR_SETTINGS_UNKNOWN_WALL_FPS/);
  const nacking = createHostSettingsStore({
    loadSettings: async () => null,
    saveSettings: async () => /** @type {any} */ (false),
  });
  await assert.rejects(nacking.save({ scheme: 'mv-dark' }), /ERR_SETTINGS_SAVE_FAILED/);
});

test('actual fps meter counts arrivals over the injected clock window', () => {
  let at = 0;
  const meter = createWallFpsMeter({ windowMs: 1000, now: () => at });
  assert.equal(meter.read(), null);
  meter.push(1_000_000_000);
  meter.push(2_000_000_000);
  at = 500;
  meter.push(3_000_000_000);
  meter.push(4_000_000_000);
  assert.equal(meter.read(), 4);
  at = 1500;
  assert.equal(meter.read(), 2);
  at = 3000;
  assert.equal(meter.read(), null);
  meter.push('nope');
  meter.push(-1);
  meter.push(1.5);
  meter.push(null);
  assert.equal(meter.read(), null);
});

test('actual fps line shows requested next to measured, never an error', () => {
  assert.equal(formatWallFpsLine(30, 2.625), '30 requested, 2.6 actual');
  assert.equal(formatWallFpsLine(60, null), '60 requested, -- actual');
  assert.equal(formatWallFpsLine(24, 1), '30 requested, 1.0 actual');
  assert.equal(formatWallFpsLine(3, Number.NaN), '3 requested, -- actual');
});

test('typed refusals use fixed literals and never leak host text', () => {
  assert.deepEqual(
    { ...settingsRefusalFor({ code: 'ERR_SETTINGS_HOST' }) },
    { code: 'ERR_SETTINGS_HOST', reason: 'Settings host is unavailable' },
  );
  assert.deepEqual(
    { ...settingsRefusalFor({ code: 'ERR_SETTINGS_UNKNOWN_SCHEME' }) },
    { code: 'ERR_SETTINGS_UNKNOWN_SCHEME', reason: 'Stored settings are unreadable; defaults are in use' },
  );
  assert.deepEqual(
    { ...settingsRefusalFor({ code: 'ERR_SETTINGS_UNKNOWN_WALL_FPS' }) },
    { code: 'ERR_SETTINGS_UNKNOWN_WALL_FPS', reason: 'Stored settings are unreadable; defaults are in use' },
  );
  assert.deepEqual(
    { ...settingsRefusalFor({ code: 'ERR_SETTINGS_UNKNOWN_RECORDING_FPS' }) },
    { code: 'ERR_SETTINGS_UNKNOWN_RECORDING_FPS', reason: 'Stored settings are unreadable; defaults are in use' },
  );
  const leaked = settingsRefusalFor(new Error('SECRET-TOKEN-xyz'));
  assert.equal(leaked.code, 'ERR_SETTINGS_SAVE_FAILED');
  assert.equal(leaked.reason.includes('SECRET'), false);
  assert.deepEqual(
    { ...settingsRefusalFor(null) },
    { code: 'ERR_SETTINGS_SAVE_FAILED', reason: 'Settings could not be saved on the host' },
  );
  assert.deepEqual(
    { ...settingsRefusalFor({ code: 'ERR_SETTINGS_APPLY_FAILED' }) },
    { code: 'ERR_SETTINGS_APPLY_FAILED', reason: 'Color scheme could not be applied' },
  );
});

test('settings ids and anchors are stable, deterministic and kebab-cased', () => {
  assert.equal(MV_SETTINGS_IDS.panel, 'mv-settings-panel');
  assert.equal(MV_SETTINGS_ANCHORS.panel, 'settings/mv-panel');
  assert.equal(MV_SETTINGS_ANCHORS.schemeGroup, 'settings/scheme');
  assert.equal(MV_SETTINGS_IDS.densityGroup, 'settings-density');
  assert.equal(MV_SETTINGS_IDS.wallFpsGroup, 'settings-wall-fps');
  assert.equal(MV_SETTINGS_IDS.recordingFpsGroup, 'settings-recording-fps');
  assert.equal(MV_SETTINGS_IDS.actualRow, 'settings-wall-fps-actual');
  assert.equal(MV_SETTINGS_ANCHORS.wallFpsGroup, 'settings/wall-fps');
  assert.equal(MV_SETTINGS_ANCHORS.recordingFpsGroup, 'settings/recording-fps');
  assert.equal(MV_SETTINGS_ANCHORS.actualRow, 'settings/wall-fps-actual');
  assert.equal(mvSchemeOptionDomId('mv-dark'), 'mv-settings-scheme-mv-dark');
  assert.equal(mvSchemeOptionAnchor('mv-dark'), 'settings/scheme-mv-dark');
  assert.equal(mvSchemeOptionAnchor('mv-dark'), mvSchemeOptionAnchor('mv-dark'));
  assert.notEqual(mvSchemeOptionAnchor('mv-dark'), mvSchemeOptionAnchor('mv-light'));
  assert.equal(mvDensityOptionDomId('comfortable'), 'settings-density-comfortable');
  assert.equal(mvDensityOptionAnchor('comfortable'), 'settings/density-comfortable');
  assert.equal(mvWallFpsOptionDomId(60), 'settings-wall-fps-60');
  assert.equal(mvWallFpsOptionAnchor(60), 'settings/wall-fps-60');
  assert.notEqual(mvWallFpsOptionAnchor(30), mvWallFpsOptionAnchor(60));
  for (const anchor of Object.values(MV_SETTINGS_ANCHORS)) {
    assert.match(anchor, /^[a-z0-9]+(?:\/[a-z0-9-]+)+$/);
  }
});
