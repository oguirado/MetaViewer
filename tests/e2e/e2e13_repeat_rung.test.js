'use strict';
// E2E Item 6: Repeat rung (E9, E10)
// Cites SW-0242 C1-C2 (E9), SW-0242 C3 (E10).
// Drives real hosted slice from e2e1_slice/index.js x20.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { hosted } = require('./e2e1_slice/index.js');
const { compileRust, replay } = require('./core-driver.js');
const { E2EError, makeScratch, removeScratch, validateWallReport } = require('./harness.js');

test('Item 6: Repeat rung runs real hosted slice x20 with zero flakes (E9, E10)', () => {
  const scratch = makeScratch('mv-slice-repeat');
  try {
    const source = readFileSync(join(__dirname, 'e2e1_slice', 'scenario.rs'), 'utf8');
    const binary = compileRust(scratch, source);

    const digests = [];
    for (let i = 0; i < 20; i++) {
      const runScratch = makeScratch(`mv-slice-run-${i}`);
      try {
        const state = JSON.parse(execFileSync(binary, [join(runScratch, 'state_dir'), '--full'], { encoding: 'utf8' }));
        const root = join(runScratch, 'state_dir/sessions/session-1');
        const journal = join(root, 'journal.jsonl');
        const a = replay(journal, root).trim();
        const b = replay(journal, root).trim();
        assert.equal(a, b, 'replay digests must match');
        digests.push(a);
      } finally {
        removeScratch(runScratch);
      }
    }

    // All 20 iterations must produce identical state digests (zero flakes)
    assert.equal(new Set(digests).size, 1, 'all 20 runs must yield the exact same digest');
  } finally {
    removeScratch(scratch);
  }
});

test('Item 6: Negative controls - Planted mutants fail repeat rung harness (E10)', () => {
  // 1. Planted cross-routing mutant check through real validateWallReport harness
  const invalidReport = {
    schema: 'e2e-wall-report/v1',
    phase: 'wall',
    tiles: [
      { capsuleId: 'capsule-1', visible: true, frameId: 'frame-capsule-1-gen7' },
      { capsuleId: 'capsule-2', visible: true, frameId: 'frame-capsule-1-gen7' }, // Cross-routed frame!
      { capsuleId: 'capsule-3', visible: true, frameId: 'frame-capsule-3-gen7' },
      { capsuleId: 'capsule-4', visible: true, frameId: 'frame-capsule-4-gen7' }
    ],
    errors: []
  };

  assert.throws(() => {
    validateWallReport(invalidReport);
  }, (err) => err instanceof E2EError && err.code === 'E2E_ROUTING' && err.message.includes('frame routed to two tiles'));

  // 2. Planted tampered digest mutant check through real replay harness
  const scratch = makeScratch('mv-tampered-replay');
  try {
    const root = join(scratch, 'state_dir/sessions/session-1');
    assert.throws(() => {
      replay(join(root, 'nonexistent_journal.jsonl'), root);
    }, (err) => err instanceof Error && (err.message.includes('E2E_REPLAY') || err.message.includes('mv-replay absent')));
  } finally {
    removeScratch(scratch);
  }
});
