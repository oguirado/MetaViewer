mod support;

use metaviewer_core::journal::sha256_hex;
use metaviewer_core::record::capture::Host;
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::wire::payload::FrameRef;
use metaviewer_core::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixStream;

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
fn b1_record_decimates_under_backward_clock_skew() {
    let mut host = Host::default();
    let surfaces = BTreeSet::from(["surface-demo".to_owned()]);
    let frame_with = |byte: u8, gen: u64| -> (FrameRef, Vec<u8>) {
        let bytes = vec![byte; 3];
        let mut value: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        value["surface_id"] = "surface-demo".into();
        value["generation"] = gen.into();
        value["sha256"] = sha256_hex(&bytes).into();
        (serde_json::from_value(value).unwrap(), bytes)
    };

    let (f0, b0) = frame_with(1, 1);
    host.frame(&f0, b0, 1000).unwrap();

    // Start at max_fps=3 (period = 333 ms) at t=1000 ms; initial frame at t=1000 is kept.
    let (mut host, start_reply, _) = host
        .prepare(
            "recordStart",
            &json!({
                "schema": "capture_request/v1",
                "request_id": "req-skew",
                "surface_id": "surface-demo",
                "mode": "ai",
                "max_fps": 3
            }),
            surfaces.clone(),
            1000,
        )
        .unwrap();
    assert_eq!(start_reply["ok"], true);
    let rec_id = start_reply["recording_id"].as_str().unwrap().to_owned();

    // Backward clock skew at t=500 ms (< last_ms=1000 ms) must saturate delta to 0 and drop.
    let (f_skew, b_skew) = frame_with(2, 2);
    let skew_events = host.frame(&f_skew, b_skew, 500).unwrap();
    assert!(
        skew_events.is_empty(),
        "frame at t=500 ms after last_ms=1000 ms must be decimated"
    );

    let (_, stop_reply, _) = host
        .prepare(
            "recordStop",
            &json!({
                "request_id": "stop-skew",
                "recording_id": rec_id
            }),
            surfaces,
            1200,
        )
        .unwrap();
    assert_eq!(stop_reply["ok"], true);
    assert_eq!(stop_reply["recording"]["frames"], 1);
    assert_eq!(stop_reply["recording"]["dropped_frames"], 1);
    assert_eq!(stop_reply["recording"]["sha256"], sha256_hex(&[1_u8; 3]));
}

#[test]
fn b2_serve_wire_ram_start_61_to_120_vs_disk_start_refusal_shape() {
    // Negative controls at Host/Coordinator and wire schema boundaries: 0 and 121 -> POLICY / invalid.
    let mut host = Host::default();
    let surfaces = BTreeSet::from(["surface-demo".to_owned()]);
    let mut f_val: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    f_val["surface_id"] = "surface-demo".into();
    f_val["sha256"] = sha256_hex(b"rgb").into();
    let f_ref: FrameRef = serde_json::from_value(f_val).unwrap();
    host.frame(&f_ref, b"rgb".to_vec(), 0).unwrap();
    for bad_fps in [0_u64, 121] {
        let (_, reply, events) = host
            .prepare(
                "recordStart",
                &json!({
                    "schema": "capture_request/v1",
                    "request_id": format!("req-{bad_fps}"),
                    "surface_id": "surface-demo",
                    "mode": "ai",
                    "max_fps": bad_fps
                }),
                surfaces.clone(),
                0,
            )
            .unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["code"], "POLICY");
        assert_eq!(events[0]["events"][0]["reason_code"], "POLICY");
    }

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
        surface["surface_id"] = "surface-demo".into();
        daemon
            .send(json!({"schema": "surface_event/v0.2", "event": "created", "data": {"surface": surface}}))
            .await;
        let _ = ui.receive().await;

        let shm = SharedFrame::new(1);
        daemon.send(shm.value(1, 1)).await;
        let _ = ui.receive().await;

        // Negative control on the wire: unsupported ring_bytes yields POLICY action_verdict.
        ui.send(json!({
            "schema": "record_request/v0.2",
            "request_id": "wire-bad-ring",
            "op": "ram_start",
            "params": {
                "surface_id": "surface-demo",
                "recording_id": "rec-bad-ring",
                "ring_bytes": 4096,
                "max_fps": 3
            }
        }))
        .await;
        let bad_ring_verdict = ui
            .receive_until(|m| m["schema"] == "action_verdict/v0.2")
            .await;
        assert_eq!(bad_ring_verdict["decision"], "refused");
        assert_eq!(bad_ring_verdict["reason_code"], "POLICY");

        // ram_start with max_fps=61 passes the 1..=120 wire gate and yields CAPTURE_REPLY BUDGET_EXCEEDED.
        ui.send(json!({
            "schema": "record_request/v0.2",
            "request_id": "ram-61",
            "op": "ram_start",
            "params": {
                "surface_id": "surface-demo",
                "recording_id": "rec-ram-61",
                "ring_bytes": 8_388_608,
                "max_fps": 61
            }
        }))
        .await;
        let first_ram_61 = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(
            first_ram_61["data"]["code"], "CAPTURE_REPLY",
            "ram_start max_fps=61 must yield CAPTURE_REPLY, got: {first_ram_61}"
        );
        let detail: Value =
            serde_json::from_str(first_ram_61["data"]["detail"].as_str().unwrap()).unwrap();
        assert_eq!(detail["method"], "recordStart");
        assert_eq!(detail["reply"]["ok"], false);
        assert_eq!(detail["reply"]["code"], "BUDGET_EXCEEDED");
        let refused_ev = ui
            .receive_until(|v| v["schema"] == "record_event/v0.2")
            .await;
        assert_eq!(refused_ev["event"], "refused");
        assert_eq!(refused_ev["reason_code"], "BUDGET_EXCEEDED");

        // disk_start with max_fps=61 is refused directly by disk_start gate with BUDGET_EXCEEDED verdict, no CAPTURE_REPLY.
        ui.send(json!({
            "schema": "record_request/v0.2",
            "request_id": "disk-61",
            "op": "disk_start",
            "params": {
                "surface_id": "surface-demo",
                "recording_id": "rec-disk-61",
                "destination_capability_id": "recording:configured",
                "destination_path": "/tmp",
                "max_fps": 61
            }
        }))
        .await;
        let disk_61_reply = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(
            disk_61_reply["schema"], "action_verdict/v0.2",
            "disk_start max_fps=61 must return action_verdict, not CAPTURE_REPLY: {disk_61_reply}"
        );
        assert_eq!(disk_61_reply["proposal_id"], "disk-61");
        assert_eq!(disk_61_reply["decision"], "refused");
        assert_eq!(disk_61_reply["reason_code"], "BUDGET_EXCEEDED");

        drop((daemon, ui));
        task.abort();
        let _ = task.await;
    });
}

#[test]
fn b3_serve_ns_to_ms_decimation_clock() {
    support::run(async {
        static NEXT_DIR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let shm_dir = std::path::PathBuf::from(format!(
            "/dev/shm/mv-mut-rec-b3-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&shm_dir).unwrap();
        struct ShmDir(std::path::PathBuf);
        impl Drop for ShmDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let temp = ShmDir(shm_dir);
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
        surface["surface_id"] = "surface-demo".into();
        daemon
            .send(json!({"schema": "surface_event/v0.2", "event": "created", "data": {"surface": surface}}))
            .await;
        let _ = ui.receive().await;

        let shm1 = SharedFrame::new(1);
        let shm2 = SharedFrame::new(2);
        let shm3 = SharedFrame::new(3);

        // Initial frame before ram_start; wait out the 50 ms frame group-commit window
        // so ram_start does not block waiting to flush shm1's batch.
        daemon.send(shm1.value(1, 1)).await;
        let _ = ui.receive().await;
        tokio::time::sleep(Duration::from_millis(60)).await;

        ui.send(json!({
            "schema": "record_request/v0.2",
            "request_id": "start-30fps",
            "op": "ram_start",
            "params": {
                "surface_id": "surface-demo",
                "recording_id": "rec-30fps",
                "ring_bytes": 8_388_608,
                "max_fps": 30
            }
        }))
        .await;
        let start_carrier = ui
            .receive_until(|v| v["data"]["code"] == "CAPTURE_REPLY")
            .await;
        let start_detail: Value =
            serde_json::from_str(start_carrier["data"]["detail"].as_str().unwrap()).unwrap();
        assert_eq!(start_detail["reply"]["ok"], true);
        let _ = ui
            .receive_until(|v| v["schema"] == "record_event/v0.2" && v["event"] == "frame_captured")
            .await;

        // Send frame 2 (>= 33 ms after ram_start, kept) and frame 3 back-to-back in the same
        // daemon batch (~12 ms after frame 2, < 33 ms period for 30 fps -> decimated).
        // Mutant `now_ns / 1_000` inflates the ~12 ms delta to ~12_000 ms and keeps both.
        tokio::time::sleep(Duration::from_millis(40)).await;
        daemon.send(shm2.value(2, 2)).await;
        daemon.send(shm3.value(3, 3)).await;
        let _ = ui
            .receive_until(|v| v["schema"] == "frame_ref/v0.2" && v["generation"] == 3)
            .await;

        ui.send(json!({
            "schema": "record_request/v0.2",
            "request_id": "stop-30fps",
            "op": "ram_stop",
            "params": {
                "surface_id": "surface-demo",
                "recording_id": "rec-30fps"
            }
        }))
        .await;
        let stop_carrier = ui
            .receive_until(|v| v["data"]["code"] == "CAPTURE_REPLY")
            .await;
        let stop_detail: Value =
            serde_json::from_str(stop_carrier["data"]["detail"].as_str().unwrap()).unwrap();
        assert_eq!(stop_detail["reply"]["ok"], true);
        assert_eq!(
            stop_detail["reply"]["recording"]["frames"], 2,
            "stop_detail: {stop_detail}"
        );
        assert_eq!(
            stop_detail["reply"]["recording"]["dropped_frames"], 1,
            "stop_detail: {stop_detail}"
        );

        drop((daemon, ui));
        task.abort();
        let _ = task.await;
    });
}
