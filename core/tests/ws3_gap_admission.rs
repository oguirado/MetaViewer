#![forbid(unsafe_code)]
use metaviewer_core::admission::{
    AdmissionRequest, CoreState, Frame, Input, LifecycleUpdate, Surface,
};
use metaviewer_core::{decode_envelope, Component, Endpoint, Refusal};
use serde_json::{json, Value};

fn surface() -> Surface {
    Surface {
        display: "display".into(),
        owner: Endpoint {
            component: Component::Ui,
            instance: "ui".into(),
        },
        agent_controlled: false,
        live: true,
        frame: None,
        refresh_after: None,
        allowed_verbs: vec![],
    }
}
fn state() -> CoreState {
    let mut s = CoreState::new("ws3", 10).unwrap();
    s.apply(&Input::Connect).unwrap();
    s.apply(&Input::Lifecycle {
        surface_id: "surface".into(),
        update: LifecycleUpdate::Created(surface()),
    })
    .unwrap();
    s
}
#[test]
fn decode_target_and_body_fences() {
    let original: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/envelope.valid.json"
    ))
    .unwrap();
    let peer: Endpoint = serde_json::from_value(original["from"].clone()).unwrap();
    let decode = |v: &Value| AdmissionRequest::decode(&v.to_string(), &peer, "session-demo", 1, 0);
    assert!(decode(&original).is_ok());
    for target in ["ui", "daemon"] {
        let mut wrong = original.clone();
        wrong["to"]["component"] = target.into();
        assert!(
            decode_envelope(&wrong.to_string()).is_ok(),
            "must reach admission fence"
        );
        assert!(decode(&wrong).is_err(), "accepted target {target}");
    }
    let mut wrong = original;
    wrong["body"] = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    assert!(decode_envelope(&wrong.to_string()).is_ok());
    assert!(decode(&wrong).is_err());
}
#[test]
fn lifecycle_frame_metadata_errors_without_state_change() {
    let mut s = state();
    let before = s.domain_snapshot().unwrap();
    let mut metadata = surface();
    metadata.frame = Some(Frame {
        sha256: "a".repeat(64),
        generation: 1,
        width: 10,
        height: 10,
    });
    assert!(s
        .apply(&Input::Lifecycle {
            surface_id: "surface".into(),
            update: LifecycleUpdate::Updated(metadata)
        })
        .is_err());
    assert_eq!(s.domain_snapshot().unwrap(), before);
    assert_eq!(
        s.apply(&Input::Lifecycle {
            surface_id: "surface".into(),
            update: LifecycleUpdate::Updated(surface())
        })
        .unwrap()
        .reason,
        None
    );
}
#[test]
fn human_text_bounds_preserve_budget_and_replay_slot() {
    let mut s = state();
    let input = |text: &str| {
        Input::HumanInput { request: serde_json::from_value(json!({"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"surface","proposal_id":"text","origin":"human","action":{"type":"type","text":text}}})).unwrap() }
    };
    for text in [String::new(), "x".repeat(16385), "bad\0text".into()] {
        let seen = serde_json::from_slice::<Value>(&s.snapshot().unwrap()).unwrap()["seen"].clone();
        assert!(seen.is_array(), "snapshot must expose replay evidence");
        let budget = s.remaining_budget;
        let out = s.apply(&input(&text)).unwrap();
        assert_eq!(out.reason, Some(Refusal::Policy));
        assert!(!out.dispatch);
        assert_eq!(s.remaining_budget, budget);
        assert_eq!(
            serde_json::from_slice::<Value>(&s.snapshot().unwrap()).unwrap()["seen"],
            seen
        );
    }
    let out = s.apply(&input("ready")).unwrap();
    assert_eq!(out.reason, None);
    assert!(out.dispatch);
    assert_eq!(s.remaining_budget, 9);
    assert_eq!(
        s.apply(&input("ready")).unwrap().reason,
        Some(Refusal::Policy)
    );
}
