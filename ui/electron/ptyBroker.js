// @ts-check
'use strict';

/**
 * W1-TERM-BROKER supervised PTY broker: parent transport, child engine,
 * main IPC bridge and renderer facade seam.
 *
 * Main supervises; the broker owns PTY handles; core owns admission. The
 * broker child directly spawns server-owned provider argv and
 * speaks versioned line-delimited JSON; renderer and child never exchange
 * executable paths, argv, cwd or env, only provider references. Imports are
 * inert: the fork-entry wiring lives outside this surface and invokes the
 * exported engine explicitly. No Electron import: unit tests run under Node.
 *
 * @module ptyBroker
 */

import { validateKillTarget } from './coreLauncher.js';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Typed broker failure; a failure admits nothing and spawns nothing.
 */
export class PtyBrokerError extends Error {
  /**
   * @param {string} code Stable refusal code.
   * @param {string} message Human detail (never PTY output or secrets).
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PtyBrokerError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * @param {string} code Stable refusal code.
 * @param {string} message Human detail.
 * @returns {never}
 */
function fail(code, message) {
  throw new PtyBrokerError(code, message);
}

/** Protocol version carried on every broker message and IPC outcome. */
export const TERMINAL_WIRE_VERSION = 1;

/** Closed IPC channel prefix; renderer never sends raw channel names. */
export const TERMINAL_CHANNEL_PREFIX = 'metaviewer:terminal.';

/** Fixed IPC operations behind the prefix. */
export const TERMINAL_METHODS = Object.freeze([
  'open',
  'attach',
  'close',
  'write',
  'resize',
  'ack',
  'capabilities',
]);

/** Full channel per fixed method, mirrored by the main wiring. */
export const TERMINAL_CHANNELS = Object.freeze({
  open: 'metaviewer:terminal.open',
  attach: 'metaviewer:terminal.attach',
  close: 'metaviewer:terminal.close',
  write: 'metaviewer:terminal.write',
  resize: 'metaviewer:terminal.resize',
  ack: 'metaviewer:terminal.ack',
  capabilities: 'metaviewer:terminal.capabilities',
});

/** Electron utility service name for the broker child. */
export const TERMINAL_SERVICE_NAME = 'MetaViewer terminal';

/** Args after the executable; total argv length is 1..MAX_ARGV_LENGTH. */
export const MAX_ARGS = 32;
export const MAX_ARGV_LENGTH = MAX_ARGS + 1;
export const MAX_ARG_BYTES = 4096;
export const MAX_ENV_VALUE_BYTES = 4096;
/** Env name grammar, exemplar parity. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Session and provider id grammar, exemplar parity. */
export const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Strict base64 gate; Buffer decoding alone would skip bad characters. */
export const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const MAX_WRITE_BYTES = 65536;
export const SESSION_BYTE_CAP = 8388608;
export const MAX_LINE_BYTES = 262144;
export const MAX_SESSIONS = 8;
export const MAX_LIFETIME_MS = 3600000;
export const MAX_TOMBSTONES = 256;
export const MIN_COLS = 2;
export const MAX_COLS = 1000;
export const MIN_ROWS = 2;
export const MAX_ROWS = 1000;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const HIGH_WATER_BYTES = 131072;
export const LOW_WATER_BYTES = 65536;
export const MAX_PENDING_BYTES = 524288;
export const MAX_PENDING_FRAMES = 4096;
/** PATH segments scanned during resolution; core launcher parity. */
export const TERMINAL_MAX_PATH_SEGMENTS = 32;

/** Default login shell; bash-only flags are gated to bash basenames. */
export const LOGIN_SHELL_FALLBACK = '/bin/bash';
/** Hermetic flags accepted before -l -i, bash shells only. */
export const SHELL_HERMETIC_ARGS = Object.freeze(['--noprofile', '--norc']);

/** Renderer must never send these value keys; main refuses on sight. */
const FORBIDDEN_VALUE_KEYS = Object.freeze([
  'exe',
  'cwd',
  'env',
  'argv',
  'path',
  'PATH',
  'channel',
]);

/** Credential-looking env names never reach a child, case-insensitively. */
const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|KEY)/i;

/** Fixed exit-reason tokens; no PTY output or env ever leaves in events. */
const EXIT_REASONS = Object.freeze(['SESSION_CAP', 'SESSION_EXPIRED']);

/**
 * True when the variable name must be scrubbed from every child env:
 * dynamic-loader prefixes, runtime toggles and interpreter variables.
 * @param {unknown} name Alleged env name.
 * @returns {boolean}
 */
export function isScrubbedEnvName(name) {
  if (typeof name !== 'string') return true;
  return (
    name.startsWith('LD_') ||
    name.startsWith('DYLD_') ||
    name === 'NODE_OPTIONS' ||
    name === 'ELECTRON_RUN_AS_NODE' ||
    name.startsWith('PYTHON')
  );
}

/**
 * @param {unknown} value Alleged UTF-8 string.
 * @returns {number} Byte length, or -1 when not a string.
 */
function utf8Length(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : -1;
}

/**
 * @param {unknown} value Alleged plain record.
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value Alleged safe integer.
 * @returns {value is number}
 */
function isSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * @param {unknown} id Alleged session or provider id.
 * @returns {boolean}
 */
function isTerminalId(id) {
  return typeof id === 'string' && TERMINAL_ID_RE.test(id);
}

/**
 * Validated provider argv: executable plus at most MAX_ARGS args, each a
 * bounded NUL-free string, argv[0] non-empty and never an option flag.
 * Limits mirror the providers lane; this copy is the main-side gate that
 * never trusts renderer-shaped data. Throws only PtyBrokerError.
 * @param {unknown} argv Alleged argv array.
 * @returns {ReadonlyArray<string>} Frozen validated copy.
 */
export function validateProviderArgv(argv) {
  if (!Array.isArray(argv)) fail('ARGV_SHAPE', 'argv must be an array');
  const items = /** @type {Array<unknown>} */ (argv);
  if (items.length < 1 || items.length > MAX_ARGV_LENGTH) {
    fail('ARGV_LENGTH', `argv length must be 1..${MAX_ARGV_LENGTH}`);
  }
  for (const item of items) {
    if (typeof item !== 'string') fail('ARGV_ITEM', 'argv items must be strings');
    const text = /** @type {string} */ (item);
    if (text.includes('\0')) fail('ARGV_NUL', 'argv items must not contain NUL');
    if (Buffer.byteLength(text, 'utf8') > MAX_ARG_BYTES) {
      fail('ARGV_BYTES', `argv item exceeds ${MAX_ARG_BYTES} bytes`);
    }
  }
  const head = /** @type {string} */ (items[0]);
  if (head.length === 0) fail('ARGV0_EMPTY', 'argv[0] must be non-empty');
  if (head.startsWith('-')) fail('ARGV0_DASH', 'argv[0] must not start with a dash');
  return Object.freeze([.../** @type {Array<string>} */ (items)]);
}

/**
 * Absolute login shell path, or the pinned bash fallback. Only absolute
 * bounded NUL-free overrides are honoured; anything else falls back.
 * @param {unknown} override Alleged shell path, or undefined for $SHELL.
 * @returns {string}
 */
export function resolveLoginShell(override) {
  const value = override === undefined ? process.env.SHELL : override;
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ENV_VALUE_BYTES &&
    !value.includes('\0') &&
    isAbsolute(value)
  ) {
    return value;
  }
  return LOGIN_SHELL_FALLBACK;
}

/**
 * Single-quote an argv item for the login shell -c string: wrap in quotes
 * and escape embedded quotes. The -c string is built ONLY from validated
 * argv; caller shell text is never accepted.
 * @param {unknown} arg Alleged argv item.
 * @returns {string}
 */
export function quoteShellArg(arg) {
  if (typeof arg !== 'string' || arg.includes('\0') || utf8Length(arg) > MAX_ARG_BYTES) {
    fail('ARG_INVALID', 'cannot quote invalid shell arg');
  }
  const text = /** @type {string} */ (arg);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * `exec -- <quoted argv>` replacing the login shell, so the provider TUI
 * owns the PTY and its exit code ends the session.
 * @param {unknown} providerArgv Validated provider argv.
 * @returns {string}
 */
export function buildProviderExecCommand(providerArgv) {
  const argv = validateProviderArgv(providerArgv);
  return `exec -- ${argv.map((item) => quoteShellArg(item)).join(' ')}`;
}

/**
 * Basename of a shell path for hermetic-flag gating.
 * @param {string} shell Absolute shell path.
 * @returns {string}
 */
function shellBasename(shell) {
  return basename(shell);
}

/**
 * Login shell spawn spec: hermetic bash flags, then -l -i. Bash-only
 * flags are refused for non-bash shells, which keep bare -l -i.
 * @param {unknown} extraArgs Alleged extra args, hermetic flags only.
 * @param {unknown} loginShell Alleged shell override.
 * @returns {{ file: string, args: ReadonlyArray<string> }}
 */
export function buildShellSpawn(extraArgs = [], loginShell) {
  if (!Array.isArray(extraArgs) || extraArgs.length > MAX_ARGS) {
    fail('ARGS_SHAPE', 'extra args must be an array within cap');
  }
  const file = resolveLoginShell(loginShell);
  const isBash = shellBasename(file) === 'bash';
  for (const item of /** @type {Array<unknown>} */ (extraArgs)) {
    if (typeof item !== 'string' || item.includes('\0') || utf8Length(item) > MAX_ARG_BYTES) {
      fail('ARGS_ITEM', 'extra args must be bounded NUL-free strings');
    }
    const text = /** @type {string} */ (item);
    if (!SHELL_HERMETIC_ARGS.includes(text)) fail('ARGS_FLAG', 'only hermetic flags allowed');
    if (!isBash) fail('ARGS_SHELL', 'hermetic flags require a bash shell');
  }
  return { file, args: Object.freeze([.../** @type {Array<string>} */ (extraArgs), '-l', '-i']) };
}

/**
 * [TARGET, unit decision] Direct provider spawn; no login-shell command string.
 * The legacy loginShell argument remains source-compatible but is not executed.
 * @param {unknown} providerArgv Validated provider argv.
 * @param {unknown} loginShell Alleged shell override.
 * @returns {{ file: string, args: ReadonlyArray<string> }}
 */
export function buildProviderSpawn(providerArgv, loginShell) {
  const argv = validateProviderArgv(providerArgv);
  if (!isAbsolute(argv[0])) fail('PROFILE_EXEC', 'provider executable must be absolute');
  return { file: argv[0], args: Object.freeze(argv.slice(1)) };
}

/**
 * Build the frozen broker child env from host-observed values: only
 * allowlisted names are copied, scrubbed and credential-looking names in
 * the allowlist are refused loudly, and there is no renderer-env input
 * at all, so renderer env is rejected structurally. Oversize host values
 * are truncated to cap, exemplar parity. Throws only PtyBrokerError.
 * @param {unknown} hostEnv Alleged host env record.
 * @param {unknown} allowlist Alleged allowlisted names.
 * @returns {Readonly<Record<string, string>>} Frozen child env.
 */
export function validateProviderEnv(hostEnv, allowlist) {
  if (!isRecord(hostEnv)) fail('ENV_SHAPE', 'host env must be a record');
  if (!Array.isArray(allowlist)) fail('ENV_ALLOWLIST', 'allowlist must be an array');
  const host = /** @type {Record<string, unknown>} */ (hostEnv);
  const out = /** @type {Record<string, string>} */ ({});
  for (const entry of /** @type {Array<unknown>} */ (allowlist)) {
    if (typeof entry !== 'string' || !ENV_KEY_RE.test(entry)) {
      fail('ENV_NAME', 'allowlist names must match env grammar');
    }
    const name = /** @type {string} */ (entry);
    if (isScrubbedEnvName(name)) fail('ENV_SCRUB', `scrubbed name refused: ${name}`);
    if (SECRET_ENV_RE.test(name)) fail('ENV_SECRET', `credential-looking name refused: ${name}`);
    const raw = host[name];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') fail('ENV_VALUE', `host value for ${name} must be a string`);
    const text = /** @type {string} */ (raw);
    if (text.includes('\0')) fail('ENV_NUL', `host value for ${name} must not contain NUL`);
    const bytes = Buffer.from(text, 'utf8');
    let end = Math.min(bytes.length, MAX_ENV_VALUE_BYTES);
    // If the cut lands inside a code point, omit that entire code point.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out[name] = bytes.subarray(0, end).toString('utf8');
  }
  return Object.freeze(out);
}

/**
 * Strict check of an already-built spawn env (admitted profile): every
 * name and value must be clean, with no truncation and no defaults.
 * Throws only PtyBrokerError.
 * @param {unknown} env Alleged spawn env record.
 * @returns {Readonly<Record<string, string>>} Frozen validated copy.
 */
export function validateSpawnEnv(env) {
  if (!isRecord(env)) fail('ENV_SHAPE', 'spawn env must be a record');
  const out = /** @type {Record<string, string>} */ ({});
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (env))) {
    if (!ENV_KEY_RE.test(name)) fail('ENV_NAME', 'spawn env names must match env grammar');
    if (isScrubbedEnvName(name)) fail('ENV_SCRUB', `scrubbed name refused: ${name}`);
    if (SECRET_ENV_RE.test(name)) fail('ENV_SECRET', `credential-looking name refused: ${name}`);
    if (typeof raw !== 'string') fail('ENV_VALUE', `spawn value for ${name} must be a string`);
    const text = /** @type {string} */ (raw);
    if (text.includes('\0')) fail('ENV_NUL', `spawn value for ${name} must not contain NUL`);
    if (Buffer.byteLength(text, 'utf8') > MAX_ENV_VALUE_BYTES) {
      fail('ENV_BYTES', `spawn value for ${name} exceeds cap`);
    }
    out[name] = text;
  }
  return Object.freeze(out);
}

/**
 * Fail-closed node-pty directory resolution: explicit override, sibling
 * of this module, packaged real-file path outside ASAR, then ordinary
 * package resolution. Throws NATIVE_ABSENT when nothing resolves.
 * @param {unknown} env Alleged env record carrying the override.
 * @param {unknown} resourcesPath Alleged packaged resources dir, if any.
 * @returns {string} Resolved node-pty directory.
 */
export function resolveNodePtyDir(env = process.env, resourcesPath = undefined) {
  if (!isRecord(env)) fail('NATIVE_ENV', 'env must be a record for native resolution');
  const table = /** @type {Record<string, unknown>} */ (env);
  const override = table.METAVIEWER_NODE_PTY_DIR;
  if (typeof override === 'string' && override.length > 0) {
    if (override.includes('\0')) fail('NATIVE_OVERRIDE', 'native override must not contain NUL');
    return resolve(override);
  }
  const sibling = join(fileURLToPath(import.meta.url), '..', 'node-pty');
  if (existsSync(sibling)) return sibling;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    const packaged = join(resourcesPath, 'build-native', 'pty-runtime', 'node-pty');
    if (existsSync(packaged)) return packaged;
  }
  try {
    const require = createRequire(import.meta.url);
    return resolve(require.resolve('node-pty/package.json'), '..');
  } catch {
    fail('NATIVE_ABSENT', 'node-pty is not installed');
  }
}

/**
 * Resolve argv[0] against a server-owned PATH with an injected executable
 * probe. Absolute paths probe directly; bare names scan absolute PATH
 * segments only; cwd-relative paths and leading-dash names resolve to
 * null without probing. Malformed input throws; unresolvable returns
 * null. Throws only PtyBrokerError.
 * @param {unknown} argv0 Alleged executable word.
 * @param {unknown} trustedPath Alleged server-owned PATH string.
 * @param {(absolutePath: string) => Promise<boolean>} canExecute Injected
 * regular-executable plus X_OK probe; host integration implements it.
 * @returns {Promise<string | null>}
 */
export async function resolveExecutable(argv0, trustedPath, canExecute) {
  if (typeof canExecute !== 'function') fail('RESOLVER_SHAPE', 'canExecute must be a function');
  if (typeof argv0 !== 'string' || argv0.length === 0) {
    fail('RESOLVER_ARGV0', 'argv0 must be a non-empty string');
  }
  const word = /** @type {string} */ (argv0);
  if (word.includes('\0') || utf8Length(word) > MAX_ARG_BYTES) {
    fail('RESOLVER_ARGV0', 'argv0 must be bounded and NUL-free');
  }
  if (word.startsWith('-')) return null;
  if (isAbsolute(word)) {
    return (await canExecute(word)) ? word : null;
  }
  if (word.includes('/')) return null;
  if (typeof trustedPath !== 'string' || trustedPath.length === 0) return null;
  const pathValue = /** @type {string} */ (trustedPath);
  let scanned = 0;
  for (const segment of pathValue.split(':')) {
    if (scanned >= TERMINAL_MAX_PATH_SEGMENTS) break;
    if (segment.length === 0 || !isAbsolute(segment)) continue;
    scanned += 1;
    const candidate = join(segment, word);
    if (await canExecute(candidate)) return candidate;
  }
  return null;
}

/**
 * @typedef {object} KillIdentity Proven caller identities plus lookup.
 * @property {number} selfPid Proven caller pid.
 * @property {number} selfPgid Proven caller process group.
 * @property {(pid: number) => number | null} getpgid Injected group lookup;
 * Node offers none, so the supervisor provides it. Null means unknown.
 */

/**
 * Terminal kill guard: the shared repo guard plus an own-group check via
 * injected getpgid. Total: never throws; unknown or own group refuses.
 * Negative pids (group signals) are refused; group teardown belongs to
 * the supervisor, which proves each member first.
 * @param {unknown} pid Alleged signal target.
 * @param {unknown} identity Alleged caller identities.
 * @returns {boolean} True only when signalling is admitted.
 */
export function validateTerminalKillTarget(pid, identity) {
  if (!isRecord(identity)) return false;
  const proven = /** @type {Record<string, unknown>} */ (identity);
  if (!validateKillTarget(pid, proven.selfPid, proven.selfPgid)) return false;
  if (typeof proven.getpgid !== 'function') return false;
  const target = /** @type {number} */ (pid);
  const selfPgid = /** @type {number} */ (proven.selfPgid);
  let group = null;
  try {
    group = /** @type {(p: number) => unknown} */ (proven.getpgid)(target);
  } catch {
    return false;
  }
  if (!isSafeInt(group)) return false;
  return /** @type {number} */ (group) !== selfPgid;
}

/**
 * @typedef {object} LineFramer Bounded NDJSON assembler.
 * @property {(chunk: string) => void} push Feed a decoded text chunk.
 */

/**
 * Assemble bounded line-delimited JSON: complete lines parse to objects
 * via onMessage; oversize, malformed or non-object lines report via
 * onError without breaking the stream.
 * @param {object} options Framer options.
 * @param {number} [options.maxLineBytes] Per-line UTF-8 cap.
 * @param {(message: Record<string, unknown>) => void} options.onMessage Parsed object sink.
 * @param {(info: { code: string }) => void} options.onError Line fault sink.
 * @returns {LineFramer}
 */
export function createLineFramer({ maxLineBytes = MAX_LINE_BYTES, onMessage, onError }) {
  if (!isSafeInt(maxLineBytes) || maxLineBytes <= 0) {
    fail('FRAMER_SHAPE', 'maxLineBytes must be a positive safe integer');
  }
  if (typeof onMessage !== 'function' || typeof onError !== 'function') {
    fail('FRAMER_SHAPE', 'framer sinks must be functions');
  }
  const cap = /** @type {number} */ (maxLineBytes);
  let buffer = '';
  let dropped = false;
  return {
    push(chunk) {
      if (typeof chunk !== 'string') fail('FRAMER_CHUNK', 'framer chunks must be strings');
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (dropped) {
          dropped = false;
        } else if (Buffer.byteLength(line, 'utf8') > cap) {
          onError({ code: 'LINE_TOO_LONG' });
        } else if (line.trim().length === 0) {
          // Ignore blank lines; they carry no message.
        } else {
          let parsed = null;
          try {
            parsed = JSON.parse(line);
          } catch {
            parsed = null;
          }
          if (!isRecord(parsed)) {
            onError({ code: 'MALFORMED' });
          } else {
            onMessage(/** @type {Record<string, unknown>} */ (parsed));
          }
        }
        index = buffer.indexOf('\n');
      }
      if (Buffer.byteLength(buffer, 'utf8') > cap) {
        buffer = '';
        if (!dropped) {
          dropped = true;
          onError({ code: 'LINE_TOO_LONG' });
        }
      }
    },
  };
}

/**
 * @typedef {object} BrokerLink Parsed-object duplex link to the peer.
 * @property {(message: Record<string, unknown>) => void} send Emit one message.
 * @property {(listener: (message: Record<string, unknown>) => void) => () => void} onMessage Subscribe; returns unsubscriber.
 */

/**
 * Child-side stdio link: parent messages arrive via stdin chunks and, in
 * the Electron utility child, via parentPort string messages; events
 * leave as JSON lines on stdout. Framing faults surface as local
 * {ev:'error', id:null} syntheses, never as crashes.
 * @param {object} options Link options.
 * @param {{ on: Function }} options.input Stdin-like emitter of chunks.
 * @param {{ write: Function }} options.output Stdout-like sink.
 * @param {{ on: Function } | null} [options.parentPort] Utility parent port, if any.
 * @param {number} [options.maxLineBytes] Per-line UTF-8 cap.
 * @returns {BrokerLink}
 */
export function createStdioLink({ input, output, parentPort = null, maxLineBytes = MAX_LINE_BYTES }) {
  if (input === null || typeof input !== 'object' || typeof input.on !== 'function') {
    fail('LINK_SHAPE', 'stdio link needs an input emitter');
  }
  if (output === null || typeof output !== 'object' || typeof output.write !== 'function') {
    fail('LINK_SHAPE', 'stdio link needs an output sink');
  }
  if (parentPort !== null && (typeof parentPort !== 'object' || typeof parentPort.on !== 'function')) {
    fail('LINK_SHAPE', 'parentPort must be an emitter or null');
  }
  /** @type {Set<(message: Record<string, unknown>) => void>} */
  const listeners = new Set();
  /** @param {Record<string, unknown>} message */
  const deliver = (message) => {
    for (const listener of [...listeners]) {
      try {
        listener(message);
      } catch {
        // A throwing subscriber must not break the peer stream.
      }
    }
  };
  const framer = createLineFramer({
    maxLineBytes,
    onMessage: deliver,
    onError: (info) => {
      deliver({ version: TERMINAL_WIRE_VERSION, ev: 'error', id: null, code: info.code });
    },
  });
  /** @param {unknown} chunk */
  const feed = (chunk) => {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return;
    framer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };
  /** @type {{ on: Function }} */ (input).on('data', feed);
  if (parentPort !== null) {
    /** @type {{ on: Function }} */ (parentPort).on('message', (/** @type {unknown} */ event) => {
      const data =
        isRecord(event) && typeof event.data === 'string'
          ? event.data
          : typeof event === 'string'
            ? event
            : null;
      if (data !== null) framer.push(data);
    });
  }
  return {
    send(message) {
      if (!isRecord(message)) fail('LINK_MESSAGE', 'link messages must be records');
      /** @type {{ write: Function }} */ (output).write(`${JSON.stringify(message)}\n`);
    },
    onMessage(listener) {
      if (typeof listener !== 'function') fail('LINK_SHAPE', 'link listener must be a function');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * @typedef {object} BrokerTransport Parent-side broker child transport.
 * @property {number | undefined} pid Child pid, when known.
 * @property {(message: string) => void} send Send one JSON line, no newline needed.
 * @property {(listener: (message: Record<string, unknown>) => void) => () => void} onMessage Framed inbound objects.
 * @property {(listener: (code: number | null) => void) => () => void} onExit Child exit code.
 * @property {() => Promise<void>} dispose Idempotent release; kills the child.
 */

/**
 * @typedef {object} BrokerRuntime Main-injected fork implementation.
 * @property {'electron' | 'node-test'} kind Electron utility or Node test child.
 * @property {Function} fork Fork function: Electron UtilityProcess.fork
 * shape for electron, child_process.fork shape for node-test.
 */

/**
 * Assert an already-scrubbed spawn env is actually clean. The spawn
 * boundary re-verifies instead of trusting the builder.
 * @param {unknown} env Alleged child env.
 * @returns {void}
 */
function assertSpawnBoundaryEnv(env) {
  validateSpawnEnv(env);
}

/**
 * Spawn the broker child over a main-injected runtime. Electron children
 * cannot pipe stdin, so parent input tunnels through postMessage; the
 * Node kind exists for unit tests only and is never selected from
 * renderer input or ambient env. Production callers must be app-ready.
 * Throws only PtyBrokerError.
 * @param {object} options Spawn options.
 * @param {unknown} options.entry Trusted absolute broker entry path.
 * @param {unknown} options.cwd Trusted absolute working directory.
 * @param {unknown} options.env Already-scrubbed host env, re-verified.
 * @param {BrokerRuntime} options.runtime Main-injected fork.
 * @returns {BrokerTransport}
 */
export function spawnTerminalBroker({ entry, cwd, env, runtime }) {
  if (typeof entry !== 'string' || entry.length === 0 || !isAbsolute(entry)) {
    fail('SPAWN_ENTRY', 'broker entry must be a non-empty absolute path');
  }
  if (utf8Length(entry) > MAX_ENV_VALUE_BYTES || entry.includes('\0')) {
    fail('SPAWN_ENTRY', 'broker entry must be bounded and NUL-free');
  }
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
    fail('SPAWN_CWD', 'broker cwd must be a non-empty absolute path');
  }
  if (utf8Length(cwd) > MAX_ENV_VALUE_BYTES || cwd.includes('\0')) {
    fail('SPAWN_CWD', 'broker cwd must be bounded and NUL-free');
  }
  assertSpawnBoundaryEnv(env);
  if (!isRecord(runtime)) fail('SPAWN_RUNTIME', 'runtime must be main-injected');
  const kind = /** @type {Record<string, unknown>} */ (runtime).kind;
  const fork = /** @type {Record<string, unknown>} */ (runtime).fork;
  if (kind !== 'electron' && kind !== 'node-test') {
    fail('SPAWN_RUNTIME', 'runtime kind must be electron or node-test');
  }
  if (typeof fork !== 'function') fail('SPAWN_RUNTIME', 'runtime fork must be a function');
  /** @type {Set<(message: Record<string, unknown>) => void>} */
  const messageListeners = new Set();
  /** @type {Set<(code: number | null) => void>} */
  const exitListeners = new Set();
  /** @param {Record<string, unknown>} message */
  const deliver = (message) => {
    for (const listener of [...messageListeners]) {
      try {
        listener(message);
      } catch {
        // A throwing subscriber must not break the broker stream.
      }
    }
  };
  const framer = createLineFramer({
    onMessage: deliver,
    onError: (info) => {
      deliver({ version: TERMINAL_WIRE_VERSION, ev: 'error', id: null, code: info.code });
    },
  });
  /** @param {unknown} chunk */
  const feed = (chunk) => {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return;
    framer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };
  let send = null;
  let pid = undefined;
  let native = null;
  if (kind === 'electron') {
    const utility = /** @type {(e: string, a: Array<string>, o: object) => unknown} */ (fork)(
      /** @type {string} */ (entry),
      [],
      { cwd, env, stdio: 'pipe', serviceName: TERMINAL_SERVICE_NAME },
    );
    if (!isRecord(utility) || typeof utility.postMessage !== 'function') {
      fail('SPAWN_SHAPE', 'electron fork must return a utility process');
    }
    const proc = /** @type {Record<string, unknown>} */ (utility);
    const stdout = /** @type {Record<string, unknown>} */ (proc.stdout);
    if (stdout === null || typeof stdout !== 'object' || typeof stdout.on !== 'function') {
      fail('SPAWN_SHAPE', 'electron broker needs piped stdout');
    }
    const stdoutEmitter = /** @type {{ on: Function }} */ (stdout);
    stdoutEmitter.on('data', feed);
    const stderr = /** @type {Record<string, unknown>} */ (proc.stderr);
    if (stderr !== null && typeof stderr === 'object' && typeof stderr.on === 'function') {
      const stderrDrain = /** @type {{ on: Function }} */ (stderr);
      stderrDrain.on('data', () => {});
    }
    if (typeof proc.once === 'function') {
      /** @type {(e: string, l: Function) => void} */ (proc.once)('exit', (/** @type {unknown} */ code) => {
        const value = isSafeInt(code) ? /** @type {number} */ (code) : null;
        for (const listener of [...exitListeners]) {
          try {
            listener(value);
          } catch {
            // Ignore subscriber faults on the exit path.
          }
        }
      });
    }
    if (typeof proc.pid === 'number' && Number.isSafeInteger(proc.pid)) {
      pid = /** @type {number} */ (proc.pid);
    }
    send = (/** @type {string} */ message) => {
      /** @type {{ postMessage: (text: string) => void }} */ (proc).postMessage(message);
    };
    native = proc;
  } else {
    const child = /** @type {(e: string, a: Array<string>, o: object) => unknown} */ (fork)(
      /** @type {string} */ (entry),
      [],
      { cwd, env, stdio: 'pipe' },
    );
    if (!isRecord(child)) fail('SPAWN_SHAPE', 'node fork must return a child process');
    const proc = /** @type {Record<string, unknown>} */ (child);
    const stdin = /** @type {Record<string, unknown>} */ (proc.stdin);
    const stdout = /** @type {Record<string, unknown>} */ (proc.stdout);
    if (stdin === null || typeof stdin !== 'object' || typeof stdin.write !== 'function') {
      fail('SPAWN_SHAPE', 'node-test broker needs piped stdin');
    }
    if (stdout === null || typeof stdout !== 'object' || typeof stdout.on !== 'function') {
      fail('SPAWN_SHAPE', 'node-test broker needs piped stdout');
    }
    const nodeStdout = /** @type {{ on: Function }} */ (stdout);
    nodeStdout.on('data', feed);
    const stderr = /** @type {Record<string, unknown>} */ (proc.stderr);
    if (stderr !== null && typeof stderr === 'object' && typeof stderr.on === 'function') {
      const nodeStderr = /** @type {{ on: Function }} */ (stderr);
      nodeStderr.on('data', () => {});
    }
    if (typeof proc.on === 'function') {
      /** @type {(e: string, l: Function) => void} */ (proc.on)('exit', (/** @type {unknown} */ code) => {
        const value = isSafeInt(code) ? /** @type {number} */ (code) : null;
        for (const listener of [...exitListeners]) {
          try {
            listener(value);
          } catch {
            // Ignore subscriber faults on the exit path.
          }
        }
      });
    }
    if (typeof proc.pid === 'number' && Number.isSafeInteger(proc.pid)) {
      pid = /** @type {number} */ (proc.pid);
    }
    const writer = /** @type {{ write: Function }} */ (/** @type {unknown} */ (stdin));
    send = (/** @type {string} */ message) => {
      writer.write(message.endsWith('\n') ? message : `${message}\n`);
    };
    native = proc;
  }
  let disposed = false;
  const handle = /** @type {Record<string, unknown>} */ (native);
  return {
    pid,
    send(message) {
      if (disposed) fail('TRANSPORT_DISPOSED', 'broker transport is disposed');
      if (typeof message !== 'string' || message.length === 0) {
        fail('TRANSPORT_MESSAGE', 'broker messages must be non-empty strings');
      }
      /** @type {(message: string) => void} */ (send)(message);
    },
    onMessage(listener) {
      if (typeof listener !== 'function') fail('TRANSPORT_SHAPE', 'listener must be a function');
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onExit(listener) {
      if (typeof listener !== 'function') fail('TRANSPORT_SHAPE', 'listener must be a function');
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      messageListeners.clear();
      exitListeners.clear();
      try {
        if (typeof handle.kill === 'function') {
          /** @type {{ kill: (signal?: string) => unknown }} */ (handle).kill(
            kind === 'electron' ? undefined : 'SIGTERM',
          );
        }
      } catch {
        // The child is already gone; disposal still completes.
      }
      for (const key of ['stdin', 'stdout', 'stderr']) {
        const stream = /** @type {Record<string, unknown>} */ (handle[key]);
        if (stream !== null && typeof stream === 'object' && typeof stream.destroy === 'function') {
          try {
            const destroyable = /** @type {{ destroy: () => void }} */ (stream);
            destroyable.destroy();
          } catch {
            // Best effort; disposal still completes.
          }
        }
      }
    },
  };
}

/**
 * @typedef {object} BrokerLimits Tunable broker caps.
 * @property {number} maxSessions Concurrent live sessions.
 * @property {number} maxWriteBytes Decoded bytes per write op.
 * @property {number} sessionByteCap Lifetime output bytes per session.
 * @property {number} lifetimeMs Session lifetime before explicit expiry.
 * @property {number} highWaterBytes Unacked bytes that pause the PTY.
 * @property {number} lowWaterBytes Unacked bytes below which the PTY resumes.
 * @property {number} maxPendingBytes Unacked bytes that fault the session.
 * @property {number} maxPendingFrames Unacked frames that fault the session.
 */

/** Default caps; hosts override per field with validated values. */
export const DEFAULT_LIMITS = Object.freeze({
  maxSessions: MAX_SESSIONS,
  maxWriteBytes: MAX_WRITE_BYTES,
  sessionByteCap: SESSION_BYTE_CAP,
  lifetimeMs: MAX_LIFETIME_MS,
  highWaterBytes: HIGH_WATER_BYTES,
  lowWaterBytes: LOW_WATER_BYTES,
  maxPendingBytes: MAX_PENDING_BYTES,
  maxPendingFrames: MAX_PENDING_FRAMES,
});

/**
 * Merge limit overrides over defaults, validating every bound before
 * any session exists. Throws only PtyBrokerError.
 * @param {unknown} overrides Alleged partial limits.
 * @returns {Readonly<BrokerLimits>} Frozen effective limits.
 */
export function normalizeLimits(overrides = {}) {
  if (overrides !== undefined && !isRecord(overrides)) {
    fail('LIMITS_SHAPE', 'limits overrides must be a record');
  }
  const base = /** @type {Record<string, number>} */ ({ ...DEFAULT_LIMITS });
  const extra = /** @type {Record<string, unknown>} */ (overrides ?? {});
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in base)) fail('LIMITS_KEY', `unknown limit: ${key}`);
    if (!isSafeInt(value) || /** @type {number} */ (value) <= 0) {
      fail('LIMITS_VALUE', `limit ${key} must be a positive safe integer`);
    }
    base[key] = /** @type {number} */ (value);
  }
  if (!(base.lowWaterBytes < base.highWaterBytes)) {
    fail('LIMITS_WATER', 'need 0 < lowWaterBytes < highWaterBytes');
  }
  if (!(base.highWaterBytes <= base.maxPendingBytes)) {
    fail('LIMITS_WATER', 'need highWaterBytes <= maxPendingBytes');
  }
  return /** @type {Readonly<BrokerLimits>} */ (Object.freeze(base));
}

/**
 * @typedef {object} SpawnProfile Host-owned spawn spec, never renderer data.
 * @property {'shell' | 'provider'} command Spawn kind.
 * @property {string} executable Absolute provider path, or the login shell.
 * @property {ReadonlyArray<string>} argv Provider argv; empty for shell.
 * @property {string} cwd Absolute working directory.
 * @property {Readonly<Record<string, string>>} env Clean spawn env.
 * @property {string} loginShell Absolute login shell path.
 */

/**
 * Closed spawn-profile check shared by child construction and main
 * dispatch. Throws only PtyBrokerError.
 * @param {unknown} profile Alleged spawn profile.
 * @returns {SpawnProfile} Frozen validated profile.
 */
function assertSpawnProfile(profile) {
  if (!isRecord(profile)) fail('PROFILE_SHAPE', 'spawn profile must be a record');
  const record = /** @type {Record<string, unknown>} */ (profile);
  const keys = Object.keys(record).sort();
  const wanted = ['argv', 'command', 'cwd', 'env', 'executable', 'loginShell'].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail('PROFILE_SHAPE', 'spawn profile has an exact closed shape');
  }
  if (record.command !== 'shell' && record.command !== 'provider') {
    fail('PROFILE_COMMAND', 'profile command must be shell or provider');
  }
  const command = /** @type {'shell' | 'provider'} */ (record.command);
  if (
    typeof record.executable !== 'string' ||
    !isAbsolute(/** @type {string} */ (record.executable))
  ) {
    fail('PROFILE_EXEC', 'profile executable must be an absolute path');
  }
  if (typeof record.cwd !== 'string' || !isAbsolute(/** @type {string} */ (record.cwd))) {
    fail('PROFILE_CWD', 'profile cwd must be an absolute path');
  }
  if (typeof record.loginShell !== 'string' || !isAbsolute(/** @type {string} */ (record.loginShell))) {
    fail('PROFILE_SHELL', 'profile loginShell must be an absolute path');
  }
  for (const key of ['executable', 'cwd', 'loginShell']) {
    const text = /** @type {string} */ (record[key]);
    if (text.includes('\0') || utf8Length(text) > MAX_ENV_VALUE_BYTES) {
      fail('PROFILE_PATH', `profile ${key} must be bounded and NUL-free`);
    }
  }
  const env = validateSpawnEnv(record.env);
  let argv;
  if (command === 'shell') {
    if (!Array.isArray(record.argv) || record.argv.length !== 0) {
      fail('PROFILE_ARGV', 'shell profiles carry an empty argv');
    }
    argv = Object.freeze([]);
  } else {
    argv = validateProviderArgv(record.argv);
    if (argv[0] !== record.executable) {
      fail('PROFILE_ARGV', 'provider argv[0] must equal the executable');
    }
  }
  return {
    command,
    executable: /** @type {string} */ (record.executable),
    argv,
    cwd: /** @type {string} */ (record.cwd),
    env,
    loginShell: /** @type {string} */ (record.loginShell),
  };
}

/**
 * @typedef {object} PtySpawnOptions node-pty spawn options, exemplar surface.
 * @property {string} name Terminal type.
 * @property {number} cols Initial columns.
 * @property {number} rows Initial rows.
 * @property {string} cwd Working directory.
 * @property {Record<string, string>} env Spawn env copy.
 * @property {null} encoding Undecoded chunks.
 */

/**
 * @typedef {object} PtyHandle Injected PTY handle; only the eight exemplar
 * node-pty members are ever touched.
 * @property {number} pid PTY leader pid.
 * @property {(cb: (chunk: string | Uint8Array) => void) => { dispose: () => void }} onData Output subscription.
 * @property {(cb: (code: number) => void) => { dispose: () => void }} onExit Exit subscription.
 * @property {(data: string) => void} write Input write.
 * @property {(cols: number, rows: number) => void} resize Resize.
 * @property {(signal: string) => void} kill Signal.
 * @property {() => void} pause Pause output.
 * @property {() => void} resume Resume output.
 */

/**
 * @typedef {object} PtyAdapter Injected PTY factory; tests substitute a fake.
 * @property {(file: string, args: ReadonlyArray<string>, options: PtySpawnOptions) => PtyHandle} spawn Spawn one PTY.
 */

/**
 * @typedef {object} BrokerProcesses Main-supervision process hooks.
 * @property {(pid: number) => void} record Record an owned pid at spawn.
 * @property {(pid: number) => Promise<void>} reapOwned Reap an owned tree; resolves when reaped.
 */

/**
 * @typedef {object} BrokerAuthority Child-side audit sink.
 * @property {(admission: Record<string, unknown>, outcome: Record<string, unknown>) => unknown} commitOutcome Commit a lifecycle outcome against a main-issued admission.
 */

/**
 * @typedef {object} BrokerSession Live child session.
 * @property {string} id Session id.
 * @property {PtyHandle} handle PTY handle.
 * @property {number} pid PTY leader pid.
 * @property {Record<string, unknown> | null} admission Main-issued admission, opaque.
 * @property {number} seq Last emitted output seq.
 * @property {number} sent Cumulative output bytes.
 * @property {number} acked Cumulative consumed bytes.
 * @property {number} ackedSeq Consumed output seq watermark.
 * @property {boolean} paused PTY paused for backpressure.
 * @property {boolean} exited Exit already emitted.
 * @property {ReturnType<typeof setTimeout>} deadline Lifetime timer.
 * @property {Array<{ dispose: () => void }>} disposables PTY subscriptions.
 */

const CHILD_OPS = Object.freeze(['open', 'write', 'resize', 'close', 'ack', 'pause', 'resume']);

/**
 * Child-side broker engine: owns PTY handles behind a versioned,
 * generation-gated message link. Open requests carry provider
 * references only; spawn specs come from the validated server-owned
 * profiles map. The child never admits: it commits outcomes against
 * main-issued admissions and refuses anything malformed with a typed
 * error event, never a crash. Imports stay inert; the fork-entry wiring
 * outside this surface builds the stdio link and invokes this engine.
 * @param {object} options Engine options.
 * @param {BrokerLink} options.transport Duplex link to the parent.
 * @param {PtyAdapter} options.pty Injected PTY factory.
 * @param {ReadonlyMap<string, unknown>} options.profiles Server-owned id to profile map.
 * @param {unknown} [options.limits] Partial limit overrides.
 * @param {BrokerAuthority | null} [options.authority] Audit sink, if any.
 * @param {BrokerProcesses} options.processes Supervision hooks.
 * @param {number} [options.serviceGeneration] Own service generation.
 * @returns {{ dispose: () => Promise<void> }} Engine handle.
 */
export function runBroker({
  transport,
  pty,
  profiles,
  limits = {},
  authority = null,
  processes,
  serviceGeneration = 1,
}) {
  if (transport === null || typeof transport !== 'object') fail('ENGINE_SHAPE', 'transport is required');
  const link = /** @type {BrokerLink} */ (transport);
  if (typeof link.send !== 'function' || typeof link.onMessage !== 'function') {
    fail('ENGINE_SHAPE', 'transport needs send and onMessage');
  }
  if (pty === null || typeof pty !== 'object' || typeof pty.spawn !== 'function') {
    fail('ENGINE_SHAPE', 'pty adapter needs spawn');
  }
  const factory = /** @type {PtyAdapter} */ (pty);
  if (!(profiles instanceof Map)) fail('ENGINE_SHAPE', 'profiles must be a Map');
  /** @type {Map<string, SpawnProfile>} */
  const owned = new Map();
  for (const [id, profile] of /** @type {ReadonlyMap<string, unknown>} */ (profiles)) {
    if (!isTerminalId(id)) fail('PROFILE_ID', 'profile ids must match id grammar');
    try {
      owned.set(/** @type {string} */ (id), assertSpawnProfile(profile));
    } catch (error) {
      if (error instanceof PtyBrokerError) throw error;
      fail('PROFILE_SHAPE', 'profile validation failed');
    }
  }
  const caps = normalizeLimits(limits);
  if (authority !== null) {
    if (typeof authority !== 'object' || typeof authority.commitOutcome !== 'function') {
      fail('ENGINE_SHAPE', 'authority needs commitOutcome or null');
    }
  }
  const audit = /** @type {BrokerAuthority | null} */ (authority);
  if (processes === null || typeof processes !== 'object') {
    fail('ENGINE_SHAPE', 'processes hooks are required');
  }
  const hooks = /** @type {BrokerProcesses} */ (processes);
  if (typeof hooks.record !== 'function' || typeof hooks.reapOwned !== 'function') {
    fail('ENGINE_SHAPE', 'processes needs record and reapOwned');
  }
  if (!isSafeInt(serviceGeneration) || /** @type {number} */ (serviceGeneration) < 0) {
    fail('ENGINE_SHAPE', 'serviceGeneration must be a safe integer >= 0');
  }
  const generation = /** @type {number} */ (serviceGeneration);
  /** @type {Map<string, BrokerSession>} */
  const sessions = new Map();
  /** @type {Set<string>} */
  const tombstones = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let disposed = false;

  /** @param {Record<string, unknown>} event */
  const emit = (event) => {
    try {
      link.send({ version: TERMINAL_WIRE_VERSION, generation, ...event });
    } catch {
      // The parent is gone; best effort only.
    }
  };
  /** @param {string | null} id @param {string} code */
  const sendError = (id, code) => {
    emit({ ev: 'error', id, code });
  };
  /** @param {unknown} id */
  const extractId = (id) => (isTerminalId(id) ? /** @type {string} */ (id) : null);
  /** @param {string} id */
  const addTombstone = (id) => {
    tombstones.add(id);
    while (tombstones.size > MAX_TOMBSTONES) {
      const oldest = tombstones.values().next();
      if (oldest.done) break;
      tombstones.delete(/** @type {string} */ (oldest.value));
    }
  };
  /**
   * @param {Record<string, unknown> | null} admission
   * @param {Record<string, unknown>} outcome
   * @param {string | null} id
   */
  const commit = async (admission, outcome, id) => {
    if (audit === null || admission === null) return;
    try {
      await audit.commitOutcome(admission, outcome);
    } catch {
      sendError(id, 'AUDIT_FAILED');
    }
  };

  /**
   * @param {string} id
   * @param {number} exitCode
   * @param {string | null} reason Fixed token or null.
   */
  const closeSession = async (id, exitCode, reason) => {
    const session = sessions.get(id);
    if (!session || session.exited) return;
    session.exited = true;
    sessions.delete(id);
    clearTimeout(session.deadline);
    addTombstone(id);
    for (const disposable of session.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Ignore disposal faults on the teardown path.
      }
    }
    session.disposables = [];
    try {
      session.handle.kill('SIGKILL');
    } catch {
      // The PTY is already gone; reaping still verifies.
    }
    try {
      await hooks.reapOwned(session.pid);
    } catch {
      sendError(id, 'REAP_FAILED');
    }
    /** @type {Record<string, unknown>} */
    const outcome = { event: 'exited', session: id, code: exitCode };
    if (reason !== null) outcome.reason = reason;
    await commit(session.admission, outcome, id);
    /** @type {Record<string, unknown>} */
    const event = { ev: 'exit', id, code: exitCode };
    if (reason !== null) event.reason = reason;
    emit(event);
  };

  /** @param {string} id */
  const expireSession = (id) => {
    if (!sessions.has(id)) return;
    void closeSession(id, 0, 'SESSION_EXPIRED');
  };

  /**
   * @param {string} id
   * @param {string | Uint8Array} chunk
   */
  const onPtyData = async (id, chunk) => {
    const session = sessions.get(id);
    if (!session || session.exited) return;
    let bytes = null;
    if (typeof chunk === 'string') bytes = Buffer.from(chunk, 'utf8');
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
    if (bytes === null || bytes.length === 0) return;
    const capped = bytes.length >= caps.sessionByteCap - session.sent;
    bytes = bytes.subarray(0, caps.sessionByteCap - session.sent);
    if (bytes.length === 0) {
      await closeSession(id, 0, 'SESSION_CAP');
      return;
    }
    session.seq += 1;
    session.sent += bytes.length;
    const unacked = session.sent - session.acked;
    const unackedFrames = session.seq - session.ackedSeq;
    if (unacked > caps.maxPendingBytes || unackedFrames > caps.maxPendingFrames) {
      await closeSession(id, -1, null);
      return;
    }
    if (capped) {
      emit({ ev: 'data', id, seq: session.seq, b64: bytes.toString('base64') });
      await closeSession(id, 0, 'SESSION_CAP');
      return;
    }
    emit({ ev: 'data', id, seq: session.seq, b64: bytes.toString('base64') });
    if (!session.paused && unacked >= caps.highWaterBytes) {
      session.paused = true;
      try {
        session.handle.pause();
      } catch {
        // Accounting still bounds the session via the pending caps.
      }
    }
  };

  /**
   * @param {string} id
   * @param {unknown} code
   */
  const onPtyExit = async (id, code) => {
    const session = sessions.get(id);
    if (!session || session.exited) return;
    await closeSession(id, isSafeInt(code) ? /** @type {number} */ (code) : -1, null);
  };

  /** @param {unknown} id @returns {'live' | 'closed' | 'unknown' | 'shape'} */
  const statusOf = (id) => {
    if (!isTerminalId(id)) return 'shape';
    const key = /** @type {string} */ (id);
    if (sessions.has(key)) return 'live';
    if (tombstones.has(key)) return 'closed';
    return 'unknown';
  };

  /**
   * @param {Record<string, unknown>} msg
   */
  const handleOpen = async (msg) => {
    const rawId = msg.id;
    if (!isTerminalId(rawId)) {
      sendError(null, 'SESSION_SHAPE');
      return;
    }
    const id = /** @type {string} */ (rawId);
    if (sessions.has(id)) {
      sendError(id, 'SESSION_DUPLICATE');
      return;
    }
    if (tombstones.has(id)) {
      sendError(id, 'SESSION_CLOSED');
      return;
    }
    const rawAdmission = msg.admission === undefined ? null : msg.admission;
    if (rawAdmission !== null && !isRecord(rawAdmission)) {
      addTombstone(id);
      sendError(id, 'ADMISSION_SHAPE');
      return;
    }
    const admission = /** @type {Record<string, unknown> | null} */ (rawAdmission);
    /** @param {string} code */
    const refuse = (code) => {
      addTombstone(id);
      sendError(id, code);
      void commit(admission, { event: 'refused', session: id, reason: code }, id);
    };
    if (sessions.size >= caps.maxSessions) {
      refuse('SESSION_LIMIT');
      return;
    }
    if (!isTerminalId(msg.provider)) {
      refuse('PROVIDER_SHAPE');
      return;
    }
    if (msg.command !== 'shell' && msg.command !== 'provider') {
      refuse('COMMAND_SHAPE');
      return;
    }
    const profile = owned.get(/** @type {string} */ (msg.provider));
    if (!profile) {
      refuse('UNKNOWN_PROVIDER');
      return;
    }
    if (profile.command !== msg.command) {
      refuse('COMMAND_MISMATCH');
      return;
    }
    const cols = msg.cols === undefined ? DEFAULT_COLS : msg.cols;
    const rows = msg.rows === undefined ? DEFAULT_ROWS : msg.rows;
    if (
      !isSafeInt(cols) ||
      !isSafeInt(rows) ||
      /** @type {number} */ (cols) < MIN_COLS ||
      /** @type {number} */ (cols) > MAX_COLS ||
      /** @type {number} */ (rows) < MIN_ROWS ||
      /** @type {number} */ (rows) > MAX_ROWS
    ) {
      refuse('DIMS_RANGE');
      return;
    }
    let file = '';
    /** @type {ReadonlyArray<string>} */
    let args = [];
    try {
      const spec =
        profile.command === 'shell'
          ? buildShellSpawn([], profile.loginShell)
          : buildProviderSpawn(profile.argv, profile.loginShell);
      file = spec.file;
      args = spec.args;
    } catch {
      refuse('SPAWN_SHAPE');
      return;
    }
    /** @type {PtyHandle | null} */
    let handle = null;
    try {
      handle = factory.spawn(file, [...args], {
        name: 'xterm-256color',
        cols: /** @type {number} */ (cols),
        rows: /** @type {number} */ (rows),
        cwd: profile.cwd,
        env: { ...profile.env },
        encoding: null,
      });
    } catch {
      refuse('SPAWN_FAILED');
      return;
    }
    const candidate = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (handle));
    const shapeOk =
      isRecord(handle) &&
      isSafeInt(candidate.pid) &&
      /** @type {number} */ (candidate.pid) > 1 &&
      /** @type {number} */ (candidate.pid) !== process.pid &&
      typeof candidate.onData === 'function' &&
      typeof candidate.onExit === 'function' &&
      typeof candidate.write === 'function' &&
      typeof candidate.resize === 'function' &&
      typeof candidate.kill === 'function' &&
      typeof candidate.pause === 'function' &&
      typeof candidate.resume === 'function';
    if (!shapeOk) {
      try {
        if (typeof candidate.kill === 'function') {
          /** @type {(signal: string) => void} */ (candidate.kill)('SIGKILL');
        }
      } catch {
        // Best effort cleanup of the malformed handle.
      }
      refuse('PTY_SHAPE');
      return;
    }
    const live = /** @type {PtyHandle} */ (handle);
    const pid = /** @type {number} */ (candidate.pid);
    try {
      hooks.record(pid);
    } catch {
      try {
        live.kill('SIGKILL');
      } catch {
        // Best effort cleanup after the record fault.
      }
      refuse('RECORD_FAILED');
      return;
    }
    /** @type {BrokerSession} */
    const session = {
      id,
      handle: live,
      pid,
      admission,
      seq: 0,
      sent: 0,
      acked: 0,
      ackedSeq: 0,
      paused: false,
      exited: false,
      deadline: setTimeout(expireSession, caps.lifetimeMs, id),
      disposables: [],
    };
    try {
      session.disposables.push(
        live.onData((chunk) => {
          void onPtyData(id, chunk);
        }),
      );
      session.disposables.push(
        live.onExit((code) => {
          void onPtyExit(id, code);
        }),
      );
    } catch {
      clearTimeout(session.deadline);
      try {
        live.kill('SIGKILL');
      } catch {
        // Best effort cleanup after the subscribe fault.
      }
      refuse('PTY_SHAPE');
      return;
    }
    sessions.set(id, session);
    emit({ ev: 'open', id, pid });
    await commit(admission, { event: 'started', session: id, pid }, id);
  };

  /** @param {Record<string, unknown>} msg */
  const handleWrite = async (msg) => {
    const status = statusOf(msg.id);
    if (status !== 'live') {
      sendError(
        extractId(msg.id),
        status === 'shape'
          ? 'SESSION_SHAPE'
          : status === 'closed'
            ? 'SESSION_CLOSED'
            : 'UNKNOWN_SESSION',
      );
      return;
    }
    const id = /** @type {string} */ (msg.id);
    const session = /** @type {BrokerSession} */ (sessions.get(id));
    const raw = msg.b64;
    if (typeof raw !== 'string' || !BASE64_RE.test(raw)) {
      sendError(id, 'WRITE_SHAPE');
      return;
    }
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length > caps.maxWriteBytes) {
      sendError(id, 'WRITE_TOO_LARGE');
      return;
    }
    let text = '';
    try {
      text = decoder.decode(bytes);
    } catch {
      sendError(id, 'INVALID_INPUT');
      return;
    }
    try {
      session.handle.write(text);
    } catch {
      sendError(id, 'WRITE_FAILED');
    }
  };

  /** @param {Record<string, unknown>} msg */
  const handleResize = async (msg) => {
    const status = statusOf(msg.id);
    if (status !== 'live') {
      sendError(
        extractId(msg.id),
        status === 'shape'
          ? 'SESSION_SHAPE'
          : status === 'closed'
            ? 'SESSION_CLOSED'
            : 'UNKNOWN_SESSION',
      );
      return;
    }
    const id = /** @type {string} */ (msg.id);
    const session = /** @type {BrokerSession} */ (sessions.get(id));
    const cols = msg.cols;
    const rows = msg.rows;
    if (
      !isSafeInt(cols) ||
      !isSafeInt(rows) ||
      /** @type {number} */ (cols) < MIN_COLS ||
      /** @type {number} */ (cols) > MAX_COLS ||
      /** @type {number} */ (rows) < MIN_ROWS ||
      /** @type {number} */ (rows) > MAX_ROWS
    ) {
      sendError(id, 'DIMS_RANGE');
      return;
    }
    try {
      session.handle.resize(/** @type {number} */ (cols), /** @type {number} */ (rows));
    } catch {
      sendError(id, 'RESIZE_FAILED');
    }
  };

  /** @param {Record<string, unknown>} msg */
  const handleAck = async (msg) => {
    const status = statusOf(msg.id);
    if (status !== 'live') {
      sendError(
        extractId(msg.id),
        status === 'shape'
          ? 'SESSION_SHAPE'
          : status === 'closed'
            ? 'SESSION_CLOSED'
            : 'UNKNOWN_SESSION',
      );
      return;
    }
    const id = /** @type {string} */ (msg.id);
    const session = /** @type {BrokerSession} */ (sessions.get(id));
    const seq = msg.ack_seq;
    const bytes = msg.ack_bytes;
    if (
      !isSafeInt(seq) ||
      !isSafeInt(bytes) ||
      /** @type {number} */ (seq) < 0 ||
      /** @type {number} */ (bytes) < 0
    ) {
      sendError(id, 'ACK_SHAPE');
      return;
    }
    const ackSeq = /** @type {number} */ (seq);
    const ackBytes = /** @type {number} */ (bytes);
    if (ackSeq > session.seq || ackSeq < session.ackedSeq || ackBytes > session.sent || ackBytes < session.acked) {
      sendError(id, 'ACK_REFUSED');
      return;
    }
    session.ackedSeq = ackSeq;
    session.acked = ackBytes;
    if (session.paused && session.sent - session.acked < caps.lowWaterBytes) {
      session.paused = false;
      try {
        session.handle.resume();
      } catch {
        // The next ack retries the resume; bytes stay accounted.
      }
    }
  };

  /**
   * @param {Record<string, unknown>} msg
   * @param {'pause' | 'resume'} op
   */
  const handlePauseResume = async (msg, op) => {
    const status = statusOf(msg.id);
    if (status !== 'live') {
      sendError(
        extractId(msg.id),
        status === 'shape'
          ? 'SESSION_SHAPE'
          : status === 'closed'
            ? 'SESSION_CLOSED'
            : 'UNKNOWN_SESSION',
      );
      return;
    }
    const id = /** @type {string} */ (msg.id);
    const session = /** @type {BrokerSession} */ (sessions.get(id));
    session.paused = op === 'pause';
    try {
      if (op === 'pause') session.handle.pause();
      else session.handle.resume();
    } catch {
      sendError(id, op === 'pause' ? 'PAUSE_FAILED' : 'RESUME_FAILED');
    }
  };

  /** @param {Record<string, unknown>} msg */
  const handleClose = async (msg) => {
    const status = statusOf(msg.id);
    if (status === 'shape') {
      sendError(null, 'SESSION_SHAPE');
      return;
    }
    const id = /** @type {string} */ (msg.id);
    if (status === 'unknown') {
      sendError(id, 'UNKNOWN_SESSION');
      return;
    }
    if (status === 'closed') return;
    await closeSession(id, 0, null);
  };

  /** @param {unknown} message */
  const route = async (message) => {
    if (disposed) return;
    if (!isRecord(message)) {
      sendError(null, 'MALFORMED');
      return;
    }
    const msg = /** @type {Record<string, unknown>} */ (message);
    const id = extractId(msg.id);
    if (msg.version !== TERMINAL_WIRE_VERSION) {
      sendError(id, 'BAD_VERSION');
      return;
    }
    if (msg.generation !== generation) {
      sendError(id, 'STALE_GENERATION');
      return;
    }
    const op = msg.op;
    if (typeof op !== 'string' || !CHILD_OPS.includes(op)) {
      sendError(id, 'UNKNOWN_OP');
      return;
    }
    const name = /** @type {string} */ (op);
    try {
      if (name === 'open') await handleOpen(msg);
      else if (name === 'write') await handleWrite(msg);
      else if (name === 'resize') await handleResize(msg);
      else if (name === 'close') await handleClose(msg);
      else if (name === 'ack') await handleAck(msg);
      else await handlePauseResume(msg, /** @type {'pause' | 'resume'} */ (name));
    } catch {
      sendError(id, 'INTERNAL');
    }
  };

  const unsubscribe = link.onMessage((message) => {
    void route(message).catch(() => {});
  });

  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } catch {
        // Best effort; disposal still completes.
      }
      for (const id of [...sessions.keys()]) {
        try {
          await closeSession(id, 0, null);
        } catch {
          // Per-session faults must not block the remaining teardown.
        }
      }
    },
  };
}

/**
 * @typedef {object} IpcMainSeam Narrow main-side IPC seam.
 * @property {(channel: string, listener: (event: unknown, ...args: Array<unknown>) => unknown) => void} handle Bind a channel.
 * @property {(channel: string) => void} removeHandler Revoke a channel.
 */

/**
 * @typedef {object} BrokerPrincipal Main-observed caller principal.
 * @property {string} owner Stable owner label echoed to the renderer.
 */

/**
 * @typedef {object} BrokerAdmission Admission outcome from core.
 * @property {boolean} allowed Whether the request is admitted.
 * @property {string | null} reason Refusal reason, null when allowed.
 * @property {Record<string, unknown> | null} context Core-issued session context, null on denial.
 * @property {Record<string, unknown> | null} profile Core-authorized spawn profile, null on denial.
 */

/**
 * @typedef {object} DispatchAuthority Core admission seam.
 * @property {(principal: BrokerPrincipal, request: Record<string, unknown>) => Promise<BrokerAdmission>} admit Admit one request; called per privileged op, never cached.
 */

/**
 * @typedef {object} PlaneContext Directional byte-plane context.
 * @property {string} session Session id.
 * @property {'input' | 'output'} direction Ledger direction.
 * @property {number} serviceGeneration Service generation.
 * @property {number} epoch Authority epoch.
 * @property {number} attachmentGeneration View generation.
 */

/**
 * @typedef {object} BytePlaneSeam Injected output ledger (plane lane).
 * @property {(context: PlaneContext) => void} open Open a directional ledger.
 * @property {(context: PlaneContext, frame: { seq: number, b64: string }) => { session: string, seq: number, bytes: Uint8Array, byteLength: number }} ingest Ingest one frame.
 * @property {(context: PlaneContext, ack: { seq: number, bytes: number }) => void} acknowledge Advance the consumed prefix.
 * @property {(context: PlaneContext) => { firstSeq: number | null, lastSeq: number | null, bytes: Uint8Array, truncated: boolean }} attach Read the replay suffix.
 * @property {(context: PlaneContext) => void} close Close a directional ledger.
 */

/**
 * @typedef {object} ProviderCapability Availability report per provider.
 * @property {string} id Provider id.
 * @property {boolean} available Whether launch is currently possible.
 * @property {string} reason Empty when available, otherwise the cause.
 */

/**
 * Main-side IPC bridge: fixed channels, per-call owner re-verification,
 * per-request admission, then a single child dispatch. Renderer values
 * carrying exe, cwd, env, argv or channel names are refused before any
 * authority interaction. Child events flow through the injected output
 * plane; stale generations are revoked silently, faults publish loudly.
 * The transport is owned by the caller and is never disposed here.
 * @param {object} options Bridge options.
 * @param {IpcMainSeam} options.ipcMain Narrow IPC seam.
 * @param {(event: unknown) => BrokerPrincipal} options.authenticate Main-observed principal, never renderer-minted.
 * @param {DispatchAuthority} options.authority Core admission seam.
 * @param {BrokerLink} options.transport Duplex link to the broker child.
 * @param {ReadonlyMap<string, unknown>} options.providers Server-owned id to profile map.
 * @param {BytePlaneSeam} options.plane Injected output ledger.
 * @param {((event: Record<string, unknown>) => void) | null} [options.publish] Live-event sink, if any.
 * @param {(() => Promise<Array<unknown>>) | null} [options.capabilitiesProvider] Host probing seam, if any.
 * @param {number} [options.serviceGeneration] Expected child generation.
 * @returns {{ dispose: () => Promise<void> }} Bridge handle.
 */
export function registerTerminalIpc({
  ipcMain,
  authenticate,
  authority,
  transport,
  providers,
  plane,
  publish = null,
  capabilitiesProvider = null,
  serviceGeneration = 1,
}) {
  if (ipcMain === null || typeof ipcMain !== 'object') fail('BRIDGE_SHAPE', 'ipcMain seam is required');
  const ipc = /** @type {IpcMainSeam} */ (ipcMain);
  if (typeof ipc.handle !== 'function' || typeof ipc.removeHandler !== 'function') {
    fail('BRIDGE_SHAPE', 'ipcMain needs handle and removeHandler');
  }
  if (typeof authenticate !== 'function') fail('BRIDGE_SHAPE', 'authenticate must be a function');
  if (authority === null || typeof authority !== 'object' || typeof authority.admit !== 'function') {
    fail('BRIDGE_SHAPE', 'authority needs admit');
  }
  const gate = /** @type {DispatchAuthority} */ (authority);
  if (transport === null || typeof transport !== 'object') fail('BRIDGE_SHAPE', 'transport is required');
  const link = /** @type {BrokerLink} */ (transport);
  if (typeof link.send !== 'function' || typeof link.onMessage !== 'function') {
    fail('BRIDGE_SHAPE', 'transport needs send and onMessage');
  }
  if (!(providers instanceof Map)) fail('BRIDGE_SHAPE', 'providers must be a Map');
  /** @type {Map<string, SpawnProfile>} */
  const owned = new Map();
  for (const [id, profile] of /** @type {ReadonlyMap<string, unknown>} */ (providers)) {
    if (!isTerminalId(id)) fail('PROFILE_ID', 'provider ids must match id grammar');
    owned.set(/** @type {string} */ (id), assertSpawnProfile(profile));
  }
  if (plane === null || typeof plane !== 'object') fail('BRIDGE_SHAPE', 'plane is required');
  const ledger = /** @type {BytePlaneSeam} */ (plane);
  for (const key of ['open', 'ingest', 'acknowledge', 'attach', 'close']) {
    if (typeof ledger[/** @type {keyof BytePlaneSeam} */ (key)] !== 'function') {
      fail('BRIDGE_SHAPE', `plane needs ${key}`);
    }
  }
  if (publish !== null && typeof publish !== 'function') {
    fail('BRIDGE_SHAPE', 'publish must be a function or null');
  }
  const sink = /** @type {((event: Record<string, unknown>) => void) | null} */ (publish);
  if (capabilitiesProvider !== null && typeof capabilitiesProvider !== 'function') {
    fail('BRIDGE_SHAPE', 'capabilitiesProvider must be a function or null');
  }
  const probe = /** @type {(() => Promise<Array<unknown>>) | null} */ (capabilitiesProvider);
  if (!isSafeInt(serviceGeneration) || /** @type {number} */ (serviceGeneration) < 0) {
    fail('BRIDGE_SHAPE', 'serviceGeneration must be a safe integer >= 0');
  }
  const generation = /** @type {number} */ (serviceGeneration);
  /** @type {Map<string, { session: string, epoch: number, attachGen: number, pid: number | null }>} */
  const live = new Map();
  /** @type {Set<string>} */
  const closed = new Set();
  let disposed = false;

  /** @param {Record<string, unknown>} event */
  const publishEvent = (event) => {
    if (sink === null) return;
    try {
      sink(event);
    } catch {
      // A throwing sink must not break the bridge.
    }
  };
  /** @param {string} id */
  const markClosed = (id) => {
    closed.add(id);
    while (closed.size > MAX_TOMBSTONES) {
      const oldest = closed.values().next();
      if (oldest.done) break;
      closed.delete(/** @type {string} */ (oldest.value));
    }
  };
  /**
   * @param {boolean} ok
   * @param {Record<string, unknown>} [extra]
   * @returns {Record<string, unknown>}
   */
  const outcome = (ok, extra = {}) => ({
    version: TERMINAL_WIRE_VERSION,
    generation,
    ok,
    ...extra,
  });

  /**
   * @param {unknown} event
   * @param {string} method
   * @param {Array<unknown>} args
   * @returns {{ principal: BrokerPrincipal, value: Record<string, unknown> }}
   */
  const ingress = (event, method, args) => {
    let principal = null;
    try {
      principal = authenticate(event);
    } catch {
      fail('TERMINAL_AUTH', 'authentication failed');
    }
    const observed = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (principal));
    if (!isRecord(principal) || typeof observed.owner !== 'string' || observed.owner.length === 0) {
      fail('TERMINAL_AUTH', 'principal must carry a non-empty owner');
    }
    if (args.length !== 1) fail('TERMINAL_ARGS', 'exactly one argument is required');
    if (method === 'capabilities') {
      const body = args[0];
      if (body !== undefined && body !== null) fail('TERMINAL_ARGS', 'capabilities takes no value');
      return { principal: /** @type {BrokerPrincipal} */ (principal), value: {} };
    }
    const envelope = args[0];
    if (!isRecord(envelope)) fail('TERMINAL_SHAPE', 'value must be an owner envelope');
    const keys = Object.keys(/** @type {Record<string, unknown>} */ (envelope)).sort();
    if (keys.length !== 2 || keys[0] !== 'owner' || keys[1] !== 'value') {
      fail('TERMINAL_SHAPE', 'envelope must be exactly {owner, value}');
    }
    const box = /** @type {Record<string, unknown>} */ (envelope);
    if (box.owner !== observed.owner) fail('TERMINAL_OWNER', 'envelope owner mismatch');
    if (!isRecord(box.value)) fail('TERMINAL_SHAPE', 'envelope value must be a record');
    const value = /** @type {Record<string, unknown>} */ (box.value);
    for (const forbidden of FORBIDDEN_VALUE_KEYS) {
      if (forbidden in value) fail('TERMINAL_FORBIDDEN', `renderer must not send ${forbidden}`);
    }
    return { principal: /** @type {BrokerPrincipal} */ (principal), value };
  };

  /**
   * @param {BrokerPrincipal} principal
   * @param {Record<string, unknown>} request
   * @returns {Promise<{ admission: BrokerAdmission } | { refusal: Record<string, unknown> }>}
   */
  const admit = async (principal, request) => {
    /** @type {BrokerAdmission | null} */
    let admission = null;
    try {
      admission = await gate.admit(principal, request);
    } catch {
      return { refusal: outcome(false, { reason: 'ADMISSION_FAILED' }) };
    }
    if (
      admission === null ||
      typeof admission !== 'object' ||
      typeof admission.allowed !== 'boolean'
    ) {
      return { refusal: outcome(false, { reason: 'ADMISSION_SHAPE' }) };
    }
    if (!admission.allowed) {
      const reason =
        typeof admission.reason === 'string' && admission.reason.length > 0
          ? admission.reason
          : 'DENIED';
      return { refusal: outcome(false, { reason }) };
    }
    return { admission };
  };

  /**
   * @param {BrokerAdmission} admission
   * @returns {{ session: string, epoch: number } | null}
   */
  const readContext = (admission) => {
    if (!isRecord(admission.context)) return null;
    const context = /** @type {Record<string, unknown>} */ (admission.context);
    if (!isTerminalId(context.session)) return null;
    const epoch = context.epoch === undefined ? 0 : context.epoch;
    if (!isSafeInt(epoch) || /** @type {number} */ (epoch) < 0) return null;
    return { session: /** @type {string} */ (context.session), epoch: /** @type {number} */ (epoch) };
  };

  /**
   * Fresh output context for one plane call. A new object per call: the
   * plane fences generations, so attach bumps the session counter and
   * later calls observe the new generation.
   * @param {string} session
   * @param {number} epoch
   * @param {number} attachGen Current attachment generation.
   * @returns {PlaneContext}
   */
  const outputContext = (session, epoch, attachGen) => ({
    session,
    direction: 'output',
    serviceGeneration: generation,
    epoch,
    attachmentGeneration: attachGen,
  });

  /**
   * @param {Record<string, unknown>} message
   * @returns {boolean} False when the send failed.
   */
  const forward = (message) => {
    try {
      link.send({ version: TERMINAL_WIRE_VERSION, generation, ...message });
      return true;
    } catch {
      return false;
    }
  };

  /** @type {Record<string, (principal: BrokerPrincipal, value: Record<string, unknown>) => Promise<Record<string, unknown>>>} */
  const methods = {
    open: async (principal, value) => {
      const provider = value.provider;
      const command = value.command;
      if (!isTerminalId(provider)) return outcome(false, { reason: 'PROVIDER_SHAPE' });
      if (command !== 'shell' && command !== 'provider') {
        return outcome(false, { reason: 'COMMAND_SHAPE' });
      }
      const known = owned.get(/** @type {string} */ (provider));
      if (!known || known.command !== command) {
        return outcome(false, { reason: 'UNKNOWN_PROVIDER' });
      }
      const cols = value.cols === undefined ? DEFAULT_COLS : value.cols;
      const rows = value.rows === undefined ? DEFAULT_ROWS : value.rows;
      if (
        !isSafeInt(cols) ||
        !isSafeInt(rows) ||
        /** @type {number} */ (cols) < MIN_COLS ||
        /** @type {number} */ (cols) > MAX_COLS ||
        /** @type {number} */ (rows) < MIN_ROWS ||
        /** @type {number} */ (rows) > MAX_ROWS
      ) {
        return outcome(false, { reason: 'DIMS_RANGE' });
      }
      const decided = await admit(principal, {
        operation: 'open',
        provider,
        command,
        session: null,
      });
      if (disposed) return outcome(false, { reason: 'BRIDGE_DISPOSED' });
      if ('refusal' in decided) return decided.refusal;
      const context = readContext(decided.admission);
      if (context === null) return outcome(false, { reason: 'ADMISSION_CONTEXT' });
      if (live.has(context.session)) return outcome(false, { reason: 'SESSION_DUPLICATE' });
      if (closed.has(context.session)) return outcome(false, { reason: 'SESSION_CLOSED' });
      try {
        const admitted = assertSpawnProfile(decided.admission.profile);
        if (admitted.command !== known.command || admitted.executable !== known.executable ||
            admitted.cwd !== known.cwd || admitted.loginShell !== known.loginShell ||
            admitted.argv.length !== known.argv.length ||
            admitted.argv.some((arg, index) => arg !== known.argv[index]) ||
            Object.keys(admitted.env).length !== Object.keys(known.env).length ||
            Object.entries(admitted.env).some(([key, value]) => value !== known.env[key])) {
          return outcome(false, { reason: 'PROFILE_REFUSED' });
        }
      } catch {
        return outcome(false, { reason: 'PROFILE_REFUSED' });
      }
      const ctx = outputContext(context.session, context.epoch, 0);
      const { profile: droppedProfile, ...auditAdmission } = decided.admission;
      void droppedProfile;
      const sent = forward({
        op: 'open',
        id: context.session,
        provider,
        command,
        cols,
        rows,
        admission: auditAdmission,
      });
      if (!sent) return outcome(false, { reason: 'TRANSPORT_FAILED' });
      try {
        ledger.open(ctx);
      } catch {
        forward({ op: 'close', id: context.session });
        return outcome(false, { reason: 'PLANE_FAILED' });
      }
      live.set(context.session, {
        session: context.session,
        epoch: context.epoch,
        attachGen: 0,
        pid: null,
      });
      return outcome(true, { session: context.session });
    },
    attach: async (principal, value) => {
      if (!isTerminalId(value.session)) return outcome(false, { reason: 'SESSION_SHAPE' });
      const session = /** @type {string} */ (value.session);
      const decided = await admit(principal, { operation: 'attach', session });
      if (disposed) return outcome(false, { reason: 'BRIDGE_DISPOSED' });
      if ('refusal' in decided) return decided.refusal;
      const context = readContext(decided.admission);
      if (context === null || context.session !== session) {
        return outcome(false, { reason: 'ADMISSION_CONTEXT' });
      }
      const entry = live.get(session);
      if (!entry) {
        return outcome(false, { reason: closed.has(session) ? 'SESSION_CLOSED' : 'UNKNOWN_SESSION' });
      }
      entry.attachGen += 1;
      /** @type {{ firstSeq: number | null, lastSeq: number | null, bytes: Uint8Array, truncated: boolean }} */
      let suffix;
      try {
        suffix = ledger.attach(outputContext(entry.session, entry.epoch, entry.attachGen));
      } catch {
        return outcome(false, { reason: 'PLANE_FAILED' });
      }
      return outcome(true, {
        session,
        firstSeq: suffix.firstSeq,
        lastSeq: suffix.lastSeq,
        b64: Buffer.from(suffix.bytes).toString('base64'),
        truncated: suffix.truncated,
      });
    },
    close: async (principal, value) => {
      if (!isTerminalId(value.session)) return outcome(false, { reason: 'SESSION_SHAPE' });
      const session = /** @type {string} */ (value.session);
      const decided = await admit(principal, { operation: 'close', session });
      if (disposed) return outcome(false, { reason: 'BRIDGE_DISPOSED' });
      if ('refusal' in decided) return decided.refusal;
      const context = readContext(decided.admission);
      if (context === null || context.session !== session) {
        return outcome(false, { reason: 'ADMISSION_CONTEXT' });
      }
      if (!live.has(session)) {
        if (closed.has(session)) return outcome(true, { session });
        return outcome(false, { reason: 'UNKNOWN_SESSION' });
      }
      if (!forward({ op: 'close', id: session })) {
        return outcome(false, { reason: 'TRANSPORT_FAILED' });
      }
      return outcome(true, { session });
    },
    write: async (principal, value) => {
      if (!isTerminalId(value.session)) return outcome(false, { reason: 'SESSION_SHAPE' });
      const session = /** @type {string} */ (value.session);
      const raw = value.b64;
      if (typeof raw !== 'string' || !BASE64_RE.test(raw)) {
        return outcome(false, { reason: 'WRITE_SHAPE' });
      }
      if (Buffer.byteLength(raw, 'base64') > MAX_WRITE_BYTES) {
        return outcome(false, { reason: 'WRITE_TOO_LARGE' });
      }
      const decided = await admit(principal, { operation: 'write', session });
      if (disposed) return outcome(false, { reason: 'BRIDGE_DISPOSED' });
      if ('refusal' in decided) return decided.refusal;
      const context = readContext(decided.admission);
      if (context === null || context.session !== session) {
        return outcome(false, { reason: 'ADMISSION_CONTEXT' });
      }
      if (!live.has(session)) {
        return outcome(false, { reason: closed.has(session) ? 'SESSION_CLOSED' : 'UNKNOWN_SESSION' });
      }
      if (!forward({ op: 'write', id: session, b64: raw })) {
        return outcome(false, { reason: 'TRANSPORT_FAILED' });
      }
      return outcome(true, { session });
    },
    resize: async (principal, value) => {
      if (!isTerminalId(value.session)) return outcome(false, { reason: 'SESSION_SHAPE' });
      const session = /** @type {string} */ (value.session);
      const cols = value.cols;
      const rows = value.rows;
      if (
        !isSafeInt(cols) ||
        !isSafeInt(rows) ||
        /** @type {number} */ (cols) < MIN_COLS ||
        /** @type {number} */ (cols) > MAX_COLS ||
        /** @type {number} */ (rows) < MIN_ROWS ||
        /** @type {number} */ (rows) > MAX_ROWS
      ) {
        return outcome(false, { reason: 'DIMS_RANGE' });
      }
      const decided = await admit(principal, { operation: 'resize', session });
      if (disposed) return outcome(false, { reason: 'BRIDGE_DISPOSED' });
      if ('refusal' in decided) return decided.refusal;
      const context = readContext(decided.admission);
      if (context === null || context.session !== session) {
        return outcome(false, { reason: 'ADMISSION_CONTEXT' });
      }
      if (!live.has(session)) {
        return outcome(false, { reason: closed.has(session) ? 'SESSION_CLOSED' : 'UNKNOWN_SESSION' });
      }
      if (!forward({ op: 'resize', id: session, cols, rows })) {
        return outcome(false, { reason: 'TRANSPORT_FAILED' });
      }
      return outcome(true, { session });
    },
    ack: async (principal, value) => {
      if (!isTerminalId(value.session)) return outcome(false, { reason: 'SESSION_SHAPE' });
      const session = /** @type {string} */ (value.session);
      const seq = value.ack_seq;
      const bytes = value.ack_bytes;
      if (!isSafeInt(seq) || !isSafeInt(bytes) || /** @type {number} */ (seq) < 0 || /** @type {number} */ (bytes) < 0) {
        return outcome(false, { reason: 'ACK_SHAPE' });
      }
      const decided = await admit(principal, { operation: 'ack', session });
      if (disposed) return outcome(false, { reason: 'BRIDGE_DISPOSED' });
      if ('refusal' in decided) return decided.refusal;
      const context = readContext(decided.admission);
      if (context === null || context.session !== session) {
        return outcome(false, { reason: 'ADMISSION_CONTEXT' });
      }
      const entry = live.get(session);
      if (!entry) {
        return outcome(false, { reason: closed.has(session) ? 'SESSION_CLOSED' : 'UNKNOWN_SESSION' });
      }
      try {
        ledger.acknowledge(outputContext(entry.session, entry.epoch, entry.attachGen), {
          seq: /** @type {number} */ (seq),
          bytes: /** @type {number} */ (bytes),
        });
      } catch {
        return outcome(false, { reason: 'ACK_REFUSED' });
      }
      if (!forward({ op: 'ack', id: session, ack_seq: seq, ack_bytes: bytes })) {
        return outcome(false, { reason: 'TRANSPORT_FAILED' });
      }
      return outcome(true, { session });
    },
    capabilities: async (principal) => {
      /** @type {Array<unknown>} */
      let reports;
      if (probe === null) {
        reports = [...owned.keys()].map((id) => ({
          id,
          available: false,
          reason: 'PROBE_UNAVAILABLE',
        }));
      } else {
        try {
          reports = await probe();
          if (disposed) return outcome(false, { reason: 'BRIDGE_DISPOSED' });
        } catch {
          return outcome(false, { reason: disposed ? 'BRIDGE_DISPOSED' : 'CAPABILITY_FAULT' });
        }
      }
      if (!Array.isArray(reports)) return outcome(false, { reason: 'CAPABILITY_FAULT' });
      /** @type {Array<ProviderCapability>} */
      const capabilities = [];
      for (const report of reports) {
        if (!isRecord(report)) return outcome(false, { reason: 'CAPABILITY_FAULT' });
        const item = /** @type {Record<string, unknown>} */ (report);
        if (
          typeof item.id !== 'string' ||
          item.id.length === 0 ||
          typeof item.available !== 'boolean' ||
          typeof item.reason !== 'string'
        ) {
          return outcome(false, { reason: 'CAPABILITY_FAULT' });
        }
        capabilities.push({
          id: /** @type {string} */ (item.id),
          available: /** @type {boolean} */ (item.available),
          reason: /** @type {string} */ (item.reason),
        });
      }
      return outcome(true, {
        owner: principal.owner,
        capabilities: Object.freeze(capabilities),
      });
    },
  };

  for (const method of TERMINAL_METHODS) {
    const name = /** @type {string} */ (method);
    ipc.handle(TERMINAL_CHANNEL_PREFIX + name, (event, ...args) => {
      if (disposed) fail('BRIDGE_DISPOSED', 'terminal bridge is disposed');
      const { principal, value } = ingress(event, name, args);
      return methods[name](principal, value);
    });
  }

  const unsubscribe = link.onMessage((message) => {
    if (disposed) return;
    if (!isRecord(message)) {
      publishEvent({ kind: 'fault', code: 'MALFORMED' });
      return;
    }
    const event = /** @type {Record<string, unknown>} */ (message);
    if (event.version !== TERMINAL_WIRE_VERSION) {
      publishEvent({ kind: 'fault', code: 'BAD_VERSION' });
      return;
    }
    if (event.generation !== generation) return;
    const kind = event.ev;
    if (kind === 'open') {
      if (!isTerminalId(event.id)) return;
      const entry = live.get(/** @type {string} */ (event.id));
      if (entry && isSafeInt(event.pid)) entry.pid = /** @type {number} */ (event.pid);
      return;
    }
    if (kind === 'data') {
      if (!isTerminalId(event.id)) return;
      const id = /** @type {string} */ (event.id);
      const entry = live.get(id);
      if (!entry) return;
      const seq = event.seq;
      const b64 = event.b64;
      if (!isSafeInt(seq) || typeof b64 !== 'string') {
        publishEvent({ kind: 'fault', session: id, code: 'DATA_SHAPE' });
        return;
      }
      /** @type {{ session: string, seq: number, bytes: Uint8Array, byteLength: number }} */
      let frame;
      try {
        frame = ledger.ingest(outputContext(entry.session, entry.epoch, entry.attachGen), {
          seq: /** @type {number} */ (seq),
          b64,
        });
      } catch {
        live.delete(id);
        markClosed(id);
        try {
          ledger.close(outputContext(entry.session, entry.epoch, entry.attachGen));
        } catch {
          // The ledger is already faulted; teardown continues.
        }
        forward({ op: 'close', id });
        publishEvent({ kind: 'fault', session: id, code: 'PLANE_FAULT' });
        return;
      }
      publishEvent({
        kind: 'data',
        session: frame.session,
        seq: frame.seq,
        bytes: frame.bytes,
        byteLength: frame.byteLength,
      });
      return;
    }
    if (kind === 'exit') {
      if (!isTerminalId(event.id)) return;
      const id = /** @type {string} */ (event.id);
      const code = isSafeInt(event.code) ? /** @type {number} */ (event.code) : -1;
      const entry = live.get(id);
      live.delete(id);
      markClosed(id);
      if (entry) {
        try {
          ledger.close(outputContext(entry.session, entry.epoch, entry.attachGen));
        } catch {
          // The ledger is already closed; teardown continues.
        }
      }
      /** @type {Record<string, unknown>} */
      const payload = { kind: 'exit', session: id, code };
      if (typeof event.reason === 'string' && EXIT_REASONS.includes(event.reason)) {
        payload.reason = event.reason;
      }
      publishEvent(payload);
      return;
    }
    if (kind === 'error') {
      if (isTerminalId(event.id)) {
        const id = /** @type {string} */ (event.id);
        const entry = live.get(id);
        if (entry && entry.pid === null) {
          live.delete(id);
          markClosed(id);
          try {
            ledger.close(outputContext(entry.session, entry.epoch, entry.attachGen));
          } catch {
            // Session revocation must survive an already faulted ledger.
          }
        }
      }
      /** @type {Record<string, unknown>} */
      const payload = { kind: 'error', session: null, code: 'UNKNOWN' };
      if (event.id === null || isTerminalId(event.id)) payload.session = event.id;
      if (typeof event.code === 'string' && event.code.length > 0 && event.code.length <= 64) {
        payload.code = event.code;
      }
      publishEvent(payload);
      return;
    }
    publishEvent({ kind: 'fault', code: 'UNKNOWN_EVENT' });
  });

  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } catch {
        // Best effort; disposal still completes.
      }
      for (const method of TERMINAL_METHODS) {
        try {
          ipc.removeHandler(TERMINAL_CHANNEL_PREFIX + /** @type {string} */ (method));
        } catch {
          // Per-channel faults must not block the remaining revocation.
        }
      }
      for (const [id, entry] of [...live]) {
        live.delete(id);
        markClosed(id);
        try {
          ledger.close(outputContext(entry.session, entry.epoch, entry.attachGen));
        } catch {
          // Per-session faults must not block the remaining teardown.
        }
      }
    },
  };
}

/**
 * @typedef {object} FacadeSeams Preload-owned narrow seams, never raw IPC.
 * @property {(operation: string, value: unknown) => Promise<unknown>} request Closed authenticated domain call.
 * @property {(listener: (event: Record<string, unknown>) => void) => () => void} subscribe Event subscription.
 */

/**
 * @typedef {object} TerminalFacade Renderer terminal API.
 * @property {(value: unknown) => Promise<Readonly<Record<string, unknown>>>} open Open a session by provider reference.
 * @property {(value: unknown) => Promise<Readonly<Record<string, unknown>>>} attach Reattach and read the replay suffix.
 * @property {(value: unknown) => Promise<Readonly<Record<string, unknown>>>} close Close a session.
 * @property {(value: unknown) => Promise<Readonly<Record<string, unknown>>>} write Write input; gated by setEnabled.
 * @property {(value: unknown) => Promise<Readonly<Record<string, unknown>>>} resize Resize a session.
 * @property {(value: unknown) => Promise<Readonly<Record<string, unknown>>>} ack Confirm consumed output.
 * @property {() => Promise<Readonly<Record<string, unknown>>>} capabilities List provider capabilities and bootstrap the owner.
 * @property {(enabled: boolean) => void} setEnabled UX input gate; main rechecks every effect.
 * @property {(listener: (frame: Record<string, unknown>) => void) => () => void} onData Output frames.
 * @property {(listener: (event: Record<string, unknown>) => void) => () => void} onExit Exits, errors and faults.
 * @property {() => void} dispose Idempotent release.
 */

/**
 * Renderer facade over the preload-owned seams: wraps values in the
 * main-issued owner envelope, freezes request bodies, and gates write
 * behind an explicit UX enable that never substitutes for main-side
 * admission. Input starts disabled: no keystroke leaves the renderer
 * before the host enables it, while ack and output stay live so READ
 * mode keeps reading. Post-dispose calls are safe no-ops.
 * @param {FacadeSeams} seams Preload-owned seams.
 * @returns {TerminalFacade}
 */
export function createTerminalFacade({ request, subscribe }) {
  if (typeof request !== 'function' || typeof subscribe !== 'function') {
    fail('FACADE_SHAPE', 'facade needs request and subscribe seams');
  }
  /** @type {string | null} */
  let owner = null;
  let enabled = false;
  let disposed = false;
  /** @type {Set<() => void>} */
  const revocations = new Set();

  /** @param {unknown} result @returns {Readonly<Record<string, unknown>>} */
  const checkOutcome = (result) => {
    if (!isRecord(result) || typeof result.ok !== 'boolean') {
      fail('BAD_OUTCOME', 'terminal outcome must carry ok');
    }
    return /** @type {Readonly<Record<string, unknown>>} */ (
      Object.freeze({ .../** @type {Record<string, unknown>} */ (result) })
    );
  };

  /**
   * @param {string} operation
   * @param {unknown} value
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  const call = async (operation, value) => {
    if (disposed) {
      return /** @type {Readonly<Record<string, unknown>>} */ (
        Object.freeze({ ok: false, reason: 'DISPOSED' })
      );
    }
    if (!isRecord(value)) fail('FACADE_VALUE', `${operation} value must be a record`);
    if (owner === null) {
      return /** @type {Readonly<Record<string, unknown>>} */ (
        Object.freeze({ ok: false, reason: 'NO_OWNER' })
      );
    }
    if (operation === 'write' && !enabled) {
      return /** @type {Readonly<Record<string, unknown>>} */ (
        Object.freeze({ ok: false, reason: 'INPUT_DISABLED' })
      );
    }
    const body = Object.freeze({ .../** @type {Record<string, unknown>} */ (value) });
    const envelope = Object.freeze({ owner, value: body });
    let result = null;
    try {
      result = await request(operation, envelope);
    } catch {
      fail('REQUEST_FAILED', `${operation} request failed`);
    }
    return checkOutcome(result);
  };

  /**
   * @param {'data' | 'exit'} which
   * @param {(event: Record<string, unknown>) => void} listener
   * @returns {() => void}
   */
  const listen = (which, listener) => {
    if (typeof listener !== 'function') fail('FACADE_SHAPE', 'facade listener must be a function');
    if (disposed) return () => {};
    /** @type {() => void} */
    let revoke = () => {};
    const wrapped = (/** @type {unknown} */ event) => {
      if (disposed || !isRecord(event)) return;
      const item = /** @type {Record<string, unknown>} */ (event);
      if (which === 'data') {
        if (item.kind !== 'data') return;
        if (typeof item.session !== 'string' || !isSafeInt(item.seq)) return;
        try {
          listener(item);
        } catch {
          // A throwing renderer listener must not break delivery.
        }
        return;
      }
      if (item.kind !== 'exit' && item.kind !== 'error' && item.kind !== 'fault') return;
      try {
        listener(item);
      } catch {
        // A throwing renderer listener must not break delivery.
      }
    };
    try {
      revoke = subscribe(wrapped);
    } catch {
      fail('SUBSCRIBE_FAILED', 'facade subscribe failed');
    }
    if (typeof revoke !== 'function') fail('SUBSCRIBE_FAILED', 'subscribe must return a revoker');
    revocations.add(revoke);
    return () => {
      revocations.delete(revoke);
      try {
        revoke();
      } catch {
        // Best effort revocation.
      }
    };
  };

  /** @type {TerminalFacade} */
  const facade = {
    open: (value) => call('open', value),
    attach: (value) => call('attach', value),
    close: (value) => call('close', value),
    write: (value) => call('write', value),
    resize: (value) => call('resize', value),
    ack: (value) => call('ack', value),
    capabilities: async () => {
      if (disposed) {
        return /** @type {Readonly<Record<string, unknown>>} */ (
          Object.freeze({ ok: false, reason: 'DISPOSED' })
        );
      }
      let result = null;
      try {
        result = await request('capabilities', undefined);
      } catch {
        fail('REQUEST_FAILED', 'capabilities request failed');
      }
      const checked = checkOutcome(result);
      if (checked.ok === true && typeof checked.owner === 'string' && checked.owner.length > 0) {
        owner = checked.owner;
      }
      return checked;
    },
    setEnabled: (next) => {
      if (disposed) return;
      if (typeof next !== 'boolean') fail('FACADE_SHAPE', 'setEnabled needs a boolean');
      enabled = next;
    },
    onData: (listener) => listen('data', listener),
    onExit: (listener) => listen('exit', listener),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      enabled = false;
      owner = null;
      for (const revoke of [...revocations]) {
        revocations.delete(revoke);
        try {
          revoke();
        } catch {
          // Best effort revocation.
        }
      }
    },
  };
  return facade;
}


