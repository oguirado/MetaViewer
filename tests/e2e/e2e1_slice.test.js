'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hosted, requireLive } = require('./e2e1_slice');
test('hosted core gen7->gen8 stale refusal, pending cancellation, drain, release, dispatch, receipt and replay', () => {
  const result = hosted();
  assert.equal(result.mode, 'hosted-core-only');
  assert.deepEqual(result.state.pending, {});
  assert.deepEqual(result.state.draining, {});
  assert.equal(result.state.remaining_budget, 9997);
});
test('LIVE without explicit flag refuses E2E_GATE; absent authority wiring refuses E2E_PREREQ', () => {
  assert.throws(() => requireLive({}), { code: 'E2E_GATE' });
  assert.throws(() => requireLive({ MV_E2E_LIVE: '1' }), { code: 'E2E_PREREQ' });
});
