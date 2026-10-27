// MVUI14 room C: judge-notes regressions for the frame-port router and the
// SurfaceCanvas binding. Each defect gets a test that fails before the fix
// plus a negative control. The tile tests mount the REAL SurfaceCanvas SFC
// (compiled with @vue/compiler-sfc, inline template) on a stub renderer with
// the REAL tile scheduler and the REAL frame-port router: no DOM, no new
// dependencies. Plain node:test.
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
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
async function hexDigest(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Real-SFC tile harness.
// ---------------------------------------------------------------------------

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
const compiledTile = compileScript(parse(tileSource).descriptor, { id: 'mvui14-judge-tile', inlineTemplate: true });
const tileCode = compiledTile.content
  .replaceAll(`from 'vue'`, `from ${vueUrl}`)
  .replaceAll('from "vue"', `from ${vueUrl}`)
  .replaceAll(`from './tileScheduler.js'`, `from ${schedulerUrl}`)
  .replaceAll('from "./tileScheduler.js"', `from ${schedulerUrl}`);
const SurfaceCanvas = (await import(`data:text/javascript;base64,${Buffer.from(tileCode).toString('base64')}`)).default;
assert.ok(SurfaceCanvas && typeof SurfaceCanvas.setup === 'function', 'tile SFC compiles to a setup component');

// Minimal nodeOps for the tile template (section/canvas/div/span/strong/p,
// v-if anchors, text interpolation, template ref on the canvas element).
function stubOps(canvasStub) {
  return {
    createElement(tag) {
      if (tag === 'canvas') return canvasStub;
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

// Mounts the real tile with reactive props, the real scheduler and the real
// router. Returns the app plus a setProps helper that flushes the watcher.
function mountTile(initialProps) {
  const targetListeners = new Map();
  const target = {
    location: { origin: ORIGIN },
    addEventListener(type, fn) {
      if (!targetListeners.has(type)) targetListeners.set(type, new Set());
      targetListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { targetListeners.get(type)?.delete(fn); },
    emit(event) { for (const fn of [...(targetListeners.get('message') ?? [])]) fn(event); },
  };
  const router = installFramePortRouter({ target });
  assert.ok(router, 'router installs on the harness target');
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const { createApp } = createRenderer(stubOps(canvas));
  const propsRef = ref({ ...initialProps });
  const Holder = { setup: () => () => h(SurfaceCanvas, { ...propsRef.value }) };
  const app = createApp(Holder);
  app.provide('tileScheduler', scheduler);
  app.provide('framePortRouter', router);
  app.mount({ children: [] });
  return {
    target, router, scheduler, canvas, app,
    async setProps(patch) {
      propsRef.value = { ...propsRef.value, ...patch };
      await nextTick();
      await nextTick();
      await tick();
    },
  };
}

function tilePort() {
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

function portNotice(port, surfaceId = 'A', generation = 1) {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE, schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: surfaceId, surface_generation: generation,
    },
    origin: ORIGIN, ports: [port],
  };
}

async function frameDelivery(overrides = {}) {
  const bytes = overrides.bytes ?? new Uint8Array([12, 34, 56]);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'c1', principal: 'utility',
    epoch: 1, surfaceId: 'A', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'l1',
    width: 1, height: 1, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

const ackOutcomes = (port) => port.acks.map((ack) => ack.outcome);

test('judge note 1: generation/epoch prop updates keep the same port open and keep painting', async () => {
  // App.vue wires :generation="surface.generation" :epoch="snapshot?.envelope?.epoch ?? ''":
  // the tile mounts before the envelope arrives (''), then both props resolve
  // to the registered binding while the stream stays live.
  const mounted = mountTile({ surfaceId: 'A', generation: '', epoch: '', frame: '', digest: '', state: 'live' });
  const { target, router, scheduler, canvas, app } = mounted;
  try {
    const port = tilePort();
    target.emit(portNotice(port));
    await tick();
    assert.equal(port.started, true);
    port.deliver(await frameDelivery({ correlation: 'first', frameGeneration: 1, leaseId: 'l1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    // The envelope resolves: generation/epoch props update on the SAME tile.
    await mounted.setProps({ generation: 1, epoch: 1 });
    assert.equal(port.closed, false, 'same-surface prop updates must not retire the live port');
    assert.deepEqual(router.getSurfaceStatus('A').portOpen, true);
    assert.equal(scheduler.getInstrumentation('A').canvasAttached, true);
    port.deliver(await frameDelivery({
      bytes: new Uint8Array([7, 8, 9]), correlation: 'second', frameGeneration: 2, leaseId: 'l2',
    }));
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 2);
    assert.deepEqual(canvas.paints[1].data, [7, 8, 9, 255]);
  } finally {
    app.unmount();
    router.dispose();
  }
});

test('negative control: a surfaceId change retires the old binding and binds the new surface', async () => {
  const mounted = mountTile({ surfaceId: 'A', generation: '', epoch: '', frame: '', digest: '', state: 'live' });
  const { target, router, canvas, app } = mounted;
  try {
    const oldPort = tilePort();
    target.emit(portNotice(oldPort));
    oldPort.deliver(await frameDelivery({ correlation: 'a-live', frameGeneration: 1, leaseId: 'la' }));
    await untilAcks(oldPort, 1);
    assert.deepEqual(ackOutcomes(oldPort), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    await mounted.setProps({ surfaceId: 'B', generation: 1, epoch: 1 });
    assert.equal(oldPort.closed, true, 'the previous surface binding retires');
    assert.equal(router.getSurfaceStatus('A'), null);
    const nextPort = tilePort();
    target.emit(portNotice(nextPort, 'B'));
    nextPort.deliver(await frameDelivery({
      bytes: new Uint8Array([2, 2, 2]), correlation: 'b-live', surfaceId: 'B',
      frameGeneration: 1, leaseId: 'lb',
    }));
    await untilAcks(nextPort, 1);
    assert.deepEqual(ackOutcomes(nextPort), [FRAME_OUTCOMES.PRESENTED]);
    assert.deepEqual(router.getSurfaceStatus('B').portOpen, true);
    assert.equal(canvas.paints.length, 2);
    assert.deepEqual(canvas.paints[1].data, [2, 2, 2, 255]);
  } finally {
    app.unmount();
    router.dispose();
  }
});

test('judge note 1 (shape): the tile watcher only rebinds the router on surfaceId change', () => {
  const guarded = (source) => {
    const start = source.indexOf('watch(() => [props.surfaceId, props.generation, props.epoch]');
    if (start < 0) return false;
    const block = source.slice(start, source.indexOf('});', start));
    const guard = block.indexOf('props.surfaceId !== previous[0]');
    const unbind = block.indexOf('unbindFramePort(previous[0])');
    const bind = block.indexOf('bindFramePort()');
    return guard >= 0 && unbind > guard && bind > guard;
  };
  assert.equal(guarded(tileSource), true, 'the router rebind runs only when the surface id changes');
  assert.equal(
    guarded(tileSource.replaceAll('props.surfaceId !== previous[0]', 'true')),
    false,
    'negative control: the check fails when the surface guard is stripped',
  );
  assert.equal(
    guarded(tileSource.replaceAll('unbindFramePort(previous[0])', 'unbindFramePort(null)')),
    false,
    'negative control: the check fails when the guarded unbind is stripped',
  );
});

// ---------------------------------------------------------------------------
// Router-level harness for notes 2 and 3 (real scheduler, real router).
// ---------------------------------------------------------------------------

function routerSetup() {
  const listeners = new Map();
  const target = {
    location: { origin: ORIGIN },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(event) { for (const fn of [...(listeners.get('message') ?? [])]) fn(event); },
  };
  const router = installFramePortRouter({ target, digestSha256: async (bytes) => hexDigest(bytes) });
  assert.ok(router, 'router installs on the harness target');
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  return { target, router, scheduler, canvas };
}

function bindTile(router, scheduler, canvas, surfaceId = 'A', onRegistered = null) {
  const retry = onRegistered ?? ((registered) => {
    scheduler.attachCanvas({
      surfaceId: registered.surfaceId, surfaceGeneration: registered.surfaceGeneration,
      epoch: registered.epoch, canvas,
    });
  });
  const first = scheduler.attachCanvas({ surfaceId, canvas });
  router.bindSurface({ surfaceId, scheduler, onRegistered: retry });
  return first;
}

test('judge note 2: context loss acks CONTEXT_LOST and closes the port', async () => {
  const { target, router, scheduler, canvas } = routerSetup();
  bindTile(router, scheduler, canvas);
  const port = tilePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'live', frameGeneration: 1, leaseId: 'l1' }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
  scheduler.onContextLost('A');
  port.deliver(await frameDelivery({ correlation: 'lost', frameGeneration: 2, leaseId: 'l2' }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.CONTEXT_LOST]);
  assert.equal(canvas.paints.length, 1);
  assert.equal(port.closed, true, 'a context-lost outcome retires the stream port');
  assert.deepEqual(router.getSurfaceStatus(), []);
  port.deliver(await frameDelivery({ correlation: 'late', frameGeneration: 3, leaseId: 'l3' }));
  await tick();
  assert.equal(port.acks.length, 2, 'late arrivals on the closed port change nothing');
  // The surface is not bricked: after restore, a newer stream presents again.
  scheduler.onContextRestored('A');
  const next = tilePort();
  target.emit(portNotice(next, 'A', 2));
  next.deliver(await frameDelivery({
    bytes: new Uint8Array([4, 5, 6]), correlation: 'back', frameGeneration: 3, leaseId: 'l3',
  }));
  await untilAcks(next, 1);
  assert.deepEqual(ackOutcomes(next), [FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 2);
  router.dispose();
});

test('negative control: a refused delivery keeps the port open and the stream recovers', async () => {
  const { target, router, scheduler, canvas } = routerSetup();
  bindTile(router, scheduler, canvas);
  const port = tilePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'bad-sha', frameGeneration: 1, leaseId: 'l1', sha256: 'f'.repeat(64) }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
  assert.equal(port.closed, false, 'refusals must not retire the stream');
  assert.deepEqual(router.getSurfaceStatus('A').portOpen, true);
  port.deliver(await frameDelivery({ correlation: 'good', frameGeneration: 2, leaseId: 'l2' }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED, FRAME_OUTCOMES.PRESENTED]);
  assert.equal(canvas.paints.length, 1);
  router.dispose();
});

test('judge note 3: unbind during ensureRegistered settles SURFACE_DESTROYED', async () => {
  const { target, router, scheduler, canvas } = routerSetup();
  // The tile unmounts while the first delivery registers the surface:
  // ensureRegistered synchronously invokes onRegistered, which unbinds.
  bindTile(router, scheduler, canvas, 'A', () => { router.unbindSurface('A'); });
  const port = tilePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'racing-unbind', frameGeneration: 1, leaseId: 'l1' }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SURFACE_DESTROYED]);
  assert.equal(canvas.paints.length, 0);
  assert.equal(port.closed, true);
  router.dispose();
});

test('judge note 3: dispose during ensureRegistered settles SURFACE_DESTROYED', async () => {
  const { target, router, scheduler, canvas } = routerSetup();
  bindTile(router, scheduler, canvas, 'A', () => { router.dispose(); });
  const port = tilePort();
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({ correlation: 'racing-dispose', frameGeneration: 1, leaseId: 'l1' }));
  await untilAcks(port, 1);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SURFACE_DESTROYED]);
  assert.equal(canvas.paints.length, 0);
  assert.equal(port.closed, true);
  router.dispose();
});

test('negative control: a superseded record on a live stream still settles SUPERSEDED', async () => {
  const { target, router, scheduler, canvas } = routerSetup();
  const port = tilePort();
  const replacement = await frameDelivery({
    bytes: new Uint8Array([9, 8, 7]), correlation: 'new', frameGeneration: 2, leaseId: 'l2',
  });
  // Reentrant arrival during registration: the in-flight record is superseded
  // while the stream stays live and bound.
  bindTile(router, scheduler, canvas, 'A', (registered) => {
    scheduler.attachCanvas({
      surfaceId: registered.surfaceId, surfaceGeneration: registered.surfaceGeneration,
      epoch: registered.epoch, canvas,
    });
    port.deliver(replacement);
  });
  target.emit(portNotice(port));
  port.deliver(await frameDelivery({
    bytes: new Uint8Array([1, 1, 1]), correlation: 'old', frameGeneration: 1, leaseId: 'l1',
  }));
  await untilAcks(port, 2);
  assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.SUPERSEDED, FRAME_OUTCOMES.PRESENTED]);
  assert.deepEqual(port.acks.map((ack) => ack.correlation), ['old', 'new']);
  assert.equal(canvas.paints.length, 1);
  assert.deepEqual(canvas.paints[0].data, [9, 8, 7, 255]);
  assert.equal(port.closed, false);
  router.dispose();
});
