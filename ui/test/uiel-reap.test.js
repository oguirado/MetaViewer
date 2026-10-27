import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCoreLauncher } from '../electron/coreLauncher.js';

function launcher(t, { preExited = false, stalled = false, allThrow = false } = {}) {
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const attempts = [], signalled = [], waits = [], killed = new Set();
  const instance = createCoreLauncher({ spawn: () => child, command: '/fixture/metaviewer-core', args: [],
    env: { PATH: '/usr/bin:/bin' }, runtimeDir: '/fixture/runtime', selfPid: 100, selfPgid: 100,
    killFn(pid, signal) {
      attempts.push([pid, signal]);
      if (allThrow || (preExited && pid === 5002)) throw Object.assign(new Error('already gone'), { code: 'ESRCH' });
      signalled.push([pid, signal]);
      if (signal === 'SIGKILL') killed.add(pid);
    },
    handshake: async () => ({ authority_epoch: 7 }),
    transport: { connect: async () => {}, request: async value => value, close: async () => {} },
    limits: { maxStdoutLineBytes: 64, maxStderrTailBytes: 256, maxQueuedRequests: 2,
      maxQueuedBytes: 512, maxRequestBytes: 128, handshakeTimeoutMs: 100,
      requestTimeoutMs: 100, shutdownTimeoutMs: 20 },
    ownership: { ownedPids: () => [4242, 5002, 5003], async waitForExit(pid) {
      waits.push(pid);
      if (stalled && pid === 5003 && !killed.has(pid)) throw new Error('not exited yet');
    } }, callbacks: { onStatus() {} },
  });
  t.after(() => instance.dispose());
  return { instance, attempts, signalled, waits };
}

// Mutation: omit signalled.push(target) in stopChild's killFn catch branch.
test('U11 reaping waits for a pre-exited middle pid after TERM throws and escalates only the stalled pid', async t => {
  const f = launcher(t, { preExited: true, stalled: true });
  assert.equal((await f.instance.start()).availability, 'live');
  await f.instance.dispose();
  assert.deepEqual(f.attempts, [[5003, 'SIGTERM'], [5002, 'SIGTERM'], [4242, 'SIGTERM'], [5003, 'SIGKILL']]);
  assert.deepEqual(f.waits, [5003, 5003, 5002, 4242]);
  assert.deepEqual(f.signalled, [[5003, 'SIGTERM'], [4242, 'SIGTERM'], [5003, 'SIGKILL']]);
  for (const [pid, signal] of f.attempts) {
    assert.ok([4242, 5002, 5003].includes(pid), 'unrecorded pids must never be signalled');
    if (signal === 'SIGKILL') assert.ok(f.attempts.findIndex(([p, s]) => p === pid && s === 'SIGTERM')
      < f.attempts.findIndex(([p, s]) => p === pid && s === 'SIGKILL'));
  }
  await f.instance.dispose();
  assert.equal(f.attempts.length, 4);
  assert.equal(f.instance.getStatus().availability, 'unavailable');
});

// Mutation: send SIGKILL after every successful waitForExit.
test('U11 negative control: promptly exited ledger members receive TERM only', async t => {
  const f = launcher(t);
  await f.instance.start(); await f.instance.dispose(); await f.instance.dispose();
  assert.deepEqual(f.attempts, [[5003, 'SIGTERM'], [5002, 'SIGTERM'], [4242, 'SIGTERM']]);
  assert.deepEqual(f.waits, [5003, 5002, 4242]);
});

// Mutation: abort stopChild on the first throwing killFn.
// D4 adaptation: distinguish attempted signals from successfully delivered signals.
test('U11/D4 throwing kills deliver zero signals but still wait for every ledger member', async t => {
  const f = launcher(t, { allThrow: true });
  await f.instance.start(); await f.instance.dispose();
  assert.deepEqual(f.attempts, [[5003, 'SIGTERM'], [5002, 'SIGTERM'], [4242, 'SIGTERM']]);
  assert.deepEqual(f.signalled, []);
  assert.deepEqual(f.waits, [5003, 5002, 4242]);
  assert.equal(f.instance.getStatus().availability, 'unavailable');
});
