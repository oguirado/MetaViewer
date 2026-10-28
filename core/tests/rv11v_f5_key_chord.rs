#![forbid(unsafe_code)]

use metaviewer_core::admission::{CoreState, Frame, Input, Surface};
use metaviewer_core::wire::payload::SurfaceRequestCase5;
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;

fn framed_human_surface() -> Surface {
    Surface {
        display: ":99".into(),
        owner: Endpoint {
            component: Component::Ui,
            instance: "ui-1".into(),
        },
        agent_controlled: false,
        live: true,
        frame: Some(Frame {
            sha256: "c".repeat(64),
            generation: 1,
            width: 800,
            height: 600,
        }),
        refresh_after: None,
        allowed_verbs: Vec::new(),
    }
}

fn key_input(surface_id: &str, proposal_id: &str, keys: &[&str]) -> Input {
    let request: SurfaceRequestCase5 = serde_json::from_value(json!({
        "schema": "surface_request/v0.2",
        "op": "input",
        "params": {
            "surface_id": surface_id,
            "proposal_id": proposal_id,
            "origin": "human",
            "action": {
                "type": "key",
                "keys": keys
            }
        }
    }))
    .expect("valid surface_request/v0.2 key payload");
    Input::HumanInput { request }
}

#[test]
fn human_key_chord_refuses_empty_nul_and_overlong_and_admits_valid_chord() {
    let mut state = CoreState::new("sess-rv11-f5", 10).unwrap();
    state.apply(&Input::Connect).unwrap();
    state
        .apply(&Input::Surface {
            id: "s-key".into(),
            surface: framed_human_surface(),
        })
        .unwrap();

    let overlong_single = "a".repeat(33);
    let overlong_tail = "a".repeat(25); // "Control+" (8) + 25 = 33 > 32
    let invalid_cases: Vec<Vec<&str>> = vec![
        vec![],
        vec![""],
        vec!["Control", ""],
        vec!["", "c"],
        vec!["\0"],
        vec!["Control", "c\0"],
        vec!["Con\0trol", "c"],
        vec![overlong_single.as_str()],
        vec!["Control", overlong_tail.as_str()],
    ];

    for keys in &invalid_cases {
        let out = state
            .apply(&key_input("s-key", "prop-chord-1", keys))
            .unwrap();
        assert_eq!(
            out.reason,
            Some(Refusal::Policy),
            "expected Policy refusal for invalid chord {keys:?}"
        );
        assert!(!out.dispatch);
        assert_eq!(state.remaining_budget, 10);
    }

    // Negative control: valid chord ["Control", "c"] with the same proposal_id dispatches,
    // proving refused attempts did not pollute `seen` or burn budget.
    let admitted = state
        .apply(&key_input("s-key", "prop-chord-1", &["Control", "c"]))
        .unwrap();
    assert_eq!(admitted.reason, None);
    assert!(admitted.dispatch);
    assert_eq!(state.remaining_budget, 9);

    // Boundary check: joined length == 32 ("Control+" (8) + 24 = 32) is admitted.
    let exact_tail = "a".repeat(24);
    let boundary = state
        .apply(&key_input(
            "s-key",
            "prop-chord-32",
            &["Control", exact_tail.as_str()],
        ))
        .unwrap();
    assert_eq!(boundary.reason, None);
    assert!(boundary.dispatch);
    assert_eq!(state.remaining_budget, 8);
}
