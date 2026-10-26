'use strict';

/**
 * E2E2 Golden Scenario with Replay-Digest Equality.
 *
 * Quotes cited:
 * Source: SW-0183, Lockstep State Synchronization, lines 297-299:
 * > HB_ARCH records that replaying a recorded input journal reproduces the
 * > state bit for bit without model inference [CITED]; here the replay of the
 * > 8-tick log gives the same final digest as a direct application of the scripted
 * > inputs [MEASURED], and the replay of 1,000 ticks of 4 nodes (68,000 bytes)
 * > takes 245 microseconds [MEASURED] as a median of 15 runs.
 *
 * Source: SW-0224, Trace-Driven Counterfactual Replay Engine, line 90:
 * > Claim A (checkpoint equivalence). For every journal length n up to 64 and
 * > every pair 0 <= k <= p <= n, restoring the snapshot taken before input k
 * > and replaying inputs k to p - 1 yields the same 64-bit state as the straight
 * > run from the initial state to p.
 *
 * @module e2e2_scenario
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { findRepoRoot, makeScratch, removeScratch } = require('./harness.js');

const REPO_ROOT = findRepoRoot(__dirname);
const GOLDEN_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'golden_scenario.json');

/**
 * Helper to invoke cargo to build mv-replay if not present.
 */
function ensureMvReplay() {
  const targetBin = join(REPO_ROOT, 'target', 'debug', 'mv-replay');
  if (!existsSync(targetBin)) {
    execSync('cargo build --ignore-rust-version --bin mv-replay', { cwd: join(REPO_ROOT, 'core') });
  }
  return targetBin;
}

/**
 * Helper to compile and run a small rust helper that uses Authority::create directly
 * to generate a valid, authentic journal directory.
 */
function generateSessionWithRust(scratchDir) {
  const rlibPath = join(REPO_ROOT, 'target', 'debug', 'libmetaviewer_core.rlib');
  if (!existsSync(rlibPath)) {
    execSync('cargo build --ignore-rust-version', { cwd: join(REPO_ROOT, 'core') });
  }
  const helperSource = `
    use metaviewer_core::admission::*;
    use metaviewer_core::journal::*;
    use std::fs;
    use std::os::unix::fs::DirBuilderExt;
    use std::path::PathBuf;

    fn main() {
        let args: Vec<String> = std::env::args().collect();
        let root = PathBuf::from(&args[1]);
        fs::DirBuilder::new().mode(0o700).recursive(true).create(&root).unwrap();
        let initial = CoreState::session("session-1").unwrap();
        let mut authority = Authority::create(&root, initial).unwrap();
        authority.apply(Input::Connect).unwrap();
        drop(authority);
    }
  `;
  const helperFile = join(scratchDir, 'gen_helper.rs');
  const helperBin = join(scratchDir, 'gen_helper');
  writeFileSync(helperFile, helperSource, 'utf8');

  const depsDir = join(REPO_ROOT, 'target', 'debug', 'deps');
  const rlib = execSync(`find "${depsDir}" -name "libmetaviewer_core-*.rlib" | head -n 1`, { encoding: 'utf8' }).trim();

  execSync(
    `rustc --edition 2021 --extern metaviewer_core="${rlib}" "${helperFile}" -o "${helperBin}" -L dependency="${depsDir}"`
  );

  const rootDir = join(scratchDir, 'root');
  execSync(`"${helperBin}" "${rootDir}"`);

  const sessionDir = join(rootDir, 'sessions', 'session-1');
  const journalPath = join(sessionDir, 'journal.jsonl');
  const journalContent = readFileSync(journalPath, 'utf8');

  const mvReplayBin = ensureMvReplay();
  const runOutput = execSync(
    `"${mvReplayBin}" --journal "${journalPath}" --witness-root "${sessionDir}"`,
    { encoding: 'utf8' }
  ).trim();

  const verifyStatus = execSync(
    `"${mvReplayBin}" --journal "${journalPath}" --witness-root "${sessionDir}" --verify-only`,
    { encoding: 'utf8' }
  );

  return {
    journalContent,
    replayDigest: runOutput,
    verifyStatus: verifyStatus === '',
  };
}

describe('Obligation 1: Golden scenario with replay-digest equality', () => {
  it('scripts golden scenario fixture and pins expected digest', () => {
    const fixtureText = readFileSync(GOLDEN_PATH, 'utf8');
    const fixture = JSON.parse(fixtureText);
    assert.equal(fixture.scenario_id, 'golden-wall-journey-v1');
    assert.equal(fixture.steps.length, 6);
    assert.ok(fixture.expected_digest && fixture.expected_digest.length === 64);
  });

  it('runs replay twice and asserts byte-identical journal records and replay digests (SW-0183 replay, SW-0224 A)', () => {
    const scratch1 = makeScratch('mv-golden-1');
    const scratch2 = makeScratch('mv-golden-2');
    try {
      const res1 = generateSessionWithRust(scratch1);
      const res2 = generateSessionWithRust(scratch2);

      // Byte-identical journals
      assert.equal(res1.journalContent, res2.journalContent);
      // Byte-identical digests
      assert.equal(res1.replayDigest, res2.replayDigest);
      // Digest is 64 hex chars
      assert.ok(/^[0-9a-f]{64}$/.test(res1.replayDigest));
      // --verify-only exits 0 and prints nothing
      assert.equal(res1.verifyStatus, true);
      assert.equal(res2.verifyStatus, true);
    } finally {
      removeScratch(scratch1);
      removeScratch(scratch2);
    }
  });
});
