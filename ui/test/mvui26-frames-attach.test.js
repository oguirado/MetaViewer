// MVUI26 lane F: attach-path presentation witness, notify, and metrics.
// RV10-02 (HIGH): attachCanvas must honour the draw status of a retained
// pendingPaint ({ok:false} keeps the frame pending, records no witness) and
// must notify subscribers after a successful attach paint. NEW-03 (LOW): a
// successful attach paint must advance the present counters like the normal
// present path. Plain node:test; bounded fakes (2x2 frames, one delivery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

const BUDGET = Object.freeze({
  maxDrawsPerTick: 4, maxUploadBytesPerTick: 16777216, maxPresentMsPerTick: 8,
  maxWarmResourcesPerSurface: 1, maxDrainSteps: 4,
});
const STATIC_BYTES = [12, 34, 56, 78, 90, 11, 22, 33, 44, 55, 66, 77];

function liveState(width = 2, height = 2) {
  return {
    panelOpen: true, panelSelected: true, folded: false,
    width, height, x: 0, y: 0,
    viewportIntersecting: true, windowPresentationAllowed: true, contextLost: false,
  };
}

function schedulerFrame(overrides = {}) {
  const bytes = overrides.bytes ?? new Uint8Array(STATIC_BYTES);
  return {
    surfaceId: 'A', surfaceGeneration: 1, frameGeneration: 1,
    leaseId: 'sg-l1', byteLength: bytes.byteLength, width: 2, height: 2,
    bytes, principal: 'utility', epoch: 7, sha256: 'sg', ...overrides,
  };
}

function drawableCanvasStub() {
  const canvas = {
    paints: [], width: 0, height: 0,
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

// A canvas handle that passes the attach shape check (getContext is a
// function) but whose 2d context is unavailable: drawRgb24ToCanvas reports
// {ok:false} by return, without throwing.
function nullContextCanvasStub() {
  return { width: 0, height: 0, getContext: () => null };
}

function expectedRgba2x2() {
  const out = [];
  for (let i = 0; i < STATIC_BYTES.length; i += 3) {
    out.push(STATIC_BYTES[i], STATIC_BYTES[i + 1], STATIC_BYTES[i + 2], 255);
  }
  return out;
}

function registerLive(scheduler) {
  assert.equal(scheduler.registerSurface({
    surfaceId: 'A', surfaceGeneration: 1,
    principal: 'utility', epoch: 7, state: liveState(),
  }).ok, true);
}

// Drive one frame into pendingPaint: submit + tick with no canvas attached.
function retainPendingPaint(scheduler) {
  assert.equal(scheduler.submitFrame(schedulerFrame()).ok, true);
  assert.equal(scheduler.runTick().drawsUsed, 1);
}

test('RV10-02: attach paints pendingPaint once and notifies', () => {
  const scheduler = createTileScheduler({ budget: BUDGET });
  try {
    registerLive(scheduler);
    retainPendingPaint(scheduler);
    let notifications = 0;
    const stop = scheduler.subscribePresentation(() => { notifications += 1; });
    try {
      // A failed draw keeps the frame pending and records no witness.
      const broken = nullContextCanvasStub();
      assert.equal(scheduler.attachCanvas({
        surfaceId: 'A', surfaceGeneration: 1, epoch: 7, canvas: broken,
      }).ok, true);
      const failed = scheduler.getInstrumentation('A');
      assert.equal(failed.lastPresentedFrameGen, 0);
      assert.equal(failed.lastPresentedHandle, '');
      assert.equal(failed.lastPresentedDigest, '');
      assert.equal(notifications, 0, 'failed attach notifies nobody');
      // The retained frame survived: a working attach paints it exactly once.
      const canvas = drawableCanvasStub();
      assert.equal(scheduler.attachCanvas({
        surfaceId: 'A', surfaceGeneration: 1, epoch: 7, canvas,
      }).ok, true);
      assert.equal(canvas.paints.length, 1, 'working attach paints the retained frame once');
      assert.deepEqual(canvas.paints[0].data, expectedRgba2x2());
      assert.equal(notifications, 1, 'successful attach paint notifies subscribers');
      const info = scheduler.getInstrumentation('A');
      assert.equal(info.lastPresentedFrameGen, 1);
      assert.ok(info.lastPresentedHandle.length > 0);
      assert.equal(info.lastPresentedDigest, 'sg');
      assert.equal(info.lastPresentedWidth, 2);
      assert.equal(info.lastPresentedHeight, 2);
    } finally {
      stop();
    }
  } finally {
    scheduler.destroy();
  }
});

test('NEW-03: attach paint advances metrics with witness', () => {
  const scheduler = createTileScheduler({ budget: BUDGET });
  try {
    registerLive(scheduler);
    retainPendingPaint(scheduler);
    const before = scheduler.getInstrumentation('A');
    assert.equal(before.presentCount, 0);
    assert.equal(before.convertedBytesTotal, 0);
    const canvas = drawableCanvasStub();
    assert.equal(scheduler.attachCanvas({
      surfaceId: 'A', surfaceGeneration: 1, epoch: 7, canvas,
    }).ok, true);
    const info = scheduler.getInstrumentation('A');
    assert.ok(info.lastPresentedHandle.length > 0, 'witness handle is set');
    assert.equal(info.presentCount, 1, 'attach paint counts as a present');
    assert.equal(info.convertedBytesTotal, 2 * 2 * 4, 'attach paint accounts converted bytes');
  } finally {
    scheduler.destroy();
  }
});

test('RV10-02 negative control: plain attach notifies nothing and touches no witness', () => {
  const scheduler = createTileScheduler({ budget: BUDGET });
  try {
    registerLive(scheduler);
    let notifications = 0;
    const stop = scheduler.subscribePresentation(() => { notifications += 1; });
    try {
      const canvas = drawableCanvasStub();
      assert.equal(scheduler.attachCanvas({
        surfaceId: 'A', surfaceGeneration: 1, epoch: 7, canvas,
      }).ok, true);
      assert.equal(canvas.paints.length, 0, 'nothing retained, nothing painted');
      assert.equal(notifications, 0);
      const info = scheduler.getInstrumentation('A');
      assert.equal(info.lastPresentedFrameGen, 0);
      assert.equal(info.lastPresentedHandle, '');
      assert.equal(info.presentCount, 0);
      assert.equal(info.convertedBytesTotal, 0);
    } finally {
      stop();
    }
  } finally {
    scheduler.destroy();
  }
});

test('NEW-03 negative control: failed attach paint advances no metrics', () => {
  const scheduler = createTileScheduler({ budget: BUDGET });
  try {
    registerLive(scheduler);
    retainPendingPaint(scheduler);
    assert.equal(scheduler.attachCanvas({
      surfaceId: 'A', surfaceGeneration: 1, epoch: 7, canvas: nullContextCanvasStub(),
    }).ok, true);
    const info = scheduler.getInstrumentation('A');
    // Witness assertions belong to the RV10-02 regression test; this control
    // pins only that a failed paint never accounts metrics.
    assert.equal(info.presentCount, 0);
    assert.equal(info.convertedBytesTotal, 0);
  } finally {
    scheduler.destroy();
  }
});
