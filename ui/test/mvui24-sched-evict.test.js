/**
 * MVUI24 lane S (RV9 NEW-02): scheduler entries (with their retained
 * lastPaint bytes) must be evicted once their surface fully retires (frame
 * stream retired + no canvas left to serve), so memory does not grow with
 * capsule churn. Eviction never tombstones: a reopened capsule id registers
 * fresh. Live, grace-held, and canvas-attached entries always survive.
 *
 * Mounts the REAL SurfaceCanvas SFC (compiled with @vue/compiler-sfc, inline
 * template) on a stub renderer with the REAL tile scheduler and the REAL
 * frame-port router: no DOM, no new dependencies. Plain node:test; bounded
 * fakes (2x2 frames, single deliveries); async waits only via frame-wait.mjs.
 * Fails before the fix: the entry (and lastPaint) survives unmount + grace.
 */
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
import {
  RELEASE_CAUSES,
  SCHEDULER_REASONS,
  createTileScheduler,
} from '../src/surfaces/tileScheduler.js';
import * as tileScheduler from '../src/surfaces/tileScheduler.js';
import { tick, until, untilAcks } from './frame-wait.mjs';

const { shouldEvictSchedulerEntry } = tileScheduler;

const ORIGIN = 'app://metaviewer';
const NOTICE_GEN = 886;
const DELIVERY_GEN = 1;
const DELIVERY_EPOCH = 7;
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
          canvas.paints.push({ width: image.width, height: image.height });
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
  const bytes = overrides.bytes ?? new Uint8Array([12, 34, 56, 78, 90, 11, 22, 33, 44, 55, 66, 77]);
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

// ---------------------------------------------------------------------------
// Real-SFC compile helpers (production sources untouched).
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
    if (typeof target === 'string') return `const ${bindings.trim()} = await import(${target});`;
    return `const ${bindings.trim()} = globalThis.__mvui24SDeps[${JSON.stringify(spec)}];`;
  });
  return out;
}

async function compileSource(source, id, deps) {
  const compiled = compileScript(parse(source).descriptor, { id, inlineTemplate: true });
  const code = rewriteImports(compiled.content, deps);
  globalThis.__mvui24SDeps = deps;
  try {
    const tag = `${id}-${sfcSerial++}`;
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
  } finally {
    delete globalThis.__mvui24SDeps;
  }
}

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');

async function compileTile(source = tileSource) {
  return compileSource(source, 'mvui24s-tile', { './tileScheduler.js': schedulerUrl });
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
    },
  };
}

function mountWithProvide(Component, initialProps, provides, canvasStub = null) {
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

function tileProps(overrides = {}) {
  return {
    surfaceId: 'A', generation: 887, epoch: 4242,
    frame: '', digest: '', state: 'live', ...overrides,
  };
}

function eligibleState() {
  return {
    panelOpen: true, panelSelected: true, folded: false,
    width: 320, height: 200, x: 0, y: 0,
    viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
  };
}

function makeSchedulerFrame(overrides = {}) {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  return {
    surfaceId: 'capsule-a', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'l1',
    byteLength: bytes.length, width: 2, height: 2, bytes,
    principal: 'wall-main', epoch: 7, ...overrides,
  };
}

function makeFakeCanvas() {
  const puts = [];
  const ctx = {
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: (image) => { puts.push(image); },
  };
  return { width: 0, height: 0, puts, getContext: (kind) => (kind === '2d' ? ctx : null) };
}

// ---------------------------------------------------------------------------
// NEW-02: entry lifecycle on the real scheduler + real router + real tile.
// ---------------------------------------------------------------------------

test('mvui24-sched NEW-02: removed capsule releases its scheduler entry after the keepStream grace', async () => {
  const SurfaceCanvas = await compileTile();
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, keepStreamGraceMs: 30 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const mounted = mountWithProvide(SurfaceCanvas, tileProps(), {
    tileScheduler: scheduler, framePortRouter: router,
  }, canvas);
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'evict-main', leaseId: 'le1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    assert.ok(scheduler.getInstrumentation('A') !== null, 'entry must exist before removal');
    mounted.app.unmount();
    await until(() => router.getSurfaceStatus('A') === null, 'stream retired past grace');
    await until(() => scheduler.getInstrumentation('A') === null, 'scheduler entry evicted');
    assert.equal(router.getSurfaceStatus('A'), null);
    const reRegistered = scheduler.registerSurface({
      surfaceId: 'A', surfaceGeneration: 1, epoch: DELIVERY_EPOCH,
      principal: 'utility', state: eligibleState(),
    });
    assert.equal(reRegistered.ok, true, 'evicted id must stay re-registerable (no tombstone)');
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui24-sched NEW-02 negative control: remount inside the grace keeps the entry and repaints', async () => {
  const SurfaceCanvas = await compileTile();
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, keepStreamGraceMs: 5000 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas1 = drawableCanvasStub();
  const first = mountWithProvide(SurfaceCanvas, tileProps(), {
    tileScheduler: scheduler, framePortRouter: router,
  }, canvas1);
  const canvas2 = drawableCanvasStub();
  let second = null;
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'evict-remount', leaseId: 'le2' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    first.app.unmount();
    second = mountWithProvide(SurfaceCanvas, tileProps(), {
      tileScheduler: scheduler, framePortRouter: router,
    }, canvas2);
    await tick();
    assert.equal(canvas2.paints.length, 1, 'remount must repaint the retained frame');
    assert.ok(scheduler.getInstrumentation('A') !== null, 'entry must survive the remount');
    assert.equal(scheduler.getInstrumentation('A').canvasAttached, true);
    const t0 = Date.now();
    await until(() => Date.now() - t0 > 1500, 'evict window elapsed');
    assert.ok(scheduler.getInstrumentation('A') !== null, 'live stream must never evict');
    assert.ok(router.getSurfaceStatus('A') !== null, 'rebind must cancel the grace');
  } finally {
    second?.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui24-sched NEW-02 negative control: a surface with another tile bound is never evicted', async () => {
  const SurfaceCanvas = await compileTile();
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, keepStreamGraceMs: 5000 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas1 = drawableCanvasStub();
  const canvas2 = drawableCanvasStub();
  const first = mountWithProvide(SurfaceCanvas, tileProps(), {
    tileScheduler: scheduler, framePortRouter: router,
  }, canvas1);
  const second = mountWithProvide(SurfaceCanvas, tileProps(), {
    tileScheduler: scheduler, framePortRouter: router,
  }, canvas2);
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'evict-shared', leaseId: 'le3' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    first.app.unmount();
    await tick();
    assert.ok(router.getSurfaceStatus('A') !== null, 'shared stream must stay open');
    const t0 = Date.now();
    await until(() => Date.now() - t0 > 1500, 'evict window elapsed');
    assert.ok(scheduler.getInstrumentation('A') !== null, 'bound surface must never evict');
    assert.ok(router.getSurfaceStatus('A') !== null, 'shared stream must stay open');
  } finally {
    second.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui24-sched NEW-02: surface change evicts the retired old surface promptly', async () => {
  const SurfaceCanvas = await compileTile();
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest, keepStreamGraceMs: 30 });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const mounted = mountWithProvide(SurfaceCanvas, tileProps(), {
    tileScheduler: scheduler, framePortRouter: router,
  }, canvas);
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'evict-switch', leaseId: 'le4' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    await mounted.setProps({ surfaceId: 'B' });
    assert.equal(router.getSurfaceStatus('A'), null, 'old stream must retire on switch');
    assert.equal(scheduler.getInstrumentation('A'), null, 'old entry must evict on switch');
    assert.equal(scheduler.getInstrumentation('B'), null, 'new surface registers on its own stream');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui24-sched NEW-02 unit: evictSurface drops holdings without tombstoning', () => {
  const releases = [];
  const scheduler = createTileScheduler({
    budget: BUDGET, onReleaseLease: (release) => { releases.push(release); },
  });
  try {
    assert.equal(typeof scheduler.evictSurface, 'function', 'scheduler must expose evictSurface');
    const registered = scheduler.registerSurface({
      surfaceId: 'capsule-a', surfaceGeneration: 1, epoch: 7,
      principal: 'wall-main', captureLeaseId: 'capture-a', captureLeaseActive: true,
      state: eligibleState(),
    });
    assert.equal(registered.ok, true);
    const canvas = makeFakeCanvas();
    const attached = scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas });
    assert.equal(attached.ok, true);
    const disposed = [];
    assert.equal(scheduler.allocateWarmResource('capsule-a', {
      resourceId: 'w', byteLength: 8, dispose: () => { disposed.push('w'); },
    }).ok, true);
    assert.equal(scheduler.submitFrame(makeSchedulerFrame({})).ok, true);
    const presented = scheduler.presentSurfaceNow('capsule-a');
    assert.equal(presented.presented.length, 1);
    assert.equal(canvas.puts.length, 1);
    assert.equal(scheduler.submitFrame(makeSchedulerFrame({ frameGeneration: 2, leaseId: 'l2' })).ok, true);
    scheduler.detachCanvas('capsule-a', attached.token);
    const evicted = scheduler.evictSurface('capsule-a');
    assert.equal(evicted.ok, true);
    assert.equal(evicted.evicted, true);
    assert.equal(scheduler.getInstrumentation('capsule-a'), null, 'entry must leave the registry');
    assert.deepEqual(disposed, ['w'], 'warm disposer must run exactly once');
    const byLease = (id) => releases.filter((r) => r.leaseId === id);
    assert.equal(byLease('l1').length, 1, 'drawn lease released once');
    assert.equal(byLease('l1')[0].reason, RELEASE_CAUSES.PRESENTED);
    assert.equal(byLease('l2').length, 1, 'mailbox lease released once');
    assert.equal(byLease('l2')[0].reason, RELEASE_CAUSES.SURFACE_DESTROYED);
    const reRegistered = scheduler.registerSurface({
      surfaceId: 'capsule-a', surfaceGeneration: 1, epoch: 7, principal: 'wall-main', state: eligibleState(),
    });
    assert.equal(reRegistered.ok, true, 'evicted id must stay re-registerable');
    assert.equal(scheduler.evictSurface('ghost').reason, SCHEDULER_REASONS.SURFACE_NOT_REGISTERED);
    assert.equal(scheduler.destroySurface('capsule-a').destroyed, true);
    assert.equal(scheduler.evictSurface('capsule-a').reason, SCHEDULER_REASONS.SURFACE_DESTROYED);
  } finally {
    scheduler.destroy();
  }
});

test('mvui24-sched NEW-02 unit: shouldEvictSchedulerEntry fires only for retired, canvas-less entries', () => {
  assert.equal(typeof shouldEvictSchedulerEntry, 'function');
  assert.equal(shouldEvictSchedulerEntry({ streamRetired: true, canvasAttached: false }), true);
  assert.equal(shouldEvictSchedulerEntry({ streamRetired: true, canvasAttached: true }), false);
  assert.equal(shouldEvictSchedulerEntry({ streamRetired: false, canvasAttached: false }), false);
  assert.equal(shouldEvictSchedulerEntry({ streamRetired: false, canvasAttached: true }), false);
  assert.equal(shouldEvictSchedulerEntry({}), false);
  assert.equal(shouldEvictSchedulerEntry(), false);
  assert.equal(shouldEvictSchedulerEntry(null), false);
});

test('mvui24-sched NEW-02 memory: suite rss stays under the 512 MiB ceiling', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
