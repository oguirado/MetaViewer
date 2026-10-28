#![forbid(unsafe_code)]

use metaviewer_core::admission::{CoreState, Frame, Input, LifecycleUpdate, Surface};
use metaviewer_core::wire::payload::{ActionProposalAction, SurfaceRequestCase5};
use metaviewer_core::{decode_envelope, Command, Component, Endpoint, Refusal};
use serde_json::json;

fn unframed_human_surface() -> Surface {
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
        sha256: "b".repeat(64),
        generation: 1,
        width: 800,
        height: 600,
    }
}

fn scroll_input(surface_id: &str, proposal_id: &str, dx: i64, dy: i64) -> Input {
    let request: SurfaceRequestCase5 = serde_json::from_value(json!({
        "schema": "surface_request/v0.2",
        "op": "input",
        "params": {
            "surface_id": surface_id,
            "proposal_id": proposal_id,
            "origin": "human",
            "action": {
                "type": "scroll",
                "dx": dx,
                "dy": dy
            }
        }
    }))
    .expect("valid surface_request/v0.2 scroll payload");
    Input::HumanInput { request }
}

#[test]
fn human_scroll_requires_frame_bounds_deltas_and_admits_contract_shape() {
    let mut state = CoreState::new("sess-rv11-f2", 5).unwrap();
    state.apply(&Input::Connect).unwrap();
    state
        .apply(&Input::Lifecycle {
            surface_id: "s-1".into(),
            update: LifecycleUpdate::Created(unframed_human_surface()),
        })
        .unwrap();

    // 1. No-frame refused: scroll on a surface without a current frame is refused
    // with OutOfBounds, burning no budget or seen slot.
    let no_frame = state
        .apply(&scroll_input("s-1", "prop-scroll-1", 0, -120))
        .unwrap();
    assert_eq!(no_frame.reason, Some(Refusal::OutOfBounds));
    assert!(!no_frame.dispatch);
    assert_eq!(state.remaining_budget, 5);

    // Attach an 800x600 frame.
    state
        .apply(&Input::Frame {
            surface_id: "s-1".into(),
            frame: valid_frame(),
        })
        .unwrap();

    // 2. Out-of-range deltas refused: i32 overflow deltas return OutOfBounds
    // without burning budget or inserting into `seen`.
    for (dx, dy) in [
        (i64::from(i32::MAX) + 1, 0),
        (0, i64::from(i32::MIN) - 1),
        (i64::from(i32::MIN) - 1, 0),
        (0, i64::from(i32::MAX) + 1),
    ] {
        let over = state
            .apply(&scroll_input("s-1", "prop-scroll-1", dx, dy))
            .unwrap();
        assert_eq!(over.reason, Some(Refusal::OutOfBounds));
        assert!(!over.dispatch);
        assert_eq!(state.remaining_budget, 5);
    }

    // 3. Inside bounds admitted: reusing "prop-scroll-1" proves prior
    // OutOfBounds refusals did not insert into `seen`.
    let admitted = state
        .apply(&scroll_input("s-1", "prop-scroll-1", 0, -120))
        .unwrap();
    assert_eq!(admitted.reason, None);
    assert!(admitted.dispatch);
    assert_eq!(state.remaining_budget, 4);

    // Replaying the admitted proposal_id is refused with Policy.
    let replay = state
        .apply(&scroll_input("s-1", "prop-scroll-1", 0, -120))
        .unwrap();
    assert_eq!(replay.reason, Some(Refusal::Policy));
    assert!(!replay.dispatch);
    assert_eq!(state.remaining_budget, 4);

    // 4. Inside bounds at i32 limits admitted through closed envelope decode;
    // extra anchor fields (x/y) are rejected by the frozen contract.
    let env_raw = json!({
        "schema": "envelope/v0.2",
        "msg_id": "msg-scroll-contract",
        "ts_ns": 1000,
        "from": { "component": "ui", "instance": "ui-1" },
        "to": { "component": "core", "instance": "core-1" },
        "session_id": "sess-rv11-f2",
        "seq": 1,
        "nonce": "nonce-scroll-contract",
        "body": {
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": "s-1",
                "proposal_id": "prop-scroll-2",
                "origin": "human",
                "action": {
                    "type": "scroll",
                    "dx": i32::MIN,
                    "dy": i32::MAX
                }
            }
        }
    })
    .to_string();
    let decoded = decode_envelope(&env_raw).expect("contract scroll envelope must decode");
    let Command::SurfaceRequest(sr) = decoded.body else {
        panic!("expected SurfaceRequest body");
    };
    let metaviewer_core::wire::payload::SurfaceRequest::Case5(req) = *sr else {
        panic!("expected SurfaceRequestCase5");
    };
    let ActionProposalAction::Case3(ref scroll_act) = req.params.action else {
        panic!("expected scroll Case3 action");
    };
    assert_eq!(scroll_act.dx, i64::from(i32::MIN));
    assert_eq!(scroll_act.dy, i64::from(i32::MAX));

    let admitted_limits = state.apply(&Input::HumanInput { request: *req }).unwrap();
    assert_eq!(admitted_limits.reason, None);
    assert!(admitted_limits.dispatch);
    assert_eq!(state.remaining_budget, 3);

    let extra_xy_raw = json!({
        "schema": "envelope/v0.2",
        "msg_id": "msg-scroll-extra",
        "ts_ns": 1001,
        "from": { "component": "ui", "instance": "ui-1" },
        "to": { "component": "core", "instance": "core-1" },
        "session_id": "sess-rv11-f2",
        "seq": 2,
        "nonce": "nonce-scroll-extra",
        "body": {
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": "s-1",
                "proposal_id": "prop-scroll-3",
                "origin": "human",
                "action": {
                    "type": "scroll",
                    "dx": 0,
                    "dy": -120,
                    "x": 10,
                    "y": 20
                }
            }
        }
    })
    .to_string();
    assert!(decode_envelope(&extra_xy_raw).is_err());
}
