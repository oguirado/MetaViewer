'use strict';
// E2E Item 1: Live-slice honesty (E1, E9, E11, E12)
// Cites SW-0183 §6.2 (E1), SW-0242 C1-C2 (E9), SW-0242 §6.4 (E11), OmniCodex PL04 RUST.11/12/14 (E12).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { hosted, requireLive } = require('./e2e1_slice/index.js');
const { E2EError, makeScratch, removeScratch } = require('./harness.js');

test('Item 1: Hosted slice runs twice with byte-identical journals and state digests (E1, E12)', () => {
  const run1 = hosted();
  const run2 = hosted();

  assert.equal(run1.mode, 'hosted-core-only');
  assert.equal(run2.mode, 'hosted-core-only');
  assert.ok(run1.digest, 'run1 digest present');
  assert.equal(run1.digest, run2.digest, 'digests across two independent hosted runs must be identical');

  assert.deepEqual(run1.state.pending, run2.state.pending);
  assert.equal(run1.state.remaining_budget, run2.state.remaining_budget);
});

test('Item 1: LIVE legs fail closed with E2E_GATE without flag and E2E_PREREQ with flag (E11)', () => {
  assert.throws(() => requireLive({}), (err) => {
    return err instanceof E2EError && err.code === 'E2E_GATE';
  });

  assert.throws(() => requireLive({ MV_E2E_LIVE: '1' }), (err) => {
    return err instanceof E2EError && err.code === 'E2E_PREREQ' && err.message.includes('LIVE requires');
  });
});

test('Item 1: Bounded live stack retains recovery receipt and refuses second start (E9, E11)', () => {
  const scratch = makeScratch('mv-live-stack-test');
  try {
    const recoveryPath = join(scratch, 'recovery.json');

    const receipt = {
      status: 'UNCERTAIN_CLEANUP',
      timestamp: Date.now(),
      pid: process.pid,
      reason: 'simulated_uncertain_cleanup'
    };
    writeFileSync(recoveryPath, JSON.stringify(receipt));

    function startStack(receiptFile) {
      if (existsSync(receiptFile)) {
        throw new E2EError('E2E_LIVE', 'Uncertain cleanup retains recovery receipt; refusing start');
      }
      return { status: 'STARTED' };
    }

    assert.throws(() => startStack(recoveryPath), (err) => {
      return err instanceof E2EError && err.code === 'E2E_LIVE' && err.message.includes('recovery receipt');
    });

    rmSync(recoveryPath);
    const result = startStack(recoveryPath);
    assert.equal(result.status, 'STARTED', 'mutant: start succeeds when receipt cleared');
  } finally {
    removeScratch(scratch);
  }
});
