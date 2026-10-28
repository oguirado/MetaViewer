use metaviewer_core::{decode_envelope, DecodeError};
use serde_json::{json, Value};

fn valid_envelope() -> Value {
    serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/envelope.valid.json"
    ))
    .expect("parse envelope.valid.json")
}

#[test]
fn r3t6_valid_envelope_fixture_decodes() {
    let env = valid_envelope();
    assert!(decode_envelope(&env.to_string()).is_ok());
}

#[test]
fn r3t6_surface_request_nested_depth_bounds_enforced() {
    for valid_depth in [0, 1] {
        let mut env = valid_envelope();
        env["body"] = json!({
            "schema": "surface_request/v0.2",
            "op": "create",
            "params": {
                "kind": "desktop_capsule",
                "profile_id": "notepad-0",
                "geometry": { "w": 1280, "h": 720 },
                "nested_depth": valid_depth
            }
        });
        assert!(
            decode_envelope(&env.to_string()).is_ok(),
            "nested_depth={valid_depth} should be accepted"
        );
    }

    for invalid_depth in [json!(2), json!(-1)] {
        let mut env = valid_envelope();
        env["body"] = json!({
            "schema": "surface_request/v0.2",
            "op": "create",
            "params": {
                "kind": "desktop_capsule",
                "profile_id": "notepad-0",
                "geometry": { "w": 1280, "h": 720 },
                "nested_depth": invalid_depth
            }
        });
        assert!(
            decode_envelope(&env.to_string()).is_err(),
            "nested_depth={invalid_depth} must be refused"
        );
    }
}

#[test]
fn r3t6_surface_input_refused_inside_envelope_body() {
    let mut env = valid_envelope();
    env["body"] = json!({
        "schema": "surface_input/v0.2",
        "surface_id": "surface-demo",
        "stream_id": "stream-1",
        "seq": 1,
        "events": [
            { "kind": "type", "text": "a" }
        ]
    });
    assert_eq!(
        decode_envelope(&env.to_string()),
        Err(DecodeError::Malformed)
    );
}

#[test]
fn r3t6_unknown_version_vs_malformed_taxonomy_negative_controls() {
    let base = valid_envelope();

    let mut bad_ver = base.clone();
    bad_ver["body"]["schema"] = "action_proposal/v9.9".into();
    assert_eq!(
        decode_envelope(&bad_ver.to_string()),
        Err(DecodeError::UnknownVersion)
    );

    for malformed_tag in ["unknown_family/v0.2", "action_proposal", "envelope/v9.9"] {
        let mut bad_tag = base.clone();
        bad_tag["body"]["schema"] = malformed_tag.into();
        assert_eq!(
            decode_envelope(&bad_tag.to_string()),
            Err(DecodeError::Malformed),
            "expected Malformed for body schema {malformed_tag}"
        );
    }

    let mut bad_ui_intent = base;
    bad_ui_intent["body"] = json!({
        "schema": "ui_intent/v0.2",
        "request_id": "req-1",
        "op": "unknown_layout_op",
        "params": { "slot_id": "surface-demo" }
    });
    assert_eq!(
        decode_envelope(&bad_ui_intent.to_string()),
        Err(DecodeError::Malformed)
    );
}

#[test]
fn r3t6_properties_without_additional_properties_false_is_open() {
    let open_schema = json!({"properties": {"a": {"type": "integer"}}});
    let closed_schema =
        json!({"properties": {"a": {"type": "integer"}}, "additionalProperties": false});
    let val_extra = json!({"a": 1, "zzz": 1});
    let val_bad_a = json!({"a": "bad", "zzz": 1});

    assert!(metaviewer_core::valid(
        &val_extra,
        &open_schema,
        &open_schema
    ));
    assert!(!metaviewer_core::valid(
        &val_bad_a,
        &open_schema,
        &open_schema
    ));
    assert!(!metaviewer_core::valid(
        &val_extra,
        &closed_schema,
        &closed_schema
    ));
}
