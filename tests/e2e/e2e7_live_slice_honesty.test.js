'use strict';
// Hosted slice determinism and live prerequisite fail-closed gates.
// Mutation: remove the MV_E2E_LIVE !== '1' check in e2e1_slice/index.js requireLive
// -> requireLive({}) throws E2E_PREREQ instead of E2E_GATE and this test fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hosted, requireLive } = require('./e2e1_slice/index.js');
const { E2EError } = require('./harness.js');

test('hosted slice runs twice with identical state digests and budgets', () => {
  const run1 = hosted();
  const run2 = hosted();

  assert.equal(run1.mode, 'hosted-core-only');
  assert.equal(run2.mode, 'hosted-core-only');
  assert.ok(run1.digest, 'run1 digest present');
  assert.equal(run1.digest, run2.digest, 'digests across two independent hosted runs must be identical');

  assert.deepEqual(run1.state.pending, run2.state.pending);
  assert.equal(run1.state.remaining_budget, run2.state.remaining_budget);
});

test('live slice prerequisites fail closed with E2E_GATE without flag and E2E_PREREQ with flag', () => {
  assert.throws(() => requireLive({}), (err) => {
    return err instanceof E2EError && err.code === 'E2E_GATE';
  });

  assert.throws(() => requireLive({ MV_E2E_LIVE: '1' }), (err) => {
    return err instanceof E2EError && err.code === 'E2E_PREREQ' && err.message.includes('LIVE requires');
  });
});
