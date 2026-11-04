#![forbid(unsafe_code)]
use metaviewer_core::admission::{
    AdmissionRequest, CoreState, Frame, Input, LifecycleUpdate, Surface,
};
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;
fn agent() -> Endpoint {
    Endpoint {
        component: Component::Agent,
        instance: "agent-fixture".into(),
    }
}
fn surface() -> Surface {
    Surface {
        display: "display-fixture".into(),
        owner: agent(),
        agent_controlled: true,
        live: true,
        frame: None,
        refresh_after: None,
        allowed_verbs: vec![],
    }
}
fn lifecycle(update: LifecycleUpdate) -> Input {
    Input::Lifecycle {
        surface_id: "surface-fixture".into(),
        update,
    }
}
fn create() -> Input {
    Input::GuestCommandRequest{request:serde_json::from_value(json!({"schema":"guest_command_request/v0.2","request_id":"request-create","op":"create","params":{"profile_id":"guest-command-arm64-v1"}})).unwrap(),caller:Endpoint{component:Component::Ui,instance:"ui-fixture".into()},agent:agent(),other_resources:false,received_ns:0}
}
#[test]
fn destroyed_only_history_preserves_tombstone_and_admits_first_guest() {
    let mut s = CoreState::new("session-fixture", 10).unwrap();
    s.apply(&lifecycle(LifecycleUpdate::Created(surface())))
        .unwrap();
    s.apply(&lifecycle(LifecycleUpdate::Destroyed)).unwrap();
    assert!(!s.has_unclosed_graphical_custody());
    assert!(s.surfaces.contains_key("surface-fixture"));
    assert!(s.is_destroyed("surface-fixture"));
    let mut recovered: CoreState = serde_json::from_slice(&s.snapshot().unwrap()).unwrap();
    assert!(!recovered.has_unclosed_graphical_custody());
    assert_eq!(recovered.apply(&create()).unwrap().reason, None);
    assert!(recovered.guest_command.held);
    assert_eq!(recovered.remaining_budget, 9);
}
#[test]
fn active_lost_and_false_live_without_destroyed_proof_all_block() {
    for lost in [false, true] {
        let mut s = CoreState::new("session-fixture", 10).unwrap();
        s.apply(&lifecycle(LifecycleUpdate::Created(surface())))
            .unwrap();
        if lost {
            s.apply(&lifecycle(LifecycleUpdate::Lost)).unwrap();
        }
        assert!(s.has_unclosed_graphical_custody());
        assert_eq!(s.apply(&create()).unwrap().reason, Some(Refusal::Policy));
        assert!(!s.guest_command.started);
        assert_eq!(s.remaining_budget, 10);
    }
    let mut s = CoreState::new("session-fixture", 10).unwrap();
    let mut row = surface();
    row.live = false;
    s.surfaces.insert("surface-fixture".into(), row);
    assert!(s.has_unclosed_graphical_custody());
}
#[test]
fn lease_draining_or_pending_without_a_surface_never_looks_free() {
    let mut s = CoreState::new("session-fixture", 10).unwrap();
    s.leases.insert("surface-old".into(), "lease-old".into());
    assert!(s.has_unclosed_graphical_custody());
    s.leases.clear();
    s.draining
        .insert("proposal-old".into(), "surface-old".into());
    assert!(s.has_unclosed_graphical_custody());
    let mut s = CoreState::new("session-fixture", 10).unwrap();
    s.apply(&Input::Connect).unwrap();
    s.apply(&lifecycle(LifecycleUpdate::Created(surface())))
        .unwrap();
    s.apply(&Input::Frame {
        surface_id: "surface-fixture".into(),
        frame: Frame {
            sha256: "a".repeat(64),
            generation: 1,
            width: 10,
            height: 10,
        },
    })
    .unwrap();
    let raw = json!({"schema":"envelope/v0.2","msg_id":"message-proposal","session_id":"session-fixture","ts_ns":0,"from":agent(),"to":{"component":"core","instance":"core-fixture"},"nonce":"nonce-proposal","seq":1,"body":{"schema":"action_proposal/v0.2","proposal_id":"proposal-fixture","surface_id":"surface-fixture","based_on_frame":{"generation":1,"sha256":"a".repeat(64)},"action":{"type":"click","x":1,"y":1,"button":"left"},"expectation":{"type":"text_present","text":"ready"},"budget":{"max_ms":100,"max_retries":0}}});
    let p = AdmissionRequest::decode(&raw.to_string(), &agent(), "session-fixture", 1, 0).unwrap();
    s.apply(&Input::Propose(p)).unwrap();
    assert!(!s.pending.is_empty());
    // Poison contrast: even absent surface rows cannot erase a retained pending job.
    s.surfaces.clear();
    s.leases.clear();
    s.draining.clear();
    assert!(s.has_unclosed_graphical_custody());
    assert_eq!(s.apply(&create()).unwrap().reason, Some(Refusal::Policy));
}
#[test]
fn held_headless_and_unknown_guest_never_release_capacity_or_refund_budget() {
    let mut s = CoreState::new("session-fixture", 10).unwrap();
    s.headless.held = true;
    assert_eq!(s.apply(&create()).unwrap().reason, Some(Refusal::Policy));
    assert_eq!(s.remaining_budget, 10);
    let mut s = CoreState::new("session-fixture", 10).unwrap();
    assert_eq!(s.apply(&create()).unwrap().reason, None);
    s.guest_command.uncertain();
    assert!(s.guest_command.held);
    assert_eq!(
        s.apply(&lifecycle(LifecycleUpdate::Created(surface())))
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert_eq!(s.remaining_budget, 9);
}
