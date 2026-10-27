'use strict';
// E2E Item 9: Headless discipline (E11, E12, E13, E14)
// Cites SW-0242 §6.4 (E11), OmniCodex PL04 RUST (E12), PL11 GO (E13), PL21 PY (E14).
// Uses harness.js directly for prerequisite verification.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { XVFB_ARGV, E2EError, findRepoRoot } = require('./harness.js');
const { requireLive } = require('./e2e1_slice/index.js');

test('Item 9: Headless discipline asserts pinned 1280x900x24 geometry in XVFB_ARGV (E11)', () => {
  assert.ok(XVFB_ARGV.includes('-screen 0 1280x900x24'),
    'XVFB_ARGV must contain pinned geometry -screen 0 1280x900x24');
  const root = findRepoRoot(__dirname);
  assert.ok(root, 'repo root must be resolvable');
});

test('Item 9: Negative controls - Missing prerequisite ends typed fail-closed E2E_GATE or E2E_PREREQ (E11)', () => {
  // Missing MV_E2E_LIVE flag throws E2E_GATE
  assert.throws(() => {
    requireLive({});
  }, (err) => err instanceof E2EError && err.code === 'E2E_GATE');

  // Missing required binaries throws E2E_PREREQ
  assert.throws(() => {
    requireLive({ MV_E2E_LIVE: '1' });
  }, (err) => err instanceof E2EError && err.code === 'E2E_PREREQ');
});
