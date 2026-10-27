'use strict';
// E2E Item 10: Correlation trace (E8)
// Cites SW-0170 C8 and §2.4 (E8).
// Drives real metaviewer_core via core-driver.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRust } = require('./core-driver.js');
const { makeScratch, removeScratch } = require('./harness.js');

test('Item 10: Real core correlation trace requires strictly increasing sequence numbers (E8)', () => {
  const scratch = makeScratch('mv-trace-core');
  try {
    const rustScript = `
      use metaviewer_core::admission::*;
      use std::fs;
      use std::os::unix::fs::DirBuilderExt;
      use std::path::PathBuf;

      fn main() {
          let args: Vec<String> = std::env::args().collect();
          let root = PathBuf::from(&args[1]).join("trace_session");
          fs::DirBuilder::new().mode(0o700).recursive(true).create(&root).unwrap();

          let initial = CoreState::session("session-trace").unwrap();
          let mut authority = Authority::create(&root, initial).unwrap();
          authority.apply(Input::Connect).unwrap();

          let w1 = authority.retain_witness(b"frame-trace").unwrap();
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

          // 1. Submit seq 1 -> Admitted
          let req1_json = serde_json::json!({
              "schema": "envelope/v0.2",
              "msg_id": "prop-1",
              "ts_ns": 0,
              "from": {"component": "agent", "instance": "agent-1"},
              "to": {"component": "core", "instance": "authority"},
              "session_id": "session-trace",
              "seq": 1,
              "nonce": "nonce-1",
              "body": {
                  "schema": "action_proposal/v0.2",
                  "proposal_id": "proposal-1",
                  "surface_id": "s1",
                  "based_on_frame": {"sha256": w1.sha256, "generation": 1},
                  "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                  "expectation": {"type": "text_present", "text": "ok"},
                  "budget": {"max_ms": 100, "max_retries": 0}
              }
          });
          let req1 = AdmissionRequest::decode(
              &req1_json.to_string(),
              &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
              "session-trace", 1, 0,
          ).unwrap();
          let out1 = authority.apply_with_witnesses(Input::Propose(req1), vec![w1.clone()]).unwrap();
          println!("STEP1_REASON:{:?}", out1.reason);

          // 2. Submit duplicate/out-of-order seq 1 -> Refused with Policy (must NOT attach to default trace)
          let req2_json = serde_json::json!({
              "schema": "envelope/v0.2",
              "msg_id": "prop-2",
              "ts_ns": 0,
              "from": {"component": "agent", "instance": "agent-1"},
              "to": {"component": "core", "instance": "authority"},
              "session_id": "session-trace",
              "seq": 1, // Duplicate sequence!
              "nonce": "nonce-2",
              "body": {
                  "schema": "action_proposal/v0.2",
                  "proposal_id": "proposal-2",
                  "surface_id": "s1",
                  "based_on_frame": {"sha256": w1.sha256, "generation": 1},
                  "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                  "expectation": {"type": "text_present", "text": "ok"},
                  "budget": {"max_ms": 100, "max_retries": 0}
              }
          });
          let req2 = AdmissionRequest::decode(
              &req2_json.to_string(),
              &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
              "session-trace", 1, 0,
          ).unwrap();
          let out2 = authority.apply_with_witnesses(Input::Propose(req2), vec![w1.clone()]).unwrap();
          println!("STEP2_REASON:{:?}", out2.reason);
      }
    `;

    const output = runRust(scratch, rustScript).trim();
    assert.ok(output.includes('STEP1_REASON:None'), `Step 1 must be admitted, got:\n${output}`);
    assert.ok(output.includes('STEP2_REASON:Some(Policy)'), `Out-of-order seq 1 must be refused with Policy, got:\n${output}`);
  } finally {
    removeScratch(scratch);
  }
});
