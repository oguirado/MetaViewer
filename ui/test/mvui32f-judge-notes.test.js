/**
 * MVUI32F lane F: judge-notes regressions for the rehash reporter retry and
 * the admitDelivery held-verifying fence. Reporter tests use injected fake
 * clock/timers only (no sleeps); router tests use deferred digest gates and
 * wall-clock-bounded waits (no fixed sleeps, no sockets). Every behaviour
 * has a negative control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import installFramePortRouter, {
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
  createRehashDiagReporter,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { tick, until, untilAcks } from './frame-wait.mjs';

const ORIGIN = 'app://metaviewer';
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
const BYTES_A = [12, 34, 56];
const BYTES_B = [200, 201, 202];
const BYTES_C = [7, 8, 9];
const BYTES_P = [41, 42, 43];

async function hexDigest(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fakeClock() {
  let now = 0;
  return { get: () => now, advance: (ms) => { now += ms; } };
}

function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => { pending.delete(id); },
    fireAll() {
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.fn();
      }
    },
  };
}

function diagDouble() {
  let skipped = 0;
  let done = 0;
  const listeners = new Set();
  return {
    set(nextSkipped, nextDone) {
      skipped = nextSkipped;
      done = nextDone;
      for (const listener of [...listeners]) listener(this.getRehashDiag());
    },
    getRehashDiag() {
      return Object.freeze({ rehashSkipped: skipped, rehashDone: done });
    },
    onRehashDiag(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function modeFacade(mode) {
  return {
    mode,
    reports: [],
    attempts: 0,
    reportDiag(payload) {
      this.attempts += 1;
      if (this.mode === 'throw') throw new Error('host down');
      if (this.mode === 'refuse') return false;
      this.reports.push(payload);
      return true;
    },
  };
}

const pendingDelay = (timers) => [...timers.pending.values()][0]?.ms;

test('mvui32f: refused immediate report retries on a trailing timer', () => {
  for (const mode of ['refuse', 'throw']) {
    const router = diagDouble();
    const clock = fakeClock();
    const timers = fakeTimers();
    const facade = modeFacade(mode);
    const reporter = createRehashDiagReporter(router, {
      getFacade: () => facade, now: clock.get,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    assert.ok(reporter);
    try {
      router.set(0, 1);
      assert.equal(facade.attempts, 1);
      assert.deepEqual(facade.reports, []);
      assert.equal(timers.pending.size, 1, `${mode}: refused report arms one retry`);
      assert.equal(pendingDelay(timers), 1000, `${mode}: retry within the same throttle`);
      facade.mode = 'accept';
      clock.advance(1000);
      timers.fireAll();
      assert.equal(facade.attempts, 2, `${mode}: retry fires without another delivery`);
      assert.deepEqual(facade.reports, [{ rehashSkipped: 0, rehashDone: 1 }]);
      assert.equal(timers.pending.size, 0);
    } finally {
      reporter.dispose();
    }
  }
});

test('mvui32f negative: accepted immediate report arms no retry timer', () => {
  const router = diagDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const facade = modeFacade('accept');
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  try {
    router.set(0, 1);
    assert.equal(facade.attempts, 1);
    assert.deepEqual(facade.reports, [{ rehashSkipped: 0, rehashDone: 1 }]);
    assert.equal(timers.pending.size, 0, 'no retry when the host accepted');
    clock.advance(1000);
    timers.fireAll();
    assert.equal(facade.attempts, 1, 'no spurious retry');
  } finally {
    reporter.dispose();
  }
});

test('mvui32f: refused trailing report retries again at most once per second', () => {
  const router = diagDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const facade = modeFacade('accept');
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  try {
    router.set(0, 1);
    assert.equal(facade.reports.length, 1);
    router.set(1, 1);
    assert.equal(timers.pending.size, 1, 'throttled change arms one timer');
    assert.equal(pendingDelay(timers), 1000);
    facade.mode = 'refuse';
    clock.advance(1000);
    timers.fireAll();
    assert.equal(facade.attempts, 2, 'trailing attempt ran');
    assert.equal(facade.reports.length, 1, 'refused trailing keeps pending totals');
    assert.equal(timers.pending.size, 1, 'refused trailing schedules one retry');
    assert.equal(pendingDelay(timers), 1000, 'retry waits a full throttle interval');
    facade.mode = 'accept';
    clock.advance(1000);
    timers.fireAll();
    assert.deepEqual(facade.reports[1], { rehashSkipped: 1, rehashDone: 1 });
    assert.equal(timers.pending.size, 0);
  } finally {
    reporter.dispose();
  }
});

test('mvui32f: dispose stops retrying after a refused report', () => {
  const router = diagDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const facade = modeFacade('refuse');
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  router.set(0, 1);
  assert.equal(timers.pending.size, 1, 'retry armed before dispose');
  reporter.dispose();
  assert.equal(timers.pending.size, 0, 'dispose clears the retry timer');
  assert.equal(facade.attempts, 2, 'dispose flushes once');
  assert.deepEqual(facade.reports, []);
  router.set(0, 2);
  clock.advance(5000);
  timers.fireAll();
  assert.equal(facade.attempts, 2, 'no retry after dispose');
  assert.equal(timers.pending.size, 0);
});

test('mvui32f: totals never decrease, then a later increase reports', () => {
  const router = diagDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const facade = modeFacade('accept');
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  try {
    router.set(2, 3);
    assert.deepEqual(facade.reports, [{ rehashSkipped: 2, rehashDone: 3 }]);
    router.set(1, 1);
    assert.equal(timers.pending.size, 0, 'full decrease arms no timer');
    assert.equal(facade.reports.length, 1, 'full decrease is never sent');
    router.set(3, 2);
    assert.equal(timers.pending.size, 0, 'partial decrease arms no timer');
    assert.equal(facade.reports.length, 1, 'partial decrease is never sent');
    clock.advance(1000);
    timers.fireAll();
    assert.equal(facade.reports.length, 1, 'no trailing decrease');
    router.set(3, 4);
    assert.deepEqual(facade.reports[1], { rehashSkipped: 3, rehashDone: 4 });
  } finally {
    reporter.dispose();
  }
});

test('mvui32f: missing facade stays silent with no timers', () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const router = diagDouble();
  for (const getFacade of [() => null, () => undefined, () => ({}), () => { throw new Error('gone'); }]) {
    const reporter = createRehashDiagReporter(router, {
      getFacade, now: clock.get,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    assert.ok(reporter);
    router.set(0, 1);
    assert.equal(timers.pending.size, 0, 'missing facade arms no timer');
    reporter.dispose();
    assert.equal(timers.pending.size, 0);
  }
});

test('mvui32f: throttled change with a missing facade arms no timer', () => {
  const router = diagDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const live = modeFacade('accept');
  const holder = { current: live };
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => holder.current, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  try {
    router.set(0, 1);
    assert.equal(live.reports.length, 1);
    holder.current = null;
    router.set(0, 2);
    assert.equal(timers.pending.size, 0, 'missing facade stays silent when throttled');
    clock.advance(1000);
    timers.fireAll();
    assert.equal(live.reports.length, 1, 'nothing sent while the facade is missing');
    assert.equal(timers.pending.size, 0);
  } finally {
    reporter.dispose();
  }
});

function fakeTarget() {
  const listeners = new Map();
  return {
    location: { origin: ORIGIN },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(event) { for (const fn of [...(listeners.get('message') ?? [])]) fn(event); },
  };
}

function trustedPort() {
  const listeners = new Map();
  const port = {
    acks: [], closed: false, started: false,
    postMessage(message) { port.acks.push(message); },
    start() { port.started = true; },
    close() { port.closed = true; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    deliver(data, isTrusted) {
      const event = isTrusted === undefined ? { data } : { data, isTrusted };
      for (const fn of [...(listeners.get('message') ?? [])]) fn(event);
    },
  };
  return port;
}

function fakeCanvas() {
  const canvas = {
    paints: [], width: 0, height: 0,
    getContext() {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: (image) => {
          canvas.paints.push({ width: image.width, height: image.height, data: [...image.data] });
        },
      };
    },
  };
  return canvas;
}

function notice(port, surfaceGeneration = 1, surfaceId = 'A') {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE, schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: surfaceId, surface_generation: surfaceGeneration,
    },
    origin: ORIGIN, ports: [port],
  };
}

async function delivery(overrides = {}) {
  const bytes = overrides.bytes ?? new Uint8Array(BYTES_A);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'c1', principal: 'utility',
    epoch: 1, surfaceId: 'A', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'l1',
    width: 1, height: 1, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

function bindTile(router, scheduler, canvas, surfaceId = 'A') {
  scheduler.attachCanvas({ surfaceId, canvas });
  router.bindSurface({
    surfaceId, scheduler,
    onRegistered: (registered) => {
      scheduler.attachCanvas({
        surfaceId: registered.surfaceId,
        surfaceGeneration: registered.surfaceGeneration,
        epoch: registered.epoch, canvas,
      });
    },
  });
}

function deferred() {
  let release = () => {};
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

const ackPairs = (port) => port.acks.map((ack) => [ack.correlation, ack.outcome]);

test('mvui32f: older delivery while a held frame verifies refuses, newer paints', async () => {
  const gate = deferred();
  let digestCalls = 0;
  const target = fakeTarget();
  const router = installFramePortRouter({
    target,
    pendingUnboundMs: 5,
    digestSha256: async (bytes) => {
      digestCalls += 1;
      if (digestCalls === 1) await gate.promise;
      return hexDigest(bytes);
    },
  });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    port.deliver(await delivery({
      correlation: 'held5', frameGeneration: 5, leaseId: 'l5', bytes: new Uint8Array(BYTES_B),
    }));
    await until(() => digestCalls >= 1, 'held expiry verification starts');
    await tick();
    assert.deepEqual(port.acks, [], 'held frame still awaits its digest');
    bindTile(router, scheduler, canvas);
    await tick();
    port.deliver(await delivery({ correlation: 'old3', frameGeneration: 3, leaseId: 'l3' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackPairs(port), [['old3', FRAME_OUTCOMES.REFUSED]]);
    assert.equal(digestCalls, 1, 'older-than-held refuses pre-hash');
    assert.equal(canvas.paints.length, 0, 'older frame never paints');
    gate.release();
    await untilAcks(port, 2);
    assert.deepEqual(ackPairs(port)[1], ['held5', FRAME_OUTCOMES.HIDDEN]);
    await until(() => canvas.paints.length === 1, 'held frame paints after bind');
    assert.deepEqual(canvas.paints[0].data, [...BYTES_B, 255]);
    assert.equal(scheduler.getInstrumentation('A').lastPresentedFrameGen, 5);
    assert.deepEqual(router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 1 });
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui32f: equal delivery while a held frame verifies refuses', async () => {
  const gate = deferred();
  let digestCalls = 0;
  const target = fakeTarget();
  const router = installFramePortRouter({
    target,
    pendingUnboundMs: 5,
    digestSha256: async (bytes) => {
      digestCalls += 1;
      if (digestCalls === 1) await gate.promise;
      return hexDigest(bytes);
    },
  });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    port.deliver(await delivery({
      correlation: 'held5', frameGeneration: 5, leaseId: 'l5', bytes: new Uint8Array(BYTES_B),
    }));
    await until(() => digestCalls >= 1, 'held expiry verification starts');
    await tick();
    bindTile(router, scheduler, canvas);
    await tick();
    port.deliver(await delivery({
      correlation: 'dup5', frameGeneration: 5, leaseId: 'l5b', bytes: new Uint8Array(BYTES_C),
    }));
    await untilAcks(port, 1);
    assert.deepEqual(ackPairs(port), [['dup5', FRAME_OUTCOMES.REFUSED]]);
    assert.equal(digestCalls, 1, 'equal-to-held refuses pre-hash');
    gate.release();
    await untilAcks(port, 2);
    assert.deepEqual(ackPairs(port)[1], ['held5', FRAME_OUTCOMES.HIDDEN]);
    await until(() => canvas.paints.length === 1, 'held frame paints');
    assert.deepEqual(canvas.paints[0].data, [...BYTES_B, 255]);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui32f negative: newer delivery while a held frame verifies presents', async () => {
  const gate = deferred();
  let digestCalls = 0;
  const target = fakeTarget();
  const router = installFramePortRouter({
    target,
    pendingUnboundMs: 5,
    digestSha256: async (bytes) => {
      digestCalls += 1;
      if (digestCalls === 1) await gate.promise;
      return hexDigest(bytes);
    },
  });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    port.deliver(await delivery({
      correlation: 'held5', frameGeneration: 5, leaseId: 'l5', bytes: new Uint8Array(BYTES_B),
    }));
    await until(() => digestCalls >= 1, 'held expiry verification starts');
    await tick();
    bindTile(router, scheduler, canvas);
    await tick();
    port.deliver(await delivery({
      correlation: 'new7', frameGeneration: 7, leaseId: 'l7', bytes: new Uint8Array(BYTES_P),
    }));
    await untilAcks(port, 1);
    assert.deepEqual(ackPairs(port), [['new7', FRAME_OUTCOMES.PRESENTED]]);
    assert.equal(canvas.paints.length, 1);
    assert.deepEqual(canvas.paints[0].data, [...BYTES_P, 255]);
    assert.equal(scheduler.getInstrumentation('A').lastPresentedFrameGen, 7);
    gate.release();
    await untilAcks(port, 2);
    assert.deepEqual(ackPairs(port)[1], ['held5', FRAME_OUTCOMES.SUPERSEDED]);
    assert.equal(canvas.paints.length, 1, 'superseded held frame never paints');
    assert.deepEqual(router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 2 });
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});
