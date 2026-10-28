#![forbid(unsafe_code)]

use metaviewer_core::journal::sha256_hex;
use metaviewer_core::record::capture::{Host, DEFAULT_FPS, MAX_FPS};
use metaviewer_core::record::{Coordinator, Error as RecordError, JournalSink};
use metaviewer_core::wire::payload::{
    FrameRef, RecordEvent, RecordEventRefusal, RecordRequest, SessionRecord, Settings,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const PARITY_FIXTURE_JSON: &str = include_str!("../../tests/fixtures/settings_parity.json");

#[derive(Default)]
struct MemorySink {
    entries: Vec<(SessionRecord, Vec<RecordEvent>)>,
}

impl JournalSink for MemorySink {
    fn append(
        &mut self,
        record: &SessionRecord,
        events: &[RecordEvent],
    ) -> Result<(), RecordError> {
        self.entries.push((record.clone(), events.to_vec()));
        Ok(())
    }
}

fn fixture_vectors() -> Value {
    serde_json::from_str(PARITY_FIXTURE_JSON).expect("valid settings_parity.json")
}

fn admitted_surfaces() -> BTreeSet<String> {
    BTreeSet::from(["s1".to_owned()])
}

fn seed_host_with_frame(surface: &str) -> (Host, Vec<u8>, FrameRef) {
    let mut raw: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .expect("valid frame_ref example");
    let bytes = vec![7_u8; 64];
    raw["surface_id"] = surface.into();
    raw["sha256"] = sha256_hex(&bytes).into();
    let frame: FrameRef = serde_json::from_value(raw).expect("valid FrameRef");
    let mut host = Host::default();
    host.frame(&frame, bytes.clone(), 1000)
        .expect("frame accepted");
    (host, bytes, frame)
}

#[test]
fn parity_d1_wire_payload_requires_integer_max_fps_and_explicit_fps_decimates() {
    let vectors = fixture_vectors();
    assert_eq!(
        DEFAULT_FPS,
        vectors["contract_bounds"]["defaults"]["rust_capture_fps"]
            .as_u64()
            .unwrap()
    );
    assert_eq!(
        MAX_FPS,
        vectors["contract_bounds"]["ui_ceiling_fps"]
            .as_u64()
            .unwrap()
    );

    let valid_req: RecordRequest =
        serde_json::from_value(vectors["d1_lenient_default"]["valid_ram_start_fps_20"].clone())
            .expect("valid ram_start request");
    let settings: Settings = serde_json::from_value(
        vectors["d5_settings_limits"]["valid_settings_v02"][1]["doc"].clone(),
    )
    .expect("valid settings");
    let mut coord = Coordinator::new(&settings, admitted_surfaces()).expect("coordinator");
    let mut sink = MemorySink::default();
    let events = coord
        .handle(&valid_req, 1_000_000, &mut sink)
        .expect("handle valid request");
    assert!(matches!(events.as_slice(), [RecordEvent::Case0(_)]));

    for invalid in vectors["d1_lenient_default"]["invalid_requests"]
        .as_array()
        .expect("invalid_requests array")
    {
        let id = invalid["id"].as_str().unwrap_or("<unknown>");
        let parsed = serde_json::from_value::<RecordRequest>(invalid["request"].clone());
        assert!(
            parsed.is_err(),
            "RecordRequest must refuse invalid max_fps vector {id}"
        );
    }

    // Explicit max_fps = 20 (period 50 ms) on Host::prepare decimates a frame at +10 ms and keeps one at +60 ms.
    let (host, bytes, frame) = seed_host_with_frame("s1");
    let (mut host, reply, _) = host
        .prepare(
            "recordStart",
            &json!({
                "schema": "capture_request/v1",
                "request_id": "req-explicit-20",
                "surface_id": "s1",
                "mode": "ai",
                "max_fps": 20
            }),
            admitted_surfaces(),
            1000,
        )
        .expect("prepare explicit 20 fps");
    assert_eq!(reply["ok"], true);
    let rec_id = reply["recording_id"].as_str().unwrap().to_owned();

    // Frame at 1010 ms (elapsed 10 ms < 50 ms) is decimated.
    host.frame(&frame, bytes.clone(), 1010)
        .expect("frame at 1010 ms");
    // Frame at 1060 ms (elapsed 60 ms >= 50 ms) is kept.
    host.frame(&frame, bytes, 1060).expect("frame at 1060 ms");

    let (_, stop_reply, _) = host
        .prepare(
            "recordStop",
            &json!({
                "schema": "capture_request/v1",
                "request_id": "req-stop-20",
                "recording_id": rec_id
            }),
            admitted_surfaces(),
            1100,
        )
        .expect("stop explicit 20 fps");
    assert_eq!(stop_reply["ok"], true);
    assert_eq!(stop_reply["recording"]["frames"], 2);
    assert_eq!(stop_reply["recording"]["dropped_frames"], 1);
}

#[test]
fn parity_d2_coordinator_accepts_1_to_120_and_enforces_configured_ceiling() {
    let vectors = fixture_vectors();
    let settings_120: Settings = serde_json::from_value(
        vectors["d5_settings_limits"]["valid_settings_v02"][2]["doc"].clone(),
    )
    .expect("valid settings with max_fps 120");
    let mut coord_120 =
        Coordinator::new(&settings_120, admitted_surfaces()).expect("coordinator 120");
    let mut sink = MemorySink::default();

    let mut all_valid_fps = Vec::new();
    for v in vectors["d2_ceiling_sixty_vs_one_twenty"]["accepted_1_to_60"]
        .as_array()
        .unwrap()
    {
        all_valid_fps.push(v.as_u64().unwrap());
    }
    for v in vectors["d2_ceiling_sixty_vs_one_twenty"]["contract_valid_61_to_120"]
        .as_array()
        .unwrap()
    {
        all_valid_fps.push(v.as_u64().unwrap());
    }

    for (idx, fps) in all_valid_fps.iter().copied().enumerate() {
        let ram_req: RecordRequest = serde_json::from_value(json!({
            "schema": "record_request/v0.2",
            "request_id": format!("req-ram-{idx}-{fps}"),
            "op": "ram_start",
            "params": {
                "surface_id": "s1",
                "recording_id": format!("rec-ram-{idx}-{fps}"),
                "ring_bytes": 1024,
                "max_fps": fps
            }
        }))
        .expect("valid ram_start");
        let events = coord_120
            .handle(&ram_req, 1000, &mut sink)
            .expect("handle ram_start");
        assert!(
            matches!(events.as_slice(), [RecordEvent::Case0(_)]),
            "Coordinator(120) must admit ram_start max_fps={fps}"
        );

        let disk_req: RecordRequest = serde_json::from_value(json!({
            "schema": "record_request/v0.2",
            "request_id": format!("req-disk-{idx}-{fps}"),
            "op": "disk_start",
            "params": {
                "surface_id": "s1",
                "recording_id": format!("rec-disk-{idx}-{fps}"),
                "destination_capability_id": "recording:configured",
                "destination_path": "/tmp/mv-export",
                "max_fps": fps
            }
        }))
        .expect("valid disk_start");
        let events = coord_120
            .handle(&disk_req, 2000, &mut sink)
            .expect("handle disk_start");
        assert!(
            matches!(events.as_slice(), [RecordEvent::Case0(_)]),
            "Coordinator(120) must admit disk_start max_fps={fps}"
        );
    }

    for bad in vectors["d2_ceiling_sixty_vs_one_twenty"]["out_of_contract_fps"]
        .as_array()
        .unwrap()
    {
        if let Some(fps) = bad.as_u64() {
            let req: RecordRequest = serde_json::from_value(json!({
                "schema": "record_request/v0.2",
                "request_id": format!("req-bad-{fps}"),
                "op": "ram_start",
                "params": {
                    "surface_id": "s1",
                    "recording_id": format!("rec-bad-{fps}"),
                    "ring_bytes": 1024,
                    "max_fps": fps
                }
            }))
            .expect("u64 request");
            let events = coord_120
                .handle(&req, 3000, &mut sink)
                .expect("handle out-of-contract u64");
            match events.as_slice() {
                [RecordEvent::Case5(refused)] => {
                    assert_eq!(refused.reason_code, RecordEventRefusal::POLICY);
                }
                other => panic!("expected POLICY refusal for max_fps={fps}, got {other:?}"),
            }
        } else {
            let parsed = serde_json::from_value::<RecordRequest>(json!({
                "schema": "record_request/v0.2",
                "request_id": "req-neg",
                "op": "ram_start",
                "params": {
                    "surface_id": "s1",
                    "recording_id": "rec-neg",
                    "ring_bytes": 1024,
                    "max_fps": bad
                }
            }));
            assert!(
                parsed.is_err(),
                "negative max_fps must fail u64 deserialization"
            );
        }
    }

    // Coordinator configured with max_fps = 30 refuses 61..=120 with BUDGET_EXCEEDED.
    let settings_30: Settings = serde_json::from_value(
        vectors["d5_settings_limits"]["valid_settings_v02"][1]["doc"].clone(),
    )
    .expect("valid settings 30");
    let mut coord_30 = Coordinator::new(&settings_30, admitted_surfaces()).expect("coordinator 30");
    for v in vectors["d2_ceiling_sixty_vs_one_twenty"]["contract_valid_61_to_120"]
        .as_array()
        .unwrap()
    {
        let fps = v.as_u64().unwrap();
        let req: RecordRequest = serde_json::from_value(json!({
            "schema": "record_request/v0.2",
            "request_id": format!("req-budget-{fps}"),
            "op": "ram_start",
            "params": {
                "surface_id": "s1",
                "recording_id": format!("rec-budget-{fps}"),
                "ring_bytes": 1024,
                "max_fps": fps
            }
        }))
        .expect("u64 request");
        let events = coord_30
            .handle(&req, 4000, &mut sink)
            .expect("handle budget check");
        match events.as_slice() {
            [RecordEvent::Case5(refused)] => {
                assert_eq!(refused.reason_code, RecordEventRefusal::BUDGETEXCEEDED);
            }
            other => panic!("expected BUDGET_EXCEEDED for max_fps={fps}, got {other:?}"),
        }
    }
}

#[test]
fn parity_d3_wire_payload_refuses_json_float_lexeme_30_0() {
    let vectors = fixture_vectors();
    let d3 = &vectors["d3_float_lexeme"];

    let ram_raw = d3["record_request_ram_start_30_0_json"].as_str().unwrap();
    assert!(
        serde_json::from_str::<RecordRequest>(ram_raw).is_err(),
        "RecordRequest ram_start must refuse 30.0 float lexeme"
    );

    let disk_raw = d3["record_request_disk_start_30_0_json"].as_str().unwrap();
    assert!(
        serde_json::from_str::<RecordRequest>(disk_raw).is_err(),
        "RecordRequest disk_start must refuse 30.0 float lexeme"
    );

    let settings_raw = d3["settings_v02_limits_30_0_json"].as_str().unwrap();
    assert!(
        serde_json::from_str::<Settings>(settings_raw).is_err(),
        "Settings limits.max_fps must refuse 30.0 float lexeme"
    );
}

#[test]
fn parity_d4_wire_payload_refuses_unknown_keys() {
    let vectors = fixture_vectors();
    let d4 = &vectors["d4_unknown_keys"];

    assert!(
        serde_json::from_value::<RecordRequest>(d4["record_request_unknown_top"].clone()).is_err(),
        "RecordRequest must refuse unknown top-level key"
    );
    assert!(
        serde_json::from_value::<RecordRequest>(d4["record_request_unknown_param"].clone())
            .is_err(),
        "RecordRequest must refuse unknown params key"
    );
    assert!(
        serde_json::from_value::<Settings>(d4["settings_v02_unknown_top"].clone()).is_err(),
        "Settings must refuse unknown top-level key"
    );
    assert!(
        serde_json::from_value::<Settings>(d4["settings_v02_unknown_limit"].clone()).is_err(),
        "Settings must refuse unknown limits key"
    );
}

#[test]
fn parity_d5_settings_v02_limits_decoder_enforces_1_to_120() {
    let vectors = fixture_vectors();
    for entry in vectors["d5_settings_limits"]["valid_settings_v02"]
        .as_array()
        .unwrap()
    {
        let id = entry["id"].as_str().unwrap();
        let settings: Settings = serde_json::from_value(entry["doc"].clone())
            .unwrap_or_else(|e| panic!("valid settings {id} failed deserialize: {e}"));
        assert!(
            Coordinator::new(&settings, admitted_surfaces()).is_ok(),
            "Coordinator::new must accept valid settings {id}"
        );
    }

    for entry in vectors["d5_settings_limits"]["invalid_settings_v02"]
        .as_array()
        .unwrap()
    {
        let id = entry["id"].as_str().unwrap();
        match serde_json::from_value::<Settings>(entry["doc"].clone()) {
            Err(_) => {}
            Ok(settings) => {
                assert_eq!(
                    Coordinator::new(&settings, admitted_surfaces()),
                    Err(RecordError::Configuration),
                    "Coordinator::new must refuse invalid settings {id}"
                );
            }
        }
    }
}

#[test]
#[ignore = "FINDING D1"]
fn finding_d1_capture_prepare_refuses_missing_or_non_integer_max_fps() {
    let vectors = fixture_vectors();
    let (host, _, _) = seed_host_with_frame("s1");

    for invalid in vectors["d1_lenient_default"]["invalid_requests"]
        .as_array()
        .unwrap()
    {
        let id = invalid["id"].as_str().unwrap();
        let outcome = host.prepare(
            "recordStart",
            &invalid["capture_req"],
            admitted_surfaces(),
            1000,
        );
        let accepted = matches!(&outcome, Ok((_, reply, _)) if reply["ok"] == true);
        assert!(
            !accepted,
            "Host::prepare must refuse invalid or missing max_fps case {id}, got {outcome:?}"
        );
    }
}

#[test]
#[ignore = "FINDING D2"]
fn finding_d2_capture_prepare_admits_contract_valid_61_to_120_max_fps() {
    let vectors = fixture_vectors();
    let (host, _, _) = seed_host_with_frame("s1");

    for v in vectors["d2_ceiling_sixty_vs_one_twenty"]["contract_valid_61_to_120"]
        .as_array()
        .unwrap()
    {
        let fps = v.as_u64().unwrap();
        let (_, reply, _) = host
            .prepare(
                "recordStart",
                &json!({
                    "schema": "capture_request/v1",
                    "request_id": format!("req-d2-{fps}"),
                    "surface_id": "s1",
                    "mode": "ai",
                    "max_fps": fps
                }),
                admitted_surfaces(),
                1000,
            )
            .expect("prepare contract-valid max_fps");
        assert_eq!(
            reply["ok"], true,
            "Host::prepare must admit contract-valid max_fps={fps}, got {reply}"
        );
    }
}

#[test]
#[ignore = "FINDING D4"]
fn finding_d4_capture_prepare_refuses_unknown_keys_in_request() {
    let (host, _, _) = seed_host_with_frame("s1");
    let outcome = host.prepare(
        "recordStart",
        &json!({
            "schema": "capture_request/v1",
            "request_id": "req-d4-extra",
            "surface_id": "s1",
            "mode": "ai",
            "max_fps": 30,
            "extra": 1
        }),
        admitted_surfaces(),
        1000,
    );
    let accepted = matches!(&outcome, Ok((_, reply, _)) if reply["ok"] == true);
    assert!(
        !accepted,
        "Host::prepare must refuse unknown keys in capture request, got {outcome:?}"
    );
}
