use metaviewer_core::decode_envelope;

fn base_envelope() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/envelope.valid.json"
    ))
    .unwrap()
}

#[test]
fn r3t6_nested_depth_and_surface_input_body_refusal() {
    let base = base_envelope();

    // 1. surface_request/v0.2 create op with nested_depth 0 and 1 are admitted; 2 and -1 are refused.
    for depth in [0, 1] {
        let mut env = base.clone();
        env["body"] = serde_json::json!({
            "schema": "surface_request/v0.2",
            "op": "create",
            "params": {
                "kind": "desktop_capsule",
                "geometry": {"w": 1280, "h": 720},
                "profile_id": "r3t6-profile",
                "nested_depth": depth
            }
        });
        assert!(decode_envelope(&env.to_string()).is_ok(), "depth {depth}");
    }

    for depth in [2, -1] {
        let mut env = base.clone();
        env["body"] = serde_json::json!({
            "schema": "surface_request/v0.2",
            "op": "create",
            "params": {
                "kind": "desktop_capsule",
                "geometry": {"w": 1280, "h": 720},
                "profile_id": "r3t6-profile",
                "nested_depth": depth
            }
        });
        assert!(decode_envelope(&env.to_string()).is_err(), "depth {depth}");
    }

    // 2. surface_input/v0.2 non-envelope batch is refused as envelope body
    let mut env = base.clone();
    env["body"] = serde_json::json!({
        "schema": "surface_input/v0.2",
        "surface_id": "s1",
        "stream_id": 1,
        "seq": 1,
        "events": [{"kind": "click", "x": 10, "y": 20, "button": "left"}]
    });
    assert!(decode_envelope(&env.to_string()).is_err());
}
