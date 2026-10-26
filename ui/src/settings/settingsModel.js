/**
 * MetaViewer settings model (AC-08): mv-light (primary) / mv-dark schemes,
 * compact density, persisted through an injected host settings interface
 * (XDG on the host side). Never localStorage, never the repository.
 *
 * Pure JavaScript with JSDoc; zero imports. Closed decode rejects unknown
 * keys and unknown values; every failure maps to a typed refusal with a
 * fixed literal reason so host error text never reaches the screen.
 *
 * @module settings/settingsModel
 */

/**
 * Closed MetaViewer scheme set. mv-light is primary.
 * @type {ReadonlyArray<string>}
 */
export const MV_SCHEMES = Object.freeze(['mv-light', 'mv-dark']);

/**
 * Primary scheme and decode fallback.
 * @type {string}
 */
export const MV_PRIMARY_SCHEME = 'mv-light';

/**
 * MetaViewer density. Compact only.
 * @type {string}
 */
export const MV_DENSITY = 'compact';

/**
 * @typedef {object} MvSettings
 * @property {string} scheme `mv-light` or `mv-dark`.
 * @property {string} density Always `compact`.
 */

/**
 * @typedef {object} HostSettingsPort Injected host settings interface.
 * @property {() => Promise<string|null>} loadSettings Read stored settings text, null when absent.
 * @property {(json: string) => Promise<true>} saveSettings Store settings text; resolves true.
 */

/**
 * Creates a coded error for deterministic gate assertions.
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function settingsError(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(`${code}: ${message}`));
  err.code = code;
  return err;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value
 * @returns {boolean} True for mv-light or mv-dark.
 */
export function isMvScheme(value) {
  return value === 'mv-light' || value === 'mv-dark';
}

/**
 * @param {unknown} value Requested scheme.
 * @param {string} [fallback] Fallback when unknown.
 * @returns {string} Known scheme or the fallback.
 */
export function normalizeScheme(value, fallback = MV_PRIMARY_SCHEME) {
  if (isMvScheme(value)) return /** @type {string} */ (value);
  return isMvScheme(fallback) ? fallback : MV_PRIMARY_SCHEME;
}

/**
 * @returns {Readonly<MvSettings>} Frozen default settings.
 */
export function defaultMvSettings() {
  return Object.freeze({ scheme: MV_PRIMARY_SCHEME, density: MV_DENSITY });
}

/**
 * Closed decode of stored settings. Accepts an object or its JSON text;
 * rejects unknown keys, unknown schemes and unknown densities.
 * @param {unknown} raw
 * @returns {{ ok: true, settings: Readonly<MvSettings> } | { ok: false, error: { code: string, message: string } }}
 */
export function decodeMvSettings(raw) {
  let candidate = raw;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return {
        ok: false,
        error: { code: 'ERR_SETTINGS_MALFORMED', message: 'Settings text is not JSON' },
      };
    }
  }
  if (!isPlainObject(candidate)) {
    return {
      ok: false,
      error: { code: 'ERR_SETTINGS_MALFORMED', message: 'Settings must be an object' },
    };
  }
  for (const key of Object.keys(candidate)) {
    if (key !== 'scheme' && key !== 'density') {
      return {
        ok: false,
        error: { code: 'ERR_SETTINGS_UNKNOWN_KEY', message: `Unknown settings key: ${key}` },
      };
    }
  }
  const scheme = candidate.scheme === undefined ? MV_PRIMARY_SCHEME : candidate.scheme;
  if (typeof scheme !== 'string' || !isMvScheme(scheme)) {
    return {
      ok: false,
      error: { code: 'ERR_SETTINGS_UNKNOWN_SCHEME', message: `Unknown scheme: ${String(scheme)}` },
    };
  }
  const density = candidate.density === undefined ? MV_DENSITY : candidate.density;
  if (typeof density !== 'string' || density !== MV_DENSITY) {
    return {
      ok: false,
      error: { code: 'ERR_SETTINGS_UNKNOWN_DENSITY', message: `Unknown density: ${String(density)}` },
    };
  }
  return { ok: true, settings: Object.freeze({ scheme, density }) };
}

/**
 * Strict-encode settings to canonical JSON (fixed key order). Throws the
 * coded decode error when the value is not valid settings.
 * @param {unknown} settings
 * @returns {string}
 */
export function encodeMvSettings(settings) {
  const decoded = decodeMvSettings(settings);
  if (decoded.ok === false) {
    throw settingsError(decoded.error.code, decoded.error.message);
  }
  return JSON.stringify({ scheme: decoded.settings.scheme, density: decoded.settings.density });
}

/**
 * Creates a settings store over an injected host port. The host shape is
 * validated eagerly so a missing method fails at wiring time, never at
 * save time.
 * @param {HostSettingsPort} host Injected host settings interface.
 * @returns {Readonly<{ load: () => Promise<Readonly<MvSettings>>, save: (settings: unknown) => Promise<true> }>}
 */
export function createHostSettingsStore(host) {
  if (
    host === null ||
    typeof host !== 'object' ||
    typeof host.loadSettings !== 'function' ||
    typeof host.saveSettings !== 'function'
  ) {
    throw settingsError('ERR_SETTINGS_HOST', 'Settings host must provide loadSettings and saveSettings');
  }
  return Object.freeze({
    /**
     * Load settings; absent storage resolves defaults. Malformed storage
     * throws its coded error so the caller can show the typed refusal.
     * @returns {Promise<Readonly<MvSettings>>}
     */
    async load() {
      const raw = await host.loadSettings();
      if (raw === null) return defaultMvSettings();
      if (typeof raw !== 'string') {
        throw settingsError('ERR_SETTINGS_MALFORMED', 'Stored settings must be text or null');
      }
      const decoded = decodeMvSettings(raw);
      if (decoded.ok === false) {
        throw settingsError(decoded.error.code, decoded.error.message);
      }
      return decoded.settings;
    },
    /**
     * Validate, encode and persist settings. The encoded payload is
     * fixed-shape and tiny; the host still bounds it like layout text.
     * @param {unknown} settings
     * @returns {Promise<true>}
     */
    async save(settings) {
      const json = encodeMvSettings(settings);
      const ack = await host.saveSettings(json);
      if (ack !== true) {
        throw settingsError('ERR_SETTINGS_SAVE_FAILED', 'Settings host refused the write');
      }
      return true;
    },
  });
}

/**
 * In-memory host double for tests and fixtures. Records every call.
 * @param {string|null} [initialText]
 * @returns {HostSettingsPort & { calls: Array<{ op: string, json?: string }> }}
 */
export function createMemorySettingsHost(initialText = null) {
  /** @type {Array<{ op: string, json?: string }>} */
  const calls = [];
  /** @type {string|null} */
  let text = initialText;
  return {
    calls,
    loadSettings: async () => {
      calls.push({ op: 'load' });
      return text;
    },
    saveSettings: async (/** @type {string} */ json) => {
      calls.push({ op: 'save', json });
      text = json;
      return /** @type {const} */ (true);
    },
  };
}

/**
 * Maps any failure to a typed refusal with a fixed literal reason. Host
 * error text never passes through.
 * @param {unknown} error
 * @returns {Readonly<{ code: string, reason: string }>}
 */
export function settingsRefusalFor(error) {
  const code =
    typeof error === 'object' && error !== null && typeof /** @type {{ code?: unknown }} */ (error).code === 'string'
      ? /** @type {{ code: string }} */ (/** @type {unknown} */ (error)).code
      : '';
  switch (code) {
    case 'ERR_SETTINGS_HOST':
      return Object.freeze({ code, reason: 'Settings host is unavailable' });
    case 'ERR_SETTINGS_MALFORMED':
    case 'ERR_SETTINGS_UNKNOWN_KEY':
    case 'ERR_SETTINGS_UNKNOWN_SCHEME':
    case 'ERR_SETTINGS_UNKNOWN_DENSITY':
      return Object.freeze({ code, reason: 'Stored settings are unreadable; defaults are in use' });
    case 'ERR_SETTINGS_APPLY_FAILED':
      return Object.freeze({ code, reason: 'Color scheme could not be applied' });
    case 'ERR_SETTINGS_SAVE_FAILED':
      return Object.freeze({ code, reason: 'Settings could not be saved on the host' });
    default:
      return Object.freeze({ code: 'ERR_SETTINGS_SAVE_FAILED', reason: 'Settings could not be saved on the host' });
  }
}

/**
 * Stable DOM ids for the MetaViewer settings panel (agent_lane/v1).
 * @type {Readonly<{ panel: string, schemeGroup: string, densityRow: string, refusalRow: string }>}
 */
export const MV_SETTINGS_IDS = Object.freeze({
  panel: 'mv-settings-panel',
  schemeGroup: 'mv-settings-scheme',
  densityRow: 'mv-settings-density',
  refusalRow: 'mv-settings-save-refusal',
});

/**
 * Semantic anchors for the MetaViewer settings panel (agent_lane/v1).
 * @type {Readonly<{ panel: string, schemeGroup: string, densityRow: string, refusalRow: string }>}
 */
export const MV_SETTINGS_ANCHORS = Object.freeze({
  panel: 'settings/mv-panel',
  schemeGroup: 'settings/scheme',
  densityRow: 'settings/density',
  refusalRow: 'settings/save-refusal',
});

/**
 * @param {string} scheme `mv-light` or `mv-dark`.
 * @returns {string} Stable DOM id for the scheme radio option.
 */
export function mvSchemeOptionDomId(scheme) {
  return `mv-settings-scheme-${scheme}`;
}

/**
 * @param {string} scheme `mv-light` or `mv-dark`.
 * @returns {string} Semantic anchor for the scheme radio option.
 */
export function mvSchemeOptionAnchor(scheme) {
  return `settings/scheme-${scheme}`;
}