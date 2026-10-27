//! Verify actual server envelopes against standalone v0.2 field sets and the
//! agents codec. No persisted fixture or host-specific tool path is required.
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

fn check_objects(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            if let Some(tag) = object.get("schema").and_then(Value::as_str) {
                let name = tag.split('/').next().unwrap();
                let raw = match name {
                    "frame_ref" => Some(include_str!("../../contracts/v0.2/frame_ref.schema.json")),
                    "observation" => {
                        Some(include_str!("../../contracts/v0.2/observation.schema.json"))
                    }
                    "surface" => Some(include_str!("../../contracts/v0.2/surface.schema.json")),
                    "action_receipt" => Some(include_str!(
                        "../../contracts/v0.2/action_receipt.schema.json"
                    )),
                    _ => None,
                };
                if let Some(raw) = raw {
                    let schema: Value = serde_json::from_str(raw).unwrap();
                    if value["schema"] != schema["properties"]["schema"]["const"] {
                        return Err(format!("wrong nested tag: {tag}"));
                    }
                    let properties = schema["properties"].as_object().unwrap();
                    if object.keys().any(|key| !properties.contains_key(key))
                        || schema["required"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|key| !object.contains_key(key.as_str().unwrap()))
                    {
                        return Err(format!("wrong field set: {tag}"));
                    }
                }
            }
            for child in object.values() {
                check_objects(child)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                check_objects(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn assert_v02_output(envelope: &Value) {
    check_objects(envelope).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut child = Command::new("python3")
        .arg("-c")
        .arg("import sys; from metaviewer_agents.envelope import loads_envelope; loads_envelope(sys.stdin.buffer.read(), max_bytes=1048576)")
        .env("PYTHONPATH", root.join("agents"))
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("python3 agents codec must be available");
    let mut line = serde_json::to_vec(envelope).unwrap();
    line.push(b'\n');
    child.stdin.take().unwrap().write_all(&line).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "agents rejected core output: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn contract_check_rejects_legacy_tags_missing_path_and_extra_fields() {
    let frame: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    assert!(check_objects(&frame).is_ok());
    let mut legacy = frame.clone();
    legacy["schema"] = "frame_ref/v0.1".into();
    assert!(check_objects(&legacy).is_err());
    let mut missing = frame.clone();
    missing.as_object_mut().unwrap().remove("ramws_path");
    assert!(check_objects(&missing).is_err());
    let mut extra = frame;
    extra["unknown"] = true.into();
    assert!(check_objects(&extra).is_err());
}

#[test]
fn frozen_verified_receipt_serializes_as_v02_for_agents() {
    // Frozen tool-result fixtures still contain legacy embedded tags. They stay
    // readable, but serialization must project every nested tag to v0.2.
    let body: metaviewer_core::Command = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/mv_tool_result.valid.json"
    ))
    .unwrap();
    let mut envelope: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/envelope.valid.json"
    ))
    .unwrap();
    envelope["body"] = serde_json::to_value(body).unwrap();
    assert_eq!(envelope["body"]["receipt"]["schema"], "action_receipt/v0.2");
    assert_eq!(
        envelope["body"]["receipt"]["after_frame"]["schema"],
        "frame_ref/v0.2"
    );
    let decoded = metaviewer_core::decode_envelope(&envelope.to_string()).unwrap();
    assert_v02_output(&serde_json::to_value(decoded).unwrap());
}
