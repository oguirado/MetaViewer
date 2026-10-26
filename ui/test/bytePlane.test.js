/**
 * W1-TERM-PLANE suite: lossless byte plane (`ui/electron/bytePlane.js`).
 *
 * Runs under plain Node (`node --test`): no Electron, no PTY, no timers.
 * Every behaviour pairs a positive witness with a negative control that
 * must fail: refusals leave the ledger byte-identical (snapshot deep-equal
 * before/after) and fatal violations close the session through exactly one
 * `onFault` call. Boundary tests pin the off-by-one mutants (pause at
 * high, broker resume strictly below low, overflow past the cap).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlaneError,
  createBytePlane,
  createFlowController,
} from '../electron/bytePlane.js';

/**
 * Candidate broker limits [TARGET, unit decision]: 64 KiB frames, pause at
 * 128 KiB unacked, resume below 64 KiB, 512 KiB / 4096 frames pending,
 * 128 KiB replay suffix, 8 MiB session lifetime output. Canonical values
 * freeze in `terminal_session/v0.2` (owner W0-CONTRACTS); this table only
 * exercises the injectable `limits` parameter.
 */
const FULL_LIMITS = {
  maxFrameBytes: 65536,
  highWaterBytes: 131072,
  lowWaterBytes: 65536,
  maxPendingBytes: 524288,
  maxPendingFrames: 4096,
  replayBytes: 131072,
  maxSessionOutputBytes: 8388608,
};

/**
 * Small limits for fast tests; every override keeps low < high <= pending.
 * @param {Partial<typeof FULL_LIMITS>} [over]
 */
function tinyLimits(over = {}) {
  return {
    maxFrameBytes: 16,
    highWaterBytes: 32,
    lowWaterBytes: 8,
    maxPendingBytes: 48,
    maxPendingFrames: 8,
    replayBytes: 24,
    maxSessionOutputBytes: 64,
    ...over,
  };
}

/**
 * @param {typeof FULL_LIMITS} [limits]
 */
function makePlane(limits = FULL_LIMITS) {
  /** @type {Array<[string, string, string, string?]>} */
  const events = [];
  const plane = createBytePlane({
    limits,
    onPause: (ctx) => { events.push(['pause', ctx.session, ctx.direction]); },
    onResume: (ctx) => { events.push(['resume', ctx.session, ctx.direction]); },
    onFault: (ctx, code) => { events.push(['fault', ctx.session, ctx.direction, code]); },
  });
  return { plane, events };
}

/**
 * @param {string} [session]
 * @param {'input'|'output'} [direction]
 * @param {number} [attachmentGeneration]
 */
function ctx(session = 's1', direction = 'output', attachmentGeneration = 0) {
  return { session, direction, serviceGeneration: 1, epoch: 1, attachmentGeneration };
}

/** @param {Uint8Array|number[]} bytes */
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/**
 * Asserts `fn` throws a PlaneError with exactly `code`.
 * @param {() => unknown} fn
 * @param {string} code
 */
function rejectsWith(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PlaneError, `expected PlaneError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected PlaneError ${code}, nothing thrown`);
}

describe('createFlowController', () => {
  it('requires every field', () => {
    const full = { highWaterBytes: 100, lowWaterBytes: 10, onPause: () => {}, onResume: () => {} };
    assert.throws(() => createFlowController(undefined), TypeError);
    assert.throws(() => createFlowController(null), TypeError);
    for (const key of Object.keys(full)) {
      const partial = { ...full };
      // @ts-expect-error negative control: missing required field
      delete partial[key];
      assert.throws(() => createFlowController(partial), TypeError, key);
    }
    assert.ok(createFlowController(full));
  });

  it('rejects bad watermarks and non-function callbacks', () => {
    const good = { onPause: () => {}, onResume: () => {} };
    assert.throws(() => createFlowController({ ...good, highWaterBytes: 10, lowWaterBytes: 10 }), RangeError);
    assert.throws(() => createFlowController({ ...good, highWaterBytes: 9, lowWaterBytes: 10 }), RangeError);
    for (const bad of [0, -1, 1.5, Number.NaN, '100', undefined]) {
      assert.throws(
        () => createFlowController({ ...good, highWaterBytes: bad, lowWaterBytes: 10 }),
        TypeError, String(bad),
      );
    }
    assert.throws(() => createFlowController(
      { highWaterBytes: 100, lowWaterBytes: 10, onPause: 'x', onResume: () => {} },
    ), TypeError);
    assert.throws(() => createFlowController(
      { highWaterBytes: 100, lowWaterBytes: 10, onPause: () => {}, onResume: null },
    ), TypeError);
  });

  it('pauses exactly at the high watermark, once', () => {
    let pauses = 0;
    let resumes = 0;
    const flow = createFlowController({
      highWaterBytes: 100, lowWaterBytes: 10,
      onPause: () => { pauses += 1; }, onResume: () => { resumes += 1; },
    });
    flow.enqueue(99);
    assert.deepEqual(flow.snapshot(), { buffered: 99, paused: false });
    flow.enqueue(1);
    assert.deepEqual(flow.snapshot(), { buffered: 100, paused: true });
    assert.equal(pauses, 1);
    flow.enqueue(50);
    assert.deepEqual(flow.snapshot(), { buffered: 150, paused: true });
    assert.equal(pauses, 1);
    assert.equal(resumes, 0);
  });

  it('resumes at or below low and stays paused above it', () => {
    let resumes = 0;
    const flow = createFlowController({
      highWaterBytes: 100, lowWaterBytes: 10,
      onPause: () => {}, onResume: () => { resumes += 1; },
    });
    flow.enqueue(150);
    flow.acknowledge(139);
    assert.deepEqual(flow.snapshot(), { buffered: 11, paused: true });
    flow.acknowledge(1);
    assert.deepEqual(flow.snapshot(), { buffered: 10, paused: false });
    assert.equal(resumes, 1);
  });

  it('never drops bytes under flood', () => {
    const flow = createFlowController({
      highWaterBytes: 100, lowWaterBytes: 10, onPause: () => {}, onResume: () => {},
    });
    for (let i = 0; i < 1000; i += 1) {
      flow.enqueue(7);
      flow.acknowledge(7);
    }
    assert.deepEqual(flow.snapshot(), { buffered: 0, paused: false });
    for (let i = 0; i < 1000; i += 1) flow.enqueue(7);
    assert.deepEqual(flow.snapshot(), { buffered: 7000, paused: true });
    flow.acknowledge(7000);
    assert.deepEqual(flow.snapshot(), { buffered: 0, paused: false });
  });

  it('reset clears bytes and pause without firing callbacks', () => {
    let calls = 0;
    const flow = createFlowController({
      highWaterBytes: 100, lowWaterBytes: 10,
      onPause: () => { calls += 1; }, onResume: () => { calls += 1; },
    });
    flow.enqueue(200);
    assert.equal(flow.snapshot().paused, true);
    flow.reset();
    assert.deepEqual(flow.snapshot(), { buffered: 0, paused: false });
    assert.equal(calls, 1);
  });

  it('refuses unsafe sums instead of wrapping', () => {
    const flow = createFlowController({
      highWaterBytes: Number.MAX_SAFE_INTEGER, lowWaterBytes: 10,
      onPause: () => {}, onResume: () => {},
    });
    flow.enqueue(Number.MAX_SAFE_INTEGER);
    assert.throws(() => flow.enqueue(1), RangeError);
    assert.deepEqual(flow.snapshot(), { buffered: Number.MAX_SAFE_INTEGER, paused: true });
    assert.throws(() => flow.enqueue(-1), TypeError);
    assert.throws(() => flow.acknowledge(0.5), TypeError);
  });

  it('clamps host-side over-acknowledge at zero', () => {
    const flow = createFlowController({
      highWaterBytes: 100, lowWaterBytes: 10, onPause: () => {}, onResume: () => {},
    });
    flow.enqueue(5);
    flow.acknowledge(99);
    assert.deepEqual(flow.snapshot(), { buffered: 0, paused: false });
  });
});

describe('createBytePlane limits', () => {
  it('validates bounds before allocating anything', () => {
    const hooks = { onPause: () => {}, onResume: () => {}, onFault: () => {} };
    assert.throws(() => createBytePlane(undefined), TypeError);
    assert.throws(() => createBytePlane({ ...hooks }), TypeError);
    assert.throws(() => createBytePlane({ ...hooks, limits: null }), TypeError);
    for (const key of Object.keys(FULL_LIMITS)) {
      const limits = { ...FULL_LIMITS };
      // @ts-expect-error negative control: missing bound
      delete limits[key];
      assert.throws(() => createBytePlane({ ...hooks, limits }), TypeError, key);
    }
    for (const bad of [0, -1, 1.5, Number.NaN, '8', undefined]) {
      assert.throws(
        () => createBytePlane({ ...hooks, limits: { ...FULL_LIMITS, maxFrameBytes: bad } }),
        TypeError, String(bad),
      );
    }
    assert.throws(() => createBytePlane({
      ...hooks, limits: { ...FULL_LIMITS, lowWaterBytes: 131072 },
    }), RangeError);
    assert.throws(() => createBytePlane({
      ...hooks, limits: { ...FULL_LIMITS, highWaterBytes: 524289 },
    }), RangeError);
    assert.throws(() => createBytePlane({
      ...hooks,
      limits: { ...FULL_LIMITS, maxSessionOutputBytes: Number.MAX_SAFE_INTEGER, maxFrameBytes: 2 },
    }), RangeError);
    assert.throws(() => createBytePlane({ limits: FULL_LIMITS }), TypeError);
    assert.throws(() => createBytePlane(
      { limits: FULL_LIMITS, onPause: () => {}, onResume: () => {}, onFault: 0 },
    ), TypeError);
  });
});

describe('open/close/snapshot', () => {
  it('opens a ledger with zero counters', () => {
    const { plane } = makePlane();
    plane.open(ctx());
    assert.deepEqual(plane.snapshot(ctx()), {
      sent: 0, acked: 0, lastSeq: 0, pendingFrames: 0, paused: false,
    });
  });

  it('rejects malformed contexts without creating a ledger', () => {
    const { plane } = makePlane();
    const bad = [
      undefined, null, 's1', 42,
      { ...ctx(), session: '' },
      { ...ctx(), session: 'a\0b' },
      { ...ctx(), session: 7 },
      { ...ctx(), direction: 'in' },
      { ...ctx(), direction: undefined },
      { ...ctx(), serviceGeneration: -1 },
      { ...ctx(), epoch: 1.5 },
      { ...ctx(), attachmentGeneration: Number.NaN },
      { session: 's1', direction: 'output' },
    ];
    for (const context of bad) {
      assert.throws(() => plane.open(context), TypeError, JSON.stringify(context));
    }
    rejectsWith(() => plane.snapshot(ctx()), 'unknown-session');
  });

  it('refuses duplicate open and never revives a closed id', () => {
    const { plane } = makePlane();
    plane.open(ctx());
    rejectsWith(() => plane.open(ctx()), 'duplicate-open');
    plane.close(ctx());
    rejectsWith(() => plane.open(ctx()), 'duplicate-open');
    assert.deepEqual(plane.snapshot(ctx()), {
      sent: 0, acked: 0, lastSeq: 0, pendingFrames: 0, paused: false,
    });
  });

  it('close is idempotent but unknown sessions are refused', () => {
    const { plane } = makePlane();
    rejectsWith(() => plane.close(ctx('ghost')), 'unknown-session');
    plane.open(ctx());
    plane.close(ctx());
    plane.close(ctx());
    rejectsWith(() => plane.snapshot(ctx('ghost')), 'unknown-session');
  });

  it('keeps input and output ledgers independent', () => {
    const { plane } = makePlane(tinyLimits());
    plane.open(ctx('s1', 'input'));
    plane.open(ctx('s1', 'output'));
    plane.ingest(ctx('s1', 'input'), { seq: 1, b64: b64([1, 2, 3]) });
    plane.ingest(ctx('s1', 'output'), { seq: 1, b64: b64([4, 5]) });
    plane.acknowledge(ctx('s1', 'input'), { seq: 1, bytes: 3 });
    assert.deepEqual(plane.snapshot(ctx('s1', 'input')), {
      sent: 3, acked: 3, lastSeq: 1, pendingFrames: 0, paused: false,
    });
    assert.deepEqual(plane.snapshot(ctx('s1', 'output')), {
      sent: 2, acked: 0, lastSeq: 1, pendingFrames: 1, paused: false,
    });
  });
});

describe('ingest', () => {
  it('sequence starts at 1: any other first seq faults once', () => {
    for (const seq of [0, 2, -3]) {
      const { plane, events } = makePlane();
      plane.open(ctx());
      rejectsWith(() => plane.ingest(ctx(), { seq, b64: b64([1]) }), seq > 1 ? 'seq-gap' : 'seq-duplicate');
      assert.deepEqual(events, [['fault', 's1', 'output', seq > 1 ? 'seq-gap' : 'seq-duplicate']]);
      assert.deepEqual(plane.snapshot(ctx()), {
        sent: 0, acked: 0, lastSeq: 0, pendingFrames: 0, paused: false,
      });
      rejectsWith(() => plane.ingest(ctx(), { seq: 1, b64: b64([1]) }), 'closed');
      rejectsWith(() => plane.acknowledge(ctx(), { seq: 1, bytes: 1 }), 'closed');
      rejectsWith(() => plane.attach(ctx('s1', 'output', 1)), 'closed');
      assert.equal(events.length, 1);
    }
  });

  it('gap and duplicate fault with distinct codes', () => {
    const { plane, events } = makePlane();
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64([1]) });
    plane.ingest(ctx(), { seq: 2, b64: b64([2]) });
    rejectsWith(() => plane.ingest(ctx(), { seq: 4, b64: b64([4]) }), 'seq-gap');
    assert.deepEqual(plane.snapshot(ctx()).lastSeq, 2);
    assert.deepEqual(events.at(-1), ['fault', 's1', 'output', 'seq-gap']);

    const again = makePlane();
    again.plane.open(ctx());
    again.plane.ingest(ctx(), { seq: 1, b64: b64([1]) });
    rejectsWith(() => again.plane.ingest(ctx(), { seq: 1, b64: b64([1]) }), 'seq-duplicate');
  });

  it('invalid base64 faults without consuming a byte', () => {
    for (const bad of ['!!!', 'abc', 'a===', 'ab=c', '****']) {
      const { plane, events } = makePlane();
      plane.open(ctx());
      plane.ingest(ctx(), { seq: 1, b64: b64([9]) });
      const before = plane.snapshot(ctx());
      rejectsWith(() => plane.ingest(ctx(), { seq: 2, b64: bad }), 'bad-base64');
      assert.deepEqual(plane.snapshot(ctx()), before);
      assert.deepEqual(events.at(-1), ['fault', 's1', 'output', 'bad-base64']);
    }
  });

  it('non-string b64 is a caller TypeError, the session survives', () => {
    const { plane, events } = makePlane();
    plane.open(ctx());
    assert.throws(() => plane.ingest(ctx(), { seq: 1, b64: 42 }), TypeError);
    assert.throws(() => plane.ingest(ctx(), null), TypeError);
    assert.throws(() => plane.ingest(ctx(), { seq: 1.5, b64: '' }), TypeError);
    assert.equal(events.length, 0);
    plane.ingest(ctx(), { seq: 1, b64: b64([1]) });
    assert.equal(plane.snapshot(ctx()).sent, 1);
  });

  it('oversize frames fault; exact-size frames pass', () => {
    const { plane } = makePlane(tinyLimits({ maxFrameBytes: 16 }));
    plane.open(ctx());
    const frame = plane.ingest(ctx(), { seq: 1, b64: b64(new Array(16).fill(7)) });
    assert.equal(frame.byteLength, 16);
    rejectsWith(
      () => plane.ingest(ctx(), { seq: 2, b64: b64(new Array(17).fill(7)) }),
      'frame-too-large',
    );
    assert.equal(plane.snapshot(ctx()).sent, 16);
  });

  it('round-trips split UTF-8 and VT bytes exactly', () => {
    const { plane } = makePlane();
    plane.open(ctx());
    const original = Buffer.from('h\xc3\xa9llo\x1b[31m!\x1b[0m\xe2\x82\xac', 'latin1');
    const cuts = [1, 2, 5, 6, 9];
    let start = 0;
    const parts = [];
    let seq = 0;
    for (const cut of [...cuts, original.length]) {
      seq += 1;
      const slice = original.subarray(start, cut);
      const frame = plane.ingest(ctx(), { seq, b64: slice.toString('base64') });
      assert.ok(frame.bytes instanceof Uint8Array);
      assert.equal(frame.session, 's1');
      assert.equal(frame.seq, seq);
      assert.equal(frame.byteLength, slice.length);
      parts.push(frame.bytes);
      start = cut;
    }
    assert.deepEqual(Buffer.concat(parts.map((p) => Buffer.from(p))), original);
    assert.equal(plane.snapshot(ctx()).sent, original.length);
  });

  it('returned bytes are copies: caller mutation cannot corrupt replay', () => {
    const { plane } = makePlane(tinyLimits());
    plane.open(ctx());
    const frame = plane.ingest(ctx(), { seq: 1, b64: b64([1, 2, 3, 4]) });
    frame.bytes.fill(0);
    const suffix = plane.attach(ctx('s1', 'output', 1));
    assert.deepEqual(Array.from(suffix.bytes), [1, 2, 3, 4]);
  });

  it('accepts empty base64 as a zero-byte frame', () => {
    const { plane } = makePlane();
    plane.open(ctx());
    const frame = plane.ingest(ctx(), { seq: 1, b64: '' });
    assert.equal(frame.byteLength, 0);
    assert.deepEqual(plane.snapshot(ctx()), {
      sent: 0, acked: 0, lastSeq: 1, pendingFrames: 1, paused: false,
    });
  });

  it('pauses at 128 KiB and resumes strictly below 64 KiB', () => {
    const { plane, events } = makePlane();
    plane.open(ctx());
    const chunk = new Array(32768).fill(1);
    for (let seq = 1; seq <= 3; seq += 1) {
      plane.ingest(ctx(), { seq, b64: b64(chunk) });
    }
    assert.equal(plane.snapshot(ctx()).paused, false);
    plane.ingest(ctx(), { seq: 4, b64: b64(chunk) });
    assert.deepEqual(plane.snapshot(ctx()).paused, true);
    assert.deepEqual(events, [['pause', 's1', 'output']]);
    plane.acknowledge(ctx(), { seq: 1, bytes: 32768 });
    plane.acknowledge(ctx(), { seq: 2, bytes: 65536 });
    assert.equal(plane.snapshot(ctx()).paused, true);
    plane.acknowledge(ctx(), { seq: 3, bytes: 98304 });
    assert.equal(plane.snapshot(ctx()).paused, false);
    assert.deepEqual(events.at(-1), ['resume', 's1', 'output']);
  });

  it('pending past 512 KiB ends the session explicitly', () => {
    const { plane, events } = makePlane();
    plane.open(ctx());
    const chunk = new Array(65536).fill(2);
    for (let seq = 1; seq <= 8; seq += 1) {
      plane.ingest(ctx(), { seq, b64: b64(chunk) });
    }
    assert.equal(plane.snapshot(ctx()).sent, 524288);
    rejectsWith(() => plane.ingest(ctx(), { seq: 9, b64: b64(chunk) }), 'pending-overflow');
    assert.equal(plane.snapshot(ctx()).sent, 524288);
    assert.deepEqual(events.at(-1), ['fault', 's1', 'output', 'pending-overflow']);
  });

  it('frame count past the cap ends the session; acked credit frees room', () => {
    const { plane } = makePlane(tinyLimits({ maxPendingFrames: 3, maxPendingBytes: 1000 }));
    plane.open(ctx());
    for (let seq = 1; seq <= 3; seq += 1) {
      plane.ingest(ctx(), { seq, b64: b64([seq]) });
    }
    rejectsWith(() => plane.ingest(ctx(), { seq: 4, b64: b64([4]) }), 'frames-overflow');

    const fresh = makePlane(tinyLimits({ maxPendingFrames: 3, maxPendingBytes: 1000 }));
    fresh.plane.open(ctx());
    fresh.plane.ingest(ctx(), { seq: 1, b64: b64([1]) });
    fresh.plane.acknowledge(ctx(), { seq: 1, bytes: 1 });
    fresh.plane.ingest(ctx(), { seq: 2, b64: b64([2]) });
    assert.equal(fresh.plane.snapshot(ctx()).pendingFrames, 1);
  });

  it('lifetime cap ends the session, never drops silently', () => {
    const { plane, events } = makePlane(tinyLimits({ maxSessionOutputBytes: 20 }));
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64(new Array(16).fill(3)) });
    plane.ingest(ctx(), { seq: 2, b64: b64(new Array(4).fill(3)) });
    assert.equal(plane.snapshot(ctx()).sent, 20);
    rejectsWith(() => plane.ingest(ctx(), { seq: 3, b64: b64([3]) }), 'lifetime-overflow');
    assert.equal(plane.snapshot(ctx()).sent, 20);
    assert.deepEqual(events.at(-1), ['fault', 's1', 'output', 'lifetime-overflow']);
  });

  it('stale-generation ingest is ignored and the session survives', () => {
    const { plane, events } = makePlane(tinyLimits());
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64([1]) });
    plane.attach(ctx('s1', 'output', 1));
    const before = plane.snapshot(ctx('s1', 'output', 1));
    rejectsWith(
      () => plane.ingest(ctx('s1', 'output', 0), { seq: 2, b64: b64([2]) }),
      'stale-generation',
    );
    rejectsWith(
      () => plane.ingest(ctx('s1', 'output', 2), { seq: 2, b64: b64([2]) }),
      'stale-generation',
    );
    rejectsWith(
      () => plane.ingest(
        { ...ctx('s1', 'output', 1), serviceGeneration: 2 }, { seq: 2, b64: b64([2]) },
      ),
      'stale-generation',
    );
    assert.deepEqual(plane.snapshot(ctx('s1', 'output', 1)), before);
    assert.equal(events.length, 0);
    plane.ingest(ctx('s1', 'output', 1), { seq: 2, b64: b64([2]) });
    assert.equal(plane.snapshot(ctx('s1', 'output', 1)).sent, 2);
  });

  it('unknown and closed sessions refuse ingest', () => {
    const { plane } = makePlane();
    rejectsWith(() => plane.ingest(ctx('ghost'), { seq: 1, b64: '' }), 'unknown-session');
    plane.open(ctx());
    plane.close(ctx());
    rejectsWith(() => plane.ingest(ctx(), { seq: 1, b64: '' }), 'closed');
  });
});

describe('acknowledge', () => {
  it('advances only on the parser-consumed prefix boundary', () => {
    const { plane } = makePlane(
      tinyLimits({ maxFrameBytes: 32, highWaterBytes: 100, maxPendingBytes: 200 }),
    );
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64(new Array(10).fill(1)) });
    plane.ingest(ctx(), { seq: 2, b64: b64(new Array(20).fill(2)) });
    plane.ingest(ctx(), { seq: 3, b64: b64(new Array(10).fill(3)) });
    plane.acknowledge(ctx(), { seq: 1, bytes: 10 });
    assert.deepEqual(plane.snapshot(ctx()), {
      sent: 40, acked: 10, lastSeq: 3, pendingFrames: 2, paused: false,
    });
    plane.acknowledge(ctx(), { seq: 3, bytes: 40 });
    assert.deepEqual(plane.snapshot(ctx()), {
      sent: 40, acked: 40, lastSeq: 3, pendingFrames: 0, paused: false,
    });
  });

  it('early, future, decreasing, non-boundary and out-of-order acks are refused', () => {
    const { plane } = makePlane(tinyLimits());
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64(new Array(10).fill(1)) });
    plane.ingest(ctx(), { seq: 2, b64: b64(new Array(10).fill(2)) });
    const pristine = plane.snapshot(ctx());
    const refused = [
      [{ seq: 5, bytes: 50 }, 'ack-unknown-seq'],
      [{ seq: 3, bytes: 30 }, 'ack-unknown-seq'],
      [{ seq: 1, bytes: 11 }, 'ack-not-boundary'],
      [{ seq: 1, bytes: 9 }, 'ack-not-boundary'],
      [{ seq: 0, bytes: 0 }, 'ack-stale'],
    ];
    for (const [ack, code] of refused) {
      rejectsWith(() => plane.acknowledge(ctx(), ack), code);
      assert.deepEqual(plane.snapshot(ctx()), pristine);
    }
    plane.acknowledge(ctx(), { seq: 1, bytes: 10 });
    const advanced = plane.snapshot(ctx());
    rejectsWith(() => plane.acknowledge(ctx(), { seq: 1, bytes: 10 }), 'ack-stale');
    rejectsWith(() => plane.acknowledge(ctx(), { seq: 2, bytes: 10 }), 'ack-not-boundary');
    assert.deepEqual(plane.snapshot(ctx()), advanced);
    plane.acknowledge(ctx(), { seq: 2, bytes: 20 });
    rejectsWith(() => plane.acknowledge(ctx(), { seq: 1, bytes: 10 }), 'ack-stale');
    assert.equal(plane.snapshot(ctx()).acked, 20);
  });

  it('malformed acks are caller TypeErrors', () => {
    const { plane } = makePlane(tinyLimits());
    plane.open(ctx());
    assert.throws(() => plane.acknowledge(ctx(), null), TypeError);
    assert.throws(() => plane.acknowledge(ctx(), { seq: 1 }), TypeError);
    assert.throws(() => plane.acknowledge(ctx(), { seq: 1, bytes: -1 }), TypeError);
    assert.throws(() => plane.acknowledge(ctx(), { seq: 1.5, bytes: 1 }), TypeError);
  });

  it('stale-generation ack never credits the new view', () => {
    const { plane, events } = makePlane(tinyLimits());
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64([1, 2]) });
    plane.attach(ctx('s1', 'output', 1));
    rejectsWith(
      () => plane.acknowledge(ctx('s1', 'output', 0), { seq: 1, bytes: 2 }),
      'stale-generation',
    );
    assert.equal(plane.snapshot(ctx('s1', 'output', 1)).acked, 0);
    assert.equal(events.length, 0);
    plane.acknowledge(ctx('s1', 'output', 1), { seq: 1, bytes: 2 });
    assert.equal(plane.snapshot(ctx('s1', 'output', 1)).acked, 2);
  });

  it('unknown and closed sessions refuse ack', () => {
    const { plane } = makePlane();
    rejectsWith(() => plane.acknowledge(ctx('ghost'), { seq: 1, bytes: 1 }), 'unknown-session');
    plane.open(ctx());
    plane.close(ctx());
    rejectsWith(() => plane.acknowledge(ctx(), { seq: 1, bytes: 1 }), 'closed');
  });
});

describe('attach', () => {
  it('returns the bounded suffix with exact cursors', () => {
    const { plane } = makePlane(tinyLimits({ replayBytes: 24 }));
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    plane.ingest(ctx(), { seq: 2, b64: b64([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) });
    plane.ingest(ctx(), { seq: 3, b64: b64([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]) });
    const suffix = plane.attach(ctx('s1', 'output', 1));
    assert.equal(suffix.firstSeq, 1);
    assert.equal(suffix.lastSeq, 3);
    assert.equal(suffix.truncated, true);
    assert.ok(suffix.bytes instanceof Uint8Array);
    assert.deepEqual(Array.from(suffix.bytes), [
      7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
  });

  it('untruncated history reports exact cursors; empty history reports nulls', () => {
    const { plane } = makePlane(tinyLimits());
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64([1, 2]) });
    const suffix = plane.attach(ctx('s1', 'output', 1));
    assert.deepEqual(
      { firstSeq: suffix.firstSeq, lastSeq: suffix.lastSeq, truncated: suffix.truncated },
      { firstSeq: 1, lastSeq: 1, truncated: false },
    );
    assert.deepEqual(Array.from(suffix.bytes), [1, 2]);

    const blank = makePlane(tinyLimits());
    blank.plane.open(ctx());
    const empty = blank.plane.attach(ctx('s1', 'output', 1));
    assert.equal(empty.firstSeq, null);
    assert.equal(empty.lastSeq, null);
    assert.equal(empty.truncated, false);
    assert.equal(empty.bytes.length, 0);
  });

  it('attach requires a strict generation bump on the same service', () => {
    const { plane } = makePlane(tinyLimits());
    plane.open(ctx());
    rejectsWith(() => plane.attach(ctx()), 'stale-generation');
    rejectsWith(
      () => plane.attach({ ...ctx('s1', 'output', 1), serviceGeneration: 9 }),
      'stale-generation',
    );
    plane.attach(ctx('s1', 'output', 1));
    rejectsWith(() => plane.attach(ctx('s1', 'output', 1)), 'stale-generation');
    const suffix = plane.attach(ctx('s1', 'output', 2));
    assert.equal(suffix.truncated, false);
  });

  it('unknown and closed sessions refuse attach', () => {
    const { plane } = makePlane();
    rejectsWith(() => plane.attach(ctx('ghost', 'output', 1)), 'unknown-session');
    plane.open(ctx());
    plane.close(ctx());
    rejectsWith(() => plane.attach(ctx('s1', 'output', 1)), 'closed');
  });

  it('reattach preserves credit and continues the sequence', () => {
    const { plane } = makePlane(tinyLimits());
    plane.open(ctx());
    plane.ingest(ctx(), { seq: 1, b64: b64([1]) });
    plane.ingest(ctx(), { seq: 2, b64: b64([2]) });
    plane.acknowledge(ctx(), { seq: 1, bytes: 1 });
    const before = plane.snapshot(ctx());
    plane.attach(ctx('s1', 'output', 1));
    assert.deepEqual(plane.snapshot(ctx('s1', 'output', 1)), before);
    plane.ingest(ctx('s1', 'output', 1), { seq: 3, b64: b64([3]) });
    assert.equal(plane.snapshot(ctx('s1', 'output', 1)).sent, 3);
    rejectsWith(
      () => plane.ingest(ctx('s1', 'output', 0), { seq: 4, b64: b64([4]) }),
      'stale-generation',
    );
  });
});

describe('fault boundaries', () => {
  it('off-by-one: high-1 open, high paused, low equal paused, low-1 resumed', () => {
    const { plane, events } = makePlane(
      tinyLimits({ highWaterBytes: 32, lowWaterBytes: 8, maxPendingFrames: 64 }),
    );
    plane.open(ctx());
    for (let seq = 1; seq <= 31; seq += 1) {
      plane.ingest(ctx(), { seq, b64: b64([seq % 256]) });
    }
    assert.equal(plane.snapshot(ctx()).paused, false);
    plane.ingest(ctx(), { seq: 32, b64: b64([32]) });
    assert.equal(plane.snapshot(ctx()).paused, true);
    assert.deepEqual(events, [['pause', 's1', 'output']]);
    plane.acknowledge(ctx(), { seq: 24, bytes: 24 });
    assert.equal(plane.snapshot(ctx()).paused, true);
    plane.acknowledge(ctx(), { seq: 25, bytes: 25 });
    assert.equal(plane.snapshot(ctx()).paused, false);
    assert.deepEqual(events.at(-1), ['resume', 's1', 'output']);
  });

  it('onFault fires exactly once and carries code only, never payload', () => {
    /** @type {Array<[unknown, unknown]>} */
    const faults = [];
    const plane = createBytePlane({
      limits: tinyLimits(),
      onPause: () => {},
      onResume: () => {},
      onFault: (context, code) => { faults.push([context, code]); },
    });
    plane.open(ctx());
    rejectsWith(() => plane.ingest(ctx(), { seq: 7, b64: b64([1]) }), 'seq-gap');
    rejectsWith(() => plane.ingest(ctx(), { seq: 1, b64: b64([1]) }), 'closed');
    assert.equal(faults.length, 1);
    const [context, code] = faults[0];
    assert.equal(code, 'seq-gap');
    assert.deepEqual(Object.keys(context).sort(), [
      'attachmentGeneration', 'direction', 'epoch', 'serviceGeneration', 'session',
    ]);
  });
});
