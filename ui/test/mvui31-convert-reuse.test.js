/**
 * MVUI31 lane P: rgb24->RGBA conversion bit-identity plus per-tile scratch
 * reuse. Plain node:test with fake canvases and a frozen clock; no DOM,
 * no Electron, no timing assertions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULER_REASONS,
  convertRgb24ToRgba,
  createTileScheduler,
} from '../src/surfaces/tileScheduler.js';

/** Deterministic PRNG (mulberry32) for random fills. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let word = state;
    word = Math.imul(word ^ (word >>> 15), word | 1);
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61);
    return (word ^ (word >>> 14)) >>> 0;
  };
}

/** Historical per-pixel loop, transcribed as the test oracle. */
function referenceConvert(bytes, out) {
  for (let src = 0, dst = 0; src < bytes.length; src += 3, dst += 4) {
    out[dst] = bytes[src];
    out[dst + 1] = bytes[src + 1];
    out[dst + 2] = bytes[src + 2];
    out[dst + 3] = 255;
  }
}

function fillPattern(kind, length, seed) {
  const bytes = new Uint8Array(length);
  if (kind === 'zeros') return bytes;
  if (kind === 'ones') return bytes.fill(255);
  if (kind === 'ramp') {
    for (let i = 0; i < length; i += 1) bytes[i] = i % 256;
    return bytes;
  }
  if (kind === 'alternate') {
    for (let i = 0; i < length; i += 1) bytes[i] = i % 2 === 0 ? 0x00 : 0xff;
    return bytes;
  }
  const next = rng(seed);
  for (let i = 0; i < length; i += 1) bytes[i] = next() % 256;
  return bytes;
}

describe('mvui31 converter bit-identity', () => {
  const sizes = [[1, 1], [2, 1], [1, 2], [3, 2], [4, 3], [7, 5], [16, 16], [64, 48], [160, 120]];
  const fills = ['zeros', 'ones', 'ramp', 'alternate', 'random-a', 'random-b'];
  for (const [width, height] of sizes) {
    for (const kind of fills) {
      it(`matches the reference loop at ${width}x${height} (${kind})`, () => {
        const seed = width * 100003 + height * 101 + kind.length * 7;
        const bytes = fillPattern(kind.startsWith('random') ? 'random' : kind, width * height * 3, seed);
        const expected = new Uint8ClampedArray(width * height * 4);
        referenceConvert(bytes, expected);
        const clamped = new Uint8ClampedArray(width * height * 4);
        convertRgb24ToRgba(bytes, clamped, width, height);
        assert.deepEqual(clamped, expected);
        const plain = new Uint8Array(width * height * 4);
        convertRgb24ToRgba(bytes, plain, width, height);
        assert.deepEqual(Array.from(plain), Array.from(expected));
        const list = new Array(width * height * 4).fill(0);
        convertRgb24ToRgba(bytes, list, width, height);
        assert.deepEqual(list, Array.from(expected));
        for (let i = 3; i < clamped.length; i += 4) assert.equal(clamped[i], 255);
      });
    }
  }

  it('covers aligned-offset and misaligned outputs identically', () => {
    const width = 9;
    const height = 7;
    const bytes = fillPattern('random', width * height * 3, 1234);
    const expected = new Uint8ClampedArray(width * height * 4);
    referenceConvert(bytes, expected);
    const offset = new Uint8ClampedArray(new ArrayBuffer(width * height * 4 + 8), 8);
    convertRgb24ToRgba(bytes, offset, width, height);
    assert.deepEqual(offset, expected);
    const backing = new ArrayBuffer(width * height * 4 + 2);
    const skewed = new Uint8ClampedArray(backing, 2, width * height * 4);
    convertRgb24ToRgba(bytes, skewed, width, height);
    assert.deepEqual(skewed, expected);
  });

  it('keeps historical prefix semantics on short input with a fresh buffer', () => {
    const width = 4;
    const height = 3;
    const bytes = fillPattern('ramp', width * height * 3 - 6, 0);
    const expected = new Uint8ClampedArray(width * height * 4);
    referenceConvert(bytes, expected);
    const actual = new Uint8ClampedArray(width * height * 4);
    convertRgb24ToRgba(bytes, actual, width, height);
    assert.deepEqual(actual, expected);
  });
});

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

function countingCanvas() {
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
      putImageData: (image) => { puts.push(image); },
    }),
  };
  return canvas;
}

function setup() {
  const now = { value: 1000 };
  const releases = [];
  const scheduler = createTileScheduler({
    budget: makeBudget(),
    clock: () => now.value,
    onPresent: (record) => scheduler.presentHandle(record),
    onReleaseLease: (release) => { releases.push(release); },
  });
  return { scheduler, releases, now };
}

function eligibleState() {
  return {
    panelOpen: true, panelSelected: true, folded: false, width: 320, height: 200,
    x: 0, y: 0, viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
  };
}

function registerLive(harness, surfaceId) {
  const res = harness.scheduler.registerSurface({
    surfaceId, surfaceGeneration: 1, epoch: 7, principal: 'wall-main',
    captureLeaseId: `capture-${surfaceId}`, captureLeaseActive: true, state: eligibleState(),
  });
  assert.equal(res.ok, true);
}

function solidRgb24(width, height, rgb) {
  const bytes = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    bytes[i * 3] = rgb[0];
    bytes[i * 3 + 1] = rgb[1];
    bytes[i * 3 + 2] = rgb[2];
  }
  return bytes;
}

function submit(harness, { surfaceId, frameGeneration, width, height, bytes }) {
  return harness.scheduler.submitFrame({
    surfaceId, surfaceGeneration: 1, frameGeneration, leaseId: `${surfaceId}-g${frameGeneration}`,
    byteLength: bytes.length, width, height, bytes, principal: 'wall-main', epoch: 7,
  });
}

function lastPutRgb(canvas, width, height) {
  const image = canvas.puts[canvas.puts.length - 1];
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  return image;
}

describe('mvui31 per-tile scratch reuse', () => {
  it('allocates once across same-dimension presents', () => {
    const h = setup();
    registerLive(h, 'tile-a');
    const canvas = countingCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'tile-a', canvas }).ok, true);
    for (let gen = 1; gen <= 3; gen += 1) {
      const shade = (gen * 40) % 256;
      assert.equal(submit(h, {
        surfaceId: 'tile-a', frameGeneration: gen, width: 4, height: 3,
        bytes: solidRgb24(4, 3, [shade, 10, 20]),
      }).ok, true);
      assert.equal(h.scheduler.runTick().drawsUsed, 1);
      const image = lastPutRgb(canvas, 4, 3);
      assert.equal(image.data[0], shade);
      assert.equal(image.data[3], 255);
    }
    assert.equal(canvas.allocCount(), 1);
    assert.equal(canvas.puts.length, 3);
    h.scheduler.destroy();
  });

  it('reallocates on every dimension change and paints the new frame fully', () => {
    const h = setup();
    registerLive(h, 'tile-a');
    const canvas = countingCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'tile-a', canvas }).ok, true);
    assert.equal(submit(h, {
      surfaceId: 'tile-a', frameGeneration: 1, width: 4, height: 3,
      bytes: solidRgb24(4, 3, [200, 0, 0]),
    }).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(submit(h, {
      surfaceId: 'tile-a', frameGeneration: 2, width: 2, height: 2,
      bytes: solidRgb24(2, 2, [0, 200, 0]),
    }).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    const small = lastPutRgb(canvas, 2, 2);
    assert.deepEqual([small.data[0], small.data[1], small.data[2], small.data[3]], [0, 200, 0, 255]);
    assert.equal(submit(h, {
      surfaceId: 'tile-a', frameGeneration: 3, width: 4, height: 3,
      bytes: solidRgb24(4, 3, [0, 0, 200]),
    }).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    const back = lastPutRgb(canvas, 4, 3);
    assert.deepEqual([back.data[0], back.data[1], back.data[2], back.data[3]], [0, 0, 200, 255]);
    assert.equal(canvas.allocCount(), 3);
    h.scheduler.destroy();
  });

  it('never leaks pixels between tiles', () => {
    const h = setup();
    registerLive(h, 'tile-a');
    registerLive(h, 'tile-b');
    const canvasA = countingCanvas();
    const canvasB = countingCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'tile-a', canvas: canvasA }).ok, true);
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'tile-b', canvas: canvasB }).ok, true);
    for (let gen = 1; gen <= 2; gen += 1) {
      assert.equal(submit(h, {
        surfaceId: 'tile-a', frameGeneration: gen, width: 4, height: 3,
        bytes: solidRgb24(4, 3, [255, 0, 0]),
      }).ok, true);
      assert.equal(submit(h, {
        surfaceId: 'tile-b', frameGeneration: gen, width: 4, height: 3,
        bytes: solidRgb24(4, 3, [0, 0, 255]),
      }).ok, true);
      assert.equal(h.scheduler.runTick().drawsUsed, 2);
    }
    assert.equal(canvasA.allocCount(), 1);
    assert.equal(canvasB.allocCount(), 1);
    for (const put of canvasA.puts) {
      assert.deepEqual([put.data[0], put.data[1], put.data[2], put.data[3]], [255, 0, 0, 255]);
    }
    for (const put of canvasB.puts) {
      assert.deepEqual([put.data[0], put.data[1], put.data[2], put.data[3]], [0, 0, 255, 255]);
    }
    h.scheduler.destroy();
  });

  it('drops the scratch on evict so a reopened tile paints fresh', () => {
    const h = setup();
    registerLive(h, 'tile-a');
    const canvas = countingCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'tile-a', canvas }).ok, true);
    assert.equal(submit(h, {
      surfaceId: 'tile-a', frameGeneration: 1, width: 4, height: 3,
      bytes: solidRgb24(4, 3, [9, 9, 9]),
    }).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(canvas.allocCount(), 1);
    assert.equal(h.scheduler.evictSurface('tile-a').ok, true);
    registerLive(h, 'tile-a');
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'tile-a', canvas }).ok, true);
    assert.equal(submit(h, {
      surfaceId: 'tile-a', frameGeneration: 1, width: 4, height: 3,
      bytes: solidRgb24(4, 3, [77, 88, 99]),
    }).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(canvas.allocCount(), 2);
    const image = lastPutRgb(canvas, 4, 3);
    assert.deepEqual([image.data[0], image.data[1], image.data[2], image.data[3]], [77, 88, 99, 255]);
    h.scheduler.destroy();
  });

  it('still refuses short or corrupt buffers with INVALID_BINDING and never paints', () => {
    const h = setup();
    registerLive(h, 'tile-a');
    const canvas = countingCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'tile-a', canvas }).ok, true);
    const short = solidRgb24(4, 3, [1, 2, 3]).slice(0, 30);
    assert.equal(submit(h, {
      surfaceId: 'tile-a', frameGeneration: 1, width: 4, height: 3, bytes: short,
    }).reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(submit(h, {
      surfaceId: 'tile-a', frameGeneration: 2, width: 5, height: 3,
      bytes: solidRgb24(4, 3, [1, 2, 3]),
    }).reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(h.scheduler.runTick().drawsUsed, 0);
    assert.equal(canvas.puts.length, 0);
    assert.equal(canvas.allocCount(), 0);
    h.scheduler.destroy();
  });
});
