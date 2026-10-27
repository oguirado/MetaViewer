use metaviewer_core::record::{Coordinator, Error, JournalSink};
use metaviewer_core::wire::payload::{RecordEvent, RecordRequest, SessionRecord, Settings};
use serde_json::{json, Value};
use std::collections::BTreeSet;

struct Sink;
impl JournalSink for Sink {
    fn append(&mut self, _: &SessionRecord, _: &[RecordEvent]) -> Result<(), Error> {
        Ok(())
    }
}

fn coordinator() -> Coordinator {
    let settings: Settings = serde_json::from_value(json!({
        "schema":"settings/v0.2", "theme":"metaviewer-light", "providers":[],
        "recording_destination":{"capability_id":"cap","path":"/exports/a.tar"},
        "limits":{"memory_bytes":32,"ring_bytes":16,"max_fps":30}
    }))
    .unwrap();
    Coordinator::new(&settings, BTreeSet::from(["s".into()])).unwrap()
}

fn request(op: &str, id: &str) -> RecordRequest {
    let mut params = json!({"surface_id":"s", "recording_id":id});
    if op == "ram_start" {
        params["ring_bytes"] = json!(16);
        params["max_fps"] = json!(20);
    } else if op == "disk_start" {
        params["max_fps"] = json!(20);
        params["destination_capability_id"] = json!("cap");
        params["destination_path"] = json!("/exports/a.tar");
    }
    serde_json::from_value(json!({
        "schema":"record_request/v0.2", "request_id":"q", "op":op, "params":params
    }))
    .unwrap()
}

fn event(id: &str, fields: Value) -> RecordEvent {
    let mut value = json!({"schema":"record_event/v0.2", "request_id":"q",
        "surface_id":"s", "recording_id":id, "mono_ns":1});
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    serde_json::from_value(value).unwrap()
}

#[test]
fn release_all_restores_budget_and_tombstones_every_id() {
    let mut c = coordinator();
    for id in ["a", "b"] {
        assert!(matches!(
            c.handle(&request("ram_start", id), 0, &mut Sink).unwrap()[0],
            RecordEvent::Case0(_)
        ));
        c.handle(&request("ram_stop", id), 1, &mut Sink).unwrap();
    }
    assert!(matches!(
        c.handle(&request("ram_start", "fresh"), 2, &mut Sink)
            .unwrap()[0],
        RecordEvent::Case5(_)
    ));
    for id in ["a", "b"] {
        c.release(id).unwrap();
        assert!(c.recording(id).is_none());
        let refusal = c.handle(&request("ram_start", id), 3, &mut Sink).unwrap();
        assert!(
            matches!(&refusal[0], RecordEvent::Case5(r) if r.reason_code == metaviewer_core::wire::payload::RecordEventRefusal::POLICY)
        );
    }
    // Both slots are available: refused tombstone reuse must not burn a reservation.
    for id in ["fresh", "fresh2"] {
        assert!(matches!(
            c.handle(&request("ram_start", id), 4, &mut Sink).unwrap()[0],
            RecordEvent::Case0(_)
        ));
    }
}

#[test]
fn unknown_active_and_repeated_release_are_typed_and_atomic() {
    let mut c = coordinator();
    let before = c.clone();
    assert_eq!(c.release("unknown"), Err(Error::UnknownRecording));
    assert_eq!(c, before);
    c.handle(&request("ram_start", "a"), 0, &mut Sink).unwrap();
    let before = c.clone();
    assert_eq!(c.release("a"), Err(Error::ActiveRecording));
    assert_eq!(c, before);
    c.handle(&request("ram_stop", "a"), 1, &mut Sink).unwrap();
    c.release("a").unwrap();
    let before = c.clone();
    assert_eq!(c.release("a"), Err(Error::UnknownRecording));
    assert_eq!(c, before);
    assert_eq!(c.observe(event("a", json!({"event":"frame_captured", "ram_path":"/dev/shm/a.png", "sha256":"a".repeat(64), "byte_count":8})), &mut Sink), Err(Error::Event));
    assert_eq!(c, before);
}

#[test]
fn exported_capture_can_be_released_and_late_receipt_is_refused() {
    let mut c = coordinator();
    c.handle(&request("disk_start", "disk"), 0, &mut Sink)
        .unwrap();
    c.handle(&request("disk_stop", "disk"), 1, &mut Sink)
        .unwrap();
    let export = event(
        "disk",
        json!({"event":"exported", "destination_capability_id":"cap",
        "destination_path":"/exports/a.tar", "sha256":"b".repeat(64), "byte_count":1024}),
    );
    c.observe(export.clone(), &mut Sink).unwrap();
    c.release("disk").unwrap();
    assert!(c.recording("disk").is_none());
    let before = c.clone();
    assert_eq!(c.observe(export, &mut Sink), Err(Error::Event));
    assert_eq!(c, before);
}
