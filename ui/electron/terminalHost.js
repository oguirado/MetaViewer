// @ts-check
/** [TARGET, unit decision] Retryable port refusals preserve the next input sequence.
 * Renderer handling requires the matching client contract.
 * Main-only capability: admitted server spec is copied
 * before utilityProcess launch. Caller authenticates renderer before transfer. */
import { fileURLToPath } from 'node:url';
import { validateSpawnSpec } from './ptySession.js';
/** @param {{utilityProcess:typeof import('electron').utilityProcess,session:string,spec:import('./ptySession.js').SpawnSpec,port:Electron.MessagePortMain}} options */
export function launchTerminalUtility({ utilityProcess, session, spec, port }) {
  const owned = validateSpawnSpec(spec);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error('INVALID_SESSION');
  const child = utilityProcess.fork(fileURLToPath(new URL('./ptyUtility.js', import.meta.url)), [], { serviceName: 'MetaViewer PTY' });
  child.once('spawn', () => child.postMessage({ session, spec: owned }, [port]));
  return child;
}


/** [TARGET, unit decision] Main hosts the existing bounded broker engine.
 * Only owned profile references enter it; recorded PTY process groups are reaped.
 * No optional provider configuration is admitted until a host-owned handoff exists.
 */
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { runBroker, validateProviderArgv, validateProviderEnv } from './ptyBroker.js';

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const CAPSULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** @param {unknown} v @param {string} keys */
function hasClosedKeys(v, keys) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Reflect.ownKeys(v).length === keys.split(',').length
    && Object.keys(v).sort().join(',') === keys
    && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d);
}

/** @param {number} rootPid @returns {number[]} */
function collectProcessTreePids(rootPid) {
  /** @type {Set<number>} */
  const tree = new Set([rootPid]);
  try {
    const entries = readdirSync('/proc');
    /** @type {Array<{ pid: number, ppid: number, pgrp: number, sid: number }>} */
    const procs = [];
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rparen = stat.lastIndexOf(')');
        if (rparen < 0) continue;
        const fields = stat.slice(rparen + 2).trim().split(/\s+/);
        const ppid = Number(fields[1]);
        const pgrp = Number(fields[2]);
        const sid = Number(fields[3]);
        procs.push({ pid, ppid, pgrp, sid });
      } catch {
        // Process exited during scan.
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const { pid, ppid, pgrp, sid } of procs) {
        if (!tree.has(pid) && (ppid === rootPid || pgrp === rootPid || sid === rootPid || tree.has(ppid))) {
          tree.add(pid);
          changed = true;
        }
      }
    }
  } catch {
    // /proc unavailable; fallback to process group and leader pid.
  }
  return [...tree];
}

// [TARGET, unit decision] Bound consecutive retryable refusals without admitted input.
export const MAX_CONSECUTIVE_RETRYABLE_REFUSALS = 64;

export const DEFAULT_TERMINAL_LIMITS = Object.freeze({
  attachDeadlineMs: 10_000,
  maxPreAttachFrames: 64,
  maxPreAttachBytes: 65_536,
  resizeBurst: 16,
  resizePerSec: 16,
  writeBytesBurst: 262_144,
  writeBytesPerSec: 262_144,
  writeOpsBurst: 64,
  writeOpsPerSec: 64,
});

/**
 * [TARGET, unit decision] Per-session token bucket for terminal resize and input rate limiting.
 * @param {{ capacity: number, refillPerSec: number, now?: () => number }} options
 */
export function createTokenBucket({ capacity, refillPerSec, now = Date.now }) {
  const cap = Number.isFinite(capacity) && capacity > 0 ? capacity : 1;
  const rate = Number.isFinite(refillPerSec) && refillPerSec >= 0 ? refillPerSec : 0;
  let tokens = cap;
  let lastMs = now();
  return {
    /** Non-consuming admission check; refusal leaves tokens and refill accounting intact.
     * @param {number} [cost] */
    canTake(cost = 1) {
      if (!Number.isFinite(cost) || cost <= 0) return false;
      const elapsedSec = Math.max(0, (now() - lastMs) / 1000);
      return Math.min(cap, tokens + elapsedSec * rate) >= cost;
    },
    /** @param {number} [cost] */
    take(cost = 1) {
      if (!Number.isFinite(cost) || cost <= 0) return false;
      const currentMs = now();
      const elapsedSec = Math.max(0, (currentMs - lastMs) / 1000);
      lastMs = currentMs;
      if (elapsedSec > 0 && rate > 0) {
        tokens = Math.min(cap, tokens + elapsedSec * rate);
      }
      if (tokens < cost) {
        return false;
      }
      tokens -= cost;
      return true;
    },
  };
}

/** @param {unknown} rawSender @returns {unknown} */
function resolveSenderKey(rawSender) {
  if (rawSender === undefined || rawSender === null) return null;
  if (typeof rawSender === 'number' || typeof rawSender === 'string' || typeof rawSender === 'symbol') {
    return rawSender;
  }
  if (typeof rawSender === 'object') {
    const rec = /** @type {Record<string, any>} */ (rawSender);
    if (typeof rec.id === 'number' || typeof rec.id === 'string') {
      return `id:${rec.id}`;
    }
    if (rec.sender && (typeof rec.sender.id === 'number' || typeof rec.sender.id === 'string')) {
      return `id:${rec.sender.id}`;
    }
    return rawSender;
  }
  return null;
}

/** @returns {Error} */
function createDisplayOnlyError() {
  const err = /** @type {Error & { code?: string }} */ (new Error('DISPLAY_ONLY: side-terminal is disabled in nested display'));
  err.code = 'DISPLAY_ONLY';
  return err;
}

/** @param {any} value @param {unknown} explicitSender */
function splitSenderArg(value, explicitSender) {
  if (explicitSender !== undefined) {
    return { cleanValue: value, senderKey: resolveSenderKey(explicitSender) };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'sender' in value) {
    const { sender, ...rest } = value;
    return { cleanValue: rest, senderKey: resolveSenderKey(sender) };
  }
  return { cleanValue: value, senderKey: null };
}

/** @param {any} options */
export function createTerminalHost({
  pty,
  createMessageChannel,
  clipboard,
  env = process.env,
  profiles = new Map(),
  nested = false,
  argv = [],
  now = Date.now,
  limits = {},
  attachDeadlineMs,
  maxPreAttachFrames,
  maxPreAttachBytes,
  resizeBurst,
  resizePerSec,
  writeBytesBurst,
  writeBytesPerSec,
  writeOpsBurst,
  writeOpsPerSec,
}) {
  const isNested = nested === true || (Array.isArray(argv) && argv.includes('--nested-depth=1'));
  const limitsConfig = {
    attachDeadlineMs: attachDeadlineMs ?? limits.attachDeadlineMs ?? DEFAULT_TERMINAL_LIMITS.attachDeadlineMs,
    maxPreAttachFrames: maxPreAttachFrames ?? limits.maxPreAttachFrames ?? DEFAULT_TERMINAL_LIMITS.maxPreAttachFrames,
    maxPreAttachBytes: maxPreAttachBytes ?? limits.maxPreAttachBytes ?? DEFAULT_TERMINAL_LIMITS.maxPreAttachBytes,
    resizeBurst: resizeBurst ?? limits.resizeBurst ?? DEFAULT_TERMINAL_LIMITS.resizeBurst,
    resizePerSec: resizePerSec ?? limits.resizePerSec ?? DEFAULT_TERMINAL_LIMITS.resizePerSec,
    writeBytesBurst: writeBytesBurst ?? limits.writeBytesBurst ?? DEFAULT_TERMINAL_LIMITS.writeBytesBurst,
    writeBytesPerSec: writeBytesPerSec ?? limits.writeBytesPerSec ?? DEFAULT_TERMINAL_LIMITS.writeBytesPerSec,
    writeOpsBurst: writeOpsBurst ?? limits.writeOpsBurst ?? DEFAULT_TERMINAL_LIMITS.writeOpsBurst,
    writeOpsPerSec: writeOpsPerSec ?? limits.writeOpsPerSec ?? DEFAULT_TERMINAL_LIMITS.writeOpsPerSec,
  };
  /** @type {{ shell: string | null, homedir: string }} */
  let osInfo = { shell: '/bin/sh', homedir: '/tmp' };
  try {
    osInfo = userInfo();
  } catch {
    // Fallback to /bin/sh and /tmp when passwd entry is absent.
  }
  const shell = typeof osInfo.shell === 'string' && osInfo.shell.startsWith('/') && !osInfo.shell.includes('\0') && osInfo.shell.length <= 4096
    ? osInfo.shell
    : '/bin/sh';
  const cwd = typeof osInfo.homedir === 'string' && osInfo.homedir.startsWith('/') && !osInfo.homedir.includes('\0')
    ? osInfo.homedir
    : (typeof env?.HOME === 'string' && env.HOME.startsWith('/') ? env.HOME : '/tmp');
  const defaultEnv = validateProviderEnv({ TERM: 'xterm-256color', ...env }, ['PATH', 'HOME', 'LANG', 'TERM', 'COLORTERM']);

  /** @type {Map<string, any>} */
  const owned = new Map();
  /** @type {Map<string, {label: string, hint: string, args: ReadonlyArray<string>}>} */
  const providerMeta = new Map();

  if (profiles && typeof profiles.entries === 'function') {
    for (const [id, raw] of profiles.entries()) {
      if (typeof id !== 'string' || !SESSION_ID_RE.test(id) || !raw || typeof raw !== 'object') continue;
      const rawArgs = Array.isArray(raw.args)
        ? raw.args
        : (Array.isArray(raw.argv) ? raw.argv.slice(1) : []);
      const executable = typeof raw.executable === 'string' && raw.executable.startsWith('/')
        ? raw.executable
        : (Array.isArray(raw.argv) && typeof raw.argv[0] === 'string' && raw.argv[0].startsWith('/') ? raw.argv[0] : shell);
      const argv = Array.isArray(raw.argv) && raw.argv.length > 0
        ? raw.argv
        : [executable, ...rawArgs];
      const profileEnv = raw.env && typeof raw.env === 'object'
        ? validateProviderEnv(raw.env, Object.keys(raw.env))
        : defaultEnv;
      owned.set(id, {
        command: id === 'shell' ? 'shell' : 'provider',
        executable,
        argv,
        loginShell: typeof raw.loginShell === 'string' && raw.loginShell.startsWith('/') ? raw.loginShell : shell,
        cwd: typeof raw.cwd === 'string' && raw.cwd.startsWith('/') ? raw.cwd : cwd,
        env: profileEnv,
      });
      providerMeta.set(id, {
        label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : id,
        hint: typeof raw.hint === 'string' ? raw.hint : '',
        args: [...rawArgs],
      });
    }
  }
  owned.set('shell', {
    command: 'shell',
    executable: shell,
    argv: [],
    loginShell: shell,
    cwd,
    env: defaultEnv,
  });
  providerMeta.set('shell', {
    label: 'System shell',
    hint: 'Interactive login shell',
    args: [],
  });

  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Set<number>} */
  const pids = new Set();
  /** @type {any} */
  let receive;
  let enabled = false;
  let disposed = false;
  /** @type {any} */
  let resolvedPty = pty ?? null;

  /** @param {any} s */
  const clearAttachTimer = (s) => {
    if (s && s.attachTimer !== null && s.attachTimer !== undefined) {
      clearTimeout(s.attachTimer);
      s.attachTimer = null;
    }
  };

  /** @param {string} sessionId */
  const closeSessionInternal = async (sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) return true;
    clearAttachTimer(s);
    if (!s.exited) {
      send({ op: 'close', id: sessionId });
      await s.exitPromise;
    }
    sessions.delete(sessionId);
    if (!s.opened) {
      try {
        s.reject(new Error('TERMINAL_IO_REFUSED'));
      } catch {}
    }
    try {
      s.port?.close?.();
    } catch {}
    return true;
  };

  /** @param {any} s @param {string} id @param {any} frame */
  const enqueuePreAttachFrame = (s, id, frame) => {
    const frameBytes = frame && frame.bytes instanceof Uint8Array ? frame.bytes.byteLength : 64;
    if (s.queue.length + 1 > limitsConfig.maxPreAttachFrames
        || s.queuedBytes + frameBytes > limitsConfig.maxPreAttachBytes) {
      s.queue = [];
      s.queuedBytes = 0;
      clearAttachTimer(s);
      void closeSessionInternal(id).catch(() => {});
      return false;
    }
    s.queue.push(frame);
    s.queuedBytes += frameBytes;
    return true;
  };

  /** @param {number} pid */
  const reapOwnedPid = async (pid) => {
    if (!pids.delete(pid) || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
      throw new Error('UNOWNED_PID');
    }
    const targets = collectProcessTreePids(pid);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ESRCH') {
        // Fallback to individual PIDs below.
      }
    }
    for (const targetPid of targets) {
      if (targetPid > 1 && targetPid !== process.pid) {
        try {
          process.kill(targetPid, 'SIGKILL');
        } catch {
          // Process already exited.
        }
      }
    }
  };

  const engine = runBroker({
    profiles: owned,
    pty: {
      spawn: (/** @type {any} */ file, /** @type {any} */ args, /** @type {any} */ opts) => {
        const handle = resolvedPty.spawn(file, args, opts);
        return {
          pid: handle.pid,
          onData: (/** @type {any} */ fn) => handle.onData(fn),
          onExit: (/** @type {any} */ fn) => handle.onExit((/** @type {any} */ event) => fn(typeof event === 'number' ? event : event?.exitCode ?? 0)),
          write: (/** @type {any} */ data) => handle.write(data),
          resize: (/** @type {any} */ c, /** @type {any} */ r) => handle.resize(c, r),
          kill: (/** @type {any} */ signal) => handle.kill(signal),
          pause: () => handle.pause?.(),
          resume: () => handle.resume?.(),
        };
      },
    },
    processes: {
      record: (pid) => {
        pids.add(pid);
      },
      reapOwned: reapOwnedPid,
    },
    transport: {
      onMessage: (fn) => {
        receive = fn;
        return () => {
          if (receive === fn) {
            receive = () => {};
          }
        };
      },
      send: (message) => {
        const id = String(message.id ?? '');
        const s = sessions.get(id);
        if (!s) return;
        if (message.ev === 'open') {
          s.opened = true;
          s.pid = message.pid;
          s.resolve({ session: id });
          return;
        }
        if (message.ev === 'error') {
          if (!s.opened) {
            clearAttachTimer(s);
            sessions.delete(id);
            s.resolveExit();
            s.reject(new Error('TERMINAL_IO_REFUSED'));
            return;
          }
          const errFrame = { session: id, error: 'TERMINAL_IO_REFUSED' };
          if (s.port) s.port.postMessage(errFrame);
          else enqueuePreAttachFrame(s, id, errFrame);
          return;
        }
        const frame = message.ev === 'data'
          ? { session: id, seq: message.seq, bytes: new Uint8Array(Buffer.from(String(message.b64), 'base64')) }
          : { session: id, ...(message.ev === 'exit' ? { exitCode: message.code } : { error: 'TERMINAL_IO_REFUSED' }) };
        if (message.ev === 'exit') {
          clearAttachTimer(s);
          s.exited = true;
          s.resolveExit();
        }
        if (s.port) s.port.postMessage(frame);
        else enqueuePreAttachFrame(s, id, frame);
      },
    },
  });

  const send = (/** @type {any} */ message) => receive({ version: 1, generation: 1, ...message });

  /** @param {any} value @param {string} [keys] @param {boolean} [allowExited] @param {unknown} [senderKey] */
  const getSession = (value, keys = 'session', allowExited = false, senderKey = null) => {
    if (!hasClosedKeys(value, keys) || typeof value.session !== 'string') {
      throw new Error('TERMINAL_IO_REFUSED');
    }
    if (!SESSION_ID_RE.test(value.session)) {
      throw new Error('TERMINAL_UNKNOWN_SESSION');
    }
    const s = sessions.get(value.session);
    if (!s || (!allowExited && s.exited)) {
      throw new Error('TERMINAL_UNKNOWN_SESSION');
    }
    if (s.sender !== null || senderKey !== null) {
      if (s.sender === null || senderKey === null || s.sender !== senderKey) {
        throw new Error('TERMINAL_IO_REFUSED: SENDER');
      }
    }
    return s;
  };

  const host = {
    profiles: owned,
    setEnabled: async (/** @type {boolean} */ value) => {
      if (isNested) throw createDisplayOnlyError();
      if (typeof value !== 'boolean') throw new Error('PAYLOAD');
      enabled = value;
      return true;
    },
    open: async (/** @type {any} */ rawValue, /** @type {unknown} */ explicitSender) => {
      if (isNested) throw createDisplayOnlyError();
      const { cleanValue: value, senderKey } = splitSenderArg(rawValue, explicitSender);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('PAYLOAD');
      }
      const keySet = Object.keys(value).sort().join(',');
      if (!['cols,command,rows', 'args,cols,command,rows', 'cols,command,provider,rows'].includes(keySet)
          || typeof value.command !== 'string'
          || !Number.isSafeInteger(value.cols) || value.cols < 2 || value.cols > 500
          || !Number.isSafeInteger(value.rows) || value.rows < 2 || value.rows > 300) {
        throw new Error('PAYLOAD');
      }
      const targetId = value.command === 'provider' && typeof value.provider === 'string'
        ? value.provider
        : value.command;
      if (value.args !== undefined) {
        if (!Array.isArray(value.args)) throw new Error('PAYLOAD');
        validateProviderArgv([targetId || 'x', ...value.args]);
      }
      if (!targetId || targetId.startsWith('-') || !SESSION_ID_RE.test(targetId) || !owned.has(targetId)) {
        throw new Error('COMMAND_NOT_ALLOWED');
      }
      const meta = providerMeta.get(targetId);
      if (value.args !== undefined && value.args.length > 0) {
        if (!meta || JSON.stringify(value.args) !== JSON.stringify(meta.args)) {
          throw new Error('COMMAND_NOT_ALLOWED');
        }
      }
      if (!enabled || disposed) {
        throw new Error('TERMINAL_DISABLED');
      }
      if (!resolvedPty) {
        try { resolvedPty = await import('node-pty'); }
        catch { return {ok:false, code:'TERMINAL_UNAVAILABLE', message:'TERMINAL_UNAVAILABLE: terminal support is not bundled in this package'}; }
      }
      const session = randomUUID();
      return new Promise((resolve, reject) => {
        /** @type {() => void} */
        let resolveExit = () => {};
        const exitPromise = new Promise((r) => {
          resolveExit = /** @type {() => void} */ (r);
        });
        /** @type {ReturnType<typeof setTimeout> | null} */
        let attachTimer = null;
        if (Number.isFinite(limitsConfig.attachDeadlineMs) && limitsConfig.attachDeadlineMs > 0) {
          attachTimer = setTimeout(() => {
            const current = sessions.get(session);
            if (current && !current.port && !current.exited) {
              void closeSessionInternal(session).catch(() => {});
            }
          }, limitsConfig.attachDeadlineMs);
          attachTimer.unref?.();
        }
        sessions.set(session, {
          resolve,
          reject,
          queue: [],
          queuedBytes: 0,
          inputSeq: 0,
          consecutiveRetryableRefusals: 0,
          opened: false,
          exited: false,
          exitPromise,
          resolveExit,
          port: null,
          sender: senderKey,
          attachTimer,
          resizeBucket: createTokenBucket({
            capacity: limitsConfig.resizeBurst,
            refillPerSec: limitsConfig.resizePerSec,
            now,
          }),
          writeOpsBucket: createTokenBucket({
            capacity: limitsConfig.writeOpsBurst,
            refillPerSec: limitsConfig.writeOpsPerSec,
            now,
          }),
          writeBytesBucket: createTokenBucket({
            capacity: limitsConfig.writeBytesBurst,
            refillPerSec: limitsConfig.writeBytesPerSec,
            now,
          }),
        });
        send({
          op: 'open',
          id: session,
          command: targetId === 'shell' ? 'shell' : 'provider',
          provider: targetId,
          cols: value.cols,
          rows: value.rows,
        });
      });
    },
    attach: async (/** @type {any} */ rawValue, /** @type {unknown} */ explicitSender) => {
      if (isNested) throw createDisplayOnlyError();
      const { cleanValue: value, senderKey } = splitSenderArg(rawValue, explicitSender);
      const s = getSession(value, 'session', true, senderKey);
      if (s.port) throw new Error('TERMINAL_IO_REFUSED');
      clearAttachTimer(s);
      const { port1, port2 } = createMessageChannel();
      s.port = port1;
      port1.on('message', (/** @type {any} */ event) => {
        const m = event && typeof event === 'object' && 'data' in event && !('session' in event)
          ? event.data
          : event;
        try {
          if (!m || typeof m !== 'object' || Array.isArray(m) || m.session !== value.session) {
            throw new Error('TERMINAL_IO_REFUSED');
          }
          const active = getSession({ session: m.session }, 'session', false, s.sender);
          const refuseRetryable = () => {
            if (active.consecutiveRetryableRefusals >= MAX_CONSECUTIVE_RETRYABLE_REFUSALS) {
              throw new Error('TERMINAL_IO_REFUSED');
            }
            active.consecutiveRetryableRefusals += 1;
            try {
              port1.postMessage({ session: value.session, error: 'TERMINAL_IO_REFUSED',
                retryable: true, expectedSeq: active.inputSeq + 1 });
            } catch {}
          };
          if (('cols' in m || 'rows' in m) && !('bytes' in m) && !('ack' in m) && !('seq' in m)) {
            if (hasClosedKeys(m, 'cols,rows,session')
                && Number.isSafeInteger(m.cols) && m.cols >= 2 && m.cols <= 500
                && Number.isSafeInteger(m.rows) && m.rows >= 2 && m.rows <= 300) {
              if (!enabled || !active.resizeBucket.take(1)) {
                refuseRetryable();
                return;
              }
              active.consecutiveRetryableRefusals = 0;
              send({ op: 'resize', id: m.session, cols: m.cols, rows: m.rows });
            } else {
              try {
                port1.postMessage({ session: value.session, error: 'TERMINAL_IO_REFUSED' });
              } catch {}
            }
            return;
          }
          if (hasClosedKeys(m, 'bytes,seq,session')
              && m.bytes instanceof Uint8Array
              && m.bytes.byteLength <= 65536
              && Number.isSafeInteger(m.seq)
              && m.seq === active.inputSeq + 1) {
            if (!enabled) {
              refuseRetryable();
              return;
            }
            if (!active.writeOpsBucket.canTake(1) || !active.writeBytesBucket.canTake(m.bytes.byteLength)) {
              refuseRetryable();
              return;
            }
            active.writeOpsBucket.take(1);
            active.writeBytesBucket.take(m.bytes.byteLength);
            active.consecutiveRetryableRefusals = 0;
            active.inputSeq += 1;
            send({ op: 'write', id: m.session, b64: Buffer.from(m.bytes).toString('base64') });
          } else if (hasClosedKeys(m, 'ack,bytes,session')
              && Number.isSafeInteger(m.ack) && m.ack > 0
              && Number.isSafeInteger(m.bytes) && m.bytes >= 0) {
            send({ op: 'ack', id: m.session, ack_seq: m.ack, ack_bytes: m.bytes });
          } else {
            throw new Error('TERMINAL_IO_REFUSED');
          }
        } catch {
          try {
            port1.postMessage({ session: value.session, error: 'TERMINAL_IO_REFUSED' });
          } catch {}
          if (sessions.has(value.session)) {
            void closeSessionInternal(value.session).catch(() => {});
          }
        }
      });
      port1.on('close', () => {
        if (sessions.has(value.session)) {
          void closeSessionInternal(value.session).catch(() => {});
        }
      });
      port1.start?.();
      for (const frame of s.queue) {
        port1.postMessage(frame);
      }
      s.queue = [];
      s.queuedBytes = 0;
      return { port: port2 };
    },
    resize: async (/** @type {any} */ rawValue, /** @type {unknown} */ explicitSender) => {
      if (isNested) throw createDisplayOnlyError();
      const { cleanValue: value, senderKey } = splitSenderArg(rawValue, explicitSender);
      const s = getSession(value, 'cols,rows,session', false, senderKey);
      if (!Number.isSafeInteger(value.cols) || value.cols < 2 || value.cols > 500
          || !Number.isSafeInteger(value.rows) || value.rows < 2 || value.rows > 300) {
        throw new Error('TERMINAL_IO_REFUSED');
      }
      if (!s.resizeBucket.take(1)) {
        throw new Error('TERMINAL_IO_REFUSED: RATE_LIMITED');
      }
      s.consecutiveRetryableRefusals = 0;
      send({ op: 'resize', id: value.session, cols: value.cols, rows: value.rows });
      return true;
    },
    close: async (/** @type {any} */ rawValue, /** @type {unknown} */ explicitSender) => {
      if (isNested) throw createDisplayOnlyError();
      const { cleanValue: value, senderKey } = splitSenderArg(rawValue, explicitSender);
      getSession(value, 'session', true, senderKey);
      return closeSessionInternal(value.session);
    },
    listProviders: async () => {
      if (isNested) throw createDisplayOnlyError();
      return {
        entries: [...owned.keys()].map((id) => {
          const meta = providerMeta.get(id);
          return {
            id,
            label: meta?.label ?? (id === 'shell' ? 'System shell' : id),
            hint: meta?.hint ?? (id === 'shell' ? 'Interactive login shell' : ''),
          };
        }),
        capabilities: [...owned.keys()].map((id) => ({
          id,
          available: !disposed,
          reason: disposed ? 'DISPOSED' : '',
        })),
      };
    },
    copyText: async (/** @type {any} */ value) => {
      if (isNested) throw createDisplayOnlyError();
      if (!hasClosedKeys(value, 'text')
          || typeof value.text !== 'string'
          || value.text.length < 1
          || value.text.length > 128
          || !CAPSULE_ID_RE.test(value.text)
          || !clipboard
          || typeof clipboard.writeText !== 'function') {
        throw new Error('ERR_CLIPBOARD_INVALID');
      }
      clipboard.writeText(value.text);
      return true;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      enabled = false;
      for (const s of sessions.values()) {
        clearAttachTimer(s);
        s.exited = true;
        s.resolveExit();
        if (!s.opened) {
          try {
            s.reject(new Error('TERMINAL_DISABLED'));
          } catch {}
        }
      }
      await engine.dispose();
      for (const pid of [...pids]) {
        try {
          await reapOwnedPid(pid);
        } catch {}
      }
      for (const s of sessions.values()) {
        clearAttachTimer(s);
        s.exited = true;
        s.resolveExit();
        try {
          s.port?.close?.();
        } catch {}
      }
      sessions.clear();
    },
  };
  return host;
}
