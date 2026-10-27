/**
 * @file Fixture runtime factory: App-compatible wall runtime stubs built
 * from fixture data, so every `?state=` screen mounts without a live core
 * (lane U5). Intent builders record instead of dispatching; the terminal
 * port stays `null` because a MessagePort is host-owned. Renderer-only,
 * no host calls. Plain JavaScript ES module with JSDoc types.
 */

import { resolveFixture } from './resolveState.js';

// Lane R re-export: the bench-only live-replay mount travels through this
// already-imported module so `main.js` keeps its closed stub-map import
// surface (the boot harnesses rewrite static imports with a fixed map).
export {
  LIVE_REPLAY_FIXTURE,
  LIVE_REPLAY_KEY,
  LIVE_REPLAY_SCRIPT,
  LIVE_REPLAY_SURFACE_ID,
  createLiveReplayHarness,
  createLiveReplayMount,
  parseStepQuery,
} from './liveReplay.js';

/**
 * @typedef {Object} FixtureProjectionSnapshot
 * @property {string} status
 * @property {boolean} stale
 * @property {{ schema: string, epoch: number, revision: number, query: string, projection: { rows: readonly import('./states.js').FixtureCapsule[] } }|null} envelope
 * @property {{ code: string, message: string }|null} error
 */

/**
 * @typedef {Object} FixtureProjectionView
 * @property {() => { rows: readonly import('./states.js').FixtureCapsule[] }} getProjection
 * @property {() => FixtureProjectionSnapshot} getSnapshot
 * @property {(listener: (snapshot: FixtureProjectionSnapshot) => void) => () => void} subscribe
 */

/**
 * @typedef {Object} FixtureIntentCall
 * @property {string} builder - `visibility`, `control`, or `presentation`.
 * @property {Readonly<Record<string, unknown>>} input
 */

/**
 * @typedef {Object} FixtureRuntime
 * @property {FixtureProjectionView} projectionView
 * @property {{ visibility: (input: unknown) => Readonly<Record<string, unknown>>, control: (input: unknown) => Readonly<Record<string, unknown>>, presentation: (input: unknown) => Readonly<Record<string, unknown>> }} intentBuilders
 * @property {Record<string, never>} controlRegistry
 * @property {Record<string, never>} scheduler
 * @property {{ attachCanvas: () => void, detachCanvas: () => void, foldSurface: () => void, unfoldSurface: () => void, updateSurfaceState: () => void, destroy: () => void }} tileScheduler
 */

/**
 * @typedef {Object} FixtureMount
 * @property {import('./states.js').FixtureState} fixture
 * @property {FixtureRuntime} runtime
 * @property {FixtureIntentCall[]} calls - Harness-owned recorded intents.
 * @property {null} terminal - Always null: ports are host-owned.
 */

/**
 * Builds a frozen projection snapshot from fixture rows.
 * @param {import('./states.js').FixtureState} fixture
 * @returns {FixtureProjectionSnapshot}
 */
function buildSnapshot(fixture) {
  return Object.freeze({
    status: 'live',
    stale: false,
    envelope: Object.freeze({
      schema: 'surface/v0.1',
      epoch: fixture.epoch,
      revision: fixture.revision,
      query: 'wall',
      projection: Object.freeze({ rows: fixture.capsules }),
    }),
    error: null,
  });
}

/**
 * No-op tile scheduler stub matching the SurfacePanel/SurfaceCanvas call surface.
 * @returns {FixtureRuntime['tileScheduler']}
 */
function createStubTileScheduler() {
  return {
    attachCanvas: () => {},
    detachCanvas: () => {},
    foldSurface: () => {},
    unfoldSurface: () => {},
    updateSurfaceState: () => {},
    destroy: () => {},
  };
}

/**
 * Creates a mountable fixture runtime from a key or a fixture record.
 * @param {string|import('./states.js').FixtureState} keyOrFixture
 * @returns {{ ok: true, mount: FixtureMount }|{ ok: false, error: import('./resolveState.js').FixtureRefusal }}
 */
export function createFixtureRuntime(keyOrFixture) {
  const resolved =
    typeof keyOrFixture === 'string'
      ? resolveFixture(keyOrFixture)
      : { ok: /** @type {const} */ (true), fixture: /** @type {import('./states.js').FixtureState} */ (keyOrFixture) };
  if (!resolved.ok) return resolved;
  const fixture = resolved.fixture;
  if (!fixture || typeof fixture !== 'object' || !Array.isArray(fixture.capsules)) {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_UNKNOWN_FIXTURE_STATE', message: 'Fixture record is malformed' }),
    };
  }
  const snapshot = buildSnapshot(fixture);
  /** @type {FixtureIntentCall[]} */
  const calls = [];
  /**
   * @param {string} builder
   * @returns {(input: unknown) => Readonly<Record<string, unknown>>}
   */
  const recorder = (builder) => (input) => {
    const frozenInput = Object.freeze({ ...((input && typeof input === 'object' ? input : {})) });
    calls.push(Object.freeze({ builder, input: frozenInput }));
    return Object.freeze({ fixture: true, builder, input: frozenInput });
  };
  const runtime = {
    projectionView: {
      getProjection: () => ({ rows: fixture.capsules }),
      getSnapshot: () => snapshot,
      subscribe: (/** @type {(snapshot: FixtureProjectionSnapshot) => void} */ listener) => {
        if (typeof listener === 'function') listener(snapshot);
        return () => {};
      },
    },
    intentBuilders: {
      visibility: recorder('visibility'),
      control: recorder('control'),
      presentation: recorder('presentation'),
    },
    controlRegistry: {},
    scheduler: {},
    tileScheduler: createStubTileScheduler(),
  };
  return { ok: true, mount: { fixture, runtime, calls, terminal: null } };
}
