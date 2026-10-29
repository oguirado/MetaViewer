/// <reference path="./kit.d.ts" />
import { createApp } from 'vue';
import App from './App.vue';
import { createAuthorityAdapter, createAuthorityRuntime, createTerminalBroker, requireAck } from './core/hostAdapters.js';
import { createSettingsHost } from './settings/settingsHost.js';
import { parseStateQuery, resolveFixture } from './fixtures/resolveState.js';
import { createFixtureRuntime, createLiveReplayMount, LIVE_REPLAY_FIXTURE, TILE_CHROME_FIXTURE, TILE_CHROME_KEY, fixtureCaptureSeed, createCapturePort, createCaptureState, createCaptureDouble, INPUT_WRITE_FIXTURE, INPUT_WRITE_KEY, createInputPort, createInputDouble, createSessionTransport, TERMINAL_LIVE_COMMANDS, TERMINAL_LIVE_PROVIDERS } from './fixtures/fixtureRuntime.js';
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
const PREVIEW_ERRORS = new Set(['ERR_UNKNOWN_FIXTURE_STATE', 'ERR_INVALID_STATE_QUERY', 'ERR_UNKNOWN_SCHEME', 'ERR_INVALID_SCHEME_QUERY', 'ERR_INVALID_STEP_QUERY', 'ERR_UNKNOWN_STEP']);

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
  let loadFailed = false;
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
          if (!String(error).includes(HANDLER_NOT_INSTALLED)) {
            loadFailed = true;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
        }
      }
      loadFailed = true;
      throw new Error('Layout service did not become ready');
    },
    writeAtomic: async (/** @type {string} */ json) => {
      if (loadFailed) throw new Error('LAYOUT_SAVE_REFUSED');
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

/**
 * MVUI29S: read stored settings once before first paint. Only a missing
 * handler binding retries (mirroring the layout read); any other failure
 * settles as failed with defaults so boot never refuses on settings.
 * @param {{ loadSettings: () => Promise<string|null> }} settingsHost
 * @returns {Promise<Readonly<{ text: string|null, failed: boolean }>>}
 */
async function readBootSettings(settingsHost) {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    try {
      return Object.freeze({ text: await settingsHost.loadSettings(), failed: false });
    } catch (error) {
      if (!String(error).includes(HANDLER_NOT_INSTALLED)) {
        return Object.freeze({ text: null, failed: true });
      }
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
    }
  }
  return Object.freeze({ text: null, failed: true });
}

/**
 * MVUI29SC: boot-scheme parse through the store decode shared via the
 * settings-host factory static, so boot paints exactly the scheme the store
 * will load; whole refusals (malformed text, unknown keys, float fps
 * lexemes) or absent storage paint the primary scheme silently here, which
 * is the full-defaults fallback.
 * @param {string|null} text Settled boot read.
 * @returns {string} mv-light or mv-dark.
 */
function bootSchemeFromText(text) {
  if (typeof text !== 'string') return 'mv-light';
  const decoded = createSettingsHost.decodeStoredSettings(text);
  if (decoded.ok === false) return 'mv-light';
  return decoded.settings.scheme;
}

/**
 * MVUI33: boot-density parse through the same shared store decode, so boot
 * paints exactly the density the store will load; whole refusals (malformed
 * text, unknown keys, float fps lexemes) or absent storage paint compact
 * silently here, which is the full-defaults fallback.
 * @param {string|null} text Settled boot read.
 * @returns {string} compact or comfortable.
 */
function bootDensityFromText(text) {
  if (typeof text !== 'string') return 'compact';
  const decoded = createSettingsHost.decodeStoredSettings(text);
  if (decoded.ok === false) return 'compact';
  return decoded.settings.density;
}

/**
 * MVUI29S: memoized boot host. The panel reuses the single boot read instead
 * of hitting the host again; every acknowledged save refreshes the cache so
 * load-after-save round-trips. A failed boot read rethrows a fixed-typed
 * error on load so the panel can show its typed refusal.
 * @param {import('./settings/settingsModel.js').HostSettingsPort} settingsHost
 * @param {Readonly<{ text: string|null, failed: boolean }>} outcome
 * @returns {import('./settings/settingsModel.js').HostSettingsPort}
 */
function createBootSettingsHost(settingsHost, outcome) {
  /** @type {string|null} */
  let cached = outcome.text;
  let failed = outcome.failed;
  return {
    loadSettings: async () => {
      if (failed) throw Object.assign(new Error('ERR_SETTINGS_HOST'), { code: 'ERR_SETTINGS_HOST' });
      return cached;
    },
    saveSettings: async (/** @type {string} */ json) => {
      const ack = await settingsHost.saveSettings(json);
      if (ack === true) {
        cached = json;
        failed = false;
      }
      return ack;
    },
  };
}

/**
 * Fixture-only replay bench driver (lane R, mvui6): named `?step=<name>`
 * outcomes drive the REAL App dispatch paths through the fixture-only hook
 * installed by lane V (`window.__metaviewerBench` when a fixture key is
 * present, never live). Propose/intent/multislot steps call the same
 * dispatch the UI controls call; terminal steps open the real panels and
 * emit through the fixture fake ports. Pending launches click the real
 * provider button (same control the operator clicks). Never throws: a
 * missing hook or a refused dispatch leaves frames mounted for the bench.
 * @param {{ bench?: { kind?: string, body?: unknown, capsuleId?: string, lifecycle?: string }, terminalHarness?: { emitExit?: () => void, emitFrame?: () => void } }} mount
 */
function driveReplayBench(mount) {
  try {
    const bench = mount?.bench;
    if (!bench || typeof bench !== 'object') return;
    const hook = /** @type {{ dispatch?: unknown, dispatchMultislot?: unknown, openMultislot?: unknown, openTerminal?: unknown }|null} */ (
      /** @type {{ __metaviewerBench?: unknown }} */ (/** @type {unknown} */ (window)).__metaviewerBench ?? null
    );
    if (bench.kind === 'propose' || bench.kind === 'intent') {
      if (hook && typeof hook.dispatch === 'function') {
        try { /** @type {(intent: unknown) => void} */ (hook.dispatch)(bench.body); } catch { /* Bench hook failures never break boot. */ }
      }
      return;
    }
    if (bench.kind === 'multislot') {
      if (hook && typeof hook.dispatchMultislot === 'function') {
        try { void /** @type {(intent: unknown, capsuleId: string) => unknown} */ (hook.dispatchMultislot)(bench.body, bench.capsuleId ?? ''); } catch { /* Bench hook failures never break boot. */ }
      }
      return;
    }
    if (bench.kind === 'terminal') {
      if (bench.lifecycle === 'pending') {
        if (hook && typeof hook.openTerminal === 'function') {
          try { /** @type {() => void} */ (hook.openTerminal)(); } catch { /* Bench hook failures never break boot. */ }
        }
        try {
          setTimeout(() => {
            try {
              const getById = /** @type {{ getElementById?: unknown }} */ (/** @type {unknown} */ (document)).getElementById;
              if (typeof getById !== 'function') return;
              const button = /** @type {{ click?: unknown }|null} */ (getById.call(document, 'mv-terminal-broker-launch-shell'));
              if (button && typeof button.click === 'function') /** @type {() => void} */ (button.click).call(button);
            } catch { /* Missing button never breaks boot. */ }
          }, 50);
        } catch { /* Timer failures never break boot. */ }
        return;
      }
      if (hook && typeof hook.openMultislot === 'function') {
        try { /** @type {() => void} */ (hook.openMultislot)(); } catch { /* Bench hook failures never break boot. */ }
      }
      const harness = mount?.terminalHarness;
      if (bench.lifecycle === 'exited' && harness && typeof harness.emitExit === 'function') {
        try { setTimeout(() => { try { harness.emitExit?.(); } catch {} }, 100); } catch { /* Timer failures never break boot. */ }
      } else if (bench.lifecycle === 'failed' && harness && typeof harness.emitFrame === 'function') {
        try { setTimeout(() => { try { harness.emitFrame?.(); } catch {} }, 100); } catch { /* Timer failures never break boot. */ }
      }
    }
  } catch { /* Bench driver never breaks boot. */ }
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
  // Bench-only live replay (lane R): ?state=live-replay replays a
  // deterministic script through the real authority runtime. It is not a
  // FIXTURES key, so the room's exact key-set contract stays untouched.
  // Live boot and every other fixture ignore this branch entirely.
  const isLiveReplay = new URLSearchParams(window.location.search).get('state') === 'live-replay';
  const isLayoutUnavailable = requestedStates[0] === 'layout-unavailable';
  // MVUI9 lane A: tile-chrome travels as an alias fixture (see
  // fixtures/tileChrome.js), never a FIXTURES key. The guards keep the
  // boot harness (which stubs this module) on the legacy path.
  const tileChromeFixture = typeof TILE_CHROME_KEY === 'string' && TILE_CHROME_FIXTURE
      && requestedStates[0] === TILE_CHROME_KEY ? TILE_CHROME_FIXTURE : null;
  const isTileChrome = tileChromeFixture !== null;
  // MVUI25 lane A: input-write travels as an alias fixture (see
  // fixtures/inputWrite.js), never a FIXTURES key. The guards keep the
  // boot harness (which stubs this module) on the legacy path.
  const inputWriteFixture = typeof INPUT_WRITE_KEY === 'string' && INPUT_WRITE_FIXTURE
      && requestedStates[0] === INPUT_WRITE_KEY ? INPUT_WRITE_FIXTURE : null;
  const isInputWrite = inputWriteFixture !== null;
  const parsed = parseStateQuery(window.location.search);
  if (!parsed.ok && parsed.error.code !== 'ERR_MISSING_STATE_PARAM' && !isLiveReplay && !isLayoutUnavailable && !isTileChrome && !isInputWrite) throw new Error(parsed.error.code);
  // A diagnostic alias keeps the canonical fixture inventory unchanged.
  const resolved = isLayoutUnavailable ? resolveFixture('one') : (!isTileChrome && !isInputWrite && parsed.ok) ? resolveFixture(parsed.key) : null;
  if (resolved && !resolved.ok) throw new Error(resolved.error.code);
  const baseFixture = isTileChrome ? tileChromeFixture : isInputWrite ? inputWriteFixture : resolved?.ok ? (isLayoutUnavailable
    ? Object.freeze({ ...resolved.fixture, key: 'layout-unavailable' }) : resolved.fixture) : (isLiveReplay ? LIVE_REPLAY_FIXTURE : null);
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
  const result = fixture ? (isLiveReplay ? createLiveReplayMount(window.location.search) : createFixtureRuntime(fixture)) : null;
  if (result && !result.ok) throw new Error(result.error.code);
  const fixtureMount = result?.ok ? result.mount : null;
  const storage = isLayoutUnavailable
    ? createLayoutStorage({ load: async () => { throw new Error('LAYOUT_CONTRACT_ABSENT'); }, save: async () => { throw new Error('LAYOUT_SAVE_REFUSED'); } })
    : fixtureMount
    ? { readRaw: async () => null, writeAtomic: async (/** @type {string} */ _json) => {} }
    : createLayoutStorage(getLayoutFacade());
  const layout = fixture ? createWallLayout(SCOPE, [...fixture.capsules]) : createInitialLayout(SCOPE);
  const host = fixture ? null : /** @type {{metaviewer?: Partial<import('./settings/settingsModel.js').HostSettingsPort> & {nestedDepth?:()=>Promise<0|1|null>,selfCapsuleId?:()=>Promise<string|null>,recordingDestination?:()=>Promise<string|null>,authority?:import('./core/hostAdapters.js').AuthorityPort,qa?:import('./qa/anchorCollector.js').QaFacade,sideTerminal?:import('./core/hostAdapters.js').TerminalPort,capture?:unknown,input?:unknown,frames?:unknown}}} */ (window).metaviewer;
  let preferences = /** @type {Storage|null} */ (null);
  if (!fixture) { try { preferences = globalThis.localStorage; } catch { /* Storage may be unavailable. */ } }
  const settingsHost = createSettingsHost(host ?? null, preferences, fixture?.scheme ?? null);
  // MVUI29S: a single settings read before first paint; the panel reuses the
  // settled value through the memoized host, so a stored scheme paints first
  // with no flash of the default. Failures keep bootable defaults.
  const bootOutcome = await readBootSettings(settingsHost);
  const bootScheme = bootSchemeFromText(bootOutcome.text);
  const bootDensity = bootDensityFromText(bootOutcome.text);
  const bootSettingsHost = createBootSettingsHost(settingsHost, bootOutcome);
  const depth = fixture ? (fixture.key === 'nested' ? 1 : 0) : (typeof host?.nestedDepth === 'function' ? await host.nestedDepth() : null);
  const selfId = fixture ? null : (typeof host?.selfCapsuleId === 'function' ? await host.selfCapsuleId() : null);
  const exportDestination = fixture ? '' : (typeof host?.recordingDestination === 'function' ? await host.recordingDestination() : null) ?? '';
  const nestedHost = { getNestedDepth: () => depth, getSelfCapsuleId: () => selfId };
  const replayMount = /** @type {{ authorityPort?: import('./core/hostAdapters.js').AuthorityPort, terminalBrokerPort?: import('./core/hostAdapters.js').TerminalPort }|null} */ (/** @type {unknown} */ (isLiveReplay ? fixtureMount : null));
  const replayPort = replayMount?.authorityPort ?? null;
  const replayTerminalPort = replayMount?.terminalBrokerPort ?? null;
  // MVUI14 lane F: live-only frame-port router. Dynamic import: the entry
  // keeps its closed static stub-map surface (mount-wiring pin), so the
  // router module loads lazily and any failure degrades to null (tiles stay
  // Connecting, never a boot refusal). Installed before the authority
  // runtime subscribes, so no brokered port notice can arrive first.
  /** @type {{ dispose?: () => void }|null} */
  let framePortRouter = null;
  /** @type {{ dispose?: () => void }|null} MVUI32 lane F: throttled rehash reporter (live only). */
  let rehashDiag = null;
  if (!fixture) {
    try {
      const routerModule = await import('./frames/framePortRouter.js');
      const installRouter = routerModule.default;
      if (typeof installRouter === 'function') {
        framePortRouter = installRouter({ target: window }) ?? null;
      }
      // Reached through the existing router import (no new static entry
      // import); the facade rides the pinned host read (host.frames), so the
      // single live-read pin stays exact. Any failure degrades to null.
      const installDiag = routerModule.createRehashDiagReporter;
      if (framePortRouter && typeof installDiag === 'function') {
        try {
          rehashDiag = installDiag(
            /** @type {any} */ (framePortRouter),
            { getFacade: () => host?.frames },
          ) ?? null;
        } catch { rehashDiag = null; }
      }
    } catch { framePortRouter = null; rehashDiag = null; }
  }
  const authorityHost = replayPort ? createAuthorityAdapter(replayPort) : (fixture ? null : createAuthorityAdapter(host?.authority));
  // MVUI29d lane T: the terminal-live fixture exposes its broker double on
  // the mount; wire it as the terminal broker so broker launches work on a
  // real ?state=terminal-live boot. Live boots and the live-replay broker
  // port are unchanged; other fixtures have no broker port and stay null.
  const fixtureBrokerPort = fixture && !replayTerminalPort
    ? /** @type {import('./core/hostAdapters.js').TerminalPort|null} */ (
      /** @type {{ terminalLive?: { brokerPort?: unknown } }|null} */ (/** @type {unknown} */ (fixtureMount))?.terminalLive?.brokerPort ?? null
    )
    : null;
  const terminalBroker = fixture
    ? (replayTerminalPort ? createTerminalBroker(replayTerminalPort) : (fixtureBrokerPort ? createTerminalBroker(fixtureBrokerPort) : null))
    : createTerminalBroker(host?.sideTerminal);
  const liveRuntime = fixture ? null : createAuthorityRuntime(host?.authority);
  // MVUI9 lane A: capture port plus reactive store. The port always
  // comes from createCapturePort; its facade is the in-memory double on
  // fixture boots and the host capture facade on live boots, reached as
  // host.capture (never a fresh window read, so the boot tests' single
  // live-read pin stays exact). The factories arrive through the
  // fixtureRuntime re-export; unknown names (stub harness) degrade
  // capture to null and the UI keeps its legacy intent path.
  const captureDouble = fixture && typeof createCaptureDouble === 'function' ? createCaptureDouble() : null;
  const capturePort = typeof createCapturePort === 'function' && (fixture ? captureDouble !== null : true)
    ? createCapturePort(/** @type {any} */ (fixture ? captureDouble : host?.capture))
    : null;
  const captureState = capturePort && typeof createCaptureState === 'function' ? createCaptureState(capturePort) : null;
  const captureAvailable = capturePort !== null && capturePort.available === true;
  if (captureState && fixture && typeof fixtureCaptureSeed === 'function') {
    // Fixture capture seeding: the recording screen and tile-chrome
    // declare seed surfaces; the double applies them deterministically
    // before mount so badges and rows render settled.
    const seed = fixtureCaptureSeed(fixture);
    for (const surfaceId of seed.record) await captureState.toggleRecord(surfaceId);
    for (const surfaceId of seed.shots) await captureState.screenshot(surfaceId);
  }
  // MVUI25 lane A: human input port. The port always comes from
  // createInputPort; its facade is the in-memory double on fixture boots
  // and the host input facade on live boots, reached as host.input
  // (never a fresh window read, so the boot tests' single live-read pin
  // stays exact). The factories arrive through the fixtureRuntime
  // re-export; unknown names (stub harness) degrade the port to null and
  // tiles stay non-focusable.
  const inputDouble = fixture && typeof createInputDouble === 'function' ? createInputDouble() : null;
  const inputPort = typeof createInputPort === 'function' && (fixture ? inputDouble !== null : true)
    ? createInputPort(/** @type {any} */ (fixture ? inputDouble : host?.input))
    : null;
  // MVUI29b lane T: terminal session port for the multislot. The source
  // is the fixture double on terminal-live boots and host.sideTerminal
  // on live boots (never a fresh window read, so the boot tests' single
  // live-read pin stays exact). The factory arrives through the
  // fixtureRuntime re-export; unknown names (stub harness) keep the raw
  // source and the multislot builds the port itself, while a malformed
  // source degrades to null and the slot keeps its binding-only path.
  const terminalLive = /** @type {{ terminalLive?: { transport?: unknown, clipboard?: unknown } }|null|undefined} */ (
    /** @type {unknown} */ (fixtureMount))?.terminalLive ?? null;
  const terminalSource = terminalLive?.transport ?? (!fixture ? host?.sideTerminal ?? null : null);
  let terminalSessionPort = terminalSource ?? null;
  if (terminalSessionPort && typeof createSessionTransport === 'function') {
    try {
      terminalSessionPort = createSessionTransport(terminalSessionPort);
    } catch {
      terminalSessionPort = null;
    }
  }
  const terminalProviders = terminalLive && typeof TERMINAL_LIVE_PROVIDERS !== 'undefined'
    ? [...TERMINAL_LIVE_PROVIDERS] : [];
  const terminalCommands = terminalLive && typeof TERMINAL_LIVE_COMMANDS !== 'undefined'
    ? [...TERMINAL_LIVE_COMMANDS] : [];
  const terminalClipboard = /** @type {{ writeText: (text: string) => Promise<void> }|null} */ (
    terminalLive?.clipboard ?? null);
  const replayRuntime = /** @type {{ dispose?: () => void }|null} */ (/** @type {unknown} */ (isLiveReplay ? fixtureMount?.runtime ?? null : null));
  let disposeQa = () => {};
  let tornDown = false;
  const teardown = () => { tornDown = true; disposeQa(); rehashDiag?.dispose?.(); framePortRouter?.dispose?.(); captureState?.dispose?.(); inputPort?.dispose?.(); liveRuntime?.dispose(); replayRuntime?.dispose?.(); window.removeEventListener?.('pagehide', teardown); };
  if (framePortRouter || captureState || liveRuntime || replayRuntime || inputPort || (!fixture && typeof host?.qa?.reportAnchors === 'function')) window.addEventListener?.('pagehide', teardown, { once: true });
  try {
    Object.assign(document.documentElement.dataset, THEME_DATASET);
    document.documentElement.dataset.themeDensity = bootDensity;
    const application = createApp(App, { layout, storage, scope: SCOPE, fixture, nestedHost, exportDestination, settingsHost: bootSettingsHost, initialScheme: bootScheme, initialDensity: bootDensity, framesPort: fixture ? null : (host?.authority ?? null), preferences, authorityHost, terminalBroker, captureState, captureAvailable,
      terminalSessionPort, hostProviders: terminalProviders, brokerCommands: terminalCommands, clipboard: terminalClipboard,
      runtime: /** @type {InstanceType<typeof App>['$props']['runtime']} */ (/** @type {unknown} */ (fixtureMount?.runtime ?? liveRuntime)),
      terminal: fixtureMount?.terminal ?? null });
    if (framePortRouter) application.provide?.('framePortRouter', framePortRouter);
    application.provide?.('inputPort', inputPort);
    installKitTheme(application);
    // Kit declaration predates its shipped MetaViewer schemes.
    /** @type {(scheme:string)=>void} */ (setKitScheme)(bootScheme);
    application.onUnmount?.(teardown);
    application.mount(MOUNT_SELECTOR);
    if (!fixture && depth !== 1 && typeof host?.qa?.reportAnchors === 'function') {
      const { installQaAnchorReporter } = await import('./qa/anchorCollector.js');
      if (!tornDown) disposeQa = installQaAnchorReporter({
        window: /** @type {import('./qa/anchorCollector.js').ReporterWindow} */ (window), document, facade: host.qa,
      });
    }
    // Fixture-only bench outcomes (mvui6): named replay steps drive the real
    // App dispatch paths through the lane-V hook. Numeric steps and live boot
    // carry no bench descriptor and ignore this branch entirely.
    if (isLiveReplay && fixtureMount && typeof fixtureMount === 'object' && 'bench' in fixtureMount) {
      try { driveReplayBench(/** @type {{ bench?: { kind?: string } }} */ (fixtureMount)); } catch { /* Bench driver never breaks boot. */ }
    }
  } catch (error) { teardown(); throw error; }
}

void bootstrap().catch(error => {
  refuseBoot(error);
});
