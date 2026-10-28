use super::*;

fn surface_event(id: &str, state: &str) -> Command {
    let mut surface: Value = serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap();
    surface["surface_id"] = id.into();
    surface["state"] = state.into();
    Command::SurfaceEvent(Box::new(
        serde_json::from_value(json!({"schema":"surface_event/v0.2",
            "event":if state == "destroyed" { "state_changed" } else { "created" },
            "data":{"surface":surface}}))
        .unwrap(),
    ))
}

fn receipt(id: &str) -> Command {
    let mut receipt: Value = serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/action_receipt.valid.json"
    ))
    .unwrap();
    receipt["proposal_id"] = id.into();
    Command::ActionReceipt(Box::new(serde_json::from_value(receipt).unwrap()))
}

#[test]
fn destroy_and_settlement_churn_keeps_live_views_and_bounds_both_receipt_indexes() {
    let mut state = ToolState::default();
    let live = "surface-live";
    let template: Value = serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap();
    let live_state = template["state"].as_str().unwrap();
    let frame: Value = serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    state.retain(&surface_event(live, live_state));
    let prefixed_live = format!("cuk-ai-slot-{live}");
    state.retain(&surface_event(&prefixed_live, live_state));
    state.retain(&surface_event(&prefixed_live, "destroyed"));
    assert!(state.destroyed.contains(&prefixed_live));
    for i in 0..10_000 {
        let id = format!("surface-{i}");
        state.retain(&surface_event(&id, live_state));
        let mut frame = frame.clone();
        frame["surface_id"] = id.clone().into();
        state.retain(&Command::FrameRef(Box::new(
            serde_json::from_value(frame).unwrap(),
        )));
        // Negative control: the live view and frame exist before destruction.
        assert!(state.surfaces.contains_key(&id));
        assert!(state.frames.contains_key(&id));
        state.layout.insert(id.clone(), "folded".into());
        state.retain(&surface_event(&id, "destroyed"));
        assert!(!state.surfaces.contains_key(&id));
        assert!(!state.frames.contains_key(&id));
        assert!(!state.layout.contains_key(&id));
        assert!(state.destroyed.len() <= DESTROYED_CAP);
        assert_eq!(state.destroyed_order.len(), state.destroyed.len());
    }
    assert_eq!(state.surfaces.len(), 1);
    assert!(state.surfaces.contains_key(live));
    assert_eq!(state.destroyed.len(), DESTROYED_CAP);
    assert!(
        state.destroyed.contains(&prefixed_live),
        "prefixed tombstone shadowing a live unprefixed surface must never be evicted"
    );
    assert_eq!(state.slot_surface(&prefixed_live), prefixed_live);
    assert!(!state.destroyed.contains("surface-0"));
    assert!(state.destroyed.contains("surface-9999"));
    assert!(state.frames.is_empty());
    assert!(state.layout.is_empty());

    for i in 0..2000 {
        state.retain(&receipt(&format!("proposal-{i}")));
        assert!(state.receipts.len() <= RECEIPT_CAP);
        assert_eq!(state.receipt_order.len(), state.receipts.len());
    }
    assert_eq!(state.receipts.len(), RECEIPT_CAP);
    assert!(!state.receipts.contains_key("proposal-0"));
    assert!(state.receipts.contains_key("proposal-1999"));

    // Refreshing an existing ID must not consume an extra retention slot.
    let refreshed = format!("proposal-{}", 2000 - RECEIPT_CAP);
    state.retain(&receipt(&refreshed));
    assert_eq!(state.receipt_order.len(), RECEIPT_CAP);
    assert_eq!(state.receipt_order.back(), Some(&refreshed));
    state.retain(&receipt("proposal-new"));
    assert!(state.receipts.contains_key(&refreshed));
    assert!(!state
        .receipts
        .contains_key(&format!("proposal-{}", 2001 - RECEIPT_CAP)));
    assert_eq!(state.receipt_order.len(), RECEIPT_CAP);
}

#[test]
fn zero_list_limit_stays_invalid_at_closed_decoding() {
    let envelope = json!({"schema":"envelope/v0.2","msg_id":"invalid-limit",
        "ts_ns":0,"from":{"component":"agent","instance":"agent-test"},
        "to":{"component":"core","instance":"core-test"},
        "session_id":"tools-test","seq":1,"nonce":"invalid-limit",
        "body":{"schema":"mv_tool_call/v0.2","request_id":"invalid-limit",
            "op":"list","args":{"cursor":null,"limit":0}}});
    assert!(matches!(
        decode_envelope(&envelope.to_string()),
        Err(DecodeError::InvalidField)
    ));
    let mut valid = envelope;
    valid["body"]["args"]["limit"] = 1.into();
    assert!(decode_envelope(&valid.to_string()).is_ok());
}
