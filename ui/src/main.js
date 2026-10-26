/// <reference path="./kit.d.ts" />
import { createApp } from 'vue';
import App from './App.vue';
import { createAuthorityAdapter, createAuthorityRuntime, createTerminalBroker, requireAck } from './core/hostAdapters.js';
import { createSettingsHost } from './settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from './fixtures/resolveState.js';
import { createFixtureRuntime } from './fixtures/fixtureRuntime.js';
import 'capsule-ui-kit/theme.css';
import './design/metaviewer.css';
import { createWallLayout, migrateWallLayout } from './wall/layout.js';
import { installKitTheme, setKitScheme } from 'capsule-ui-kit/theme';

/** @typedef {import('capsule-ui-kit/layout').LayoutProfileScope} LayoutScope */
/** @typedef {import('capsule-ui-kit/layout').LayoutProfileEnvelope} LayoutProfile */
/** @typedef {{ load: () => Promise<unknown>, save: (json: string) => Promise<unknown> }} LayoutFacade */
/** @typedef {{ readRaw: () => Promise<string|null>, writeAtomic: (json: string) => Promise<void> }} LayoutStorage */

/** @type {Readonly<LayoutScope>} */
const SCOPE = Object.freeze({
  product: 'metaviewer',
  profileId: 'default',
  workspaceId: 'main-wall',
});

/** Preload global owned and exposed by W0-SHELL-PRELOAD; never guessed. */
const FACADE_NAME = 'metaviewer';

/** Handler-installation race only; unbound invoke rejects with this text. */
const HANDLER_NOT_INSTALLED = 'No handler registered';
const READ_ATTEMPTS = 100;
const READ_RETRY_MS = 20;

/** Light-first paint seed; mirrors the static dataset attributes in index.html. */
const THEME_DATASET = Object.freeze({
  themeScheme: 'mv-light',
  themeContrast: 'normal',
  themeDensity: 'compact',
  themeTextScale: '1',
  themeForcedColors: 'none',
  themeMotion: 'no-preference',
});

/** Mount selector for the single mount div owned by index.html. */
const MOUNT_SELECTOR = '#metaviewer-app';
const REFUSAL_PREFIX = 'MetaViewer cannot start: ';
const PREVIEW_ERRORS = new Set(['ERR_UNKNOWN_FIXTURE_STATE', 'ERR_INVALID_STATE_QUERY', 'ERR_UNKNOWN_SCHEME', 'ERR_INVALID_SCHEME_QUERY']);

/**
 * Bind the closed preload layout facade. A missing or malformed facade is a
 * visible boot refusal, never a fallback to another global.
 * @returns {LayoutFacade}
 */
function getLayoutFacade() {
  const globalScope = /** @type {unknown} */ (window);
  const exposed = /** @type {{ metaviewer?: LayoutFacade }} */ (globalScope);
  const facade = exposed[FACADE_NAME];
  if (!facade || typeof facade.load !== 'function' || typeof facade.save !== 'function') {
    throw new Error('Layout service unavailable');
  }
  return facade;
}

/**
 * Presentation-only preload boundary; storage failures stay visible to the kit.
 * @param {LayoutFacade} facade
 * @returns {LayoutStorage}
 */
function createLayoutStorage(facade) {
  return {
    readRaw: async () => {
      // Mount can precede main's handler binding. Wait only for handler
      // installation; schema and storage errors never become missing profiles.
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
        try {
          const raw = await facade.load();
          if (raw !== null && typeof raw !== 'string') throw new Error('Invalid layout payload');
          return migrateWallLayout(raw);
        } catch (error) {
          if (!String(error).includes(HANDLER_NOT_INSTALLED)) throw error;
          await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
        }
      }
      throw new Error('Layout service did not become ready');
    },
    writeAtomic: async (/** @type {string} */ json) => {
      requireAck(await facade.save(json));
    },
  };
}

/**
 * Build the W0 default wall layout; decode refusal throws before mount.
 * @param {LayoutScope} scope
 * @returns {LayoutProfile}
 */
function createInitialLayout(scope) {
  return createWallLayout(scope);
}

/** Render only closed copy; host messages and codes never become visible text.
 * @param {unknown} error
 */
function refuseBoot(error) {
  const code = error instanceof Error && /^ERR_[A-Z0-9_]+$/.test(error.message)
    ? error.message : 'ERR_STARTUP_UNAVAILABLE';
  const text = REFUSAL_PREFIX + (PREVIEW_ERRORS.has(code)
    ? 'This preview is unavailable.' : 'The application is unavailable. Please try again.');
  const target = /** @type {HTMLElement|null} */ (document.querySelector(MOUNT_SELECTOR)) ?? document.body;
  target.textContent = text;
  target.dataset.errorCode = code;
}

async function bootstrap() {
  const requestedStates = new URLSearchParams(window.location.search).getAll('state');
  if (requestedStates.length > 1 || (requestedStates.length === 1 && requestedStates[0].length === 0)) {
    throw new Error('ERR_INVALID_STATE_QUERY');
  }
  const parsed = parseStateQuery(window.location.search);
  if (!parsed.ok && parsed.error.code !== 'ERR_MISSING_STATE_PARAM') throw new Error(parsed.error.code);
  const resolved = parsed.ok ? resolveFixture(parsed.key) : null;
  if (resolved && !resolved.ok) throw new Error(resolved.error.code);
  const baseFixture = resolved?.ok ? resolved.fixture : null;
  // Fixture-only vision hook (MV-5): an explicit ?scheme= overrides the
  // fixture default. Live boot ignores the parameter entirely. Matching is
  // exact and case-sensitive; unknown, empty, or repeated values refuse boot
  // with the same fixed preview copy as ?state=. Kept import-free so the
  // boot harnesses keep executing this entry with their closed stub map.
  /** @type {typeof baseFixture} */
  let fixture = baseFixture;
  if (baseFixture) {
    const requestedSchemes = new URLSearchParams(window.location.search).getAll('scheme');
    if (requestedSchemes.length > 1 || (requestedSchemes.length === 1 && requestedSchemes[0].length === 0)) {
      throw new Error('ERR_INVALID_SCHEME_QUERY');
    }
    const requestedScheme = requestedSchemes.length === 1 ? requestedSchemes[0] : null;
    if (requestedScheme !== null && requestedScheme !== 'mv-light' && requestedScheme !== 'mv-dark') {
      throw new Error('ERR_UNKNOWN_SCHEME');
    }
    if (requestedScheme !== null && requestedScheme !== baseFixture.scheme) {
      fixture = Object.freeze({ ...baseFixture, scheme: requestedScheme });
    }
  }
  const result = fixture ? createFixtureRuntime(fixture) : null;
  if (result && !result.ok) throw new Error(result.error.code);
  const fixtureMount = result?.ok ? result.mount : null;
  const storage = fixtureMount
    ? { readRaw: async () => null, writeAtomic: async (/** @type {string} */ _json) => {} }
    : createLayoutStorage(getLayoutFacade());
  const layout = fixture ? createWallLayout(SCOPE, [...fixture.capsules]) : createInitialLayout(SCOPE);
  const host = fixture ? null : /** @type {{metaviewer?: Partial<import('./settings/settingsModel.js').HostSettingsPort> & {nestedDepth?:()=>Promise<0|1|null>,selfCapsuleId?:()=>Promise<string|null>,recordingDestination?:()=>Promise<string|null>,authority?:import('./core/hostAdapters.js').AuthorityPort,sideTerminal?:import('./core/hostAdapters.js').TerminalPort}}} */ (window).metaviewer;
  let preferences = /** @type {Storage|null} */ (null);
  if (!fixture) { try { preferences = globalThis.localStorage; } catch { /* Storage may be unavailable. */ } }
  const settingsHost = createSettingsHost(host ?? null, preferences, fixture?.scheme ?? null);
  const depth = fixture ? (fixture.key === 'nested' ? 1 : 0) : (typeof host?.nestedDepth === 'function' ? await host.nestedDepth() : null);
  const selfId = fixture ? null : (typeof host?.selfCapsuleId === 'function' ? await host.selfCapsuleId() : null);
  const exportDestination = fixture ? '' : (typeof host?.recordingDestination === 'function' ? await host.recordingDestination() : null) ?? '';
  const nestedHost = { getNestedDepth: () => depth, getSelfCapsuleId: () => selfId };
  const authorityHost = fixture ? null : createAuthorityAdapter(host?.authority);
  const terminalBroker = fixture ? null : createTerminalBroker(host?.sideTerminal);
  const liveRuntime = fixture ? null : createAuthorityRuntime(host?.authority);
  const teardown = () => { liveRuntime?.dispose(); window.removeEventListener?.('pagehide', teardown); };
  if (liveRuntime) window.addEventListener?.('pagehide', teardown, { once: true });
  try {
    Object.assign(document.documentElement.dataset, THEME_DATASET);
    const application = createApp(App, { layout, storage, scope: SCOPE, fixture, nestedHost, exportDestination, settingsHost, preferences, authorityHost, terminalBroker,
      runtime: /** @type {InstanceType<typeof App>['$props']['runtime']} */ (/** @type {unknown} */ (fixtureMount?.runtime ?? liveRuntime)),
      terminal: fixtureMount?.terminal ?? null });
    installKitTheme(application);
    // Kit declaration predates its shipped MetaViewer schemes.
    /** @type {(scheme:string)=>void} */ (setKitScheme)(fixture?.scheme ?? 'mv-light');
    application.onUnmount?.(teardown);
    application.mount(MOUNT_SELECTOR);
  } catch (error) { teardown(); throw error; }
}

void bootstrap().catch(error => {
  refuseBoot(error);
});
