// MVUI20 lane M (plan MV-UI12): multislot round-trip (L4-1) + first-paint
// placeholder (L4-2). REAL frame-port router + REAL tile scheduler, bounded
// fakes (2x2 frames, single stream), plus REAL SurfaceCanvas SFC mount pairs
// (wall + multislot). One canvas is active per surface (R2-12): the most
// recently mounted tile paints, and unbinding it restores the previous tile
// with an immediate retained repaint. Plain node:test.
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
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
import { tick, untilAcks } from './frame-wait.mjs';

const ORIGIN = 'app://metaviewer';
const NOTICE_GEN = 886;
const DELIVERY_GEN = 1;
const DELIVERY_EPOCH = 7;
// Projection props the wall feeds the tile: never equal to the delivery
// identity, so the first canvas attach fails and the router notice retries.
const PROPS_GEN = 887;
const SNAP_EPOCH = 4242;
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

function portNotice(port, surfaceId = 'A', generation = NOTICE_GEN) {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE, schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: surfaceId, surface_generation: generation,
    },
    origin: ORIGIN, ports: [port],
  };
}

// Distinct bytes per frame generation so repaints are attributable.
function frameBytes(generation) {
  const bytes = new Uint8Array(12);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (generation * 31 + i * 17) % 256;
  return bytes;
}

async function frameDelivery(overrides = {}) {
  const generation = overrides.frameGeneration ?? 1;
  const bytes = overrides.bytes ?? frameBytes(generation);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: `c${generation}`, principal: 'utility',
    epoch: DELIVERY_EPOCH, surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
    frameGeneration: generation, leaseId: `l${generation}`,
    width: 2, height: 2, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

const ackOutcomes = (port) => port.acks.map((ack) => ack.outcome);
const paintBytes = (canvas, index) => canvas.paints[index].data;
function rgb24ToRgba(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 3) out.push(bytes[i], bytes[i + 1], bytes[i + 2], 255);
  return out;
}

// One mounted tile, App/SurfaceCanvas-shaped: the first attach uses the
// mismatched projection identity (fails while unregistered or mismatched),
// the bind carries this tile's token, and the router notice retries the
// attach with the delivery identity. Unmount keeps the stream (remount gap).
function mountTile(router, scheduler, surfaceId, bindToken) {
  const canvas = drawableCanvasStub();
  const tile = { canvas, bindToken, canvasToken: null };
  const first = scheduler.attachCanvas({
    surfaceId, surfaceGeneration: PROPS_GEN, epoch: SNAP_EPOCH, canvas,
  });
  if (first?.ok === true) tile.canvasToken = first.token ?? null;
  router.bindSurface({
    surfaceId, scheduler, bindToken,
    onRegistered: (notice) => {
      if (notice.surfaceId !== surfaceId) return;
      scheduler.detachCanvas(surfaceId, tile.canvasToken);
      tile.canvasToken = null;
      const attached = scheduler.attachCanvas({
        surfaceId, surfaceGeneration: notice.surfaceGeneration, epoch: notice.epoch, canvas,
      });
      if (attached?.ok === true) tile.canvasToken = attached.token ?? null;
    },
  });
  return tile;
}

function unmountTile(router, scheduler, surfaceId, tile) {
  router.unbindSurface(surfaceId, tile.bindToken, { keepStream: true });
  scheduler.detachCanvas(surfaceId, tile.canvasToken);
  tile.canvasToken = null;
}

function liveSetup() {
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  assert.ok(router, 'router installs on the harness window');
  const scheduler = createTileScheduler({ budget: BUDGET });
  return { target, router, scheduler };
}

function streamStatus(router, surfaceId = 'A') {
  return router.getSurfaceStatus(surfaceId);
}

// ---------------------------------------------------------------------------
// L4-1: wall -> multislot -> wall round trip.
// ---------------------------------------------------------------------------

test('L4-1: wall -> multislot -> wall repaints the last frame; stream survives', async () => {
  const { target, router, scheduler } = liveSetup();
  try {
    const wall = mountTile(router, scheduler, 'A', Symbol('wall'));
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ frameGeneration: 1 }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(wall.canvas.paints.length, 1);
    assert.deepEqual(paintBytes(wall.canvas, 0), rgb24ToRgba(frameBytes(1)));
    // The multislot mounts for the same surface: its canvas shows the last
    // presented frame immediately, with no new delivery.
    const multi = mountTile(router, scheduler, 'A', Symbol('multi'));
    assert.equal(multi.canvas.paints.length, 1, 'multislot canvas repaints the last frame on attach');
    assert.deepEqual(paintBytes(multi.canvas, 0), rgb24ToRgba(frameBytes(1)));
    assert.equal(wall.canvas.paints.length, 1, 'wall canvas untouched by the second attach');
    // The wall tile unmounts (App v-if): the multislot binding and stream
    // must survive the unbind of the inactive binding.
    unmountTile(router, scheduler, 'A', wall);
    assert.equal(port.closed, false, 'unbinding one tile never closes the shared stream');
    assert.equal(streamStatus(router)?.portOpen, true);
    port.deliver(await frameDelivery({ frameGeneration: 2, correlation: 'c2', leaseId: 'l2' }));
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(multi.canvas.paints.length, 2);
    assert.deepEqual(paintBytes(multi.canvas, 1), rgb24ToRgba(frameBytes(2)));
    assert.equal(wall.canvas.paints.length, 1, 'unmounted wall canvas paints nothing');
    // Back to the wall: the multislot unmounts, the wall remounts on a fresh
    // canvas, and the last frame repaints immediately from retained bytes.
    unmountTile(router, scheduler, 'A', multi);
    assert.equal(port.closed, false, 'the stream survives the remount gap');
    const wall2 = mountTile(router, scheduler, 'A', Symbol('wall2'));
    assert.equal(wall2.canvas.paints.length, 1, 'remounted wall canvas repaints without a new delivery');
    assert.deepEqual(paintBytes(wall2.canvas, 0), rgb24ToRgba(frameBytes(2)));
    port.deliver(await frameDelivery({ frameGeneration: 3, correlation: 'c3', leaseId: 'l3' }));
    await untilAcks(port, 3);
    assert.deepEqual(ackOutcomes(port),
      [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(wall2.canvas.paints.length, 2);
    assert.deepEqual(paintBytes(wall2.canvas, 1), rgb24ToRgba(frameBytes(3)));
    assert.equal(streamStatus(router)?.bound, true);
    assert.equal(streamStatus(router)?.portOpen, true);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('L4-1 reverse: unbinding the active tile restores the previous one', async () => {
  const { target, router, scheduler } = liveSetup();
  try {
    const multi = mountTile(router, scheduler, 'A', Symbol('multi'));
    const wall = mountTile(router, scheduler, 'A', Symbol('wall'));
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ frameGeneration: 1 }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(wall.canvas.paints.length, 1, 'the most recently mounted tile is active');
    assert.equal(multi.canvas.paints.length, 0, 'the inactive tile canvas stays untouched');
    // Unbinding the active tile restores the previous binding: its canvas
    // re-attaches and repaints the last frame with no new delivery.
    unmountTile(router, scheduler, 'A', wall);
    assert.equal(port.closed, false);
    assert.equal(streamStatus(router)?.bound, true);
    assert.equal(multi.canvas.paints.length, 1, 'restore repaints the previous canvas');
    assert.deepEqual(paintBytes(multi.canvas, 0), rgb24ToRgba(frameBytes(1)));
    port.deliver(await frameDelivery({ frameGeneration: 2, correlation: 'c2', leaseId: 'l2' }));
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(multi.canvas.paints.length, 2);
    assert.equal(wall.canvas.paints.length, 1);
    // With no tile bound, a delivery refuses honestly but the kept stream
    // stays open; the next tile bind resumes presentation.
    unmountTile(router, scheduler, 'A', multi);
    port.deliver(await frameDelivery({ frameGeneration: 3, correlation: 'gap', leaseId: 'lgap' }));
    await untilAcks(port, 3);
    assert.deepEqual(ackOutcomes(port),
      [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.REFUSED]);
    assert.equal(port.closed, false, 'a gap refusal never retires the kept stream');
    const wall2 = mountTile(router, scheduler, 'A', Symbol('wall2'));
    assert.equal(wall2.canvas.paints.length, 1, 'rebind repaints the last presented frame');
    assert.deepEqual(paintBytes(wall2.canvas, 0), rgb24ToRgba(frameBytes(2)));
    port.deliver(await frameDelivery({ frameGeneration: 4, correlation: 'c4', leaseId: 'l4' }));
    await untilAcks(port, 4);
    assert.deepEqual(ackOutcomes(port),
      [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.REFUSED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(wall2.canvas.paints.length, 2);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('L4-1: a token unbind retires the stream only with its last binding', async () => {
  const { target, router, scheduler } = liveSetup();
  try {
    const wall = mountTile(router, scheduler, 'A', Symbol('wall'));
    const multi = mountTile(router, scheduler, 'A', Symbol('multi'));
    const port = framePort();
    target.emit(portNotice(port));
    await tick();
    assert.equal(streamStatus(router)?.portOpen, true);
    router.unbindSurface('A', wall.bindToken);
    assert.equal(port.closed, false, 'removing an inactive binding never retires');
    assert.equal(streamStatus(router)?.bound, true);
    router.unbindSurface('A', multi.bindToken);
    assert.equal(port.closed, true, 'removing the last binding retires by default');
    assert.equal(streamStatus(router), null);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('L4-1 negative: a foreign-token unbind never touches the active bindings', async () => {
  const { target, router, scheduler } = liveSetup();
  try {
    const wall = mountTile(router, scheduler, 'A', Symbol('wall'));
    const multi = mountTile(router, scheduler, 'A', Symbol('multi'));
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ frameGeneration: 1 }));
    await untilAcks(port, 1);
    assert.equal(multi.canvas.paints.length, 1);
    assert.equal(wall.canvas.paints.length, 0);
    router.unbindSurface('A', Symbol('foreign'));
    scheduler.detachCanvas('A', Symbol('foreign'));
    assert.equal(port.closed, false);
    assert.equal(streamStatus(router)?.bound, true);
    port.deliver(await frameDelivery({ frameGeneration: 2, correlation: 'c2', leaseId: 'l2' }));
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(multi.canvas.paints.length, 2);
    assert.equal(wall.canvas.paints.length, 0);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('L4-1 pin: the legacy token-less unbind still retires the stream', async () => {
  const { target, router, scheduler } = liveSetup();
  try {
    const wall = mountTile(router, scheduler, 'A', Symbol('wall'));
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ frameGeneration: 1 }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(wall.canvas.paints.length, 1);
    router.unbindSurface('A');
    assert.equal(port.closed, true, 'token-less unbind keeps the historical retire');
    assert.equal(streamStatus(router), null);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

// ---------------------------------------------------------------------------
// L4-2: no black placeholder; Connecting until the first PRESENTED paint.
// ---------------------------------------------------------------------------

const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
let sfcSerial = 0;

function rewriteImports(code, deps) {
  let out = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, vueUrl);
    assert.ok(spec in deps, `Unmapped SFC dependency: ${spec}`);
    const target = deps[spec];
    return `const ${bindings.trim()} = await import(${target});`;
  });
  return out;
}

async function compileTile(source) {
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui20-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, { './tileScheduler.js': schedulerUrl });
  const tag = `mvui20-tile-${sfcSerial++}`;
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

function mountWithProvide(Component, initialProps, provides, canvasStub) {
  const { createApp } = createRenderer(stubOps(canvasStub));
  const propsRef = ref({ ...initialProps });
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

test('L4-2: the mounted tile keeps Connecting until the first PRESENTED paint', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const { target, router, scheduler } = liveSetup();
  const canvas = drawableCanvasStub();
  const mounted = mountWithProvide(SurfaceCanvas, {
    surfaceId: 'A', generation: PROPS_GEN, epoch: SNAP_EPOCH,
    frame: '', digest: '', state: 'live',
  }, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    const section = () => mountNodes(mounted.root).find((node) => node.tag === 'section');
    const strip = () => mountNodes(mounted.root).find((node) => node.props?.class === 'mv-surface__strip');
    assert.equal(section().props['data-state'], 'connecting');
    assert.match(mountText(mounted.root), /Connecting to surface/);
    assert.equal(canvas.props.hidden, true, 'no canvas shows before the first paint');
    assert.equal(strip(), undefined, 'no witness strip before the first paint');
    assert.equal(canvas.paints.length, 0);
    // A refused delivery (sha mismatch) is not a paint: still Connecting.
    const port = framePort();
    target.emit(portNotice(port));
    const badBytes = frameBytes(1);
    port.deliver(await frameDelivery({ frameGeneration: 1, bytes: badBytes, sha256: 'f'.repeat(64) }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
    assert.equal(section().props['data-state'], 'connecting');
    assert.equal(canvas.paints.length, 0);
    // The first PRESENTED paint flips the tile to live with pixels.
    port.deliver(await frameDelivery({ frameGeneration: 2, correlation: 'c2', leaseId: 'l2' }));
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    const info = scheduler.getInstrumentation('A');
    await mounted.setProps({
      frame: info.lastPresentedHandle, digest: info.lastPresentedDigest,
      frameWidth: info.lastPresentedWidth, frameHeight: info.lastPresentedHeight,
    });
    assert.equal(section().props['data-state'], 'live');
    assert.equal(canvas.props.hidden, false);
    assert.ok(strip(), 'presented witness strip renders');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('L4-2: a second mounted tile shows the last frame, never a black placeholder', async () => {
  const SurfaceCanvas = await compileTile(tileSource);
  const { target, router, scheduler } = liveSetup();
  const wallCanvas = drawableCanvasStub();
  const wall = mountWithProvide(SurfaceCanvas, {
    surfaceId: 'A', generation: PROPS_GEN, epoch: SNAP_EPOCH,
    frame: '', digest: '', state: 'live',
  }, { tileScheduler: scheduler, framePortRouter: router }, wallCanvas);
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ frameGeneration: 1 }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(wallCanvas.paints.length, 1);
    const info = scheduler.getInstrumentation('A');
    await wall.setProps({
      frame: info.lastPresentedHandle, digest: info.lastPresentedDigest,
      frameWidth: info.lastPresentedWidth, frameHeight: info.lastPresentedHeight,
    });
    // The multislot tile mounts with the live witness (App v-if swap): its
    // canvas must carry the last frame immediately, not black.
    const multiCanvas = drawableCanvasStub();
    const multi = mountWithProvide(SurfaceCanvas, {
      surfaceId: 'A', generation: PROPS_GEN, epoch: SNAP_EPOCH,
      frame: info.lastPresentedHandle, digest: info.lastPresentedDigest,
      frameWidth: info.lastPresentedWidth, frameHeight: info.lastPresentedHeight, state: 'live',
    }, { tileScheduler: scheduler, framePortRouter: router }, multiCanvas);
    try {
      assert.equal(multiCanvas.paints.length, 1, 'second tile repaints on mount');
      assert.deepEqual(paintBytes(multiCanvas, 0), rgb24ToRgba(frameBytes(1)));
      assert.equal(wallCanvas.paints.length, 1);
      // The most recently mounted tile is active: the next frame paints it
      // while the wall canvas keeps its pixels.
      port.deliver(await frameDelivery({ frameGeneration: 2, correlation: 'c2', leaseId: 'l2' }));
      await untilAcks(port, 2);
      assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
      assert.equal(multiCanvas.paints.length, 2);
      assert.equal(wallCanvas.paints.length, 1);
      // Unmounting the active tile restores the wall tile with a repaint.
      multi.app.unmount();
      assert.equal(wallCanvas.paints.length, 2, 'wall tile restored without a new delivery');
      assert.deepEqual(paintBytes(wallCanvas, 1), rgb24ToRgba(frameBytes(2)));
      port.deliver(await frameDelivery({ frameGeneration: 3, correlation: 'c3', leaseId: 'l3' }));
      await untilAcks(port, 3);
      assert.deepEqual(ackOutcomes(port),
        [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
      assert.equal(wallCanvas.paints.length, 3);
      assert.equal(multiCanvas.paints.length, 2);
    } finally {
      multi.app.unmount();
    }
    assert.equal(port.closed, false, 'SFC unmounts never close the shared stream');
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

// ---------------------------------------------------------------------------
// Guard: sequential frames plus a burst never refuse on a live stream.
// ---------------------------------------------------------------------------

test('guard: frames 1,2,3 and a burst of 10 are PRESENTED or SUPERSEDED, never REFUSED', async () => {
  const { target, router, scheduler } = liveSetup();
  try {
    const wall = mountTile(router, scheduler, 'A', Symbol('wall'));
    const port = framePort();
    target.emit(portNotice(port));
    for (const generation of [1, 2, 3]) {
      port.deliver(await frameDelivery({ frameGeneration: generation }));
      await untilAcks(port, generation);
    }
    assert.deepEqual(ackOutcomes(port),
      [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    // Digests first, then a synchronous back-to-back burst: every arrival
    // supersedes the in-flight record, so only the newest presents.
    const burst = [];
    for (let generation = 4; generation <= 13; generation += 1) {
      burst.push(await frameDelivery({ frameGeneration: generation }));
    }
    for (const delivery of burst) port.deliver(delivery);
    await untilAcks(port, 13);
    const outcomes = ackOutcomes(port);
    assert.equal(outcomes.length, 13);
    for (const outcome of outcomes) {
      assert.ok(outcome === FRAME_OUTCOMES.PRESENTED || outcome === FRAME_OUTCOMES.SUPERSEDED,
        `burst outcome is never REFUSED, got ${outcome}`);
    }
    assert.equal(outcomes.filter((o) => o === FRAME_OUTCOMES.PRESENTED).length, 4);
    assert.equal(port.closed, false);
    assert.equal(wall.canvas.paints.length, 4);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('memory: mvui20 fakes stay under the 512 MiB rss budget', () => {
  assert.ok(process.memoryUsage().rss < 512 * 1024 * 1024,
    `rss ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MiB exceeds budget`);
});
