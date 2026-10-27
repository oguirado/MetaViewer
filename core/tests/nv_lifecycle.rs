use metaviewer_core::admission::{CoreState, Input, LifecycleUpdate, Surface};
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
fn nv_a8_update_preserves_verbs_and_lost_can_recover() {
    let mut s = CoreState::new("nv-session", 10).unwrap();
    s.apply(&lifecycle(LifecycleUpdate::Created(surface())))
        .unwrap();
    s.apply(&lifecycle(LifecycleUpdate::Lost)).unwrap();
    let mut update = surface();
    update.allowed_verbs.clear();
    assert_eq!(
        s.apply(&lifecycle(LifecycleUpdate::Updated(update)))
            .unwrap()
            .reason,
        None
    );
    assert!(s.surfaces["surface-nv"].live);
    assert_eq!(s.surfaces["surface-nv"].allowed_verbs, ["mouse"]);
}
