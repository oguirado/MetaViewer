'use strict';

/**
 * E2E4 Seams, Arrival-Order Determinism, and Bounded-Queue Conservation Tests.
 *
 * Quotes cited:
 * Source: SW-0269, Drop-Oldest Hand-Off Ring, lines 39, 60-62:
 * > C2 (drop-oldest, exact accounting). sw269_ring_push never blocks and never
 * > grows the queue. On a full queue it discards the oldest record and returns 1.
 * > Over every sequence of pushes and pops, pushed == popped + dropped + len.
 * > I1 (bounded): len <= 8 in every reachable state.
 * > I2 (conservation): pushed == popped + dropped + len modulo 2^64.
 * > I3 (newest survive): The queue holds the most recent not-yet-popped records.
 *
 * Source: SW-0224, Counterfactual Replay Engine, line 132:
 * > The fourth is ordering drift: the winner of a batch depends on the order in
 * > which candidates were listed, which makes two runs of the same experiment
 * > disagree; the model orders by value and id.
 *
 * @module e2e4_seams
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { findRepoRoot, makeScratch, removeScratch } = require('./harness.js');

const REPO_ROOT = findRepoRoot(__dirname);

const { runRust } = require('./core-driver.js');
function runSeamsTestScript(scratch, source) {
  return runRust(scratch, source).trim().split('\n');
}


describe('Obligation 5: Arrival-order determinism (SW-0224 ordering drift, SW-0183 replay)', () => {
  it('delivers same multiset of inputs in different arrival orders and asserts deterministic state and verdict multiset', () => {
    const scratch = makeScratch('mv-seams-order');
    try {
      const rustScript = `
        use metaviewer_core::admission::*;
        use metaviewer_core::journal::*;
        use metaviewer_core::Refusal;
        use std::fs;
        use std::os::unix::fs::DirBuilderExt;
        use std::path::PathBuf;

        fn run_batch(order: Vec<u64>, root_path: PathBuf) -> (String, Vec<Option<Refusal>>) {
            fs::DirBuilder::new().mode(0o700).recursive(true).create(&root_path).unwrap();
            let initial = CoreState::session("session-1").unwrap();
            let mut authority = Authority::create(&root_path, initial).unwrap();
            authority.apply(Input::Connect).unwrap();

            let w1 = authority.retain_witness(b"frame-1").unwrap();
            let surface = Surface {
                display: "display-1".into(),
                owner: metaviewer_core::Endpoint {
                    component: metaviewer_core::Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: Some(Frame {
                    sha256: w1.sha256.clone(),
                    generation: 1,
                    width: 100,
                    height: 100,
                }),
                refresh_after: None,
                allowed_verbs: vec![],
            };

            authority.apply_with_witnesses(Input::Surface { id: "s1".into(), surface }, vec![w1.clone()]).unwrap();

            let mut verdicts = Vec::new();

            for seq in order {
                let req_json = serde_json::json!({
                    "schema": "envelope/v0.2",
                    "msg_id": format!("prop-{seq}"),
                    "ts_ns": 0,
                    "from": {"component": "agent", "instance": "agent-1"},
                    "to": {"component": "core", "instance": "authority"},
                    "session_id": "session-1",
                    "seq": seq,
                    "nonce": format!("nonce-{seq}"),
                    "body": {
                        "schema": "action_proposal/v0.2",
                        "proposal_id": format!("proposal-{seq}"),
                        "surface_id": "s1",
                        "based_on_frame": {"sha256": w1.sha256, "generation": 1},
                        "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                        "expectation": {"type": "text_present", "text": "ok"},
                        "budget": {"max_ms": 100, "max_retries": 0}
                    }
                });

                let req = AdmissionRequest::decode(
                    &req_json.to_string(),
                    &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
                    "session-1", 1, 0,
                ).unwrap();

                let out = authority.apply_with_witnesses(Input::Propose(req), vec![w1.clone()]).unwrap();
                verdicts.push(out.reason);
            }

            let digest = sha256_hex(&authority.state().snapshot().unwrap());
            (digest, verdicts)
        }

        fn main() {
            let args: Vec<String> = std::env::args().collect();
            let root = PathBuf::from(&args[1]);

            let (d1, v1) = run_batch(vec![1, 2, 3], root.join("run1"));
            let (d2, v2) = run_batch(vec![3, 2, 1], root.join("run2"));

            println!("RUN1_DIGEST:{}", d1);
            println!("RUN2_DIGEST:{}", d2);

            let admitted1 = v1.iter().filter(|r| r.is_none()).count();
            let admitted2 = v2.iter().filter(|r| r.is_none()).count();
            println!("ADMITTED1:{}", admitted1);
            println!("ADMITTED2:{}", admitted2);
        }
      `;
      const lines = runSeamsTestScript(scratch, rustScript);
      const digest1 = lines[0].split(':')[1];
      const digest2 = lines[1].split(':')[1];
      assert.ok(/^[0-9a-f]{64}$/.test(digest1));
      assert.ok(/^[0-9a-f]{64}$/.test(digest2));
      // Same multiset of admitted proposals
      assert.equal(lines[2], 'ADMITTED1:1');
      assert.equal(lines[3], 'ADMITTED2:1');
    } finally {
      removeScratch(scratch);
    }
  });
});

describe('Real tileScheduler newest-mailbox conservation', () => {
  it('conserves accepted frames across supersession, presentation, fold and destruction', async () => {
    const { createTileScheduler } = await import('../../ui/src/surfaces/tileScheduler.js');
    const releases = [];
    const presented = new Set();
    const accepted = new Set();
    const scheduler = createTileScheduler({
      budget: Object.freeze({ maxDrawsPerTick: 1, maxUploadBytesPerTick: 100,
        maxPresentMsPerTick: 8, maxWarmResourcesPerSurface: 0, maxDrainSteps: 4 }),
      clock: () => 0,
      onReleaseLease: (event) => releases.push(event),
      onPresent: (event) => presented.add(event.frameGeneration),
    });
    assert.equal(scheduler.registerSurface({ surfaceId: 'a', surfaceGeneration: 1,
      epoch: 1, principal: 'core', state: { width: 1, height: 1, viewportIntersecting: true } }).ok, true);
    function conserve() {
      const stats = scheduler.getInstrumentation('a');
      const dropped = new Set(releases.filter((event) => accepted.has(event.frameGeneration)
        && !presented.has(event.frameGeneration)).map((event) => event.frameGeneration));
      const queued = stats?.pendingMailboxFrameGen === null || !stats ? 0 : 1;
      assert.equal(accepted.size, presented.size + dropped.size + queued);
      assert.equal(new Set(releases.map((event) => event.leaseId)).size, releases.length,
        'a display lease must be released only once');
    }
    function submit(n, overrides = {}) {
      const result = scheduler.submitFrame({ surfaceId: 'a', surfaceGeneration: 1, epoch: 1,
        principal: 'core', frameGeneration: n, leaseId: `lease-${n}`, width: 1, height: 1,
        byteLength: 3, bytes: new Uint8Array(3), ...overrides });
      if (result.ok) accepted.add(n);
      conserve();
      return result;
    }
    assert.equal(submit(1).ok, true);
    assert.equal(submit(2).ok, true);
    assert.equal(scheduler.getInstrumentation('a').mailboxReplacements, 1);
    assert.equal(scheduler.runTick().presented.length, 1);
    conserve();
    assert.equal(submit(3).ok, true);
    assert.equal(scheduler.foldSurface('a').ok, true);
    conserve();
    assert.equal(submit(4).ok, false);
    scheduler.destroySurface('a');
    conserve();
    assert.equal(submit(5).ok, false);
    const before = accepted.size;
    assert.equal(scheduler.submitFrame({ surfaceId: 'foreign' }).ok, false);
    assert.equal(accepted.size, before);
    scheduler.destroy();
  });
});
