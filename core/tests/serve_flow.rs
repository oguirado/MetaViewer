mod support;
use metaviewer_core::journal::{scan, sha256_hex};
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixStream;

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
}
fn config() -> Config {
    Config {
        session_id: "serve-session".into(),
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
        let env = self.envelope(body);
        write_frame(&mut self.socket, &env).await.unwrap();
    }
    fn envelope(&self, body: Value) -> Envelope {
        decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":format!("{}-{}", self.registration.endpoint.instance,self.seq),"ts_ns":0,"from":self.registration.endpoint,"to":self.config.core.endpoint,"session_id":self.config.session_id,"seq":self.seq,"nonce":format!("{}-{}",self.registration.endpoint.instance,self.seq),"body":body}).to_string()).unwrap()
    }
    async fn receive(&mut self) -> Envelope {
        tokio::time::timeout(Duration::from_secs(3), read_frame(&mut self.socket))
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    }
    async fn verdict(&mut self, decision: &str, reason: Option<&str>) {
        let env = self.receive().await;
        let value = serde_json::to_value(env.body).unwrap();
        assert_eq!(value["decision"], decision, "{value}");
        if let Some(reason) = reason {
            assert_eq!(value["reason_code"], reason);
        }
    }
}
struct SharedFrame(std::path::PathBuf);
impl SharedFrame {
    fn new() -> Self {
        let path =
            std::path::PathBuf::from(format!("/dev/shm/mv-wire-{}-frame", std::process::id()));
        std::fs::write(&path, b"immutable fake frame").unwrap();
        Self(path)
    }
    fn value(&self, generation: u64) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        value["sha256"] = sha256_hex(b"immutable fake frame").into();
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
fn proposal(id: &str, frame: &Value) -> Value {
    let mut p: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/action_proposal.valid.json"
    ))
    .unwrap();
    p["proposal_id"] = id.into();
    p["based_on_frame"]["sha256"] = frame["sha256"].clone();
    p["based_on_frame"]["generation"] = frame["generation"].clone();
    p
}
fn control(op: &str) -> Value {
    let mut body =
        json!({"schema":"surface_request/v0.2","op":op,"params":{"surface_id":"surface-demo"}});
    if op == "take_control" {
        body["params"]["owner"] = "human".into();
    }
    body
}
#[test]
fn socket_flow_admission_control_and_replay() {
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        assert_eq!(
            std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(socket.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;
        let surface: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        daemon
            .send(
                json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface}}),
            )
            .await;
        assert!(matches!(ui.receive().await.body, Command::SurfaceEvent(_)));
        let frame = SharedFrame::new();
        let f1 = frame.value(1);
        daemon.send(f1.clone()).await;
        assert!(matches!(ui.receive().await.body, Command::FrameRef(_)));
        agent.send(proposal("first", &f1)).await;
        agent.verdict("admitted", None).await;
        let input = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(input["op"], "input");
        assert_eq!(input["params"]["proposal_id"], "first");
        let mut receipt: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        receipt["proposal_id"] = "first".into();
        receipt["after_frame"] = f1.clone();
        daemon.send(receipt.clone()).await;
        assert!(matches!(
            agent.receive().await.body,
            Command::ActionReceipt(_)
        ));
        agent.send(proposal("stale", &frame.value(2))).await;
        agent.verdict("refused", Some("STALE_FRAME")).await;
        agent.send(proposal("cancel", &f1)).await;
        agent.verdict("admitted", None).await;
        daemon.receive().await;
        ui.send(control("take_control")).await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap()["op"],
            "take_control"
        );
        // A fresh frame under human ownership proves ownership refusal independently
        // of the stale-frame fence's precedence in the admission reducer.
        daemon.send(frame.value(2)).await;
        ui.receive().await;
        agent.send(proposal("human", &frame.value(2))).await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        receipt["proposal_id"] = "cancel".into();
        daemon.send(receipt).await;
        agent.receive().await;
        ui.send(control("release_control")).await;
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap()["op"],
            "release_control"
        );
        agent
            .send(proposal("before-refresh", &frame.value(2)))
            .await;
        agent.verdict("refused", Some("STALE_FRAME")).await;
        daemon.send(frame.value(3)).await;
        ui.receive().await;
        agent.send(proposal("readmitted", &frame.value(3))).await;
        agent.verdict("admitted", None).await;
        daemon.receive().await;
        let snapshot = server.lock().unwrap().snapshot().unwrap();
        let root = temp.0.join("state/sessions/serve-session");
        let replay = scan(&root.join("journal.jsonl"), &root).unwrap();
        assert_eq!(snapshot, replay.state.snapshot().unwrap());
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
            .args([
                "--journal",
                root.join("journal.jsonl").to_str().unwrap(),
                "--witness-root",
                root.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            sha256_hex(&snapshot)
        );
        drop((daemon, agent, ui));
        tokio::time::sleep(Duration::from_millis(20)).await;
        task.abort();
        let _ = task.await;
        drop(server);
        // Recovered committed boundary witnesses preserve non-proposal replay evidence.
        let recovered = Server::open(config(), &temp.0.join("state"), uid).unwrap();
        assert_eq!(recovered.snapshot().unwrap(), snapshot);
    });
}
#[test]
fn rejects_foreign_uid_unknown_registration_pin_and_oversized_frame() {
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        // Deliberately expect a foreign uid while using a real local socket.
        let task = tokio::spawn(serve::serve(
            listener,
            server.clone(),
            uid.checked_add(1).unwrap(),
        ));
        let mut foreign = UnixStream::connect(&socket).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), read_frame(&mut foreign))
                .await
                .unwrap()
                .unwrap()
                .is_none()
        );
        task.abort();
        let _ = task.await;
        drop(foreign);
        let listener = serve::bind(&socket, uid).await.unwrap();
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        for kind in ["unknown", "pin", "oversized"] {
            let mut socket = UnixStream::connect(&socket).await.unwrap();
            let mut peer = Peer {
                socket: UnixStream::pair().unwrap().0,
                config: config(),
                registration: registration("ui"),
                seq: 1,
            };
            let mut body = serde_json::to_value(&peer.registration.hello).unwrap();
            if kind == "unknown" {
                peer.registration.endpoint.instance = "unregistered".into();
            }
            if kind == "pin" {
                body["component_version"] = "wrong".into();
            }
            if kind == "oversized" {
                use tokio::io::AsyncWriteExt;
                let bytes = vec![b' '; MAX_FRAME_BYTES];
                let _ = socket.write_all(&bytes).await;
            } else {
                write_frame(&mut socket, &peer.envelope(body))
                    .await
                    .unwrap();
            }
            let refused = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut socket))
                .await
                .unwrap();
            assert!(!matches!(refused, Ok(Some(_))), "{kind}");
        }
        assert_eq!(
            serde_json::from_slice::<Value>(&server.lock().unwrap().snapshot().unwrap()).unwrap()
                ["core_seq"],
            0
        );
        task.abort();
    });
}
#[test]
fn unsupported_ui_intent_control_is_closed_before_effects() {
    let p = PeerEnvelope::value();
    assert!(decode_envelope(&p.to_string()).is_err());
}
struct PeerEnvelope;
impl PeerEnvelope {
    fn value() -> Value {
        json!({"schema":"envelope/v0.2","msg_id":"control","ts_ns":0,"from":{"component":"ui","instance":"ui-test"},"to":{"component":"core","instance":"core-test"},"session_id":"serve-session","seq":1,"nonce":"control","body":{"schema":"ui_intent/v0.2","request_id":"control","op":"take_control","params":{"surface_id":"surface-demo"}}})
    }
}
