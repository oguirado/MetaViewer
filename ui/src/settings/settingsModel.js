/**
 * MetaViewer settings model (mvui33): mv-light (primary) / mv-dark schemes,
 * compact/comfortable density, live wall fps presets and recording fps,
 * persisted through an injected host settings interface (XDG on the host
 * side). Never localStorage, never the repository.
 *
 * Pure JavaScript with JSDoc; zero imports. ONE closed definition (keys,
 * allowed values, defaults) shared by every save and load path: the host
 * key set is exactly {scheme, density, wallFps, recordingFps}. Closed
 * decode rejects unknown keys and unknown values; every failure maps to a
 * typed refusal with a fixed literal reason so host error text never
 * reaches the screen.
 *
 * The store ignores unknown keys on load: the host's closed key set is the
 * fail-closed contract, so saves carry only the four known keys. Missing or
 * invalid values fall back to defaults per value, so a valid scheme survives
 * an invalid density and vice versa. Saves are leading-edge debounced so
 * bursts collapse to an immediate write plus one last-wins trailing write.
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
 * MetaViewer density default. Compact only until mvui33; the closed set is
 * MV_DENSITIES now.
 * @type {string}
 */
export const MV_DENSITY = 'compact';

/**
 * Closed MetaViewer density set.
 * @type {ReadonlyArray<string>}
 */
export const MV_DENSITIES = Object.freeze(['compact', 'comfortable']);

/**
 * Closed live wall fps presets. The renderer only saves the request; the
 * host applies it to the live frame cadence after a successful save.
 * @type {ReadonlyArray<number>}
 */
export const MV_WALL_FPS_VALUES = Object.freeze([3, 30, 60]);

/**
 * Default live wall fps.
 * @type {number}
 */
export const MV_DEFAULT_WALL_FPS = 30;

/**
 * Recording fps bounds (inclusive integers). The renderer only saves the
 * value; the host uses it as the default max_fps of new recording requests.
 * @type {number}
 */
export const MV_RECORDING_FPS_MIN = 1;

/**
 * Recording fps bounds (inclusive integers).
 * @type {number}
 */
export const MV_RECORDING_FPS_MAX = 60;

/**
 * Default recording fps.
 * @type {number}
 */
export const MV_DEFAULT_RECORDING_FPS = 3;

/**
 * The closed host settings key set, in canonical save order. Every save
 * carries exactly these keys; unknown keys refuse on save and are ignored
 * on load.
 * @type {ReadonlyArray<string>}
 */
export const MV_SETTINGS_KEYS = Object.freeze(['scheme', 'density', 'wallFps', 'recordingFps']);

/**
 * Save burst window in milliseconds. The first change in an idle panel saves
 * immediately; further changes within the window collapse to a single trailing
 * save carrying the last value, so bursts cannot storm the host.
 * @type {number}
 */
export const MV_SETTINGS_SAVE_WINDOW_MS = 150;

/**
 * Sliding window in milliseconds for the actual wall fps readout.
 * @type {number}
 */
export const MV_WALL_FPS_WINDOW_MS = 2000;

/**
 * @typedef {object} MvSettings
 * @property {string} scheme `mv-light` or `mv-dark`.
 * @property {string} density `compact` or `comfortable`.
 * @property {number} wallFps Requested live wall fps, one of 3, 30 or 60.
 * @property {number} recordingFps Recording fps, an integer 1..60.
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
 * @param {unknown} value
 * @returns {boolean} True for compact or comfortable.
 */
export function isMvDensity(value) {
  return value === 'compact' || value === 'comfortable';
}

/**
 * @param {unknown} value Requested density.
 * @param {string} [fallback] Fallback when unknown.
 * @returns {string} Known density or the fallback.
 */
export function normalizeDensity(value, fallback = MV_DENSITY) {
  if (isMvDensity(value)) return /** @type {string} */ (value);
  return isMvDensity(fallback) ? fallback : MV_DENSITY;
}

/**
 * @param {unknown} value
 * @returns {boolean} True for the 3 / 30 / 60 presets.
 */
export function isMvWallFps(value) {
  return value === 3 || value === 30 || value === 60;
}

/**
 * @param {unknown} value Requested live wall fps.
 * @param {number} [fallback] Fallback when unknown.
 * @returns {number} Known preset or the fallback.
 */
export function normalizeWallFps(value, fallback = MV_DEFAULT_WALL_FPS) {
  if (isMvWallFps(value)) return /** @type {number} */ (value);
  return isMvWallFps(fallback) ? fallback : MV_DEFAULT_WALL_FPS;
}

/**
 * @param {unknown} value
 * @returns {boolean} True for an integer 1..60.
 */
export function isMvRecordingFps(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 60;
}

/**
 * @param {unknown} value Requested recording fps.
 * @param {number} [fallback] Fallback when out of range.
 * @returns {number} In-range fps or the fallback.
 */
export function normalizeRecordingFps(value, fallback = MV_DEFAULT_RECORDING_FPS) {
  if (isMvRecordingFps(value)) return /** @type {number} */ (value);
  return isMvRecordingFps(fallback) ? fallback : MV_DEFAULT_RECORDING_FPS;
}

/**
 * @returns {Readonly<MvSettings>} Frozen default settings.
 */
export function defaultMvSettings() {
  return Object.freeze({
    scheme: MV_PRIMARY_SCHEME,
    density: MV_DENSITY,
    wallFps: MV_DEFAULT_WALL_FPS,
    recordingFps: MV_DEFAULT_RECORDING_FPS,
  });
}

/**
 * Closed decode of stored settings. Accepts an object or its JSON text;
 * rejects unknown keys and every unknown value. Missing keys read back as
 * their defaults, so old two-key files stay valid.
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
    if (!MV_SETTINGS_KEYS.includes(key)) {
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
  if (typeof density !== 'string' || !isMvDensity(density)) {
    return {
      ok: false,
      error: { code: 'ERR_SETTINGS_UNKNOWN_DENSITY', message: `Unknown density: ${String(density)}` },
    };
  }
  const wallFps = candidate.wallFps === undefined ? MV_DEFAULT_WALL_FPS : candidate.wallFps;
  if (!isMvWallFps(wallFps)) {
    return {
      ok: false,
      error: { code: 'ERR_SETTINGS_UNKNOWN_WALL_FPS', message: `Unknown wall fps: ${String(wallFps)}` },
    };
  }
  const recordingFps = candidate.recordingFps === undefined ? MV_DEFAULT_RECORDING_FPS : candidate.recordingFps;
  if (!isMvRecordingFps(recordingFps)) {
    return {
      ok: false,
      error: { code: 'ERR_SETTINGS_UNKNOWN_RECORDING_FPS', message: `Unknown recording fps: ${String(recordingFps)}` },
    };
  }
  return {
    ok: true,
    settings: Object.freeze({
      scheme,
      density,
      wallFps: /** @type {number} */ (wallFps),
      recordingFps: /** @type {number} */ (recordingFps),
    }),
  };
}

/**
 * Stored-text decode shared by the store and the entry boot parser: unknown
 * keys are ignored (the closed host key set is fail-closed), then each known
 * value falls back to its default independently, so a valid scheme survives
 * an invalid density and vice versa. Missing keys take defaults; malformed
 * text and non-objects refuse with the same codes.
 * @param {unknown} raw
 * @returns {{ ok: true, settings: Readonly<MvSettings> } | { ok: false, error: { code: string, message: string } }}
 */
export function decodeStoredSettings(raw) {
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
  const scheme = isMvScheme(candidate.scheme)
    ? /** @type {string} */ (candidate.scheme)
    : MV_PRIMARY_SCHEME;
  const density = isMvDensity(candidate.density)
    ? /** @type {string} */ (candidate.density)
    : MV_DENSITY;
  const wallFps = isMvWallFps(candidate.wallFps)
    ? /** @type {number} */ (candidate.wallFps)
    : MV_DEFAULT_WALL_FPS;
  const recordingFps = isMvRecordingFps(candidate.recordingFps)
    ? /** @type {number} */ (candidate.recordingFps)
    : MV_DEFAULT_RECORDING_FPS;
  return { ok: true, settings: Object.freeze({ scheme, density, wallFps, recordingFps }) };
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
  return JSON.stringify({
    scheme: decoded.settings.scheme,
    density: decoded.settings.density,
    wallFps: decoded.settings.wallFps,
    recordingFps: decoded.settings.recordingFps,
  });
}

/**
 * Stored-text failures (malformed text, unknown key, scheme, density or fps)
 * that fall back to defaults silently; transport and host failures stay loud
 * as typed refusals.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isMvSettingsDecodeFailure(error) {
  const code =
    typeof error === 'object' && error !== null && typeof /** @type {{ code?: unknown }} */ (error).code === 'string'
      ? /** @type {{ code: string }} */ (/** @type {unknown} */ (error)).code
      : '';
  return (
    code === 'ERR_SETTINGS_MALFORMED' ||
    code === 'ERR_SETTINGS_UNKNOWN_KEY' ||
    code === 'ERR_SETTINGS_UNKNOWN_SCHEME' ||
    code === 'ERR_SETTINGS_UNKNOWN_DENSITY' ||
    code === 'ERR_SETTINGS_UNKNOWN_WALL_FPS' ||
    code === 'ERR_SETTINGS_UNKNOWN_RECORDING_FPS'
  );
}

/**
 * Leading-edge debounce for settings saves. The first call runs `fn`
 * synchronously; calls within `delayMs` collapse to a single trailing call
 * with the last argument when the window ends. `cancel` drops a pending
 * trailing call (used on unmount and host replacement); `pending` reports
 * one and `pendingValue` returns the queued trailing value, if any, so a
 * revert to the applied value can overwrite the queue instead of dropping.
 * The runner carries any value; the settings panel schedules full settings
 * objects so bursts across fields keep every last value.
 * @param {(value: unknown) => void} fn
 * @param {number} delayMs
 * @returns {((value: unknown) => void) & { cancel: () => void, pending: () => boolean, pendingValue: () => unknown }}
 */
export function createDebouncedRunner(fn, delayMs) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  let windowOpen = false;
  /** @type {unknown} */
  let trailing = null;
  /**
   * @param {unknown} value
   */
  const schedule = (value) => {
    if (!windowOpen) {
      windowOpen = true;
      trailing = null;
      timer = setTimeout(onWindowEnd, Math.max(0, delayMs));
      fn(value);
      return;
    }
    trailing = value;
  };
  const onWindowEnd = () => {
    timer = null;
    windowOpen = false;
    if (trailing !== null) {
      const last = trailing;
      trailing = null;
      schedule(last);
    }
  };
  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    windowOpen = false;
    trailing = null;
  };
  const pending = () => trailing !== null;
  const pendingValue = () => trailing;
  return Object.assign(schedule, { cancel, pending, pendingValue });
}

/**
 * Creates a settings store over an injected host port. The host shape is
 * validated eagerly so a missing method fails at wiring time, never at
 * save time. Unknown keys seen on load are ignored, missing or invalid
 * values fall back to defaults per value; every save carries the full
 * four-key object.
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
     * Load settings; absent storage resolves defaults. Missing or invalid
     * known values resolve per-field defaults; malformed storage throws its
     * coded error so the caller can fall back.
     * @returns {Promise<Readonly<MvSettings>>}
     */
    async load() {
      const raw = await host.loadSettings();
      if (raw === null) {
        return defaultMvSettings();
      }
      if (typeof raw !== 'string') {
        throw settingsError('ERR_SETTINGS_MALFORMED', 'Stored settings must be text or null');
      }
      const decoded = decodeStoredSettings(raw);
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
 * Default renderer clock for the wall fps meter: monotonic
 * `performance.now()` when available, falling back to `Date.now()`. Resolved
 * at call time so hosted doubles can stub either global.
 * @returns {number}
 */
function defaultWallFpsNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/**
 * Sliding-window actual wall fps meter over frame presentation notices. Each
 * `push` admits one notice timestamp (`frame_ref.ts_ns`: a non-negative safe
 * integer; anything else is ignored) and records a renderer-clock arrival;
 * `read` returns arrivals per second inside the window, or null when the
 * window holds no sample. Pure: the clock is injected, so tests drive it
 * with a fake; the default is monotonic.
 * @param {{ windowMs?: number, now?: () => number }} [options]
 * @returns {Readonly<{ push: (tsNs: unknown) => void, read: () => number|null, msUntilEmpty: () => number }>}
 */
export function createWallFpsMeter({ windowMs = MV_WALL_FPS_WINDOW_MS, now = defaultWallFpsNow } = {}) {
  const spanMs = typeof windowMs === 'number' && Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : MV_WALL_FPS_WINDOW_MS;
  const clock = typeof now === 'function' ? now : defaultWallFpsNow;
  /** @type {number[]} */
  const arrivals = [];
  /**
   * @param {number} at
   */
  const prune = (at) => {
    const cut = at - spanMs;
    while (arrivals.length > 0 && /** @type {number} */ (arrivals[0]) < cut) arrivals.shift();
  };
  return Object.freeze({
    push(tsNs) {
      if (!Number.isSafeInteger(tsNs) || /** @type {number} */ (tsNs) < 0) return;
      const at = clock();
      arrivals.push(at);
      prune(at);
    },
    read() {
      prune(clock());
      if (arrivals.length === 0) return null;
      return arrivals.length / (spanMs / 1000);
    },
    /**
     * Milliseconds to wait before the window is guaranteed to read null with
     * no further pushes: the remaining age of the oldest sample plus a 1 ms
     * margin past the inclusive window edge, so a re-armed decay timer firing
     * on schedule always observes an empty window. Zero when already empty.
     * @returns {number}
     */
    msUntilEmpty() {
      const at = clock();
      prune(at);
      if (arrivals.length === 0) return 0;
      return Math.max(1, /** @type {number} */ (arrivals[0]) + spanMs - at + 1);
    },
  });
}

/**
 * Formats the actual wall fps readout next to the requested value, e.g.
 * "30 requested, 2.6 actual". With no sample yet the actual side shows a
 * placeholder, never an error.
 * @param {unknown} requested Requested live wall fps.
 * @param {unknown} actual Measured fps, or null when the window is empty.
 * @returns {string}
 */
export function formatWallFpsLine(requested, actual) {
  const safeRequested = normalizeWallFps(requested);
  const shown = typeof actual === 'number' && Number.isFinite(actual) && actual >= 0
    ? actual.toFixed(1)
    : '--';
  return `${safeRequested} requested, ${shown} actual`;
}

/**
 * Maps any failure to a typed refusal with a fixed literal reason. Host
 * error text never passes through.
 * @param {unknown} error
 * @returns {Readonly<{ code: string, reason: string }> }
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
    case 'ERR_SETTINGS_UNKNOWN_WALL_FPS':
    case 'ERR_SETTINGS_UNKNOWN_RECORDING_FPS':
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
 * @type {Readonly<{ panel: string, schemeGroup: string, densityRow: string, refusalRow: string, densityGroup: string, wallFpsGroup: string, recordingFpsGroup: string, recordingFpsInput: string, actualRow: string }> }
 */
export const MV_SETTINGS_IDS = Object.freeze({
  panel: 'mv-settings-panel',
  schemeGroup: 'mv-settings-scheme',
  densityRow: 'mv-settings-density',
  refusalRow: 'mv-settings-save-refusal',
  densityGroup: 'settings-density',
  wallFpsGroup: 'settings-wall-fps',
  recordingFpsGroup: 'settings-recording-fps',
  recordingFpsInput: 'settings-recording-fps-input',
  actualRow: 'settings-wall-fps-actual',
});

/**
 * Semantic anchors for the MetaViewer settings panel (agent_lane/v1).
 * @type {Readonly<{ panel: string, schemeGroup: string, densityRow: string, refusalRow: string, densityGroup: string, wallFpsGroup: string, recordingFpsGroup: string, recordingFpsInput: string, actualRow: string }> }
 */
export const MV_SETTINGS_ANCHORS = Object.freeze({
  panel: 'settings/mv-panel',
  schemeGroup: 'settings/scheme',
  densityRow: 'settings/density',
  refusalRow: 'settings/save-refusal',
  densityGroup: 'settings/density-control',
  wallFpsGroup: 'settings/wall-fps',
  recordingFpsGroup: 'settings/recording-fps',
  recordingFpsInput: 'settings/recording-fps-input',
  actualRow: 'settings/wall-fps-actual',
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

/**
 * @param {string} density `compact` or `comfortable`.
 * @returns {string} Stable DOM id for the density radio option.
 */
export function mvDensityOptionDomId(density) {
  return `settings-density-${density}`;
}

/**
 * @param {string} density `compact` or `comfortable`.
 * @returns {string} Semantic anchor for the density radio option.
 */
export function mvDensityOptionAnchor(density) {
  return `settings/density-${density}`;
}

/**
 * @param {number} wallFps One of 3, 30 or 60.
 * @returns {string} Stable DOM id for the wall fps radio option.
 */
export function mvWallFpsOptionDomId(wallFps) {
  return `settings-wall-fps-${wallFps}`;
}

/**
 * @param {number} wallFps One of 3, 30 or 60.
 * @returns {string} Semantic anchor for the wall fps radio option.
 */
export function mvWallFpsOptionAnchor(wallFps) {
  return `settings/wall-fps-${wallFps}`;
}
