/**
 * FPS-INDICATOR (U-DEC-0153 / FEEDBACK row 15): delivered painted FPS over a
 * 2 s sliding window [TARGET, unit decision] and latest frame_ref.capture_us
 * in ms in the tile footer strip (`ui/src/surfaces/SurfaceCanvas.vue` and
 * `ui/src/surfaces/fpsMeter.js`).
 *
 * Covers:
 * 1. Pure helper (`fpsMeter.js`) with injected clock:
 *    - steady 3 fps reads 3
 *    - steady 30 fps reads 30
 *    - a 3 s stall reads `—`
 *    - `capture_us` 300000 reads `300 ms`
 *    - text update throttling at most 2 times per second (500 ms interval)
 * 2. Real `SurfaceCanvas.vue` SFC (compiled with `@vue/compiler-sfc`, inline
 *    template, closed dependency map):
 *    - footer strip renders `FPS: <n>` and `CAP: <n> ms` (or `—`) with stable
 *      `data-fps` and `data-capture-ms` attributes next to `GEN` and `SHA256`
 *    - counts PAINTED frames (where the canvas is actually drawn), never
 *      received, refused, or superseded/dropped frames
 *    - strict-CSP clean
 * 3. Must-fail mutants (negative controls):
 *    - Mutant 1: counting received frames instead of painted frames
 *    - Mutant 2: window not sliding (retaining old frame timestamps across a
 *      3 s stall)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';
import {
  FPS_PLACEHOLDER,
  FPS_UPDATE_INTERVAL_MS,
  FPS_WINDOW_MS,
  createFpsMeter,
  extractCaptureUs,
  formatCaptureUs,
  normalizeCaptureMs,
} from '../src/surfaces/fpsMeter.js';
import {
  RELEASE_CAUSES,
  createTileScheduler,
} from '../src/surfaces/tileScheduler.js';
import { tick } from './frame-wait.mjs';

const SFC_PATH = fileURLToPath(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url));
const tileSource = readFileSync(SFC_PATH, 'utf8');

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
  const compiled = compileScript(parse(source).descriptor, { id: 'fpsind-tile', inlineTemplate: true });
  const code = rewriteImports(compiled.content, {
    './tileScheduler.js': schedulerUrl,
  });
  const tag = `fpsind-tile-${sfcSerial++}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${tag}`)).default;
}

const SurfaceCanvas = await compileTile(tileSource);

function makeClock(startMs = 10_000) {
  let now = startMs;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    set(ms) { now = ms; },
  };
}

function makeDrawableCanvas() {
  const paints = [];
  const ctx = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => { paints.push({ width: img.width, height: img.height }); },
  };
  return {
    tag: 'canvas',
    width: 0,
    height: 0,
    paints,
    props: {},
    children: [],
    text: null,
    parent: null,
    focus() {},
    blur() {},
    getContext: (kind) => (kind === '2d' ? ctx : null),
  };
}

function stubOps(canvasStub) {
  return {
    createElement(tag) {
      if (tag === 'canvas' && canvasStub) return canvasStub;
      const node = { tag, props: {}, children: [], text: null, parent: null };
      if (tag === 'canvas') {
        node.focus = () => {};
        node.blur = () => {};
      }
      return node;
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
const stripOf = (root) => mountNodes(root).find((node) => node.props?.class === 'mv-surface__strip');
const fpsNodeOf = (root) => mountNodes(root).find((node) => node.props && 'data-fps' in node.props);
const capNodeOf = (root) => mountNodes(root).find((node) => node.props && 'data-capture-ms' in node.props);

function mountTile(Component, provides, canvasStub, initialProps = {}) {
  const { createApp } = createRenderer(stubOps(canvasStub));
  const propsRef = ref({
    surfaceId: 'A',
    generation: 1,
    epoch: 7,
    frame: 'tile/A/g1/h1',
    digest: 'a'.repeat(64),
    state: 'live',
    frameWidth: 2,
    frameHeight: 2,
    inputEnabled: false,
    streamId: 0,
    ...initialProps,
  });
  const Holder = { setup: () => () => h(Component, { ...propsRef.value }) };
  const app = createApp(Holder);
  for (const [key, value] of Object.entries(provides)) app.provide(key, value);
  const root = { children: [] };
  app.mount(root);
  return {
    app,
    root,
    async setProps(patch) {
      propsRef.value = { ...propsRef.value, ...patch };
      await nextTick();
      await nextTick();
      await tick();
    },
  };
}

function makeBudget(overrides = {}) {
  return Object.freeze({
    maxDrawsPerTick: 4,
    maxUploadBytesPerTick: 8 * 1024 * 1024,
    maxPresentMsPerTick: 16,
    maxWarmResourcesPerSurface: 2,
    maxDrainSteps: 4,
    ...overrides,
  });
}

function eligibleState(overrides = {}) {
  return {
    panelOpen: true,
    panelSelected: true,
    folded: false,
    width: 320,
    height: 200,
    x: 0,
    y: 0,
    viewportIntersecting: true,
    windowPresentationAllowed: true,
    contextLost: false,
    ...overrides,
  };
}

function makeFrame(frameGeneration, extra = {}) {
  const bytes = new Uint8Array(2 * 2 * 3);
  bytes.fill(frameGeneration & 0xff);
  return {
    surfaceId: 'A',
    surfaceGeneration: 1,
    frameGeneration,
    leaseId: `lease-${frameGeneration}`,
    byteLength: bytes.byteLength,
    width: 2,
    height: 2,
    bytes,
    principal: 'wall-main',
    epoch: 7,
    sha256: String(frameGeneration % 10).repeat(64),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. Pure helper unit tests (`ui/src/surfaces/fpsMeter.js`)
// ---------------------------------------------------------------------------

describe('fpsMeter pure helper (injected clock)', () => {
  test('constants and capture_us conversion: 300000 reads 300 ms, invalid reads —', () => {
    assert.equal(FPS_WINDOW_MS, 2000);
    assert.equal(FPS_UPDATE_INTERVAL_MS, 500);
    assert.equal(FPS_PLACEHOLDER, '—');

    assert.equal(normalizeCaptureMs(300000), 300);
    assert.equal(formatCaptureUs(300000), '300 ms');
    assert.equal(formatCaptureUs(0), '0 ms');
    assert.equal(formatCaptureUs(1500), '2 ms');
    assert.equal(formatCaptureUs(null), '—');
    assert.equal(formatCaptureUs(undefined), '—');
    assert.equal(formatCaptureUs(-1), '—');
    assert.equal(formatCaptureUs(1.5), '—');
    assert.equal(extractCaptureUs({ capture_us: 300000 }), 300000);
    assert.equal(extractCaptureUs({ frame_ref: { capture_us: 300000 } }), 300000);
    assert.equal(extractCaptureUs(null), null);
  });

  test('empty meter before any frame arrived in the window reads —', () => {
    const clock = makeClock(1000);
    const meter = createFpsMeter({ clock: clock.now });
    const snap = meter.read();
    assert.equal(snap.fps, null);
    assert.equal(snap.fpsText, '—');
    assert.equal(snap.fpsAttr, '—');
    assert.equal(snap.captureMs, null);
    assert.equal(snap.captureText, '—');
    assert.equal(snap.captureAttr, '—');
  });

  test('steady 3 fps over the 2 s sliding window reads 3', () => {
    const clock = makeClock(10_000);
    const meter = createFpsMeter({ clock: clock.now });
    // 3 fps = 1 frame every 333.33 ms -> 6 frames across 2000 ms.
    // Feed 3 seconds (9 frames) so the 2 s window slides and holds 6 frames.
    const stepMs = 2000 / 6;
    for (let i = 0; i < 9; i += 1) {
      clock.advance(stepMs);
      meter.recordPaint({ capture_us: 300000 });
    }
    const snap = meter.read();
    assert.equal(snap.windowCount, 6);
    assert.equal(snap.fps, 3);
    assert.equal(snap.fpsText, '3');
    assert.equal(snap.fpsAttr, '3');
    assert.equal(snap.captureMs, 300);
    assert.equal(snap.captureText, '300 ms');
    assert.equal(snap.captureAttr, '300');
  });

  test('steady 30 fps over the 2 s sliding window reads 30', () => {
    const clock = makeClock(20_000);
    const meter = createFpsMeter({ clock: clock.now });
    // 30 fps = 60 frames per 2000 ms. Feed 3 seconds (90 frames) so the
    // sliding window evicts the first 30 and retains exactly 60.
    const stepMs = 2000 / 60;
    for (let i = 0; i < 90; i += 1) {
      clock.advance(stepMs);
      meter.recordPaint({ capture_us: 12000 });
    }
    const snap = meter.read();
    assert.equal(snap.windowCount, 60);
    assert.equal(snap.fps, 30);
    assert.equal(snap.fpsText, '30');
    assert.equal(snap.fpsAttr, '30');
    assert.equal(snap.captureMs, 12);
    assert.equal(snap.captureText, '12 ms');
  });

  test('a 3 s stall after painting reads —', () => {
    const clock = makeClock(50_000);
    const meter = createFpsMeter({ clock: clock.now });
    for (let i = 0; i < 6; i += 1) {
      clock.advance(300);
      meter.recordPaint({ capture_us: 300000 });
    }
    assert.equal(meter.read().fpsText, '3');
    assert.equal(meter.read().captureText, '300 ms');

    // Stall for 3 seconds (3000 ms > 2000 ms window): no frames in window.
    clock.advance(3000);
    const stalled = meter.read();
    assert.equal(stalled.windowCount, 0);
    assert.equal(stalled.fps, null);
    assert.equal(stalled.fpsText, '—');
    assert.equal(stalled.fpsAttr, '—');
    assert.equal(stalled.captureText, '—');
    assert.equal(stalled.captureAttr, '—');
  });

  test('throttled readout updates at most 2 times per second (500 ms interval)', () => {
    const clock = makeClock(100_000);
    const meter = createFpsMeter({ clock: clock.now });
    // First paint at t = 100_000 updates immediately from placeholder.
    const first = meter.recordPaint({ capture_us: 100000 });
    assert.equal(first.fpsText, '1');
    assert.equal(first.captureText, '100 ms');

    // 10 more paints within the next 400 ms (before the 500 ms throttle boundary):
    // readThrottled() and recordPaint() return the cached snapshot without recomputing text.
    const distinctSnapshots = new Set([first]);
    for (let i = 1; i <= 10; i += 1) {
      clock.advance(40); // up to +400 ms
      distinctSnapshots.add(meter.recordPaint({ capture_us: 200000 }));
      distinctSnapshots.add(meter.readThrottled());
    }
    assert.equal(distinctSnapshots.size, 1, 'no text refresh inside the 500 ms throttle window');
    assert.equal(meter.readThrottled().fpsText, '1');

    // At +500 ms from the first update, the throttled snapshot refreshes.
    clock.advance(100); // now at +500 ms
    const refreshed = meter.readThrottled();
    assert.notEqual(refreshed, first);
    assert.equal(refreshed.fpsText, '6'); // 11 painted frames in 2 s window => round(5.5) = 6
    assert.equal(refreshed.captureText, '200 ms');
  });

  test('received frames that are dropped before paint do not advance painted FPS', () => {
    const clock = makeClock(200_000);
    const meter = createFpsMeter({ clock: clock.now });
    // 60 frames received over 2 s (30 fps arrival), but only 6 are painted (3 fps).
    for (let i = 1; i <= 60; i += 1) {
      clock.advance(2000 / 60);
      meter.recordReceived({ capture_us: 300000 });
      if (i % 10 === 0) {
        meter.recordPaint();
      }
    }
    const snap = meter.read();
    assert.equal(snap.paintedCount, 6);
    assert.equal(snap.windowCount, 6);
    assert.equal(snap.fps, 3, 'reflects 3 painted fps, not 30 received fps');
    assert.equal(snap.captureText, '300 ms');
  });
});

// ---------------------------------------------------------------------------
// 2. Real SurfaceCanvas.vue footer & paint-hook integration tests
// ---------------------------------------------------------------------------

describe('SurfaceCanvas.vue footer FPS and CAP indicator', () => {
  test('renders FPS: — and CAP: — with data-fps and data-capture-ms when no frame painted in window', () => {
    const clock = makeClock(10_000);
    const canvas = makeDrawableCanvas();
    const mounted = mountTile(SurfaceCanvas, {}, canvas, { fpsClock: clock.now });
    try {
      const strip = stripOf(mounted.root);
      assert.ok(strip, 'witness strip renders on live tile');
      const text = mountText(strip);
      assert.ok(text.includes('FRAME:'), 'FRAME key present');
      assert.ok(text.includes('GEN:'), 'GEN key present');
      assert.ok(text.includes('SHA256:'), 'SHA256 key present');
      assert.ok(text.includes('FPS: —'), `expected FPS: — in strip: ${text}`);
      assert.ok(text.includes('CAP: —'), `expected CAP: — in strip: ${text}`);

      const fpsNode = fpsNodeOf(mounted.root);
      const capNode = capNodeOf(mounted.root);
      assert.ok(fpsNode, 'data-fps span exists');
      assert.ok(capNode, 'data-capture-ms span exists');
      assert.equal(fpsNode.props['data-fps'], '—');
      assert.equal(capNode.props['data-capture-ms'], '—');
    } finally {
      mounted.app.unmount();
    }
  });

  test('counts PAINTED frames (3 fps -> 3, 30 fps -> 30, 3 s stall -> —) and formats capture_us 300000 as 300 ms', async () => {
    const clock = makeClock(10_000);
    const scheduler = createTileScheduler({
      budget: makeBudget({ maxDrawsPerTick: 64 }),
      clock: clock.now,
    });
    scheduler.registerSurface({
      surfaceId: 'A',
      surfaceGeneration: 1,
      epoch: 7,
      principal: 'wall-main',
      state: eligibleState(),
    });
    const canvas = makeDrawableCanvas();
    const listeners = new Set();
    const framesPort = {
      subscribeFrames(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      emit(notice) {
        for (const cb of [...listeners]) cb(notice);
      },
    };

    const mounted = mountTile(
      SurfaceCanvas,
      { tileScheduler: scheduler, framesPort },
      canvas,
      { surfaceId: 'A', generation: 1, epoch: 7, state: 'live', frame: 'tile/A/g1/h0', fpsClock: clock.now },
    );

    try {
      let frameGen = 0;
      // 1) Steady 3 fps over 3 s (9 painted frames, 6 in the last 2 s window) with capture_us = 300000
      for (let i = 0; i < 9; i += 1) {
        clock.advance(2000 / 6);
        frameGen += 1;
        framesPort.emit({
          frame_ref: { surface_id: 'A', generation: frameGen, capture_us: 300000 },
          surface: { surface_id: 'A' },
        });
        assert.equal(scheduler.submitFrame(makeFrame(frameGen)).ok, true);
        assert.equal(scheduler.runTick().drawsUsed, 1);
      }
      await nextTick();
      assert.equal(canvas.paints.length, 9);
      assert.equal(fpsNodeOf(mounted.root).props['data-fps'], '3');
      assert.match(mountText(fpsNodeOf(mounted.root)), /FPS:\s*3/);
      assert.equal(capNodeOf(mounted.root).props['data-capture-ms'], '300');
      assert.match(mountText(capNodeOf(mounted.root)), /CAP:\s*300 ms/);

      // 2) Steady 30 fps over 3 s (90 painted frames, 60 in the last 2 s window)
      for (let i = 0; i < 90; i += 1) {
        clock.advance(2000 / 60);
        frameGen += 1;
        assert.equal(scheduler.submitFrame(makeFrame(frameGen)).ok, true);
        assert.equal(scheduler.runTick().drawsUsed, 1);
      }
      await nextTick();
      assert.equal(fpsNodeOf(mounted.root).props['data-fps'], '30');
      assert.match(mountText(fpsNodeOf(mounted.root)), /FPS:\s*30/);

      // 3) Dropped / superseded frames before paint do NOT inflate painted FPS:
      // Advance 2000 ms so the 30 fps burst leaves the window, then submit 60 frames
      // over 2 s (30 fps arrival) while running the scheduler tick only 6 times (3 fps painted).
      clock.advance(2001);
      const releases = [];
      for (let i = 1; i <= 60; i += 1) {
        clock.advance(2000 / 60);
        frameGen += 1;
        framesPort.emit({
          frame_ref: { surface_id: 'A', generation: frameGen, capture_us: 300000 },
          surface: { surface_id: 'A' },
        });
        assert.equal(scheduler.submitFrame(makeFrame(frameGen)).ok, true);
        if (i % 10 === 0) {
          const tickRes = scheduler.runTick();
          assert.equal(tickRes.drawsUsed, 1);
          releases.push(...tickRes.presented);
        }
      }
      await nextTick();
      assert.equal(releases.length, 6, 'only 6 frames were actually painted');
      assert.equal(fpsNodeOf(mounted.root).props['data-fps'], '3', 'dropped frames before paint are not counted');
      assert.match(mountText(fpsNodeOf(mounted.root)), /FPS:\s*3/);

      // 4) A 3 s stall resets FPS and CAP to —
      clock.advance(3000);
      // Trigger a presentation notification (e.g. from another surface or check) or capture update
      // after the 3 s stall: no frame painted for A in the last 2 s.
      scheduler.registerSurface({
        surfaceId: 'B',
        surfaceGeneration: 1,
        epoch: 7,
        principal: 'wall-main',
        state: eligibleState(),
      });
      scheduler.destroySurface('B'); // fires notifyPresentation() without painting A
      await nextTick();
      assert.equal(fpsNodeOf(mounted.root).props['data-fps'], '—');
      assert.match(mountText(fpsNodeOf(mounted.root)), /FPS:\s*—/);
      assert.equal(capNodeOf(mounted.root).props['data-capture-ms'], '—');
      assert.match(mountText(capNodeOf(mounted.root)), /CAP:\s*—/);
    } finally {
      mounted.app.unmount();
      scheduler.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Must-fail mutants (negative controls)
// ---------------------------------------------------------------------------

describe('FPS-INDICATOR must-fail mutants', () => {
  test('mutant 1: counting received frames instead of painted frames MUST FAIL', () => {
    // Oracle: when 60 frames arrive over 2 s (30 fps received) but 54 are dropped
    // before paint so only 6 are painted (3 fps), the meter must read 3 fps.
    function runDroppedFrameOracle(meterFactory) {
      const clock = makeClock(10_000);
      const meter = meterFactory({ clock: clock.now });
      for (let i = 1; i <= 60; i += 1) {
        clock.advance(2000 / 60);
        meter.recordReceived({ capture_us: 300000 });
        if (i % 10 === 0) {
          meter.recordPaint({ capture_us: 300000 });
        }
      }
      assert.equal(meter.read().fps, 3, 'oracle requires painted FPS (3), not received FPS (30)');
    }

    // Production meter passes the oracle.
    runDroppedFrameOracle(createFpsMeter);

    // Mutant meter: counts recordReceived as a frame timestamp.
    function createReceivedCountingMutant({ clock }) {
      const inner = createFpsMeter({ clock });
      return {
        recordReceived(meta) { inner.recordPaint(meta); },
        recordPaint() {},
        read: () => inner.read(),
      };
    }

    assert.throws(
      () => runDroppedFrameOracle(createReceivedCountingMutant),
      assert.AssertionError,
      'mutant counting received instead of painted must fail the oracle',
    );
  });

  test('mutant 1 (SFC): SurfaceCanvas counting authority frame arrivals instead of canvas paints MUST FAIL', async () => {
    const mutantSource = tileSource.replace(
      'onCaptureUsUpdated(rec.frame_ref?.capture_us);',
      'onFramePainted(rec.frame_ref?.capture_us); // mutant: count received frame_ref',
    );
    assert.notEqual(mutantSource, tileSource, 'mutant must alter SFC source');
    const MutantCanvas = await compileTile(mutantSource);

    async function assertOnlyPaintedCounted(Component) {
      const clock = makeClock(10_000);
      const scheduler = createTileScheduler({
        budget: makeBudget({ maxDrawsPerTick: 64 }),
        clock: clock.now,
      });
      scheduler.registerSurface({
        surfaceId: 'A',
        surfaceGeneration: 1,
        epoch: 7,
        principal: 'wall-main',
        state: eligibleState(),
      });
      const canvas = makeDrawableCanvas();
      const listeners = new Set();
      const framesPort = {
        subscribeFrames(cb) { listeners.add(cb); return () => listeners.delete(cb); },
        emit(notice) { for (const cb of [...listeners]) cb(notice); },
      };
      const mounted = mountTile(
        Component,
        { tileScheduler: scheduler, framesPort },
        canvas,
        { surfaceId: 'A', generation: 1, epoch: 7, state: 'live', frame: 'tile/A/g1/h0', fpsClock: clock.now },
      );
      try {
        // 60 frames received over 2 s, 0 ticks run -> 0 frames painted.
        for (let i = 1; i <= 60; i += 1) {
          clock.advance(2000 / 60);
          framesPort.emit({
            frame_ref: { surface_id: 'A', generation: i, capture_us: 300000 },
            surface: { surface_id: 'A' },
          });
          scheduler.submitFrame(makeFrame(i));
        }
        await nextTick();
        assert.equal(canvas.paints.length, 0);
        assert.equal(fpsNodeOf(mounted.root).props['data-fps'], '—', 'unpainted received frames must not show FPS');
      } finally {
        mounted.app.unmount();
        scheduler.destroy();
      }
    }

    await assertOnlyPaintedCounted(SurfaceCanvas);
    await assert.rejects(
      () => assertOnlyPaintedCounted(MutantCanvas),
      assert.AssertionError,
      'SFC mutant counting received frames must fail',
    );
  });

  test('mutant 2: window not sliding across a 3 s stall MUST FAIL', async () => {
    // Pure helper mutant check: if prune() does not slide the 2 s window,
    // a 3 s stall still retains prior frames instead of reading `—`.
    function runSlidingWindowOracle(meterFactory) {
      const clock = makeClock(10_000);
      const meter = meterFactory({ clock: clock.now });
      for (let i = 0; i < 6; i += 1) {
        clock.advance(2000 / 6);
        meter.recordPaint({ capture_us: 300000 });
      }
      assert.equal(meter.read().fpsText, '3');
      clock.advance(3000);
      assert.equal(meter.read().fpsText, '—', '3 s stall must read —');
    }

    runSlidingWindowOracle(createFpsMeter);

    // Mutant helper with non-sliding window (windowMs = Infinity).
    assert.throws(
      () => runSlidingWindowOracle(({ clock }) => createFpsMeter({ clock, windowMs: 1e12 })),
      assert.AssertionError,
      'non-sliding window mutant must fail the 3 s stall oracle',
    );

    // SFC mutant check: disable prunePaintedTimes in SurfaceCanvas.vue.
    const mutantSfcSource = tileSource.replace(
      'while (paintedTimes.length > 0 && /** @type {number} */ (paintedTimes[0]) <= cutoff) {\n    paintedTimes.shift();\n  }',
      '/* mutant: window does not slide */',
    );
    assert.notEqual(mutantSfcSource, tileSource, 'mutant must alter SFC source');
    const MutantCanvas = await compileTile(mutantSfcSource);

    async function assertStallReadsDash(Component) {
      const clock = makeClock(10_000);
      const scheduler = createTileScheduler({
        budget: makeBudget({ maxDrawsPerTick: 64 }),
        clock: clock.now,
      });
      scheduler.registerSurface({
        surfaceId: 'A',
        surfaceGeneration: 1,
        epoch: 7,
        principal: 'wall-main',
        state: eligibleState(),
      });
      const canvas = makeDrawableCanvas();
      const mounted = mountTile(
        Component,
        { tileScheduler: scheduler },
        canvas,
        { surfaceId: 'A', generation: 1, epoch: 7, state: 'live', frame: 'tile/A/g1/h0', fpsClock: clock.now },
      );
      try {
        for (let i = 1; i <= 9; i += 1) {
          clock.advance(2000 / 6);
          scheduler.submitFrame(makeFrame(i));
          scheduler.runTick();
        }
        await nextTick();
        assert.equal(fpsNodeOf(mounted.root).props['data-fps'], '3');
        clock.advance(3000);
        scheduler.registerSurface({
          surfaceId: 'B',
          surfaceGeneration: 1,
          epoch: 7,
          principal: 'wall-main',
          state: eligibleState(),
        });
        scheduler.destroySurface('B');
        await nextTick();
        assert.equal(fpsNodeOf(mounted.root).props['data-fps'], '—');
      } finally {
        mounted.app.unmount();
        scheduler.destroy();
      }
    }

    await assertStallReadsDash(SurfaceCanvas);
    await assert.rejects(
      () => assertStallReadsDash(MutantCanvas),
      assert.AssertionError,
      'SFC mutant with non-sliding window must fail the 3 s stall oracle',
    );
  });
});
