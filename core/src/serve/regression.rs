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
            config: config(),
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
        let env = self.envelope(body);
        write_frame(&mut self.socket, &env).await.unwrap();
    }
    fn envelope(&self, body: Value) -> Envelope {
        decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":format!("{}-{}", self.nonce_prefix,self.seq),"ts_ns":0,"from":self.registration.endpoint,"to":self.config.core.endpoint,"session_id":self.config.session_id,"seq":self.seq,"nonce":format!("{}-{}",self.nonce_prefix,self.seq),"body":body}).to_string()).unwrap()
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
    const WIDTH: u64 = 100;
    const HEIGHT: u64 = 60;
    const BYTES: usize = (Self::WIDTH as usize) * (Self::HEIGHT as usize) * 3;
    fn new() -> Self {
        use std::os::unix::fs::OpenOptionsExt;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::path::PathBuf::from(format!(
            "/dev/shm/mv-wire-{}-{}-frame",
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
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
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
        close_server(server, task, daemon, _agent, ui).await;
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
        close_server(server, task, daemon, agent, ui).await;
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
        close_server(server, task, daemon, agent, ui).await;
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
            agent.send(recovery_proposal(&id, &f)).await;
            agent.verdict("admitted", None).await;
            daemon.receive().await;
            let mut r: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/action_receipt.valid.native-key.json"
            ))
            .unwrap();
            r["proposal_id"] = id.into();
            r["after_frame"] = f.clone();
            r["native_evidence"]["kind"] = "click".into();
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

// [TARGET, unit decision] Recovery exercises durable receipt retention, not the
// example's short dispatch budget. Admission persists the journal before the
// dispatch recheck; a busy host can exhaust that budget and correctly refuse
// dispatch, leaving the test daemon waiting for input that will never arrive.
// Bound this fixture by the transport deadline instead, preserving production
// expiry and every receipt/recovery assertion.
fn recovery_proposal(id: &str, frame: &Value) -> Value {
    let mut value = proposal(id, frame);
    value["budget"]["max_ms"] = u64::try_from(IDLE_DEADLINE.as_millis()).unwrap().into();
    value
}

#[test]
fn recovery_dispatch_budget_tolerates_persistence_and_still_expires() {
    support::run(async {
        let (_temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let frame = SharedFrame::new();
        let f = frame.value(1);
        daemon.send(f.clone()).await;
        daemon_barrier(&mut daemon).await;

        agent.seq += 1;
        let env = agent.envelope(recovery_proposal("budget-control", &f));
        let mut state = server.lock().unwrap().authority.state().clone();
        let request = crate::admission::AdmissionRequest::decode(
            &serde_json::to_string(&env).unwrap(),
            &agent.registration.endpoint,
            &agent.config.session_id,
            state.epoch,
            0,
        )
        .unwrap();
        use crate::admission::Input;
        assert_eq!(state.apply(&Input::Propose(request)).unwrap().reason, None);
        let original_budget_ns = proposal("control", &f)["budget"]["max_ms"]
            .as_u64()
            .unwrap()
            * 1_000_000;
        let dispatch = |now_ns| Input::Dispatch {
            proposal_id: "budget-control".into(),
            now_ns,
        };
        // A persistence delay that exhausted the example budget still dispatches.
        assert!(
            state
                .clone()
                .apply(&dispatch(original_budget_ns))
                .unwrap()
                .dispatch
        );
        // Negative control: the recovery fixture still has a finite deadline.
        let expired = state
            .apply(&dispatch(u64::try_from(IDLE_DEADLINE.as_nanos()).unwrap()))
            .unwrap();
        assert!(!expired.dispatch);
        assert_eq!(expired.reason, Some(Refusal::BudgetExceeded));
        close_server(server, task, daemon, agent, ui).await;
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
    for op in ["fold", "unfold", "hide", "show", "move", "tab", "float"] {
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

#[test]
fn layout_placement_is_authoritative_atomic_and_replay_stable() {
    support::run(async {
        let (temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        let mut human = surface();
        human["control"] = "human".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":human}}))
            .await;
        ui.receive().await;
        let mut other = surface();
        other["surface_id"] = "other".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":other}}))
            .await;
        ui.receive().await;
        let slot = "cuk-ai-slot-surface-demo";
        let intent = |op: &str, params: Value| json!({"schema":"ui_intent/v0.2","request_id":format!("layout-{op}"),"op":op,"params":params});
        for (op, params) in [
            (
                "move",
                json!({"slot_id":slot,"group_id":"destination","index":0}),
            ),
            ("tab", json!({"slot_id":slot,"group_id":"tabs","index":1})),
            (
                "float",
                json!({"slot_id":slot,"x_px":12,"y_px":34,"width_px":800,"height_px":600}),
            ),
            ("hide", json!({"slot_id":slot})),
            ("show", json!({"slot_id":slot})),
            ("move", json!({"slot_id":slot,"group_id":"final","index":2})),
            ("hide", json!({"slot_id":slot})),
        ] {
            let body = intent(op, params);
            ui.send(body.clone()).await;
            assert_eq!(serde_json::to_value(ui.receive().await.body).unwrap(), body);
            let current = server.lock().unwrap().tool_state.placements.clone();
            if matches!(op, "move" | "tab" | "float") {
                assert_eq!(current["surface-demo"].position.as_ref(), Some(&body));
            } else {
                assert_eq!(current["surface-demo"].hidden, op == "hide");
            }
            // Recover every committed operation, so a later move cannot mask a
            // broken tab/float/show reducer during the final restart check.
            // The journal deliberately excludes a second writer. Recover an
            // exact copy under the authority mutex, preserving that lock gate.
            fn copy_tree(source: &std::path::Path, target: &std::path::Path) {
                std::fs::create_dir(target).unwrap();
                std::fs::set_permissions(target, std::fs::metadata(source).unwrap().permissions())
                    .unwrap();
                for entry in std::fs::read_dir(source).unwrap() {
                    let entry = entry.unwrap();
                    let destination = target.join(entry.file_name());
                    if entry.file_type().unwrap().is_dir() {
                        copy_tree(&entry.path(), &destination);
                    } else {
                        std::fs::copy(entry.path(), destination).unwrap();
                    }
                }
            }
            let checkpoint_dir = support::Temp::new();
            {
                let _guard = server.lock().unwrap();
                copy_tree(&temp.0.join("state"), &checkpoint_dir.0.join("state"));
            }
            let checkpoint =
                Server::open(config(), &checkpoint_dir.0.join("state"), support::uid()).unwrap();
            assert_eq!(checkpoint.tool_state.placements, current);
        }
        let expected = server.lock().unwrap().tool_state.placements.clone();
        assert!(expected["surface-demo"].hidden);
        assert_eq!(
            expected["surface-demo"].position.as_ref().unwrap()["params"]["group_id"],
            "final"
        );
        assert!(!expected.contains_key("other"));
        for (op, params, code) in [
            ("hide", json!({"slot_id":slot}), "LAYOUT_ILLEGAL_TRANSITION"),
            (
                "tab",
                json!({"slot_id":slot,"group_id":"tabs","index":0}),
                "LAYOUT_ILLEGAL_TRANSITION",
            ),
            ("show", json!({"slot_id":"missing"}), "LAYOUT_UNKNOWN_SLOT"),
            ("hide", json!({"slot_id":"other"}), "LAYOUT_INPUT_MODE_READ"),
        ] {
            ui.send(intent(op, params)).await;
            ui.verdict("refused", Some("POLICY")).await;
            let error = serde_json::to_value(ui.receive().await.body).unwrap();
            assert_eq!(error["event"], "error");
            assert_eq!(error["data"]["code"], code);
            assert_eq!(server.lock().unwrap().tool_state.placements, expected);
        }
        agent.send(intent("show", json!({"slot_id":slot}))).await;
        agent.verdict("refused", Some("POLICY")).await;
        // No layout operation is dispatched to the daemon; identity and capsule
        // liveness remain intact, so attached terminal sessions cannot be rebound.
        daemon_barrier(&mut daemon).await;
        assert_eq!(server.lock().unwrap().authority.state().surfaces.len(), 2);
        close_server(server, task, daemon, agent, ui).await;
        let recovered = Server::open(config(), &temp.0.join("state"), support::uid()).unwrap();
        assert_eq!(recovered.tool_state.placements, expected);
    });
}

#[test]
fn stale_daemon_state_changed_does_not_clobber_release_control() {
    support::run(async {
        let (_temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;

        ui.send(control("take_control")).await;
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap()["op"],
            "take_control"
        );
        let mut human = surface();
        human["control"] = "human".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":human.clone()}}))
            .await;
        let taken = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(taken["data"]["surface"]["control"], "human");

        ui.send(control("release_control")).await;
        assert_eq!(
            serde_json::to_value(daemon.receive().await.body).unwrap()["op"],
            "release_control"
        );
        // An in-flight list snapshot arriving from daemon with stale control:"human"
        // before daemon processes release_control must not clobber agent_controlled.
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":human}}))
            .await;
        let interim = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(interim["data"]["surface"]["control"], "agent");
        assert!(server.lock().unwrap().authority.state().surfaces["surface-demo"].agent_controlled);

        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface()}}))
            .await;
        let released = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(released["data"]["surface"]["control"], "agent");

        close_server(server, task, daemon, _agent, ui).await;
    });
}

#[test]
fn w3_control_intent_under_daemon_frame_burst_coalesces_and_preserves_checks() {
    support::run(async {
        let (temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;

        let shared = SharedFrame::new();
        for gen in 1..=16_u64 {
            let f = shared.value(gen);
            daemon
                .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f}}))
                .await;
        }
        ui.send(control("take_control")).await;
        let forwarded_take = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(forwarded_take["op"], "take_control");
        assert!(
            !server.lock().unwrap().authority.state().surfaces["surface-demo"].agent_controlled
        );
        assert_eq!(
            server.lock().unwrap().authority.state().surfaces["surface-demo"]
                .frame
                .as_ref()
                .unwrap()
                .generation,
            16
        );

        let mut human = surface();
        human["control"] = "human".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":human.clone()}}))
            .await;
        for gen in 17..=24_u64 {
            let f = shared.value(gen);
            daemon
                .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f}}))
                .await;
        }
        ui.send(control("release_control")).await;
        let forwarded_release = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(forwarded_release["op"], "release_control");
        assert!(server.lock().unwrap().authority.state().surfaces["surface-demo"].agent_controlled);

        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface()}}))
            .await;

        let mut saw_human = false;
        let mut saw_agent = false;
        let mut latest_gen = 0_u64;
        while !saw_agent || latest_gen < 24 {
            let body = serde_json::to_value(ui.receive().await.body).unwrap();
            if body["event"] == "frame_ready" {
                latest_gen = body["data"]["frame_ref"]["generation"].as_u64().unwrap();
            } else if body["event"] == "state_changed" {
                match body["data"]["surface"]["control"].as_str() {
                    Some("human") => saw_human = true,
                    Some("agent") if saw_human => saw_agent = true,
                    _ => {}
                }
            }
        }
        assert!(saw_human && saw_agent);
        assert_eq!(latest_gen, 24);

        // Stream 1280x900 RGB24 (3.456 MB) frames and verify control intents are answered
        // within the 1000 ms ceiling (product deadline 3000 ms), or <= 100 ms when
        // MV_PERF_STRICT=1 is set on a fast host.
        let strict = std::env::var("MV_PERF_STRICT").as_deref() == Ok("1");
        let control_ceiling_ms = if strict { 100.0 } else { 1000.0 };
        let large_bytes = vec![0x5a_u8; 1280 * 900 * 3];
        let large_sha = sha256_hex(&large_bytes);
        let large_path = std::path::PathBuf::from(format!(
            "/dev/shm/mv-wire-{}-large-1280x900.rgb",
            std::process::id()
        ));
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&large_path)
                .unwrap();
            std::io::Write::write_all(&mut file, &large_bytes).unwrap();
        }
        let make_large_frame = |generation: u64| -> Value {
            let mut v = shared.value(generation);
            v["width"] = 1280.into();
            v["height"] = 900.into();
            v["format"] = "rgb24".into();
            v["ramws_path"] = large_path.to_str().unwrap().into();
            v["sha256"] = large_sha.clone().into();
            v
        };

        for gen in 25..=28_u64 {
            let f = make_large_frame(gen);
            daemon
                .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f}}))
                .await;
        }
        let take_t0 = std::time::Instant::now();
        ui.send(control("take_control")).await;
        let forwarded_take_large = serde_json::to_value(daemon.receive().await.body).unwrap();
        let take_latency_ms = take_t0.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(forwarded_take_large["op"], "take_control");
        assert!(
            take_latency_ms <= control_ceiling_ms,
            "take_control under 3.456 MB frame stream took {take_latency_ms:.2} ms (> {control_ceiling_ms:.0} ms target)"
        );

        let mut saw_gen_28 = false;
        while !saw_gen_28 {
            let body = serde_json::to_value(ui.receive().await.body).unwrap();
            if body["event"] == "frame_ready" {
                latest_gen = body["data"]["frame_ref"]["generation"].as_u64().unwrap();
                if latest_gen == 28 {
                    saw_gen_28 = true;
                }
            }
        }

        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":human}}))
            .await;
        let mut saw_human_large = false;
        while !saw_human_large {
            let body = serde_json::to_value(ui.receive().await.body).unwrap();
            if body["event"] == "state_changed" && body["data"]["surface"]["control"] == "human" {
                saw_human_large = true;
            }
        }

        for gen in 29..=32_u64 {
            let f = make_large_frame(gen);
            daemon
                .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f}}))
                .await;
        }
        let release_t0 = std::time::Instant::now();
        ui.send(control("release_control")).await;
        let forwarded_release_large = serde_json::to_value(daemon.receive().await.body).unwrap();
        let release_latency_ms = release_t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!("MEASURED_CONTROL_UNDER_STREAM take_ms={take_latency_ms:.2} release_ms={release_latency_ms:.2}");
        assert_eq!(forwarded_release_large["op"], "release_control");
        assert!(
            release_latency_ms <= control_ceiling_ms,
            "release_control under 3.456 MB frame stream took {release_latency_ms:.2} ms (> {control_ceiling_ms:.0} ms target)"
        );

        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface()}}))
            .await;

        let mut saw_agent_large = false;
        while !saw_agent_large || latest_gen < 32 {
            let body = serde_json::to_value(ui.receive().await.body).unwrap();
            if body["event"] == "frame_ready" {
                latest_gen = body["data"]["frame_ref"]["generation"].as_u64().unwrap();
            } else if body["event"] == "state_changed"
                && body["data"]["surface"]["control"] == "agent"
            {
                saw_agent_large = true;
            }
        }
        let _ = std::fs::remove_file(&large_path);
        assert!(saw_human_large && saw_agent_large);
        assert_eq!(latest_gen, 32);

        // Negative control: a generation regression inside a burst is never masked by coalescing.
        let f_bad = shared.value(20);
        let f_newer = shared.value(33);
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f_bad}}))
            .await;
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f_newer}}))
            .await;
        assert!(
            read_frame(&mut daemon.socket)
                .await
                .unwrap_or(None)
                .is_none(),
            "generation regression in a frame burst must retire the daemon connection"
        );

        close_server(server, task, daemon, _agent, ui).await;
        let session_root = temp.0.join("state/sessions/serve-session");
        let verified =
            crate::journal::scan(&session_root.join("journal.jsonl"), &session_root).unwrap();
        assert_eq!(
            verified.state.surfaces["surface-demo"]
                .frame
                .as_ref()
                .unwrap()
                .generation,
            32
        );
    });
}

#[test]
fn rv10_01_invalid_lookahead_frame_does_not_skip_valid_predecessor() {
    support::run(async {
        let (_temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":shared.value(32)}}))
            .await;
        assert_eq!(
            serde_json::to_value(ui.receive().await.body).unwrap()["data"]["frame_ref"]
                ["generation"],
            32
        );

        let f33 = shared.value(33);
        let oversize_path = std::path::PathBuf::from(format!(
            "/dev/shm/mv-rv10-01-oversize-{}.rgb",
            std::process::id()
        ));
        {
            use std::os::unix::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&oversize_path)
                .unwrap();
            file.set_len(65 * 1024 * 1024).unwrap();
        }
        let mut f34_bad = shared.value(34);
        f34_bad["ramws_path"] = oversize_path.to_str().unwrap().into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f33}}))
            .await;
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":f34_bad}}))
            .await;
        assert!(
            read_frame(&mut daemon.socket)
                .await
                .unwrap_or(None)
                .is_none(),
            "invalid frame 34 must retire the daemon connection"
        );
        let _ = std::fs::remove_file(&oversize_path);
        let committed_gen = server.lock().unwrap().authority.state().surfaces["surface-demo"]
            .frame
            .as_ref()
            .unwrap()
            .generation;
        assert_eq!(
            committed_gen, 33,
            "valid frame 33 must not be skipped on bare existence of invalid frame 34"
        );
        close_server(server, task, daemon, _agent, ui).await;
    });
}

#[test]
fn rv10_02_missing_shm_on_regressed_or_unknown_surface_retires_daemon() {
    support::run(async {
        let (_temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":shared.value(32)}}))
            .await;
        assert_eq!(
            serde_json::to_value(ui.receive().await.body).unwrap()["data"]["frame_ref"]
                ["generation"],
            32
        );

        let mut regressed = shared.value(20);
        regressed["ramws_path"] = "/dev/shm/mv-nonexistent-rv10-02.rgb".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":regressed}}))
            .await;
        let closed =
            tokio::time::timeout(Duration::from_millis(300), read_frame(&mut daemon.socket))
                .await
                .expect("regressed generation with missing shm file must retire daemon promptly")
                .unwrap_or(None)
                .is_none();
        assert!(
            closed,
            "regressed generation with missing shm file must still retire the daemon"
        );
        close_server(server, task, daemon, _agent, ui).await;
    });
}

#[test]
fn rv10_03_active_recording_disables_frame_coalescing() {
    support::run(async {
        let (_temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":shared.value(1)}}))
            .await;
        let _ = ui.receive().await;

        let ui_ep = registration("ui").endpoint;
        let start_reply = server
            .lock()
            .unwrap()
            .capture_request(
                &ui_ep,
                "recordStart",
                json!({"schema":"capture_request/v1","request_id":"rv10-03-start","surface_id":"surface-demo","mode":"ai"}),
            )
            .unwrap();
        assert_eq!(start_reply["ok"], true);
        let rec_id = start_reply["recording_id"].as_str().unwrap().to_owned();

        for gen in 2..=5_u64 {
            daemon
                .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":shared.value(gen)}}))
                .await;
        }
        daemon_barrier(&mut daemon).await;

        let stop_reply = server
            .lock()
            .unwrap()
            .capture_request(
                &ui_ep,
                "recordStop",
                json!({"schema":"capture_request/v1","request_id":"rv10-03-stop","recording_id":rec_id}),
            )
            .unwrap();
        assert_eq!(stop_reply["ok"], true);
        let recorded_frames = stop_reply["recording"]["frames"].as_u64().unwrap();
        assert_eq!(
            recorded_frames, 5,
            "active recording must capture all 4 burst frames plus initial frame (got {recorded_frames})"
        );
        close_server(server, task, daemon, _agent, ui).await;
    });
}

#[test]
fn rv10_05_gapless_frame_burst_polls_expired_tool_waiters_at_batch_flush() {
    support::run(async {
        use tokio::io::AsyncWriteExt;
        let (temp, server, task) = start_server().await;
        let socket = temp.0.join("runtime/core.sock");
        let mut daemon = Peer::connect(&socket, "daemon").await;
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface()}}))
            .await;
        daemon_barrier(&mut daemon).await;

        let agent_ep = registration("agent").endpoint;
        let (agent_tx, agent_rx) = std::sync::mpsc::sync_channel(MAX_SEND_QUEUE);
        {
            let mut guard = server.lock().unwrap();
            let epoch = guard.authority.state().epoch;
            guard.connections.insert(
                agent_ep.clone(),
                serve::Connection {
                    id: 99,
                    epoch,
                    queue: agent_tx,
                    terminal: Arc::new(Mutex::new(None)),
                },
            );
            guard.tool_state.waiters.push(super::Waiter {
                peer: agent_ep,
                request_id: "rv10-05-wait".into(),
                proposal_id: "rv10-05-prop".into(),
                deadline: std::time::Instant::now() - Duration::from_millis(10),
            });
        }

        let shared = SharedFrame::new();
        for gen in 1..=32_u64 {
            daemon.send(shared.value(gen)).await;
        }
        daemon.socket.shutdown().await.unwrap();
        let _ = read_frame(&mut daemon.socket).await;

        let resolved = agent_rx.try_recv();
        assert!(
            resolved.is_ok(),
            "expired tool waiter must be polled when a 32-frame daemon batch flushes"
        );
        drop(daemon);
        task.abort();
        let _ = task.await;
        drop(server);
    });
}

#[test]
fn new_02_unavailable_shm_prefix_is_hard_error_while_missing_leaf_drops() {
    let temp = support::Temp::new();
    let mut server = Server::open(
        config(),
        &temp.0.join("state"),
        serve::effective_uid().unwrap(),
    )
    .unwrap();
    server
        .authority
        .apply(crate::admission::Input::Connect)
        .unwrap();
    let sw = server.authority.retain_witness(b"seed").unwrap();
    server
        .authority
        .apply_with_witnesses(
            crate::admission::Input::Surface {
                id: "surface-demo".into(),
                surface: crate::admission::Surface {
                    display: ":1".into(),
                    owner: registration("agent").endpoint,
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                },
            },
            vec![sw],
        )
        .unwrap();

    let mut raw: Value = serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    raw["ramws_path"] = "/dev/shm/mv-missing-leaf-new02.rgb".into();
    let frame: crate::wire::payload::FrameRef = serde_json::from_value(raw).unwrap();
    let boundary = server.authority.retain_witness(b"boundary").unwrap();

    let prefix_err =
        Server::read_shm_pixels_under(std::path::Path::new("/dev/shm-unavailable-prefix"), &frame);
    let prefix_outcome = server.frame(0, &frame, boundary.clone(), Some(prefix_err));
    assert!(
        prefix_outcome.is_err(),
        "unavailable fixed shm prefix must fail closed with Err instead of silent drop"
    );
    let leaf_outcome = server.frame(0, &frame, boundary, None).unwrap();
    assert_eq!(
        leaf_outcome, None,
        "missing leaf under valid /dev/shm prefix must keep silent-drop behavior"
    );
}

#[test]
fn new_03_refused_frame_on_destroyed_surface_notifies_daemon_with_policy() {
    support::run(async {
        let (_temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let mut dead = surface();
        dead["state"] = "destroyed".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":dead}}))
            .await;
        let _ = ui.receive().await;

        let shared = SharedFrame::new();
        daemon.send(shared.value(1)).await;
        let frame_msg_id = format!("daemon-test-{}", daemon.seq);
        daemon
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        let first = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(
            first["proposal_id"], frame_msg_id,
            "destroyed-surface frame refusal must notify daemon before subsequent barrier reply"
        );
        assert_eq!(first["decision"], "refused");
        assert_eq!(first["reason_code"], "POLICY");
        daemon.verdict("refused", Some("POLICY")).await;
        close_server(server, task, daemon, _agent, ui).await;
    });
}

#[test]
fn w3_lost_capsule_journals_forwards_to_ui_and_refuses_new_input() {
    support::run(async {
        let (temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        let frame = shared.value(1);
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":frame.clone()}}))
            .await;
        let _ = ui.receive().await;

        ui.send(json!({
            "schema": "ui_intent/v0.2",
            "request_id": "fold-demo",
            "op": "fold",
            "params": {"slot_id": "surface-demo"}
        }))
        .await;
        let folded = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(folded["data"]["surface"]["visibility"], "folded");

        // Admit an in-flight agent proposal before the capsule is lost.
        agent.send(proposal("inflight-before-loss", &frame)).await;
        agent.verdict("admitted", None).await;
        let _ = daemon.receive().await;

        // Daemon reports confirmed capsule loss via state_changed(lost), even if
        // its local snapshot carries stale control/visibility fields.
        let mut lost_surface = surface();
        lost_surface["state"] = "lost".into();
        lost_surface["control"] = "human".into();
        lost_surface["visibility"] = "unfolded".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":lost_surface}}))
            .await;
        daemon_barrier(&mut daemon).await;
        assert!(
            !server.lock().unwrap().authority.state().surfaces["surface-demo"].live,
            "core must journal and apply the Lost surface update"
        );

        // In-flight agent proposal is cancelled (refused) with SURFACE_NOT_AGENT_CONTROLLED.
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;

        // UI receives state_changed(lost) with Core's authoritative control and visibility.
        let ui_lost = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(ui_lost["schema"], "surface_event/v0.2");
        assert_eq!(ui_lost["event"], "state_changed");
        assert_eq!(ui_lost["data"]["surface"]["surface_id"], "surface-demo");
        assert_eq!(ui_lost["data"]["surface"]["state"], "lost");
        assert_eq!(ui_lost["data"]["surface"]["control"], "agent");
        assert_eq!(ui_lost["data"]["surface"]["visibility"], "folded");

        // Subsequent agent proposals on the lost surface are refused with existing frozen code.
        agent.send(proposal("after-loss", &frame)).await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;

        // Subsequent human input on the lost surface is refused with POLICY.
        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": "surface-demo",
                "proposal_id": "human-input-after-loss",
                "origin": "human",
                "action": {"type": "key", "keys": ["Return"]}
            }
        }))
        .await;
        ui.verdict("refused", Some("POLICY")).await;

        // Subsequent take_control on the lost surface is refused with POLICY.
        ui.send(control("take_control")).await;
        ui.verdict("refused", Some("POLICY")).await;

        // Subsequent record_request on the lost surface is refused in the journal with Refusal::Policy.
        ui.send(json!({
            "schema": "record_request/v0.2",
            "request_id": "rec-after-loss",
            "op": "screenshot",
            "params": {
                "surface_id": "surface-demo",
                "capture_id": "cap-after-loss"
            }
        }))
        .await;
        let meta_reply = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(meta_reply["schema"], "surface_event/v0.2");
        assert_eq!(meta_reply["data"]["code"], "CAPTURE_REPLY");
        let detail: Value =
            serde_json::from_str(meta_reply["data"]["detail"].as_str().unwrap()).unwrap();
        assert_eq!(detail["reply"]["ok"], false);
        assert_eq!(detail["reply"]["code"], "SURFACE_UNKNOWN");

        close_server(server, task, daemon, agent, ui).await;

        let session_root = temp.0.join("state/sessions/serve-session");
        let verified =
            crate::journal::scan(&session_root.join("journal.jsonl"), &session_root).unwrap();
        assert!(!verified.state.surfaces["surface-demo"].live);
        let mut saw_lost_event = false;
        for seq in 1..=verified.state.core_seq {
            let ev: Value = serde_json::from_slice(
                &std::fs::read(session_root.join("events").join(format!("{seq}.json"))).unwrap(),
            )
            .unwrap();
            if ev["input"]["event"] == "Lifecycle"
                && ev["input"]["surface_id"] == "surface-demo"
                && ev["input"]["update"]["kind"] == "Lost"
            {
                saw_lost_event = true;
            }
        }
        assert!(
            saw_lost_event,
            "journal events must record the Lost lifecycle transition"
        );
    });
}

#[test]
fn w3_r2_ad1_late_active_and_frame_cannot_resurrect_lost_surface() {
    support::run(async {
        let (_temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        let frame1 = shared.value(1);
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":frame1}}))
            .await;
        let _ = ui.receive().await;

        let mut lost_surface = surface();
        lost_surface["state"] = "lost".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":lost_surface}}))
            .await;
        let ui_lost = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(ui_lost["data"]["surface"]["state"], "lost");
        let fence_after_loss = server.lock().unwrap().authority.state().surfaces["surface-demo"]
            .refresh_after
            .expect("lost surface must keep refresh_after fence");

        // Late out-of-order state_changed(active) must be refused with POLICY and not resurrect.
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface()}}))
            .await;
        daemon.verdict("refused", Some("POLICY")).await;

        // Late frame_ready(gen=2) must also be refused with POLICY.
        let frame2 = shared.value(2);
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":frame2.clone()}}))
            .await;
        daemon.verdict("refused", Some("POLICY")).await;

        {
            let guard = server.lock().unwrap();
            let s = &guard.authority.state().surfaces["surface-demo"];
            assert!(!s.live, "late active must not resurrect lost surface");
            assert_eq!(s.frame.as_ref().unwrap().generation, 1);
            assert_eq!(s.refresh_after, Some(fence_after_loss));
        }

        // Agent proposal after late active + frame_ready(gen=2) must still be refused.
        agent
            .send(proposal("prop-after-late-active", &frame2))
            .await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;

        close_server(server, task, daemon, agent, ui).await;
    });
}

#[test]
fn w3_r2_ad2_late_frame_ref_on_lost_surface_refused_with_policy_and_preserves_fence() {
    support::run(async {
        let (_temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        let frame1 = shared.value(1);
        daemon.send(frame1.clone()).await;
        let _ = ui.receive().await;

        let mut lost_surface = surface();
        lost_surface["state"] = "lost".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":lost_surface}}))
            .await;
        let _ = ui.receive().await;

        let (frame_before, fence_before) = {
            let guard = server.lock().unwrap();
            let s = &guard.authority.state().surfaces["surface-demo"];
            (s.frame.clone(), s.refresh_after)
        };
        assert!(fence_before.is_some());

        let frame2 = shared.value(2);
        daemon.send(frame2).await;
        let frame_msg_id = format!("daemon-test-{}", daemon.seq);
        daemon
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        let first = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(first["proposal_id"], frame_msg_id);
        assert_eq!(first["decision"], "refused");
        assert_eq!(first["reason_code"], "POLICY");
        daemon.verdict("refused", Some("POLICY")).await;

        {
            let guard = server.lock().unwrap();
            let s = &guard.authority.state().surfaces["surface-demo"];
            assert_eq!(
                s.frame, frame_before,
                "late frame_ref must not replace frame"
            );
            assert_eq!(
                s.refresh_after, fence_before,
                "late frame_ref must not clear refresh_after fence"
            );
        }

        close_server(server, task, daemon, _agent, ui).await;
    });
}

#[test]
fn w3_r2_ad3_lost_cancelled_dispatched_proposal_suppresses_late_receipt_double_settlement() {
    support::run(async {
        let (temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        let frame1 = shared.value(1);
        daemon.send(frame1.clone()).await;
        let _ = ui.receive().await;

        // 1. Takeover-cancelled draining work on a live surface must not double-settle.
        agent.send(proposal("p0-takeover-drain", &frame1)).await;
        agent.verdict("admitted", None).await;
        let _ = daemon.receive().await;

        ui.send(control("take_control")).await;
        let _ = daemon.receive().await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        assert!(server
            .lock()
            .unwrap()
            .authority
            .state()
            .draining
            .contains_key("p0-takeover-drain"));

        let mut rec0: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        rec0["proposal_id"] = "p0-takeover-drain".into();
        rec0["after_frame"] = frame1.clone();
        daemon.send(rec0).await;
        daemon_barrier(&mut daemon).await;

        {
            let guard = server.lock().unwrap();
            assert!(
                !guard
                    .authority
                    .state()
                    .draining
                    .contains_key("p0-takeover-drain"),
                "takeover draining entry must be cleared by late receipt"
            );
            assert!(
                !guard.tool_state.receipts.contains_key("p0-takeover-drain"),
                "takeover-cancelled proposal receipt must not be retained as active receipt"
            );
        }

        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        let msg0 = serde_json::to_value(agent.receive().await.body).unwrap();
        assert_eq!(
            msg0["schema"], "mv_tool_result/v0.2",
            "agent must not receive a late ActionReceipt after takeover refusal (got {msg0})"
        );

        ui.send(control("release_control")).await;
        let _ = daemon.receive().await;
        let frame2 = shared.value(2);
        daemon.send(frame2.clone()).await;
        let _ = ui.receive().await;

        // 2. Lost-cancelled draining work must also not double-settle.
        agent.send(proposal("p1-lost-drain", &frame2)).await;
        agent.verdict("admitted", None).await;
        let _ = daemon.receive().await;

        let mut lost_surface = surface();
        lost_surface["state"] = "lost".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":lost_surface}}))
            .await;
        let _ = ui.receive().await;
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;
        assert!(server
            .lock()
            .unwrap()
            .authority
            .state()
            .draining
            .contains_key("p1-lost-drain"));

        // Late ActionReceipt from daemon for the cancelled proposal must drain in authority
        // without forwarding a second terminal message to the agent or retaining in tool_state.
        let mut rec: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/action_receipt.valid.json"
        ))
        .unwrap();
        rec["proposal_id"] = "p1-lost-drain".into();
        rec["after_frame"] = frame2;
        daemon.send(rec).await;
        daemon_barrier(&mut daemon).await;

        {
            let guard = server.lock().unwrap();
            assert!(
                !guard
                    .authority
                    .state()
                    .draining
                    .contains_key("p1-lost-drain"),
                "draining entry must be cleared by late receipt"
            );
            assert!(
                !guard.tool_state.receipts.contains_key("p1-lost-drain"),
                "cancelled proposal receipt on lost surface must not be retained as active receipt"
            );
        }

        // Send a barrier tool call from agent; the very next message on agent's stream must be
        // the tool_result, proving no ActionReceipt was sent to agent.
        agent
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        let next_agent_msg = serde_json::to_value(agent.receive().await.body).unwrap();
        assert_eq!(
            next_agent_msg["schema"], "mv_tool_result/v0.2",
            "agent must not receive a late ActionReceipt after refusal verdict (got {next_agent_msg})"
        );

        close_server(server, task, daemon, agent, ui).await;

        let reopened = Server::open(
            config(),
            &temp.0.join("state"),
            serve::effective_uid().unwrap(),
        )
        .unwrap();
        assert!(!reopened
            .tool_state
            .receipts
            .contains_key("p0-takeover-drain"));
        assert!(!reopened.tool_state.receipts.contains_key("p1-lost-drain"));
    });
}

#[test]
fn w3_r2_ad4_inflight_human_input_on_lost_surface_settles_with_policy_verdict_and_witness() {
    support::run(async {
        let (temp, server, task, mut daemon, agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        let frame1 = shared.value(1);
        daemon.send(frame1).await;
        let _ = ui.receive().await;

        ui.send(control("take_control")).await;
        let _ = daemon.receive().await;

        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": "surface-demo",
                "proposal_id": "hi-inflight-lost",
                "origin": "human",
                "action": {"type": "key", "keys": ["Return"]}
            }
        }))
        .await;
        let forwarded = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(forwarded["op"], "input");
        assert!(server
            .lock()
            .unwrap()
            .human_inputs
            .contains_key("hi-inflight-lost"));

        let mut lost_surface = surface();
        lost_surface["state"] = "lost".into();
        lost_surface["control"] = "human".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":lost_surface}}))
            .await;
        daemon_barrier(&mut daemon).await;
        ui.send(control("take_control")).await;

        let first_ui = serde_json::to_value(ui.receive().await.body).unwrap();
        let second_ui = serde_json::to_value(ui.receive().await.body).unwrap();
        let (ev_msg, verdict_msg) = if first_ui["schema"] == "surface_event/v0.2" {
            (first_ui, second_ui)
        } else {
            (second_ui, first_ui)
        };
        assert_eq!(ev_msg["event"], "state_changed");
        assert_eq!(ev_msg["data"]["surface"]["state"], "lost");
        assert_eq!(verdict_msg["schema"], "action_verdict/v0.2");
        assert_eq!(verdict_msg["proposal_id"], "hi-inflight-lost");
        assert_eq!(verdict_msg["decision"], "refused");
        assert_eq!(verdict_msg["reason_code"], "POLICY");
        ui.verdict("refused", Some("POLICY")).await;
        assert!(server.lock().unwrap().human_inputs.is_empty());

        // Also verify that if sending the POLICY verdict to UI fails (e.g. UI queue overflow),
        // the settlement record is still journaled first and never lost.
        let mut s2 = surface();
        s2["surface_id"] = "surface-demo-2".into();
        s2["display"] = ":100".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":s2.clone()}}))
            .await;
        let _ = ui.receive().await;
        let mut f2 = shared.value(1);
        f2["surface_id"] = "surface-demo-2".into();
        daemon.send(f2).await;
        let _ = ui.receive().await;
        ui.send(json!({
            "schema": "ui_intent/v0.2",
            "request_id": "take-s2",
            "op": "take_control",
            "params": {"surface_id": "surface-demo-2"}
        }))
        .await;
        let _ = daemon.receive().await;
        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": "surface-demo-2",
                "proposal_id": "hi-inflight-lost-sendfail",
                "origin": "human",
                "action": {"type": "key", "keys": ["Return"]}
            }
        }))
        .await;
        let _ = daemon.receive().await;
        let _keep_old_tx_alive = {
            // Replace UI connection sender with a disconnected channel while keeping the old sender
            // alive so writer_task does not retire ui_ep, forcing refuse_at to return SendFailure::Disconnected.
            let mut guard = server.lock().unwrap();
            assert!(guard.human_inputs.contains_key("hi-inflight-lost-sendfail"));
            let ui_ep = registration("ui").endpoint;
            let (dead_tx, dead_rx) = std::sync::mpsc::sync_channel(1);
            drop(dead_rx);
            guard
                .connections
                .get_mut(&ui_ep)
                .map(|conn| std::mem::replace(&mut conn.queue, dead_tx))
        };
        s2["state"] = "lost".into();
        s2["control"] = "human".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":s2}}))
            .await;
        daemon_barrier(&mut daemon).await;
        assert!(
            server.lock().unwrap().human_inputs.is_empty(),
            "send failure must not lose the settled human_input record"
        );

        close_server(server, task, daemon, agent, ui).await;

        let reopened = Server::open(
            config(),
            &temp.0.join("state"),
            serve::effective_uid().unwrap(),
        )
        .unwrap();
        assert!(
            reopened.human_inputs.is_empty(),
            "settled human input on lost surface must not resurrect on recovery"
        );
    });
}

#[test]
fn w3_r5_clean_reopen_after_journaled_lost_emits_nothing_spontaneously_and_snapshot_shows_lost() {
    support::run(async {
        let (temp, server, task, mut daemon, mut agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;
        let shared = SharedFrame::new();
        let frame1 = shared.value(1);
        daemon.send(frame1.clone()).await;
        let _ = ui.receive().await;

        agent.send(proposal("p-live-lost", &frame1)).await;
        agent.verdict("admitted", None).await;
        let _ = daemon.receive().await;

        let mut lost_surface = surface();
        lost_surface["state"] = "lost".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":lost_surface}}))
            .await;
        let ui_live = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(ui_live["event"], "state_changed");
        assert_eq!(ui_live["data"]["surface"]["state"], "lost");
        agent
            .verdict("refused", Some("SURFACE_NOT_AGENT_CONTROLLED"))
            .await;

        close_server(server, task, daemon, agent, ui).await;

        let uid = serve::effective_uid().unwrap();
        let reopened = Server::open(config(), &temp.0.join("state"), uid).unwrap();
        let snap: Value = serde_json::from_slice(&reopened.snapshot().unwrap()).unwrap();
        assert_eq!(
            snap["surfaces"]["surface-demo"]["live"], false,
            "reopened snapshot must show the surface lost (live == false)"
        );

        let socket1 = temp.0.join("runtime/core-rec1.sock");
        let listener1 = serve::bind(&socket1, uid).await.unwrap();
        let server1 = Arc::new(Mutex::new(reopened));
        let task1 = tokio::spawn(serve::serve(listener1, server1.clone(), uid));
        let daemon1 = Peer::reconnect(&socket1, "daemon", 1).await;
        let mut agent1 = Peer::reconnect(&socket1, "agent", 1).await;
        let mut ui1 = Peer::reconnect(&socket1, "ui", 1).await;

        assert!(
            tokio::time::timeout(Duration::from_millis(50), read_frame(&mut ui1.socket))
                .await
                .is_err(),
            "clean reopen after journaled Lost must not spontaneously re-emit state_changed(lost) to UI"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), read_frame(&mut agent1.socket))
                .await
                .is_err(),
            "clean reopen after journaled Lost must not spontaneously re-emit refused verdicts to agent"
        );

        agent1
            .send(tool_call("list", json!({"cursor":null,"limit":1})))
            .await;
        let listed = serde_json::to_value(agent1.receive().await.body).unwrap();
        assert_eq!(listed["schema"], "mv_tool_result/v0.2");
        assert_eq!(listed["op"], "list");
        assert_eq!(listed["status"], "ok");
        assert_eq!(listed["surfaces"], json!([]));

        close_server(server1, task1, daemon1, agent1, ui1).await;
    });
}

#[test]
fn w3_r2_ad6_frame_subscribe_and_destroy_on_lost_surface_refused_with_policy_without_forwarding() {
    support::run(async {
        let (_temp, server, task, mut daemon, _agent, mut ui) = setup().await;
        created(&mut daemon, &mut ui).await;

        let mut lost_surface = surface();
        lost_surface["state"] = "lost".into();
        daemon
            .send(json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":lost_surface}}))
            .await;
        let _ = ui.receive().await;

        let budget_before = server.lock().unwrap().authority.state().remaining_budget;

        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "frame_subscribe",
            "params": {"surface_id": "surface-demo"}
        }))
        .await;
        let sub_msg_id = format!("ui-test-{}", ui.seq);
        ui.send(control("take_control")).await;
        let first_sub = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(first_sub["proposal_id"], sub_msg_id);
        assert_eq!(first_sub["decision"], "refused");
        assert_eq!(first_sub["reason_code"], "POLICY");
        ui.verdict("refused", Some("POLICY")).await;

        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "destroy",
            "params": {"surface_id": "surface-demo"}
        }))
        .await;
        let destroy_msg_id = format!("ui-test-{}", ui.seq);
        ui.send(control("take_control")).await;
        let first_destroy = serde_json::to_value(ui.receive().await.body).unwrap();
        assert_eq!(first_destroy["proposal_id"], destroy_msg_id);
        assert_eq!(first_destroy["decision"], "refused");
        assert_eq!(first_destroy["reason_code"], "POLICY");
        ui.verdict("refused", Some("POLICY")).await;

        {
            let guard = server.lock().unwrap();
            assert_eq!(
                guard.authority.state().remaining_budget,
                budget_before,
                "refused frame_subscribe/destroy on lost surface must not burn budget"
            );
            assert!(
                !guard
                    .subscriptions
                    .iter()
                    .any(|(_, sid)| sid == "surface-demo"),
                "lost surface must not be added to subscriptions"
            );
        }

        // Verify nothing was forwarded to daemon by sending a barrier from daemon.
        daemon_barrier(&mut daemon).await;

        close_server(server, task, daemon, _agent, ui).await;
    });
}
