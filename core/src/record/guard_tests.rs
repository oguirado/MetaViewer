use super::*;

#[derive(Default)]
struct Sink(Vec<SessionRecord>);
impl JournalSink for Sink {
    fn append(&mut self, record: &SessionRecord, _: &[RecordEvent]) -> Result<(), Error> {
        self.0.push(record.clone());
        Ok(())
    }
}

fn coordinator() -> Coordinator {
    let settings = serde_json::from_value(json!({
        "schema":"settings/v0.2", "theme":"metaviewer-light", "providers":[],
        "recording_destination":{"capability_id":"cap","path":"/exports/a.tar"},
        "limits":{"memory_bytes":32,"ring_bytes":16,"max_fps":30}
    }))
    .unwrap();
    Coordinator::new(&settings, BTreeSet::from(["s".into()])).unwrap()
}

fn request(op: &str, id: &str, extra: Value) -> RecordRequest {
    let mut params = json!({"surface_id":"s"});
    params[if op == "screenshot" {
        "capture_id"
    } else {
        "recording_id"
    }] = json!(id);
    params
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(json!({"schema":"record_request/v0.2","request_id":"q",
        "op":op,"params":params}))
    .unwrap()
}

fn start(c: &mut Coordinator, sink: &mut Sink, id: &str) {
    let events = c
        .handle(
            &request("ram_start", id, json!({"ring_bytes":16,"max_fps":20})),
            0,
            sink,
        )
        .unwrap();
    assert!(matches!(events[0], RecordEvent::Case0(_)));
}

fn frame(id: &str, path: &str, sha: &str) -> RecordEvent {
    serde_json::from_value(json!({"schema":"record_event/v0.2","request_id":"f",
        "surface_id":"s","recording_id":id,"event":"frame_captured","mono_ns":1,
        "ram_path":path,"sha256":sha,"byte_count":8}))
    .unwrap()
}

fn export(bytes: u64, sha: &str) -> RecordEvent {
    serde_json::from_value(json!({"schema":"record_event/v0.2","request_id":"e",
        "surface_id":"s","recording_id":"r","event":"exported","mono_ns":2,
        "destination_capability_id":"cap","destination_path":"/exports/a.tar",
        "byte_count":bytes,"sha256":sha}))
    .unwrap()
}

fn sealed_disk() -> (Coordinator, Sink) {
    let mut c = coordinator();
    let mut sink = Sink::default();
    c.handle(
        &request(
            "disk_start",
            "r",
            json!({"max_fps":20,
        "destination_capability_id":"cap","destination_path":"/exports/a.tar"}),
        ),
        0,
        &mut sink,
    )
    .unwrap();
    c.observe(frame("r", "/dev/shm/frame.png", &"a".repeat(64)), &mut sink)
        .unwrap();
    c.handle(&request("disk_stop", "r", json!({})), 1, &mut sink)
        .unwrap();
    (c, sink)
}

fn assert_policy(events: &[RecordEvent], detail: &str) {
    assert!(
        matches!(&events[0], RecordEvent::Case5(r)
        if r.reason_code == RecordEventRefusal::POLICY && r.detail == detail),
        "{events:?}"
    );
}

#[test]
fn arg_1_delivered_and_released_screenshots_reclaim_reservations() {
    let mut c = coordinator();
    let mut sink = Sink::default();
    for id in ["s1", "s2", "s3"] {
        let events = c
            .handle(&request("screenshot", id, json!({})), 0, &mut sink)
            .unwrap();
        assert!(matches!(events[0], RecordEvent::Case0(_)), "{events:?}");
        c.observe(frame(id, "/dev/shm/frame.png", &"a".repeat(64)), &mut sink)
            .unwrap();
        assert_eq!(c.recording(id).unwrap().phase, Phase::Sealed);
        c.release(id).unwrap();
        assert!(c.recording(id).is_none());
    }
}

#[test]
fn arg_2_huge_ring_is_policy_without_overflow() {
    let mut c = coordinator();
    let mut sink = Sink::default();
    start(&mut c, &mut sink, "active");
    let events = c
        .handle(
            &request(
                "ram_start",
                "huge",
                json!({"ring_bytes":u64::MAX,"max_fps":20}),
            ),
            0,
            &mut sink,
        )
        .unwrap();
    assert_policy(&events, "recording bounds are invalid");
    assert!(c.recording("huge").is_none());
    assert_eq!(sink.0.last().unwrap().kind, SessionRecordKind::Refused);
}

#[test]
fn arg_2_unknown_surface_keeps_policy_under_pressure() {
    let mut c = coordinator();
    let mut sink = Sink::default();
    start(&mut c, &mut sink, "a");
    start(&mut c, &mut sink, "b");
    let events = c
        .handle(
            &request(
                "ram_start",
                "unknown",
                json!({"surface_id":"unknown",
        "ring_bytes":16,"max_fps":20}),
            ),
            0,
            &mut sink,
        )
        .unwrap();
    assert_policy(&events, "surface is not admitted");
    assert!(c.recording("unknown").is_none());
    assert_eq!(sink.0.last().unwrap().kind, SessionRecordKind::Refused);
}

#[test]
fn active_reservations_still_enforce_session_budget() {
    let mut c = coordinator();
    let mut sink = Sink::default();
    start(&mut c, &mut sink, "a");
    start(&mut c, &mut sink, "b");
    let events = c
        .handle(
            &request("ram_start", "c", json!({"ring_bytes":16,"max_fps":20})),
            0,
            &mut sink,
        )
        .unwrap();
    assert!(matches!(&events[0], RecordEvent::Case5(r)
        if r.reason_code == RecordEventRefusal::BUDGETEXCEEDED));
    c.handle(&request("ram_stop", "a", json!({})), 1, &mut sink)
        .unwrap();
    let events = c
        .handle(
            &request("ram_start", "c", json!({"ring_bytes":16,"max_fps":20})),
            2,
            &mut sink,
        )
        .unwrap();
    assert!(matches!(&events[0], RecordEvent::Case5(r)
        if r.reason_code == RecordEventRefusal::BUDGETEXCEEDED
        && r.detail.contains("a=16") && r.detail.contains("b=16")));
    c.release("a").unwrap();
    start(&mut c, &mut sink, "c");
}

fn reject_frame(path: &str, sha: &str) {
    let mut c = coordinator();
    let mut sink = Sink::default();
    start(&mut c, &mut sink, "r");
    let before = c.clone();
    let journal_len = sink.0.len();
    assert_eq!(
        c.observe(frame("r", path, sha), &mut sink),
        Err(Error::Event)
    );
    assert_eq!(c, before);
    assert_eq!(sink.0.len(), journal_len);
}

#[test]
fn arg_6_uppercase_frame_digest_is_rejected() {
    reject_frame("/dev/shm/frame.png", &"A".repeat(64));
}

#[test]
fn arg_6_directory_frame_paths_are_rejected() {
    reject_frame("/dev/shm/", &"a".repeat(64));
    reject_frame("/dev/shm/subdir/", &"a".repeat(64));
}

#[test]
fn absolute_non_shm_frame_path_is_atomic_and_shm_control_commits() {
    // Mutation: delete the !f.ram_path.starts_with("/dev/shm/") guard.
    reject_frame("/tmp/x.png", &"a".repeat(64));
    let mut c = coordinator();
    let mut sink = Sink::default();
    start(&mut c, &mut sink, "r");
    let before = c.clone();
    let journal_len = sink.0.len();
    c.observe(frame("r", "/dev/shm/x.png", &"a".repeat(64)), &mut sink)
        .unwrap();
    assert_ne!(c, before);
    assert_eq!(c.recording("r").unwrap().byte_count, 8);
    assert_eq!(sink.0.len(), journal_len + 1);
}

#[test]
fn arg_6_zero_byte_export_is_rejected() {
    let (mut c, mut sink) = sealed_disk();
    let before = c.clone();
    let journal_len = sink.0.len();
    assert_eq!(
        c.observe(export(0, &"b".repeat(64)), &mut sink),
        Err(Error::Event)
    );
    assert_eq!(c, before);
    assert_eq!(sink.0.len(), journal_len);
}

#[test]
fn arg_6_uppercase_export_digest_is_rejected() {
    let (mut c, mut sink) = sealed_disk();
    let before = c.clone();
    assert_eq!(
        c.observe(export(8, &"B".repeat(64)), &mut sink),
        Err(Error::Event)
    );
    assert_eq!(c, before);
}

#[test]
fn valid_export_retains_metadata_and_reservation_until_release() {
    let (mut c, mut sink) = sealed_disk();
    c.observe(export(8, &"b".repeat(64)), &mut sink).unwrap();
    assert_eq!(c.recording("r").unwrap().phase, Phase::Exported);
    assert_eq!(c.recording("r").unwrap().byte_count, 8);
    start(&mut c, &mut sink, "a");
    let events = c
        .handle(
            &request("ram_start", "b", json!({"ring_bytes":16,"max_fps":20})),
            3,
            &mut sink,
        )
        .unwrap();
    assert!(matches!(&events[0], RecordEvent::Case5(r)
        if r.reason_code == RecordEventRefusal::BUDGETEXCEEDED
        && r.detail.contains("r=16")));
    assert_eq!(c.recording("r").unwrap().byte_count, 8);
    c.release("r").unwrap();
    start(&mut c, &mut sink, "b");
}

#[test]
fn arg_1_unreleased_screenshots_hold_named_reservations() {
    let mut c = coordinator();
    let mut sink = Sink::default();
    for id in ["shot1", "shot2"] {
        let events = c
            .handle(&request("screenshot", id, json!({})), 0, &mut sink)
            .unwrap();
        assert!(matches!(events[0], RecordEvent::Case0(_)));
        c.observe(frame(id, "/dev/shm/frame.png", &"a".repeat(64)), &mut sink)
            .unwrap();
    }
    let events = c
        .handle(&request("screenshot", "shot3", json!({})), 1, &mut sink)
        .unwrap();
    assert!(matches!(&events[0], RecordEvent::Case5(r)
        if r.reason_code == RecordEventRefusal::BUDGETEXCEEDED
        && r.detail.contains("shot1=16") && r.detail.contains("shot2=16")));
    assert!(c.recording("shot3").is_none());
    c.release("shot1").unwrap();
    let events = c
        .handle(&request("screenshot", "shot3", json!({})), 2, &mut sink)
        .unwrap();
    assert!(matches!(events[0], RecordEvent::Case0(_)));
}
