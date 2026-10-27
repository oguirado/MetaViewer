// MVUI23 lane S: L8-1 startup race — notice + deliveries arrive BEFORE the wall
// SurfaceCanvas binds, and the tile stays black until a remount. Deterministic
// repro with the REAL frame-port router + REAL tile scheduler + REAL
// SurfaceCanvas SFC (compiled with @vue/compiler-sfc, inline template) on a
// stub renderer: no DOM, no new dependencies. Plain node:test; bounded fakes
// (2x2 frames, single-digit deliveries); async waits only via frame-wait.mjs.
// MVUI23C lane H: hold expiry acks HIDDEN but keeps the bytes — a bind after
// the window still paints with exactly one ack (the host never resends a
// static frame after ANY ack).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';
import installFramePortRouter, {
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler, SCHEDULER_REASONS } from '../src/surfaces/tileScheduler.js';
import { tick, until, untilAcks } from './frame-wait.mjs';

const ORIGIN = 'app://metaviewer';
// REAL-like identities (live8/9): notice stream id 886, delivery binding 1/7,
// projection props 889 + an unrelated snapshot epoch.
const NOTICE_GEN = 886;
const DELIVERY_GEN = 1;
const DELIVERY_EPOCH = 7;
const PROPS_GEN = 889;
const SNAP_EPOCH = 4242;
// Static source content: every delivery carries these identical bytes.
const STATIC_BYTES = [12, 34, 56, 78, 90, 11, 22, 33, 44, 55, 66, 77];
// Second static content: proves the NEWER delivery (not the kept one) paints.
const STATIC_BYTES_B = STATIC_BYTES.map((b) => 255 - b);
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
async function hexDigest(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const realDigest = (bytes) => hexDigest(bytes);

function fakeWindow() {
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

function framePort() {
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

function drawableCanvasStub() {
  const canvas = {
    paints: [], width: 0, height: 0, parent: null, children: [], props: {},
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

function portNotice(port, surfaceId = 'A', generation = NOTICE_GEN) {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE, schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: surfaceId, surface_generation: generation,
    },
    origin: ORIGIN, ports: [port],
  };
}

async function frameDelivery(overrides = {}) {
  const bytes = overrides.bytes ?? new Uint8Array(STATIC_BYTES);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'c1', principal: 'utility',
    epoch: DELIVERY_EPOCH, surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
    frameGeneration: NOTICE_GEN, leaseId: 'l1',
    width: 2, height: 2, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

const ackOutcomes = (port) => port.acks.map((ack) => ack.outcome);
const ackCorrelations = (port) => port.acks.map((ack) => ack.correlation);

const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
let sfcSerial = 0;

function rewriteImports(code, deps) {
  let out = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, vueUrl);
    assert.ok(spec in deps, `Unmapped SFC dependency: ${spec}`);
    return `const ${bindings.trim()} = await import(${deps[spec]});`;
  });
  return out;
}

async function compileTile(source) {
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui23-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, { './tileScheduler.js': schedulerUrl });
  const tag = `mvui23-tile-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');

function stubOps(canvasStub) {
  return {
    createElement(tag) {
      if (tag === 'canvas' && canvasStub) return canvasStub;
      return { tag, props: {}, children: [], text: null, parent: null };
    },
    createText(text) { return { text, parent: null }; },
    createComment(text) { return { comment: text, parent: null }; },
    setText(node, text) { node.text = text; },
    setElementText(el, text) { el.children = []; el.text = text; },
    insert(child, parent, anchor = null) {
      if (!parent || !Array.isArray(parent.children)) return;
      child.parent = parent;
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at >= 0) parent.children.splice(at, 0, child);
      else parent.children.push(child);
    },
    remove(child) {
      const parent = child.parent;
      if (parent && Array.isArray(parent.children)) {
        const at = parent.children.indexOf(child);
        if (at >= 0) parent.children.splice(at, 1);
      }
      child.parent = null;
    },
    parentNode(node) { return node.parent ?? null; },
    nextSibling(node) {
      const parent = node.parent;
      if (!parent || !Array.isArray(parent.children)) return null;
      return parent.children[parent.children.indexOf(node) + 1] ?? null;
    },
    patchProp(el, key, _prev, next) {
      if (!el.props || typeof el.props !== 'object') el.props = {};
      el.props[key] = next;
    },
  };
}

const mountNodes = (node) => [node, ...(node.children ?? []).flatMap(mountNodes)];
const mountText = (node) => [node.text ?? '', ...(node.children ?? []).map(mountText)].join(' ');

function mountTile(Component, provides, canvasStub) {
  const { createApp } = createRenderer(stubOps(canvasStub));
  const propsRef = ref({
    surfaceId: 'A', generation: PROPS_GEN, epoch: SNAP_EPOCH,
    frame: '', digest: '', state: 'live',
  });
  const Holder = { setup: () => () => h(Component, { ...propsRef.value }) };
  const app = createApp(Holder);
  for (const [key, value] of Object.entries(provides)) app.provide(key, value);
  const root = { children: [] };
  app.mount(root);
  return {
    app, root,
    async setProps(patch) {
      propsRef.value = { ...propsRef.value, ...patch };
      await nextTick();
      await nextTick();
      await tick();
    },
  };
}

function rgbaOf(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 3) {
    out.push(bytes[i], bytes[i + 1], bytes[i + 2], 255);
  }
  return out;
}

function expectedRgba2x2() {
  return rgbaOf(STATIC_BYTES);
}

// ---------------------------------------------------------------------------
// L8-1: deliveries before the canvas binding must paint after mount.
// ---------------------------------------------------------------------------

test('L8-1: notice + 3 static deliveries before mount paint after mount without remount', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  // The source is static: identical bytes, advancing frame generations.
  port.deliver(await frameDelivery({ correlation: 'pre-1', frameGeneration: 886, leaseId: 'pre-l1' }));
  port.deliver(await frameDelivery({ correlation: 'pre-2', frameGeneration: 887, leaseId: 'pre-l2' }));
  port.deliver(await frameDelivery({ correlation: 'pre-3', frameGeneration: 888, leaseId: 'pre-l3' }));
  await tick();
  // Nothing is lost while unbound: older held deliveries supersede, the
  // newest stays un-acked until the binding appears.
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SUPERSEDED, FRAME_OUTCOMES.SUPERSEDED]);
  assert.deepEqual(ackCorrelations(port), ['pre-1', 'pre-2']);
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    const section = () => mountNodes(mounted.root).find((node) => node.tag === 'section');
    assert.equal(section().props['data-state'], 'connecting');
    await until(() => canvas.paints.length === 1, 'first paint after mount', 2000);
    await untilAcks(port, 3);
    assert.deepEqual(ackOutcomes(port),
      [FRAME_OUTCOMES.SUPERSEDED, FRAME_OUTCOMES.SUPERSEDED, FRAME_OUTCOMES.PRESENTED]);
    assert.deepEqual(ackCorrelations(port), ['pre-1', 'pre-2', 'pre-3']);
    // The first frame after mount paints even though its bytes are identical
    // to the earlier (superseded) deliveries.
    assert.deepEqual(canvas.paints[0].width, 2);
    assert.deepEqual(canvas.paints[0].data, expectedRgba2x2());
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.canvasAttached, true);
    assert.equal(info.lastPresentedFrameGen, 888);
    assert.ok(info.lastPresentedHandle.length > 0);
    // One mount, no round trip: the presented witness leaves Connecting.
    await mounted.setProps({
      frame: info.lastPresentedHandle, digest: info.lastPresentedDigest,
      frameWidth: info.lastPresentedWidth, frameHeight: info.lastPresentedHeight,
    });
    assert.equal(section().props['data-state'], 'live');
    assert.doesNotMatch(mountText(mounted.root), /Connecting to surface/);
    assert.equal(port.closed, false, 'held deliveries keep the stream open');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('L8-1 variant: notice before mount, delivery after mount paints', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  await tick();
  assert.deepEqual(port.acks, []);
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    port.deliver(await frameDelivery({ correlation: 'post-1', frameGeneration: 886, leaseId: 'post-l1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    await until(() => canvas.paints.length === 1, 'paint after mount', 2000);
    assert.deepEqual(canvas.paints[0].data, expectedRgba2x2());
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('L8-1 variant: mount between deliveries paints both without remount', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'mid-1', frameGeneration: 886, leaseId: 'mid-l1' }));
  await tick();
  assert.deepEqual(port.acks, [], 'the single pre-mount delivery stays held');
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    await until(() => canvas.paints.length === 1, 'held delivery paints on mount', 2000);
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    port.deliver(await frameDelivery({ correlation: 'mid-2', frameGeneration: 887, leaseId: 'mid-l2' }));
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    await until(() => canvas.paints.length === 2, 'second delivery paints', 2000);
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('L8-1 hold expiry: an unbound delivery hides within a bounded window', async () => {
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, pendingUnboundMs: 60 });
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'lone' }));
    await tick();
    assert.deepEqual(port.acks, [], 'held deliveries stay un-acked before the window ends');
    await untilAcks(port, 1);
    // MVUI23C: expiry frees the host inFlight with HIDDEN (not REFUSED) and
    // keeps the bytes for the late tile; the stream stays open.
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.HIDDEN]);
    assert.equal(port.closed, false, 'expiry keeps the stream open for the late tile');
  } finally {
    router.dispose();
  }
});

test('L8-1 compat: invalid delivery while unbound refuses immediately, never held', async () => {
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'bad-shape', format: 'rgba' }));
    await tick();
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
  } finally {
    router.dispose();
  }
});

test('L8-1 compat: sha mismatch while unbound still refuses without paint', async () => {
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, pendingUnboundMs: 60 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'bad-sha', sha256: 'f'.repeat(64) }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
    assert.equal(scheduler.getInstrumentation('A'), null);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

// ---------------------------------------------------------------------------
// MVUI23C: expiry acks HIDDEN but keeps the bytes for the late tile.
// ---------------------------------------------------------------------------

test('MVUI23C: bind after the window paints the kept bytes with exactly one HIDDEN ack', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, pendingUnboundMs: 50 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const port = framePort();
  const t0 = Date.now();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'kept-1', frameGeneration: 886, leaseId: 'kept-l1' }));
  await tick();
  assert.deepEqual(port.acks, [], 'the held delivery stays un-acked inside the window');
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.HIDDEN]);
  assert.equal(port.closed, false, 'expiry keeps the stream open for the late tile');
  // Slow startup: the wall canvas binds well after the window.
  await until(() => Date.now() - t0 >= 200, 'bind delay past the window');
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    await until(() => canvas.paints.length === 1, 'kept bytes paint after late bind', 2000);
    await tick();
    assert.deepEqual(canvas.paints[0].width, 2);
    assert.deepEqual(canvas.paints[0].data, expectedRgba2x2());
    // Exactly one ack for the held delivery: no second ack on the late paint.
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.HIDDEN]);
    assert.deepEqual(ackCorrelations(port), ['kept-1']);
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.canvasAttached, true);
    assert.equal(info.lastPresentedFrameGen, 886);
    assert.ok(info.lastPresentedHandle.length > 0);
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('MVUI23C: bind inside the window presents with no expiry ack', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, pendingUnboundMs: 50 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const port = framePort();
  const t0 = Date.now();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'in-1', frameGeneration: 886, leaseId: 'in-l1' }));
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    await until(() => canvas.paints.length === 1, 'held delivery paints on mount', 2000);
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.deepEqual(canvas.paints[0].data, expectedRgba2x2());
    // Past the window: the drained hold never settles twice.
    await until(() => Date.now() - t0 >= 200, 'settle past the window');
    await tick();
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('MVUI23C: newer delivery inside the window supersedes the older held one', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, pendingUnboundMs: 500 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'sup-old', frameGeneration: 886, leaseId: 'sup-old-l' }));
  port.deliver(await frameDelivery({
    correlation: 'sup-new', frameGeneration: 887, leaseId: 'sup-new-l',
    bytes: new Uint8Array(STATIC_BYTES_B),
  }));
  await tick();
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SUPERSEDED]);
  assert.deepEqual(ackCorrelations(port), ['sup-old']);
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    await until(() => canvas.paints.length === 1, 'newest held delivery paints', 2000);
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SUPERSEDED, FRAME_OUTCOMES.PRESENTED]);
    assert.deepEqual(canvas.paints[0].data, rgbaOf(STATIC_BYTES_B));
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('MVUI23C: newer delivery after expiry replaces the kept frame', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, pendingUnboundMs: 50 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'kept-old', frameGeneration: 886, leaseId: 'kept-old-l' }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.HIDDEN]);
  port.deliver(await frameDelivery({
    correlation: 'kept-new', frameGeneration: 887, leaseId: 'kept-new-l',
    bytes: new Uint8Array(STATIC_BYTES_B),
  }));
  await tick();
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.HIDDEN], 'the newer delivery holds un-acked');
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    await until(() => canvas.paints.length === 1, 'replacement paints on mount', 2000);
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.HIDDEN, FRAME_OUTCOMES.PRESENTED]);
    assert.deepEqual(ackCorrelations(port), ['kept-old', 'kept-new']);
    assert.deepEqual(canvas.paints[0].data, rgbaOf(STATIC_BYTES_B));
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('MVUI23C negative control: REFUSED-and-drop stays black after a late bind', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, pendingUnboundMs: 50 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const port = framePort();
  const t0 = Date.now();
  target.emit(portNotice(port));
  // Shape-valid but corrupt: expiry REFUSES and drops it (the old path).
  port.deliver(await frameDelivery({ correlation: 'corrupt', sha256: 'f'.repeat(64) }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
  await until(() => Date.now() - t0 >= 200, 'bind delay past the window');
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    // Long past any paint: nothing was kept, so the tile stays black.
    await until(() => Date.now() - t0 >= 500, 'black-tile observation window');
    await tick();
    assert.deepEqual(canvas.paints, []);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
    const section = () => mountNodes(mounted.root).find((node) => node.tag === 'section');
    assert.equal(section().props['data-state'], 'connecting');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

// ---------------------------------------------------------------------------
// Scheduler guard: registered before canvas attached — late attach paints.
// ---------------------------------------------------------------------------

function liveState(width = 2, height = 2) {
  return {
    panelOpen: true, panelSelected: true, folded: false,
    width, height, x: 0, y: 0,
    viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
  };
}

function schedulerFrame(overrides = {}) {
  const bytes = overrides.bytes ?? new Uint8Array(STATIC_BYTES);
  return {
    surfaceId: 'A', surfaceGeneration: DELIVERY_GEN, frameGeneration: 1,
    leaseId: 'sg-l1', byteLength: bytes.byteLength, width: 2, height: 2,
    bytes, principal: 'utility', epoch: DELIVERY_EPOCH, sha256: 'sg', ...overrides,
  };
}

test('mvui23 guard: late attach paints the retained frame without a new submit', () => {
  const releases = [];
  const scheduler = createTileScheduler({
    budget: BUDGET,
    onReleaseLease: (release) => releases.push(release),
  });
  try {
    assert.equal(scheduler.registerSurface({
      surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
      principal: 'utility', epoch: DELIVERY_EPOCH, state: liveState(),
    }).ok, true);
    assert.equal(scheduler.submitFrame(schedulerFrame()).ok, true);
    assert.equal(scheduler.runTick().drawsUsed, 1);
    // Existing no-canvas semantics stay: the candidate retires, the lease
    // releases REFUSED, nothing presents.
    assert.equal(releases.length, 1);
    assert.equal(releases[0].reason, 'REFUSED');
    assert.equal(scheduler.getInstrumentation('A').presentCount, 0);
    const canvas = drawableCanvasStub();
    assert.equal(scheduler.attachCanvas({
      surfaceId: 'A', surfaceGeneration: DELIVERY_GEN, epoch: DELIVERY_EPOCH, canvas,
    }).ok, true);
    assert.equal(canvas.paints.length, 1, 'late attach paints the retained frame');
    assert.deepEqual(canvas.paints[0].data, expectedRgba2x2());
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedFrameGen, 1);
    assert.ok(info.lastPresentedHandle.length > 0);
  } finally {
    scheduler.destroy();
  }
});

test('mvui23 guard: newest undrawn frame wins; identity checks stay intact', () => {
  const scheduler = createTileScheduler({ budget: BUDGET });
  try {
    assert.equal(scheduler.registerSurface({
      surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
      principal: 'utility', epoch: DELIVERY_EPOCH, state: liveState(),
    }).ok, true);
    const oldBytes = new Uint8Array(STATIC_BYTES);
    const newBytes = new Uint8Array(STATIC_BYTES.map((b) => 255 - b));
    assert.equal(scheduler.submitFrame(schedulerFrame({ bytes: oldBytes })).ok, true);
    assert.equal(scheduler.runTick().drawsUsed, 1);
    assert.equal(scheduler.submitFrame(schedulerFrame({
      bytes: newBytes, frameGeneration: 2, leaseId: 'sg-l2',
    })).ok, true);
    assert.equal(scheduler.runTick().drawsUsed, 1);
    const canvas = drawableCanvasStub();
    // The scheduler identity checks stay intact on the late attach.
    assert.equal(scheduler.attachCanvas({
      surfaceId: 'A', surfaceGeneration: NOTICE_GEN, epoch: DELIVERY_EPOCH, canvas,
    }).reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(scheduler.attachCanvas({
      surfaceId: 'A', surfaceGeneration: DELIVERY_GEN, epoch: SNAP_EPOCH, canvas,
    }).reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(canvas.paints.length, 0);
    assert.equal(scheduler.attachCanvas({
      surfaceId: 'A', surfaceGeneration: DELIVERY_GEN, epoch: DELIVERY_EPOCH, canvas,
    }).ok, true);
    assert.equal(canvas.paints.length, 1);
    assert.deepEqual(canvas.paints[0].data, rgbaOf([...newBytes]));
  } finally {
    scheduler.destroy();
  }
});

test('mvui23 memory: suite rss stays under the 512 MiB ceiling', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
