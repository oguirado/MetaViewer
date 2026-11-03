use metaviewer_core::{decode_envelope, envelope_schema, DecodeError};
use serde_json::{json, Value};

fn capsule_examples() -> Vec<Value> {
    [
        include_str!("../../contracts/examples/v0.2/capsule_envelope.valid.headless_request.valid.create.json"),
        include_str!("../../contracts/examples/v0.2/capsule_envelope.valid.headless_event.valid.accepted_1.json"),
        include_str!("../../contracts/examples/v0.2/capsule_envelope.valid.guest_command_request.0.json"),
        include_str!("../../contracts/examples/v0.2/capsule_envelope.valid.guest_command_event.0.json"),
    ].into_iter().map(|s| serde_json::from_str(s).unwrap()).collect()
}

#[test]
fn additive_bodies_roundtrip_only_in_capsule_envelope() {
    for mut value in capsule_examples() {
        let decoded = decode_envelope(&value.to_string()).unwrap();
        assert_eq!(envelope_schema(&decoded.body), "capsule_envelope/v0.2");
        assert_eq!(serde_json::to_value(&decoded).unwrap(), value);
        value["schema"] = json!("envelope/v0.2");
        assert_eq!(
            decode_envelope(&value.to_string()),
            Err(DecodeError::InvalidField)
        );
    }
}

#[test]
fn legacy_hello_and_surface_stay_in_original_envelope() {
    let hello: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/envelope.valid.variant-071.json"
    ))
    .unwrap();
    let mut list = hello.clone();
    list["body"] = json!({"schema":"surface_request/v0.2","op":"list","params":{}});
    for mut value in [hello, list] {
        let decoded = decode_envelope(&value.to_string()).unwrap();
        assert_eq!(envelope_schema(&decoded.body), "envelope/v0.2");
        value["schema"] = json!("capsule_envelope/v0.2");
        assert_eq!(
            decode_envelope(&value.to_string()),
            Err(DecodeError::InvalidField)
        );
    }
}

#[test]
fn capsule_transport_preserves_closed_bounds_and_versions() {
    let value = capsule_examples().remove(0);
    for mutate in [
        |v: &mut Value| {
            v["schema"] = json!("capsule_envelope/v0.3");
        },
        |v: &mut Value| {
            v["untrusted"] = json!(true);
        },
        |v: &mut Value| {
            v["seq"] = json!(true);
        },
        |v: &mut Value| {
            v["body"]["owner_id"] = json!("renderer-spoof");
        },
        |v: &mut Value| {
            v["body"]["schema"] = json!("headless_request/v0.3");
        },
    ] {
        let mut bad = value.clone();
        mutate(&mut bad);
        assert!(decode_envelope(&bad.to_string()).is_err());
    }
}
