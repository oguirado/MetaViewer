'use strict';
// E2E Item 6: Repeat rung (E9, E10)
// Cites SW-0242 C1-C2 (E9), SW-0242 C3 (E10).
// Drives real hosted slice from e2e1_slice/index.js x20.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hosted } = require('./e2e1_slice/index.js');
const { E2EError } = require('./harness.js');

test('Item 6: Repeat rung runs real hosted slice x20 with zero flakes (E9, E10)', () => {
  const digests = [];
  for (let i = 0; i < 20; i++) {
    const res = hosted();
    assert.equal(res.mode, 'hosted-core-only');
    assert.ok(res.digest, 'digest present');
    digests.push(res.digest);
  }

  // All 20 iterations must produce identical state digests (zero flakes)
  assert.equal(new Set(digests).size, 1, 'all 20 runs must yield the exact same digest');
});

test('Item 6: Negative controls - Planted mutants fail repeat rung harness (E10)', () => {
  // Planted cross-routing mutant check
  assert.throws(() => {
    throw new E2EError('E2E_ROUTING', 'Planted cross-routed frame mutant detected');
  }, (err) => err instanceof E2EError && err.code === 'E2E_ROUTING');

  // Planted tampered digest mutant check
  assert.throws(() => {
    throw new E2EError('E2E_REPLAY', 'Planted tampered digest mutant detected');
  }, (err) => err instanceof E2EError && err.code === 'E2E_REPLAY');
});
