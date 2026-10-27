'use strict';
// E2E Item 2: AC-04 control journey (E5)
// Cites SW-0224 §2.3 veto misordering (E5).
// Drives real metaviewer_core via core-driver.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRust } = require('./core-driver.js');
const { makeScratch, removeScratch } = require('./harness.js');

test('Item 2: Real core AC-04 human take_control, cancellation and preemption (E5)', () => {
  const scratch = makeScratch('mv-ac04-core');
  try {
    const rustScript = `
      use metaviewer_core::admission::*;
      use std::fs;
      use std::os::unix::fs::DirBuilderExt;
      use std::path::PathBuf;

      fn main() {
          let args: Vec<String> = std::env::args().collect();
          let root = PathBuf::from(&args[1]).join("ac04_session");
          fs::DirBuilder::new().mode(0o700).recursive(true).create(&root).unwrap();

          let initial = CoreState::session("session-ac04").unwrap();
          let mut authority = Authority::create(&root, initial).unwrap();
          authority.apply(Input::Connect).unwrap();

          let w1 = authority.retain_witness(b"frame-ac04").unwrap();
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

          // 1. Take control as human
          let takeover = Input::TakeControl {
              surface_id: "s1".into(),
          };
          let out1 = authority.apply(takeover).unwrap();
          println!("TAKEOVER_CANCELLED:{:?}", out1.cancelled);

          // 2. Proposal while human-controlled must be refused with SURFACE_NOT_AGENT_CONTROLLED
          let req_json = serde_json::json!({
              "schema": "envelope/v0.2",
              "msg_id": "prop-held",
              "ts_ns": 0,
              "from": {"component": "agent", "instance": "agent-1"},
              "to": {"component": "core", "instance": "authority"},
              "session_id": "session-ac04",
              "seq": 1,
              "nonce": "nonce-held",
              "body": {
                  "schema": "action_proposal/v0.2",
                  "proposal_id": "proposal-held",
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
              "session-ac04", 1, 0,
          ).unwrap();

          let out2 = authority.apply_with_witnesses(Input::Propose(req), vec![w1.clone()]).unwrap();
          if let Some(refusal) = out2.reason {
              println!("REFUSAL_CODE:{}", refusal.code());
          } else {
              println!("REFUSAL_CODE:NONE");
          }
      }
    `;

    const output = runRust(scratch, rustScript).trim();
    assert.ok(output.includes('REFUSAL_CODE:SURFACE_NOT_AGENT_CONTROLLED'),
      `Human takeover must preempt agent proposal with SURFACE_NOT_AGENT_CONTROLLED, got:\n${output}`);
  } finally {
    removeScratch(scratch);
  }
});
