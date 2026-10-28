use metaviewer_core::decode_envelope;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
struct ParityFixture {
    schema: String,
    contract_version: String,
    envelope_template: Value,
    vectors: Vec<ParityVector>,
}

#[derive(Debug, Deserialize)]
struct ParityVector {
    id: String,
    family: String,
    axis: String,
    contract_verdict: String,
    findings: BTreeMap<String, String>,
    payload: Value,
}

fn load_fixture() -> ParityFixture {
    let raw = include_str!("../../tests/fixtures/frames_parity.json");
    serde_json::from_str(raw).expect("valid frames_parity.json fixture")
}

fn wrap_in_envelope(template: &Value, body: &Value) -> String {
    let mut env = template.clone();
    env["body"] = body.clone();
    serde_json::to_string(&env).expect("serializable envelope")
}

fn run_parity_suite<F>(
    fixture: &ParityFixture,
    mut decode_fn: F,
) -> (Vec<(String, String)>, Vec<String>)
where
    F: FnMut(&str) -> bool,
{
    let mut skipped_findings = Vec::new();
    let mut failures = Vec::new();

    for vec in &fixture.vectors {
        assert!(
            matches!(
                vec.family.as_str(),
                "frame_ref" | "surface_event" | "observation"
            ),
            "unexpected family {} in {}",
            vec.family,
            vec.id
        );
        assert!(
            !vec.axis.is_empty(),
            "missing review axis on vector {}",
            vec.id
        );
        let expected_accept = match vec.contract_verdict.as_str() {
            "accept" => true,
            "refuse" => false,
            other => panic!("unexpected contract_verdict {other} on {}", vec.id),
        };
        let raw = wrap_in_envelope(&fixture.envelope_template, &vec.payload);
        let actual_accept = decode_fn(&raw);

        if let Some(finding) = vec.findings.get("rust_envelope") {
            assert!(
                finding.starts_with("FINDING "),
                "finding reason must start with FINDING: {finding}"
            );
            // Confirm the divergence is still present on the unfixed decoder before skipping.
            if actual_accept == expected_accept {
                failures.push(format!(
                    "{}: marked skipped with {finding}, but decoder now matches contract_verdict={}",
                    vec.id, vec.contract_verdict
                ));
            } else {
                skipped_findings.push((vec.id.clone(), finding.clone()));
            }
            continue;
        }

        if actual_accept != expected_accept {
            failures.push(format!(
                "{}: expected contract_verdict={}, got accept={actual_accept}",
                vec.id, vec.contract_verdict
            ));
        }
    }

    (skipped_findings, failures)
}

#[test]
fn frames_parity_vectors_against_rust_decoder() {
    let fixture = load_fixture();
    assert_eq!(fixture.schema, "metaviewer.frames_parity/v1");
    assert_eq!(fixture.contract_version, "v0.2");
    assert_eq!(fixture.vectors.len(), 26);

    let (skipped, failures) = run_parity_suite(&fixture, |raw| decode_envelope(raw).is_ok());
    assert!(
        failures.is_empty(),
        "Rust decoder parity failures: {failures:?}"
    );
    assert_eq!(
        skipped,
        vec![
            (
                "observation_invalid_escape_changed_region".to_string(),
                "FINDING D8".to_string()
            ),
            (
                "observation_invalid_escape_element_bbox".to_string(),
                "FINDING D8".to_string()
            ),
        ]
    );
}

#[test]
fn frames_parity_kills_mutated_rust_sha256_case_decoder() {
    // Mutation in core/src/wire/mod.rs:380-381:
    // replacing `b.is_ascii_digit() || (b'a'..=b'f').contains(&b)` with `b.is_ascii_hexdigit()`
    // so uppercase hex in `frame_ref.sha256` is accepted.
    let fixture = load_fixture();
    let (_skipped, failures) = run_parity_suite(&fixture, |raw| {
        let mut parsed: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => return false,
        };
        if let Some(sha) = parsed
            .pointer("/body/sha256")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            if sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                parsed["body"]["sha256"] = Value::String(sha.to_ascii_lowercase());
            }
        }
        let mutated_raw = serde_json::to_string(&parsed).unwrap();
        decode_envelope(&mutated_raw).is_ok()
    });
    assert!(
        failures
            .iter()
            .any(|msg| msg.starts_with("frame_ref_invalid_sha256_upper:")),
        "expected mutated decoder to be killed by frame_ref_invalid_sha256_upper, got {failures:?}"
    );
}
