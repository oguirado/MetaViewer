/**
 * MVUI34 lane P: paced paint, newest frame only (AC-02, part 1: coalescing).
 * Real router + real scheduler, fake clock, fake digest, no timers, no
 * sleeps: every wait is a bounded microtask flush with early exit. A burst
 * of N frames during one pending paint paints only the newest (conversion
 * count 1); older pending frames settle SUPERSEDED and the PRESENTED
 * witness names only the painted generation. Each behaviour has a mutant
 * negative control that fails the same property.
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
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

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

/** Window-like target double. */
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

/** MessagePort double recording acks. */
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

/** Canvas double counting conversions (putImageData calls) and bytes. */
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
 * Closed-shape delivery for one 1x1 rgb24 frame.
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

/** Bind a tile: canvas attaches on registration (SurfaceCanvas pattern). */
function bindTile(router, scheduler, canvas) {
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

const ackPairs = (port) => port.acks.map((ack) => [ack.correlation, ack.outcome]);

test('burst of 5 during one pending paint paints only the newest (1 conversion)', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = false;
  const digestCalls = [];
  const digestSha256 = async (bytes) => {
    digestCalls.push(bytes.byteLength);
    if (!gated) { gated = true; await gate; }
    return fakeHash(bytes);
  };
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256 });
  let now = 1000;
  const scheduler = createTileScheduler({ budget: BUDGET, clock: () => now });
  const canvas = fakeCanvas();
  try {
    bindTile(router, scheduler, canvas);
    const port = fakePort();
    target.emit(notice(port));
    await settleUntil(() => true, 'notice');
    port.deliver(delivery(1, [10, 20, 30]));
    await settleUntil(() => digestCalls.length === 1, 'g1 digest pending');
    for (const gen of [2, 3, 4, 5]) {
      port.deliver(delivery(gen, [gen * 10, gen * 10 + 1, gen * 10 + 2]));
    }
    await settleUntil(() => port.acks.length === 3, 'replaced acks');
    assert.deepEqual(ackPairs(port), [
      ['c2', FRAME_OUTCOMES.SUPERSEDED],
      ['c3', FRAME_OUTCOMES.SUPERSEDED],
      ['c4', FRAME_OUTCOMES.SUPERSEDED],
    ]);
    assert.equal(canvas.paints.length, 0);
    release();
    await settleUntil(() => port.acks.length === 5, 'all acks');
    assert.deepEqual(ackPairs(port), [
      ['c2', FRAME_OUTCOMES.SUPERSEDED],
      ['c3', FRAME_OUTCOMES.SUPERSEDED],
      ['c4', FRAME_OUTCOMES.SUPERSEDED],
      ['c1', FRAME_OUTCOMES.SUPERSEDED],
      ['c5', FRAME_OUTCOMES.PRESENTED],
    ]);
    assert.equal(canvas.paints.length, 1);
    assert.deepEqual(canvas.paints[0].data, [50, 51, 52, 255]);
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedFrameGen, 5);
    assert.equal(typeof info.lastPresentedHandle, 'string');
    assert.ok(info.lastPresentedHandle.length > 0);
    assert.equal(info.lastPresentedDigest, fakeHash(new Uint8Array([50, 51, 52])));
    assert.equal(info.presentCount, 1);
    assert.equal(info.convertedBytesTotal, 4);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('scheduler mailbox: N submits then one tick paints only the newest', () => {
  const releases = [];
  const scheduler = createTileScheduler({
    budget: BUDGET, clock: () => 1000,
    onReleaseLease: (rel) => releases.push([rel.leaseId, rel.frameGeneration, rel.reason]),
  });
  try {
    const canvas = fakeCanvas();
    scheduler.registerSurface({
      surfaceId: 'S', surfaceGeneration: 1, principal: PRINCIPAL, epoch: 1,
      state: {
        panelOpen: true, panelSelected: true, folded: false, width: 1, height: 1,
        x: 0, y: 0, viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
      },
    });
    scheduler.attachCanvas({ surfaceId: 'S', canvas });
    for (const gen of [1, 2, 3, 4]) {
      const submitted = scheduler.submitFrame({
        surfaceId: 'S', surfaceGeneration: 1, frameGeneration: gen, leaseId: `l${gen}`,
        byteLength: 3, width: 1, height: 1, bytes: new Uint8Array([gen, gen, gen]),
        principal: PRINCIPAL, epoch: 1, sha256: `digest-${gen}`,
      });
      assert.equal(submitted.ok, true);
    }
    const tick = scheduler.runTick();
    assert.deepEqual(tick.presented.map((p) => p.frameGeneration), [4]);
    assert.equal(canvas.paints.length, 1);
    assert.deepEqual(canvas.paints[0].data, [4, 4, 4, 255]);
    assert.deepEqual(releases, [
      ['l1', 1, 'SUPERSEDED'], ['l2', 2, 'SUPERSEDED'], ['l3', 3, 'SUPERSEDED'],
      ['l4', 4, 'PRESENTED'],
    ]);
    const info = scheduler.getInstrumentation('S');
    assert.equal(info.mailboxReplacements, 3);
    assert.equal(info.presentCount, 1);
  } finally {
    scheduler.destroy();
  }
});

test('budget-deferred mailbox keeps newest-only; next tick paints newest once', () => {
  const scheduler = createTileScheduler({ budget: BUDGET, clock: () => 1000 });
  try {
    const canvas = fakeCanvas();
    scheduler.registerSurface({
      surfaceId: 'S', surfaceGeneration: 1, principal: PRINCIPAL, epoch: 1,
      state: {
        panelOpen: true, panelSelected: true, folded: false, width: 1, height: 1,
        x: 0, y: 0, viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
      },
    });
    scheduler.attachCanvas({ surfaceId: 'S', canvas });
    scheduler.submitFrame({
      surfaceId: 'S', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'a',
      byteLength: 3, width: 1, height: 1, bytes: new Uint8Array([1, 2, 3]),
      principal: PRINCIPAL, epoch: 1, sha256: 'digest-1', estimatedPresentMs: 999,
    });
    const deferred = scheduler.runTick();
    assert.equal(deferred.budgetDeferrals, 1);
    assert.equal(deferred.presented.length, 0);
    assert.equal(canvas.paints.length, 0);
    scheduler.submitFrame({
      surfaceId: 'S', surfaceGeneration: 1, frameGeneration: 2, leaseId: 'b',
      byteLength: 3, width: 1, height: 1, bytes: new Uint8Array([9, 9, 9]),
      principal: PRINCIPAL, epoch: 1, sha256: 'digest-2',
    });
    const tick = scheduler.runTick();
    assert.deepEqual(tick.presented.map((p) => p.frameGeneration), [2]);
    assert.equal(canvas.paints.length, 1);
    assert.deepEqual(canvas.paints[0].data, [9, 9, 9, 255]);
  } finally {
    scheduler.destroy();
  }
});

test('negative: mutant router without newest-only supersede paints the burst (property is sensitive)', async () => {
  const source = readFileSync(new URL('../src/frames/framePortRouter.js', import.meta.url), 'utf8');
  const supersededBlock = '    if (record.superseded) {\n'
    + '      settle(record, FRAME_OUTCOMES.SUPERSEDED);\n'
    + '      return;\n'
    + '    }';
  const newerQueuedBlock = '      for (const queued of entry.queue) {\n'
    + '        if (queued.raw.frameGeneration > record.raw.frameGeneration) {\n'
    + '          settle(record, FRAME_OUTCOMES.SUPERSEDED);\n'
    + '          return;\n'
    + '        }\n'
    + '      }';
  assert.ok(source.includes(supersededBlock), 'superseded mutant anchor must exist in the fixed source');
  assert.ok(source.includes(newerQueuedBlock), 'newer-queued mutant anchor must exist in the fixed source');
  const mutantSource = source
    .split(supersededBlock).join('    /* mutant: replaced in-flight records still paint */')
    .replace(newerQueuedBlock, '      /* mutant: older records paint despite newer queued */');
  assert.notEqual(mutantSource, source, 'negative control must change the source');
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = false;
  const digestCalls = [];
  const digestSha256 = async (bytes) => {
    digestCalls.push(bytes.byteLength);
    if (!gated) { gated = true; await gate; }
    return fakeHash(bytes);
  };
  const target = fakeTarget();
  const router = mutant.default({ target, digestSha256 });
  const scheduler = createTileScheduler({ budget: BUDGET, clock: () => 1000 });
  const canvas = fakeCanvas();
  try {
    bindTile(router, scheduler, canvas);
    const port = fakePort();
    target.emit(notice(port));
    await settleUntil(() => true, 'notice');
    port.deliver(delivery(1, [10, 20, 30]));
    await settleUntil(() => digestCalls.length === 1, 'g1 digest pending');
    for (const gen of [2, 3, 4, 5]) {
      port.deliver(delivery(gen, [gen * 10, gen * 10 + 1, gen * 10 + 2]));
    }
    await settleUntil(() => port.acks.length === 3, 'replaced acks');
    release();
    await settleUntil(() => port.acks.length === 5, 'all acks');
    assert.ok(canvas.paints.length > 1, `mutant must paint the burst more than once (got ${canvas.paints.length})`);
    assert.deepEqual(ackPairs(port).slice(0, 3), [
      ['c2', FRAME_OUTCOMES.SUPERSEDED],
      ['c3', FRAME_OUTCOMES.SUPERSEDED],
      ['c4', FRAME_OUTCOMES.SUPERSEDED],
    ]);
    assert.equal(port.acks[3].outcome, FRAME_OUTCOMES.PRESENTED);
    assert.throws(() => assert.equal(canvas.paints.length, 1), 'mutant must fail the newest-only property');
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});
