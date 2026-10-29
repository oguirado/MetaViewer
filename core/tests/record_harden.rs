mod support;

use metaviewer_core::journal::sha256_hex;
use metaviewer_core::record::{capture::Host, Coordinator, Error, JournalSink, Phase};
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::wire::payload::{FrameRef, RecordEvent, RecordRequest, SessionRecord};
use metaviewer_core::{decode_envelope, read_frame, write_frame, Command, Envelope};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixStream;

fn surfaces() -> BTreeSet<String> {
    BTreeSet::from(["surface-demo".into()])
}
fn frame() -> FrameRef {
    let mut raw: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    raw["width"] = json!(1);
    raw["height"] = json!(1);
    raw["sha256"] = json!(sha256_hex(b"rgb"));
    serde_json::from_value(raw).unwrap()
}
fn host() -> Host {
    let mut host = Host::default();
    host.frame(&frame(), b"rgb".to_vec(), 0).unwrap();
    host
}
fn start(fps: Value) -> Value {
    json!({"request_id":"start","surface_id":"surface-demo","max_fps":fps})
}

#[test]
#[ignore = "FINDING A: operator decision, see conductor notes"]
fn a_host_default_fps_decimates_and_counts_drops() {
    // Named mutation: drop admitted/default-fps persistence in the decimation map.
    let (mut host, reply, _) = host()
        .prepare("recordStart", &start(json!(3)), surfaces(), 0)
        .unwrap();
    for t in [1, 100, 332] {
        assert!(host.frame(&frame(), b"rgb".to_vec(), t).unwrap().is_empty());
    }
    assert!(!host
        .frame(&frame(), b"rgb".to_vec(), 333)
        .unwrap()
        .is_empty());
    let (_, stopped, _) = host
        .prepare(
            "recordStop",
            &json!({"request_id":"stop","recording_id":reply["recording_id"]}),
            surfaces(),
            334,
        )
        .unwrap();
    assert_eq!(stopped["recording"]["frames"], 2);
    assert_eq!(stopped["recording"]["dropped_frames"], 3);
    assert_eq!(stopped["recording"]["sha256"], sha256_hex(b"rgbrgb"));
}

#[test]
#[ignore = "FINDING D1: operator decision, see conductor notes"]
fn d1_missing_and_non_integer_fps_are_refused_atomically() {
    // Named mutation: restore as_u64().unwrap_or(DEFAULT_FPS).
    let host = host();
    for fps in [
        None,
        Some(Value::Null),
        Some(json!("3")),
        Some(json!(3.5)),
        Some(json!(-1)),
        Some(json!(true)),
    ] {
        let mut request = start(Value::Null);
        match fps {
            Some(fps) => request["max_fps"] = fps,
            None => {
                request.as_object_mut().unwrap().remove("max_fps");
            }
        }
        let before = host.clone();
        assert_eq!(
            host.prepare("recordStart", &request, surfaces(), 0),
            Err(Error::Event)
        );
        assert_eq!(host, before);
    }
    assert_eq!(
        host.prepare("recordStart", &start(json!(3)), surfaces(), 0)
            .unwrap()
            .1["ok"],
        true
    );
}

#[test]
#[ignore = "FINDING D2: operator decision, see conductor notes"]
fn d2_recording_ceiling_matches_frozen_contract() {
    // Named mutation: lower Host MAX_FPS back to 60.
    for fps in [1, 60, 61, 120] {
        assert_eq!(
            host()
                .prepare("recordStart", &start(json!(fps)), surfaces(), 0)
                .unwrap()
                .1["ok"],
            true,
            "fps={fps}"
        );
    }
    for fps in [0, 121] {
        assert_eq!(
            host()
                .prepare("recordStart", &start(json!(fps)), surfaces(), 0)
                .unwrap()
                .1["code"],
            "POLICY"
        );
    }
}

#[derive(Default)]
struct Sink(Vec<Value>);
impl JournalSink for Sink {
    fn append(&mut self, record: &SessionRecord, events: &[RecordEvent]) -> Result<(), Error> {
        self.0.push(json!({"record":record,"events":events}));
        Ok(())
    }
}
#[test]
fn c_receipts_use_archive_cap_and_preserve_state_on_rejection() {
    // Named mutation: raise export receipt cap back to the session cap.
    let settings = serde_json::from_value(
        json!({"schema":"settings/v0.2","theme":"metaviewer-dark","providers":[],
        "recording_destination":{"capability_id":"cap","path":"/exports/a.tar"},
        "limits":{"memory_bytes":32,"ring_bytes":16,"max_fps":120}}),
    )
    .unwrap();
    let mut core = Coordinator::new(&settings, surfaces()).unwrap();
    let mut sink = Sink::default();
    for op in ["disk_start", "disk_stop"] {
        let mut params = json!({"surface_id":"surface-demo","recording_id":"r"});
        if op == "disk_start" {
            params["destination_capability_id"] = json!("cap");
            params["destination_path"] = json!("/exports/a.tar");
            params["max_fps"] = json!(3);
        }
        let req: RecordRequest = serde_json::from_value(
            json!({"schema":"record_request/v0.2","request_id":op,"op":op,"params":params}),
        )
        .unwrap();
        core.handle(&req, 0, &mut sink).unwrap();
    }
    let receipt = |bytes| {
        serde_json::from_value(json!({"schema":"record_event/v0.2","request_id":"e","surface_id":"surface-demo","recording_id":"r","event":"exported","mono_ns":1,"destination_capability_id":"cap","destination_path":"/exports/a.tar","byte_count":bytes,"sha256":"a".repeat(64)})).unwrap()
    };
    let before = core.clone();
    let journal = sink.0.clone();
    assert_eq!(
        core.observe(receipt(16 * 1024 * 1024 + 1), &mut sink),
        Err(Error::Event)
    );
    assert_eq!(core, before);
    assert_eq!(sink.0, journal);
    // Exact-boundary and small receipts are positive controls with the same grant.
    let mut boundary = core.clone();
    boundary
        .observe(receipt(16 * 1024 * 1024), &mut Sink::default())
        .unwrap();
    core.observe(receipt(1024), &mut sink).unwrap();
    assert_eq!(core.recording("r").unwrap().phase, Phase::Exported);
    assert_eq!(sink.0.len(), journal.len() + 1);
}

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({
        "endpoint": {"component": component, "instance": format!("{component}-mut-rec")},
        "hello": {
            "schema": "hello/v0.2",
            "contract_version": "v0.2",
            "component": component,
            "component_version": "0.2.0",
            "component_commit": "0123456789abcdef0123456789abcdef01234567",
            "dependencies": []
        }
    }))
    .unwrap()
}

fn config() -> Config {
    Config {
        session_id: "mut-rec-session".into(),
        core: registration("core"),
        peers: vec![
            registration("daemon"),
            registration("agent"),
            registration("ui"),
        ],
    }
}

struct Peer {
    socket: UnixStream,
    config: Config,
    registration: Registration,
    seq: u64,
}

impl Peer {
    async fn connect(path: &std::path::Path, component: &str) -> Self {
        let mut p = Self {
            socket: UnixStream::connect(path).await.unwrap(),
            config: config(),
            registration: registration(component),
            seq: 0,
        };
        p.send(serde_json::to_value(&p.registration.hello).unwrap())
            .await;
        let hello = p.receive().await;
        assert!(matches!(hello.body, Command::Hello(_)));
        p
    }

    async fn send(&mut self, body: Value) {
        self.seq += 1;
        let env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": format!("{}-{}", self.registration.endpoint.instance, self.seq),
                "ts_ns": 0,
                "from": self.registration.endpoint,
                "to": self.config.core.endpoint,
                "session_id": self.config.session_id,
                "seq": self.seq,
                "nonce": format!("{}-{}", self.registration.endpoint.instance, self.seq),
                "body": body
            })
            .to_string(),
        )
        .unwrap();
        write_frame(&mut self.socket, &env).await.unwrap();
    }

    async fn receive(&mut self) -> Envelope {
        tokio::time::timeout(Duration::from_secs(3), read_frame(&mut self.socket))
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    }

    async fn receive_until<F>(&mut self, mut pred: F) -> Value
    where
        F: FnMut(&Value) -> bool,
    {
        loop {
            let env = self.receive().await;
            let val = serde_json::to_value(env.body).unwrap();
            if pred(&val) {
                return val;
            }
        }
    }
}

struct SharedFrame(std::path::PathBuf);

impl SharedFrame {
    const WIDTH: u64 = 4;
    const HEIGHT: u64 = 4;
    const BYTES: usize = (Self::WIDTH as usize) * (Self::HEIGHT as usize) * 3;

    fn new(fill: u8) -> Self {
        use std::os::unix::fs::OpenOptionsExt;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::path::PathBuf::from(format!(
            "/dev/shm/mv-mut-rec-{}-{}-frame",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut file, &[fill; Self::BYTES]).unwrap();
        Self(path)
    }

    fn value(&self, generation: u64, fill: u8) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        value["surface_id"] = "surface-demo".into();
        value["width"] = Self::WIDTH.into();
        value["height"] = Self::HEIGHT.into();
        value["sha256"] = sha256_hex(&[fill; Self::BYTES]).into();
        value["ramws_path"] = self.0.to_str().unwrap().into();
        value["generation"] = generation.into();
        value
    }
}

impl Drop for SharedFrame {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[test]
fn b_sealed_export_above_ui_sampling_ceiling_reaches_export_handler() {
    // Named mutation: restore the export carrier sampling-ceiling refusal at 60.
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server, uid));
        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut ui = Peer::connect(&socket, "ui").await;
        let mut surface: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        surface["surface_id"] = json!("surface-demo");
        daemon
            .send(
                json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface}}),
            )
            .await;
        ui.receive().await;
        let shm = SharedFrame::new(1);
        daemon.send(shm.value(1, 1)).await;
        ui.receive().await;
        ui.send(json!({"schema":"record_request/v0.2","request_id":"shot","op":"screenshot","params":{"surface_id":"surface-demo","capture_id":"sealed"}})).await;
        let shot = ui
            .receive_until(|m| m["data"]["code"] == "CAPTURE_REPLY")
            .await;
        let detail: Value = serde_json::from_str(shot["data"]["detail"].as_str().unwrap()).unwrap();
        assert_eq!(detail["reply"]["ok"], true);
        for fps in [3, 61, 120] {
            ui.send(json!({"schema":"record_request/v0.2","request_id":format!("export-{fps}"),"op":"disk_start","params":{"surface_id":"surface-demo","recording_id":"sealed","destination_capability_id":"ungranted","destination_path":"/exports","max_fps":fps}})).await;
            let reply = ui
                .receive_until(|m| {
                    m["data"]["code"] == "CAPTURE_REPLY" || m["schema"] == "action_verdict/v0.2"
                })
                .await;
            assert_eq!(reply["data"]["code"], "CAPTURE_REPLY", "{reply}");
            let detail: Value =
                serde_json::from_str(reply["data"]["detail"].as_str().unwrap()).unwrap();
            assert_eq!(detail["method"], "export");
            assert_eq!(detail["reply"]["code"], "DESTINATION_UNSET");
        }
        task.abort();
        let _ = task.await;
    });
}
