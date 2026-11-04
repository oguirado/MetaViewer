//! Bounded late-agent observation replay; never replay requests or authority inputs.
use super::*;

// Leave room for Hello, a journal terminal notice, and future admission notices.
const MAX_EVENTS: usize = MAX_SEND_QUEUE - 4;
const MAX_BYTES: usize = 1_048_576;

struct Entry {
    ordinal: usize,
    body: Command,
    digest: String,
}

#[derive(Default)]
pub(super) struct Transcript {
    entries: Vec<Entry>,
    count: usize,
    tail: String,
    bytes: usize,
    unavailable: bool,
}

impl Transcript {
    fn digest(ordinal: usize, previous: &str, body: &[u8]) -> String {
        let mut bytes = (ordinal as u64).to_be_bytes().to_vec();
        bytes.extend_from_slice(previous.as_bytes());
        bytes.extend_from_slice(body);
        crate::journal::sha256_hex(&bytes)
    }
    pub(super) fn invalidate(&mut self) {
        self.unavailable = true;
    }
    pub(super) fn recovered(history: bool) -> Self {
        Self {
            unavailable: history,
            ..Self::default()
        }
    }

    /// Called only with the committed, normalized public event, before fanout.
    /// Exhaustion is sticky: never discard the create binding and replay a suffix.
    fn record(&mut self, body: Command) {
        if self.unavailable {
            return;
        }
        let Ok(bytes) = serde_json::to_vec(&body) else {
            self.unavailable = true;
            return;
        };
        if self.entries.len() >= MAX_EVENTS || bytes.len() > MAX_BYTES.saturating_sub(self.bytes) {
            self.unavailable = true;
            return;
        }
        self.bytes += bytes.len();
        let digest = Self::digest(self.count, &self.tail, &bytes);
        self.entries.push(Entry {
            ordinal: self.count,
            body,
            digest: digest.clone(),
        });
        self.count += 1;
        self.tail = digest;
    }

    fn bodies(&self, owner: &str) -> Result<Vec<Command>> {
        if self.unavailable
            || self.entries.len() != self.count
            || self.entries.len() > MAX_EVENTS
            || self.bytes > MAX_BYTES
        {
            return Err(invalid("guest observation replay unavailable: missing or exhausted transcript; start a new session"));
        }
        let mut bytes = 0usize;
        let mut previous = String::new();
        let mut bodies = Vec::with_capacity(self.entries.len());
        for (ordinal, entry) in self.entries.iter().enumerate() {
            let value = match &entry.body {
                Command::GuestCommandEvent(event) => &event.0,
                Command::RewindEvent(event) => &event.0,
                _ => return Err(invalid("invalid guest observation replay family")),
            };
            let serialized = serde_json::to_vec(&entry.body)?;
            bytes = bytes
                .checked_add(serialized.len())
                .ok_or_else(|| invalid("guest replay size overflow"))?;
            if value["owner_id"].as_str() != Some(owner)
                || entry.ordinal != ordinal
                || Self::digest(ordinal, &previous, &serialized) != entry.digest
                || bytes > MAX_BYTES
            {
                return Err(invalid("guest observation replay integrity failure"));
            }
            previous.clone_from(&entry.digest);
            // Re-run the closed event decoder before any event becomes visible.
            bodies.push(serde_json::from_slice(&serialized)?);
        }
        if bytes != self.bytes || previous != self.tail {
            return Err(invalid("guest observation replay size mismatch"));
        }
        Ok(bodies)
    }
}

impl Server {
    pub(super) fn record_guest_observation(&mut self, body: Command) {
        self.guest_agent_replay.record(body);
    }

    /// The caller has completed the socket credentials and pinned Hello checks.
    /// Non-agent peers never receive this private history.
    pub(super) fn guest_observations_for(&self, ready: &ReadyPeer) -> Result<Vec<Command>> {
        if ready.endpoint().component != Component::Agent {
            return Ok(Vec::new());
        }
        let agent = self.agent()?;
        if ready.endpoint() != &agent {
            return Err(invalid("unregistered guest observation receiver"));
        }
        if !self.authority.state().guest_command.held {
            return Ok(Vec::new());
        }
        self.guest_agent_replay
            .bodies(&crate::headless::actor_id(&agent))
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use serde_json::{json, Value};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture {
        server: Arc<Mutex<Server>>,
        root: PathBuf,
        ui: mpsc::Receiver<Envelope>,
        daemon: mpsc::Receiver<Envelope>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "late-agent-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let reg = |c: &str| -> Registration {
                serde_json::from_value(json!({"endpoint":{"component":c,"instance":format!("{c}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":c,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
            };
            let config = Config {
                session_id: "late-agent-test".into(),
                core: reg("core"),
                peers: vec![reg("agent"), reg("ui"), reg("daemon")],
            };
            let mut server = Server::open(config, &root, effective_uid().unwrap()).unwrap();
            let mut attach = |component| {
                let (tx, rx) = mpsc::sync_channel(MAX_SEND_QUEUE);
                let endpoint = server
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == component)
                    .unwrap()
                    .endpoint
                    .clone();
                server.connections.insert(
                    endpoint,
                    Connection {
                        id: 1,
                        epoch: 0,
                        queue: tx,
                        terminal: Arc::new(Mutex::new(None)),
                    },
                );
                rx
            };
            let ui = attach(Component::Ui);
            let daemon = attach(Component::Daemon);
            Self {
                server: Arc::new(Mutex::new(server)),
                root,
                ui,
                daemon,
            }
        }
        fn env(s: &Server, component: Component, body: Value, seq: u64) -> Envelope {
            let body: Command = serde_json::from_value(body).unwrap();
            Envelope {
                schema: crate::wire::envelope_schema(&body).into(),
                msg_id: format!("message-{seq}"),
                ts_ns: Clock::new(0),
                from: s
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == component)
                    .unwrap()
                    .endpoint
                    .clone(),
                to: s.config.core.endpoint.clone(),
                session_id: s.config.session_id.clone(),
                seq,
                nonce: format!("nonce-{component:?}-{seq}"),
                body,
            }
        }
        fn create_ready(&self) -> Vec<Value> {
            let mut s = self.server.lock().unwrap();
            let env = Self::env(
                &s,
                Component::Ui,
                json!({"schema":"guest_command_request/v0.2","request_id":"request-create","op":"create","params":{"profile_id":"guest-command-arm64-v1"}}),
                1,
            );
            let Command::GuestCommandRequest(r) = &env.body else {
                panic!()
            };
            let w = s.authority.retain_witness(b"synthetic-create").unwrap();
            s.guest_command_request(0, &env, r, w).unwrap();
            self.daemon.try_recv().unwrap();
            let state = &s.authority.state().guest_command;
            let mut session = json!({"schema":"guest_command_session/v0.2","workload_id":"workload-late","generation":1,"owner_id":state.actor,"profile_id":"guest-command-arm64-v1","backend":"firecracker","isa":"aarch64","phase":"starting","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}});
            let mut events = Vec::new();
            for (id, kind, data) in [
                ("event-create", "accepted", json!({"op":"create"})),
                ("event-ready", "ready", json!({})),
            ] {
                if kind == "ready" {
                    session["phase"] = json!("ready");
                }
                let state = &s.authority.state().guest_command;
                let env = Self::env(
                    &s,
                    Component::Daemon,
                    json!({"schema":"guest_command_event/v0.2","event_id":id,"request_id":"request-create","reservation_id":state.reservation,"owner_id":state.actor,"session":session,"event":kind,"data":data}),
                    2,
                );
                let Command::GuestCommandEvent(e) = &env.body else {
                    panic!()
                };
                let w = s.authority.retain_witness(b"synthetic-event").unwrap();
                s.guest_command_event(0, &env, e, 0, w).unwrap();
                events.push(serde_json::to_value(self.ui.try_recv().unwrap().body).unwrap());
            }
            events
        }
        fn rewind_request(&self, component: Component, op: &str) -> Value {
            let mut s = self.server.lock().unwrap();
            s.rewind_enabled = true;
            let target = s.authority.state().rewind.target.as_ref();
            let mut params = json!({"workload_id":"workload-late","generation":target.map_or(1, |t| t.generation),"authority_epoch":target.map_or(1, |t| t.authority_epoch)});
            if op == "mark" {
                params["label"] = json!("Before edit");
            }
            if op == "restore" {
                params["point_id"] =
                    s.authority.state().rewind.status().unwrap()["last_good_usable"].clone();
            }
            let value = json!({"schema":"rewind_request/v0.2","request_id":format!("request-{op}"),"op":op,"params":params});
            let env = Self::env(&s, component, value.clone(), 3);
            let Command::RewindRequest(r) = &env.body else {
                panic!()
            };
            let w = s
                .authority
                .retain_witness(b"synthetic-rewind-request")
                .unwrap();
            s.rewind_request(0, &env, r, w).unwrap();
            value
        }
        fn rewind_event(&self, r: &Value, kind: &str) -> Value {
            let mut s = self.server.lock().unwrap();
            let state = &s.authority.state().rewind;
            let target = state.target.as_ref().unwrap();
            let mut session = state.status().unwrap_or_else(|| {
                serde_json::from_str(include_str!(
                    "../../../contracts/examples/v0.2/rewind_session.valid.json"
                ))
                .unwrap()
            });
            if state.session.is_none() {
                session["points"] = json!([]);
                session["last_good_usable"] = Value::Null;
            }
            session["workload_id"] = json!(target.workload_id);
            session["owner_id"] = json!(target.owner_id);
            session["generation"] = json!(target.generation);
            session["authority_epoch"] = json!(target.authority_epoch);
            session["phase"] = json!(if kind == "accepted" {
                match r["op"].as_str().unwrap() {
                    "mark" => "marking",
                    "pause" => "pausing",
                    _ => "restoring",
                }
            } else if r["op"] == "pause" {
                "paused"
            } else {
                "ready"
            });
            session["pending_request_id"] = if kind == "accepted" {
                r["request_id"].clone()
            } else {
                Value::Null
            };
            let mut data = json!({"op":r["op"]});
            if kind == "completed" {
                if r["op"] == "mark" {
                    let pending = state.pending.as_ref().unwrap();
                    let mut point: Value = serde_json::from_str(include_str!(
                        "../../../contracts/examples/v0.2/rewind_point.valid.json"
                    ))
                    .unwrap();
                    point["point_id"] = json!(pending.point_id);
                    point["created_order"] = json!(pending.point_order);
                    point["source_generation"] = json!(pending.origin_generation);
                    point["source_authority_epoch"] = json!(pending.origin_epoch);
                    session["points"].as_array_mut().unwrap().push(point);
                    session["last_good_usable"] = json!(pending.point_id);
                    data["point_id"] = json!(pending.point_id);
                } else if r["op"] == "restore" {
                    for point in session["points"].as_array_mut().unwrap() {
                        point["active_references"] =
                            json!(u8::from(point["point_id"] == r["params"]["point_id"]));
                    }
                    session["last_good_usable"] = r["params"]["point_id"].clone();
                    data["point_id"] = r["params"]["point_id"].clone();
                } else {
                    data["point_id"] = Value::Null;
                }
            }
            let env = Self::env(
                &s,
                Component::Daemon,
                json!({"schema":"rewind_event/v0.2","event_id":format!("event-{}-{kind}",r["op"].as_str().unwrap()),"request_id":r["request_id"],"owner_id":target.owner_id,"event":kind,"session":session,"data":data}),
                4,
            );
            let Command::RewindEvent(e) = &env.body else {
                panic!()
            };
            let w = s
                .authority
                .retain_witness(b"synthetic-rewind-event")
                .unwrap();
            s.rewind_event(0, &env, e, 0, w).unwrap();
            serde_json::to_value(self.ui.try_recv().unwrap().body).unwrap()
        }
        fn mark(&self) -> Vec<Value> {
            let r = self.rewind_request(Component::Agent, "mark");
            assert!(matches!(
                self.daemon.try_recv().unwrap().body,
                Command::RewindRequest(_)
            ));
            vec![
                self.rewind_event(&r, "accepted"),
                self.rewind_event(&r, "completed"),
            ]
        }
        fn stop(&self) {
            let mut s = self.server.lock().unwrap();
            let env = Self::env(
                &s,
                Component::Ui,
                json!({"schema":"guest_command_request/v0.2","request_id":"request-stop","op":"stop","params":{"workload_id":"workload-late","generation":1}}),
                5,
            );
            let Command::GuestCommandRequest(r) = &env.body else {
                panic!()
            };
            let witness = s
                .authority
                .retain_witness(b"synthetic-stop-request")
                .unwrap();
            s.guest_command_request(0, &env, r, witness).unwrap();
            self.daemon.try_recv().unwrap();
            for kind in ["accepted", "stopped"] {
                let state = &s.authority.state().guest_command;
                let mut session = state.session.clone().unwrap();
                session["controls"]["stop"]["ack"] = json!("accepted");
                if kind == "stopped" {
                    session["phase"] = json!("stopped");
                    session["ownership"] = json!("released");
                }
                let data = if kind == "accepted" {
                    json!({"op":"stop"})
                } else {
                    json!({"native_absent":true})
                };
                let env = Self::env(
                    &s,
                    Component::Daemon,
                    json!({"schema":"guest_command_event/v0.2","event_id":format!("event-stop-{kind}"),"request_id":"request-stop","reservation_id":state.reservation,"owner_id":state.actor,"session":session,"event":kind,"data":data}),
                    6,
                );
                let Command::GuestCommandEvent(event) = &env.body else {
                    panic!()
                };
                let witness = s.authority.retain_witness(b"synthetic-stop-event").unwrap();
                s.guest_command_event(0, &env, event, 0, witness).unwrap();
                self.ui.try_recv().unwrap();
            }
            assert!(!s.authority.state().guest_command.held);
        }
        fn pause(&self) -> Vec<Value> {
            let r = self.rewind_request(Component::Ui, "pause");
            self.daemon.try_recv().unwrap();
            vec![
                self.rewind_event(&r, "accepted"),
                self.rewind_event(&r, "completed"),
            ]
        }
        async fn connect(
            &self,
            component: Component,
            seq: u64,
        ) -> (UnixStream, tokio::task::JoinHandle<Result<()>>) {
            let (mut client, stream) = UnixStream::pair().unwrap();
            let env = {
                let s = self.server.lock().unwrap();
                let hello = s
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == component)
                    .unwrap()
                    .hello
                    .clone();
                Self::env(&s, component, serde_json::to_value(hello).unwrap(), seq)
            };
            let server = self.server.clone();
            let task = tokio::spawn(async move {
                connection(
                    stream,
                    tokio::time::Instant::now(),
                    server,
                    effective_uid().unwrap(),
                )
                .await
            });
            write_frame(&mut client, &env).await.unwrap();
            (client, task)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(mut server) = self.server.lock() {
                let _ = server.shutdown();
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn run(f: impl Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f);
    }
    async fn receive(stream: &mut UnixStream) -> Envelope {
        tokio::time::timeout(Duration::from_millis(300), read_frame(stream))
            .await
            .expect("late agent must receive original committed observation")
            .unwrap()
            .unwrap()
    }

    #[test]
    fn late_agent_receives_committed_create_ready_without_state_change() {
        run(async {
            let f = Fixture::new();
            let expected = f.create_ready();
            let before = f.server.lock().unwrap().snapshot().unwrap();
            let (mut client, task) = f.connect(Component::Agent, 10).await;
            let hello = receive(&mut client).await;
            assert!(matches!(hello.body, Command::Hello(_)));
            let accepted = receive(&mut client).await;
            let ready = receive(&mut client).await;
            assert_eq!(
                vec![
                    serde_json::to_value(&accepted.body).unwrap(),
                    serde_json::to_value(&ready.body).unwrap()
                ],
                expected
            );
            assert!(hello.seq < accepted.seq && accepted.seq < ready.seq);
            assert_ne!(accepted.nonce, ready.nonce);
            assert_eq!(f.server.lock().unwrap().snapshot().unwrap(), before);
            assert!(f.daemon.try_recv().is_err());
            drop(client);
            task.await.unwrap().unwrap();
        });
    }

    #[test]
    fn late_agent_ui_created_restore_refused_but_mark_allowed() {
        let f = Fixture::new();
        f.create_ready();
        f.mark();
        f.pause();
        let before = f.server.lock().unwrap().authority.state().rewind.clone();
        let budget = f.server.lock().unwrap().authority.state().remaining_budget;
        // Attach an agent sink without adding any SDK state.
        let (tx, rx) = mpsc::sync_channel(16);
        {
            let mut s = f.server.lock().unwrap();
            let agent = s.agent().unwrap();
            s.connections.insert(
                agent,
                Connection {
                    id: 2,
                    epoch: 0,
                    queue: tx,
                    terminal: Arc::new(Mutex::new(None)),
                },
            );
        }
        f.rewind_request(Component::Agent, "restore");
        assert!(
            f.daemon.try_recv().is_err(),
            "human Back must not dispatch Agent restore"
        );
        let refused = serde_json::to_value(rx.try_recv().unwrap().body).unwrap();
        assert_eq!(refused["data"]["code"], "OWNER");
        assert_eq!(f.server.lock().unwrap().authority.state().rewind, before);
        assert_eq!(
            f.server.lock().unwrap().authority.state().remaining_budget,
            budget
        );
        f.rewind_request(Component::Ui, "restore");
        assert!(matches!(
            f.daemon.try_recv().unwrap().body,
            Command::RewindRequest(_)
        ));
    }

    #[test]
    fn late_agent_replays_mark_restore_order_on_fresh_reconnect() {
        run(async {
            let f = Fixture::new();
            let mut expected = f.create_ready();
            expected.extend(f.mark());
            expected.extend(f.pause());
            let r = f.rewind_request(Component::Ui, "restore");
            f.daemon.try_recv().unwrap();
            expected.push(f.rewind_event(&r, "accepted"));
            expected.push(f.rewind_event(&r, "completed"));
            assert_eq!(expected.last().unwrap()["session"]["generation"], 3);
            let before = f.server.lock().unwrap().snapshot().unwrap();
            let mut last_seq = 0;
            let mut nonces = BTreeSet::new();
            for inbound_seq in [10, 20] {
                let (mut client, task) = f.connect(Component::Agent, inbound_seq).await;
                let hello = receive(&mut client).await;
                assert!(hello.seq > last_seq);
                last_seq = hello.seq;
                for body in &expected {
                    let event = receive(&mut client).await;
                    assert_eq!(serde_json::to_value(event.body).unwrap(), *body);
                    assert!(event.seq > last_seq);
                    assert!(nonces.insert(event.nonce));
                    last_seq = event.seq;
                }
                assert_eq!(f.server.lock().unwrap().snapshot().unwrap(), before);
                assert!(f.daemon.try_recv().is_err());
                drop(client);
                task.await.unwrap().unwrap();
            }
        });
    }

    #[test]
    fn late_agent_refuses_corrupt_overflow_and_recovered_history_before_hello() {
        run(async {
            for defect in [
                "digest", "owner", "count", "bytes", "restart", "reorder", "prefix", "suffix",
            ] {
                let f = Fixture::new();
                f.create_ready();
                {
                    let mut s = f.server.lock().unwrap();
                    match defect {
                        "digest" => s.guest_agent_replay.entries[0].digest = "bad-digest".into(),
                        "owner" => {
                            let entry = &mut s.guest_agent_replay.entries[0];
                            let Command::GuestCommandEvent(event) = &mut entry.body else {
                                panic!()
                            };
                            event.0["owner_id"] = json!("actor-foreign");
                            entry.digest = super::Transcript::digest(
                                0,
                                "",
                                &serde_json::to_vec(&entry.body).unwrap(),
                            );
                        }
                        "count" => {
                            let body = s.guest_agent_replay.entries[0].body.clone();
                            for _ in 0..super::MAX_EVENTS {
                                s.record_guest_observation(body.clone());
                            }
                            assert!(s.guest_agent_replay.unavailable);
                            assert_eq!(s.guest_agent_replay.entries.len(), super::MAX_EVENTS);
                        }
                        "bytes" => {
                            let body = s.guest_agent_replay.entries[0].body.clone();
                            s.guest_agent_replay.bytes = super::MAX_BYTES;
                            s.record_guest_observation(body);
                            assert!(s.guest_agent_replay.unavailable);
                            assert_eq!(s.guest_agent_replay.entries.len(), 2);
                        }
                        "restart" => {
                            s.shutdown().unwrap();
                            let config = s.config.clone();
                            let placeholder = Server::open(
                                config.clone(),
                                &f.root.join("empty"),
                                effective_uid().unwrap(),
                            )
                            .unwrap();
                            drop(std::mem::replace(&mut *s, placeholder));
                            *s = Server::open(config, &f.root, effective_uid().unwrap()).unwrap();
                        }
                        "reorder" => s.guest_agent_replay.entries.swap(0, 1),
                        "prefix" | "suffix" => {
                            if defect == "prefix" {
                                s.guest_agent_replay.entries.remove(0);
                            } else {
                                s.guest_agent_replay.entries.pop();
                            }
                            s.guest_agent_replay.count = s.guest_agent_replay.entries.len();
                            s.guest_agent_replay.bytes = s
                                .guest_agent_replay
                                .entries
                                .iter()
                                .map(|e| serde_json::to_vec(&e.body).unwrap().len())
                                .sum();
                        }
                        _ => unreachable!(),
                    }
                }
                let before = f.server.lock().unwrap().snapshot().unwrap();
                let (mut client, task) = f.connect(Component::Agent, 10).await;
                assert!(
                    tokio::time::timeout(Duration::from_millis(500), read_frame(&mut client))
                        .await
                        .unwrap()
                        .unwrap()
                        .is_none(),
                    "{defect}: no partial Hello or replay may escape"
                );
                assert!(task.await.unwrap().is_err());
                let s = f.server.lock().unwrap();
                assert!(!s.connections.contains_key(&s.agent().unwrap()));
                assert_eq!(s.snapshot().unwrap(), before);
            }
        });
    }

    #[test]
    fn late_agent_never_replays_to_ui_or_unregistered_peer() {
        run(async {
            let f = Fixture::new();
            f.create_ready();
            {
                let mut s = f.server.lock().unwrap();
                s.connections
                    .retain(|peer, _| peer.component != Component::Ui);
            }
            let (mut client, task) = f.connect(Component::Ui, 10).await;
            assert!(matches!(receive(&mut client).await.body, Command::Hello(_)));
            assert!(
                tokio::time::timeout(Duration::from_millis(50), read_frame(&mut client))
                    .await
                    .is_err()
            );
            drop(client);
            task.await.unwrap().unwrap();
            let (mut client, stream) = UnixStream::pair().unwrap();
            let mut hello = {
                let s = f.server.lock().unwrap();
                Fixture::env(
                    &s,
                    Component::Agent,
                    serde_json::to_value(&s.config.peers[0].hello).unwrap(),
                    20,
                )
            };
            hello.from.instance = "unregistered-agent".into();
            let server = f.server.clone();
            let task = tokio::spawn(async move {
                connection(
                    stream,
                    tokio::time::Instant::now(),
                    server,
                    effective_uid().unwrap(),
                )
                .await
            });
            write_frame(&mut client, &hello).await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(500), read_frame(&mut client))
                    .await
                    .unwrap()
                    .unwrap()
                    .is_none()
            );
            assert!(task.await.unwrap().is_err());
        });
    }

    #[test]
    fn late_agent_replays_service_disconnect_as_unknown_not_ready() {
        run(async {
            let f = Fixture::new();
            let mut expected = f.create_ready();
            {
                let mut s = f.server.lock().unwrap();
                let daemon = s
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == Component::Daemon)
                    .unwrap()
                    .endpoint
                    .clone();
                s.retire(&daemon, 1);
            }
            let unknown = serde_json::to_value(f.ui.try_recv().unwrap().body).unwrap();
            assert_eq!(unknown["event"], "outcome_unknown");
            expected.push(unknown);
            let before = f.server.lock().unwrap().snapshot().unwrap();
            let (mut client, task) = f.connect(Component::Agent, 10).await;
            receive(&mut client).await;
            for body in expected {
                assert_eq!(
                    serde_json::to_value(receive(&mut client).await.body).unwrap(),
                    body
                );
            }
            assert_eq!(f.server.lock().unwrap().snapshot().unwrap(), before);
            drop(client);
            task.await.unwrap().unwrap();
        });
    }

    #[test]
    fn late_agent_closed_or_rejected_guest_history_preserves_plain_hello() {
        run(async {
            for closed in [false, true] {
                let f = Fixture::new();
                if closed {
                    f.create_ready();
                    f.stop();
                    let mut s = f.server.lock().unwrap();
                    s.shutdown().unwrap();
                    let config = s.config.clone();
                    let placeholder = Server::open(
                        config.clone(),
                        &f.root.join("empty"),
                        effective_uid().unwrap(),
                    )
                    .unwrap();
                    drop(std::mem::replace(&mut *s, placeholder));
                    *s = Server::open(config, &f.root, effective_uid().unwrap()).unwrap();
                    assert!(s.guest_agent_replay.unavailable);
                } else {
                    let mut s = f.server.lock().unwrap();
                    s.connections
                        .retain(|p, _| p.component != Component::Daemon);
                    let env = Fixture::env(
                        &s,
                        Component::Ui,
                        json!({"schema":"guest_command_request/v0.2","request_id":"request-create","op":"create","params":{"profile_id":"guest-command-arm64-v1"}}),
                        1,
                    );
                    let Command::GuestCommandRequest(r) = &env.body else {
                        panic!()
                    };
                    let witness = s
                        .authority
                        .retain_witness(b"synthetic-refused-create")
                        .unwrap();
                    s.guest_command_request(0, &env, r, witness).unwrap();
                    assert!(!s.authority.state().guest_command.held);
                    s.guest_agent_replay.invalidate();
                }
                let before = f.server.lock().unwrap().snapshot().unwrap();
                let (mut client, task) = f.connect(Component::Agent, 10).await;
                assert!(matches!(receive(&mut client).await.body, Command::Hello(_)));
                assert!(
                    tokio::time::timeout(Duration::from_millis(50), read_frame(&mut client))
                        .await
                        .is_err()
                );
                assert_eq!(f.server.lock().unwrap().snapshot().unwrap(), before);
                drop(client);
                task.await.unwrap().unwrap();
            }
        });
    }
}
