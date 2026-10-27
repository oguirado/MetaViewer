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

// The oracle is a declared state, independently canonicalized here. Never
// re-pin it from runRust output: that would hide a reducer regression.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
test('independent six-event golden oracle is pinned and rejects a budget mutant', () => {
  const digest = (state) => createHash('sha256').update(canonical(state)).digest('hex');
  assert.equal(digest(fixture.expected_state), fixture.expected_digest);
  const mutant = structuredClone(fixture.expected_state);
  mutant.remaining_budget += 1;
  assert.notEqual(digest(mutant), fixture.expected_digest);
});
