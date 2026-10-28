#![forbid(unsafe_code)]

mod support;

use metaviewer_core::serve::ClockCeilingError;
use metaviewer_core::{decode_envelope, Clock, DecodeError};

#[test]
fn test_wire_bounds_session_clock_ceiling_and_rails() {
    let valid_ts = Clock::new(9007199254740991);
    let serialized = serde_json::to_string(&valid_ts).unwrap();
    assert_eq!(serialized, "9007199254740991");

    let err = ClockCeilingError {
        elapsed_ns: 9007199254740992,
    };
    assert_eq!(
        err.to_string(),
        "session monotonic clock reached wire ceiling (9007199254740992 ns >= 9007199254740991 ns); restart session"
    );
}

#[test]
fn test_nested_depth_and_decoder_versioning() {
    let invalid_nested_v01 = json_envelope_with_body(serde_json::json!({
        "schema": "mv_tool_result/v0.1",
        "tool_call_id": "call-1",
        "ok": true
    }));
    let decoded = decode_envelope(&invalid_nested_v01);
    assert!(matches!(decoded, Err(DecodeError::UnknownVersion)));
}

fn json_envelope_with_body(body: serde_json::Value) -> String {
    serde_json::json!({
        "schema": "envelope/v0.2",
        "msg_id": "m1",
        "ts_ns": 1000,
        "from": { "component": "ui", "instance": "ui-1" },
        "to": { "component": "core", "instance": "core-1" },
        "session_id": "s1",
        "seq": 1,
        "nonce": "n1",
        "body": body
    })
    .to_string()
}
