//! Authenticated additive REWIND routing. No renderer/native shortcut.
use super::*;
use crate::wire::rewind::{RewindEvent, RewindRequest};
use serde_json::json;
impl Server {
    fn rewind_receivers(&self) -> Result<BTreeSet<Endpoint>> {
        let mut out = BTreeSet::from([self.agent()?]);
        if let Some(p) = &self.authority.state().guest_command.creator {
            out.insert(p.clone());
        }
        Ok(out)
    }
    fn rewind_refused(
        &mut self,
        now: u64,
        env: &Envelope,
        r: &RewindRequest,
        code: &str,
    ) -> Result<()> {
        let agent = self.agent()?;
        let owner = crate::headless::actor_id(&agent);
        let session = if env.from == agent
            || self.authority.state().guest_command.creator.as_ref() == Some(&env.from)
        {
            self.authority.state().rewind.status()
        } else {
            None
        };
        let event: RewindEvent = serde_json::from_value(
            json!({"schema":"rewind_event/v0.2","event_id":format!("event-core-{}",self.authority.state().core_seq),"request_id":r.0["request_id"],"owner_id":owner,"event":"refused","session":session,"data":{"op":r.0["op"],"code":code}}),
        )?;
        self.send_at(now, &env.from, Command::RewindEvent(Box::new(event)))
    }
    pub(super) fn rewind_request(
        &mut self,
        now: u64,
        env: &Envelope,
        r: &RewindRequest,
        boundary: Witness,
    ) -> Result<()> {
        self.poll_rewind_at(now)?;
        let agent = self.agent()?;
        // A human-created capsule reserves Back for its human creator. Agent
        // marks are still allowed; agent-created workloads retain their API.
        if r.0["op"] == "restore"
            && env.from == agent
            && self
                .authority
                .state()
                .guest_command
                .creator
                .as_ref()
                .is_some_and(|creator| creator.component == Component::Ui)
        {
            self.authority.apply_with_witnesses(
                Input::Refuse { reason: Refusal::Policy },
                vec![boundary],
            )?;
            return self.rewind_refused(now, env, r, "OWNER");
        }
        let daemon = self
            .config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Daemon)
            .ok_or_else(|| invalid("no daemon"))?
            .endpoint
            .clone();
        let mut preview = self.authority.state().rewind.clone();
        let failure = if !self.rewind_enabled || !self.connections.contains_key(&daemon) {
            Some("UNAVAILABLE")
        } else if self.authority.state().remaining_budget == 0 {
            Some("CAPACITY")
        } else {
            preview
                .submit(
                    r,
                    &self.authority.state().guest_command,
                    &env.from,
                    &agent,
                    &env.session_id,
                    now,
                )
                .err()
        };
        if let Some(code) = failure {
            // Journal the rejected request without changing the state preview.
            let _ = self.authority.apply_with_witnesses(
                Input::RewindRequest {
                    request: r.clone(),
                    caller: env.from.clone(),
                    agent,
                    received_ns: now,
                    enabled: self.rewind_enabled && self.connections.contains_key(&daemon),
                },
                vec![boundary],
            )?;
            return self.rewind_refused(now, env, r, code);
        }
        let out = self.authority.apply_with_witnesses(
            Input::RewindRequest {
                request: r.clone(),
                caller: env.from.clone(),
                agent,
                received_ns: now,
                enabled: true,
            },
            vec![boundary],
        )?;
        if out.reason.is_some() {
            return Err(invalid("serialized rewind admission changed"));
        }
        if let Err(e) = self.send_at(now, &daemon, env.body.clone()) {
            self.mark_rewind_unknown(now)?;
            return Err(e);
        }
        Ok(())
    }
    pub(super) fn rewind_event(
        &mut self,
        now: u64,
        env: &Envelope,
        event: &RewindEvent,
        epoch: u64,
        boundary: Witness,
    ) -> Result<()> {
        self.poll_rewind_at(now)?;
        let daemon = self
            .config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Daemon)
            .ok_or_else(|| invalid("no daemon"))?;
        if env.from != daemon.endpoint {
            return Err(invalid("rewind event sender is not registered daemon"));
        }
        let input = Input::RewindEvent {
            notice: event.clone(),
            executor_epoch: epoch,
        };
        let mut preview = self.authority.state().clone();
        let preview_out = preview
            .apply(&input)
            .map_err(|_| invalid("rewind preview"))?;
        let normalized = if preview_out.reason.is_none() {
            let mut value = event.0.clone();
            value["session"] = preview.rewind.status().unwrap_or(serde_json::Value::Null);
            if value["event"] == "refused" {
                value["event"] = json!("outcome_unknown");
                value["data"] = json!({"op":event.0["data"]["op"],"code":"NATIVE"});
            }
            // Validate the exact public projection before any durable state mutation.
            Some(serde_json::from_value::<RewindEvent>(value)?)
        } else {
            None
        };
        let out = self.authority.apply_with_witnesses(input, vec![boundary])?;
        if let Some(reason) = out.reason {
            return self.refuse_at(now, &env.from, &env.msg_id, reason, out.core_seq);
        }
        let normalized = normalized.ok_or_else(|| invalid("rewind preview disagreed"))?;
        self.record_guest_observation(Command::RewindEvent(Box::new(normalized.clone())));
        for receiver in self.rewind_receivers()? {
            if self.connections.contains_key(&receiver) {
                let _ = self.send_at(
                    now,
                    &receiver,
                    Command::RewindEvent(Box::new(normalized.clone())),
                );
            }
        }
        Ok(())
    }
    pub(super) fn poll_rewind_at(&mut self, now: u64) -> Result<()> {
        if self.authority.state().rewind.expired(now) {
            self.mark_rewind_unknown(now)?;
        }
        Ok(())
    }
    pub(super) fn mark_rewind_unknown(&mut self, now: u64) -> Result<()> {
        if self.authority.state().rewind.unknown || self.authority.state().rewind.is_empty() {
            return Ok(());
        }
        let pending = self.authority.state().rewind.pending.clone();
        let out = self.authority.apply(Input::RewindUncertain)?;
        let session = self
            .authority
            .state()
            .rewind
            .status()
            .unwrap_or(serde_json::Value::Null);
        let owner = self
            .authority
            .state()
            .rewind
            .target
            .as_ref()
            .map(|t| t.owner_id.clone())
            .ok_or_else(|| invalid("missing rewind target"))?;
        if let Some(p) = pending {
            let event: RewindEvent = serde_json::from_value(
                json!({"schema":"rewind_event/v0.2","event_id":format!("event-core-{}",out.core_seq),"request_id":p.request["request_id"],"owner_id":owner,"event":"outcome_unknown","session":session,"data":{"op":p.request["op"],"code":"TRANSPORT"}}),
            )?;
            self.record_guest_observation(Command::RewindEvent(Box::new(event.clone())));
            for receiver in self.rewind_receivers()? {
                if self.connections.contains_key(&receiver) {
                    let _ = self.send_at(
                        now,
                        &receiver,
                        Command::RewindEvent(Box::new(event.clone())),
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
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        server: Server,
        root: PathBuf,
        ui: mpsc::Receiver<Envelope>,
        daemon: mpsc::Receiver<Envelope>,
    }
    impl Fixture {
        fn new(enabled: bool) -> Self {
            let root = std::env::temp_dir().join(format!(
                "rewind-route-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let reg = |c: &str| -> Registration {
                serde_json::from_value(json!({"endpoint":{"component":c,"instance":format!("{c}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":c,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
            };
            let config = Config {
                session_id: "rewind-test".into(),
                core: reg("core"),
                peers: vec![reg("agent"), reg("ui"), reg("daemon")],
            };
            let mut server = Server::open(config, &root, effective_uid().unwrap()).unwrap();
            server.rewind_enabled = enabled;
            let mut initial = CoreState::session("rewind-test").unwrap();
            initial.epoch = 1;
            let agent = server.agent().unwrap();
            let owner = crate::headless::actor_id(&agent);
            let ui_endpoint = server
                .config
                .peers
                .iter()
                .find(|p| p.endpoint.component == Component::Ui)
                .unwrap()
                .endpoint
                .clone();
            initial.guest_command.held = true;
            initial.guest_command.creator = Some(ui_endpoint);
            initial.guest_command.actor = Some(owner.clone());
            initial.guest_command.session = Some(
                json!({"schema":"guest_command_session/v0.2","workload_id":"workload-one","generation":1,"owner_id":owner,"profile_id":"guest-command-arm64-v1","backend":"firecracker","isa":"aarch64","phase":"ready","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}}),
            );
            server.authority = Authority::create(&root.join("seeded"), initial).unwrap();
            let mut attach = |component| {
                let (tx, rx) = mpsc::sync_channel(16);
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
                        epoch: 1,
                        queue: tx,
                        terminal: Arc::new(Mutex::new(None)),
                    },
                );
                rx
            };
            let ui = attach(Component::Ui);
            let daemon = attach(Component::Daemon);
            Self {
                server,
                root,
                ui,
                daemon,
            }
        }
        fn request(&self) -> Envelope {
            serde_json::from_value(json!({"schema":"rewind_envelope/v0.2","msg_id":"rewind-test","ts_ns":0,"from":{"component":"ui","instance":"ui-test"},"to":{"component":"core","instance":"core-test"},"session_id":"rewind-test","seq":1,"nonce":"nonce-one","body":{"schema":"rewind_request/v0.2","request_id":"request-pause","op":"pause","params":{"workload_id":"workload-one","generation":1,"authority_epoch":1}}})).unwrap()
        }
        fn dispatch(&mut self) -> Result<()> {
            let env = self.request();
            let Command::RewindRequest(r) = env.body.clone() else {
                panic!()
            };
            let witness = self
                .server
                .authority
                .retain_witness(b"rewind-route-fixture")?;
            self.server.rewind_request(0, &env, &r, witness)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.server.authority.flush_sync();
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn disabled_rewind_never_dispatches() {
        let mut f = Fixture::new(false);
        f.dispatch().unwrap();
        assert!(f.daemon.try_recv().is_err());
        let event = f.ui.try_recv().unwrap();
        assert!(matches!(event.body, Command::RewindEvent(_)));
        assert!(f.server.authority.state().rewind.is_empty());
    }
    #[test]
    fn committed_pending_precedes_authenticated_dispatch() {
        let mut f = Fixture::new(true);
        f.dispatch().unwrap();
        let sent = f.daemon.try_recv().unwrap();
        assert_eq!(sent.schema, "rewind_envelope/v0.2");
        assert!(f.server.authority.state().rewind.pending.is_some());
        assert!(!f.server.authority.state().rewind.allows_command());
    }
    #[test]
    fn forged_event_sender_cannot_change_state() {
        let mut f = Fixture::new(true);
        f.dispatch().unwrap();
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/rewind_event.valid.accepted.json"
        ))
        .unwrap();
        value["owner_id"] = json!(crate::headless::actor_id(&f.server.agent().unwrap()));
        let event: RewindEvent = serde_json::from_value(value).unwrap();
        let env = f.request();
        let before = f.server.authority.state().rewind.clone();
        let witness = f
            .server
            .authority
            .retain_witness(b"forged-fixture")
            .unwrap();
        assert!(f.server.rewind_event(0, &env, &event, 1, witness).is_err());
        assert_eq!(f.server.authority.state().rewind, before);
    }
    #[test]
    fn admitted_native_refusal_is_public_unknown_even_without_snapshot() {
        let mut f = Fixture::new(true);
        f.dispatch().unwrap();
        let mut env = f.request();
        env.from = Endpoint {
            component: Component::Daemon,
            instance: "daemon-test".into(),
        };
        let event:RewindEvent=serde_json::from_value(json!({"schema":"rewind_event/v0.2","event_id":"event-native-refusal","request_id":"request-pause","owner_id":crate::headless::actor_id(&f.server.agent().unwrap()),"event":"refused","session":null,"data":{"op":"pause","code":"UNAVAILABLE"}})).unwrap();
        let witness = f
            .server
            .authority
            .retain_witness(b"native-refusal-fixture")
            .unwrap();
        f.server.rewind_event(1, &env, &event, 1, witness).unwrap();
        let published = f.ui.try_recv().unwrap();
        let Command::RewindEvent(e) = published.body else {
            panic!()
        };
        assert_eq!(e.0["event"], "outcome_unknown");
        assert_eq!(e.0["data"]["code"], "NATIVE");
        assert!(e.0["session"].is_null());
        assert!(f.server.authority.state().rewind.unknown);
        assert!(f.server.authority.state().rewind.pending.is_some());
    }
    #[test]
    fn timeout_before_first_snapshot_publishes_unknown_null() {
        let mut f = Fixture::new(true);
        f.dispatch().unwrap();
        f.server.poll_rewind_at(35_000_000_001).unwrap();
        let event = f.ui.try_recv().unwrap();
        let Command::RewindEvent(e) = event.body else {
            panic!()
        };
        assert_eq!(e.0["event"], "outcome_unknown");
        assert!(e.0["session"].is_null());
    }
}
