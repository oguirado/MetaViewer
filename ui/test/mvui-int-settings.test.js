import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { SETTINGS_STORAGE_KEYS } from '../.kit/capsule-ui-kit/src/shell/SettingsModel.js';

test('settings adapter binds host methods and preserves host acknowledgements', async () => {
  const calls = [];
  const host = {
    value: '{"scheme":"mv-dark","density":"compact"}',
    async loadSettings() { calls.push('load'); return this.value; },
    async saveSettings(json) { calls.push(json); return true; },
  };
  const adapter = createSettingsHost(host, null);
  assert.equal(await adapter.loadSettings(), host.value);
  assert.equal(await adapter.saveSettings(host.value), true);
  assert.deepEqual(calls, ['load', host.value]);
});

test('settings adapter shares the established kit preference key when preload methods are absent', async () => {
  const data = new Map([[SETTINGS_STORAGE_KEYS.scheme, 'mv-dark']]);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const adapter = createSettingsHost(null, storage);
  assert.deepEqual(JSON.parse(await adapter.loadSettings()), { scheme: 'mv-dark', density: 'compact' });
  await adapter.saveSettings('{"scheme":"mv-light","density":"compact"}');
  assert.equal(data.get(SETTINGS_STORAGE_KEYS.scheme), 'mv-light');
  await assert.rejects(adapter.saveSettings('{"scheme":"invented"}'));
  assert.equal(data.get(SETTINGS_STORAGE_KEYS.scheme), 'mv-light');
});

test('fixture settings never read or write the host or local preferences', async () => {
  const forbidden = () => { throw new Error('live host called'); };
  const adapter = createSettingsHost({ loadSettings: forbidden, saveSettings: forbidden }, { getItem: forbidden, setItem: forbidden }, 'mv-dark');
  assert.equal(JSON.parse(await adapter.loadSettings()).scheme, 'mv-dark');
  await adapter.saveSettings('{"scheme":"mv-light","density":"compact"}');
  assert.equal(JSON.parse(await adapter.loadSettings()).scheme, 'mv-light');
});
