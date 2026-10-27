use super::*;

#[derive(Default)]
struct Sink {
    records: Vec<SessionRecord>,
    events: Vec<RecordEvent>,
    fail: bool,
}
impl JournalSink for Sink {
    fn append(&mut self, record: &SessionRecord, events: &[RecordEvent]) -> Result<(), Error> {
        if self.fail {
            return Err(Error::Journal);
        }
        self.records.push(record.clone());
        self.events.extend_from_slice(events);
        Ok(())
    }
}
fn settings(destination: Value) -> Settings {
    serde_json::from_value(json!({"schema":"settings/v0.2","theme":"metaviewer-light","providers":[],
        "recording_destination":destination,"limits":{"memory_bytes":32,"max_fps":30,"ring_bytes":16}})).unwrap()
}
fn core(destination: Value) -> Coordinator {
    Coordinator::new(&settings(destination), BTreeSet::from(["s".to_owned()])).unwrap()
}
fn request(op: &str, extra: Value) -> RecordRequest {
    let mut params = json!({"surface_id":"s", "recording_id":"r"});
    params
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(
        json!({"schema":"record_request/v0.2","request_id":"q","op":op,"params":params}),
    )
    .unwrap()
}
fn start() -> RecordRequest {
    request("ram_start", json!({"ring_bytes":16,"max_fps":20}))
}
fn frame(bytes: u64) -> RecordEvent {
    serde_json::from_value(json!({"schema":"record_event/v0.2","request_id":"f","surface_id":"s","recording_id":"r",
        "event":"frame_captured","mono_ns":1,"ram_path":"/dev/shm/frame.png","sha256":"a".repeat(64),"byte_count":bytes})).unwrap()
}
#[test]
fn destination_refusals_are_journalled_without_authority_mutation() {
    for destination in [
        Value::Null,
        json!({"capability_id":"other","path":"/exports/a.tar"}),
        json!({"capability_id":"cap","path":"/exports/other.tar"}),
    ] {
        let mut c = core(destination);
        let mut sink = Sink::default();
        let events = c.handle(&request("disk_start",json!({"destination_capability_id":"cap","destination_path":"/exports/a.tar","max_fps":20})),0,&mut sink).unwrap();
        assert!(
            matches!(&events[0], RecordEvent::Case5(r) if r.reason_code == RecordEventRefusal::POLICY)
        );
        assert!(c.recordings.is_empty());
        assert_eq!(sink.records[0].kind, SessionRecordKind::Refused);
        assert_eq!(sink.records[0].prev_sha256, "0".repeat(64));
    }
}
#[test]
fn ram_lifecycle_evicts_and_rejects_reuse_unknown_stops() {
    let mut c = core(Value::Null);
    let mut sink = Sink::default();
    assert!(matches!(
        c.handle(&start(), 0, &mut sink).unwrap()[0],
        RecordEvent::Case0(_)
    ));
    c.observe(frame(10), &mut sink).unwrap();
    let events = c.observe(frame(9), &mut sink).unwrap();
    assert!(matches!(&events[0],RecordEvent::Case4(d) if d.dropped_frames == 1));
    let before = c.clone();
    assert!(c.observe(frame(17), &mut sink).is_err());
    assert_eq!(c, before);
    let events = c
        .handle(&request("ram_stop", json!({})), 2, &mut sink)
        .unwrap();
    assert!(matches!(&events[0],RecordEvent::Case1(s) if s.frame_count == 1 && s.byte_count == 9));
    assert!(matches!(
        c.handle(&request("ram_stop", json!({})), 3, &mut sink)
            .unwrap()[0],
        RecordEvent::Case5(_)
    ));
    assert!(matches!(
        c.handle(&start(), 4, &mut sink).unwrap()[0],
        RecordEvent::Case5(_)
    ));
    let expected =
        sha256_hex(&canonical_bytes(&serde_json::to_value(&sink.records[0]).unwrap()).unwrap());
    assert_eq!(sink.records[1].prev_sha256, expected);
}
#[test]
fn configured_disk_export_requires_seal_and_exact_grant() {
    let mut c = core(json!({"capability_id":"cap","path":"/exports/a.tar"}));
    let mut sink = Sink::default();
    let req = request(
        "disk_start",
        json!({"destination_capability_id":"cap","destination_path":"/exports/a.tar","max_fps":20}),
    );
    assert!(matches!(
        c.handle(&req, 0, &mut sink).unwrap()[0],
        RecordEvent::Case0(_)
    ));
    let export: RecordEvent = serde_json::from_value(json!({"schema":"record_event/v0.2","request_id":"q","surface_id":"s","recording_id":"r","event":"exported","mono_ns":2,"destination_capability_id":"cap","destination_path":"/exports/a.tar","byte_count":1024,"sha256":"b".repeat(64)})).unwrap();
    assert!(c.observe(export.clone(), &mut sink).is_err());
    c.handle(&request("disk_stop", json!({})), 1, &mut sink)
        .unwrap();
    c.observe(export.clone(), &mut sink).unwrap();
    assert!(c.observe(export.clone(), &mut sink).is_err());
    let RecordEvent::Case3(mut bad) = export else {
        panic!()
    };
    bad.destination_path = "/exports/other.tar".into();
    c.recordings.get_mut("r").unwrap().phase = Phase::Sealed;
    assert!(c.observe(RecordEvent::Case3(bad), &mut sink).is_err());
}
#[test]
fn screenshot_seals_once_and_invalid_metadata_is_atomic() {
    let mut c = core(Value::Null);
    let mut sink = Sink::default();
    let req = serde_json::from_value(json!({"schema":"record_request/v0.2","request_id":"q","op":"screenshot","params":{"surface_id":"s","capture_id":"r"}})).unwrap();
    c.handle(&req, 0, &mut sink).unwrap();
    let RecordEvent::Case2(mut f) = frame(8) else {
        panic!()
    };
    f.ram_path = "/dev/shm/../disk".into();
    let before = c.clone();
    assert!(c.observe(RecordEvent::Case2(f), &mut sink).is_err());
    assert_eq!(before, c);
    let events = c.observe(frame(8), &mut sink).unwrap();
    assert!(matches!(&events[1],RecordEvent::Case1(s) if s.frame_count == 1));
    assert!(c.observe(frame(8), &mut sink).is_err());
}
#[test]
fn bounds_unknown_surfaces_and_sink_failure_never_commit() {
    let mut c = core(Value::Null);
    let mut sink = Sink::default();
    for extra in [
        json!({"ring_bytes":0,"max_fps":1}),
        json!({"ring_bytes":(1_u64<<30)+1,"max_fps":1}),
        json!({"ring_bytes":1,"max_fps":0}),
        json!({"ring_bytes":1,"max_fps":121}),
        json!({"ring_bytes":17,"max_fps":1}),
        json!({"ring_bytes":1,"max_fps":31}),
        json!({"ring_bytes":1,"max_fps":1,"surface_id":"unknown"}),
    ] {
        assert!(matches!(
            c.handle(&request("ram_start", extra), 0, &mut sink)
                .unwrap()[0],
            RecordEvent::Case5(_)
        ));
        assert!(c.recordings.is_empty());
    }
    let before = c.clone();
    sink.fail = true;
    assert_eq!(c.handle(&start(), 0, &mut sink), Err(Error::Journal));
    assert_eq!(before, c);
    let mut bad = settings(Value::Null);
    bad.limits.ring_bytes = 0;
    assert_eq!(
        Coordinator::new(&bad, BTreeSet::new()),
        Err(Error::Configuration)
    );
}
