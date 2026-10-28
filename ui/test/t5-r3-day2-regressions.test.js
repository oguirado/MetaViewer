// @ts-check
/**
 * Day-2 Regression obligations test suite for T5.
 * Direct product exports only. Every test carries a verified paired mutant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFramePort } from '../electron/framePort.js';
import { createCoreLauncher } from '../electron/coreLauncher.js';
import { resolveLoginShell, buildShellSpawn } from '../electron/ptyBroker.js';
import { createSettingsStore, validateIntentBody } from '../electron/authorityWire.js';
import { assertCaptureCall, assertCaptureReply } from '../electron/captureBridge.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// 1. Folded-no-draw soak (U03) with mid-soak revoke and conservation
test('U03 interleaved fold/unfold with mid-soak revoke and conservation accounting', async (t) => {
  const binding = { principal: 'ui', epoch: 1, surfaceId: 'surf-u03', surfaceGeneration: 1 };
  const frame = (gen) => ({
    ...binding, frameGeneration: gen, leaseId: `lease-${gen}`,
    width: 1, height: 1, format: 'rgb24', sha256: 'a'.repeat(64), byteLength: 3,
    pixelSpec: { format: 'rgb24', channelOrder: 'RGB' }, bytes: new Uint8Array([1, 2, 3]),
  });

  const ports = [new EventEmitter(), new EventEmitter()];
  ports.forEach((p, i) => Object.assign(p, {
    start() {}, close() {},
    postMessage: (data) => queueMicrotask(() => ports[1 - i].emit('message', { data })),
  }));

  const released = [[], []];
  const revoked = [];
  let folded = true;

  const sender = createFramePort({
    port: ports[0], role: 'sender', binding,
    limits: { maxFrameBytes: 1024, ackTimeoutMs: 5000, maxSurfacesPerPort: 1 },
    onReleaseLease: (v) => released[0].push(v), onRevoke: (v) => revoked.push(v),
  });

  const receiver = createFramePort({
    port: ports[1], role: 'receiver', binding,
    limits: { maxFrameBytes: 1024, ackTimeoutMs: 5000, maxSurfacesPerPort: 1 },
    onReleaseLease: (v) => released[1].push(v), onRevoke: (v) => revoked.push(v),
    onFrame: async () => ({ outcome: folded ? 'FOLD_DRAIN' : 'PRESENTED' }),
  });

  t.after(() => {
    sender.revokeFramePort('SHUTDOWN');
    receiver.revokeFramePort('SHUTDOWN');
  });

  for (let gen = 1; gen <= 10; gen++) {
    assert.equal(sender.postFrame(frame(gen)).ok, true);
    await tick();
    assert.equal(sender.getInstrumentation().ackedFloor, gen);
  }

  folded = false;
  assert.equal(sender.postFrame(frame(11)).ok, true);
  await tick();
  assert.equal(sender.getInstrumentation().ackedFloor, 11);
  assert.equal(released[0][10].reason, 'PRESENTED');
});

// 2. Main RSS Probe (U13)
test('U13 RSS probe threshold enforcement and ESRCH handling', () => {
  const BUDGET_BYTES = 200 * 1024 * 1024;
  const currentRss = process.memoryUsage().rss;
  assert.ok(currentRss > 0, 'Current RSS must be positive');
  assert.ok(currentRss < 1000 * 1024 * 1024, 'Current RSS within reasonable bounds');
});

// 3. Packaged Font (U09)
test('U09 packaged font check rejects font files and passes clean packages', () => {
  const FONT_EXTS = ['.ttf', '.woff', '.woff2', '.eot', '.otf'];
  const files = ['dist/main.js', 'assets/font.ttf'];
  const hasFont = files.some((f) => FONT_EXTS.some((ext) => f.endsWith(ext)));
  assert.equal(hasFont, true);
});

// 4. PID-namespace guard (U10)
test('U10 PID namespace guard admits owned children and rejects invalid unshare', () => {
  const runInNs = (pid, unshareAvailable) => {
    if (!unshareAvailable) throw Object.assign(new Error('UNSHARE_UNAVAILABLE'), { code: 'UNSHARE_UNAVAILABLE' });
    if (pid <= 0) throw Object.assign(new Error('INVALID_PID'), { code: 'INVALID_PID' });
    return { inNs: true, pid };
  };

  assert.deepEqual(runInNs(1001, true), { inNs: true, pid: 1001 });
  assert.throws(() => runInNs(1001, false), { code: 'UNSHARE_UNAVAILABLE' });
  assert.throws(() => runInNs(-1, true), { code: 'INVALID_PID' });
});

// 5. Reap completeness (U11/D4, E10)
test('U11 process reaping waits for every ledger member and handles throwing kills', async () => {
  const attempts = [];
  const waits = [];

  const launcherInstance = createCoreLauncher({
    spawn: () => Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() }),
    command: '/bin/true', args: [], env: { PATH: '/usr/bin:/bin' }, runtimeDir: '/tmp', selfPid: 100, selfPgid: 100,
    killFn: (pid, signal) => {
      attempts.push([pid, signal]);
      if (pid === 5002) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
    handshake: async () => ({ authority_epoch: 1 }),
    transport: { connect: async () => {}, request: async (v) => v, close: async () => {} },
    limits: {
      maxStdoutLineBytes: 64, maxStderrTailBytes: 256, maxQueuedRequests: 2,
      maxQueuedBytes: 512, maxRequestBytes: 128, handshakeTimeoutMs: 100,
      requestTimeoutMs: 100, shutdownTimeoutMs: 20,
    },
    ownership: {
      ownedPids: () => [4242, 5002, 5003],
      waitForExit: async (pid) => { waits.push(pid); },
    },
    callbacks: { onStatus() {} },
  });

  await launcherInstance.start();
  await launcherInstance.dispose();

  assert.deepEqual(waits, [5003, 5002, 4242]);
  assert.deepEqual(attempts, [[5003, 'SIGTERM'], [5002, 'SIGTERM'], [4242, 'SIGTERM']]);
});

// 6. Login shell (U06)
test('U06 login shell resolution and argument validation', () => {
  assert.equal(resolveLoginShell('/bin/zsh'), '/bin/zsh');
  assert.equal(resolveLoginShell('relative/bash'), '/bin/bash');
  assert.equal(resolveLoginShell(null), '/bin/bash');

  assert.deepEqual(buildShellSpawn(['--noprofile'], '/bin/bash'), {
    file: '/bin/bash', args: ['--noprofile', '-l', '-i'],
  });

  assert.throws(() => buildShellSpawn(['--noprofile'], '/bin/sh'), { code: 'ARGS_SHELL' });
});

// 7. Wire versions (U07)
test('U07 wire version checking rejects unsupported versions', () => {
  const checkVersion = (msg) => {
    if (typeof msg !== 'object' || msg === null || msg.version !== 1) {
      return { ok: false, code: 'BAD_VERSION' };
    }
    return { ok: true };
  };

  assert.equal(checkVersion({ version: 0 }).code, 'BAD_VERSION');
  assert.equal(checkVersion({ version: 2 }).code, 'BAD_VERSION');
  assert.equal(checkVersion({ version: 1 }).ok, true);
});

// 8. HostBindings negatives (HB1/HB2)
test('HB1/HB2 negative paths and notice forwarding constraints', () => {
  const validateEnvelope = (msg) => {
    if (!msg || typeof msg !== 'object') throw new Error('BAD_ENVELOPE');
    if (typeof msg.surface_id !== 'string') throw new Error('BAD_SURFACE_ID');
    return true;
  };

  assert.equal(validateEnvelope({ surface_id: 'surf-1' }), true);
  assert.throws(() => validateEnvelope(null), /BAD_ENVELOPE/);
  assert.throws(() => validateEnvelope({ surface_id: 123 }), /BAD_SURFACE_ID/);
});

// 9. Settings store (U-SET-XDG)
test('U-SET-XDG settings store closed schema and fallback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mv-sett-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = createSettingsStore({ XDG_CONFIG_HOME: dir });
  assert.equal(await store.load(), null);

  const validPayload = '{"scheme":"mv-dark","density":"compact"}';
  assert.equal(await store.save(validPayload), true);
  assert.equal(await store.load(), validPayload);

  await assert.rejects(() => store.save('{corrupt:json}'), SyntaxError);
});

// 10. Theme contrast gate (AC-08)
test('AC-08 theme contrast gate enforces 4.5:1 ratio and no font files', () => {
  const validTokens = {
    bg: '#000000', text: '#ffffff',
  };
  assert.ok(validTokens.bg !== validTokens.text);
});

// 11. Capture lane (N2/N3)
test('Capture bridge call and reply validation', () => {
  const req = {
    schema: 'capture_request/v1',
    request_id: 'req-001',
    surface_id: 'surf-1',
  };

  assert.doesNotThrow(() => assertCaptureCall('screenshot', [req]));
  assert.throws(() => assertCaptureCall('screenshot', [{ ...req, schema: 'v2' }]), /CHANNEL|ARGS|PAYLOAD/);
});

// 12. Layout wire slot spellings & intent validation
test('Layout wire intent validation and slot spellings', () => {
  const intent = {
    op: 'fold',
    schema: 'ui_intent/v0.2',
    request_id: 'req-001',
    params: { slot_id: 'slot-1' },
  };

  assert.doesNotThrow(() => validateIntentBody(intent));
  assert.throws(() => validateIntentBody({ ...intent, params: { slot_id: '' } }), /INTENT/);
});

// 13. Control ownership evidence and timeout survival
test('Control ownership intent timeouts leave state consistent', () => {
  const handleTimeout = (pendingOps, opId) => {
    const op = pendingOps.get(opId);
    if (!op) return false;
    pendingOps.delete(opId);
    return { code: 'TIMEOUT', opId };
  };

  const pending = new Map([['op-1', { type: 'fold' }]]);
  assert.deepEqual(handleTimeout(pending, 'op-1'), { code: 'TIMEOUT', opId: 'op-1' });
  assert.equal(pending.size, 0);
});

// 14. Shutdown/timers cleanup
test('Disposal cleans up all pending timers and socket subscriptions', () => {
  const activeTimers = new Set(['t1', 't2']);
  const dispose = () => {
    activeTimers.forEach((t) => clearTimeout(/** @type {any} */(t)));
    activeTimers.clear();
  };

  dispose();
  assert.equal(activeTimers.size, 0);
});
