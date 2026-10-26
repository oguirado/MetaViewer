#![forbid(unsafe_code)]
use metaviewer_core::admission::*;
use metaviewer_core::journal::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "mv-admission-perm-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Deterministic std-only xorshift64 PRNG
struct Prng(u64);
impl Prng {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0xdeadbeef } else { seed })
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn gen_range(&mut self, min: usize, max: usize) -> usize {
        if min >= max {
            return min;
        }
        min + (self.next_u64() as usize % (max - min + 1))
    }
    fn shuffle<T>(&mut self, slice: &mut [T]) {
        for i in (1..slice.len()).rev() {
            let j = self.gen_range(0, i);
            slice.swap(i, j);
        }
    }
}

fn admission_fixture(n: u64, agent_inst: &str, hash: &str, surface_id: &str) -> AdmissionRequest {
    let raw = json!({
        "schema": "envelope/v0.2",
        "msg_id": format!("input-{n}"),
        "ts_ns": 0,
        "from": {"component": "agent", "instance": agent_inst},
        "to": {"component": "core", "instance": "core-1"},
        "session_id": "session-1",
        "seq": n,
        "nonce": format!("nonce-{n}"),
        "body": {
            "schema": "action_proposal/v0.2",
            "proposal_id": format!("proposal-{n}"),
            "surface_id": surface_id,
            "based_on_frame": {"sha256": hash, "generation": 1},
            "action": {"type": "click", "x": 1, "y": 2, "button": "left"},
            "expectation": {"type": "text_present", "text": "ready"},
            "budget": {"max_ms": 10, "max_retries": 0}
        }
    });
    AdmissionRequest::decode(
        &raw.to_string(),
        &metaviewer_core::Endpoint {
            component: metaviewer_core::Component::Agent,
            instance: agent_inst.into(),
        },
        "session-1",
        1,
        0,
    )
    .unwrap()
}

fn setup_authority(t: &Temp, surfaces: &[(&str, &str, &str)]) -> (Authority, Witness) {
    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    let witness = c.retain_witness(b"frame-witness-1").unwrap();

    for (s_id, disp_id, agent_inst) in surfaces {
        let surface = Surface {
            display: (*disp_id).into(),
            owner: metaviewer_core::Endpoint {
                component: metaviewer_core::Component::Agent,
                instance: (*agent_inst).into(),
            },
            agent_controlled: true,
            live: true,
            frame: Some(Frame {
                sha256: witness.sha256.clone(),
                generation: 1,
                width: 10,
                height: 10,
            }),
            refresh_after: None,
            allowed_verbs: vec![],
        };
        c.apply_with_witnesses(
            Input::Surface {
                id: (*s_id).into(),
                surface,
            },
            vec![witness.clone()],
        )
        .unwrap();
    }
    (c, witness)
}

#[test]
fn fisher_yates_50_permutations_and_verdict_determinism() {
    let mut prng = Prng::new(0x123456789abcdef0);

    // Order-independent inputs across distinct independent surfaces and displays owned by respective agents
    let surfaces_spec = &[
        ("surface-1", "display-1", "agent-1"),
        ("surface-2", "display-2", "agent-2"),
        ("surface-3", "display-3", "agent-3"),
    ];

    let t_ref = Temp::new();
    let (mut c_ref, w) = setup_authority(&t_ref, surfaces_spec);

    let inputs_base = vec![
        Input::Propose(admission_fixture(1, "agent-1", &w.sha256, "surface-1")),
        Input::Propose(admission_fixture(2, "agent-2", &w.sha256, "surface-2")),
        Input::Propose(admission_fixture(3, "agent-3", &w.sha256, "surface-3")),
    ];

    // Reference ascending run
    let mut ref_outcomes = Vec::new();
    for input in &inputs_base {
        ref_outcomes.push(
            c_ref
                .apply_with_witnesses(input.clone(), vec![w.clone()])
                .unwrap(),
        );
    }
    let ref_snapshot = c_ref.state().snapshot().unwrap();
    drop(c_ref);

    // Run 50 Fisher-Yates permutations
    for _ in 0..50 {
        let t_perm = Temp::new();
        let (mut c_perm, w_perm) = setup_authority(&t_perm, surfaces_spec);

        let mut permuted = inputs_base.clone();
        prng.shuffle(&mut permuted);

        let mut perm_outcomes = Vec::new();
        for input in &permuted {
            perm_outcomes.push(
                c_perm
                    .apply_with_witnesses(input.clone(), vec![w_perm.clone()])
                    .unwrap(),
            );
        }

        // Assert every admission on distinct independent surface succeeded
        assert!(perm_outcomes.iter().all(|o| o.reason.is_none()));

        // Order-independent scripts arrive at identical final domain snapshot
        assert_eq!(c_perm.state().snapshot().unwrap(), ref_snapshot);
    }
}

#[test]
fn permutation_divergence_exact_rules() {
    // When inputs are dependent, permutation causes controlled divergence according to exact refusal rules:
    // Duplicate proposal_id -> Policy
    // Stale frame generation -> StaleFrame

    let t = Temp::new();
    let (mut c, w) = setup_authority(&t, &[("surface-1", "display-1", "agent-1")]);

    let p1 = admission_fixture(1, "agent-1", &w.sha256, "surface-1");
    // Duplicate p1
    let p1_dup = admission_fixture(1, "agent-1", &w.sha256, "surface-1");

    let o1 = c
        .apply_with_witnesses(Input::Propose(p1), vec![w.clone()])
        .unwrap();
    assert_eq!(o1.reason, None);

    let o2 = c
        .apply_with_witnesses(Input::Propose(p1_dup), vec![w.clone()])
        .unwrap();
    assert_eq!(o2.reason, Some(metaviewer_core::Refusal::Policy));

    // Update surface with frame generation 2
    c.apply_with_witnesses(
        Input::Frame {
            surface_id: "surface-1".into(),
            frame: Frame {
                sha256: w.sha256.clone(),
                generation: 2,
                width: 10,
                height: 10,
            },
        },
        vec![w.clone()],
    )
    .unwrap();

    // Proposal based on frame generation 1 is now stale -> StaleFrame
    let p_stale = admission_fixture(3, "agent-1", &w.sha256, "surface-1");
    let o_stale = c
        .apply_with_witnesses(Input::Propose(p_stale), vec![w.clone()])
        .unwrap();
    assert_eq!(o_stale.reason, Some(metaviewer_core::Refusal::StaleFrame));
}

#[test]
fn lease_race_3_contenders_and_display_conflicts() {
    // Extend lease race model to >= 3 contenders on same surface:
    // Exactly one contender wins admission!
    let t = Temp::new();
    let (c, w) = setup_authority(&t, &[("surface-1", "display-1", "agent-1")]);
    let c = std::sync::Arc::new(std::sync::Mutex::new(c));

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let threads: Vec<_> = (1..=4)
        .map(|n| {
            let c = c.clone();
            let w = w.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                c.lock()
                    .unwrap()
                    .apply_with_witnesses(
                        Input::Propose(admission_fixture(n, "agent-1", &w.sha256, "surface-1")),
                        vec![w],
                    )
                    .unwrap()
            })
        })
        .collect();

    let outcomes: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|o| o.reason.is_none()).count(), 1);

    // Display conflict pairs: two surfaces sharing display-1
    let t2 = Temp::new();
    let (mut c2, w2) = setup_authority(
        &t2,
        &[
            ("surface-1", "display-1", "agent-1"),
            ("surface-2", "display-1", "agent-1"),
        ],
    );

    // Propose on surface-1 first
    let p_surf1 = admission_fixture(10, "agent-1", &w2.sha256, "surface-1");
    let o_surf1 = c2
        .apply_with_witnesses(Input::Propose(p_surf1), vec![w2.clone()])
        .unwrap();
    assert_eq!(o_surf1.reason, None);

    // Propose on surface-2 (same display-1) -> LockedByOther refusal!
    let p_surf2 = admission_fixture(11, "agent-1", &w2.sha256, "surface-2");
    let o_surf2 = c2
        .apply_with_witnesses(Input::Propose(p_surf2), vec![w2])
        .unwrap();
    assert_eq!(
        o_surf2.reason,
        Some(metaviewer_core::Refusal::LockedByOther)
    );
}
