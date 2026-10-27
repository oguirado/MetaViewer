// MVUI18 room D: SurfaceCanvas judge notes. (1) Projection generation/epoch
// prop updates must NOT detach/re-attach a registered canvas token; only a
// surfaceId change or a new registered identity re-attaches. (2) A NEW
// delivery identity on the same surfaceId clears the retained witness so a
// recreated stream never reports the old stream as live. (3) Static check that
// the duplicated typeof guards are gone (no behaviour change). Real
// SurfaceCanvas SFC, real tile scheduler, real frame-port router; bounded 3x2
// fakes. Plain node:test.
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
// REAL-like identities (live3): notice stream id 886, delivery binding 1/7,
// projection props 887+ with an unrelated snapshot epoch.
const NOTICE_GEN = 886;
const DELIVERY_GEN = 1;
const DELIVERY_EPOCH = 7;
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

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
let sfcSerial = 0;
async function compileTile(source = tileSource) {
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui18-notes-tile', inlineTemplate: true });
  const code = compiled.content
    .replaceAll(`from 'vue'`, `from ${vueUrl}`)
    .replaceAll('from "vue"', `from ${vueUrl}`)
    .replaceAll(`from './tileScheduler.js'`, `from ${schedulerUrl}`)
    .replaceAll('from "./tileScheduler.js"', `from ${schedulerUrl}`);
  const tag = `mvui18-notes-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

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

function mountTile(Component, initialProps) {
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
  // The real scheduler is frozen, so the tile and the router share a
  // counting facade; every other method is the real closure by reference
  // (the scheduler uses no `this`, so delegation is behaviour-identical).
  const realScheduler = createTileScheduler({ budget: BUDGET });
  const calls = { attaches: 0, detaches: 0 };
  const scheduler = {
    ...realScheduler,
    attachCanvas: (...args) => { calls.attaches += 1; return realScheduler.attachCanvas(...args); },
    detachCanvas: (...args) => { calls.detaches += 1; return realScheduler.detachCanvas(...args); },
  };
  const canvas = drawableCanvasStub();
  const root = { children: [] };
  const { createApp } = createRenderer(stubOps(canvas));
  const propsRef = ref({ ...initialProps });
  const Holder = { setup: () => () => h(Component, { ...propsRef.value }) };
  const app = createApp(Holder);
  app.provide('tileScheduler', scheduler);
  app.provide('framePortRouter', router);
  app.mount(root);
  return {
    target, router, scheduler, canvas, app, root, calls,
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
const mountText = (node) => [node.text ?? '', ...((node.children ?? []).map(mountText))].join(' ');

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
  const width = overrides.width ?? 3;
  const height = overrides.height ?? 2;
  const bytes = overrides.bytes ?? Uint8Array.from({ length: width * height * 3 }, (_v, i) => (i + 1) % 256);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'c1', principal: 'utility',
    epoch: DELIVERY_EPOCH, surfaceId: 'A', surfaceGeneration: DELIVERY_GEN,
    frameGeneration: NOTICE_GEN, leaseId: 'l1',
    width, height, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

const ackOutcomes = (port) => port.acks.map((ack) => ack.outcome);

function liveProps() {
  return {
    surfaceId: 'A', generation: PROPS_GEN, epoch: SNAP_EPOCH,
    frame: '', digest: '', state: 'live', frameWidth: 0, frameHeight: 0,
  };
}

test('mvui18 judge note 1: generation/epoch advances never re-attach a registered canvas', async () => {
  const SurfaceCanvas = await compileTile();
  const mounted = mountTile(SurfaceCanvas, liveProps());
  const { target, router, scheduler, canvas, app, root } = mounted;
  try {
    const port = tilePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'notes1', leaseId: 'notes-l1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    assert.equal(scheduler.getInstrumentation('A').canvasAttached, true);
    const { calls } = mounted;
    calls.attaches = 0;
    calls.detaches = 0;
    const ADVANCES = 5;
    for (let i = 1; i <= ADVANCES; i += 1) {
      await mounted.setProps({ generation: PROPS_GEN + i });
    }
    await mounted.setProps({ epoch: SNAP_EPOCH + 1 });
    assert.equal(calls.detaches, 0, `${ADVANCES} generation advances + 1 epoch advance detach never`);
    assert.equal(calls.attaches, 0, 'no re-attach while the delivery identity stands');
    assert.equal(scheduler.getInstrumentation('A').canvasAttached, true);
    assert.equal(sectionNode(root).props['data-state'], 'connecting');
    // The live stream keeps presenting on the standing binding: no REFUSED.
    port.deliver(await frameDelivery({
      correlation: 'notes2', leaseId: 'notes-l2', frameGeneration: NOTICE_GEN + 1,
      bytes: Uint8Array.from({ length: 18 }, (_v, i) => (50 + i) % 256),
    }));
    await untilAcks(port, 2);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 2);
    // Only a surfaceId change re-attaches.
    calls.detaches = 0;
    calls.attaches = 0;
    await mounted.setProps({ surfaceId: 'B' });
    assert.equal(calls.detaches, 1, 'a surfaceId change still detaches');
    assert.equal(calls.attaches, 1, 'a surfaceId change still re-attaches');
  } finally {
    app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui18 judge note 1 negative: without the skip, every advance detaches', async () => {
  // In-memory mutant (production source untouched): the guard never skips,
  // restoring the per-tick detach/re-attach.
  const mutantSource = tileSource.replace(
    'if (!surfaceChanged && registeredIdentity !== null && canvasToken !== null) {',
    'if (!surfaceChanged && registeredIdentity !== null && canvasToken !== null && false) { // mutant: always re-attach',
  );
  assert.notEqual(mutantSource, tileSource, 'negative control must change the source');
  const MutantTile = await compileTile(mutantSource);
  const mounted = mountTile(MutantTile, liveProps());
  const { target, router, scheduler, canvas, app } = mounted;
  try {
    const port = tilePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'notesn1', leaseId: 'notesn-l1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    const { calls } = mounted;
    calls.attaches = 0;
    calls.detaches = 0;
    await mounted.setProps({ generation: PROPS_GEN + 1 });
    await mounted.setProps({ generation: PROPS_GEN + 2 });
    assert.equal(calls.detaches, 2, 'the old watcher detaches once per advance');
    assert.equal(calls.attaches, 2, 'the old watcher re-attaches once per advance');
  } finally {
    app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui18 judge note 2: a recreated stream drops the previous witness', async () => {
  const SurfaceCanvas = await compileTile();
  const mounted = mountTile(SurfaceCanvas, liveProps());
  const { target, router, scheduler, canvas, app, root } = mounted;
  try {
    const port = tilePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'notes-w1', leaseId: 'notes-wl1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    const first = scheduler.getInstrumentation('A');
    await mounted.setProps({
      frame: first.lastPresentedHandle, digest: first.lastPresentedDigest,
      frameWidth: first.lastPresentedWidth, frameHeight: first.lastPresentedHeight,
    });
    assert.equal(sectionNode(root).props['data-state'], 'live');
    assert.equal(byClass(root, 'mv-surface__strip').length, 1);
    // The surface is recreated with the SAME id but a NEW delivery stream.
    const nextPort = tilePort();
    target.emit(portNotice(nextPort, 'A', NOTICE_GEN + 1));
    await tick();
    nextPort.deliver(await frameDelivery({
      correlation: 'notes-w2', leaseId: 'notes-wl2', surfaceGeneration: DELIVERY_GEN + 1,
      frameGeneration: 1,
      bytes: Uint8Array.from({ length: 18 }, (_v, i) => (101 + i) % 256),
    }));
    await untilAcks(nextPort, 1);
    assert.deepEqual(ackOutcomes(nextPort), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 2);
    assert.equal(scheduler.getInstrumentation('A').surfaceGeneration, DELIVERY_GEN + 1);
    // The App witness gaps before the new stream's witness flows: the tile
    // must not report the previous stream's handle as live.
    await mounted.setProps({ frame: '', digest: '', frameWidth: 0, frameHeight: 0 });
    assert.equal(sectionNode(root).props['data-state'], 'connecting');
    assert.equal(byClass(root, 'mv-surface__strip').length, 0);
    assert.equal(canvasNode(root).props.hidden, true);
    assert.equal(mountText(root).includes(first.lastPresentedHandle.slice(0, 8)), false);
    // The new stream's first witness then flows and the tile goes live.
    const second = scheduler.getInstrumentation('A');
    assert.notEqual(second.lastPresentedHandle, first.lastPresentedHandle);
    await mounted.setProps({
      frame: second.lastPresentedHandle, digest: second.lastPresentedDigest,
      frameWidth: second.lastPresentedWidth, frameHeight: second.lastPresentedHeight,
    });
    assert.equal(sectionNode(root).props['data-state'], 'live');
    assert.equal(byClass(root, 'mv-surface__strip').length, 1);
  } finally {
    app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui18 judge note 2 negative: without the clear, the old witness stays live', async () => {
  // In-memory mutant (production source untouched): the retained witness
  // survives the new delivery identity, as before the fix.
  const mutantSource = tileSource.replace(
    'if (changed) {\n            // MVUI18D',
    'if (false) { // mutant: keep the stale retained witness\n            // MVUI18D',
  );
  assert.notEqual(mutantSource, tileSource, 'negative control must change the source');
  const MutantTile = await compileTile(mutantSource);
  const mounted = mountTile(MutantTile, liveProps());
  const { target, router, scheduler, app, root } = mounted;
  try {
    const port = tilePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'notes-wn1', leaseId: 'notes-wnl1' }));
    await untilAcks(port, 1);
    const first = scheduler.getInstrumentation('A');
    await mounted.setProps({
      frame: first.lastPresentedHandle, digest: first.lastPresentedDigest,
      frameWidth: first.lastPresentedWidth, frameHeight: first.lastPresentedHeight,
    });
    const nextPort = tilePort();
    target.emit(portNotice(nextPort, 'A', NOTICE_GEN + 1));
    await tick();
    nextPort.deliver(await frameDelivery({
      correlation: 'notes-wn2', leaseId: 'notes-wnl2', surfaceGeneration: DELIVERY_GEN + 1,
      frameGeneration: 1,
      bytes: Uint8Array.from({ length: 18 }, (_v, i) => (201 + i) % 256),
    }));
    await untilAcks(nextPort, 1);
    await mounted.setProps({ frame: '', digest: '', frameWidth: 0, frameHeight: 0 });
    assert.equal(sectionNode(root).props['data-state'], 'live', 'the stale witness still claims live');
    assert.equal(byClass(root, 'mv-surface__strip').length, 1);
    assert.equal(mountText(root).includes(first.lastPresentedHandle.slice(0, 8)), true);
  } finally {
    app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('mvui18 judge note 3: retained size initializers carry no duplicated checks', () => {
  assert.doesNotMatch(tileSource, /typeof props\.frameWidth === 'number' && typeof props\.frameWidth/);
  assert.doesNotMatch(tileSource, /typeof props\.frameHeight === 'number' && typeof props\.frameHeight/);
  assert.ok(tileSource.includes("typeof props.frameWidth === 'number' && Number.isSafeInteger(props.frameWidth) && props.frameWidth > 0"));
  assert.ok(tileSource.includes("typeof props.frameHeight === 'number' && Number.isSafeInteger(props.frameHeight) && props.frameHeight > 0"));
  // Negative controls: the patterns spot the old duplication.
  assert.match(
    "typeof props.frameWidth === 'number' && typeof props.frameWidth === 'number'",
    /typeof props\.frameWidth === 'number' && typeof props\.frameWidth/,
  );
  assert.match(
    "typeof props.frameHeight === 'number' && typeof props.frameHeight === 'number'",
    /typeof props\.frameHeight === 'number' && typeof props\.frameHeight/,
  );
});

test('mvui18 judge notes: rss stays bounded', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} bytes stays under 512 MiB`);
});

