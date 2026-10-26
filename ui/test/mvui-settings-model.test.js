// MetaViewer settings model (AC-08): closed decode, strict encode, host
// store, memory double and typed refusals. Every behaviour ships with a
// negative control proving the assertion can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MV_DENSITY,
  MV_PRIMARY_SCHEME,
  MV_SCHEMES,
  MV_SETTINGS_ANCHORS,
  MV_SETTINGS_IDS,
  createHostSettingsStore,
  createMemorySettingsHost,
  decodeMvSettings,
  defaultMvSettings,
  encodeMvSettings,
  isMvScheme,
  mvSchemeOptionAnchor,
  mvSchemeOptionDomId,
  normalizeScheme,
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

test('default settings are frozen light/compact', () => {
  assert.deepEqual({ ...defaultMvSettings() }, { scheme: 'mv-light', density: 'compact' });
  assert.equal(Object.isFrozen(defaultMvSettings()), true);
});

test('closed decode accepts objects, JSON text and partial values', () => {
  assert.deepEqual(decodeMvSettings({ scheme: 'mv-dark', density: 'compact' }), {
    ok: true,
    settings: { scheme: 'mv-dark', density: 'compact' },
  });
  assert.deepEqual(decodeMvSettings('{"scheme":"mv-dark"}'), {
    ok: true,
    settings: { scheme: 'mv-dark', density: 'compact' },
  });
  assert.deepEqual(decodeMvSettings({}), { ok: true, settings: { scheme: 'mv-light', density: 'compact' } });
});

test('closed decode refuses unknown keys, values and malformed input', () => {
  const unknownKey = decodeMvSettings({ scheme: 'mv-dark', font: 'x' });
  assert.equal(unknownKey.ok, false);
  assert.equal(unknownKey.ok === false && unknownKey.error.code, 'ERR_SETTINGS_UNKNOWN_KEY');
  const badScheme = decodeMvSettings({ scheme: 'dark' });
  assert.equal(badScheme.ok === false && badScheme.error.code, 'ERR_SETTINGS_UNKNOWN_SCHEME');
  const badDensity = decodeMvSettings({ density: 'regular' });
  assert.equal(badDensity.ok === false && badDensity.error.code, 'ERR_SETTINGS_UNKNOWN_DENSITY');
  for (const malformed of ['{nope', '42', 'null', '[]', 42, null, undefined, [], ['mv-dark']]) {
    const decoded = decodeMvSettings(malformed);
    assert.equal(decoded.ok, false, `expected refusal for ${String(malformed)}`);
    assert.equal(decoded.ok === false && decoded.error.code, 'ERR_SETTINGS_MALFORMED');
  }
});

test('strict encode is canonical and throws coded errors on invalid input', () => {
  assert.equal(encodeMvSettings({ scheme: 'mv-dark', density: 'compact' }), '{"scheme":"mv-dark","density":"compact"}');
  assert.equal(encodeMvSettings({ scheme: 'mv-dark' }), '{"scheme":"mv-dark","density":"compact"}');
  assert.throws(() => encodeMvSettings({ scheme: 'dark' }), /ERR_SETTINGS_UNKNOWN_SCHEME/);
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
  assert.deepEqual({ ...(await empty.load()) }, { scheme: 'mv-light', density: 'compact' });
  const stored = createHostSettingsStore(createMemorySettingsHost('{"scheme":"mv-dark"}'));
  assert.deepEqual({ ...(await stored.load()) }, { scheme: 'mv-dark', density: 'compact' });
  const broken = createHostSettingsStore(createMemorySettingsHost('{nope'));
  await assert.rejects(broken.load(), /ERR_SETTINGS_MALFORMED/);
  const foreign = createHostSettingsStore({ loadSettings: async () => 42, saveSettings: async () => true });
  await assert.rejects(foreign.load(), /ERR_SETTINGS_MALFORMED/);
});

test('store saves canonical JSON and refuses invalid values and nacks', async () => {
  const host = createMemorySettingsHost();
  const store = createHostSettingsStore(host);
  assert.equal(await store.save({ scheme: 'mv-dark', density: 'compact' }), true);
  assert.deepEqual(host.calls, [
    { op: 'save', json: '{"scheme":"mv-dark","density":"compact"}' },
  ]);
  assert.deepEqual({ ...(await store.load()) }, { scheme: 'mv-dark', density: 'compact' });
  await assert.rejects(store.save({ scheme: 'dark' }), /ERR_SETTINGS_UNKNOWN_SCHEME/);
  const nacking = createHostSettingsStore({
    loadSettings: async () => null,
    saveSettings: async () => /** @type {any} */ (false),
  });
  await assert.rejects(nacking.save({ scheme: 'mv-dark' }), /ERR_SETTINGS_SAVE_FAILED/);
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
  assert.equal(mvSchemeOptionDomId('mv-dark'), 'mv-settings-scheme-mv-dark');
  assert.equal(mvSchemeOptionAnchor('mv-dark'), 'settings/scheme-mv-dark');
  assert.equal(mvSchemeOptionAnchor('mv-dark'), mvSchemeOptionAnchor('mv-dark'));
  assert.notEqual(mvSchemeOptionAnchor('mv-dark'), mvSchemeOptionAnchor('mv-light'));
  for (const anchor of Object.values(MV_SETTINGS_ANCHORS)) {
    assert.match(anchor, /^[a-z0-9]+(?:\/[a-z0-9-]+)+$/);
  }
});
