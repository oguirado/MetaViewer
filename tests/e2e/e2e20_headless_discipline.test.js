'use strict';
// Headless Xvfb geometry and fail-closed live prerequisite verification.
// Mutation: change XVFB_ARGV in tests/e2e/harness.js from 1280x900x24 to 1024x768x24
// -> pinned geometry assertion fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { XVFB_ARGV, E2EError, findRepoRoot } = require('./harness.js');
const { requireLive } = require('./e2e1_slice/index.js');

test('headless discipline asserts pinned 1280x900x24 geometry in XVFB_ARGV', () => {
  assert.ok(XVFB_ARGV.includes('-screen 0 1280x900x24'),
    'XVFB_ARGV must contain pinned geometry -screen 0 1280x900x24');
  const root = findRepoRoot(__dirname);
  assert.ok(root, 'repo root must be resolvable');
});

test('missing live prerequisite ends with typed fail-closed E2E_GATE or E2E_PREREQ', () => {
  assert.throws(() => {
    requireLive({});
  }, (err) => err instanceof E2EError && err.code === 'E2E_GATE');

  assert.throws(() => {
    requireLive({ MV_E2E_LIVE: '1' });
  }, (err) => err instanceof E2EError && err.code === 'E2E_PREREQ');
});
