/**
 * MVUI31 lane P: the renderer skips its re-hash only for deliveries carrying
 * the host-set utilityVerified marker on a trusted port event. The marker
 * arrives via test double (the host owner has not sent it yet); without a
 * valid marker every behaviour is unchanged. Plain node:test, fake window
 * target, fake ports, fake canvas, and the REAL tile scheduler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import installFramePortRouter, {
  FRAME_DELIVERY_MARKER_KEY,
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { until, untilAcks } from './frame-wait.mjs';

const ORIGIN = 'app://metaviewer';
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});

async function hexDigest(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fakeTarget(origin = ORIGIN) {
  const listeners = new Map();
  return {
    location: { origin },
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
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
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

function notice(port, overrides = {}) {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE,
      schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: 'A',
      surface_generation: 1,
      ...overrides,
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
    correlation: `c${overrides.frameGeneration ?? 1}`,
    principal: 'utility',
    epoch: 1,
    surfaceId: 'A',
    surfaceGeneration: 1,
    frameGeneration: 1,
    leaseId: `l${overrides.frameGeneration ?? 1}`,
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

function bindTile(router, scheduler, canvas, surfaceId = 'A') {
  scheduler.attachCanvas({ surfaceId, canvas });
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
}

function setup(options = {}) {
  const target = fakeTarget();
  const digestCalls = [];
  const digestSha256 = async (bytes) => {
    digestCalls.push(bytes.byteLength);
    if (options.digestImpl) return options.digestImpl(bytes);
    return hexDigest(bytes);
  };
  const router = installFramePortRouter({ target, digestSha256, ...options.routerOptions });
  assert.ok(router, 'router installs on a usable target');
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  const port = trustedPort();
  target.emit(notice(port));
  return { target, router, scheduler, canvas, port, digestCalls };
}

function teardown(ctx) {
  ctx.router.dispose();
  ctx.scheduler.destroy();
}

function ackOutcomes(port) {
  return port.acks.map((ack) => ack.outcome);
}

test('mvui31 marker contract: the marker key is pinned and exported', () => {
  assert.equal(FRAME_DELIVERY_MARKER_KEY, 'utilityVerified');
});

test('mvui31 marker + trusted event paints with zero digests', async () => {
  const ctx = setup();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    const marker = await delivery({ frameGeneration: 1, utilityVerified: true });
    assert.equal(Object.keys(marker).length, 17);
    ctx.port.deliver(marker, true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(ctx.digestCalls.length, 0);
    assert.equal(ctx.canvas.paints.length, 1);
    assert.deepEqual(ctx.canvas.paints[0].data.slice(0, 4), [12, 34, 56, 255]);
  } finally {
    teardown(ctx);
  }
});

test('mvui31 marker + trusted event skips even a mismatched digest (host-verified)', async () => {
  const ctx = setup();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    const claimed = await delivery({ frameGeneration: 1 });
    const tampered = new Uint8Array([200, 201, 202]);
    assert.notDeepEqual(await hexDigest(tampered), claimed.sha256);
    ctx.port.deliver(await delivery({
      frameGeneration: 1, bytes: tampered, sha256: claimed.sha256, utilityVerified: true,
    }), true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(ctx.digestCalls.length, 0);
    assert.equal(ctx.canvas.paints.length, 1);
    assert.deepEqual(ctx.canvas.paints[0].data.slice(0, 4), [200, 201, 202, 255]);
  } finally {
    teardown(ctx);
  }
});

test('mvui31 legacy delivery still hashes: match paints, mismatch never paints', async () => {
  const ctx = setup();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    ctx.port.deliver(await delivery({ frameGeneration: 1 }), true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(ctx.digestCalls.length, 1);
    const claimed = await delivery({ frameGeneration: 2 });
    ctx.port.deliver(await delivery({
      frameGeneration: 2, bytes: new Uint8Array([9, 9, 9]), sha256: claimed.sha256,
    }), true);
    await untilAcks(ctx.port, 2);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.REFUSED]);
    assert.equal(ctx.digestCalls.length, 2);
    assert.equal(ctx.canvas.paints.length, 1);
  } finally {
    teardown(ctx);
  }
});

test('mvui31 malformed markers are treated as absent and hash', async () => {
  const ctx = setup();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    const malformed = [1, 'true', 0, null, {}, []];
    let gen = 0;
    for (const value of malformed) {
      gen += 1;
      const claimed = await delivery({ frameGeneration: gen });
      ctx.port.deliver(await delivery({
        frameGeneration: gen,
        bytes: new Uint8Array([gen, gen + 1, gen + 2]),
        sha256: claimed.sha256,
        utilityVerified: value,
      }), true);
      await untilAcks(ctx.port, gen);
    }
    assert.deepEqual(ackOutcomes(ctx.port), Array(malformed.length).fill(FRAME_OUTCOMES.REFUSED));
    assert.ok(ctx.digestCalls.length >= malformed.length);
    assert.equal(ctx.canvas.paints.length, 0);
  } finally {
    teardown(ctx);
  }
});

test('mvui31 marker on an untrusted event falls back to the digest', async () => {
  const ctx = setup();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    const claimed = await delivery({ frameGeneration: 1 });
    ctx.port.deliver(await delivery({
      frameGeneration: 1, bytes: new Uint8Array([7, 8, 9]), sha256: claimed.sha256, utilityVerified: true,
    }), false);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.REFUSED]);
    assert.equal(ctx.digestCalls.length, 1);
    assert.equal(ctx.canvas.paints.length, 0);
    ctx.port.deliver(await delivery({ frameGeneration: 2, utilityVerified: true }));
    await untilAcks(ctx.port, 2);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.REFUSED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(ctx.digestCalls.length, 2);
    assert.equal(ctx.canvas.paints.length, 1);
  } finally {
    teardown(ctx);
  }
});

test('mvui31 marker does not weaken shape, generation, or identity checks', async () => {
  const ctx = setup();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    ctx.port.deliver(await delivery({ frameGeneration: 1, utilityVerified: true }), true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.PRESENTED]);
    ctx.port.deliver(await delivery({ frameGeneration: 2, surfaceId: 'B', utilityVerified: true }), true);
    ctx.port.deliver(await delivery({ frameGeneration: 1, utilityVerified: true }), true);
    const short = new Uint8Array([1, 2]);
    ctx.port.deliver(await delivery({
      frameGeneration: 3, bytes: short, byteLength: 2, utilityVerified: true,
    }), true);
    await untilAcks(ctx.port, 4);
    assert.deepEqual(ackOutcomes(ctx.port), [
      FRAME_OUTCOMES.PRESENTED,
      FRAME_OUTCOMES.REFUSED,
      FRAME_OUTCOMES.REFUSED,
      FRAME_OUTCOMES.REFUSED,
    ]);
    assert.equal(ctx.canvas.paints.length, 1);
  } finally {
    teardown(ctx);
  }
});

test('mvui31 unknown extra keys still refuse with the marker present', async () => {
  const ctx = setup();
  try {
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    const evil = await delivery({ frameGeneration: 1, utilityVerified: true });
    evil.extraField = true;
    ctx.port.deliver(evil, true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.REFUSED]);
    assert.equal(ctx.digestCalls.length, 0);
    assert.equal(ctx.canvas.paints.length, 0);
  } finally {
    teardown(ctx);
  }
});

test('mvui31 PRESENTED still requires the scheduler witness under the marker', async () => {
  const ctx = setup();
  try {
    ctx.router.bindSurface({ surfaceId: 'A', scheduler: ctx.scheduler });
    ctx.port.deliver(await delivery({ frameGeneration: 1, utilityVerified: true }), true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.REFUSED]);
    assert.equal(ctx.digestCalls.length, 0);
    assert.equal(ctx.canvas.paints.length, 0);
  } finally {
    teardown(ctx);
  }
});

test('mvui31 held marker delivery verifies without a digest and paints on bind', async () => {
  const ctx = setup({ routerOptions: { pendingUnboundMs: 30 } });
  try {
    ctx.port.deliver(await delivery({ frameGeneration: 1, utilityVerified: true }), true);
    await untilAcks(ctx.port, 1);
    assert.deepEqual(ackOutcomes(ctx.port), [FRAME_OUTCOMES.HIDDEN]);
    assert.equal(ctx.digestCalls.length, 0);
    bindTile(ctx.router, ctx.scheduler, ctx.canvas);
    await until(() => ctx.canvas.paints.length === 1, 'retained marker frame paints');
    assert.equal(ctx.port.acks.length, 1);
    assert.equal(ctx.digestCalls.length, 0);
    assert.deepEqual(ctx.canvas.paints[0].data.slice(0, 4), [12, 34, 56, 255]);
  } finally {
    teardown(ctx);
  }
});
