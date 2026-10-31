//! Socket regressions for admission, fanout, capture and human settlement.
//! [TARGET, unit decision] Seed replayable authority state through public APIs;
//! every behavior under test enters through the authenticated serve socket.
#![forbid(unsafe_code)]
mod support;
use metaviewer_core::admission::{Authority, CoreState, Frame, Input, Surface};
use metaviewer_core::journal::{scan, sha256_hex};
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

// Each saturation fixture routes hundreds of durable events on a single-thread
// runtime. Keep these fixtures from starving each other's live socket deadlines.
static SATURATION: Mutex<()> = Mutex::new(());

// [TARGET, unit decision] Allow 120 seconds for an observable socket/state
// transition under CI CPU and durable-journal load. This is a failure ceiling,
// never evidence that an event occurred (or did not occur).
const EVENT_BOUND: Duration = Duration::from_secs(120);

fn reply_limits() -> WireLimits {
    WireLimits::new(MAX_FRAME_BYTES, 32, 256, 65536, EVENT_BOUND, EVENT_BOUND).unwrap()
}

fn registration(instance: &str) -> Registration {
    let component = if instance.starts_with("ui") {
        "ui"
    } else {
        instance
    };
    serde_json::from_value(json!({"endpoint":{"component":component,"instance":instance},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
}
fn config() -> Config {
    Config {
        session_id: "serve-mut".into(),
        core: registration("core"),
        peers: vec![
            registration("daemon"),
            registration("agent"),
            registration("ui"),
            registration("ui-healthy"),
        ],
    }
}
fn frame(generation: u64) -> Value {
    let mut v: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    v["width"] = 2.into();
    v["height"] = 2.into();
    v["sha256"] = sha256_hex(&[7; 12]).into();
    v["generation"] = generation.into();
    v
}
fn proposal(id: &str, generation: u64) -> Value {
    json!({"schema":"action_proposal/v0.2","proposal_id":id,"surface_id":"surface-demo",
        "based_on_frame":{"sha256":frame(1)["sha256"],"generation":generation},
        "action":{"type":"key","keys":["a"]},"expectation":{"type":"text_present","text":"ready"},
        "budget":{"max_ms":1000,"max_retries":1}})
}
fn error(detail: &str) -> Value {
    json!({"schema":"surface_event/v0.2","event":"error","data":{"surface_id":"surface-demo","code":"CLI_FAILED","detail":detail}})
}
fn unsupported() -> Value {
    json!({"schema":"ui_intent/v0.2","request_id":"fill","op":"fold","params":{"slot_id":"missing"}})
}
struct Peer {
    socket: BufReader<UnixStream>,
    component: String,
    seq: u64,
    received_ns: u64,
}
impl Peer {
    async fn connect(path: &Path, component: &str) -> Self {
        let mut p = Self {
            socket: BufReader::new(
                tokio::time::timeout(EVENT_BOUND, UnixStream::connect(path))
                    .await
                    .expect("bounded fixture connect")
                    .unwrap(),
            ),
            component: component.into(),
            seq: 0,
            received_ns: 0,
        };
        p.send(serde_json::to_value(registration(component).hello).unwrap())
            .await;
        assert_eq!(p.receive().await["schema"], "hello/v0.2");
        p
    }
    fn envelope(&mut self, body: Value) -> Envelope {
        self.seq += 1;
        serde_json::from_value(json!({"schema":"envelope/v0.2","msg_id":format!("{}-{}",self.component,self.seq),
            "ts_ns":0,"from":registration(&self.component).endpoint,"to":registration("core").endpoint,
            "session_id":"serve-mut","seq":self.seq,"nonce":format!("{}-{}",self.component,self.seq),"body":body})).unwrap()
    }
    async fn send(&mut self, body: Value) {
        self.send_if_connected(body).await.unwrap();
    }
    async fn send_if_connected(&mut self, body: Value) -> std::io::Result<()> {
        let env = self.envelope(body);
        // Fixture construction needs no second full contract validation: the
        // authenticated server still decodes every byte, and receive validates
        // its replies. Buffer reads to avoid one socket syscall per reply byte.
        let mut bytes = serde_json::to_vec(&env).unwrap();
        bytes.push(b'\n');
        tokio::time::timeout(EVENT_BOUND, self.socket.write_all(&bytes))
            .await
            .expect("bounded fixture write")
    }
    async fn receive(&mut self) -> Value {
        tokio::time::timeout(EVENT_BOUND, async {
            loop {
                let env = read_frame_with_limits(&mut self.socket, &reply_limits())
                    .await
                    .expect("valid frame")
                    .expect("peer remains connected");
                self.received_ns = env.ts_ns.get();
                // A loaded fixture can cross the real server's probe interval.
                // Acknowledge probes as a daemon would; they are not test replies.
                if self.component == "daemon" && env.msg_id.starts_with("core-keepalive-") {
                    assert_eq!(serde_json::to_value(&env.body).unwrap()["op"], "list");
                    self.send(json!({"schema":"surface_event/v0.2","event":"error",
                        "data":{"surface_id":"daemon","code":"DAEMON_KEEPALIVE",
                        "detail":"core-keepalive"}}))
                        .await;
                    continue;
                }
                return serde_json::to_value(env.body).unwrap();
            }
        })
        .await
        .expect("bounded reply wait")
    }
    async fn verdict(&mut self, id: &str, decision: &str, reason: Option<&str>) {
        let v = self.receive().await;
        assert_eq!(v["schema"], "action_verdict/v0.2", "{v}");
        assert_eq!(v["decision"], decision, "{v}");
        assert_eq!(v["proposal_id"], id, "{v}");
        if let Some(r) = reason {
            assert_eq!(v["reason_code"], r, "{v}");
        }
    }
    // One preloaded socket write and a current-thread runtime keep the reply
    // writer asleep until the complete burst fills the bounded application queue.
    fn burst(&mut self, bodies: impl IntoIterator<Item = Value>) {
        let mut bytes = Vec::new();
        for body in bodies {
            serde_json::to_writer(&mut bytes, &self.envelope(body)).unwrap();
            bytes.push(b'\n');
        }
        assert_eq!(
            self.socket.get_ref().try_write(&bytes).unwrap(),
            bytes.len(),
            "burst must be preloaded atomically"
        );
    }
}
struct Harness {
    temp: support::Temp,
    socket: PathBuf,
    server: Arc<Mutex<Server>>,
    task: tokio::task::JoinHandle<serve::Result<()>>,
}
impl Harness {
    async fn new(human: bool) -> Self {
        let temp = support::Temp::new();
        let state = temp.0.join("state");
        let mut authority =
            Authority::create(&state, CoreState::session("serve-mut").unwrap()).unwrap();
        // A recovered executor epoch avoids the independent epoch-zero refusal.
        // No daemon socket is connected until the test explicitly connects one.
        authority.apply(Input::Connect).unwrap();
        let witness = authority
            .retain_frame_witness(frame(1)["sha256"].as_str().unwrap(), &[7; 12])
            .unwrap();
        authority
            .apply_with_witnesses(
                Input::Surface {
                    id: "surface-demo".into(),
                    surface: Surface {
                        display: ":101".into(),
                        owner: registration("agent").endpoint,
                        agent_controlled: !human,
                        live: true,
                        frame: Some(Frame {
                            sha256: frame(1)["sha256"].as_str().unwrap().into(),
                            generation: 1,
                            width: 2,
                            height: 2,
                        }),
                        refresh_after: None,
                        allowed_verbs: vec![],
                    },
                },
                vec![witness],
            )
            .unwrap();
        drop(authority);
        let uid = support::uid();
        let socket = temp.0.join("runtime/core.sock");
        let listener = serve::bind(&socket, uid).await.unwrap();
        let server = Arc::new(Mutex::new(Server::open(config(), &state, uid).unwrap()));
        let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
        Self {
            temp,
            socket,
            server,
            task,
        }
    }
    async fn peer(&self, component: &str) -> Peer {
        Peer::connect(&self.socket, component).await
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&self.server.lock().unwrap().snapshot().unwrap()).unwrap()
    }
    fn root(&self) -> PathBuf {
        self.temp.0.join("state/sessions/serve-mut")
    }
    fn events(&self) -> Vec<Value> {
        let state = self.state();
        let root = self.root();
        let replay = scan(&root.join("journal.jsonl"), &root).unwrap();
        assert_eq!(serde_json::to_value(replay.state).unwrap(), state);
        (1..=state["core_seq"].as_u64().unwrap())
            .map(|seq| {
                serde_json::from_slice(
                    &std::fs::read(root.join("events").join(format!("{seq}.json"))).unwrap(),
                )
                .unwrap()
            })
            .collect()
    }
    async fn finish(self) {
        let _ = self.finish_with_events().await;
    }
    async fn finish_with_events(mut self) -> Vec<Value> {
        self.task.abort();
        let _ = (&mut self.task).await;
        self.server.lock().unwrap().shutdown().unwrap();
        self.events()
    }
}

#[test]
fn m1_missing_daemon_refuses_once_and_connected_control_dispatches() {
    support::run(async {
        let h = Harness::new(false).await;
        let mut agent = h.peer("agent").await;
        let before = h.events().len();
        agent.send(proposal("offline", 1)).await;
        // Refusals echo the proposal id, distinct from the envelope msg_id.
        agent.verdict("offline", "refused", Some("POLICY")).await;
        let events = h.events();
        assert_eq!(events.len(), before + 1);
        assert_eq!(events.last().unwrap()["input"]["event"], "Refuse");
        assert_eq!(h.state()["pending"], json!({}));
        assert_eq!(h.state()["leases"], json!({}));
        let mut daemon = h.peer("daemon").await;
        let mut ui = h.peer("ui").await;
        let pixels = Pixels::new();
        daemon.send(pixels.frame(2)).await;
        assert_eq!(ui.receive().await["generation"], 2);
        agent.send(proposal("online", 2)).await;
        agent.verdict("online", "admitted", None).await;
        assert_eq!(daemon.receive().await["params"]["proposal_id"], "online");
        drop((agent, daemon, ui));
        h.finish().await;
    });
}

#[test]
fn m4_refused_overflow_does_not_dispatch_fail_but_admitted_overflow_does() {
    let _saturation = SATURATION.lock().unwrap_or_else(|error| error.into_inner());
    for admitted in [false, true] {
        support::run(async {
            let h = Harness::new(false).await;
            let mut daemon = h.peer("daemon").await;
            let mut ui = h.peer("ui").await;
            let pixels = Pixels::new();
            daemon.send(pixels.frame(2)).await;
            assert_eq!(ui.receive().await["generation"], 2);
            let mut agent = h.peer("agent").await;
            let before = h.events().len();
            agent.burst(
                (0..MAX_SEND_QUEUE)
                    .map(|_| unsupported())
                    .chain(std::iter::once(proposal(
                        "overflow",
                        if admitted { 2 } else { 3 },
                    ))),
            );
            // Await journal progress via another socket, whose request also proves
            // that terminal overflow on the agent did not poison the server.
            ui.send(unsupported()).await;
            ui.verdict("fill", "refused", Some("POLICY")).await;
            assert_eq!(h.state()["leases"], json!({}));
            assert_eq!(h.state()["pending"], json!({}));
            let mut overflow = false;
            for _ in 0..=MAX_SEND_QUEUE {
                let v = agent.receive().await;
                if v["data"]["code"] == "QUEUE_OVERFLOW" {
                    overflow = true;
                    break;
                }
            }
            assert!(
                overflow,
                "must exercise queue overflow, not a disconnected peer"
            );
            drop((agent, daemon, ui));
            // Drain the live overflow reply before doing the expensive replay.
            // Teardown returns the same fully replay-checked journal used for the
            // refusal/admission assertions; no second identical replay is needed.
            let events = h.finish_with_events().await;
            let events = &events[before..];
            let attempts: Vec<_> = events
                .iter()
                .filter(|e| e["input"]["event"] == "Propose")
                .collect();
            assert_eq!(
                attempts.len(),
                1,
                "proposal must reach admission before overflow"
            );
            if admitted {
                assert!(attempts[0]["outcome"]["reason"].is_null(), "{attempts:?}");
            }
            if !admitted {
                assert_eq!(attempts[0]["outcome"]["reason"], "STALE_FRAME");
            }
            let failures = events
                .iter()
                .filter(|e| e["input"]["event"] == "DispatchFailed")
                .count();
            assert_eq!(
                failures,
                usize::from(admitted),
                "only admitted unsent work needs release"
            );
        });
    }
}

async fn human_input(ui: &mut Peer, daemon: &mut Peer, id: &str) {
    ui.send(json!({"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"surface-demo","proposal_id":id,"origin":"human","action":{"type":"key","keys":["a"]}}})).await;
    let command = daemon.receive().await;
    assert_eq!(command["params"]["proposal_id"], id);
    assert_eq!(command["params"]["origin"], "human");
}
fn receipt(id: &str, verified: bool, error: &str) -> Value {
    let mut v: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/action_receipt.valid.json"
    ))
    .unwrap();
    v["proposal_id"] = id.into();
    v["verified"] = verified.into();
    v["error"] = error.into();
    v["after_frame"] = frame(1);
    v
}
#[test]
fn m5_adapter_refusals_preserve_typed_reason_on_receipt_and_case4() {
    support::run(async {
        let h = Harness::new(true).await;
        let mut daemon = h.peer("daemon").await;
        let mut ui = h.peer("ui").await;
        for (i, (detail, reason)) in [
            ("LOCKED_BY_OTHER", "LOCKED_BY_OTHER"),
            ("SURFACE_NOT_HUMAN_CONTROLLED", "LOCKED_BY_OTHER"),
            ("OUT_OF_BOUNDS", "OUT_OF_BOUNDS"),
            ("invalid click", "OUT_OF_BOUNDS"),
            ("STALE_FRAME", "STALE_FRAME"),
            ("BUDGET_EXCEEDED", "BUDGET_EXCEEDED"),
            ("BUDGET_EXHAUSTED", "BUDGET_EXCEEDED"),
            (
                "SURFACE_NOT_AGENT_CONTROLLED",
                "SURFACE_NOT_AGENT_CONTROLLED",
            ),
            (
                "human control blocks agent input",
                "SURFACE_NOT_AGENT_CONTROLLED",
            ),
            ("unknown adapter failure", "POLICY"),
        ]
        .iter()
        .enumerate()
        {
            for case4 in [false, true] {
                let id = format!("reason-{i}-{case4}");
                human_input(&mut ui, &mut daemon, &id).await;
                if case4 {
                    let event = error(&format!("input failed: {detail}"));
                    daemon.send(event.clone()).await;
                    assert_eq!(ui.receive().await, event);
                } else {
                    daemon.send(receipt(&id, false, detail)).await;
                }
                ui.verdict(&id, "refused", Some(reason)).await;
            }
        }
        assert_eq!(
            h.events()
                .iter()
                .filter(|e| e["input"]["event"] == "HumanInput")
                .count(),
            20
        );
        drop((ui, daemon));
        h.finish().await;
    });
}
#[test]
fn m6_verified_empty_error_is_policy_and_case4_only_settles_prefixed_oldest() {
    support::run(async {
        let h = Harness::new(true).await;
        let mut daemon = h.peer("daemon").await;
        let mut ui = h.peer("ui").await;
        human_input(&mut ui, &mut daemon, "verified").await;
        daemon.send(receipt("verified", true, "")).await;
        ui.verdict("verified", "refused", Some("POLICY")).await;
        // Negative control: an unverified empty-error receipt is admitted.
        human_input(&mut ui, &mut daemon, "unverified").await;
        daemon.send(receipt("unverified", false, "")).await;
        ui.verdict("unverified", "admitted", None).await;
        human_input(&mut ui, &mut daemon, "oldest").await;
        human_input(&mut ui, &mut daemon, "newest").await;
        let notice = error("OUT_OF_BOUNDS: background observation failed");
        daemon.send(notice.clone()).await;
        assert_eq!(ui.receive().await, notice);
        // Ordered same-peer barrier catches any unwanted settlement verdict
        // without relying on a short timeout as evidence of absence.
        ui.send(unsupported()).await;
        ui.verdict("fill", "refused", Some("POLICY")).await;
        let failure = error("input failed: OUT_OF_BOUNDS");
        daemon.send(failure.clone()).await;
        assert_eq!(ui.receive().await, failure);
        ui.verdict("oldest", "refused", Some("OUT_OF_BOUNDS")).await;
        daemon.send(failure.clone()).await;
        assert_eq!(ui.receive().await, failure);
        ui.verdict("newest", "refused", Some("OUT_OF_BOUNDS")).await;
        drop((ui, daemon));
        h.finish().await;
    });
}

struct Pixels(PathBuf);
impl Pixels {
    fn new() -> Self {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = PathBuf::from(format!(
            "/dev/shm/mv-serve-mut-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(&[7; 12]).unwrap();
        Self(path)
    }
    fn frame(&self, generation: u64) -> Value {
        let mut v = frame(generation);
        v["ramws_path"] = self.0.to_str().unwrap().into();
        v
    }
}
impl Drop for Pixels {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn fanout_with_saturated_first_ui(frames: bool) {
    let h = Harness::new(false).await;
    let mut daemon = h.peer("daemon").await;
    let mut victim = h.peer("ui").await;
    let mut healthy = h.peer("ui-healthy").await;
    assert!(registration("ui").endpoint < registration("ui-healthy").endpoint);
    victim
        .send(json!({"schema":"surface_request/v0.2","op":"list","params":{}}))
        .await;
    assert_eq!(daemon.receive().await["op"], "list");
    let pixels = Pixels::new();
    // Each healthy receive is a routing barrier, preventing frame batch
    // supersession and continuously draining the healthy observer.
    let messages = MAX_SEND_QUEUE * if frames { 5 } else { 3 } / 2;
    let mut heartbeat_ns = healthy.received_ns;
    let mut victim_retired = false;
    for i in 0..messages {
        // Use observed server-clock progress, not a count of frames assumed to
        // finish before the idle deadline. Never drain the saturation victim.
        if healthy.received_ns.saturating_sub(heartbeat_ns) >= (IDLE_DEADLINE.as_nanos() / 4) as u64
        {
            if !victim_retired {
                match victim
                    .send_if_connected(json!({"schema":"surface_request/v0.2",
                    "op":"list","params":{}}))
                    .await
                {
                    Ok(()) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                        ) =>
                    {
                        victim_retired = true
                    }
                    Err(error) => panic!("victim heartbeat: {error}"),
                }
            }
            // Distinct operation marks the healthy barrier even if the victim
            // has just retired. The final overflow assertion still proves why
            // that peer closed; a disconnect alone can never pass this test.
            healthy
                .send(json!({"schema":"surface_request/v0.2",
                "op":"frame_subscribe","params":{"surface_id":"surface-demo"}}))
                .await;
            loop {
                let command = daemon.receive().await;
                if command["op"] == "frame_subscribe" {
                    break;
                }
                assert_eq!(command["op"], "list");
            }
            heartbeat_ns = daemon.received_ns;
        }
        let body = if frames {
            pixels.frame(i as u64 + 2)
        } else {
            error(&format!("{i}:{}", "x".repeat(2048)))
        };
        daemon.send(body.clone()).await;
        assert_eq!(
            healthy.receive().await,
            body,
            "fanout item {i}, frames={frames}"
        );
    }
    let mut overflow = false;
    for _ in 0..messages {
        let v = victim.receive().await;
        if v["data"]["code"] == "QUEUE_OVERFLOW" {
            overflow = true;
            break;
        }
    }
    assert!(overflow, "victim must actually saturate; frames={frames}");
    drop((victim, healthy, daemon));
    h.finish().await;
}
#[test]
fn m2_notice_fanout_continues_after_saturated_first_ui() {
    let _saturation = SATURATION.lock().unwrap_or_else(|error| error.into_inner());
    support::run(fanout_with_saturated_first_ui(false));
}
#[test]
fn m2_frame_fanout_continues_after_saturated_first_ui() {
    let _saturation = SATURATION.lock().unwrap_or_else(|error| error.into_inner());
    support::run(fanout_with_saturated_first_ui(true));
}
async fn capture_message(ui: &mut Peer, code: &str) -> Value {
    for _ in 0..16 {
        let v = ui.receive().await;
        if v["data"]["code"] == code {
            return serde_json::from_str(v["data"]["detail"].as_str().unwrap()).unwrap();
        }
    }
    panic!("missing {code}");
}
#[test]
fn m3_capture_publishes_recording_state_for_frames_and_stop() {
    support::run(async {
        let h = Harness::new(false).await;
        let mut daemon = h.peer("daemon").await;
        let mut ui = h.peer("ui").await;
        let pixels = Pixels::new();
        daemon.send(pixels.frame(2)).await;
        assert_eq!(ui.receive().await["generation"], 2);
        ui.send(json!({"schema":"record_request/v0.2","request_id":"start","op":"ram_start","params":{"surface_id":"surface-demo","recording_id":"state-recording","ring_bytes":8388608,"max_fps":30}})).await;
        let reply = capture_message(&mut ui, "CAPTURE_REPLY").await;
        assert_eq!(reply["request_id"], "start");
        assert_eq!(reply["reply"]["ok"], true);
        let state = capture_message(&mut ui, "CAPTURE_STATE").await;
        assert_eq!(state["recording_id"], "state-recording");
        assert_eq!(state["frames"], 1);
        // The start state and its envelope share the capture's server clock.
        // Wait for that clock to cross the configured decimation period through
        // ordered request/reply barriers, rather than guessing with a sleep.
        let capture_ns = ui.received_ns;
        // A separate observer keeps the recording UI's pending record events
        // in order for capture_message to consume, just as before.
        let mut clock_peer = h.peer("ui-healthy").await;
        tokio::time::timeout(EVENT_BOUND, async {
            while clock_peer.received_ns / 1_000_000 < capture_ns / 1_000_000 + 1000 / 30 {
                clock_peer.send(unsupported()).await;
                clock_peer.verdict("fill", "refused", Some("POLICY")).await;
            }
        })
        .await
        .expect("capture clock reaches next frame period");
        drop(clock_peer);
        daemon.send(pixels.frame(3)).await;
        let state = capture_message(&mut ui, "CAPTURE_STATE").await;
        assert_eq!(state["type"], "capture.state");
        assert_eq!(state["recording_id"], "state-recording");
        assert_eq!(state["surface_id"], "surface-demo");
        assert_eq!(state["frames"], 2);
        ui.send(json!({"schema":"record_request/v0.2","request_id":"stop","op":"ram_stop","params":{"surface_id":"surface-demo","recording_id":"state-recording"}})).await;
        let reply = capture_message(&mut ui, "CAPTURE_REPLY").await;
        assert_eq!(reply["reply"]["ok"], true);
        let state = capture_message(&mut ui, "CAPTURE_STATE").await;
        assert_eq!(state["recording_id"], "state-recording");
        assert_eq!(state["phase"], "sealed");
        assert_eq!(state["frames"], 2);
        let rows = h
            .server
            .lock()
            .unwrap()
            .capture_request(&registration("ui").endpoint, "list", Value::Null)
            .unwrap();
        assert!(rows["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "state-recording" && r["frames"] == 2 && r["phase"] == "sealed"));
        drop((ui, daemon));
        h.finish().await;
    });
}

#[test]
fn missing_daemon_refusal_must_echo_proposal_id() {
    support::run(async {
        let h = Harness::new(false).await;
        let mut agent = h.peer("agent").await;
        agent.send(proposal("offline-correlated", 1)).await;
        agent
            .verdict("offline-correlated", "refused", Some("POLICY"))
            .await;
        drop(agent);
        h.finish().await;
    });
}
