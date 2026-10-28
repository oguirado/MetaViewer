#![forbid(unsafe_code)]
mod support;

use metaviewer_core::admission::{
    AdmissionRequest, Authority, CoreState, Frame, Input, LifecycleUpdate, Surface,
};
use metaviewer_core::journal::sha256_hex;
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixStream;

fn unit_surface() -> Surface {
    Surface {
        display: "display-1".into(),
        owner: Endpoint {
            component: Component::Agent,
            instance: "agent-1".into(),
        },
        agent_controlled: true,
        live: true,
        frame: None,
        refresh_after: None,
        allowed_verbs: vec!["advance".into()],
    }
}

fn lifecycle(update: LifecycleUpdate) -> Input {
    Input::Lifecycle {
        surface_id: "surface-1".into(),
        update,
    }
}

fn proposal_raw_and_request(frame_sha: &str) -> (String, AdmissionRequest) {
    let raw = json!({
        "schema": "envelope/v0.2",
        "msg_id": "message-1",
        "session_id": "mut-lost-session",
        "ts_ns": 0,
        "from": unit_surface().owner,
        "to": {"component": "core", "instance": "core-1"},
        "nonce": "nonce-1",
        "seq": 1,
        "body": {
            "schema": "action_proposal/v0.2",
            "proposal_id": "proposal-1",
            "surface_id": "surface-1",
            "based_on_frame": {"generation": 1, "sha256": frame_sha},
            "action": {"type": "click", "x": 3, "y": 4, "button": "left"},
            "expectation": {"type": "text_present", "text": "ready"},
            "budget": {"max_ms": 100, "max_retries": 1}
        }
    })
    .to_string();
    let req =
        AdmissionRequest::decode(&raw, &unit_surface().owner, "mut-lost-session", 1, 0).unwrap();
    (raw, req)
}

#[test]
fn duplicate_lost_returns_policy_and_leaves_state_untouched() {
    // Mutation: core/src/admission/mod.rs:387 delete the `if !old.live` guard
    // so a second Lost succeeds instead of returning Policy.
    let temp = support::Temp::new();
    let state_dir = temp.0.join("state");
    let initial = CoreState::new("mut-lost-session", 10).unwrap();
    let mut auth = Authority::create(&state_dir, initial).unwrap();

    auth.apply(Input::Connect).unwrap();
    auth.apply(lifecycle(LifecycleUpdate::Created(unit_surface())))
        .unwrap();
    let pixels = b"pixels";
    let frame_sha = sha256_hex(pixels);
    let f1 = Frame {
        sha256: frame_sha.clone(),
        generation: 1,
        width: 10,
        height: 10,
    };
    let frame_witness = metaviewer_core::journal::VerifiedPixels::from_bytes(pixels.to_vec())
        .unwrap()
        .retain_in_authority(&mut auth)
        .unwrap();
    auth.apply_with_witnesses(
        Input::Frame {
            surface_id: "surface-1".into(),
            frame: f1.clone(),
        },
        vec![frame_witness.clone()],
    )
    .unwrap();
    let (raw_prop, req_prop) = proposal_raw_and_request(&frame_sha);
    let prop_witness = auth.retain_witness(raw_prop.as_bytes()).unwrap();
    assert_eq!(
        auth.apply_with_witnesses(Input::Propose(req_prop), vec![prop_witness, frame_witness])
            .unwrap()
            .reason,
        None
    );
    assert!(
        auth.apply(Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 1,
        })
        .unwrap()
        .dispatch
    );

    let out1 = auth.apply(lifecycle(LifecycleUpdate::Lost)).unwrap();
    assert_eq!(out1.reason, None);
    assert!(!auth.state().surfaces["surface-1"].live);
    assert_eq!(
        auth.state().surfaces["surface-1"].refresh_after,
        Some(out1.core_seq)
    );

    let snapshot_after_first = auth.state().domain_snapshot().unwrap();
    let frame_after_first = auth.state().surfaces["surface-1"].frame.clone();
    let fence_after_first = auth.state().surfaces["surface-1"].refresh_after;
    let leases_after_first = auth.state().leases.clone();
    let draining_after_first = auth.state().draining.clone();
    assert_eq!(frame_after_first, Some(f1));
    assert!(fence_after_first.is_some());

    let out2 = auth.apply(lifecycle(LifecycleUpdate::Lost)).unwrap();
    assert_eq!(out2.reason, Some(Refusal::Policy));
    assert!(out2.cancelled.is_empty());
    assert_eq!(out2.cancellation_reason, None);
    assert_eq!(auth.state().surfaces["surface-1"].frame, frame_after_first);
    assert_eq!(
        auth.state().surfaces["surface-1"].refresh_after,
        fence_after_first
    );
    assert_eq!(auth.state().leases, leases_after_first);
    assert_eq!(auth.state().draining, draining_after_first);
    assert_eq!(
        auth.state().domain_snapshot().unwrap(),
        snapshot_after_first
    );

    auth.flush_sync().unwrap();
    drop(auth);
    let root = state_dir.join("sessions/mut-lost-session");
    let mut recovered = Authority::recover(&root.join("journal.jsonl"), &root).unwrap();
    assert_eq!(
        recovered.state().domain_snapshot().unwrap(),
        snapshot_after_first
    );

    let out3 = recovered.apply(lifecycle(LifecycleUpdate::Lost)).unwrap();
    assert_eq!(out3.reason, Some(Refusal::Policy));
    assert!(out3.cancelled.is_empty());
    assert_eq!(out3.cancellation_reason, None);
    assert_eq!(
        recovered.state().surfaces["surface-1"].frame,
        frame_after_first
    );
    assert_eq!(
        recovered.state().surfaces["surface-1"].refresh_after,
        fence_after_first
    );
    assert_eq!(recovered.state().leases, leases_after_first);
    assert_eq!(recovered.state().draining, draining_after_first);
    assert_eq!(
        recovered.state().domain_snapshot().unwrap(),
        snapshot_after_first
    );
}

#[test]
fn lost_releases_undispatched_permits_without_draining_entries() {
    // Mutation: core/src/admission/mod.rs:621 force the draining insert for
    // undispatched/unknown-false pending so undispatched permits leak into draining with leases held.
    let mut state = CoreState::new("mut-lost-session", 10).unwrap();
    state.apply(&Input::Connect).unwrap();
    state
        .apply(&lifecycle(LifecycleUpdate::Created(unit_surface())))
        .unwrap();
    state
        .apply(&Input::Frame {
            surface_id: "surface-1".into(),
            frame: Frame {
                sha256: "a".repeat(64),
                generation: 1,
                width: 10,
                height: 10,
            },
        })
        .unwrap();
    let (_, req_prop) = proposal_raw_and_request(&"a".repeat(64));
    assert_eq!(state.apply(&Input::Propose(req_prop)).unwrap().reason, None);
    assert!(state.pending.contains_key("proposal-1"));
    assert_eq!(state.leases.get("surface-1"), Some(&"proposal-1".into()));

    let out = state.apply(&lifecycle(LifecycleUpdate::Lost)).unwrap();
    assert_eq!(out.reason, None);
    assert_eq!(out.cancelled, ["proposal-1"]);
    assert_eq!(
        out.cancellation_reason,
        Some(Refusal::SurfaceNotAgentControlled)
    );
    assert!(state.pending.is_empty());
    assert!(state.draining.is_empty());
    assert!(!state.leases.contains_key("surface-1"));

    let drain_out = state
        .apply(&Input::Drain {
            proposal_id: "proposal-1".into(),
            epoch: 1,
        })
        .unwrap();
    assert_eq!(drain_out.reason, Some(Refusal::Policy));
}

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

fn serve_config() -> Config {
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
    nonce_prefix: String,
}

impl Peer {
    async fn connect(path: &std::path::Path, component: &str) -> Self {
        Self::connect_with_prefix(path, component, None).await
    }

    async fn reconnect(path: &std::path::Path, component: &str, gen: u64) -> Self {
        let reg = registration(component);
        let prefix = format!("{}-g{gen}", reg.endpoint.instance);
        Self::connect_with_prefix(path, component, Some(prefix)).await
    }

    async fn connect_with_prefix(
        path: &std::path::Path,
        component: &str,
        prefix: Option<String>,
    ) -> Self {
        let reg = registration(component);
        let nonce_prefix = prefix.unwrap_or_else(|| reg.endpoint.instance.clone());
        let mut p = Self {
            socket: UnixStream::connect(path).await.unwrap(),
            config: serve_config(),
            registration: reg,
            seq: 0,
            nonce_prefix,
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
                "msg_id": format!("{}-{}", self.nonce_prefix, self.seq),
                "ts_ns": 0,
                "from": self.registration.endpoint,
                "to": self.config.core.endpoint,
                "session_id": self.config.session_id,
                "seq": self.seq,
                "nonce": format!("{}-{}", self.nonce_prefix, self.seq),
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
}

struct SharedFrame(std::path::PathBuf);

impl SharedFrame {
    const WIDTH: u64 = 100;
    const HEIGHT: u64 = 60;
    const BYTES: usize = (Self::WIDTH as usize) * (Self::HEIGHT as usize) * 3;

    fn new() -> Self {
        use std::os::unix::fs::OpenOptionsExt;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::path::PathBuf::from(format!(
            "/dev/shm/mv-mut-lost-{}-{}-frame",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut file, &vec![b'f'; Self::BYTES]).unwrap();
        Self(path)
    }

    fn value(&self, generation: u64) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        value["width"] = Self::WIDTH.into();
        value["height"] = Self::HEIGHT.into();
        value["sha256"] = sha256_hex(&vec![b'f'; Self::BYTES]).into();
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

fn wire_surface() -> Value {
    serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap()
}

#[test]
fn daemon_destroyed_clears_pending_human_input_silently() {
    // Mutation: core/src/serve/mod.rs:1284 delete the `SurfaceState::Destroyed`
    // retain arm so daemon-destroyed leaves human_inputs pending.
    support::run(async {
        let temp = support::Temp::new();
        let socket = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(serve_config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = Peer::connect(&socket, "daemon").await;
        let _agent = Peer::connect(&socket, "agent").await;
        let mut ui = Peer::connect(&socket, "ui").await;

        let created = json!({
            "schema": "surface_event/v0.2",
            "event": "created",
            "data": {"surface": wire_surface()}
        });
        daemon.send(created).await;
        let _ = ui.receive().await;

        let shared = SharedFrame::new();
        let frame1 = shared.value(1);
        daemon.send(frame1.clone()).await;
        let _ = ui.receive().await;

        ui.send(json!({
            "schema": "ui_intent/v0.2",
            "request_id": "control-take",
            "op": "take_control",
            "params": {"surface_id": "surface-demo"}
        }))
        .await;
        let take_fwd = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(take_fwd["op"], "take_control");

        for pid in ["hi-destroyed-live", "hi-destroyed-reopen"] {
            ui.send(json!({
                "schema": "surface_request/v0.2",
                "op": "input",
                "params": {
                    "surface_id": "surface-demo",
                    "proposal_id": pid,
                    "origin": "human",
                    "action": {"type": "key", "keys": ["Return"]}
                }
            }))
            .await;
            let forwarded = serde_json::to_value(daemon.receive().await.body).unwrap();
            assert_eq!(forwarded["op"], "input");
            assert_eq!(forwarded["params"]["proposal_id"], pid);
        }

        let mut dead = wire_surface();
        dead["state"] = "destroyed".into();
        dead["control"] = "human".into();
        daemon
            .send(json!({
                "schema": "surface_event/v0.2",
                "event": "state_changed",
                "data": {"surface": dead}
            }))
            .await;

        let ui_ev = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(ui_ev["schema"], "surface_event/v0.2");
        assert_eq!(ui_ev["event"], "state_changed");
        assert_eq!(ui_ev["data"]["surface"]["state"], "destroyed");

        // UI receives state_changed only, no action_verdict for the human proposals.
        // Prove human_inputs is empty in live server: a late daemon ActionReceipt for
        // "hi-destroyed-live" must be refused to daemon with POLICY (unknown proposal)
        // rather than settling a pending human input to UI.
        let mut receipt_live: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        receipt_live["proposal_id"] = "hi-destroyed-live".into();
        receipt_live["verified"] = false.into();
        receipt_live["error"] = "".into();
        daemon.send(receipt_live).await;
        daemon
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "daemon-barrier-live",
                "op": "list",
                "args": {"cursor": null, "limit": 1}
            }))
            .await;
        let daemon_reply = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(daemon_reply["schema"], "action_verdict/v0.2");
        assert_eq!(
            daemon_reply["proposal_id"], "hi-destroyed-live",
            "pending human input on destroyed surface must be cleared so late receipt is refused to daemon"
        );
        assert_eq!(daemon_reply["decision"], "refused");
        assert_eq!(daemon_reply["reason_code"], "POLICY");
        let daemon_barrier_reply = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(daemon_barrier_reply["proposal_id"], "daemon-barrier-live");
        assert_eq!(daemon_barrier_reply["decision"], "refused");
        assert_eq!(daemon_barrier_reply["reason_code"], "POLICY");

        // Barrier on UI confirms no action_verdict was queued to UI for either human proposal.
        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "destroy",
            "params": {"surface_id": "surface-demo"}
        }))
        .await;
        let ui_barrier_id = format!("ui-test-{}", ui.seq);
        let ui_next = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(ui_next["schema"], "action_verdict/v0.2");
        assert_eq!(ui_next["proposal_id"], ui_barrier_id);
        assert_eq!(ui_next["decision"], "refused");
        assert_eq!(ui_next["reason_code"], "POLICY");

        task.abort();
        let _ = task.await;
        drop((daemon, _agent, ui));
        tokio::time::timeout(Duration::from_secs(2), async {
            while Arc::strong_count(&server) != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("connection tasks must release server");
        drop(server);

        // Reopen server and verify "hi-destroyed-reopen" does not resurrect on recovery.
        let socket2 = temp.0.join("runtime/core2.sock");
        let listener2 = serve::bind(&socket2, uid).await.unwrap();
        let reopened = Arc::new(Mutex::new(
            Server::open(serve_config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task2 = tokio::spawn(serve::serve(listener2, reopened.clone(), uid));

        let mut daemon2 = Peer::reconnect(&socket2, "daemon", 2).await;
        let mut ui2 = Peer::reconnect(&socket2, "ui", 2).await;

        let mut receipt_reopen: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        receipt_reopen["proposal_id"] = "hi-destroyed-reopen".into();
        receipt_reopen["verified"] = false.into();
        receipt_reopen["error"] = "".into();
        daemon2.send(receipt_reopen).await;
        daemon2
            .send(json!({
                "schema": "mv_tool_call/v0.2",
                "request_id": "daemon-barrier-reopen",
                "op": "list",
                "args": {"cursor": null, "limit": 1}
            }))
            .await;
        let daemon2_reply = serde_json::to_value(daemon2.receive().await.body).unwrap();
        assert_eq!(daemon2_reply["schema"], "action_verdict/v0.2");
        assert_eq!(
            daemon2_reply["proposal_id"], "hi-destroyed-reopen",
            "reopened server must not resurrect human input on destroyed surface"
        );
        assert_eq!(daemon2_reply["decision"], "refused");
        assert_eq!(daemon2_reply["reason_code"], "POLICY");
        let daemon2_barrier_reply = serde_json::to_value(daemon2.receive().await.body).unwrap();
        assert_eq!(
            daemon2_barrier_reply["proposal_id"],
            "daemon-barrier-reopen"
        );
        assert_eq!(daemon2_barrier_reply["decision"], "refused");
        assert_eq!(daemon2_barrier_reply["reason_code"], "POLICY");

        ui2.send(json!({
            "schema": "surface_request/v0.2",
            "op": "destroy",
            "params": {"surface_id": "surface-demo"}
        }))
        .await;
        let ui2_barrier_id = format!("ui-test-g2-{}", ui2.seq);
        let ui2_next = serde_json::to_value(ui2.receive().await.body).unwrap();
        assert_eq!(ui2_next["schema"], "action_verdict/v0.2");
        assert_eq!(ui2_next["proposal_id"], ui2_barrier_id);
        assert_eq!(ui2_next["decision"], "refused");
        assert_eq!(ui2_next["reason_code"], "POLICY");

        drop((daemon2, ui2));
        task2.abort();
        let _ = task2.await;
    });
}
