'use strict';
// U13 adapts the static flag spec: ui/test/security.test.js already pins those
// functions. This verifies their real Chromium behavior, including preload.
// Mutation: flip createWindowOptions' `sandbox: true` to false -> the native
// preferences audit fails. Mutation: decideWindowOpen returns allow -> a second
// real window appears and the popup assertion fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const harness = require('./ac-harness.cjs');

function audit(report) {
  assert.deepEqual(report.preferences, {
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
  }, 'E2E_SECURITY: window flags');
  assert.equal(report.node, 'undefined');
  assert.equal(report.process, 'undefined');
  assert.equal(report.inline, false, 'E2E_CSP: inline script executed');
  assert.equal(report.evalBlocked, true, 'E2E_CSP: eval allowed');
  assert.equal(report.fetchBlocked, true, 'E2E_CSP: connect allowed');
  assert.equal(report.popupDenied, true, 'E2E_WINDOW_OPEN: popup allowed');
  assert.equal(report.windows, 1);
  assert.equal(report.frozen, true);
  assert.deepEqual(report.facade, ['authority', 'capture', 'load', 'loadSettings', 'nestedDepth',
    'recordingDestination', 'save', 'saveSettings', 'selfCapsuleId', 'sideTerminal']);
  assert.deepEqual(report.authority, ['intent', 'propose', 'subscribeFrames']);
  assert.deepEqual(report.capture, ['list', 'recordStart', 'recordStop', 'screenshot', 'subscribe']);
  assert.deepEqual(report.terminal, ['open', 'setEnabled']);
}

test('Chromium enforces product flags, CSP, popup denial and preload allowlist; unsafe flags fail', () => {
  const scratch = harness.makeScratch('mv-security');
  try {
    const run = mode => {
      const report = join(scratch, mode + '.json');
      const outcome = harness.runUnderXvfb({
        electron: harness.electronBinary(join(__dirname, '../..')),
        appDir: join(__dirname, 'security-main.mjs'), extraArgs: [report, mode], timeoutMs: 25000,
      });
      assert.equal(outcome.status, 0, JSON.stringify(outcome));
      return JSON.parse(readFileSync(report, 'utf8'));
    };
    audit(run('clean'));
    assert.throws(() => audit(run('unsafe')), /E2E_SECURITY/);
  } finally { harness.removeScratch(scratch); }
});
