/**
 * MVUI32 lane S (R3-SCHEDULER-1): retained repaint on attach is gated on
 * surface eligibility. Hosted-safe: plain node:test, fake canvases counting
 * real putImageData calls, fake clock; no sleeps, no sockets, no Electron.
 * Every test is synchronous, far inside a 5000 ms margin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULER_REASONS,
  createTileScheduler,
} from '../src/surfaces/tileScheduler.js';

const BUDGET = Object.freeze({
  maxDrawsPerTick: 4,
  maxUploadBytesPerTick: 8 * 1024 * 1024,
  maxPresentMsPerTick: 16,
  maxWarmResourcesPerSurface: 2,
  maxDrainSteps: 4,
});

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

function makeScheduler() {
  const scheduler = createTileScheduler({
    budget: BUDGET,
    clock: () => 1000,
    onPresent: (record) => scheduler.presentHandle(record),
  });
  return scheduler;
}

function registerLive(scheduler, surfaceId = 's1') {
  const res = scheduler.registerSurface({
    surfaceId,
    surfaceGeneration: 1,
    epoch: 7,
    principal: 'wall-main',
    captureLeaseId: `capture-${surfaceId}`,
    captureLeaseActive: true,
    state: eligibleState(),
  });
  assert.equal(res.ok, true);
}

function makeFakeCanvas() {
  const puts = [];
  const ctx = {
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: (image, x, y) => { puts.push({ image, x, y }); },
  };
  return { width: 0, height: 0, puts, getContext: (kind) => (kind === '2d' ? ctx : null) };
}

/** Distinct 2x2 RGB24 payload: TL red, TR green, BL blue, BR white. */
function frameBytes() {
  return new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
}

function rgbaOf(rgb24) {
  const out = [];
  for (let i = 0; i < rgb24.length; i += 3) {
    out.push(rgb24[i], rgb24[i + 1], rgb24[i + 2], 255);
  }
  return out;
}

function submitG1(scheduler, surfaceId = 's1') {
  const bytes = frameBytes();
  const out = scheduler.submitFrame({
    surfaceId,
    surfaceGeneration: 1,
    frameGeneration: 1,
    leaseId: 'lease-1',
    byteLength: bytes.length,
    width: 2,
    height: 2,
    bytes,
    principal: 'wall-main',
    epoch: 7,
  });
  assert.equal(out.ok, true);
  return bytes;
}

/** Present g1 onto C1; returns the submitted bytes for pixel assertions. */
function presentG1(scheduler) {
  const first = makeFakeCanvas();
  assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: first }).ok, true);
  const bytes = submitG1(scheduler);
  assert.equal(scheduler.presentSurfaceNow('s1').drawsUsed, 1);
  assert.equal(first.puts.length, 1);
  return bytes;
}

function assertRgbaPaint(canvas, rgb24, label) {
  assert.equal(canvas.puts.length, 1, label);
  assert.deepEqual([...canvas.puts[0].image.data], rgbaOf(rgb24), `${label} pixels`);
}

test('mvui32-s folded: attach paints zero, unfold replays newest retained frame', () => {
  const scheduler = makeScheduler();
  try {
    registerLive(scheduler);
    const bytes = presentG1(scheduler);
    assert.equal(scheduler.foldSurface('s1').ok, true);
    const folded = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: folded }).ok, true);
    assert.equal(folded.puts.length, 0, 'zero putImageData while folded');
    assert.equal(scheduler.unfoldSurface('s1').ok, true);
    const revived = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: revived }).ok, true);
    assertRgbaPaint(revived, bytes, 'unfold replays the newest permitted frame');
  } finally {
    scheduler.destroy();
  }
});

test('mvui32-s hidden: attach paints zero, re-show replays newest retained frame', () => {
  const scheduler = makeScheduler();
  try {
    registerLive(scheduler);
    const bytes = presentG1(scheduler);
    const hid = scheduler.updateSurfaceState('s1', { viewportIntersecting: false });
    assert.equal(hid.ok, true);
    assert.equal(hid.eligible, false);
    const hidden = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: hidden }).ok, true);
    assert.equal(hidden.puts.length, 0, 'zero putImageData while hidden');
    const shown = scheduler.updateSurfaceState('s1', { viewportIntersecting: true });
    assert.equal(shown.ok, true);
    assert.equal(shown.eligible, true);
    const revived = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: revived }).ok, true);
    assertRgbaPaint(revived, bytes, 're-show replays the newest permitted frame');
  } finally {
    scheduler.destroy();
  }
});

test('mvui32-s context-lost: attach paints zero, restore replays newest retained frame', () => {
  const scheduler = makeScheduler();
  try {
    registerLive(scheduler);
    const bytes = presentG1(scheduler);
    assert.equal(scheduler.onContextLost('s1').ok, true);
    const lost = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: lost }).ok, true);
    assert.equal(lost.puts.length, 0, 'zero putImageData while context-lost');
    assert.equal(scheduler.onContextRestored('s1').ok, true);
    const revived = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: revived }).ok, true);
    assertRgbaPaint(revived, bytes, 'restore replays the newest permitted frame');
  } finally {
    scheduler.destroy();
  }
});

test('mvui32-s pending: canvas-less frame survives an ineligible attach, paints when eligible', () => {
  const scheduler = makeScheduler();
  try {
    registerLive(scheduler);
    const bytes = submitG1(scheduler);
    assert.equal(scheduler.runTick().drawsUsed, 1);
    assert.equal(scheduler.getInstrumentation('s1').presentCount, 0);
    // Same-lifetime re-registration resets state to ineligible defaults but
    // keeps the undrawn pending frame.
    assert.equal(scheduler.registerSurface({
      surfaceId: 's1',
      surfaceGeneration: 1,
      epoch: 7,
      principal: 'wall-main',
      captureLeaseId: 'capture-s1',
      captureLeaseActive: true,
    }).ok, true);
    const early = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: early }).ok, true);
    assert.equal(early.puts.length, 0, 'zero putImageData while ineligible');
    const eligible = scheduler.updateSurfaceState('s1', { width: 320, height: 200, viewportIntersecting: true });
    assert.equal(eligible.ok, true);
    assert.equal(eligible.eligible, true);
    const late = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: late }).ok, true);
    assertRgbaPaint(late, bytes, 'eligible attach paints the retained pending frame');
    assert.equal(scheduler.getInstrumentation('s1').lastPresentedFrameGen, 1);
  } finally {
    scheduler.destroy();
  }
});

test('mvui32-s eligible attach still repaints the retained frame (positive control)', () => {
  const scheduler = makeScheduler();
  try {
    registerLive(scheduler);
    const bytes = presentG1(scheduler);
    const second = makeFakeCanvas();
    assert.equal(scheduler.attachCanvas({ surfaceId: 's1', canvas: second }).ok, true);
    assertRgbaPaint(second, bytes, 'eligible attach repaints');
  } finally {
    scheduler.destroy();
  }
});

test('mvui32-s destroyed: attach is refused and draws nothing', () => {
  const scheduler = makeScheduler();
  try {
    registerLive(scheduler);
    presentG1(scheduler);
    assert.equal(scheduler.destroySurface('s1').ok, true);
    const dead = makeFakeCanvas();
    const refused = scheduler.attachCanvas({ surfaceId: 's1', canvas: dead });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, SCHEDULER_REASONS.SURFACE_DESTROYED);
    assert.equal(dead.puts.length, 0, 'zero putImageData on a destroyed surface');
  } finally {
    scheduler.destroy();
  }
});
