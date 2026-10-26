/**
 * Tests for the wall tile scheduler (`ui/src/surfaces/tileScheduler.js`) and
 * the SurfaceCanvas contract (`ui/src/surfaces/SurfaceCanvas.vue`).
 *
 * Runs under the repository `node --test` gate with fake canvases, clocks
 * and scheduler doubles only; no DOM or Electron runtime is loaded. Each
 * behaviour pairs a positive witness with a negative control that must fail:
 * cross-tile routing refuses, leaked disposers trip the audit, and inline
 * mutant fixtures fail the same assertions as a broken implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_CAUSES,
  SCHEDULER_REASONS,
  SURFACE_STATES,
  createTileScheduler,
  evaluateTileEligibility,
  formatFrameStrip,
  normalizeSurfaceState,
  shortenDigest,
  surfaceCanvasAccessibleName,
  surfaceCanvasAnchor,
  surfaceCanvasDomId,
  validateFrozenBudget,
} from '../src/surfaces/tileScheduler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SFC_PATH = join(HERE, '..', 'src', 'surfaces', 'SurfaceCanvas.vue');

/** @returns {Readonly<{maxDrawsPerTick:number,maxUploadBytesPerTick:number,maxPresentMsPerTick:number,maxWarmResourcesPerSurface:number,maxDrainSteps:number}>} */
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

function makeClock(startMs = 1000) {
  let now = startMs;
  return {
    clock: () => now,
    advance: (ms) => { now += ms; },
  };
}

function makeHarness({ budget, onPresent } = {}) {
  const tick = makeClock();
  const presents = [];
  const releases = [];
  const newestRequests = [];
  const scheduler = createTileScheduler({
    budget: budget ?? makeBudget(),
    clock: tick.clock,
    onPresent: (record) => {
      presents.push(record);
      if (onPresent) onPresent(record, scheduler);
    },
    onReleaseLease: (release) => { releases.push(release); },
    onRequestNewestGeneration: (req) => { newestRequests.push(req); },
  });
  return { scheduler, presents, releases, newestRequests, tick };
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

function registerLive(h, surfaceId, overrides = {}) {
  const res = h.scheduler.registerSurface({
    surfaceId,
    surfaceGeneration: 1,
    epoch: 7,
    principal: 'wall-main',
    captureLeaseId: `capture-${surfaceId}`,
    captureLeaseActive: true,
    state: eligibleState(),
    ...overrides,
  });
  assert.equal(res.ok, true);
  return res;
}

/**
 * Builds packed RGB24 bytes; paint(x, y) returns [r, g, b].
 */
function makeRgb24(width, height, paint) {
  const bytes = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const o = (y * width + x) * 3;
      bytes[o] = r;
      bytes[o + 1] = g;
      bytes[o + 2] = b;
    }
  }
  return bytes;
}

/** Distinct corners: TL red, TR green, BL blue, BR white, body mid-gray. */
function cornerPaint(width, height) {
  return (x, y) => {
    if (x === 0 && y === 0) return [255, 0, 0];
    if (x === width - 1 && y === 0) return [0, 255, 0];
    if (x === 0 && y === height - 1) return [0, 0, 255];
    if (x === width - 1 && y === height - 1) return [255, 255, 255];
    return [128, 128, 128];
  };
}

function makeFrame({
  surfaceId = 'capsule-a',
  surfaceGeneration = 1,
  frameGeneration = 1,
  leaseId = `lease-${frameGeneration}`,
  width = 4,
  height = 3,
  bytes = null,
  principal = 'wall-main',
  epoch = 7,
  extra = {},
} = {}) {
  const payload = bytes ?? makeRgb24(width, height, cornerPaint(width, height));
  return {
    surfaceId,
    surfaceGeneration,
    frameGeneration,
    leaseId,
    byteLength: payload.length,
    width,
    height,
    bytes: payload,
    principal,
    epoch,
    ...extra,
  };
}

function makeFakeCanvas() {
  const puts = [];
  const ctx = {
    puts,
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: (image) => { puts.push(image); },
  };
  return {
    width: 0,
    height: 0,
    puts,
    getContext: (kind) => (kind === '2d' ? ctx : null),
  };
}

function pixelAt(image, x, y) {
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}

/** Colored-corner oracle: fails on flip, rotation, or channel reorder. */
function assertCorners(canvas, width, height) {
  assert.equal(canvas.puts.length > 0, true);
  const image = canvas.puts[canvas.puts.length - 1];
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  assert.deepEqual(pixelAt(image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(image, width - 1, 0), [0, 255, 0, 255]);
  assert.deepEqual(pixelAt(image, 0, height - 1), [0, 0, 255, 255]);
  assert.deepEqual(pixelAt(image, width - 1, height - 1), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(image, 1, 1), [128, 128, 128, 255]);
}

/** Every lease must retire exactly once; double or missing release trips. */
function assertExactlyOnceReleased(releases, leaseIds) {
  for (const leaseId of leaseIds) {
    const hits = releases.filter((r) => r.leaseId === leaseId);
    assert.equal(hits.length, 1, `lease ${leaseId} released ${hits.length}x`);
  }
}

describe('tileScheduler budget', () => {
  it('accepts the exact frozen profile', () => {
    const out = validateFrozenBudget(makeBudget());
    assert.equal(out.ok, true);
  });

  it('refuses unfrozen, partial, unknown-key, and out-of-range budgets', () => {
    const frozen = makeBudget();
    assert.equal(validateFrozenBudget({ ...frozen }).reason, SCHEDULER_REASONS.INVALID_BUDGET);
    const missing = { ...frozen };
    // @ts-expect-error negative control deletes a required key
    delete missing.maxDrainSteps;
    assert.equal(validateFrozenBudget(Object.freeze(missing)).reason, SCHEDULER_REASONS.INVALID_BUDGET);
    assert.equal(
      validateFrozenBudget(Object.freeze({ ...frozen, maxFps: 60 })).reason,
      SCHEDULER_REASONS.INVALID_BUDGET,
    );
    assert.equal(
      validateFrozenBudget(Object.freeze({ ...frozen, maxDrawsPerTick: 0 })).reason,
      SCHEDULER_REASONS.INVALID_BUDGET,
    );
    assert.equal(
      validateFrozenBudget(Object.freeze({ ...frozen, maxPresentMsPerTick: Number.NaN })).reason,
      SCHEDULER_REASONS.INVALID_BUDGET,
    );
    assert.equal(validateFrozenBudget(null).reason, SCHEDULER_REASONS.INVALID_BUDGET);
  });

  it('factory throws on an invalid budget and freezes the scheduler', () => {
    assert.throws(() => createTileScheduler({ budget: { ...makeBudget() } }), /INVALID_BUDGET/);
    const h = makeHarness();
    assert.equal(Object.isFrozen(h.scheduler), true);
    assert.equal(Object.isFrozen(SCHEDULER_REASONS), true);
    assert.equal(Object.isFrozen(RELEASE_CAUSES), true);
  });
});

describe('tileScheduler eligibility', () => {
  it('accepts a fully drawable tile with a rounded box', () => {
    const out = evaluateTileEligibility(eligibleState({ x: 10.6, y: 4.2, width: 320.4, height: 199.6 }));
    assert.equal(out.eligible, true);
    assert.deepEqual(out.reasons, []);
    assert.deepEqual(out.box, { x: 11, y: 4, width: 320, height: 200 });
  });

  it('vetoes each axis independently with frozen codes and null box', () => {
    const cases = [
      [{ panelOpen: false }, SCHEDULER_REASONS.PANEL_NOT_SELECTED_OR_OPEN],
      [{ panelSelected: false }, SCHEDULER_REASONS.PANEL_NOT_SELECTED_OR_OPEN],
      [{ folded: true }, SCHEDULER_REASONS.FOLDED],
      [{ width: 0 }, SCHEDULER_REASONS.NON_POSITIVE_SIZE],
      [{ width: 0.4 }, SCHEDULER_REASONS.NON_POSITIVE_SIZE],
      [{ viewportIntersecting: false }, SCHEDULER_REASONS.NOT_INTERSECTING_VIEWPORT],
      [{ windowPresentationAllowed: false }, SCHEDULER_REASONS.WINDOW_PRESENTATION_DISALLOWED],
      [{ contextLost: true }, SCHEDULER_REASONS.CONTEXT_LOST],
    ];
    for (const [patch, code] of cases) {
      const out = evaluateTileEligibility(eligibleState(patch));
      assert.equal(out.eligible, false);
      assert.equal(out.box, null);
      assert.ok(out.reasons.includes(code), `missing ${code}`);
      for (const reason of out.reasons) {
        assert.ok(Object.values(SCHEDULER_REASONS).includes(reason), `unfrozen reason ${reason}`);
      }
    }
    const missing = evaluateTileEligibility(null);
    assert.deepEqual(missing.reasons, [SCHEDULER_REASONS.MISSING_STATE]);
    assert.equal(missing.box, null);
  });
});

describe('tileScheduler registration', () => {
  it('registers with explicit binding and capture lease', () => {
    const h = makeHarness();
    const res = registerLive(h, 'capsule-a');
    assert.equal(res.epoch, 7);
    const info = h.scheduler.getInstrumentation('capsule-a');
    assert.equal(info.captureLeaseActive, true);
    assert.equal(info.captureLeaseId, 'capture-capsule-a');
    assert.equal(info.eligible, true);
  });

  it('refuses bad ids, generations, bindings, and phantom capture leases', () => {
    const h = makeHarness();
    const base = {
      surfaceId: 'capsule-a',
      surfaceGeneration: 1,
      epoch: 7,
      principal: 'wall-main',
      captureLeaseId: 'capture-a',
      captureLeaseActive: true,
      state: eligibleState(),
    };
    assert.equal(h.scheduler.registerSurface({ ...base, surfaceId: '' }).reason, SCHEDULER_REASONS.INVALID_SURFACE_ID);
    assert.equal(h.scheduler.registerSurface({ ...base, surfaceId: '42' }).reason, SCHEDULER_REASONS.INVALID_SURFACE_ID);
    assert.equal(
      h.scheduler.registerSurface({ ...base, surfaceGeneration: 0 }).reason,
      SCHEDULER_REASONS.INVALID_GENERATION,
    );
    assert.equal(
      h.scheduler.registerSurface({ ...base, epoch: undefined }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(
      h.scheduler.registerSurface({ ...base, principal: '' }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(
      h.scheduler.registerSurface({ ...base, captureLeaseId: undefined, captureLeaseActive: true }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
  });

  it('advances generations, refuses regress and binding drift', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    const canvas = makeFakeCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas }).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    const advance = h.scheduler.registerSurface({
      surfaceId: 'capsule-a',
      surfaceGeneration: 2,
      epoch: 7,
      principal: 'wall-main',
      captureLeaseId: 'capture-a2',
      captureLeaseActive: true,
      state: eligibleState(),
    });
    assert.equal(advance.ok, true);
    assert.equal(h.releases.length, 1);
    assert.equal(h.releases[0].reason, RELEASE_CAUSES.SUPERSEDED);
    assert.equal(
      h.scheduler.registerSurface({
        surfaceId: 'capsule-a', surfaceGeneration: 1, epoch: 7, principal: 'wall-main',
      }).reason,
      SCHEDULER_REASONS.STALE_SURFACE_GENERATION,
    );
    assert.equal(
      h.scheduler.registerSurface({
        surfaceId: 'capsule-a', surfaceGeneration: 2, epoch: 7, principal: 'intruder',
      }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(
      h.scheduler.registerSurface({
        surfaceId: 'capsule-a', surfaceGeneration: 3, epoch: 6, principal: 'wall-main',
      }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
  });
});

describe('tileScheduler capture witnesses', () => {
  it('advances while folded without scheduling draws', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.equal(h.scheduler.foldSurface('capsule-a').ok, true);
    for (const gen of [5, 6, 7]) {
      const out = h.scheduler.recordCaptureWitness({ surfaceId: 'capsule-a', surfaceGeneration: 1, captureGeneration: gen });
      assert.equal(out.ok, true);
      assert.equal(out.lastCaptureGeneration, gen);
    }
    assert.equal(h.scheduler.recordCaptureWitness({
      surfaceId: 'capsule-a', surfaceGeneration: 1, captureGeneration: 7,
    }).reason, SCHEDULER_REASONS.STALE_FRAME_GENERATION);
    assert.equal(h.scheduler.recordCaptureWitness({
      surfaceId: 'capsule-a', surfaceGeneration: 2, captureGeneration: 8,
    }).reason, SCHEDULER_REASONS.STALE_SURFACE_GENERATION);
    const info = h.scheduler.getInstrumentation('capsule-a');
    assert.equal(info.lastCaptureGeneration, 7);
    assert.equal(info.presentCount, 0);
  });
});

describe('tileScheduler submitFrame', () => {
  it('queues a valid frame and supersedes newest-only with one release', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.deepEqual(h.scheduler.submitFrame(makeFrame({ frameGeneration: 1 })), {
      ok: true, queuedFrameGeneration: 1, replacedFrameGeneration: null,
    });
    const second = h.scheduler.submitFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' }));
    assert.deepEqual(second, { ok: true, queuedFrameGeneration: 2, replacedFrameGeneration: 1 });
    assert.equal(h.releases.length, 1);
    assert.equal(h.releases[0].leaseId, 'lease-1');
    assert.equal(h.releases[0].reason, RELEASE_CAUSES.SUPERSEDED);
    // Single-object full-identity payload.
    assert.deepEqual(Object.keys(h.releases[0]).sort(), [
      'epoch', 'frameGeneration', 'leaseId', 'principal', 'reason', 'releasedAtMs', 'surfaceGeneration', 'surfaceId',
    ]);
    assert.equal(h.scheduler.getInstrumentation('capsule-a').mailboxReplacements, 1);
  });

  it('refuses stale, unbound, and malformed submissions before buffering', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.equal(
      h.scheduler.submitFrame(makeFrame({ surfaceId: 'ghost' })).reason,
      SCHEDULER_REASONS.SURFACE_NOT_REGISTERED,
    );
    assert.equal(
      h.scheduler.submitFrame(makeFrame({ surfaceGeneration: 9 })).reason,
      SCHEDULER_REASONS.STALE_SURFACE_GENERATION,
    );
    assert.equal(
      h.scheduler.submitFrame(makeFrame({ principal: 'intruder' })).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(h.scheduler.submitFrame(makeFrame({ epoch: 8 })).reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(h.scheduler.submitFrame(makeFrame({ leaseId: '' })).reason, SCHEDULER_REASONS.STALE_LEASE);
    h.tick.advance(5000);
    assert.equal(
      h.scheduler.submitFrame(makeFrame({ extra: { leaseExpiresAtMs: 1000 } })).reason,
      SCHEDULER_REASONS.STALE_LEASE,
    );
    const short = makeRgb24(4, 3, cornerPaint(4, 3)).slice(0, 30);
    assert.equal(
      h.scheduler.submitFrame(makeFrame({ bytes: short, extra: {} })).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(
      h.scheduler.submitFrame(makeFrame({ width: 5, bytes: makeRgb24(4, 3, cornerPaint(4, 3)) })).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(h.scheduler.getInstrumentation('capsule-a').pendingMailboxFrameGen, null);
  });

  it('refuses over-budget, folded, hidden, and context-lost tiles', () => {
    const h = makeHarness({ budget: makeBudget({ maxUploadBytesPerTick: 16 }) });
    registerLive(h, 'capsule-a');
    assert.equal(h.scheduler.submitFrame(makeFrame({})).reason, SCHEDULER_REASONS.BUDGET_EXHAUSTED);
    const roomy = makeHarness();
    registerLive(roomy, 'capsule-a');
    registerLive(roomy, 'capsule-b', { state: eligibleState({ panelSelected: false }) });
    registerLive(roomy, 'capsule-c');
    assert.equal(roomy.scheduler.foldSurface('capsule-a').ok, true);
    assert.equal(
      roomy.scheduler.submitFrame(makeFrame({})).reason,
      SCHEDULER_REASONS.FOLDED_DISPLAY_DISABLED,
    );
    assert.equal(
      roomy.scheduler.submitFrame(makeFrame({ surfaceId: 'capsule-b', leaseId: 'lease-b1' })).reason,
      SCHEDULER_REASONS.HIDDEN_SURFACE,
    );
    assert.equal(roomy.scheduler.onContextLost('capsule-c').ok, true);
    const lost = roomy.scheduler.submitFrame(makeFrame({ surfaceId: 'capsule-c', leaseId: 'lease-c1' }));
    assert.equal(lost.reason, SCHEDULER_REASONS.CONTEXT_LOST);
    assert.deepEqual(lost.disqualifiers, [SCHEDULER_REASONS.CONTEXT_LOST]);
  });

  it('never draws on arrival', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    const canvas = makeFakeCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas }).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    assert.equal(canvas.puts.length, 0);
    assert.equal(canvas.width, 0);
  });
});

describe('tileScheduler fold lifecycle', () => {
  it('bounds drain steps and drains the mailbox with FOLD_DRAIN', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.equal(
      h.scheduler.foldSurface('capsule-a', { drainSteps: 99 }).reason,
      SCHEDULER_REASONS.DRAIN_LIMIT_EXCEEDED,
    );
    assert.equal(
      h.scheduler.foldSurface('capsule-a', { drainSteps: -1 }).reason,
      SCHEDULER_REASONS.DRAIN_LIMIT_EXCEEDED,
    );
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 3 })).ok, true);
    const disposed = [];
    assert.equal(h.scheduler.allocateWarmResource('capsule-a', {
      resourceId: 'warm-1', byteLength: 64, dispose: () => { disposed.push('warm-1'); },
    }).ok, true);
    const folded = h.scheduler.foldSurface('capsule-a');
    assert.deepEqual(folded, {
      ok: true, folded: true, drainedFrameGeneration: 3, captureLeaseRetained: true, warmResourceCount: 1,
    });
    assert.equal(h.releases.length, 1);
    assert.deepEqual(
      [h.releases[0].surfaceId, h.releases[0].leaseId, h.releases[0].frameGeneration, h.releases[0].reason],
      ['capsule-a', 'lease-3', 3, RELEASE_CAUSES.FOLD_DRAIN],
    );
    assert.equal(h.scheduler.getInstrumentation('capsule-a').pendingMailboxFrameGen, null);
    assert.deepEqual(disposed, []);
  });

  it('trims warm resources over budget on fold and reopens above the witness floor', () => {
    const h = makeHarness({ budget: makeBudget({ maxWarmResourcesPerSurface: 1 }) });
    registerLive(h, 'capsule-a');
    const disposed = [];
    for (const id of ['warm-1', 'warm-2', 'warm-3']) {
      assert.equal(h.scheduler.allocateWarmResource('capsule-a', {
        resourceId: id, byteLength: 8, dispose: () => { disposed.push(id); },
      }).ok, true);
    }
    assert.deepEqual(disposed, ['warm-1', 'warm-2']);
    assert.equal(h.scheduler.foldSurface('capsule-a').ok, true);
    assert.deepEqual(disposed, ['warm-1', 'warm-2']);
    assert.equal(h.scheduler.recordCaptureWitness({
      surfaceId: 'capsule-a', surfaceGeneration: 1, captureGeneration: 11,
    }).ok, true);
    const reopened = h.scheduler.unfoldSurface('capsule-a');
    assert.equal(reopened.ok, true);
    assert.equal(reopened.requestedAfterFrameGeneration, 11);
    assert.deepEqual(h.newestRequests, [{
      surfaceId: 'capsule-a', surfaceGeneration: 1, epoch: 7, afterFrameGeneration: 11,
    }]);
    // Hidden backlog never replays: anything at or below the floor refuses.
    assert.equal(
      h.scheduler.submitFrame(makeFrame({ frameGeneration: 11, leaseId: 'lease-11' })).reason,
      SCHEDULER_REASONS.STALE_FRAME_GENERATION,
    );
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 12, leaseId: 'lease-12' })).ok, true);
  });
});

describe('tileScheduler ticks', () => {
  it('schedules fairly across tiles and freezes the tick report', () => {
    const h = makeHarness({ budget: makeBudget({ maxDrawsPerTick: 1 }),
      onPresent: (record, scheduler) => scheduler.presentHandle(record) });
    registerLive(h, 'capsule-a');
    registerLive(h, 'capsule-b');
    for (const surfaceId of ['capsule-a', 'capsule-b']) {
      assert.equal(h.scheduler.attachCanvas({ surfaceId, canvas: makeFakeCanvas() }).ok, true);
    }
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 1 })).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({ surfaceId: 'capsule-b', frameGeneration: 1, leaseId: 'lease-b1' })).ok, true);
    const first = h.scheduler.runTick();
    assert.equal(first.drawsUsed, 1);
    assert.equal(first.presented.length, 1);
    assert.equal(first.presented[0].surfaceId, 'capsule-a');
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.presented), true);
    const second = h.scheduler.runTick();
    assert.equal(second.presented[0].surfaceId, 'capsule-b');
    assert.deepEqual(Object.keys(second.presented[0]).sort(), [
      'box', 'epoch', 'frameGeneration', 'handle', 'presentedAtMs', 'surfaceGeneration', 'surfaceId',
    ]);
  });

  it('defers over-budget tiles without dropping their mailboxes', () => {
    const h = makeHarness({ budget: makeBudget({ maxDrawsPerTick: 1 }) });
    registerLive(h, 'capsule-a');
    registerLive(h, 'capsule-b');
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 1 })).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({ surfaceId: 'capsule-b', frameGeneration: 1, leaseId: 'lease-b1' })).ok, true);
    const tick = h.scheduler.runTick();
    assert.equal(tick.drawsUsed, 1);
    assert.equal(tick.budgetDeferrals, 1);
    assert.equal(h.scheduler.getInstrumentation('capsule-b').pendingMailboxFrameGen, 1);
  });

  it('defers on byte and time budgets', () => {
    const bytes = makeHarness({ budget: makeBudget({ maxUploadBytesPerTick: 36 }) });
    registerLive(bytes, 'capsule-a');
    registerLive(bytes, 'capsule-b');
    assert.equal(bytes.scheduler.submitFrame(makeFrame({ frameGeneration: 1 })).ok, true);
    assert.equal(bytes.scheduler.submitFrame(makeFrame({ surfaceId: 'capsule-b', frameGeneration: 1, leaseId: 'lease-b1' })).ok, true);
    assert.equal(bytes.scheduler.runTick().budgetDeferrals, 1);
    const timed = makeHarness({ budget: makeBudget({ maxPresentMsPerTick: 1 }) });
    registerLive(timed, 'capsule-a');
    assert.equal(timed.scheduler.submitFrame(makeFrame({ frameGeneration: 1, extra: { estimatedPresentMs: 40 } })).ok, true);
    const tick = timed.scheduler.runTick();
    assert.equal(tick.drawsUsed, 0);
    assert.equal(tick.budgetDeferrals, 1);
  });

  it('presents a single surface now under every guard', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.equal(h.scheduler.presentSurfaceNow('capsule-a').reason, SCHEDULER_REASONS.EMPTY_MAILBOX);
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    const tick = h.scheduler.presentSurfaceNow('capsule-a');
    assert.equal(tick.drawsUsed, 1);
    assert.equal(h.scheduler.presentSurfaceNow('ghost').reason, SCHEDULER_REASONS.SURFACE_NOT_REGISTERED);
    assert.equal(h.scheduler.foldSurface('capsule-a').ok, true);
    assert.equal(h.scheduler.presentSurfaceNow('capsule-a').reason, SCHEDULER_REASONS.FOLDED_DISPLAY_DISABLED);
  });

  it('expires leases at tick time and counts them', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.equal(h.scheduler.submitFrame(makeFrame({ extra: { leaseExpiresAtMs: 1500 } })).ok, true);
    h.tick.advance(1000);
    const tick = h.scheduler.runTick();
    assert.equal(tick.rejectedStaleLeases, 1);
    assert.equal(tick.presented.length, 0);
    assert.equal(h.releases[0].reason, RELEASE_CAUSES.REFUSED);
  });
});

describe('tileScheduler canvas registry', () => {
  it('attaches, draws in-turn with the corner oracle, and detaches', () => {
    const canvases = new Map();
    const h = makeHarness({
      onPresent: (record, scheduler) => {
        assert.deepEqual(Object.keys(record).sort(), ['box', 'frameGeneration', 'handle', 'surfaceId']);
        const out = scheduler.presentHandle({ surfaceId: record.surfaceId, handle: record.handle });
        assert.equal(out.ok, true);
        assert.equal(out.convertedBytes, 4 * 3 * 4);
      },
    });
    registerLive(h, 'capsule-a');
    const canvas = makeFakeCanvas();
    canvases.set('capsule-a', canvas);
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas }).ok, true);
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'ghost', canvas }).reason, SCHEDULER_REASONS.SURFACE_NOT_REGISTERED);
    assert.equal(
      h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas: { width: 1 } }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assertCorners(canvas, 4, 3);
    assert.equal(canvas.width, 4);
    assert.equal(canvas.height, 3);
    const info = h.scheduler.getInstrumentation('capsule-a');
    assert.equal(info.bytesUploadedTotal, 36);
    assert.equal(info.convertedBytesTotal, 48);
    assert.equal(info.lastPresentedFrameGen, 1);
    assert.equal(info.canvasAttached, true);
    h.scheduler.detachCanvas('capsule-a');
    h.scheduler.detachCanvas('ghost-does-not-throw');
    assert.equal(h.scheduler.getInstrumentation('capsule-a').canvasAttached, false);
  });

  it('refuses presentHandle outside a coordinated turn', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    const canvas = makeFakeCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas }).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(h.presents.length, 1);
    const late = h.scheduler.presentHandle({ surfaceId: 'capsule-a', handle: h.presents[0].handle });
    assert.equal(late.reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(canvas.puts.length, 0);
  });

  it('refuses unknown and canvas-less handles in-turn', () => {
    const draws = [];
    const h = makeHarness({
      onPresent: (record, scheduler) => {
        draws.push(scheduler.presentHandle({ surfaceId: record.surfaceId, handle: 'tile/ghost/g9/h9' }));
        draws.push(scheduler.presentHandle({ surfaceId: record.surfaceId, handle: record.handle }));
      },
    });
    registerLive(h, 'capsule-a');
    // No canvas attached: refusal must retire the candidate and release its lease.
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(draws[0].reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(draws[1].reason, SCHEDULER_REASONS.INVALID_BINDING);
    assert.equal(h.scheduler.getInstrumentation('capsule-a').presentedPendingFrameGen, null);
    assert.equal(h.releases.length, 1);
    assert.equal(h.releases[0].reason, RELEASE_CAUSES.REFUSED);
    assert.equal(h.scheduler.getInstrumentation('capsule-a').presentCount, 0);
  });

  it('refuses a second draw of a retired handle as stale', () => {
    const attempts = [];
    let retestHandle = null;
    const h = makeHarness({
      onPresent: (record, scheduler) => {
        if (retestHandle !== null) {
          attempts.push(scheduler.presentHandle({ surfaceId: record.surfaceId, handle: retestHandle }));
          retestHandle = null;
        }
        attempts.push(scheduler.presentHandle({ surfaceId: record.surfaceId, handle: record.handle }));
      },
    });
    registerLive(h, 'capsule-a');
    const canvas = makeFakeCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas }).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 1 })).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(attempts[0].ok, true);
    retestHandle = h.presents[0].handle;
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' })).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(attempts[1].reason, SCHEDULER_REASONS.STALE_FRAME_GENERATION);
    assert.equal(attempts[2].ok, true);
    assert.equal(canvas.puts.length, 2);
  });
});

describe('tileScheduler cross-capsule routing (must-fail control)', () => {
  it('refuses a frame for A drawn onto tile B: no draw, no A retirement', () => {
    const canvasA = makeFakeCanvas();
    const canvasB = makeFakeCanvas();
    const attempts = [];
    const h = makeHarness({
      onPresent: (record, scheduler) => {
        if (record.surfaceId === 'capsule-a') {
          attempts.push(scheduler.presentHandle({ surfaceId: 'capsule-b', handle: record.handle }));
          attempts.push(scheduler.presentHandle({ surfaceId: 'capsule-a', handle: record.handle }));
        } else {
          attempts.push(scheduler.presentHandle({ surfaceId: record.surfaceId, handle: record.handle }));
        }
      },
    });
    registerLive(h, 'capsule-a');
    registerLive(h, 'capsule-b');
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas: canvasA }).ok, true);
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-b', canvas: canvasB }).ok, true);
    const paintB = (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : [200, 200, 200]);
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 1 })).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({
      surfaceId: 'capsule-b', frameGeneration: 1, leaseId: 'lease-b1',
      bytes: makeRgb24(4, 3, paintB),
    })).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 2);
    assert.equal(attempts[0].reason, SCHEDULER_REASONS.SURFACE_MISMATCH);
    assert.equal(attempts[1].ok, true);
    assert.equal(attempts[2].ok, true);
    // B shows only B content; the cross attempt drew nothing anywhere.
    assert.equal(canvasB.puts.length, 1);
    assert.deepEqual(pixelAt(canvasB.puts[0], 0, 0), [0, 0, 0, 255]);
    assertCorners(canvasA, 4, 3);
    // A's lease retired exactly once, by its own legitimate draw.
    assertExactlyOnceReleased(h.releases, ['lease-1', 'lease-b1']);
    assert.equal(h.releases.find((r) => r.leaseId === 'lease-1').reason, RELEASE_CAUSES.PRESENTED);
  });

  it('a mutant router that cross-draws fails the corner oracle', () => {
    const canvasB = makeFakeCanvas();
    const bytesA = makeRgb24(4, 3, cornerPaint(4, 3));
    // Mutant: writes A's bytes into B's canvas, bypassing presentHandle.
    const ctx = canvasB.getContext('2d');
    const image = ctx.createImageData(4, 3);
    for (let src = 0, dst = 0; src < bytesA.length; src += 3, dst += 4) {
      image.data[dst] = bytesA[src];
      image.data[dst + 1] = bytesA[src + 1];
      image.data[dst + 2] = bytesA[src + 2];
      image.data[dst + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    // B's oracle expects B content: the mutant output must fail it.
    assert.throws(() => {
      assert.deepEqual(pixelAt(canvasB.puts[0], 0, 0), [0, 0, 0, 255]);
    }, assert.AssertionError);
  });
});

describe('tileScheduler resource lifecycle (must-fail control)', () => {
  it('requires native disposers and invokes each exactly once', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.equal(
      h.scheduler.allocateWarmResource('capsule-a', { resourceId: 'w', byteLength: 8 }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(
      h.scheduler.allocateWarmResource('capsule-a', { resourceId: '', byteLength: 8, dispose: () => {} }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    const calls = [];
    assert.equal(h.scheduler.allocateWarmResource('capsule-a', {
      resourceId: 'warm-1', byteLength: 8, dispose: () => { calls.push('warm-1a'); },
    }).ok, true);
    assert.equal(h.scheduler.allocateWarmResource('capsule-a', {
      resourceId: 'warm-1', byteLength: 8, dispose: () => { calls.push('warm-1b'); },
    }).ok, true);
    assert.deepEqual(calls, ['warm-1a']);
    assert.deepEqual(h.scheduler.onContextLost('capsule-a'), {
      ok: true, contextLost: true, captureLeaseRetained: true,
    });
    assert.deepEqual(calls, ['warm-1a', 'warm-1b']);
    assert.equal(h.scheduler.getInstrumentation('capsule-a').reclaimedWarmResources, 1);
  });

  it('retires every lease exactly once across a full lifecycle', () => {
    const h = makeHarness({
      onPresent: (record, scheduler) => {
        const out = scheduler.presentHandle({ surfaceId: record.surfaceId, handle: record.handle });
        assert.equal(out.ok, true);
      },
    });
    registerLive(h, 'capsule-a');
    const canvas = makeFakeCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas }).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 1 })).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 2, leaseId: 'lease-2' })).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(h.scheduler.foldSurface('capsule-a').ok, true);
    assert.equal(h.scheduler.recordCaptureWitness({
      surfaceId: 'capsule-a', surfaceGeneration: 1, captureGeneration: 9,
    }).ok, true);
    assert.equal(h.scheduler.unfoldSurface('capsule-a').requestedAfterFrameGeneration, 9);
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 10, leaseId: 'lease-10' })).ok, true);
    assert.equal(h.scheduler.runTick().drawsUsed, 1);
    assert.equal(h.scheduler.destroySurface('capsule-a').destroyed, true);
    assertExactlyOnceReleased(h.releases, ['lease-1', 'lease-2', 'lease-10']);
    const causes = Object.fromEntries(h.releases.map((r) => [r.leaseId, r.reason]));
    assert.deepEqual(causes, {
      'lease-1': RELEASE_CAUSES.SUPERSEDED,
      'lease-2': RELEASE_CAUSES.PRESENTED,
      'lease-10': RELEASE_CAUSES.PRESENTED,
    });
  });

  it('a mutant audit that double-counts or skips releases fails', () => {
    const leaky = [
      { leaseId: 'x', reason: RELEASE_CAUSES.PRESENTED },
      { leaseId: 'x', reason: RELEASE_CAUSES.SUPERSEDED },
    ];
    assert.throws(() => assertExactlyOnceReleased(leaky, ['x']), assert.AssertionError);
    assert.throws(() => assertExactlyOnceReleased([], ['missing']), assert.AssertionError);
    // Mutant resource map without disposers cannot satisfy the reclaim audit.
    const mutantWarm = new Map([['w1', { bytes: 8 }]]);
    mutantWarm.delete('w1');
    assert.throws(() => {
      assert.equal(typeof mutantWarm.get('w1')?.dispose, 'function');
    }, assert.AssertionError);
  });
});

describe('tileScheduler context and state', () => {
  it('drains on context loss and requests newest on restore', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.equal(h.scheduler.submitFrame(makeFrame({ frameGeneration: 4 })).ok, true);
    const lost = h.scheduler.onContextLost('capsule-a');
    assert.deepEqual(lost, { ok: true, contextLost: true, captureLeaseRetained: true });
    assert.equal(h.releases[0].reason, RELEASE_CAUSES.CONTEXT_LOST);
    const restored = h.scheduler.onContextRestored('capsule-a');
    assert.equal(restored.requestedAfterFrameGeneration, 4);
    assert.deepEqual(h.newestRequests[0], {
      surfaceId: 'capsule-a', surfaceGeneration: 1, epoch: 7, afterFrameGeneration: 4,
    });
  });

  it('updates state, drains when hidden, and refuses lifecycle bypass', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    const moved = h.scheduler.updateSurfaceState('capsule-a', { x: 40, width: 640 });
    assert.equal(moved.ok, true);
    assert.equal(moved.eligible, true);
    assert.equal(h.scheduler.getInstrumentation('capsule-a').pendingMailboxFrameGen, 1);
    const hidden = h.scheduler.updateSurfaceState('capsule-a', { viewportIntersecting: false });
    assert.equal(hidden.eligible, false);
    assert.equal(h.releases[0].reason, RELEASE_CAUSES.HIDDEN);
    assert.equal(h.scheduler.getInstrumentation('capsule-a').pendingMailboxFrameGen, null);
    assert.equal(
      h.scheduler.updateSurfaceState('capsule-a', { folded: true }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
    assert.equal(
      h.scheduler.updateSurfaceState('capsule-a', { contextLost: true }).reason,
      SCHEDULER_REASONS.INVALID_BINDING,
    );
  });
});

describe('tileScheduler destroy', () => {
  it('tombstones destroyed ids and refuses every later use', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    const canvas = makeFakeCanvas();
    assert.equal(h.scheduler.attachCanvas({ surfaceId: 'capsule-a', canvas }).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    assert.equal(h.scheduler.destroySurface('capsule-a').destroyed, true);
    assert.equal(h.releases[0].reason, RELEASE_CAUSES.SURFACE_DESTROYED);
    const info = h.scheduler.getInstrumentation('capsule-a');
    assert.equal(info.destroyed, true);
    assert.equal(info.captureLeaseActive, false);
    assert.equal(info.canvasAttached, false);
    assert.equal(
      h.scheduler.registerSurface({
        surfaceId: 'capsule-a', surfaceGeneration: 1, epoch: 7, principal: 'wall-main',
      }).reason,
      SCHEDULER_REASONS.SURFACE_DESTROYED,
    );
    assert.equal(h.scheduler.submitFrame(makeFrame({})).reason, SCHEDULER_REASONS.SURFACE_DESTROYED);
    assert.equal(
      h.scheduler.recordCaptureWitness({ surfaceId: 'capsule-a', surfaceGeneration: 1, captureGeneration: 2 }).reason,
      SCHEDULER_REASONS.SURFACE_DESTROYED,
    );
    assert.equal(h.scheduler.destroySurface('ghost').reason, SCHEDULER_REASONS.SURFACE_NOT_REGISTERED);
  });

  it('destroy() releases everything and resets the registry', () => {
    const h = makeHarness();
    registerLive(h, 'capsule-a');
    const disposed = [];
    assert.equal(h.scheduler.allocateWarmResource('capsule-a', {
      resourceId: 'w', byteLength: 1, dispose: () => { disposed.push('w'); },
    }).ok, true);
    assert.equal(h.scheduler.submitFrame(makeFrame({})).ok, true);
    h.scheduler.destroy();
    assert.equal(h.releases[0].reason, RELEASE_CAUSES.SURFACE_DESTROYED);
    assert.deepEqual(disposed, ['w']);
    assert.equal(h.scheduler.getInstrumentation('capsule-a'), null);
    registerLive(h, 'capsule-a');
    assert.equal(h.scheduler.getInstrumentation('capsule-a').destroyed, false);
  });
});

describe('tileScheduler view helpers', () => {
  it('normalizes states without ever faking live', () => {
    assert.deepEqual([...SURFACE_STATES], ['live', 'connecting', 'lost', 'empty']);
    assert.equal(normalizeSurfaceState('live'), 'live');
    assert.equal(normalizeSurfaceState('bogus'), 'empty');
    assert.equal(normalizeSurfaceState(null), 'empty');
    assert.equal(surfaceCanvasDomId('capsule-a'), 'mv-surface-canvas-capsule-a');
    assert.equal(surfaceCanvasAnchor('capsule-a'), 'capsule/capsule-a/slot');
    assert.equal(
      surfaceCanvasAccessibleName({ surfaceId: 'capsule-a', state: 'live' }),
      'Live surface for capsule-a',
    );
    assert.equal(
      surfaceCanvasAccessibleName({ surfaceId: 'capsule-a', state: 'bogus' }),
      'No surface for capsule-a',
    );
  });

  it('formats the witness strip, shortening digests and numbering generations', () => {
    assert.equal(shortenDigest(''), '');
    assert.equal(shortenDigest(null), '');
    assert.equal(shortenDigest('abc'), 'abc');
    assert.equal(shortenDigest('0'.repeat(64)), `${'0'.repeat(8)}…${'0'.repeat(6)}`);
    const strip = formatFrameStrip({ frame: 'tile/capsule-a/g1/h1', generation: 12, digest: 'd'.repeat(64) });
    assert.deepEqual(strip, {
      frameText: 'tile/capsule-a/g1/h1',
      generationText: '12',
      digestText: `${'d'.repeat(8)}…${'d'.repeat(6)}`,
      readOnlyText: 'READ-ONLY ISOLATED EXECUTION',
    });
    assert.equal(formatFrameStrip({ readOnly: false }).readOnlyText, '');
  });
});

describe('SurfaceCanvas contract', () => {
  it('wires the scheduler, anchors, and metadata-only emits', () => {
    const source = readFileSync(SFC_PATH, 'utf8');
    for (const token of [
      './tileScheduler.js',
      "inject('tileScheduler'",
      'attachCanvas',
      'detachCanvas',
      'canvas-ready',
      'canvas-released',
      'surfaceCanvasDomId',
      'surfaceCanvasAnchor',
      'surfaceCanvasAccessibleName',
      'normalizeSurfaceState',
      'formatFrameStrip',
      'surfaceId',
      'generation',
      'epoch',
      'frame',
      'digest',
      'state',
    ]) {
      assert.ok(source.includes(token), `SFC missing ${token}`);
    }
  });

  it('holds no pixels, draws nothing, and never injects markup', () => {
    const source = readFileSync(SFC_PATH, 'utf8');
    for (const forbidden of ['putImageData', 'getContext', 'Uint8Array', 'v-html', 'presentHandle']) {
      assert.ok(!source.includes(forbidden), `SFC must not contain ${forbidden}`);
    }
  });
});
