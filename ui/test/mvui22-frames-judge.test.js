// MVUI22 lane F: MV-UI12 judge notes. Grace-bound keepStream retire with
// pending-delivery acks, lazy frame retain with warm-eviction drop, and the
// same-element reattach repaint skip. Real framePortRouter + real
// tileScheduler, bounded 1x1 fakes, wall-clock waits via frame-wait only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import installFramePortRouter, {
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { until, untilAcks } from './frame-wait.mjs';

const ORIGIN = 'app://metaviewer';
const GRACE_MS = 40;
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

function portNotice(port, surfaceId = 'A', generation = 1) {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE, schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: surfaceId, surface_generation: generation,
    },
    origin: ORIGIN,
    ports: [port],
  };
}

const frameBytes = (gen) => new Uint8Array([gen % 256, (gen + 10) % 256, (gen + 20) % 256]);
const rgba = (bytes) => [bytes[0], bytes[1], bytes[2], 255];
const ackOutcomes = (port) => port.acks.map((ack) => ack.outcome);

async function frameDelivery(overrides = {}) {
  const bytes = overrides.bytes ?? frameBytes(overrides.frameGeneration ?? 1);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'c1', principal: 'utility',
    epoch: 1, surfaceId: 'A', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'l1',
    width: 1, height: 1, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

// mvui20 mountTile idiom: the first attach fails while unregistered; the
// router registration notice retries it with the delivery identity.
function bindTile(router, scheduler, token) {
  const canvas = fakeCanvas();
  const tile = { canvas, bindToken: token, canvasToken: null };
  const first = scheduler.attachCanvas({ surfaceId: 'A', canvas });
  if (first?.ok === true) tile.canvasToken = first.token ?? null;
  router.bindSurface({
    surfaceId: 'A', scheduler, bindToken: token,
    onRegistered: (notice) => {
      const attached = scheduler.attachCanvas({
        surfaceId: notice.surfaceId, surfaceGeneration: notice.surfaceGeneration,
        epoch: notice.epoch, canvas,
      });
      if (attached?.ok === true) tile.canvasToken = attached.token ?? null;
    },
  });
  return tile;
}

function liveSetup(routerOptions = {}) {
  const target = fakeTarget();
  const router = installFramePortRouter({ target, digestSha256: (bytes) => hexDigest(bytes), ...routerOptions });
  assert.ok(router, 'router installs on the harness window');
  const scheduler = createTileScheduler({
    budget: BUDGET,
    onPresent: (record) => scheduler.presentHandle(record),
  });
  return { target, router, scheduler };
}

async function pastGrace(start, ms = GRACE_MS * 3 + 30) {
  await until(() => Date.now() - start >= ms, `past the ${GRACE_MS} ms grace`);
}

test('R1: keepStream grace expiry retires the stream and closes the port', async () => {
  const { target, router, scheduler } = liveSetup({ keepStreamGraceMs: GRACE_MS });
  try {
    const wall = bindTile(router, scheduler, Symbol('wall'));
    const port = browserPort();
    target.emit(portNotice(port));
    router.unbindSurface('A', wall.bindToken, { keepStream: true });
    assert.ok(router.getSurfaceStatus('A') !== null, 'the kept stream stays open inside the grace');
    assert.equal(port.closed, false);
    await until(() => router.getSurfaceStatus('A') === null, 'grace expiry retires the kept stream');
    assert.equal(port.closed, true, 'grace expiry closes the port');
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('R1b: grace expiry acks an in-flight delivery as destroyed, exactly once, never painted', async () => {
  let releaseDigest = () => {};
  const gate = new Promise((resolve) => { releaseDigest = resolve; });
  const { target, router, scheduler } = liveSetup({
    keepStreamGraceMs: GRACE_MS,
    digestSha256: (bytes) => gate.then(() => hexDigest(bytes)),
  });
  try {
    const wall = bindTile(router, scheduler, Symbol('wall'));
    const port = browserPort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ frameGeneration: 1 }));
    router.unbindSurface('A', wall.bindToken, { keepStream: true });
    await until(() => router.getSurfaceStatus('A') === null, 'grace expiry retires the kept stream');
    assert.equal(port.closed, true);
    assert.equal(port.acks.length, 0, 'the gated delivery settles only when validation completes');
    releaseDigest();
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SURFACE_DESTROYED]);
    assert.equal(port.acks.length, 1, 'exactly one ack for the pending delivery');
    assert.equal(scheduler.getInstrumentation('A'), null, 'the displaced delivery never registers or paints');
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('C1: a rebind within the grace keeps the stream alive and presenting', async () => {
  const { target, router, scheduler } = liveSetup({ keepStreamGraceMs: GRACE_MS });
  try {
    const wall = bindTile(router, scheduler, Symbol('wall'));
    const port = browserPort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ frameGeneration: 1 }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(wall.canvas.paints.length, 1);
    const start = Date.now();
    router.unbindSurface('A', wall.bindToken, { keepStream: true });
    const multi = bindTile(router, scheduler, Symbol('multi'));
    assert.equal(multi.canvas.paints.length, 1, 'remount repaints the retained frame');
    port.deliver(await frameDelivery({ frameGeneration: 2, correlation: 'c2', leaseId: 'l2' }));
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    await pastGrace(start);
    const status = router.getSurfaceStatus('A');
    assert.equal(status?.bound, true, 'the rebound stream survives its own grace window');
    assert.equal(status?.portOpen, true);
    assert.equal(port.closed, false);
    port.deliver(await frameDelivery({ frameGeneration: 3, correlation: 'c3', leaseId: 'l3' }));
    await untilAcks(port, 3);
    assert.deepEqual(ackOutcomes(port),
      [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('N1 negative control: without grace arming the kept stream never retires', async () => {
  const source = readFileSync(new URL('../src/frames/framePortRouter.js', import.meta.url), 'utf8');
  const before = 'armKeepStreamGrace(entry);';
  assert.ok(source.includes(before), 'mutant anchor must exist in the fixed source');
  const mutantSource = source.replace(before, '/* mutant: the grace never arms */');
  assert.notEqual(mutantSource, source, 'negative control must change the source');
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
  const target = fakeTarget();
  const router = mutant.default({ target, digestSha256: (bytes) => hexDigest(bytes), keepStreamGraceMs: GRACE_MS });
  const scheduler = createTileScheduler({
    budget: BUDGET,
    onPresent: (record) => scheduler.presentHandle(record),
  });
  try {
    const wall = bindTile(router, scheduler, Symbol('wall'));
    const port = browserPort();
    target.emit(portNotice(port));
    const start = Date.now();
    router.unbindSurface('A', wall.bindToken, { keepStream: true });
    await pastGrace(start);
    const status = router.getSurfaceStatus('A');
    assert.ok(status !== null, 'the unpatched router keeps the port open past the grace (the reported leak)');
    assert.equal(status.portOpen, true);
    assert.equal(port.closed, false);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('D1: the default grace retires a kept stream', async () => {
  const routerModule = await import('../src/frames/framePortRouter.js');
  assert.equal(routerModule.KEEP_STREAM_GRACE_MS, 500, 'default grace contract');
  const { target, router, scheduler } = liveSetup();
  try {
    const wall = bindTile(router, scheduler, Symbol('wall'));
    const port = browserPort();
    target.emit(portNotice(port));
    router.unbindSurface('A', wall.bindToken, { keepStream: true });
    assert.ok(router.getSurfaceStatus('A') !== null, 'the kept stream stays open inside the default grace');
    await until(() => router.getSurfaceStatus('A') === null, 'default grace expiry retires the kept stream');
    assert.equal(port.closed, true);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

function directScheduler() {
  const scheduler = createTileScheduler({
    budget: BUDGET,
    onPresent: (record) => scheduler.presentHandle(record),
  });
  const registered = scheduler.registerSurface({
    surfaceId: 'A', surfaceGeneration: 1, principal: 'utility', epoch: 1,
    state: {
      panelOpen: true, panelSelected: true, folded: false, width: 2, height: 2,
      x: 0, y: 0, viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
    },
  });
  assert.equal(registered.ok, true);
  return scheduler;
}

function submitFrame(scheduler, { frameGeneration, leaseId, bytes }) {
  const out = scheduler.submitFrame({
    surfaceId: 'A', surfaceGeneration: 1, frameGeneration, leaseId,
    byteLength: bytes.byteLength, width: 1, height: 1, bytes,
    principal: 'utility', epoch: 1, sha256: 'a'.repeat(64),
  });
  assert.equal(out.ok, true);
  return out;
}

function presentOnce(scheduler) {
  const result = scheduler.presentSurfaceNow('A');
  assert.equal(result.drawsUsed, 1);
}

class TrackedBytes extends Uint8Array {
  constructor(bytes) {
    super(bytes);
    this.sliceCalls = 0;
  }
  slice(...args) {
    this.sliceCalls += 1;
    return super.slice(...args);
  }
}

test('R2a: presents retain the frame without copying bytes', () => {
  const scheduler = directScheduler();
  try {
    const canvas = fakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 'A', canvas }).ok, true);
    const first = new TrackedBytes(frameBytes(1));
    submitFrame(scheduler, { frameGeneration: 1, leaseId: 'l1', bytes: first });
    presentOnce(scheduler);
    const second = new TrackedBytes(frameBytes(2));
    submitFrame(scheduler, { frameGeneration: 2, leaseId: 'l2', bytes: second });
    presentOnce(scheduler);
    assert.equal(first.sliceCalls, 0, 'no per-present copy of the first frame');
    assert.equal(second.sliceCalls, 0, 'no per-present copy of the second frame');
    assert.equal(canvas.paints.length, 2);
    assert.deepEqual(canvas.paints[0].data, rgba(frameBytes(1)));
    assert.deepEqual(canvas.paints[1].data, rgba(frameBytes(2)));
  } finally {
    scheduler.destroy();
  }
});

test('R2b: warm-resource eviction drops the retained frame', () => {
  const scheduler = directScheduler();
  try {
    const first = fakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 'A', canvas: first }).ok, true);
    submitFrame(scheduler, { frameGeneration: 1, leaseId: 'l1', bytes: frameBytes(1) });
    presentOnce(scheduler);
    const second = fakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 'A', canvas: second }).ok, true);
    assert.equal(second.paints.length, 1, 'the retained frame repaints a new element before eviction');
    assert.deepEqual(second.paints[0].data, rgba(frameBytes(1)));
    let disposed = 0;
    assert.equal(scheduler.allocateWarmResource('A', {
      resourceId: 'w1', byteLength: 8, dispose: () => { disposed += 1; },
    }).ok, true);
    assert.equal(scheduler.allocateWarmResource('A', {
      resourceId: 'w2', byteLength: 8, dispose: () => { disposed += 1; },
    }).ok, true);
    assert.equal(disposed, 1, 'the second allocation evicts the first');
    assert.equal(scheduler.getInstrumentation('A').reclaimedWarmResources, 1);
    const third = fakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 'A', canvas: third }).ok, true);
    assert.equal(third.paints.length, 0, 'no retained frame survives a warm eviction');
  } finally {
    scheduler.destroy();
  }
});

let cachedMutantScheduler = null;
async function mutantScheduler() {
  if (cachedMutantScheduler) return cachedMutantScheduler;
  const source = readFileSync(new URL('../src/surfaces/tileScheduler.js', import.meta.url), 'utf8');
  const copyBefore = 'entry.lastPaint = { bytes: slot.bytes, width: slot.width, height: slot.height };';
  const guardBefore = 'if (entry.lastPaint !== null && previous !== args.canvas && !sameElementReattach) {';
  assert.ok(source.includes(copyBefore), 'copy mutant anchor must exist in the fixed source');
  assert.ok(source.includes(guardBefore), 'guard mutant anchor must exist in the fixed source');
  const mutantSource = source
    .replace(copyBefore, 'entry.lastPaint = { bytes: slot.bytes.slice(), width: slot.width, height: slot.height }; // mutant: per-present copy')
    .replace(guardBefore, 'if (entry.lastPaint !== null && previous !== args.canvas) { // mutant: always repaint');
  assert.notEqual(mutantSource, source, 'negative controls must change the source');
  cachedMutantScheduler = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
  return cachedMutantScheduler;
}

function directMutantScheduler(mutant) {
  const scheduler = mutant.createTileScheduler({
    budget: BUDGET,
    onPresent: (record) => scheduler.presentHandle(record),
  });
  const registered = scheduler.registerSurface({
    surfaceId: 'A', surfaceGeneration: 1, principal: 'utility', epoch: 1,
    state: {
      panelOpen: true, panelSelected: true, folded: false, width: 2, height: 2,
      x: 0, y: 0, viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
    },
  });
  assert.equal(registered.ok, true);
  return scheduler;
}

test('N2 negative control: the per-present copy mutant copies every frame', async () => {
  const mutant = await mutantScheduler();
  const scheduler = directMutantScheduler(mutant);
  try {
    const canvas = fakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 'A', canvas }).ok, true);
    const tracked = new TrackedBytes(frameBytes(1));
    submitFrame(scheduler, { frameGeneration: 1, leaseId: 'l1', bytes: tracked });
    presentOnce(scheduler);
    assert.equal(tracked.sliceCalls, 1, 'the unpatched present copies the frame (the reported defect)');
  } finally {
    scheduler.destroy();
  }
});

test('R4: same-element detach+reattach skips the repaint; a new element repaints', () => {
  const scheduler = directScheduler();
  try {
    const first = fakeCanvas();
    const attached = scheduler.attachCanvas({ surfaceId: 'A', canvas: first });
    assert.equal(attached.ok, true);
    submitFrame(scheduler, { frameGeneration: 1, leaseId: 'l1', bytes: frameBytes(1) });
    presentOnce(scheduler);
    assert.equal(first.paints.length, 1);
    // The SurfaceCanvas onRegistered pattern: detach, then reattach the same
    // live element. It still shows the retained frame: no repaint.
    scheduler.detachCanvas('A', attached.token);
    const reattached = scheduler.attachCanvas({ surfaceId: 'A', canvas: first });
    assert.equal(reattached.ok, true, 'the reattach stands');
    assert.equal(first.paints.length, 1, 'same-element reattach repaints nothing');
    // Control: a genuinely new element still repaints immediately.
    const second = fakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 'A', canvas: second }).ok, true);
    assert.equal(second.paints.length, 1, 'a new element repaints the retained frame');
    assert.deepEqual(second.paints[0].data, rgba(frameBytes(1)));
  } finally {
    scheduler.destroy();
  }
});

test('N4 negative control: without the guard the same-element reattach repaints', async () => {
  const mutant = await mutantScheduler();
  const scheduler = directMutantScheduler(mutant);
  try {
    const canvas = fakeCanvas();
    const attached = scheduler.attachCanvas({ surfaceId: 'A', canvas });
    assert.equal(attached.ok, true);
    submitFrame(scheduler, { frameGeneration: 1, leaseId: 'l1', bytes: frameBytes(1) });
    presentOnce(scheduler);
    assert.equal(canvas.paints.length, 1);
    scheduler.detachCanvas('A', attached.token);
    assert.equal(scheduler.attachCanvas({ surfaceId: 'A', canvas }).ok, true);
    assert.equal(canvas.paints.length, 2, 'the unpatched attach repaints the same element (the reported defect)');
  } finally {
    scheduler.destroy();
  }
});

test('lane F tests stay under 512 MiB rss', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes exceeds the 512 MiB lane budget`);
});
