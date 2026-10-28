// @ts-check
/** [TARGET, unit decision] Main-only capability: admitted server spec is copied
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

/** @param {any} options */
export function createTerminalHost({ pty, createMessageChannel, clipboard, env = process.env, profiles = new Map() }) {
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
        return () => {};
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
            sessions.delete(id);
            s.resolveExit();
            s.reject(new Error('TERMINAL_IO_REFUSED'));
            return;
          }
          const errFrame = { session: id, error: 'TERMINAL_IO_REFUSED' };
          if (s.port) s.port.postMessage(errFrame);
          else s.queue.push(errFrame);
          return;
        }
        const frame = message.ev === 'data'
          ? { session: id, seq: message.seq, bytes: new Uint8Array(Buffer.from(String(message.b64), 'base64')) }
          : { session: id, ...(message.ev === 'exit' ? { exitCode: message.code } : { error: 'TERMINAL_IO_REFUSED' }) };
        if (s.port) s.port.postMessage(frame);
        else s.queue.push(frame);
        if (message.ev === 'exit') {
          s.exited = true;
          s.resolveExit();
        }
      },
    },
  });

  const send = (/** @type {any} */ message) => receive({ version: 1, generation: 1, ...message });

  /** @param {any} value @param {string} [keys] @param {boolean} [allowExited] */
  const getSession = (value, keys = 'session', allowExited = false) => {
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
    return s;
  };

  const host = {
    profiles: owned,
    setEnabled: async (/** @type {boolean} */ value) => {
      if (typeof value !== 'boolean') throw new Error('PAYLOAD');
      enabled = value;
      return true;
    },
    open: async (/** @type {any} */ value) => {
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
        resolvedPty = await import('node-pty');
      }
      const session = randomUUID();
      return new Promise((resolve, reject) => {
        /** @type {() => void} */
        let resolveExit = () => {};
        const exitPromise = new Promise((r) => {
          resolveExit = /** @type {() => void} */ (r);
        });
        sessions.set(session, {
          resolve,
          reject,
          queue: [],
          inputSeq: 0,
          opened: false,
          exited: false,
          exitPromise,
          resolveExit,
          port: null,
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
    attach: async (/** @type {any} */ value) => {
      const s = getSession(value, 'session', true);
      if (s.port) throw new Error('TERMINAL_IO_REFUSED');
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
          const active = getSession({ session: m.session }, 'session', false);
          const keys = Object.keys(m).sort().join(',');
          if (keys === 'bytes,seq,session'
              && m.bytes instanceof Uint8Array
              && m.bytes.byteLength <= 65536
              && Number.isSafeInteger(m.seq)
              && m.seq === active.inputSeq + 1
              && enabled) {
            active.inputSeq += 1;
            send({ op: 'write', id: m.session, b64: Buffer.from(m.bytes).toString('base64') });
          } else if (keys === 'ack,bytes,session'
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
            void host.close({ session: value.session }).catch(() => {});
          }
        }
      });
      port1.on('close', () => {
        if (sessions.has(value.session)) {
          void host.close({ session: value.session }).catch(() => {});
        }
      });
      port1.start?.();
      for (const frame of s.queue) {
        port1.postMessage(frame);
      }
      s.queue = [];
      return { port: port2 };
    },
    resize: async (/** @type {any} */ value) => {
      getSession(value, 'cols,rows,session', false);
      if (!Number.isSafeInteger(value.cols) || value.cols < 2 || value.cols > 500
          || !Number.isSafeInteger(value.rows) || value.rows < 2 || value.rows > 300) {
        throw new Error('TERMINAL_IO_REFUSED');
      }
      send({ op: 'resize', id: value.session, cols: value.cols, rows: value.rows });
      return true;
    },
    close: async (/** @type {any} */ value) => {
      const s = getSession(value, 'session', true);
      if (!s.exited) {
        send({ op: 'close', id: value.session });
        await s.exitPromise;
      }
      sessions.delete(value.session);
      try {
        s.port?.close?.();
      } catch {}
      return true;
    },
    listProviders: async () => ({
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
    }),
    copyText: async (/** @type {any} */ value) => {
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
      await engine.dispose();
      for (const pid of [...pids]) {
        try {
          await reapOwnedPid(pid);
        } catch {}
      }
      for (const s of sessions.values()) {
        try {
          s.port?.close?.();
        } catch {}
      }
      sessions.clear();
    },
  };
  return host;
}
