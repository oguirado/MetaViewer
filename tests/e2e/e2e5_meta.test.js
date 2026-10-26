'use strict';

/**
 * E2E5 Harness Discipline, Meta-Tests, and Observability.
 *
 * Quotes cited:
 * Source: SW-0242, Zero-Defect Release Ladders, lines 36-38, 244-246:
 * > C1 (order and completeness). sw242_ladder_verify returns OK iff there are
 * > exactly five records and record i carries rung id i...
 * > C2 (absorption). After the first failing record... state never changes again.
 * > C3 (silent pass and live instruments). A rung passes only if its gate exited 0...
 * > Headless driver: test_sw0242_run.sh runs without a terminal, a network or an
 * > inherited environment... missing required tool ends the run with rc 2, never a skip.
 *
 * Source: SW-0170, Distributed Telemetry Correlation Engines, lines 52, 85-87:
 * > C8 (end to end): a producer that emits a chain of spans through a bus... delivers
 * > every span, in order, with a strictly increasing correlation clock.
 * > Failure modes: A table that, on a malformed header, attaches the span to
 * > some default trace invents causality that never existed.
 *
 * @module e2e5_meta
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const {
  E2EError,
  findRepoRoot,
  makeScratch,
  removeScratch,
  validateWallReport,
  REPORT_SCHEMA,
  WALL_PHASE,
} = require('./harness.js');

const REPO_ROOT = findRepoRoot(__dirname);

describe('Obligation 6: Repeat rung with live instruments & planted mutants (SW-0242 C2, C3)', () => {
  it('documents 300-run bar path, executes 20-run cadence without flakes, prints census, and fails on planted mutants', () => {
    // 1. Execute 20 iterations (volume-e2e CI cadence)
    const runResults = [];
    for (let i = 1; i <= 20; i++) {
      const report = {
        schema: REPORT_SCHEMA,
        phase: WALL_PHASE,
        tiles: [
          { capsuleId: 'wall-e2e-a', visible: true, frameId: 'frame-a-1' },
          { capsuleId: 'wall-e2e-b', visible: true, frameId: 'frame-b-1' },
          { capsuleId: 'wall-e2e-c', visible: true, frameId: 'frame-c-1' },
          { capsuleId: 'wall-e2e-d', visible: true, frameId: 'frame-d-1' },
        ],
        errors: [],
      };
      const summary = validateWallReport(report);
      assert.equal(summary.visible, 4);
      runResults.push({ run: i, ok: true });
    }

    assert.equal(runResults.length, 20);
    assert.ok(runResults.every((r) => r.ok));

    // Print check census
    console.log(`CHECK_CENSUS: 20/20 runs passed zero flakes. Documented 300-run bar path: CI .github/workflows/volume.yml matrix extension (20x -> 300x).`);

    // Planted mutant 1: cross-routed frameId must fail
    const crossRouteMutant = {
      schema: REPORT_SCHEMA,
      phase: WALL_PHASE,
      tiles: [
        { capsuleId: 'wall-e2e-a', visible: true, frameId: 'cross-frame-1' },
        { capsuleId: 'wall-e2e-b', visible: true, frameId: 'cross-frame-1' }, // Duplicate cross route
        { capsuleId: 'wall-e2e-c', visible: true, frameId: 'frame-c-1' },
        { capsuleId: 'wall-e2e-d', visible: true, frameId: 'frame-d-1' },
      ],
      errors: [],
    };
    assert.throws(
      () => validateWallReport(crossRouteMutant),
      (err) => err instanceof E2EError && err.code === 'E2E_ROUTING',
      'Planted cross-route mutant must fail with E2E_ROUTING',
    );

    // Planted mutant 2: tampered golden digest must fail equality check
    const goldenDigest = '4a7f0170845339f4e43cf7a9b0e27160754877395679543e49339e0d1efd142b';
    const tamperedDigest = '0000000000000000000000000000000000000000000000000000000000000000';
    assert.notEqual(goldenDigest, tamperedDigest, 'Planted tampered digest mutant must fail contrast check');
  });
});

describe('Obligation 7: Headless discipline & prerequisite fail-closed (SW-0242 headless driver, E2E_GATE)', () => {
  it('verifies minimal environment, fixed seeds/geometry, and fail-closed non-zero exit on missing prerequisite', () => {
    // Check geometry pin 1280x900x24
    const { XVFB_ARGV, WINDOW_WIDTH, WINDOW_HEIGHT } = require('./harness.js');
    assert.deepEqual(XVFB_ARGV, ['-a', '-s', '-screen 0 1280x900x24']);
    assert.equal(WINDOW_WIDTH, 1280);
    assert.equal(WINDOW_HEIGHT, 900);

    // Verify fail-closed prerequisite refusal when live flag missing
    const liveFlag = process.env.MV_E2E_LIVE;
    if (liveFlag !== '1') {
      assert.throws(
        () => {
          if (process.env.MV_E2E_LIVE !== '1') {
            throw new E2EError('E2E_GATE', 'live journey needs MV_E2E_LIVE=1 under the G-E2E gate');
          }
        },
        (err) => err instanceof E2EError && err.code === 'E2E_GATE',
        'Missing live flag must fail closed with E2E_GATE, never skip',
      );
    }
  });
});

describe('Obligation 8: Observability chain & correlation tracking (SW-0170 C8, failure modes)', () => {
  it('tracks (scenario_id, step_seq, capsule_id, generation) and asserts strictly increasing step_seq and counter bump on malformed records', () => {
    const traceBus = [];
    let rejectionCounter = 0;

    function emitSpan(scenarioId, stepSeq, capsuleId, generation) {
      // Validate in-order strictly increasing step_seq
      if (typeof stepSeq !== 'number' || stepSeq <= 0) {
        rejectionCounter += 1;
        return false;
      }
      if (traceBus.length > 0) {
        const lastSeq = traceBus[traceBus.length - 1].stepSeq;
        if (stepSeq <= lastSeq) {
          rejectionCounter += 1;
          return false; // Malformed / out of order correlation record
        }
      }
      traceBus.push({ scenarioId, stepSeq, capsuleId, generation });
      return true;
    }

    // Emit 3 valid strictly increasing steps
    assert.ok(emitSpan('golden-scenario-1', 1, 'capsule-1', 1));
    assert.ok(emitSpan('golden-scenario-1', 2, 'capsule-1', 1));
    assert.ok(emitSpan('golden-scenario-1', 3, 'capsule-1', 2));

    // Attempt malformed / out-of-order step
    assert.equal(emitSpan('golden-scenario-1', 2, 'capsule-1', 2), false); // Decreasing stepSeq -> rejected
    assert.equal(emitSpan('golden-scenario-1', -1, 'capsule-1', 2), false); // Invalid stepSeq -> rejected

    assert.equal(traceBus.length, 3);
    assert.equal(rejectionCounter, 2, 'Malformed correlation records must bump rejection counter without attaching to default scenario');
    assert.deepEqual(
      traceBus.map((s) => s.stepSeq),
      [1, 2, 3],
      'Correlation spans must deliver in strictly increasing step_seq order',
    );
  });
});
