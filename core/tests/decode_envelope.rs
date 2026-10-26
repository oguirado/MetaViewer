use metaviewer_core::{decode_envelope, Clock, Refusal, MAX_FRAME_BYTES};

fn fixture() -> String {
    include_str!("../../contracts/examples/v0.2/envelope.valid.json").into()
}

#[test]
fn closed_decode_and_numeric_controls() {
    let raw = fixture();
    assert!(decode_envelope(&raw).is_ok());
    for bad in [
        raw.replacen("\"schema\":", "\"unknown\": 1, \"schema\":", 1),
        raw.replacen(
            "\"schema\":",
            "\"schema\": \"envelope/v0.2\", \"schema\":",
            1,
        ),
        raw.replace("envelope/v0.2", "envelope/v0.0"),
        "x".repeat(MAX_FRAME_BYTES),
    ] {
        let error = decode_envelope(&bad).unwrap_err();
        assert!(!format!("{error:?} {error}").contains(&bad));
    }
    assert_eq!(Clock::new(1).checked_next().unwrap().get(), 2);
    assert!(Clock::new(u64::MAX).checked_next().is_err());
}

#[test]
fn refusal_vocabulary_is_frozen() {
    for (reason, code) in [
        (Refusal::StaleFrame, "STALE_FRAME"),
        (
            Refusal::SurfaceNotAgentControlled,
            "SURFACE_NOT_AGENT_CONTROLLED",
        ),
        (Refusal::LockedByOther, "LOCKED_BY_OTHER"),
        (Refusal::BudgetExceeded, "BUDGET_EXCEEDED"),
        (Refusal::OutOfBounds, "OUT_OF_BOUNDS"),
        (Refusal::Policy, "POLICY"),
    ] {
        assert_eq!(reason.code(), code);
        assert_eq!(reason.to_string(), code);
    }
    assert!(serde_json::from_str::<Refusal>("\"UNKNOWN\"").is_err());
}

#[test]
fn all_frozen_body_examples_and_negative_controls() {
    let base: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/examples/v0.2");
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap();
        let valid = name.ends_with(".valid.json");
        let invalid = name.ends_with(".invalid.schema.json");
        if !valid && !invalid {
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut env = base.clone();
        if name.starts_with("envelope.") {
            env = value;
        } else {
            env["body"] = value;
        }
        let result = decode_envelope(&serde_json::to_string(&env).unwrap());
        assert_eq!(result.is_ok(), valid, "{name}: {result:?}");
    }
}

#[test]
fn nested_closure_and_required_nullable_fields() {
    let mut env: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    for pointer in [
        "",
        "/from",
        "/to",
        "/body",
        "/body/action",
        "/body/based_on_frame",
        "/body/expectation/bbox",
        "/body/budget",
    ] {
        let mut bad = env.clone();
        bad.pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("unknown".into(), true.into());
        assert!(decode_envelope(&bad.to_string()).is_err(), "{pointer}");
    }
    for (field, value) in [
        ("seq", serde_json::json!(0)),
        ("seq", serde_json::json!(1.0)),
        ("seq", serde_json::json!(true)),
        ("ts_ns", serde_json::json!(-1)),
        ("msg_id", serde_json::json!("")),
    ] {
        let mut bad = env.clone();
        bad[field] = value;
        assert!(decode_envelope(&bad.to_string()).is_err(), "{field}");
    }
    env.as_object_mut().unwrap().remove("nonce");
    assert!(decode_envelope(&env.to_string()).is_err());
    let duplicate = fixture().replacen("\"x\": 20", "\"x\": 20, \"\\u0078\": 21", 1);
    assert_eq!(
        decode_envelope(&duplicate),
        Err(metaviewer_core::DecodeError::DuplicateField)
    );
    let mut env: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    env["body"] = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap();
    // Optional absence is legal; explicit null must not disappear during decode.
    let properties: serde_json::Value =
        serde_json::from_str(include_str!("../../contracts/v0.2/surface.schema.json")).unwrap();
    let required = properties["required"].as_array().unwrap();
    for key in properties["properties"]
        .as_object()
        .unwrap()
        .keys()
        .filter(|k| !required.contains(&serde_json::json!(k)))
    {
        let mut bad = env.clone();
        bad["body"][key] = serde_json::Value::Null;
        assert!(decode_envelope(&bad.to_string()).is_err(), "{key}");
    }
}

#[test]
fn explicit_wire_limits_and_terminal_byte_count() {
    use metaviewer_core::{decode_envelope_with_limits, DecodeError, WireLimits};
    use std::time::Duration;
    let raw = fixture();
    let deadline = Duration::from_millis(50);
    let limits = |bytes, depth, keys, strings| {
        WireLimits::new(bytes, depth, keys, strings, deadline, deadline).unwrap()
    };
    assert!(decode_envelope_with_limits(&raw, &limits(raw.len() + 1, 32, 256, 65536)).is_ok());
    assert_eq!(
        decode_envelope_with_limits(&raw, &limits(raw.len(), 32, 256, 65536)),
        Err(DecodeError::Oversized)
    );
    assert_eq!(
        decode_envelope_with_limits(&raw, &limits(MAX_FRAME_BYTES, 1, 256, 65536)),
        Err(DecodeError::DepthExceeded)
    );
    assert_eq!(
        decode_envelope_with_limits(&raw, &limits(MAX_FRAME_BYTES, 32, 1, 65536)),
        Err(DecodeError::KeyLimitExceeded)
    );
    assert_eq!(
        decode_envelope_with_limits(&raw, &limits(MAX_FRAME_BYTES, 32, 256, 1)),
        Err(DecodeError::StringLimitExceeded)
    );
    assert!(WireLimits::new(0, 32, 256, 65536, deadline, deadline).is_err());
    assert!(WireLimits::new(MAX_FRAME_BYTES, 33, 256, 65536, deadline, deadline).is_err());
    let nested = format!("{}0{}", "[".repeat(33), "]".repeat(33));
    assert_eq!(decode_envelope(&nested), Err(DecodeError::DepthExceeded));
    let large = format!("[{}]", vec!["0"; 4097].join(","));
    assert_eq!(
        decode_envelope(&large),
        Err(DecodeError::ArrayLimitExceeded)
    );
    let mut env: serde_json::Value = serde_json::from_str(&raw).unwrap();
    env["body"] = serde_json::json!({"schema":"terminal_session/v0.2","request_id":"request","op":"write","params":{"session_id":"session","terminal_generation":1,"input_seq":1,"b64":"YQ==","byte_count":1}});
    assert!(decode_envelope(&env.to_string()).is_ok());
    env["body"]["params"]["byte_count"] = 2.into();
    assert!(decode_envelope(&env.to_string()).is_err());
}
