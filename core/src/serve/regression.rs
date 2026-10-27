mod support {
    use std::future::Future;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    pub fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    pub struct Temp(pub PathBuf);
    impl Temp {
        pub fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "metaviewer-core-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    pub fn uid() -> u32 {
        tokio::net::UnixStream::pair()
            .unwrap()
            .0
            .peer_cred()
            .unwrap()
            .uid()
    }
}
use crate::journal::sha256_hex;
use crate::serve::{self, Config, Registration, Server};
use crate::*;
use serde_json::{json, Value};
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
        // read_frame already enforces the transport's configured read deadline.
        // An additional shorter watchdog makes host scheduling a test oracle.
        read_frame(&mut self.socket)
            .await
            .expect("test peer frame read failed")
            .unwrap_or_else(|| {
                panic!(
                    "core closed {} after seq {}",
                    self.registration.endpoint.instance, self.seq
                )
            })
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

// [TARGET, unit decision] A daemon cannot issue agent tools. Its POLICY reply
// fences all earlier messages on that same connection, without a timed probe.
// Unexpected daemon dispatches precede the reply and fail the verdict assertion.
async fn daemon_barrier(daemon: &mut Peer) {
    daemon
        .send(tool_call("list", json!({"cursor":null,"limit":1})))
        .await;
    daemon.verdict("refused", Some("POLICY")).await;
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
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
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
        "../../../contracts/examples/v0.2/action_proposal.valid.json"
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
fn tool_call(op: &str, args: Value) -> Value {
    json!({"schema":"mv_tool_call/v0.2","request_id":"body-request","op":op,"args":args})
}
async fn tool_result(peer: &mut Peer, op: &str, status: &str) -> Value {
    let expected = format!("agent-test-{}", peer.seq);
    let env = peer.receive().await;
    assert!(matches!(env.body, Command::MvToolResult(_)), "{env:?}");
    let result = serde_json::to_value(env.body).unwrap();
    assert_eq!(result["request_id"], expected);
    assert_eq!(result["op"], op);
    assert_eq!(result["status"], status, "{result}");
    result
}

async fn start_server() -> (
    support::Temp,
    Arc<Mutex<Server>>,
    tokio::task::JoinHandle<serve::Result<()>>,
) {
    let temp = support::Temp::new();
    let socket = temp.0.join("runtime/core.sock");
    let uid = support::uid();
    let listener = serve::bind(&socket, uid).await.unwrap();
    let server = Arc::new(Mutex::new(
        Server::open(config(), &temp.0.join("state"), uid).unwrap(),
    ));
    let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
    (temp, server, task)
}
async fn setup() -> (
    support::Temp,
    Arc<Mutex<Server>>,
    tokio::task::JoinHandle<serve::Result<()>>,
    Peer,
    Peer,
    Peer,
) {
    let (temp, server, task) = start_server().await;
    let socket = temp.0.join("runtime/core.sock");
    let daemon = Peer::connect(&socket, "daemon").await;
    let agent = Peer::connect(&socket, "agent").await;
    let ui = Peer::connect(&socket, "ui").await;
    (temp, server, task, daemon, agent, ui)
}
fn surface() -> Value {
    serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap()
}
async fn created(daemon: &mut Peer, ui: &mut Peer) {
    daemon
        .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface()}}))
        .await;
    ui.receive().await;
}
#[test]
fn expired_publication_does_not_retire_daemon_or_admit_pixels() {
    support::run(async {
        let (_temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let expired = SharedFrame::new();
        let missing = expired.value(1);
        std::fs::remove_file(&expired.0).unwrap();
        // Both daemon publication forms can be queued beyond the lease window.
        daemon.send(missing.clone()).await;
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready",
                "data":{"frame_ref":missing}}))
            .await;
        daemon_barrier(&mut daemon).await;
        assert!(server
            .lock()
            .unwrap()
            .authority
            .state()
            .surfaces
            .values()
            .all(|surface| surface.frame.is_none()));
        let fresh = SharedFrame::new();
        daemon.send(fresh.value(2)).await;
        let received = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(received, fresh.value(2));
        daemon_barrier(&mut daemon).await;
        // A present publication with a false digest must still fail closed.
        let mut bad = fresh.value(3);
        bad["sha256"] = "0".repeat(64).into();
        let frame: crate::wire::payload::FrameRef = serde_json::from_value(bad).unwrap();
        assert!(server.lock().unwrap().witness(&frame).is_err());
        task.abort();
        let _ = task.await;
    });
}
#[test]
fn cancelled_dispatched_wait_returns_unavailable_promptly() {
    support::run(async {
        let (_temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let frame = SharedFrame::new();
        let f = frame.value(1);
        daemon.send(f.clone()).await;
        ui.receive().await;
        agent.send(proposal("cancelled", &f)).await;
        agent.verdict("admitted", None).await;
        daemon.receive().await;
        agent
            .send(tool_call(
                "wait_verify",
                json!({"proposal_id":"cancelled","timeout_ms":5000}),
            ))
            .await;
        // Force ordering: this connection's following request cannot precede wait registration.
        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        tool_result(&mut agent, "list", "ok").await;
        assert_eq!(server.lock().unwrap().tool_state.waiters.len(), 1);
        ui.send(control("take_control")).await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        // Control dispatch follows notify_cancellations in the same route call.
        // Check that causal boundary instead of measuring host scheduling time.
        assert!(matches!(
            daemon.receive().await.body,
            Command::SurfaceRequest(_)
        ));
        assert!(server.lock().unwrap().tool_state.waiters.is_empty());
        let result = agent.receive().await;
        let result = serde_json::to_value(result.body).unwrap();
        assert_eq!(result["code"], "UNAVAILABLE");
        assert!(server
            .lock()
            .unwrap()
            .authority
            .state()
            .draining
            .contains_key("cancelled"));
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
        task.abort();
    });
}
#[test]
fn cancellation_enqueues_wait_result_in_the_notification_call() {
    let temp = support::Temp::new();
    let mut server = Server::open(
        config(),
        &temp.0.join("state"),
        serve::effective_uid().unwrap(),
    )
    .unwrap();
    let peer = registration("agent").endpoint;
    let (queue, rx) = std::sync::mpsc::sync_channel(MAX_SEND_QUEUE);
    server.connections.insert(
        peer.clone(),
        serve::Connection {
            id: 1,
            epoch: 0,
            queue,
            terminal: Arc::new(Mutex::new(None)),
        },
    );
    server.tool_state.waiters.push(super::Waiter {
        peer,
        request_id: "cancel-wait".into(),
        proposal_id: "cancelled".into(),
        deadline: std::time::Instant::now() + IDLE_DEADLINE,
    });
    // Negative control: merely retaining a waiter enqueues no result.
    assert!(matches!(
        rx.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    server
        .notify_cancellations(&["cancelled".into()], 1)
        .unwrap();
    assert!(server.tool_state.waiters.is_empty());
    assert!(matches!(
        rx.try_recv().unwrap().body,
        Command::ActionVerdict(_)
    ));
    let result = serde_json::to_value(rx.try_recv().unwrap().body).unwrap();
    assert_eq!(result["request_id"], "cancel-wait");
    assert_eq!(result["code"], "UNAVAILABLE");
    assert!(matches!(
        rx.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
}
#[test]
fn list_lookahead_needs_no_metadata_but_returned_entries_do() {
    support::run(async {
        let (_temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let mut next = surface();
        next["surface_id"] = "surface-next".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":next}}))
            .await;
        ui.receive().await;
        server
            .lock()
            .unwrap()
            .tool_state
            .surfaces
            .remove("surface-next");
        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        let result = tool_result(&mut agent, "list", "ok").await;
        assert_eq!(result["surfaces"].as_array().unwrap().len(), 1);
        assert_eq!(result["next_cursor"], "surface-demo");
        agent
            .send(tool_call(
                "list",
                json!({"cursor":"surface-demo","limit":1}),
            ))
            .await;
        assert_eq!(
            tool_result(&mut agent, "list", "error").await["code"],
            "UNAVAILABLE"
        );
        task.abort();
    });
}
#[test]
fn retained_maps_drop_dead_surfaces_and_bound_receipts() {
    let mut state = super::ToolState::default();
    let frame: Value = serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    for i in 0..1000 {
        let mut s = surface();
        s["surface_id"] = format!("s-{i}").into();
        let event = |s: Value, event| {
            serde_json::from_value::<crate::wire::payload::SurfaceEvent>(
                json!({"schema":"surface_event/v0.2","event":event,"data":{"surface":s}}),
            )
            .unwrap()
        };
        state.retain(&Command::SurfaceEvent(Box::new(event(
            s.clone(),
            "created",
        ))));
        let mut f = frame.clone();
        f["surface_id"] = s["surface_id"].clone();
        state.retain(&Command::FrameRef(Box::new(
            serde_json::from_value(f).unwrap(),
        )));
        s["state"] = if i % 2 == 0 { "destroyed" } else { "lost" }.into();
        state.retain(&Command::SurfaceEvent(Box::new(event(s, "state_changed"))));
    }
    assert!(state.surfaces.is_empty(), "dead metadata retained");
    assert!(state.frames.is_empty(), "dead frames retained");
}
#[test]
fn receipt_retention_is_bounded_in_arrival_order() {
    let mut state = super::ToolState::default();
    for i in 0..200 {
        let mut r: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        r["proposal_id"] = format!("receipt-{i}").into();
        state.retain(&Command::ActionReceipt(Box::new(
            serde_json::from_value(r).unwrap(),
        )));
    }
    assert!(state.receipts.len() <= 128, "receipt cap exceeded");
    assert!(!state.receipts.contains_key("receipt-0"));
    assert!(state.receipts.contains_key("receipt-199"));
}
#[test]
fn layout_fold_unfold_publishes_and_recovers_without_daemon_dispatch() {
    support::run(async {
        let (temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        let mut pinned = surface();
        pinned["visibility"] = "pinned".into();
        daemon
            .send(
                json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":pinned}}),
            )
            .await;
        assert_eq!(
            serde_json::to_value(ui.receive().await.body).unwrap()["data"]["surface"]["visibility"],
            "pinned"
        );
        agent.send(json!({"schema":"ui_intent/v0.2","request_id":"agent-fold","op":"fold","params":{"slot_id":"surface-demo"}})).await;
        agent.verdict("refused", Some("POLICY")).await;
        for (op, visibility) in [
            ("fold", "folded"),
            ("unfold", "unfolded"),
            ("fold", "folded"),
        ] {
            ui.send(json!({"schema":"ui_intent/v0.2","request_id":op,"op":op,"params":{"slot_id":"surface-demo"}})).await;
            let event = serde_json::to_value(ui.receive().await.body).unwrap();
            assert_eq!(event["event"], "state_changed");
            assert_eq!(event["data"]["surface"]["visibility"], visibility);
        }
        // A later daemon lifecycle event cannot reverse a committed layout intent.
        daemon.send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface()}})).await;
        assert_eq!(
            serde_json::to_value(ui.receive().await.body).unwrap()["data"]["surface"]["visibility"],
            "folded"
        );
        daemon_barrier(&mut daemon).await;
        ui.send(json!({"schema":"ui_intent/v0.2","request_id":"unknown","op":"fold","params":{"slot_id":"unknown"}})).await;
        ui.verdict("refused", Some("POLICY")).await;
        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        assert_eq!(
            tool_result(&mut agent, "list", "ok").await["surfaces"][0]["visibility"],
            "folded"
        );
        assert_eq!(server.lock().unwrap().authority.state().surfaces.len(), 1);
        close_server(server, task, daemon, agent, ui).await;
        let recovered = Server::open(config(), &temp.0.join("state"), support::uid()).unwrap();
        assert_eq!(
            recovered.tool_state.surfaces["surface-demo"]["visibility"],
            "folded"
        );
    });
}
#[test]
fn recovery_retains_only_live_views_and_recent_receipts() {
    support::run(async {
        let (temp, server, task) = start_server().await;
        let socket = temp.0.join("runtime/core.sock");
        let mut daemon = Peer::connect(&socket, "daemon").await;
        let mut agent = Peer::connect(&socket, "agent").await;
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface()}}))
            .await;
        let frame = SharedFrame::new();
        let f = frame.value(1);
        daemon.send(f.clone()).await;
        daemon_barrier(&mut daemon).await;
        // [TARGET, unit decision] Receipt traffic does not use the UI. Connecting
        // it before this journal-heavy batch made success depend on the entire
        // batch completing before the transport's legitimate idle deadline.
        assert!(!server
            .lock()
            .unwrap()
            .connections
            .contains_key(&registration("ui").endpoint));
        for i in 0..200 {
            let id = format!("p-{i}");
            agent.send(proposal(&id, &f)).await;
            agent.verdict("admitted", None).await;
            daemon.receive().await;
            let mut r: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/action_receipt.valid.json"
            ))
            .unwrap();
            r["proposal_id"] = id.into();
            r["after_frame"] = f.clone();
            daemon.send(r).await;
            agent.receive().await;
        }
        let mut ui = Peer::connect(&socket, "ui").await;
        let mut dead = surface();
        dead["state"] = "destroyed".into();
        daemon.send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":dead}})).await;
        ui.receive().await;
        {
            let guard = server.lock().unwrap();
            assert!(guard.tool_state.surfaces.is_empty());
            assert!(guard.tool_state.frames.is_empty());
            assert!(guard.tool_state.receipts.len() <= 128);
        }
        close_server(server, task, daemon, agent, ui).await;
        let recovered = Server::open(config(), &temp.0.join("state"), support::uid()).unwrap();
        let state = &recovered.tool_state;
        assert!(state.surfaces.is_empty());
        assert!(state.frames.is_empty());
        assert!(state.receipts.len() <= 128);
        assert!(state.receipts.contains_key("p-199"));
        assert!(!state.receipts.contains_key("p-0"));
    });
}

async fn close_server(
    server: Arc<Mutex<Server>>,
    task: tokio::task::JoinHandle<serve::Result<()>>,
    daemon: Peer,
    agent: Peer,
    ui: Peer,
) {
    task.abort();
    let _ = task.await;
    drop((daemon, agent, ui));
    tokio::time::timeout(Duration::from_secs(2), async {
        while Arc::strong_count(&server) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("connection tasks must release server");
    drop(server);
}

#[test]
fn layout_intents_reject_open_or_malformed_decoding() {
    for op in ["fold", "unfold"] {
        for params in [
            json!({}),
            json!({"slot_id":""}),
            json!({"slot_id":"s","extra":true}),
            json!({"surface_id":"s"}),
        ] {
            let value = json!({"schema":"envelope/v0.2","msg_id":"bad-layout","ts_ns":0,"from":{"component":"ui","instance":"ui-test"},"to":{"component":"core","instance":"core-test"},"session_id":"serve-session","seq":1,"nonce":"bad-layout","body":{"schema":"ui_intent/v0.2","request_id":"bad-layout","op":op,"params":params}});
            assert!(decode_envelope(&value.to_string()).is_err());
        }
    }
}
