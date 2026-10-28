// MVUI26 lane F: expiring held delivery vs newer arrivals, and retained
// drain ordering. RV10-01 (PARTIAL/LOW): only the confirmed sub-claim — a
// newer arrival while an older delivery awaits expiry verification must
// settle the older record SUPERSEDED immediately. NEW-01 (LOW):
// drainRetained must not supersede queued work with an older kept frame.
// Plain node:test; bounded fakes (1x1 frames, single-digit deliveries).
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

const ORIGIN = 'app://test-shell';
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
const BYTES_A = [12, 34, 56];
const BYTES_B = [200, 201, 202];

async function hexDigest(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const realDigest = (bytes) => hexDigest(bytes);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function browserPort() {
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
    deliver(data) { for (const fn of [...(listeners.get('message') ?? [])]) fn({ data }); },
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
  const bytes = overrides.bytes ?? new Uint8Array(BYTES_A);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'c1', principal: 'utility',
    epoch: 1, surfaceId: 'A', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'l1',
    width: 1, height: 1, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

// SurfaceCanvas-equivalent binding: the first attach fails while the surface
// is unregistered; the router's registration notice retries it.
function bindTile(router, scheduler, canvas, surfaceId = 'A') {
  const first = scheduler.attachCanvas({ surfaceId, canvas });
  router.bindSurface({
    surfaceId,
    scheduler,
    onRegistered: (registered) => {
      scheduler.attachCanvas({
        surfaceId: registered.surfaceId,
        surfaceGeneration: registered.surfaceGeneration,
        epoch: registered.epoch,
        canvas,
      });
    },
  });
  return first;
}

function deferredDigest() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    digest: async (bytes) => {
      await gate;
      return hexDigest(bytes);
    },
    release: () => release(),
  };
}

const ackPairs = (port) => port.acks.map((ack) => [ack.correlation, ack.outcome]);

test('RV10-01: expiring settles SUPERSEDED synchronously when newer delivery arrives', async () => {
  const deferred = deferredDigest();
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: deferred.digest, pendingUnboundMs: 10 });
  try {
    const port = browserPort();
    target.emit(notice(port));
    port.deliver(await delivery({ correlation: 'old', frameGeneration: 886, leaseId: 'old-l' }));
    // The expiry window (10 ms) elapses while verification blocks on the gate.
    await sleep(60);
    await tick();
    assert.deepEqual(port.acks, [], 'the older delivery still awaits its digest');
    port.deliver(await delivery({ correlation: 'new', frameGeneration: 887, leaseId: 'new-l' }));
    await tick();
    assert.deepEqual(
      ackPairs(port),
      [['old', FRAME_OUTCOMES.SUPERSEDED]],
      'the newer arrival settles the older record before the digest resolves',
    );
    deferred.release();
    await tick();
    assert.deepEqual(
      ackPairs(port),
      [['old', FRAME_OUTCOMES.SUPERSEDED]],
      'the late completion never settles the older record twice; the newer one stays held',
    );
  } finally {
    router.dispose();
  }
});

test('NEW-01: older bound arrivals refuse pre-hash while a held frame verifies', async () => {
  // Fixed ordering (MVUI32F held-verifying fence): the held delivery at
  // generation 886 expires with a blocked digest, the tile binds, and two
  // bound arrivals follow, both below the held generation. Each
  // at-or-below-held arrival refuses pre-hash (no digest, no paint); the
  // held frame hides once its digest resolves, then paints as the retained
  // frame. An older frame can never paint after the newer held one was
  // accepted.
  const deferred = deferredDigest();
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: deferred.digest, pendingUnboundMs: 10 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    const port = browserPort();
    target.emit(notice(port));
    port.deliver(await delivery({ correlation: 'held', frameGeneration: 886, leaseId: 'held-l' }));
    // The expiry window (10 ms) elapses while verification blocks on the gate.
    await sleep(60);
    await tick();
    assert.deepEqual(port.acks, [], 'the expired delivery still awaits its digest');
    bindTile(router, scheduler, canvas);
    port.deliver(await delivery({
      correlation: 'mid-old', frameGeneration: 884, leaseId: 'mid-old-l',
      bytes: new Uint8Array(BYTES_A),
    }));
    port.deliver(await delivery({
      correlation: 'mid-new', frameGeneration: 885, leaseId: 'mid-new-l',
      bytes: new Uint8Array(BYTES_B),
    }));
    await tick();
    assert.deepEqual(
      ackPairs(port),
      [
        ['mid-old', FRAME_OUTCOMES.REFUSED],
        ['mid-new', FRAME_OUTCOMES.REFUSED],
      ],
      'both older-than-held arrivals refuse pre-hash without disturbing the live verification',
    );
    deferred.release();
    await untilAcks(port, 3);
    assert.deepEqual(
      ackPairs(port),
      [
        ['mid-old', FRAME_OUTCOMES.REFUSED],
        ['mid-new', FRAME_OUTCOMES.REFUSED],
        ['held', FRAME_OUTCOMES.HIDDEN],
      ],
      'the held newer frame hides once verified; the refused older frames never paint',
    );
    await until(() => canvas.paints.length === 1, 'the held newer frame paints', 2000);
    assert.deepEqual(canvas.paints[0].data, [BYTES_A[0], BYTES_A[1], BYTES_A[2], 255]);
    assert.equal(scheduler.getInstrumentation('A').lastPresentedFrameGen, 886);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('RV10-01 negative control: older arrival during verification refuses and expiring stays live', async () => {
  const deferred = deferredDigest();
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: deferred.digest, pendingUnboundMs: 10 });
  try {
    const port = browserPort();
    target.emit(notice(port));
    port.deliver(await delivery({ correlation: 'old', frameGeneration: 886, leaseId: 'old-l' }));
    // The expiry window (10 ms) elapses while verification blocks on the gate.
    await sleep(60);
    await tick();
    assert.deepEqual(port.acks, [], 'the older delivery still awaits its digest');
    port.deliver(await delivery({ correlation: 'older', frameGeneration: 885, leaseId: 'older-l' }));
    await tick();
    assert.deepEqual(
      ackPairs(port),
      [['older', FRAME_OUTCOMES.REFUSED]],
      'the duplicate/older arrival refuses without disturbing the live verification',
    );
    deferred.release();
    await untilAcks(port, 2);
    assert.deepEqual(
      ackPairs(port),
      [['older', FRAME_OUTCOMES.REFUSED], ['old', FRAME_OUTCOMES.HIDDEN]],
      'the verified delivery still hides once its digest resolves',
    );
  } finally {
    router.dispose();
  }
});

test('NEW-01 negative control: idle retained drain still paints kept with no second ack', async () => {
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: realDigest, pendingUnboundMs: 10 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    const port = browserPort();
    target.emit(notice(port));
    port.deliver(await delivery({ correlation: 'kept', frameGeneration: 886, leaseId: 'kept-l' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackPairs(port), [['kept', FRAME_OUTCOMES.HIDDEN]]);
    bindTile(router, scheduler, canvas);
    await until(() => canvas.paints.length === 1, 'kept bytes paint after late bind', 2000);
    await tick();
    assert.deepEqual(ackPairs(port), [['kept', FRAME_OUTCOMES.HIDDEN]], 'no second ack on the late paint');
    assert.deepEqual(canvas.paints[0].data, [BYTES_A[0], BYTES_A[1], BYTES_A[2], 255]);
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedFrameGen, 886);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});
