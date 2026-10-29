//! Frozen wire parity; mutation witness: ignore an unknown verdict key.
use metaviewer_core::decode_envelope;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/verdict_parity.json")).unwrap()
}

fn accepts(f: &Value, body: &Value) -> bool {
    let mut env = f["envelope_template"].clone();
    env["body"] = body.clone();
    decode_envelope(&env.to_string()).is_ok()
}

#[test]
fn verdict_parity_frozen_contracts() {
    let f = fixture();
    assert_eq!(f["contract_version"], "v0.2");
    for v in f["vectors"].as_array().unwrap() {
        assert_eq!(
            accepts(&f, &v["payload"]),
            v["contract_verdict"] == "accept",
            "{}",
            v["id"]
        );
    }
}

#[test]
fn verdict_parity_kills_ignore_unknown_key_mutant() {
    let f = fixture();
    let v = f["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "verdict_extra")
        .unwrap();
    assert!(!accepts(&f, &v["payload"]));
    // Behavioral mutant: a decoder that silently discards the unknown key.
    let mut mutated = v["payload"].clone();
    mutated.as_object_mut().unwrap().remove("extra");
    assert!(accepts(&f, &mutated));
    assert_eq!(v["contract_verdict"], "refuse");
}
