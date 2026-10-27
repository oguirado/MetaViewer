// MVUI18 lane J: live frame scale jitter (L2-8). The projection generation
// advances before the async port frame arrives; the tile must keep the last
// painted frame visible (no flash to the waiting placeholder at a different
// scale) and size the canvas from the delivery width/height with CSS-class
// scaling (CSP-safe, no style writes). Real SurfaceCanvas SFC, real tile
// scheduler, real frame-port router; bounded 3x2 fakes. Plain node:test.
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

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
const compiledTile = compileScript(parse(tileSource).descriptor, { id: 'mvui18-jitter-tile', inlineTemplate: true });
const tileCode = compiledTile.content
  .replaceAll(`from 'vue'`, `from ${vueUrl}`)
  .replaceAll('from "vue"', `from ${vueUrl}`)
  .replaceAll(`from './tileScheduler.js'`, `from ${schedulerUrl}`)
  .replaceAll('from "./tileScheduler.js"', `from ${schedulerUrl}`);
const SurfaceCanvas = (await import(`data:text/javascript;base64,${Buffer.from(tileCode).toString('base64')}`)).default;
assert.ok(SurfaceCanvas && typeof SurfaceCanvas.setup === 'function');

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
      if (el === canvasStub && (key === 'width' || key === 'height') && Number.isSafeInteger(next)) {
        el[key] = next;
      }
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
  assert.ok(router);
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const root = { children: [] };
  const { createApp } = createRenderer(stubOps(canvas));
  const propsRef = ref({ ...initialProps });
  const Holder = { setup: () => () => h(SurfaceCanvas, { ...propsRef.value }) };
  const app = createApp(Holder);
  app.provide('tileScheduler', scheduler);
  app.provide('framePortRouter', router);
  app.mount(root);
  return {
    target, router, scheduler, canvas, app, root,
    async setProps(patch) {
      propsRef.value = { ...propsRef.value, ...patch };
      await nextTick();
      await nextTick();
      await tick();
    },
  };
}

function allNodes(node) {
  return [node, ...((node.children ?? []).flatMap(allNodes))];
}
function byClass(root, cls) {
  return allNodes(root).filter((n) => n.props?.class === cls);
}
function canvasNode(root) {
  return byClass(root, 'mv-surface__canvas')[0] ?? null;
}
function sectionNode(root) {
  return allNodes(root).find((n) => n.tag === 'section') ?? null;
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
  const width = overrides.width ?? 3;
  const height = overrides.height ?? 2;
  const bytes = overrides.bytes ?? Uint8Array.from({ length: width * height * 3 }, (_v, i) => (i + 1) % 256);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'c1', principal: 'utility',
    epoch: 1, surfaceId: 'A', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'l1',
    width, height, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

const ackOutcomes = (port) => port.acks.map((ack) => ack.outcome);

test('mvui18 L2-8: generation advance before paint keeps the previous canvas', async () => {
  const mounted = mountTile({ surfaceId: 'A', generation: 1, epoch: 1, frame: '', digest: '', state: 'live', frameWidth: 0, frameHeight: 0 });
  const { target, router, scheduler, canvas, app, root } = mounted;
  try {
    assert.equal(canvasNode(root).props.hidden, true);
    assert.equal(byClass(root, 'mv-surface__waiting').length, 1);
    assert.equal(byClass(root, 'mv-surface__strip').length, 0);
    const port = tilePort();
    target.emit(portNotice(port));
    await tick();
    port.deliver(await frameDelivery({ correlation: 'first', frameGeneration: 1, leaseId: 'l1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    assert.equal(canvas.width, 3);
    assert.equal(canvas.height, 2);
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedWidth, 3);
    assert.equal(info.lastPresentedHeight, 2);
    await mounted.setProps({ frame: info.lastPresentedHandle, digest: info.lastPresentedDigest, frameWidth: 3, frameHeight: 2 });
    assert.equal(canvasNode(root).props.hidden, false);
    assert.equal(byClass(root, 'mv-surface__waiting').length, 0);
    assert.equal(byClass(root, 'mv-surface__strip').length, 1);
    assert.equal(sectionNode(root).props['data-state'], 'live');
    const stripLabel = byClass(root, 'mv-surface__strip')[0].props['aria-label'];
    assert.ok(String(stripLabel).includes(info.lastPresentedHandle.slice(0, 8)));
    await mounted.setProps({ generation: 2, frame: '', digest: '', frameWidth: 3, frameHeight: 2 });
    assert.equal(canvasNode(root).props.hidden, false, 'the previous canvas stays visible during the gap');
    assert.equal(byClass(root, 'mv-surface__waiting').length, 0, 'no waiting flash');
    assert.equal(byClass(root, 'mv-surface__strip').length, 1, 'no strip flash');
    assert.equal(sectionNode(root).props['data-state'], 'live');
    assert.equal(canvas.paints.length, 1);
    assert.equal(canvas.width, 3);
    assert.equal(canvas.height, 2);
    assert.ok(String(byClass(root, 'mv-surface__strip')[0].props['aria-label']).includes(info.lastPresentedHandle.slice(0, 8)), 'strip frame content is retained');
    const nextPort = tilePort();
    target.emit(portNotice(nextPort, 'A', 2));
    await tick();
    assert.equal(port.closed, true);
    nextPort.deliver(await frameDelivery({
      bytes: Uint8Array.from({ length: 18 }, (_v, i) => (101 + i) % 256),
      correlation: 'second-stream', surfaceGeneration: 2, frameGeneration: 1, leaseId: 'l2',
    }));
    await untilAcks(nextPort, 1);
    assert.deepEqual(ackOutcomes(nextPort), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 2);
    const info2 = scheduler.getInstrumentation('A');
    assert.equal(info2.surfaceGeneration, 2);
    await mounted.setProps({ frame: info2.lastPresentedHandle, digest: info2.lastPresentedDigest, frameWidth: 3, frameHeight: 2 });
    assert.equal(canvasNode(root).props.hidden, false);
    assert.equal(byClass(root, 'mv-surface__strip').length, 1);
    assert.notEqual(info2.lastPresentedHandle, info.lastPresentedHandle);
  } finally {
    app.unmount();
    router.dispose();
  }
});

test('mvui18 L2-8 negative: empty tile hides and a surface change resets the retain', async () => {
  const mounted = mountTile({ surfaceId: 'A', generation: 1, epoch: 1, frame: '', digest: '', state: 'live', frameWidth: 0, frameHeight: 0 });
  const { router, app, root } = mounted;
  try {
    assert.equal(canvasNode(root).props.hidden, true);
    assert.equal(sectionNode(root).props['data-state'], 'connecting');
    await mounted.setProps({ frame: 'tile/A/g1/h1', digest: 'a'.repeat(64), frameWidth: 3, frameHeight: 2 });
    assert.equal(canvasNode(root).props.hidden, false);
    assert.equal(sectionNode(root).props['data-state'], 'live');
    await mounted.setProps({ surfaceId: 'B', generation: 1, epoch: 1, frame: '', digest: '', frameWidth: 0, frameHeight: 0 });
    assert.equal(canvasNode(root).props.hidden, true, 'a new surface never inherits the old frame');
    assert.equal(sectionNode(root).props['data-state'], 'connecting');
    assert.equal(byClass(root, 'mv-surface__strip').length, 0);
  } finally {
    app.unmount();
    router.dispose();
  }
});

test('mvui18 L2-8: canvas intrinsic size equals the delivery width and height', async () => {
  const scheduler = createTileScheduler({ budget: BUDGET, onPresent: (r) => scheduler.presentHandle(r) });
  const canvas = drawableCanvasStub();
  try {
    scheduler.registerSurface({ surfaceId: 'A', surfaceGeneration: 1, principal: 'utility', epoch: 1,
      state: { panelOpen: true, panelSelected: true, width: 3, height: 2, viewportIntersecting: true, windowPresentationAllowed: true } });
    scheduler.attachCanvas({ surfaceId: 'A', canvas });
    const bytes = Uint8Array.from({ length: 18 }, (_v, i) => i + 1);
    scheduler.submitFrame({ surfaceId: 'A', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'l1',
      byteLength: 18, width: 3, height: 2, bytes, principal: 'utility', epoch: 1, sha256: 'b'.repeat(64) });
    scheduler.runTick();
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedWidth, 3);
    assert.equal(info.lastPresentedHeight, 2);
    assert.equal(canvas.width, 3);
    assert.equal(canvas.height, 2);
    scheduler.registerSurface({ surfaceId: 'A', surfaceGeneration: 2, principal: 'utility', epoch: 1 });
    const reset = scheduler.getInstrumentation('A');
    assert.equal(reset.lastPresentedWidth, 0);
    assert.equal(reset.lastPresentedHeight, 0);
  } finally {
    scheduler.destroy();
  }
  const mounted = mountTile({ surfaceId: 'A', generation: 1, epoch: 1, frame: 'tile/A/g1/h1', digest: 'c'.repeat(64), state: 'live', frameWidth: 3, frameHeight: 2 });
  try {
    assert.equal(canvasNode(mounted.root).props.width, 3);
    assert.equal(canvasNode(mounted.root).props.height, 2);
    await mounted.setProps({ frame: '', digest: '', frameWidth: 0, frameHeight: 0 });
    assert.equal(canvasNode(mounted.root).props.width, 3, 'the gap retains the last size');
    assert.equal(canvasNode(mounted.root).props.height, 2);
    await mounted.setProps({ frame: 'tile/A/g1/h2', digest: 'd'.repeat(64), frameWidth: 4, frameHeight: 5 });
    assert.equal(canvasNode(mounted.root).props.width, 4);
    assert.equal(canvasNode(mounted.root).props.height, 5);
  } finally {
    mounted.app.unmount();
    mounted.router.dispose();
  }
});

test('mvui18 L2-8 negative: unknown or invalid sizes never break the tile', async () => {
  const mounted = mountTile({ surfaceId: 'A', generation: 1, epoch: 1, frame: '', digest: '', state: 'live', frameWidth: 0, frameHeight: 0 });
  try {
    assert.equal(canvasNode(mounted.root).props.width, 0);
    assert.equal(canvasNode(mounted.root).props.hidden, true);
    await mounted.setProps({ frame: 'tile/A/g1/h1', digest: '', frameWidth: -1, frameHeight: Number.NaN });
    assert.equal(canvasNode(mounted.root).props.hidden, false, 'visibility follows the frame, not the size');
    assert.equal(canvasNode(mounted.root).props.width, 0);
    assert.equal(canvasNode(mounted.root).props.height, 0);
  } finally {
    mounted.app.unmount();
    mounted.router.dispose();
  }
});

test('mvui18 L2-8: app wires frame size and the tile scales through its CSS class', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
  assert.ok(app.includes(':frame-width="surfaceWitness(surface).width"'));
  assert.ok(app.includes(':frame-height="surfaceWitness(surface).height"'));
  assert.ok(app.includes(':frame-width="surfaceWitness(selectedSurface).width"'));
  assert.ok(app.includes('lastPresentedWidth'));
  assert.ok(app.includes('lastPresentedHeight'));
  assert.ok(tileSource.includes(':width="effectiveWidth"'));
  assert.ok(tileSource.includes(':height="effectiveHeight"'));
  assert.ok(tileSource.includes('retainedFrame'));
  assert.ok(tileSource.includes('effectiveFrame.value.length === 0'));
  assert.doesNotMatch(tileSource, /v-bind:style/);
  assert.doesNotMatch(tileSource, /(?:^|[\s"'`:=])style\s*=/m);
  assert.doesNotMatch(tileSource, /v-show/);
  assert.doesNotMatch(tileSource, /\.style\.[a-zA-Z]/);
  const css = tileSource.match(/<style scoped>([\s\S]*?)<\/style>/)[1];
  assert.ok(css.includes('object-fit: contain'), 'aspect-preserving class scaling stays');
  assert.ok(css.includes('.mv-surface__canvas[hidden]'));
  const stripped = tileSource.replaceAll(':width="effectiveWidth"', '');
  assert.equal(stripped.includes(':width="effectiveWidth"'), false);
});

test('mvui18 frame jitter: rss stays bounded', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});
