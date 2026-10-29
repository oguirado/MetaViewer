#![forbid(unsafe_code)]
mod support;

use metaviewer_core::journal::sha256_hex;
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({
        "endpoint": {"component": component, "instance": format!("{component}-test")},
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
        session_id: "holdings-settle-session".into(),
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
        static NEXT_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        self.seq += 1;
        let nonce_id = NEXT_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": format!("{}-{}-{}", self.registration.endpoint.instance, self.seq, nonce_id),
                "ts_ns": 0,
                "from": self.registration.endpoint,
                "to": self.config.core.endpoint,
                "session_id": self.config.session_id,
                "seq": self.seq,
                "nonce": format!("{}-{}-{}", self.registration.endpoint.instance, self.seq, nonce_id),
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

    async fn receive_json(&mut self) -> Value {
        serde_json::to_value(self.receive().await.body).unwrap()
    }
}

struct SharedFrame {
    path: std::path::PathBuf,
    sha256: String,
}

impl SharedFrame {
    const WIDTH: u64 = 100;
    const HEIGHT: u64 = 60;
    const BYTES: usize = (Self::WIDTH as usize) * (Self::HEIGHT as usize) * 3;

    fn new(fill: u8) -> Self {
        use std::os::unix::fs::OpenOptionsExt;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::path::PathBuf::from(format!(
            "/dev/shm/mv-holdings-mut-{}-{}-frame",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let bytes = vec![fill; Self::BYTES];
        let sha256 = sha256_hex(&bytes);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut file, &bytes).unwrap();
        Self { path, sha256 }
    }

    fn value(&self, surface_id: &str, generation: u64, ts_ns: u64) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        value["surface_id"] = surface_id.into();
        value["width"] = Self::WIDTH.into();
        value["height"] = Self::HEIGHT.into();
        value["sha256"] = self.sha256.clone().into();
        value["ramws_path"] = self.path.to_str().unwrap().into();
        value["generation"] = generation.into();
        value["tick"] = 0.into();
        value["ts_ns"] = ts_ns.into();
        value
    }

    fn sidecar_path(&self) -> std::path::PathBuf {
        let parent = self.path.parent().unwrap();
        let name = self.path.file_name().unwrap().to_str().unwrap();
        parent.join(format!(".state-{name}"))
    }

    fn write_state(&self, raw: &[u8]) {
        use std::os::unix::fs::OpenOptionsExt;
        let path = self.sidecar_path();
        let _ = std::fs::remove_file(&path);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut file, raw).unwrap();
    }
}

impl Drop for SharedFrame {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.sidecar_path());
    }
}

fn holdings_surface(surface_id: &str) -> Value {
    let mut s: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap();
    s["surface_id"] = surface_id.into();
    s["kind"] = "game_capsule".into();
    s["control"] = "agent".into();
    s["profile_id"] = "holdings-v0.2".into();
    s
}

fn state_change_proposal(
    proposal_id: &str,
    surface_id: &str,
    based_on_frame: &Value,
    before_state_sha256: &str,
    min_tick: u64,
    max_tick: u64,
) -> Value {
    json!({
        "schema": "action_proposal/v0.2",
        "proposal_id": proposal_id,
        "surface_id": surface_id,
        "based_on_frame": {
            "generation": based_on_frame["generation"],
            "sha256": based_on_frame["sha256"]
        },
        "action": {
            "type": "click",
            "x": 20,
            "y": 20,
            "button": "left"
        },
        "expectation": {
            "type": "state_sha256_change",
            "before": before_state_sha256,
            "min_tick": min_tick,
            "max_tick": max_tick
        },
        "budget": {
            "max_ms": 500,
            "max_retries": 0
        }
    })
}

fn holdings_observation(frame_ref: &Value, state_sha256: &str, tick: u64) -> Value {
    json!({
        "schema": "observation/v0.2",
        "frame_ref": frame_ref,
        "ground_truth": {
            "source": "holdings_lane",
            "state_sha256": state_sha256,
            "tick": tick
        }
    })
}

fn daemon_receipt(proposal_id: &str, after_frame: &Value) -> Value {
    json!({
        "schema": "action_receipt/v0.2",
        "proposal_id": proposal_id,
        "executed_at_ns": 2_000,
        "after_frame": after_frame,
        "verified": false,
        "verification": {
            "method": "pixel",
            "detail": "post-input capture only; expectation verification belongs to core"
        },
        "error": ""
    })
}

// [TARGET, unit decision] Reuse the public wire fixture shape; each control
// starts with a dispatched proposal and real canonical sidecars, not mock witnesses.
struct Harness {
    temp: support::Temp,
    socket: std::path::PathBuf,
    server: Option<Arc<Mutex<Server>>>,
    task: tokio::task::JoinHandle<serve::Result<()>>,
    daemon: Peer,
    agent: Peer,
    ui: Peer,
    _before_file: SharedFrame,
    after_file: SharedFrame,
    before: Value,
    after: Value,
    before_digest: String,
    after_digest: String,
}

impl Harness {
    async fn new(after_tick: u64, expected_before: Option<&str>) -> Self {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        let daemon = Peer::connect(&socket, "daemon").await;
        let agent = Peer::connect(&socket, "agent").await;
        let ui = Peer::connect(&socket, "ui").await;
        let before_file = SharedFrame::new(b'a');
        let after_file = SharedFrame::new(b'b');
        let mut before = before_file.value("surface-holdings", 1, 1_000);
        before["tick"] = 5.into();
        let mut after = after_file.value("surface-holdings", 2, 2_500);
        after["tick"] = after_tick.into();
        let before_raw = br#"{"meta":{"tick":5},"nodes":{"level":1}}"#;
        let after_raw = format!("{{\"meta\":{{\"tick\":{after_tick}}},\"nodes\":{{\"level\":2}}}}");
        before_file.write_state(before_raw);
        after_file.write_state(after_raw.as_bytes());
        let before_digest = sha256_hex(before_raw);
        let after_digest = sha256_hex(after_raw.as_bytes());
        let mut h = Self {
            temp,
            socket,
            server: Some(server),
            task,
            daemon,
            agent,
            ui,
            _before_file: before_file,
            after_file,
            before,
            after,
            before_digest,
            after_digest,
        };
        h.daemon.send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":holdings_surface("surface-holdings")}})).await;
        h.ui.receive().await;
        h.frame(h.before.clone()).await;
        let expected = expected_before.unwrap_or(&h.before_digest).to_owned();
        h.propose("p1", &expected).await;
        h
    }

    async fn propose(&mut self, id: &str, expected: &str) {
        let proposal = state_change_proposal(id, "surface-holdings", &self.before, expected, 1, 10);
        self.agent.send(json!({"schema":"mv_tool_call/v0.2","request_id":format!("propose-{id}"),"op":"propose","args":{"proposal":proposal}})).await;
        assert_eq!(self.agent.receive_json().await["status"], "admitted");
        assert_eq!(self.daemon.receive_json().await["op"], "input");
    }

    async fn frame(&mut self, frame: Value) {
        self.daemon.send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":frame}})).await;
        self.ui.receive().await;
    }

    async fn before_observation(&mut self) {
        self.daemon
            .send(holdings_observation(&self.before, &self.before_digest, 5))
            .await;
    }

    async fn after_observation(&mut self) {
        self.daemon
            .send(holdings_observation(
                &self.after,
                &self.after_digest,
                self.after["tick"].as_u64().unwrap(),
            ))
            .await;
    }

    async fn refusal(&mut self) {
        let refusal = self.daemon.receive_json().await;
        assert_eq!(refusal["decision"], "refused", "{refusal}");
        assert_eq!(refusal["reason_code"], "POLICY", "{refusal}");
    }

    async fn settle(&mut self, id: &str, detail: &str, verified: bool) {
        let mut receipt = daemon_receipt(id, &self.after);
        receipt["native_evidence"] =
            json!({"surface_id":"surface-holdings","input_mono_ns":2100,"input_ts_ns":1800});
        self.daemon.send(receipt).await;
        let settled = self.agent.receive_json().await;
        assert_eq!(settled["schema"], "action_receipt/v0.2", "{settled}");
        assert_eq!(settled["verified"], verified, "{settled}");
        assert_eq!(settled["verification"]["detail"], detail, "{settled}");
        let waited = self.wait(id).await;
        if verified {
            assert_eq!(waited["status"], "verified", "{waited}");
            assert_eq!(waited["receipt"]["verified"], true, "{waited}");
            assert_eq!(
                waited["receipt"]["verification"]["detail"], detail,
                "{waited}"
            );
        } else {
            assert_eq!(waited["code"], "VERIFICATION_FAILED", "{waited}");
            assert_eq!(waited["detail"], detail, "{waited}");
        }
    }

    async fn wait(&mut self, id: &str) -> Value {
        self.agent.send(json!({"schema":"mv_tool_call/v0.2","request_id":format!("wait-{id}"),"op":"wait_verify","args":{"proposal_id":id,"timeout_ms":10}})).await;
        self.agent.receive_json().await
    }

    async fn no_exposed_ground_truth(&mut self) {
        self.agent.send(json!({"schema":"mv_tool_call/v0.2","request_id":"observe","op":"observe","args":{"surface_id":"surface-holdings"}})).await;
        let observed = self.agent.receive_json().await;
        assert!(
            observed.to_string().find("ground_truth").is_none(),
            "{observed}"
        );
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[test]
fn canonical_pair_positive_control() {
    support::run(async {
        let mut h = Harness::new(6, None).await;
        h.before_observation().await;
        h.frame(h.after.clone()).await;
        h.after_observation().await;
        h.settle("p1", "frame-bound witness matched", true).await;
    });
}

#[test]
fn before_digest_mismatch_detail() {
    support::run(async {
        let wrong = "c".repeat(64);
        let mut h = Harness::new(6, Some(&wrong)).await;
        h.before_observation().await;
        h.frame(h.after.clone()).await;
        h.after_observation().await;
        h.settle(
            "p1",
            "before ground_truth state_sha256 does not match expectation.before",
            false,
        )
        .await;
    });
}

#[test]
fn in_window_tick_regression_refused() {
    support::run(async {
        for tick in [4, 5] {
            let mut h = Harness::new(tick, None).await;
            h.before_observation().await;
            h.frame(h.after.clone()).await;
            h.after_observation().await;
            h.settle("p1", "witness tick outside expectation window", false)
                .await;
        }
    });
}

#[test]
fn unsafe_integer_sidecar_refused_end_to_end() {
    support::run(async {
        let mut h = Harness::new(6, None).await;
        h.before_observation().await;
        h.frame(h.after.clone()).await;
        // Both signs, with the digest matching the invalid bytes: rejection must
        // come from integer admission, not from an unrelated digest mismatch.
        for number in ["9007199254740992", "-9007199254740992"] {
            let raw = format!("{{\"meta\":{{\"tick\":6}},\"nodes\":{{\"value\":{number}}}}}");
            h.after_file.write_state(raw.as_bytes());
            h.after_digest = sha256_hex(raw.as_bytes());
            h.after_observation().await;
            h.refusal().await;
        }
        h.settle("p1", "missing holdings_lane ground_truth witness", false)
            .await;
    });
}

#[test]
fn vision_bearing_observation_refused_at_intake() {
    support::run(async {
        let mut h = Harness::new(6, None).await;
        let mut obs = holdings_observation(&h.before, &h.before_digest, 5);
        obs["vision"] = json!({"summary":"native frame","changed_regions":[],"elements":[]});
        h.daemon.send(obs).await;
        h.refusal().await;
        h.no_exposed_ground_truth().await;
    });
}

#[test]
fn before_after_reordering_refused() {
    support::run(async {
        let mut h = Harness::new(6, None).await;
        // Future after frame has not been committed.
        h.after_observation().await;
        h.refusal().await;
        h.frame(h.after.clone()).await;
        // Original before frame is now stale.
        h.before_observation().await;
        h.refusal().await;
        h.after_observation().await;
        h.settle(
            "p1",
            "holdings_lane witness joined; canonical state JSON bytes absent from capsule output",
            false,
        )
        .await;
    });
}

#[test]
fn observation_pair_replay_across_proposals_refused() {
    support::run(async {
        let mut h = Harness::new(6, None).await;
        h.before_observation().await;
        h.frame(h.after.clone()).await;
        h.after_observation().await;
        h.settle("p1", "frame-bound witness matched", true).await;
        // Proposal two is based on frame two; neither old observation can prove
        // an input after that frame, even though the pair verified proposal one.
        let old_before = h.before.clone();
        h.before = h.after.clone();
        let digest = h.after_digest.clone();
        h.propose("p2", &digest).await;
        h.daemon
            .send(holdings_observation(&old_before, &h.before_digest, 5))
            .await;
        h.refusal().await;
        h.after_observation().await;
        h.settle("p2", "missing holdings_lane ground_truth witness", false)
            .await;
    });
}

#[test]
fn crash_between_observations_has_no_verified_receipt_after_recovery() {
    support::run(async {
        let mut h = Harness::new(6, None).await;
        h.before_observation().await;
        // Wait for the canonical artifact to prove the before observation was
        // processed. Server observation admission/commit is synchronous.
        tokio::time::timeout(Duration::from_secs(3), async {
            while !h
                .temp
                .0
                .join("state/sessions")
                .join(config().session_id)
                .join("artifacts")
                .join(&h.before_digest)
                .is_file()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // Abort with no receipt or after witness submitted.
        let pending = h.wait("p1").await;
        assert_ne!(pending["receipt"]["verified"], true, "{pending}");
        h.daemon.socket.shutdown().await.unwrap();
        h.agent.socket.shutdown().await.unwrap();
        h.ui.socket.shutdown().await.unwrap();
        h.task.abort();
        while Arc::strong_count(h.server.as_ref().unwrap()) > 1 {
            tokio::task::yield_now().await;
        }
        drop(h.server.take());
        std::fs::remove_file(&h.socket).unwrap();
        let uid = support::uid();
        let listener = serve::bind(&h.socket, uid).await.unwrap();
        h.server = Some(Arc::new(Mutex::new(
            Server::open(config(), &h.temp.0.join("state"), uid).unwrap(),
        )));
        h.task = tokio::spawn(serve::serve(
            listener,
            h.server.as_ref().unwrap().clone(),
            uid,
        ));
        h.agent = Peer::connect(&h.socket, "agent").await;
        let recovered = h.wait("p1").await;
        assert_ne!(recovered["status"], "verified", "{recovered}");
        assert_ne!(recovered["receipt"]["verified"], true, "{recovered}");
        assert!(
            recovered
                .get("receipt")
                .is_none_or(|r| r.is_null() || r["verified"] == false),
            "{recovered}"
        );
    });
}
