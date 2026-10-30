import {addOperatorStubs} from './operator-stubs.mjs';
// MVUI18 lane J: live frames paint (L3-1), frame scale jitter (L2-8), kit
// subscribe mirror. REAL-like numbers throughout: the notice stream id is
// 886 while deliveries pin surfaceGeneration 1 / epoch E, and the tile
// props carry projection generation 886+ with a different snapshot epoch.
// Mounts the REAL SurfaceCanvas + SurfacePanel SFCs (compiled with
// @vue/compiler-sfc, inline template) on a stub renderer with the REAL tile
// scheduler and the REAL frame-port router: no DOM, no new dependencies.
// Plain node:test; bounded fakes (2x2 frames, single deliveries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { createRenderer, h, inject, nextTick, ref } from 'vue';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import installFramePortRouter, {
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
} from '../src/frames/framePortRouter.js';
import { createTileScheduler, SCHEDULER_REASONS } from '../src/surfaces/tileScheduler.js';
import * as tileStates from '../src/wall/tileStates.js';
import { tick, untilAcks } from './frame-wait.mjs';

const ORIGIN = 'app://metaviewer';
// REAL-like identities (live3): notice stream id 886, delivery binding 1/E,
// projection props 886+ with an unrelated snapshot epoch.
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
// Real-SFC compile helpers (production sources untouched; mutants are
// in-memory strings for negative controls only).
// ---------------------------------------------------------------------------

const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));
const tileStatesUrl = JSON.stringify(import.meta.resolve('../src/wall/tileStates.js'));
let sfcSerial = 0;

function rewriteImports(code, deps) {
  let out = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, vueUrl);
    addOperatorStubs(deps);
    assert.ok(spec in deps, `Unmapped SFC dependency: ${spec}`);
    const target = deps[spec];
    if (typeof target === 'string') return `const ${bindings.trim()} = await import(${target});`;
    return `const ${bindings.trim()} = globalThis.__mvui18Deps[${JSON.stringify(spec)}];`;
  });
  return out;
}

async function compileSource(source, id, deps) {
  const compiled = compileScript(parse(source).descriptor, { id, inlineTemplate: true });
  const code = rewriteImports(compiled.content, deps);
  globalThis.__mvui18Deps = deps;
  try {
    const tag = `${id}-${sfcSerial++}`;
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
  } finally {
    delete globalThis.__mvui18Deps;
  }
}

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/wall/SurfacePanel.vue', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');

async function compileTile(source = tileSource) {
  return compileSource(source, 'mvui18-tile', { './tileScheduler.js': schedulerUrl });
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

const mountNodes = (node) => [node, ...(node.children ?? []).flatMap(mountNodes)];
const mountText = (node) => [node.text ?? '', ...(node.children ?? []).map(mountText)].join(' ');

// Mounts a compiled component with reactive props and provided doubles.
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

// ---------------------------------------------------------------------------
// L3-1: the canvas attaches with the identity the router registered.
// ---------------------------------------------------------------------------

test('L3-1 unit: notice pins the delivery binding; projection identity refuses', async () => {
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  assert.ok(router, 'router installs on the harness window');
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const seen = [];
  let attachedToken = null;
  try {
    const before = scheduler.attachCanvas({ surfaceId: 'A', canvas });
    assert.equal(before.ok, false, 'attach before registration fails');
    router.bindSurface({
      surfaceId: 'A', scheduler,
      onRegistered: (notice) => {
        seen.push({ ...notice });
        const attached = scheduler.attachCanvas({
          surfaceId: notice.surfaceId, surfaceGeneration: notice.surfaceGeneration,
          epoch: notice.epoch, canvas,
        });
        if (attached?.ok === true) attachedToken = attached.token ?? null;
      },
    });
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'real-app', frameGeneration: NOTICE_GEN, leaseId: 'lr3' }));
    await untilAcks(port, 1);
    assert.deepEqual(seen, [{ surfaceId: 'A', surfaceGeneration: DELIVERY_GEN, epoch: DELIVERY_EPOCH }]);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    assert.deepEqual(scheduler.getInstrumentation('A').surfaceGeneration, DELIVERY_GEN);
    // Negative control: the pre-fix tile attached with the PROJECTION
    // identity (notice/stream generation + snapshot epoch). That binding
    // reproduces the live INVALID_BINDING and never paints.
    assert.equal(typeof attachedToken, 'symbol', 'notice-identity attach owns the canvas');
    scheduler.detachCanvas('A', attachedToken);
    assert.equal(scheduler.getInstrumentation('A').canvasAttached, false);
    const refused = scheduler.attachCanvas({
      surfaceId: 'A', surfaceGeneration: NOTICE_GEN, epoch: SNAP_EPOCH, canvas,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(refused.reason, 'INVALID_BINDING');
    assert.equal(scheduler.getInstrumentation('A').canvasAttached, false);
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('L3-1 production path: mounted tile with App-like wiring paints and leaves Connecting', async () => {
  const SurfaceCanvas = await compileTile();
  // App-like wiring (main.js installs the router on window; App provides
  // the scheduler): projection props carry 886+/snapshot epoch.
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const mounted = mountWithProvide(SurfaceCanvas, {
    surfaceId: 'A', generation: PROPS_GEN, epoch: SNAP_EPOCH,
    frame: '', digest: '', state: 'live',
  }, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    const section = () => mountNodes(mounted.root).find((node) => node.tag === 'section');
    assert.equal(section().props['data-state'], 'connecting');
    assert.match(mountText(mounted.root), /Connecting to surface/);
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'live-paint', frameGeneration: NOTICE_GEN, leaseId: 'lp1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    assert.equal(canvas.paints.length, 1);
    assert.deepEqual(canvas.paints[0].width, 2);
    assert.deepEqual(scheduler.getInstrumentation('A').canvasAttached, true);
    // App surfaceWitness equivalence: the presented handle + delivery size
    // flow back as tile props and the tile leaves Connecting.
    const info = scheduler.getInstrumentation('A');
    assert.ok(info.lastPresentedHandle.length > 0);
    await mounted.setProps({
      frame: info.lastPresentedHandle, digest: info.lastPresentedDigest,
      frameWidth: info.lastPresentedWidth, frameHeight: info.lastPresentedHeight,
    });
    assert.equal(section().props['data-state'], 'live');
    assert.doesNotMatch(mountText(mounted.root), /Connecting to surface/);
    assert.equal(canvas.props.hidden, false);
    assert.equal(canvas.width, 2, 'intrinsic width equals the delivery width after paint');
    assert.equal(canvas.height, 2, 'intrinsic height equals the delivery height after paint');
    const strip = mountNodes(mounted.root).find((node) => node.props?.class === 'mv-surface__strip');
    assert.ok(strip, 'presented witness strip renders');
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

test('L3-1 negative: without the pinned identity the tile never paints', async () => {
  // In-memory mutant (production source untouched): the attach ignores the
  // router notice and uses the projection props, as before the fix.
  const mutantSource = tileSource.replace(
    'const identity = registeredIdentity;',
    'const identity = null; // mutant: projection-identity attach',
  );
  assert.notEqual(mutantSource, tileSource, 'negative control must change the source');
  const MutantTile = await compileTile(mutantSource);
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  const mounted = mountWithProvide(MutantTile, {
    surfaceId: 'A', generation: PROPS_GEN, epoch: SNAP_EPOCH,
    frame: '', digest: '', state: 'live',
  }, { tileScheduler: scheduler, framePortRouter: router }, canvas);
  try {
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'mutant', frameGeneration: NOTICE_GEN, leaseId: 'lm1' }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.REFUSED]);
    assert.equal(canvas.paints.length, 0);
    assert.equal(scheduler.getInstrumentation('A').canvasAttached, false);
    const section = mountNodes(mounted.root).find((node) => node.tag === 'section');
    assert.equal(section.props['data-state'], 'connecting');
    assert.match(mountText(mounted.root), /Connecting to surface/);
  } finally {
    mounted.app.unmount();
    router.dispose();
    scheduler.destroy();
  }
});

// ---------------------------------------------------------------------------
// L2-8: the last painted frame stays visible until the new one paints, at
// the delivery's intrinsic size with class-only scaling.
// ---------------------------------------------------------------------------

test('L2-8: generation advance before paint keeps the previous canvas', async () => {
  const SurfaceCanvas = await compileTile();
  const scheduler = createTileScheduler({ budget: BUDGET, onPresent: (r) => scheduler.presentHandle(r) });
  const canvas = drawableCanvasStub();
  const mounted = mountWithProvide(SurfaceCanvas, {
    surfaceId: 'A', generation: NOTICE_GEN, epoch: 1,
    frame: 'painted-handle-1', digest: 'ab'.repeat(32),
    frameWidth: 2, frameHeight: 2, state: 'live',
  }, { tileScheduler: scheduler }, canvas);
  try {
    const section = () => mountNodes(mounted.root).find((node) => node.tag === 'section');
    assert.equal(section().props['data-state'], 'live');
    // The delivery stream paints the mounted canvas through the scheduler:
    // its identity matches the post-gap projection, so the gap below reads
    // as a healthy same-stream wait, not a skewed stream.
    scheduler.registerSurface({ surfaceId: 'A', surfaceGeneration: NOTICE_GEN + 1, principal: 'utility', epoch: 1,
      state: { panelOpen: true, panelSelected: true, width: 2, height: 2, viewportIntersecting: true, windowPresentationAllowed: true } });
    assert.equal(scheduler.attachCanvas({ surfaceId: 'A', canvas }).ok, true);
    const firstRgb = [12, 34, 56, 78, 90, 11, 22, 33, 44, 55, 66, 77];
    const firstRgba = firstRgb.flatMap((byte, index) => (index % 3 === 2 ? [byte, 255] : [byte]));
    assert.equal(scheduler.submitFrame({ surfaceId: 'A', surfaceGeneration: NOTICE_GEN + 1, frameGeneration: 1, leaseId: 'lg1',
      byteLength: 12, width: 2, height: 2, bytes: new Uint8Array(firstRgb),
      principal: 'utility', epoch: 1, sha256: 'e'.repeat(64) }).ok, true);
    scheduler.runTick();
    assert.equal(canvas.width, 2, 'intrinsic width equals the delivery width after paint');
    assert.equal(canvas.height, 2, 'intrinsic height equals the delivery height after paint');
    // The projection advances before the async port frame arrives: the
    // witness props gap, but the painted canvas must not flash away.
    // The legacy gap re-attaches through the tile, so the scheduler may
    // repaint the retained frame; the asserts pin size and bytes, not count.
    await mounted.setProps({ generation: NOTICE_GEN + 1, frame: '', digest: '' });
    assert.equal(section().props['data-state'], 'live', 'no witness flash after a painted frame');
    assert.equal(canvas.props.hidden, false);
    assert.match(mountText(mounted.root), /painted-handle-1/);
    assert.equal(canvas.width, 2, 'painted size retained across the gap');
    assert.equal(canvas.height, 2);
    assert.deepEqual(canvas.paints.at(-1), { width: 2, height: 2, data: firstRgba }, 'the gap keeps the painted bytes, never cleared');
    // A dimension change repaints at the new size, never painted-then-cleared.
    const paintsBeforeResize = canvas.paints.length;
    assert.equal(scheduler.submitFrame({ surfaceId: 'A', surfaceGeneration: NOTICE_GEN + 1, frameGeneration: 2, leaseId: 'lg2',
      byteLength: 18, width: 3, height: 2, bytes: Uint8Array.from({ length: 18 }, (_v, i) => (i + 1) % 256),
      principal: 'utility', epoch: 1, sha256: 'f'.repeat(64) }).ok, true);
    scheduler.runTick();
    assert.equal(canvas.width, 3);
    assert.equal(canvas.height, 2);
    assert.equal(canvas.paints.length, paintsBeforeResize + 1, 'the resize paints exactly once');
    assert.equal(canvas.paints.at(-1).width, 3, 'the resize paints synchronously at the new size');
    assert.equal(canvas.paints.at(-1).height, 2);
    // Negative control: a tile that never painted has nothing to retain.
    const bare = mountWithProvide(SurfaceCanvas, {
      surfaceId: 'A', generation: NOTICE_GEN, epoch: 1, frame: '', digest: '', state: 'live',
    }, { tileScheduler: scheduler }, drawableCanvasStub());
    try {
      const bareSection = mountNodes(bare.root).find((node) => node.tag === 'section');
      assert.equal(bareSection.props['data-state'], 'connecting');
    } finally {
      bare.app.unmount();
    }
    // Only a surface change resets the retained frame.
    await mounted.setProps({ surfaceId: 'B' });
    assert.equal(section().props['data-state'], 'connecting');
    assert.doesNotMatch(mountText(mounted.root), /painted-handle-1/);
  } finally {
    mounted.app.unmount();
    scheduler.destroy();
  }
});

test('L2-8: presented size is the delivery size; App witness keeps it without the projection check', async () => {
  const target = fakeWindow();
  const router = installFramePortRouter({ target, digestSha256: realDigest });
  const scheduler = createTileScheduler({ budget: BUDGET });
  const canvas = drawableCanvasStub();
  try {
    assert.equal(scheduler.getInstrumentation('A'), null);
    router.bindSurface({
      surfaceId: 'A', scheduler,
      onRegistered: (notice) => {
        scheduler.attachCanvas({
          surfaceId: notice.surfaceId, surfaceGeneration: notice.surfaceGeneration,
          epoch: notice.epoch, canvas,
        });
      },
    });
    const port = framePort();
    target.emit(portNotice(port));
    const bytes = new Uint8Array(18).map((_, index) => index + 1);
    port.deliver(await frameDelivery({
      bytes, width: 3, height: 2, correlation: 'sized', frameGeneration: NOTICE_GEN, leaseId: 'ls1',
    }));
    await untilAcks(port, 1);
    assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
    const info = scheduler.getInstrumentation('A');
    assert.equal(info.lastPresentedWidth, 3, 'canvas intrinsic size equals delivery width');
    assert.equal(info.lastPresentedHeight, 2, 'canvas intrinsic size equals delivery height');
    // App surfaceWitness equivalence with REAL-like skew: delivery identity
    // (1/7) never equals the projection (887/snapshot epoch), yet the
    // witness must flow so the tile leaves Connecting.
    const witness = (surfaceId) => {
      const record = scheduler.getInstrumentation(surfaceId);
      if (!record || !('lastPresentedHandle' in record) || record.destroyed || record.contextLost) {
        return { frame: '', digest: '', width: 0, height: 0 };
      }
      return {
        frame: record.lastPresentedHandle, digest: record.lastPresentedDigest,
        width: record.lastPresentedWidth, height: record.lastPresentedHeight,
      };
    };
    const live = witness('A');
    assert.ok(live.frame.length > 0, 'tile leaves Connecting on first PRESENTED');
    assert.equal(live.width, 3);
    assert.equal(live.height, 2);
    assert.deepEqual(witness('missing'), { frame: '', digest: '', width: 0, height: 0 });
  } finally {
    router.dispose();
    scheduler.destroy();
  }
});

test('L2-8 static: canvas intrinsic size binds delivery size with class-only scaling', () => {
  const style = tileSource.slice(tileSource.indexOf('<style'));
  assert.equal(tileSource.includes(':width='), false, 'no reactive width binding may wipe a painted frame');
  assert.equal(tileSource.includes(':height='), false, 'no reactive height binding may wipe a painted frame');
  assert.ok(tileSource.includes('Intrinsic canvas size is owned by the scheduler paint path'), 'the paint path owns the intrinsic size');
  const canvasTag = tileSource.match(/<canvas[\s\S]*?\/>/)[0];
  assert.equal(canvasTag.includes('width'), false, 'the canvas tag carries no width attribute');
  assert.equal(canvasTag.includes('height'), false, 'the canvas tag carries no height attribute');
  assert.match(style, /\.mv-surface__canvas\s*\{[\s\S]*?width:\s*100%/, 'class scales the canvas');
  assert.match(style, /\.mv-surface__canvas\s*\{[\s\S]*?object-fit:\s*contain/, 'class preserves aspect ratio');
  const unsafe = (source) => /:style=|v-bind:style|v-show|\.style\.[a-zA-Z]|style\s*=/.test(source);
  assert.equal(unsafe(tileSource), false, 'no style writes: CSP-safe scaling');
  assert.equal(unsafe(`${tileSource}<canvas :style="'width:1px'"></canvas>`), true,
    'negative control: the check spots a planted style write');
  // App feeds the delivery size into every tile instance.
  const tileTags = appSource.match(/<SurfaceCanvas\b[\s\S]*?\/>/g) ?? [];
  assert.ok(tileTags.length >= 3, 'wall, multislot and selected tiles exist');
  for (const tag of tileTags) {
    assert.ok(tag.includes(':frame-width="'), `tile tag carries frame width: ${tag.slice(0, 60)}`);
    assert.ok(tag.includes(':frame-height="'), `tile tag carries frame height: ${tag.slice(0, 60)}`);
  }
});

// ---------------------------------------------------------------------------
// Judge note: kitProjectionView.subscribe mirrors the folded boolean for
// subscribers consuming the callback argument.
// ---------------------------------------------------------------------------

function panelSnapshot(row) {
  return {
    status: 'live', stale: false,
    envelope: { schema: 'panel/v1', epoch: 1, revision: 1, query: '', projection: { rows: [row] } },
    error: null,
  };
}

function panelRow(overrides = {}) {
  return {
    id: 'cap-01', surfaceId: 'cap-01', backendLifecycle: 'active',
    generation: 1, visibility: 'visible', control: 'agent', ...overrides,
  };
}

function fakeProjectionView(initial) {
  const listeners = new Set();
  return {
    snapshot: initial,
    getSnapshot() { return this.snapshot; },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    emit(next) {
      this.snapshot = next;
      for (const fn of [...listeners]) fn(next);
    },
  };
}

async function compilePanel(source, captured) {
  const CapsulePanel = {
    setup(_, ctx) {
      captured.view = inject('publicProjectionView', null);
      return () => h('section', {}, ctx.slots.surface?.() ?? []);
    },
  };
  const TileCaptureChrome = { setup: () => () => h('div') };
  return compileSource(source, 'mvui18-panel', {
    'capsule-ui-kit/CapsulePanel': CapsulePanel,
    './TileCaptureChrome.vue': TileCaptureChrome,
    './tileStates.js': tileStatesUrl,
  });
}

function panelProps(view) {
  return {
    capsuleId: 'cap-01',
    projectionView: view,
    intentBuilders: { visibility: () => ({}), control: () => ({}), presentation: () => ({}) },
    controlRegistry: {},
    scheduler: {},
    tileScheduler: null,
    presentationInstance: 'panel-cap-01',
  };
}

test('subscribe mirror: kit subscribers see the mirrored folded boolean', async () => {
  const captured = {};
  const SurfacePanel = await compilePanel(panelSource, captured);
  const first = panelRow();
  const view = fakeProjectionView(panelSnapshot(first));
  const mounted = mountWithProvide(SurfacePanel, panelProps(view), {});
  try {
    assert.ok(captured.view, 'kit panel injects the public projection view');
    const seen = [];
    const stop = captured.view.subscribe((snapshot) => { seen.push(snapshot); });
    assert.equal(typeof stop, 'function', 'subscribe returns the source unsubscribe');
    const folded = panelRow({ visibility: 'folded' });
    assert.equal('folded' in folded, false, 'live authority rows carry no folded boolean');
    view.emit(panelSnapshot(folded));
    await tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].envelope.projection.rows[0].folded, true);
    assert.equal('folded' in folded, false, 'the source snapshot is never mutated');
    assert.equal(captured.view.getSnapshot().envelope.projection.rows[0].folded, true,
      'getSnapshot stays mirrored too');
    stop();
  } finally {
    mounted.app.unmount();
  }
});

test('subscribe mirror negative: the raw listener sees no folded boolean', async () => {
  // In-memory mutant (production source untouched): subscribe passes the
  // listener through, as before the fix.
  const mutantSource = panelSource.replace(
    'kitViewSource.subscribe((s) => listener(mirrorKitFoldedSnapshot(s)))',
    'kitViewSource.subscribe(listener)',
  );
  assert.notEqual(mutantSource, panelSource, 'negative control must change the source');
  const captured = {};
  const MutantPanel = await compilePanel(mutantSource, captured);
  const view = fakeProjectionView(panelSnapshot(panelRow()));
  const mounted = mountWithProvide(MutantPanel, panelProps(view), {});
  try {
    const seen = [];
    captured.view.subscribe((snapshot) => { seen.push(snapshot); });
    const folded = panelRow({ visibility: 'folded' });
    view.emit(panelSnapshot(folded));
    await tick();
    assert.equal(seen.length, 1);
    assert.equal('folded' in seen[0].envelope.projection.rows[0], false,
      'raw subscribers miss the mirror the kit reads');
  } finally {
    mounted.app.unmount();
  }
});

// Mounts the REAL App (R1-074 idiom: only external UI boundaries are
// stubbed) with a capturing canvas stub. `provides` decides the witness
// regime: a provided router is the live delivery-identity path.
async function loadAppHarness(captured, row) {
  const stub = vue.defineComponent({ setup: (_, ctx) => () => vue.h('div', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])) });
  const wall = vue.defineComponent({ setup: (_, ctx) => () => vue.h('main', {}, row ? ctx.slots.surface?.({ surface: row, capsuleId: row.id }) : []) });
  const canvas = vue.defineComponent({
    props: ['surfaceId', 'generation', 'epoch', 'state', 'frame', 'digest', 'frameWidth', 'frameHeight'],
    setup: (props) => () => {
      captured.push({ ...props });
      return vue.h('canvas');
    },
  });
  const deps = {
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub, NewCapsuleDialog: stub },
    '../.kit/capsule-ui-kit/src/side-terminal/SideTerminalPanel.vue': stub,
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme: () => {} },
    '../.kit/capsule-ui-kit/src/shell/SettingsModel.js': { SETTINGS_STORAGE_KEYS: { scheme: 'scheme' }, readStoredSetting: (_s, _k, d) => d, writeStoredSetting: () => {} },
    './wall/WallWorkspace.vue': wall,
    './surfaces/SurfaceCanvas.vue': canvas,
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './settings/settingsHost.js': { createSettingsHost },
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  globalThis.__mvui18AppDeps = deps;
  try {
    const { descriptor } = parse(appSource);
    const compiled = compileScript(descriptor, { id: 'mvui18-app', inlineTemplate: true });
    const require = createRequire(import.meta.url);
    const code = compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, bindings, _quote, specifier) => {
      if (specifier === 'vue') return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      return `const ${bindings.trim()} = globalThis.__mvui18AppDeps[${JSON.stringify(specifier)}];`;
    });
    const tag = `mvui18-app-${sfcSerial++}`;
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
  } finally {
    delete globalThis.__mvui18AppDeps;
  }
}

function appRenderer() {
  return vue.createRenderer({
    createElement: (tag) => ({ tag, children: [] }),
    createText: (text) => ({ text }),
    createComment: (text) => ({ text }),
    insert(child, parent) { child.parent = parent; parent.children.push(child); },
    remove(child) {
      const children = child.parent?.children;
      if (children) children.splice(children.indexOf(child), 1);
    },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; },
    parentNode: (node) => node.parent,
    nextSibling: () => null,
    patchProp() {},
    querySelector: () => null,
    setScopeId() {},
  });
}

test('L3-1 App witness: router path flows with skewed identities, legacy path keeps the guard', async () => {
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const budget = Object.freeze({
    maxDrawsPerTick: 1, maxUploadBytesPerTick: 3, maxPresentMsPerTick: 8,
    maxWarmResourcesPerSurface: 0, maxDrainSteps: 1,
  });
  const scheduler = createTileScheduler({ budget, onPresent: (r) => scheduler.presentHandle(r) });
  const binding = { surfaceId: 'A', surfaceGeneration: DELIVERY_GEN, principal: 'wall-main', epoch: DELIVERY_EPOCH };
  scheduler.registerSurface({ ...binding, state: { panelOpen: true, panelSelected: true, width: 10, height: 10, viewportIntersecting: true, windowPresentationAllowed: true } });
  scheduler.attachCanvas({ surfaceId: 'A', canvas: drawableCanvasStub() });
  scheduler.submitFrame({ ...binding, frameGeneration: NOTICE_GEN, leaseId: 'lw1', width: 1, height: 1, byteLength: 3, bytes: new Uint8Array([9, 9, 9]), sha256: '9'.repeat(64) });
  scheduler.runTick();
  // REAL-like skew: projection generation 886+ and a snapshot epoch that
  // never equal the delivery binding (1/7).
  const row = vue.reactive({ id: 'A', surfaceId: 'A', generation: PROPS_GEN, backendLifecycle: 'active', attachmentState: 'live' });
  const snapshot = { status: 'live', stale: false, envelope: { epoch: SNAP_EPOCH }, error: null };
  const runtime = {
    tileScheduler: scheduler,
    projectionView: { getProjection: () => ({ rows: [row] }), getSnapshot: () => snapshot, subscribe: () => () => {} },
    intentBuilders: {}, controlRegistry: {}, scheduler: {},
  };
  const props = { runtime, layout: {}, scope: {}, storage: { readRaw: async () => null, writeAtomic: async () => {} } };
  const liveRouterTarget = fakeWindow();
  const liveRouter = installFramePortRouter({ target: liveRouterTarget, digestSha256: realDigest });
  let legacyApp = null;
  let liveApp = null;
  try {
    const legacyCaptured = [];
    const LegacyApp = await loadAppHarness(legacyCaptured, row);
    legacyApp = appRenderer().createApp(LegacyApp, props);
    legacyApp.mount({ children: [] });
    assert.equal(legacyCaptured.at(-1).frame, '',
      'legacy path (R1-074): a skewed entry must not label the tile live');
    const liveCaptured = [];
    const LiveApp = await loadAppHarness(liveCaptured, row);
    liveApp = appRenderer().createApp(LiveApp, props);
    liveApp.provide('framePortRouter', liveRouter);
    liveApp.mount({ children: [] });
    assert.ok(liveCaptured.at(-1).frame.length > 0, 'router path: the witness flows despite the skew');
    assert.equal(liveCaptured.at(-1).digest, '9'.repeat(64));
    assert.equal(liveCaptured.at(-1).frameWidth, 1, 'router path: delivery width reaches the tile');
    assert.equal(liveCaptured.at(-1).frameHeight, 1);
  } finally {
    legacyApp?.unmount();
    liveApp?.unmount();
    liveRouter.dispose();
    scheduler.destroy();
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  }
});

test('mvui18 memory: suite rss stays under the 512 MiB ceiling', () => {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 512 * 1024 * 1024, `rss ${rss} exceeds 512 MiB`);
});
