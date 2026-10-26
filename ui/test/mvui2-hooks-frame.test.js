// MV-5 bench frame-binding hook: fixture installs expose a callable
// __benchCaptureFrame binding captures to deterministic lane snapshot
// ids; live installs never expose it. Snapshot values stay untouched.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCH_FRAME_GLOBAL,
  installAgentLane,
  validateBenchFrameDescriptor,
  formatBenchSnapshotId,
  validateSnapshotShape,
} from '../src/agent/agentLane.js';

const DIGEST = '0123456789abcdef'.repeat(4);
const FRAME = Object.freeze({ raw_sha256: DIGEST, source_pin: 'mv-capture/2764800' });

/** @param {any[]} [nodes] */
function fakeRoot(nodes = []) {
  return { querySelectorAll: () => nodes };
}

/**
 * @param {() => void} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(/** @type {any} */ (error).code, code);
    return;
  }
  assert.fail(`expected throw with code ${code}`);
}

test('hook identities are frozen', () => {
  assert.equal(BENCH_FRAME_GLOBAL, '__benchCaptureFrame');
  assert.equal(formatBenchSnapshotId('four', 1), 'fixture:four:1');
  assert.equal(formatBenchSnapshotId('nested', 12), 'fixture:nested:12');
});

test('fixture install binds captures to the current lane snapshot id', async () => {
  const host = {};
  const uninstall = installAgentLane(host, { root: fakeRoot([]), screen: 'wall', fixture: 'four' });
  try {
    assert.equal(typeof host.__benchCaptureFrame, 'function');
    assert.equal(host.__agentLane.snapshot.constructor.name, 'AsyncFunction');
    const first = await host.__agentLane.snapshot();
    // The counting wrapper never leaks into snapshot values.
    assert.deepEqual(first.state, { source: 'dom', fixture: 'four', collected: 0, skipped: [] });
    assert.deepEqual(validateSnapshotShape(first), { ok: true });
    const binding = host.__benchCaptureFrame(FRAME);
    assert.deepEqual(binding, {
      snapshot: 'fixture:four:1',
      frame: { raw_sha256: DIGEST, source_pin: 'mv-capture/2764800' },
    });
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(binding.frame));
    // A second bind before the next snapshot keeps the current id.
    assert.equal(host.__benchCaptureFrame(FRAME).snapshot, 'fixture:four:1');
    const second = await host.__agentLane.snapshot();
    assert.deepEqual(second, first, 'snapshots stay deterministic');
    assert.equal(host.__benchCaptureFrame({ raw_sha256: DIGEST }).snapshot, 'fixture:four:2');
  } finally {
    uninstall();
  }
  assert.equal(host.__agentLane, undefined);
  assert.equal(host.__benchCaptureFrame, undefined);
});

describe('live installs never expose the hook', () => {
  for (const fixture of [undefined, null, '']) {
    test(`fixture ${String(fixture)} installs no hook`, async () => {
      const host = {};
      const uninstall = installAgentLane(host, { root: fakeRoot([]), screen: 'wall', fixture });
      try {
        assert.equal(BENCH_FRAME_GLOBAL in host, false);
        const snapshot = await host.__agentLane.snapshot();
        assert.deepEqual(validateSnapshotShape(snapshot), { ok: true });
      } finally {
        uninstall();
      }
      assert.equal(host.__agentLane, undefined);
    });
  }

  test('live uninstall leaves a foreign hook value untouched', () => {
    const foreign = { raw_sha256: 'foreign' };
    const host = { __benchCaptureFrame: foreign };
    const uninstall = installAgentLane(host, { root: fakeRoot([]) });
    uninstall();
    assert.equal(host.__agentLane, undefined);
    assert.equal(host.__benchCaptureFrame, foreign);
  });
});

describe('descriptor validation', () => {
  test('accepts the closed descriptor shapes', () => {
    assert.deepEqual(validateBenchFrameDescriptor(FRAME), {
      ok: true,
      frame: { raw_sha256: DIGEST, source_pin: 'mv-capture/2764800' },
    });
    assert.deepEqual(validateBenchFrameDescriptor({ raw_sha256: DIGEST }), {
      ok: true,
      frame: { raw_sha256: DIGEST, source_pin: null },
    });
    const validated = validateBenchFrameDescriptor(FRAME);
    assert.equal(validated.ok, true);
    if (validated.ok) assert.ok(Object.isFrozen(validated.frame));
  });

  test('refuses malformed descriptors without throwing', () => {
    const malformed = [
      null, undefined, 42, 'sha', [], {},
      { raw_sha256: 'abcdef' },
      { raw_sha256: 'g'.repeat(64) },
      { raw_sha256: DIGEST.toUpperCase() },
      { raw_sha256: `${DIGEST}00` },
      { raw_sha256: 123 },
      { source_pin: 'mv-capture/1' },
      { raw_sha256: DIGEST, extra: 1 },
      { raw_sha256: DIGEST, source_pin: '' },
      { raw_sha256: DIGEST, source_pin: 'x'.repeat(257) },
      { raw_sha256: DIGEST, source_pin: 7 },
    ];
    for (const value of malformed) {
      const result = validateBenchFrameDescriptor(value);
      assert.equal(result.ok, false, JSON.stringify(value)?.slice(0, 80));
      if (!result.ok) assert.equal(result.error.code, 'ERR_BENCH_FRAME_SHAPE');
      else assert.fail('malformed descriptor must refuse');
    }
  });

  test('the installed hook throws the typed shape error on malformed frames', async () => {
    const host = {};
    const uninstall = installAgentLane(host, { root: fakeRoot([]), fixture: 'one' });
    try {
      await host.__agentLane.snapshot();
      throwsCode(() => host.__benchCaptureFrame(null), 'ERR_BENCH_FRAME_SHAPE');
      throwsCode(() => host.__benchCaptureFrame({ raw_sha256: 'short' }), 'ERR_BENCH_FRAME_SHAPE');
      throwsCode(() => host.__benchCaptureFrame({ raw_sha256: DIGEST, extra: 1 }), 'ERR_BENCH_FRAME_SHAPE');
      throwsCode(() => host.__benchCaptureFrame(), 'ERR_BENCH_FRAME_SHAPE');
    } finally {
      uninstall();
    }
  });
});

test('binding before any snapshot refuses with a typed error', () => {
  const host = {};
  const uninstall = installAgentLane(host, { root: fakeRoot([]), fixture: 'one' });
  try {
    throwsCode(() => host.__benchCaptureFrame(FRAME), 'ERR_BENCH_FRAME_NO_SNAPSHOT');
  } finally {
    uninstall();
  }
});

test('a pre-occupied hook key refuses install atomically', () => {
  const foreign = { stale: true };
  const host = { __benchCaptureFrame: foreign };
  throwsCode(() => installAgentLane(host, { root: fakeRoot([]), fixture: 'four' }), 'ERR_BENCH_FRAME_MOUNTED');
  assert.equal(host.__agentLane, undefined, 'failed install leaves no lane');
  assert.equal(host.__benchCaptureFrame, foreign, 'failed install keeps the foreign value');
});

test('uninstall removes only its own hook', () => {
  const host = {};
  const uninstall = installAgentLane(host, { root: fakeRoot([]), fixture: 'four' });
  const foreign = { raw_sha256: 'bench-written' };
  host.__benchCaptureFrame = foreign;
  uninstall();
  assert.equal(host.__agentLane, undefined);
  assert.equal(host.__benchCaptureFrame, foreign);
});

test('double installation stays a typed error with the hook present', () => {
  const host = {};
  const uninstall = installAgentLane(host, { root: fakeRoot([]), fixture: 'four' });
  try {
    throwsCode(() => installAgentLane(host, { root: fakeRoot([]), fixture: 'four' }), 'ERR_AGENT_LANE_MOUNTED');
  } finally {
    uninstall();
  }
});
