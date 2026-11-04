use super::*;
use serde_json::json;

#[test]
fn role_switch_wire_is_closed_and_additive() {
    let request = json!({"schema":"metaviewer.role_switch/v0.3","request_id":"switch-1","surface_id":"surface-1","role":"agent"});
    assert!(serde_json::from_value::<Command>(request.clone()).is_ok());
    let envelope = json!({"schema":"role_switch_envelope/v0.3","msg_id":"m1","ts_ns":0,"from":{"component":"ui","instance":"ui-1"},"to":{"component":"core","instance":"core-1"},"session_id":"session-1","seq":1,"nonce":"nonce-1","body":request});
    assert!(decode_envelope(&envelope.to_string()).is_ok());
    let mut old = envelope;
    old["schema"] = "envelope/v0.2".into();
    assert!(decode_envelope(&old.to_string()).is_err());
    for bad in [
        json!({"role":"shared"}),
        json!({"extra":true}),
        json!({"request_id":""}),
    ] {
        let mut mutated = request.clone();
        mutated
            .as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        assert!(serde_json::from_value::<Command>(mutated).is_err());
    }
    let mut legacy = request;
    legacy["schema"] = "surface_request/v0.2".into();
    assert!(serde_json::from_value::<Command>(legacy).is_err());
}
