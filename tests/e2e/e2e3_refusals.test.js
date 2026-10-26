'use strict';

/**
 * E2E3 Refusals and Preemption E2E Tests.
 *
 * Quotes cited:
 * Source: SW-0224, Trace-Driven Counterfactual Replay Engine, lines 132-134:
 * > A counterfactual engine fails in characteristic ways... The first is inventing
 * > an outcome... The model refuses with 64. The second is confusing exhaustion
 * > with absence... The third is partial state: an operation that fails half way...
 * > The sixth is veto misordering: a request that should be vetoed for recursion
 * > being reported as an empty journal, which sends the operator to fix the wrong
 * > thing; the model fixes the order.
 *
 * @module e2e3_refusals
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { findRepoRoot, makeScratch, removeScratch } = require('./harness.js');

const REPO_ROOT = findRepoRoot(__dirname);

function ensureCoreBuilt() {
  const rlibPath = join(REPO_ROOT, 'target', 'debug', 'libmetaviewer_core.rlib');
  if (!existsSync(rlibPath)) {
    execSync('cargo build --ignore-rust-version', { cwd: join(REPO_ROOT, 'core') });
  }
}

function runRefusalTestScript(scratchDir, rustScript) {
  ensureCoreBuilt();
  const helperFile = join(scratchDir, 'refusal_helper.rs');
  const helperBin = join(scratchDir, 'refusal_helper');
  writeFileSync(helperFile, rustScript, 'utf8');

  const depsDir = join(REPO_ROOT, 'target', 'debug', 'deps');
  const rlib = execSync(`find "${depsDir}" -name "libmetaviewer_core-*.rlib" | head -n 1`, { encoding: 'utf8' }).trim();
  const serdeJsonRlib = execSync(`find "${depsDir}" -name "libserde_json-*.rlib" | head -n 1`, { encoding: 'utf8' }).trim();

  execSync(
    `rustc --edition 2021 --extern metaviewer_core="${rlib}" --extern serde_json="${serdeJsonRlib}" "${helperFile}" -o "${helperBin}" -L dependency="${depsDir}"`
  );

  const rootDir = join(scratchDir, 'state_dir');
  const stdout = execSync(`"${helperBin}" "${rootDir}"`, { encoding: 'utf8' }).trim();
  return stdout.split('\n');
}

describe('Obligation 2: Stale-frame refusal E2E (SW-0224)', () => {
  it('submits act bound to old frame generation after newer generation is admitted and asserts STALE_FRAME refusal without partial state', () => {
    const scratch = makeScratch('mv-refusal-stale');
    try {
      const rustScript = `
        use metaviewer_core::admission::*;
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

            let w1 = authority.retain_witness(b"frame-gen-1-bytes").unwrap();
            let w2 = authority.retain_witness(b"frame-gen-2-bytes").unwrap();

            let surface1 = Surface {
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

            authority.apply_with_witnesses(Input::Surface {
                id: "surface-1".into(),
                surface: surface1,
            }, vec![w1.clone()]).unwrap();

            // Advance frame to generation 2
            authority.apply_with_witnesses(Input::Frame {
                surface_id: "surface-1".into(),
                frame: Frame {
                    sha256: w2.sha256.clone(),
                    generation: 2,
                    width: 100,
                    height: 100,
                },
            }, vec![w2.clone()]).unwrap();

            let req_json = serde_json::json!({
                "schema": "envelope/v0.2",
                "msg_id": "prop-stale-1",
                "ts_ns": 0,
                "from": {"component": "agent", "instance": "agent-1"},
                "to": {"component": "core", "instance": "authority"},
                "session_id": "session-1",
                "seq": 1,
                "nonce": "nonce-stale-1",
                "body": {
                    "schema": "action_proposal/v0.2",
                    "proposal_id": "proposal-stale-1",
                    "surface_id": "surface-1",
                    "based_on_frame": {"sha256": w1.sha256, "generation": 1},
                    "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                    "expectation": {"type": "text_present", "text": "ok"},
                    "budget": {"max_ms": 100, "max_retries": 0}
                }
            });

            let req = AdmissionRequest::decode(
                &req_json.to_string(),
                &metaviewer_core::Endpoint {
                    component: metaviewer_core::Component::Agent,
                    instance: "agent-1".into(),
                },
                "session-1",
                1,
                0,
            ).unwrap();

            let before_pending_count = authority.state().pending.len();
            let outcome = authority.apply_with_witnesses(Input::Propose(req), vec![w1]).unwrap();
            let after_pending_count = authority.state().pending.len();

            println!("REASON:{:?}", outcome.reason);
            println!("DISPATCH:{}", outcome.dispatch);
            println!("PENDING_MUTATED:{}", before_pending_count != after_pending_count);
        }
      `;
      const lines = runRefusalTestScript(scratch, rustScript);
      assert.equal(lines[0], 'REASON:Some(StaleFrame)');
      assert.equal(lines[1], 'DISPATCH:false');
      assert.equal(lines[2], 'PENDING_MUTATED:false');
    } finally {
      removeScratch(scratch);
    }
  });
});

describe('Obligation 3: Human take_control preemption E2E (SW-0224 veto misordering)', () => {
  it('refuses agent act after take_control with exact SURFACE_NOT_AGENT_CONTROLLED code, and admits again after release_control', () => {
    const scratch = makeScratch('mv-refusal-preempt');
    try {
      const rustScript = `
        use metaviewer_core::admission::*;
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

            let w1 = authority.retain_witness(b"frame-sha-1-bytes").unwrap();
            let w2 = authority.retain_witness(b"frame-sha-2-bytes").unwrap();
            let w3 = authority.retain_witness(b"frame-sha-3-bytes").unwrap();

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

            authority.apply_with_witnesses(Input::Surface {
                id: "surface-1".into(),
                surface,
            }, vec![w1.clone()]).unwrap();

            // Human takes control
            let take_out = authority.apply(Input::TakeControl { surface_id: "surface-1".into() }).unwrap();
            println!("TAKE_CONTROL_READY:{}", take_out.control_ready);

            // Fresh frame published under human control to clear refresh fence
            authority.apply_with_witnesses(Input::Frame {
                surface_id: "surface-1".into(),
                frame: Frame {
                    sha256: w2.sha256.clone(),
                    generation: 2,
                    width: 100,
                    height: 100,
                },
            }, vec![w2.clone()]).unwrap();

            // Agent proposes action while human has control
            let req_json = serde_json::json!({
                "schema": "envelope/v0.2",
                "msg_id": "prop-preempt-1",
                "ts_ns": 0,
                "from": {"component": "agent", "instance": "agent-1"},
                "to": {"component": "core", "instance": "authority"},
                "session_id": "session-1",
                "seq": 1,
                "nonce": "nonce-preempt-1",
                "body": {
                    "schema": "action_proposal/v0.2",
                    "proposal_id": "proposal-preempt-1",
                    "surface_id": "surface-1",
                    "based_on_frame": {"sha256": w2.sha256, "generation": 2},
                    "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                    "expectation": {"type": "text_present", "text": "ok"},
                    "budget": {"max_ms": 100, "max_retries": 0}
                }
            });

            let req1 = AdmissionRequest::decode(
                &req_json.to_string(),
                &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
                "session-1", 1, 0,
            ).unwrap();

            let out1 = authority.apply_with_witnesses(Input::Propose(req1), vec![w2.clone()]).unwrap();
            println!("PREEMPTED_REASON:{:?}", out1.reason);

            // Human releases control
            authority.apply(Input::ReleaseControl { surface_id: "surface-1".into() }).unwrap();

            // Submit new frame to clear refresh_after fence after release
            authority.apply_with_witnesses(Input::Frame {
                surface_id: "surface-1".into(),
                frame: Frame {
                    sha256: w3.sha256.clone(),
                    generation: 3,
                    width: 100,
                    height: 100,
                },
            }, vec![w3.clone()]).unwrap();

            let req_json2 = serde_json::json!({
                "schema": "envelope/v0.2",
                "msg_id": "prop-preempt-2",
                "ts_ns": 0,
                "from": {"component": "agent", "instance": "agent-1"},
                "to": {"component": "core", "instance": "authority"},
                "session_id": "session-1",
                "seq": 2,
                "nonce": "nonce-preempt-2",
                "body": {
                    "schema": "action_proposal/v0.2",
                    "proposal_id": "proposal-preempt-2",
                    "surface_id": "surface-1",
                    "based_on_frame": {"sha256": w3.sha256, "generation": 3},
                    "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                    "expectation": {"type": "text_present", "text": "ok"},
                    "budget": {"max_ms": 100, "max_retries": 0}
                }
            });

            let req2 = AdmissionRequest::decode(
                &req_json2.to_string(),
                &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
                "session-1", 1, 0,
            ).unwrap();

            let out2 = authority.apply_with_witnesses(Input::Propose(req2), vec![w3]).unwrap();
            println!("ADMITTED_REASON:{:?}", out2.reason);
        }
      `;
      const lines = runRefusalTestScript(scratch, rustScript);
      assert.equal(lines[0], 'TAKE_CONTROL_READY:true');
      assert.equal(lines[1], 'PREEMPTED_REASON:Some(SurfaceNotAgentControlled)');
      assert.equal(lines[2], 'ADMITTED_REASON:None');
    } finally {
      removeScratch(scratch);
    }
  });
});

describe('Obligation 9: Exhaustion versus absence (SW-0224)', () => {
  it('acting on unknown capsule id vs known but destroyed capsule yields documented refusal codes', () => {
    const scratch = makeScratch('mv-refusal-absence');
    try {
      const rustScript = `
        use metaviewer_core::admission::*;
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

            let w1 = authority.retain_witness(b"unk-frame-bytes").unwrap();
            let w2 = authority.retain_witness(b"dead-frame-bytes").unwrap();

            // Unknown capsule id proposal -> StaleFrame refusal
            let req_unknown = serde_json::json!({
                "schema": "envelope/v0.2",
                "msg_id": "prop-unk-1",
                "ts_ns": 0,
                "from": {"component": "agent", "instance": "agent-1"},
                "to": {"component": "core", "instance": "authority"},
                "session_id": "session-1",
                "seq": 1,
                "nonce": "nonce-unk-1",
                "body": {
                    "schema": "action_proposal/v0.2",
                    "proposal_id": "proposal-unk-1",
                    "surface_id": "unknown-capsule-99",
                    "based_on_frame": {"sha256": w1.sha256, "generation": 1},
                    "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                    "expectation": {"type": "text_present", "text": "ok"},
                    "budget": {"max_ms": 100, "max_retries": 0}
                }
            });

            let req1 = AdmissionRequest::decode(
                &req_unknown.to_string(),
                &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
                "session-1", 1, 0,
            ).unwrap();

            let out1 = authority.apply_with_witnesses(Input::Propose(req1), vec![w1]).unwrap();
            println!("UNKNOWN_REASON:{:?}", out1.reason);

            // Create a surface then set live = false (destroyed / offline)
            let surface_dead = Surface {
                display: "display-1".into(),
                owner: metaviewer_core::Endpoint {
                    component: metaviewer_core::Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: false, // Destroyed / offline
                frame: Some(Frame {
                    sha256: w2.sha256.clone(),
                    generation: 1,
                    width: 100,
                    height: 100,
                }),
                refresh_after: None,
                allowed_verbs: vec![],
            };

            authority.apply_with_witnesses(Input::Surface {
                id: "surface-dead-1".into(),
                surface: surface_dead,
            }, vec![w2.clone()]).unwrap();

            let req_dead = serde_json::json!({
                "schema": "envelope/v0.2",
                "msg_id": "prop-dead-1",
                "ts_ns": 0,
                "from": {"component": "agent", "instance": "agent-1"},
                "to": {"component": "core", "instance": "authority"},
                "session_id": "session-1",
                "seq": 2,
                "nonce": "nonce-dead-1",
                "body": {
                    "schema": "action_proposal/v0.2",
                    "proposal_id": "proposal-dead-1",
                    "surface_id": "surface-dead-1",
                    "based_on_frame": {"sha256": w2.sha256, "generation": 1},
                    "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                    "expectation": {"type": "text_present", "text": "ok"},
                    "budget": {"max_ms": 100, "max_retries": 0}
                }
            });

            let req2 = AdmissionRequest::decode(
                &req_dead.to_string(),
                &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
                "session-1", 1, 0,
            ).unwrap();

            let out2 = authority.apply_with_witnesses(Input::Propose(req2), vec![w2]).unwrap();
            println!("DESTROYED_REASON:{:?}", out2.reason);
        }
      `;
      const lines = runRefusalTestScript(scratch, rustScript);
      assert.equal(lines[0], 'UNKNOWN_REASON:Some(StaleFrame)');
      assert.equal(lines[1], 'DESTROYED_REASON:Some(SurfaceNotAgentControlled)');
      assert.notEqual(lines[0], lines[1], 'exhaustion (unknown) and absence (destroyed) must produce distinct refusal codes');
    } finally {
      removeScratch(scratch);
    }
  });
});
