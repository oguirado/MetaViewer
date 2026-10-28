/**
 * @file `?state=terminal-live` alias fixture (MVUI29b lane T): one live
 * terminal session plus one ended, with the provider menu populated.
 * Pure frozen data plus deterministic fixture-only doubles: no host calls,
 * no dates, no random ids.
 *
 * NOT a FIXTURES key. Like `live-replay`, it travels outside the room's
 * exact key-set contract in `states.js`; unlike the `main.js` aliases it
 * resolves through the `resolveState.js` alias table, so no entry change
 * is needed. The kit provider menu opens from its own trigger; this state
 * carries the populated entries (`menuOpen` intent) plus the live binding
 * and the ended-session descriptor the tests drive through the real
 * renderer modules.
 *
 * The doubles mirror the fixed host API exactly: open takes command
 * `shell` or a provider id with empty args; attach returns the session
 * port; resize/close/copyText resolve literal `true`; listProviders
 * resolves reference-only rows with `shell` always present. Refusals
 * carry the host codes (`COMMAND_NOT_ALLOWED`, `TERMINAL_DISABLED`,
 * `TERMINAL_UNKNOWN_SESSION`, `ERR_CLIPBOARD_INVALID`): exactly these
 * four codes. Malformed requests throw the double's `invalid request`
 * contract violation instead.
 *
 * Plain JavaScript ES module with JSDoc types and zero imports.
 */

/**
 * Canonical `?state=` key for the terminal-live preview.
 * @type {string}
 */
export const TERMINAL_LIVE_KEY = 'terminal-live';

/** Binding session that stays live with scripted output. */
export const TERMINAL_LIVE_SESSION = 'term-live-01';

/** Broker-opened session the harness ends to raise the typed notice. */
export const TERMINAL_LIVE_ENDED = 'term-ended-01';

/** Capsule slot the terminal-live screen opens. */
export const TERMINAL_LIVE_CAPSULE = 'cap-01';

/**
 * Host-owned provider entries (identities, labels, server-owned argv) for
 * the direct host-data path of this state. Validated by the renderer
 * `terminal/providers` contract; never invented renderer-side.
 */
export const TERMINAL_LIVE_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'alpha',
    label: 'Alpha',
    hint: 'First host provider',
    argv: Object.freeze(['alpha', '--serve']),
  }),
  Object.freeze({
    id: 'beta.tool',
    label: 'Beta Tool',
    hint: '',
    argv: Object.freeze(['beta']),
  }),
]);

/**
 * Host-reported availability per provider id for this state.
 */
export const TERMINAL_LIVE_CAPABILITIES = Object.freeze([
  Object.freeze({ id: 'shell', available: true, reason: '' }),
  Object.freeze({ id: 'alpha', available: true, reason: '' }),
  Object.freeze({ id: 'beta.tool', available: true, reason: '' }),
]);

/**
 * Fixed-API provider listing for this state: reference-only rows (no
 * argv, projected from the host-owned entries above) plus host-reported
 * availability with `shell` always present.
 */
export const TERMINAL_LIVE_LISTING = Object.freeze({
  entries: Object.freeze(
    TERMINAL_LIVE_PROVIDERS.map((entry) => Object.freeze({ id: entry.id, label: entry.label, hint: entry.hint })),
  ),
  capabilities: TERMINAL_LIVE_CAPABILITIES,
});

/**
 * Advertised broker commands for this state: the menu protocol the kit
 * commits (`shell` row, `provider` rows). The renderer translates commits
 * to the fixed host `open` (command `shell` or a provider id, empty args).
 */
export const TERMINAL_LIVE_COMMANDS = Object.freeze(['shell', 'provider']);

/** Text the fixture `copyText` double admits: the closed host grammar. */
const TERMINAL_LIVE_COPYTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Commands the fixture `open` double admits: shell plus provider ids. */
const TERMINAL_LIVE_OPEN_COMMANDS = new Set([
  'shell',
  ...TERMINAL_LIVE_PROVIDERS.map((entry) => entry.id),
]);

/**
 * Scripted live-session output frames (port protocol records). Byte
 * content is fixed ASCII; the harness delivers each frame's bytes as one
 * `Uint8Array` under the live session id with contiguous sequences.
 */
export const TERMINAL_LIVE_SCRIPT = Object.freeze([
  Object.freeze({ seq: 1, bytes: Object.freeze([36, 32]) }),
  Object.freeze({ seq: 2, bytes: Object.freeze([114, 101, 97, 100, 121, 13, 10]) }),
]);

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
 * @param {string} id
 * @param {Partial<import('./states.js').FixtureCapsule>} [over]
 * @returns {import('./states.js').FixtureCapsule}
 */
function capsule(id, over = {}) {
  const row = {
    id,
    surfaceId: id,
    title: `Capsule ${id}`,
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
    ...over,
  };
  row.controlOwner = row.control === 'shared' ? 'none' : row.control;
  row.folded = row.visibility === 'folded';
  return row;
}

/** @type {import('./states.js').FixtureState} */
export const TERMINAL_LIVE_FIXTURE = deepFreeze({
  key: TERMINAL_LIVE_KEY,
  screen: 'multislot',
  scheme: 'mv-light',
  density: 'compact',
  epoch: 1,
  revision: 14,
  capsules: [
    capsule(TERMINAL_LIVE_CAPSULE, {
      title: 'Assisted editor',
      control: 'shared',
      aiSessionActivity: 'busy',
      dispatchOutcome: 'verified',
    }),
  ],
  ui: {
    terminalLive: {
      liveSession: TERMINAL_LIVE_SESSION,
      endedSession: TERMINAL_LIVE_ENDED,
      menuOpen: true,
    },
    terminalAttached: true,
    terminalSession: TERMINAL_LIVE_SESSION,
  },
  expectedAnchors: [
    { anchor: 'settings/scheme', role: 'button' },
    { anchor: 'terminal/toggle', role: 'button' },
    { anchor: `capsule/${TERMINAL_LIVE_CAPSULE}/panel`, role: 'region' },
    { anchor: `capsule/${TERMINAL_LIVE_CAPSULE}/fold`, role: 'button', ifPresent: true },
    { anchor: `capsule/${TERMINAL_LIVE_CAPSULE}/control`, role: 'button', ifPresent: true },
    { anchor: `capsule/${TERMINAL_LIVE_CAPSULE}/slot`, role: 'region' },
    { anchor: `capsule/${TERMINAL_LIVE_CAPSULE}/input-mode`, role: 'switch' },
    { anchor: `capsule/${TERMINAL_LIVE_CAPSULE}/copy-id`, role: 'button' },
    { anchor: `capsule/${TERMINAL_LIVE_CAPSULE}/terminal`, role: 'region' },
    { anchor: 'terminal/side/new', role: 'button' },
  ],
});

/**
 * @typedef {Object} TerminalLiveHarness
 * @property {{ open: (...args: unknown[]) => Promise<{ session: string }>, setEnabled: (...args: unknown[]) => Promise<true>, close: (...args: unknown[]) => void }} brokerPort Fixture-only broker port (open/setEnabled/close).
 * @property {{ postMessage: (message: unknown) => void, addEventListener: (type: string, receive: (event: { data: unknown }) => void) => void, removeEventListener: (type: string, receive: (event: { data: unknown }) => void) => void, start: () => void }} sessionPort Fixture-only session port for the live binding.
 * @property {{ attach: (...args: unknown[]) => Promise<Record<string, unknown>>, resize: (...args: unknown[]) => Promise<true>, close: (...args: unknown[]) => Promise<true>, listProviders: (...args: unknown[]) => Promise<{ entries: unknown, capabilities: unknown }>, copyText: (...args: unknown[]) => Promise<true> }} transport Fixture-only fixed-API transport source.
 * @property {{ writeText: (text: string) => Promise<void> }} clipboard Fixture-only clipboard.
 * @property {{ method: string }[]} calls Harness-owned recorded calls.
 * @property {(frames?: readonly { seq: number, bytes: readonly number[] }[]) => void} emitScript Deliver scripted live-session output frames.
 * @property {(frame: unknown) => void} emitData Deliver one port-protocol frame to the attached session port it names.
 * @property {(event: unknown) => void} emitExit End the attached session the event names through its session port.
 * @property {() => void} emitPortExit End the live binding session through the session port.
 */

/**
 * Creates the fixture-only terminal doubles for the terminal-live state.
 * Every method enforces the real contract: exact spec keys, the admitted
 * open commands and geometry bounds (mirroring the preload), single
 * positional arguments, and the `{port}` / literal-`true` replies.
 * Emission is harness-driven so tests capture each phase deterministically.
 * @returns {TerminalLiveHarness}
 */
export function createTerminalLiveHarness() {
  /** @type {{ method: string }[]} */
  const calls = [];
  /** @type {Set<(event: { data: unknown }) => void>} */
  const portListeners = new Set();
  /** @type {Map<string, { listeners: Set<(event: { data: unknown }) => void>, port: { postMessage: (message: unknown) => void, addEventListener: (type: string, receive: (event: { data: unknown }) => void) => void, removeEventListener: (type: string, receive: (event: { data: unknown }) => void) => void, start: () => void } }>} */
  const sessionPorts = new Map();
  /** @type {Set<string>} */
  const opened = new Set();
  /** @type {unknown[]} */
  const posted = [];
  let enabled = false;

  /**
   * @param {string} name
   * @param {readonly unknown[]} args
   * @param {number} arity
   */
  function checkArity(name, args, arity) {
    if (args.length !== arity) throw new Error(`terminal-live/${name}: wrong arity`);
  }

  /**
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Returns the stable per-session port double, creating it on first
   * attach. One port per broker session, like the host.
   * @param {string} session Broker session id.
   */
  function sessionPortFor(session) {
    let entry = sessionPorts.get(session);
    if (!entry) {
      /** @type {Set<(event: { data: unknown }) => void>} */
      const listeners = new Set();
      entry = {
        listeners,
        port: {
          /** @param {unknown} message */
          postMessage(message) {
            posted.push({ session, message });
          },
          /** @param {string} type @param {(event: { data: unknown }) => void} receive */
          addEventListener(type, receive) {
            if (type === 'message' && typeof receive === 'function') listeners.add(receive);
          },
          /** @param {string} type @param {(event: { data: unknown }) => void} receive */
          removeEventListener(type, receive) {
            if (type === 'message') listeners.delete(receive);
          },
          start() {},
        },
      };
      sessionPorts.set(session, entry);
    }
    return entry.port;
  }

  const sessionPort = {
    /** @param {unknown} message */
    postMessage(message) {
      posted.push(message);
    },
    /** @param {string} type @param {(event: { data: unknown }) => void} receive */
    addEventListener(type, receive) {
      if (type === 'message' && typeof receive === 'function') portListeners.add(receive);
    },
    /** @param {string} type @param {(event: { data: unknown }) => void} receive */
    removeEventListener(type, receive) {
      if (type === 'message') portListeners.delete(receive);
    },
    start() {},
  };

  const brokerPort = {
    /** @param {...unknown} args @returns {Promise<{ session: string }>} */
    open(...args) {
      checkArity('broker-open', args, 1);
      const spec = args[0];
      if (!isRecord(spec) || Object.keys(spec).sort().join(',') !== 'args,cols,command,rows') {
        throw new Error('terminal-live/broker-open: invalid spec');
      }
      // Fixed host API: command 'shell' or a provider id; argv and env
      // never cross, so args stays empty.
      if (typeof spec.command !== 'string' || !TERMINAL_LIVE_OPEN_COMMANDS.has(spec.command)) {
        throw new Error('terminal-live/broker-open: COMMAND_NOT_ALLOWED');
      }
      if (!Array.isArray(spec.args) || spec.args.length !== 0) {
        throw new Error('terminal-live/broker-open: invalid spec');
      }
      const cols = spec.cols;
      const rows = spec.rows;
      if (typeof cols !== 'number' || !Number.isSafeInteger(cols) || cols < 2 || cols > 500
          || typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 2 || rows > 300) {
        throw new Error('terminal-live/broker-open: invalid spec');
      }
      if (!enabled) throw new Error('terminal-live/broker-open: TERMINAL_DISABLED');
      calls.push(Object.freeze({ method: 'open' }));
      opened.add(TERMINAL_LIVE_ENDED);
      return Promise.resolve({ session: TERMINAL_LIVE_ENDED });
    },
    /** @param {...unknown} args @returns {Promise<true>} */
    setEnabled(...args) {
      checkArity('broker-setEnabled', args, 1);
      if (typeof args[0] !== 'boolean') throw new Error('terminal-live/broker-setEnabled: invalid flag');
      enabled = args[0];
      calls.push(Object.freeze({ method: 'setEnabled' }));
      return Promise.resolve(true);
    },
    /** @param {...unknown} args */
    close(...args) {
      checkArity('broker-close', args, 1);
      const request = args[0];
      if (!isRecord(request) || Object.keys(request).join(',') !== 'session') {
        throw new Error('terminal-live/broker-close: invalid request');
      }
      calls.push(Object.freeze({ method: 'close' }));
    },
  };

  const transport = {
    /** @param {...unknown} args @returns {Promise<Record<string, unknown>>} */
    attach(...args) {
      checkArity('transport-attach', args, 1);
      const request = args[0];
      if (!isRecord(request) || typeof request.session !== 'string') {
        throw new Error('terminal-live/transport-attach: invalid request');
      }
      // The double issues exactly one broker session; anything else is an
      // unknown session on the fixed host API.
      if (!opened.has(request.session)) {
        throw new Error('terminal-live/transport-attach: TERMINAL_UNKNOWN_SESSION');
      }
      calls.push(Object.freeze({ method: 'attach' }));
      return Promise.resolve({ port: sessionPortFor(request.session) });
    },
    /** @param {...unknown} args @returns {Promise<true>} */
    resize(...args) {
      checkArity('transport-resize', args, 1);
      const size = args[0];
      if (!isRecord(size) || typeof size.session !== 'string'
          || typeof size.cols !== 'number' || typeof size.rows !== 'number') {
        throw new Error('terminal-live/transport-resize: invalid request');
      }
      if (!opened.has(size.session)) {
        throw new Error('terminal-live/transport-resize: TERMINAL_UNKNOWN_SESSION');
      }
      if (!Number.isSafeInteger(size.cols) || size.cols < 2 || size.cols > 500
          || !Number.isSafeInteger(size.rows) || size.rows < 2 || size.rows > 300) {
        throw new Error('terminal-live/transport-resize: invalid request');
      }
      calls.push(Object.freeze({ method: 'resize' }));
      return Promise.resolve(true);
    },
    /** @param {...unknown} args @returns {Promise<true>} */
    close(...args) {
      checkArity('transport-close', args, 1);
      const request = args[0];
      if (!isRecord(request) || typeof request.session !== 'string') {
        throw new Error('terminal-live/transport-close: invalid request');
      }
      if (!opened.has(request.session)) {
        throw new Error('terminal-live/transport-close: TERMINAL_UNKNOWN_SESSION');
      }
      calls.push(Object.freeze({ method: 'transport-close' }));
      return Promise.resolve(true);
    },
    /** @param {...unknown} args @returns {Promise<{ entries: unknown, capabilities: unknown }>} */
    listProviders(...args) {
      checkArity('transport-listProviders', args, 0);
      calls.push(Object.freeze({ method: 'listProviders' }));
      return Promise.resolve(TERMINAL_LIVE_LISTING);
    },
    /** @param {...unknown} args @returns {Promise<true>} */
    copyText(...args) {
      checkArity('transport-copyText', args, 1);
      const request = args[0];
      if (!isRecord(request) || typeof request.text !== 'string') {
        throw new Error('terminal-live/transport-copyText: invalid request');
      }
      // Fixed host API: only the closed copytext grammar (a host security
      // test pins it); anything else refuses with ERR_CLIPBOARD_INVALID.
      if (!TERMINAL_LIVE_COPYTEXT_RE.test(request.text)) {
        throw new Error('terminal-live/transport-copyText: ERR_CLIPBOARD_INVALID');
      }
      calls.push(Object.freeze({ method: 'copyText' }));
      return Promise.resolve(true);
    },
  };

  /** @type {string[]} */
  const copied = [];
  const clipboard = {
    /** @param {string} text @returns {Promise<void>} */
    async writeText(text) {
      copied.push(text);
      calls.push(Object.freeze({ method: 'clipboard-write' }));
    },
  };

  return {
    brokerPort,
    sessionPort,
    transport,
    clipboard,
    calls,
    /** @param {readonly { seq: number, bytes: readonly number[] }[]=} frames */
    emitScript(frames = TERMINAL_LIVE_SCRIPT) {
      for (const frame of frames) {
        const data = {
          session: TERMINAL_LIVE_SESSION,
          seq: frame.seq,
          bytes: Uint8Array.from(frame.bytes),
        };
        for (const receive of [...portListeners]) receive({ data });
      }
    },
    /** @param {unknown} frame */
    emitData(frame) {
      const session = isRecord(frame) && typeof frame.session === 'string' ? frame.session : null;
      const entry = session ? sessionPorts.get(session) : undefined;
      if (!entry) return;
      for (const receive of [...entry.listeners]) receive({ data: frame });
    },
    /** @param {unknown} event */
    emitExit(event) {
      const session = isRecord(event) && typeof event.session === 'string' ? event.session : null;
      const entry = session ? sessionPorts.get(session) : undefined;
      if (!entry) return;
      const data = isRecord(event) && event.reason === 'failed'
        ? { session, error: 'Session failed' }
        : { session, exitCode: 0 };
      for (const receive of [...entry.listeners]) receive({ data });
    },
    emitPortExit() {
      const data = { session: TERMINAL_LIVE_SESSION, exitCode: 0 };
      for (const receive of [...portListeners]) receive({ data });
    },
  };
}
