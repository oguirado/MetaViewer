'use strict';
// E2E Item 5: Golden replay after the new head (E1, E2, E3)
// Cites SW-0183 §6.2 (E1), SW-0183 §6.4 (E2), SW-0224 Claim A (E3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { runRust, replay } = require('./core-driver.js');
const { makeScratch, removeScratch } = require('./harness.js');
const fixture = require('../fixtures/golden_scenario.json');

const EXPECTED_DIGEST = '28b88ad39277c9e2dfe5d494973b8c9c428c2d7c92eaafa40ea7fcd1f6d686e5';
const source = readFileSync(join(__dirname, 'e2e1_slice/scenario.rs'), 'utf8');

test('Item 5: Six-event replay equals pinned golden digest twice with byte-identical journals (E1, E3)', () => {
  assert.equal(fixture.expected_digest, EXPECTED_DIGEST, 'golden fixture digest must equal pinned hash');

  const runs = [];
  for (let i = 0; i < 2; i++) {
    const scratch = makeScratch('mv-golden-e2e11');
    try {
      const stateRaw = runRust(scratch, source).trim();
      const stateObj = JSON.parse(stateRaw);
      assert.deepEqual(stateObj, fixture.expected_state, 'state must match expected golden state');

      const root = join(scratch, 'state_dir/sessions/session-1');
      const journal = join(root, 'journal.jsonl');
      const journalContent = readFileSync(journal, 'utf8');

      const digest = replay(journal, root).trim();
      assert.equal(digest, EXPECTED_DIGEST, 'replayed digest must equal golden digest');

      const verifyOnlyOutput = replay(journal, root, true);
      assert.equal(verifyOnlyOutput, '', 'verify-only output must be silent');

      runs.push({ arch: process.arch, journalContent, digest });
    } finally {
      removeScratch(scratch);
    }
  }

  assert.equal(runs[0].journalContent, runs[1].journalContent, 'journals must be byte-identical');
  assert.equal(runs[0].digest, runs[1].digest, 'digests must be identical');
});

test('Item 5: Replay purity and tampered journal refusal (E2)', () => {
  const scratch = makeScratch('mv-golden-tamper-e2e11');
  try {
    runRust(scratch, source);
    const root = join(scratch, 'state_dir/sessions/session-1');
    const journal = join(root, 'journal.jsonl');
    const journalContent = readFileSync(journal, 'utf8');

    const tamperedContent = journalContent.replace('surface_changed', 'received');
    writeFileSync(journal, tamperedContent);

    assert.throws(() => replay(journal, root), (err) => {
      return err && err.message.includes('E2E_REPLAY');
    }, 'tampered journal must refuse replay');
  } finally {
    removeScratch(scratch);
  }
});
