use metaviewer_core::admission::{CoreState, Frame, Input, LifecycleUpdate, Surface};
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;

fn surface() -> Surface {
    Surface {
        display: "display-nv".into(),
        owner: Endpoint {
            component: Component::Agent,
            instance: "agent-nv".into(),
        },
        agent_controlled: true,
        live: true,
        frame: None,
        refresh_after: None,
        allowed_verbs: vec!["mouse".into()],
    }
}
fn lifecycle(update: LifecycleUpdate) -> Input {
    Input::Lifecycle {
        surface_id: "surface-nv".into(),
        update,
    }
}
#[test]
fn nv_a7_destroyed_is_terminal_without_budget_burn() {
    let mut s = CoreState::new("nv-session", 10).unwrap();
    s.apply(&lifecycle(LifecycleUpdate::Created(surface())))
        .unwrap();
    s.apply(&lifecycle(LifecycleUpdate::Destroyed)).unwrap();
    let snapshot = s.domain_snapshot().unwrap();
    assert_eq!(
        s.apply(&lifecycle(LifecycleUpdate::Updated(surface())))
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert_eq!(s.domain_snapshot().unwrap(), snapshot);
    for op in ["destroy", "frame_subscribe", "frame_unsubscribe"] {
        let request = serde_json::from_value(
            json!({"schema":"surface_request/v0.2","op":op,"params":{"surface_id":"surface-nv"}}),
        )
        .unwrap();
        assert_eq!(
            s.apply(&Input::SurfaceRequest { request }).unwrap().reason,
            Some(Refusal::Policy)
        );
        assert_eq!(s.domain_snapshot().unwrap(), snapshot);
    }
    assert_eq!(s.remaining_budget, 10);
}
#[test]
fn nv_a8_update_preserves_verbs_and_lost_is_terminal() {
    // Mutation: revert the !old.live Policy guard in LifecycleUpdate::Updated so Lost can be revived.
    let mut s = CoreState::new("nv-session", 10).unwrap();
    s.apply(&lifecycle(LifecycleUpdate::Created(surface())))
        .unwrap();
    let mut update = surface();
    update.allowed_verbs.clear();
    assert_eq!(
        s.apply(&lifecycle(LifecycleUpdate::Updated(update.clone())))
            .unwrap()
            .reason,
        None
    );
    assert!(s.surfaces["surface-nv"].live);
    assert_eq!(s.surfaces["surface-nv"].allowed_verbs, ["mouse"]);
    let f1 = Frame {
        sha256: "a".repeat(64),
        generation: 1,
        width: 100,
        height: 60,
    };
    assert_eq!(
        s.apply(&Input::Frame {
            surface_id: "surface-nv".into(),
            frame: f1.clone(),
        })
        .unwrap()
        .reason,
        None
    );
    assert_eq!(s.surfaces["surface-nv"].frame, Some(f1.clone()));
    assert_eq!(s.surfaces["surface-nv"].refresh_after, None);
    assert_eq!(
        s.apply(&lifecycle(LifecycleUpdate::Lost)).unwrap().reason,
        None
    );
    assert!(!s.surfaces["surface-nv"].live);
    let frame_after_lost = s.surfaces["surface-nv"].frame.clone();
    let fence_after_lost = s.surfaces["surface-nv"].refresh_after;
    assert_eq!(frame_after_lost, Some(f1));
    assert!(fence_after_lost.is_some());
    assert_eq!(
        s.apply(&lifecycle(LifecycleUpdate::Updated(update.clone())))
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert!(!s.surfaces["surface-nv"].live);
    assert_eq!(s.surfaces["surface-nv"].frame, frame_after_lost);
    assert_eq!(s.surfaces["surface-nv"].refresh_after, fence_after_lost);
    assert_eq!(s.surfaces["surface-nv"].allowed_verbs, ["mouse"]);

    // Positive control: a new surface identity created after the loss works normally (replacement path).
    assert_eq!(
        s.apply(&Input::Lifecycle {
            surface_id: "surface-nv-replacement".into(),
            update: LifecycleUpdate::Created(surface()),
        })
        .unwrap()
        .reason,
        None
    );
    assert!(s.surfaces["surface-nv-replacement"].live);
    assert_eq!(
        s.surfaces["surface-nv-replacement"].allowed_verbs,
        ["mouse"]
    );
    assert_eq!(
        s.apply(&Input::Lifecycle {
            surface_id: "surface-nv-replacement".into(),
            update: LifecycleUpdate::Updated(update),
        })
        .unwrap()
        .reason,
        None
    );
    assert!(s.surfaces["surface-nv-replacement"].live);
    assert_eq!(
        s.surfaces["surface-nv-replacement"].allowed_verbs,
        ["mouse"]
    );
    let f2 = Frame {
        sha256: "b".repeat(64),
        generation: 1,
        width: 100,
        height: 60,
    };
    assert_eq!(
        s.apply(&Input::Frame {
            surface_id: "surface-nv-replacement".into(),
            frame: f2.clone(),
        })
        .unwrap()
        .reason,
        None
    );
    assert_eq!(s.surfaces["surface-nv-replacement"].frame, Some(f2));
    assert_eq!(s.surfaces["surface-nv-replacement"].refresh_after, None);
    let sub_replacement = serde_json::from_value(
        json!({"schema":"surface_request/v0.2","op":"frame_subscribe","params":{"surface_id":"surface-nv-replacement"}}),
    )
    .unwrap();
    assert_eq!(
        s.apply(&Input::SurfaceRequest {
            request: sub_replacement,
        })
        .unwrap()
        .reason,
        None
    );
    assert_eq!(s.remaining_budget, 9);
    assert!(!s.surfaces["surface-nv"].live);
    assert_eq!(s.surfaces["surface-nv"].frame, frame_after_lost);
    assert_eq!(s.surfaces["surface-nv"].refresh_after, fence_after_lost);
}
