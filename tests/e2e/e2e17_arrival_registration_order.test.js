'use strict';
// Registration and arrival-order determinism against metaviewer_core.
// Mutation: bypass the conflict lease check in CoreState::check (core/src/admission/mod.rs)
// -> run1 admits 3 proposals instead of 1 and the arrival-order assertion fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRust } = require('./core-driver.js');
const { makeScratch, removeScratch } = require('./harness.js');

test('real core arrival-order determinism yields identical admitted proposal count', () => {
  const scratch = makeScratch('mv-order-core');
  try {
    const rustScript = `
      use metaviewer_core::admission::*;
      use std::fs;
      use std::os::unix::fs::DirBuilderExt;
      use std::path::PathBuf;

      fn run_order_batch(order: Vec<u64>, root_path: PathBuf) -> usize {
          fs::DirBuilder::new().mode(0o700).recursive(true).create(&root_path).unwrap();
          let initial = CoreState::session("session-order").unwrap();
          let mut authority = Authority::create(&root_path, initial).unwrap();
          authority.apply(Input::Connect).unwrap();

          let w1 = authority.retain_witness(b"frame-order").unwrap();
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

          let mut admitted = 0;
          for seq in order {
              let req_json = serde_json::json!({
                  "schema": "envelope/v0.2",
                  "msg_id": format!("prop-{seq}"),
                  "ts_ns": 0,
                  "from": {"component": "agent", "instance": "agent-1"},
                  "to": {"component": "core", "instance": "authority"},
                  "session_id": "session-order",
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
                  "session-order", 1, 0,
              ).unwrap();

              let out = authority.apply_with_witnesses(Input::Propose(req), vec![w1.clone()]).unwrap();
              if out.reason.is_none() {
                  admitted += 1;
              }
          }

          admitted
      }

      fn main() {
          let args: Vec<String> = std::env::args().collect();
          let root = PathBuf::from(&args[1]);

          let a1 = run_order_batch(vec![1, 2, 3], root.join("run1"));
          let a2 = run_order_batch(vec![3, 2, 1], root.join("run2"));

          println!("ADMITTED_RUN1:{}", a1);
          println!("ADMITTED_RUN2:{}", a2);
      }
    `;

    const lines = runRust(scratch, rustScript).trim().split('\n');
    const a1 = parseInt(lines.find((l) => l.startsWith('ADMITTED_RUN1:')).split(':')[1], 10);
    const a2 = parseInt(lines.find((l) => l.startsWith('ADMITTED_RUN2:')).split(':')[1], 10);

    assert.equal(a1, 1, 'first run admits exactly 1 proposal (locked after first)');
    assert.equal(a2, 1, 'second run admits exactly 1 proposal across arrival permutation');
    assert.equal(a1, a2, 'multiset of admitted proposals must be equal across arrival permutations');
  } finally {
    removeScratch(scratch);
  }
});
