// MVUI23D lane C: RV9 SurfaceCanvas items — reactive canvas dimensions wipe the
// attach repaint (L8-1 co-cause), keepStream grace retire on last unmount, and
// retained-frame clearing on destroyed/context-lost blanking. Deterministic
// repro with the REAL frame-port router + REAL tile scheduler + REAL
// SurfaceCanvas SFC (compiled with @vue/compiler-sfc, inline template) on a
// stub renderer: no DOM, no new dependencies. Plain node:test; bounded fakes
// (2x2/3x2 frames, single-digit deliveries); async waits only via frame-wait.
// The canvas double models REAL canvas semantics: ANY width/height set clears
// the bitmap, and the stub patchProp mirrors width/height onto the element
// like a DOM patch — so a reactive dimension patch after a sync paint wipes.
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
  KEEP_STREAM_GRACE_MS,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { tick, until, untilAcks } from './frame-wait.mjs';

const ORIGIN = 'app://metaviewer';
const NOTICE_GEN = 886;
const DELIVERY_GEN = 1;
const DELIVERY_EPOCH = 7;
const BYTES_2X2_A = [12, 34, 56, 78, 90, 11, 22, 33, 44, 55, 66, 77];
const BYTES_2X2_B = BYTES_2X2_A.map((b) => 255 - b);
const BYTES_3X2_A = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
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

// Real canvas semantics: setting width/height ALWAYS clears the bitmap,
// even to the same value. The order log pins paint-vs-resize ordering.
function wipeCanvasStub() {
  const canvas = {
    paints: [], patchKeys: [], orderLog: [], parent: null, children: [], props: {},
    getContext() {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: (image) => {
          canvas.paints.push({ width: image.width, height: image.height, data: [...image.data] });
          canvas.orderLog.push('paint');
        },
      };
    },
  };
  let w = 0;
  let h = 0;
  Object.defineProperties(canvas, {
    width: {
      get: () => w,
      set: (v) => { w = v; canvas.paints.length = 0; canvas.orderLog.push('dim'); },
      enumerable: true, configurable: true,
    },
    height: {
      get: () => h,
      set: (v) => { h = v; canvas.paints.length = 0; canvas.orderLog.push('dim'); },
      enumerable: true, configurable: true,
    },
  });
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
  const bytes = overrides.bytes ?? new Uint8Array(BYTES_2X2_A);
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
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui23d-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, { './tileScheduler.js': schedulerUrl });
  const tag = `mvui23d-tile-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');

// Legacy variant: the pre-fix reactive dimension bindings, rebuilt from the
// CURRENT source so the negative control tracks the live component. Any
// surviving binding is stripped first, then the reactive pair is restored.
function legacyTileSource() {
  const anchor = '<canvas ref="canvasRef" ';
  assert.ok(tileSource.includes(anchor), 'canvas tag anchor for the legacy variant');
  const stripped = tileSource.replace(/ :width="[^"]*" :height="[^"]*"/, '');
  assert.equal(stripped.includes(':width="'), false, 'legacy variant starts unbound');
  return stripped.replace(anchor, `${anchor}:width="frameWidth" :height="frameHeight" `);
}

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
      // Real-DOM model: a dimension patch writes the canvas IDL attribute,
      // which clears the bitmap on a real canvas (see wipeCanvasStub).
      if (el === canvasStub) {
        canvasStub.patchKeys.push(key);
        if ((key === 'width' || key === 'height') && Number.isSafeInteger(next)) el[key] = next;
      }
    },
  };
}

const mountNodes = (node) => [node, ...(node.children ?? []).flatMap(mountNodes)];
const mountText = (node) => [node.text ?? '', ...(node.children ?? []).map(mountText)].join(' ');
const sectionOf = (root) => mountNodes(root).find((node) => node.tag === 'section');

function mountTile(Component, provides, canvasStub, initialProps = {}) {
  const { createApp } = createRenderer(stubOps(canvasStub));
  const propsRef = ref({
    surfaceId: 'A', generation: DELIVERY_GEN, epoch: DELIVERY_EPOCH,
    frame: '', digest: '', state: 'live', frameWidth: 0, frameHeight: 0,
    ...initialProps,
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

function liveState(width = 2, height = 2) {
  return {
    panelOpen: true, panelSelected: true, folded: false,
    width, height, x: 0, y: 0,
    viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
  };
}

// ---------------------------------------------------------------------------
// RV9-02: no reactive dimension update may clear a painted frame.
// ---------------------------------------------------------------------------

test('mvui23d dims: template carries no reactive canvas dimensions', () => {
  assert.equal(tileSource.includes(':width="effectiveWidth"'), false);
  assert.equal(tileSource.includes(':height="effectiveHeight"'), false);
  assert.ok(tileSource.includes('class="mv-surface__canvas"'), 'aspect stays on the CSS class');
});

test('mvui23d dims: delivery size change plus prop update keeps the painted frame', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = wipeCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 's-1', frameGeneration: 886, leaseId: 's-l1' }));
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    await until(() => canvas.paints.length === 1, 'first paint after mount', 2000);
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.width, 2, 'canvas sized from the delivery');
    const info = scheduler.getInstrumentation('A');
    await mounted.setProps({
      frame: info.lastPresentedHandle, digest: info.lastPresentedDigest,
      frameWidth: info.lastPresentedWidth, frameHeight: info.lastPresentedHeight,
    });
    assert.equal(sectionOf(mounted.root).props['data-state'], 'live');
    // New delivery size, then the matching prop update: the painted frame
    // must survive both — dimensions move only inside the paint step.
    port.deliver(await frameDelivery({
      correlation: 's-2', frameGeneration: 887, leaseId: 's-l2',
      bytes: new Uint8Array(BYTES_3X2_A), width: 3, height: 2,
    }));
    await untilAcks(port, 2);
    await until(() => canvas.paints.length >= 1 && canvas.width === 3, 'repaint at the new size', 2000);
    await mounted.setProps({ frameWidth: 3, frameHeight: 2 });
    assert.ok(canvas.paints.length >= 1, 'a painted frame survives the dimension change');
    assert.deepEqual(canvas.paints.at(-1).data, rgbaOf(BYTES_3X2_A));
    assert.equal(canvas.width, 3, 'canvas sized from the new delivery, not the props');
    assert.equal(canvas.height, 2);
    assert.equal(canvas.patchKeys.includes('width'), false, 'no reactive width patch hits the canvas');
    assert.equal(canvas.patchKeys.includes('height'), false, 'no reactive height patch hits the canvas');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui23d dims: surface switch repaints the static frame and survives', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas1 = wipeCanvasStub();
  const canvas2 = wipeCanvasStub();
  const portA = framePort();
  const portB = framePort();
  target.emit(portNotice(portA, 'A'));
  target.emit(portNotice(portB, 'B'));
  const tile1 = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas1);
  portA.deliver(await frameDelivery({
    correlation: 'a-1', frameGeneration: 886, leaseId: 'a-l1',
    bytes: new Uint8Array(BYTES_3X2_A), width: 3, height: 2,
  }));
  const tile2 = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas2,
    { surfaceId: 'B', frameWidth: 2, frameHeight: 2 });
  portB.deliver(await frameDelivery({
    correlation: 'b-1', frameGeneration: 886, leaseId: 'b-l1', surfaceId: 'B',
    bytes: new Uint8Array(BYTES_2X2_B),
  }));
  try {
    await until(() => canvas1.paints.length === 1, 'A paints on tile1', 2000);
    await until(() => canvas2.paints.length === 1, 'B paints on tile2', 2000);
    await untilAcks(portA, 1);
    await untilAcks(portB, 1);
    assert.equal(canvas2.width, 2);
    // The co-cause switch: tile2 leaves B for the static A surface. The
    // attach repaints A's retained frame synchronously; with a static source
    // nothing would repaint a wipe, so the tile would stay black.
    await tile2.setProps({ surfaceId: 'A', frame: '', digest: '', frameWidth: 3, frameHeight: 2 });
    assert.ok(canvas2.paints.length >= 1, 'the switch repaint survives (no post-paint wipe)');
    assert.deepEqual(canvas2.paints.at(-1).data, rgbaOf(BYTES_3X2_A));
    assert.equal(canvas2.width, 3, 'canvas sized from the delivery, not the props');
    assert.equal(canvas2.patchKeys.includes('width'), false, 'no reactive width patch hits the canvas');
    assert.equal(canvas2.patchKeys.includes('height'), false, 'no reactive height patch hits the canvas');
    // The surface change unbinds without keepStream: B retires at once.
    assert.equal(router.getSurfaceStatus('B'), null);
    assert.equal(portB.closed, true);
  } finally {
    tile1.app.unmount();
    tile2.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui23d dims negative control: the old reactive binding wipes the painted frame', async () => {
  const LegacyCanvas = await compileTile(legacyTileSource());
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = wipeCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'n-1', frameGeneration: 886, leaseId: 'n-l1' }));
  const mounted = mountTile(LegacyCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas,
    { frameWidth: 2, frameHeight: 2 });
  try {
    await until(() => canvas.paints.length === 1, 'legacy paints before the patch', 2000);
    await untilAcks(port, 1);
    await mounted.setProps({ frameWidth: 3, frameHeight: 2 });
    assert.ok(canvas.patchKeys.includes('width'), 'the reactive dimension patch fires');
    assert.deepEqual(canvas.paints, [], 'the post-paint dimension patch wipes the bitmap (black tile)');
    assert.equal(canvas.width, 3, 'the patch resizes but the frame is gone');
    const lastPaintAt = canvas.orderLog.lastIndexOf('paint');
    const lastDimAt = canvas.orderLog.lastIndexOf('dim');
    assert.ok(lastDimAt > lastPaintAt, 'the dimension set lands after the paint');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

// ---------------------------------------------------------------------------
// RV9-01: the last unmount without a remount retires within the grace.
// ---------------------------------------------------------------------------

test('mvui23d unmount: last tile unmount retires the stream within the grace', async () => {
  assert.equal(KEEP_STREAM_GRACE_MS, 500, 'this base keeps streams across a 500 ms remount grace');
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = wipeCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'u-1', frameGeneration: 886, leaseId: 'u-l1' }));
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    await until(() => canvas.paints.length === 1, 'paint before unmount', 2000);
    await untilAcks(port, 1);
    const t0 = Date.now();
    mounted.app.unmount();
    // The grace holds the stream for the remounting tile: still open now.
    assert.notEqual(router.getSurfaceStatus('A'), null);
    assert.equal(router.getSurfaceStatus('A').portOpen, true);
    assert.equal(port.closed, false);
    // ...but a capsule that goes away must not leak its port.
    await until(() => router.getSurfaceStatus('A') === null, 'grace expiry retires the stream', 2000);
    assert.equal(port.closed, true, 'the port closes on grace expiry');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 400, `the grace holds first (elapsed ${elapsed} ms)`);
    assert.ok(elapsed < 1500, `the retire stays bounded (elapsed ${elapsed} ms)`);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui23d unmount: remount within the grace keeps the stream alive', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas1 = wipeCanvasStub();
  const canvas2 = wipeCanvasStub();
  const port = framePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'r-1', frameGeneration: 886, leaseId: 'r-l1' }));
  const tile1 = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas1);
  try {
    await until(() => canvas1.paints.length === 1, 'paint before the swap', 2000);
    await untilAcks(port, 1);
    const t0 = Date.now();
    tile1.app.unmount();
    const tile2 = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas2);
    try {
      await until(() => Date.now() - t0 >= 700, 'past the 500 ms grace');
      await tick();
      const status = router.getSurfaceStatus('A');
      assert.notEqual(status, null, 'the rebound stream survives past the grace');
      assert.equal(status.portOpen, true);
      assert.equal(port.closed, false);
      assert.equal(canvas2.paints.length, 1, 'the remount repaints the retained frame');
      assert.deepEqual(canvas2.paints[0].data, rgbaOf(BYTES_2X2_A));
    } finally {
      tile2.app.unmount();
    }
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

// ---------------------------------------------------------------------------
// RV9-03: retainedFrame clears on destroyed/context-lost blanking.
// ---------------------------------------------------------------------------

test('mvui23d retained: legacy generation skew degrades the tile to connecting', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const scheduler = createTileScheduler({ budget: BUDGET });
  // The legacy tile painted before: the entry carries the old identity.
  assert.equal(scheduler.registerSurface({
    surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
    principal: 'utility', epoch: DELIVERY_EPOCH, state: liveState(),
  }).ok, true);
  const canvas = wipeCanvasStub();
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: null }, canvas,
    { frame: 'h1', digest: 'd1', state: 'live', frameWidth: 2, frameHeight: 2 });
  try {
    assert.equal(sectionOf(mounted.root).props['data-state'], 'live');
    assert.match(mountText(mounted.root), /FRAME: h1/);
    // Legacy skew (R1-074): the witness blanks while the generation moves on.
    await mounted.setProps({ frame: '', digest: '', generation: 2 });
    assert.equal(sectionOf(mounted.root).props['data-state'], 'connecting');
    assert.doesNotMatch(mountText(mounted.root), /h1/, 'no stale frame shown as live');
  } finally {
    mounted.app.unmount();
    scheduler.destroy();
  }
});

test('mvui23d retained: router-null tile with no entry retains across the gap', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = wipeCanvasStub();
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: null }, canvas,
    { frame: 'h1', digest: 'd1', state: 'live', frameWidth: 2, frameHeight: 2 });
  try {
    // L2-8 shape: an unknown entry cannot be stale, so the gap retains.
    await mounted.setProps({ frame: '', digest: '', generation: 2 });
    assert.equal(sectionOf(mounted.root).props['data-state'], 'live');
    assert.match(mountText(mounted.root), /FRAME: h1/);
  } finally {
    mounted.app.unmount();
    scheduler.destroy();
  }
});

test('mvui23d retained: a live transient gap keeps the retained frame', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  assert.equal(scheduler.registerSurface({
    surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
    principal: 'utility', epoch: DELIVERY_EPOCH, state: liveState(),
  }).ok, true);
  const canvas = wipeCanvasStub();
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas,
    { frame: 'h1', digest: 'd1', state: 'live', frameWidth: 2, frameHeight: 2 });
  try {
    assert.equal(sectionOf(mounted.root).props['data-state'], 'live');
    // L2-8 anti-flash: a blank over a healthy live entry must retain.
    await mounted.setProps({ frame: '', digest: '' });
    assert.equal(sectionOf(mounted.root).props['data-state'], 'live');
    assert.match(mountText(mounted.root), /FRAME: h1/);
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui23d retained: context-lost blanking clears the stale frame', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  assert.equal(scheduler.registerSurface({
    surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
    principal: 'utility', epoch: DELIVERY_EPOCH, state: liveState(),
  }).ok, true);
  const canvas = wipeCanvasStub();
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas,
    { frame: 'h1', digest: 'd1', state: 'live', frameWidth: 2, frameHeight: 2 });
  try {
    assert.equal(sectionOf(mounted.root).props['data-state'], 'live');
    assert.equal(scheduler.onContextLost('A').ok, true);
    assert.equal(scheduler.getInstrumentation('A').contextLost, true);
    await mounted.setProps({ frame: '', digest: '' });
    assert.equal(sectionOf(mounted.root).props['data-state'], 'connecting');
    assert.doesNotMatch(mountText(mounted.root), /h1/, 'no stale frame shown as live');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui23d retained: destroyed blanking clears the stale frame', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  assert.equal(scheduler.registerSurface({
    surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
    principal: 'utility', epoch: DELIVERY_EPOCH, state: liveState(),
  }).ok, true);
  const canvas = wipeCanvasStub();
  const mounted = mountTile(SurfaceCanvas, { tileScheduler: scheduler, framePortRouter: router }, canvas,
    { frame: 'h1', digest: 'd1', state: 'live', frameWidth: 2, frameHeight: 2 });
  try {
    assert.equal(sectionOf(mounted.root).props['data-state'], 'live');
    assert.equal(scheduler.destroySurface('A').ok, true);
    assert.equal(scheduler.getInstrumentation('A').destroyed, true);
    await mounted.setProps({ frame: '', digest: '' });
    assert.equal(sectionOf(mounted.root).props['data-state'], 'connecting');
    assert.doesNotMatch(mountText(mounted.root), /h1/, 'no stale frame shown as live');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui23d surface canvas: rss stays bounded', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
