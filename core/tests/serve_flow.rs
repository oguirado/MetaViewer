mod serve_v02_tags;
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
        let env = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut self.socket))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let value = serde_json::to_value(&env).unwrap();
        if matches!(
            value["body"]["schema"].as_str(),
            Some("surface_event/v0.2" | "frame_ref/v0.2")
        ) {
            serve_v02_tags::assert_v02_output(&value);
        }
        env
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
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::path::PathBuf::from(format!(
            "/dev/shm/mv-wire-{}-{}-frame",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
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
    json!({"schema":"ui_intent/v0.2","request_id":format!("control-{op}"),"op":op,"params":{"surface_id":"surface-demo"}})
}

#[test]
fn live_frame_fanout_isolates_surface_subscriptions() {
    // Mutation: replace the per-surface subscription lookup in fanout with true.
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
        let mut agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;
        let surface: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        for id in ["surface-demo", "surface-b"] {
            let mut s = surface.clone();
            s["surface_id"] = id.into();
            daemon
                .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":s}}))
                .await;
            ui.receive().await;
        }
        agent.send(json!({"schema":"surface_request/v0.2","op":"frame_subscribe","params":{"surface_id":"surface-demo"}})).await;
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap()["op"],
            "frame_subscribe"
        );
        let a = SharedFrame::new();
        let b = SharedFrame::new();
        std::fs::write(&b.0, b"different immutable frame").unwrap();
        let fa = a.value(1);
        let mut fb = b.value(1);
        fb["surface_id"] = "surface-b".into();
        fb["sha256"] = sha256_hex(b"different immutable frame").into();
        // A subscribed UI receives B while the A-only agent must not.
        daemon.send(fb.clone()).await;
        assert_eq!(serde_json::to_value(ui.receive().await.body).unwrap(), fb);
        daemon.send(fa.clone()).await;
        assert_eq!(serde_json::to_value(ui.receive().await.body).unwrap(), fa);
        // A is also a barrier: an incorrectly queued B would be read first.
        assert_eq!(
            serde_json::to_value(agent.receive().await.body).unwrap(),
            fa
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), read_frame(&mut agent.socket))
                .await
                .is_err()
        );
        drop((daemon, agent, ui));
        task.abort();
        let _ = task.await;
    });
}
#[test]
fn lifecycle_requests_forward_and_replies_are_durable() {
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
        let create = json!({"schema":"surface_request/v0.2","op":"create","params":{"kind":"desktop_capsule","geometry":{"w":1280,"h":720},"profile_id":"test"}});
        // A registered executor is not a lifecycle caller.
        daemon.send(create.clone()).await;
        daemon.verdict("refused", Some("POLICY")).await;
        ui.send(create.clone()).await;
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap(),
            create
        );
        let list = json!({"schema":"surface_request/v0.2","op":"list","params":{}});
        agent.send(list.clone()).await;
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap(),
            list
        );
        let surface: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        let created =
            json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface}});
        daemon.send(created.clone()).await;
        for peer in [&mut ui, &mut agent] {
            assert_eq!(
                serde_json::to_value(peer.receive().await.body).unwrap(),
                created
            );
        }
        let frame = SharedFrame::new();
        let f = frame.value(1);
        daemon.send(f.clone()).await;
        for peer in [&mut ui, &mut agent] {
            assert_eq!(serde_json::to_value(peer.receive().await.body).unwrap(), f);
        }
        for op in ["frame_unsubscribe", "frame_subscribe"] {
            let request = json!({"schema":"surface_request/v0.2","op":op,"params":{"surface_id":"surface-demo"}});
            agent.send(request.clone()).await;
            assert_eq!(
                serde_json::to_value(daemon.receive().await.body).unwrap(),
                request
            );
            let event =
                json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f}});
            daemon.send(event.clone()).await;
            assert_eq!(
                serde_json::to_value(ui.receive().await.body).unwrap(),
                event
            );
            if op == "frame_subscribe" {
                assert_eq!(
                    serde_json::to_value(agent.receive().await.body).unwrap(),
                    event
                );
            } else {
                assert!(tokio::time::timeout(
                    Duration::from_millis(50),
                    read_frame(&mut agent.socket)
                )
                .await
                .is_err());
            }
        }
        // Lifecycle permission must not bypass action admission.
        agent.send(json!({"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"surface-demo","proposal_id":"bypass","action":{"type":"key","keys":["Enter"]}}})).await;
        agent.verdict("refused", Some("POLICY")).await;
        let destroy = json!({"schema":"surface_request/v0.2","op":"destroy","params":{"surface_id":"surface-demo"}});
        for peer in [&mut ui, &mut agent] {
            peer.send(destroy.clone()).await;
            assert_eq!(
                serde_json::to_value(daemon.receive().await.body).unwrap(),
                destroy
            );
        }
        let mut destroyed = surface;
        destroyed["state"] = "destroyed".into();
        let event = json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":destroyed}});
        daemon.send(event.clone()).await;
        for peer in [&mut ui, &mut agent] {
            assert_eq!(
                serde_json::to_value(peer.receive().await.body).unwrap(),
                event
            );
        }
        // Failed creates have no surface in authority state, but their error is durable.
        agent.send(create.clone()).await;
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap(),
            create
        );
        let error = json!({"schema":"surface_event/v0.2","event":"error","data":{"surface_id":"failed-create","code":"CLI_FAILED","detail":"failed"}});
        daemon.send(error.clone()).await;
        for peer in [&mut ui, &mut agent] {
            assert_eq!(
                serde_json::to_value(peer.receive().await.body).unwrap(),
                error
            );
        }
        let snapshot = server.lock().unwrap().snapshot().unwrap();
        let root = temp.0.join("state/sessions/serve-session");
        assert_eq!(
            scan(&root.join("journal.jsonl"), &root)
                .unwrap()
                .state
                .snapshot()
                .unwrap(),
            snapshot
        );
        // Each forwarded request has its original boundary envelope retained.
        let mut requests = 0;
        for entry in std::fs::read_dir(root.join("events")).unwrap() {
            let event: Value =
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
            if event["input"]["event"] == "SurfaceRequest" {
                requests += 1;
                let hash = event["witnesses"][0]["sha256"].as_str().unwrap();
                let raw = std::fs::read_to_string(root.join("artifacts").join(hash)).unwrap();
                assert!(matches!(
                    decode_envelope(&raw).unwrap().body,
                    Command::SurfaceRequest(_)
                ));
            }
        }
        assert_eq!(requests, 7);
        drop((daemon, agent, ui));
        task.abort();
        let _ = task.await;
        drop(server);
    });
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
        ui.send(json!({"schema":"ui_intent/v0.2","request_id":"unsupported","op":"fold","params":{"slot_id":"slot"}})).await;
        ui.verdict("refused", Some("POLICY")).await;
        // A well-formed body sent by the wrong role also preserves the connection.
        agent.send(control("take_control")).await;
        agent.verdict("refused", Some("POLICY")).await;
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
        // Duplicate lifecycle creation is refused durably without retiring the daemon.
        daemon
            .send(
                json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface}}),
            )
            .await;
        daemon.verdict("refused", Some("POLICY")).await;
        let frame = SharedFrame::new();
        let f1 = frame.value(1);
        daemon.send(f1.clone()).await;
        assert!(matches!(ui.receive().await.body, Command::FrameRef(_)));
        // Unsupported executor actions are refused before any attempt is reserved.
        for (id, action) in [
            ("scroll-refused", json!({"type":"scroll","dx":0,"dy":1})),
            ("wait-refused", json!({"type":"wait","ms":1})),
        ] {
            let before: Value =
                serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
            let mut p = proposal(id, &f1);
            p["action"] = action;
            agent.send(p).await;
            agent.verdict("refused", Some("POLICY")).await;
            let after: Value =
                serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
            assert_eq!(before["leases"], after["leases"]);
            assert_eq!(before["remaining_budget"], after["remaining_budget"]);
        }
        agent.send(proposal("first", &f1)).await;
        agent.verdict("admitted", None).await;
        let input = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(input["op"], "input");
        assert_eq!(input["params"]["proposal_id"], "first");
        let mut receipt: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        receipt["verified"] = false.into();
        receipt["error"] = "native input failed; no post-input frame".into();
        receipt["proposal_id"] = "unknown".into();
        let before: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        daemon.send(receipt.clone()).await;
        daemon.verdict("refused", Some("POLICY")).await;
        let after: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        assert_eq!(before["leases"], after["leases"]);
        assert_eq!(before["remaining_budget"], after["remaining_budget"]);
        receipt["proposal_id"] = "first".into();
        receipt["after_frame"] = f1.clone();
        // An error can never be reported as verified, nor clear the live lease.
        receipt["verified"] = true.into();
        let before: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        daemon.send(receipt.clone()).await;
        daemon.verdict("refused", Some("POLICY")).await;
        let after: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        assert_eq!(before["leases"], after["leases"]);
        assert_eq!(before["remaining_budget"], after["remaining_budget"]);
        receipt["verified"] = false.into();
        daemon.send(receipt.clone()).await;
        let settled = serde_json::to_value(agent.receive().await.body).unwrap();
        assert_eq!(settled["verified"], false);
        assert_ne!(settled["error"], "");
        let state: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        assert_eq!(state["leases"], json!({}));
        agent.send(proposal("stale", &frame.value(2))).await;
        agent.verdict("refused", Some("STALE_FRAME")).await;
        daemon.send(frame.value(2)).await;
        ui.receive().await;
        agent.send(proposal("cancel", &frame.value(2))).await;
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
        // Daemon metadata must not undo a human takeover.
        daemon.send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface}})).await;
        ui.receive().await;
        agent.send(proposal("human-before-frame", &f1)).await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        // Release cannot bypass a dispatched action awaiting its receipt.
        ui.send(control("release_control")).await;
        ui.verdict("refused", Some("POLICY")).await;
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
        let drained = serde_json::to_value(agent.receive().await.body).unwrap();
        assert_eq!(drained["verified"], false);
        assert_ne!(drained["error"], "");
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
        let mut changed = surface.clone();
        changed["state"] = "lost".into();
        daemon.send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":changed}})).await;
        ui.receive().await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        agent.send(proposal("lost-surface", &frame.value(3))).await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        let mut settled: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        settled["proposal_id"] = "readmitted".into();
        daemon.send(settled).await;
        agent.receive().await;
        daemon.send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface}})).await;
        ui.receive().await;
        agent
            .send(proposal("updated-needs-frame", &frame.value(3)))
            .await;
        agent.verdict("refused", Some("STALE_FRAME")).await;
        daemon.send(frame.value(4)).await;
        ui.receive().await;
        agent
            .send(proposal("updated-admitted", &frame.value(4)))
            .await;
        agent.verdict("admitted", None).await;
        daemon.receive().await;
        let mut destroyed = surface.clone();
        destroyed["state"] = "destroyed".into();
        daemon.send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":destroyed}})).await;
        ui.receive().await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        agent
            .send(proposal("destroyed-surface", &frame.value(4)))
            .await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
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
        let mut malformed = Peer::connect(&socket, "ui").await;
        let mut env = PeerEnvelope::value();
        env["seq"] = 2.into();
        env["body"]["params"] = json!({});
        use tokio::io::AsyncWriteExt;
        malformed
            .socket
            .write_all(format!("{env}\n").as_bytes())
            .await
            .unwrap();
        let closed =
            tokio::time::timeout(Duration::from_secs(3), read_frame(&mut malformed.socket))
                .await
                .unwrap();
        assert!(!matches!(closed, Ok(Some(_))));
        assert_eq!(
            serde_json::from_slice::<Value>(&server.lock().unwrap().snapshot().unwrap()).unwrap()
                ["core_seq"],
            0
        );
        drop(malformed);
        task.abort();
        let _ = task.await;
        drop(server);
    });
}
#[test]
fn control_intents_are_closed_and_reject_malformed_params() {
    for op in ["take_control", "release_control"] {
        let mut p = PeerEnvelope::value();
        p["body"]["op"] = op.into();
        assert!(decode_envelope(&p.to_string()).is_ok());
        for params in [
            json!({}),
            json!({"surface_id":""}),
            json!({"surface_id":"s","owner":"human"}),
        ] {
            p["body"]["params"] = params;
            assert!(decode_envelope(&p.to_string()).is_err());
        }
    }
}
struct PeerEnvelope;
impl PeerEnvelope {
    fn value() -> Value {
        json!({"schema":"envelope/v0.2","msg_id":"control","ts_ns":0,"from":{"component":"ui","instance":"ui-test"},"to":{"component":"core","instance":"core-test"},"session_id":"serve-session","seq":1,"nonce":"control","body":{"schema":"ui_intent/v0.2","request_id":"control","op":"take_control","params":{"surface_id":"surface-demo"}}})
    }
}

fn tool_call(op: &str, args: Value) -> Value {
    json!({"schema":"mv_tool_call/v0.2","request_id":"body-request","op":op,"args":args})
}
async fn tool_result(peer: &mut Peer, op: &str, status: &str) -> Value {
    let expected = format!("agent-test-{}", peer.seq);
    let env = peer.receive().await;
    assert!(matches!(env.body, Command::MvToolResult(_)), "{env:?}");
    serve_v02_tags::assert_v02_output(&serde_json::to_value(&env).unwrap());
    let result = serde_json::to_value(env.body).unwrap();
    assert_eq!(result["request_id"], expected);
    assert_eq!(result["op"], op);
    assert_eq!(result["status"], status, "{result}");
    result
}
#[test]
fn agent_tools_observe_propose_and_wait_for_receipt() {
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
        agent
            .send(tool_call("observe", json!({"surface_id":"missing"})))
            .await;
        assert_eq!(
            tool_result(&mut agent, "observe", "error").await["code"],
            "NOT_FOUND"
        );
        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        assert_eq!(
            tool_result(&mut agent, "list", "ok").await["surfaces"],
            json!([])
        );
        let surface: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        for id in ["surface-demo", "surface-next"] {
            let mut s = surface.clone();
            s["surface_id"] = id.into();
            daemon
                .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":s}}))
                .await;
            ui.receive().await;
        }
        agent
            .send(tool_call("observe", json!({"surface_id":"surface-demo"})))
            .await;
        assert_eq!(
            tool_result(&mut agent, "observe", "error").await["code"],
            "UNAVAILABLE"
        );
        let frame = SharedFrame::new();
        let f = frame.value(1);
        daemon.send(f.clone()).await;
        ui.receive().await;
        agent
            .send(tool_call("observe", json!({"surface_id":"surface-demo"})))
            .await;
        let observed = tool_result(&mut agent, "observe", "ok").await;
        let expected = f.clone();
        assert_eq!(observed["observation"]["frame_ref"], expected);
        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        let page = tool_result(&mut agent, "list", "ok").await;
        assert_eq!(page["surfaces"].as_array().unwrap().len(), 1);
        assert_eq!(page["surfaces"][0]["profile_id"], surface["profile_id"]);
        assert_eq!(page["next_cursor"], "surface-demo");
        agent
            .send(tool_call(
                "list",
                json!({"cursor":page["next_cursor"],"limit":1}),
            ))
            .await;
        let page = tool_result(&mut agent, "list", "ok").await;
        assert_eq!(page["surfaces"][0]["surface_id"], "surface-next");
        assert!(page["next_cursor"].is_null());
        let mut p = proposal("tool-proposal", &f);
        // Bind the proposal to the observed frame rather than an out-of-band frame.
        p["based_on_frame"]["sha256"] = observed["observation"]["frame_ref"]["sha256"].clone();
        p["based_on_frame"]["generation"] =
            observed["observation"]["frame_ref"]["generation"].clone();
        agent
            .send(tool_call("propose", json!({"proposal":p})))
            .await;
        let admitted = tool_result(&mut agent, "propose", "admitted").await;
        assert_eq!(admitted["verdict"]["proposal_id"], "tool-proposal");
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap()["params"]["proposal_id"],
            "tool-proposal"
        );
        agent
            .send(tool_call(
                "wait_verify",
                json!({"proposal_id":"tool-proposal","timeout_ms":30}),
            ))
            .await;
        let timeout = tool_result(&mut agent, "wait_verify", "timeout").await;
        assert_eq!(timeout["verified"], false);
        agent
            .send(tool_call(
                "wait_verify",
                json!({"proposal_id":"tool-proposal","timeout_ms":1000}),
            ))
            .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(30), read_frame(&mut agent.socket))
                .await
                .is_err()
        );
        let mut receipt: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        receipt["verified"] = false.into();
        receipt["error"] = "native execution failed".into();
        receipt["proposal_id"] = "tool-proposal".into();
        receipt["after_frame"] = f.clone();
        daemon.send(receipt).await;
        assert!(matches!(
            agent.receive().await.body,
            Command::ActionReceipt(_)
        ));
        // Outcome verification alone is not focus proof. Missing evidence is never true.
        assert_eq!(
            tool_result(&mut agent, "wait_verify", "error").await["code"],
            "VERIFICATION_FAILED"
        );
        agent
            .send(tool_call(
                "wait_verify",
                json!({"proposal_id":"tool-proposal","timeout_ms":1000}),
            ))
            .await;
        assert_eq!(
            tool_result(&mut agent, "wait_verify", "error").await["code"],
            "VERIFICATION_FAILED"
        );
        agent
            .send(tool_call(
                "wait_verify",
                json!({"proposal_id":"unknown","timeout_ms":1}),
            ))
            .await;
        assert_eq!(
            tool_result(&mut agent, "wait_verify", "error").await["code"],
            "NOT_FOUND"
        );
        agent
            .send(tool_call(
                "propose",
                json!({"proposal":proposal("stale-tool", &frame.value(2))}),
            ))
            .await;
        assert_eq!(
            tool_result(&mut agent, "propose", "refused").await["reason_code"],
            "STALE_FRAME"
        );
        ui.send(control("take_control")).await;
        daemon.receive().await;
        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        assert_eq!(
            tool_result(&mut agent, "list", "ok").await["surfaces"][0]["control"],
            "human"
        );
        agent
            .send(tool_call(
                "propose",
                json!({"proposal":proposal("human-tool", &f)}),
            ))
            .await;
        assert_eq!(
            tool_result(&mut agent, "propose", "refused").await["reason_code"],
            "SURFACE_NOT_AGENT_CONTROLLED"
        );
        let snapshot = server.lock().unwrap().snapshot().unwrap();
        drop((daemon, agent, ui));
        tokio::time::sleep(Duration::from_millis(20)).await;
        task.abort();
        let _ = task.await;
        drop(server);
        let recovered = Server::open(config(), &temp.0.join("state"), uid).unwrap();
        assert_eq!(recovered.snapshot().unwrap(), snapshot);
        let listener = serve::bind(&socket, uid).await.unwrap();
        let recovered = Arc::new(Mutex::new(recovered));
        let task = tokio::spawn(serve::serve(listener, recovered, uid));
        // Resume above the persisted sender nonce/sequence rail.
        let mut agent = Peer {
            socket: UnixStream::connect(&socket).await.unwrap(),
            config: config(),
            registration: registration("agent"),
            seq: 100,
        };
        agent
            .send(serde_json::to_value(&agent.registration.hello).unwrap())
            .await;
        agent.receive().await;
        agent
            .send(tool_call("observe", json!({"surface_id":"surface-demo"})))
            .await;
        assert_eq!(
            tool_result(&mut agent, "observe", "ok").await["observation"]["frame_ref"],
            expected
        );
        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        assert_eq!(
            tool_result(&mut agent, "list", "ok").await["surfaces"][0]["control"],
            "human"
        );
        agent
            .send(tool_call(
                "wait_verify",
                json!({"proposal_id":"tool-proposal","timeout_ms":1}),
            ))
            .await;
        assert_eq!(
            tool_result(&mut agent, "wait_verify", "error").await["code"],
            "VERIFICATION_FAILED"
        );
        drop(agent);
        task.abort();
        let _ = task.await;
    });
}
#[test]
fn unknown_tool_operation_is_refused_by_closed_decoding() {
    let mut value = PeerEnvelope::value();
    value["from"] = json!({"component":"agent","instance":"agent-test"});
    value["body"] = tool_call("unknown", json!({}));
    assert!(matches!(
        decode_envelope(&value.to_string()),
        Err(DecodeError::Malformed)
    ));
    for (op, args) in [
        ("observe", json!({"surface_id":"s"})),
        ("list", json!({"cursor":null,"limit":1})),
    ] {
        value["body"] = tool_call(op, args);
        assert!(decode_envelope(&value.to_string()).is_ok());
    }
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        let mut agent = Peer::connect(&socket, "agent").await;
        agent
            .send(tool_call("observe", json!({"surface_id":"missing"})))
            .await;
        assert_eq!(
            tool_result(&mut agent, "observe", "error").await["code"],
            "NOT_FOUND"
        );
        let snapshot = server.lock().unwrap().snapshot().unwrap();
        let mut unknown = serde_json::to_value(
            agent.envelope(tool_call("list", json!({"cursor":null,"limit":1}))),
        )
        .unwrap();
        unknown["seq"] = (agent.seq + 1).into();
        unknown["nonce"] = "unknown-tool".into();
        unknown["body"]["op"] = "unknown".into();
        use tokio::io::AsyncWriteExt;
        agent
            .socket
            .write_all(format!("{unknown}\n").as_bytes())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), read_frame(&mut agent.socket))
                .await
                .unwrap()
                .unwrap()
                .is_none()
        );
        assert_eq!(server.lock().unwrap().snapshot().unwrap(), snapshot);
        drop(agent);
        task.abort();
        let _ = task.await;
        drop(server);
    });
}
