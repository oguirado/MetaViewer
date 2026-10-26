import { createApp } from 'vue';
import App from './App.vue';
import 'capsule-ui-kit/theme.css';
import './design/metaviewer.css';
import { createDefaultLayoutProfile, decodeAndMigrateLayoutProfile } from 'capsule-ui-kit/layout';
import { installKitTheme } from 'capsule-ui-kit/theme';

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
  themeScheme: 'light',
  themeContrast: 'normal',
  themeDensity: 'regular',
  themeTextScale: '1',
  themeForcedColors: 'none',
  themeMotion: 'no-preference',
});

/** Mount selector for the single mount div owned by index.html. */
const MOUNT_SELECTOR = '#metaviewer-app';
const REFUSAL_PREFIX = 'MetaViewer cannot start: ';
const REFUSAL_MAX_CHARS = 280;

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
          return raw;
        } catch (error) {
          if (!String(error).includes(HANDLER_NOT_INSTALLED)) throw error;
          await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
        }
      }
      throw new Error('Layout service did not become ready');
    },
    writeAtomic: async (/** @type {string} */ json) => {
      await facade.save(json);
    },
  };
}

/**
 * Build the W0 default wall layout; decode refusal throws before mount.
 * @param {LayoutScope} scope
 * @returns {LayoutProfile}
 */
function createInitialLayout(scope) {
  const candidate = createDefaultLayoutProfile(scope);
  const checked = decodeAndMigrateLayoutProfile(candidate, { expectedScope: scope });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.profile;
}

/**
 * Show a bounded plain-text refusal; boot never leaves a partial mount behind.
 * @param {string} message
 */
function refuseBoot(message) {
  const text = `${REFUSAL_PREFIX}${message}`.slice(0, REFUSAL_MAX_CHARS);
  const mount = document.querySelector(MOUNT_SELECTOR);
  if (mount) {
    mount.textContent = text;
    return;
  }
  document.body.textContent = text;
}

function bootstrap() {
  const storage = createLayoutStorage(getLayoutFacade());
  const layout = createInitialLayout(SCOPE);
  Object.assign(document.documentElement.dataset, THEME_DATASET);
  const application = createApp(App, { layout, storage, scope: SCOPE });
  installKitTheme(application);
  application.mount(MOUNT_SELECTOR);
}

try {
  bootstrap();
} catch (error) {
  refuseBoot(error instanceof Error ? error.message : 'Unknown startup failure');
}
