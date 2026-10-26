'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { runRust, replay } = require('./core-driver.js');
const { makeScratch, removeScratch } = require('./harness.js');
const fixture = require('../fixtures/golden_scenario.json');
const source = readFileSync(join(__dirname, 'e2e1_slice/scenario.rs'), 'utf8');

test('six-event replay equals the independently declared golden state twice; verify-only is silent', () => {
  const runs = [];
  for (let i = 0; i < 2; ++i) {
    const scratch = makeScratch('mv-golden');
    try {
      const state = runRust(scratch, source).trim();
      assert.deepEqual(JSON.parse(state), fixture.expected_state);
      assert.equal(createHash('sha256').update(state).digest('hex'), fixture.expected_digest);
      const root = join(scratch, 'state_dir/sessions/session-1');
      const journal = join(root, 'journal.jsonl');
      const contents = readFileSync(journal, 'utf8');
      assert.equal(contents.trim().split('\n').length, fixture.steps.length + 1);
      const digest = replay(journal, root).trim();
      assert.equal(digest, fixture.expected_digest);
      assert.equal(replay(journal, root, true), '');
      runs.push({ contents, digest });
      writeFileSync(journal, contents.replace('surface_changed', 'received'));
      assert.throws(() => replay(journal, root), 'corrupted journal must refuse');
    } finally { removeScratch(scratch); }
  }
  assert.deepEqual(runs[0], runs[1]);
});
