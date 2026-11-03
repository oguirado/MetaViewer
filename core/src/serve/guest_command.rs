//! Serialized authenticated routing for the additive guest command family.
use super::*;
use crate::wire::guest_command::{GuestCommandEvent, GuestCommandRequest};
use serde_json::{json, Value};
impl Server {
    fn guest_command_receivers(&self) -> Result<BTreeSet<Endpoint>> {
        let mut receivers = BTreeSet::from([self.agent()?]);
        let state = &self.authority.state().guest_command;
        if let Some(p) = &state.creator {
            receivers.insert(p.clone());
        }
        for p in state.pending.values() {
            receivers.insert(p.caller.clone());
        }
        Ok(receivers)
    }
    fn guest_command_refused(
        &mut self,
        now: u64,
        env: &Envelope,
        r: &GuestCommandRequest,
        code: &str,
        boundary: Witness,
    ) -> Result<()> {
        let out = self.authority.apply_with_witnesses(
            Input::GuestCommandRefused {
                request_id: r.0["request_id"].as_str().unwrap().to_owned(),
            },
            vec![boundary],
        )?;
        let state = &self.authority.state().guest_command;
        let agent = self.agent()?;
        let matched = state.held
            && (state.creator.as_ref() == Some(&env.from) || env.from == agent)
            && state.session.as_ref().is_some_and(|s| {
                r.0["params"]["workload_id"] == s["workload_id"]
                    && r.0["params"]["generation"] == s["generation"]
            });
        let reservation = if matched {
            state.reservation.clone().unwrap()
        } else {
            crate::guest_command::reservation_id(
                &env.session_id,
                r.0["request_id"].as_str().unwrap(),
            )
        };
        let session = if matched { state.session.clone() } else { None };
        let event = serde_json::from_value(
            json!({"schema":"guest_command_event/v0.2","event_id":format!("event-core-{}",out.core_seq),"request_id":r.0["request_id"],"reservation_id":reservation,"owner_id":crate::headless::actor_id(&agent),"session":session,"event":"refused","data":{"op":r.0["op"],"code":code}}),
        )?;
        self.send_at(now, &env.from, Command::GuestCommandEvent(Box::new(event)))
    }
    pub(super) fn guest_command_request(
        &mut self,
        now: u64,
        env: &Envelope,
        r: &GuestCommandRequest,
        boundary: Witness,
    ) -> Result<()> {
        self.poll_guest_command_at(now)?;
        let agent = self.agent()?;
        let daemon = self
            .config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Daemon)
            .ok_or_else(|| invalid("no daemon"))?
            .endpoint
            .clone();
        if !self.connections.contains_key(&daemon) {
            return self.guest_command_refused(now, env, r, "UNAVAILABLE", boundary);
        }
        let other = self.authority.state().has_unclosed_graphical_custody()
            || self.authority.state().headless.held;
        let mut preview = self.authority.state().guest_command.clone();
        if let Err(code) = preview.submit(r, &env.from, &agent, &env.session_id, now, other) {
            return self.guest_command_refused(now, env, r, code, boundary);
        }
        if self.authority.state().remaining_budget == 0
            && !matches!(r.0["op"].as_str(), Some("cancel" | "stop"))
        {
            return self.guest_command_refused(now, env, r, "CAPACITY", boundary);
        }
        let out = self.authority.apply_with_witnesses(
            Input::GuestCommandRequest {
                request: r.clone(),
                caller: env.from.clone(),
                agent,
                other_resources: other,
                received_ns: now,
            },
            vec![boundary],
        )?;
        if out.reason.is_some() {
            return Err(invalid("guest command serialized admission changed"));
        }
        if let Err(e) = self.send_at(now, &daemon, env.body.clone()) {
            self.mark_guest_command_unknown(now)?;
            return Err(e);
        }
        Ok(())
    }
    pub(super) fn guest_command_event(
        &mut self,
        now: u64,
        env: &Envelope,
        e: &GuestCommandEvent,
        epoch: u64,
        boundary: Witness,
    ) -> Result<()> {
        self.poll_guest_command_at(now)?;
        let receivers = self.guest_command_receivers()?;
        let out = self.authority.apply_with_witnesses(
            Input::GuestCommandEvent {
                notice: e.clone(),
                executor_epoch: epoch,
            },
            vec![boundary],
        )?;
        if let Some(reason) = out.reason {
            self.mark_guest_command_unknown(now)?;
            return self.refuse_at(now, &env.from, &env.msg_id, reason, out.core_seq);
        }
        // Preserve the exact daemon witness in the journal, but publish the
        // core's normalized snapshot including controls queued after that witness.
        let mut forwarded = e.clone();
        forwarded.0["session"] = self
            .authority
            .state()
            .guest_command
            .session
            .clone()
            .unwrap_or(Value::Null);
        for p in receivers {
            if self.connections.contains_key(&p) {
                let _ = self.send_at(
                    now,
                    &p,
                    Command::GuestCommandEvent(Box::new(forwarded.clone())),
                );
            }
        }
        Ok(())
    }
    pub(super) fn poll_guest_command_at(&mut self, now: u64) -> Result<()> {
        if self.authority.state().guest_command.expired(now) {
            self.mark_guest_command_unknown(now)?;
        }
        Ok(())
    }
    pub(super) fn mark_guest_command_unknown(&mut self, now: u64) -> Result<()> {
        let old = self.authority.state().guest_command.clone();
        if !old.held || (old.unknown && old.pending.values().all(|p| p.unknown)) {
            return Ok(());
        }
        let receivers = self.guest_command_receivers()?;
        let out = self.authority.apply(Input::GuestCommandUncertain)?;
        let state = &self.authority.state().guest_command;
        let session = state.session.clone();
        let reservation = state.reservation.clone();
        let owner = state.actor.clone();
        // One authoritative failure settles all local waiters. Sending a second
        // control failure after the first global unknown would create ambiguity.
        let primary = ["run", "stop", "cancel", "create"].iter().find_map(|op| {
            old.pending
                .iter()
                .find(|(_, p)| !p.unknown && p.request["op"] == *op)
                .map(|(id, p)| (id.clone(), p.request["op"].clone()))
        });
        let notices: Vec<(String, Value)> = primary
            .or_else(|| {
                old.create_id
                    .as_ref()
                    .map(|id| (id.clone(), json!("create")))
            })
            .into_iter()
            .collect();
        for (index, (id, op)) in notices.iter().enumerate() {
            let e: GuestCommandEvent = serde_json::from_value(
                json!({"schema":"guest_command_event/v0.2","event_id":format!("event-core-{}-{}",out.core_seq,index),"request_id":id,"reservation_id":reservation,"owner_id":owner,"session":session,"event":"outcome_unknown","data":{"op":op,"code":"TRANSPORT"}}),
            )?;
            for p in &receivers {
                if self.connections.contains_key(p) {
                    let _ = self.send_at(now, p, Command::GuestCommandEvent(Box::new(e.clone())));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        server: Server,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "guest-command-core-{}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let reg = |c: &str| -> Registration {
                serde_json::from_value(json!({"endpoint":{"component":c,"instance":format!("{c}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":c,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
            };
            let config = Config {
                session_id: "guest-command-test".into(),
                core: reg("core"),
                peers: vec![reg("agent"), reg("ui"), reg("daemon")],
            };
            let server = Server::open(config, &root, effective_uid().unwrap()).unwrap();
            Self { server, root }
        }
        fn endpoint(&self, c: Component) -> Endpoint {
            self.server
                .config
                .peers
                .iter()
                .find(|r| r.endpoint.component == c)
                .unwrap()
                .endpoint
                .clone()
        }
        fn attach(&mut self, c: Component) -> mpsc::Receiver<Envelope> {
            let (tx, rx) = mpsc::sync_channel(16);
            self.server.connections.insert(
                self.endpoint(c),
                Connection {
                    id: 1,
                    epoch: 0,
                    queue: tx,
                    terminal: Arc::new(Mutex::new(None)),
                },
            );
            rx
        }
        fn env(&self, c: Component, body: Value) -> Envelope {
            let command: Command = serde_json::from_value(body.clone()).unwrap();
            let schema = crate::wire::envelope_schema(&command);
            serde_json::from_value(json!({"schema":schema,"msg_id":"message-test","ts_ns":0,"from":self.endpoint(c),"to":self.server.config.core.endpoint,"session_id":"guest-command-test","seq":1,"nonce":"nonce-test","body":body})).unwrap()
        }
        fn create(&self) -> Envelope {
            self.env(Component::Ui,json!({"schema":"guest_command_request/v0.2","request_id":"request-create","op":"create","params":{"profile_id":"guest-command-arm64-v1"}}))
        }
        fn dispatch(&mut self, env: Envelope) -> Result<()> {
            let body = env.body.clone();
            let w = self
                .server
                .authority
                .retain_witness(b"guest-command-test-boundary")?;
            if let Command::GuestCommandRequest(r) = body {
                self.server.guest_command_request(0, &env, &r, w)
            } else {
                panic!("request")
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.server.authority.flush_sync();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn reserve_before_dispatch_and_failed_queue_keeps_unknown() {
        let mut f = Fixture::new();
        let daemon = f.attach(Component::Daemon);
        let _ui = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        assert!(f.server.authority.state().guest_command.held);
        let outbound = daemon.try_recv().unwrap();
        assert_eq!(outbound.schema, "capsule_envelope/v0.2");
        assert!(crate::decode_envelope(&serde_json::to_string(&outbound).unwrap()).is_ok());
        assert!(matches!(outbound.body, Command::GuestCommandRequest(_)));
        let mut f = Fixture::new();
        drop(f.attach(Component::Daemon));
        let _ui = f.attach(Component::Ui);
        assert!(f.dispatch(f.create()).is_err());
        let s = &f.server.authority.state().guest_command;
        assert!(s.held && s.unknown);
    }
    #[test]
    fn unavailable_refusal_is_correlation_only() {
        let mut f = Fixture::new();
        let ui = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        assert!(!f.server.authority.state().guest_command.held);
        let outbound = ui.try_recv().unwrap();
        assert_eq!(outbound.schema, "capsule_envelope/v0.2");
        assert!(crate::decode_envelope(&serde_json::to_string(&outbound).unwrap()).is_ok());
        let v = serde_json::to_value(outbound.body).unwrap();
        assert_eq!(v["event"], "refused");
        assert!(v["session"].is_null());
        assert_eq!(
            v["reservation_id"],
            crate::guest_command::reservation_id("guest-command-test", "request-create")
        );
    }
    #[test]
    fn capacity_blocks_both_providers_and_graphical() {
        let mut f = Fixture::new();
        let _d = f.attach(Component::Daemon);
        let _u = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        let graphic=serde_json::from_value(json!({"schema":"surface_request/v0.2","op":"create","params":{"kind":"vm","profile_id":"vm-profile","geometry":{"w":1280,"h":900}}})).unwrap();
        assert_eq!(
            f.server
                .authority
                .apply(Input::SurfaceRequest { request: graphic })
                .unwrap()
                .reason,
            Some(Refusal::Policy)
        );
        let headless=serde_json::from_value(json!({"schema":"headless_request/v0.2","request_id":"request-headless","op":"create","params":{"template":"headless-sumsq"}})).unwrap();
        let agent = f.endpoint(Component::Agent);
        let ui = f.endpoint(Component::Ui);
        assert_eq!(
            f.server
                .authority
                .apply(Input::HeadlessRequest {
                    request: headless,
                    caller: ui,
                    agent,
                    graphical_seen: false,
                    received_ns: 0
                })
                .unwrap()
                .reason,
            Some(Refusal::Policy)
        );
        let mut f = Fixture::new();
        let d = f.attach(Component::Daemon);
        let u = f.attach(Component::Ui);
        f.server.headless_graphical_seen = true;
        let owner = f.endpoint(Component::Agent);
        f.server
            .authority
            .apply(Input::Lifecycle {
                surface_id: "surface-active".into(),
                update: crate::admission::LifecycleUpdate::Created(crate::admission::Surface {
                    display: "display-active".into(),
                    owner,
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                }),
            })
            .unwrap();
        f.dispatch(f.create()).unwrap();
        assert!(d.try_recv().is_err());
        assert_eq!(
            serde_json::to_value(u.try_recv().unwrap().body).unwrap()["data"]["code"],
            "CAPACITY"
        );
    }
    #[test]
    fn destroyed_graphical_history_allows_first_guest_but_lost_does_not() {
        for closed in [false, true] {
            let mut f = Fixture::new();
            let d = f.attach(Component::Daemon);
            let u = f.attach(Component::Ui);
            f.server.headless_graphical_seen = true;
            let owner = f.endpoint(Component::Agent);
            f.server
                .authority
                .apply(Input::Lifecycle {
                    surface_id: "surface-old".into(),
                    update: crate::admission::LifecycleUpdate::Created(crate::admission::Surface {
                        display: "display-old".into(),
                        owner,
                        agent_controlled: true,
                        live: true,
                        frame: None,
                        refresh_after: None,
                        allowed_verbs: vec![],
                    }),
                })
                .unwrap();
            f.server
                .authority
                .apply(Input::Lifecycle {
                    surface_id: "surface-old".into(),
                    update: if closed {
                        crate::admission::LifecycleUpdate::Destroyed
                    } else {
                        crate::admission::LifecycleUpdate::Lost
                    },
                })
                .unwrap();
            f.dispatch(f.create()).unwrap();
            if closed {
                assert!(matches!(
                    d.try_recv().unwrap().body,
                    Command::GuestCommandRequest(_)
                ));
                assert!(f.server.authority.state().guest_command.held);
            } else {
                assert!(d.try_recv().is_err());
                assert_eq!(
                    serde_json::to_value(u.try_recv().unwrap().body).unwrap()["data"]["code"],
                    "CAPACITY"
                );
            }
        }
    }

    #[test]
    fn timeout_retains_null_identity_reservation() {
        let mut f = Fixture::new();
        let _d = f.attach(Component::Daemon);
        let u = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        f.server.poll_guest_command_at(15_000_000_000).unwrap();
        let s = &f.server.authority.state().guest_command;
        assert!(s.held && s.unknown && s.session.is_none());
        let v = serde_json::to_value(u.try_recv().unwrap().body).unwrap();
        assert_eq!(v["event"], "outcome_unknown");
        assert!(v["session"].is_null());
    }
    #[test]
    fn event_fanout_and_foreign_tuple_refusal() {
        let mut f = Fixture::new();
        let _d = f.attach(Component::Daemon);
        let u = f.attach(Component::Ui);
        let a = f.attach(Component::Agent);
        f.dispatch(f.create()).unwrap();
        let s = &f.server.authority.state().guest_command;
        let body = json!({"schema":"guest_command_event/v0.2","event_id":"event-daemon","request_id":"request-create","reservation_id":s.reservation,"owner_id":s.actor,"event":"accepted","session":{"schema":"guest_command_session/v0.2","workload_id":"workload-one","generation":1,"owner_id":s.actor,"profile_id":"guest-command-arm64-v1","backend":"firecracker","isa":"aarch64","phase":"starting","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}},"data":{"op":"create"}});
        let env = f.env(Component::Daemon, body);
        let Command::GuestCommandEvent(event) = env.body.clone() else {
            panic!()
        };
        let w = f.server.authority.retain_witness(b"guest-event").unwrap();
        f.server.guest_command_event(0, &env, &event, 0, w).unwrap();
        assert!(matches!(
            u.try_recv().unwrap().body,
            Command::GuestCommandEvent(_)
        ));
        assert!(matches!(
            a.try_recv().unwrap().body,
            Command::GuestCommandEvent(_)
        ));
    }
    #[test]
    fn journal_failure_dispatches_nothing() {
        let mut f = Fixture::new();
        let daemon = f.attach(Component::Daemon);
        let _u = f.attach(Component::Ui);
        crate::journal::fail_next_append_with_torn_event_sidecar(&f.server.root);
        assert!(f.dispatch(f.create()).is_err());
        assert!(daemon.try_recv().is_err());
        assert!(!f.server.authority.state().guest_command.held);
    }
    fn ready(f: &Fixture, c: Component) -> ReadyPeer {
        let config = f.server.config.clone();
        let registration = config
            .peers
            .iter()
            .find(|r| r.endpoint.component == c)
            .unwrap()
            .clone();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let policy = HandshakePolicy::new(
                    effective_uid().unwrap(),
                    registration.endpoint.clone(),
                    config.core.endpoint.clone(),
                    config.session_id.clone(),
                    registration.hello.clone(),
                )
                .unwrap();
                let hello = f.env(c, serde_json::to_value(registration.hello).unwrap());
                let (mut left, mut right) = UnixStream::pair().unwrap();
                let writer = tokio::spawn(async move {
                    write_frame(&mut left, &hello).await.unwrap();
                });
                let peer = handshake_at(
                    &mut right,
                    &policy,
                    &WireLimits::default(),
                    tokio::time::Instant::now(),
                )
                .await
                .unwrap();
                writer.await.unwrap();
                peer
            })
    }
    #[test]
    fn guest_command_authenticated_role_spoof_rejected_before_dispatch() {
        let mut f = Fixture::new();
        let daemon = f.attach(Component::Daemon);
        let peer = ready(&f, Component::Agent);
        let request = f.create();
        assert!(f.server.route(&peer, 0, request).is_err());
        assert!(!f.server.authority.state().guest_command.held);
        assert!(daemon.try_recv().is_err());
    }
    #[test]
    fn refused_request_is_not_replayed_when_daemon_appears() {
        let mut f = Fixture::new();
        let ui = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        let _ = ui.try_recv().unwrap();
        let d = f.attach(Component::Daemon);
        f.dispatch(f.create()).unwrap();
        assert!(d.try_recv().is_err());
        let e = serde_json::to_value(ui.try_recv().unwrap().body).unwrap();
        assert_eq!(e["data"]["code"], "DUPLICATE");
        assert!(!f.server.authority.state().guest_command.held);
    }
    #[test]
    fn guest_command_recovery_keeps_reservation() {
        let mut f = Fixture::new();
        let _daemon = f.attach(Component::Daemon);
        let _ui = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        f.server.authority.flush_sync().unwrap();
        let path = f.server.root.join("journal.jsonl");
        let old_root = f.server.root.clone();
        let config = f.server.config.clone();
        let replacement = Server::open(
            config,
            &f.root.join("replacement"),
            effective_uid().unwrap(),
        )
        .unwrap();
        let old_server = std::mem::replace(&mut f.server, replacement);
        drop(old_server);
        let recovered = Authority::recover(&path, &old_root).unwrap();
        assert!(recovered.state().guest_command.held);
        assert!(recovered
            .state()
            .guest_command
            .requests
            .contains("request-create"));
    }
    #[test]
    fn idle_disconnect_emits_original_create_unknown() {
        let mut f = Fixture::new();
        let _d = f.attach(Component::Daemon);
        let u = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        let state = &f.server.authority.state().guest_command;
        let mut session = json!({"schema":"guest_command_session/v0.2","workload_id":"workload-idle","generation":1,"owner_id":state.actor,"profile_id":"guest-command-arm64-v1","backend":"firecracker","isa":"aarch64","phase":"starting","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}});
        for (id, kind, data) in [
            ("event-accepted", "accepted", json!({"op":"create"})),
            ("event-ready", "ready", json!({})),
        ] {
            if kind == "ready" {
                session["phase"] = json!("ready");
            }
            let state = &f.server.authority.state().guest_command;
            let e=serde_json::from_value(json!({"schema":"guest_command_event/v0.2","event_id":id,"request_id":"request-create","reservation_id":state.reservation,"owner_id":state.actor,"session":session,"event":kind,"data":data})).unwrap();
            assert!(f
                .server
                .authority
                .apply(Input::GuestCommandEvent {
                    notice: e,
                    executor_epoch: 0
                })
                .unwrap()
                .reason
                .is_none());
        }
        assert!(f.server.authority.state().guest_command.pending.is_empty());
        f.server.mark_guest_command_unknown(1).unwrap();
        let v = serde_json::to_value(u.try_recv().unwrap().body).unwrap();
        assert_eq!(v["request_id"], "request-create");
        assert_eq!(v["session"]["phase"], "uncertain");
        assert_eq!(v["event"], "outcome_unknown");
        assert!(f.server.authority.state().guest_command.held);
    }
    #[test]
    fn lagged_ack_fanout_uses_normalized_core_snapshot() {
        let mut f = Fixture::new();
        let _d = f.attach(Component::Daemon);
        let u = f.attach(Component::Ui);
        let a = f.attach(Component::Agent);
        f.dispatch(f.create()).unwrap();
        let state = &f.server.authority.state().guest_command;
        let mut session = json!({"schema":"guest_command_session/v0.2","workload_id":"workload-lag","generation":1,"owner_id":state.actor,"profile_id":"guest-command-arm64-v1","backend":"firecracker","isa":"aarch64","phase":"starting","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}});
        for (id, kind, data) in [
            ("event-a", "accepted", json!({"op":"create"})),
            ("event-r", "ready", json!({})),
        ] {
            if kind == "ready" {
                session["phase"] = json!("ready");
            }
            let state = &f.server.authority.state().guest_command;
            let e=serde_json::from_value(json!({"schema":"guest_command_event/v0.2","event_id":id,"request_id":"request-create","reservation_id":state.reservation,"owner_id":state.actor,"session":session,"event":kind,"data":data})).unwrap();
            assert!(f
                .server
                .authority
                .apply(Input::GuestCommandEvent {
                    notice: e,
                    executor_epoch: 0
                })
                .unwrap()
                .reason
                .is_none());
        }
        for (op, id, params) in [
            (
                "run",
                "request-run",
                json!({"workload_id":"workload-lag","generation":1,"job_id":"job-lag","command_utf8":"true","cwd":"","stdin_b64":"","timeout_ms":1000}),
            ),
            (
                "stop",
                "request-stop",
                json!({"workload_id":"workload-lag","generation":1}),
            ),
        ] {
            let request=serde_json::from_value(json!({"schema":"guest_command_request/v0.2","request_id":id,"op":op,"params":params})).unwrap();
            let caller = f.endpoint(Component::Ui);
            let agent = f.endpoint(Component::Agent);
            assert!(f
                .server
                .authority
                .apply(Input::GuestCommandRequest {
                    request,
                    caller,
                    agent,
                    other_resources: false,
                    received_ns: 0
                })
                .unwrap()
                .reason
                .is_none());
        }
        session["phase"] = json!("running");
        session["jobs_started"] = json!(1);
        session["job"] = json!({"job_id":"job-lag","state":"running","exit_code":null,"signal":null,"stdout_bytes":0,"stderr_bytes":0,"output_complete":false});
        let state = &f.server.authority.state().guest_command;
        let env=f.env(Component::Daemon,json!({"schema":"guest_command_event/v0.2","event_id":"event-run-ack","request_id":"request-run","reservation_id":state.reservation,"owner_id":state.actor,"session":session,"event":"accepted","data":{"op":"run"}}));
        let Command::GuestCommandEvent(e) = env.body.clone() else {
            panic!()
        };
        let w = f.server.authority.retain_witness(b"lagged-run").unwrap();
        f.server.guest_command_event(0, &env, &e, 0, w).unwrap();
        for rx in [&u, &a] {
            let v = serde_json::to_value(rx.try_recv().unwrap().body).unwrap();
            assert_eq!(v["session"]["phase"], "stopping");
            assert_eq!(
                v["session"]["controls"]["stop"]["request_id"],
                "request-stop"
            );
            assert_eq!(v["session"]["controls"]["stop"]["ack"], "pending");
        }
        f.server.mark_guest_command_unknown(1).unwrap();
        for rx in [&u, &a] {
            let v = serde_json::to_value(rx.try_recv().unwrap().body).unwrap();
            assert_eq!(v["request_id"], "request-run");
            assert_eq!(v["event"], "outcome_unknown");
            assert!(rx.try_recv().is_err());
        }
        assert!(f
            .server
            .authority
            .state()
            .guest_command
            .pending
            .values()
            .all(|p| p.unknown));
    }
}
