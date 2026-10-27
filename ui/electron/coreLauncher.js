// @ts-check
'use strict';

/**
 * W0-SHELL-MAIN Rust core launcher: single-flight native child supervisor.
 *
 * [TARGET, unit decision] Pass the validated host recording destination grant
 * separately from the generic environment allowlist.
 * Main supervises; Rust owns state. This module spawns the pinned core
 * binary at most once per instance (never respawns), scrubs the child
 * environment to an allowlist, bounds every stdio and queue byte, and
 * reaps through a trusted ownership ledger with a strict kill guard.
 * No Electron import: unit tests run directly under Node.
 *
 * @module coreLauncher
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Typed launcher failure; a failure admits nothing.
 */
export class CoreLauncherError extends Error {
  /**
   * @param {string} code Stable refusal code.
   * @param {string} message Human detail (never an authority grant).
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'CoreLauncherError';
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
  throw new CoreLauncherError(code, message);
}

/**
 * Maximum environment value characters kept.
 * @type {number}
 */
export const CORE_MAX_ENV_VALUE_CHARS = 4096;

/**
 * Maximum PATH segments kept after sanitizing.
 * @type {number}
 */
export const CORE_MAX_PATH_SEGMENTS = 32;

/**
 * Maximum environment name characters accepted.
 * @type {number}
 */
export const CORE_MAX_ENV_NAME_CHARS = 64;

/**
 * Maximum runtime-dir path characters accepted.
 * @type {number}
 */
export const CORE_MAX_PATH_CHARS = 4096;

/**
 * Exact environment allowlist for the core child. Everything else,
 * including the parent XDG_RUNTIME_DIR, is denied by default; main sets
 * the validated runtime dir itself.
 * @type {ReadonlyArray<string>}
 */
export const ALLOWED_CORE_ENV = Object.freeze(['LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']);

/**
 * Forbidden environment name prefixes (loader/debugger injection
 * families plus interpreter configuration).
 * @type {ReadonlyArray<string>}
 */
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(['DYLD_', 'ELECTRON_', 'LD_', 'NODE_', 'PYTHON']);

/**
 * Forbidden environment names outside the prefix families (shell
 * startup, locale-data and resolver injection).
 * @type {ReadonlyArray<string>}
 */
export const FORBIDDEN_ENV_EXACT = Object.freeze(['BASH_ENV', 'ENV', 'GCONV_PATH', 'HOSTALIASES', 'ZDOTDIR']);

/**
 * True for a forbidden environment name (exact entry or prefix family).
 * Total: non-strings are false, never a throw.
 * @param {unknown} name Alleged name.
 * @returns {boolean} True when the name must never reach a child.
 */
export function isForbiddenEnvName(name) {
  if (typeof name !== 'string' || name.length < 1) {
    return false;
  }
  for (const exact of FORBIDDEN_ENV_EXACT) {
    if (name === exact) {
      return true;
    }
  }
  for (const prefix of FORBIDDEN_ENV_PREFIXES) {
    if (name.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * List the forbidden names present (with string values) in an alleged
 * environment object. Total: malformed inputs yield an empty list.
 * @param {unknown} env Alleged environment record.
 * @returns {ReadonlyArray<string>} Frozen present forbidden names.
 */
export function findForbiddenEnv(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return Object.freeze([]);
  }
  const record = /** @type {Record<string, unknown>} */ (env);
  /** @type {Array<string>} */
  const found = [];
  for (const key of Object.keys(record)) {
    if (typeof record[key] !== 'string') {
      continue;
    }
    if (isForbiddenEnvName(key)) {
      found.push(key);
    }
  }
  return Object.freeze(found);
}

/**
 * True for a keepable ambient value: a string within bounds, no NUL.
 * @param {unknown} value Alleged value.
 * @returns {boolean} True for keepable values.
 */
function isKeepableValue(value) {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length > CORE_MAX_ENV_VALUE_CHARS) {
    return false;
  }
  return !value.includes(String.fromCharCode(0));
}

/**
 * Sanitize a PATH value: keep absolute segments only, drop empty and
 * relative segments, cap the count. Total: anything unusable yields
 * null so the caller refuses loudly instead of falling back.
 * @param {unknown} value Alleged PATH value.
 * @returns {string | null} Sanitized PATH, or null when unusable.
 */
function sanitizePathValue(value) {
  if (!isKeepableValue(value)) {
    return null;
  }
  /** @type {Array<string>} */
  const kept = [];
  for (const segment of /** @type {string} */ (value).split(':')) {
    if (kept.length >= CORE_MAX_PATH_SEGMENTS) {
      break;
    }
    if (segment.length < 1 || !isAbsolute(segment)) {
      continue;
    }
    kept.push(segment);
  }
  if (kept.length === 0) {
    return null;
  }
  return kept.join(':');
}

/**
 * Build the frozen core child environment: allowlisted parent values
 * only, PATH sanitized to absolute segments, plus the main-validated
 * XDG_RUNTIME_DIR. A missing or unusable PATH refuses with ENV_PATH;
 * there is no fallback PATH. Throws only CoreLauncherError.
 * @param {unknown} rawEnv Alleged parent environment record.
 * @param {unknown} runtimeDir Alleged validated runtime directory.
 * @returns {Readonly<Record<string, string>>} Frozen child environment.
 */
export function scrubChildEnv(rawEnv, runtimeDir) {
  if (rawEnv === null || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    fail('ENV_SHAPE', 'parent environment must be an object');
  }
  if (
    typeof runtimeDir !== 'string' ||
    runtimeDir.length < 1 ||
    runtimeDir.length > CORE_MAX_PATH_CHARS ||
    runtimeDir.includes(String.fromCharCode(0)) ||
    !isAbsolute(runtimeDir)
  ) {
    fail('ENV_RUNTIME', 'runtime directory must be a bounded absolute path');
  }
  const parent = /** @type {Record<string, unknown>} */ (rawEnv);
  const out = /** @type {Record<string, string>} */ ({});
  for (const name of ALLOWED_CORE_ENV) {
    if (name === 'PATH') {
      continue;
    }
    const raw = parent[name];
    if (!isKeepableValue(raw)) {
      continue;
    }
    out[name] = /** @type {string} */ (raw);
  }
  const path = sanitizePathValue(parent.PATH);
  if (path === null) {
    fail('ENV_PATH', 'PATH must sanitize to at least one absolute segment');
  }
  out.PATH = /** @type {string} */ (path);
  // Same host grant validation as authorityWire, kept self-contained so the
  // packaged main/launcher security probe needs no authority runtime modules.
  const destination = parent.MV_RECORDING_DESTINATION;
  if (destination !== undefined && destination !== '') {
    if (typeof destination !== 'string' || !isAbsolute(destination)
        || destination.length > CORE_MAX_PATH_CHARS || /[\0\r\n]/.test(destination)) {
      fail('SETTINGS_DESTINATION', 'recording destination must be a bounded absolute path');
    }
    const canonical = realpathSync(resolve(destination));
    const rel = relative(fileURLToPath(new URL('../..', import.meta.url)), canonical);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      fail('SETTINGS_IN_REPO', 'recording destination must be outside the source tree');
    }
    out.MV_RECORDING_DESTINATION = canonical;
  }
  out.XDG_RUNTIME_DIR = /** @type {string} */ (runtimeDir);
  return Object.freeze(out);
}

/**
 * Pure kill guard. True only for a primitive safe-integer pid above 1
 * that is neither the caller pid nor the caller process group, with
 * safe-integer caller identities. No coercion: valueOf, proxies and
 * boxed numbers are refused. Total: never throws.
 * @param {unknown} pid Alleged signal target.
 * @param {unknown} selfPid Proven caller pid.
 * @param {unknown} selfPgid Proven caller process group.
 * @returns {boolean} True when signalling is admitted.
 */
export function validateKillTarget(pid, selfPid, selfPgid) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) {
    return false;
  }
  if (typeof selfPid !== 'number' || !Number.isSafeInteger(selfPid)) {
    return false;
  }
  if (typeof selfPgid !== 'number' || !Number.isSafeInteger(selfPgid)) {
    return false;
  }
  if (pid === selfPid || pid === selfPgid) {
    return false;
  }
  return true;
}

/**
 * Launcher lifecycle snapshot. `authority_epoch` comes solely from the
 * verified core handshake; absent is null, never zero.
 * @typedef {object} CoreStatus
 * @property {'idle' | 'starting' | 'live' | 'unavailable'} availability Lifecycle state.
 * @property {number | null} pid Owned child pid, or null before spawn.
 * @property {number | null} authority_epoch Verified core epoch, or null.
 * @property {string | null} reason Terminal failure reason, or null.
 */

/**
 * Trusted core-client transport. The UDS codec belongs upstream; this
 * adapter only carries bytes with deadlines.
 * @typedef {object} CoreTransport
 * @property {(signal: AbortSignal) => Promise<void>} connect Connect with a deadline signal.
 * @property {(message: unknown, signal: AbortSignal) => Promise<unknown>} request One request, never resent.
 * @property {() => Promise<void>} close Release transport resources.
 */

/**
 * Trusted descendant ledger with exit evidence. Signal delivery never
 * proves reaping; only waitForExit does.
 * @typedef {object} CoreOwnership
 * @property {() => ReadonlyArray<number>} ownedPids Owned descendant pids in tree order.
 * @property {(pid: number, signal: AbortSignal) => Promise<void>} waitForExit Resolve when the pid has exited.
 */

/**
 * Required finite bounds. Production values are owned upstream; every
 * field must be a positive safe integer.
 * @typedef {object} CoreLimits
 * @property {number} maxStdoutLineBytes Partial stdout line ceiling before decoding.
 * @property {number} maxStderrTailBytes Retained stderr tail ceiling.
 * @property {number} maxQueuedRequests In-flight request count ceiling.
 * @property {number} maxQueuedBytes In-flight request byte ceiling.
 * @property {number} maxRequestBytes Single request byte ceiling.
 * @property {number} handshakeTimeoutMs Handshake deadline.
 * @property {number} requestTimeoutMs Per-request deadline.
 * @property {number} shutdownTimeoutMs Per-pid TERM/KILL wait deadline.
 */

/**
 * @typedef {object} CoreCallbacks
 * @property {(status: CoreStatus) => void} onStatus Transition listener; exceptions are swallowed.
 */

/**
 * Authenticated core handshake over the connected transport.
 * @typedef {(transport: CoreTransport, signal: AbortSignal) => Promise<{authority_epoch: number}>} CoreHandshake
 */

/**
 * @typedef {(pid: number, signal: 'SIGTERM' | 'SIGKILL') => void} CoreKillFn
 */

/**
 * Exact launcher options. `command` and `args` are the admitted bundle
 * launch spec; no path is guessed here.
 * @typedef {object} CoreLauncherOptions
 * @property {(command: string, args: ReadonlyArray<string>, opts: Record<string, unknown>) => unknown} spawn child_process-compatible spawn.
 * @property {string} command Absolute pinned core binary path.
 * @property {ReadonlyArray<string>} args Admitted core arguments.
 * @property {unknown} env Parent environment to scrub.
 * @property {string} runtimeDir Validated runtime directory.
 * @property {number} selfPid Proven caller pid.
 * @property {number} selfPgid Proven caller process group.
 * @property {CoreKillFn} killFn Single-pid signal function (never a group).
 * @property {CoreHandshake} handshake Authenticated hello producing the epoch.
 * @property {CoreTransport} transport Trusted core-client adapter.
 * @property {CoreLimits} limits Exact finite bounds.
 * @property {CoreOwnership} ownership Trusted descendant ledger.
 * @property {CoreCallbacks} callbacks Status listener.
 */

/**
 * @typedef {object} CoreLauncher
 * @property {() => Promise<CoreStatus>} start Single-flight start; repeated calls share the result.
 * @property {(message: unknown) => Promise<unknown>} request One live request with gates and a deadline.
 * @property {() => Promise<void>} dispose Idempotent teardown; never rejects.
 * @property {() => CoreStatus} getStatus Frozen snapshot.
 */

/**
 * @type {ReadonlyArray<string>}
 */
const OPTION_KEYS = Object.freeze([
  'spawn', 'command', 'args', 'env', 'runtimeDir', 'selfPid', 'selfPgid',
  'killFn', 'handshake', 'transport', 'limits', 'ownership', 'callbacks',
]);

/**
 * @type {ReadonlyArray<string>}
 */
const LIMIT_KEYS = Object.freeze([
  'maxStdoutLineBytes', 'maxStderrTailBytes', 'maxQueuedRequests', 'maxQueuedBytes',
  'maxRequestBytes', 'handshakeTimeoutMs', 'requestTimeoutMs', 'shutdownTimeoutMs',
]);

/**
 * True for an object with exactly the expected own keys.
 * @param {unknown} value Alleged options object.
 * @param {ReadonlyArray<string>} keys Expected keys.
 * @returns {boolean} True for exact key sets.
 */
function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  if (own.length !== keys.length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      return false;
    }
  }
  return true;
}

/**
 * Race a task against a deadline. The timer is always cleared on
 * settle; the controller aborts the task signal on timeout.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} task Task receiving the abort signal.
 * @param {number} ms Deadline in milliseconds.
 * @param {string} code Timeout error code.
 * @returns {Promise<T>} Task result or a coded timeout rejection.
 */
function withTimeout(task, ms, code) {
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* signal best-effort */
      }
      reject(new CoreLauncherError(code, `deadline of ${ms}ms exceeded`));
    }, ms);
  });
  /** @type {Promise<T>} */
  let attempt;
  try {
    attempt = task(controller.signal);
  } catch (error) {
    if (timer !== null) {
      clearTimeout(timer);
    }
    return Promise.reject(error);
  }
  return Promise.race([attempt, deadline]).then(
    (value) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      return value;
    },
    (error) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      throw error;
    },
  );
}

/**
 * Measure one request in UTF-8 bytes without mutating it. Strings are
 * measured directly; anything else must JSON-serialize.
 * @param {unknown} message Alleged request.
 * @returns {number} Byte length, or -1 when unmeasurable.
 */
function requestByteLength(message) {
  if (typeof message === 'string') {
    return Buffer.byteLength(message, 'utf8');
  }
  try {
    const text = JSON.stringify(message);
    if (typeof text !== 'string') {
      return -1;
    }
    return Buffer.byteLength(text, 'utf8');
  } catch {
    return -1;
  }
}

/**
 * Create the single-flight core launcher. Every option is validated
 * before any spawn; invalid options throw CoreLauncherError and never
 * spawn. Runtime failures resolve to `unavailable` and never respawn.
 * @param {CoreLauncherOptions} options Exact launcher options.
 * @returns {CoreLauncher} Frozen launcher.
 */
export function createCoreLauncher(options) {
  if (!hasExactKeys(options, OPTION_KEYS)) {
    fail('OPTIONS', 'options must carry exactly the launcher keys');
  }
  const typed = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (options));
  if (typeof typed.spawn !== 'function') {
    fail('SPAWN', 'spawn must be a function');
  }
  const command = typed.command;
  if (
    typeof command !== 'string' || command.length < 1 || command.length > CORE_MAX_PATH_CHARS ||
    command.includes(String.fromCharCode(0)) || !isAbsolute(command)
  ) {
    fail('COMMAND', 'command must be a bounded absolute path');
  }
  const args = typed.args;
  if (!Array.isArray(args)) {
    fail('ARGS', 'args must be a string array');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > CORE_MAX_ENV_VALUE_CHARS || arg.includes(String.fromCharCode(0))) {
      fail('ARGS', 'args must be bounded NUL-free strings');
    }
  }
  const scrubbed = scrubChildEnv(typed.env, typed.runtimeDir);
  const selfPid = typed.selfPid;
  const selfPgid = typed.selfPgid;
  if (
    typeof selfPid !== 'number' || !Number.isSafeInteger(selfPid) || selfPid < 1 ||
    typeof selfPgid !== 'number' || !Number.isSafeInteger(selfPgid) || selfPgid < 1
  ) {
    fail('IDENTITY', 'caller pid and pgid must be safe integers above zero');
  }
  if (typeof typed.killFn !== 'function') {
    fail('KILLFN', 'killFn must be a function');
  }
  if (typeof typed.handshake !== 'function') {
    fail('HANDSHAKE', 'handshake must be a function');
  }
  const transport = typed.transport;
  if (
    transport === null || typeof transport !== 'object' || Array.isArray(transport) ||
    typeof /** @type {Record<string, unknown>} */ (transport).connect !== 'function' ||
    typeof /** @type {Record<string, unknown>} */ (transport).request !== 'function' ||
    typeof /** @type {Record<string, unknown>} */ (transport).close !== 'function'
  ) {
    fail('TRANSPORT', 'transport must provide connect, request and close');
  }
  if (!hasExactKeys(typed.limits, LIMIT_KEYS)) {
    fail('LIMITS', 'limits must carry exactly the bound keys');
  }
  const limits = /** @type {Record<string, unknown>} */ (typed.limits);
  for (const key of LIMIT_KEYS) {
    const bound = limits[key];
    if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound <= 0) {
      fail('LIMITS', `limit ${key} must be a positive safe integer`);
    }
  }
  // [TARGET, unit decision] Bound host-supplied production hello deadlines.
  if (/** @type {number} */ (limits.handshakeTimeoutMs) > 10000) {
    fail('LIMITS', 'handshakeTimeoutMs exceeds the startup budget');
  }
  const ownership = typed.ownership;
  if (
    ownership === null || typeof ownership !== 'object' || Array.isArray(ownership) ||
    typeof /** @type {Record<string, unknown>} */ (ownership).ownedPids !== 'function' ||
    typeof /** @type {Record<string, unknown>} */ (ownership).waitForExit !== 'function'
  ) {
    fail('OWNERSHIP', 'ownership must provide ownedPids and waitForExit');
  }
  const callbacks = typed.callbacks;
  if (
    callbacks === null || typeof callbacks !== 'object' || Array.isArray(callbacks) ||
    typeof /** @type {Record<string, unknown>} */ (callbacks).onStatus !== 'function'
  ) {
    fail('CALLBACKS', 'callbacks must provide onStatus');
  }
  const spawnFn = /** @type {(command: string, args: ReadonlyArray<string>, opts: Record<string, unknown>) => unknown} */ (typed.spawn);
  const killFn = /** @type {CoreKillFn} */ (typed.killFn);
  const handshake = /** @type {CoreHandshake} */ (typed.handshake);
  const adapter = /** @type {CoreTransport} */ (transport);
  const bounds = /** @type {CoreLimits} */ (limits);
  const ledger = /** @type {CoreOwnership} */ (ownership);
  const listener = /** @type {CoreCallbacks} */ (callbacks);
  const hostArgs = /** @type {ReadonlyArray<string>} */ (args).slice();

  /** @type {'idle' | 'starting' | 'live' | 'unavailable'} */
  let availability = 'idle';
  /** @type {number | null} */
  let pid = null;
  /** @type {number | null} */
  let authorityEpoch = null;
  /** @type {string | null} */
  let reason = null;
  /** @type {Promise<CoreStatus> | null} */
  let startPromise = null;
  /** @type {Promise<void> | null} */
  let disposePromise = null;
  let childAlive = false;
  /** @type {Set<number>} */
  const exitedPids = new Set();
  /** @type {Array<number>} */
  let pendingLine = [];
  /** @type {Array<number>} */
  let stderrTail = [];
  let inFlightCount = 0;
  let inFlightBytes = 0;

  /**
   * @returns {CoreStatus} Frozen snapshot.
   */
  function getStatus() {
    return Object.freeze({ availability, pid, authority_epoch: authorityEpoch, reason });
  }

  /**
   * Fire the status listener; listener exceptions never escape.
   * @returns {void}
   */
  function emitStatus() {
    try {
      listener.onStatus(getStatus());
    } catch {
      /* listener failure never bypasses cleanup or revives state */
    }
  }

  /**
   * Move to `unavailable` once; the first terminal reason wins.
   * @param {string} failure Terminal reason.
   * @returns {CoreStatus} Frozen snapshot.
   */
  function setUnavailable(failure) {
    if (availability !== 'unavailable') {
      availability = 'unavailable';
      if (reason === null) {
        reason = failure;
      }
      emitStatus();
    }
    return getStatus();
  }

  /**
   * Stop the owned child tree: TERM every owned, live, guard-admitted
   * pid in reverse ledger order, await exit evidence, escalate to KILL
   * on deadline. Nothing spawned yields zero signals, and missing
   * ownership yields zero signals. Never throws.
   * @returns {Promise<void>}
   */
  async function stopChild() {
    childAlive = false;
    if (pid === null) {
      return;
    }
    /** @type {ReadonlyArray<unknown>} */
    let listed = [];
    try {
      const result = ledger.ownedPids();
      if (!Array.isArray(result)) {
        return;
      }
      listed = result;
    } catch {
      return;
    }
    /** @type {Array<number>} */
    const candidates = [];
    for (let index = listed.length - 1; index >= 0; index -= 1) {
      const candidate = listed[index];
      if (!validateKillTarget(candidate, selfPid, selfPgid)) {
        continue;
      }
      const target = /** @type {number} */ (candidate);
      if (exitedPids.has(target) || candidates.includes(target)) {
        continue;
      }
      candidates.push(target);
    }
    if (pid !== null && validateKillTarget(pid, selfPid, selfPgid) && !exitedPids.has(pid) && !candidates.includes(pid)) {
      candidates.push(pid);
    }
    /** @type {Array<number>} */
    const signalled = [];
    for (const target of candidates) {
      try {
        killFn(target, 'SIGTERM');
        signalled.push(target);
      } catch {
        /* kill failure still awaits exit evidence below */
        signalled.push(target);
      }
    }
    for (const target of signalled) {
      try {
        await withTimeout(
          (signal) => ledger.waitForExit(target, signal),
          bounds.shutdownTimeoutMs,
          'SHUTDOWN_TIMEOUT',
        );
      } catch {
        if (validateKillTarget(target, selfPid, selfPgid)) {
          try {
            killFn(target, 'SIGKILL');
          } catch {
            /* fall through to the bounded rewait */
          }
        }
        try {
          await withTimeout(
            (signal) => ledger.waitForExit(target, signal),
            bounds.shutdownTimeoutMs,
            'SHUTDOWN_TIMEOUT',
          );
        } catch {
          /* teardown never rejects */
        }
      }
    }
  }

  /**
   * Handle one stdout chunk: split complete lines off the bounded byte
   * buffer. Lines are drained, never interpreted: no v0.2 stdout
   * consumer exists. Oversize partial lines fail the child.
   * @param {unknown} chunk Alleged bytes.
   * @returns {void}
   */
  function onStdoutData(chunk) {
    if (availability === 'unavailable') {
      return;
    }
    /** @type {Uint8Array | null} */
    let bytes = null;
    if (typeof chunk === 'string') {
      bytes = Buffer.from(chunk, 'utf8');
    } else if (chunk instanceof Uint8Array) {
      bytes = chunk;
    }
    if (bytes === null) {
      setUnavailable('stdout protocol violation: chunk is not bytes');
      void stopChild();
      return;
    }
    for (let index = 0; index < bytes.length; index += 1) {
      pendingLine.push(/** @type {number} */ (bytes[index]));
    }
    drainPendingLines();
  }

  /**
   * Split complete lines off the pending byte buffer. The byte bound is
   * enforced incrementally, before any decoding, so a missing newline
   * can never grow the buffer without limit.
   * @returns {void}
   */
  function drainPendingLines() {
    for (;;) {
      const newline = pendingLine.indexOf(10);
      if (newline === -1) {
        if (pendingLine.length > bounds.maxStdoutLineBytes) {
          pendingLine = [];
          setUnavailable('stdout line exceeds its byte bound');
          void stopChild();
        }
        return;
      }
      const raw = pendingLine.slice(0, newline);
      pendingLine = pendingLine.slice(newline + 1);
      if (raw.length > bounds.maxStdoutLineBytes) {
        pendingLine = [];
        setUnavailable('stdout line exceeds its byte bound');
        void stopChild();
        return;
      }
      try {
        Buffer.from(raw).toString('utf8');
      } catch {
        pendingLine = [];
        setUnavailable('stdout protocol violation: line is not UTF-8');
        void stopChild();
        return;
      }
    }
  }

  /**
   * Handle one stderr chunk: retain a bounded tail, count nothing
   * unbounded. Stderr volume alone never fails the child.
   * @param {unknown} chunk Alleged bytes.
   * @returns {void}
   */
  function onStderrData(chunk) {
    if (availability === 'unavailable') {
      return;
    }
    /** @type {Uint8Array | null} */
    let bytes = null;
    if (typeof chunk === 'string') {
      bytes = Buffer.from(chunk, 'utf8');
    } else if (chunk instanceof Uint8Array) {
      bytes = chunk;
    }
    if (bytes === null) {
      return;
    }
    for (let index = 0; index < bytes.length; index += 1) {
      stderrTail.push(/** @type {number} */ (bytes[index]));
    }
    if (stderrTail.length > bounds.maxStderrTailBytes) {
      stderrTail = stderrTail.slice(stderrTail.length - bounds.maxStderrTailBytes);
    }
  }

  /**
   * @param {unknown} code Exit code.
   * @param {unknown} signal Exit signal.
   * @returns {void}
   */
  function onChildExit(code, signal) {
    if (pid !== null) {
      exitedPids.add(pid);
    }
    childAlive = false;
    pendingLine = [];
    setUnavailable(`core child exited (code=${String(code)} signal=${String(signal)})`);
  }

  /**
   * Run the single start attempt: spawn with pipes and no shell, wire
   * bounded drains, connect the transport, then go live only through
   * the authenticated handshake. Never throws.
   * @returns {Promise<CoreStatus>} Terminal start status.
   */
  async function runStart() {
    availability = 'starting';
    emitStatus();
    /** @type {unknown} */
    let spawned = null;
    try {
      const result = spawnFn(/** @type {string} */ (command), hostArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: scrubbed,
      });
      if (typeof result === 'object' && result !== null) {
        spawned = result;
      }
    } catch {
      spawned = null;
    }
    if (spawned === null) {
      return setUnavailable('core spawn failed');
    }
    const child = /** @type {Record<string, unknown>} */ (spawned);
    const childPid = child.pid;
    if (!validateKillTarget(childPid, selfPid, selfPgid)) {
      return setUnavailable('core spawn failed: unsafe child pid');
    }
    pid = /** @type {number} */ (childPid);
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (
      stdout === null || typeof stdout !== 'object' || Array.isArray(stdout) ||
      stderr === null || typeof stderr !== 'object' || Array.isArray(stderr) ||
      typeof /** @type {Record<string, unknown>} */ (stdout).on !== 'function' ||
      typeof /** @type {Record<string, unknown>} */ (stderr).on !== 'function' ||
      typeof child.on !== 'function'
    ) {
      return setUnavailable('core spawn failed: malformed child handle');
    }
    childAlive = true;
    try {
      /** @type {{on: (event: string, listener: (...args: Array<unknown>) => void) => unknown}} */ (stdout).on('data', onStdoutData);
      /** @type {{on: (event: string, listener: (...args: Array<unknown>) => void) => unknown}} */ (stdout).on('end', () => {
        pendingLine = [];
        setUnavailable('core stdout reached EOF');
      });
      /** @type {{on: (event: string, listener: (...args: Array<unknown>) => void) => unknown}} */ (stdout).on('error', () => {
        setUnavailable('core stdout stream error');
        void stopChild();
      });
      /** @type {{on: (event: string, listener: (...args: Array<unknown>) => void) => unknown}} */ (stderr).on('data', onStderrData);
      /** @type {{on: (event: string, listener: (...args: Array<unknown>) => void) => unknown}} */ (stderr).on('error', () => {
        /* stderr alone never fails the child */
      });
      /** @type {(event: string, listener: (...args: Array<unknown>) => void) => unknown} */ (child.on).call(child, 'error', () => {
        setUnavailable('core child error');
        void stopChild();
      });
      /** @type {(event: string, listener: (...args: Array<unknown>) => void) => unknown} */ (child.on).call(child, 'exit', onChildExit);
      /** @type {(event: string, listener: (...args: Array<unknown>) => void) => unknown} */ (child.on).call(child, 'close', () => {
        if (pid !== null) {
          exitedPids.add(pid);
        }
        childAlive = false;
        setUnavailable('core child closed');
      });
    } catch {
      return setUnavailable('core spawn failed: listener wiring refused');
    }
    try {
      await withTimeout(
        (signal) => adapter.connect(signal),
        bounds.handshakeTimeoutMs,
        'HANDSHAKE_TIMEOUT',
      );
    } catch {
      await stopChild();
      return setUnavailable('core handshake failed: connect refused');
    }
    /** @type {unknown} */
    let hello = null;
    try {
      hello = await withTimeout(
        (signal) => handshake(adapter, signal),
        bounds.handshakeTimeoutMs,
        'HANDSHAKE_TIMEOUT',
      );
    } catch (error) {
      await stopChild();
      // Surface only the admitted version code; foreign error text is untrusted.
      const versionMismatch = error !== null && typeof error === 'object' &&
        'code' in error && error.code === 'VERSION_MISMATCH';
      return setUnavailable(versionMismatch
        ? 'core handshake failed: VERSION_MISMATCH'
        : 'core handshake failed: no verified hello');
    }
    const epoch = /** @type {Record<string, unknown> | null} */ (typeof hello === 'object' && hello !== null && !Array.isArray(hello) ? hello : null);
    const verified = epoch === null ? null : epoch.authority_epoch;
    if (typeof verified !== 'number' || !Number.isSafeInteger(verified) || verified < 0) {
      await stopChild();
      return setUnavailable('core handshake failed: bad authority epoch');
    }
    availability = 'live';
    authorityEpoch = verified;
    emitStatus();
    return getStatus();
  }

  /**
   * Single-flight start. The latch is set before any spawn; repeated
   * calls share the one attempt and the launcher never respawns.
   * @returns {Promise<CoreStatus>} Start status.
   */
  function start() {
    if (disposePromise !== null) {
      return Promise.resolve(getStatus());
    }
    if (startPromise !== null) {
      return startPromise;
    }
    startPromise = runStart();
    return startPromise;
  }

  /**
   * Send one request when live: count and byte gates first, then a
   * single transport attempt with a deadline. Never resends; a failed
   * request rejects while the launcher stays live.
   * @param {unknown} message Request message.
   * @returns {Promise<unknown>} Transport answer.
   */
  async function request(message) {
    if (availability !== 'live') {
      throw new CoreLauncherError('NOT_LIVE', 'core is not live');
    }
    const bytes = requestByteLength(message);
    if (bytes < 0) {
      throw new CoreLauncherError('REQUEST_SHAPE', 'request is not measurable');
    }
    if (bytes > bounds.maxRequestBytes) {
      throw new CoreLauncherError('REQUEST_BYTES', 'request exceeds its byte bound');
    }
    if (inFlightCount + 1 > bounds.maxQueuedRequests) {
      throw new CoreLauncherError('QUEUE_FULL', 'request queue is full');
    }
    if (inFlightBytes + bytes > bounds.maxQueuedBytes) {
      throw new CoreLauncherError('QUEUE_BYTES', 'request queue bytes are exhausted');
    }
    inFlightCount += 1;
    inFlightBytes += bytes;
    try {
      return await withTimeout(
        (signal) => adapter.request(message, signal),
        bounds.requestTimeoutMs,
        'REQUEST_TIMEOUT',
      );
    } finally {
      inFlightCount -= 1;
      inFlightBytes -= bytes;
    }
  }

  /**
   * Run teardown: close admission, close the transport, stop the owned
   * tree with exit evidence. Never rejects.
   * @returns {Promise<void>}
   */
  async function runDispose() {
    try {
      await adapter.close();
    } catch {
      /* teardown never rejects */
    }
    await stopChild();
  }

  /**
   * Idempotent teardown shared across calls. The terminal transition
   * happens synchronously so a racing start cannot spawn.
   * @returns {Promise<void>}
   */
  function dispose() {
    if (disposePromise !== null) {
      return disposePromise;
    }
    if (availability !== 'unavailable') {
      availability = 'unavailable';
      if (reason === null) {
        reason = 'disposed';
      }
      emitStatus();
    } else if (reason === null) {
      reason = 'disposed';
    }
    disposePromise = runDispose();
    return disposePromise;
  }

  return Object.freeze({ start, request, dispose, getStatus });
}
