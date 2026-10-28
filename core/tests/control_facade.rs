#![forbid(unsafe_code)]
use metaviewer_core::admission::{Authority, CoreState, Frame, Input, Surface};
use metaviewer_core::control::publish_frame;
use metaviewer_core::journal::Witness;
use metaviewer_core::{Component, Endpoint, Refusal};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

mod support;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn fixture() -> (Authority, Root, Frame, Witness) {
    let root = Root(std::env::temp_dir().join(format!(
        "control-facade-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root.0)
        .unwrap();
    let mut authority =
        Authority::create(&root.0, CoreState::session("control-facade").unwrap()).unwrap();
    authority
        .apply(Input::Surface {
            id: "surface".into(),
            surface: Surface {
                display: "display".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent".into(),
                },
                live: true,
                agent_controlled: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        })
        .unwrap();
    let witness = authority.retain_witness(b"frame").unwrap();
    let frame = Frame {
        generation: 1,
        sha256: witness.sha256.clone(),
        width: 10,
        height: 10,
    };
    publish_frame(
        &mut authority,
        "surface",
        frame.clone(),
        vec![witness.clone()],
    )
    .unwrap();
    (authority, root, frame, witness)
}

fn assert_recovered(authority: Authority, root: &Root) {
    let expected = authority.state().clone();
    drop(authority);
    let path = root.0.join("sessions/control-facade/journal.jsonl");
    let recovered = Authority::recover(&path, path.parent().unwrap()).unwrap();
    assert_eq!(recovered.state(), &expected);
}

#[test]
fn every_frame_validation_rejection_is_a_durable_refusal() {
    let (mut authority, root, frame, witness) = fixture();
    let mut candidates = Vec::new();
    for sha256 in ["zz".into(), "A".repeat(64), "a".repeat(63), "g".repeat(64)] {
        candidates.push(Frame {
            generation: 2,
            sha256,
            ..frame.clone()
        });
    }
    candidates.push(Frame {
        generation: 2,
        width: 0,
        ..frame.clone()
    });
    candidates.push(Frame {
        generation: 2,
        height: 0,
        ..frame.clone()
    });
    for candidate in candidates {
        let before = authority.state().clone();
        let out =
            publish_frame(&mut authority, "surface", candidate, vec![witness.clone()]).unwrap();
        assert_eq!(out.reason, Some(Refusal::Policy));
        let mut expected = before;
        expected.core_seq += 1;
        assert_eq!(authority.state(), &expected);
    }
    for generation in [0, 1] {
        let before = authority.state().core_seq;
        let out = publish_frame(
            &mut authority,
            "surface",
            Frame {
                generation,
                ..frame.clone()
            },
            vec![witness.clone()],
        )
        .unwrap();
        assert_eq!(out.reason, Some(Refusal::StaleFrame));
        assert_eq!(out.core_seq, before + 1);
    }
    // Negative control: valid newer frames still publish and survive replay.
    let newer = Frame {
        generation: 2,
        ..frame
    };
    assert_eq!(
        publish_frame(&mut authority, "surface", newer.clone(), vec![witness])
            .unwrap()
            .reason,
        None
    );
    assert_eq!(authority.state().surfaces["surface"].frame, Some(newer));
    assert_recovered(authority, &root);
}

#[test]
fn non_witness_publication_rejection_is_journalled() {
    let (mut authority, root, frame, witness) = fixture();
    let before = authority.state().clone();
    // Exceed the archive's 64 MiB [CITED: journal::MAX_BYTES] event cap before
    // witness verification, while leaving capacity for a small refusal record.
    let oversized = Witness {
        sha256: "a".repeat(64 * 1024 * 1024),
        byte_len: 1,
    };
    let out = publish_frame(
        &mut authority,
        "surface",
        Frame {
            generation: 2,
            ..frame
        },
        vec![witness, oversized],
    )
    .unwrap();
    assert_eq!(out.reason, Some(Refusal::Policy));
    let mut expected = before;
    expected.core_seq += 1;
    assert_eq!(authority.state(), &expected);
    assert_recovered(authority, &root);
}

#[test]
fn serve_forwards_human_control_owner() {
    use metaviewer_core::serve::{self, Config, Registration, Server};
    use metaviewer_core::{decode_envelope, read_frame, write_frame};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::net::UnixStream;

    fn registration(component: &str) -> Registration {
        serde_json::from_value(json!({"endpoint":{"component":component,"instance":component},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
    }
    async fn send(socket: &mut UnixStream, component: &str, seq: u64, body: Value) {
        let envelope = decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":format!("{component}-{seq}"),"session_id":"control-serve","ts_ns":0,"from":{"component":component,"instance":component},"to":{"component":"core","instance":"core"},"nonce":format!("{component}-{seq}"),"seq":seq,"body":body}).to_string()).unwrap();
        write_frame(socket, &envelope).await.unwrap();
    }
    async fn receive(socket: &mut UnixStream) -> Value {
        let envelope = tokio::time::timeout(Duration::from_secs(3), read_frame(socket))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::to_value(envelope.body).unwrap()
    }

    support::run(async {
        let root = support::Temp::new();
        let socket = root.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(
                Config {
                    session_id: "control-serve".into(),
                    core: registration("core"),
                    peers: vec![
                        registration("daemon"),
                        registration("agent"),
                        registration("ui"),
                    ],
                },
                &root.0.join("state"),
                uid,
            )
            .unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        let mut daemon = UnixStream::connect(&socket).await.unwrap();
        send(
            &mut daemon,
            "daemon",
            1,
            serde_json::to_value(registration("daemon").hello).unwrap(),
        )
        .await;
        assert_eq!(receive(&mut daemon).await["schema"], "hello/v0.2");
        let mut ui = UnixStream::connect(&socket).await.unwrap();
        send(
            &mut ui,
            "ui",
            1,
            serde_json::to_value(registration("ui").hello).unwrap(),
        )
        .await;
        assert_eq!(receive(&mut ui).await["schema"], "hello/v0.2");
        let surface: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        send(
            &mut daemon,
            "daemon",
            2,
            json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface}}),
        )
        .await;
        receive(&mut ui).await;
        send(&mut ui, "ui", 2, json!({"schema":"ui_intent/v0.2","request_id":"take","op":"take_control","params":{"surface_id":"surface-demo"}})).await;
        assert_eq!(
            receive(&mut daemon).await,
            json!({"schema":"surface_request/v0.2","op":"take_control","params":{"surface_id":"surface-demo","owner":"human"}})
        );
        drop((daemon, ui));
        task.abort();
        let _ = task.await;
    });
}

#[test]
fn serve_release_when_agent_controlled_commits_and_forwards_only_on_admission() {
    use metaviewer_core::journal::scan;
    use metaviewer_core::serve::{self, Config, Registration, Server};
    use metaviewer_core::{decode_envelope, read_frame, write_frame};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::net::UnixStream;

    fn registration(component: &str) -> Registration {
        serde_json::from_value(json!({"endpoint":{"component":component,"instance":component},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
    }
    async fn send(socket: &mut UnixStream, component: &str, seq: u64, body: Value) {
        let envelope = decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":format!("{component}-{seq}"),"session_id":"control-release-agent","ts_ns":0,"from":{"component":component,"instance":component},"to":{"component":"core","instance":"core"},"nonce":format!("{component}-{seq}"),"seq":seq,"body":body}).to_string()).unwrap();
        write_frame(socket, &envelope).await.unwrap();
    }
    async fn receive(socket: &mut UnixStream) -> Value {
        let envelope = tokio::time::timeout(Duration::from_secs(3), read_frame(socket))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::to_value(envelope.body).unwrap()
    }

    support::run(async {
        let root = support::Temp::new();
        let socket = root.0.join("runtime/core.sock");
        let state_dir = root.0.join("state");
        let uid = support::uid();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(
                Config {
                    session_id: "control-release-agent".into(),
                    core: registration("core"),
                    peers: vec![
                        registration("daemon"),
                        registration("agent"),
                        registration("ui"),
                    ],
                },
                &state_dir,
                uid,
            )
            .unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

        let mut daemon = UnixStream::connect(&socket).await.unwrap();
        send(
            &mut daemon,
            "daemon",
            1,
            serde_json::to_value(registration("daemon").hello).unwrap(),
        )
        .await;
        assert_eq!(receive(&mut daemon).await["schema"], "hello/v0.2");

        let mut ui = UnixStream::connect(&socket).await.unwrap();
        send(
            &mut ui,
            "ui",
            1,
            serde_json::to_value(registration("ui").hello).unwrap(),
        )
        .await;
        assert_eq!(receive(&mut ui).await["schema"], "hello/v0.2");

        let surface: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        assert_eq!(surface["control"], "agent");
        send(
            &mut daemon,
            "daemon",
            2,
            json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface}}),
        )
        .await;
        assert_eq!(receive(&mut ui).await["event"], "created");

        let before: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        let seq_before = before["core_seq"].as_u64().unwrap();
        assert_eq!(
            before["surfaces"]["surface-demo"]["agent_controlled"],
            json!(true)
        );
        assert!(before["surfaces"]["surface-demo"]["refresh_after"].is_null());

        // 1. Release on an already agent-controlled surface succeeds in production,
        // advances the journal by 1, sets refresh_after, and forwards to daemon.
        send(
            &mut ui,
            "ui",
            2,
            json!({
                "schema": "ui_intent/v0.2",
                "request_id": "release-when-agent",
                "op": "release_control",
                "params": {"surface_id": "surface-demo"}
            }),
        )
        .await;
        assert_eq!(
            receive(&mut daemon).await,
            json!({
                "schema": "surface_request/v0.2",
                "op": "release_control",
                "params": {"surface_id": "surface-demo"}
            })
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(40), read_frame(&mut ui))
                .await
                .is_err(),
            "accepted release_control must not emit a refusal verdict to UI"
        );

        let after: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        assert_eq!(after["core_seq"].as_u64().unwrap(), seq_before + 1);
        assert_eq!(
            after["surfaces"]["surface-demo"]["agent_controlled"],
            json!(true)
        );
        assert_eq!(
            after["surfaces"]["surface-demo"]["refresh_after"],
            json!(seq_before + 1)
        );

        // 2. Negative control: a refused release_control (unknown surface) journals POLICY,
        // returns a refusal verdict to UI, and never forwards to daemon.
        send(
            &mut ui,
            "ui",
            3,
            json!({
                "schema": "ui_intent/v0.2",
                "request_id": "release-unknown",
                "op": "release_control",
                "params": {"surface_id": "surface-missing"}
            }),
        )
        .await;
        let verdict = receive(&mut ui).await;
        assert_eq!(verdict["schema"], "action_verdict/v0.2");
        assert_eq!(verdict["proposal_id"], "release-unknown");
        assert_eq!(verdict["decision"], "refused");
        assert_eq!(verdict["reason_code"], "POLICY");
        assert_eq!(verdict["core_seq"], json!(seq_before + 2));
        assert!(
            tokio::time::timeout(Duration::from_millis(40), read_frame(&mut daemon))
                .await
                .is_err(),
            "refused release_control must not forward to daemon"
        );

        let session_root = state_dir.join("sessions/control-release-agent");
        let replayed = scan(&session_root.join("journal.jsonl"), &session_root).unwrap();
        assert_eq!(replayed.state.core_seq, seq_before + 2);
        assert_eq!(
            replayed.state.snapshot().unwrap(),
            server.lock().unwrap().snapshot().unwrap()
        );

        drop((daemon, ui));
        task.abort();
        let _ = task.await;
    });
}
