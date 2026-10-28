#![forbid(unsafe_code)]
mod support;

use metaviewer_core::journal::sha256_hex;
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
            "/dev/shm/mv-holdings-{}-{}-frame",
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

#[test]
fn holdings_witness_intake_join_and_observe_exposure() {
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let state_dir = temp.0.join("state");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(Server::open(config(), &state_dir, uid).unwrap()));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'a');
        let f2 = SharedFrame::new(b'b');
        let f3 = SharedFrame::new(b'c');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let frame2 = f2.value("surface-holdings", 2, 1_500);
        let frame3 = f3.value("surface-holdings", 3, 2_500);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        assert_eq!(ui.receive_json().await["event"], "created");

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        assert_eq!(ui.receive_json().await["event"], "frame_ready");

        let before_digest = "11".repeat(32);
        let after_digest = "22".repeat(32);
        let prop = state_change_proposal(
            "prop-holdings-1",
            "surface-holdings",
            &frame1,
            &before_digest,
            1,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-1",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        let propose_res = agent.receive_json().await;
        assert_eq!(propose_res["status"], "admitted");
        let dispatched = daemon.receive_json().await;
        assert_eq!(dispatched["op"], "input");
        assert_eq!(dispatched["params"]["proposal_id"], "prop-holdings-1");

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "input_applied",
                "data": {"surface_id": "surface-holdings", "proposal_id": "prop-holdings-1"}
            }))
            .await;
        assert_eq!(ui.receive_json().await["event"], "input_applied");

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        assert_eq!(ui.receive_json().await["event"], "frame_ready");

        // Daemon emits observation/v0.2 with holdings_lane ground_truth before action_receipt/v0.2.
        daemon
            .send(holdings_observation(&frame2, &after_digest, 4))
            .await;
        daemon
            .send(daemon_receipt("prop-holdings-1", &frame2))
            .await;

        let settled = agent.receive_json().await;
        assert_eq!(settled["schema"], "action_receipt/v0.2");
        assert_eq!(settled["proposal_id"], "prop-holdings-1");
        assert_eq!(settled["verified"], false);
        assert_eq!(settled["verification"]["method"], "state_sha256");
        assert_eq!(
            settled["verification"]["detail"],
            "holdings_lane witness joined; canonical state JSON bytes absent from capsule output"
        );

        // Agent observe exposes ground_truth {source: "holdings_lane", state_sha256, tick} for frame2.
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-observe-1",
                "op": "observe",
                "args": {"surface_id": "surface-holdings"}
            }))
            .await;
        let obs_res = agent.receive_json().await;
        assert_eq!(obs_res["status"], "ok");
        assert_eq!(
            obs_res["observation"]["frame_ref"]["sha256"],
            frame2["sha256"]
        );
        assert_eq!(
            obs_res["observation"]["ground_truth"],
            json!({
                "source": "holdings_lane",
                "state_sha256": after_digest,
                "tick": 4
            })
        );

        // wait_verify fails closed because verify/mod.rs requires canonical state JSON bytes.
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-wait-1",
                "op": "wait_verify",
                "args": {"proposal_id": "prop-holdings-1", "timeout_ms": 100}
            }))
            .await;
        let wait_res = agent.receive_json().await;
        assert_eq!(wait_res["status"], "error");
        assert_eq!(wait_res["code"], "VERIFICATION_FAILED");
        assert_eq!(
            wait_res["detail"],
            "holdings_lane witness joined; canonical state JSON bytes absent from capsule output"
        );

        // Reopen server from journal and confirm ground_truth is recovered for frame2.
        drop((daemon, agent, ui));
        task.abort();
        let _ = task.await;
        while Arc::strong_count(&server) > 1 {
            tokio::task::yield_now().await;
        }
        drop(server);
        let _ = std::fs::remove_file(&socket);
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(Server::open(config(), &state_dir, uid).unwrap()));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-observe-recovered",
                "op": "observe",
                "args": {"surface_id": "surface-holdings"}
            }))
            .await;
        let recovered_obs = agent.receive_json().await;
        assert_eq!(recovered_obs["status"], "ok");
        assert_eq!(
            recovered_obs["observation"]["ground_truth"],
            json!({
                "source": "holdings_lane",
                "state_sha256": after_digest,
                "tick": 4
            })
        );

        // Advancing to frame3 without a new witness clears stale ground_truth on observe.
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame3}
            }))
            .await;
        assert_eq!(ui.receive_json().await["event"], "frame_ready");
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-observe-next",
                "op": "observe",
                "args": {"surface_id": "surface-holdings"}
            }))
            .await;
        let next_obs = agent.receive_json().await;
        assert_eq!(next_obs["status"], "ok");
        assert!(next_obs["observation"].get("ground_truth").is_none());

        task.abort();
    });
}

#[test]
fn negative_control_missing_witness_fails_closed() {
    // Named mutation: omit daemon observation/v0.2 before action_receipt/v0.2.
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'd');
        let f2 = SharedFrame::new(b'e');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let frame2 = f2.value("surface-holdings", 2, 1_500);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-missing-witness",
            "surface-holdings",
            &frame1,
            &"11".repeat(32),
            1,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-1",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;

        // Mutation: send action_receipt without observation/v0.2.
        daemon
            .send(daemon_receipt("prop-missing-witness", &frame2))
            .await;

        let settled = agent.receive_json().await;
        assert_eq!(settled["verified"], false);
        assert_eq!(settled["verification"]["method"], "state_sha256");
        assert_eq!(
            settled["verification"]["detail"],
            "missing holdings_lane ground_truth witness"
        );

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-wait-missing",
                "op": "wait_verify",
                "args": {"proposal_id": "prop-missing-witness", "timeout_ms": 100}
            }))
            .await;
        let wait_res = agent.receive_json().await;
        assert_eq!(wait_res["status"], "error");
        assert_eq!(wait_res["code"], "VERIFICATION_FAILED");
        assert_eq!(
            wait_res["detail"],
            "missing holdings_lane ground_truth witness"
        );

        task.abort();
    });
}

#[test]
fn negative_control_unchanged_digest_fails_closed() {
    // Named mutation: observation/v0.2 carries state_sha256 equal to expectation.before.
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'g');
        let f2 = SharedFrame::new(b'h');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let frame2 = f2.value("surface-holdings", 2, 1_500);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let same_digest = "33".repeat(32);
        let prop = state_change_proposal(
            "prop-unchanged-digest",
            "surface-holdings",
            &frame1,
            &same_digest,
            1,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-1",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;

        daemon
            .send(holdings_observation(&frame2, &same_digest, 5))
            .await;
        daemon
            .send(daemon_receipt("prop-unchanged-digest", &frame2))
            .await;

        let settled = agent.receive_json().await;
        assert_eq!(settled["verified"], false);
        assert_eq!(settled["verification"]["method"], "state_sha256");
        assert_eq!(
            settled["verification"]["detail"],
            "state_sha256 unchanged from before digest"
        );

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-wait-unchanged",
                "op": "wait_verify",
                "args": {"proposal_id": "prop-unchanged-digest", "timeout_ms": 100}
            }))
            .await;
        let wait_res = agent.receive_json().await;
        assert_eq!(wait_res["status"], "error");
        assert_eq!(wait_res["code"], "VERIFICATION_FAILED");
        assert_eq!(
            wait_res["detail"],
            "state_sha256 unchanged from before digest"
        );

        task.abort();
    });
}

#[test]
fn negative_control_tick_outside_window_fails_closed() {
    // Named mutation: observation/v0.2 carries tick outside [min_tick, max_tick].
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'j');
        let f2 = SharedFrame::new(b'k');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let frame2 = f2.value("surface-holdings", 2, 1_500);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-tick-outside",
            "surface-holdings",
            &frame1,
            &"44".repeat(32),
            2,
            8,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-1",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;

        // Tick 99 is above max_tick 8.
        daemon
            .send(holdings_observation(&frame2, &"55".repeat(32), 99))
            .await;
        daemon
            .send(daemon_receipt("prop-tick-outside", &frame2))
            .await;

        let settled = agent.receive_json().await;
        assert_eq!(settled["verified"], false);
        assert_eq!(settled["verification"]["method"], "state_sha256");
        assert_eq!(
            settled["verification"]["detail"],
            "witness tick outside expectation window"
        );

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-wait-tick",
                "op": "wait_verify",
                "args": {"proposal_id": "prop-tick-outside", "timeout_ms": 100}
            }))
            .await;
        let wait_res = agent.receive_json().await;
        assert_eq!(wait_res["status"], "error");
        assert_eq!(wait_res["code"], "VERIFICATION_FAILED");
        assert_eq!(
            wait_res["detail"],
            "witness tick outside expectation window"
        );

        task.abort();
    });
}

#[test]
fn negative_control_witness_bound_to_foreign_frame_or_surface_fails_closed() {
    // Named mutation: bind observation/v0.2 to a foreign surface/frame at intake and to an
    // earlier frame generation than action_receipt.after_frame at settlement.
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'm');
        let f2 = SharedFrame::new(b'n');
        let f3 = SharedFrame::new(b'p');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let frame2 = f2.value("surface-holdings", 2, 1_500);
        let frame3 = f3.value("surface-holdings", 3, 1_800);
        let foreign_surface_frame = f2.value("surface-other", 1, 1_500);

        for sid in ["surface-holdings", "surface-other"] {
            daemon
                .send(json!({
                    "schema": "surface_event/v0.2",
                    "event": "created",
                    "data": {"surface": holdings_surface(sid)}
                }))
                .await;
            ui.receive().await;
        }
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": foreign_surface_frame}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-foreign-witness",
            "surface-holdings",
            &frame1,
            &"66".repeat(32),
            1,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-1",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;

        // 1) Witness bound to foreign surface (no pending proposal on surface-other) -> POLICY refusal.
        daemon
            .send(holdings_observation(
                &foreign_surface_frame,
                &"77".repeat(32),
                3,
            ))
            .await;
        let refused_surface = daemon.receive_json().await;
        assert_eq!(refused_surface["decision"], "refused");
        assert_eq!(refused_surface["reason_code"], "POLICY");

        // 2) Witness bound to uncommitted/stale frame1 on surface-holdings -> POLICY refusal.
        daemon
            .send(holdings_observation(&frame1, &"77".repeat(32), 3))
            .await;
        let refused_frame = daemon.receive_json().await;
        assert_eq!(refused_frame["decision"], "refused");
        assert_eq!(refused_frame["reason_code"], "POLICY");

        // 3) Valid witness on frame2 followed by frame3 and receipt on frame3 -> foreign to after_frame.
        daemon
            .send(holdings_observation(&frame2, &"77".repeat(32), 3))
            .await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame3}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(daemon_receipt("prop-foreign-witness", &frame3))
            .await;

        let settled = agent.receive_json().await;
        assert_eq!(settled["verified"], false);
        assert_eq!(settled["verification"]["method"], "state_sha256");
        assert_eq!(
            settled["verification"]["detail"],
            "witness bound to foreign frame or surface"
        );

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-wait-foreign",
                "op": "wait_verify",
                "args": {"proposal_id": "prop-foreign-witness", "timeout_ms": 100}
            }))
            .await;
        let wait_res = agent.receive_json().await;
        assert_eq!(wait_res["status"], "error");
        assert_eq!(wait_res["code"], "VERIFICATION_FAILED");
        assert_eq!(
            wait_res["detail"],
            "witness bound to foreign frame or surface"
        );

        task.abort();
    });
}

#[test]
fn negative_control_observation_from_non_daemon_peer_refused() {
    // Named mutation: send observation/v0.2 from agent and ui peers (and from daemon with no pending input).
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'q');
        let frame1 = f1.value("surface-holdings", 1, 1_000);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let obs = holdings_observation(&frame1, &"88".repeat(32), 2);

        // Agent peer sends observation/v0.2 -> refused with POLICY.
        agent.send(obs.clone()).await;
        let agent_refusal = agent.receive_json().await;
        assert_eq!(agent_refusal["decision"], "refused");
        assert_eq!(agent_refusal["reason_code"], "POLICY");

        // UI peer sends observation/v0.2 -> refused with POLICY.
        ui.send(obs.clone()).await;
        let ui_refusal = ui.receive_json().await;
        assert_eq!(ui_refusal["decision"], "refused");
        assert_eq!(ui_refusal["reason_code"], "POLICY");

        // Daemon peer sends observation/v0.2 with no pending agent-origin input -> refused with POLICY.
        daemon.send(obs).await;
        let daemon_refusal = daemon.receive_json().await;
        assert_eq!(daemon_refusal["decision"], "refused");
        assert_eq!(daemon_refusal["reason_code"], "POLICY");

        // Confirm none of the refused observations polluted observe.
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-observe-recovered",
                "op": "observe",
                "args": {"surface_id": "surface-holdings"}
            }))
            .await;
        let obs_res = agent.receive_json().await;
        assert_eq!(obs_res["status"], "ok");
        assert!(obs_res["observation"].get("ground_truth").is_none());

        task.abort();
    });
}

#[test]
fn intake_rejects_observation_for_unknown_old_epoch_proposal() {
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'r');
        let frame1 = f1.value("surface-holdings", 1, 1_000);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-old-epoch",
            "surface-holdings",
            &frame1,
            &"11".repeat(32),
            1,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-epoch",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        // Reconnect daemon so epoch increments and prop-old-epoch becomes unknown.
        drop(daemon);
        for _ in 0..500 {
            let epoch_before = {
                let s = server.lock().unwrap();
                let snap: Value = serde_json::from_slice(&s.snapshot().unwrap()).unwrap();
                snap["epoch"].as_u64().unwrap_or(0)
            };
            if epoch_before == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let mut daemon = Peer::connect(&socket, "daemon").await;
        for _ in 0..500 {
            let epoch_after = {
                let s = server.lock().unwrap();
                let snap: Value = serde_json::from_slice(&s.snapshot().unwrap()).unwrap();
                snap["epoch"].as_u64().unwrap_or(0)
            };
            if epoch_after >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        daemon
            .send(holdings_observation(&frame1, &"22".repeat(32), 4))
            .await;
        let refusal = daemon.receive_json().await;
        assert_eq!(refusal["decision"], "refused");
        assert_eq!(refusal["reason_code"], "POLICY");

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-observe-after-epoch",
                "op": "observe",
                "args": {"surface_id": "surface-holdings"}
            }))
            .await;
        let obs_res = agent.receive_json().await;
        assert_eq!(obs_res["status"], "ok");
        assert!(obs_res["observation"].get("ground_truth").is_none());

        task.abort();
    });
}

#[test]
fn observe_omits_witness_during_human_control_or_human_pending() {
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b's');
        let f2 = SharedFrame::new(b't');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let frame2 = f2.value("surface-holdings", 2, 1_500);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-human-takeover",
            "surface-holdings",
            &frame1,
            &"11".repeat(32),
            1,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-ht",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;

        daemon
            .send(holdings_observation(&frame2, &"22".repeat(32), 4))
            .await;
        for _ in 0..500 {
            let committed = server.lock().unwrap().snapshot().is_ok_and(|bytes| {
                serde_json::from_slice::<Value>(&bytes)
                    .map(|snap| snap["core_seq"].as_u64().unwrap_or(0) >= 6)
                    .unwrap_or(false)
            });
            if committed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        // Before human takeover, observe exposes the witness on frame2.
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-observe-before-ht",
                "op": "observe",
                "args": {"surface_id": "surface-holdings"}
            }))
            .await;
        let before_ht = agent.receive_json().await;
        assert_eq!(before_ht["status"], "ok");
        assert!(before_ht["observation"].get("ground_truth").is_some());

        // Still on frame2 (without advancing the frame), human takes control
        // (cancelling prop-human-takeover and clearing agent_controlled).
        ui.send(json!({
            "schema": "ui_intent/v0.2",
            "request_id": "req-take-1",
            "op": "take_control",
            "params": {"surface_id": "surface-holdings"}
        }))
        .await;
        let cancelled_verdict = agent.receive_json().await;
        assert_eq!(cancelled_verdict["decision"], "refused");
        assert_eq!(
            cancelled_verdict["reason_code"],
            "SURFACE_NOT_AGENT_CONTROLLED"
        );
        let daemon_take = daemon.receive_json().await;
        assert_eq!(daemon_take["op"], "take_control");

        // Observe on frame2 must now omit the stale agent ground_truth witness.
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-observe-after-ht",
                "op": "observe",
                "args": {"surface_id": "surface-holdings"}
            }))
            .await;
        let after_ht = agent.receive_json().await;
        assert_eq!(after_ht["status"], "ok");
        assert_eq!(
            after_ht["observation"]["frame_ref"]["sha256"],
            frame2["sha256"]
        );
        assert!(after_ht["observation"].get("ground_truth").is_none());

        // Drain the cancelled agent proposal (draining receipts settle silently
        // without forwarding to the agent) and submit a human pending input on
        // frame2; observe must continue omitting ground_truth while human input
        // is pending.
        daemon
            .send(daemon_receipt("prop-human-takeover", &frame2))
            .await;
        for _ in 0..500 {
            let drained = {
                let s = server.lock().unwrap();
                let snap: Value = serde_json::from_slice(&s.snapshot().unwrap()).unwrap();
                snap["draining"].get("prop-human-takeover").is_none()
            };
            if drained {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": "surface-holdings",
                "proposal_id": "human-input-1",
                "origin": "human",
                "action": {"type": "click", "x": 10, "y": 10, "button": "left"}
            }
        }))
        .await;
        let daemon_human_in = daemon.receive_json().await;
        assert_eq!(daemon_human_in["op"], "input");
        assert_eq!(daemon_human_in["params"]["proposal_id"], "human-input-1");

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-observe-human-pending",
                "op": "observe",
                "args": {"surface_id": "surface-holdings"}
            }))
            .await;
        let during_human_pending = agent.receive_json().await;
        assert_eq!(during_human_pending["status"], "ok");
        assert!(during_human_pending["observation"]
            .get("ground_truth")
            .is_none());

        task.abort();
    });
}

#[test]
fn holdings_state_matching_canonicalises_and_settles_verified_true() {
    // End-to-end: relay-escaped and unsorted state sidecars are re-canonicalised by Core,
    // verified against state_sha256, and settle Case2 verified=true in action_receipt and wait_verify.
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'u');
        let f2 = SharedFrame::new(b'v');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let mut frame1_obs = frame1.clone();
        frame1_obs["tick"] = 3.into();
        let mut frame2 = f2.value("surface-holdings", 2, 2_500);
        frame2["tick"] = 5.into();

        // Canonical bytes vs Go encoding/json relayed bytes (with \u003c\u003e\u0026 and unsorted keys).
        let before_canonical =
            br#"{"meta":{"tag":"<before>&ok","tick":3},"nodes":{"cash":"100","level":1}}"#;
        let before_relayed = br#"{"nodes":{"level":1,"cash":"100"},"meta":{"tick":3,"tag":"\u003cbefore\u003e\u0026ok"}}"#;
        let before_digest = sha256_hex(before_canonical);

        let after_canonical =
            br#"{"meta":{"tag":"<after>&ok","tick":5},"nodes":{"cash":"250","level":2}}"#;
        let after_relayed = br#"{"nodes":{"level":2,"cash":"250"},"meta":{"tick":5,"tag":"\u003cafter\u003e\u0026ok"}}"#;
        let after_digest = sha256_hex(after_canonical);

        f1.write_state(before_relayed);
        f2.write_state(after_relayed);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-h4-verified",
            "surface-holdings",
            &frame1,
            &before_digest,
            4,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-h4",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        assert_eq!(daemon.receive_json().await["op"], "input");

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "input_applied",
                "data": {"surface_id": "surface-holdings", "proposal_id": "prop-h4-verified"}
            }))
            .await;
        ui.receive().await;

        // Before-input observation on frame1 (bound to tick 3) + after-input frame2 and observation (bound to tick 5).
        daemon
            .send(holdings_observation(&frame1_obs, &before_digest, 3))
            .await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(holdings_observation(&frame2, &after_digest, 5))
            .await;
        let mut rcpt = daemon_receipt("prop-h4-verified", &frame2);
        rcpt["native_evidence"] = json!({
            "surface_id": "surface-holdings",
            "input_mono_ns": 2_100,
            "input_ts_ns": 1_800
        });
        daemon.send(rcpt).await;

        let settled = agent.receive_json().await;
        assert_eq!(settled["schema"], "action_receipt/v0.2");
        assert_eq!(settled["proposal_id"], "prop-h4-verified");
        assert_eq!(settled["verified"], true);
        assert_eq!(settled["verification"]["method"], "state_sha256");
        assert_eq!(
            settled["verification"]["detail"],
            "frame-bound witness matched"
        );

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-wait-h4",
                "op": "wait_verify",
                "args": {"proposal_id": "prop-h4-verified", "timeout_ms": 100}
            }))
            .await;
        let wait_res = agent.receive_json().await;
        assert_eq!(wait_res["status"], "verified");
        assert_eq!(wait_res["focus_verified"], true);
        assert_eq!(wait_res["input_mono_ns"], 2_100);
        assert_eq!(wait_res["frame_sha256"], frame2["sha256"]);
        assert_eq!(wait_res["receipt"]["verified"], true);
        assert_eq!(
            wait_res["receipt"]["verification"]["method"],
            "state_sha256"
        );
        assert_eq!(
            wait_res["receipt"]["verification"]["detail"],
            "frame-bound witness matched"
        );

        // Drop /dev/shm frames and sidecars, reopen Server from journal, and confirm
        // wait_verify still settles verified=true from committed artifacts.
        drop((f1, f2, daemon, agent, ui));
        task.abort();
        let _ = task.await;
        while Arc::strong_count(&server) > 1 {
            tokio::task::yield_now().await;
        }
        drop(server);
        let _ = std::fs::remove_file(&socket);
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        let mut agent = Peer::connect(&socket, "agent").await;

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-wait-h4-recovered",
                "op": "wait_verify",
                "args": {"proposal_id": "prop-h4-verified", "timeout_ms": 100}
            }))
            .await;
        let recovered_wait = agent.receive_json().await;
        assert_eq!(recovered_wait["status"], "verified");
        assert_eq!(recovered_wait["input_mono_ns"], 2_100);
        assert_eq!(recovered_wait["receipt"]["verified"], true);

        task.abort();
    });
}

#[test]
fn negative_control_tampered_state_refused() {
    // Named mutation: tamper with the relayed state JSON in the sidecar so it either
    // violates canonical number rules (float) or differs from the claimed state_sha256.
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'w');
        let f2 = SharedFrame::new(b'x');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let mut frame2 = f2.value("surface-holdings", 2, 1_500);
        frame2["tick"] = 5.into();

        let before_canonical = br#"{"meta":{"tick":3},"nodes":{"level":1}}"#;
        let before_digest = sha256_hex(before_canonical);
        let after_canonical = br#"{"meta":{"tick":5},"nodes":{"level":2}}"#;
        let after_digest = sha256_hex(after_canonical);

        // Tamper with f2's state bytes (level changed to 99 while claiming after_digest).
        f2.write_state(br#"{"meta":{"tick":5},"nodes":{"level":99}}"#);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-tampered-state",
            "surface-holdings",
            &frame1,
            &before_digest,
            4,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-tampered",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;

        daemon
            .send(holdings_observation(&frame2, &after_digest, 5))
            .await;
        let refusal = daemon.receive_json().await;
        assert_eq!(refusal["decision"], "refused");
        assert_eq!(refusal["reason_code"], "POLICY");

        // Also verify non-integer float in state sidecar is refused with POLICY.
        f2.write_state(br#"{"meta":{"tick":5},"nodes":{"ratio":1.5}}"#);
        daemon
            .send(holdings_observation(&frame2, &after_digest, 5))
            .await;
        let float_refusal = daemon.receive_json().await;
        assert_eq!(float_refusal["decision"], "refused");
        assert_eq!(float_refusal["reason_code"], "POLICY");

        task.abort();
    });
}

#[test]
fn negative_control_state_digest_mismatch_refused() {
    // Named mutation: observation.ground_truth.state_sha256 does not match sha256(canonicalBytes(state)).
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'y');
        let f2 = SharedFrame::new(b'z');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let mut frame2 = f2.value("surface-holdings", 2, 1_500);
        frame2["tick"] = 5.into();

        let before_canonical = br#"{"meta":{"tick":3},"nodes":{"level":1}}"#;
        let before_digest = sha256_hex(before_canonical);
        f2.write_state(br#"{"meta":{"tick":5},"nodes":{"level":2}}"#);
        let mismatched_digest = "aa".repeat(32);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-digest-mismatch",
            "surface-holdings",
            &frame1,
            &before_digest,
            4,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-mismatch",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;

        daemon
            .send(holdings_observation(&frame2, &mismatched_digest, 5))
            .await;
        let refusal = daemon.receive_json().await;
        assert_eq!(refusal["decision"], "refused");
        assert_eq!(refusal["reason_code"], "POLICY");

        task.abort();
    });
}

#[test]
fn negative_control_state_tick_mismatch_settles_verified_false() {
    // Named mutation: frame_ref.tick does not match ground_truth.tick when canonical state bytes are present.
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'1');
        let f2 = SharedFrame::new(b'2');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let mut frame1_obs = frame1.clone();
        frame1_obs["tick"] = 3.into();
        let mut frame2 = f2.value("surface-holdings", 2, 2_500);
        // Frame tick is 4 while ground_truth.tick is 5 -> tick mismatch.
        frame2["tick"] = 4.into();

        let before_canonical = br#"{"meta":{"tick":3},"nodes":{"level":1}}"#;
        let before_digest = sha256_hex(before_canonical);
        let after_canonical = br#"{"meta":{"tick":5},"nodes":{"level":2}}"#;
        let after_digest = sha256_hex(after_canonical);

        f1.write_state(before_canonical);
        f2.write_state(after_canonical);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-tick-mismatch",
            "surface-holdings",
            &frame1,
            &before_digest,
            4,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-tick-mismatch",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(holdings_observation(&frame1_obs, &before_digest, 3))
            .await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(holdings_observation(&frame2, &after_digest, 5))
            .await;
        daemon
            .send(daemon_receipt("prop-tick-mismatch", &frame2))
            .await;

        let settled = agent.receive_json().await;
        assert_eq!(settled["verified"], false);
        assert_eq!(settled["verification"]["method"], "state_sha256");
        assert_eq!(
            settled["verification"]["detail"],
            "witness tick does not match frame_ref.tick"
        );

        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-wait-tick-mismatch",
                "op": "wait_verify",
                "args": {"proposal_id": "prop-tick-mismatch", "timeout_ms": 100}
            }))
            .await;
        let wait_res = agent.receive_json().await;
        assert_eq!(wait_res["status"], "error");
        assert_eq!(wait_res["code"], "VERIFICATION_FAILED");
        assert_eq!(
            wait_res["detail"],
            "witness tick does not match frame_ref.tick"
        );

        task.abort();
    });
}

#[test]
fn negative_control_oversize_state_refused() {
    // Named mutation: state sidecar exceeds 1 MiB (1,048,576 bytes).
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let f1 = SharedFrame::new(b'3');
        let f2 = SharedFrame::new(b'4');
        let frame1 = f1.value("surface-holdings", 1, 1_000);
        let mut frame2 = f2.value("surface-holdings", 2, 1_500);
        frame2["tick"] = 5.into();

        let before_digest = "11".repeat(32);
        let mut oversize = br#"{"pad":""#.to_vec();
        oversize.extend(std::iter::repeat_n(b'a', 1_048_576));
        oversize.extend_from_slice(br#""}"#);
        assert!(oversize.len() > 1_048_576);
        let oversize_digest = sha256_hex(&oversize);
        f2.write_state(&oversize);

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": holdings_surface("surface-holdings")}
            }))
            .await;
        ui.receive().await;
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame1}
            }))
            .await;
        ui.receive().await;

        let prop = state_change_proposal(
            "prop-oversize-state",
            "surface-holdings",
            &frame1,
            &before_digest,
            4,
            10,
        );
        agent
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "req-propose-oversize",
                "op": "propose",
                "args": {"proposal": prop}
            }))
            .await;
        assert_eq!(agent.receive_json().await["status"], "admitted");
        daemon.receive().await;

        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "frame_ready",
                "data": {"frame_ref": frame2}
            }))
            .await;
        ui.receive().await;

        daemon
            .send(holdings_observation(&frame2, &oversize_digest, 5))
            .await;
        let refusal = daemon.receive_json().await;
        assert_eq!(refusal["decision"], "refused");
        assert_eq!(refusal["reason_code"], "POLICY");

        task.abort();
    });
}
