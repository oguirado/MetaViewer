/**
 * Tests for the frame delivery port (`ui/electron/framePort.js`).
 *
 * Runs under the repository `node --test` gate with fake brokered ports,
 * timers and leases only; no Electron runtime is loaded. Each behaviour
 * pairs a positive witness with a negative control that must fail: stale
 * or cross-tile input is refused before the wire (zero fake postMessage
 * calls) and inline mutant fixtures fail the same bounded-send,
 * newest-only and exactly-once assertions as a broken implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACK_OUTCOMES,
  FRAME_ACK_SCHEMA,
  FRAME_DELIVERY_SCHEMA,
  FRAME_REASONS,
  FramePortError,
  PORT_REVOKE_REASONS,
  createFramePort,
} from '../electron/framePort.js';

/** Non-null fixed digest witness (64 lowercase hex). */
const DIGEST = 'ab'.repeat(32);
/** Second fixed digest witness. */
const DIGEST_B = 'cd'.repeat(32);

/**
 * @param {Record<string, unknown>} [over]
 * @returns {{ principal: string, epoch: number, surfaceId: string, surfaceGeneration: number }}
 */
function makeBinding(over = {}) {
  return {
    principal: 'mv-utility',
    epoch: 7,
    surfaceId: 'capsule-A',
    surfaceGeneration: 3,
    ...over,
  };
}

/**
 * @param {Record<string, unknown>} [over]
 * @returns {{ maxFrameBytes: number, ackTimeoutMs: number, maxSurfacesPerPort: number }}
 */
function makeLimits(over = {}) {
  return { maxFrameBytes: 1024 * 1024, ackTimeoutMs: 50, maxSurfacesPerPort: 4, ...over };
}

/**
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>} Valid VerifiedFrame-shaped fixture (4x4 rgb24).
 */
function makeFrame(over = {}) {
  const bytes = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (i * 7 + 3) % 251;
  }
  return {
    principal: 'mv-utility',
    epoch: 7,
    surfaceId: 'capsule-A',
    surfaceGeneration: 3,
    frameGeneration: 1,
    leaseId: 'lease-1',
    width: 4,
    height: 4,
    format: 'rgb24',
    sha256: DIGEST,
    byteLength: bytes.byteLength,
    pixelSpec: { format: 'rgb24', channelOrder: 'RGB' },
    bytes,
    ...over,
  };
}

/**
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>} Valid ACK-shaped fixture.
 */
function makeAck(over = {}) {
  return {
    kind: 'ack',
    correlation: 'capsule-A#1#lease-1',
    principal: 'mv-utility',
    epoch: 7,
    surfaceId: 'capsule-A',
    surfaceGeneration: 3,
    frameGeneration: 1,
    leaseId: 'lease-1',
    outcome: 'PRESENTED',
    ...over,
  };
}

/**
 * Fake brokered port mirroring the MessagePortMain surface (on/off/close/
 * postMessage/start) with Electron-style `{ data }` message events.
 *
 * @returns {Record<string, any>} Fake port plus spies.
 */
function makeFakePort() {
  /** @type {Array<unknown>} */
  const sent = [];
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map([
    ['message', new Set()],
    ['close', new Set()],
  ]);
  const fake = {
    sent,
    starts: 0,
    closes: 0,
    /** @param {unknown} message */
    postMessage(message) {
      sent.push(message);
    },
    start() {
      fake.starts += 1;
    },
    close() {
      fake.closes += 1;
    },
    /**
     * @param {string} event
     * @param {Function} listener
     */
    on(event, listener) {
      listeners.get(event)?.add(listener);
      return fake;
    },
    /**
     * @param {string} event
     * @param {Function} listener
     */
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return fake;
    },
    /**
     * @param {unknown} data Electron-style payload.
     */
    emitMessage(data) {
      for (const listener of [...(listeners.get('message') ?? [])]) {
        listener({ data });
      }
    },
    emitClose() {
      for (const listener of [...(listeners.get('close') ?? [])]) {
        listener();
      }
    },
    /** @param {string} event */
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
  return fake;
}

/**
 * Deterministic timer pair recording every arm and clear.
 *
 * @returns {Record<string, any>} Timer fns plus spies and manual fire.
 */
function makeTimers() {
  let nextId = 1;
  /** @type {Map<number, { callback: () => void, ms: number }>} */
  const armed = new Map();
  /** @type {Array<number>} */
  const cleared = [];
  return {
    armed,
    cleared,
    /**
     * @param {() => void} callback
     * @param {number} ms
     */
    setTimer(callback, ms) {
      const id = nextId;
      nextId += 1;
      armed.set(id, { callback, ms });
      return id;
    },
    /** @param {unknown} handle */
    clearTimer(handle) {
      cleared.push(/** @type {number} */ (handle));
      armed.delete(/** @type {number} */ (handle));
    },
    fireFirst() {
      const first = [...armed.entries()].sort((a, b) => a[0] - b[0])[0];
      assert.ok(first, 'expected an armed timer');
      armed.delete(first[0]);
      first[1].callback();
    },
    pendingCount() {
      return armed.size;
    },
  };
}

/**
 * @returns {Record<string, any>} Owner callback sinks plus spies.
 */
function makeSinks() {
  /** @type {Array<Record<string, any>>} */
  const releases = [];
  /** @type {Array<Record<string, any>>} */
  const revokes = [];
  return {
    releases,
    revokes,
    /** @param {Record<string, any>} release */
    onReleaseLease(release) {
      releases.push(release);
    },
    /** @param {Record<string, any>} notice */
    onRevoke(notice) {
      revokes.push(notice);
    },
  };
}

/**
 * @param {Record<string, any>} [over] Option overrides.
 * @returns {{ port: any, endpoint: any, timers: any, sinks: any }}
 */
function makeSender(over = {}) {
  const fake = makeFakePort();
  const timers = makeTimers();
  const sinks = makeSinks();
  const endpoint = createFramePort({
    port: fake,
    role: 'sender',
    binding: makeBinding(),
    limits: makeLimits(),
    onReleaseLease: sinks.onReleaseLease,
    onRevoke: sinks.onRevoke,
    clock: () => 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...over,
  });
  return { port: fake, endpoint, timers, sinks };
}

/**
 * @param {Record<string, any>} [over] Option overrides.
 * @param {(frame: any) => unknown} [onFrame] Receiver consumer.
 * @returns {{ port: any, endpoint: any, timers: any, sinks: any, consumed: Array<any> }}
 */
function makeReceiver(over = {}, onFrame) {
  const fake = makeFakePort();
  const timers = makeTimers();
  const sinks = makeSinks();
  /** @type {Array<any>} */
  const consumed = [];
  const endpoint = createFramePort({
    port: fake,
    role: 'receiver',
    binding: makeBinding(),
    limits: makeLimits(),
    onReleaseLease: sinks.onReleaseLease,
    onRevoke: sinks.onRevoke,
    onFrame:
      onFrame ??
      (async (frame) => {
        consumed.push(frame);
        return { outcome: 'PRESENTED' };
      }),
    clock: () => 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...over,
  });
  return { port: fake, endpoint, timers, sinks, consumed };
}

/** Microtask drain for the receiver consume chain. */
async function drain() {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe('framePort factory', () => {
  it('binds a frozen sender endpoint and starts the port', () => {
    const { port, endpoint } = makeSender();
    assert.equal(port.starts, 1);
    assert.equal(port.listenerCount('message'), 1);
    assert.equal(port.listenerCount('close'), 1);
    assert.ok(Object.isFrozen(endpoint));
    assert.deepEqual(Object.keys(endpoint).sort(), [
      'acceptAck',
      'getInstrumentation',
      'postFrame',
      'revokeFramePort',
    ]);
    const info = endpoint.getInstrumentation();
    assert.ok(Object.isFrozen(info));
    assert.equal(info.role, 'sender');
    assert.equal(info.revoked, false);
    assert.equal(info.createdAtMs, 1000);
  });

  it('rejects invalid wiring with stable codes', () => {
    const fake = makeFakePort();
    const sinks = makeSinks();
    const base = {
      port: fake,
      role: 'sender',
      binding: makeBinding(),
      limits: makeLimits(),
      onReleaseLease: sinks.onReleaseLease,
      onRevoke: sinks.onRevoke,
    };
    const cases = [
      [{ ...base, port: {} }, /INVALID_CONTRACT/],
      [{ ...base, role: 'broker' }, /INVALID_BINDING/],
      [{ ...base, binding: makeBinding({ epoch: 0 }) }, /INVALID_BINDING/],
      [{ ...base, binding: makeBinding({ surfaceId: '' }) }, /INVALID_BINDING/],
      [{ ...base, limits: makeLimits({ maxFrameBytes: 0 }) }, /INVALID_BUDGET/],
      [{ ...base, limits: makeLimits({ ackTimeoutMs: -1 }) }, /INVALID_BUDGET/],
      [{ ...base, onReleaseLease: undefined }, /INVALID_CONTRACT/],
      [{ ...base, onRevoke: undefined }, /INVALID_CONTRACT/],
      [{ ...base, onFrame: async () => ({}) }, /INVALID_CONTRACT/],
      [{ ...base, role: 'receiver' }, /INVALID_CONTRACT/],
    ];
    for (const [options, pattern] of cases) {
      assert.throws(() => createFramePort(options), pattern);
    }
    // A receiver with onFrame is valid wiring.
    const receiver = createFramePort({
      ...base,
      role: 'receiver',
      onFrame: async () => ({ outcome: 'PRESENTED' }),
    });
    assert.equal(receiver.getInstrumentation().role, 'receiver');
    receiver.revokeFramePort();
    try {
      createFramePort({ ...base, role: 'nope' });
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof FramePortError);
      assert.equal(/** @type {FramePortError} */ (error).code, 'INVALID_BINDING');
    }
  });

  it('exposes the exact frozen vocabularies', () => {
    assert.ok(Object.isFrozen(FRAME_REASONS));
    assert.deepEqual(Object.keys(FRAME_REASONS).sort(), [
      'CLOSED',
      'DIGEST_MISMATCH',
      'INVALID_BINDING',
      'INVALID_BUDGET',
      'INVALID_CONTRACT',
      'INVALID_GENERATION',
      'INVALID_PATH',
      'IO_ERROR',
      'LEASE_INVALID',
      'NULL_DIGEST',
      'PORT_REVOKED',
      'SIZE_MISMATCH',
      'STALE_EPOCH',
      'STALE_FRAME_GENERATION',
      'STALE_SURFACE_GENERATION',
      'SURFACE_MISMATCH',
      'TIMEOUT',
      'UNPUBLISHED',
    ]);
    assert.ok(Object.isFrozen(ACK_OUTCOMES));
    assert.deepEqual(Object.keys(ACK_OUTCOMES).sort(), [
      'CONTEXT_LOST',
      'FOLD_DRAIN',
      'HIDDEN',
      'PRESENTED',
      'REFUSED',
      'SUPERSEDED',
      'SURFACE_DESTROYED',
    ]);
    assert.ok(Object.isFrozen(PORT_REVOKE_REASONS));
    assert.deepEqual(Object.keys(PORT_REVOKE_REASONS).sort(), [
      'ENDPOINT_RESTART',
      'PORT_REVOKED',
      'SHUTDOWN',
      'TIMEOUT',
    ]);
  });

  it('rejects a revoke reason outside the vocabulary', () => {
    const { endpoint } = makeSender();
    assert.throws(() => endpoint.revokeFramePort('BOGUS'), /INVALID_CONTRACT/);
    assert.equal(endpoint.getInstrumentation().revoked, false);
  });
});

describe('sender mailbox: bounded sends, newest pending', () => {
  it('posts gen1 at once, supersedes gen2 with gen3, sends gen3 after the ACK', () => {
    const { port, endpoint, timers, sinks } = makeSender();
    const first = endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    assert.deepEqual(first, { ok: true, sent: true, frameGeneration: 1, leaseId: 'lease-1' });
    assert.equal(port.sent.length, 1);
    assert.equal(timers.pendingCount(), 1);

    const second = endpoint.postFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }));
    assert.equal(second.ok, true);
    assert.equal(second.sent, false);
    assert.equal(second.queued, true);
    const third = endpoint.postFrame(makeFrame({ frameGeneration: 3, leaseId: 'lease-3' }));
    assert.equal(third.ok, true);
    assert.equal(third.superseded, 2);
    // A per-arrival mutant would have posted 3 bulk frames; newest-only posts 1.
    assert.equal(port.sent.length, 1);
    assert.equal(timers.pendingCount(), 1);
    assert.equal(sinks.releases.length, 1);
    assert.deepEqual(sinks.releases[0], {
      principal: 'mv-utility',
      epoch: 7,
      surfaceId: 'capsule-A',
      surfaceGeneration: 3,
      frameGeneration: 2,
      leaseId: 'lease-2',
      reason: 'SUPERSEDED',
    });

    const acked = endpoint.acceptAck(makeAck({ outcome: 'PRESENTED' }));
    assert.deepEqual(acked, { ok: true, acked: 1, promoted: 3 });
    assert.equal(port.sent.length, 2);
    const posted = port.sent.map((message) => message.frameGeneration);
    assert.deepEqual(posted, [1, 3]);
    // Gen2 never crossed the wire: zero backlog.
    const delivery = port.sent[1];
    assert.equal(delivery.schema, FRAME_DELIVERY_SCHEMA);
    assert.equal(delivery.kind, 'frame');
    assert.equal(delivery.correlation, 'capsule-A#3#lease-3');
    assert.ok(delivery.bytes instanceof Uint8Array);
    assert.equal(delivery.byteLength, delivery.bytes.byteLength);
    const done = endpoint.acceptAck(
      makeAck({ frameGeneration: 3, leaseId: 'lease-3', correlation: 'capsule-A#3#lease-3' }),
    );
    assert.deepEqual(done, { ok: true, acked: 3, promoted: null });
    assert.equal(timers.pendingCount(), 0);
    const info = endpoint.getInstrumentation();
    assert.equal(info.sent, 2);
    assert.equal(info.acked, 2);
    assert.equal(info.superseded, 1);
    assert.equal(info.inFlightGeneration, null);
    assert.equal(info.pendingGeneration, null);
  });

  it('refuses stale generations without moving the floor', () => {
    const { port, endpoint } = makeSender();
    assert.equal(endpoint.postFrame(makeFrame({ frameGeneration: 3 })).ok, true);
    for (const generation of [3, 2, 1]) {
      const result = endpoint.postFrame(makeFrame({ frameGeneration: generation }));
      assert.equal(result.ok, false);
      assert.equal(result.reason, FRAME_REASONS.STALE_FRAME_GENERATION);
    }
    assert.equal(port.sent.length, 1);
    assert.equal(endpoint.postFrame(makeFrame({ frameGeneration: 4 })).ok, true);
    assert.equal(endpoint.getInstrumentation().acceptedFloor, 4);
  });

  it('refuses malformed generations and shapes before the wire', () => {
    const { port, endpoint } = makeSender();
    const refusals = [
      [makeFrame({ frameGeneration: 0 }), 'INVALID_GENERATION'],
      [makeFrame({ frameGeneration: 1.5 }), 'INVALID_GENERATION'],
      [makeFrame({ frameGeneration: '1' }), 'INVALID_GENERATION'],
      [makeFrame({ leaseId: '' }), 'LEASE_INVALID'],
      [makeFrame({ format: 'png' }), 'INVALID_CONTRACT'],
      [makeFrame({ bytes: [1, 2, 3] }), 'INVALID_CONTRACT'],
      [makeFrame({ byteLength: 4 }), 'SIZE_MISMATCH'],
      [makeFrame({ width: 8 }), 'SIZE_MISMATCH'],
      [makeFrame({ sha256: 'xyz' }), 'INVALID_CONTRACT'],
      [makeFrame({ sha256: '0'.repeat(64) }), 'NULL_DIGEST'],
      [makeFrame({ pixelSpec: null }), 'INVALID_CONTRACT'],
    ];
    for (const [frame, reason] of refusals) {
      const result = endpoint.postFrame(frame);
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
    }
    const oversize = makeFrame({ width: 1024, height: 1024 });
    oversize.bytes = new Uint8Array(1024 * 1024 * 3);
    oversize.byteLength = oversize.bytes.byteLength;
    const capped = endpoint.postFrame(oversize);
    assert.equal(capped.ok, false);
    assert.equal(capped.reason, 'SIZE_MISMATCH');
    assert.equal(port.sent.length, 0);
    assert.equal(endpoint.getInstrumentation().acceptedFloor, 0);
  });
});

describe('sender identity: epoch, tile and lifetime', () => {
  it('refuses foreign epoch, tile and lifetime without touching the wire', () => {
    const { port, endpoint } = makeSender();
    const cases = [
      [makeFrame({ epoch: 8 }), 'STALE_EPOCH'],
      [makeFrame({ principal: 'mv-other' }), 'SURFACE_MISMATCH'],
      [makeFrame({ surfaceId: 'capsule-B' }), 'SURFACE_MISMATCH'],
      [makeFrame({ surfaceGeneration: 2 }), 'STALE_SURFACE_GENERATION'],
      [makeFrame({ surfaceGeneration: 4 }), 'INVALID_BINDING'],
      [makeFrame({ epoch: '7' }), 'INVALID_CONTRACT'],
    ];
    for (const [frame, reason] of cases) {
      const result = endpoint.postFrame(frame);
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
    }
    assert.equal(port.sent.length, 0);
    assert.equal(endpoint.getInstrumentation().refused, cases.length);
  });

  it('AC-02 control: a frame for capsule-A never routes through the capsule-B port', () => {
    const { port, endpoint, sinks } = makeSender({ binding: makeBinding({ surfaceId: 'capsule-B' }) });
    const result = endpoint.postFrame(makeFrame({ surfaceId: 'capsule-A', frameGeneration: 1 }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, FRAME_REASONS.SURFACE_MISMATCH);
    assert.equal(port.sent.length, 0);
    assert.equal(sinks.releases.length, 0);
    assert.equal(endpoint.getInstrumentation().acceptedFloor, 0);
  });
});

describe('sender ACKs: exact match, idempotent replay, wrong ACKs refused', () => {
  it('replays duplicates idempotently without double release', () => {
    const { endpoint, sinks } = makeSender();
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    assert.deepEqual(endpoint.acceptAck(makeAck()), { ok: true, acked: 1, promoted: null });
    assert.equal(sinks.releases.length, 1);
    for (let i = 0; i < 3; i += 1) {
      const replay = endpoint.acceptAck(makeAck());
      assert.deepEqual(replay, { ok: true, duplicate: true });
    }
    assert.equal(sinks.releases.length, 1);
    assert.equal(endpoint.getInstrumentation().acked, 1);
  });

  it('refuses wrong-lease, wrong-correlation and unsent-generation ACKs; in-flight survives', () => {
    const { endpoint, sinks } = makeSender();
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    endpoint.postFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }));
    const wrong = [
      makeAck({ leaseId: 'lease-9' }),
      makeAck({ correlation: 'capsule-A#1#lease-9' }),
      makeAck({ frameGeneration: 2, leaseId: 'lease-2', correlation: 'capsule-A#2#lease-2' }),
      makeAck({ frameGeneration: 9, leaseId: 'lease-9', correlation: 'capsule-A#9#lease-9' }),
    ];
    for (const ack of wrong) {
      const result = endpoint.acceptAck(ack);
      assert.equal(result.ok, false);
      assert.equal(result.reason, FRAME_REASONS.LEASE_INVALID);
    }
    assert.equal(sinks.releases.length, 0);
    assert.equal(endpoint.getInstrumentation().inFlightGeneration, 1);
    assert.equal(endpoint.getInstrumentation().pendingGeneration, 2);
    const good = endpoint.acceptAck(makeAck());
    assert.deepEqual(good, { ok: true, acked: 1, promoted: 2 });
  });

  it('refuses malformed and foreign ACKs before state', () => {
    const { endpoint } = makeSender();
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    const cases = [
      [makeAck({ kind: 'frame' }), 'INVALID_CONTRACT'],
      [makeAck({ outcome: 'VANISHED' }), 'INVALID_CONTRACT'],
      [makeAck({ outcome: undefined }), 'INVALID_CONTRACT'],
      [makeAck({ frameGeneration: 0 }), 'INVALID_GENERATION'],
      [makeAck({ leaseId: '' }), 'LEASE_INVALID'],
      [makeAck({ correlation: 42 }), 'INVALID_CONTRACT'],
      [makeAck({ epoch: 8 }), 'STALE_EPOCH'],
      [makeAck({ surfaceId: 'capsule-B' }), 'SURFACE_MISMATCH'],
      [makeAck({ principal: 'mv-other' }), 'SURFACE_MISMATCH'],
      [makeAck({ surfaceGeneration: 1 }), 'STALE_SURFACE_GENERATION'],
    ];
    for (const [ack, reason] of cases) {
      const result = endpoint.acceptAck(ack);
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
    }
    assert.equal(endpoint.getInstrumentation().inFlightGeneration, 1);
  });

  it('accepts wire ACKs arriving as port messages', () => {
    const { port, endpoint } = makeSender();
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    port.emitMessage({ schema: FRAME_ACK_SCHEMA, ...makeAck() });
    const info = endpoint.getInstrumentation();
    assert.equal(info.acked, 1);
    assert.equal(info.inFlightGeneration, null);
  });

  it('ignores non-ACK arrivals on the sender port', () => {
    const { port, endpoint } = makeSender();
    port.emitMessage({ kind: 'frame', ...makeFrame() });
    port.emitMessage(null);
    port.emitMessage({ nope: true });
    assert.equal(endpoint.getInstrumentation().refused, 3);
    assert.equal(endpoint.getInstrumentation().acceptedFloor, 0);
  });
});

describe('sender timeout and revocation', () => {
  it('revokes on ACK timeout, releasing holdings exactly once', () => {
    const { port, endpoint, timers, sinks } = makeSender();
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    endpoint.postFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }));
    assert.equal(timers.pendingCount(), 1);
    timers.fireFirst();
    const info = endpoint.getInstrumentation();
    assert.equal(info.revoked, true);
    assert.equal(info.revokeReason, 'TIMEOUT');
    assert.equal(info.revokedAtMs, 1000);
    assert.equal(info.timeouts, 1);
    assert.equal(info.inFlightGeneration, null);
    assert.equal(info.pendingGeneration, null);
    assert.equal(port.closes, 1);
    assert.equal(timers.pendingCount(), 0);
    assert.deepEqual(
      sinks.releases.map((release) => [release.frameGeneration, release.reason]),
      [
        [1, 'TIMEOUT'],
        [2, 'TIMEOUT'],
      ],
    );
    assert.equal(sinks.revokes.length, 1);
    assert.deepEqual(sinks.revokes[0], { binding: makeBinding(), reason: 'TIMEOUT' });
    const late = endpoint.postFrame(makeFrame({ frameGeneration: 3 }));
    assert.equal(late.ok, false);
    assert.equal(late.reason, FRAME_REASONS.PORT_REVOKED);
    const lateAck = endpoint.acceptAck(makeAck());
    assert.equal(lateAck.ok, false);
    assert.equal(lateAck.reason, FRAME_REASONS.PORT_REVOKED);
  });

  it('ignores a stale timer fire after the ACK cleared the slot', () => {
    const { endpoint, timers } = makeSender();
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    endpoint.acceptAck(makeAck());
    assert.equal(timers.pendingCount(), 0);
    assert.equal(endpoint.getInstrumentation().revoked, false);
  });

  it('revokeFramePort is idempotent and detaches everything', () => {
    const { port, endpoint, timers, sinks } = makeSender();
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    endpoint.postFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }));
    endpoint.revokeFramePort();
    endpoint.revokeFramePort('SHUTDOWN');
    assert.equal(port.closes, 1);
    assert.equal(port.listenerCount('message'), 0);
    assert.equal(port.listenerCount('close'), 0);
    assert.equal(timers.pendingCount(), 0);
    assert.equal(timers.cleared.length, 1);
    assert.equal(sinks.releases.length, 2);
    assert.equal(sinks.revokes.length, 1);
    assert.equal(sinks.revokes[0].reason, 'PORT_REVOKED');
    port.emitMessage({ schema: FRAME_ACK_SCHEMA, ...makeAck() });
    assert.equal(endpoint.getInstrumentation().acked, 0);
  });

  it('revokes when the remote end disconnects', () => {
    const { port, endpoint, sinks } = makeSender();
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    port.emitClose();
    assert.equal(endpoint.getInstrumentation().revokeReason, 'ENDPOINT_RESTART');
    assert.equal(sinks.releases.length, 1);
    assert.equal(sinks.releases[0].reason, 'ENDPOINT_RESTART');
    assert.equal(sinks.revokes.length, 1);
  });

  it('revokes a stalled handoff using production default clock and timers', async () => {
    const port = makeFakePort();
    const sinks = makeSinks();
    const beforeMs = Date.now();
    const endpoint = createFramePort({
      port,
      role: 'sender',
      binding: makeBinding(),
      limits: makeLimits({ ackTimeoutMs: 25 }),
      onReleaseLease: sinks.onReleaseLease,
      onRevoke: sinks.onRevoke,
    });
    try {
      const posted = endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
      assert.equal(posted.ok, true);
      assert.equal(posted.sent, true);

      const deadline = Date.now() + 1500;
      while (!endpoint.getInstrumentation().revoked && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const afterMs = Date.now();

      const info = endpoint.getInstrumentation();
      assert.equal(info.revoked, true);
      assert.equal(info.revokeReason, 'TIMEOUT');
      assert.equal(info.timeouts, 1);
      assert.equal(info.inFlightGeneration, null);
      assert.equal(info.pendingGeneration, null);
      assert.ok(info.createdAtMs >= beforeMs && info.createdAtMs <= afterMs);
      assert.ok(
        typeof info.revokedAtMs === 'number' &&
          info.revokedAtMs >= info.createdAtMs &&
          info.revokedAtMs <= afterMs,
      );
      assert.equal(port.closes, 1);
      assert.deepEqual(
        sinks.releases.map((release) => [release.frameGeneration, release.reason]),
        [[1, 'TIMEOUT']],
      );
      assert.deepEqual(sinks.revokes, [{ binding: makeBinding(), reason: 'TIMEOUT' }]);

      const latePost = endpoint.postFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }));
      assert.equal(latePost.ok, false);
      assert.equal(latePost.reason, FRAME_REASONS.PORT_REVOKED);
    } finally {
      endpoint.revokeFramePort();
    }
  });

  it('negative control: completing handoff within window disarms production default timer and keeps port live', async () => {
    const port = makeFakePort();
    const sinks = makeSinks();
    const endpoint = createFramePort({
      port,
      role: 'sender',
      binding: makeBinding(),
      limits: makeLimits({ ackTimeoutMs: 25 }),
      onReleaseLease: sinks.onReleaseLease,
      onRevoke: sinks.onRevoke,
    });
    try {
      const first = endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
      assert.equal(first.ok, true);
      assert.deepEqual(endpoint.acceptAck(makeAck()), { ok: true, acked: 1, promoted: null });

      await new Promise((resolve) => setTimeout(resolve, 60));

      const mid = endpoint.getInstrumentation();
      assert.equal(mid.revoked, false);
      assert.equal(mid.revokeReason, null);
      assert.equal(mid.revokedAtMs, null);
      assert.equal(mid.timeouts, 0);
      assert.equal(mid.acked, 1);
      assert.equal(sinks.revokes.length, 0);

      const second = endpoint.postFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }));
      assert.equal(second.ok, true);
      assert.equal(second.sent, true);
      assert.deepEqual(
        endpoint.acceptAck(
          makeAck({
            frameGeneration: 2,
            leaseId: 'lease-2',
            correlation: 'capsule-A#2#lease-2',
          }),
        ),
        { ok: true, acked: 2, promoted: null },
      );
      assert.equal(endpoint.getInstrumentation().revoked, false);
      assert.equal(endpoint.getInstrumentation().acked, 2);
    } finally {
      endpoint.revokeFramePort();
    }
  });
});

describe('receiver: validate, consume newest, ACK after consume', () => {
  /**
   * @param {Record<string, any>} frame
   * @returns {Record<string, any>} Wire delivery envelope.
   */
  function deliveryFor(frame) {
    return {
      schema: FRAME_DELIVERY_SCHEMA,
      kind: 'frame',
      correlation: `capsule-A#${frame.frameGeneration}#${frame.leaseId}`,
      ...frame,
    };
  }

  it('consumes a valid delivery then ACKs with the exact identity', async () => {
    const { port, endpoint, sinks, consumed } = makeReceiver();
    port.emitMessage(deliveryFor(makeFrame({ frameGeneration: 1, leaseId: 'lease-1', sha256: DIGEST })));
    await drain();
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0].frameGeneration, 1);
    assert.ok(Object.isFrozen(consumed[0]));
    assert.ok(consumed[0].bytes instanceof Uint8Array);
    assert.equal(consumed[0].bytes.byteLength, 48);
    assert.equal(port.sent.length, 1);
    assert.deepEqual(port.sent[0], {
      schema: FRAME_ACK_SCHEMA,
      kind: 'ack',
      correlation: 'capsule-A#1#lease-1',
      principal: 'mv-utility',
      epoch: 7,
      surfaceId: 'capsule-A',
      surfaceGeneration: 3,
      frameGeneration: 1,
      leaseId: 'lease-1',
      outcome: 'PRESENTED',
    });
    assert.equal(sinks.releases.length, 1);
    assert.equal(sinks.releases[0].reason, 'PRESENTED');
    const info = endpoint.getInstrumentation();
    assert.equal(info.acksSent, 1);
    assert.equal(info.heldGeneration, null);
    assert.equal(info.acceptedFloor, 1);
  });

  it('echoes the consumer outcome and tolerates a throwing consumer', async () => {
    const hidden = makeReceiver(
      {},
      async () => ({ outcome: 'HIDDEN' }),
    );
    hidden.port.emitMessage(deliveryFor(makeFrame({ frameGeneration: 1 })));
    await drain();
    assert.equal(hidden.port.sent[0].outcome, 'HIDDEN');
    assert.equal(hidden.sinks.releases[0].reason, 'HIDDEN');

    const failing = makeReceiver(
      {},
      async () => {
        throw new Error('canvas gone');
      },
    );
    failing.port.emitMessage(deliveryFor(makeFrame({ frameGeneration: 1 })));
    await drain();
    assert.equal(failing.port.sent[0].outcome, 'REFUSED');
    assert.equal(failing.sinks.releases[0].reason, 'REFUSED');
    // The receiver stays usable after a consumer fault.
    failing.port.emitMessage(deliveryFor(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' })));
    await drain();
    assert.equal(failing.port.sent.length, 2);
  });

  it('coalesces rapid deliveries: newest wins before consume, superseded never consumed', async () => {
    /** @type {Array<(value: unknown) => void>} */
    const gates = [];
    /** @type {Array<number>} */
    const seen = [];
    const { port, sinks } = makeReceiver(
      {},
      (frame) => {
        seen.push(frame.frameGeneration);
        return new Promise((resolve) => {
          gates.push(resolve);
        });
      },
    );
    port.emitMessage(deliveryFor(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' })));
    await drain();
    port.emitMessage(deliveryFor(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' })));
    port.emitMessage(deliveryFor(makeFrame({ frameGeneration: 3, leaseId: 'lease-3' })));
    await drain();
    // ARG-ui_frames-4: only queued gen2 is released immediately. Active gen1
    // retains its lease and ACK until the consumer settles.
    assert.deepEqual(seen, [1]);
    assert.deepEqual(
      sinks.releases.map((release) => [release.frameGeneration, release.reason]),
      [
        [2, 'SUPERSEDED'],
      ],
    );
    assert.deepEqual(port.sent.map(ack => [ack.frameGeneration, ack.outcome]), [[2, 'SUPERSEDED']]);
    gates[0]({ outcome: 'PRESENTED' });
    await drain();
    assert.deepEqual(seen, [1, 3]);
    gates[1]({ outcome: 'PRESENTED' });
    await drain();
    assert.deepEqual(
      sinks.releases.map((release) => [release.frameGeneration, release.reason]),
      [
        [2, 'SUPERSEDED'],
        [1, 'SUPERSEDED'],
        [3, 'PRESENTED'],
      ],
    );
    assert.deepEqual(
      port.sent.map((ack) => [ack.frameGeneration, ack.outcome]),
      [
        [2, 'SUPERSEDED'],
        [1, 'SUPERSEDED'],
        [3, 'PRESENTED'],
      ],
    );
  });

  it('refuses stale, foreign and malformed deliveries; the consumer never runs', async () => {
    const { port, endpoint, sinks, consumed } = makeReceiver();
    port.emitMessage(deliveryFor(makeFrame({ frameGeneration: 5, leaseId: 'lease-5' })));
    await drain();
    assert.equal(consumed.length, 1);
    const bad = [
      deliveryFor(makeFrame({ frameGeneration: 5, leaseId: 'lease-5b' })),
      deliveryFor(makeFrame({ frameGeneration: 4, leaseId: 'lease-4' })),
      deliveryFor(makeFrame({ frameGeneration: 6, leaseId: 'lease-6', epoch: 8 })),
      deliveryFor(makeFrame({ frameGeneration: 6, leaseId: 'lease-6', surfaceId: 'capsule-B' })),
      deliveryFor(
        makeFrame({ frameGeneration: 6, leaseId: 'lease-6', surfaceGeneration: 2 }),
      ),
      deliveryFor(makeFrame({ frameGeneration: 6, leaseId: 'lease-6', sha256: '0'.repeat(64) })),
      deliveryFor(makeFrame({ frameGeneration: 6, leaseId: 'lease-6', byteLength: 1 })),
      { schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'junk' },
    ];
    // ARG-ui_frames-3: foreign identities and missing correlation are silent;
    // bound stale or malformed payloads still receive correlated refusals.
    const ackedIndices = new Set([0, 1, 5, 6]);
    for (const [index, message] of bad.entries()) {
      const before = port.sent.length;
      port.emitMessage(message);
      assert.equal(port.sent.length, before + (ackedIndices.has(index) ? 1 : 0));
      if (ackedIndices.has(index)) {
        assert.equal(port.sent.at(-1).correlation, message.correlation);
        assert.equal(port.sent.at(-1).frameGeneration, message.frameGeneration);
      }
    }
    await drain();
    assert.equal(consumed.length, 1);
    assert.equal(endpoint.getInstrumentation().acceptedFloor, 5);
    assert.equal(endpoint.getInstrumentation().refused, bad.length);
    assert.deepEqual(port.sent.map(ack => ack.outcome), [
      'PRESENTED', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED',
    ]);
    assert.ok(
      sinks.releases.every((release) => release.frameGeneration === 5),
      'refused arrivals release nothing',
    );
  });

  it('AC-02 control: a capsule-A delivery never reaches the capsule-B consumer', async () => {
    const { port, consumed } = makeReceiver({ binding: makeBinding({ surfaceId: 'capsule-B' }) });
    port.emitMessage({
      schema: FRAME_DELIVERY_SCHEMA,
      kind: 'frame',
      correlation: 'capsule-A#1#lease-1',
      ...makeFrame({ surfaceId: 'capsule-A', sha256: DIGEST_B }),
    });
    await drain();
    assert.equal(consumed.length, 0);
    // ARG-ui_frames-3: a foreign arrival must not expose capsule-B's binding.
    assert.equal(port.sent.length, 0);
  });

  it('ignores ACKs on the receiver port and refuses the sender methods', () => {
    const { port, endpoint } = makeReceiver();
    port.emitMessage({ schema: FRAME_ACK_SCHEMA, ...makeAck() });
    assert.equal(endpoint.getInstrumentation().refused, 1);
    assert.equal(port.sent.length, 0);
    const posted = endpoint.postFrame(makeFrame());
    assert.equal(posted.ok, false);
    assert.equal(posted.reason, FRAME_REASONS.INVALID_BINDING);
    const acked = endpoint.acceptAck(makeAck());
    assert.equal(acked.ok, false);
    assert.equal(acked.reason, FRAME_REASONS.INVALID_BINDING);
  });

  it('revoke drains the held frame and freezes the consumer out', async () => {
    /** @type {Array<(value: unknown) => void>} */
    const gates = [];
    /** @type {Array<number>} */
    const seen = [];
    const { port, endpoint, sinks } = makeReceiver(
      {},
      (frame) => {
        seen.push(frame.frameGeneration);
        return new Promise((resolve) => {
          gates.push(resolve);
        });
      },
    );
    port.emitMessage({
      schema: FRAME_DELIVERY_SCHEMA,
      kind: 'frame',
      correlation: 'capsule-A#1#lease-1',
      ...makeFrame({ frameGeneration: 1 }),
    });
    await drain();
    assert.deepEqual(seen, [1]);
    endpoint.revokeFramePort('SHUTDOWN');
    gates[0]({ outcome: 'PRESENTED' });
    port.emitMessage({
      schema: FRAME_DELIVERY_SCHEMA,
      kind: 'frame',
      correlation: 'capsule-A#2#lease-2',
      ...makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }),
    });
    await drain();
    assert.deepEqual(seen, [1]);
    assert.deepEqual(
      sinks.releases.map((release) => [release.frameGeneration, release.reason]),
      [[1, 'SHUTDOWN']],
    );
    assert.equal(sinks.revokes.length, 1);
    assert.equal(port.sent.length, 0);
  });
});

describe('linked endpoints: delivery and ACK cross the wire', () => {
  it('moves one frame sender to receiver and the ACK back', async () => {
    const senderFake = makeFakePort();
    const receiverFake = makeFakePort();
    // Cross-wired bulk path: each endpoint posts into the peer listener set.
    const senderWire = {
      ...senderFake,
      postMessage: (/** @type {unknown} */ message) => receiverFake.emitMessage(message),
    };
    const receiverWire = {
      ...receiverFake,
      postMessage: (/** @type {unknown} */ message) => senderFake.emitMessage(message),
    };
    const senderTimers = makeTimers();
    const receiverTimers = makeTimers();
    const senderSinks = makeSinks();
    const receiverSinks = makeSinks();
    /** @type {Array<any>} */
    const consumed = [];
    const sender = createFramePort({
      port: senderWire,
      role: 'sender',
      binding: makeBinding(),
      limits: makeLimits(),
      onReleaseLease: senderSinks.onReleaseLease,
      onRevoke: senderSinks.onRevoke,
      clock: () => 1000,
      setTimer: senderTimers.setTimer,
      clearTimer: senderTimers.clearTimer,
    });
    createFramePort({
      port: receiverWire,
      role: 'receiver',
      binding: makeBinding(),
      limits: makeLimits(),
      onReleaseLease: receiverSinks.onReleaseLease,
      onRevoke: receiverSinks.onRevoke,
      onFrame: async (frame) => {
        consumed.push(frame);
        return { outcome: 'PRESENTED' };
      },
      clock: () => 1000,
      setTimer: receiverTimers.setTimer,
      clearTimer: receiverTimers.clearTimer,
    });
    const posted = sender.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    assert.equal(posted.ok, true);
    await drain();
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0].sha256, DIGEST);
    const info = sender.getInstrumentation();
    assert.equal(info.acked, 1);
    assert.equal(info.inFlightGeneration, null);
    assert.equal(senderSinks.releases.length, 1);
    assert.equal(senderSinks.releases[0].reason, 'PRESENTED');
    assert.equal(receiverSinks.releases.length, 1);
  });
});

describe('owner faults never wedge the transport', () => {
  it('counts a throwing releaser and stays consistent', () => {
    const fake = makeFakePort();
    const timers = makeTimers();
    const sinks = makeSinks();
    const endpoint = createFramePort({
      port: fake,
      role: 'sender',
      binding: makeBinding(),
      limits: makeLimits(),
      onReleaseLease: () => {
        throw new Error('owner ledger down');
      },
      onRevoke: sinks.onRevoke,
      clock: () => 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    endpoint.postFrame(makeFrame({ frameGeneration: 1, leaseId: 'lease-1' }));
    endpoint.postFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }));
    endpoint.postFrame(makeFrame({ frameGeneration: 3, leaseId: 'lease-3' }));
    const info = endpoint.getInstrumentation();
    assert.equal(info.releaseFaults, 1);
    assert.equal(info.lastReleaseFault, 'owner ledger down');
    assert.equal(info.pendingGeneration, 3);
    assert.deepEqual(endpoint.acceptAck(makeAck()), { ok: true, acked: 1, promoted: 3 });
    assert.equal(endpoint.getInstrumentation().releaseFaults, 2);
    assert.equal(sinks.revokes.length, 0);
  });
});
