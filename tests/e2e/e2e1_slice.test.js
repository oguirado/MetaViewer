'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hosted, requireLive, checkLiveResult } = require('./e2e1_slice');
test('hosted core gen7->gen8 stale refusal, pending cancellation, drain, release, dispatch, receipt and replay', () => {
  const result = hosted();
  assert.equal(result.mode, 'hosted-core-only');
  assert.deepEqual(result.state.pending, {});
  assert.deepEqual(result.state.draining, {});
  assert.equal(result.state.remaining_budget, 9997);
});
test('LIVE result gate refuses partial success, missing evidence and contradictory exit codes', () => {
  const assertions = Object.fromEntries(['capsule_frame_ui_fanout', 'observe_propose_dispatch_receipt',
    'receipt_binding_negative_control',
    'stale_no_state_change', 'human_cancel_release_refresh',
    'action_journal_replay_corruption', 'electron_tile'].map(key => [key, 'PASS']));
  const passed = { status: 'DONE', container_cleanup: 'PASS', assertions,
    verify_verdict: { status: 'verified', receipt: { verified: true } },
    verify_negative_control: { status: 'PASS', baseline: { verified: true },
      different_surface: { verified: false }, stale_generation: { verified: false } },
    process_cleanup: { status: 'PASS', temporary_tree_absent: true, socket_absent: true },
    ram_cleanup: { status: 'PASS' } };
  assert.doesNotThrow(() => checkLiveResult(passed, 0));
  assert.doesNotThrow(() => checkLiveResult({ status: 'BLOCKED' }, 1));
  for (const report of [
    { ...passed, assertions: {} },
    { ...passed, verify_verdict: undefined },
    { ...passed, verify_verdict: { status: 'verified', receipt: { verified: false } } },
    { ...passed, verify_negative_control: undefined },
    { ...passed, verify_negative_control: { ...passed.verify_negative_control,
      different_surface: { verified: true } } },
    { ...passed, verify_negative_control: { ...passed.verify_negative_control,
      stale_generation: { verified: true } } },
    { ...passed, assertions: { ...assertions, electron_tile: 'PENDING' } },
    { ...passed, assertions: { ...assertions, observe_propose_dispatch_receipt: 'FAIL' } },
    { ...passed, container_cleanup: 'FAIL' },
    { ...passed, process_cleanup: undefined },
    { ...passed, process_cleanup: { ...passed.process_cleanup, socket_absent: false } },
    { ...passed, ram_cleanup: { status: 'FAIL' } },
    { status: 'BLOCKED' },
  ]) assert.throws(() => checkLiveResult(report, 0), { code: 'E2E_LIVE' });
  assert.throws(() => checkLiveResult(passed, 1), { code: 'E2E_LIVE' });
});
test('LIVE requires explicit authorization and real binary/environment prerequisites', () => {
  assert.throws(() => requireLive({}), { code: 'E2E_GATE' });
  assert.throws(() => requireLive({ MV_E2E_LIVE: '1' }), { code: 'E2E_PREREQ' });
});
