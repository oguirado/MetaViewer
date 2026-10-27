use metaviewer_core::verify::{verify_receipt, Evidence};
use metaviewer_core::wire::payload::*;
use metaviewer_core::wire::*;
use serde_json::json;
use sha2::{Digest, Sha256};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fixture(
    expectation: serde_json::Value,
) -> (ActionProposal, Observation, Observation, ActionReceipt) {
    let frame = json!({"schema":"frame_ref/v0.2","surface_id":"fixture","generation":1,
        "tick":4,"ts_ns":1,"width":2,"height":1,"format":"rgb24",
        "ramws_path":"/dev/shm/fixture","sha256":hash(&[0;6]),"capture_us":1});
    let before: Observation =
        serde_json::from_value(json!({"schema":"observation/v0.2","frame_ref":frame,
        "ground_truth":{"source":"holdings_lane","state_sha256":hash(b"{\"v\":1}"),"tick":4}}))
        .unwrap();
    let mut after = before.clone();
    after.frame_ref.generation = 2;
    after.frame_ref.tick = 5;
    after.frame_ref.ts_ns = 3;
    after.frame_ref.sha256 = hash(&[1; 6]);
    after.ground_truth = Optional::Present(ObservationGroundTruth {
        source: ObservationGroundTruthSource::Value,
        state_sha256: hash(b"{\"v\":2}"),
        tick: 5,
    });
    let p = serde_json::from_value(json!({"schema":"action_proposal/v0.2","proposal_id":"p1",
        "surface_id":"fixture","based_on_frame":{"generation":1,"sha256":before.frame_ref.sha256},
        "action":{"type":"click","x":0,"y":0,"button":"left"},"expectation":expectation,
        "budget":{"max_ms":100,"max_retries":0}}))
    .unwrap();
    let r = serde_json::from_value(json!({"schema":"action_receipt/v0.2","proposal_id":"p1",
        "executed_at_ns":2,"after_frame":after.frame_ref,"verified":true,
        "verification":{"method":"pixel","detail":"untrusted claim"},"error":""}))
    .unwrap();
    (p, before, after, r)
}
fn pixel() -> serde_json::Value {
    json!({"type":"changed_region","bbox":{"x":0,"y":0,"w":1,"h":1}})
}
fn evidence() -> Evidence<'static> {
    Evidence {
        before_rgb: Some(&[0; 6]),
        after_rgb: Some(&[1; 6]),
        ..Evidence::default()
    }
}

#[test]
fn pixel_witness_and_negative_controls() {
    let (p, b, a, r) = fixture(pixel());
    assert!(verify_receipt(&p, &b, &a, &r, &evidence()).verified);
    for e in [
        Evidence::default(),
        Evidence {
            after_rgb: Some(&[]),
            ..evidence()
        },
        Evidence {
            after_rgb: Some(&[1; 3]),
            ..evidence()
        },
        Evidence {
            after_rgb: Some(&[2; 6]),
            ..evidence()
        },
    ] {
        assert!(!verify_receipt(&p, &b, &a, &r, &e).verified);
    }
    let mut bad = a.clone();
    bad.frame_ref.surface_id = "other".into();
    assert!(!verify_receipt(&p, &b, &bad, &r, &evidence()).verified);
    let mut bad = r.clone();
    bad.proposal_id = "other".into();
    assert!(!verify_receipt(&p, &b, &a, &bad, &evidence()).verified);
    bad = r.clone();
    bad.error = "input failed".into();
    assert!(!verify_receipt(&p, &b, &a, &bad, &evidence()).verified);
    let (p, b, mut a, mut r) = fixture(pixel());
    a.frame_ref.sha256 = hash(&[0; 6]);
    r.after_frame = a.frame_ref.clone();
    assert!(
        !verify_receipt(
            &p,
            &b,
            &a,
            &r,
            &Evidence {
                after_rgb: Some(&[0; 6]),
                ..evidence()
            }
        )
        .verified
    );
}

#[test]
fn holdings_chain_tick_window_and_negative_controls() {
    let (p, b, a, r) = fixture(
        json!({"type":"state_sha256_change","before":hash(b"{\"v\":1}"),"min_tick":5,"max_tick":5}),
    );
    let previous = hash(b"{\"v\":1}");
    let e = Evidence {
        semantic_frame_sha256: Some(&a.frame_ref.sha256),
        before_state: Some(b"{\"v\":1}"),
        after_state: Some(b"{\"v\":2}"),
        previous_state_sha256: Some(&previous),
        ..evidence()
    };
    assert!(verify_receipt(&p, &b, &a, &r, &e).verified);
    assert!(
        !verify_receipt(
            &p,
            &b,
            &a,
            &r,
            &Evidence {
                semantic_frame_sha256: None,
                ..e
            }
        )
        .verified
    );
    for e in [
        Evidence {
            after_state: None,
            ..e
        },
        Evidence {
            after_state: Some(b"{\"v\":3}"),
            ..e
        },
        Evidence {
            previous_state_sha256: None,
            ..e
        },
        Evidence {
            after_state: Some(b"{\"v\":2.0}"),
            ..e
        },
    ] {
        assert!(!verify_receipt(&p, &b, &a, &r, &e).verified);
    }
    for (low, high) in [(6, 7), (1, 4), (6, 5)] {
        let mut p = p.clone();
        if let ActionProposalExpectation::Case2(ref mut want) = p.expectation {
            want.min_tick = low;
            want.max_tick = high;
        }
        assert!(!verify_receipt(&p, &b, &a, &r, &e).verified);
    }
}

#[test]
fn element_witness_and_negative_controls() {
    let (p, b, a, r) =
        fixture(json!({"type":"element_state","role":"button","name":"Go","state":"enabled"}));
    let elements = [metaviewer_core::verify::ElementWitness {
        role: "button",
        name: "Go",
        state: "enabled",
    }];
    let e = Evidence {
        semantic_frame_sha256: Some(&a.frame_ref.sha256),
        elements: &elements,
        ..evidence()
    };
    assert!(verify_receipt(&p, &b, &a, &r, &e).verified);
    assert!(
        !verify_receipt(
            &p,
            &b,
            &a,
            &r,
            &Evidence {
                semantic_frame_sha256: None,
                ..e
            }
        )
        .verified
    );
    assert!(!verify_receipt(&p, &b, &a, &r, &evidence()).verified);
    let (p, b, a, r) =
        fixture(json!({"type":"element_state","role":"button","name":"Go","state":"disabled"}));
    assert!(!verify_receipt(&p, &b, &a, &r, &e).verified);
}

#[test]
fn checked_bounds_and_stale_frames_fail_closed() {
    let (mut p, b, a, r) = fixture(pixel());
    if let ActionProposalExpectation::Case0(ref mut want) = p.expectation {
        want.bbox.x = u64::MAX;
    }
    assert!(!verify_receipt(&p, &b, &a, &r, &evidence()).verified);
    let (p, b, mut a, mut r) = fixture(pixel());
    a.frame_ref.generation = 1;
    r.after_frame = a.frame_ref.clone();
    assert!(!verify_receipt(&p, &b, &a, &r, &evidence()).verified);
    let mut b = b.clone();
    b.frame_ref.width = u64::MAX;
    assert!(!verify_receipt(&p, &b, &a, &r, &evidence()).verified);
}

#[test]
fn ram_file_integrity_and_path_negative_controls() {
    use metaviewer_core::verify::read_published_frame;
    use std::os::unix::fs::symlink;
    let root = std::path::Path::new("/dev/shm").join(format!("mv-verify-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("frame");
    std::fs::write(&path, [1; 6]).unwrap();
    let (_, _, a, _) = fixture(pixel());
    let mut frame = a.frame_ref;
    frame.ramws_path = path.to_str().unwrap().into();
    assert_eq!(read_published_frame(&frame).unwrap(), [1; 6]);
    let link = root.join("link");
    symlink(&path, &link).unwrap();
    let mut bad = frame.clone();
    bad.ramws_path = link.to_str().unwrap().into();
    assert!(read_published_frame(&bad).is_err());
    bad.ramws_path = root.to_str().unwrap().into();
    assert!(read_published_frame(&bad).is_err());
    for bytes in [vec![], vec![1; 3], vec![2; 6], vec![1; 7]] {
        std::fs::write(&path, bytes).unwrap();
        assert!(read_published_frame(&frame).is_err());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn text_evidence_and_region_specific_negative_control() {
    let (p, b, a, r) = fixture(json!({"type":"text_present","text":"Ready"}));
    let e = Evidence {
        semantic_frame_sha256: Some(&a.frame_ref.sha256),
        text: &["Ready"],
        ..evidence()
    };
    assert!(verify_receipt(&p, &b, &a, &r, &e).verified);
    assert!(
        !verify_receipt(
            &p,
            &b,
            &a,
            &r,
            &Evidence {
                semantic_frame_sha256: None,
                ..e
            }
        )
        .verified
    );
    assert!(!verify_receipt(&p, &b, &a, &r, &evidence()).verified);
    let (p, b, mut a, mut r) = fixture(pixel());
    let rgb = [0, 0, 0, 1, 1, 1];
    a.frame_ref.sha256 = hash(&rgb);
    r.after_frame = a.frame_ref.clone();
    assert!(
        !verify_receipt(
            &p,
            &b,
            &a,
            &r,
            &Evidence {
                after_rgb: Some(&rgb),
                ..evidence()
            }
        )
        .verified
    );
}
