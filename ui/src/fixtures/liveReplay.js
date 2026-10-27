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
 *
 * MVUI6 (lane R, room mvui4l): named bench steps extend the numeric frame
 * phases without changing them. Numeric `?step=0..8` replays frame entries
 * `[0, N)` exactly as before; named `?step=<name>` replays the full script
 * (recovered live) plus one bench outcome through the real App dispatch
 * paths (via the fixture-only hook installed by lane V): propose verdicts,
 * intent acks/refusals, multislot fold outcomes, and terminal lifecycle
 * rows. The frozen `LIVE_REPLAY_STEP_MAP` documents every step for the
 * vision bench. The fixture-only fake terminal ports enforce the real
 * broker contract (exact arity, closed specs, literal `true` acks, closed
 * session-id grammar) with deterministic fixed ids.
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

/**
 * @typedef {Object} LiveReplayBenchAction
 * @property {'propose'|'intent'|'multislot'|'terminal'} kind - Bench dispatch family.
 * @property {Readonly<Record<string, unknown>>} [body] - Frozen dispatch body for propose/intent/multislot.
 * @property {string} [capsuleId] - Capsule identity for multislot dispatches.
 * @property {'pending'|'attached'|'exited'|'failed'} [lifecycle] - Terminal lifecycle for terminal steps.
 */

/**
 * @typedef {Object} LiveReplayStepMapEntry
 * @property {number|string} step - Numeric frame step (0..8) or named bench step.
 * @property {string} name - Stable step name for the bench.
 * @property {'frames'|'propose'|'intent'|'multislot'|'terminal'} kind - Step family.
 * @property {string} description - Designed bench description, never placeholder text.
 * @property {number} frames - Frame notices emitted (numeric: step count; named: full script).
 * @property {LiveReplayBenchAction|null} bench - Frozen bench action, or null for pure frame steps.
 * @property {Readonly<Record<string, unknown>>} expects - Frozen expected outcome hints for the bench.
 */

/**
 * @typedef {Object} LiveReplayTerminalHarness
 * @property {import('../core/hostAdapters.js').TerminalPort} brokerPort - Fake broker port (open/setEnabled/close).
 * @property {{ postMessage: (...args: unknown[]) => void, addEventListener: (...args: unknown[]) => void, removeEventListener: (...args: unknown[]) => void, start: (...args: unknown[]) => void }} sessionPort - Fake MessagePort-like session port.
 * @property {readonly { method: string }[]} calls - Harness-owned recorded terminal calls.
 * @property {() => void} emitExit - Deliver a deterministic exit message to session listeners.
 * @property {() => void} emitFrame - Deliver one deterministic valid frame (failed lifecycle throws on ack).
 * @property {'pending'|'attached'|'exited'|'failed'} lifecycle - Harness lifecycle mode.
 */

/** Canonical `?state=` value for the bench-only replay path. */
export const LIVE_REPLAY_KEY = 'live-replay';

/** Surface identity replayed by every script notice; matches the fixture capsule. */
export const LIVE_REPLAY_SURFACE_ID = 'cap-01';

/** Fixed terminal session identity for every terminal bench step. */
export const LIVE_REPLAY_TERMINAL_SESSION = 'term-01';

/** Fixed multislot slot identity for fold/unfold bench intents. */
export const LIVE_REPLAY_MULTISLOT_SLOT = 'cuk-ai-slot-cap-01';

/** Allowlisted named bench steps (mvui6); every other name stays invalid. */
export const LIVE_REPLAY_BENCH_NAMES = Object.freeze([
  'propose-admitted',
  'propose-refused',
  'intent-acked',
  'intent-refused',
  'multislot-fold-acked',
  'multislot-unfold-refused',
  'terminal-pending',
  'terminal-attached',
  'terminal-exited',
  'terminal-failed',
]);

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
 * Frozen step map for the vision bench (mvui6): every numeric frame phase
 * plus every named bench outcome. Numeric steps emit frame entries `[0, N)`;
 * named steps emit the full script (recovered live) and drive one bench
 * action through the real App dispatch paths via the fixture-only hook.
 * The bench reads this table to reach verdict, refusal, intent, multislot,
 * and terminal rows. Deep-frozen, deterministic, no random ids.
 * @type {readonly LiveReplayStepMapEntry[]}
 */
export const LIVE_REPLAY_STEP_MAP = deepFreeze([
  { step: 0, name: 'waiting', kind: 'frames', description: 'Waiting for the first surface update.', frames: 0, bench: null, expects: { rows: 0, envelope: null } },
  { step: 1, name: 'live-1', kind: 'frames', description: 'Live surface at generation 1.', frames: 1, bench: null, expects: { rows: 1, generation: 1, control: 'shared' } },
  { step: 2, name: 'live-2', kind: 'frames', description: 'Live surface at generation 2.', frames: 2, bench: null, expects: { rows: 1, generation: 2, control: 'shared' } },
  { step: 3, name: 'live-3', kind: 'frames', description: 'Live surface at generation 3.', frames: 3, bench: null, expects: { rows: 1, generation: 3, control: 'shared' } },
  { step: 4, name: 'human-control', kind: 'frames', description: 'Human control at generation 4.', frames: 4, bench: null, expects: { rows: 1, generation: 4, control: 'human' } },
  { step: 5, name: 'agent-acting', kind: 'frames', description: 'Agent acting at generation 5.', frames: 5, bench: null, expects: { rows: 1, generation: 5, control: 'agent' } },
  { step: 6, name: 'stale-resend', kind: 'frames', description: 'Stale generation absorbed without applying.', frames: 6, bench: null, expects: { rows: 1, generation: 5, revision: 6 } },
  { step: 7, name: 'lost', kind: 'frames', description: 'Surface lost at generation 6.', frames: 7, bench: null, expects: { rows: 1, generation: 6, backendLifecycle: 'lost' } },
  { step: 8, name: 'recovered', kind: 'frames', description: 'Recovered live at generation 7.', frames: 8, bench: null, expects: { rows: 1, generation: 7, backendLifecycle: 'active' } },
  {
    step: 'propose-admitted', name: 'propose-admitted', kind: 'propose',
    description: 'Propose verdict admitted through the real dispatch path.',
    frames: 8, bench: { kind: 'propose', body: { action: 'example' } },
    expects: { activity: 'ACTION_ADMITTED', tone: 'success', text: 'Action admitted.' },
  },
  {
    step: 'propose-refused', name: 'propose-refused', kind: 'propose',
    description: 'Policy refusal through the real dispatch path.',
    frames: 8, bench: { kind: 'propose', body: { action: 'example', refuse: true } },
    expects: { activity: 'POLICY', tone: 'refusal', text: 'This action is unavailable under the current policy.' },
  },
  {
    step: 'intent-acked', name: 'intent-acked', kind: 'intent',
    description: 'Intent acknowledgement through the real dispatch path.',
    frames: 8, bench: { kind: 'intent', body: { op: 'take_control', surfaceId: 'cap-01' } },
    expects: { activity: 'INTENT_ACKNOWLEDGED', tone: 'success', text: 'Request sent.' },
  },
  {
    step: 'intent-refused', name: 'intent-refused', kind: 'intent',
    description: 'Intent refusal through the real dispatch path.',
    frames: 8, bench: { kind: 'intent', body: { op: 'take_control', surfaceId: '' } },
    expects: { activity: 'HOST_REQUEST_REFUSED', tone: 'refusal', text: 'This request is unavailable. Please try again.' },
  },
  {
    step: 'multislot-fold-acked', name: 'multislot-fold-acked', kind: 'multislot',
    description: 'Multislot fold acknowledged through the real multislot path.',
    frames: 8,
    bench: { kind: 'multislot', capsuleId: 'cap-01', body: { schema: 'ui_intent/v0.2', request_id: 'replay-bench-fold-1', op: 'fold', params: { slot_id: 'cuk-ai-slot-cap-01' } } },
    expects: { activity: 'INTENT_ACKNOWLEDGED', tone: 'success', text: 'Request sent.' },
  },
  {
    step: 'multislot-unfold-refused', name: 'multislot-unfold-refused', kind: 'multislot',
    description: 'Multislot unfold refused through the real multislot path.',
    frames: 8,
    bench: { kind: 'multislot', capsuleId: 'cap-01', body: { schema: 'ui_intent/v0.2', request_id: 'replay-bench-unfold-1', op: 'unfold', params: {} } },
    expects: { activity: 'HOST_REQUEST_REFUSED', tone: 'refusal', text: 'This request is unavailable. Please try again.' },
  },
  {
    step: 'terminal-pending', name: 'terminal-pending', kind: 'terminal',
    description: 'Terminal launch pending row through the real broker path.',
    frames: 8, bench: { kind: 'terminal', lifecycle: 'pending' },
    expects: { row: 'pending', anchor: 'terminal/pending', text: 'Starting session…' },
  },
  {
    step: 'terminal-attached', name: 'terminal-attached', kind: 'terminal',
    description: 'Terminal attached session through the real binding path.',
    frames: 8, bench: { kind: 'terminal', lifecycle: 'attached' },
    expects: { row: 'attached', session: 'term-01', anchor: 'terminal/session/term-01/tab' },
  },
  {
    step: 'terminal-exited', name: 'terminal-exited', kind: 'terminal',
    description: 'Terminal exited notice through the real binding path.',
    frames: 8, bench: { kind: 'terminal', lifecycle: 'exited' },
    expects: { row: 'exited', code: 'TERMINAL_SESSION_EXITED', text: 'Session ended.', tone: 'info', anchor: 'capsule/cap-01/session-notice' },
  },
  {
    step: 'terminal-failed', name: 'terminal-failed', kind: 'terminal',
    description: 'Terminal failed notice through the real binding path.',
    frames: 8, bench: { kind: 'terminal', lifecycle: 'failed' },
    expects: { row: 'failed', code: 'TERMINAL_SESSION_FAILED', text: 'Session ended unexpectedly.', tone: 'error', anchor: 'capsule/cap-01/session-notice' },
  },
]);

/**
 * Parses the bench-only `step` parameter. Absent means the full replay.
 * Canonical non-negative integers (0..8) plus the allowlisted named bench
 * steps; anything else is a typed refusal.
 * @param {unknown} search
 * @returns {{ ok: true, step: number|string }|{ ok: false, error: LiveReplayRefusal }}
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
  // Named bench steps (mvui6): allowlisted before the numeric grammar so the
  // vision bench can reach verdict, refusal, intent, multislot, and terminal
  // rows. Every other name stays an invalid query (never unknown).
  if (LIVE_REPLAY_BENCH_NAMES.includes(text)) {
    return { ok: true, step: text };
  }
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
 * Creates the fixture-only fake terminal ports for one lifecycle (mvui6).
 * The broker port enforces the real contract: bound receiver, exact
 * positional arity, closed open specs (`command`, `args`, `cols`, `rows`),
 * closed session-id grammar, and literal `true` enable acks. The session
 * port implements the minimal MessagePort surface the renderer facade
 * consumes (`postMessage`, `addEventListener`, `removeEventListener`,
 * `start`) with the same receiver/arity guards. Behaviour is fixed per
 * lifecycle: `pending` opens stay pending for the bench screenshot,
 * `attached` carries a live binding with no exit, `exited` emits a clean
 * exit, and `failed` throws on the ack write so the pump reports failed.
 * Pure: fixed ids, no dates, no random ids.
 * @param {'pending'|'attached'|'exited'|'failed'} lifecycle
 * @returns {LiveReplayTerminalHarness}
 */
export function createLiveReplayTerminalHarness(lifecycle) {
  if (lifecycle !== 'pending' && lifecycle !== 'attached' && lifecycle !== 'exited' && lifecycle !== 'failed') {
    throw new Error('live-replay/terminal: unknown lifecycle');
  }
  /** @type {{ method: string }[]} */
  const calls = [];
  /** @type {Set<(event: { data: unknown }) => void>} */
  const listeners = new Set();
  /**
   * @param {unknown} self
   * @param {string} name
   */
  function checkTerminalReceiver(self, name) {
    if (self !== brokerPort && self !== sessionPort) throw new Error(`live-replay/${name}: invalid receiver`);
  }
  /**
   * @param {string} name
   * @param {readonly unknown[]} args
   * @param {number} arity
   */
  function checkTerminalArity(name, args, arity) {
    if (args.length !== arity) throw new Error(`live-replay/${name}: wrong arity`);
  }
  /**
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  function isTerminalRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  const brokerPort = {
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {Promise<{ session: string }>}
     */
    open(...args) {
      checkTerminalReceiver(this, 'terminal-open');
      checkTerminalArity('terminal-open', args, 1);
      const spec = args[0];
      if (!isTerminalRecord(spec) || Object.keys(spec).sort().join(',') !== 'args,cols,command,rows') {
        throw new Error('live-replay/terminal-open: invalid spec');
      }
      if (typeof spec.command !== 'string' || spec.command.length === 0) {
        throw new Error('live-replay/terminal-open: invalid spec');
      }
      if (!Array.isArray(spec.args) || !spec.args.every((item) => typeof item === 'string')) {
        throw new Error('live-replay/terminal-open: invalid spec');
      }
      if (typeof spec.cols !== 'number' || !Number.isSafeInteger(spec.cols) || spec.cols < 1
        || typeof spec.rows !== 'number' || !Number.isSafeInteger(spec.rows) || spec.rows < 1) {
        throw new Error('live-replay/terminal-open: invalid spec');
      }
      calls.push(Object.freeze({ method: 'open' }));
      if (lifecycle === 'pending') return new Promise(() => {});
      return Promise.resolve({ session: LIVE_REPLAY_TERMINAL_SESSION });
    },
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {Promise<true>}
     */
    setEnabled(...args) {
      checkTerminalReceiver(this, 'terminal-setEnabled');
      checkTerminalArity('terminal-setEnabled', args, 1);
      if (typeof args[0] !== 'boolean') throw new Error('live-replay/terminal-setEnabled: invalid flag');
      calls.push(Object.freeze({ method: 'setEnabled' }));
      return Promise.resolve(true);
    },
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {void}
     */
    close(...args) {
      checkTerminalReceiver(this, 'terminal-close');
      checkTerminalArity('terminal-close', args, 1);
      const request = args[0];
      if (!isTerminalRecord(request) || Object.keys(request).join(',') !== 'session') {
        throw new Error('live-replay/terminal-close: invalid request');
      }
      if (typeof request.session !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(request.session)) {
        throw new Error('live-replay/terminal-close: invalid request');
      }
      calls.push(Object.freeze({ method: 'close' }));
    },
  };
  const sessionPort = {
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {void}
     */
    postMessage(...args) {
      checkTerminalReceiver(this, 'terminal-postMessage');
      checkTerminalArity('terminal-postMessage', args, 1);
      const message = args[0];
      if (!isTerminalRecord(message) || typeof message.session !== 'string') {
        throw new Error('live-replay/terminal-postMessage: invalid message');
      }
      calls.push(Object.freeze({ method: 'postMessage' }));
      // Failed lifecycle: the ack write throws so the multislot pump reports
      // `failed` (typed error row) instead of advancing the credit range.
      if (lifecycle === 'failed' && Object.hasOwn(message, 'ack')) {
        throw new Error('live-replay/terminal: ack refused');
      }
    },
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {void}
     */
    addEventListener(...args) {
      checkTerminalReceiver(this, 'terminal-addEventListener');
      checkTerminalArity('terminal-addEventListener', args, 2);
      if (args[0] !== 'message' || typeof args[1] !== 'function') {
        throw new Error('live-replay/terminal-addEventListener: message listener required');
      }
      listeners.add(/** @type {(event: { data: unknown }) => void} */ (args[1]));
      calls.push(Object.freeze({ method: 'addEventListener' }));
    },
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {void}
     */
    removeEventListener(...args) {
      checkTerminalReceiver(this, 'terminal-removeEventListener');
      checkTerminalArity('terminal-removeEventListener', args, 2);
      listeners.delete(/** @type {(event: { data: unknown }) => void} */ (args[1]));
      calls.push(Object.freeze({ method: 'removeEventListener' }));
    },
    /**
     * @this {Record<string, unknown>}
     * @param {...unknown} args
     * @returns {void}
     */
    start(...args) {
      checkTerminalReceiver(this, 'terminal-start');
      checkTerminalArity('terminal-start', args, 0);
      calls.push(Object.freeze({ method: 'start' }));
    },
  };
  return {
    brokerPort: /** @type {import('../core/hostAdapters.js').TerminalPort} */ (/** @type {unknown} */ (brokerPort)),
    sessionPort: /** @type {LiveReplayTerminalHarness['sessionPort']} */ (/** @type {unknown} */ (sessionPort)),
    calls,
    lifecycle,
    emitExit() {
      const event = { data: { session: LIVE_REPLAY_TERMINAL_SESSION, exitCode: 0 } };
      for (const receive of [...listeners]) receive(event);
    },
    emitFrame() {
      const event = { data: { session: LIVE_REPLAY_TERMINAL_SESSION, seq: 1, bytes: Uint8Array.from([65]) } };
      for (const receive of [...listeners]) receive(event);
    },
  };
}

/**
 * Builds the replay mount: the fake port behind the REAL authority runtime,
 * stepped to the bench `step` from the query string. Numeric steps emit
 * entries `[0, N)` exactly as before; named bench steps emit the full
 * script (recovered live) and attach a frozen bench descriptor plus, for
 * terminal lifecycles, the fixture-only fake terminal ports. Live mode
 * never calls this; invalid steps refuse with a typed error.
 * @param {unknown} search
 * @returns {{ ok: true, mount: Omit<LiveReplayMount,'terminal'> & { bench?: LiveReplayBenchAction, terminalBrokerPort?: import('../core/hostAdapters.js').TerminalPort, terminalHarness?: LiveReplayTerminalHarness, terminal: null|{ session: string, port: unknown } } }|{ ok: false, error: LiveReplayRefusal }}
 */
export function createLiveReplayMount(search) {
  const parsed = parseStepQuery(search);
  if (!parsed.ok) return parsed;
  const harness = createLiveReplayHarness();
  const runtime = createAuthorityRuntime(harness.port);
  if (!runtime) throw new Error('live-replay unavailable');
  if (typeof parsed.step === 'number') {
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
  harness.emitUpTo(LIVE_REPLAY_SCRIPT.length);
  const entry = LIVE_REPLAY_STEP_MAP.find((row) => row.step === parsed.step) ?? null;
  const bench = entry?.bench ?? null;
  if (!bench) throw new Error('live-replay/bench: unknown step');
  if (bench.kind === 'terminal') {
    const terminalHarness = createLiveReplayTerminalHarness(bench.lifecycle ?? 'attached');
    const pending = bench.lifecycle === 'pending';
    return {
      ok: true,
      mount: {
        fixture: LIVE_REPLAY_FIXTURE,
        runtime,
        authorityPort: harness.port,
        calls: harness.calls,
        terminal: pending ? null : { session: LIVE_REPLAY_TERMINAL_SESSION, port: terminalHarness.sessionPort },
        bench,
        terminalBrokerPort: terminalHarness.brokerPort,
        terminalHarness,
      },
    };
  }
  return {
    ok: true,
    mount: {
      fixture: LIVE_REPLAY_FIXTURE,
      runtime,
      authorityPort: harness.port,
      calls: harness.calls,
      terminal: null,
      bench,
    },
  };
}
