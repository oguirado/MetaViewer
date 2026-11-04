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

const NON_ENVELOPE_SCHEMA_PREFIXES: &[&str] = &["surface_input"];

const LEGACY_BODIES: &[&str] = &[
    "surface",
    "frame_ref",
    "surface_request",
    "surface_event",
    "observation",
    "action_proposal",
    "action_verdict",
    "action_receipt",
    "hello",
    "capsule_meta",
    "ui_intent",
    "catalog_entry",
    "terminal_session",
    "record_request",
    "record_event",
    "settings",
    "mv_tool_call",
    "mv_tool_result",
    "session_record",
    "capsule_state_request",
    "capsule_state_event",
];
const CAPSULE_BODIES: &[&str] = &[
    "headless_request",
    "headless_event",
    "guest_command_request",
    "guest_command_event",
];
const REWIND_BODIES: &[&str] = &["rewind_request", "rewind_event"];
const COMMAND_OBSERVATION_BODIES: &[&str] = &["guest_command_observation"];
fn family(prefix: &str) -> Option<&'static str> {
    if prefix == "envelope" || LEGACY_BODIES.contains(&prefix) {
        Some("envelope")
    } else if prefix == "capsule_envelope" || CAPSULE_BODIES.contains(&prefix) {
        Some("capsule_envelope")
    } else if prefix == "rewind_envelope" || REWIND_BODIES.contains(&prefix) {
        Some("rewind_envelope")
    } else if prefix == "guest_command_observation_envelope"
        || COMMAND_OBSERVATION_BODIES.contains(&prefix)
    {
        Some("guest_command_observation_envelope")
    } else {
        None
    }
}

// These host-only metadata schemas use regexes intentionally outside the wire
// scalar vocabulary. Exercise the unchanged canonical validator, not a skip.
fn canonical_metadata_valid(prefix: &str, raw: &[u8]) -> Result<bool, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let script = r#"import importlib.util,pathlib,sys
root=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('canonical_contracts',root/'tools/check_contracts.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
v=m.Validator(root/'contracts/v0.2')
s=v.load(sys.argv[2]+'.schema.json')
try:
 v.validate(m.loads_strict(sys.stdin.read()),s)
except m.ValidationError:
 print('invalid')
else:
 print('valid')
"#;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut child = Command::new("/usr/bin/python3")
        .args(["-I", "-B", "-c", script])
        .arg(root)
        .arg(prefix)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("canonical metadata validator unavailable: {e}"))?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(raw)
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("canonical metadata validator failed".into());
    }
    match output.stdout.as_slice() {
        b"valid\n" => Ok(true),
        b"invalid\n" => Ok(false),
        _ => Err("canonical metadata validator unknown response".into()),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ExampleDisposition {
    SkippedNonEnvelope,
    EmbeddedChecked { valid: bool },
    EnvelopeChecked { valid: bool },
    BodyChecked { prefix: String, valid: bool },
}

fn check_frozen_example(
    name: &str,
    raw: &[u8],
    base: &serde_json::Value,
    envelope_bodies: &std::collections::BTreeSet<String>,
) -> Result<ExampleDisposition, String> {
    let valid = name.ends_with(".json") && name.contains(".valid.");
    let invalid = name.ends_with(".json") && name.contains(".invalid.");
    if !valid && !invalid {
        return Err(format!("unrecognized fixture filename {name}"));
    }
    let prefix = name.split('.').next().unwrap_or("");
    if NON_ENVELOPE_SCHEMA_PREFIXES.contains(&prefix) {
        return Ok(ExampleDisposition::SkippedNonEnvelope);
    }
    if matches!(prefix, "guest_command_session" | "guest_transport_metadata") {
        let checked = if prefix == "guest_command_session" {
            serde_json::from_slice::<metaviewer_core::wire::guest_command::GuestCommandSession>(raw)
                .map(|_| ())
        } else {
            serde_json::from_slice::<metaviewer_core::wire::guest_command::GuestTransportMetadata>(
                raw,
            )
            .map(|_| ())
        };
        if checked.is_ok() != valid {
            return Err(format!(
                "{name}: embedded guest validity mismatch {checked:?}"
            ));
        }
        return Ok(ExampleDisposition::EmbeddedChecked { valid });
    }
    if prefix == "headless_session" {
        let checked =
            serde_json::from_slice::<metaviewer_core::wire::headless::HeadlessSession>(raw);
        if checked.is_ok() != valid {
            return Err(format!(
                "{name}: expected embedded valid={valid}, got {checked:?}"
            ));
        }
        return Ok(ExampleDisposition::EmbeddedChecked { valid });
    }
    let metadata = match prefix {
        "rewind_session" => Some(
            serde_json::from_slice::<metaviewer_core::wire::rewind::RewindSession>(raw).map(|_| ()),
        ),
        "rewind_point" => Some(
            serde_json::from_slice::<metaviewer_core::wire::rewind::RewindPoint>(raw).map(|_| ()),
        ),
        "rewind_guest_reset" => Some(
            serde_json::from_slice::<metaviewer_core::wire::rewind::RewindGuestReset>(raw)
                .map(|_| ()),
        ),
        _ => None,
    };
    if let Some(checked) = metadata {
        if checked.is_ok() != valid {
            return Err(format!("{name}: metadata validity mismatch {checked:?}"));
        }
        return Ok(ExampleDisposition::EmbeddedChecked { valid });
    }
    if matches!(
        prefix,
        "capsule_capabilities" | "capsule_resource_inventory"
    ) {
        if canonical_metadata_valid(prefix, raw)? != valid {
            return Err(format!("{name}: metadata validity mismatch"));
        }
        return Ok(ExampleDisposition::EmbeddedChecked { valid });
    }
    let family = family(prefix)
        .ok_or_else(|| format!("unrecognized schema prefix {prefix:?} in fixture {name}"))?;
    if prefix != family && !envelope_bodies.contains(prefix) {
        return Err(format!(
            "unrecognized schema prefix {prefix:?} in fixture {name}"
        ));
    }
    let value: serde_json::Value =
        serde_json::from_slice(raw).map_err(|err| format!("{name}: {err}"))?;
    let mut env = if family == "guest_command_observation_envelope" {
        serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/guest_command_observation_envelope.valid.json"
        ))
        .unwrap()
    } else {
        base.clone()
    };
    if prefix == family {
        env = value;
    } else {
        env["schema"] = format!("{family}/v0.2").into();
        env["body"] = value;
    }
    let result = decode_envelope(&serde_json::to_string(&env).unwrap());
    if result.is_ok() != valid {
        return Err(format!("{name}: expected valid={valid}, got {result:?}"));
    }
    if prefix == family {
        Ok(ExampleDisposition::EnvelopeChecked { valid })
    } else {
        Ok(ExampleDisposition::BodyChecked {
            prefix: prefix.to_string(),
            valid,
        })
    }
}

#[test]
fn all_frozen_body_examples_and_negative_controls() {
    let base: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    let mut envelope_bodies = std::collections::BTreeSet::new();
    for (schema, expected) in [
        (
            include_str!("../../contracts/v0.2/envelope.schema.json"),
            LEGACY_BODIES,
        ),
        (
            include_str!("../../contracts/v0.2/capsule_envelope.schema.json"),
            CAPSULE_BODIES,
        ),
        (
            include_str!("../../contracts/v0.2/rewind_envelope.schema.json"),
            REWIND_BODIES,
        ),
    ] {
        let schema: serde_json::Value = serde_json::from_str(schema).unwrap();
        let actual: std::collections::BTreeSet<String> = schema
            .pointer("/properties/body/oneOf")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                v["$ref"]
                    .as_str()
                    .unwrap()
                    .trim_end_matches(".schema.json")
                    .to_string()
            })
            .collect();
        assert_eq!(actual, expected.iter().map(|v| v.to_string()).collect());
        envelope_bodies.extend(actual);
    }
    // This separate read-only family intentionally uses one direct body ref.
    let observation_schema: serde_json::Value = serde_json::from_str(include_str!(
        "../../contracts/v0.2/guest_command_observation_envelope.schema.json"
    ))
    .unwrap();
    assert_eq!(
        observation_schema
            .pointer("/properties/body/$ref")
            .and_then(serde_json::Value::as_str),
        Some("guest_command_observation.schema.json")
    );
    assert_eq!(COMMAND_OBSERVATION_BODIES, &["guest_command_observation"]);
    envelope_bodies.extend(COMMAND_OBSERVATION_BODIES.iter().map(|s| s.to_string()));
    assert_eq!(LEGACY_BODIES.len(), 21);
    assert_eq!(CAPSULE_BODIES.len(), 4);
    assert_eq!(REWIND_BODIES.len(), 2);
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/examples/v0.2");
    let mut valid_body_prefixes = std::collections::BTreeSet::new();
    let mut invalid_body_prefixes = std::collections::BTreeSet::new();
    let mut skipped_non_envelope = 0usize;
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap();
        if name == "README.md" {
            continue;
        }
        let raw = std::fs::read(&path).unwrap();
        match check_frozen_example(name, &raw, &base, &envelope_bodies)
            .unwrap_or_else(|err| panic!("{err}"))
        {
            ExampleDisposition::SkippedNonEnvelope => {
                skipped_non_envelope += 1;
            }
            ExampleDisposition::EnvelopeChecked { .. } => {}
            ExampleDisposition::EmbeddedChecked { .. } => {}
            ExampleDisposition::BodyChecked { prefix, valid } => {
                if valid {
                    valid_body_prefixes.insert(prefix);
                } else {
                    invalid_body_prefixes.insert(prefix);
                }
            }
        }
    }
    assert_eq!(valid_body_prefixes, envelope_bodies);
    assert_eq!(invalid_body_prefixes, envelope_bodies);
    assert!(skipped_non_envelope >= 1);

    // Fail-closed negative controls: any unrecognized schema prefix is rejected
    // rather than silently converted into an is_err decode assertion.
    for unknown_name in [
        "unrecognized_schema.valid.json",
        "unrecognized_schema.invalid.schema.json",
    ] {
        let err = check_frozen_example(
            unknown_name,
            br#"{"schema":"unrecognized_schema/v0.2"}"#,
            &base,
            &envelope_bodies,
        )
        .unwrap_err();
        assert!(
            err.contains("unrecognized schema prefix"),
            "unexpected error for {unknown_name}: {err}"
        );
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

#[test]
fn integer_upper_rails_are_exact_and_recursive() {
    use metaviewer_core::{DecodeError, MAX_WIRE_INTEGER};
    let base: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    for pointer in [
        "/seq",
        "/ts_ns",
        "/body/based_on_frame/generation",
        "/body/action/x",
    ] {
        let mut value = base.clone();
        *value.pointer_mut(pointer).unwrap() = MAX_WIRE_INTEGER.into();
        assert!(decode_envelope(&value.to_string()).is_ok(), "{pointer}");
        *value.pointer_mut(pointer).unwrap() = (MAX_WIRE_INTEGER + 1).into();
        assert_eq!(
            decode_envelope(&value.to_string()),
            Err(DecodeError::OutOfBounds),
            "{pointer}"
        );
    }
    for (pointer, cap) in [
        ("/body/budget/max_ms", 3_600_000_u64),
        ("/body/budget/max_retries", 10_u64),
        ("/body/expectation/bbox/w", 16_384_u64),
        ("/body/expectation/bbox/h", 16_384_u64),
    ] {
        let mut value = base.clone();
        *value.pointer_mut(pointer).unwrap() = cap.into();
        assert!(decode_envelope(&value.to_string()).is_ok(), "{pointer}");
        *value.pointer_mut(pointer).unwrap() = (cap + 1).into();
        assert_eq!(
            decode_envelope(&value.to_string()),
            Err(DecodeError::InvalidField),
            "{pointer}"
        );
        *value.pointer_mut(pointer).unwrap() = (MAX_WIRE_INTEGER + 1).into();
        assert_eq!(
            decode_envelope(&value.to_string()),
            Err(DecodeError::OutOfBounds),
            "{pointer}"
        );
    }
    for delta in [
        MAX_WIRE_INTEGER as i64,
        -(MAX_WIRE_INTEGER as i64),
        MAX_WIRE_INTEGER as i64 + 1,
        -(MAX_WIRE_INTEGER as i64) - 1,
    ] {
        let mut value = base.clone();
        value["body"]["action"] = serde_json::json!({"type":"scroll", "dx":delta, "dy":0});
        let result = decode_envelope(&value.to_string());
        assert_eq!(result.is_ok(), delta.unsigned_abs() <= MAX_WIRE_INTEGER);
        if result.is_err() {
            assert_eq!(result, Err(DecodeError::OutOfBounds));
        }
    }
}

#[test]
fn frame_paths_accept_literal_rn_and_refuse_controls() {
    let mut env: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    env["body"] = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    // Locate the schema's path property rather than assuming the fixture layout.
    let object = env["body"].as_object_mut().unwrap();
    let key = object
        .iter()
        .find(|(_, v)| v.as_str().is_some_and(|s| s.starts_with("/dev/shm/")))
        .map(|(k, _)| k.clone())
        .unwrap();
    env["body"][&key] = "/dev/shm/frame_rn".into();
    assert!(decode_envelope(&env.to_string()).is_ok());
    for control in ['\0', '\r', '\n'] {
        env["body"][&key] = format!("/dev/shm/frame{control}").into();
        assert!(decode_envelope(&env.to_string()).is_err());
    }
}

#[test]
fn mv_tool_result_refuses_nested_v01_schemas_and_admits_v02() {
    let base: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    let frame: serde_json::Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    let surface: serde_json::Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap();
    let verified_result: serde_json::Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/mv_tool_result.valid.json"
    ))
    .unwrap();

    let observe_v02 = serde_json::json!({
        "schema": "mv_tool_result/v0.2",
        "request_id": "req-001",
        "op": "observe",
        "status": "ok",
        "observation": {
            "schema": "observation/v0.2",
            "frame_ref": frame,
        }
    });
    let list_v02 = serde_json::json!({
        "schema": "mv_tool_result/v0.2",
        "request_id": "req-001",
        "op": "list",
        "status": "ok",
        "surfaces": [surface],
        "next_cursor": null
    });
    let propose_v02 = serde_json::json!({
        "schema": "mv_tool_result/v0.2",
        "request_id": "req-001",
        "op": "propose",
        "status": "admitted",
        "verdict": {
            "schema": "action_verdict/v0.2",
            "proposal_id": "prop-001",
            "decision": "admitted",
            "core_seq": 1
        }
    });

    for (body, pointer, v01_tag) in [
        (&observe_v02, "/observation/schema", "observation/v0.1"),
        (
            &observe_v02,
            "/observation/frame_ref/schema",
            "frame_ref/v0.1",
        ),
        (&list_v02, "/surfaces/0/schema", "surface/v0.1"),
        (&propose_v02, "/verdict/schema", "action_verdict/v0.1"),
        (&verified_result, "/receipt/schema", "action_receipt/v0.1"),
        (
            &verified_result,
            "/receipt/after_frame/schema",
            "frame_ref/v0.1",
        ),
    ] {
        let mut valid_env = base.clone();
        valid_env["body"] = (*body).clone();
        assert!(
            decode_envelope(&valid_env.to_string()).is_ok(),
            "negative control failed for {pointer}"
        );

        let mut bad_env = valid_env;
        *bad_env["body"].pointer_mut(pointer).unwrap() = v01_tag.into();
        assert!(
            decode_envelope(&bad_env.to_string()).is_err(),
            "nested v0.1 should be refused at {pointer}"
        );
    }
}

#[test]
fn body_known_family_version_mismatch_is_unknown_version() {
    use metaviewer_core::DecodeError;
    let base: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    assert!(decode_envelope(&base.to_string()).is_ok());

    for tag in [
        "action_proposal/v9.9",
        "action_proposal/v0.1",
        "hello/v9.9",
        "mv_tool_result/v0.1",
    ] {
        let mut bad = base.clone();
        bad["body"]["schema"] = tag.into();
        assert_eq!(
            decode_envelope(&bad.to_string()),
            Err(DecodeError::UnknownVersion),
            "{tag}"
        );
    }

    for unknown_family in [
        "unknown_family/v0.2",
        "unknown_family/v9.9",
        "envelope/v9.9",
        "action_proposal",
    ] {
        let mut bad = base.clone();
        bad["body"]["schema"] = unknown_family.into();
        assert_eq!(
            decode_envelope(&bad.to_string()),
            Err(DecodeError::Malformed),
            "{unknown_family}"
        );
    }

    let frame_ref: serde_json::Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    let mut frame_12 = frame_ref.clone();
    frame_12["extra_tag"] = "twelfth".into();
    let schema_10 = serde_json::json!({
        "$defs": {
            "frame_ref_12": {
                "type": "object",
                "properties": {
                    "schema": { "const": "frame_ref/v0.2" },
                    "surface_id": { "type": "string" },
                    "generation": { "type": "integer" },
                    "tick": { "type": "integer" },
                    "ts_ns": { "type": "integer" },
                    "width": { "type": "integer" },
                    "height": { "type": "integer" },
                    "format": { "const": "rgb24" },
                    "ramws_path": { "type": "string" },
                    "sha256": { "type": "string" },
                    "capture_us": { "type": "integer" },
                    "extra_tag": { "type": "string" }
                },
                "required": [
                    "schema", "surface_id", "generation", "tick", "ts_ns",
                    "width", "height", "format", "ramws_path", "sha256", "capture_us"
                ],
                "additionalProperties": false,
                "maxProperties": 256
            }
        },
        "$ref": "#/$defs/frame_ref_12",
        "maxProperties": 10
    });
    let mut schema_12 = schema_10.clone();
    schema_12["maxProperties"] = 12.into();
    assert!(!metaviewer_core::valid(&frame_12, &schema_10, &schema_10));
    assert!(metaviewer_core::valid(&frame_12, &schema_12, &schema_12));
    let typeless_obj_constraint = serde_json::json!({ "maxProperties": 1 });
    assert!(metaviewer_core::valid(
        &serde_json::json!("non-object"),
        &typeless_obj_constraint,
        &typeless_obj_constraint
    ));
}

#[test]
fn closed_families_and_metadata_cannot_cross_wire() {
    let base: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    for (name, bodies) in [
        ("envelope", LEGACY_BODIES),
        ("capsule_envelope", CAPSULE_BODIES),
        ("rewind_envelope", REWIND_BODIES),
    ] {
        for body in bodies {
            let raw = std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join(format!("../contracts/examples/v0.2/{body}.valid.json")),
            )
            .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&raw).unwrap();
            for tag in ["envelope", "capsule_envelope", "rewind_envelope"] {
                let mut env = base.clone();
                env["schema"] = format!("{tag}/v0.2").into();
                env["body"] = value.clone();
                assert_eq!(
                    decode_envelope(&env.to_string()).is_ok(),
                    tag == name,
                    "{body} in {tag}"
                );
            }
        }
    }
    for helper in [
        "headless_session",
        "guest_command_session",
        "guest_transport_metadata",
        "rewind_session",
        "rewind_point",
        "rewind_guest_reset",
        "capsule_capabilities",
        "capsule_resource_inventory",
    ] {
        let value: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join(format!("../contracts/examples/v0.2/{helper}.valid.json")),
            )
            .unwrap(),
        )
        .unwrap();
        for tag in ["envelope", "capsule_envelope", "rewind_envelope"] {
            let mut env = base.clone();
            env["schema"] = format!("{tag}/v0.2").into();
            env["body"] = value.clone();
            assert!(
                decode_envelope(&env.to_string()).is_err(),
                "helper {helper} in {tag}"
            );
        }
    }
}

#[test]
fn reset_metadata_entropy_predicate_matches_closed_contract() {
    use metaviewer_core::wire::rewind::RewindGuestReset;
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/rewind_guest_reset.valid.request.json"
    ))
    .unwrap();
    for entropy in [
        "0".repeat(128),
        "F".repeat(128),
        "1".repeat(127),
        "1".repeat(129),
        format!("{}g", "1".repeat(127)),
    ] {
        let mut bad = value.clone();
        bad["entropy"] = entropy.into();
        assert!(serde_json::from_value::<RewindGuestReset>(bad).is_err());
    }
    for entropy in [
        format!("{}1", "0".repeat(127)),
        format!("f{}", "0".repeat(127)),
    ] {
        let mut good = value.clone();
        good["entropy"] = entropy.into();
        assert!(serde_json::from_value::<RewindGuestReset>(good).is_ok());
    }
}

#[test]
fn merged_slot_and_arm_families_stay_disjoint() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/examples/v0.2");
    let base: serde_json::Value = serde_json::from_str(&fixture()).unwrap();
    for (name, own) in [
        ("capsule_state_request", "envelope/v0.2"),
        ("capsule_state_event", "envelope/v0.2"),
        ("guest_command_request", "capsule_envelope/v0.2"),
        ("guest_command_event", "capsule_envelope/v0.2"),
        ("headless_request", "capsule_envelope/v0.2"),
        ("headless_event", "capsule_envelope/v0.2"),
    ] {
        let body: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join(format!("{name}.valid.json"))).unwrap(),
        )
        .unwrap();
        for family in ["envelope/v0.2", "capsule_envelope/v0.2"] {
            let mut envelope = base.clone();
            envelope["schema"] = family.into();
            envelope["body"] = body.clone();
            assert_eq!(
                decode_envelope(&envelope.to_string()).is_ok(),
                family == own,
                "{name} / {family}"
            );
        }
    }
}

#[test]
fn command_observation_fourth_family_stays_read_only_and_closed() {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/guest_command_observation_envelope.valid.ui.json"
    ))
    .unwrap();
    assert!(decode_envelope(&value.to_string()).is_ok());
    for tag in [
        "envelope/v0.2",
        "capsule_envelope/v0.2",
        "rewind_envelope/v0.2",
    ] {
        let mut bad = value.clone();
        bad["schema"] = tag.into();
        assert!(decode_envelope(&bad.to_string()).is_err());
    }
    for (field, component) in [("from", "agent"), ("from", "daemon"), ("to", "agent")] {
        let mut bad = value.clone();
        bad[field]["component"] = component.into();
        assert!(decode_envelope(&bad.to_string()).is_err());
    }
    let mut extra = value.clone();
    extra["body"]["stdin_b64"] = "".into();
    assert!(decode_envelope(&extra.to_string()).is_err());
    assert!(family("guest_command_observation_unknown").is_none());
}
