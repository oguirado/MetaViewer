/**
 * MVUI32 lane F: rehash counters (rehashSkipped/rehashDone) and the throttled
 * frames.reportDiag reporter. Counter tests use the real router + scheduler;
 * reporter tests build against a test double with a fake clock and fake
 * timers (no sleeps, no sockets). Every behaviour has a negative control.
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

async function hexDigest(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

function notice(port) {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE, schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: 'A', surface_generation: 1,
    },
    origin: ORIGIN, ports: [port],
  };
}

async function delivery(overrides = {}) {
  const bytes = overrides.bytes ?? new Uint8Array([12, 34, 56]);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: `c${overrides.frameGeneration ?? 1}`,
    principal: 'utility', epoch: 1, surfaceId: 'A', surfaceGeneration: 1, frameGeneration: 1,
    leaseId: `l${overrides.frameGeneration ?? 1}`, width: 1, height: 1, format: 'rgb24',
    byteLength: bytes.byteLength, sha256, pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

function bindTile(router, scheduler, canvas) {
  scheduler.attachCanvas({ surfaceId: 'A', canvas });
  router.bindSurface({
    surfaceId: 'A', scheduler,
    onRegistered: (registered) => {
      scheduler.attachCanvas({
        surfaceId: registered.surfaceId,
        surfaceGeneration: registered.surfaceGeneration,
        epoch: registered.epoch, canvas,
      });
    },
  });
}

function setupRouter(options = {}) {
  const target = fakeTarget();
  const digestCalls = [];
  const router = installFramePortRouter({
    target,
    digestSha256: async (bytes) => {
      digestCalls.push(bytes.byteLength);
      return hexDigest(bytes);
    },
    ...options,
  });
  assert.ok(router);
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  const port = trustedPort();
  target.emit(notice(port));
  return { target, router, scheduler, canvas, port, digestCalls };
}

test('rehash: legacy delivery increments only rehashDone', async () => {
  const ctx = setupRouter();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 0 });
    ctx.port.deliver(await delivery({ frameGeneration: 1 }), true);
    await untilAcks(ctx.port, 1);
    assert.equal(ctx.port.acks[0].outcome, FRAME_OUTCOMES.PRESENTED);
    assert.equal(ctx.digestCalls.length, 1);
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 1 });
  } finally {
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
});

test('rehash: forged marker increments rehashDone, never skipped', async () => {
  const ctx = setupRouter();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    ctx.port.deliver(await delivery({ frameGeneration: 1, utilityVerified: 1 }), true);
    await untilAcks(ctx.port, 1);
    assert.equal(ctx.digestCalls.length, 1);
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 1 });
  } finally {
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
});

test('rehash: valid marker increments rehashSkipped, never done', async () => {
  const ctx = setupRouter();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    ctx.port.deliver(await delivery({ frameGeneration: 1, utilityVerified: true }), true);
    await untilAcks(ctx.port, 1);
    assert.equal(ctx.port.acks[0].outcome, FRAME_OUTCOMES.PRESENTED);
    assert.equal(ctx.digestCalls.length, 0);
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 1, rehashDone: 0 });
  } finally {
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
});

test('rehash negative: valid marker on an untrusted event hashes (done)', async () => {
  const ctx = setupRouter();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    ctx.port.deliver(await delivery({ frameGeneration: 1, utilityVerified: true }), false);
    await untilAcks(ctx.port, 1);
    assert.equal(ctx.digestCalls.length, 1);
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 1 });
  } finally {
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
});

test('rehash negative: shape-refused delivery increments neither counter', async () => {
  const ctx = setupRouter();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    const evil = await delivery({ frameGeneration: 1, utilityVerified: true });
    evil.extraField = true;
    ctx.port.deliver(evil, true);
    await untilAcks(ctx.port, 1);
    assert.equal(ctx.port.acks[0].outcome, FRAME_OUTCOMES.REFUSED);
    assert.equal(ctx.digestCalls.length, 0);
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 0 });
  } finally {
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
});

test('rehash: snapshot is frozen with exactly the two counter keys', async () => {
  const ctx = setupRouter();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    ctx.port.deliver(await delivery({ frameGeneration: 1, utilityVerified: true }), true);
    await untilAcks(ctx.port, 1);
    const diag = ctx.router.getRehashDiag();
    assert.ok(Object.isFrozen(diag));
    assert.deepEqual(Object.keys(diag).sort(), ['rehashDone', 'rehashSkipped']);
    assert.ok(Number.isSafeInteger(diag.rehashSkipped) && diag.rehashSkipped >= 0);
    assert.ok(Number.isSafeInteger(diag.rehashDone) && diag.rehashDone >= 0);
  } finally {
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
});

test('rehash: held delivery counts once across expiry verify and retained paint', async () => {
  const ctx = setupRouter({ pendingUnboundMs: 10 });
  try {
    ctx.port.deliver(await delivery({ frameGeneration: 1 }), true);
    await untilAcks(ctx.port, 1);
    assert.equal(ctx.port.acks[0].outcome, FRAME_OUTCOMES.HIDDEN);
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 1 });
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    await until(() => ctx.canvas.paints.length === 1, 'retained frame paints');
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 1 });
  } finally {
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
});

test('rehash: onRehashDiag notifies with the frozen snapshot then unsubscribes', async () => {
  const ctx = setupRouter();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    const seen = [];
    const stop = ctx.router.onRehashDiag((diag) => seen.push({ ...diag }));
    ctx.port.deliver(await delivery({ frameGeneration: 1 }), true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(seen, [{ rehashSkipped: 0, rehashDone: 1 }]);
    stop();
    ctx.port.deliver(await delivery({ frameGeneration: 2, bytes: new Uint8Array([9, 9, 9]) }), true);
    await untilAcks(ctx.port, 2);
    assert.deepEqual(seen.length, 1, 'no notify after unsubscribe');
    assert.deepEqual(ctx.router.getRehashDiag(), { rehashSkipped: 0, rehashDone: 2 });
  } finally {
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
});

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

function facadeDouble() {
  return {
    reports: [],
    attempts: 0,
    reportDiag(payload) {
      this.attempts += 1;
      this.reports.push(payload);
      return true;
    },
  };
}

test('reportDiag: no report without change, including on dispose', () => {
  const router = diagDouble();
  const facade = facadeDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  reporter.dispose();
  assert.deepEqual(facade.reports, []);
  assert.equal(timers.pending.size, 0);
});

test('reportDiag: exactly one plain object with the two cumulative keys', () => {
  const router = diagDouble();
  const facade = facadeDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  try {
    router.set(2, 3);
    assert.equal(facade.reports.length, 1);
    assert.deepEqual(Object.keys(facade.reports[0]).sort(), ['rehashDone', 'rehashSkipped']);
    assert.deepEqual(facade.reports[0], { rehashSkipped: 2, rehashDone: 3 });
    assert.equal(Object.getPrototypeOf(facade.reports[0]), Object.prototype);
  } finally {
    reporter.dispose();
  }
});

test('reportDiag: throttle collapses rapid changes to one trailing report', () => {
  const router = diagDouble();
  const facade = facadeDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  try {
    router.set(0, 1);
    assert.equal(facade.reports.length, 1);
    router.set(1, 1);
    router.set(1, 2);
    assert.equal(facade.reports.length, 1, 'throttled changes do not report yet');
    assert.equal(timers.pending.size, 1, 'one trailing timer');
    clock.advance(1000);
    timers.fireAll();
    assert.equal(facade.reports.length, 2);
    assert.deepEqual(facade.reports[1], { rehashSkipped: 1, rehashDone: 2 });
    assert.equal(timers.pending.size, 0);
  } finally {
    reporter.dispose();
  }
});

test('reportDiag: dispose flushes one pending change and then detaches', () => {
  const router = diagDouble();
  const facade = facadeDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const reporter = createRehashDiagReporter(router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  router.set(0, 1);
  assert.equal(facade.reports.length, 1);
  router.set(0, 2);
  assert.equal(facade.reports.length, 1);
  reporter.dispose();
  assert.equal(facade.reports.length, 2);
  assert.deepEqual(facade.reports[1], { rehashSkipped: 0, rehashDone: 2 });
  router.set(0, 3);
  timers.fireAll();
  assert.equal(facade.reports.length, 2, 'detached: no report after dispose');
});

test('reportDiag negative: missing facade is silent', () => {
  const router = diagDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  for (const getFacade of [() => null, () => undefined, () => ({}), () => { throw new Error('gone'); }]) {
    const reporter = createRehashDiagReporter(router, {
      getFacade, now: clock.get,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    assert.ok(reporter);
    router.set(0, 1);
    reporter.dispose();
  }
});

test('reportDiag negative: throw and refusal are silent', () => {
  const router = diagDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const throwing = { reportDiag() { throw new Error('host down'); } };
  const refusing = { reportDiag() { return false; } };
  for (const facade of [throwing, refusing]) {
    const reporter = createRehashDiagReporter(router, {
      getFacade: () => facade, now: clock.get,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    assert.ok(reporter);
    router.set(0, 1);
    clock.advance(1000);
    timers.fireAll();
    reporter.dispose();
  }
});

test('reportDiag: invalid router returns null', () => {
  assert.equal(createRehashDiagReporter(null), null);
  assert.equal(createRehashDiagReporter({}), null);
  assert.equal(createRehashDiagReporter({ getRehashDiag() { return {}; } }), null);
});

test('reportDiag integration: real router reports cumulative totals throttled', async () => {
  const ctx = setupRouter();
  const facade = facadeDouble();
  const clock = fakeClock();
  const timers = fakeTimers();
  const reporter = createRehashDiagReporter(ctx.router, {
    getFacade: () => facade, now: clock.get,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.ok(reporter);
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    ctx.port.deliver(await delivery({ frameGeneration: 1 }), true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(facade.reports, [{ rehashSkipped: 0, rehashDone: 1 }]);
    ctx.port.deliver(await delivery({ frameGeneration: 2, utilityVerified: true }), true);
    await untilAcks(ctx.port, 2);
    assert.equal(facade.reports.length, 1, 'second change throttled at the same instant');
    clock.advance(1000);
    timers.fireAll();
    assert.deepEqual(facade.reports[1], { rehashSkipped: 1, rehashDone: 1 });
  } finally {
    reporter.dispose();
    ctx.router.dispose();
    ctx.scheduler.destroy();
  }
  assert.equal(facade.reports.length, 2, 'dispose adds nothing once caught up');
});
