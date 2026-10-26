import { SETTINGS_STORAGE_KEYS, readStoredSetting, writeStoredSetting } from '../../.kit/capsule-ui-kit/src/shell/SettingsModel.js';
import { decodeMvSettings, encodeMvSettings } from './settingsModel.js';

/**
 * Interim compatibility adapter: use each preload method when present.
 * Only an absent loadSettings/saveSettings method permits the corresponding
 * kit preference Storage (localStorage) fallback until preload provides both
 * methods. A host rejection never triggers fallback.
 * Fixture settings always remain in memory. Legacy kit light/dark preferences
 * are normalized to the MetaViewer scheme vocabulary on read.
 * @param {Partial<import('./settingsModel.js').HostSettingsPort>|null} host
 * @param {Storage|null} storage
 * @param {string|null} [fixtureScheme]
 * @returns {import('./settingsModel.js').HostSettingsPort} */
export function createSettingsHost(host, storage, fixtureScheme = null) {
  if (fixtureScheme !== null) {
    let text = encodeMvSettings({ scheme: fixtureScheme, density: 'compact' });
    return { loadSettings: async () => text, saveSettings: async json => { text = json; return true; } };
  }
  const load = typeof host?.loadSettings === 'function' ? host.loadSettings.bind(host) : null;
  const save = typeof host?.saveSettings === 'function' ? host.saveSettings.bind(host) : null;
  return {
    loadSettings: load !== null
      ? () => load()
      : async () => {
        const stored = readStoredSetting(storage, SETTINGS_STORAGE_KEYS.scheme, 'mv-light');
        const scheme = stored === 'dark' ? 'mv-dark' : stored === 'light' ? 'mv-light' : stored;
        return encodeMvSettings({ scheme, density: 'compact' });
      },
    saveSettings: save !== null
      ? json => save(json)
      : async json => {
        const decoded = decodeMvSettings(json);
        if (!decoded.ok) throw Object.assign(new Error(decoded.error.code), { code: decoded.error.code });
        if (storage === null || !writeStoredSetting(storage, SETTINGS_STORAGE_KEYS.scheme, decoded.settings.scheme)) {
          throw Object.assign(new Error('ERR_SETTINGS_SAVE_FAILED'), { code: 'ERR_SETTINGS_SAVE_FAILED' });
        }
        return true;
      },
  };
}
