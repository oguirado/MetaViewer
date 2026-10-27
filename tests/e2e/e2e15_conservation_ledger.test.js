'use strict';
// E2E Item 7: Conservation ledger (E6, E7)
// Cites SW-0269 C2 (E6), SW-0269 I1-I3 (E7).

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Item 7: Real tileScheduler conserves accepted == presented + dropped + queued across operations (E6, E7)', async () => {
  const { createTileScheduler } = await import('../../ui/src/surfaces/tileScheduler.js');
  const releases = [];
  const presented = new Set();
  const accepted = new Set();

  const scheduler = createTileScheduler({
    budget: Object.freeze({
      maxDrawsPerTick: 1, maxUploadBytesPerTick: 100,
      maxPresentMsPerTick: 8, maxWarmResourcesPerSurface: 0, maxDrainSteps: 4
    }),
    clock: () => 0,
    onReleaseLease: (event) => releases.push(event),
    onPresent: (event) => {
      assert.equal(scheduler.presentHandle(event).ok, true);
      presented.add(event.frameGeneration);
    },
  });

  assert.equal(scheduler.registerSurface({
    surfaceId: 'surf-a', surfaceGeneration: 1, epoch: 1,
    principal: 'core', state: { width: 1, height: 1, viewportIntersecting: true }
  }).ok, true);

  const draws = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (image) => draws.push(image),
    })
  };
  assert.equal(scheduler.attachCanvas({ surfaceId: 'surf-a', canvas }).ok, true);

  function checkConservation() {
    const stats = scheduler.getInstrumentation('surf-a');
    const dropped = new Set(releases.filter((e) => accepted.has(e.frameGeneration) && !presented.has(e.frameGeneration))
      .map((e) => e.frameGeneration));
    const queued = !stats || stats.destroyed || stats.pendingMailboxFrameGen === null ? 0 : 1;
    assert.equal(accepted.size, presented.size + dropped.size + queued,
      `accepted (${accepted.size}) must equal presented (${presented.size}) + dropped (${dropped.size}) + queued (${queued})`);
  }

  function submit(gen) {
    const res = scheduler.submitFrame({
      surfaceId: 'surf-a', surfaceGeneration: 1, epoch: 1,
      principal: 'core', frameGeneration: gen, leaseId: `lease-${gen}`, width: 1, height: 1,
      byteLength: 3, bytes: new Uint8Array(3)
    });
    if (res.ok) accepted.add(gen);
    checkConservation();
    return res;
  }

  assert.equal(submit(1).ok, true);
  assert.equal(submit(2).ok, true);
  checkConservation();

  assert.equal(scheduler.runTick().presented.length, 1);
  checkConservation();
  assert.equal(draws.length, 1);
  assert.deepEqual([...presented], [2]);

  scheduler.destroy();
});

test('Item 7: Negative controls - Undrawn frame callback does not count as presented (E6, E7)', async () => {
  const { createTileScheduler } = await import('../../ui/src/surfaces/tileScheduler.js');
  const releases = [];
  const scheduler = createTileScheduler({
    budget: Object.freeze({
      maxDrawsPerTick: 1, maxUploadBytesPerTick: 100,
      maxPresentMsPerTick: 8, maxWarmResourcesPerSurface: 0, maxDrainSteps: 4
    }),
    clock: () => 0,
    onPresent: () => {},
    onReleaseLease: (event) => releases.push(event),
  });

  scheduler.registerSurface({
    surfaceId: 'surf-b', surfaceGeneration: 1, epoch: 1,
    principal: 'core', state: { width: 1, height: 1, viewportIntersecting: true }
  });

  assert.equal(scheduler.submitFrame({
    surfaceId: 'surf-b', surfaceGeneration: 1, epoch: 1,
    principal: 'core', frameGeneration: 10, leaseId: 'lease-undrawn', width: 1, height: 1,
    byteLength: 3, bytes: new Uint8Array(3)
  }).ok, true);

  assert.equal(scheduler.runTick().presented.length, 0);
  assert.equal(scheduler.getInstrumentation('surf-b').presentCount, 0);
  assert.equal(releases.length, 1);

  scheduler.destroy();
});
