#![forbid(unsafe_code)]

use metaviewer_core::admission::{CoreState, Frame, Input, LifecycleUpdate, Surface};
use metaviewer_core::wire::payload::SurfaceRequestCase5;
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;

fn human_surface() -> Surface {
    Surface {
        display: ":99".into(),
        owner: Endpoint {
            component: Component::Ui,
            instance: "ui-1".into(),
        },
        agent_controlled: false,
        live: true,
        frame: None,
        refresh_after: None,
        allowed_verbs: Vec::new(),
    }
}

fn valid_frame() -> Frame {
    Frame {
        sha256: "a".repeat(64),
        generation: 1,
        width: 100,
        height: 80,
    }
}

fn click_input(surface_id: &str, proposal_id: &str, x: u64, y: u64) -> Input {
    let request: SurfaceRequestCase5 = serde_json::from_value(json!({
        "schema": "surface_request/v0.2",
        "op": "input",
        "params": {
            "surface_id": surface_id,
            "proposal_id": proposal_id,
            "origin": "human",
            "action": {
                "type": "click",
                "x": x,
                "y": y,
                "button": "left"
            }
        }
    }))
    .expect("valid surface_request/v0.2 click payload");
    Input::HumanInput { request }
}

#[test]
fn human_click_without_frame_refuses_out_of_bounds_without_side_effects() {
    let mut state = CoreState::new("sess-rv11-f1", 10).unwrap();
    state.apply(&Input::Connect).unwrap();
    let create = state
        .apply(&Input::Lifecycle {
            surface_id: "s-unframed".into(),
            update: LifecycleUpdate::Created(human_surface()),
        })
        .unwrap();
    assert_eq!(create.reason, None);
    assert_eq!(state.surfaces["s-unframed"].frame, None);

    // Click when s.frame is None must fail closed with OutOfBounds, no dispatch,
    // no budget burn, and no seen insertion.
    let out = state
        .apply(&click_input("s-unframed", "prop-click-1", 0, 0))
        .unwrap();
    assert_eq!(out.reason, Some(Refusal::OutOfBounds));
    assert!(!out.dispatch);
    assert_eq!(state.remaining_budget, 10);

    // Attach a valid 100x80 frame.
    let frame_out = state
        .apply(&Input::Frame {
            surface_id: "s-unframed".into(),
            frame: valid_frame(),
        })
        .unwrap();
    assert_eq!(frame_out.reason, None);

    // Out-of-bounds clicks on a framed surface must also refuse with OutOfBounds
    // and leave budget and seen untouched.
    for (x, y) in [(100, 0), (0, 80), (150, 90)] {
        let oob = state
            .apply(&click_input("s-unframed", "prop-click-1", x, y))
            .unwrap();
        assert_eq!(oob.reason, Some(Refusal::OutOfBounds));
        assert!(!oob.dispatch);
        assert_eq!(state.remaining_budget, 10);
    }

    // Negative control: in-bounds click on the framed surface with the SAME proposal_id
    // dispatches, proving prior OutOfBounds refusals did not pollute `seen`.
    let admitted = state
        .apply(&click_input("s-unframed", "prop-click-1", 99, 79))
        .unwrap();
    assert_eq!(admitted.reason, None);
    assert!(admitted.dispatch);
    assert_eq!(state.remaining_budget, 9);

    // Replaying the now-admitted proposal_id is refused with Policy.
    let replay = state
        .apply(&click_input("s-unframed", "prop-click-1", 10, 10))
        .unwrap();
    assert_eq!(replay.reason, Some(Refusal::Policy));
    assert!(!replay.dispatch);
    assert_eq!(state.remaining_budget, 9);
}
