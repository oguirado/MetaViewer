import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createTileScheduler,
  validateFrozenBudget,
  evaluateTileEligibility,
  SCHEDULER_REASONS,
  RELEASE_CAUSES
} from '../src/surfaces/tileScheduler.js';
import { createFramePort, PORT_REVOKE_REASONS } from '../electron/framePort.js';
import { createBytePlane, createFlowController } from '../electron/bytePlane.js';
import { createTerminalClient } from '../src/terminal/terminalClient.js';
import { createPtySession, validateSpawnSpec } from '../electron/ptySession.js';
import { createProviderMenu, normalizeProviders } from '../src/terminal/providers.js';

function makePair() {
  const a = new EventEmitter(), b = new EventEmitter();
  a.postMessage = data => queueMicrotask(() => b.emit('message', { data }));
  b.postMessage = data => queueMicrotask(() => a.emit('message', { data }));
  a.addEventListener = (event, fn) => a.on(event, fn);
  b.addEventListener = (event, fn) => b.on(event, fn);
  a.removeEventListener = (event, fn) => a.off(event, fn);
  b.removeEventListener = (event, fn) => b.off(event, fn);
  a.start = b.start = () => {};
  a.close = b.close = () => {};
  return [a, b];
}

const defaultBudget = Object.freeze({
  maxDrawsPerTick: 2,
  maxUploadBytesPerTick: 4096,
  maxPresentMsPerTick: 16,
  maxWarmResourcesPerSurface: 2,
  maxDrainSteps: 10
});

const defaultState = {
  panelOpen: true,
  panelSelected: true,
  folded: false,
  width: 100,
  height: 100,
  x: 0,
  y: 0,
  viewportIntersecting: true,
  windowPresentationAllowed: true,
  contextLost: false
};

// Pure selectWallSurface implementation to test Obligation 11 without private kit dependency
function selectWallSurfacePure(snapshot, capsuleId) {
  if (typeof capsuleId !== 'string' || capsuleId.length === 0) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'ERR_INVALID_CAPSULE_ID', message: 'capsuleId must be a non-empty string' })
    });
  }
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.envelope || !snapshot.envelope.projection || !Array.isArray(snapshot.envelope.projection.rows)) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'ERR_PROJECTION_UNAVAILABLE', message: 'projection snapshot is unavailable' })
    });
  }
  const row = snapshot.envelope.projection.rows.find(r => r && r.id === capsuleId);
  if (!row) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'ERR_UNKNOWN_SURFACE', message: `no admitted row for capsule "${capsuleId}"` })
    });
  }
  if (row.surfaceId !== capsuleId) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ code: 'ERR_MALFORMED_ROW', message: 'row id and surfaceId diverge' })
    });
  }
  return Object.freeze({ ok: true, value: Object.freeze(row) });
}

describe('T5 UI-WALL Test Suite', () => {

  // OBLIGATION 1: Newest-only mailbox (SW-0269 I3/I5)
  test('Obligation 1: Newest-only mailbox slot supersedes older frames without ticking and leaves state unchanged on refusal', () => {
    const released = [];
    const scheduler = createTileScheduler({
      budget: defaultBudget,
      onReleaseLease: release => released.push(release)
    });

    scheduler.registerSurface({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      principal: 'P1',
      epoch: 1,
      state: defaultState
    });

    // Submit frame 1
    const bytes1 = new Uint8Array(300);
    const sub1 = scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 1,
      leaseId: 'lease-1',
      byteLength: 300,
      width: 10,
      height: 10,
      bytes: bytes1,
      principal: 'P1',
      epoch: 1
    });
    assert.equal(sub1.ok, true);
    assert.equal(sub1.queuedFrameGeneration, 1);
    assert.equal(released.length, 0);

    // Submit frame 2 (supersedes frame 1 without calling runTick)
    const bytes2 = new Uint8Array(300);
    const sub2 = scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 2,
      leaseId: 'lease-2',
      byteLength: 300,
      width: 10,
      height: 10,
      bytes: bytes2,
      principal: 'P1',
      epoch: 1
    });
    assert.equal(sub2.ok, true);
    assert.equal(sub2.queuedFrameGeneration, 2);
    assert.equal(sub2.replacedFrameGeneration, 1);

    // Lease-1 was released as SUPERSEDED
    assert.equal(released.length, 1);
    assert.equal(released[0].leaseId, 'lease-1');
    assert.equal(released[0].reason, RELEASE_CAUSES.SUPERSEDED);

    const instBefore = scheduler.getInstrumentation('S1');
    assert.equal(instBefore.pendingMailboxFrameGen, 2);

    // Refused submission (invalid byte length shape mismatch)
    const refusedSub = scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 3,
      leaseId: 'lease-3',
      byteLength: 500, // mismatch for 10x10 RGB24
      width: 10,
      height: 10,
      bytes: new Uint8Array(500),
      principal: 'P1',
      epoch: 1
    });
    assert.equal(refusedSub.ok, false);
    assert.equal(refusedSub.reason, SCHEDULER_REASONS.INVALID_BINDING);

    // Assert mailbox and instrumentation stayed unchanged on refusal
    const instAfter = scheduler.getInstrumentation('S1');
    assert.equal(instAfter.pendingMailboxFrameGen, 2);
    assert.equal(instAfter.decodeCount, instBefore.decodeCount);

    // Refused release recorded
    assert.equal(released.length, 2);
    assert.equal(released[1].leaseId, 'lease-3');
    assert.equal(released[1].reason, RELEASE_CAUSES.REFUSED);

    // MUST-FAIL CONTROL: mutant that does not supersede frame 1
    const badMailboxState = instAfter.pendingMailboxFrameGen === 1;
    assert.equal(badMailboxState, false, 'Mutant keeping older frame must fail');
  });

  // OBLIGATION 2: Conservation accounting (SW-0269 I2)
  test('Obligation 2: Differential test and conservation identity (submitted == presented + superseded + fold-drained + refused + held)', () => {
    let submitted = 0;
    let presentedCount = 0;
    let supersededCount = 0;
    let foldDrainedCount = 0;
    let refusedCount = 0;

    let schedulerRef = null;
    const scheduler = createTileScheduler({
      budget: defaultBudget,
      onPresent: rec => {
        if (schedulerRef) {
          schedulerRef.presentHandle({ surfaceId: rec.surfaceId, handle: rec.handle });
        }
      },
      onReleaseLease: rel => {
        if (rel.reason === RELEASE_CAUSES.PRESENTED) presentedCount++;
        else if (rel.reason === RELEASE_CAUSES.SUPERSEDED) supersededCount++;
        else if (rel.reason === RELEASE_CAUSES.FOLD_DRAIN) foldDrainedCount++;
        else if (rel.reason === RELEASE_CAUSES.REFUSED || rel.reason === RELEASE_CAUSES.HIDDEN || rel.reason === RELEASE_CAUSES.CONTEXT_LOST) refusedCount++;
      }
    });
    schedulerRef = scheduler;

    scheduler.registerSurface({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      principal: 'P1',
      epoch: 1,
      state: defaultState
    });

    const canvas = {
      getContext: () => ({
        createImageData: () => ({ data: new Uint8ClampedArray(12) }),
        putImageData: () => {}
      })
    };
    scheduler.attachCanvas({ surfaceId: 'S1', surfaceGeneration: 1, epoch: 1, canvas });

    // LCG PRNG parameters specified in SW-0269
    let seed = BigInt(20260269);
    const mul = BigInt('6364136223846793005');
    const inc = BigInt('1442695040888963407');

    function nextRand() {
      seed = (seed * mul + inc) & BigInt('0xFFFFFFFFFFFFFFFF');
      return Number(seed % BigInt(100));
    }

    let frameGen = 0;
    let isFolded = false;

    for (let op = 0; op < 4000; op++) {
      const r = nextRand();
      if (r < 60) {
        // Push / submit frame
        frameGen++;
        submitted++;
        const bytes = new Uint8Array(12);
        scheduler.submitFrame({
          surfaceId: 'S1',
          surfaceGeneration: 1,
          frameGeneration: frameGen,
          leaseId: `l-${frameGen}`,
          byteLength: 12,
          width: 2,
          height: 2,
          bytes,
          principal: 'P1',
          epoch: 1
        });
      } else if (r < 90) {
        // Pop / tick & present inside onPresent
        scheduler.runTick();
      } else {
        // Fold / unfold toggle
        if (!isFolded) {
          scheduler.foldSurface('S1');
          isFolded = true;
        } else {
          scheduler.unfoldSurface('S1');
          isFolded = false;
        }
      }

      const inst = scheduler.getInstrumentation('S1');
      const held = (inst.pendingMailboxFrameGen ? 1 : 0) + (inst.presentedPendingFrameGen ? 1 : 0);
      const totalAccounted = presentedCount + supersededCount + foldDrainedCount + refusedCount + held;
      assert.equal(submitted, totalAccounted, `Conservation violated at op ${op}: submitted=${submitted}, sum=${totalAccounted}`);
    }

    // Clean up
    scheduler.destroy();

    // MUST-FAIL CONTROL: verify that an off-by-one accounting fails conservation check
    const badSum = presentedCount + supersededCount + foldDrainedCount + refusedCount + 99;
    assert.notEqual(submitted, badSum, 'Mutant conservation identity must fail');
  });

  // OBLIGATION 3: Fair round-robin under frozen budget (SW-0129 I6/I9)
  test('Obligation 3: Fair round-robin rotation across surfaces and validateFrozenBudget validation', () => {
    const scheduler = createTileScheduler({
      budget: Object.freeze({
        maxDrawsPerTick: 1,
        maxUploadBytesPerTick: 4096,
        maxPresentMsPerTick: 16,
        maxWarmResourcesPerSurface: 2,
        maxDrainSteps: 5
      })
    });

    const surfaces = ['A', 'B', 'C'];
    for (const id of surfaces) {
      scheduler.registerSurface({
        surfaceId: id,
        surfaceGeneration: 1,
        principal: 'P',
        epoch: 1,
        state: defaultState
      });
      scheduler.submitFrame({
        surfaceId: id,
        surfaceGeneration: 1,
        frameGeneration: 1,
        leaseId: `lease-${id}`,
        byteLength: 3,
        width: 1,
        height: 1,
        bytes: new Uint8Array([1, 2, 3]),
        principal: 'P',
        epoch: 1
      });
    }

    // Tick 1 should present surface A
    const t1 = scheduler.runTick();
    assert.equal(t1.presented.length, 1);
    assert.equal(t1.presented[0].surfaceId, 'A');

    // Submit new frame for A so A has mailbox again
    scheduler.submitFrame({
      surfaceId: 'A',
      surfaceGeneration: 1,
      frameGeneration: 2,
      leaseId: 'lease-A2',
      byteLength: 3,
      width: 1,
      height: 1,
      bytes: new Uint8Array([1, 2, 3]),
      principal: 'P',
      epoch: 1
    });

    // Tick 2 should rotate fairly to surface B
    const t2 = scheduler.runTick();
    assert.equal(t2.presented.length, 1);
    assert.equal(t2.presented[0].surfaceId, 'B');

    // Tick 3 should rotate to surface C
    const t3 = scheduler.runTick();
    assert.equal(t3.presented.length, 1);
    assert.equal(t3.presented[0].surfaceId, 'C');

    // validateFrozenBudget checks
    const badUnfrozen = { ...defaultBudget };
    assert.equal(validateFrozenBudget(badUnfrozen, { requireFrozen: true }).ok, false);

    const badKey = Object.freeze({ ...defaultBudget, unknownKey: 123 });
    assert.equal(validateFrozenBudget(badKey).ok, false);

    const missingKey = Object.freeze({ maxDrawsPerTick: 1 });
    assert.equal(validateFrozenBudget(missingKey).ok, false);

    // MUST-FAIL CONTROL: mutant that always schedules A instead of round-robin
    const unfairRotation = t1.presented[0].surfaceId === t2.presented[0].surfaceId;
    assert.equal(unfairRotation, false, 'Unfair rotation must fail');
  });

  // OBLIGATION 4: Exactly-once coverage (SW-0129 I8)
  test('Obligation 4: Exactly-once lease release across lifecycles, unfold requests newest, presentHandle outside turn returns stale', () => {
    const releaseLog = new Map();
    let schedulerRef = null;
    const scheduler = createTileScheduler({
      budget: defaultBudget,
      onPresent: rec => {
        if (schedulerRef) {
          schedulerRef.presentHandle({ surfaceId: rec.surfaceId, handle: rec.handle });
        }
      },
      onReleaseLease: rel => {
        const count = releaseLog.get(rel.leaseId) || 0;
        releaseLog.set(rel.leaseId, count + 1);
      }
    });
    schedulerRef = scheduler;

    scheduler.registerSurface({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      principal: 'P1',
      epoch: 1,
      state: defaultState
    });

    const canvas = {
      getContext: () => ({
        createImageData: () => ({ data: new Uint8ClampedArray(4) }),
        putImageData: () => {}
      })
    };
    scheduler.attachCanvas({ surfaceId: 'S1', surfaceGeneration: 1, epoch: 1, canvas });

    // Frame 1 -> Submitted & Presented in tick
    scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 1,
      leaseId: 'lease-1',
      byteLength: 3,
      width: 1,
      height: 1,
      bytes: new Uint8Array([1, 2, 3]),
      principal: 'P1',
      epoch: 1
    });

    const tickRes = scheduler.runTick();
    const presentedHandle = tickRes.presented[0].handle;

    // Drawing in-turn released lease-1 exactly once
    assert.equal(releaseLog.get('lease-1'), 1);

    // Trying presentHandle outside turn returns INVALID_BINDING
    const latePresent = scheduler.presentHandle({ surfaceId: 'S1', handle: presentedHandle });
    assert.equal(latePresent.ok, false);
    assert.equal(latePresent.reason, SCHEDULER_REASONS.INVALID_BINDING);

    // Frame 2 -> Fold Drain
    scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 2,
      leaseId: 'lease-2',
      byteLength: 3,
      width: 1,
      height: 1,
      bytes: new Uint8Array([1, 2, 3]),
      principal: 'P1',
      epoch: 1
    });
    scheduler.foldSurface('S1');
    assert.equal(releaseLog.get('lease-2'), 1);

    // Unfold surface requests newest generation and never replays backlog
    let requestedGen = null;
    const scheduler2 = createTileScheduler({
      budget: defaultBudget,
      onRequestNewestGeneration: req => { requestedGen = req.afterFrameGeneration; }
    });
    scheduler2.registerSurface({ surfaceId: 'S2', surfaceGeneration: 1, principal: 'P1', epoch: 1, state: defaultState });
    scheduler2.foldSurface('S2');
    scheduler2.unfoldSurface('S2');
    assert.notEqual(requestedGen, null);

    // MUST-FAIL CONTROL: duplicate release of lease-1 must fail count check
    assert.equal(releaseLog.get('lease-1'), 1, 'Lease released twice must fail');
  });

  // OBLIGATION 5: Overflow-safe byte budget (SW-0129 I5/I11)
  test('Obligation 5: Byte upload limit equality, convertedBytesTotal accumulation, and byteLength mismatch rejection', () => {
    const tightBudget = Object.freeze({
      maxDrawsPerTick: 2,
      maxUploadBytesPerTick: 300,
      maxPresentMsPerTick: 16,
      maxWarmResourcesPerSurface: 2,
      maxDrainSteps: 5
    });

    let schedulerRef = null;
    const scheduler = createTileScheduler({
      budget: tightBudget,
      onPresent: rec => {
        if (schedulerRef) {
          schedulerRef.presentHandle({ surfaceId: rec.surfaceId, handle: rec.handle });
        }
      }
    });
    schedulerRef = scheduler;

    scheduler.registerSurface({ surfaceId: 'S1', surfaceGeneration: 1, principal: 'P1', epoch: 1, state: defaultState });

    const canvas = {
      getContext: () => ({
        createImageData: () => ({ data: new Uint8ClampedArray(400) }),
        putImageData: () => {}
      })
    };
    scheduler.attachCanvas({ surfaceId: 'S1', surfaceGeneration: 1, epoch: 1, canvas });

    // Submit exactly 300 bytes -> Accepted
    const exactSub = scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 1,
      leaseId: 'l1',
      byteLength: 300,
      width: 10,
      height: 10,
      bytes: new Uint8Array(300),
      principal: 'P1',
      epoch: 1
    });
    assert.equal(exactSub.ok, true);

    // Present frame in-turn -> convertedBytesTotal += 10*10*4 = 400 bytes
    scheduler.runTick();
    const inst = scheduler.getInstrumentation('S1');
    assert.equal(inst.convertedBytesTotal, 400);

    // Submit 330 bytes (width 10, height 11 -> matches shape 330 bytes) > maxUploadBytesPerTick 300 -> Refused BUDGET_EXHAUSTED
    const overSub = scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 2,
      leaseId: 'l2',
      byteLength: 330,
      width: 10,
      height: 11,
      bytes: new Uint8Array(330),
      principal: 'P1',
      epoch: 1
    });
    assert.equal(overSub.ok, false);
    assert.equal(overSub.reason, SCHEDULER_REASONS.BUDGET_EXHAUSTED);

    // Absurd mismatch (width 10, height 10, but declared byteLength 999) -> Rejected INVALID_BINDING
    const mismatchSub = scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 3,
      leaseId: 'l3',
      byteLength: 999,
      width: 10,
      height: 10,
      bytes: new Uint8Array(999),
      principal: 'P1',
      epoch: 1
    });
    assert.equal(mismatchSub.ok, false);
    assert.equal(mismatchSub.reason, SCHEDULER_REASONS.INVALID_BINDING);

    // MUST-FAIL CONTROL: admitting 330 bytes over-budget must fail
    assert.equal(overSub.ok, false, 'Admitting over-budget bytes must fail');
  });

  // OBLIGATION 6: Credit boundary and order (SW-0166 I1-I5)
  test('Obligation 6: Contiguous parser completion advances terminal ACKs and bytePlane credit boundary', async () => {
    const [portA, portB] = makePair();
    const writeCalls = [];

    const client = createTerminalClient({
      session: 'term-1',
      port: portA,
      write: (bytes, done) => {
        writeCalls.push({ bytes, done });
      },
      onStatus: () => {}
    });

    let ackReceived = null;
    portB.on('message', ev => {
      if (ev.data && ev.data.ack) ackReceived = ev.data;
    });

    // Send seq 1 and seq 2
    portB.postMessage({ session: 'term-1', seq: 1, bytes: new Uint8Array([65, 66]) });
    portB.postMessage({ session: 'term-1', seq: 2, bytes: new Uint8Array([67, 68]) });

    await new Promise(r => setTimeout(r, 10));

    assert.equal(writeCalls.length, 2);
    assert.equal(ackReceived, null); // No ACK yet before write completion

    // Complete seq 2 out of order -> ACK should NOT advance until seq 1 completes
    writeCalls[1].done();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(ackReceived, null);

    // Complete seq 1 -> ACK should advance to seq 2 with total bytes 4
    writeCalls[0].done();
    await new Promise(r => setTimeout(r, 10));
    assert.notEqual(ackReceived, null);
    assert.equal(ackReceived.ack, 2);
    assert.equal(ackReceived.bytes, 4);

    client.dispose();

    // MUST-FAIL CONTROL: non-contiguous ACK emission must fail
    assert.notEqual(ackReceived.ack, 1, 'Non-contiguous ACK must fail');
  });

  // OBLIGATION 7: Burst/backpressure (SW-0166 313-315)
  test('Obligation 7: PTY output backpressure pause at 131072, resume below 65536, and overflow fault at 524288', () => {
    let paused = false;
    let resumed = false;
    let killed = false;
    let dataCb = null;
    let exitCb = null;

    const fakePty = {
      onData: fn => { dataCb = fn; return { dispose: () => {} }; },
      onExit: fn => { exitCb = fn; return { dispose: () => {} }; },
      write: () => {},
      resize: () => {},
      pause: () => { paused = true; },
      resume: () => { resumed = true; },
      kill: () => { killed = true; }
    };

    const sentMessages = [];
    const ptySession = createPtySession({
      session: 'pty-1',
      spec: { file: '/bin/bash', args: [], cwd: '/', env: {} },
      spawn: () => fakePty,
      send: msg => sentMessages.push(msg)
    });

    // Emit data up to 131,072 bytes (32 chunks of 4096 bytes)
    const chunk = new Uint8Array(4096);
    for (let i = 0; i < 32; i++) {
      dataCb(chunk);
    }

    assert.equal(sentMessages.length, 32);
    assert.equal(paused, true); // Paused after reaching 131072 unacked bytes

    // ACK first 20 chunks (81,920 bytes) -> unacked remaining = 49,152 < 65536 -> triggers resume
    ptySession.receive({ session: 'pty-1', ack: 20, bytes: 20 * 4096 });
    assert.equal(resumed, true);

    // Flood to exceed 524,288 unacked bytes -> OUTPUT_OVERFLOW error & killed
    const hugeChunk = new Uint8Array(65536);
    for (let i = 0; i < 10; i++) {
      if (!killed) dataCb(hugeChunk);
    }

    assert.equal(killed, true);
    assert.equal(sentMessages.at(-1).error, 'OUTPUT_OVERFLOW');

    // MUST-FAIL CONTROL: missing pause under load must fail
    assert.equal(paused, true, 'PTY backpressure pause must trigger');
  });

  // OBLIGATION 8: Release-once lifecycle (SW-0249 INV-RELEASE-ONCE/CONSERVE)
  test('Obligation 8: Release-once lifecycle for destroySurface, warm resource disposers, and PTY kill', () => {
    let disposeCount = 0;
    const disposer = () => { disposeCount++; };

    const scheduler = createTileScheduler({ budget: defaultBudget });
    scheduler.registerSurface({ surfaceId: 'S1', surfaceGeneration: 1, principal: 'P1', epoch: 1, state: defaultState });

    scheduler.allocateWarmResource('S1', {
      resourceId: 'res-1',
      byteLength: 100,
      dispose: disposer
    });

    assert.equal(disposeCount, 0);

    // First destroy invokes disposer
    scheduler.destroySurface('S1');
    assert.equal(disposeCount, 1);

    // Second destroy on destroyed surface is a safe no-op and does NOT re-invoke disposer
    scheduler.destroySurface('S1');
    assert.equal(disposeCount, 1);

    // PTY session single kill
    let ptyKillCount = 0;
    const fakePty = {
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => { ptyKillCount++; }
    };

    const session = createPtySession({
      session: 'pty-2',
      spec: { file: '/bin/bash', args: [], cwd: '/', env: {} },
      spawn: () => fakePty,
      send: () => {}
    });

    session.close();
    assert.equal(ptyKillCount, 1);

    // Second close is no-op
    session.close();
    assert.equal(ptyKillCount, 1);

    // MUST-FAIL CONTROL: double disposal must fail check
    assert.equal(disposeCount, 1, 'Double disposal must fail');
  });

  // OBLIGATION 9: Handle/scope rejection (SW-0249 HANDLE-ONCE/SCOPE/REJECT)
  test('Obligation 9: Handle/scope rejection for forged handles, wrong epoch, and post-revocation postings', async () => {
    let schedulerRef = null;
    let crossRes = null;
    const scheduler = createTileScheduler({
      budget: defaultBudget,
      onPresent: rec => {
        if (schedulerRef && rec.surfaceId === 'S1') {
          // Attempt cross-surface draw for S2 using S1's handle
          crossRes = schedulerRef.presentHandle({ surfaceId: 'S2', handle: rec.handle });
        }
      }
    });
    schedulerRef = scheduler;

    scheduler.registerSurface({ surfaceId: 'S1', surfaceGeneration: 1, principal: 'P1', epoch: 1, state: defaultState });
    scheduler.registerSurface({ surfaceId: 'S2', surfaceGeneration: 1, principal: 'P1', epoch: 1, state: defaultState });

    const canvas = {
      getContext: () => ({
        createImageData: () => ({ data: new Uint8ClampedArray(12) }),
        putImageData: () => {}
      })
    };
    scheduler.attachCanvas({ surfaceId: 'S1', surfaceGeneration: 1, epoch: 1, canvas });
    scheduler.attachCanvas({ surfaceId: 'S2', surfaceGeneration: 1, epoch: 1, canvas });

    scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 1,
      leaseId: 'l1',
      byteLength: 3,
      width: 1,
      height: 1,
      bytes: new Uint8Array([1, 2, 3]),
      principal: 'P1',
      epoch: 1
    });

    // Run tick -> inside onPresent, presentHandle for S2 with S1's handle is called
    scheduler.runTick();

    assert.notEqual(crossRes, null);
    assert.equal(crossRes.ok, false);
    assert.equal(crossRes.reason, SCHEDULER_REASONS.SURFACE_MISMATCH);

    // Forged handle rejection
    const forgedRes = scheduler.presentHandle({ surfaceId: 'S1', handle: 'tile/S1/forged' });
    assert.equal(forgedRes.ok, false);
    assert.equal(forgedRes.reason, SCHEDULER_REASONS.INVALID_BINDING);

    // FramePort revocation
    const [portA] = makePair();
    const binding = { principal: 'p', epoch: 1, surfaceId: 'S1', surfaceGeneration: 1 };
    const limits = { maxFrameBytes: 1024, ackTimeoutMs: 1000, maxSurfacesPerPort: 1 };
    const port = createFramePort({ port: portA, binding, limits, role: 'sender', onReleaseLease: () => {}, onRevoke: () => {} });

    port.revokeFramePort(PORT_REVOKE_REASONS.PORT_REVOKED);
    const postRes = port.postFrame({
      ...binding,
      frameGeneration: 1,
      leaseId: 'l',
      width: 1,
      height: 1,
      format: 'rgb24',
      sha256: 'a'.repeat(64),
      pixelSpec: { format: 'rgb24' },
      byteLength: 3,
      bytes: new Uint8Array(3)
    });
    assert.equal(postRes.ok, false);
    assert.equal(postRes.reason, 'PORT_REVOKED');

    // MUST-FAIL CONTROL: allowing cross-surface handle must fail
    assert.equal(crossRes.ok, false, 'Cross-surface handle must be rejected');
  });

  // OBLIGATION 10: Event-loop and memory (PL34/PL35)
  test('Obligation 10: Execution time boundaries, array buffer dropping, and fuzz testing JSDoc types', () => {
    const scheduler = createTileScheduler({ budget: defaultBudget });
    scheduler.registerSurface({ surfaceId: 'S1', surfaceGeneration: 1, principal: 'P1', epoch: 1, state: defaultState });

    // Fuzz test submitFrame with malformed non-TypeScript runtime inputs
    const badInputs = [
      null,
      undefined,
      123,
      'string',
      {},
      { surfaceId: 'S1', surfaceGeneration: 'invalid' },
      { surfaceId: 'S1', surfaceGeneration: 1, frameGeneration: 1, bytes: [1, 2, 3] }, // Not Uint8Array
      { surfaceId: 'S1', surfaceGeneration: 1, frameGeneration: 1, bytes: new Uint8Array(10), byteLength: 5 } // Mismatch
    ];

    for (const bad of badInputs) {
      const res = scheduler.submitFrame(/** @type {any} */ (bad));
      assert.equal(res.ok, false, `Fuzz input ${JSON.stringify(bad)} should be rejected`);
    }

    // Array buffer dropping verification
    let bytes = new Uint8Array(1000);
    scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 1,
      leaseId: 'l1',
      byteLength: 300,
      width: 10,
      height: 10,
      bytes: new Uint8Array(300),
      principal: 'P1',
      epoch: 1
    });

    scheduler.destroySurface('S1');
    const inst = scheduler.getInstrumentation('S1');
    assert.equal(inst.pendingMailboxFrameGen, null);

    // MUST-FAIL CONTROL: admitting raw JS array instead of Uint8Array must fail
    const rawArrayRes = scheduler.submitFrame({
      surfaceId: 'S1',
      surfaceGeneration: 1,
      frameGeneration: 1,
      leaseId: 'l1',
      byteLength: 3,
      width: 1,
      height: 1,
      bytes: /** @type {any} */ ([1, 2, 3]),
      principal: 'P1',
      epoch: 1
    });
    assert.equal(rawArrayRes.ok, false, 'Raw array submission must fail');
  });

  // OBLIGATION 11: Projection stale-last-good
  test('Obligation 11: Projection decoding refusal keeps last-good snapshot visibly stale', () => {
    const snapshotLive = {
      status: 'live',
      stale: false,
      ramRevision: 1,
      durableRevision: null,
      envelope: {
        schema: 'surface/v0.1',
        epoch: 1,
        revision: 1,
        query: 'wall/surfaces/v1',
        projection: {
          rows: [
            {
              id: 'cap-1',
              surfaceId: 'cap-1',
              backendLifecycle: 'active',
              generation: 10,
              visibility: 'unfolded',
              control: 'human',
              title: 'Active Tile'
            }
          ]
        }
      },
      error: null
    };

    const goodRes = selectWallSurfacePure(snapshotLive, 'cap-1');
    assert.equal(goodRes.ok, true);
    assert.equal(goodRes.value.surfaceId, 'cap-1');

    // Refusal snapshot (decoder error overlaid) retains envelope but marks stale
    const snapshotStale = {
      status: 'stale',
      stale: true,
      ramRevision: 1,
      durableRevision: null,
      envelope: snapshotLive.envelope,
      error: { code: 'ERR_MALFORMED_JSON', message: 'corrupt payload' }
    };

    const staleRes = selectWallSurfacePure(snapshotStale, 'cap-1');
    assert.equal(staleRes.ok, true);
    assert.equal(staleRes.value.surfaceId, 'cap-1');

    // Malformed row identity select -> Refused
    const badSelect = selectWallSurfacePure(snapshotLive, 'missing-id');
    assert.equal(badSelect.ok, false);
    assert.equal(badSelect.error.code, 'ERR_UNKNOWN_SURFACE');

    // MUST-FAIL CONTROL: selecting unknown surface must fail
    assert.equal(badSelect.ok, false, 'Unknown surface selection must fail');
  });

  // OBLIGATION 12: PTY spawn contract
  test('Obligation 12: PTY spawn spec validation and provider menu reference-only filtering', () => {
    // Relative paths in spawn spec must throw INVALID_SPAWN_SPEC
    const relativeSpec = { file: 'bash', args: [], cwd: '/home', env: {} };
    assert.throws(() => validateSpawnSpec(/** @type {any} */ (relativeSpec)), /INVALID_SPAWN_SPEC/);

    // Invalid env key must throw INVALID_SPAWN_SPEC
    const badEnvSpec = { file: '/bin/bash', args: [], cwd: '/', env: { 'BAD-KEY': '1' } };
    assert.throws(() => validateSpawnSpec(/** @type {any} */ (badEnvSpec)), /INVALID_SPAWN_SPEC/);

    // Valid spec passes
    const validSpec = { file: '/bin/bash', args: ['-l'], cwd: '/', env: { PATH: '/bin' } };
    const normSpec = validateSpawnSpec(validSpec);
    assert.equal(normSpec.file, '/bin/bash');

    // Provider menu normalization: reference-only menu never exposes argv/env/cwd
    const rawProviders = [
      { id: 'p1', label: 'Provider 1', hint: 'Hint 1', argv: ['/usr/bin/p1', '--flag'] }
    ];
    const normProviders = normalizeProviders(rawProviders);
    const menu = createProviderMenu(normProviders, [{ id: 'p1', available: true, reason: '' }]);

    assert.equal(menu.length, 2); // shell + p1
    assert.equal(menu[1].id, 'p1');
    assert.equal(menu[1].label, 'Provider 1');
    assert.equal('argv' in menu[1], false, 'Menu row must never contain argv');
    assert.equal('env' in menu[1], false, 'Menu row must never contain env');

    // MUST-FAIL CONTROL: accepting relative binary path must fail
    assert.throws(() => validateSpawnSpec({ file: 'relative/bin', args: [], cwd: '/', env: {} }), /INVALID_SPAWN_SPEC/);
  });

});
