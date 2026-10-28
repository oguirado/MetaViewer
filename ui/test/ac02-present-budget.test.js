/**
 * AC-02 present budget at live size: 4 tiles at 1280x900 through the real
 * scheduler in memory (fake canvases, fake clock for every assertion). The
 * per-present millisecond figures are informational report output only and
 * are never asserted. Plain node:test; no Electron, no sockets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SCHEDULER_REASONS, createTileScheduler } from '../src/surfaces/tileScheduler.js';

const WIDTH = 1280;
const HEIGHT = 900;
const PIXELS = WIDTH * HEIGHT;
const RGB24_LEN = PIXELS * 3;
const TILE_IDS = ['tile-0', 'tile-1', 'tile-2', 'tile-3'];
const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
/** Simulated convert+upload milliseconds per draw, charged in putImageData. */
const DRAW_MS = 3;

function tileBytes(tileIndex) {
  const shade = [40 + tileIndex * 50, 90, 140];
  const bytes = new Uint8Array(RGB24_LEN);
  for (let px = 0; px < PIXELS; px += 1) {
    bytes[px * 3] = shade[0];
    bytes[px * 3 + 1] = shade[1];
    bytes[px * 3 + 2] = shade[2];
  }
  const corner = (x, y, rgb) => {
    const o = (y * WIDTH + x) * 3;
    bytes[o] = rgb[0];
    bytes[o + 1] = rgb[1];
    bytes[o + 2] = rgb[2];
  };
  corner(0, 0, [255, 0, 0]);
  corner(WIDTH - 1, 0, [0, 255, 0]);
  corner(0, HEIGHT - 1, [0, 0, 255]);
  corner(WIDTH - 1, HEIGHT - 1, [255, 255, 255]);
  return { bytes, shade };
}

function makeCanvas(clock, chargeDrawMs) {
  const puts = [];
  let allocs = 0;
  const canvas = {
    width: 0,
    height: 0,
    puts,
    allocCount: () => allocs,
    getContext: (kind) => (kind !== '2d' ? null : {
      createImageData: (w, h) => {
        allocs += 1;
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      putImageData: (image) => {
        puts.push(image);
        clock.now += chargeDrawMs;
      },
    }),
  };
  return canvas;
}

function setup({ chargeDrawMs = DRAW_MS } = {}) {
  const clock = { now: 1000 };
  const releases = [];
  const scheduler = createTileScheduler({
    budget: BUDGET,
    clock: () => clock.now,
    onPresent: (record) => scheduler.presentHandle(record),
    onReleaseLease: (release) => { releases.push(release); },
  });
  const canvases = new Map();
  for (const id of TILE_IDS) {
    const res = scheduler.registerSurface({
      surfaceId: id, surfaceGeneration: 1, epoch: 7, principal: 'wall-main',
      captureLeaseId: `capture-${id}`, captureLeaseActive: true,
      state: {
        panelOpen: true, panelSelected: true, folded: false, width: WIDTH, height: HEIGHT,
        x: 0, y: 0, viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
      },
    });
    assert.equal(res.ok, true);
    const canvas = makeCanvas(clock, chargeDrawMs);
    assert.equal(scheduler.attachCanvas({ surfaceId: id, canvas }).ok, true);
    canvases.set(id, canvas);
  }
  return { scheduler, canvases, clock, releases };
}

function submitLive(harness, tileIndex, frameGeneration) {
  const id = TILE_IDS[tileIndex];
  const { bytes } = tileBytes(tileIndex);
  return harness.scheduler.submitFrame({
    surfaceId: id, surfaceGeneration: 1, frameGeneration, leaseId: `${id}-g${frameGeneration}`,
    byteLength: bytes.length, width: WIDTH, height: HEIGHT, bytes,
    principal: 'wall-main', epoch: 7,
  });
}

function pixelOf(image, x, y) {
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}

function assertLiveCorners(harness, tileIndex) {
  const id = TILE_IDS[tileIndex];
  const canvas = harness.canvases.get(id);
  const image = canvas.puts[canvas.puts.length - 1];
  assert.equal(image.width, WIDTH);
  assert.equal(image.height, HEIGHT);
  assert.deepEqual(pixelOf(image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelOf(image, WIDTH - 1, 0), [0, 255, 0, 255]);
  assert.deepEqual(pixelOf(image, 0, HEIGHT - 1), [0, 0, 255, 255]);
  assert.deepEqual(pixelOf(image, WIDTH - 1, HEIGHT - 1), [255, 255, 255, 255]);
  const shade = [40 + tileIndex * 50, 90, 140, 255];
  assert.deepEqual(pixelOf(image, 640, 450), shade);
}

describe('ac02 present budget at 1280x900', () => {
  it('presents 4 live-size tiles inside the byte and draw budget', () => {
    const h = setup({ chargeDrawMs: 2 });
    try {
      for (let t = 0; t < 4; t += 1) assert.equal(submitLive(h, t, 1).ok, true);
      const tick = h.scheduler.runTick();
      assert.equal(tick.drawsUsed, 4);
      assert.equal(tick.presented.length, 4);
      assert.equal(tick.bytesUploaded, 4 * RGB24_LEN);
      assert.ok(tick.bytesUploaded <= BUDGET.maxUploadBytesPerTick);
      assert.equal(tick.budgetDeferrals, 0);
      assert.equal(tick.timeSpentMs, 8);
      for (let t = 0; t < 4; t += 1) {
        assertLiveCorners(h, t);
        assert.equal(h.canvases.get(TILE_IDS[t]).allocCount(), 1);
        assert.equal(h.scheduler.getInstrumentation(TILE_IDS[t]).measuredPresentMs, 2);
      }
    } finally {
      h.scheduler.destroy();
    }
  });

  it('enforces later ticks against the measured present cost', () => {
    const h = setup();
    try {
      for (let t = 0; t < 4; t += 1) assert.equal(submitLive(h, t, 1).ok, true);
      const first = h.scheduler.runTick();
      assert.equal(first.presented.length, 3);
      assert.equal(first.budgetDeferrals, 1);
      for (let t = 0; t < 3; t += 1) assert.equal(submitLive(h, t, 2).ok, true);
      const paced = h.scheduler.runTick();
      assert.deepEqual(paced.presented.map((r) => `${r.surfaceId}:g${r.frameGeneration}`).sort(),
        ['tile-0:g2', 'tile-3:g1']);
      assert.equal(paced.budgetDeferrals, 2);
      assert.ok(paced.timeSpentMs <= BUDGET.maxPresentMsPerTick);
      assert.equal(submitLive(h, 3, 2).ok, true);
      const paced2 = h.scheduler.runTick();
      assert.equal(paced2.presented.length, 2);
      assert.equal(paced2.budgetDeferrals, 1);
      const drained = h.scheduler.runTick();
      assert.equal(drained.presented.length, 1);
      assert.equal(drained.budgetDeferrals, 0);
      for (let t = 0; t < 4; t += 1) {
        assertLiveCorners(h, t);
        assert.equal(h.scheduler.getInstrumentation(TILE_IDS[t]).lastPresentedFrameGen, 2);
        assert.equal(h.canvases.get(TILE_IDS[t]).allocCount(), 1);
      }
    } finally {
      h.scheduler.destroy();
    }
  });

  it('keeps explicit caller estimates verbatim over the measured average', () => {
    const clock = { now: 1000 };
    const scheduler = createTileScheduler({
      budget: BUDGET,
      clock: () => clock.now,
      onPresent: (record) => scheduler.presentHandle(record),
      onReleaseLease: () => {},
    });
    try {
      assert.equal(scheduler.registerSurface({
        surfaceId: 'tile-0', surfaceGeneration: 1, epoch: 7, principal: 'wall-main',
        captureLeaseId: 'capture-tile-0', captureLeaseActive: true,
        state: {
          panelOpen: true, panelSelected: true, folded: false, width: 4, height: 3,
          x: 0, y: 0, viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
        },
      }).ok, true);
      assert.equal(scheduler.attachCanvas({
        surfaceId: 'tile-0',
        canvas: {
          width: 0,
          height: 0,
          getContext: () => ({
            createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
            putImageData: () => { clock.now += DRAW_MS; },
          }),
        },
      }).ok, true);
      const small = new Uint8Array(4 * 3 * 3).fill(7);
      assert.equal(scheduler.submitFrame({
        surfaceId: 'tile-0', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'tile-0-g1',
        byteLength: small.length, width: 4, height: 3, bytes: small, principal: 'wall-main', epoch: 7,
      }).ok, true);
      assert.equal(scheduler.runTick().drawsUsed, 1);
      assert.equal(scheduler.getInstrumentation('tile-0').measuredPresentMs, DRAW_MS);
      assert.equal(scheduler.submitFrame({
        surfaceId: 'tile-0', surfaceGeneration: 1, frameGeneration: 2, leaseId: 'tile-0-g2',
        byteLength: small.length, width: 4, height: 3, bytes: small, principal: 'wall-main', epoch: 7,
        estimatedPresentMs: 1000,
      }).ok, true);
      const refused = scheduler.runTick();
      assert.equal(refused.drawsUsed, 0);
      assert.equal(refused.budgetDeferrals, 1);
    } finally {
      scheduler.destroy();
    }
  });

  it('refuses truncated live-size buffers with INVALID_BINDING and never paints', () => {
    const h = setup();
    try {
      const { bytes } = tileBytes(0);
      const short = bytes.slice(0, bytes.length - 100);
      assert.equal(h.scheduler.submitFrame({
        surfaceId: 'tile-0', surfaceGeneration: 1, frameGeneration: 1, leaseId: 'tile-0-g1',
        byteLength: short.length, width: WIDTH, height: HEIGHT, bytes: short,
        principal: 'wall-main', epoch: 7,
      }).reason, SCHEDULER_REASONS.INVALID_BINDING);
      assert.equal(h.scheduler.runTick().drawsUsed, 0);
      assert.equal(h.canvases.get('tile-0').puts.length, 0);
    } finally {
      h.scheduler.destroy();
    }
  });

  it('reports per-present ms at 1280x900 before/after (informational, not asserted)', () => {
    const { bytes } = tileBytes(1);
    const ctx = {
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    };
    const before = [];
    for (let sample = 0; sample < 8; sample += 1) {
      const start = performance.now();
      const image = ctx.createImageData(WIDTH, HEIGHT);
      const out = image.data;
      for (let src = 0, dst = 0; src < bytes.length; src += 3, dst += 4) {
        out[dst] = bytes[src];
        out[dst + 1] = bytes[src + 1];
        out[dst + 2] = bytes[src + 2];
        out[dst + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      before.push(performance.now() - start);
    }
    const h = setup({ chargeDrawMs: 0 });
    try {
      const after = [];
      for (let gen = 1; gen <= 8; gen += 1) {
        assert.equal(submitLive(h, 1, gen).ok, true);
        const start = performance.now();
        assert.equal(h.scheduler.presentSurfaceNow('tile-1').drawsUsed, 1);
        after.push(performance.now() - start);
      }
      const mean = (samples) => samples.reduce((a, b) => a + b, 0) / samples.length;
      const beforeMean = mean(before);
      const afterMean = mean(after);
      console.log(`ac02-present: 1280x900 per-present ms before=${beforeMean.toFixed(2)}`
        + ` after=${afterMean.toFixed(2)} speedup=${(beforeMean / Math.max(afterMean, 1e-9)).toFixed(2)}x`
        + ` allocs=${h.canvases.get('tile-1').allocCount()}`);
      assertLiveCorners(h, 1);
    } finally {
      h.scheduler.destroy();
    }
  });
});
