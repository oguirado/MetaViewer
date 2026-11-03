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
  assert.deepEqual(report.facade, ['authority', 'capture', 'clipboard', 'frames', 'input', 'load', 'loadSettings', 'nestedDepth', 'operator',
    'recordingDestination', 'save', 'saveSettings', 'selfCapsuleId', 'sideTerminal', 'slots']);
  assert.deepEqual(report.slots, ['request']);
  assert.equal(report.slotsFrozen, true);
  assert.deepEqual(report.operator, {
    demo: ['check', 'prompt', 'start', 'stop'],
    entry: ['copy'],
    identity: ['create', 'delete', 'list', 'login', 'show'],
    egress: ['get', 'set'],
    handoff: ['ack', 'list', 'subscribe'],
  });
  assert.equal(report.operatorCallable, true, 'operator members must be functions');
  // POLISH-2 (6a635afdc): createSurface is the host-owned, zero-argument browser create.
  assert.deepEqual(report.authority, ['createSurface', 'intent', 'propose', 'subscribeFrames', 'vmAvailable']);
  assert.deepEqual(report.capture, ['export', 'list', 'recordStart', 'recordStop', 'screenshot', 'subscribe']);
  assert.deepEqual(report.terminal, ['attach', 'close', 'copyText', 'listProviders', 'open', 'resize', 'setEnabled']);
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
    const clean = run('clean');
    audit(clean);
    assert.throws(() => audit({ ...clean, facade: [...clean.facade, 'unexpected'].sort() }),
      { code: 'ERR_ASSERTION' });
    assert.throws(() => audit({ ...clean, slots: ['request', 'unexpected'] }),
      { code: 'ERR_ASSERTION' });
    assert.throws(() => audit({ ...clean, operator: { ...clean.operator, unexpected: [] } }),
      { code: 'ERR_ASSERTION' });
    assert.throws(() => audit({ ...clean, operator: {
      ...clean.operator, demo: [...clean.operator.demo, 'unexpected'].sort(),
    } }), { code: 'ERR_ASSERTION' });
    assert.throws(() => audit({ ...clean, operatorCallable: false }), /operator members/);
    assert.throws(() => audit(run('unsafe')), /E2E_SECURITY/);
  } finally { harness.removeScratch(scratch); }
});

// The additive facade method uses precisely the host's fixed slot channel.
test('slots request channel agrees with main and rejects unknown request fields', async () => {
  const { installPreload } = await import('../../ui/electron/preload.js');
  const { WIRE_CHANNELS } = await import('../../ui/electron/authorityWire.js');
  const calls = [];
  const api = installPreload({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {
    on() {}, removeListener() {},
    async invoke(channel, request) {
      calls.push([channel, request]);
      const { credential_copy_confirmed, ...fields } = request;
      return { ...fields, schema: 'capsule_state_event/v0.2', event: 'completed', slots: [] };
    },
  } });
  const request = { schema: 'capsule_state_request/v0.2', operation_id: 'security-slot',
    op: 'list', profile_id: 'profile-demo', slot_id: 'slot-demo', credential_copy_confirmed: true };
  assert.equal(WIRE_CHANNELS.slotRequest, 'metaviewer:capsule-state.request');
  await api.slots.request(request);
  assert.deepEqual(calls, [[WIRE_CHANNELS.slotRequest, request]]);
  await assert.rejects(api.slots.request({ ...request, channel: 'unexpected' }));
  assert.equal(calls.length, 1);
});
