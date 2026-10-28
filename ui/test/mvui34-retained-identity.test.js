/**
 * MVUI34 lane P: paced paint, newest frame only (AC-02, part 2: retained
 * identity). Fake clock, fake digest, fake timers, no sleeps. A retained
 * or kept byte buffer repaints only under its own frame identity
 * (surface, generation, digest); the reusable RGBA scratch never shows
 * bytes of a different frame across frames or dimension changes. Each
 * behaviour has a mutant negative control that fails the same property.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import installFramePortRouter, {
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler, convertRgb24ToRgba } from '../src/surfaces/tileScheduler.js';

const ORIGIN = 'app://test-host';
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
const PRINCIPAL = 'utility';
const NULL_DIGEST = '0'.repeat(64);
const SETTLE_STEPS = 200;

/** Deterministic 64-hex digest over bytes (pure, no crypto threadpool). */
function fakeHash(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0').repeat(8);
}

/** @returns {Promise<void>} One microtask checkpoint (no timers). */
const micro = () => Promise.resolve();

/**
 * Flush microtasks until `done()` or the bound; throws past the bound.
 * @param {() => boolean} done
 * @param {string} label
 */
async function settleUntil(done, label) {
  await micro();
  for (let i = 1; i < SETTLE_STEPS && !done(); i += 1) await micro();
  if (!done()) throw new Error(`not settled: ${label}`);
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

function fakePort() {
  const listeners = new Map();
  const port = {
    acks: [],
    postMessage(message) { port.acks.push(message); },
    start() {},
    close() {},
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
    paints: [],
    width: 0,
    height: 0,
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

/**
 * Closed-shape 1x1 rgb24 delivery.
 * @param {number} gen Frame generation.
 * @param {number[]} rgb Three bytes.
 */
function delivery(gen, rgb) {
  const bytes = new Uint8Array(rgb);
  const sha256 = fakeHash(bytes);
  assert.notEqual(sha256, NULL_DIGEST);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: `c${gen}`, principal: PRINCIPAL,
    epoch: 1, surfaceId: 'A', surfaceGeneration: 1, frameGeneration: gen, leaseId: `l${gen}`,
    width: 1, height: 1, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes,
  };
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

const ELIGIBLE_1X1 = {
  panelOpen: true, panelSelected: true, folded: false, width: 1, height: 1,
  x: 0, y: 0, viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
};

/**
 * Minimal fake-timer shim swapping the globals; only microtask awaits may
 * run while installed, and the caller must restore in a finally.
 */
function installFakeTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let seq = 0;
  const pending = new Map();
  globalThis.setTimeout = (cb, ms = 0, ...args) => {
    seq += 1;
    pending.set(seq, { at: now + Math.max(0, Number(ms) || 0), cb, args });
    return seq;
  };
  globalThis.clearTimeout = (id) => { pending.delete(id); };
  return {
    advance(ms) {
      now += ms;
      for (const [id, job] of [...pending].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])) {
        if (job.at <= now) { pending.delete(id); job.cb(...job.args); }
      }
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

test('canvas-less retain paints on attach under its own identity only', async () => {
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: async (b) => fakeHash(b) });
  const scheduler = createTileScheduler({ budget: BUDGET, clock: () => 1000 });
  const first = fakeCanvas();
  let token = null;
  try {
    router.bindSurface({
      surfaceId: 'A', scheduler,
      onRegistered: (registered) => {
        const attached = scheduler.attachCanvas({
          surfaceId: registered.surfaceId,
          surfaceGeneration: registered.surfaceGeneration,
          epoch: registered.epoch, canvas: first,
        });
        token = attached.token;
      },
    });
    const port = fakePort();
    target.emit(notice(port));
    await settleUntil(() => true, 'notice');
    port.deliver(delivery(1, [10, 20, 30]));
    await settleUntil(() => port.acks.length === 1, 'g1 ack');
    assert.equal(port.acks[0].outcome, FRAME_OUTCOMES.PRESENTED);
    assert.equal(first.paints.length, 1);
    scheduler.detachCanvas('A', token);
    port.deliver(delivery(2, [200, 201, 202]));
    await settleUntil(() => port.acks.length === 2, 'g2 ack');
    assert.equal(port.acks[1].outcome, FRAME_OUTCOMES.REFUSED);
    assert.equal(first.paints.length, 1);
    const second = fakeCanvas();
    scheduler.attachCanvas({ surfaceId: 'A', canvas: second });
    assert.equal(second.paints.length, 1);
    assert.deepEqual(second.paints[0].data, [200, 201, 202, 255]);
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedFrameGen, 2);
    assert.equal(info.lastPresentedDigest, fakeHash(new Uint8Array([200, 201, 202])));
    const third = fakeCanvas();
    scheduler.attachCanvas({ surfaceId: 'A', canvas: third });
    assert.equal(third.paints.length, 1);
    assert.deepEqual(third.paints[0].data, [200, 201, 202, 255]);
    const again = scheduler.getInstrumentation('A');
    assert.equal(again.lastPresentedFrameGen, 2);
    assert.equal(again.lastPresentedDigest, info.lastPresentedDigest);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('kept frame replays on bind with its own digest and no second ack', async () => {
  const timers = installFakeTimers();
  const target = fakeTarget();
  const router = installFramePortRouter({
    target, digestSha256: async (b) => fakeHash(b), pendingUnboundMs: 50,
  });
  const scheduler = createTileScheduler({ budget: BUDGET, clock: () => 1000 });
  const canvas = fakeCanvas();
  try {
    const port = fakePort();
    target.emit(notice(port));
    await settleUntil(() => true, 'notice');
    port.deliver(delivery(1, [60, 61, 62]));
    await settleUntil(() => true, 'hold');
    assert.equal(port.acks.length, 0);
    timers.advance(1000);
    await settleUntil(() => port.acks.length === 1, 'expiry ack');
    assert.equal(port.acks[0].outcome, FRAME_OUTCOMES.HIDDEN);
    assert.equal(canvas.paints.length, 0);
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
    await settleUntil(() => canvas.paints.length === 1, 'kept paint');
    assert.deepEqual(canvas.paints[0].data, [60, 61, 62, 255]);
    assert.equal(port.acks.length, 1);
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedFrameGen, 1);
    assert.equal(info.lastPresentedDigest, fakeHash(new Uint8Array([60, 61, 62])));
  } finally {
    timers.restore();
    router.dispose();
    scheduler.destroy();
  }
});

test('scratch reuse never leaks bytes across frames or dimension changes', () => {
  const scheduler = createTileScheduler({ budget: BUDGET, clock: () => 1000 });
  try {
    const canvas = fakeCanvas();
    scheduler.registerSurface({
      surfaceId: 'S', surfaceGeneration: 1, principal: PRINCIPAL, epoch: 1,
      state: { ...ELIGIBLE_1X1, width: 2, height: 2 },
    });
    scheduler.attachCanvas({ surfaceId: 'S', canvas });
    const submit = (gen, rgb, w, h) => scheduler.submitFrame({
      surfaceId: 'S', surfaceGeneration: 1, frameGeneration: gen, leaseId: `l${gen}`,
      byteLength: rgb.length, width: w, height: h, bytes: new Uint8Array(rgb),
      principal: PRINCIPAL, epoch: 1, sha256: `digest-${gen}`,
    });
    const frameA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const frameB = [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211];
    assert.equal(submit(1, frameA, 2, 2).ok, true);
    scheduler.presentSurfaceNow('S');
    assert.equal(submit(2, frameB, 2, 2).ok, true);
    scheduler.presentSurfaceNow('S');
    assert.equal(canvas.paints.length, 2);
    const expectedB = new Uint8ClampedArray(16);
    convertRgb24ToRgba(new Uint8Array(frameB), expectedB, 2, 2);
    assert.deepEqual(canvas.paints[1].data, [...expectedB]);
    const frameC = [77, 88, 99];
    assert.equal(submit(3, frameC, 1, 1).ok, true);
    scheduler.presentSurfaceNow('S');
    assert.equal(canvas.paints.length, 3);
    assert.deepEqual(canvas.paints[2], { width: 1, height: 1, data: [77, 88, 99, 255] });
    const reattached = fakeCanvas();
    scheduler.attachCanvas({ surfaceId: 'S', canvas: reattached });
    assert.equal(reattached.paints.length, 1);
    assert.deepEqual(reattached.paints[0], { width: 1, height: 1, data: [77, 88, 99, 255] });
    const info = scheduler.getInstrumentation('S');
    assert.equal(info.presentCount, 3);
    assert.equal(info.convertedBytesTotal, 16 + 16 + 4);
  } finally {
    scheduler.destroy();
  }
});

test('negative: mutant scheduler without the canvas-less retain repaint shows stale bytes', async () => {
  const source = readFileSync(new URL('../src/surfaces/tileScheduler.js', import.meta.url), 'utf8');
  const retainBefore = '    if (entry.pendingPaint !== null) {';
  assert.ok(source.includes(retainBefore), 'retain mutant anchor must exist in the fixed source');
  const mutantSource = source.replace(
    retainBefore,
    '    if (false) { // mutant: the canvas-less retained frame never repaints newest',
  );
  assert.notEqual(mutantSource, source, 'negative control must change the source');
  const keyMapUrl = import.meta.resolve('../src/input/keyMap.js');
  const frameMapUrl = import.meta.resolve('../src/input/frameMap.js');
  const relinkedSource = mutantSource
    .split(`'../input/keyMap.js'`).join(JSON.stringify(keyMapUrl))
    .split(`'../input/frameMap.js'`).join(JSON.stringify(frameMapUrl));
  assert.ok(relinkedSource.includes(keyMapUrl), 'keyMap specifier must relink to an absolute URL');
  assert.ok(relinkedSource.includes(frameMapUrl), 'frameMap specifier must relink to an absolute URL');
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(relinkedSource).toString('base64')}`);
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: async (b) => fakeHash(b) });
  const scheduler = mutant.createTileScheduler({ budget: BUDGET, clock: () => 1000 });
  const first = fakeCanvas();
  let token = null;
  try {
    router.bindSurface({
      surfaceId: 'A', scheduler,
      onRegistered: (registered) => {
        const attached = scheduler.attachCanvas({
          surfaceId: registered.surfaceId,
          surfaceGeneration: registered.surfaceGeneration,
          epoch: registered.epoch, canvas: first,
        });
        token = attached.token;
      },
    });
    const port = fakePort();
    target.emit(notice(port));
    await settleUntil(() => true, 'notice');
    port.deliver(delivery(1, [10, 20, 30]));
    await settleUntil(() => port.acks.length === 1, 'g1 ack');
    assert.equal(port.acks[0].outcome, FRAME_OUTCOMES.PRESENTED);
    scheduler.detachCanvas('A', token);
    port.deliver(delivery(2, [200, 201, 202]));
    await settleUntil(() => port.acks.length === 2, 'g2 ack');
    assert.equal(port.acks[1].outcome, FRAME_OUTCOMES.REFUSED);
    const second = fakeCanvas();
    scheduler.attachCanvas({ surfaceId: 'A', canvas: second });
    assert.equal(second.paints.length, 1);
    assert.deepEqual(second.paints[0].data, [10, 20, 30, 255]);
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedFrameGen, 1);
    assert.equal(info.lastPresentedDigest, fakeHash(new Uint8Array([10, 20, 30])));
    assert.throws(
      () => assert.deepEqual(second.paints[0].data, [200, 201, 202, 255]),
      'mutant must fail the retained-identity property',
    );
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('negative: mutant scratch reused across dimensions paints wrong pixels', async () => {
  const source = readFileSync(new URL('../src/surfaces/tileScheduler.js', import.meta.url), 'utf8');
  const scratchBefore = '  if (exactBytes && isReusableScratch(slot, width, height)) {';
  assert.ok(source.includes(scratchBefore), 'scratch mutant anchor must exist in the fixed source');
  const mutantSource = source.replace(
    scratchBefore,
    '  if (slot !== null && typeof slot === \'object\' && slot.image != null) { // mutant: reuse any scratch across dimensions',
  );
  assert.notEqual(mutantSource, source, 'negative control must change the source');
  const keyMapUrl = import.meta.resolve('../src/input/keyMap.js');
  const frameMapUrl = import.meta.resolve('../src/input/frameMap.js');
  const relinkedSource = mutantSource
    .split(`'../input/keyMap.js'`).join(JSON.stringify(keyMapUrl))
    .split(`'../input/frameMap.js'`).join(JSON.stringify(frameMapUrl));
  assert.ok(relinkedSource.includes(keyMapUrl), 'keyMap specifier must relink to an absolute URL');
  assert.ok(relinkedSource.includes(frameMapUrl), 'frameMap specifier must relink to an absolute URL');
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(relinkedSource).toString('base64')}`);
  const scheduler = mutant.createTileScheduler({ budget: BUDGET, clock: () => 1000 });
  try {
    const canvas = fakeCanvas();
    scheduler.registerSurface({
      surfaceId: 'S', surfaceGeneration: 1, principal: PRINCIPAL, epoch: 1,
      state: { ...ELIGIBLE_1X1, width: 2, height: 2 },
    });
    scheduler.attachCanvas({ surfaceId: 'S', canvas });
    const submit = (gen, rgb, w, h) => scheduler.submitFrame({
      surfaceId: 'S', surfaceGeneration: 1, frameGeneration: gen, leaseId: `l${gen}`,
      byteLength: rgb.length, width: w, height: h, bytes: new Uint8Array(rgb),
      principal: PRINCIPAL, epoch: 1, sha256: `digest-${gen}`,
    });
    const frameA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const frameB = [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211];
    assert.equal(submit(1, frameA, 2, 2).ok, true);
    scheduler.presentSurfaceNow('S');
    assert.equal(submit(2, frameB, 2, 2).ok, true);
    scheduler.presentSurfaceNow('S');
    assert.equal(canvas.paints.length, 2);
    assert.equal(submit(3, [77, 88, 99], 1, 1).ok, true);
    scheduler.presentSurfaceNow('S');
    assert.equal(canvas.paints.length, 3);
    assert.equal(canvas.paints[2].width, 2);
    assert.equal(canvas.paints[2].height, 2);
    assert.deepEqual(canvas.paints[2].data.slice(0, 4), [77, 88, 99, 255]);
    assert.notDeepEqual(canvas.paints[2].data, [77, 88, 99, 255]);
    assert.throws(
      () => assert.deepEqual(canvas.paints[2], { width: 1, height: 1, data: [77, 88, 99, 255] }),
      'mutant must fail the no-leak property',
    );
  } finally {
    scheduler.destroy();
  }
});
