// MVUI30 lane L: a lost capsule shows its last presented frame frozen with a
// Lost badge instead of "Connecting to surface". Canvas state maps from the
// backend lifecycle (not the attachment); the frozen tile keeps its canvas
// visible, takes no input, and takes no new paints; destroyed,
// detached and unknown rows never render the frozen view. Hosted-safe: the
// REAL SurfaceCanvas SFC (compiled with @vue/compiler-sfc, inline template),
// the REAL tile scheduler and frame-port router, and the REAL App.vue (same
// stub map as the committed App harnesses) on stub renderers. Plain
// node:test, no Electron, no sockets, no host paths. Bounded fakes (2x2
// frames, single-digit deliveries); async waits only via frame-wait.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue';
import {
  canvasStateForRow,
  createTileScheduler,
  surfaceLostBadgeAccessibleName,
  surfaceLostBadgeAnchor,
} from '../src/surfaces/tileScheduler.js';
import installFramePortRouter, {
  FRAME_DELIVERY_SCHEMA,
  FRAME_OUTCOMES,
  FRAME_PORT_NOTICE_SCHEMA,
  FRAME_PORT_NOTICE_TYPE,
} from '../src/frames/framePortRouter.js';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { tick, until, untilAcks } from './frame-wait.mjs';

// ---------------------------------------------------------------------------
// Mapping truth table (pure): backend lifecycle wins over attachment.
// ---------------------------------------------------------------------------

describe('mvui30 canvas state mapping', () => {
  test('lost lifecycle maps to lost whatever the attachment claims', () => {
    for (const attachment of ['live', 'disconnected', 'attaching', 'restoring', 'detached', undefined, null, '']) {
      assert.equal(
        canvasStateForRow({ backendLifecycle: 'lost', attachmentState: attachment }),
        'lost', String(attachment),
      );
    }
  });

  test('every other lifecycle keeps the live/connecting attachment mapping', () => {
    for (const lifecycle of ['active', 'standby', 'ceded', 'destroyed', 'melted', '', null, undefined]) {
      assert.equal(
        canvasStateForRow({ backendLifecycle: lifecycle, attachmentState: 'live' }),
        'live', String(lifecycle),
      );
      for (const attachment of ['attaching', 'restoring', 'disconnected', 'detached', undefined, null, '']) {
        assert.equal(
          canvasStateForRow({ backendLifecycle: lifecycle, attachmentState: attachment }),
          'connecting', `${String(lifecycle)}/${String(attachment)}`,
        );
      }
    }
  });

  test('negative controls: destroyed, detached and malformed rows never yield lost', () => {
    for (const row of [null, undefined, 7, 'lost', [], { backendLifecycle: 'destroyed', attachmentState: 'live' },
      { backendLifecycle: 'lostx' }, { attachmentState: 'lost' }, {}]) {
      assert.notEqual(canvasStateForRow(row), 'lost', JSON.stringify(row));
    }
    assert.equal(canvasStateForRow({ backendLifecycle: 'destroyed' }), 'connecting');
    assert.equal(canvasStateForRow({ attachmentState: 'detached' }), 'connecting');
  });
});

describe('mvui30 lost badge identity', () => {
  test('anchor and accessible name are pinned', () => {
    assert.equal(surfaceLostBadgeAnchor('A'), 'tile-A-lost-badge');
    assert.equal(surfaceLostBadgeAccessibleName(), 'Capsule lost: showing the last frame');
  });

  test('hostile surface ids stay anchor-safe', () => {
    const anchor = surfaceLostBadgeAnchor('a/b c');
    assert.doesNotMatch(anchor, /[\s/]/);
    assert.match(anchor, /^tile-.*-lost-badge$/);
  });
});

// ---------------------------------------------------------------------------
// SurfaceCanvas rig: stub renderer plus a canvas double with real bitmap,
// focus, and paint semantics.
// ---------------------------------------------------------------------------

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
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
  const compiled = compileScript(parse(source).descriptor, { id: 'mvui30-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, { './tileScheduler.js': schedulerUrl });
  const tag = `mvui30-tile-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const SurfaceCanvas = await compileTile(tileSource);

function tileCanvasDouble() {
  const doc = { activeElement: null };
  const canvas = {
    tag: 'canvas', props: {}, children: [], text: null, parent: null,
    paints: [],
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100 };
    },
    getContext() {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: (image) => {
          canvas.paints.push({ width: image.width, height: image.height, data: [...image.data] });
        },
      };
    },
    focus() {
      if (canvas.props.tabindex === 0 || canvas.props.tabindex === '0') {
        doc.activeElement = canvas;
        canvas.props.onFocus?.({ type: 'focus', target: canvas });
      }
    },
    blur() {
      if (doc.activeElement === canvas) {
        doc.activeElement = null;
        canvas.props.onBlur?.({ type: 'blur', target: canvas });
      }
    },
  };
  let w = 0;
  let h = 0;
  Object.defineProperties(canvas, {
    width: {
      get: () => w, set: (v) => { w = v; canvas.paints.length = 0; },
      enumerable: true, configurable: true,
    },
    height: {
      get: () => h, set: (v) => { h = v; canvas.paints.length = 0; },
      enumerable: true, configurable: true,
    },
  });
  return { canvas, doc };
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
const sectionOf = (root) => mountNodes(root).find((node) => node.tag === 'section');
const badgeOf = (root) => mountNodes(root).find((node) => node.props?.id === 'tile-A-lost-badge');
const stripOf = (root) => mountNodes(root).find((node) => node.props?.class === 'mv-surface__strip');

function mountTile(Component, provides, canvasStub, initialProps = {}) {
  const { createApp } = createRenderer(stubOps(canvasStub));
  const propsRef = ref({
    surfaceId: 'A', generation: 1, epoch: 7,
    frame: '', digest: '', state: 'live', frameWidth: 0, frameHeight: 0,
    inputEnabled: false, streamId: 0,
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

function stubInputPort() {
  const queueCalls = [];
  const port = Object.freeze({
    available: true,
    send: async () => ({ ok: true, accepted: 0 }),
    queue: (surfaceId, streamId, event) => { queueCalls.push({ surfaceId, streamId, event }); },
    onRefusal: () => () => {},
    dispose: () => {},
  });
  return { port, queueCalls };
}

function fakeKeyEvent(key, overrides = {}) {
  const event = {
    type: 'keydown', key, ctrlKey: false, altKey: false, shiftKey: false,
    metaKey: false, keyCode: 0, isComposing: false, defaultPrevented: false,
    ...overrides,
    preventDefault() { event.defaultPrevented = true; },
  };
  return event;
}

function fakePointerEvent(type, overrides = {}) {
  const event = {
    type, button: 0, buttons: 1, clientX: 0, clientY: 0, defaultPrevented: false,
    ...overrides,
    preventDefault() { event.defaultPrevented = true; },
  };
  return event;
}

function fakeWheelEvent(overrides = {}) {
  const event = {
    type: 'wheel', deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 0, clientY: 0,
    defaultPrevented: false,
    ...overrides,
    preventDefault() { event.defaultPrevented = true; },
  };
  return event;
}

function schedulerDouble() {
  let info = null;
  return {
    scheduler: {
      attachCanvas: () => ({ ok: false, reason: 'SURFACE_NOT_REGISTERED' }),
      detachCanvas: () => {},
      getInstrumentation: () => info,
    },
    setInfo(next) { info = next; },
  };
}

// ---------------------------------------------------------------------------
// Frozen view: lost with a retained frame keeps canvas plus badge.
// ---------------------------------------------------------------------------

describe('mvui30 frozen lost tile', () => {
  test('lost with a retained frame shows the canvas and the badge, never the strip', () => {
    const { canvas } = tileCanvasDouble();
    const tile = mountTile(SurfaceCanvas, {}, canvas,
      { frame: 'frame-handle-1', digest: 'digest-1', state: 'lost' });
    try {
      assert.equal(sectionOf(tile.root).props['data-state'], 'lost');
      assert.equal(canvas.props.hidden, false, 'frozen canvas stays visible');
      const badge = badgeOf(tile.root);
      assert.ok(badge, 'Lost badge renders');
      assert.equal(badge.props['data-semantic-anchor'], 'tile-A-lost-badge');
      assert.equal(badge.props['aria-label'], 'Capsule lost: showing the last frame');
      assert.equal(badge.props.role, 'status');
      assert.match(mountText(tile.root), /Lost/);
      assert.match(mountText(tile.root), /Showing the last frame\./);
      assert.doesNotMatch(mountText(tile.root), /Connecting/);
      assert.equal(stripOf(tile.root), undefined, 'no witness strip on a frozen tile (R2-16)');
      assert.doesNotMatch(mountText(tile.root), /frame-handle-1/,
        'frame identity lives on the panel Frame badge, not the frozen canvas');
    } finally {
      tile.app.unmount();
    }
  });

  test('lost without a frame shows Lost, never Connecting', () => {
    const { canvas } = tileCanvasDouble();
    const tile = mountTile(SurfaceCanvas, {}, canvas, { state: 'lost' });
    try {
      assert.equal(sectionOf(tile.root).props['data-state'], 'lost');
      assert.equal(canvas.props.hidden, true);
      assert.equal(badgeOf(tile.root), undefined, 'no frozen badge without a frame');
      assert.match(mountText(tile.root), /Lost/);
      assert.doesNotMatch(mountText(tile.root), /Connecting/);
      assert.equal(stripOf(tile.root), undefined, 'no witness strip without a frame');
    } finally {
      tile.app.unmount();
    }
  });

  test('negative control: a live surface with no frame still shows Connecting', () => {
    const { canvas } = tileCanvasDouble();
    const tile = mountTile(SurfaceCanvas, {}, canvas, { state: 'live', frame: '' });
    try {
      assert.equal(sectionOf(tile.root).props['data-state'], 'connecting');
      assert.equal(canvas.props.hidden, true);
      assert.equal(badgeOf(tile.root), undefined);
      assert.match(mountText(tile.root), /Connecting to surface/);
      assert.equal(stripOf(tile.root), undefined);
    } finally {
      tile.app.unmount();
    }
  });

  test('negative controls: destroyed and detached states never show the frozen view', () => {
    for (const [state, copy] of [['connecting', 'Connecting to surface'], ['empty', 'Waiting for surface']]) {
      const { canvas } = tileCanvasDouble();
      const tile = mountTile(SurfaceCanvas, {}, canvas, { state, frame: 'frame-handle-1' });
      try {
        assert.equal(canvas.props.hidden, true, `${state}: canvas hidden despite a retained frame`);
        assert.equal(badgeOf(tile.root), undefined, `${state}: no Lost badge`);
        assert.match(mountText(tile.root), new RegExp(copy), state);
        assert.doesNotMatch(mountText(tile.root), /Showing the last frame/, state);
      } finally {
        tile.app.unmount();
      }
    }
  });

  test('retained-witness drop behaviour stays: blank over a dead surface drops, live gaps keep', async () => {
    const double = schedulerDouble();
    const { canvas } = tileCanvasDouble();
    const tile = mountTile(SurfaceCanvas, { tileScheduler: double.scheduler }, canvas,
      { state: 'live', frame: 'h1' });
    try {
      assert.ok(stripOf(tile.root), 'presented frame shows the strip');
      double.setInfo(null);
      await tile.setProps({ frame: '' });
      assert.ok(stripOf(tile.root), 'unknown entry keeps the retained witness');
      assert.equal(sectionOf(tile.root).props['data-state'], 'live');
      await tile.setProps({ frame: 'h2' });
      double.setInfo({ destroyed: true });
      await tile.setProps({ frame: '' });
      assert.equal(sectionOf(tile.root).props['data-state'], 'connecting');
      assert.equal(stripOf(tile.root), undefined, 'destroyed blank drops the retained witness');
      await tile.setProps({ frame: 'h3' });
      double.setInfo({ contextLost: true });
      await tile.setProps({ frame: '' });
      assert.equal(sectionOf(tile.root).props['data-state'], 'connecting');
      assert.equal(stripOf(tile.root), undefined, 'contextLost blank drops the retained witness');
      assert.equal(canvas.paints.length, 0);
    } finally {
      tile.app.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Frozen input gate: no focus, no capture, even when gated in and focused.
// ---------------------------------------------------------------------------

describe('mvui30 frozen input gate', () => {
  test('lost stays unfocusable and queues nothing; live still queues', async () => {
    const { canvas, doc } = tileCanvasDouble();
    const { port, queueCalls } = stubInputPort();
    const tile = mountTile(SurfaceCanvas, { inputPort: port }, canvas,
      { state: 'lost', frame: 'h1', inputEnabled: true, streamId: 3 });
    try {
      assert.equal(canvas.props.tabindex, undefined, 'no tabindex while lost');
      assert.equal(canvas.props['aria-hidden'], 'true');
      assert.equal(canvas.props.id, undefined, 'no input anchor while lost');
      assert.equal(canvas.props['data-semantic-anchor'], undefined);
      assert.equal(canvas.props['aria-label'], undefined);
      canvas.focus();
      assert.equal(doc.activeElement, null, 'focus is a no-op without tabindex');
      canvas.props.onFocus({ type: 'focus', target: canvas });
      const key = fakeKeyEvent('a');
      canvas.props.onKeydown(key);
      assert.equal(key.defaultPrevented, false, 'no preventDefault while lost');
      assert.equal(queueCalls.length, 0, 'no key queued while lost');
      const down = fakePointerEvent('pointerdown', { clientX: 100, clientY: 50 });
      canvas.props.onPointerdown(down);
      assert.equal(down.defaultPrevented, true, 'pointerdown still prevents page scroll');
      canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 100, clientY: 50 }));
      assert.equal(queueCalls.length, 0, 'no click queued while lost');
      const wheel = fakeWheelEvent({ clientX: 100, clientY: 50, deltaY: -10 });
      canvas.props.onWheel(wheel);
      assert.equal(wheel.defaultPrevented, false, 'wheel untouched while lost');
      assert.equal(queueCalls.length, 0);
      await tile.setProps({ state: 'live' });
      assert.equal(canvas.props.tabindex, 0, 'live restores focusability');
      canvas.width = 400;
      canvas.height = 200;
      canvas.focus();
      canvas.props.onPointerdown(fakePointerEvent('pointerdown', { clientX: 100, clientY: 50 }));
      canvas.props.onPointerup(fakePointerEvent('pointerup', { clientX: 100, clientY: 50 }));
      assert.equal(queueCalls.length, 1, 'live gated-in canvas still queues a click');
      assert.equal(queueCalls[0].event.kind, 'click');
    } finally {
      tile.app.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Frozen paint gate: the lost transition detaches, so later deliveries paint
// nothing and the bitmap stays intact.
// ---------------------------------------------------------------------------

const ORIGIN = 'app://metaviewer';
const NOTICE_GEN = 886;
const DELIVERY_GEN = 1;
const DELIVERY_EPOCH = 7;
const BYTES_2X2_A = [12, 34, 56, 78, 90, 11, 22, 33, 44, 55, 66, 77];
const BYTES_2X2_B = BYTES_2X2_A.map((b) => 255 - b);
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

describe('mvui30 frozen paint gate', () => {
  test('a delivery after loss paints nothing and the bitmap stays intact', async () => {
    const target = fakeWindow();
    const router = installFramePortRouter({ target, digestSha256: realDigest });
    const scheduler = createTileScheduler({ budget: BUDGET });
    const { canvas } = tileCanvasDouble();
    const port = framePort();
    target.emit(portNotice(port));
    port.deliver(await frameDelivery({ correlation: 'frozen-1', frameGeneration: 886, leaseId: 'frozen-l1' }));
    const mounted = mountTile(SurfaceCanvas,
      { tileScheduler: scheduler, framePortRouter: router }, canvas, { state: 'live' });
    try {
      await until(() => canvas.paints.length === 1, 'first paint after mount', 2000);
      await untilAcks(port, 1);
      assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED]);
      const info = scheduler.getInstrumentation('A');
      await mounted.setProps({
        frame: info.lastPresentedHandle, digest: info.lastPresentedDigest,
        frameWidth: info.lastPresentedWidth, frameHeight: info.lastPresentedHeight,
      });
      assert.equal(sectionOf(mounted.root).props['data-state'], 'live');
      const frozen = { ...canvas.paints[0], data: [...canvas.paints[0].data] };
      await mounted.setProps({ state: 'lost' });
      assert.equal(sectionOf(mounted.root).props['data-state'], 'lost');
      assert.equal(canvas.props.hidden, false, 'frozen canvas stays visible');
      assert.ok(badgeOf(mounted.root), 'Lost badge renders after the transition');
      assert.equal(scheduler.getInstrumentation('A').canvasAttached, false, 'lost detaches the binding');
      port.deliver(await frameDelivery({
        correlation: 'frozen-2', frameGeneration: 887, leaseId: 'frozen-l2',
        bytes: new Uint8Array(BYTES_2X2_B),
      }));
      await untilAcks(port, 2);
      assert.deepEqual(ackOutcomes(port), [FRAME_OUTCOMES.PRESENTED, FRAME_OUTCOMES.REFUSED]);
      assert.equal(canvas.paints.length, 1, 'no new paint after loss');
      assert.deepEqual(canvas.paints[0].data, frozen.data, 'frozen bitmap stays intact');
      assert.equal(canvas.props.hidden, false);
    } finally {
      mounted.app.unmount();
      router.dispose();
      scheduler.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// App wiring: every SurfaceCanvas mount maps lost lifecycles to lost state.
// ---------------------------------------------------------------------------

const APP_URL = new URL('../src/App.vue', import.meta.url);
let appSerial = 0;

async function loadApp(captured) {
  const stub = defineComponent({
    setup: (_, ctx) => () => h('div', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
  });
  const canvasStub = defineComponent({
    props: ['surfaceId', 'state', 'inputEnabled'],
    setup: (props) => {
      captured.canvases.push({ surfaceId: props.surfaceId, state: props.state, inputEnabled: props.inputEnabled });
      return () => h('div');
    },
  });
  const wallStub = defineComponent({
    setup: (_, ctx) => () => h('div', {},
      (captured.wallRows ?? []).flatMap((row) => ctx.slots.surface?.({ surface: row, capsuleId: row.id }) ?? [])),
  });
  const multislotStub = defineComponent({
    setup: (_, ctx) => () => h('div', {}, ctx.slots.surface?.() ?? []),
  });
  globalThis.__mvui30deps = {
    './core/HostOutcome.vue': stub,
    './activity/ActivityStrip.vue': stub,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': wallStub,
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': multislotStub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './creative/CreativeCapsule.vue': stub,
    './surfaces/SurfaceCanvas.vue': canvasStub,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  const { descriptor } = parse(readFileSync(APP_URL, 'utf8'));
  const compiled = compileScript(descriptor, { id: `mvui30-app-${++appSerial}`, inlineTemplate: true });
  const require = createRequire(import.meta.url);
  const code = compiled.content.replace(/^[ \t]*import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
    (all, binding, _q, specifier) => {
      if (specifier === 'vue') {
        return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
      }
      return `const ${binding.trim()} = globalThis.__mvui30deps[${JSON.stringify(specifier)}];`;
    });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui30-app-${appSerial}`)).default;
}

function appRenderer() {
  return createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }),
    createComment: (text) => ({ text }),
    insert(child, parent, anchor) {
      if (child.parent) this.remove(child);
      child.parent = parent;
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
    },
    remove(child) {
      const items = child.parent?.children;
      if (items) items.splice(items.indexOf(child), 1);
    },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, _old, value) { node.props[key] = value; },
    querySelector: () => null,
    setScopeId() {},
  });
}

function appRow(id, overrides = {}) {
  return {
    id, surfaceId: id, title: `Capsule ${id}`, kind: 'program',
    backendLifecycle: 'active', generation: 1, visibility: 'unfolded',
    control: 'shared', attachmentState: 'live', ...overrides,
  };
}

function appRuntime(rows) {
  const snapshot = {
    status: 'live', stale: false, error: null,
    envelope: { schema: 'surface/v0.1', epoch: 1, revision: 1, query: 'wall', projection: { rows } },
  };
  return {
    projectionView: {
      getSnapshot: () => snapshot,
      getProjection: () => ({ rows }),
      subscribe: () => () => {},
    },
  };
}

function stubGlobals() {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  return () => {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    delete globalThis.__mvui30deps;
  };
}

const appProps = (overrides = {}) => ({
  runtime: appRuntime([]),
  layout: {}, scope: {},
  nestedHost: { getNestedDepth: () => 0, getSelfCapsuleId: () => null },
  storage: { readRaw: async () => null, writeAtomic: async () => {} },
  ...overrides,
});

describe('mvui30 App mount mapping', () => {
  test('wall mount maps lost to lost, keeps live/connecting, and gates lost input', async () => {
    const restore = stubGlobals();
    let appHandle;
    try {
      const rows = [
        appRow('L1', { backendLifecycle: 'lost', attachmentState: 'disconnected', control: 'human' }),
        appRow('A1', { backendLifecycle: 'active', attachmentState: 'live', control: 'human' }),
        appRow('A2', { backendLifecycle: 'active', attachmentState: 'attaching' }),
        appRow('M1', { backendLifecycle: 'melted', attachmentState: 'disconnected' }),
        appRow('D1', { backendLifecycle: 'destroyed', attachmentState: 'disconnected' }),
      ];
      const captured = { canvases: [], wallRows: rows };
      const App = await loadApp(captured);
      const root = { children: [] };
      appHandle = appRenderer().createApp(App, appProps({
        runtime: appRuntime(rows),
        fixture: { key: 'tile-states', scheme: 'mv-light', ui: { inputMode: 'WRITE' }, capsules: [{ id: 'L1' }] },
      }));
      appHandle.mount(root);
      await nextTick();
      const byId = new Map(captured.canvases.map((entry) => [entry.surfaceId, entry]));
      assert.equal(byId.get('L1')?.state, 'lost', 'lost lifecycle reaches the canvas as lost');
      assert.equal(byId.get('L1')?.inputEnabled, false, 'lost input stays gated in WRITE mode');
      assert.equal(byId.get('A1')?.state, 'live');
      assert.equal(byId.get('A1')?.inputEnabled, true, 'live human tile stays gated in');
      assert.equal(byId.get('A2')?.state, 'connecting');
      assert.equal(byId.get('M1')?.state, 'connecting', 'unknown lifecycle never yields lost');
      assert.equal(byId.get('D1')?.state, 'connecting', 'destroyed never yields lost');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });

  test('multislot mount maps a lost selection to lost', async () => {
    const restore = stubGlobals();
    let appHandle;
    try {
      const rows = [appRow('L1', { backendLifecycle: 'lost', attachmentState: 'disconnected' })];
      const captured = { canvases: [], wallRows: [] };
      const App = await loadApp(captured);
      const root = { children: [] };
      appHandle = appRenderer().createApp(App, appProps({
        runtime: appRuntime(rows),
        fixture: { key: 'multislot', ui: { liveReplay: true }, capsules: [{ id: 'L1' }] },
      }));
      appHandle.mount(root);
      await nextTick();
      assert.equal(captured.canvases.length, 1);
      assert.equal(captured.canvases[0].surfaceId, 'L1');
      assert.equal(captured.canvases[0].state, 'lost');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });

  test('nested mount maps lost to lost and live to live', async () => {
    const restore = stubGlobals();
    let appHandle;
    try {
      const rows = [
        appRow('L1', { backendLifecycle: 'lost', attachmentState: 'disconnected' }),
        appRow('A1', { backendLifecycle: 'active', attachmentState: 'live' }),
      ];
      const captured = { canvases: [], wallRows: [] };
      const App = await loadApp(captured);
      const root = { children: [] };
      appHandle = appRenderer().createApp(App, appProps({
        runtime: appRuntime(rows),
        nestedHost: { getNestedDepth: () => 1, getSelfCapsuleId: () => null },
      }));
      appHandle.mount(root);
      await nextTick();
      const byId = new Map(captured.canvases.map((entry) => [entry.surfaceId, entry]));
      assert.equal(byId.get('L1')?.state, 'lost');
      assert.equal(byId.get('A1')?.state, 'live');
    } finally {
      appHandle?.unmount();
      restore();
    }
  });
});
