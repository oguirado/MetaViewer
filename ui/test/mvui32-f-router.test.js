/**
 * MVUI32 lane F: R3-FRAMES-1 router floor, superseded repaint, retired stream
 * ids. Real tile scheduler, controllable digest gates, short hold windows
 * with wall-clock-bounded waits (no fixed sleeps, no sockets). Every
 * behaviour has a negative control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import installFramePortRouter, {
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
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
const BYTES_D = [41, 42, 43];

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

function countingDigest() {
  const calls = [];
  return {
    calls,
    digest: async (bytes) => {
      calls.push(bytes.byteLength);
      return hexDigest(bytes);
    },
  };
}

function deferred() {
  let release = () => {};
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

const ackPairs = (port) => port.acks.map((ack) => [ack.correlation, ack.outcome]);

test('R3-07: bad digest at N+1 refuses, then a valid retransmit presents', async () => {
  const counter = countingDigest();
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: counter.digest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    bindTile(router, scheduler, canvas);
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    port.deliver(await delivery({ correlation: 'g1', frameGeneration: 1, leaseId: 'l1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackPairs(port), [['g1', FRAME_OUTCOMES.PRESENTED]]);
    port.deliver(await delivery({
      correlation: 'g2-bad', frameGeneration: 2, leaseId: 'l2',
      bytes: new Uint8Array(BYTES_B), sha256: 'f'.repeat(64),
    }));
    await untilAcks(port, 2);
    assert.deepEqual(ackPairs(port)[1], ['g2-bad', FRAME_OUTCOMES.REFUSED]);
    assert.equal(canvas.paints.length, 1);
    port.deliver(await delivery({
      correlation: 'g2-retry', frameGeneration: 2, leaseId: 'l2b',
      bytes: new Uint8Array(BYTES_B),
    }));
    await untilAcks(port, 3);
    assert.deepEqual(ackPairs(port)[2], ['g2-retry', FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 2);
    assert.deepEqual(canvas.paints[1].data, [...BYTES_B, 255]);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R3-07: bad digest at MAX_SAFE_INTEGER refuses, then a valid g2 presents', async () => {
  const counter = countingDigest();
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: counter.digest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    bindTile(router, scheduler, canvas);
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    port.deliver(await delivery({ correlation: 'g1', frameGeneration: 1, leaseId: 'l1' }));
    await untilAcks(port, 1);
    port.deliver(await delivery({
      correlation: 'gmax-bad', frameGeneration: Number.MAX_SAFE_INTEGER, leaseId: 'lmax',
      bytes: new Uint8Array(BYTES_C), sha256: 'e'.repeat(64),
    }));
    await untilAcks(port, 2);
    assert.deepEqual(ackPairs(port)[1], ['gmax-bad', FRAME_OUTCOMES.REFUSED]);
    assert.equal(canvas.paints.length, 1);
    port.deliver(await delivery({
      correlation: 'g2', frameGeneration: 2, leaseId: 'l2',
      bytes: new Uint8Array(BYTES_B),
    }));
    await untilAcks(port, 3);
    assert.deepEqual(ackPairs(port)[2], ['g2', FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 2);
    assert.equal(scheduler.getInstrumentation('A').lastPresentedFrameGen, 2);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R3-07 negative: in-order g1,g2 present; older g1 after g2 refuses', async () => {
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: (bytes) => hexDigest(bytes) });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    bindTile(router, scheduler, canvas);
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    const f1 = await delivery({ correlation: 'g1', frameGeneration: 1, leaseId: 'l1' });
    const f2 = await delivery({
      correlation: 'g2', frameGeneration: 2, leaseId: 'l2', bytes: new Uint8Array(BYTES_B),
    });
    port.deliver(f1);
    port.deliver(f2);
    await untilAcks(port, 2);
    // Back-to-back newest-only: g1 superseded, g2 presented.
    assert.deepEqual(ackPairs(port), [
      ['g1', FRAME_OUTCOMES.SUPERSEDED], ['g2', FRAME_OUTCOMES.PRESENTED],
    ]);
    assert.equal(canvas.paints.length, 1);
    port.deliver(await delivery({ correlation: 'g1-late', frameGeneration: 1, leaseId: 'l1b' }));
    await untilAcks(port, 3);
    assert.deepEqual(ackPairs(port)[2], ['g1-late', FRAME_OUTCOMES.REFUSED]);
    assert.equal(canvas.paints.length, 1);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R3-07 negative: sequential in-order g1 then g2 both present', async () => {
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: (bytes) => hexDigest(bytes) });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    bindTile(router, scheduler, canvas);
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    port.deliver(await delivery({ correlation: 'g1', frameGeneration: 1, leaseId: 'l1' }));
    await untilAcks(port, 1);
    port.deliver(await delivery({
      correlation: 'g2', frameGeneration: 2, leaseId: 'l2', bytes: new Uint8Array(BYTES_B),
    }));
    await untilAcks(port, 2);
    assert.deepEqual(ackPairs(port), [
      ['g1', FRAME_OUTCOMES.PRESENTED], ['g2', FRAME_OUTCOMES.PRESENTED],
    ]);
    assert.equal(canvas.paints.length, 2);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R3-07 negative: older arrival while a newer record validates refuses', async () => {
  const gate = deferred();
  const target = fakeTarget();
  const router = installFramePortRouter({
    target,
    digestSha256: async (bytes) => {
      await gate.promise;
      return hexDigest(bytes);
    },
  });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    bindTile(router, scheduler, canvas);
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    port.deliver(await delivery({
      correlation: 'new', frameGeneration: 2, leaseId: 'l2', bytes: new Uint8Array(BYTES_B),
    }));
    await tick();
    port.deliver(await delivery({ correlation: 'old', frameGeneration: 1, leaseId: 'l1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackPairs(port), [['old', FRAME_OUTCOMES.REFUSED]]);
    gate.release();
    await untilAcks(port, 2);
    assert.deepEqual(ackPairs(port)[1], ['new', FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    assert.deepEqual(canvas.paints[0].data, [...BYTES_B, 255]);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R3-05: dual expiry settles g1 SUPERSEDED; H1 then H2 paints only g2', async () => {
  const h1 = deferred();
  const h2 = deferred();
  const digestCalls = [];
  const target = fakeTarget();
  const router = installFramePortRouter({
    target,
    pendingUnboundMs: 10,
    digestSha256: async (bytes) => {
      const index = digestCalls.length;
      digestCalls.push(bytes.byteLength);
      await (index === 0 ? h1.promise : h2.promise);
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
      correlation: 'g1', frameGeneration: 1, leaseId: 'l1', bytes: new Uint8Array(BYTES_A),
    }));
    await until(() => digestCalls.length >= 1, 'g1 expiry verification starts');
    await tick();
    assert.deepEqual(port.acks, [], 'g1 still awaits its digest');
    port.deliver(await delivery({
      correlation: 'g2', frameGeneration: 2, leaseId: 'l2', bytes: new Uint8Array(BYTES_B),
    }));
    await tick();
    assert.deepEqual(ackPairs(port), [['g1', FRAME_OUTCOMES.SUPERSEDED]]);
    await until(() => digestCalls.length >= 2, 'g2 expiry verification starts');
    bindTile(router, scheduler, canvas);
    await tick();
    h1.release();
    await tick();
    await tick();
    assert.deepEqual(ackPairs(port), [['g1', FRAME_OUTCOMES.SUPERSEDED]], 'g1 never re-acks');
    assert.equal(canvas.paints.length, 0, 'g1 never paints');
    h2.release();
    await untilAcks(port, 2);
    assert.deepEqual(ackPairs(port), [
      ['g1', FRAME_OUTCOMES.SUPERSEDED], ['g2', FRAME_OUTCOMES.HIDDEN],
    ]);
    await until(() => canvas.paints.length === 1, 'g2 paints after bind');
    assert.deepEqual(canvas.paints[0].data, [...BYTES_B, 255]);
    assert.equal(scheduler.getInstrumentation('A').lastPresentedFrameGen, 2);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R3-05 negative: single expiry still hides and paints on bind', async () => {
  const target = fakeTarget();
  const router = installFramePortRouter({
    target, digestSha256: (bytes) => hexDigest(bytes), pendingUnboundMs: 10,
  });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    const port = trustedPort();
    target.emit(notice(port, 1));
    await tick();
    port.deliver(await delivery({ correlation: 'solo', frameGeneration: 1, leaseId: 'l1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackPairs(port), [['solo', FRAME_OUTCOMES.HIDDEN]]);
    bindTile(router, scheduler, canvas);
    await until(() => canvas.paints.length === 1, 'kept frame paints');
    assert.deepEqual(port.acks.length, 1, 'no second ack');
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R3-06: retired stream 1 refuses after stream 2 closes; stream 3 paints', async () => {
  const counter = countingDigest();
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: counter.digest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    bindTile(router, scheduler, canvas);
    const live = trustedPort();
    target.emit(notice(live, 2));
    await tick();
    live.deliver(await delivery({ correlation: 's2-g1', frameGeneration: 1, leaseId: 'l1' }));
    await untilAcks(live, 1);
    assert.deepEqual(ackPairs(live), [['s2-g1', FRAME_OUTCOMES.PRESENTED]]);
    assert.equal(canvas.paints.length, 1);
    assert.equal(counter.calls.length, 1);
    router.unbindSurface('A');
    await tick();
    assert.deepEqual(router.getSurfaceStatus(), []);
    assert.equal(live.closed, true);
    bindTile(router, scheduler, canvas);
    const stale = trustedPort();
    target.emit(notice(stale, 1));
    await tick();
    assert.equal(stale.closed, true, 'retired stream id refuses before adoption');
    assert.equal(router.getSurfaceStatus('A'), null, 'no entry for the refused stream');
    stale.deliver(await delivery({ correlation: 's1-late', frameGeneration: 9, leaseId: 'l9' }));
    await tick();
    assert.deepEqual(stale.acks, []);
    assert.equal(canvas.paints.length, 1, 'zero scheduler paints for the refused stream');
    assert.equal(counter.calls.length, 1, 'the refused stream never hashes');
    const next = trustedPort();
    target.emit(notice(next, 3));
    await tick();
    assert.equal(next.closed, false);
    assert.equal(router.getSurfaceStatus('A').surfaceGeneration, 3);
    next.deliver(await delivery({
      correlation: 's3-g2', frameGeneration: 2, leaseId: 'l2', bytes: new Uint8Array(BYTES_B),
    }));
    await untilAcks(next, 1);
    assert.deepEqual(ackPairs(next), [['s3-g2', FRAME_OUTCOMES.PRESENTED]]);
    assert.equal(canvas.paints.length, 2);
    assert.deepEqual(canvas.paints[1].data, [...BYTES_B, 255]);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R3-06 negative: same stream id while live is ignored', async () => {
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: (bytes) => hexDigest(bytes) });
  try {
    const first = trustedPort();
    target.emit(notice(first, 2));
    await tick();
    assert.equal(first.closed, false);
    const spare = trustedPort();
    target.emit(notice(spare, 2));
    await tick();
    assert.equal(spare.closed, true);
    assert.equal(first.closed, false);
    assert.equal(router.getSurfaceStatus('A').surfaceGeneration, 2);
  } finally {
    router.dispose();
  }
});
