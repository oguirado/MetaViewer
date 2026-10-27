#![forbid(unsafe_code)]
// [TARGET, unit decision] Frozen wait_verify has no context override. Exercise
// the public product verifier with the same live receipt and retained pixels.
use metaviewer_core::verify::{verify_receipt, Evidence};
use metaviewer_core::wire::payload::{ActionProposal, ActionReceipt, Observation};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let fixture: Value = serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();
    let artifacts = PathBuf::from(&args[2]);
    let p: ActionProposal = serde_json::from_value(fixture["proposal"].clone()).unwrap();
    let r: ActionReceipt = serde_json::from_value(fixture["receipt"].clone()).unwrap();
    let observation = |frame: Value| -> Observation {
        serde_json::from_value(json!({"schema":"observation/v0.2", "frame_ref":frame,
            "vision":{"summary":"", "changed_regions":[], "elements":[]}}))
        .unwrap()
    };
    let b = observation(fixture["before"].clone());
    let a = observation(serde_json::to_value(&r.after_frame).unwrap());
    let before = fs::read(artifacts.join(&b.frame_ref.sha256)).unwrap();
    let after = fs::read(artifacts.join(&a.frame_ref.sha256)).unwrap();
    let evidence = Evidence {
        before_rgb: Some(&before),
        after_rgb: Some(&after),
        ..Evidence::default()
    };
    let baseline = verify_receipt(&p, &b, &a, &r, &evidence);
    assert!(
        baseline.verified,
        "live baseline must verify before mutation"
    );
    let mut wrong_surface = p.clone();
    wrong_surface.surface_id = format!("{}-different", p.surface_id);
    let surface = verify_receipt(&wrong_surface, &b, &a, &r, &evidence);
    let mut stale = p.clone();
    stale.based_on_frame.generation = p.based_on_frame.generation.checked_add(1).unwrap();
    let generation = verify_receipt(&stale, &b, &a, &r, &evidence);
    assert!(!surface.verified, "different surface verified");
    assert!(!generation.verified, "mismatched generation verified");
    println!(
        "{}",
        json!({"status":"PASS", "scope":"public core verify_receipt; same live receipt and retained pixels",
        "baseline":baseline, "different_surface":surface, "stale_generation":generation})
    );
}
