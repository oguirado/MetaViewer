// MVUI32G lane T: negative control for the updated NEW-01 fixed ordering.
// The router exposes no seam to skip the held-verifying fence (it is inline
// in admitDelivery; only the digest and timing are injectable), so per the
// task fallback this replays the NEW-01 scenario with the same helpers the
// mvui26 file uses, and shows the old pinned outcome (older bytes painted)
// is rejected by the updated assertions. Plain node:test; bounded fakes.
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

// Old defective outcome NEW-01 used to pin: the queued older bound
// deliveries painted over the newer held frame (mid-new PRESENTED).
const OLD_ACK_PAIRS = [
  ['held', FRAME_OUTCOMES.HIDDEN],
  ['mid-old', FRAME_OUTCOMES.SUPERSEDED],
  ['mid-new', FRAME_OUTCOMES.PRESENTED],
];
const OLD_PAINT_DATA = [BYTES_B[0], BYTES_B[1], BYTES_B[2], 255];
const OLD_WITNESS_GEN = 885;

const FIXED_ACK_PAIRS = [
  ['mid-old', FRAME_OUTCOMES.REFUSED],
  ['mid-new', FRAME_OUTCOMES.REFUSED],
  ['held', FRAME_OUTCOMES.HIDDEN],
];
const FIXED_PAINT_DATA = [BYTES_A[0], BYTES_A[1], BYTES_A[2], 255];
const FIXED_WITNESS_GEN = 886;

async function hexDigest(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
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

const ackPairs = (port) => port.acks.map((ack) => [ack.correlation, ack.outcome]);

test('mvui32g negative: NEW-01 replay refuses pre-hash, held paints, old outcome absent', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let digestCalls = 0;
  const digest = async (bytes) => {
    digestCalls += 1;
    if (digestCalls === 1) await gate;
    return hexDigest(bytes);
  };
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: digest, pendingUnboundMs: 10 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  try {
    const port = browserPort();
    target.emit(notice(port));
    port.deliver(await delivery({ correlation: 'held', frameGeneration: 886, leaseId: 'held-l' }));
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
      'both older-than-held arrivals refuse pre-hash',
    );
    assert.equal(digestCalls, 1, 'the refused arrivals never reach the digest');
    assert.equal(canvas.paints.length, 0, 'older frames never paint');
    release();
    await untilAcks(port, 3);
    assert.deepEqual(ackPairs(port), FIXED_ACK_PAIRS);
    assert.notDeepEqual(ackPairs(port), OLD_ACK_PAIRS, 'the old defective ack ordering is gone');
    await until(() => canvas.paints.length === 1, 'the held newer frame paints', 2000);
    assert.deepEqual(canvas.paints[0].data, FIXED_PAINT_DATA);
    assert.notDeepEqual(canvas.paints[0].data, OLD_PAINT_DATA, 'older bytes never paint');
    assert.equal(scheduler.getInstrumentation('A').lastPresentedFrameGen, FIXED_WITNESS_GEN);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui32g negative: the updated NEW-01 assertions reject the old pinned outcome', () => {
  assert.throws(
    () => assert.deepEqual(OLD_ACK_PAIRS, FIXED_ACK_PAIRS),
    'the fixed ack ordering rejects the old HIDDEN/SUPERSEDED/PRESENTED triple',
  );
  assert.throws(
    () => assert.deepEqual(OLD_PAINT_DATA, FIXED_PAINT_DATA),
    'the fixed paint assertion rejects the older mid-new bytes',
  );
  assert.throws(
    () => assert.equal(OLD_WITNESS_GEN, FIXED_WITNESS_GEN),
    'the fixed witness rejects the old presented generation',
  );
});
