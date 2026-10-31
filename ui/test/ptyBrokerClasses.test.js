// @ts-check
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn as spawnNodePty } from 'node-pty';
import * as liveBrokerMod from '../electron/ptyBroker.js';
import {
  AI_MAX_LIFETIME_MS,
  AI_SESSION_BYTE_CAP,
  BROKER_REFUSAL_REMEDIES,
  CLOSE_SIGHUP_WAIT_MS,
  CLOSE_SIGTERM_WAIT_MS,
  DEFAULT_LIMITS,
  MAX_AI_SESSIONS,
  MAX_LIFETIME_MS,
  MAX_SESSIONS,
  MAX_SHELL_SESSIONS,
  SESSION_BYTE_CAP,
  SPAWN_BRAKE_BURST,
  SPAWN_BRAKE_COOLDOWN_MS,
  SPAWN_BRAKE_MAX_FAILURES,
  SPAWN_BRAKE_REFILL_PER_SEC,
  TERMINAL_CHANNELS,
  TERMINAL_WIRE_VERSION,
  assertSpawnProfile,
  createSpawnBrake,
  getBrokerRefusalRemedy,
  normalizeLimits,
  registerTerminalIpc,
  resolveNodePtyDir,
  resolveSessionClass,
  runBroker,
} from '../electron/ptyBroker.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = resolve(THIS_DIR, '..', 'electron');
const BROKER_SOURCE_PATH = join(ELECTRON_DIR, 'ptyBroker.js');
const CORE_LAUNCHER_URL = pathToFileURL(join(ELECTRON_DIR, 'coreLauncher.js')).href;

const SHELL_PROFILE = Object.freeze({
  command: 'shell',
  executable: '/bin/sh',
  argv: [],
  cwd: '/tmp',
  loginShell: '/bin/sh',
  env: { LANG: 'C', TERM: 'xterm-256color' },
});

const AI_PROFILE = Object.freeze({
  command: 'provider',
  executable: '/bin/echo',
  argv: ['/bin/echo', 'ready'],
  cwd: '/tmp',
  loginShell: '/bin/sh',
  env: { LANG: 'C', TERM: 'xterm-256color' },
});

const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

/**
 * Create a controllable in-memory broker harness with shell and ai profiles.
 * @param {object} [options]
 * @param {typeof runBroker} [options.runBrokerImpl]
 * @param {Partial<import('../electron/ptyBroker.js').BrokerLimits>} [options.limits]
 * @param {Map<string, unknown>} [options.profiles]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(pid: number) => Promise<void>} [options.onReap]
 * @param {(file: string, args: Array<string>, opts: Record<string, unknown>, index: number) => { pid?: number, killBehavior?: 'ignore' | 'sighup' | 'sigterm', throwOnSpawn?: boolean }} [options.onSpawn]
 */
function createClassBrokerHarness({
  runBrokerImpl = runBroker,
  limits = {},
  profiles = new Map([
    ['shell', SHELL_PROFILE],
    ['provider-ai', AI_PROFILE],
  ]),
  now = Date.now,
  sleep = undefined,
  onReap = undefined,
  onSpawn = undefined,
} = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  /** @type {Array<{ admission: Record<string, unknown>, outcome: Record<string, unknown> }>} */
  const outcomes = [];
  /** @type {Array<number>} */
  const recordedPids = [];
  /** @type {Array<number>} */
  const reapedPids = [];
  /** @type {Map<string, { pid: number, signals: Array<string>, emitData: (chunk: string | Uint8Array) => void, emitExit: (code: number) => void }>} */
  const handlesByPid = new Map();
  /** @type {((msg: unknown) => void) | null} */
  let receive = null;
  let nextPid = 4000;
  let spawnCalls = 0;

  const engine = runBrokerImpl({
    profiles,
    limits,
    now,
    sleep,
    authority: {
      async commitOutcome(admission, outcome) {
        outcomes.push({ admission, outcome });
      },
    },
    processes: {
      record(pid) {
        recordedPids.push(pid);
      },
      async reapOwned(pid) {
        if (onReap) await onReap(pid);
        reapedPids.push(pid);
      },
    },
    transport: {
      send(message) {
        events.push(/** @type {Record<string, unknown>} */ (message));
      },
      onMessage(listener) {
        receive = listener;
        return () => {
          receive = null;
        };
      },
    },
    pty: {
      spawn(file, args, opts) {
        spawnCalls += 1;
        const directive = onSpawn ? onSpawn(file, args, opts, spawnCalls) : {};
        if (directive && directive.throwOnSpawn) {
          throw new Error('simulated spawn failure');
        }
        const pid = directive && typeof directive.pid === 'number' ? directive.pid : (nextPid += 1);
        const killBehavior =
          directive && directive.killBehavior ? directive.killBehavior : 'sighup';
        /** @type {Array<string>} */
        const signals = [];
        /** @type {Array<(chunk: string | Uint8Array) => void>} */
        const dataListeners = [];
        /** @type {Array<(code: number) => void>} */
        const exitListeners = [];
        const emitData = (/** @type {string | Uint8Array} */ chunk) => {
          for (const fn of [...dataListeners]) fn(chunk);
        };
        const emitExit = (/** @type {number} */ code) => {
          for (const fn of [...exitListeners]) fn(code);
        };
        handlesByPid.set(String(pid), { pid, signals, emitData, emitExit });
        return {
          pid,
          onData(listener) {
            dataListeners.push(listener);
            return {
              dispose() {
                const idx = dataListeners.indexOf(listener);
                if (idx >= 0) dataListeners.splice(idx, 1);
              },
            };
          },
          onExit(listener) {
            exitListeners.push(listener);
            return {
              dispose() {
                const idx = exitListeners.indexOf(listener);
                if (idx >= 0) exitListeners.splice(idx, 1);
              },
            };
          },
          write() {},
          resize() {},
          pause() {},
          resume() {},
          kill(signal = 'SIGTERM') {
            signals.push(signal);
            if (killBehavior === 'sighup' && signal === 'SIGHUP') {
              emitExit(0);
            } else if (
              killBehavior === 'sigterm' &&
              (signal === 'SIGTERM' || signal === 'SIGKILL')
            ) {
              emitExit(0);
            } else if (signal === 'SIGKILL' && killBehavior !== 'ignore') {
              emitExit(0);
            }
          },
        };
      },
    },
  });

  /**
   * @param {Record<string, unknown>} payload
   */
  const send = async (payload) => {
    if (!receive) throw new Error('transport not connected');
    receive({ version: TERMINAL_WIRE_VERSION, generation: 1, ...payload });
    await tick();
    await tick();
  };

  return {
    engine,
    events,
    outcomes,
    recordedPids,
    reapedPids,
    handlesByPid,
    getSpawnCalls: () => spawnCalls,
    send,
  };
}

test('U3-1: per-class [TARGET] constants, refusal remedies, resolveSessionClass, assertSpawnProfile, and normalizeLimits', () => {
  // Verify [TARGET] and [CITED] defaults on DEFAULT_LIMITS.
  assert.equal(MAX_SESSIONS, 8);
  assert.equal(MAX_SHELL_SESSIONS, 4);
  assert.equal(MAX_AI_SESSIONS, 4);
  assert.equal(SESSION_BYTE_CAP, 8388608);
  assert.equal(AI_SESSION_BYTE_CAP, 67108864);
  assert.equal(MAX_LIFETIME_MS, 3600000);
  assert.equal(AI_MAX_LIFETIME_MS, 14400000);
  assert.equal(CLOSE_SIGHUP_WAIT_MS, 100);
  assert.equal(CLOSE_SIGTERM_WAIT_MS, 250);
  assert.equal(SPAWN_BRAKE_BURST, 16);
  assert.equal(SPAWN_BRAKE_REFILL_PER_SEC, 1);
  assert.equal(SPAWN_BRAKE_MAX_FAILURES, 3);
  assert.equal(SPAWN_BRAKE_COOLDOWN_MS, 60000);

  assert.equal(DEFAULT_LIMITS.maxSessions, 8);
  assert.equal(DEFAULT_LIMITS.maxShellSessions, 4);
  assert.equal(DEFAULT_LIMITS.maxAiSessions, 4);
  assert.equal(DEFAULT_LIMITS.shellSessionByteCap, 8388608);
  assert.equal(DEFAULT_LIMITS.aiSessionByteCap, 67108864);
  assert.equal(DEFAULT_LIMITS.shellLifetimeMs, 3600000);
  assert.equal(DEFAULT_LIMITS.aiLifetimeMs, 14400000);
  assert.equal(DEFAULT_LIMITS.closeSighupWaitMs, 100);
  assert.equal(DEFAULT_LIMITS.closeSigtermWaitMs, 250);

  // Verify documented refusal remedy table and helper.
  assert.equal(typeof BROKER_REFUSAL_REMEDIES.CLASS_LIMIT, 'string');
  assert.ok(BROKER_REFUSAL_REMEDIES.CLASS_LIMIT.length > 10);
  assert.equal(typeof BROKER_REFUSAL_REMEDIES.SPAWN_BRAKE, 'string');
  assert.ok(BROKER_REFUSAL_REMEDIES.SPAWN_BRAKE.length > 10);
  assert.equal(typeof BROKER_REFUSAL_REMEDIES.SESSION_LIMIT, 'string');
  assert.ok(BROKER_REFUSAL_REMEDIES.SESSION_LIMIT.length > 10);
  assert.equal(getBrokerRefusalRemedy('CLASS_LIMIT'), BROKER_REFUSAL_REMEDIES.CLASS_LIMIT);
  assert.equal(getBrokerRefusalRemedy('SPAWN_BRAKE'), BROKER_REFUSAL_REMEDIES.SPAWN_BRAKE);
  assert.equal(getBrokerRefusalRemedy('SESSION_LIMIT'), BROKER_REFUSAL_REMEDIES.SESSION_LIMIT);
  assert.equal(getBrokerRefusalRemedy('UNKNOWN_CODE'), null);
  assert.equal(getBrokerRefusalRemedy(null), null);

  // resolveSessionClass maps commands and explicit classes, and refuses unknown values.
  assert.equal(resolveSessionClass('shell'), 'shell');
  assert.equal(resolveSessionClass('provider'), 'ai');
  assert.equal(resolveSessionClass('shell', 'shell'), 'shell');
  assert.equal(resolveSessionClass('provider', 'ai'), 'ai');
  assert.equal(resolveSessionClass('provider', 'capsule-ai'), 'ai');
  assert.throws(() => resolveSessionClass('unknown'), { code: 'PROFILE_COMMAND' });
  assert.throws(() => resolveSessionClass('provider', 'root'), { code: 'PROFILE_CLASS' });

  // assertSpawnProfile populates sessionClass and refuses conflicting class declarations.
  const shellSpec = assertSpawnProfile(SHELL_PROFILE);
  assert.equal(shellSpec.sessionClass, 'shell');
  const aiSpec = assertSpawnProfile({ ...AI_PROFILE, class: 'capsule-ai' });
  assert.equal(aiSpec.sessionClass, 'ai');
  assert.throws(
    () => assertSpawnProfile({ ...SHELL_PROFILE, class: 'ai' }),
    { code: 'PROFILE_CLASS' },
  );
  assert.throws(
    () => assertSpawnProfile({ ...AI_PROFILE, class: 'shell' }),
    { code: 'PROFILE_CLASS' },
  );

  // normalizeLimits validates per-class overrides, escalates when maxSessions > 8, and rejects invalid keys/values.
  const custom = normalizeLimits({
    maxShellSessions: 2,
    maxAiSessions: 3,
    shellSessionByteCap: 1024,
    aiSessionByteCap: 4096,
    closeSighupWaitMs: 50,
    closeSigtermWaitMs: 120,
  });
  assert.equal(custom.maxShellSessions, 2);
  assert.equal(custom.maxAiSessions, 3);
  assert.equal(custom.shellSessionByteCap, 1024);
  assert.equal(custom.aiSessionByteCap, 4096);
  assert.equal(custom.closeSighupWaitMs, 50);
  assert.equal(custom.closeSigtermWaitMs, 120);

  const scaled = normalizeLimits({ maxSessions: 12 });
  assert.equal(scaled.maxSessions, 12);
  assert.equal(scaled.maxShellSessions, 12);
  assert.equal(scaled.maxAiSessions, 12);
  assert.equal(scaled.spawnBrakeBurst, 16);

  assert.throws(() => normalizeLimits({ maxShellSessions: 0 }), { code: 'LIMITS_VALUE' });
  assert.throws(() => normalizeLimits({ aiSessionByteCap: -1 }), { code: 'LIMITS_VALUE' });
  assert.throws(() => normalizeLimits({ unknownClassLimit: 4 }), { code: 'LIMITS_KEY' });
});

test('U3-2: per-class concurrent session limits isolate shell (4) and ai (4) in mixed and shell-only configs and count closing sessions until reaped', async () => {
  // 1. Mixed broker configuration (shell + provider-ai).
  const h = createClassBrokerHarness();
  try {
    for (let i = 1; i <= 4; i += 1) {
      await h.send({
        op: 'open',
        id: `sh-${i}`,
        provider: 'shell',
        command: 'shell',
        admission: { seq: i },
      });
    }
    assert.equal(
      h.events.filter((e) => e.ev === 'open').length,
      4,
    );

    // 5th shell session is refused with CLASS_LIMIT + remedy, tombstoned, and never spawns.
    const spawnsBeforeRefusal = h.getSpawnCalls();
    await h.send({
      op: 'open',
      id: 'sh-overflow',
      provider: 'shell',
      command: 'shell',
      admission: { seq: 5 },
    });
    assert.equal(h.getSpawnCalls(), spawnsBeforeRefusal);
    assert.deepEqual(h.events.at(-1), {
      version: 1,
      generation: 1,
      ev: 'error',
      id: 'sh-overflow',
      code: 'CLASS_LIMIT',
      remedy: BROKER_REFUSAL_REMEDIES.CLASS_LIMIT,
    });
    assert.deepEqual(h.outcomes.at(-1), {
      admission: { seq: 5 },
      outcome: { event: 'refused', session: 'sh-overflow', reason: 'CLASS_LIMIT' },
    });

    // Reusing tombstoned id 'sh-overflow' refuses with SESSION_CLOSED.
    await h.send({
      op: 'open',
      id: 'sh-overflow',
      provider: 'shell',
      command: 'shell',
    });
    assert.equal(h.events.at(-1)?.code, 'SESSION_CLOSED');

    // While shell is full at 4, ai class can still open 4 sessions (reaching global 8).
    for (let i = 1; i <= 4; i += 1) {
      await h.send({
        op: 'open',
        id: `ai-${i}`,
        provider: 'provider-ai',
        command: 'provider',
        admission: { seq: 10 + i },
      });
    }
    assert.equal(
      h.events.filter((e) => e.ev === 'open').length,
      8,
    );

    // Close one shell session so global live count is 7 (3 shell + 4 ai).
    await h.send({ op: 'close', id: 'sh-1' });
    assert.equal(
      h.events.some((e) => e.ev === 'exit' && e.id === 'sh-1'),
      true,
    );

    // A 5th ai session is refused with CLASS_LIMIT + remedy even though global count is 7 (< 8).
    await h.send({
      op: 'open',
      id: 'ai-overflow',
      provider: 'provider-ai',
      command: 'provider',
      admission: { seq: 15 },
    });
    assert.deepEqual(h.events.at(-1), {
      version: 1,
      generation: 1,
      ev: 'error',
      id: 'ai-overflow',
      code: 'CLASS_LIMIT',
      remedy: BROKER_REFUSAL_REMEDIES.CLASS_LIMIT,
    });

    // A new shell session succeeds because sh-1 freed its shell slot.
    await h.send({
      op: 'open',
      id: 'sh-replacement',
      provider: 'shell',
      command: 'shell',
      admission: { seq: 16 },
    });
    assert.equal(
      h.events.some((e) => e.ev === 'open' && e.id === 'sh-replacement'),
      true,
    );
  } finally {
    await h.engine.dispose();
  }

  // 2. Shell-only configuration (no 'ai' profile registered): still enforces maxShellSessions = 4 [TARGET].
  const hShellOnly = createClassBrokerHarness({
    profiles: new Map([['shell', SHELL_PROFILE]]),
  });
  try {
    for (let i = 1; i <= 4; i += 1) {
      await hShellOnly.send({
        op: 'open',
        id: `sh-only-${i}`,
        provider: 'shell',
        command: 'shell',
      });
    }
    assert.equal(
      hShellOnly.events.filter((e) => e.ev === 'open').length,
      4,
    );
    await hShellOnly.send({
      op: 'open',
      id: 'sh-only-5',
      provider: 'shell',
      command: 'shell',
    });
    assert.deepEqual(hShellOnly.events.at(-1), {
      version: 1,
      generation: 1,
      ev: 'error',
      id: 'sh-only-5',
      code: 'CLASS_LIMIT',
      remedy: BROKER_REFUSAL_REMEDIES.CLASS_LIMIT,
    });
  } finally {
    await hShellOnly.engine.dispose();
  }

  // 3. Staged-close sessions continue counting against both class and global caps until reaped.
  /** @type {(() => void) | null} */
  let releaseCloseWait = null;
  /** @type {(() => void) | null} */
  let releaseReapWait = null;
  const hClosing = createClassBrokerHarness({
    onSpawn: () => ({ killBehavior: 'ignore' }),
    sleep: () =>
      new Promise((resolveWait) => {
        if (!releaseCloseWait) {
          releaseCloseWait = () => resolveWait(undefined);
        } else {
          resolveWait(undefined);
        }
      }),
    onReap: () =>
      new Promise((resolveReap) => {
        if (!releaseReapWait) {
          releaseReapWait = () => resolveReap(undefined);
        } else {
          resolveReap(undefined);
        }
      }),
  });
  try {
    for (let i = 1; i <= 4; i += 1) {
      await hClosing.send({ op: 'open', id: `sc-sh-${i}`, provider: 'shell', command: 'shell' });
    }
    for (let i = 1; i <= 4; i += 1) {
      await hClosing.send({
        op: 'open',
        id: `sc-ai-${i}`,
        provider: 'provider-ai',
        command: 'provider',
      });
    }
    assert.equal(
      hClosing.events.filter((e) => e.ev === 'open').length,
      8,
    );

    // Initiate staged close on sc-sh-1; it pauses inside the SIGHUP wait.
    await hClosing.send({ op: 'close', id: 'sc-sh-1' });
    assert.equal(typeof releaseCloseWait, 'function');

    // While sc-sh-1 is in staged close, global liveCount is still 8 -> SESSION_LIMIT refuses.
    await hClosing.send({
      op: 'open',
      id: 'sc-during-wait-global',
      provider: 'shell',
      command: 'shell',
    });
    assert.deepEqual(hClosing.events.at(-1), {
      version: 1,
      generation: 1,
      ev: 'error',
      id: 'sc-during-wait-global',
      code: 'SESSION_LIMIT',
      remedy: BROKER_REFUSAL_REMEDIES.SESSION_LIMIT,
    });

    // Release SIGHUP wait; closeSession now pauses inside hooks.reapOwned.
    releaseCloseWait?.();
    await tick();
    await tick();
    assert.equal(typeof releaseReapWait, 'function');

    // While sc-sh-1 is awaiting reapOwned, it still counts as live -> SESSION_LIMIT refuses.
    await hClosing.send({
      op: 'open',
      id: 'sc-during-reap-global',
      provider: 'shell',
      command: 'shell',
    });
    assert.equal(hClosing.events.at(-1)?.code, 'SESSION_LIMIT');

    // Release reapOwned so sc-sh-1 finishes reaping and frees its slot.
    releaseReapWait?.();
    await tick();
    await tick();
    assert.equal(
      hClosing.events.some((e) => e.ev === 'exit' && e.id === 'sc-sh-1'),
      true,
    );

    // Now opening a replacement shell session succeeds.
    await hClosing.send({
      op: 'open',
      id: 'sc-after-reap',
      provider: 'shell',
      command: 'shell',
    });
    assert.equal(
      hClosing.events.some((e) => e.ev === 'open' && e.id === 'sc-after-reap'),
      true,
    );
  } finally {
    releaseCloseWait?.();
    releaseReapWait?.();
    await hClosing.engine.dispose();
  }
});

test('U3-3: per-class byte caps and lifetime timers enforce separate bounds for shell vs ai sessions', async () => {
  const h = createClassBrokerHarness({
    limits: {
      shellSessionByteCap: 32,
      aiSessionByteCap: 128,
      shellLifetimeMs: 35,
      aiLifetimeMs: 500,
    },
  });
  try {
    await h.send({ op: 'open', id: 'sh-byte', provider: 'shell', command: 'shell' });
    await h.send({ op: 'open', id: 'ai-byte', provider: 'provider-ai', command: 'provider' });

    const shOpen = h.events.find((e) => e.ev === 'open' && e.id === 'sh-byte');
    const aiOpen = h.events.find((e) => e.ev === 'open' && e.id === 'ai-byte');
    assert.ok(shOpen && aiOpen);

    const shHandle = h.handlesByPid.get(String(shOpen.pid));
    const aiHandle = h.handlesByPid.get(String(aiOpen.pid));
    assert.ok(shHandle && aiHandle);

    // Emit 32 bytes on both sessions: shell hits shellSessionByteCap (32) and exits with SESSION_CAP;
    // ai stays live because aiSessionByteCap is 128.
    shHandle.emitData(Buffer.alloc(32, 0x61));
    aiHandle.emitData(Buffer.alloc(32, 0x62));
    await tick();
    await tick();

    assert.equal(
      h.events.some((e) => e.ev === 'exit' && e.id === 'sh-byte' && e.reason === 'SESSION_CAP'),
      true,
    );
    assert.equal(
      h.events.some((e) => e.ev === 'exit' && e.id === 'ai-byte'),
      false,
    );

    // Emit another 64 bytes on ai (total 96 < 128): still live.
    aiHandle.emitData(Buffer.alloc(64, 0x62));
    await tick();
    assert.equal(
      h.events.some((e) => e.ev === 'exit' && e.id === 'ai-byte'),
      false,
    );

    // Emit final 32 bytes on ai (total 128 == aiSessionByteCap): now exits with SESSION_CAP.
    aiHandle.emitData(Buffer.alloc(32, 0x62));
    await tick();
    await tick();
    assert.equal(
      h.events.some((e) => e.ev === 'exit' && e.id === 'ai-byte' && e.reason === 'SESSION_CAP'),
      true,
    );

    // Verify per-class lifetime expiry: shell expires at 35 ms while ai stays alive.
    await h.send({ op: 'open', id: 'sh-ttl', provider: 'shell', command: 'shell' });
    await h.send({ op: 'open', id: 'ai-ttl', provider: 'provider-ai', command: 'provider' });
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 65));
    await tick();
    assert.equal(
      h.events.some((e) => e.ev === 'exit' && e.id === 'sh-ttl' && e.reason === 'SESSION_EXPIRED'),
      true,
    );
    assert.equal(
      h.events.some((e) => e.ev === 'exit' && e.id === 'ai-ttl'),
      false,
    );
  } finally {
    await h.engine.dispose();
  }
});

test('U3-4: staged close escalates SIGHUP -> bounded wait -> SIGTERM -> bounded wait -> SIGKILL and short-circuits on early exit', async () => {
  /** @type {Array<number>} */
  const waits = [];
  /** @type {Record<string, 'ignore' | 'sighup' | 'sigterm'>} */
  const behaviors = {
    '1': 'ignore',
    '2': 'sighup',
    '3': 'sigterm',
  };
  const h = createClassBrokerHarness({
    limits: {
      closeSighupWaitMs: 100,
      closeSigtermWaitMs: 250,
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    onSpawn: (_file, _args, _opts, idx) => ({
      killBehavior: behaviors[String(idx)] ?? 'ignore',
    }),
  });

  try {
    // 1. Stubborn process ignoring SIGHUP and SIGTERM gets full escalation:
    // SIGHUP -> wait(100) -> SIGTERM -> wait(250) -> SIGKILL -> reapOwned.
    await h.send({ op: 'open', id: 's-stubborn', provider: 'shell', command: 'shell' });
    const openStubborn = h.events.find((e) => e.ev === 'open' && e.id === 's-stubborn');
    assert.ok(openStubborn);
    const stubbornHandle = h.handlesByPid.get(String(openStubborn.pid));
    assert.ok(stubbornHandle);

    await h.send({ op: 'close', id: 's-stubborn' });
    assert.deepEqual(stubbornHandle.signals, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
    assert.deepEqual(waits, [100, 250]);
    assert.equal(h.reapedPids.includes(stubbornHandle.pid), true);
    assert.equal(
      h.events.some((e) => e.ev === 'exit' && e.id === 's-stubborn' && e.code === 0),
      true,
    );

    // 2. Cooperative process exiting on SIGHUP short-circuits before SIGTERM and SIGKILL.
    waits.length = 0;
    await h.send({ op: 'open', id: 's-sighup', provider: 'shell', command: 'shell' });
    const openHup = h.events.find((e) => e.ev === 'open' && e.id === 's-sighup');
    assert.ok(openHup);
    const hupHandle = h.handlesByPid.get(String(openHup.pid));
    assert.ok(hupHandle);

    await h.send({ op: 'close', id: 's-sighup' });
    assert.deepEqual(hupHandle.signals, ['SIGHUP']);
    assert.deepEqual(waits, []);
    assert.equal(h.reapedPids.includes(hupHandle.pid), true);

    // 3. Process ignoring SIGHUP but exiting on SIGTERM receives SIGHUP then SIGTERM, never SIGKILL.
    waits.length = 0;
    await h.send({ op: 'open', id: 's-sigterm', provider: 'provider-ai', command: 'provider' });
    const openTerm = h.events.find((e) => e.ev === 'open' && e.id === 's-sigterm');
    assert.ok(openTerm);
    const termHandle = h.handlesByPid.get(String(openTerm.pid));
    assert.ok(termHandle);

    await h.send({ op: 'close', id: 's-sigterm' });
    assert.deepEqual(termHandle.signals, ['SIGHUP', 'SIGTERM']);
    assert.deepEqual(waits, [100]);
    assert.equal(h.reapedPids.includes(termHandle.pid), true);
  } finally {
    await h.engine.dispose();
  }
});

test('U3-5: real node-pty staged close escalates past trapped SIGHUP to SIGTERM and reaps tree', async () => {
  const pty = {
    /**
     * @param {string} file
     * @param {ReadonlyArray<string>} args
     * @param {import('../electron/ptyBroker.js').PtySpawnOptions} opts
     */
    spawn(file, args, opts) {
      const raw = spawnNodePty(file, [...args], opts);
      return {
        pid: raw.pid,
        onData: (cb) => raw.onData(cb),
        onExit: (cb) => raw.onExit((ev) => cb(ev.exitCode)),
        write: (data) => raw.write(data),
        resize: (cols, rows) => raw.resize(cols, rows),
        kill: (sig) => raw.kill(sig),
        pause: () => raw.pause(),
        resume: () => raw.resume(),
      };
    },
  };
  const trapProfile = {
    command: 'provider',
    executable: '/bin/sh',
    argv: ['/bin/sh', '-c', 'trap "" HUP; trap "exit 0" TERM; echo READY; while :; do sleep 1; done'],
    cwd: '/tmp',
    loginShell: '/bin/sh',
    env: { LANG: 'C', TERM: 'xterm-256color' },
  };
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  /** @type {Array<number>} */
  const reaped = [];
  /** @type {((msg: unknown) => void) | null} */
  let receive = null;
  const engine = runBroker({
    profiles: new Map([['trap-hup', trapProfile]]),
    limits: {
      closeSighupWaitMs: 40,
      closeSigtermWaitMs: 200,
    },
    processes: {
      record() {},
      async reapOwned(pid) {
        reaped.push(pid);
      },
    },
    transport: {
      send(msg) {
        events.push(/** @type {Record<string, unknown>} */ (msg));
      },
      onMessage(fn) {
        receive = fn;
        return () => {
          receive = null;
        };
      },
    },
    pty,
  });

  try {
    assert.ok(receive);
    receive({
      version: TERMINAL_WIRE_VERSION,
      generation: 1,
      op: 'open',
      id: 'real-staged',
      provider: 'trap-hup',
      command: 'provider',
    });

    // Wait for READY output so the shell trap is active before closing.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const hasData = events.some(
        (e) =>
          e.ev === 'data' &&
          e.id === 'real-staged' &&
          Buffer.from(/** @type {string} */ (e.b64), 'base64').toString('utf8').includes('READY'),
      );
      if (hasData) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 15));
    }
    const openEv = events.find((e) => e.ev === 'open' && e.id === 'real-staged');
    assert.ok(openEv && typeof openEv.pid === 'number');

    receive({
      version: TERMINAL_WIRE_VERSION,
      generation: 1,
      op: 'close',
      id: 'real-staged',
    });

    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline) {
      if (events.some((e) => e.ev === 'exit' && e.id === 'real-staged')) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 15));
    }
    const exitEv = events.find((e) => e.ev === 'exit' && e.id === 'real-staged');
    assert.ok(exitEv);
    assert.deepEqual(reaped, [openEv.pid]);
    const reapDeadline = Date.now() + 500;
    while (Date.now() < reapDeadline) {
      try {
        process.kill(/** @type {number} */ (openEv.pid), 0);
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
      } catch {
        break;
      }
    }
    assert.throws(() => process.kill(/** @type {number} */ (openEv.pid), 0), { code: 'ESRCH' });
  } finally {
    await engine.dispose();
  }
});

test('U3-6: small per-class spawn brake enforces burst rate limit, 3-failure cooldown, and refusal remedies across broker and IPC', async () => {
  // Validate createSpawnBrake input guards.
  assert.throws(() => createSpawnBrake({ burst: 0 }), { code: 'BRAKE_SHAPE' });
  assert.throws(() => createSpawnBrake({ refillPerSec: 0 }), { code: 'BRAKE_SHAPE' });
  assert.throws(() => createSpawnBrake({ maxFailures: 0 }), { code: 'BRAKE_SHAPE' });
  assert.throws(() => createSpawnBrake({ cooldownMs: 0 }), { code: 'BRAKE_SHAPE' });

  // 1. Burst rate limit in runBroker with per-class isolation, clock refill, and remedy.
  let clockMs = 10_000;
  const hBurst = createClassBrokerHarness({
    now: () => clockMs,
    limits: {
      spawnBrakeBurst: 2,
      spawnBrakeRefillPerSec: 1,
      spawnBrakeMaxFailures: 3,
      spawnBrakeCooldownMs: 60000,
    },
  });
  try {
    await hBurst.send({ op: 'open', id: 'sh-b1', provider: 'shell', command: 'shell' });
    await hBurst.send({ op: 'open', id: 'sh-b2', provider: 'shell', command: 'shell' });
    assert.equal(hBurst.getSpawnCalls(), 2);

    // Close sh-b1 so session cap does not interfere; burst bucket for shell is now 0.
    await hBurst.send({ op: 'close', id: 'sh-b1' });

    // 3rd shell open at the same millisecond is refused by SPAWN_BRAKE with remedy without calling pty.spawn.
    await hBurst.send({
      op: 'open',
      id: 'sh-braked',
      provider: 'shell',
      command: 'shell',
      admission: { seq: 99 },
    });
    assert.equal(hBurst.getSpawnCalls(), 2);
    assert.deepEqual(hBurst.events.at(-1), {
      version: 1,
      generation: 1,
      ev: 'error',
      id: 'sh-braked',
      code: 'SPAWN_BRAKE',
      remedy: BROKER_REFUSAL_REMEDIES.SPAWN_BRAKE,
    });
    assert.deepEqual(hBurst.outcomes.at(-1), {
      admission: { seq: 99 },
      outcome: { event: 'refused', session: 'sh-braked', reason: 'SPAWN_BRAKE' },
    });

    // Meanwhile ai class has its own untouched spawn brake and opens immediately.
    await hBurst.send({ op: 'open', id: 'ai-b1', provider: 'provider-ai', command: 'provider' });
    assert.equal(hBurst.getSpawnCalls(), 3);

    // Advance clock by 1000 ms (refills 1 token for shell) -> shell open succeeds again.
    clockMs += 1000;
    await hBurst.send({ op: 'open', id: 'sh-refilled', provider: 'shell', command: 'shell' });
    assert.equal(hBurst.getSpawnCalls(), 4);
    assert.equal(
      hBurst.events.some((e) => e.ev === 'open' && e.id === 'sh-refilled'),
      true,
    );
  } finally {
    await hBurst.engine.dispose();
  }

  // 2. Consecutive spawn failures trip 60000 ms cooldown circuit breaker.
  let failClockMs = 50_000;
  let shouldFailSpawn = true;
  const hFail = createClassBrokerHarness({
    now: () => failClockMs,
    limits: {
      spawnBrakeBurst: 10,
      spawnBrakeRefillPerSec: 1,
      spawnBrakeMaxFailures: 3,
      spawnBrakeCooldownMs: 60000,
    },
    onSpawn: (_file, args) => ({
      // Only fail the ai provider; shell stays healthy.
      throwOnSpawn: shouldFailSpawn && args.length > 0,
    }),
  });
  try {
    for (let i = 1; i <= 3; i += 1) {
      await hFail.send({
        op: 'open',
        id: `ai-fail-${i}`,
        provider: 'provider-ai',
        command: 'provider',
      });
      assert.equal(hFail.events.at(-1)?.code, 'SPAWN_FAILED');
    }
    assert.equal(hFail.getSpawnCalls(), 3);

    // 4th ai attempt during cooldown is refused with SPAWN_BRAKE + remedy before calling pty.spawn.
    shouldFailSpawn = false;
    await hFail.send({
      op: 'open',
      id: 'ai-cooling',
      provider: 'provider-ai',
      command: 'provider',
    });
    assert.equal(hFail.getSpawnCalls(), 3);
    assert.equal(hFail.events.at(-1)?.code, 'SPAWN_BRAKE');
    assert.equal(hFail.events.at(-1)?.remedy, BROKER_REFUSAL_REMEDIES.SPAWN_BRAKE);

    // Shell class is unaffected by ai cooldown.
    await hFail.send({ op: 'open', id: 'sh-healthy', provider: 'shell', command: 'shell' });
    assert.equal(hFail.getSpawnCalls(), 4);
    assert.equal(hFail.events.at(-1)?.ev, 'open');

    // Advance past 60000 ms cooldown: ai spawn succeeds again and resets failure count.
    failClockMs += 60000;
    await hFail.send({
      op: 'open',
      id: 'ai-recovered',
      provider: 'provider-ai',
      command: 'provider',
    });
    assert.equal(hFail.getSpawnCalls(), 5);
    assert.equal(
      hFail.events.some((e) => e.ev === 'open' && e.id === 'ai-recovered'),
      true,
    );
  } finally {
    await hFail.engine.dispose();
  }

  // 3. registerTerminalIpc forwards refusal remedy to renderer event sink.
  /** @type {Array<Record<string, unknown>>} */
  const ipcPublished = [];
  /** @type {((msg: Record<string, unknown>) => void) | null} */
  let emitFromChild = null;
  const handlers = new Map();
  const bridge = registerTerminalIpc({
    ipcMain: {
      handle(channel, fn) {
        handlers.set(channel, fn);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    authenticate() {
      return { owner: 'capsule:test' };
    },
    authority: {
      async admit() {
        return { admitted: true, admission: { token: 't1' } };
      },
    },
    transport: {
      send() {},
      onMessage(fn) {
        emitFromChild = fn;
        return () => {
          emitFromChild = null;
        };
      },
    },
    providers: new Map([['shell', SHELL_PROFILE]]),
    plane: {
      open() {},
      attach() {
        return { frames: [] };
      },
      ingest(_ctx, frame) {
        return { session: 's1', seq: frame.seq, bytes: new Uint8Array(), byteLength: 0 };
      },
      acknowledge() {},
      close() {},
    },
    publish(event) {
      ipcPublished.push(event);
    },
  });
  try {
    assert.ok(emitFromChild);
    emitFromChild({
      version: TERMINAL_WIRE_VERSION,
      generation: 1,
      ev: 'error',
      id: 'sess-limit',
      code: 'CLASS_LIMIT',
      remedy: BROKER_REFUSAL_REMEDIES.CLASS_LIMIT,
    });
    assert.deepEqual(ipcPublished.at(-1), {
      kind: 'error',
      session: 'sess-limit',
      code: 'CLASS_LIMIT',
      remedy: BROKER_REFUSAL_REMEDIES.CLASS_LIMIT,
    });
    assert.equal(handlers.has(TERMINAL_CHANNELS.open), true);
  } finally {
    await bridge.dispose();
  }
});

/**
 * Oracles used by U3-7 against both the live ptyBroker module and real source-mutated copies.
 */
const BROKER_ORACLES = Object.freeze({
  /**
   * M1 oracle: shell-only and mixed configurations both enforce maxShellSessions = 4 [TARGET].
   * @param {typeof liveBrokerMod} mod
   */
  async M1_shellCapInAllConfigs(mod) {
    const hShellOnly = createClassBrokerHarness({
      runBrokerImpl: mod.runBroker,
      profiles: new Map([['shell', SHELL_PROFILE]]),
    });
    try {
      for (let i = 1; i <= 5; i += 1) {
        await hShellOnly.send({
          op: 'open',
          id: `m1-sh-${i}`,
          provider: 'shell',
          command: 'shell',
        });
      }
      const last = hShellOnly.events.at(-1);
      assert.equal(last?.ev, 'error');
      assert.equal(last?.code, 'CLASS_LIMIT');
    } finally {
      await hShellOnly.engine.dispose();
    }
  },

  /**
   * M2 oracle: shell and ai sessions enforce distinct per-class byte caps.
   * @param {typeof liveBrokerMod} mod
   */
  async M2_perClassByteCap(mod) {
    const h = createClassBrokerHarness({
      runBrokerImpl: mod.runBroker,
      limits: { shellSessionByteCap: 32, aiSessionByteCap: 128 },
    });
    try {
      await h.send({ op: 'open', id: 'm2-sh', provider: 'shell', command: 'shell' });
      await h.send({ op: 'open', id: 'm2-ai', provider: 'provider-ai', command: 'provider' });
      const shOpen = h.events.find((e) => e.ev === 'open' && e.id === 'm2-sh');
      const aiOpen = h.events.find((e) => e.ev === 'open' && e.id === 'm2-ai');
      const shHandle = h.handlesByPid.get(String(shOpen?.pid));
      const aiHandle = h.handlesByPid.get(String(aiOpen?.pid));
      shHandle?.emitData(Buffer.alloc(32, 0x78));
      aiHandle?.emitData(Buffer.alloc(32, 0x78));
      await tick();
      await tick();
      assert.equal(
        h.events.some((e) => e.ev === 'exit' && e.id === 'm2-sh' && e.reason === 'SESSION_CAP'),
        true,
      );
      assert.equal(
        h.events.some((e) => e.ev === 'exit' && e.id === 'm2-ai'),
        false,
      );
    } finally {
      await h.engine.dispose();
    }
  },

  /**
   * M3 oracle: staged close on runBroker sends SIGHUP -> wait(100) -> SIGTERM -> wait(250) -> SIGKILL.
   * @param {typeof liveBrokerMod} mod
   */
  async M3_stagedCloseSignalOrder(mod) {
    /** @type {Array<number>} */
    const waits = [];
    const h = createClassBrokerHarness({
      runBrokerImpl: mod.runBroker,
      sleep: async (ms) => {
        waits.push(ms);
      },
      onSpawn: () => ({ killBehavior: 'ignore' }),
    });
    try {
      await h.send({ op: 'open', id: 'm3-s1', provider: 'shell', command: 'shell' });
      const openEv = h.events.find((e) => e.ev === 'open' && e.id === 'm3-s1');
      const handle = h.handlesByPid.get(String(openEv?.pid));
      assert.ok(handle);
      await h.send({ op: 'close', id: 'm3-s1' });
      assert.deepEqual(handle.signals, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
      assert.deepEqual(waits, [100, 250]);
    } finally {
      await h.engine.dispose();
    }
  },

  /**
   * M4 oracle: per-class spawn brake in runBroker enforces burst cap and 3-failure cooldown.
   * @param {typeof liveBrokerMod} mod
   */
  async M4_spawnBrakeEnforcement(mod) {
    let clockMs = 1000;
    let failMode = false;
    const h = createClassBrokerHarness({
      runBrokerImpl: mod.runBroker,
      now: () => clockMs,
      limits: {
        spawnBrakeBurst: 2,
        spawnBrakeRefillPerSec: 1,
        spawnBrakeMaxFailures: 3,
        spawnBrakeCooldownMs: 60000,
      },
      onSpawn: (_file, args) => ({
        throwOnSpawn: failMode && args.length > 0,
      }),
    });
    try {
      await h.send({ op: 'open', id: 'm4-sh-1', provider: 'shell', command: 'shell' });
      await h.send({ op: 'open', id: 'm4-sh-2', provider: 'shell', command: 'shell' });
      await h.send({ op: 'close', id: 'm4-sh-1' });
      await h.send({ op: 'open', id: 'm4-sh-3', provider: 'shell', command: 'shell' });
      assert.equal(h.events.at(-1)?.code, 'SPAWN_BRAKE');

      clockMs += 10_000;
      failMode = true;
      for (let i = 1; i <= 3; i += 1) {
        clockMs += 1000;
        await h.send({
          op: 'open',
          id: `m4-ai-f${i}`,
          provider: 'provider-ai',
          command: 'provider',
        });
        assert.equal(h.events.at(-1)?.code, 'SPAWN_FAILED');
      }
      failMode = false;
      clockMs += 1000;
      await h.send({
        op: 'open',
        id: 'm4-ai-cooled',
        provider: 'provider-ai',
        command: 'provider',
      });
      assert.equal(h.events.at(-1)?.code, 'SPAWN_BRAKE');
    } finally {
      await h.engine.dispose();
    }
  },

  /**
   * M5 oracle: sessions in staged close remain counted as live until reaped.
   * @param {typeof liveBrokerMod} mod
   */
  async M5_closingCountedUntilReaped(mod) {
    /** @type {(() => void) | null} */
    let releaseWait = null;
    const h = createClassBrokerHarness({
      runBrokerImpl: mod.runBroker,
      onSpawn: () => ({ killBehavior: 'ignore' }),
      sleep: () =>
        new Promise((resolveWait) => {
          if (!releaseWait) {
            releaseWait = () => resolveWait(undefined);
          } else {
            resolveWait(undefined);
          }
        }),
    });
    try {
      for (let i = 1; i <= 4; i += 1) {
        await h.send({ op: 'open', id: `m5-sh-${i}`, provider: 'shell', command: 'shell' });
      }
      await h.send({ op: 'close', id: 'm5-sh-1' });
      await h.send({ op: 'open', id: 'm5-sh-5', provider: 'shell', command: 'shell' });
      assert.equal(h.events.at(-1)?.code, 'CLASS_LIMIT');
    } finally {
      releaseWait?.();
      await h.engine.dispose();
    }
  },

  /**
   * M6 oracle: CLASS_LIMIT and SPAWN_BRAKE refusal events carry non-empty remedies.
   * @param {typeof liveBrokerMod} mod
   */
  async M6_refusalRemediesPresent(mod) {
    const h = createClassBrokerHarness({
      runBrokerImpl: mod.runBroker,
      limits: { maxShellSessions: 1, spawnBrakeBurst: 1 },
    });
    try {
      await h.send({ op: 'open', id: 'm6-sh-1', provider: 'shell', command: 'shell' });
      await h.send({ op: 'open', id: 'm6-sh-2', provider: 'shell', command: 'shell' });
      const classRefusal = h.events.at(-1);
      assert.equal(classRefusal?.code, 'CLASS_LIMIT');
      assert.equal(classRefusal?.remedy, BROKER_REFUSAL_REMEDIES.CLASS_LIMIT);

      await h.send({ op: 'close', id: 'm6-sh-1' });
      await h.send({ op: 'open', id: 'm6-sh-3', provider: 'shell', command: 'shell' });
      const brakeRefusal = h.events.at(-1);
      assert.equal(brakeRefusal?.code, 'SPAWN_BRAKE');
      assert.equal(brakeRefusal?.remedy, BROKER_REFUSAL_REMEDIES.SPAWN_BRAKE);
    } finally {
      await h.engine.dispose();
    }
  },
});

test('U3-7: non-vacuous mutant verification suite mutates ptyBroker.js and proves each mutant fails its real broker oracle', async () => {
  // 1. Verify every oracle passes against the live unmutated ptyBroker module.
  await BROKER_ORACLES.M1_shellCapInAllConfigs(liveBrokerMod);
  await BROKER_ORACLES.M2_perClassByteCap(liveBrokerMod);
  await BROKER_ORACLES.M3_stagedCloseSignalOrder(liveBrokerMod);
  await BROKER_ORACLES.M4_spawnBrakeEnforcement(liveBrokerMod);
  await BROKER_ORACLES.M5_closingCountedUntilReaped(liveBrokerMod);
  await BROKER_ORACLES.M6_refusalRemediesPresent(liveBrokerMod);

  // 2. Materialize real code mutants of ptyBroker.js and prove each mutant fails its oracle.
  const originalSource = readFileSync(BROKER_SOURCE_PATH, 'utf8').replace(
    "from './coreLauncher.js'",
    `from ${JSON.stringify(CORE_LAUNCHER_URL)}`,
  );
  const mutantDir = mkdtempSync(join(tmpdir(), 'mv-u3-mutants-'));

  /**
   * @param {string} name
   * @param {string} targetSnippet
   * @param {string} mutatedSnippet
   * @returns {Promise<typeof liveBrokerMod>}
   */
  const loadMutatedBroker = async (name, targetSnippet, mutatedSnippet) => {
    assert.equal(
      originalSource.includes(targetSnippet),
      true,
      `mutant ${name} target snippet must exist in ptyBroker.js`,
    );
    const mutatedSource = originalSource.replace(targetSnippet, mutatedSnippet);
    assert.notEqual(mutatedSource, originalSource);
    const mutantFile = join(mutantDir, `${name}.mjs`);
    writeFileSync(mutantFile, mutatedSource, 'utf8');
    return /** @type {Promise<typeof liveBrokerMod>} */ (import(pathToFileURL(mutantFile).href));
  };

  try {
    // M1: mutate classLimit to use caps.maxSessions (8) for shell instead of caps.maxShellSessions (4).
    const m1Mod = await loadMutatedBroker(
      'M1_shell_cap_fallback',
      "sessionClass === 'shell' ? caps.maxShellSessions : caps.maxAiSessions",
      "sessionClass === 'shell' ? caps.maxSessions : caps.maxAiSessions",
    );
    await assert.rejects(
      () => BROKER_ORACLES.M1_shellCapInAllConfigs(m1Mod),
      /ERR_ASSERTION/,
    );

    // M2: mutate effectiveByteCap to apply shellSessionByteCap to both classes.
    const m2Mod = await loadMutatedBroker(
      'M2_shared_byte_cap',
      "sessionClass === 'shell' ? caps.shellSessionByteCap : caps.aiSessionByteCap",
      'caps.shellSessionByteCap',
    );
    await assert.rejects(
      () => BROKER_ORACLES.M2_perClassByteCap(m2Mod),
      /ERR_ASSERTION/,
    );

    // M3: mutate staged close to send SIGKILL first instead of SIGHUP -> SIGTERM -> SIGKILL.
    const m3Mod = await loadMutatedBroker(
      'M3_skip_sighup_staged_close',
      "session.handle.kill('SIGHUP');",
      "session.handle.kill('SIGKILL');",
    );
    await assert.rejects(
      () => BROKER_ORACLES.M3_stagedCloseSignalOrder(m3Mod),
      /ERR_ASSERTION/,
    );

    // M4a: mutate runBroker to bypass brake.consumeAttempt() check.
    const m4BurstMod = await loadMutatedBroker(
      'M4a_bypass_spawn_brake_burst',
      'if (!brake.consumeAttempt()) {',
      'if (false && !brake.consumeAttempt()) {',
    );
    await assert.rejects(
      () => BROKER_ORACLES.M4_spawnBrakeEnforcement(m4BurstMod),
      /ERR_ASSERTION/,
    );

    // M4b: mutate createSpawnBrake.recordFailure so consecutive failures never trip cooldown.
    const m4CooldownMod = await loadMutatedBroker(
      'M4b_disable_spawn_brake_cooldown',
      'if (failures >= maxFailures) {',
      'if (false && failures >= maxFailures) {',
    );
    await assert.rejects(
      () => BROKER_ORACLES.M4_spawnBrakeEnforcement(m4CooldownMod),
      /ERR_ASSERTION/,
    );

    // M5: mutate countLiveByClass to stop counting closing sessions before reapOwned completes.
    const m5Mod = await loadMutatedBroker(
      'M5_free_slot_while_closing',
      'if (!s.exited && s.sessionClass === sessionClass) count += 1;',
      'if (!s.exited && !s.closing && s.sessionClass === sessionClass) count += 1;',
    );
    await assert.rejects(
      () => BROKER_ORACLES.M5_closingCountedUntilReaped(m5Mod),
      /ERR_ASSERTION/,
    );

    // M6: mutate sendError to omit the refusal remedy field.
    const m6Mod = await loadMutatedBroker(
      'M6_omit_refusal_remedy',
      'const remedy = getBrokerRefusalRemedy(code);',
      'const remedy = null;',
    );
    await assert.rejects(
      () => BROKER_ORACLES.M6_refusalRemediesPresent(m6Mod),
      /ERR_ASSERTION/,
    );
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
});

test('U3-8: packaged-path broker loading resolves resources/build-native/pty-runtime/node-pty and enforces class caps and staged close via terminalHost', async () => {
  // Stage a disposable packaged bundle layout matching ui/tools/package.js stageElectronModules:
  //   <bundleRoot>/app/electron/{ptyBroker.js,coreLauncher.js,terminalHost.js,bytePlane.js}
  //   <bundleRoot>/resources/build-native/pty-runtime/node-pty -> local node-pty
  const bundleRoot = mkdtempSync(join(tmpdir(), 'mv-u3-packaged-'));
  const stagedElectronDir = join(bundleRoot, 'app', 'electron');
  const stagedResourcesDir = join(bundleRoot, 'resources');
  const stagedPtyRuntimeDir = join(stagedResourcesDir, 'build-native', 'pty-runtime');
  mkdirSync(stagedElectronDir, { recursive: true });
  mkdirSync(stagedPtyRuntimeDir, { recursive: true });

  for (const file of readdirSync(ELECTRON_DIR)) {
    if (file.endsWith('.js')) {
      copyFileSync(join(ELECTRON_DIR, file), join(stagedElectronDir, file));
    }
  }
  const realNodePtyDir = resolveNodePtyDir({});
  const packagedNodePtyDir = join(stagedPtyRuntimeDir, 'node-pty');
  symlinkSync(realNodePtyDir, packagedNodePtyDir, 'dir');

  try {
    const stagedBrokerMod = /** @type {typeof liveBrokerMod} */ (
      await import(pathToFileURL(join(stagedElectronDir, 'ptyBroker.js')).href)
    );
    const stagedHostMod = await import(
      pathToFileURL(join(stagedElectronDir, 'terminalHost.js')).href
    );

    // 1. Verify resolveNodePtyDir resolves the packaged build-native/pty-runtime/node-pty path
    // when METAVIEWER_NODE_PTY_DIR is unset and no sibling node-pty exists next to electron/.
    const resolvedPackagedPty = stagedBrokerMod.resolveNodePtyDir({}, stagedResourcesDir);
    assert.equal(resolvedPackagedPty, packagedNodePtyDir);

    // 2. Drive createTerminalHost (the exact main-process entry used by hostBindings.js in the packaged app)
    // using node-pty resolved from the packaged resources path.
    /** @type {Array<number>} */
    const spawnedPids = [];
    const host = stagedHostMod.createTerminalHost({
      pty: {
        spawn(file, args, opts) {
          const raw = spawnNodePty(file, [...args], opts);
          spawnedPids.push(raw.pid);
          return raw;
        },
      },
      cwd: '/tmp',
      shell: '/bin/sh',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        LANG: 'C',
        TERM: 'xterm-256color',
        METAVIEWER_NODE_PTY_DIR: resolvedPackagedPty,
      },
      attachDeadlineMs: 5000,
    });

    try {
      await host.setEnabled(true);
      /** @type {Array<{ session: string }>} */
      const opened = [];
      for (let i = 1; i <= 4; i += 1) {
        const res = await host.open({ command: 'shell', cols: 80, rows: 24 });
        assert.equal(typeof res.session, 'string');
        opened.push(res);
      }
      assert.equal(opened.length, 4);
      assert.equal(spawnedPids.length, 4);

      // 5th shell open through packaged terminalHost -> ptyBroker is refused by the 4-shell class cap.
      await assert.rejects(
        () => host.open({ command: 'shell', cols: 80, rows: 24 }),
        { message: 'TERMINAL_IO_REFUSED' },
      );

      // Closing the 1st shell runs staged close (SIGHUP -> SIGTERM -> SIGKILL), reaps the OS process,
      // and frees the class slot so a replacement shell opens cleanly.
      const first = opened[0];
      const firstPid = spawnedPids[0];
      await host.close({ session: first.session });
      const reapDeadline = Date.now() + 500;
      while (Date.now() < reapDeadline) {
        try {
          process.kill(firstPid, 0);
          await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
        } catch {
          break;
        }
      }
      assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' });

      const replacement = await host.open({ command: 'shell', cols: 80, rows: 24 });
      assert.equal(typeof replacement.session, 'string');
    } finally {
      await host.dispose();
    }
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});
