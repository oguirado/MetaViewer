// MVUI14 lane B: stream-id regression. The notice surface_generation is ONLY a
// monotonic stream id (orders/replaces streams per surface); deliveries carry
// their own surfaceGeneration binding which is never compared with the notice
// value. Plain node:test, real tile scheduler, no new dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import installFramePortRouter, {
  FRAME_ACK_SCHEMA,
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

const ORIGIN = 'app://metaviewer';
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function tick() {
  for (let i = 0; i < 5; i += 1) await flush();
}
async function until(condition, label) {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function untilAcks(port, count) {
  await until(() => port.acks.length >= count, `${count} acks`);
}
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
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(event) {
      for (const fn of [...(listeners.get('message') ?? [])]) fn(event);
    },
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
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    deliver(data) {
      for (const fn of [...(listeners.get('message') ?? [])]) fn({ data });
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

function notice(port, surfaceGeneration) {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE,
      schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: 'A',
      surface_generation: surfaceGeneration,
    },
    origin: ORIGIN,
    ports: [port],
  };
}

async function delivery(overrides = {}) {
  const bytes = overrides.bytes ?? new Uint8Array([12, 34, 56]);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA,
    kind: 'frame',
    correlation: 'c1',
    principal: 'utility',
    epoch: 1,
    surfaceId: 'A',
    surfaceGeneration: 1,
    frameGeneration: 1,
    leaseId: 'l1',
    width: 1,
    height: 1,
    format: 'rgb24',
    byteLength: bytes.byteLength,
    sha256,
    pixelSpec: { format: 'rgb24' },
    bytes,
    ...overrides,
  };
}

function setup() {
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: (bytes) => hexDigest(bytes) });
  assert.ok(router, 'router installs on a usable target');
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  scheduler.attachCanvas({ surfaceId: 'A', canvas });
  router.bindSurface({
    surfaceId: 'A',
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
  return { target, router, scheduler, canvas };
}

test('notice stream id 7 with delivery binding 1 PRESENTs and echoes the delivery binding', async () => {
  const { target, router, canvas } = setup();
  const port = browserPort();
  target.emit(notice(port, 7));
  await tick();
  port.deliver(await delivery({ correlation: 's7-f1', leaseId: 'l1' }));
  await untilAcks(port, 1);
  assert.equal(port.acks.length, 1);
  assert.deepEqual(port.acks[0], {
    schema: FRAME_ACK_SCHEMA,
    kind: 'ack',
    correlation: 's7-f1',
    principal: 'utility',
    epoch: 1,
    surfaceId: 'A',
    surfaceGeneration: 1,
    frameGeneration: 1,
    leaseId: 'l1',
    outcome: FRAME_OUTCOMES.PRESENTED,
  });
  assert.equal(canvas.paints.length, 1);
  assert.deepEqual(canvas.paints[0].data, [12, 34, 56, 255]);
  port.deliver(await delivery({ correlation: 's7-f2', frameGeneration: 2, leaseId: 'l2' }));
  await untilAcks(port, 2);
  assert.deepEqual(port.acks.map((ack) => ack.outcome),
    [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 2);
  router.dispose();
});

test('a newer notice stream id replaces and closes the older stream', async () => {
  const { target, router, canvas } = setup();
  const oldPort = browserPort();
  target.emit(notice(oldPort, 7));
  oldPort.deliver(await delivery({ correlation: 'old-live', leaseId: 'l1' }));
  await untilAcks(oldPort, 1);
  assert.deepEqual(oldPort.acks.map((ack) => ack.outcome), [FRAME_OUTCOMES.PRESENTED]);
  const newPort = browserPort();
  target.emit(notice(newPort, 8));
  await tick();
  assert.equal(oldPort.closed, true);
  assert.equal(newPort.closed, false);
  oldPort.deliver(await delivery({ correlation: 'old-late', frameGeneration: 2, leaseId: 'l2' }));
  await tick();
  assert.equal(oldPort.acks.length, 1, 'late arrivals on the retired port are never acked');
  assert.equal(canvas.paints.length, 1, 'late arrivals on the retired port are never painted');
  newPort.deliver(await delivery({ correlation: 'new-live', frameGeneration: 2, leaseId: 'l1n' }));
  await untilAcks(newPort, 1);
  assert.deepEqual(newPort.acks.map((ack) => ack.outcome), [FRAME_OUTCOMES.PRESENTED]);
  assert.equal(newPort.acks[0].surfaceGeneration, 1);
  assert.equal(canvas.paints.length, 2);
  router.dispose();
});

test('negative control: delivery identity altered on the same port is refused', async () => {
  const { target, router, canvas } = setup();
  const port = browserPort();
  target.emit(notice(port, 7));
  port.deliver(await delivery({ correlation: 'pin', frameGeneration: 1, leaseId: 'l1' }));
  await untilAcks(port, 1);
  assert.deepEqual(port.acks.map((ack) => ack.outcome), [FRAME_OUTCOMES.PRESENTED]);
  port.deliver(await delivery({
    correlation: 'altered-binding', surfaceGeneration: 2, frameGeneration: 2, leaseId: 'l2',
  }));
  await untilAcks(port, 2);
  assert.deepEqual(port.acks.map((ack) => ack.outcome),
    [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.REFUSED]);
  assert.deepEqual(port.acks[1].surfaceGeneration, 2, 'the refusal still echoes the delivery');
  assert.equal(canvas.paints.length, 1, 'the refused delivery never paints');
  port.deliver(await delivery({
    correlation: 'altered-principal', principal: 'other', frameGeneration: 3, leaseId: 'l3',
  }));
  await untilAcks(port, 3);
  assert.deepEqual(port.acks.map((ack) => ack.outcome),
    [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.REFUSED, FRAME_OUTCOMES.REFUSED]);
  assert.equal(canvas.paints.length, 1);
  assert.equal(port.closed, false, 'refusals keep the stream open');
  port.deliver(await delivery({ correlation: 'still-live', frameGeneration: 4, leaseId: 'l4' }));
  await untilAcks(port, 4);
  assert.deepEqual(port.acks[3].outcome, FRAME_OUTCOMES.PRESENTED);
  assert.equal(canvas.paints.length, 2);
  router.dispose();
});
