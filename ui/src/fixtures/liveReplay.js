/**
 * @file Fixture-only live-replay bench path (`?state=live-replay`, lane R).
 * Replays a deterministic scripted authority sequence through the REAL
 * `createAuthorityRuntime` (never fixture rows): connecting, live frames,
 * human control, agent acting, an absorbed stale generation, lost, recovered.
 * The stale entry re-sends an older generation: the runtime absorbs the
 * duplicate without applying it (rows unchanged, still live). Malformed
 * notices still refuse with `ERR_FRAME_NOTICE`.
 * The fixture-only fake authority port enforces the real API contract:
 * exact positional arity, literal `true` acknowledgements, and closed
 * frame_ref/v0.2 + surface/v0.2 notices. Frame pixels are NOT replayed:
 * the frame-port path is host-brokered (MessagePort, host-owned like the
 * terminal port), so no fixture injection point exists and tiles stay
 * blank by design. Pure: no `window` access, no dates, no random ids.
 * Plain JavaScript ES module with JSDoc types.
 */

import { createAuthorityRuntime } from '../core/hostAdapters.js';

/**
 * @typedef {Object} LiveReplayRefusal
 * @property {string} code - `ERR_INVALID_STEP_QUERY` or `ERR_UNKNOWN_STEP`.
 * @property {string} message
 */

/**
 * @typedef {Object} LiveReplayScriptEntry
 * @property {number} index - Position in the script (0-based).
 * @property {string} phase - `live`, `human-control`, `agent-acting`, `stale-resend`, `lost`, or `recovered`.
 * @property {number} generation - frame_ref/v0.2 generation carried by the notice.
 * @property {string} control - surface/v0.2 control axis.
 * @property {string} state - surface/v0.2 state axis.
 * @property {{ frame_ref: Record<string, unknown>, surface: Record<string, unknown> }} notice - Closed v0.2 notice.
 */

/**
 * @typedef {Object} LiveReplayHarness
 * @property {import('../core/hostAdapters.js').AuthorityPort} port - Fake port with exactly `propose`, `intent`, `subscribeFrames`.
 * @property {(step: number) => number} emitUpTo - Deliver script entries `[0, step)` to every subscriber; returns the delivered count.
 * @property {readonly { method: string, payload: string }[]} calls - Harness-owned recorded port calls.
 * @property {readonly LiveReplayScriptEntry[]} script - The deterministic script.
 */

/**
 * @typedef {Object} LiveReplayMount
 * @property {import('./states.js').FixtureState} fixture
 * @property {NonNullable<ReturnType<typeof createAuthorityRuntime>>} runtime - REAL authority runtime, never fixture rows.
 * @property {import('../core/hostAdapters.js').AuthorityPort} authorityPort - Fake port behind the runtime, for the intent adapter.
 * @property {readonly { method: string, payload: string }[]} calls - Harness-owned recorded port calls.
 * @property {null} terminal - Always null: ports are host-owned.
 */

/** Canonical `?state=` value for the bench-only replay path. */
export const LIVE_REPLAY_KEY = 'live-replay';

/** Surface identity replayed by every script notice; matches the fixture capsule. */
export const LIVE_REPLAY_SURFACE_ID = 'cap-01';

/** Fixed frame geometry for every script notice. */
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 180;

/** Fixed clock base; per-entry offsets keep the script deterministic and safe. */
const TS_NS_BASE = 1700000000;
const TS_NS_STEP = 1000;

/**
 * Recursively freezes plain data.
 * @param {any} value
 * @returns {any}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const entry of value) deepFreeze(entry);
    } else {
      for (const entry of Object.values(value)) deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds one closed frame_ref/v0.2 + surface/v0.2 notice. Fixed digests and
 * timestamps: the same entry always builds the same bytes.
 * @param {{ generation: number, control: string, state: string }} entry
 * @param {number} index
 * @returns {{ frame_ref: Record<string, unknown>, surface: Record<string, unknown> }}
 */
function buildNotice(entry, index) {
  const seed = ['a0', 'b1', 'c2', 'd3', 'e4', 'f5', '06', '17'][index] ?? 'ff';
  return {
    frame_ref: {
      schema: 'frame_ref/v0.2',
      surface_id: LIVE_REPLAY_SURFACE_ID,
      generation: entry.generation,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      tick: index + 1,
      ts_ns: TS_NS_BASE + index * TS_NS_STEP,
      capture_us: 120 + index * 7,
      format: 'rgb24',
      sha256: seed.repeat(32),
    },
    surface: {
      schema: 'surface/v0.2',
      surface_id: LIVE_REPLAY_SURFACE_ID,
      kind: 'desktop_capsule',
      display: 'Replay capsule',
      geometry: { w: FRAME_WIDTH, h: FRAME_HEIGHT },
      state: entry.state,
      visibility: 'unfolded',
      control: entry.control,
      profile_id: 'replay-bench',
    },
  };
}

/** Script phases in replay order; the stale entry re-sends an older generation. */
const PHASES = Object.freeze([
  Object.freeze({ phase: 'live', generation: 1, control: 'shared', state: 'active' }),
  Object.freeze({ phase: 'live', generation: 2, control: 'shared', state: 'active' }),
  Object.freeze({ phase: 'live', generation: 3, control: 'shared', state: 'active' }),
  Object.freeze({ phase: 'human-control', generation: 4, control: 'human', state: 'active' }),
  Object.freeze({ phase: 'agent-acting', generation: 5, control: 'agent', state: 'active' }),
  Object.freeze({ phase: 'stale-resend', generation: 3, control: 'shared', state: 'active' }),
  Object.freeze({ phase: 'lost', generation: 6, control: 'agent', state: 'lost' }),
  Object.freeze({ phase: 'recovered', generation: 7, control: 'shared', state: 'active' }),
]);

/** Deterministic scripted authority sequence; step N replays entries `[0, N)`. */
export const LIVE_REPLAY_SCRIPT = deepFreeze(
  PHASES.map((entry, index) => ({ index, ...entry, notice: buildNotice(entry, index) })),
);

/**
 * Fixture record for the replay mount (layout, scheme, App props). It is
 * deliberately NOT a `FIXTURES` key: the room's exact key-set contract and
 * the closed boot stub maps stay untouched, and the replay routes through
 * a dedicated bench branch in `main.js`.
 * @type {import('./states.js').FixtureState}
 */
export const LIVE_REPLAY_FIXTURE = deepFreeze({
  key: LIVE_REPLAY_KEY,
  screen: 'wall',
  scheme: 'mv-light',
  density: 'compact',
  epoch: 1,
  revision: 12,
  capsules: [
    {
      id: LIVE_REPLAY_SURFACE_ID,
      surfaceId: LIVE_REPLAY_SURFACE_ID,
      title: 'Replay capsule',
      kind: 'program',
      backendLifecycle: 'active',
      generation: 1,
      visibility: 'unfolded',
      control: 'shared',
      controlOwner: 'none',
      folded: false,
      refusal: null,
      readinessError: null,
      attachmentState: 'live',
      aiSessionActivity: 'ready',
      dispatchOutcome: 'none',
    },
  ],
  ui: { liveReplay: true },
  expectedAnchors: [
    { anchor: 'settings/scheme', role: 'button' },
    { anchor: 'terminal/toggle', role: 'button' },
    { anchor: 'capsule/cap-01/panel', role: 'region' },
    { anchor: 'capsule/cap-01/fold', role: 'button', ifPresent: true },
    { anchor: 'capsule/cap-01/control', role: 'button', ifPresent: true },
  ],
});

/**
 * Parses the bench-only `step` parameter. Absent means the full replay.
 * Canonical non-negative integers only; anything else is a typed refusal.
 * @param {unknown} search
 * @returns {{ ok: true, step: number }|{ ok: false, error: LiveReplayRefusal }}
 */
export function parseStepQuery(search) {
  if (typeof search !== 'string') {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_INVALID_STEP_QUERY', message: 'Step query must be a string' }),
    };
  }
  let values = [];
  try {
    values = new URLSearchParams(search.startsWith('?') ? search : `?${search}`).getAll('step');
  } catch {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_INVALID_STEP_QUERY', message: 'Step query is malformed' }),
    };
  }
  if (values.length === 0) {
    return { ok: true, step: LIVE_REPLAY_SCRIPT.length };
  }
  if (values.length > 1 || values[0].length === 0) {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_INVALID_STEP_QUERY', message: 'Step must occur exactly once' }),
    };
  }
  const text = values[0];
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_INVALID_STEP_QUERY', message: `Invalid step ${text}` }),
    };
  }
  const step = Number(text);
  if (!Number.isSafeInteger(step)) {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_INVALID_STEP_QUERY', message: `Invalid step ${text}` }),
    };
  }
  if (step > LIVE_REPLAY_SCRIPT.length) {
    return {
      ok: false,
      error: Object.freeze({ code: 'ERR_UNKNOWN_STEP', message: `Unknown step ${text}` }),
    };
  }
  return { ok: true, step };
}

/**
 * Creates the fixture-only fake authority port. Every method enforces the
 * real contract: bound receiver, exact positional arity, JSON-text bodies,
 * literal `true` intent acknowledgements, and closed v0.2 notices only.
 * `propose` answers `admitted`, or a typed `POLICY` refusal when the body
 * carries `refuse: true`. Emission is harness-driven (`emitUpTo`) so the
 * vision bench captures each phase deterministically.
 * @returns {LiveReplayHarness}
 */
export function createLiveReplayHarness() {
  /** @type {Set<(notice: unknown) => void>} */
  const listeners = new Set();
  /** @type {{ method: string, payload: string }[]} */
  const calls = [];
  let delivered = 0;
  /**
   * @param {unknown} self
   * @param {string} name
   */
  function checkReceiver(self, name) {
    if (self !== port) throw new Error(`live-replay/${name}: invalid receiver`);
  }
  /**
   * @param {string} name
   * @param {readonly unknown[]} args
   * @param {number} arity
   */
  function checkArity(name, args, arity) {
    if (args.length !== arity) throw new Error(`live-replay/${name}: wrong arity`);
  }
  /**
   * @param {string} name
   * @param {unknown} json
   * @returns {Record<string, any>}
   */
  function readJsonBody(name, json) {
    if (typeof json !== 'string') throw new Error(`live-replay/${name}: payload must be JSON text`);
    let body = null;
    try {
      body = JSON.parse(json);
    } catch {
      throw new Error(`live-replay/${name}: payload must be JSON text`);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`live-replay/${name}: payload must be JSON text`);
    }
    return body;
  }
  const port = {
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {Promise<import('../core/hostAdapters.js').ActionVerdict>}
     */
    propose(...args) {
      checkReceiver(this, 'propose');
      checkArity('propose', args, 1);
      const body = readJsonBody('propose', args[0]);
      calls.push(Object.freeze({ method: 'propose', payload: /** @type {string} */ (args[0]) }));
      if (body.refuse === true) {
        return Promise.resolve({
          schema: 'action_verdict/v0.2',
          proposal_id: 'replay-proposal-1',
          core_seq: 1,
          decision: /** @type {const} */ ('refused'),
          reason_code: 'POLICY',
        });
      }
      return Promise.resolve({
        schema: 'action_verdict/v0.2',
        proposal_id: 'replay-proposal-1',
        core_seq: 1,
        decision: /** @type {const} */ ('admitted'),
      });
    },
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {Promise<true>}
     */
    intent(...args) {
      checkReceiver(this, 'intent');
      checkArity('intent', args, 1);
      const body = readJsonBody('intent', args[0]);
      if (body.schema !== 'ui_intent/v0.2' || typeof body.op !== 'string') {
        throw new Error('live-replay/intent: invalid intent payload');
      }
      calls.push(Object.freeze({ method: 'intent', payload: /** @type {string} */ (args[0]) }));
      return Promise.resolve(true);
    },
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {() => void}
     */
    subscribeFrames(...args) {
      checkReceiver(this, 'subscribeFrames');
      checkArity('subscribeFrames', args, 1);
      const callback = args[0];
      if (typeof callback !== 'function') throw new Error('live-replay/subscribeFrames: callback required');
      listeners.add(/** @type {(notice: unknown) => void} */ (callback));
      let active = true;
      return (...rest) => {
        if (rest.length !== 0) throw new Error('live-replay/unsubscribe: wrong arity');
        if (active) {
          active = false;
          listeners.delete(/** @type {(notice: unknown) => void} */ (callback));
        }
      };
    },
  };
  /**
   * Delivers script entries `[0, step)` to every subscriber, synchronously
   * and in order. Steps only advance; replaying from scratch needs a mount.
   * @param {number} step
   * @returns {number} Delivered count.
   */
  function emitUpTo(step) {
    if (!Number.isSafeInteger(step) || step < 0 || step > LIVE_REPLAY_SCRIPT.length) {
      throw new Error('live-replay/replay: unknown step');
    }
    for (; delivered < step; delivered += 1) {
      const notice = LIVE_REPLAY_SCRIPT[delivered].notice;
      for (const callback of [...listeners]) callback(notice);
    }
    return delivered;
  }
  return {
    port: /** @type {import('../core/hostAdapters.js').AuthorityPort} */ (/** @type {unknown} */ (port)),
    emitUpTo,
    calls,
    script: LIVE_REPLAY_SCRIPT,
  };
}

/**
 * Builds the replay mount: the fake port behind the REAL authority runtime,
 * stepped to the bench `step` from the query string. Live mode never calls
 * this; invalid steps refuse with a typed error for the boot refusal copy.
 * @param {unknown} search
 * @returns {{ ok: true, mount: LiveReplayMount }|{ ok: false, error: LiveReplayRefusal }}
 */
export function createLiveReplayMount(search) {
  const parsed = parseStepQuery(search);
  if (!parsed.ok) return parsed;
  const harness = createLiveReplayHarness();
  const runtime = createAuthorityRuntime(harness.port);
  if (!runtime) throw new Error('live-replay unavailable');
  harness.emitUpTo(parsed.step);
  return {
    ok: true,
    mount: {
      fixture: LIVE_REPLAY_FIXTURE,
      runtime,
      authorityPort: harness.port,
      calls: harness.calls,
      terminal: null,
    },
  };
}
