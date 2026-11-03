//! Authenticated headless routing; all changes pass through the authority journal.
use super::*;
use crate::wire::headless::{HeadlessEvent, HeadlessRequest};
use serde_json::json;

impl Server {
    fn headless_refused(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        request: &HeadlessRequest,
        code: &str,
        boundary: Witness,
    ) -> Result<()> {
        self.authority.apply_with_witnesses(
            Input::Refuse {
                reason: Refusal::Policy,
            },
            vec![boundary],
        )?;
        let state = &self.authority.state().headless;
        let visible = state.creator.as_ref() == Some(&env.from) || env.from == self.agent()?;
        let session = state.session.as_ref().filter(|_| visible);
        let value = json!({"schema":"headless_event/v0.2","event_id":format!("event-core-{}",self.authority.state().core_seq),"request_id":request.0["request_id"],"event":"refused","data":{"workload_id":session.map(|s|s["workload_id"].clone()),"generation":session.map(|s|s["generation"].clone()),"code":code,"effect":"not_dispatched"}});
        self.send_at(
            now_ns,
            &env.from,
            Command::HeadlessEvent(Box::new(serde_json::from_value(value)?)),
        )
    }
    pub(super) fn headless_request(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        request: &HeadlessRequest,
        boundary: Witness,
    ) -> Result<()> {
        self.poll_headless_at(now_ns)?;
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
            return self.headless_refused(now_ns, env, request, "UNAVAILABLE", boundary);
        }
        let mut preview = self.authority.state().headless.clone();
        let graphical = self.headless_graphical_seen || !self.authority.state().surfaces.is_empty();
        if let Err(code) = preview.submit(
            request,
            &env.from,
            &agent,
            self.authority.state().epoch,
            graphical,
        ) {
            return self.headless_refused(now_ns, env, request, code, boundary);
        }
        if self.authority.state().remaining_budget == 0 && request.0["op"] != "stop" {
            return self.headless_refused(now_ns, env, request, "POLICY", boundary);
        }
        let outcome = self.authority.apply_with_witnesses(
            Input::HeadlessRequest {
                request: request.clone(),
                caller: env.from.clone(),
                agent,
                graphical_seen: graphical,
                received_ns: now_ns,
            },
            vec![boundary],
        )?;
        if outcome.reason.is_some() {
            return Err(invalid(
                "headless admission changed during serialized routing",
            ));
        }
        if let Err(error) = self.send_at(now_ns, &daemon, env.body.clone()) {
            // Keep the reservation even if a queue reports failure; never replay.
            self.mark_headless_unknown(now_ns)?;
            return Err(error);
        }
        Ok(())
    }
    fn headless_receivers(&self) -> Result<BTreeSet<Endpoint>> {
        let state = &self.authority.state().headless;
        let mut receivers = BTreeSet::from([self.agent()?]);
        if let Some(owner) = &state.creator {
            receivers.insert(owner.clone());
        }
        if let Some(pending) = &state.pending {
            receivers.insert(pending.caller.clone());
        }
        Ok(receivers)
    }
    pub(super) fn headless_event(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        event: &HeadlessEvent,
        epoch: u64,
        boundary: Witness,
    ) -> Result<()> {
        self.poll_headless_at(now_ns)?;
        let receivers = self.headless_receivers()?;
        let out = self.authority.apply_with_witnesses(
            Input::HeadlessEvent {
                notice: event.clone(),
                executor_epoch: epoch,
            },
            vec![boundary],
        )?;
        if let Some(reason) = out.reason {
            return self.refuse_at(now_ns, &env.from, &env.msg_id, reason, out.core_seq);
        }
        for receiver in receivers {
            if self.connections.contains_key(&receiver) {
                // A saturated UI must not retire the authenticated daemon or starve the owner agent.
                let _ = self.send_at(now_ns, &receiver, env.body.clone());
            }
        }
        Ok(())
    }
    pub(super) fn poll_headless_at(&mut self, now_ns: u64) -> Result<()> {
        if self
            .authority
            .state()
            .headless
            .pending
            .as_ref()
            .and_then(|p| p.deadline_ns)
            .is_some_and(|deadline| now_ns >= deadline)
        {
            self.mark_headless_unknown(now_ns)?;
        }
        Ok(())
    }
    pub(super) fn mark_headless_unknown(&mut self, now_ns: u64) -> Result<()> {
        let old = self.authority.state().headless.clone();
        if !old.held {
            return Ok(());
        }
        let receivers = self.headless_receivers()?;
        let out = self.authority.apply(Input::HeadlessUncertain)?;
        if old.pending.is_some() && self.authority.state().headless.session.is_none() {
            eprintln!("headless outcome unknown before workload identity; reservation retained");
        }
        if let (Some(pending), Some(session)) =
            (old.pending, self.authority.state().headless.session.clone())
        {
            let value = json!({"schema":"headless_event/v0.2","event_id":format!("event-core-{}",out.core_seq),"request_id":pending.request["request_id"],"event":"outcome_unknown","data":{"session":session,"op":pending.request["op"],"code":"OUTCOME_UNKNOWN"}});
            let event: HeadlessEvent = serde_json::from_value(value)?;
            for receiver in receivers {
                if self.connections.contains_key(&receiver) {
                    let _ = self.send_at(
                        now_ns,
                        &receiver,
                        Command::HeadlessEvent(Box::new(event.clone())),
                    );
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
                "headless-core-{}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let reg = |c: &str| -> Registration {
                serde_json::from_value(json!({"endpoint":{"component":c,"instance":format!("{c}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":c,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
            };
            let config = Config {
                session_id: "headless-test".into(),
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
            serde_json::from_value(json!({"schema":schema,"msg_id":"message-test","ts_ns":0,"from":self.endpoint(c),"to":self.server.config.core.endpoint,"session_id":"headless-test","seq":1,"nonce":"nonce-test","body":body})).unwrap()
        }
        fn create(&self) -> Envelope {
            self.env(Component::Ui,json!({"schema":"headless_request/v0.2","request_id":"request-create","op":"create","params":{"template":"headless-sumsq"}}))
        }
        fn dispatch(&mut self, env: Envelope) -> Result<()> {
            let body = env.body.clone();
            let w = self
                .server
                .authority
                .retain_witness(b"headless-test-boundary")?;
            if let Command::HeadlessRequest(r) = body {
                self.server.headless_request(0, &env, &r, w)
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
    fn headless_dispatch_reserves_before_daemon_queue() {
        let mut f = Fixture::new();
        let daemon = f.attach(Component::Daemon);
        let _ui = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        assert!(f.server.authority.state().headless.held);
        let outbound = daemon.try_recv().unwrap();
        assert_eq!(outbound.schema, "capsule_envelope/v0.2");
        assert!(crate::decode_envelope(&serde_json::to_string(&outbound).unwrap()).is_ok());
        assert!(matches!(outbound.body, Command::HeadlessRequest(_)));
        assert!(f.server.authority.state().core_seq > 0);
    }
    #[test]
    fn headless_missing_daemon_refuses_without_reservation() {
        let mut f = Fixture::new();
        let ui = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        assert!(!f.server.authority.state().headless.held);
        let outbound = ui.try_recv().unwrap();
        assert_eq!(outbound.schema, "capsule_envelope/v0.2");
        assert!(crate::decode_envelope(&serde_json::to_string(&outbound).unwrap()).is_ok());
        let body = serde_json::to_value(outbound.body).unwrap();
        assert_eq!(body["event"], "refused");
        assert_eq!(body["data"]["code"], "UNAVAILABLE");
    }
    #[test]
    fn headless_send_failure_retains_consumed_reservation() {
        let mut f = Fixture::new();
        let receiver = f.attach(Component::Daemon);
        drop(receiver);
        let _ui = f.attach(Component::Ui);
        assert!(f.dispatch(f.create()).is_err());
        let s = &f.server.authority.state().headless;
        assert!(s.held);
        assert!(s.started);
        assert!(s.pending.is_none());
    }
    #[test]
    fn headless_recovery_keeps_reservation() {
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
        assert!(recovered.state().headless.held);
        assert!(recovered
            .state()
            .headless
            .requests
            .contains("request-create"));
    }
    #[test]
    fn headless_journal_failure_sends_nothing() {
        let mut f = Fixture::new();
        let daemon = f.attach(Component::Daemon);
        let _ui = f.attach(Component::Ui);
        crate::journal::fail_next_append_with_torn_event_sidecar(&f.server.root);
        assert!(f.dispatch(f.create()).is_err());
        assert!(daemon.try_recv().is_err());
        assert!(!f.server.authority.state().headless.held);
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
    fn headless_authenticated_role_spoof_rejected_before_dispatch() {
        let mut f = Fixture::new();
        let daemon = f.attach(Component::Daemon);
        let peer = ready(&f, Component::Agent);
        let request = f.create();
        assert!(f.server.route(&peer, 0, request).is_err());
        assert!(!f.server.authority.state().headless.held);
        assert!(daemon.try_recv().is_err());
    }
    #[test]
    fn headless_real_route_forwards_ui_and_sends_only_valid_daemon_event() {
        let mut f = Fixture::new();
        let daemon = f.attach(Component::Daemon);
        let ui = f.attach(Component::Ui);
        let agent = f.attach(Component::Agent);
        let peer = ready(&f, Component::Ui);
        f.server.route(&peer, 0, f.create()).unwrap();
        assert!(matches!(
            daemon.try_recv().unwrap().body,
            Command::HeadlessRequest(_)
        ));
        let actor = crate::headless::actor_id(&f.endpoint(Component::Agent));
        let accepted = json!({"schema":"headless_event/v0.2","event_id":"event-daemon","request_id":"request-create","event":"accepted","data":{"op":"create","session":{"schema":"headless_session/v0.2","workload_id":"workload-real","generation":1,"owner_id":actor,"profile_id":"headless-sumsq-v1","backend":"firecracker","isa":"aarch64","phase":"starting","ownership":"held","job":null}}});
        let peer = ready(&f, Component::Daemon);
        let notice = f.env(Component::Daemon, accepted);
        f.server.route(&peer, 0, notice).unwrap();
        assert!(matches!(
            ui.try_recv().unwrap().body,
            Command::HeadlessEvent(_)
        ));
        assert!(matches!(
            agent.try_recv().unwrap().body,
            Command::HeadlessEvent(_)
        ));
    }
    #[test]
    fn headless_graphical_admission_interacts_both_directions() {
        let mut f = Fixture::new();
        let _daemon = f.attach(Component::Daemon);
        let _ui = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        let graphic:crate::wire::payload::SurfaceRequest=serde_json::from_value(json!({"schema":"surface_request/v0.2","op":"create","params":{"kind":"vm","profile_id":"vm-profile","geometry":{"w":1280,"h":900}}})).unwrap();
        assert_eq!(
            f.server
                .authority
                .apply(Input::SurfaceRequest { request: graphic })
                .unwrap()
                .reason,
            Some(Refusal::Policy)
        );
        let mut f = Fixture::new();
        let daemon = f.attach(Component::Daemon);
        let ui = f.attach(Component::Ui);
        f.server.headless_graphical_seen = true;
        f.dispatch(f.create()).unwrap();
        assert!(daemon.try_recv().is_err());
        assert_eq!(
            serde_json::to_value(ui.try_recv().unwrap().body).unwrap()["data"]["code"],
            "BUSY"
        );
    }

    #[test]
    fn headless_pending_deadline_never_releases_unknown_create() {
        let mut f = Fixture::new();
        let _daemon = f.attach(Component::Daemon);
        let _ui = f.attach(Component::Ui);
        f.dispatch(f.create()).unwrap();
        f.server.poll_headless_at(35_000_000_000).unwrap();
        assert!(f.server.authority.state().headless.held);
        assert!(f.server.authority.state().headless.pending.is_none());
        assert!(f.server.authority.state().headless.session.is_none());
    }
}
