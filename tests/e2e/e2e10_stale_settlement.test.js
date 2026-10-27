'use strict';
// Stale-frame refusal settlement and budget conservation against metaviewer_core.
// Mutation: bypass the stale-frame sha256/generation check in CoreState::check
// -> stale gen-7 proposal against gen-8 frame is admitted and deducts budget.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRust } = require('./core-driver.js');
const { makeScratch, removeScratch } = require('./harness.js');

test('real core stale-frame refusal gen7->gen8 settles cleanly without budget or domain mutation', () => {
  const scratch = makeScratch('mv-stale-core');
  try {
    const rustScript = `
      use metaviewer_core::admission::*;
      use std::fs;
      use std::os::unix::fs::DirBuilderExt;
      use std::path::PathBuf;

      fn main() {
          let args: Vec<String> = std::env::args().collect();
          let root = PathBuf::from(&args[1]).join("stale_session");
          fs::DirBuilder::new().mode(0o700).recursive(true).create(&root).unwrap();

          let initial = CoreState::session("session-stale").unwrap();
          let mut authority = Authority::create(&root, initial).unwrap();
          authority.apply(Input::Connect).unwrap();

          let w1 = authority.retain_witness(b"frame-gen7").unwrap();
          let w2 = authority.retain_witness(b"frame-gen8").unwrap();

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
                  generation: 7,
                  width: 100,
                  height: 100,
              }),
              refresh_after: None,
              allowed_verbs: vec![],
          };

          authority.apply_with_witnesses(Input::Surface { id: "s1".into(), surface }, vec![w1.clone()]).unwrap();

          // Advance frame to generation 8
          let frame8 = Frame {
              sha256: w2.sha256.clone(),
              generation: 8,
              width: 100,
              height: 100,
          };
          authority.apply_with_witnesses(Input::Frame { surface_id: "s1".into(), frame: frame8 }, vec![w2.clone()]).unwrap();

          let budget_before = authority.state().remaining_budget;

          // Propose action based on gen 7 frame
          let req_json = serde_json::json!({
              "schema": "envelope/v0.2",
              "msg_id": "prop-stale",
              "ts_ns": 0,
              "from": {"component": "agent", "instance": "agent-1"},
              "to": {"component": "core", "instance": "authority"},
              "session_id": "session-stale",
              "seq": 1,
              "nonce": "nonce-stale",
              "body": {
                  "schema": "action_proposal/v0.2",
                  "proposal_id": "proposal-stale",
                  "surface_id": "s1",
                  "based_on_frame": {"sha256": w1.sha256, "generation": 7},
                  "action": {"type": "click", "x": 10, "y": 10, "button": "left"},
                  "expectation": {"type": "text_present", "text": "ok"},
                  "budget": {"max_ms": 100, "max_retries": 0}
              }
          });

          let req = AdmissionRequest::decode(
              &req_json.to_string(),
              &metaviewer_core::Endpoint { component: metaviewer_core::Component::Agent, instance: "agent-1".into() },
              "session-stale", 1, 0,
          ).unwrap();

          let out = authority.apply_with_witnesses(Input::Propose(req), vec![w1.clone()]).unwrap();
          let budget_after = authority.state().remaining_budget;

          println!("REFUSAL:{:?}", out.reason);
          println!("BUDGET_BEFORE:{}", budget_before);
          println!("BUDGET_AFTER:{}", budget_after);
      }
    `;

    const output = runRust(scratch, rustScript).trim();
    assert.ok(output.includes('REFUSAL:Some(StaleFrame)'), `Stale proposal must return StaleFrame, got:\n${output}`);
    assert.ok(output.includes('BUDGET_BEFORE:10000'), `Budget before must be 10000, got:\n${output}`);
    assert.ok(output.includes('BUDGET_AFTER:10000'), `Budget must not decrease on refusal, got:\n${output}`);
  } finally {
    removeScratch(scratch);
  }
});
