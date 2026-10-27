'use strict';
// Unknown vs destroyed capsule refusal distinction in metaviewer_core.
// Mutation: omit `old.live = false;` in LifecycleUpdate::Destroyed (core/src/admission/mod.rs)
// -> destroyed surface proposal does not return SurfaceNotAgentControlled.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRust } = require('./core-driver.js');
const { makeScratch, removeScratch } = require('./harness.js');

test('real core unknown vs destroyed capsule IDs yield distinct refusal outcomes', () => {
  const scratch = makeScratch('mv-unknown-destroyed-core');
  try {
    const rustScript = `
      use metaviewer_core::admission::*;
      use std::fs;
      use std::os::unix::fs::DirBuilderExt;
      use std::path::PathBuf;

      fn main() {
          let args: Vec<String> = std::env::args().collect();
          let root = PathBuf::from(&args[1]).join("ud_session");
          fs::DirBuilder::new().mode(0o700).recursive(true).create(&root).unwrap();

          let initial = CoreState::session("session-ud").unwrap();
          let mut authority = Authority::create(&root, initial).unwrap();
          authority.apply(Input::Connect).unwrap();

          let w1 = authority.retain_witness(b"frame-ud").unwrap();
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

          authority.apply_with_witnesses(Input::Surface { id: "s-registered".into(), surface }, vec![w1.clone()]).unwrap();

          // 1. Proposal on unknown surface id -> StaleFrame refusal
          let req_unknown_json = serde_json::json!({
              "schema": "envelope/v0.2",
              "msg_id": "prop-unknown",
              "ts_ns": 0,
              "from": {"component": "agent", "instance": "agent-1"},
              "to": {"component": "core", "instance": "authority"},
              "session_id": "session-ud",
              "seq": 1,
              "nonce": "nonce-unknown",
              "body": {
                  "schema": "action_proposal/v0.2",
                  "proposal_id": "proposal-unknown",
                  "surface_id": "s-unknown-nonexistent",
                  "based_on_frame": {"sha256": w1.sha256, "generation": 1},
                  "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                  "expectation": {"type": "text_present", "text": "ok"},
                  "budget": {"max_ms": 100, "max_retries": 0}
              }
          });
          let req_unknown = AdmissionRequest::decode(
              &req_unknown_json.to_string(),
              &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
              "session-ud", 1, 0,
          ).unwrap();
          let out_unknown = authority.apply_with_witnesses(Input::Propose(req_unknown), vec![w1.clone()]).unwrap();
          println!("UNKNOWN_REFUSAL:{:?}", out_unknown.reason);

          // 2. Destroy surface s-registered
          let destroy_update = Input::Lifecycle {
              surface_id: "s-registered".into(),
              update: LifecycleUpdate::Destroyed,
          };
          authority.apply(destroy_update).unwrap();

          // 3. Propose on destroyed surface -> SurfaceNotAgentControlled refusal
          let req_destroyed_json = serde_json::json!({
              "schema": "envelope/v0.2",
              "msg_id": "prop-destroyed",
              "ts_ns": 0,
              "from": {"component": "agent", "instance": "agent-1"},
              "to": {"component": "core", "instance": "authority"},
              "session_id": "session-ud",
              "seq": 2,
              "nonce": "nonce-destroyed",
              "body": {
                  "schema": "action_proposal/v0.2",
                  "proposal_id": "proposal-destroyed",
                  "surface_id": "s-registered",
                  "based_on_frame": {"sha256": w1.sha256, "generation": 1},
                  "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                  "expectation": {"type": "text_present", "text": "ok"},
                  "budget": {"max_ms": 100, "max_retries": 0}
              }
          });
          let req_destroyed = AdmissionRequest::decode(
              &req_destroyed_json.to_string(),
              &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
              "session-ud", 1, 0,
          ).unwrap();
          let out_destroyed = authority.apply_with_witnesses(Input::Propose(req_destroyed), vec![w1.clone()]).unwrap();
          println!("DESTROYED_REFUSAL:{:?}", out_destroyed.reason);
      }
    `;

    const output = runRust(scratch, rustScript).trim();
    assert.ok(output.includes('UNKNOWN_REFUSAL:Some(StaleFrame)'),
      `Unknown surface proposal must return StaleFrame, got:\n${output}`);
    assert.ok(output.includes('DESTROYED_REFUSAL:Some(SurfaceNotAgentControlled)'),
      `Destroyed surface proposal must return SurfaceNotAgentControlled, got:\n${output}`);
  } finally {
    removeScratch(scratch);
  }
});
