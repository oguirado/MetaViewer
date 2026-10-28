#![forbid(unsafe_code)]
mod support;

use metaviewer_core::journal::scan;
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::{decode_envelope, read_frame, write_frame, Command, DecodeError, Envelope};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixStream;

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({
        "endpoint": {"component": component, "instance": format!("{component}-layout")},
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

fn config(session_id: &str) -> Config {
    Config {
        session_id: session_id.into(),
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
    async fn connect(path: &Path, session_id: &str, component: &str) -> Self {
        let mut peer = Self {
            socket: UnixStream::connect(path).await.unwrap(),
            config: config(session_id),
            registration: registration(component),
            seq: 0,
        };
        peer.send(serde_json::to_value(&peer.registration.hello).unwrap())
            .await;
        let hello = peer.receive().await;
        assert!(matches!(hello.body, Command::Hello(_)));
        peer
    }

    fn envelope(&self, seq: u64, body: Value) -> Envelope {
        decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": format!("{}-{seq}", self.registration.endpoint.instance),
                "ts_ns": 0,
                "from": self.registration.endpoint,
                "to": self.config.core.endpoint,
                "session_id": self.config.session_id,
                "seq": seq,
                "nonce": format!("{}-{seq}", self.registration.endpoint.instance),
                "body": body
            })
            .to_string(),
        )
        .unwrap()
    }

    async fn send(&mut self, body: Value) {
        self.seq += 1;
        let env = self.envelope(self.seq, body);
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

    async fn assert_quiet(&mut self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(40), read_frame(&mut self.socket))
                .await
                .is_err(),
            "expected no frame on {} socket",
            self.registration.endpoint.instance
        );
    }
}

fn layout_ops() -> Vec<(&'static str, Value)> {
    vec![
        ("fold", json!({"slot_id": "surface-demo"})),
        ("unfold", json!({"slot_id": "surface-demo"})),
        (
            "move",
            json!({"slot_id": "surface-demo", "group_id": "group-main", "index": 0}),
        ),
        (
            "tab",
            json!({"slot_id": "surface-demo", "group_id": "group-tabs", "index": 255}),
        ),
        (
            "float",
            json!({"slot_id": "surface-demo", "x_px": 0, "y_px": 16383, "width_px": 16384, "height_px": 1}),
        ),
        ("hide", json!({"slot_id": "cuk-ai-slot-surface-demo"})),
        ("show", json!({"slot_id": "surface-demo"})),
    ]
}

#[test]
fn layout_ops_route_with_daemon_connected_and_discriminate_unsupported_ops() {
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let state_dir = temp.0.join("state");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config("layout-connected"), &state_dir, uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "layout-connected", "daemon").await;
        let mut agent = Peer::connect(&socket, "layout-connected", "agent").await;
        let mut ui = Peer::connect(&socket, "layout-connected", "ui").await;

        // Register agent as a lifecycle observer so fanout reaches both UI and agent.
        let list_req = json!({"schema": "surface_request/v0.2", "op": "list", "params": {}});
        agent.send(list_req.clone()).await;
        assert_eq!(daemon.receive_json().await, list_req);

        let surface: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": surface}
            }))
            .await;
        assert_eq!(ui.receive_json().await["event"], "created");
        assert_eq!(agent.receive_json().await["event"], "created");

        // Take human control so placement writes (move/tab/float/hide/show) are permitted;
        // verify daemon receives the forwarded take_control surface_request.
        ui.send(json!({
            "schema": "ui_intent/v0.2",
            "request_id": "take-human",
            "op": "take_control",
            "params": {"surface_id": "surface-demo"}
        }))
        .await;
        assert_eq!(
            daemon.receive_json().await,
            json!({
                "schema": "surface_request/v0.2",
                "op": "take_control",
                "params": {"surface_id": "surface-demo", "owner": "human"}
            })
        );

        // Goal 1: route each of the 7 layout ops through serve with daemon connected;
        // assert journal commit (SurfaceNotice) and typed fanout for every op.
        for (op, params) in layout_ops() {
            let before_seq =
                serde_json::from_slice::<Value>(&server.lock().unwrap().snapshot().unwrap())
                    .unwrap()["core_seq"]
                    .as_u64()
                    .unwrap();

            let req_id = format!("req-{op}");
            let intent = json!({
                "schema": "ui_intent/v0.2",
                "request_id": req_id,
                "op": op,
                "params": params
            });
            ui.send(intent.clone()).await;

            let ui_out = ui.receive_json().await;
            let agent_out = agent.receive_json().await;
            assert_eq!(ui_out, agent_out, "observer fanout mismatch on {op}");

            if matches!(op, "fold" | "unfold") {
                let expected_vis = if op == "fold" { "folded" } else { "unfolded" };
                assert_eq!(ui_out["schema"], "surface_event/v0.2", "{op}");
                assert_eq!(ui_out["event"], "state_changed", "{op}");
                assert_eq!(ui_out["data"]["surface"]["surface_id"], "surface-demo");
                assert_eq!(ui_out["data"]["surface"]["visibility"], expected_vis);
                assert_eq!(ui_out["data"]["surface"]["control"], "human");
            } else {
                assert_eq!(
                    ui_out, intent,
                    "extended layout op {op} must fan out unchanged"
                );
            }

            let after_seq =
                serde_json::from_slice::<Value>(&server.lock().unwrap().snapshot().unwrap())
                    .unwrap()["core_seq"]
                    .as_u64()
                    .unwrap();
            assert_eq!(
                after_seq,
                before_seq + 1,
                "{op} must commit one journal entry"
            );
        }
        daemon.assert_quiet().await;

        // Goal 3 (Negative control): unrouted/unknown ops in the same harness hit the unsupported arm
        // (journalled POLICY refusal verdict, no layout fanout, no daemon forward), proving discrimination.
        for (bad_op, bad_params) in [
            ("pin", json!({"slot_id": "surface-demo", "pinned": true})),
            ("layout_save", json!({"layout_id": "default"})),
            ("layout_load", json!({"layout_id": "default"})),
        ] {
            let before_seq =
                serde_json::from_slice::<Value>(&server.lock().unwrap().snapshot().unwrap())
                    .unwrap()["core_seq"]
                    .as_u64()
                    .unwrap();
            let req_id = format!("unsupported-{bad_op}");
            ui.send(json!({
                "schema": "ui_intent/v0.2",
                "request_id": req_id,
                "op": bad_op,
                "params": bad_params
            }))
            .await;
            let verdict = ui.receive_json().await;
            assert_eq!(
                verdict,
                json!({
                    "schema": "action_verdict/v0.2",
                    "proposal_id": req_id,
                    "decision": "refused",
                    "reason_code": "POLICY",
                    "core_seq": before_seq + 1
                }),
                "unrouted op {bad_op} must hit unsupported_at"
            );
            agent.assert_quiet().await;
            daemon.assert_quiet().await;
        }

        // Completely unknown op outside ui_intent/v0.2 is rejected by closed envelope decoding.
        let mut raw_unknown = serde_json::to_value(ui.envelope(
            ui.seq + 1,
            json!({
                "schema": "ui_intent/v0.2",
                "request_id": "req-fold",
                "op": "fold",
                "params": {"slot_id": "surface-demo"}
            }),
        ))
        .unwrap();
        raw_unknown["body"]["op"] = "unknown_layout_op".into();
        assert!(matches!(
            decode_envelope(&raw_unknown.to_string()),
            Err(DecodeError::Malformed)
        ));

        let session_root = state_dir.join("sessions/layout-connected");
        let replayed = scan(&session_root.join("journal.jsonl"), &session_root).unwrap();
        assert_eq!(
            replayed.state.snapshot().unwrap(),
            server.lock().unwrap().snapshot().unwrap()
        );

        drop((daemon, agent, ui));
        task.abort();
        let _ = task.await;
    });
}

#[test]
fn layout_ops_without_daemon_return_typed_refusals_and_never_forward() {
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let state_dir = temp.0.join("state");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config("layout-disconnected"), &state_dir, uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        // Goal 2: daemon is disconnected (never connected). Route all 7 layout ops through serve.
        let mut ui = Peer::connect(&socket, "layout-disconnected", "ui").await;

        for (op, params) in layout_ops() {
            let before_seq =
                serde_json::from_slice::<Value>(&server.lock().unwrap().snapshot().unwrap())
                    .unwrap()["core_seq"]
                    .as_u64()
                    .unwrap();

            let req_id = format!("no-daemon-{op}");
            let slot_id = params["slot_id"].as_str().unwrap().to_owned();
            ui.send(json!({
                "schema": "ui_intent/v0.2",
                "request_id": req_id,
                "op": op,
                "params": params
            }))
            .await;

            let verdict = ui.receive_json().await;
            assert_eq!(
                verdict,
                json!({
                    "schema": "action_verdict/v0.2",
                    "proposal_id": req_id,
                    "decision": "refused",
                    "reason_code": "POLICY",
                    "core_seq": before_seq + 1
                }),
                "disconnected-daemon {op} must journal and return POLICY refusal"
            );

            if !matches!(op, "fold" | "unfold") {
                let err_event = ui.receive_json().await;
                assert_eq!(
                    err_event,
                    json!({
                        "schema": "surface_event/v0.2",
                        "event": "error",
                        "data": {
                            "surface_id": slot_id,
                            "code": "LAYOUT_UNKNOWN_SLOT",
                            "detail": req_id
                        }
                    }),
                    "extended op {op} without live surface must emit LAYOUT_UNKNOWN_SLOT"
                );
            }
            ui.assert_quiet().await;
        }

        let session_root = state_dir.join("sessions/layout-disconnected");
        let replayed = scan(&session_root.join("journal.jsonl"), &session_root).unwrap();
        assert_eq!(replayed.state.core_seq, 7);
        assert_eq!(
            replayed.state.snapshot().unwrap(),
            server.lock().unwrap().snapshot().unwrap()
        );

        drop(ui);
        task.abort();
        let _ = task.await;
    });
}
