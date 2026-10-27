#![forbid(unsafe_code)]
use metaviewer_core::admission::{
    AdmissionRequest, CoreState, Frame, Input, LifecycleUpdate, Surface,
};
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;

fn surface() -> Surface {
    Surface {
        display: "display-1".into(),
        owner: Endpoint {
            component: Component::Agent,
            instance: "agent-1".into(),
        },
        agent_controlled: true,
        live: true,
        frame: None,
        refresh_after: None,
        allowed_verbs: vec!["advance".into()],
    }
}

fn lifecycle(update: LifecycleUpdate) -> Input {
    Input::Lifecycle {
        surface_id: "surface-1".into(),
        update,
    }
}

fn dispatched() -> CoreState {
    let mut state = CoreState::new("session-1", 10).unwrap();
    state.apply(&Input::Connect).unwrap();
    state
        .apply(&lifecycle(LifecycleUpdate::Created(surface())))
        .unwrap();
    state
        .apply(&Input::Frame {
            surface_id: "surface-1".into(),
            frame: Frame {
                sha256: "a".repeat(64),
                generation: 1,
                width: 10,
                height: 10,
            },
        })
        .unwrap();
    let raw = json!({
        "schema":"envelope/v0.2", "msg_id":"message-1", "session_id":"session-1",
        "ts_ns":0, "from":surface().owner, "to":{"component":"core","instance":"core-1"},
        "nonce":"nonce-1", "seq":1,
        "body":{"schema":"action_proposal/v0.2", "proposal_id":"proposal-1",
            "surface_id":"surface-1", "based_on_frame":{"generation":1,"sha256":"a".repeat(64)},
            "action":{"type":"click","x":3,"y":4,"button":"left"},
            "expectation":{"type":"text_present","text":"ready"},
            "budget":{"max_ms":100,"max_retries":1}}
    });
    let request =
        AdmissionRequest::decode(&raw.to_string(), &surface().owner, "session-1", 1, 0).unwrap();
    assert_eq!(state.apply(&Input::Propose(request)).unwrap().reason, None);
    assert!(
        state
            .apply(&Input::Dispatch {
                proposal_id: "proposal-1".into(),
                now_ns: 1,
            })
            .unwrap()
            .dispatch
    );
    state
}

#[test]
fn standby_preserves_live_surface_and_dispatched_proposal() {
    let mut state = dispatched();
    let pending = state.pending.clone();
    let leases = state.leases.clone();
    let budget = state.remaining_budget;
    let mut metadata = surface();
    metadata.live = false;
    metadata.display = "display-2".into();
    let out = state
        .apply(&lifecycle(LifecycleUpdate::Updated(metadata)))
        .unwrap();
    assert_eq!(out.reason, None);
    assert!(out.cancelled.is_empty());
    assert_eq!(out.cancellation_reason, None);
    assert!(state.surfaces["surface-1"].live);
    assert_eq!(state.surfaces["surface-1"].display, "display-2");
    assert_eq!(state.pending, pending);
    assert_eq!(state.leases, leases);
    assert!(state.draining.is_empty());
    assert_eq!(state.remaining_budget, budget);
    assert_eq!(
        state.surfaces["surface-1"].refresh_after,
        Some(out.core_seq)
    );
    assert_eq!(
        state
            .apply(&Input::Receipt {
                proposal_id: "proposal-1".into(),
                epoch: 1,
            })
            .unwrap()
            .reason,
        None
    );
}

#[test]
fn explicit_loss_cancels_and_keeps_dispatched_work_draining() {
    let mut state = dispatched();
    let out = state.apply(&lifecycle(LifecycleUpdate::Lost)).unwrap();
    assert_eq!(out.reason, None);
    assert!(!state.surfaces["surface-1"].live);
    assert_eq!(out.cancelled, ["proposal-1"]);
    assert_eq!(
        out.cancellation_reason,
        Some(Refusal::SurfaceNotAgentControlled)
    );
    assert!(state.pending.is_empty());
    assert_eq!(state.draining["proposal-1"], "surface-1");
    assert_eq!(state.leases["surface-1"], "proposal-1");
}

#[test]
fn ceded_metadata_still_cancels_without_marking_surface_lost() {
    let mut state = dispatched();
    let mut metadata = surface();
    metadata.live = false;
    metadata.agent_controlled = false;
    let out = state
        .apply(&lifecycle(LifecycleUpdate::Updated(metadata)))
        .unwrap();
    assert!(state.surfaces["surface-1"].live);
    assert!(!state.surfaces["surface-1"].agent_controlled);
    assert_eq!(out.cancelled, ["proposal-1"]);
    assert_eq!(
        out.cancellation_reason,
        Some(Refusal::SurfaceNotAgentControlled)
    );
    // Metadata cannot restore control after it has been ceded.
    state
        .apply(&lifecycle(LifecycleUpdate::Updated(surface())))
        .unwrap();
    assert!(!state.surfaces["surface-1"].agent_controlled);
}

#[test]
fn case4_surface_notice_keeps_authority_and_proposal() {
    let mut state = dispatched();
    let before = state.domain_snapshot().unwrap();
    let out = state.apply(&Input::SurfaceNotice).unwrap();
    assert_eq!(out.reason, None);
    assert!(out.cancelled.is_empty());
    assert_eq!(state.domain_snapshot().unwrap(), before);
}

#[test]
fn destroyed_surface_refuses_metadata_resurrection() {
    let mut state = dispatched();
    let out = state.apply(&lifecycle(LifecycleUpdate::Destroyed)).unwrap();
    assert_eq!(out.cancelled, ["proposal-1"]);
    assert!(!state.surfaces["surface-1"].live);
    let before = state.domain_snapshot().unwrap();
    assert_eq!(
        state
            .apply(&lifecycle(LifecycleUpdate::Updated(surface())))
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert_eq!(state.domain_snapshot().unwrap(), before);
}

#[test]
fn metadata_preserves_admitted_verbs() {
    for verbs in [vec![], vec!["forbidden".into()]] {
        let mut state = dispatched();
        let mut metadata = surface();
        metadata.allowed_verbs = verbs;
        state
            .apply(&lifecycle(LifecycleUpdate::Updated(metadata)))
            .unwrap();
        assert_eq!(state.surfaces["surface-1"].allowed_verbs, ["advance"]);
    }
}
