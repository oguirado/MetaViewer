//! [TARGET, unit decision] A capacity refusal ends admission, not transport.
//! Flush accepted records before notifying peers. Emergency destroy commands
//! are cleanup only: their replies never become unjournaled authority state or
//! frame publications. One outstanding destroy preserves adapter stop order.
use super::*;
use std::collections::VecDeque;
use std::io::Write;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct EndMarker {
    schema: String,
    core_seq: u64,
    state_sha256: String,
}

pub(super) struct SessionEnd {
    pending: VecDeque<String>,
    active: Option<String>,
    seen: BTreeSet<String>,
}

impl Server {
    fn end_marker(&self) -> Result<EndMarker> {
        Ok(EndMarker {
            schema: "metaviewer.journal-ended/v1".into(),
            core_seq: self.authority.state().core_seq,
            state_sha256: crate::journal::sha256_hex(&self.snapshot()?),
        })
    }

    fn new_session_end(&self) -> SessionEnd {
        let ids: BTreeSet<_> = self
            .authority
            .state()
            .surfaces
            .keys()
            .filter(|id| !self.authority.state().is_destroyed(id))
            .cloned()
            .collect();
        SessionEnd {
            pending: ids.iter().cloned().collect(),
            active: None,
            seen: ids,
        }
    }

    pub(super) fn load_journal_end(&mut self) -> Result<()> {
        self.journal_end = None;
        let path = self.root.join("journal-ended.json");
        let read_marker = || -> Result<EndMarker> {
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_file()
                || meta.len() > 1024
                || meta.uid() != effective_uid()?
                || meta.mode() & 0o077 != 0
            {
                return Err(invalid("invalid journal end marker"));
            }
            Ok(serde_json::from_slice(&fs::read(&path)?)?)
        };
        match read_marker() {
            Ok(marker) if marker == self.end_marker()? => {
                self.journal_end = Some(self.new_session_end());
            }
            Err(e)
                if e.downcast_ref::<io::Error>()
                    .is_some_and(|e| e.kind() == io::ErrorKind::NotFound) => {}
            _ => {
                // A marker is only a hint. Strict replay already established
                // authority; a damaged or stale hint cannot make it unavailable.
                eprintln!("Ignoring invalid or replay-mismatched journal end marker");
                if fs::rename(&path, self.root.join("journal-ended.ignored.json")).is_err() {
                    eprintln!("Could not move ignored journal end marker aside");
                }
            }
        }
        Ok(())
    }

    fn persist_journal_end(&self) -> Result<()> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temp = self.root.join(format!(
            ".journal-ended-{}-{serial}.tmp",
            std::process::id()
        ));
        let bytes = crate::journal::canonical_bytes(&serde_json::to_value(self.end_marker()?)?)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        let result = (|| -> Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temp, self.root.join("journal-ended.json"))?;
            fs::File::open(&self.root)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    pub(super) fn resume_journal_end(&mut self, now_ns: u64, peer: &Endpoint) -> Result<()> {
        let Some(end) = &mut self.journal_end else {
            return Ok(());
        };
        if peer.component == Component::Daemon {
            if let Some(active) = end.active.take() {
                end.pending.push_front(active);
            }
            self.start_next_journal_stop(now_ns)
        } else {
            self.journal_full_notice(now_ns, peer)
        }
    }

    fn journal_full_notice(&mut self, now_ns: u64, to: &Endpoint) -> Result<()> {
        let body = Command::SurfaceEvent(Box::new(serde_json::from_value(serde_json::json!({
            "schema":"surface_event/v0.2", "event":"error",
            "data":{"surface_id":"session", "code":"JOURNAL_FULL",
                "detail":"Session journal is full. New work is refused (POLICY). Capsules are stopping in order; the accepted journal remains replayable. Start a new session."}
        }))?));
        self.journal_notice_at(now_ns, to, body)
    }

    fn journal_notice_at(&mut self, now_ns: u64, to: &Endpoint, body: Command) -> Result<()> {
        let env = self.outbound_at(now_ns, to, body, "core")?;
        // A diagnostic is best effort. enqueue/send_at would reserve a
        // QUEUE_OVERFLOW terminal on saturation and retire the transport.
        if let Some(connection) = self.connections.get(to) {
            let _ = connection.queue.try_send(env);
        }
        Ok(())
    }

    pub(super) fn end_full_journal(&mut self, now_ns: u64, env: &Envelope) -> Result<()> {
        self.authority.flush_sync()?;
        if self.journal_end.is_none() {
            // Close admission before attempting this non-authoritative hint.
            // ENOSPC, a torn previous hint or failed directory sync cannot
            // turn a capacity refusal back into a peer transport failure.
            self.journal_end = Some(self.new_session_end());
            if let Err(e) = self.persist_journal_end() {
                eprintln!("Journal admission closed; end marker persistence failed: {e}");
            }
            let peers: Vec<_> = self
                .connections
                .keys()
                .filter(|p| p.component != Component::Daemon)
                .cloned()
                .collect();
            for peer in peers {
                // A slow observer cannot prevent emergency adapter cleanup.
                if let Err(e) = self.journal_full_notice(now_ns, &peer) {
                    if e.downcast_ref::<SendFailure>().is_none() {
                        return Err(e);
                    }
                }
            }
        }
        // Inspect the capacity-triggering event before issuing the first stop:
        // a refused error is not an acknowledgment of a cleanup not yet sent.
        if env.from.component == Component::Daemon {
            self.route_ended_session(now_ns, env)
        } else {
            self.start_next_journal_stop(now_ns)
        }
    }

    fn start_next_journal_stop(&mut self, now_ns: u64) -> Result<()> {
        let Some(end) = &mut self.journal_end else {
            return Ok(());
        };
        if end.active.is_some() {
            return Ok(());
        }
        let Some(sid) = end.pending.front().cloned() else {
            return Ok(());
        };
        let Some(daemon) = self
            .connections
            .keys()
            .find(|p| p.component == Component::Daemon)
            .cloned()
        else {
            return Ok(());
        };
        let body = Command::SurfaceRequest(Box::new(serde_json::from_value(serde_json::json!({
            "schema":"surface_request/v0.2", "op":"destroy", "params":{"surface_id":sid}
        }))?));
        self.send_at(now_ns, &daemon, body)?;
        let end = self.journal_end.as_mut().unwrap();
        end.pending.pop_front();
        end.active = Some(sid);
        Ok(())
    }

    pub(super) fn route_ended_session(&mut self, now_ns: u64, env: &Envelope) -> Result<()> {
        if env.from.component != Component::Daemon {
            return self.journal_full_notice(now_ns, &env.from);
        }
        if let Command::SurfaceEvent(event) = &env.body {
            let value = serde_json::to_value(event)?;
            // A create already in flight may complete after admission closes.
            if let Some(sid) = value["data"]["surface"]["surface_id"].as_str() {
                let end = self.journal_end.as_mut().unwrap();
                if value["event"] == "created" && end.seen.insert(sid.into()) {
                    end.pending.push_back(sid.into());
                }
            }
            let sid = value["data"]["surface_id"]
                .as_str()
                .or_else(|| value["data"]["surface"]["surface_id"].as_str());
            let end = self.journal_end.as_mut().unwrap();
            let terminal_refusal = value["event"] == "error"
                && ((value["data"]["code"] == "surface"
                    && value["data"]["detail"] == "unknown or terminal surface")
                    || (value["data"]["code"] == "ADAPTER_SURFACE"
                        && value["data"]["detail"] == "surface: unknown or terminal surface"));
            if end.active.is_some()
                && sid == end.active.as_deref()
                && ((value["event"] == "state_changed"
                    && value["data"]["surface"]["state"] == "destroyed")
                    || terminal_refusal)
            {
                end.active = None;
            } else if end.active.is_some()
                && sid == end.active.as_deref()
                && value["event"] == "error"
                && !((value["data"]["code"] == "ADAPTER_SURFACE"
                    && value["data"]["detail"] == "surface: destroy already in progress")
                    || (value["data"]["code"] == "surface"
                        && value["data"]["detail"] == "destroy already in progress"))
            {
                // Stop failure is explicit; retain the active identity so we
                // never claim completion or race a later capsule's stop.
                let peers: Vec<_> = self
                    .connections
                    .keys()
                    .filter(|p| p.component != Component::Daemon)
                    .cloned()
                    .collect();
                for peer in peers {
                    let body = Command::SurfaceEvent(Box::new(serde_json::from_value(
                        serde_json::json!({
                            "schema":"surface_event/v0.2", "event":"error", "data":{
                                "surface_id":"session", "code":"JOURNAL_STOP_FAILED",
                                "detail":"Session journal is full. A capsule could not be stopped. Stop the remaining capsules before starting a new session."
                            }
                        }),
                    )?));
                    if let Err(e) = self.send_at(now_ns, &peer, body) {
                        if e.downcast_ref::<SendFailure>().is_none() {
                            return Err(e);
                        }
                    }
                }
            }
        }
        self.start_next_journal_stop(now_ns)
    }
}
