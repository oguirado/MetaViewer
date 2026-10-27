#![forbid(unsafe_code)]
use metaviewer_core::admission::*;
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;

fn sender() -> Endpoint {
    Endpoint {
        component: Component::Agent,
        instance: "agent-1".into(),
    }
}
fn proposal(n: u64) -> AdmissionRequest {
    request(n, json!({"type":"click","x":3,"y":4,"button":"left"}))
}
fn request(n: u64, action: serde_json::Value) -> AdmissionRequest {
    let raw = json!({"schema":"envelope/v0.2","msg_id":format!("msg-{n}"),"session_id":"session-1","ts_ns":0,"from":sender(),"to":{"component":"core","instance":"core-1"},"nonce":format!("nonce-{n}"),"seq":n,"body":{"schema":"action_proposal/v0.2","proposal_id":format!("proposal-{n}"),"surface_id":"surface-1","based_on_frame":{"generation":1,"sha256":"a".repeat(64)},"action":action,"expectation":{"type":"text_present","text":"ready"},"budget":{"max_ms":100,"max_retries":1}}});
    AdmissionRequest::decode(&raw.to_string(), &sender(), "session-1", 1, 0).unwrap()
}
fn state() -> CoreState {
    let mut s = CoreState::new("session-1", 10).unwrap();
    s.apply(&Input::Connect).unwrap();
    s.apply(&Input::Surface {
        id: "surface-1".into(),
        surface: Surface {
            display: "display-1".into(),
            owner: sender(),
            agent_controlled: true,
            live: true,
            frame: Some(Frame {
                sha256: "a".repeat(64),
                generation: 1,
                width: 10,
                height: 10,
            }),
            refresh_after: None,
            allowed_verbs: vec!["advance".into()],
        },
    })
    .unwrap();
    s
}
#[test]
fn matrix_and_order() {
    assert_eq!(
        state().apply(&Input::Propose(proposal(1))).unwrap().reason,
        None
    );
    type Mutation = Box<dyn Fn(&mut CoreState)>;
    let cases: Vec<(Refusal, Mutation)> = vec![
        (
            Refusal::StaleFrame,
            Box::new(|s| s.surfaces.get_mut("surface-1").unwrap().frame = None),
        ),
        (
            Refusal::StaleFrame,
            Box::new(|s| {
                s.surfaces
                    .get_mut("surface-1")
                    .unwrap()
                    .frame
                    .as_mut()
                    .unwrap()
                    .sha256 = "b".repeat(64)
            }),
        ),
        (
            Refusal::StaleFrame,
            Box::new(|s| {
                s.surfaces
                    .get_mut("surface-1")
                    .unwrap()
                    .frame
                    .as_mut()
                    .unwrap()
                    .generation = 2
            }),
        ),
        (
            Refusal::SurfaceNotAgentControlled,
            Box::new(|s| s.surfaces.get_mut("surface-1").unwrap().agent_controlled = false),
        ),
        (
            Refusal::LockedByOther,
            Box::new(|s| {
                s.leases.insert("surface-1".into(), "occupied".into());
            }),
        ),
        (
            Refusal::BudgetExceeded,
            Box::new(|s| s.remaining_budget = 0),
        ),
    ];
    for (reason, mutate) in cases {
        let mut s = state();
        mutate(&mut s);
        let before = s.domain_snapshot().unwrap();
        let out = s.apply(&Input::Propose(proposal(1))).unwrap();
        assert_eq!(out.reason, Some(reason));
        assert_eq!(s.domain_snapshot().unwrap(), before);
        assert_eq!(s.core_seq, 3);
    }
    let mut s = state();
    assert_eq!(
        s.apply(&Input::Propose(request(
            1,
            json!({"type":"click","x":10,"y":0,"button":"left"})
        )))
        .unwrap()
        .reason,
        Some(Refusal::OutOfBounds)
    );
    assert_eq!(s.apply(&Input::Propose(request(2,json!({"type":"lane_submit","verb":"forbidden","payload":{"nonce":"n","seq":1,"command":"run","args":[]}})))).unwrap().reason,Some(Refusal::Policy));
    let mut s = state();
    s.surfaces.get_mut("surface-1").unwrap().agent_controlled = false;
    s.surfaces.get_mut("surface-1").unwrap().frame = None;
    assert_eq!(
        s.apply(&Input::Propose(proposal(1))).unwrap().reason,
        Some(Refusal::StaleFrame)
    );
}
#[test]
fn replay_identity_preempts_and_reservations_are_atomic() {
    let mut s = state();
    let p = proposal(1);
    s.apply(&Input::Propose(p.clone())).unwrap();
    assert_eq!(s.remaining_budget, 9);
    assert_eq!(s.pending.len(), 1);
    assert_eq!(
        s.apply(&Input::Propose(p)).unwrap().reason,
        Some(Refusal::Policy)
    );
    assert_eq!(s.remaining_budget, 9);
    assert_eq!(
        s.apply(&Input::Propose(proposal(2))).unwrap().reason,
        Some(Refusal::LockedByOther)
    );
    assert_eq!(s.remaining_budget, 9);
}
#[test]
fn takeover_epoch_and_dispatch_are_nonreusable() {
    let mut s = state();
    s.apply(&Input::Propose(proposal(1))).unwrap();
    assert!(
        s.apply(&Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 1
        })
        .unwrap()
        .dispatch
    );
    assert!(
        !s.apply(&Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 2
        })
        .unwrap()
        .dispatch
    );
    s.apply(&Input::TakeControl {
        surface_id: "surface-1".into(),
    })
    .unwrap();
    assert!(s.pending.is_empty());
    assert!(!s.leases.is_empty());
    assert_eq!(
        s.apply(&Input::ReleaseControl {
            surface_id: "surface-1".into()
        })
        .unwrap()
        .reason,
        Some(Refusal::Policy)
    );
    assert!(
        s.apply(&Input::Drain {
            proposal_id: "proposal-1".into(),
            epoch: 1
        })
        .unwrap()
        .control_ready
    );
    assert!(s.leases.is_empty());
    s.apply(&Input::ReleaseControl {
        surface_id: "surface-1".into(),
    })
    .unwrap();
    assert_eq!(
        s.apply(&Input::Propose(proposal(2))).unwrap().reason,
        Some(Refusal::StaleFrame)
    );
    let mut s = state();
    s.apply(&Input::Propose(proposal(1))).unwrap();
    s.apply(&Input::Connect).unwrap();
    assert_eq!(
        s.apply(&Input::Receipt {
            proposal_id: "proposal-1".into(),
            epoch: 1
        })
        .unwrap()
        .reason,
        Some(Refusal::Policy)
    );
    assert!(
        !s.apply(&Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 1
        })
        .unwrap()
        .dispatch
    );
}
#[test]
fn dispatch_rechecks_frame_owner_deadline() {
    for mode in 0..3 {
        let mut s = state();
        s.apply(&Input::Propose(proposal(1))).unwrap();
        if mode == 0 {
            s.surfaces.get_mut("surface-1").unwrap().frame = None;
        }
        if mode == 1 {
            s.surfaces.get_mut("surface-1").unwrap().owner.instance = "other".into();
        }
        let out = s
            .apply(&Input::Dispatch {
                proposal_id: "proposal-1".into(),
                now_ns: if mode == 2 { 100_000_000 } else { 1 },
            })
            .unwrap();
        assert!(!out.dispatch);
    }
}

#[test]
fn valid_receipt_releases_once_and_lane_replay_is_persistent() {
    let mut s = state();
    let action = json!({"type":"lane_submit","verb":"advance","payload":{"nonce":"lane-nonce","seq":1,"command":"run","args":[]}});
    assert_eq!(
        s.apply(&Input::Propose(request(1, action.clone())))
            .unwrap()
            .reason,
        None
    );
    assert!(
        s.apply(&Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 1
        })
        .unwrap()
        .dispatch
    );
    assert_eq!(
        s.apply(&Input::Receipt {
            proposal_id: "proposal-1".into(),
            epoch: 1
        })
        .unwrap()
        .reason,
        None
    );
    assert_eq!(
        s.apply(&Input::Receipt {
            proposal_id: "proposal-1".into(),
            epoch: 1
        })
        .unwrap()
        .reason,
        Some(Refusal::Policy)
    );
    assert!(s.leases.is_empty());
    assert_eq!(s.remaining_budget, 9);
    assert_eq!(
        s.apply(&Input::Propose(request(2, action))).unwrap().reason,
        Some(Refusal::Policy)
    );
}
#[test]
fn fresh_capture_same_generation_reopens_after_release() {
    let mut s = state();
    s.apply(&Input::Propose(proposal(1))).unwrap();
    let out = s
        .apply(&Input::TakeControl {
            surface_id: "surface-1".into(),
        })
        .unwrap();
    assert!(out.control_ready);
    assert_eq!(out.cancelled, vec!["proposal-1"]);
    assert_eq!(
        out.cancellation_reason,
        Some(Refusal::SurfaceNotAgentControlled)
    );
    s.apply(&Input::ReleaseControl {
        surface_id: "surface-1".into(),
    })
    .unwrap();
    let frame = s.surfaces["surface-1"].frame.clone().unwrap();
    s.apply(&Input::Frame {
        surface_id: "surface-1".into(),
        frame,
    })
    .unwrap();
    assert_eq!(s.apply(&Input::Propose(proposal(2))).unwrap().reason, None);
}
#[test]
fn checked_sequence_epoch_and_frame_regression_leave_state_unchanged() {
    let mut s = state();
    s.epoch = u64::MAX;
    let before = s.snapshot().unwrap();
    assert_eq!(s.apply(&Input::Connect), Err(AdmissionError::Overflow));
    assert_eq!(s.snapshot().unwrap(), before);
    s.core_seq = u64::MAX;
    assert_eq!(s.apply(&Input::Connect), Err(AdmissionError::Overflow));
    let mut s = state();
    let mut f = s.surfaces["surface-1"].frame.clone().unwrap();
    f.generation = 0;
    let before = s.snapshot().unwrap();
    assert!(s
        .apply(&Input::Frame {
            surface_id: "surface-1".into(),
            frame: f
        })
        .is_err());
    assert_eq!(s.snapshot().unwrap(), before);
}
#[test]
fn display_lease_conflicts_across_distinct_surfaces() {
    let mut s = state();
    let surface = s.surfaces["surface-1"].clone();
    s.apply(&Input::Surface {
        id: "surface-2".into(),
        surface,
    })
    .unwrap();
    s.leases.insert("surface-2".into(), "occupied".into());
    assert_eq!(
        s.apply(&Input::Propose(proposal(1))).unwrap().reason,
        Some(Refusal::LockedByOther)
    );
}

#[test]
fn bounds_tick_interval_and_deadline_overflow_refuse_without_domain_mutation() {
    let p = proposal(1);
    let encoded = serde_json::to_value(p).unwrap();
    let original: serde_json::Value =
        serde_json::from_str(encoded["raw"].as_str().unwrap()).unwrap();
    for (mode, reason) in [
        (0, Refusal::OutOfBounds),
        (1, Refusal::Policy),
        (2, Refusal::BudgetExceeded),
        (3, Refusal::BudgetExceeded),
    ] {
        let mut raw = original.clone();
        match mode {
            0 => {
                raw["body"]["expectation"] =
                    json!({"type":"changed_region","bbox":{"x":u64::MAX,"y":0,"w":2,"h":1}})
            }
            1 => {
                raw["body"]["expectation"] = json!({"type":"state_sha256_change","before":"b".repeat(64),"min_tick":2,"max_tick":1})
            }
            2 => raw["body"]["budget"]["max_ms"] = json!(u64::MAX),
            _ => raw["body"]["action"] = json!({"type":"wait","ms":101}),
        }
        let mut s = state();
        let before = s.domain_snapshot().unwrap();
        if mode == 0 || mode == 2 {
            // The frozen wire rail now refuses u64::MAX before admission.
            assert_eq!(
                AdmissionRequest::decode(&raw.to_string(), &sender(), "session-1", 1, 0),
                Err(AdmissionError::OutOfBounds)
            );
            assert_eq!(s.domain_snapshot().unwrap(), before);
            // Also retain admission bounds/deadline-overflow coverage for the
            // largest admitted integer (milliseconds still overflow nanoseconds).
            if mode == 0 {
                raw["body"]["expectation"]["bbox"]["x"] = metaviewer_core::MAX_WIRE_INTEGER.into();
            } else {
                raw["body"]["budget"]["max_ms"] = metaviewer_core::MAX_WIRE_INTEGER.into();
            }
        }
        let r = AdmissionRequest::decode(&raw.to_string(), &sender(), "session-1", 1, 0).unwrap();
        assert_eq!(s.apply(&Input::Propose(r)).unwrap().reason, Some(reason));
        assert_eq!(s.domain_snapshot().unwrap(), before);
    }
}
#[test]
fn closed_decode_and_authenticated_peer_are_required() {
    let encoded = serde_json::to_value(proposal(1)).unwrap();
    let original = encoded["raw"].as_str().unwrap();
    let mut foreign = sender();
    foreign.instance = "foreign".into();
    assert!(AdmissionRequest::decode(original, &foreign, "session-1", 1, 0).is_err());
    assert!(AdmissionRequest::decode(original, &sender(), "foreign-session", 1, 0).is_err());
    for mode in 0..4 {
        let mut raw: serde_json::Value = serde_json::from_str(original).unwrap();
        match mode {
            0 => {
                raw["body"].as_object_mut().unwrap().remove("budget");
            }
            1 => raw["body"]["extra"] = json!(true),
            2 => raw["body"]["action"]["x"] = json!(1.5),
            _ => raw["body"]["action"]["type"] = json!("verb"),
        };
        assert!(AdmissionRequest::decode(&raw.to_string(), &sender(), "session-1", 1, 0).is_err());
    }
}

#[test]
fn failed_dispatch_consumes_stale_permit() {
    let mut s = state();
    s.apply(&Input::Propose(proposal(1))).unwrap();
    s.surfaces.get_mut("surface-1").unwrap().agent_controlled = false;
    assert!(
        !s.apply(&Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 1
        })
        .unwrap()
        .dispatch
    );
    s.surfaces.get_mut("surface-1").unwrap().agent_controlled = true;
    assert!(
        !s.apply(&Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 1
        })
        .unwrap()
        .dispatch
    );
    assert!(s.pending.is_empty());
    assert!(s.leases.is_empty());
}

#[test]
fn scroll_executor_rails_refuse_before_effect() {
    for field in ["dx", "dy"] {
        for delta in [
            i64::from(i32::MIN),
            i64::from(i32::MAX),
            i64::from(i32::MIN) - 1,
            i64::from(i32::MAX) + 1,
        ] {
            let mut s = state();
            let before = s.domain_snapshot().unwrap();
            let mut action = json!({"type":"scroll", "dx":0, "dy":0});
            action[field] = delta.into();
            let out = s.apply(&Input::Propose(request(1, action))).unwrap();
            if i32::try_from(delta).is_ok() {
                assert_eq!(out.reason, Some(Refusal::Policy));
            } else {
                assert_eq!(out.reason, Some(Refusal::OutOfBounds));
            }
            assert_eq!(s.domain_snapshot().unwrap(), before);
            assert!(s.leases.is_empty());
            assert!(s.pending.is_empty());
        }
    }
}

#[test]
fn unsupported_wait_refuses_before_reservation_but_native_inputs_admit() {
    let mut s = state();
    let before = s.domain_snapshot().unwrap();
    let out = s
        .apply(&Input::Propose(request(1, json!({"type":"wait", "ms":1}))))
        .unwrap();
    assert_eq!(out.reason, Some(Refusal::Policy));
    assert_eq!(s.domain_snapshot().unwrap(), before);
    assert!(s.leases.is_empty());
    assert!(s.pending.is_empty());

    for action in [
        json!({"type":"click", "x":3, "y":4, "button":"left"}),
        json!({"type":"key", "keys":["a"]}),
        json!({"type":"type", "text":"ready"}),
    ] {
        let mut s = state();
        let budget = s.remaining_budget;
        let out = s.apply(&Input::Propose(request(1, action))).unwrap();
        assert_eq!(out.reason, None);
        assert_eq!(s.remaining_budget, budget - 1);
        assert_eq!(s.leases.len(), 1);
        assert_eq!(s.pending.len(), 1);
        assert!(
            s.apply(&Input::Dispatch {
                proposal_id: "proposal-1".into(),
                now_ns: 1,
            })
            .unwrap()
            .dispatch
        );
    }
}
