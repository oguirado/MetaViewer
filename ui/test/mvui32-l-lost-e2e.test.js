// MVUI32 lane L: lost surface end-to-end on the real renderer path.
//
// A dead capsule's core event
//   {schema:'surface_event/v0.2', event:'state_changed',
//    data:{surface:{surface_id, state:'lost', control, visibility, ...}}}
// reaches the renderer as a closed {frame_ref, surface} notice: the host
// reuses the last live frame_ref (publishState) and posts it state-only,
// the preload forwards it to subscribeFrames listeners. This file feeds
// that host-equivalent notice through the REAL createAuthorityRuntime +
// REAL projection into a REAL App mount (nested display-only, REAL
// SurfaceCanvas SFC, REAL tile scheduler, REAL frame-port router) after a
// live surface with a presented 2x2 frame, and asserts the tile freezes
// with the Capsule lost badge (anchor tile-<surface>-lost-badge) and no
// longer reads live. Negative controls: live without the event keeps
// live; destroyed never shows the frozen view. Hosted-safe: plain
// node:test, no Electron, no sockets, no host paths; waits via frame-wait.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, defineComponent, h, nextTick } from 'vue';
import { createAuthorityRuntime } from '../src/core/hostAdapters.js';
import {
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

const SID = 'cap-01';
const ORIGIN = 'app://metaviewer';
const NOTICE_GEN = 886;
const DELIVERY_GEN = 1;
const DELIVERY_EPOCH = 7;
const BYTES_2X2 = [12, 34, 56, 78, 90, 11, 22, 33, 44, 55, 66, 77];
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
const STORAGE = { readRaw: async () => null, writeAtomic: async () => {} };
const NESTED_HOST = { getNestedDepth: () => 1, getSelfCapsuleId: () => null };

async function hexDigest(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const realDigest = (bytes) => hexDigest(bytes);

// ---------------------------------------------------------------------------
// Authority notices: live, then the host-equivalent lost translation.
// ---------------------------------------------------------------------------

function liveFrameRef() {
  return {
    schema: 'frame_ref/v0.2', surface_id: SID, generation: 1,
    width: 320, height: 180, tick: 1, ts_ns: 1700000000, capture_us: 120,
    format: 'rgb24', sha256: 'ab'.repeat(32),
  };
}

function liveSurface() {
  return {
    schema: 'surface/v0.2', surface_id: SID, kind: 'desktop_capsule',
    display: 'E2E capsule', geometry: { w: 320, h: 180 }, state: 'active',
    visibility: 'unfolded', control: 'shared', profile_id: 'e2e-bench',
  };
}

/**
 * Host-equivalent translation of the core lost event into the renderer
 * notice. The host keeps the last live frame_ref for the surface and
 * posts it state-only with the lost surface record; the preload
 * forwards that notice to every subscribeFrames listener. Same
 * generation as the live frame: the lost delivery reuses it.
 * @param {{ schema: string, event: string, data: { surface: Record<string, unknown> } }} event
 * @param {Record<string, unknown>} lastFrameRef
 */
function translateSurfaceEvent(event, lastFrameRef) {
  assert.equal(event.schema, 'surface_event/v0.2');
  assert.equal(event.event, 'state_changed');
  const surface = event.data?.surface;
  assert.ok(surface && typeof surface === 'object');
  assert.equal(surface.surface_id, SID);
  assert.equal(surface.state, 'lost');
  return { frame_ref: lastFrameRef, surface: { ...surface } };
}

function lostCoreEvent() {
  return {
    schema: 'surface_event/v0.2', event: 'state_changed',
    data: { surface: { ...liveSurface(), state: 'lost' } },
  };
}

function fakeAuthorityPort() {
  let callback = null;
  return {
    port: {
      subscribeFrames(next) {
        callback = next;
        return () => { callback = null; };
      },
    },
    emit(notice) {
      assert.ok(typeof callback === 'function', 'runtime subscribed');
      callback(notice);
    },
  };
}

// ---------------------------------------------------------------------------
// Frame-port doubles (2x2 frames, single deliveries).
// ---------------------------------------------------------------------------

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

function portNotice(port, surfaceId = SID, generation = NOTICE_GEN) {
  return {
    data: {
      type: FRAME_PORT_NOTICE_TYPE, schema: FRAME_PORT_NOTICE_SCHEMA,
      surface_id: surfaceId, surface_generation: generation,
    },
    origin: ORIGIN, ports: [port],
  };
}

async function frameDelivery(overrides = {}) {
  const bytes = overrides.bytes ?? new Uint8Array(BYTES_2X2);
  const sha256 = overrides.sha256 ?? await hexDigest(bytes);
  return {
    schema: FRAME_DELIVERY_SCHEMA, kind: 'frame', correlation: 'c1', principal: 'utility',
    epoch: DELIVERY_EPOCH, surfaceId: SID, surfaceGeneration: DELIVERY_GEN,
    frameGeneration: NOTICE_GEN, leaseId: 'l1',
    width: 2, height: 2, format: 'rgb24', byteLength: bytes.byteLength, sha256,
    pixelSpec: { format: 'rgb24' }, bytes, ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Real-SFC compile: SurfaceCanvas plus App wired to the real tile.
// ---------------------------------------------------------------------------

const tileSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const vueUrl = JSON.stringify(import.meta.resolve('vue'));
const schedulerUrl = JSON.stringify(import.meta.resolve('../src/surfaces/tileScheduler.js'));

function rewriteTileImports(code) {
  let out = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  return out.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2;?/g, (all, bindings, _q, spec) => {
    if (spec === 'vue') return all.replace(/(['"])vue\1/, vueUrl);
    assert.equal(spec, './tileScheduler.js', `Unmapped tile dependency: ${spec}`);
    return `const ${bindings.trim()} = await import(${schedulerUrl});`;
  });
}

const SurfaceCanvas = await (async () => {
  const compiled = compileScript(parse(tileSource).descriptor, { id: 'mvui32l-tile', inlineTemplate: true });
  const code = rewriteTileImports(compiled.content);
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui32l-tile`)).default;
})();

const App = await (async () => {
  const stub = defineComponent({
    setup: (_, ctx) => () => h('div', {}, Object.values(ctx.slots).flatMap((slot) => slot?.() ?? [])),
  });
  globalThis.__mvui32Ldeps = {
    './core/HostOutcome.vue': stub,
    './activity/ActivityStrip.vue': stub,
    'capsule-ui-kit/DockWorkspace': stub,
    '../.kit/capsule-ui-kit/src/index-shell.js': { ShellWorkspace: stub, TopBar: stub, Sidebar: stub, StatusBar: stub },
    'capsule-ui-kit/ui': { UiButton: stub },
    'capsule-ui-kit/theme': { setKitScheme() {} },
    './wall/WallWorkspace.vue': stub,
    './wall/EmptyWallView.vue': stub,
    './catalog/CatalogLauncher.vue': stub,
    './terminal/SideTerminalOverlay.vue': stub,
    './multislot/MultislotHost.vue': stub,
    './recording/MvRecordingPanel.vue': stub,
    './settings/MvSettingsPanel.vue': stub,
    './agent/AgentLaneHost.vue': stub,
    './creative/CreativeCapsule.vue': stub,
    './surfaces/SurfaceCanvas.vue': SurfaceCanvas,
    './nested/nested.js': { resolveNestedMode, applyNestedWall },
    './surfaces/tileScheduler.js': { createTileScheduler },
  };
  try {
    const compiled = compileScript(parse(appSource).descriptor, { id: 'mvui32l-app', inlineTemplate: true });
    const require = createRequire(import.meta.url);
    const code = compiled.content.replace(/^[ \t]*import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,
      (all, binding, _q, specifier) => {
        if (specifier === 'vue') {
          return all.replace(/(['"])vue\1/, JSON.stringify(pathToFileURL(require.resolve('vue')).href));
        }
        assert.ok(specifier in globalThis.__mvui32Ldeps, `Unmapped App dependency: ${specifier}`);
        return `const ${binding.trim()} = globalThis.__mvui32Ldeps[${JSON.stringify(specifier)}];`;
      });
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#mvui32l-app`)).default;
  } finally {
    delete globalThis.__mvui32Ldeps;
  }
})();

// ---------------------------------------------------------------------------
// Stub renderer with a canvas double per tile.
// ---------------------------------------------------------------------------

function tileCanvasDouble() {
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
    focus() {},
    blur() {},
  };
  let w = 0;
  let h = 0;
  Object.defineProperties(canvas, {
    width: { get: () => w, set: (v) => { w = v; canvas.paints.length = 0; }, enumerable: true, configurable: true },
    height: { get: () => h, set: (v) => { h = v; canvas.paints.length = 0; }, enumerable: true, configurable: true },
  });
  return canvas;
}

function appRenderer(canvases) {
  return createRenderer({
    createElement(tag) {
      if (tag === 'canvas') {
        const canvas = tileCanvasDouble();
        canvases.push(canvas);
        return canvas;
      }
      return { tag, props: {}, children: [], text: null, parent: null };
    },
    createText: (text) => ({ text, parent: null }),
    createComment: (text) => ({ text, parent: null }),
    setText(node, text) { node.text = text; },
    setElementText(el, text) { el.children = []; el.text = text; },
    insert(child, parent, anchor = null) {
      if (!parent || !Array.isArray(parent.children)) return;
      if (child.parent) {
        const items = child.parent.children;
        items.splice(items.indexOf(child), 1);
      }
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
    parentNode: (node) => node.parent ?? null,
    nextSibling: (node) => {
      const parent = node.parent;
      if (!parent || !Array.isArray(parent.children)) return null;
      return parent.children[parent.children.indexOf(node) + 1] ?? null;
    },
    patchProp(el, key, _prev, next) {
      if (!el.props || typeof el.props !== 'object') el.props = {};
      el.props[key] = next;
    },
    querySelector: () => null,
    setScopeId() {},
  });
}

const mountNodes = (node) => [node, ...(node.children ?? []).flatMap(mountNodes)];
const mountText = (node) => [node.text ?? '', ...(node.children ?? []).map(mountText)].join(' ');
const tileSectionOf = (root) => mountNodes(root).find((node) => node.tag === 'section' && node.props?.class === 'mv-surface');
const badgeOf = (root, anchor) => mountNodes(root).find((node) => node.props?.id === anchor);
const stripOf = (root) => mountNodes(root).find((node) => node.props?.class === 'mv-surface__strip');
const canvasOf = (root) => mountNodes(root).find((node) => node.tag === 'canvas');

function stubGlobals() {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
  return () => {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  };
}

/**
 * Mounts the real App in nested display-only over the real runtime.
 * @param {{ projectionView: unknown }} liveRuntime
 * @param {unknown} scheduler
 * @param {unknown} router
 */
function mountE2E(liveRuntime, scheduler, router) {
  const canvases = [];
  const root = { children: [] };
  const handle = appRenderer(canvases).createApp(App, {
    layout: {}, scope: {}, storage: STORAGE, fixture: null, nestedHost: NESTED_HOST,
    runtime: { ...liveRuntime, tileScheduler: scheduler },
  });
  if (router) handle.provide('framePortRouter', router);
  handle.mount(root);
  return { handle, root, canvases };
}

const runtimeRow = (liveRuntime) => {
  const rows = liveRuntime.projectionView.getProjection()?.rows ?? [];
  return rows.find((entry) => entry.id === SID) ?? null;
};

describe('mvui32-l lost surface end to end', () => {
  test('lost state_changed after a presented live frame freezes the tile with the Capsule lost badge', async () => {
    const restore = stubGlobals();
    const authority = fakeAuthorityPort();
    const liveRuntime = createAuthorityRuntime(authority.port);
    assert.ok(liveRuntime, 'real authority runtime mounts on the fake port');
    const scheduler = createTileScheduler({ budget: BUDGET });
    const target = fakeWindow();
    const router = installFramePortRouter({ target, digestSha256: realDigest });
    const port = framePort();
    let mounted = null;
    try {
      assert.equal(surfaceLostBadgeAnchor(SID), 'tile-cap-01-lost-badge');
      assert.equal(surfaceLostBadgeAccessibleName(), 'Capsule lost: showing the last frame');
      mounted = mountE2E(liveRuntime, scheduler, router);
      await nextTick();
      await tick();
      assert.equal(tileSectionOf(mounted.root), undefined, 'no tile before the live surface');

      target.emit(portNotice(port));
      port.deliver(await frameDelivery({ correlation: 'e2e-1', leaseId: 'e2e-l1' }));
      const ref = liveFrameRef();
      authority.emit({ frame_ref: ref, surface: liveSurface() });
      await until(() => tileSectionOf(mounted.root) !== undefined, 'live tile mounts', 5000);
      await until(() => canvasOf(mounted.root)?.paints.length === 1, 'first paint after mount', 5000);
      await untilAcks(port, 1);
      await nextTick();
      await tick();

      const liveSection = tileSectionOf(mounted.root);
      assert.equal(liveSection.props['data-state'], 'live');
      assert.equal(canvasOf(mounted.root).props.hidden, false, 'live canvas visible');
      assert.ok(stripOf(mounted.root), 'live tile shows the witness strip');
      assert.match(mountText(liveSection), /live/);
      assert.equal(badgeOf(mounted.root, 'tile-cap-01-lost-badge'), undefined, 'no badge while live');
      assert.equal(runtimeRow(liveRuntime)?.backendLifecycle, 'active');
      const frozenPaint = [...canvasOf(mounted.root).paints[0].data];

      const event = lostCoreEvent();
      const lostNotice = translateSurfaceEvent(event, ref);
      authority.emit(lostNotice);
      await until(() => badgeOf(mounted.root, 'tile-cap-01-lost-badge') !== undefined, 'Lost badge renders', 5000);
      await nextTick();
      await tick();

      const snapshot = liveRuntime.projectionView.getSnapshot();
      assert.equal(snapshot.status, 'live', 'lost admission stays clean, never stale');
      assert.equal(snapshot.error, null);
      assert.equal(runtimeRow(liveRuntime)?.backendLifecycle, 'lost', 'lost row stays admitted');
      const section = tileSectionOf(mounted.root);
      assert.ok(section, 'lost tile stays mounted');
      assert.equal(section.props['data-state'], 'lost');
      const canvas = canvasOf(mounted.root);
      assert.equal(canvas.props.hidden, false, 'frozen canvas stays visible');
      const badge = badgeOf(mounted.root, 'tile-cap-01-lost-badge');
      assert.ok(badge, 'Lost badge renders');
      assert.equal(badge.props['data-semantic-anchor'], 'tile-cap-01-lost-badge');
      assert.equal(badge.props['aria-label'], 'Capsule lost: showing the last frame');
      assert.equal(badge.props.role, 'status');
      assert.match(mountText(section), /Lost/);
      assert.match(mountText(section), /Showing the last frame\./);
      assert.doesNotMatch(mountText(section), /live/i, 'status no longer reads live');
      assert.equal(stripOf(mounted.root), undefined, 'no witness strip on the frozen tile');
      assert.equal(canvas.paints.length, 1, 'no new paint after loss');
      assert.deepEqual(canvas.paints[0].data, frozenPaint, 'frozen bitmap stays intact');
      assert.equal(scheduler.getInstrumentation(SID).canvasAttached, false, 'lost releases the binding');
    } finally {
      try { mounted?.handle.unmount(); } catch {}
      try { router.dispose(); } catch {}
      try { scheduler.destroy(); } catch {}
      try { liveRuntime.dispose(); } catch {}
      restore();
    }
  });

  test('negative control: a live surface without the event keeps live', async () => {
    const restore = stubGlobals();
    const authority = fakeAuthorityPort();
    const liveRuntime = createAuthorityRuntime(authority.port);
    const scheduler = createTileScheduler({ budget: BUDGET });
    const target = fakeWindow();
    const router = installFramePortRouter({ target, digestSha256: realDigest });
    const port = framePort();
    let mounted = null;
    try {
      mounted = mountE2E(liveRuntime, scheduler, router);
      await nextTick();
      await tick();
      target.emit(portNotice(port));
      port.deliver(await frameDelivery({ correlation: 'e2e-live', leaseId: 'e2e-live-l1' }));
      authority.emit({ frame_ref: liveFrameRef(), surface: liveSurface() });
      await until(() => canvasOf(mounted.root)?.paints.length === 1, 'live paint', 5000);
      await untilAcks(port, 1);
      await nextTick();
      await tick();
      await tick();

      assert.equal(runtimeRow(liveRuntime)?.backendLifecycle, 'active');
      const section = tileSectionOf(mounted.root);
      assert.ok(section);
      assert.equal(section.props['data-state'], 'live');
      assert.ok(stripOf(mounted.root), 'witness strip stays');
      assert.match(mountText(section), /live/);
      assert.equal(badgeOf(mounted.root, 'tile-cap-01-lost-badge'), undefined, 'no Lost badge without the event');
      assert.doesNotMatch(mountText(mounted.root), /Showing the last frame/);
    } finally {
      try { mounted?.handle.unmount(); } catch {}
      try { router.dispose(); } catch {}
      try { scheduler.destroy(); } catch {}
      try { liveRuntime.dispose(); } catch {}
      restore();
    }
  });

  test('negative control: a destroyed surface never shows the frozen view', async () => {
    const restore = stubGlobals();
    const authority = fakeAuthorityPort();
    const liveRuntime = createAuthorityRuntime(authority.port);
    const scheduler = createTileScheduler({ budget: BUDGET });
    const target = fakeWindow();
    const router = installFramePortRouter({ target, digestSha256: realDigest });
    const port = framePort();
    let mounted = null;
    try {
      mounted = mountE2E(liveRuntime, scheduler, router);
      await nextTick();
      await tick();
      target.emit(portNotice(port));
      port.deliver(await frameDelivery({ correlation: 'e2e-dead', leaseId: 'e2e-dead-l1' }));
      const ref = liveFrameRef();
      authority.emit({ frame_ref: ref, surface: liveSurface() });
      await until(() => canvasOf(mounted.root)?.paints.length === 1, 'live paint', 5000);
      await untilAcks(port, 1);
      await nextTick();
      await tick();
      assert.equal(tileSectionOf(mounted.root)?.props['data-state'], 'live');

      authority.emit({ frame_ref: ref, surface: { ...liveSurface(), state: 'destroyed' } });
      await until(() => tileSectionOf(mounted.root) === undefined, 'destroyed tile leaves the wall', 5000);
      await nextTick();
      await tick();

      assert.equal(runtimeRow(liveRuntime)?.backendLifecycle, 'destroyed', 'destroyed row stays admitted');
      assert.equal(tileSectionOf(mounted.root), undefined, 'no tile for a destroyed surface');
      assert.equal(badgeOf(mounted.root, 'tile-cap-01-lost-badge'), undefined, 'no Lost badge for destroyed');
      assert.doesNotMatch(mountText(mounted.root), /Showing the last frame/, 'never the frozen view');
      assert.doesNotMatch(mountText(mounted.root), /Capsule lost/);
    } finally {
      try { mounted?.handle.unmount(); } catch {}
      try { router.dispose(); } catch {}
      try { scheduler.destroy(); } catch {}
      try { liveRuntime.dispose(); } catch {}
      restore();
    }
  });
});
