use metaviewer_core::wire::{decode_envelope, Command, DecodeError};
use serde_json::{json, Value};
fn value() -> Value {
    serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/rewind_envelope.valid.json"
    ))
    .unwrap()
}
#[test]
fn new_family_closed_pair_and_shared_frame() {
    let v = value();
    assert!(matches!(
        decode_envelope(&v.to_string()).unwrap().body,
        Command::RewindRequest(_)
    ));
    for family in ["envelope/v0.2", "capsule_envelope/v0.2"] {
        let mut b = v.clone();
        b["schema"] = json!(family);
        assert!(matches!(
            decode_envelope(&b.to_string()),
            Err(DecodeError::InvalidField)
        ));
    }
}
#[test]
fn old_body_new_family_refuses() {
    let mut v = value();
    let old: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/capsule_envelope.valid.guest_command_request.0.json"
    ))
    .unwrap();
    v["body"] = old["body"].clone();
    assert!(decode_envelope(&v.to_string()).is_err());
}
#[test]
fn duplicate_keys_not_masked_by_new_family() {
    let raw = value().to_string();
    let raw = raw.replacen("{", "{\"seq\":2,", 1);
    assert!(matches!(
        decode_envelope(&raw),
        Err(DecodeError::DuplicateField)
    ));
}
