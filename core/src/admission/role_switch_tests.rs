use super::*;

fn fixture() -> CoreState {
    let mut s = CoreState::new("switch-session", 20).unwrap();
    s.surfaces.insert(
        "browser".into(),
        Surface {
            display: ":199".into(),
            owner: Endpoint {
                component: crate::wire::Component::Agent,
                instance: "agent".into(),
            },
            agent_controlled: false,
            live: true,
            frame: None,
            refresh_after: None,
            allowed_verbs: vec![],
        },
    );
    s.human_roles.insert("browser".into());
    s
}
fn begin(id: &str, human: bool) -> Input {
    Input::BeginRoleSwitch {
        sender: Endpoint {
            component: crate::wire::Component::Ui,
            instance: "ui".into(),
        },
        request_id: id.into(),
        surface_id: "browser".into(),
        human,
    }
}
fn finish(id: &str, success: bool) -> Input {
    Input::FinishRoleSwitch {
        request_id: id.into(),
        surface_id: "browser".into(),
        success,
    }
}

#[test]
fn role_switch_keeps_legacy_role_fences_until_correlated_confirmation() {
    let mut s = fixture();
    assert_eq!(
        s.apply(&Input::ReleaseControl {
            surface_id: "browser".into()
        })
        .unwrap()
        .reason,
        Some(Refusal::Policy)
    );
    assert!(s.apply(&begin("a", false)).unwrap().reason.is_none());
    assert!(!s.surfaces["browser"].agent_controlled);
    assert!(s.human_roles.contains("browser"));
    assert_eq!(
        s.apply(&finish("other", true)).unwrap().reason,
        Some(Refusal::Policy)
    );
    assert!(s.apply(&finish("a", true)).unwrap().reason.is_none());
    assert!(s.surfaces["browser"].agent_controlled);
    assert!(!s.human_roles.contains("browser"));
    assert!(s.surfaces["browser"].refresh_after.is_some());
    assert!(s.apply(&begin("b", true)).unwrap().reason.is_none());
    assert!(s.apply(&finish("b", true)).unwrap().reason.is_none());
    assert!(!s.surfaces["browser"].agent_controlled);
    assert!(s.human_roles.contains("browser"));
    assert_eq!(
        s.apply(&Input::ReleaseControl {
            surface_id: "browser".into()
        })
        .unwrap()
        .reason,
        Some(Refusal::Policy)
    );
}

#[test]
fn role_switch_refuses_busy_and_non_ui_requests_and_rolls_back_known_refusal() {
    let mut s = fixture();
    s.leases.insert("browser".into(), "pending".into());
    assert_eq!(
        s.apply(&begin("a", false)).unwrap().reason,
        Some(Refusal::Policy)
    );
    s.leases.clear();
    let mut request = begin("a", false);
    if let Input::BeginRoleSwitch { sender, .. } = &mut request {
        sender.component = crate::wire::Component::Agent;
    }
    assert_eq!(s.apply(&request).unwrap().reason, Some(Refusal::Policy));
    assert!(s.apply(&begin("b", false)).unwrap().reason.is_none());
    assert!(s.apply(&finish("b", false)).unwrap().reason.is_none());
    assert!(s.human_roles.contains("browser"));
    assert!(!s.surfaces["browser"].agent_controlled);
    assert!(s.role_switches.is_empty());
}

#[test]
fn role_switch_remains_available_both_ways_at_zero_action_budget() {
    let mut s = fixture();
    s.remaining_budget = 0;
    assert!(s.apply(&begin("agent", false)).unwrap().reason.is_none());
    assert!(s.apply(&finish("agent", true)).unwrap().reason.is_none());
    assert!(s.surfaces["browser"].agent_controlled);
    assert!(s.apply(&begin("human", true)).unwrap().reason.is_none());
    assert!(s.apply(&finish("human", true)).unwrap().reason.is_none());
    assert!(!s.surfaces["browser"].agent_controlled);
    assert!(s.human_roles.contains("browser"));
    assert_eq!(s.remaining_budget, 0);
}
