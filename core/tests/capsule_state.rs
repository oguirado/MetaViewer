#![forbid(unsafe_code)]
use metaviewer_core::decode_envelope;
use serde_json::{json, Value};

fn request() -> Value {
    json!({"schema":"capsule_state_request/v0.2", "operation_id":"slot-op-1",
        "op":"save", "profile_id":"profile-demo", "slot_id":"slot-demo",
        "credential_copy_confirmed":true})
}
fn envelope(body: Value) -> Value {
    let mut env: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/envelope.valid.json"
    ))
    .unwrap();
    env["body"] = body;
    env
}
#[test]
fn additive_capsule_request_decodes_and_rejects_unknown_fields() {
    let good = envelope(request());
    assert!(decode_envelope(&good.to_string()).is_ok());
    let mut bad = good;
    bad["body"]["path"] = "/tmp/bypass".into();
    assert!(decode_envelope(&bad.to_string()).is_err());
}
#[test]
fn asynchronous_capsule_events_decode() {
    for phase in ["accepted", "completed"] {
        let body = json!({"schema":"capsule_state_event/v0.2", "operation_id":"slot-op-1",
            "profile_id":"profile-demo", "slot_id":"slot-demo", "op":"save", "event":phase});
        assert!(decode_envelope(&envelope(body).to_string()).is_ok());
    }
}

use metaviewer_core::admission::{Authority, CoreState, Input, LifecycleUpdate, Surface};
use metaviewer_core::wire::payload::{CapsuleStateEvent, CapsuleStateRequest};
use metaviewer_core::{Component, Endpoint, Refusal};
mod support;
fn sender(component: Component) -> Endpoint {
    Endpoint {
        component,
        instance: "slot-ui".into(),
    }
}
fn admit(value: Value, component: Component) -> Input {
    Input::CapsuleStateRequest {
        sender: sender(component),
        request: serde_json::from_value::<CapsuleStateRequest>(value).unwrap(),
    }
}
fn completion(phase: &str) -> CapsuleStateEvent {
    let mut value = request();
    value
        .as_object_mut()
        .unwrap()
        .remove("credential_copy_confirmed");
    value["schema"] = "capsule_state_event/v0.2".into();
    value["event"] = phase.into();
    if phase == "refused" {
        value["reason_code"] = "IDENTITY_BOUND".into();
    }
    serde_json::from_value(value).unwrap()
}
#[test]
fn agent_refused_and_pending_duplicate_does_not_spend_or_dispatch() {
    let mut state = CoreState::new("session-1", 10).unwrap();
    assert_eq!(
        state
            .apply(&admit(request(), Component::Agent))
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert!(state.slot_ops.is_empty());
    let first = state.apply(&admit(request(), Component::Ui)).unwrap();
    assert_eq!(first.reason, None);
    assert!(first.dispatch);
    assert_eq!(state.remaining_budget, 9);
    assert!(
        !state
            .apply(&admit(request(), Component::Ui))
            .unwrap()
            .dispatch
    );
    assert_eq!(state.remaining_budget, 9);
    let mut changed = request();
    changed["slot_id"] = "other-slot".into();
    assert_eq!(
        state.apply(&admit(changed, Component::Ui)).unwrap().reason,
        Some(Refusal::Policy)
    );
}
#[test]
fn pending_operation_fences_create_source_and_copy_destination() {
    let mut state = CoreState::new("session-1", 10).unwrap();
    let mut copy = request();
    copy["op"] = "copy".into();
    copy["destination_profile_id"] = "profile-copy".into();
    state.apply(&admit(copy, Component::Ui)).unwrap();
    for profile in ["profile-demo", "profile-copy"] {
        let request=serde_json::from_value(json!({"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","geometry":{"w":800,"h":600},"profile_id":profile}})).unwrap();
        assert_eq!(
            state
                .apply(&Input::SurfaceRequest { request })
                .unwrap()
                .reason,
            Some(Refusal::Policy)
        );
    }
    assert_eq!(state.remaining_budget, 9);
}
#[test]
fn pending_create_and_live_surface_refuse_slot_work() {
    let mut state = CoreState::new("session-1", 10).unwrap();
    state
        .apply(&Input::ProfileCreate {
            profile_id: "profile-demo".into(),
        })
        .unwrap();
    assert_eq!(
        state
            .apply(&admit(request(), Component::Ui))
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    state
        .apply(&Input::Surface {
            id: "surface-demo".into(),
            surface: Surface {
                display: ":101".into(),
                owner: sender(Component::Agent),
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        })
        .unwrap();
    state
        .apply(&Input::ProfileBind {
            surface_id: "surface-demo".into(),
            profile_id: "profile-demo".into(),
        })
        .unwrap();
    let mut next = request();
    next["operation_id"] = "live-op".into();
    assert_eq!(
        state.apply(&admit(next, Component::Ui)).unwrap().reason,
        Some(Refusal::Policy)
    );
    state
        .apply(&Input::Lifecycle {
            surface_id: "surface-demo".into(),
            update: LifecycleUpdate::Destroyed,
        })
        .unwrap();
    let mut next = request();
    next["operation_id"] = "stopped-op".into();
    assert!(state.apply(&admit(next, Component::Ui)).unwrap().dispatch);
}
#[test]
fn completion_is_epoch_bound_and_terminal_replay_never_dispatches() {
    let mut state = CoreState::new("session-1", 10).unwrap();
    state.apply(&Input::Connect).unwrap();
    state.apply(&admit(request(), Component::Ui)).unwrap();
    assert_eq!(
        state
            .apply(&Input::CapsuleStateEvent {
                epoch: 0,
                event: completion("completed")
            })
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert!(!state.slot_ops.is_empty());
    assert_eq!(
        state
            .apply(&Input::CapsuleStateEvent {
                epoch: 1,
                event: completion("completed")
            })
            .unwrap()
            .reason,
        None
    );
    assert!(state.slot_ops.is_empty());
    assert_eq!(
        state.slot_history["slot-op-1"].event,
        completion("completed")
    );
    assert!(
        !state
            .apply(&admit(request(), Component::Ui))
            .unwrap()
            .dispatch
    );
    assert_eq!(state.remaining_budget, 9);
}
#[test]
fn old_journal_recovers_without_new_fields_and_pending_journal_keeps_fence() {
    let temp = support::Temp::new();
    let dir = temp.0.join("state");
    let mut authority = Authority::create(&dir, CoreState::session("session-1").unwrap()).unwrap();
    authority.apply(Input::Connect).unwrap();
    let snapshot = authority.state().snapshot().unwrap();
    let value: Value = serde_json::from_slice(&snapshot).unwrap();
    for field in [
        "slot_ops",
        "slot_history",
        "profile_surfaces",
        "profile_creates",
    ] {
        assert!(value.get(field).is_none());
    }
    drop(authority);
    let root = dir.join("sessions/session-1");
    let mut recovered = Authority::recover(&root.join("journal.jsonl"), &root).unwrap();
    assert_eq!(recovered.state().snapshot().unwrap(), snapshot);
    recovered.apply(admit(request(), Component::Ui)).unwrap();
    let pending = recovered.state().snapshot().unwrap();
    drop(recovered);
    let recovered = Authority::recover(&root.join("journal.jsonl"), &root).unwrap();
    assert_eq!(recovered.state().snapshot().unwrap(), pending);
    assert!(!recovered.state().slot_ops.is_empty());
}

use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::{read_frame_with_limits, WireLimits, MAX_FRAME_BYTES};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
fn registration(name: &str) -> Registration {
    serde_json::from_value(json!({"endpoint":{"component":name,"instance":name},
        "hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":name,
        "component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
}
struct Peer {
    socket: BufReader<UnixStream>,
    name: String,
    seq: u64,
}
impl Peer {
    async fn connect(path: &Path, name: &str) -> Self {
        let mut peer = Self {
            socket: BufReader::new(UnixStream::connect(path).await.unwrap()),
            name: name.into(),
            seq: 0,
        };
        peer.send(serde_json::to_value(registration(name).hello).unwrap())
            .await;
        assert_eq!(peer.receive().await["schema"], "hello/v0.2");
        peer
    }
    async fn send(&mut self, body: Value) {
        self.seq += 1;
        let value = json!({"schema":"envelope/v0.2","msg_id":format!("{}-{}",self.name,self.seq),"ts_ns":0,
            "from":registration(&self.name).endpoint,"to":registration("core").endpoint,"session_id":"capsule-socket",
            "nonce":format!("{}-{}",self.name,self.seq),"seq":self.seq,"body":body});
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.socket.write_all(&bytes).await.unwrap();
    }
    async fn receive(&mut self) -> Value {
        let bound = Duration::from_secs(30);
        let limits = WireLimits::new(MAX_FRAME_BYTES, 32, 256, 65536, bound, bound).unwrap();
        let env = tokio::time::timeout(bound, read_frame_with_limits(&mut self.socket, &limits))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::to_value(env.body).unwrap()
    }
}
#[test]
fn socket_save_is_async_ui_only_and_replays_completed_outcome() {
    support::run(async {
        let temp = support::Temp::new();
        let uid = support::uid();
        let path = temp.0.join("runtime/core.sock");
        let listener = serve::bind(&path, uid).await.unwrap();
        let config = Config {
            session_id: "capsule-socket".into(),
            core: registration("core"),
            peers: vec![
                registration("ui"),
                registration("daemon"),
                registration("agent"),
            ],
        };
        let server = Arc::new(Mutex::new(
            Server::open(config, &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        let mut daemon = Peer::connect(&path, "daemon").await;
        let mut ui = Peer::connect(&path, "ui").await;
        let mut agent = Peer::connect(&path, "agent").await;
        agent.send(request()).await;
        assert_eq!(agent.receive().await["reason_code"], "POLICY");
        ui.send(request()).await;
        assert_eq!(ui.receive().await["event"], "accepted");
        assert_eq!(daemon.receive().await, request());
        ui.send(request()).await;
        assert_eq!(ui.receive().await["event"], "accepted");
        ui.send(json!({"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","geometry":{"w":800,"h":600},"profile_id":"profile-demo"}})).await;
        assert_eq!(ui.receive().await["reason_code"], "POLICY");
        // Fake slow save has not completed; unrelated traffic still reaches daemon.
        let list = json!({"schema":"surface_request/v0.2","op":"list","params":{}});
        ui.send(list.clone()).await;
        assert_eq!(daemon.receive().await, list);
        daemon
            .send(serde_json::to_value(completion("accepted")).unwrap())
            .await;
        assert_eq!(ui.receive().await["event"], "accepted");
        daemon
            .send(serde_json::to_value(completion("completed")).unwrap())
            .await;
        assert_eq!(ui.receive().await["event"], "completed");
        ui.send(request()).await;
        assert_eq!(ui.receive().await["event"], "completed");
        ui.send(list.clone()).await;
        assert_eq!(daemon.receive().await, list); // no repeated destructive request
        let value: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        assert!(value.get("slot_ops").is_none());
        assert_eq!(value["remaining_budget"], 9997); // save plus unrelated lists
        let mut legacy = request();
        legacy["operation_id"] = "old-adapter-op".into();
        ui.send(legacy.clone()).await;
        assert_eq!(ui.receive().await["event"], "accepted");
        assert_eq!(daemon.receive().await, legacy);
        daemon
            .send(
                json!({"schema":"surface_event/v0.2","event":"error","data":{
            "surface_id":format!("slot:{}",metaviewer_core::journal::sha256_hex(b"old-adapter-op")),
            "code":"ADAPTER_SCHEMA","detail":"schema: unsupported request schema"}}),
            )
            .await;
        assert_eq!(ui.receive().await["reason_code"], "UNSUPPORTED_SCHEMA");
        ui.send(legacy).await;
        assert_eq!(ui.receive().await["reason_code"], "UNSUPPORTED_SCHEMA");
        drop((ui, daemon, agent));
        task.abort();
        let _ = task.await;
        server.lock().unwrap().close().unwrap();
    });
}
#[test]
fn confirmation_budget_and_ambiguous_custody_fail_closed() {
    let mut unconfirmed = request();
    unconfirmed["credential_copy_confirmed"] = false.into();
    let mut state = CoreState::new("session-1", 10).unwrap();
    assert_eq!(
        state
            .apply(&admit(unconfirmed, Component::Ui))
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    let mut state = CoreState::new("session-1", 0).unwrap();
    assert_eq!(
        state
            .apply(&admit(request(), Component::Ui))
            .unwrap()
            .reason,
        Some(Refusal::BudgetExceeded)
    );
    assert!(state.slot_ops.is_empty());
    let mut state = CoreState::new("session-1", 10).unwrap();
    state
        .apply(&Input::Surface {
            id: "unknown".into(),
            surface: Surface {
                display: ":101".into(),
                owner: sender(Component::Agent),
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        })
        .unwrap();
    assert_eq!(
        state
            .apply(&admit(request(), Component::Ui))
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
}
#[test]
fn daemon_refusal_is_recorded_and_releases_both_copy_profiles() {
    let mut state = CoreState::new("session-1", 10).unwrap();
    let mut copy = request();
    copy["op"] = "copy".into();
    copy["destination_profile_id"] = "profile-copy".into();
    state.apply(&admit(copy.clone(), Component::Ui)).unwrap();
    let mut event = completion("refused");
    event.op = metaviewer_core::wire::payload::CapsuleStateOp::Copy;
    assert_eq!(
        state
            .apply(&Input::CapsuleStateEvent {
                epoch: 0,
                event: event.clone()
            })
            .unwrap()
            .reason,
        None
    );
    assert!(state.slot_ops.is_empty());
    assert!(!state.apply(&admit(copy, Component::Ui)).unwrap().dispatch);
    assert_eq!(state.slot_history["slot-op-1"].event, event);
}

#[test]
fn new_contract_fixtures_agree_with_closed_wire_decoder() {
    let examples = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("contracts/examples/v0.2");
    for entry in std::fs::read_dir(examples).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap();
        if !name.starts_with("capsule_state_") {
            continue;
        }
        let body: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let decoded = decode_envelope(&envelope(body).to_string());
        assert_eq!(
            decoded.is_ok(),
            name.contains(".valid."),
            "{name}: {decoded:?}"
        );
    }
}

#[test]
fn list_and_delete_keep_ui_authority_and_terminal_idempotency() {
    for op in ["list", "delete"] {
        let mut state = CoreState::new("session-1", 10).unwrap();
        let mut req = request();
        req["op"] = op.into();
        assert_eq!(
            state
                .apply(&admit(req.clone(), Component::Agent))
                .unwrap()
                .reason,
            Some(Refusal::Policy)
        );
        assert!(
            state
                .apply(&admit(req.clone(), Component::Ui))
                .unwrap()
                .dispatch
        );
        let mut event = completion("completed");
        event.op = serde_json::from_value(json!(op)).unwrap();
        state
            .apply(&Input::CapsuleStateEvent {
                epoch: state.epoch,
                event,
            })
            .unwrap();
        assert!(state.slot_ops.is_empty());
        assert!(!state.apply(&admit(req, Component::Ui)).unwrap().dispatch);
    }
}

#[test]
fn repeated_creates_only_fence_slots_and_settle_one_binding_at_a_time() {
    let mut state = CoreState::new("session-1", 20).unwrap();
    for _ in 0..2 {
        let request = serde_json::from_value(json!({"schema":"surface_request/v0.2",
            "op":"create", "params":{"kind":"desktop_capsule", "profile_id":"profile-demo",
                "geometry":{"w":1280,"h":720}}}))
        .unwrap();
        assert_eq!(
            state
                .apply(&Input::SurfaceRequest { request })
                .unwrap()
                .reason,
            None
        );
        assert_eq!(
            state
                .apply(&Input::ProfileCreate {
                    profile_id: "profile-demo".into(),
                })
                .unwrap()
                .reason,
            None
        );
    }
    for id in ["first", "second"] {
        let mut blocked = request();
        blocked["operation_id"] = format!("blocked-{id}").into();
        assert_eq!(
            state.apply(&admit(blocked, Component::Ui)).unwrap().reason,
            Some(Refusal::Policy)
        );
        let out = state
            .apply(&Input::ProfileLifecycle {
                surface_id: id.into(),
                profile_id: "profile-demo".into(),
                update: LifecycleUpdate::Created(Surface {
                    display: ":101".into(),
                    owner: sender(Component::Agent),
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                }),
            })
            .unwrap();
        assert_eq!(out.reason, None);
        let pending = state.profile_create_extras.clone();
        state
            .apply(&Input::ProfileBind {
                surface_id: id.into(),
                profile_id: "profile-demo".into(),
            })
            .unwrap();
        assert_eq!(
            state.profile_create_extras, pending,
            "duplicate evidence must not settle another create"
        );
        state
            .apply(&Input::Lifecycle {
                surface_id: id.into(),
                update: LifecycleUpdate::Destroyed,
            })
            .unwrap();
    }
    assert!(state.profile_creates.is_empty());
    let mut settled = request();
    settled["operation_id"] = "settled-op".into();
    assert!(
        state
            .apply(&admit(settled, Component::Ui))
            .unwrap()
            .dispatch
    );
    // An active slot operation still vetoes creates on its own profile.
    assert_eq!(
        state
            .apply(&Input::ProfileCreate {
                profile_id: "profile-demo".into(),
            })
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert_eq!(
        state
            .apply(&Input::ProfileCreate {
                profile_id: "unrelated-profile".into(),
            })
            .unwrap()
            .reason,
        None
    );
}

#[test]
fn profiled_lifecycle_is_atomic_and_replayable() {
    let temp = support::Temp::new();
    let dir = temp.0.join("state");
    let mut authority = Authority::create(&dir, CoreState::session("session-1").unwrap()).unwrap();
    authority
        .apply(Input::ProfileCreate {
            profile_id: "requested-profile".into(),
        })
        .unwrap();
    let before = authority.state().core_seq;
    authority
        .apply(Input::ProfileLifecycle {
            surface_id: "surface-reply".into(),
            profile_id: "different-profile".into(),
            update: LifecycleUpdate::Created(Surface {
                display: ":101".into(),
                owner: sender(Component::Agent),
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            }),
        })
        .unwrap();
    assert_eq!(authority.state().core_seq, before + 1);
    assert_eq!(
        authority.state().profile_surfaces["surface-reply"],
        "different-profile"
    );
    // Uncorrelated evidence cannot clear the requested profile's slot fence.
    assert!(authority
        .state()
        .profile_creates
        .contains("requested-profile"));
    let snapshot = authority.state().snapshot().unwrap();
    drop(authority);
    let root = dir.join("sessions/session-1");
    let recovered = Authority::recover(&root.join("journal.jsonl"), &root).unwrap();
    assert_eq!(recovered.state().snapshot().unwrap(), snapshot);
}
