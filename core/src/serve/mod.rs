//! [TARGET, unit decision] Layout slots use surface_id as slot_id until a slot
//! registry ABI exists (kit DOM aliases are resolved by layout.rs). Layout
//! operations commit SurfaceNotice plus the closed intent witness and rebuild
//! placement/visibility on replay. Fold/unfold publish state_changed from core;
//! the daemon adapter defines no layout operation. See layout.rs for policy and
//! typed refusals; accepted placement intents are fanned out unchanged.
//! [TARGET, unit decision] Trusted startup registration is a closed JSON config:
//! {session_id, core:{endpoint,hello}, peers:[{endpoint,hello}]} at MV_CORE_CONFIG.
//! The core endpoint instance is a fresh process identity on each restart.
//! A created surface belongs to the single registered agent. Multiple agent
//! registrations are refused until an ownership wire contract exists.
//! [TARGET, unit decision] Each UI subscribes to daemon events; unsupported
//! well-formed messages receive journalled POLICY verdicts keyed by request/msg id.
//! Saturated peers receive a terminal surface_event.error QUEUE_OVERFLOW through
//! a reserved notification slot before disconnection; normal queue memory is bounded.
//! Frame witnesses are retained only from regular, non-symlink /dev/shm files,
//! bounded to 64 MiB and verified against the advertised digest before commit.
//! [TARGET, unit decision] UI and agent may create/destroy/list and subscribe to
//! frames. Lifecycle callers observe daemon events for their connection lifetime
//! (the wire has no reply correlation); frame unsubscribe overrides that default.
//! Raw input and control requests retain their existing proposal/UI-intent gates.
//! [TARGET, unit decision] An expired RAM publication is not admissible evidence.
//! Drop that frame without retiring the authenticated daemon: its bounded lease
//! window can advance while an earlier journal transaction is being persisted.
//! [TARGET, unit decision] Replay evidence remains session-wide: reconnects must
//! use fresh nonces and increasing sequences within each authenticated connection. EOF drains bounded queued replies;
//! a terminal writer retires its endpoint after flushing its diagnostic.
//! [TARGET, unit decision] A failed receipt must have verified=false; contradictory receipts are refused
//! before settlement and cannot clear a lease.
//! [TARGET, unit decision] The session-relative monotonic clock is bounded below
//! MAX_WIRE_INTEGER ns (~104.25 days). Reaching the ceiling logs and fails closed
//! with ClockCeilingError without mutating authority state; the session must be restarted.
mod capture;
mod layout;
mod tools;

use crate::admission::{
    AdmissionRequest, Authority, CoreState, Frame, Input, LifecycleUpdate, Surface,
};
use crate::journal::{sha256_hex, Witness};
use crate::wire::payload::{FrameRef, Hello, SurfaceEvent};
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{UnixListener, UnixStream};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;
fn invalid(message: &str) -> Error {
    io::Error::new(io::ErrorKind::InvalidData, message).into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub endpoint: Endpoint,
    pub hello: Hello,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub session_id: String,
    pub core: Registration,
    pub peers: Vec<Registration>,
}
impl Config {
    pub fn validate(&self, uid: u32) -> Result<()> {
        if self.core.endpoint.component != Component::Core
            || self
                .peers
                .iter()
                .filter(|p| p.endpoint.component == Component::Agent)
                .count()
                != 1
            || self
                .peers
                .iter()
                .filter(|p| p.endpoint.component == Component::Daemon)
                .count()
                != 1
        {
            return Err(invalid(
                "require core, one agent and one daemon registration",
            ));
        }
        let mut endpoints = std::collections::BTreeSet::new();
        for r in std::iter::once(&self.core).chain(&self.peers) {
            if !endpoints.insert(r.endpoint.clone())
                || (r.endpoint != self.core.endpoint
                    && !matches!(
                        r.endpoint.component,
                        Component::Agent | Component::Ui | Component::Daemon
                    ))
            {
                return Err(invalid("duplicate or unsupported registration"));
            }
            HandshakePolicy::new(
                uid,
                r.endpoint.clone(),
                self.core.endpoint.clone(),
                self.session_id.clone(),
                r.hello.clone(),
            )?;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum SendFailure {
    QueueOverflow(Endpoint),
    Disconnected(Endpoint),
}
impl std::fmt::Display for SendFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for SendFailure {}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClockCeilingError {
    pub elapsed_ns: u128,
}
impl std::fmt::Display for ClockCeilingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "session monotonic clock reached wire ceiling ({} ns >= {} ns); restart session",
            self.elapsed_ns, MAX_WIRE_INTEGER
        )
    }
}
impl std::error::Error for ClockCeilingError {}
struct Connection {
    id: u64,
    epoch: u64,
    queue: mpsc::SyncSender<Envelope>,
    terminal: Arc<Mutex<Option<Envelope>>>,
}
/// One serialization point for all authority transitions and publication.
pub struct Server {
    config: Config,
    authority: Authority,
    root: PathBuf,
    replay: ReplayTable,
    connections: BTreeMap<Endpoint, Connection>,
    origin: Instant,
    clock_offset: Duration,
    route_now_ns: Option<u64>,
    #[cfg(test)]
    clock_step_ns: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    clock_samples: std::sync::atomic::AtomicU64,
    serial: u64,
    observers: BTreeSet<Endpoint>,
    subscriptions: BTreeSet<(Endpoint, String)>,
    unsubscribed: BTreeSet<(Endpoint, String)>,
    tool_state: tools::ToolState,
    capture: crate::record::capture::Host,
}
impl Server {
    pub fn open(config: Config, state_dir: &Path, uid: u32) -> Result<Self> {
        config.validate(uid)?;
        frame_directory_flags()?;
        // Let Journal validate path components and session identity before use.
        let initial = CoreState::session(&config.session_id)?;
        if config.session_id == "."
            || config.session_id == ".."
            || !config
                .session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(invalid("unsafe session id"));
        }
        let root = state_dir.join("sessions").join(&config.session_id);
        let path = root.join("journal.jsonl");
        let authority = if path.exists() {
            match Authority::recover(&path, &root) {
                Ok(authority) => authority,
                Err(crate::journal::JournalError::Corrupt)
                    if legacy_destroy_archive(&path, &root) =>
                {
                    return Err(invalid("UPGRADE-REQUIRED: pre-tombstone journal contains destroyed surfaces; stop peers, archive the complete session directory unchanged, and start a new session_id; do not replay this archive as current state"));
                }
                Err(error) => return Err(error.into()),
            }
        } else {
            Authority::create(state_dir, initial)?
        };
        if authority.state().session_id != config.session_id {
            return Err(invalid("recovered session mismatch"));
        }
        let mut replay = ReplayTable::new(100_000)?;
        // Boundary envelope witnesses also persist sender nonce/sequence evidence.
        // Artifacts are validated by recovery before they are considered here.
        let mut envelopes = Vec::new();
        let mut seen = BTreeSet::new();
        let mut tool_state = tools::ToolState::default();
        for seq in 1..=authority.state().core_seq {
            let event: serde_json::Value = serde_json::from_slice(&fs::read(
                root.join("events").join(format!("{seq}.json")),
            )?)?;
            let witnesses: Vec<Witness> = serde_json::from_value(event["witnesses"].clone())?;
            for witness in witnesses.into_iter().take(1) {
                if witness.byte_len > MAX_FRAME_BYTES as u64 {
                    continue;
                }
                let bytes = fs::read(root.join("artifacts").join(witness.sha256))?;
                if let Ok(raw) = std::str::from_utf8(&bytes) {
                    if let Ok(env) = decode_envelope(raw) {
                        if env.session_id == config.session_id
                            && env.to.component == Component::Core
                        {
                            if event["outcome"]["reason"].is_null() {
                                tool_state.retain(&env.body);
                            }
                            // One envelope can witness several journal records. A restarted
                            // sequence must not overwrite an older nonce witness.
                            if seen.insert((env.from.clone(), env.nonce.clone())) {
                                envelopes.push(env);
                            }
                        }
                    }
                }
            }
        }
        tool_state.prune(authority.state());
        for env in envelopes {
            // Journal order is authoritative across connection generations;
            // restore every nonce and the latest observed sender sequence.
            replay.record_reconnect(&env.session_id, &env.from, &env.nonce, env.seq)?;
        }
        let capture = crate::record::capture::Host::with_serial(authority.state().core_seq);
        Ok(Self {
            config,
            authority,
            root,
            replay,
            connections: BTreeMap::new(),
            origin: Instant::now(),
            clock_offset: Duration::ZERO,
            route_now_ns: None,
            #[cfg(test)]
            clock_step_ns: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            clock_samples: std::sync::atomic::AtomicU64::new(0),
            serial: 0,
            observers: BTreeSet::new(),
            subscriptions: BTreeSet::new(),
            unsubscribed: BTreeSet::new(),
            tool_state,
            capture,
        })
    }
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        Ok(self.authority.state().snapshot()?)
    }
    fn retire(&mut self, peer: &Endpoint, id: u64) {
        if self.connections.get(peer).is_some_and(|c| c.id == id) {
            self.connections.remove(peer);
            self.tool_state.remove_peer(peer);
            self.observers.remove(peer);
            self.subscriptions.retain(|(p, _)| p != peer);
            self.unsubscribed.retain(|(p, _)| p != peer);
        }
    }
    fn now(&self) -> Result<u64> {
        #[cfg(test)]
        let elapsed = {
            let step = self
                .clock_step_ns
                .load(std::sync::atomic::Ordering::Relaxed);
            if step > 0 {
                let sample = self
                    .clock_samples
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.clock_offset
                    .saturating_add(Duration::from_nanos(sample.saturating_mul(step)))
            } else {
                self.origin.elapsed().saturating_add(self.clock_offset)
            }
        };
        #[cfg(not(test))]
        let elapsed = self.origin.elapsed().saturating_add(self.clock_offset);
        let elapsed_ns = elapsed.as_nanos();
        if elapsed_ns >= u128::from(MAX_WIRE_INTEGER) {
            let err = ClockCeilingError { elapsed_ns };
            eprintln!("core clock exhausted: {err}");
            return Err(err.into());
        }
        Ok(u64::try_from(elapsed_ns)?)
    }
    fn send(&mut self, to: &Endpoint, body: Command) -> Result<()> {
        let ts_ns = self.route_now_ns.map_or_else(|| self.now(), Ok)?;
        self.send_at(ts_ns, to, body)
    }
    fn send_at(&mut self, ts_ns: u64, to: &Endpoint, body: Command) -> Result<()> {
        self.serial = self
            .serial
            .checked_add(1)
            .ok_or_else(|| invalid("sequence exhausted"))?;
        let env = Envelope {
            schema: "envelope/v0.2".into(),
            msg_id: format!("core-{}-{}", self.authority.state().epoch, self.serial),
            ts_ns: Clock::new(ts_ns),
            from: self.config.core.endpoint.clone(),
            to: to.clone(),
            session_id: self.config.session_id.clone(),
            seq: self.serial,
            nonce: format!("core-{}-{}", self.authority.state().epoch, self.serial),
            body,
        };
        decode_envelope(&serde_json::to_string(&env)?)?;
        let c = self
            .connections
            .get(to)
            .ok_or_else(|| -> Error { SendFailure::Disconnected(to.clone()).into() })?;
        match c.queue.try_send(env) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(mut env)) => {
                env.body = Command::SurfaceEvent(Box::new(serde_json::from_value(
                    serde_json::json!({"schema":"surface_event/v0.2","event":"error",
                        "data":{"surface_id":to.instance,"code":"QUEUE_OVERFLOW",
                        "detail":"Peer send queue exhausted; reconnect and refresh state"}}),
                )?));
                let mut terminal = c
                    .terminal
                    .lock()
                    .map_err(|_| invalid("poisoned terminal slot"))?;
                if terminal.is_none() {
                    *terminal = Some(env);
                }
                return Err(SendFailure::QueueOverflow(to.clone()).into());
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                return Err(SendFailure::Disconnected(to.clone()).into());
            }
        }
        Ok(())
    }
    fn fanout_at(&mut self, now_ns: u64, body: Command) {
        let frame_surface = match &body {
            Command::FrameRef(frame) => Some(frame.surface_id.as_str()),
            Command::SurfaceEvent(event) => match event.as_ref() {
                SurfaceEvent::Case2(event) => Some(event.data.frame_ref.surface_id.as_str()),
                _ => None,
            },
            _ => None,
        };
        let peers: Vec<_> = self
            .connections
            .keys()
            .filter(|p| {
                let observing = p.component == Component::Ui || self.observers.contains(*p);
                match frame_surface {
                    Some(sid) => {
                        let key = ((*p).clone(), sid.to_owned());
                        (observing || self.subscriptions.contains(&key))
                            && !self.unsubscribed.contains(&key)
                    }
                    None => observing,
                }
            })
            .cloned()
            .collect();
        for peer in peers {
            let _ = self.send_at(now_ns, &peer, body.clone());
        }
    }
    #[cfg(test)]
    fn witness(&mut self, frame: &FrameRef) -> Result<Witness> {
        self.witness_pixels(frame).map(|(witness, _)| witness)
    }
    fn witness_pixels(&mut self, frame: &FrameRef) -> Result<(Witness, Vec<u8>)> {
        let path = Path::new(&frame.ramws_path);
        if !path.starts_with("/dev/shm")
            || path == Path::new("/dev/shm")
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(invalid("frame outside shared memory"));
        }
        // Pin every directory with O_NOFOLLOW|O_DIRECTORY. /proc/self/fd is
        // Linux's safe Rust equivalent of openat(dirfd, child): each child is
        // resolved from the live directory descriptor, never a mutable prefix.
        use std::os::fd::AsRawFd;
        let open_dir = |path: &Path| -> Result<fs::File> {
            Ok(fs::OpenOptions::new()
                .read(true)
                .custom_flags(frame_directory_flags()?)
                .open(path)?)
        };
        let mut directory = open_dir(Path::new("/"))?;
        for part in ["dev", "shm"] {
            directory = open_dir(
                &PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(part),
            )?;
        }
        let relative = path.strip_prefix("/dev/shm")?;
        let mut parts = relative.components().peekable();
        while let Some(part) = parts.next() {
            let std::path::Component::Normal(name) = part else {
                return Err(invalid("invalid frame path component"));
            };
            if parts.peek().is_none() {
                break;
            }
            directory = open_dir(
                &PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(name),
            )?;
        }
        let name = relative
            .file_name()
            .ok_or_else(|| invalid("missing frame filename"))?;
        let anchored = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(name);
        let before = fs::symlink_metadata(&anchored)?;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(frame_open_flags()?)
            .open(&anchored)?;
        let meta = file.metadata()?;
        if !meta.is_file()
            || before.dev() != meta.dev()
            || before.ino() != meta.ino()
            || meta.len() == 0
            || meta.len() > 64 * 1024 * 1024
        {
            return Err(invalid("invalid frame witness"));
        }
        let mut bytes = Vec::new();
        file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != meta.len() || sha256_hex(&bytes) != frame.sha256 {
            return Err(invalid("frame digest mismatch"));
        }
        Ok((self.authority.retain_witness(&bytes)?, bytes))
    }
    fn frame(&mut self, now_ns: u64, frame: &FrameRef, boundary: Witness) -> Result<bool> {
        let (witness, pixels) = match self.witness_pixels(frame) {
            Ok(witness) => witness,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(false);
            }
            Err(error) => return Err(error),
        };
        let out = self.authority.apply_with_witnesses(
            Input::Frame {
                surface_id: frame.surface_id.clone(),
                frame: Frame {
                    sha256: frame.sha256.clone(),
                    generation: frame.generation,
                    width: frame.width,
                    height: frame.height,
                },
            },
            vec![boundary, witness],
        )?;
        if out.reason.is_none() {
            self.capture_frame_at(now_ns, frame, pixels)?;
            self.tool_state
                .retain(&Command::FrameRef(Box::new(frame.clone())));
        }
        Ok(out.reason.is_none())
    }
    fn route(&mut self, peer: &ReadyPeer, epoch: u64, env: Envelope) -> Result<()> {
        peer.check_sender(&env)?;
        let now_ns = self.now()?;
        self.route_now_ns = Some(now_ns);
        let result = self.route_at(now_ns, peer, epoch, env);
        self.route_now_ns = None;
        result
    }
    fn route_at(&mut self, now_ns: u64, peer: &ReadyPeer, epoch: u64, env: Envelope) -> Result<()> {
        self.replay
            .record(&env.session_id, &env.from, &env.nonce, env.seq)?;
        let raw = serde_json::to_string(&env)?;
        let boundary = self.authority.retain_witness(raw.as_bytes())?;
        match (&env.from.component, &env.body) {
            (Component::Ui, Command::RecordRequest(request)) => {
                return self.capture_wire(now_ns, &env, request, boundary);
            }
            (Component::Agent, Command::MvToolCall(call)) => {
                return self.tool_call(peer, epoch, &env, call, boundary);
            }
            (Component::Ui | Component::Agent, Command::SurfaceRequest(request)) => {
                let value = serde_json::to_value(request)?;
                let op = value["op"].as_str().ok_or_else(|| invalid("missing op"))?;
                if !matches!(
                    op,
                    "create" | "destroy" | "list" | "frame_subscribe" | "frame_unsubscribe"
                ) {
                    return self.unsupported_at(now_ns, &env, boundary);
                }
                if env.from.component == Component::Ui
                    && op == "list"
                    && env.msg_id.starts_with("capture-list:")
                {
                    return self.capture_list_wire(now_ns, &env, boundary);
                }
                let daemon = self
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == Component::Daemon)
                    .ok_or_else(|| invalid("no daemon"))?
                    .endpoint
                    .clone();
                if !self.connections.contains_key(&daemon) {
                    return self.unsupported_at(now_ns, &env, boundary);
                }
                let sid = value["params"]["surface_id"].as_str();
                if matches!(op, "destroy" | "frame_subscribe" | "frame_unsubscribe")
                    && !sid.is_some_and(|id| {
                        self.authority.state().surfaces.contains_key(id)
                            && !self.authority.state().is_destroyed(id)
                    })
                {
                    return self.unsupported_at(now_ns, &env, boundary);
                }
                let out = self.authority.apply_with_witnesses(
                    Input::SurfaceRequest {
                        request: request.as_ref().clone(),
                    },
                    vec![boundary],
                )?;
                if let Some(reason) = out.reason {
                    return self.refuse_at(now_ns, &env.from, &env.msg_id, reason, out.core_seq);
                }
                match op {
                    "frame_subscribe" | "frame_unsubscribe" => {
                        let key = (
                            env.from.clone(),
                            sid.ok_or_else(|| invalid("missing surface"))?.to_owned(),
                        );
                        if op == "frame_subscribe" {
                            self.unsubscribed.remove(&key);
                            self.subscriptions.insert(key);
                        } else {
                            self.subscriptions.remove(&key);
                            self.unsubscribed.insert(key);
                        }
                    }
                    _ => {
                        self.observers.insert(env.from.clone());
                    }
                }
                self.send_at(now_ns, &daemon, env.body.clone())?;
            }
            (Component::Daemon, Command::SurfaceEvent(event)) => {
                if epoch != self.authority.state().epoch {
                    return Err(invalid("old executor"));
                }
                let out = match event.as_ref() {
                    SurfaceEvent::Case0(e) => {
                        Some(self.lifecycle(&e.data.surface, true, boundary)?)
                    }
                    SurfaceEvent::Case1(e) => {
                        Some(self.lifecycle(&e.data.surface, false, boundary)?)
                    }
                    SurfaceEvent::Case2(e) => {
                        if !self.frame(now_ns, &e.data.frame_ref, boundary)? {
                            return Ok(());
                        }
                        None
                    }
                    SurfaceEvent::Case3(_) | SurfaceEvent::Case4(_) => Some(
                        self.authority
                            .apply_with_witnesses(Input::SurfaceNotice, vec![boundary])?,
                    ),
                };
                if let Some(out) = out {
                    if let Some(reason) = out.reason {
                        return self.refuse_at(
                            now_ns,
                            &env.from,
                            &env.msg_id,
                            reason,
                            out.core_seq,
                        );
                    }
                    self.notify_cancellations_at(now_ns, &out.cancelled, out.core_seq)?;
                }
                self.tool_state.retain(&env.body);
                self.tool_state.prune(self.authority.state());
                self.poll_tool_waiters()?;
                let body = match event.as_ref() {
                    SurfaceEvent::Case1(e) => self
                        .tool_state
                        .surface_event(&e.data.surface.surface_id, self.authority.state())
                        .unwrap_or_else(|| env.body.clone()),
                    _ => env.body.clone(),
                };
                self.fanout_at(now_ns, body);
            }
            (Component::Daemon, Command::FrameRef(frame)) => {
                if epoch != self.authority.state().epoch {
                    return Err(invalid("old executor"));
                }
                if !self.frame(now_ns, frame, boundary)? {
                    return Ok(());
                }
                self.fanout_at(now_ns, env.body.clone());
            }
            (Component::Agent, Command::ActionProposal(proposal)) => {
                self.admit_proposal_at(now_ns, peer, &env, proposal, boundary, None)?;
            }

            (Component::Ui, Command::UiIntent(request)) => {
                let value = serde_json::to_value(request)?;
                if matches!(
                    value["op"].as_str(),
                    Some("fold" | "unfold" | "move" | "tab" | "float" | "hide" | "show")
                ) {
                    return self.layout_intent(now_ns, &env, &value, boundary);
                }
                let take = match value["op"].as_str() {
                    Some("take_control") => true,
                    Some("release_control") => false,
                    _ => return self.unsupported_at(now_ns, &env, boundary),
                };
                let sid = value["params"]["surface_id"]
                    .as_str()
                    .ok_or_else(|| invalid("surface required"))?
                    .to_string();
                let input = if take {
                    Input::TakeControl { surface_id: sid }
                } else {
                    Input::ReleaseControl { surface_id: sid }
                };
                if !self
                    .authority
                    .state()
                    .surfaces
                    .contains_key(value["params"]["surface_id"].as_str().unwrap_or(""))
                {
                    return self.unsupported_at(now_ns, &env, boundary);
                }
                let daemon = self
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == Component::Daemon)
                    .ok_or_else(|| invalid("no daemon"))?
                    .endpoint
                    .clone();
                if !self.connections.contains_key(&daemon) {
                    return self.unsupported_at(now_ns, &env, boundary);
                }
                let out = self.authority.apply_with_witnesses(input, vec![boundary])?;
                if let Some(reason) = out.reason {
                    return self.refuse_at(
                        now_ns,
                        &env.from,
                        value["request_id"].as_str().unwrap_or(&env.msg_id),
                        reason,
                        out.core_seq,
                    );
                }
                self.notify_cancellations_at(now_ns, &out.cancelled, out.core_seq)?;
                let mut params = serde_json::json!({"surface_id":value["params"]["surface_id"]});
                if take {
                    params["owner"] = "human".into();
                }
                let body = serde_json::from_value(
                    serde_json::json!({"schema":"surface_request/v0.2","op":value["op"],"params":params}),
                )?;
                self.send_at(now_ns, &daemon, Command::SurfaceRequest(Box::new(body)))?;
            }
            (Component::Daemon, Command::ActionReceipt(receipt)) => {
                if !receipt.error.is_empty() && receipt.verified {
                    let out = self.authority.apply_with_witnesses(
                        Input::Refuse {
                            reason: Refusal::Policy,
                        },
                        vec![boundary],
                    )?;
                    return self.refuse_at(
                        now_ns,
                        &env.from,
                        &receipt.proposal_id,
                        Refusal::Policy,
                        out.core_seq,
                    );
                }
                let input = if self
                    .authority
                    .state()
                    .draining
                    .contains_key(&receipt.proposal_id)
                {
                    Input::Drain {
                        proposal_id: receipt.proposal_id.clone(),
                        epoch,
                    }
                } else {
                    Input::Receipt {
                        proposal_id: receipt.proposal_id.clone(),
                        epoch,
                    }
                };
                let out = self.authority.apply_with_witnesses(input, vec![boundary])?;
                if let Some(reason) = out.reason {
                    return self.refuse_at(
                        now_ns,
                        &env.from,
                        &receipt.proposal_id,
                        reason,
                        out.core_seq,
                    );
                }
                let agent = self
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == Component::Agent)
                    .ok_or_else(|| invalid("no agent"))?
                    .endpoint
                    .clone();
                self.tool_state.retain(&env.body);
                if let Err(error) = self.send_at(now_ns, &agent, env.body.clone()) {
                    if error.downcast_ref::<SendFailure>().is_none() {
                        return Err(error);
                    }
                }
                self.poll_tool_waiters()?;
            }
            _ => return self.unsupported_at(now_ns, &env, boundary),
        }
        Ok(())
    }
    fn admit_proposal(
        &mut self,
        peer: &ReadyPeer,
        env: &Envelope,
        proposal: &crate::wire::payload::ActionProposal,
        boundary: Witness,
        tool: Option<&str>,
    ) -> Result<()> {
        let now_ns = self.route_now_ns.map_or_else(|| self.now(), Ok)?;
        self.admit_proposal_at(now_ns, peer, env, proposal, boundary, tool)
    }
    fn admit_proposal_at(
        &mut self,
        now_ns: u64,
        peer: &ReadyPeer,
        env: &Envelope,
        proposal: &crate::wire::payload::ActionProposal,
        boundary: Witness,
        tool: Option<&str>,
    ) -> Result<()> {
        let daemon = self
            .config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Daemon)
            .ok_or_else(|| invalid("no executor"))?
            .endpoint
            .clone();
        if !self.connections.contains_key(&daemon) {
            return self.proposal_refusal(env, tool, Refusal::Policy, boundary);
        }
        let request = AdmissionRequest::decode(
            &serde_json::to_string(env)?,
            peer.endpoint(),
            &self.config.session_id,
            self.authority.state().epoch,
            now_ns,
        )?;
        let mut witnesses = vec![boundary];
        // A stale proposal needs no retained pixel witness.
        let artifact = self
            .root
            .join("artifacts")
            .join(&proposal.based_on_frame.sha256);
        if let Ok(meta) = fs::metadata(artifact) {
            witnesses.push(Witness {
                sha256: proposal.based_on_frame.sha256.clone(),
                byte_len: meta.len(),
            });
        }
        let verdict = self.authority.admit(request, witnesses)?;
        let admitted = serde_json::to_value(&verdict)?["decision"] == "admitted";
        if let Err(error) = self.proposal_verdict(env, tool, verdict) {
            if admitted && error.downcast_ref::<SendFailure>().is_some() {
                self.authority.apply(Input::DispatchFailed {
                    proposal_id: proposal.proposal_id.clone(),
                    epoch: self.authority.state().epoch,
                })?;
            }
            return Err(error);
        }
        if admitted {
            let out = self.authority.apply(Input::Dispatch {
                proposal_id: proposal.proposal_id.clone(),
                now_ns,
            })?;
            if out.dispatch {
                let body = serde_json::from_value(
                    serde_json::json!({"schema":"surface_request/v0.2","op":"input","params":{"surface_id":proposal.surface_id,"proposal_id":proposal.proposal_id,"action":proposal.action}}),
                )?;
                if let Err(error) =
                    self.send_at(now_ns, &daemon, Command::SurfaceRequest(Box::new(body)))
                {
                    if error.downcast_ref::<SendFailure>().is_none() {
                        return Err(error);
                    }
                    let failed = self.authority.apply(Input::DispatchFailed {
                        proposal_id: proposal.proposal_id.clone(),
                        epoch: self.authority.state().epoch,
                    })?;
                    self.proposal_dispatch_refusal(
                        env,
                        tool,
                        &proposal.proposal_id,
                        Refusal::Policy,
                        failed.core_seq,
                    )?;
                }
            } else {
                self.proposal_dispatch_refusal(
                    env,
                    tool,
                    &proposal.proposal_id,
                    out.reason.unwrap_or(Refusal::Policy),
                    out.core_seq,
                )?;
            }
        }
        Ok(())
    }
    #[cfg(test)]
    fn notify_cancellations(&mut self, ids: &[String], seq: u64) -> Result<()> {
        let now_ns = self.route_now_ns.map_or_else(|| self.now(), Ok)?;
        self.notify_cancellations_at(now_ns, ids, seq)
    }
    fn notify_cancellations_at(&mut self, now_ns: u64, ids: &[String], seq: u64) -> Result<()> {
        let agent = self.agent()?;
        if self.connections.contains_key(&agent) {
            for id in ids {
                if let Err(error) =
                    self.refuse_at(now_ns, &agent, id, Refusal::SurfaceNotAgentControlled, seq)
                {
                    // A slow agent must never prevent forwarding human control
                    // to the daemon. Saturation has its own reserved diagnostic.
                    if error.downcast_ref::<SendFailure>().is_none() {
                        return Err(error);
                    }
                }
            }
        }
        self.poll_tool_waiters()
    }
    fn agent(&self) -> Result<Endpoint> {
        self.config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Agent)
            .map(|p| p.endpoint.clone())
            .ok_or_else(|| invalid("no agent"))
    }
    fn lifecycle(
        &mut self,
        s: &crate::wire::payload::Surface,
        created: bool,
        boundary: Witness,
    ) -> Result<crate::admission::Outcome> {
        use crate::wire::payload::{SurfaceControl, SurfaceState};
        let agent_controlled = if created {
            s.control == SurfaceControl::Agent
        } else {
            self.authority
                .state()
                .surfaces
                .get(&s.surface_id)
                .map_or(s.control == SurfaceControl::Agent, |old| {
                    old.agent_controlled
                })
        };
        let surface = Surface {
            display: s.display.clone(),
            owner: self.agent()?,
            agent_controlled,
            live: s.state == SurfaceState::Active,
            frame: None,
            refresh_after: None,
            allowed_verbs: Vec::new(),
        };
        let update = if created {
            LifecycleUpdate::Created(surface)
        } else {
            match s.state {
                SurfaceState::Lost => LifecycleUpdate::Lost,
                SurfaceState::Destroyed => LifecycleUpdate::Destroyed,
                _ => LifecycleUpdate::Updated(surface),
            }
        };
        Ok(self.authority.apply_with_witnesses(
            Input::Lifecycle {
                surface_id: s.surface_id.clone(),
                update,
            },
            vec![boundary],
        )?)
    }
    fn layout_intent(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        value: &serde_json::Value,
        boundary: Witness,
    ) -> Result<()> {
        let sid = value["params"]["slot_id"]
            .as_str()
            .ok_or_else(|| invalid("slot required"))?;
        let sid = self.tool_state.slot_surface(sid).to_owned();
        let extended = !matches!(value["op"].as_str(), Some("fold" | "unfold"));
        if !self
            .authority
            .state()
            .surfaces
            .get(&sid)
            .is_some_and(|s| s.live)
            || !self.tool_state.has_surface(&sid)
        {
            return if extended {
                self.layout_refusal(env, boundary, "LAYOUT_UNKNOWN_SLOT")
            } else {
                self.unsupported_at(now_ns, env, boundary)
            };
        }
        if extended && self.authority.state().surfaces[&sid].agent_controlled {
            return self.layout_refusal(env, boundary, "LAYOUT_INPUT_MODE_READ");
        }
        if let Err(code) = self.tool_state.placement_change(&sid, value) {
            return self.layout_refusal(env, boundary, code);
        }
        self.authority
            .apply_with_witnesses(Input::SurfaceNotice, vec![boundary])?;
        self.tool_state.retain(&env.body);
        let event = self
            .tool_state
            .surface_event(&sid, self.authority.state())
            .ok_or_else(|| invalid("missing layout view"))?;
        if extended {
            self.fanout_at(now_ns, env.body.clone());
        } else {
            self.fanout_at(now_ns, event);
        }
        Ok(())
    }
    fn unsupported(&mut self, env: &Envelope, boundary: Witness) -> Result<()> {
        let now_ns = self.route_now_ns.map_or_else(|| self.now(), Ok)?;
        self.unsupported_at(now_ns, env, boundary)
    }
    fn unsupported_at(&mut self, now_ns: u64, env: &Envelope, boundary: Witness) -> Result<()> {
        let value = serde_json::to_value(&env.body)?;
        let id = value["request_id"].as_str().unwrap_or(&env.msg_id);
        let out = self.authority.apply_with_witnesses(
            Input::Refuse {
                reason: Refusal::Policy,
            },
            vec![boundary],
        )?;
        self.refuse_at(now_ns, &env.from, id, Refusal::Policy, out.core_seq)
    }
    fn refuse(&mut self, peer: &Endpoint, id: &str, reason: Refusal, seq: u64) -> Result<()> {
        let now_ns = self.route_now_ns.map_or_else(|| self.now(), Ok)?;
        self.refuse_at(now_ns, peer, id, reason, seq)
    }
    fn refuse_at(
        &mut self,
        now_ns: u64,
        peer: &Endpoint,
        id: &str,
        reason: Refusal,
        seq: u64,
    ) -> Result<()> {
        let body = serde_json::from_value(
            serde_json::json!({"schema":"action_verdict/v0.2", "proposal_id":id,"decision":"refused","reason_code":reason,"core_seq":seq}),
        )?;
        self.send_at(now_ns, peer, Command::ActionVerdict(Box::new(body)))
    }
}

// [TARGET, unit decision] Pre-tombstone archives cannot be replayed under the
// terminal-ID reducer. Preserve them unchanged and require a fresh session.
// This diagnostic runs only after strict recovery refused; it never admits data.
fn legacy_destroy_archive(path: &Path, root: &Path) -> bool {
    use std::io::BufRead;
    let inspect = || -> Option<bool> {
        let file = fs::File::open(path).ok()?;
        if file.metadata().ok()?.len() > 64 * 1024 * 1024 {
            return None;
        }
        let mut lines = io::BufReader::new(file).lines();
        let header: serde_json::Value = serde_json::from_str(&lines.next()?.ok()?).ok()?;
        if header["schema"] != "metaviewer.journal/v1" {
            return None;
        }
        for (index, line) in lines.take(100_000).enumerate() {
            let record: serde_json::Value = serde_json::from_str(&line.ok()?).ok()?;
            if record["core_seq"].as_u64()? != index as u64 + 1 {
                return None;
            }
            let file =
                fs::File::open(root.join("events").join(format!("{}.json", index + 1))).ok()?;
            let mut bytes = Vec::new();
            file.take(MAX_FRAME_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() > MAX_FRAME_BYTES {
                return None;
            }
            let event: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
            if event["input"]["event"] == "Lifecycle"
                && event["input"]["update"]["kind"] == "Destroyed"
                && event["state"].get("destroyed").is_none()
            {
                return Some(true);
            }
        }
        Some(false)
    };
    inspect() == Some(true)
}

// Linux O_DIRECTORY differs between ARM and x86 just like O_NOFOLLOW.
fn frame_directory_flags() -> Result<i32> {
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Ok(frame_open_flags()? | 0x4000)
    }
    #[cfg(all(target_os = "linux", any(target_arch = "x86", target_arch = "x86_64")))]
    {
        Ok(frame_open_flags()? | 0x10000)
    }
    #[cfg(not(all(
        target_os = "linux",
        any(target_arch = "aarch64", target_arch = "x86", target_arch = "x86_64")
    )))]
    {
        Err(invalid("unsupported frame open ABI"))
    }
}

// Linux UAPI O_NOFOLLOW | O_NONBLOCK, limited to explicitly supported ABIs.
fn frame_open_flags() -> Result<i32> {
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Ok(0x8000 | 0x800)
    }
    #[cfg(all(target_os = "linux", any(target_arch = "x86", target_arch = "x86_64")))]
    {
        Ok(0x20000 | 0x800)
    }
    #[cfg(not(all(
        target_os = "linux",
        any(target_arch = "aarch64", target_arch = "x86", target_arch = "x86_64")
    )))]
    {
        Err(invalid("unsupported frame open ABI"))
    }
}

/// Bind first; startup failures cannot expose a half-created session server.
pub async fn bind(path: &Path, uid: u32) -> Result<UnixListener> {
    Ok(bind_owner_only(path, uid, Duration::from_millis(100)).await?)
}
/// Runs until cancelled by its owner. All tasks use bounded per-peer queues.
pub async fn serve(listener: UnixListener, server: Arc<Mutex<Server>>, uid: u32) -> Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let accepted = tokio::time::Instant::now();
        let server = server.clone();
        tokio::spawn(async move {
            if let Err(error) = connection(stream, accepted, server, uid).await {
                eprintln!("core peer closed: {error}");
            }
        });
    }
}
async fn connection(
    mut stream: UnixStream,
    accepted: tokio::time::Instant,
    server: Arc<Mutex<Server>>,
    uid: u32,
) -> Result<()> {
    verify_peer_cred(&stream, uid)?;
    let env = tokio::time::timeout_at(accepted + HANDSHAKE_DEADLINE, read_frame(&mut stream))
        .await??
        .ok_or_else(|| invalid("missing hello"))?;
    let config = server
        .lock()
        .map_err(|_| invalid("poisoned authority"))?
        .config
        .clone();
    let registration = config
        .peers
        .iter()
        .find(|p| p.endpoint == env.from)
        .ok_or_else(|| invalid("unregistered peer"))?;
    let policy = HandshakePolicy::new(
        uid,
        registration.endpoint.clone(),
        config.core.endpoint.clone(),
        config.session_id.clone(),
        registration.hello.clone(),
    )?;
    // HandshakePolicy chooses a registration before reading. Replay the already
    // closed-decoded hello through a local socket pair to reuse its exact pin and
    // identity checks; SO_PEERCRED above always authenticates the actual socket.
    let (mut a, mut b) = UnixStream::pair()?;
    let hello_env = env.clone();
    let hello_writer = tokio::spawn(async move { write_frame(&mut a, &hello_env).await });
    let ready = handshake_at(&mut b, &policy, &WireLimits::default(), accepted).await?;
    hello_writer.await??;
    let (tx, rx) = mpsc::sync_channel(MAX_SEND_QUEUE);
    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let terminal = Arc::new(Mutex::new(None));
    let cleanup_deadline = tokio::time::Instant::now() + Duration::from_millis(100);
    loop {
        let occupied = server
            .lock()
            .map_err(|_| invalid("poisoned authority"))?
            .connections
            .contains_key(ready.endpoint());
        if !occupied || tokio::time::Instant::now() >= cleanup_deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let (id, epoch) = {
        let mut s = server.lock().map_err(|_| invalid("poisoned authority"))?;
        if s.connections.contains_key(ready.endpoint()) {
            return Err(invalid("endpoint already connected"));
        }
        let now_ns = s.now()?;
        s.replay
            .record_reconnect(&env.session_id, &env.from, &env.nonce, env.seq)?;
        if env.from.component == Component::Daemon {
            let witness = s
                .authority
                .retain_witness(serde_json::to_string(&env)?.as_bytes())?;
            s.authority
                .apply_with_witnesses(Input::Connect, vec![witness])?;
        }
        s.serial = s
            .serial
            .checked_add(1)
            .ok_or_else(|| invalid("sequence exhausted"))?;
        let id = s.serial;
        let epoch = s.authority.state().epoch;
        s.connections.insert(
            ready.endpoint().clone(),
            Connection {
                id,
                epoch,
                queue: tx,
                terminal: terminal.clone(),
            },
        );
        let hello = s.config.core.hello.clone();
        s.send_at(now_ns, ready.endpoint(), Command::Hello(Box::new(hello)))?;
        (id, epoch)
    };
    let (mut reader, mut writer) = stream.into_split();
    let writer_closed = closed.clone();
    let writer_server = server.clone();
    let writer_endpoint = ready.endpoint().clone();
    let mut writer_task = tokio::spawn(async move {
        while !writer_closed.load(std::sync::atomic::Ordering::Acquire) {
            let notification = terminal.lock().ok().and_then(|mut slot| slot.take());
            if let Some(env) = notification {
                let _ = write_frame(&mut writer, &env).await;
                if let Ok(mut s) = writer_server.lock() {
                    s.retire(&writer_endpoint, id);
                }
                break;
            }
            match rx.try_recv() {
                Ok(env) => {
                    if write_frame(&mut writer, &env).await.is_err() {
                        break;
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => break,
                Err(mpsc::TryRecvError::Empty) => {
                    tokio::time::sleep(Duration::from_millis(2)).await
                }
            }
        }
        writer_closed.store(true, std::sync::atomic::Ordering::Release);
    });
    let result = async {
        loop {
            if closed.load(std::sync::atomic::Ordering::Acquire) {
                return Err(invalid("connection closed"));
            }
            // Polling avoids an unbounded channel or requiring extra Tokio features.
            let reading = read_frame(&mut reader);
            tokio::pin!(reading);
            let env = loop {
                if let Ok(result) =
                    tokio::time::timeout(Duration::from_millis(2), &mut reading).await
                {
                    break result?;
                }
                server
                    .lock()
                    .map_err(|_| invalid("poisoned authority"))?
                    .poll_tool_waiters()?;
                if closed.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(invalid("connection closed"));
                }
            };
            let Some(env) = env else {
                return Ok(());
            };
            let mut s = server.lock().map_err(|_| invalid("poisoned authority"))?;
            let c = s
                .connections
                .get(ready.endpoint())
                .ok_or_else(|| invalid("connection retired"))?;
            if c.id != id || c.epoch != epoch {
                return Err(invalid("connection superseded"));
            }
            if let Err(error) = s.route(&ready, epoch, env) {
                // The recipient's reserved slot reports saturation. Keep the
                // originating peer alive long enough to receive that signal.
                if !error
                    .downcast_ref::<SendFailure>()
                    .is_some_and(|failure| match failure {
                        SendFailure::QueueOverflow(_) => true,
                        SendFailure::Disconnected(to) => to != ready.endpoint(),
                    })
                {
                    return Err(error);
                }
            }
        }
    }
    .await;
    {
        let mut s = server.lock().map_err(|_| invalid("poisoned authority"))?;
        s.retire(ready.endpoint(), id);
    }
    // Removing the sender closes the bounded queue. A half-close still receives
    // its queued verdicts; a stalled reader cannot retain the writer forever.
    if result.is_err()
        || tokio::time::timeout(Duration::from_secs(1), &mut writer_task)
            .await
            .is_err()
    {
        writer_task.abort();
        let _ = writer_task.await;
    }
    closed.store(true, std::sync::atomic::Ordering::Release);
    result
}

pub fn effective_uid() -> Result<u32> {
    let status = fs::read_to_string("/proc/self/status")?;
    Ok(status
        .lines()
        .find_map(|l| l.strip_prefix("Uid:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .ok_or_else(|| invalid("uid unavailable"))?
        .parse()?)
}
pub fn state_dir() -> Result<PathBuf> {
    Ok(crate::journal::default_state_dir()?)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod nv_regressions {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct ShmFixture(PathBuf);
    impl ShmFixture {
        fn new() -> Self {
            loop {
                let root = Path::new("/dev/shm").join(format!(
                    "mv-nv-layout-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&root) {
                    Ok(()) => return Self(root),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => panic!("shared-memory fixture directory: {e}"),
                }
            }
        }
    }
    impl Drop for ShmFixture {
        fn drop(&mut self) {
            // Do not double-panic while unwinding a failed assertion.
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn shm_fixture_is_unique_and_cleans_up_on_unwind() {
        let first = ShmFixture::new();
        let second = ShmFixture::new();
        assert_ne!(first.0, second.0);
        let root = first.0.clone();
        let cleanup_path = root.clone();
        let result = std::panic::catch_unwind(move || {
            let _guard = first;
            fs::create_dir(root.join("ramws")).unwrap();
            fs::write(root.join("ramws/demo.rgb"), b"pixels").unwrap();
            panic!("exercise fixture unwinding");
        });
        assert!(result.is_err());
        assert!(!cleanup_path.exists());
        assert!(second.0.is_dir(), "cleanup must preserve another fixture");
        let second_path = second.0.clone();
        drop(second);
        assert!(!second_path.exists());
    }
    struct Fixture {
        server: Server,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "mv-nv-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let reg = |c: &str| -> Registration {
                serde_json::from_value(json!({"endpoint":{"component":c,"instance":format!("{c}-nv")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":c,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
            };
            let config = Config {
                session_id: "nv-session".into(),
                core: reg("core"),
                peers: vec![reg("daemon"), reg("agent"), reg("ui")],
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
        fn attach(&mut self, c: Component, capacity: usize) -> mpsc::Receiver<Envelope> {
            let (queue, rx) = mpsc::sync_channel(capacity);
            self.server.connections.insert(
                self.endpoint(c),
                Connection {
                    id: 1,
                    epoch: 1,
                    queue,
                    terminal: Arc::new(Mutex::new(None)),
                },
            );
            rx
        }
        fn seed(&mut self) {
            self.server.authority.apply(Input::Connect).unwrap();
            let witness = self.server.authority.retain_witness(b"pixels").unwrap();
            self.server
                .authority
                .apply_with_witnesses(
                    Input::Surface {
                        id: "surface-demo".into(),
                        surface: Surface {
                            display: "display-nv".into(),
                            owner: self.endpoint(Component::Agent),
                            agent_controlled: true,
                            live: true,
                            frame: Some(Frame {
                                sha256: sha256_hex(b"pixels"),
                                generation: 1,
                                width: 1280,
                                height: 720,
                            }),
                            refresh_after: None,
                            allowed_verbs: vec!["mouse".into()],
                        },
                    },
                    vec![witness],
                )
                .unwrap();
        }
        fn envelope(&self, c: Component, n: u64, body: Value) -> Envelope {
            decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":format!("nv-{c:?}-{n}"),"ts_ns":0,"from":self.endpoint(c),"to":self.server.config.core.endpoint,"session_id":"nv-session","seq":n,"nonce":format!("nv-{c:?}-{n}"),"body":body}).to_string()).unwrap()
        }
        async fn route(&mut self, c: Component, n: u64, body: Value) -> Result<()> {
            let reg = self
                .server
                .config
                .peers
                .iter()
                .find(|r| r.endpoint.component == c)
                .unwrap();
            let policy = HandshakePolicy::new(
                effective_uid().unwrap(),
                reg.endpoint.clone(),
                self.server.config.core.endpoint.clone(),
                "nv-session".into(),
                reg.hello.clone(),
            )
            .unwrap();
            let hello = self.envelope(c, 1, serde_json::to_value(&reg.hello).unwrap());
            let (mut a, mut b) = UnixStream::pair().unwrap();
            let task = tokio::spawn(async move { write_frame(&mut a, &hello).await.unwrap() });
            let peer = handshake_at(
                &mut b,
                &policy,
                &WireLimits::default(),
                tokio::time::Instant::now(),
            )
            .await
            .unwrap();
            task.await.unwrap();
            let env = self.envelope(c, n, body);
            self.server.route(&peer, 1, env)
        }
        fn proposal(&self) -> Value {
            let mut p: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/action_proposal.valid.json"
            ))
            .unwrap();
            p["proposal_id"] = "nv-proposal".into();
            p["based_on_frame"]["sha256"] = sha256_hex(b"pixels").into();
            p["based_on_frame"]["generation"] = 1.into();
            p
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    fn run(future: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future);
    }

    #[test]
    fn nv_a1_nested_frames_and_no_symlinks() {
        let mut f = Fixture::new();
        let root = PathBuf::from(format!(
            "/dev/shm/mv-nv-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let direct = root.with_extension("frame");
        fs::write(&direct, b"pixels").unwrap();
        let nested = root.join("frame");
        fs::write(&nested, b"pixels").unwrap();
        let link = root.with_extension("link");
        std::os::unix::fs::symlink(&direct, &link).unwrap();
        let mut frame: FrameRef = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        frame.sha256 = sha256_hex(b"pixels");
        frame.ramws_path = direct.to_str().unwrap().into();
        assert!(f.server.witness(&frame).is_ok());
        frame.ramws_path = link.to_str().unwrap().into();
        let symlink_refused = f.server.witness(&frame).is_err();
        // Exercise the actual open flags independently of the pre-open lstat:
        // a replacement symlink must be rejected by the kernel on this ABI.
        assert!(fs::OpenOptions::new()
            .read(true)
            .custom_flags(frame_open_flags().unwrap())
            .open(&link)
            .is_err());
        frame.ramws_path = nested.to_str().unwrap().into();
        let nested_admitted = f.server.witness(&frame).is_ok();
        fs::remove_file(link).unwrap();
        fs::remove_file(direct).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(symlink_refused);
        assert!(nested_admitted, "canonical nested adapter paths must work");
    }
    #[test]
    fn nv_r2_contract_adapter_layout_and_component_guards() {
        let mut f = Fixture::new();
        let shm = ShmFixture::new();
        let root = &shm.0;
        let adapter = root.join("frames-ABC123");
        fs::create_dir_all(&adapter).unwrap();
        let frame_path = adapter.join("f.rgb");
        fs::write(&frame_path, b"pixels").unwrap();
        let alias = root.join("root-alias");
        std::os::unix::fs::symlink(root, &alias).unwrap();
        let inner_alias = root.join("alias");
        std::os::unix::fs::symlink(&adapter, &inner_alias).unwrap();
        let final_alias = adapter.join("alias.rgb");
        std::os::unix::fs::symlink(&frame_path, &final_alias).unwrap();
        let mut frame: FrameRef = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        frame.sha256 = sha256_hex(b"pixels");
        // Preserve the contract's nested layout under this test's exclusive root.
        let contract_path = root.join(
            Path::new(&frame.ramws_path)
                .strip_prefix("/dev/shm")
                .unwrap(),
        );
        let contract_dir = contract_path.parent().unwrap();
        fs::create_dir_all(contract_dir).unwrap();
        let mut contract_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&contract_path)
            .unwrap();
        use std::io::Write;
        contract_file.write_all(b"pixels").unwrap();
        frame.ramws_path = contract_path.to_str().unwrap().into();
        let contract_admitted = f.server.witness(&frame).is_ok();
        frame.ramws_path = frame_path.to_str().unwrap().into();
        let adapter_admitted = f.server.witness(&frame).is_ok();
        let outside = f.root.join("outside.rgb");
        fs::write(&outside, b"pixels").unwrap();
        let bad_paths = [
            alias.join("frames-ABC123/f.rgb"),
            inner_alias.join("f.rgb"),
            final_alias,
            adapter.join("../frames-ABC123/f.rgb"),
            outside,
        ];
        let refused: Vec<_> = bad_paths
            .iter()
            .map(|path| {
                frame.ramws_path = path.to_str().unwrap().into();
                f.server.witness(&frame).is_err()
            })
            .collect();
        frame.ramws_path = frame_path.to_str().unwrap().into();
        frame.sha256 = "0".repeat(64);
        let bad_digest_refused = f.server.witness(&frame).is_err();
        assert!(contract_admitted, "contract example path must be admitted");
        assert!(
            adapter_admitted,
            "published adapter frame path must be admitted"
        );
        assert!(
            refused.into_iter().all(|r| r),
            "symlink at any component, traversal and outside paths must fail closed"
        );
        assert!(bad_digest_refused);
    }
    #[test]
    fn nv_r2_legacy_destroy_archive_requires_explicit_upgrade() {
        let mut f = Fixture::new();
        f.seed();
        f.server
            .authority
            .apply(Input::Lifecycle {
                surface_id: "surface-demo".into(),
                update: LifecycleUpdate::Destroyed,
            })
            .unwrap();
        let witness = f.server.authority.retain_witness(b"pixels").unwrap();
        f.server
            .authority
            .apply_with_witnesses(
                Input::Frame {
                    surface_id: "surface-demo".into(),
                    frame: Frame {
                        sha256: sha256_hex(b"pixels"),
                        generation: 2,
                        width: 800,
                        height: 600,
                    },
                },
                vec![witness],
            )
            .unwrap();
        let config = f.server.config.clone();
        let root = f.server.root.clone();
        let path = root.join("journal.jsonl");
        // Negative control: current tombstone journals recover, including refusals.
        let fresh = crate::journal::scan(&path, &root).unwrap();
        assert!(fresh.state.is_destroyed("surface-demo"));
        assert!(
            !legacy_destroy_archive(&path, &root),
            "current archives must not be classified as legacy"
        );
        let old = std::mem::replace(
            &mut f.server.authority,
            Authority::create(
                &f.root.join("unused"),
                CoreState::session("unused").unwrap(),
            )
            .unwrap(),
        );
        drop(old);
        let mut records: Vec<Value> = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        let mut tail = "0".repeat(64);
        let mut archive = tail.clone();
        for n in 1..records.len() {
            let event_path = root.join("events").join(format!("{n}.json"));
            let mut event: Value = serde_json::from_slice(&fs::read(&event_path).unwrap()).unwrap();
            event["state"].as_object_mut().unwrap().remove("destroyed");
            if n == records.len() - 1 {
                // Old reduce admitted a frame after destroy, retaining non-live state.
                event["outcome"]["reason"] = Value::Null;
                records[n]["kind"] = records[n - 1]["kind"].clone();
                event["state"]["surfaces"]["surface-demo"]["frame"] =
                    event["input"]["frame"].clone();
                event["state"]["surfaces"]["surface-demo"]["refresh_after"] = Value::Null;
            }
            records[n]["prev_sha256"] = tail.clone().into();
            event["record"] = records[n].clone();
            event["envelope"]["body"] = records[n].clone();
            let bytes = crate::journal::canonical_bytes(&event).unwrap();
            let mut preimage = archive.as_bytes().to_vec();
            preimage.extend_from_slice(&bytes);
            archive = sha256_hex(&preimage);
            fs::write(event_path, bytes).unwrap();
            tail = sha256_hex(&crate::journal::canonical_bytes(&records[n]).unwrap());
        }
        let mut journal = Vec::new();
        for record in records {
            journal.extend(crate::journal::canonical_bytes(&record).unwrap());
            journal.push(b'\n');
        }
        fs::write(&path, journal).unwrap();
        let checkpoint_path = root.join("checkpoint.json");
        let mut checkpoint: Value =
            serde_json::from_slice(&fs::read(&checkpoint_path).unwrap()).unwrap();
        checkpoint["tail"] = tail.into();
        checkpoint["archive"] = archive.into();
        fs::write(
            checkpoint_path,
            crate::journal::canonical_bytes(&checkpoint).unwrap(),
        )
        .unwrap();
        let error = Server::open(config, &f.root, effective_uid().unwrap())
            .err()
            .expect("legacy destroy cannot silently migrate");
        assert!(
            error.to_string().contains("UPGRADE-REQUIRED"),
            "unexpected recovery error: {error}"
        );
        assert!(error.to_string().contains("archive"));
    }
    #[test]
    fn nv_r2_destroyed_frames_never_fanout() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let ui = f.attach(Component::Ui, 8);
            let _daemon = f.attach(Component::Daemon, 8);
            let path = PathBuf::from(format!(
                "/dev/shm/mv-nv-frame-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::write(&path, b"pixels").unwrap();
            let mut frame: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            frame["ramws_path"] = path.to_str().unwrap().into();
            frame["sha256"] = sha256_hex(b"pixels").into();
            // Negative control: a committed live frame is published.
            f.route(Component::Daemon, 2, frame.clone()).await.unwrap();
            assert!(ui.try_recv().is_ok());
            f.server
                .authority
                .apply(Input::Lifecycle {
                    surface_id: "surface-demo".into(),
                    update: LifecycleUpdate::Destroyed,
                })
                .unwrap();
            let before = f.server.authority.state().domain_snapshot().unwrap();
            f.route(Component::Daemon, 3, frame.clone()).await.unwrap();
            assert!(
                ui.try_recv().is_err(),
                "refused FrameRef must not be published"
            );
            f.route(Component::Daemon, 4, json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":frame}})).await.unwrap();
            assert!(
                ui.try_recv().is_err(),
                "refused frame_ready must not be published"
            );
            assert_eq!(
                before,
                f.server.authority.state().domain_snapshot().unwrap()
            );
            fs::remove_file(path).unwrap();
        });
    }
    #[test]
    fn nv_r2_terminal_write_retains_connection_until_flushed() {
        run(async {
            let f = Fixture::new();
            let socket = f.root.join("runtime/blocked.sock");
            let uid = effective_uid().unwrap();
            let listener = bind(&socket, uid).await.unwrap();
            let server = Arc::new(Mutex::new(
                Server::open(f.server.config.clone(), &f.root.join("blocked-state"), uid).unwrap(),
            ));
            let task = tokio::spawn(serve(listener, server.clone(), uid));
            let mut stream = UnixStream::connect(&socket).await.unwrap();
            let hello = f.envelope(
                Component::Ui,
                1,
                serde_json::to_value(&f.server.config.peers[2].hello).unwrap(),
            );
            write_frame(&mut stream, &hello).await.unwrap();
            read_frame(&mut stream).await.unwrap().unwrap();
            let ui = f.endpoint(Component::Ui);
            let terminal = {
                let mut s = server.lock().unwrap();
                let body = Command::Hello(Box::new(s.config.core.hello.clone()));
                for _ in 0..=MAX_SEND_QUEUE {
                    let _ = s.send(&ui, body.clone());
                }
                let terminal = s.connections[&ui].terminal.clone();
                // Force write_frame to await socket capacity before it can finish.
                let mut slot = terminal.lock().unwrap();
                if let Command::SurfaceEvent(event) = &mut slot.as_mut().unwrap().body {
                    if let SurfaceEvent::Case4(e) = event.as_mut() {
                        e.data.detail = "\u{1}".repeat(65_000);
                    }
                }
                drop(slot);
                terminal
            };
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if terminal.lock().unwrap().is_none() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .unwrap();
            assert!(
                server.lock().unwrap().connections.contains_key(&ui),
                "endpoint retired before terminal write completed"
            );
            // A pipelined request must not abort that in-flight terminal write.
            let request = f.envelope(Component::Ui, 2, json!({"schema":"ui_intent/v0.2","request_id":"pipeline","op":"fold","params":{"slot_id":"slot"}}));
            write_frame(&mut stream, &request).await.unwrap();
            // Escaped control characters provide a valid, large wire diagnostic.
            // Keep reading bounded while forcing deterministic socket backpressure.
            use tokio::io::AsyncBufReadExt;
            let mut reader = tokio::io::BufReader::new(stream);
            let mut bytes = Vec::new();
            tokio::time::timeout(Duration::from_secs(3), reader.read_until(b'\n', &mut bytes))
                .await
                .unwrap()
                .unwrap();
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["body"]["data"]["code"], "QUEUE_OVERFLOW");
            task.abort();
        });
    }
    #[test]
    fn nv_a2_missing_daemon_preserves_control() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let ui = f.attach(Component::Ui, 8);
            f.route(Component::Ui,2,json!({"schema":"ui_intent/v0.2","request_id":"take-nv","op":"take_control","params":{"surface_id":"surface-demo"}})).await.unwrap();
            assert!(f.server.authority.state().surfaces["surface-demo"].agent_controlled);
            let reply = serde_json::to_value(ui.try_recv().unwrap().body).unwrap();
            assert_eq!(reply["reason_code"], "POLICY");
            f.route(Component::Ui,3,json!({"schema":"ui_intent/v0.2","request_id":"still-live","op":"fold","params":{"slot_id":"slot"}})).await.unwrap();
            assert!(ui.try_recv().is_ok());
        });
    }
    #[test]
    fn nv_a3_receipt_without_agent_is_durable() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let daemon = f.attach(Component::Daemon, 8);
            let agent = f.attach(Component::Agent, 8);
            f.route(Component::Agent, 2, f.proposal()).await.unwrap();
            agent.try_recv().unwrap();
            daemon.try_recv().unwrap();
            f.server.connections.remove(&f.endpoint(Component::Agent));
            drop(agent);
            let mut receipt: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/action_receipt.valid.json"
            ))
            .unwrap();
            receipt["proposal_id"] = "nv-proposal".into();
            f.route(Component::Daemon, 2, receipt).await.unwrap();
            assert!(f.server.authority.state().pending.is_empty());
            assert!(f.server.authority.state().leases.is_empty());
            let records =
                crate::journal::scan(&f.server.root.join("journal.jsonl"), &f.server.root).unwrap();
            assert_eq!(&records.state, f.server.authority.state());
        });
    }
    #[test]
    fn nv_a4_failed_forward_releases_lease() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let _daemon = f.attach(Component::Daemon, 1);
            let _agent = f.attach(Component::Agent, 8);
            let daemon = f.endpoint(Component::Daemon);
            let hello = f.server.config.core.hello.clone();
            f.server
                .send(&daemon, Command::Hello(Box::new(hello)))
                .unwrap();
            let _result = f.route(Component::Agent, 2, f.proposal()).await;
            assert!(
                f.server.authority.state().pending.is_empty(),
                "unsent work cannot remain dispatched"
            );
            assert!(f.server.authority.state().leases.is_empty());
            let records =
                crate::journal::scan(&f.server.root.join("journal.jsonl"), &f.server.root).unwrap();
            assert_eq!(&records.state, f.server.authority.state());
        });
    }
    #[test]
    fn nv_a4b_failed_verdict_releases_lease() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let daemon = f.attach(Component::Daemon, 8);
            let _agent = f.attach(Component::Agent, 1);
            let agent = f.endpoint(Component::Agent);
            let hello = f.server.config.core.hello.clone();
            f.server
                .send(&agent, Command::Hello(Box::new(hello)))
                .unwrap();
            let error = f
                .route(Component::Agent, 2, f.proposal())
                .await
                .unwrap_err();
            assert!(
                matches!(error.downcast_ref::<SendFailure>(), Some(SendFailure::QueueOverflow(to)) if to == &agent)
            );
            assert!(f.server.authority.state().pending.is_empty());
            assert!(f.server.authority.state().leases.is_empty());
            assert!(
                daemon.try_recv().is_err(),
                "failed verdict must prevent dispatch"
            );
            assert!(f.server.connections[&agent]
                .terminal
                .lock()
                .unwrap()
                .is_some());
            let records =
                crate::journal::scan(&f.server.root.join("journal.jsonl"), &f.server.root).unwrap();
            assert_eq!(&records.state, f.server.authority.state());
        });
    }
    #[test]
    fn nv_a6_error_observes_but_lost_cancels() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let _daemon = f.attach(Component::Daemon, 8);
            let _agent = f.attach(Component::Agent, 8);
            f.route(Component::Agent, 2, f.proposal()).await.unwrap();
            f.route(Component::Daemon,2,json!({"schema":"surface_event/v0.2","event":"error","data":{"surface_id":"surface-demo","code":"CLI_FAILED","detail":"failed"}})).await.unwrap();
            assert!(f.server.authority.state().surfaces["surface-demo"].live);
            assert!(f
                .server
                .authority
                .state()
                .pending
                .contains_key("nv-proposal"));
            let mut surface: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/surface.valid.json"
            ))
            .unwrap();
            surface["state"] = "lost".into();
            f.route(Component::Daemon,3,json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface}})).await.unwrap();
            assert!(!f.server.authority.state().surfaces["surface-demo"].live);
            assert!(f.server.authority.state().pending.is_empty());
            assert!(f
                .server
                .authority
                .state()
                .draining
                .contains_key("nv-proposal"));
        });
    }
    #[test]
    fn nv_a5_overflow_reconnect_fresh_sequence() {
        run(async {
            let f = Fixture::new();
            let socket = f.root.join("runtime/core.sock");
            let uid = effective_uid().unwrap();
            let listener = bind(&socket, uid).await.unwrap();
            let server = Arc::new(Mutex::new(
                Server::open(f.server.config.clone(), &f.root.join("socket-state"), uid).unwrap(),
            ));
            let task = tokio::spawn(serve(listener, server.clone(), uid));
            let mut first = UnixStream::connect(&socket).await.unwrap();
            let hello = f.envelope(
                Component::Ui,
                1,
                serde_json::to_value(&f.server.config.peers[2].hello).unwrap(),
            );
            write_frame(&mut first, &hello).await.unwrap();
            read_frame(&mut first).await.unwrap().unwrap();
            {
                let mut s = server.lock().unwrap();
                let ui = f.endpoint(Component::Ui);
                let body = Command::Hello(Box::new(s.config.core.hello.clone()));
                for _ in 0..=MAX_SEND_QUEUE {
                    let _ = s.send(&ui, body.clone());
                }
            }
            let terminal = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut first))
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_value(terminal.body).unwrap()["data"]["code"],
                "QUEUE_OVERFLOW"
            );
            let mut second = UnixStream::connect(&socket).await.unwrap();
            let mut hello2 = hello;
            hello2.seq = 2;
            hello2.nonce = "fresh-hello".into();
            hello2.msg_id = "fresh-hello".into();
            write_frame(&mut second, &hello2).await.unwrap();
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(3), read_frame(&mut second))
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .body,
                Command::Hello(_)
            ));
            drop(second);
            let mut third = UnixStream::connect(&socket).await.unwrap();
            hello2.seq = 3;
            hello2.nonce = "third-hello".into();
            hello2.msg_id = "third-hello".into();
            write_frame(&mut third, &hello2).await.unwrap();
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(3), read_frame(&mut third))
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .body,
                Command::Hello(_)
            ));
            task.abort();
        });
    }
    #[test]
    fn nv_a5_eof_flushes_reply() {
        run(async {
            use tokio::io::AsyncWriteExt;
            let f = Fixture::new();
            let socket = f.root.join("runtime/eof.sock");
            let uid = effective_uid().unwrap();
            let listener = bind(&socket, uid).await.unwrap();
            let server = Arc::new(Mutex::new(
                Server::open(f.server.config.clone(), &f.root.join("eof-state"), uid).unwrap(),
            ));
            let task = tokio::spawn(serve(listener, server, uid));
            let mut stream = UnixStream::connect(&socket).await.unwrap();
            let hello = f.envelope(
                Component::Ui,
                1,
                serde_json::to_value(&f.server.config.peers[2].hello).unwrap(),
            );
            write_frame(&mut stream, &hello).await.unwrap();
            read_frame(&mut stream).await.unwrap().unwrap();
            let request=f.envelope(Component::Ui,2,json!({"schema":"ui_intent/v0.2","request_id":"eof-request","op":"fold","params":{"slot_id":"slot"}}));
            write_frame(&mut stream, &request).await.unwrap();
            stream.shutdown().await.unwrap();
            let reply = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut stream))
                .await
                .unwrap()
                .unwrap()
                .expect("EOF must drain queued verdicts");
            assert!(matches!(reply.body, Command::ActionVerdict(_)));
            task.abort();
        });
    }
    #[test]
    fn rv7_clock_ceiling_fails_closed_without_domain_mutation() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let daemon = f.attach(Component::Daemon, 8);
            let agent = f.attach(Component::Agent, 8);
            let over_ceiling = f.envelope(
                Component::Agent,
                1,
                serde_json::to_value(&f.server.config.peers[0].hello).unwrap(),
            );
            let mut raw_over = serde_json::to_value(&over_ceiling).unwrap();
            raw_over["ts_ns"] = json!(MAX_WIRE_INTEGER + 1);
            assert!(
                decode_envelope(&serde_json::to_string(&raw_over).unwrap()).is_err(),
                "negative control: ts_ns above MAX_WIRE_INTEGER must be rejected by decode_envelope"
            );

            // Positive control: just below the ceiling works and admits work.
            f.server.origin = Instant::now();
            f.server.clock_offset = Duration::from_nanos(MAX_WIRE_INTEGER - 500_000_000);
            let ts_below = f.server.now().unwrap();
            assert!(ts_below >= MAX_WIRE_INTEGER - 500_000_000);
            assert!(ts_below < MAX_WIRE_INTEGER);
            f.route(Component::Agent, 2, f.proposal()).await.unwrap();
            let verdict_env = agent.try_recv().unwrap();
            assert!(verdict_env.ts_ns.get() < MAX_WIRE_INTEGER);
            let dispatched_env = daemon.try_recv().unwrap();
            assert!(dispatched_env.ts_ns.get() < MAX_WIRE_INTEGER);
            assert_eq!(f.server.authority.state().pending.len(), 1);

            // Negative controls: at the ceiling and above the ceiling refuse new work
            // with typed ClockCeilingError and no domain or sequence mutation.
            let before_domain = f.server.authority.state().domain_snapshot().unwrap();
            let before_state = f.server.snapshot().unwrap();
            let before_seq = f.server.authority.state().core_seq;
            let before_serial = f.server.serial;
            for (idx, offset) in [
                Duration::from_nanos(MAX_WIRE_INTEGER),
                Duration::from_secs(200 * 86_400),
            ]
            .into_iter()
            .enumerate()
            {
                f.server.origin = Instant::now();
                f.server.clock_offset = offset;
                let now_err = f.server.now().unwrap_err();
                let ceiling_err = now_err
                    .downcast_ref::<ClockCeilingError>()
                    .expect("now() at/above ceiling must fail with ClockCeilingError");
                assert!(ceiling_err.elapsed_ns >= u128::from(MAX_WIRE_INTEGER));

                let mut next_proposal = f.proposal();
                next_proposal["proposal_id"] = format!("nv-ceiling-{idx}").into();
                let route_err = f
                    .route(Component::Agent, 3 + idx as u64, next_proposal)
                    .await
                    .unwrap_err();
                assert!(
                    route_err.downcast_ref::<ClockCeilingError>().is_some(),
                    "route() at/above ceiling must refuse with ClockCeilingError: {route_err}"
                );
                assert_eq!(
                    f.server.authority.state().domain_snapshot().unwrap(),
                    before_domain,
                    "refusal at/above clock ceiling must not mutate domain state"
                );
                assert_eq!(f.server.snapshot().unwrap(), before_state);
                assert_eq!(f.server.authority.state().core_seq, before_seq);
                assert_eq!(f.server.serial, before_serial);
                assert!(agent.try_recv().is_err());
                assert!(daemon.try_recv().is_err());
            }
        });
    }
    #[test]
    fn rv8_route_samples_clock_once_and_never_mutates_on_ceiling_crossing() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let mut raw_frame: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            raw_frame["sha256"] = sha256_hex(b"pixels").into();
            let frame: FrameRef = serde_json::from_value(raw_frame).unwrap();
            f.server.capture_frame(&frame, b"pixels".to_vec()).unwrap();
            let daemon = f.attach(Component::Daemon, 8);
            let agent = f.attach(Component::Agent, 8);
            let ui = f.attach(Component::Ui, 8);

            // Start 500 ms below the ceiling and advance 300 ms per now() sample.
            // Sample 0 (-500 ms) and sample 1 (-200 ms) are below the ceiling;
            // sample 2 (+100 ms) crosses MAX_WIRE_INTEGER.
            f.server.origin = Instant::now();
            f.server.clock_offset = Duration::from_nanos(MAX_WIRE_INTEGER - 500_000_000);
            f.server.clock_step_ns.store(300_000_000, Ordering::Relaxed);
            f.server.clock_samples.store(0, Ordering::Relaxed);

            // Request 1 (proposal): must sample now() exactly once, succeed,
            // and stamp verdict + dispatch with identical ts_ns.
            f.route(Component::Agent, 2, f.proposal())
                .await
                .expect("proposal starting below ceiling must not fail mid-transition");
            assert_eq!(
                f.server.clock_samples.load(Ordering::Relaxed),
                1,
                "route(ActionProposal) must sample now() exactly once"
            );
            let verdict_env = agent.try_recv().unwrap();
            let dispatched_env = daemon.try_recv().unwrap();
            assert_eq!(
                verdict_env.ts_ns.get(),
                dispatched_env.ts_ns.get(),
                "one request must observe a single clock sample across verdict and dispatch"
            );
            assert_eq!(f.server.authority.state().pending.len(), 1);

            // Request 2 (capture_wire screenshot): uses sample 1 (-200 ms), must
            // sample now() once and stamp CAPTURE_REPLY + RecordEvent identically.
            let shot_req = json!({
                "schema": "record_request/v0.2",
                "request_id": "rv8-shot",
                "op": "screenshot",
                "params": {"surface_id": "surface-demo", "capture_id": "shot-rv8"}
            });
            f.route(Component::Ui, 2, shot_req)
                .await
                .expect("capture_wire starting below ceiling must not fail mid-transition");
            assert_eq!(
                f.server.clock_samples.load(Ordering::Relaxed),
                2,
                "route(RecordRequest) must sample now() exactly once"
            );
            let cap_reply = ui.try_recv().unwrap();
            let cap_event = ui.try_recv().unwrap();
            assert_eq!(cap_reply.ts_ns.get(), cap_event.ts_ns.get());
            assert!(cap_reply.ts_ns.get() > verdict_env.ts_ns.get());

            // Request 3: sample 2 (+100 ms) crosses MAX_WIRE_INTEGER at route() entry.
            // Negative control: must fail closed with ClockCeilingError and zero mutation.
            let before_domain = f.server.authority.state().domain_snapshot().unwrap();
            let before_state = f.server.snapshot().unwrap();
            let before_seq = f.server.authority.state().core_seq;
            let before_serial = f.server.serial;
            let mut over_proposal = f.proposal();
            over_proposal["proposal_id"] = "rv8-over-ceiling".into();
            let err = f
                .route(Component::Agent, 3, over_proposal)
                .await
                .unwrap_err();
            assert!(
                err.downcast_ref::<ClockCeilingError>().is_some(),
                "expected ClockCeilingError at entry, got: {err}"
            );
            assert_eq!(
                f.server.authority.state().domain_snapshot().unwrap(),
                before_domain
            );
            assert_eq!(f.server.snapshot().unwrap(), before_state);
            assert_eq!(f.server.authority.state().core_seq, before_seq);
            assert_eq!(f.server.serial, before_serial);
            assert!(agent.try_recv().is_err());
            assert!(daemon.try_recv().is_err());
        });
    }
}

#[cfg(test)]
mod reconnect_tests;
