// MVUI14 lane F: frame-port router. Fake window target, fake ports (browser
// addEventListener shape plus a node-EventEmitter shape), a fake canvas, and
// the REAL tile scheduler: every outcome path, exactly-once acks, port
// lifecycle, and the first-frame-presented witness. Plain node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import installFramePortRouter, {
  FRAME_ACK_SCHEMA,
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
  isFramePortNotice,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

const ORIGIN = 'app://metaviewer';
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
// Quiescence for synchronous paths (refusals, silent drops, adoptions):
// nothing async is ever scheduled, so a few turns prove the outcome.
async function tick() {
  for (let i = 0; i < 5; i += 1) await flush();
}
// Deterministic wait for async outcomes (digest-gated paints): poll the
// expected condition under a generous bound instead of counting turns,
// so loaded machines cannot flake the suite.
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
const realDigest = (bytes) => hexDigest(bytes);

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
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    emit(event) {
      for (const fn of [...(listeners.get('message') ?? [])]) fn(event);
    },
  };
}

// Browser-shaped port: addEventListener/removeEventListener + start/close.
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
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    deliver(data) {
      for (const fn of [...(listeners.get('message') ?? [])]) fn({ data });
    },
  };
  return port;
}

// Node-shaped port: EventEmitter on/off (framePort.js test idiom).
class NodePort extends EventEmitter {
  constructor() {
    super();
    this.acks = [];
    this.closed = false;
    this.started = false;
  }
  postMessage(message) { this.acks.push(message); }
  start() { this.started = true; }
  close() { this.closed = true; }
  deliver(data) { this.emit('message', { data }); }
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

function notice(port, overrides = {}, eventOverrides = {}) {
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
    ...eventOverrides,
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

function setup(options = {}) {
  const target = fakeTarget(options.origin);
  const router = installFramePortRouter({ target, digestSha256: options.digestSha256 ?? realDigest });
  assert.ok(router, 'router installs on a usable target');
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  return { target, router, scheduler, canvas };
}

function ackOutcomes(port) {
  return port.acks.map((ack) => ack.outcome);
}

test('router is dormant until the first valid notice', async () => {
  const { target, router, scheduler, canvas } = setup();
  assert.equal(target.listenerCount('message'), 1);
  assert.deepEqual(router.getSurfaceStatus(), []);
  // Unrelated traffic and the interim schemaless preload notice change nothing.
  target.emit({ data: { hello: 'world' }, origin: ORIGIN, ports: [] });
  const interim = browserPort();
  target.emit({ data: { type: FRAME_PORT_NOTICE_TYPE, surface_id: 'A' }, origin: ORIGIN, ports: [interim] });
  await tick();
  assert.deepEqual(router.getSurfaceStatus(), []);
  assert.equal(canvas.paints.length, 0);
  assert.equal(scheduler.getInstrumentation('A'), null);
  assert.equal(interim.closed, true);
  router.dispose();
});

test('install refuses unusable targets', () => {
  assert.equal(installFramePortRouter(null), null);
  assert.equal(installFramePortRouter({}), null);
  assert.equal(installFramePortRouter({ target: {} }), null);
  assert.equal(installFramePortRouter({
    target: { addEventListener() {}, removeEventListener() {}, location: { origin: '' } },
  }), null);
  assert.equal(installFramePortRouter({
    target: { addEventListener() {}, removeEventListener() {} },
  }), null);
});

test('isFramePortNotice admits only the closed notice shape', () => {
  const valid = { type: FRAME_PORT_NOTICE_TYPE, schema: FRAME_PORT_NOTICE_SCHEMA, surface_id: 'A', surface_generation: 1 };
  assert.equal(isFramePortNotice(valid), true);
  assert.equal(isFramePortNotice({ type: FRAME_PORT_NOTICE_TYPE, surface_id: 'A' }), false);
  assert.equal(isFramePortNotice({ ...valid, extra: 1 }), false);
  assert.equal(isFramePortNotice({ ...valid, schema: 'frame_port/v0' }), false);
  assert.equal(isFramePortNotice({ ...valid, type: 'other' }), false);
  assert.equal(isFramePortNotice({ ...valid, surface_id: '' }), false);
  assert.equal(isFramePortNotice({ ...valid, surface_generation: 0 }), false);
  assert.equal(isFramePortNotice({ ...valid, surface_generation: 1.5 }), false);
  assert.equal(isFramePortNotice(null), false);
  assert.equal(isFramePortNotice('frame-port'), false);
  assert.equal(isFramePortNotice([]), false);
});

for (const [name, mutate, eventMutate] of [
  ['extra keys', (data) => ({ ...data, extra: 1 }), null],
  ['wrong schema', (data) => ({ ...data, schema: 'frame_port/v9' }), null],
  ['wrong type', (data) => ({ ...data, type: 'metaviewer:other' }), null],
  ['missing generation', (data) => {
    const next = { ...data };
    delete next.surface_generation;
    return next;
  }, null],
  ['empty surface id', (data) => ({ ...data, surface_id: '' }), null],
  ['zero generation', (data) => ({ ...data, surface_generation: 0 }), null],
  ['non-object data', () => 'notice', null],
  ['null data', () => null, null],
  ['wrong origin', null, (event) => ({ ...event, origin: 'https://evil.example' })],
  ['empty origin', null, (event) => ({ ...event, origin: '' })],
  ['zero ports', null, (event) => ({ ...event, ports: [] })],
  ['two ports', null, (event) => ({ ...event, ports: [...event.ports, browserPort()] })],
  ['ports not an array', null, (event) => ({ ...event, ports: 'port' })],
  ['unusable port', null, (event) => ({
    ...event,
    ports: [{ closed: false, close() { this.closed = true; } }],
  })],
]) {
  test(`malformed notice ignored (${name}); transferred ports close`, async () => {
    const { target, router, canvas } = setup();
    const port = browserPort();
    let event = notice(port);
    if (mutate) event = { ...event, data: mutate(event.data) };
    if (eventMutate) event = eventMutate(event);
    target.emit(event);
    await tick();
    assert.deepEqual(router.getSurfaceStatus(), []);
    assert.equal(canvas.paints.length, 0);
    for (const candidate of (Array.isArray(event.ports) ? event.ports : [])) {
      assert.equal(candidate.closed, true, `${name}: spare port closed`);
    }
    assert.equal(port.started, false);
    router.dispose();
  });
}

test('one port per stream: same generation ignored, newer replaces and closes the old', async () => {
  const { target, router } = setup();
  const first = browserPort();
  target.emit(notice(first));
  await tick();
  assert.equal(first.started, true);
  assert.deepEqual(router.getSurfaceStatus('A'), {
    surfaceId: 'A', surfaceGeneration: 1, bound: false, portOpen: true,
    registered: false, presentedFrames: 0, firstPresented: false,
  });
  const spare = browserPort();
  target.emit(notice(spare));
  await tick();
  assert.equal(spare.closed, true);
  assert.equal(first.closed, false);
  assert.equal(first.listenerCount('message'), 1);
  const next = browserPort();
  target.emit(notice(next, { surface_generation: 2 }));
  await tick();
  assert.equal(first.closed, true);
  assert.equal(first.listenerCount('message'), 0);
  assert.equal(next.closed, false);
  assert.deepEqual(router.getSurfaceStatus('A').surfaceGeneration, 2);
  // Late deliveries on the retired port are never painted and never acked.
  first.deliver(await delivery({ surfaceGeneration: 1, correlation: 'late' }));
  await tick();
  assert.deepEqual(first.acks, []);
  assert.deepEqual(next.acks, []);
  router.dispose();
});

test('node-shaped ports wire through on/off like browser ports', async () => {
  const { target, router, scheduler, canvas } = setup();
  bindTile(router, scheduler, canvas);
  const port = new NodePort();
  target.emit(notice(port));
  port.deliver(await delivery());
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 1);
  router.dispose();
});

test('first valid frame registers, paints rgb24->rgba, acks PRESENTED once with the exact shape', async () => {
  const { target, router, scheduler, canvas } = setup();
  const firstAttach = bindTile(router, scheduler, canvas);
  assert.equal(firstAttach.ok, false, 'attach before registration fails; the retry does the work');
  const seen = [];
  const stop = router.onSurfaceRegistered((registered) => seen.push(registered));
  const port = browserPort();
  target.emit(notice(port));
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  port.deliver(await delivery({ bytes, width: 2, height: 2, correlation: 'paint-1', leaseId: 'lease-1' }));
  await untilAcks(port, 1);
  assert.equal(port.acks.length, 1);
  const ack = port.acks[0];
  assert.deepEqual(Object.keys(ack).sort(), ['correlation', 'epoch', 'frameGeneration', 'kind', 'leaseId',
    'outcome', 'principal', 'schema', 'surfaceGeneration', 'surfaceId'].sort());
  assert.deepEqual(ack, {
    schema: FRAME_ACK_SCHEMA,
    kind: 'ack',
    correlation: 'paint-1',
    principal: 'utility',
    epoch: 1,
    surfaceId: 'A',
    surfaceGeneration: 1,
    frameGeneration: 1,
    leaseId: 'lease-1',
    outcome: FRAME_OUTCOMES.PRESENTED,
  });
  assert.equal(canvas.paints.length, 1);
  assert.deepEqual(canvas.paints[0].data, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
  const info = scheduler.getInstrumentation('A');
  assert.equal(info.lastPresentedFrameGen, 1);
  assert.ok(info.lastPresentedHandle.length > 0);
  assert.equal(info.presentCount, 1);
  // App surfaceWitness equivalence: a non-empty frame handle leaves Connecting.
  const witness = info && 'lastPresentedHandle' in info && info.surfaceGeneration === 1
    && info.epoch === 1 && !info.destroyed && !info.contextLost
    ? { frame: info.lastPresentedHandle, digest: info.lastPresentedDigest }
    : { frame: '', digest: '' };
  assert.ok(witness.frame.length > 0, 'tile leaves Connecting on first PRESENTED');
  assert.deepEqual(router.getSurfaceStatus('A'), {
    surfaceId: 'A', surfaceGeneration: 1, bound: true, portOpen: true,
    registered: true, presentedFrames: 1, firstPresented: true,
  });
  assert.deepEqual(seen, [{ surfaceId: 'A', surfaceGeneration: 1, epoch: 1 }]);
  stop();
  router.dispose();
});

test('no paint before validation: nothing draws or acks while the digest is pending', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { target, router, scheduler, canvas } = setup({
    digestSha256: async (bytes) => {
      await gate;
      return hexDigest(bytes);
    },
  });
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery());
  await tick();
  assert.equal(canvas.paints.length, 0);
  assert.equal(port.acks.length, 0);
  assert.equal(scheduler.getInstrumentation('A'), null);
  release();
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 1);
  router.dispose();
});

test('default digest verifies through SubtleCrypto with no override', async () => {
  assert.ok(globalThis.crypto?.subtle, 'node 24 provides WebCrypto');
  const target = fakeTarget();
  const router = installFramePortRouter({ target });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = fakeCanvas();
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery());
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
  router.dispose();
});

for (const [name, mutate] of [
  ['sha mismatch', async (frame) => ({ ...frame, sha256: 'f'.repeat(64) })],
  ['null-marker digest', async (frame) => ({ ...frame, sha256: '0'.repeat(64) })],
  ['uppercase digest', async (frame) => ({ ...frame, sha256: (await hexDigest(frame.bytes)).toUpperCase() })],
  ['short digest', async (frame) => ({ ...frame, sha256: 'ab' })],
  ['wrong schema', async (frame) => ({ ...frame, schema: 'frame_delivery/v9' })],
  ['wrong kind', async (frame) => ({ ...frame, kind: 'ack' })],
  ['extra key', async (frame) => ({ ...frame, extra: 1 })],
  ['missing byteLength', async (frame) => {
    const next = { ...frame };
    delete next.byteLength;
    return next;
  }],
  ['byteLength disagrees with geometry', async (frame) => ({ ...frame, byteLength: 4 })],
  ['byteLength disagrees with bytes', async (frame) => ({ ...frame, bytes: new Uint8Array([1, 2, 3, 4]) })],
  ['bytes not a Uint8Array', async (frame) => ({ ...frame, bytes: [12, 34, 56] })],
  ['bytes an ArrayBuffer', async (frame) => ({ ...frame, bytes: frame.bytes.buffer })],
  ['format not rgb24', async (frame) => ({ ...frame, format: 'rgba' })],
  ['zero width', async (frame) => ({ ...frame, width: 0 })],
  ['negative height', async (frame) => ({ ...frame, height: -2 })],
  ['pixelSpec null', async (frame) => ({ ...frame, pixelSpec: null })],
  ['pixelSpec scalar', async (frame) => ({ ...frame, pixelSpec: 'rgb24' })],
  ['zero frameGeneration', async (frame) => ({ ...frame, frameGeneration: 0 })],
  ['zero epoch', async (frame) => ({ ...frame, epoch: 0 })],
  ['wrong surfaceId', async (frame) => ({ ...frame, surfaceId: 'B' })],
  ['non-positive surfaceGeneration', async (frame) => ({ ...frame, surfaceGeneration: 0 })],
]) {
  test(`malformed delivery refused without paint (${name})`, async () => {
    const { target, router, scheduler, canvas } = setup();
    bindTile(router, scheduler, canvas);
    const port = browserPort();
    target.emit(notice(port));
    port.deliver(await mutate(await delivery()));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
    assert.equal(canvas.paints.length, 0);
    assert.equal(scheduler.getInstrumentation('A'), null);
    assert.equal(port.closed, false, 'refusals keep the stream open');
    router.dispose();
  });
}

for (const [name, frame] of [
  ['empty correlation', delivery({ correlation: '' })],
  ['missing correlation', delivery().then((frame) => {
    const next = { ...frame };
    delete next.correlation;
    return next;
  })],
  ['non-object', Promise.resolve('frame')],
  ['null', Promise.resolve(null)],
  ['empty leaseId', delivery({ leaseId: '' })],
  ['empty principal', delivery({ principal: '' })],
]) {
  test(`unackable arrival dropped silently (${name})`, async () => {
    const { target, router, canvas } = setup();
    const port = browserPort();
    target.emit(notice(port));
    port.deliver(await frame);
    await tick();
    assert.deepEqual(port.acks, []);
    assert.equal(canvas.paints.length, 0);
    assert.equal(port.closed, false);
    router.dispose();
  });
}

test('unavailable digest refuses without paint', async () => {
  const { target, router, scheduler, canvas } = setup({
    digestSha256: async () => { throw new Error('DIGEST_UNAVAILABLE'); },
  });
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery());
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
  assert.equal(canvas.paints.length, 0);
  router.dispose();
});

test('unbound surface refuses as unknown; binding later admits the same generation', async () => {
  const { target, router, scheduler, canvas } = setup();
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'unbound-1' }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
  assert.equal(scheduler.getInstrumentation('A'), null);
  bindTile(router, scheduler, canvas);
  port.deliver(await delivery({ correlation: 'bound-1' }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED, FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 1);
  router.dispose();
});

test('replayed generation refuses after presentation', async () => {
  const { target, router, scheduler, canvas } = setup();
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'first' }));
  await untilAcks(port, 1);
  port.deliver(await delivery({ correlation: 'replay', leaseId: 'l1b' }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.REFUSED]);
  assert.equal(canvas.paints.length, 1);
  router.dispose();
});

test('pinned identity refuses a racing principal or epoch change', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { target, router, scheduler, canvas } = setup({
    digestSha256: async (bytes) => {
      await gate;
      return hexDigest(bytes);
    },
  });
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'pin', frameGeneration: 1, leaseId: 'l1' }));
  // The first accepted delivery pins utility/1 before its digest resolves.
  port.deliver(await delivery({ correlation: 'hijack', frameGeneration: 2, leaseId: 'l2', principal: 'other' }));
  port.deliver(await delivery({ correlation: 'hijack-epoch', frameGeneration: 3, leaseId: 'l3', epoch: 9 }));
  release();
  await untilAcks(port, 3);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED, FRAME_OUTCOMES.REFUSED, FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 1);
  assert.deepEqual(canvas.paints[0].data, [12, 34, 56, 255]);
  router.dispose();
});

test('newer delivery before paint supersedes the older one; exactly one paint', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { target, router, scheduler, canvas } = setup({
    digestSha256: async (bytes) => {
      await gate;
      return hexDigest(bytes);
    },
  });
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  const oldBytes = new Uint8Array([9, 9, 9]);
  const newBytes = new Uint8Array([7, 8, 9]);
  port.deliver(await delivery({ bytes: oldBytes, correlation: 'old', frameGeneration: 1, leaseId: 'l1' }));
  port.deliver(await delivery({ bytes: newBytes, correlation: 'new', frameGeneration: 2, leaseId: 'l2' }));
  await tick();
  assert.deepEqual(port.acks, [], 'nothing settles while validation is gated');
  release();
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SUPERSEDED, FRAME_OUTCOMES.PRESENTED]);
  assert.deepEqual(port.acks.map((ack) => ack.correlation), ['old', 'new']);
  assert.equal(canvas.paints.length, 1);
  assert.deepEqual(canvas.paints[0].data, [7, 8, 9, 255]);
  assert.deepEqual(router.getSurfaceStatus('A').presentedFrames, 1);
  router.dispose();
});

test('rapid deliveries settle exactly once each: one PRESENTED, rest SUPERSEDED', async () => {
  const { target, router, scheduler, canvas } = setup();
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  // Precompute, then deliver back-to-back with no yields: all three land
  // while the first digest is still pending.
  const pending = [
    await delivery({ correlation: 'r1', frameGeneration: 1, leaseId: 'l1' }),
    await delivery({ correlation: 'r2', frameGeneration: 2, leaseId: 'l2' }),
    await delivery({ bytes: new Uint8Array([5, 6, 7]), correlation: 'r3', frameGeneration: 3, leaseId: 'l3' }),
  ];
  for (const frame of pending) port.deliver(frame);
  await untilAcks(port, 3);
  assert.equal(port.acks.length, 3);
  const outcomeByCorrelation = Object.fromEntries(port.acks.map((ack) => [ack.correlation, ack.outcome]));
  assert.deepEqual(outcomeByCorrelation, {
    r1: FRAME_OUTCOMES.SUPERSEDED, r2: FRAME_OUTCOMES.SUPERSEDED, r3: FRAME_OUTCOMES.PRESENTED,
  });
  for (const ack of port.acks) {
    assert.equal(ack.schema, FRAME_ACK_SCHEMA);
    assert.equal(ack.kind, 'ack');
  }
  assert.equal(canvas.paints.length, 1);
  assert.deepEqual(canvas.paints[0].data, [5, 6, 7, 255]);
  assert.equal(scheduler.getInstrumentation('A').lastPresentedFrameGen, 3);
  router.dispose();
});

test('folded surface drains with FOLD_DRAIN and closes the port', async () => {
  const { target, router, scheduler, canvas } = setup();
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'live', frameGeneration: 1, leaseId: 'l1' }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
  scheduler.foldSurface('A');
  port.deliver(await delivery({ correlation: 'folded', frameGeneration: 2, leaseId: 'l2' }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.FOLD_DRAIN]);
  assert.equal(canvas.paints.length, 1);
  assert.equal(port.closed, true);
  assert.equal(port.listenerCount('message'), 0);
  assert.deepEqual(router.getSurfaceStatus(), []);
  // Late arrivals on the closed port change nothing.
  port.deliver(await delivery({ correlation: 'late', frameGeneration: 3, leaseId: 'l3' }));
  await tick();
  assert.equal(port.acks.length, 2);
  router.dispose();
});

test('hidden surface acks HIDDEN and closes the port', async () => {
  const { target, router, scheduler, canvas } = setup();
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'live', frameGeneration: 1, leaseId: 'l1' }));
  await untilAcks(port, 1);
  scheduler.updateSurfaceState('A', { viewportIntersecting: false });
  port.deliver(await delivery({ correlation: 'hidden', frameGeneration: 2, leaseId: 'l2' }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.HIDDEN]);
  assert.equal(canvas.paints.length, 1);
  assert.equal(port.closed, true);
  assert.deepEqual(router.getSurfaceStatus(), []);
  router.dispose();
});

test('context loss acks CONTEXT_LOST and closes the port; a newer stream recovers after restore', async () => {
  const { target, router, scheduler, canvas } = setup();
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'live', frameGeneration: 1, leaseId: 'l1' }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
  scheduler.onContextLost('A');
  port.deliver(await delivery({ correlation: 'lost', frameGeneration: 2, leaseId: 'l2' }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.CONTEXT_LOST]);
  assert.equal(canvas.paints.length, 1);
  assert.equal(port.closed, true);
  assert.equal(port.listenerCount('message'), 0);
  assert.deepEqual(router.getSurfaceStatus(), []);
  // Late arrivals on the closed port change nothing.
  port.deliver(await delivery({ correlation: 'late', frameGeneration: 3, leaseId: 'l3' }));
  await tick();
  assert.equal(port.acks.length, 2);
  // After restore, a newer stream presents again on the still-bound tile.
  scheduler.onContextRestored('A');
  const next = browserPort();
  target.emit(notice(next, { surface_generation: 2 }));
  next.deliver(await delivery({
    bytes: new Uint8Array([4, 5, 6]), correlation: 'back', frameGeneration: 3, leaseId: 'l3b',
  }));
  await untilAcks(next, 1);
  assert.deepEqual(ackOutcomes(next), [FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 2);
  assert.deepEqual(canvas.paints[1].data, [4, 5, 6, 255]);
  router.dispose();
});

test('destroyed surface acks SURFACE_DESTROYED and closes the port', async () => {
  const { target, router, scheduler, canvas } = setup();
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'live', frameGeneration: 1, leaseId: 'l1' }));
  await untilAcks(port, 1);
  scheduler.destroySurface('A');
  port.deliver(await delivery({ correlation: 'gone', frameGeneration: 2, leaseId: 'l2' }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.SURFACE_DESTROYED]);
  assert.equal(canvas.paints.length, 1);
  assert.equal(port.closed, true);
  assert.deepEqual(router.getSurfaceStatus(), []);
  router.dispose();
});

test('unbind closes the port; the in-flight delivery settles SURFACE_DESTROYED unpainted', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { target, router, scheduler, canvas } = setup({
    digestSha256: async (bytes) => {
      await gate;
      return hexDigest(bytes);
    },
  });
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'flight' }));
  router.unbindSurface('A');
  assert.equal(port.closed, true);
  assert.equal(port.listenerCount('message'), 0);
  release();
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SURFACE_DESTROYED]);
  assert.equal(canvas.paints.length, 0);
  router.dispose();
});

test('generation replacement settles the in-flight old record SUPERSEDED, never painted', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { target, router, scheduler, canvas } = setup({
    digestSha256: async (bytes) => {
      await gate;
      return hexDigest(bytes);
    },
  });
  const seen = [];
  router.bindSurface({
    surfaceId: 'A',
    scheduler,
    onRegistered: (registered) => {
      seen.push(registered.surfaceGeneration);
      scheduler.attachCanvas({
        surfaceId: registered.surfaceId,
        surfaceGeneration: registered.surfaceGeneration,
        epoch: registered.epoch,
        canvas,
      });
    },
  });
  const oldPort = browserPort();
  target.emit(notice(oldPort));
  oldPort.deliver(await delivery({
    bytes: new Uint8Array([1, 1, 1]), correlation: 'old-flight', frameGeneration: 1, leaseId: 'l1',
  }));
  const newPort = browserPort();
  target.emit(notice(newPort, { surface_generation: 2 }));
  assert.equal(oldPort.closed, true);
  release();
  await untilAcks(oldPort, 1);
  assert.deepEqual(ackOutcomes(oldPort), [FRAME_OUTCOMES.SUPERSEDED]);
  newPort.deliver(await delivery({
    bytes: new Uint8Array([2, 2, 2]),
    correlation: 'new-live', surfaceGeneration: 2, frameGeneration: 1, leaseId: 'l1g2',
  }));
  await untilAcks(newPort, 1);
  assert.deepEqual(ackOutcomes(newPort), [FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 1);
  assert.deepEqual(canvas.paints[0].data, [2, 2, 2, 255]);
  assert.deepEqual(seen, [2]);
  assert.equal(scheduler.getInstrumentation('A').surfaceGeneration, 2);
  router.dispose();
});

test('dispose drops the window listener, closes ports, settles the queue destroyed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { target, router, scheduler, canvas } = setup({
    digestSha256: async (bytes) => {
      await gate;
      return hexDigest(bytes);
    },
  });
  bindTile(router, scheduler, canvas);
  const port = browserPort();
  target.emit(notice(port));
  port.deliver(await delivery({ correlation: 'flight', frameGeneration: 1, leaseId: 'l1' }));
  router.dispose();
  assert.equal(target.listenerCount('message'), 0);
  assert.equal(port.closed, true);
  release();
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SURFACE_DESTROYED]);
  assert.equal(canvas.paints.length, 0);
  const late = browserPort();
  target.emit(notice(late));
  await tick();
  assert.equal(late.started, false);
  router.dispose();
});

test('bindSurface validates bindings; unknown status reads null', async () => {
  const { router } = setup();
  assert.equal(router.bindSurface(null), false);
  assert.equal(router.bindSurface({}), false);
  assert.equal(router.bindSurface({ surfaceId: 'A' }), false);
  assert.equal(router.bindSurface({ surfaceId: '', scheduler: {} }), false);
  assert.equal(router.bindSurface({ surfaceId: 'A', scheduler: {} }), false);
  assert.equal(router.getSurfaceStatus('missing'), null);
  assert.deepEqual(router.getSurfaceStatus(), []);
  router.unbindSurface('missing');
  router.unbindSurface(null);
  router.dispose();
  assert.equal(router.bindSurface({ surfaceId: 'A', scheduler: createTileScheduler({ budget: BUDGET }) }), false);
});
