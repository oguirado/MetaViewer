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
//! UI may submit surface_request/v0.2 op="input" when the surface is under human
//! control (!agent_controlled); agent raw input remains refused with POLICY.
//! [TARGET, unit decision] Admitted UI human input is translated into an explicit
//! surface_request/v0.2 op="input" command bound to its validated proposal_id
//! (or a core-minted human-input-<core_seq> id if absent) and tracked across
//! recovery so daemon action_receipt/v0.2 and error outcomes settle against the
//! originating UI peer as typed action_verdict/v0.2 outcomes without emitting a
//! human-input verdict back to the daemon. Recoverable daemon policy refusals
//! (such as an in-flight frame_ref/v0.2 or surface_event/v0.2 on a destroyed
//! surface) emit a refused POLICY action_verdict/v0.2 that the daemon stream
//! consumes after sequence/nonce reservation without terminating the session.
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
//! Idle waiter poll ticks sample the session clock once before dequeuing ready waiters.
//! [TARGET, unit decision] Server shutdown/Drop and serve() teardown flush the
//! authority journal and join its background sync worker before returning.
mod capture;
mod layout;
mod timings;
mod tools;

use crate::admission::{
    AdmissionRequest, Authority, CoreState, Frame, Input, LifecycleUpdate, Surface,
};
#[cfg(test)]
use crate::journal::sha256_hex;
use crate::journal::{VerifiedPixels, Witness};
use crate::wire::payload::{FrameRef, Hello, SurfaceEvent, SurfaceState};
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::future::Future;
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
#[derive(Clone, Debug, PartialEq, Eq)]
struct HumanInputPending {
    seq: u64,
    ui: Endpoint,
    surface_id: String,
    ui_proposal_id: String,
    case4_expired: bool,
}
fn adapter_input_refusal(detail: &str) -> Refusal {
    if detail.contains("SURFACE_NOT_HUMAN_CONTROLLED") || detail.contains("LOCKED_BY_OTHER") {
        Refusal::LockedByOther
    } else if detail.contains("SURFACE_NOT_AGENT_CONTROLLED")
        || detail.contains("human control blocks agent input")
    {
        Refusal::SurfaceNotAgentControlled
    } else if detail.contains("OUT_OF_BOUNDS") || detail.contains("invalid click") {
        Refusal::OutOfBounds
    } else if detail.contains("STALE_FRAME") {
        Refusal::StaleFrame
    } else if detail.contains("BUDGET_EXHAUSTED") || detail.contains("BUDGET_EXCEEDED") {
        Refusal::BudgetExceeded
    } else {
        Refusal::Policy
    }
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
    human_inputs: BTreeMap<String, HumanInputPending>,
    tool_state: tools::ToolState,
    capture: crate::record::capture::Host,
    frame_timings: timings::Writer,
    frame_clock: Option<timings::Clock>,
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
                Err(
                    crate::journal::JournalError::Corrupt
                    | crate::journal::JournalError::Empty
                    | crate::journal::JournalError::Blank
                    | crate::journal::JournalError::Utf8Bom
                    | crate::journal::JournalError::MissingLf
                    | crate::journal::JournalError::Oversize
                    | crate::journal::JournalError::Unsealed,
                ) if legacy_destroy_archive(&path, &root) => {
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
        let mut human_inputs = BTreeMap::new();
        let mut tool_state = tools::ToolState::default();
        for seq in 1..=authority.state().core_seq {
            let event: serde_json::Value = serde_json::from_slice(&fs::read(
                root.join("events").join(format!("{seq}.json")),
            )?)?;
            if let Some(cancelled) = event["outcome"]["cancelled"].as_array() {
                for pid in cancelled.iter().filter_map(|v| v.as_str()) {
                    tool_state.evict_proposal(pid);
                }
            }
            if event["input"]["event"] == "TakeControl" && event["outcome"]["reason"].is_null() {
                if let Some(sid) = event["input"]["surface_id"].as_str() {
                    tool_state.clear_surface_ground_truth(sid);
                }
            } else if event["input"]["event"] == "HumanInput"
                && event["outcome"]["reason"].is_null()
            {
                if let Some(sid) = event["input"]["request"]["params"]["surface_id"].as_str() {
                    tool_state.clear_surface_ground_truth(sid);
                }
            } else if (event["input"]["event"] == "DispatchFailed"
                && event["outcome"]["reason"].is_null())
                || (event["input"]["event"] == "Dispatch"
                    && event["outcome"]["dispatch"].as_bool() == Some(false))
            {
                if let Some(pid) = event["input"]["proposal_id"].as_str() {
                    tool_state.evict_proposal(pid);
                }
            }
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
                            if event["input"]["event"] == "HumanInput"
                                && event["outcome"]["reason"].is_null()
                            {
                                if let (Some(raw_pid), Some(sid)) = (
                                    event["input"]["request"]["params"]["proposal_id"].as_str(),
                                    event["input"]["request"]["params"]["surface_id"].as_str(),
                                ) {
                                    let pid = if raw_pid.is_empty() {
                                        format!("human-input-{seq}")
                                    } else {
                                        raw_pid.to_owned()
                                    };
                                    human_inputs.insert(
                                        pid,
                                        HumanInputPending {
                                            seq,
                                            ui: env.from.clone(),
                                            surface_id: sid.to_owned(),
                                            ui_proposal_id: raw_pid.to_owned(),
                                            case4_expired: false,
                                        },
                                    );
                                }
                            } else if event["input"]["event"] == "SurfaceRequest"
                                && event["outcome"]["reason"].is_null()
                                && event["input"]["request"]["op"] == "destroy"
                            {
                                if let Some(sid) =
                                    event["input"]["request"]["params"]["surface_id"].as_str()
                                {
                                    human_inputs.retain(|_, h| h.surface_id != sid);
                                }
                            } else if event["input"]["event"] == "ReleaseControl"
                                && event["outcome"]["reason"].is_null()
                            {
                                if let Some(sid) = event["input"]["surface_id"].as_str() {
                                    for h in human_inputs.values_mut() {
                                        if h.surface_id == sid {
                                            h.case4_expired = true;
                                        }
                                    }
                                }
                            } else if env.from.component == Component::Daemon {
                                match &env.body {
                                    Command::ActionReceipt(receipt) => {
                                        human_inputs.remove(&receipt.proposal_id);
                                    }
                                    Command::SurfaceEvent(ev)
                                        if event["outcome"]["reason"].is_null() =>
                                    {
                                        match ev.as_ref() {
                                            SurfaceEvent::Case1(e) => {
                                                if matches!(
                                                    e.data.surface.state,
                                                    SurfaceState::Destroyed | SurfaceState::Lost
                                                ) {
                                                    human_inputs.retain(|_, h| {
                                                        h.surface_id != e.data.surface.surface_id
                                                    });
                                                } else if e.data.surface.control
                                                    != crate::wire::payload::SurfaceControl::Human
                                                {
                                                    for h in human_inputs.values_mut() {
                                                        if h.surface_id == e.data.surface.surface_id
                                                        {
                                                            h.case4_expired = true;
                                                        }
                                                    }
                                                }
                                            }
                                            SurfaceEvent::Case4(e)
                                                if e.data.detail.starts_with("input failed:") =>
                                            {
                                                if let Some(pid) = human_inputs
                                                    .iter()
                                                    .filter(|(_, h)| {
                                                        h.surface_id == e.data.surface_id
                                                            && !h.case4_expired
                                                    })
                                                    .min_by_key(|(_, h)| h.seq)
                                                    .map(|(k, _)| k.clone())
                                                {
                                                    human_inputs.remove(&pid);
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            if event["outcome"]["reason"].is_null() {
                                if let Command::ActionReceipt(receipt) = &env.body {
                                    if event["input"]["event"] != "Drain" {
                                        let recomputed = Command::ActionReceipt(Box::new(
                                            tool_state.recompute_daemon_receipt(receipt, &root),
                                        ));
                                        tool_state.retain(&recomputed);
                                    }
                                } else {
                                    tool_state.retain(&env.body);
                                }
                            }
                            // One envelope can witness several journal records. A restarted
                            // sequence must not overwrite an older nonce witness.
                            if seen.insert((env.from.clone(), env.nonce.clone())) {
                                envelopes.push(env);
                            }
                        }
                    } else if let Ok(meta) = serde_json::from_str::<serde_json::Value>(raw) {
                        if let Some(pid) = meta["human_input_settled"].as_str() {
                            human_inputs.remove(pid);
                        }
                    }
                }
            }
        }
        human_inputs.retain(|_, h| {
            authority
                .state()
                .surfaces
                .get(&h.surface_id)
                .is_some_and(|s| s.live)
                && !authority.state().is_destroyed(&h.surface_id)
        });
        tool_state.prune(authority.state());
        for env in envelopes {
            // Journal order is authoritative across connection generations;
            // restore every nonce and the latest observed sender sequence.
            replay.record_reconnect(&env.session_id, &env.from, &env.nonce, env.seq)?;
        }
        let capture = crate::record::capture::Host::with_serial(authority.state().core_seq);
        let frame_timings = timings::Writer::start(root.join("artifacts/frame_timings.jsonl"));
        Ok(Self {
            frame_timings,
            frame_clock: None,
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
            human_inputs,
            tool_state,
            capture,
        })
    }
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        Ok(self.authority.state().snapshot()?)
    }
    pub fn shutdown(&mut self) -> Result<()> {
        self.frame_timings.close();
        self.connections.clear();
        self.observers.clear();
        self.subscriptions.clear();
        self.unsubscribed.clear();
        Ok(self.authority.flush_sync()?)
    }
    pub fn close(&mut self) -> Result<()> {
        self.shutdown()
    }
    fn settle_human_input_in_journal(&mut self, daemon_pid: &str) -> Result<u64> {
        let witness_bytes =
            serde_json::to_vec(&serde_json::json!({"human_input_settled": daemon_pid}))?;
        let witness = self.authority.retain_witness(&witness_bytes)?;
        let out = self.authority.apply_with_witnesses(
            Input::Refuse {
                reason: Refusal::Policy,
            },
            vec![witness],
        )?;
        Ok(out.core_seq)
    }
    fn retire(&mut self, peer: &Endpoint, id: u64) {
        if self.connections.get(peer).is_some_and(|c| c.id == id) {
            self.connections.remove(peer);
            self.tool_state.remove_peer(peer);
            self.observers.remove(peer);
            self.subscriptions.retain(|(p, _)| p != peer);
            self.unsubscribed.retain(|(p, _)| p != peer);
            if peer.component == Component::Daemon {
                let mut pending: Vec<_> = self
                    .human_inputs
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                pending.sort_by_key(|(_, h)| h.seq);
                let now_ns = self.now().unwrap_or(0);
                for (daemon_pid, human) in pending {
                    let Ok(core_seq) = self.settle_human_input_in_journal(&daemon_pid) else {
                        continue;
                    };
                    self.human_inputs.remove(&daemon_pid);
                    if self.connections.contains_key(&human.ui) {
                        let _ = self.refuse_at(
                            now_ns,
                            &human.ui,
                            &human.ui_proposal_id,
                            Refusal::Policy,
                            core_seq,
                        );
                    }
                }
            } else {
                let mut dropped: Vec<_> = self
                    .human_inputs
                    .iter()
                    .filter(|(_, h)| &h.ui == peer)
                    .map(|(k, h)| (k.clone(), h.seq))
                    .collect();
                dropped.sort_by_key(|(_, seq)| *seq);
                for (daemon_pid, _) in dropped {
                    if self.settle_human_input_in_journal(&daemon_pid).is_ok() {
                        self.human_inputs.remove(&daemon_pid);
                    }
                }
            }
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
        self.send_tagged_at(ts_ns, to, body, "core")
    }
    fn send_tagged_at(
        &mut self,
        ts_ns: u64,
        to: &Endpoint,
        body: Command,
        tag: &str,
    ) -> Result<()> {
        self.serial = self
            .serial
            .checked_add(1)
            .ok_or_else(|| invalid("sequence exhausted"))?;
        let env = Envelope {
            schema: "envelope/v0.2".into(),
            msg_id: format!("{tag}-{}-{}", self.authority.state().epoch, self.serial),
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
        let started = Instant::now();
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
        if let Some(clock) = &mut self.frame_clock {
            clock.row.fanout_ns += started.elapsed().as_nanos();
        }
    }
    #[cfg(test)]
    fn witness(&mut self, frame: &FrameRef) -> Result<Witness> {
        self.witness_pixels(frame).map(|(witness, _)| witness)
    }
    fn open_anchored_shm_dir(shm_root: &Path, path: &Path) -> Result<(fs::File, PathBuf)> {
        if !path.starts_with(shm_root)
            || path == shm_root
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
        let mut directory =
            open_dir(Path::new("/")).map_err(|_| invalid("shared memory prefix unavailable"))?;
        for part in shm_root.components().filter_map(|c| match c {
            std::path::Component::Normal(p) => Some(p),
            _ => None,
        }) {
            directory = open_dir(
                &PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(part),
            )
            .map_err(|_| invalid("shared memory prefix unavailable"))?;
        }
        let relative = path.strip_prefix(shm_root)?;
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
        Ok((directory, anchored))
    }
    #[allow(dead_code)]
    fn read_shm_pixels(frame: &FrameRef) -> Result<VerifiedPixels> {
        Self::read_shm_pixels_under_session(Path::new("/dev/shm"), None, frame)
    }
    fn read_shm_pixels_in_session(
        session_root: &Path,
        epoch: u64,
        frame: &FrameRef,
    ) -> Result<VerifiedPixels> {
        Self::read_shm_pixels_under_session(
            Path::new("/dev/shm"),
            Some((session_root, epoch)),
            frame,
        )
    }
    #[allow(dead_code)]
    pub(crate) fn read_shm_pixels_under(
        shm_root: &Path,
        frame: &FrameRef,
    ) -> Result<VerifiedPixels> {
        Self::read_shm_pixels_under_session(shm_root, None, frame)
    }
    pub(crate) fn read_shm_pixels_under_session(
        shm_root: &Path,
        session: Option<(&Path, u64)>,
        frame: &FrameRef,
    ) -> Result<VerifiedPixels> {
        let started = Instant::now();
        #[cfg(test)]
        let t_read = Instant::now();
        #[cfg(test)]
        let (h_before, sh_before) = crate::journal::STAGE_TIMINGS.with(|c| {
            let st = c.get();
            (st.hash_ns, st.skipped_hash_ns)
        });
        let uid = effective_uid()?;
        let expected_bytes = crate::verify::byte_len(frame)
            .filter(|&len| len > 0 && len <= 64 * 1024 * 1024)
            .ok_or_else(|| invalid("invalid frame witness"))?;
        let path = Path::new(&frame.ramws_path);
        let (_directory, anchored) = Self::open_anchored_shm_dir(shm_root, path)?;
        let before = fs::symlink_metadata(&anchored)?;
        if !before.is_file()
            || before.file_type().is_symlink()
            || before.uid() != uid
            || (before.mode() & 0o077) != 0
            || before.len() != expected_bytes
        {
            return Err(invalid("invalid frame witness"));
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(frame_open_flags()?)
            .open(&anchored)?;
        let meta = file.metadata()?;
        if !meta.is_file()
            || before.dev() != meta.dev()
            || before.ino() != meta.ino()
            || meta.uid() != uid
            || (meta.mode() & 0o077) != 0
            || meta.len() != expected_bytes
        {
            return Err(invalid("invalid frame witness"));
        }
        let expected_len = expected_bytes as usize;
        let res = match session {
            Some((session_root, epoch)) => VerifiedPixels::read_verified_for_surface(
                session_root,
                &frame.surface_id,
                epoch,
                frame.generation,
                frame.width,
                frame.height,
                &file,
                expected_len,
                &frame.sha256,
            ),
            None => VerifiedPixels::read_verified(&file, expected_len, &frame.sha256),
        };
        #[cfg(test)]
        crate::journal::STAGE_TIMINGS.with(|cell| {
            let mut s = cell.get();
            let h_delta = s.hash_ns.saturating_sub(h_before);
            let sh_delta = s.skipped_hash_ns.saturating_sub(sh_before);
            s.shm_read_ns += t_read
                .elapsed()
                .as_nanos()
                .saturating_sub(h_delta)
                .saturating_sub(sh_delta);
            cell.set(s);
        });
        let mut verified = res?;
        let after = file.metadata()?;
        if !after.is_file()
            || after.dev() != meta.dev()
            || after.ino() != meta.ino()
            || after.uid() != uid
            || (after.mode() & 0o077) != 0
            || after.len() != expected_bytes
        {
            return Err(invalid("invalid frame witness"));
        }
        verified.read_started = Some(started);
        verified.shm_read_ns = started
            .elapsed()
            .as_nanos()
            .saturating_sub(verified.hash_ns)
            .saturating_sub(verified.skipped_hash_ns);
        Ok(verified)
    }
    #[cfg(test)]
    fn witness_pixels(&mut self, frame: &FrameRef) -> Result<(Witness, Vec<u8>)> {
        let verified =
            Self::read_shm_pixels_in_session(&self.root, self.authority.state().epoch, frame)?;
        let witness = verified.retain_in_authority(&mut self.authority)?;
        Ok((witness, verified.into_bytes()))
    }
    fn precheck_frame_on_not_found(&self, frame: &FrameRef) -> Result<()> {
        if frame.generation < 1
            || crate::verify::byte_len(frame).is_none_or(|n| n == 0 || n > 64 * 1024 * 1024)
            || frame.sha256.len() != 64
            || !frame
                .sha256
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(invalid("invalid frame"));
        }
        if self.authority.state().is_destroyed(&frame.surface_id)
            || self
                .authority
                .state()
                .surfaces
                .get(&frame.surface_id)
                .is_some_and(|s| !s.live)
        {
            return Ok(());
        }
        let s = self
            .authority
            .state()
            .surfaces
            .get(&frame.surface_id)
            .ok_or_else(|| invalid("unknown surface"))?;
        if s.frame
            .as_ref()
            .is_some_and(|f| frame.generation <= f.generation)
        {
            return Err(invalid("generation regression"));
        }
        Ok(())
    }
    fn frame(
        &mut self,
        now_ns: u64,
        frame: &FrameRef,
        boundary: Witness,
        pre_pixels: Option<Result<VerifiedPixels>>,
    ) -> Result<Option<crate::admission::Outcome>> {
        let session_root = self.root.clone();
        let session_epoch = self.authority.state().epoch;
        let pixels_result = pre_pixels.unwrap_or_else(|| {
            Self::read_shm_pixels_in_session(&session_root, session_epoch, frame)
        });
        let witness_started = Instant::now();
        let verified = match pixels_result {
            Ok(verified) => verified,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                self.precheck_frame_on_not_found(frame)?;
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        if verified.sha256() != frame.sha256 {
            return Err(invalid("frame digest mismatch"));
        }
        if let Some(clock) = &mut self.frame_clock {
            clock.read(&verified);
            clock.row.byte_len = verified.bytes().len() as u64;
        }
        let witness = verified.retain_in_authority(&mut self.authority)?;
        let pixels = verified.into_bytes();
        // [TARGET, unit decision] Only the daemon boundary translates these
        // validated frames into recoverable refusals. Direct admission retains
        // its atomic InvalidInput contract; witness failures above still retire.
        let state = self.authority.state();
        let surface = state.surfaces.get(&frame.surface_id);
        let unknown = surface.is_none() && !state.is_destroyed(&frame.surface_id);
        let stale = surface.is_some_and(|s| {
            s.live
                && s.frame
                    .as_ref()
                    .is_some_and(|f| frame.generation <= f.generation)
        });
        let input = if unknown || stale {
            Input::Refuse {
                reason: Refusal::StaleFrame,
            }
        } else {
            Input::Frame {
                surface_id: frame.surface_id.clone(),
                frame: Frame {
                    sha256: frame.sha256.clone(),
                    generation: frame.generation,
                    width: frame.width,
                    height: frame.height,
                },
            }
        };
        let out = self
            .authority
            .apply_with_witnesses(input, vec![boundary, witness])?;
        if let Some(clock) = &mut self.frame_clock {
            clock.row.witness_journal_ns += witness_started.elapsed().as_nanos();
            clock.accepted = out.reason.is_none();
        }
        if out.reason.is_none() {
            let capture_started = Instant::now();
            #[cfg(test)]
            let t_cap = Instant::now();
            #[cfg(test)]
            let h_before = crate::journal::STAGE_TIMINGS.with(|c| c.get().hash_ns);
            let capture_result = self.capture_frame_at(now_ns, frame, pixels);
            if let Some(clock) = &mut self.frame_clock {
                clock.row.capture_ns += capture_started.elapsed().as_nanos();
            }
            capture_result?;
            #[cfg(test)]
            crate::journal::STAGE_TIMINGS.with(|cell| {
                let mut s = cell.get();
                let h_delta = s.hash_ns.saturating_sub(h_before);
                s.capture_ns += t_cap.elapsed().as_nanos().saturating_sub(h_delta);
                cell.set(s);
            });
            self.tool_state
                .retain(&Command::FrameRef(Box::new(frame.clone())));
        }
        Ok(Some(out))
    }
    fn daemon_frame_ref(body: &Command) -> Option<&FrameRef> {
        match body {
            Command::FrameRef(frame) => Some(frame.as_ref()),
            Command::SurfaceEvent(event) => match event.as_ref() {
                SurfaceEvent::Case2(event) => Some(&event.data.frame_ref),
                _ => None,
            },
            _ => None,
        }
    }
    // Uncommitted superseded frames skip pixel reads and SHA-256 verification by design:
    // skipped bytes never enter state, journal, capture, or display.
    fn can_supersede_frame(&self, epoch: u64, frame: &FrameRef) -> bool {
        let Some(expected_bytes) =
            crate::verify::byte_len(frame).filter(|&len| len > 0 && len <= 64 * 1024 * 1024)
        else {
            return false;
        };
        let Ok(uid) = effective_uid() else {
            return false;
        };
        if epoch != self.authority.state().epoch
            || frame.generation < 1
            || frame.sha256.len() != 64
            || !frame
                .sha256
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            || self.capture.has_active_recording(&frame.surface_id)
        {
            return false;
        }
        let path = Path::new(&frame.ramws_path);
        let Ok((directory, anchored)) = Self::open_anchored_shm_dir(Path::new("/dev/shm"), path)
        else {
            return false;
        };
        let valid_leaf = fs::symlink_metadata(&anchored).is_ok_and(|m| {
            m.is_file()
                && !m.file_type().is_symlink()
                && m.uid() == uid
                && (m.mode() & 0o077) == 0
                && m.len() == expected_bytes
        });
        drop(directory);
        if !valid_leaf {
            return false;
        }
        if self.authority.state().is_destroyed(&frame.surface_id) {
            return false;
        }
        let Some(surface) = self.authority.state().surfaces.get(&frame.surface_id) else {
            return false;
        };
        surface.live
            && surface
                .frame
                .as_ref()
                .is_none_or(|f| frame.generation > f.generation)
    }
    fn skip_superseded_frame(
        &mut self,
        peer: &ReadyPeer,
        epoch: u64,
        env: &Envelope,
        frame: &FrameRef,
    ) -> Result<bool> {
        if !self.can_supersede_frame(epoch, frame) {
            return Ok(false);
        }
        peer.check_sender(env)?;
        let _now_ns = self.now()?;
        self.replay
            .record(&env.session_id, &env.from, &env.nonce, env.seq)?;
        Ok(true)
    }
    fn route_peer_envelope(
        server: &Arc<Mutex<Server>>,
        ready: &ReadyPeer,
        id: u64,
        epoch: u64,
        env: Envelope,
    ) -> Result<()> {
        Self::route_peer_envelope_with_pixels(server, ready, id, epoch, env, None)
    }
    fn route_peer_envelope_with_pixels(
        server: &Arc<Mutex<Server>>,
        ready: &ReadyPeer,
        id: u64,
        epoch: u64,
        env: Envelope,
        pre_pixels: Option<Result<VerifiedPixels>>,
    ) -> Result<()> {
        let mut s = server.lock().map_err(|_| invalid("poisoned authority"))?;
        let c = s
            .connections
            .get(ready.endpoint())
            .ok_or_else(|| invalid("connection retired"))?;
        if c.id != id || c.epoch != epoch {
            return Err(invalid("connection superseded"));
        }
        if let Err(error) = s.route_with_pixels(ready, epoch, env, pre_pixels) {
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
        Ok(())
    }
    async fn route_daemon_batch(
        server: &Arc<Mutex<Server>>,
        ready: &ReadyPeer,
        id: u64,
        epoch: u64,
        batch: Vec<Envelope>,
    ) -> Result<bool> {
        let mut had_frame = false;
        let len = batch.len();
        let mut pre_verified: Vec<Option<Result<VerifiedPixels>>> =
            (0..len).map(|_| None).collect();
        for (i, env) in batch.iter().enumerate() {
            let mut superseding: Option<(usize, &FrameRef)> = None;
            if let Some(frame_i) = Self::daemon_frame_ref(&env.body) {
                had_frame = true;
                let mut prev_gen = frame_i.generation;
                for (j, next) in batch.iter().enumerate().skip(i + 1) {
                    let Some(frame_j) = Self::daemon_frame_ref(&next.body) else {
                        break;
                    };
                    if frame_j.surface_id == frame_i.surface_id {
                        let meta_ok = {
                            let s = server.lock().map_err(|_| invalid("poisoned authority"))?;
                            let c = s
                                .connections
                                .get(ready.endpoint())
                                .ok_or_else(|| invalid("connection retired"))?;
                            if c.id != id || c.epoch != epoch {
                                return Err(invalid("connection superseded"));
                            }
                            frame_j.generation > prev_gen && s.can_supersede_frame(epoch, frame_j)
                        };
                        if !meta_ok {
                            superseding = None;
                            break;
                        }
                        prev_gen = frame_j.generation;
                        superseding = Some((j, frame_j));
                    }
                }
                if let Some((j, frame_j)) = superseding {
                    if pre_verified[j].is_none() {
                        let session_root = server
                            .lock()
                            .map_err(|_| invalid("poisoned authority"))?
                            .root
                            .clone();
                        let cand_clone = frame_j.clone();
                        let res = if cand_clone.width.saturating_mul(cand_clone.height) >= 512 * 512
                        {
                            tokio::task::spawn_blocking(move || {
                                Server::read_shm_pixels_in_session(
                                    &session_root,
                                    epoch,
                                    &cand_clone,
                                )
                            })
                            .await
                            .map_err(|_| invalid("frame witness worker panicked"))?
                        } else {
                            Server::read_shm_pixels_in_session(&session_root, epoch, &cand_clone)
                        };
                        pre_verified[j] = Some(res);
                    }
                    let cand_pixels_ok = pre_verified[j].as_ref().is_some_and(|r| r.is_ok());
                    if cand_pixels_ok {
                        let mut s = server.lock().map_err(|_| invalid("poisoned authority"))?;
                        let c = s
                            .connections
                            .get(ready.endpoint())
                            .ok_or_else(|| invalid("connection retired"))?;
                        if c.id != id || c.epoch != epoch {
                            return Err(invalid("connection superseded"));
                        }
                        if s.can_supersede_frame(epoch, frame_j)
                            && s.skip_superseded_frame(ready, epoch, env, frame_i)?
                        {
                            continue;
                        }
                    }
                }
                let pre_pixels = match pre_verified[i].take() {
                    Some(res) => res,
                    None => {
                        let session_root = server
                            .lock()
                            .map_err(|_| invalid("poisoned authority"))?
                            .root
                            .clone();
                        let frame_clone = frame_i.clone();
                        if frame_clone.width.saturating_mul(frame_clone.height) >= 512 * 512 {
                            tokio::task::spawn_blocking(move || {
                                Server::read_shm_pixels_in_session(
                                    &session_root,
                                    epoch,
                                    &frame_clone,
                                )
                            })
                            .await
                            .map_err(|_| invalid("frame witness worker panicked"))?
                        } else {
                            Server::read_shm_pixels_in_session(&session_root, epoch, &frame_clone)
                        }
                    }
                };
                Self::route_peer_envelope_with_pixels(
                    server,
                    ready,
                    id,
                    epoch,
                    env.clone(),
                    Some(pre_pixels),
                )?;
                continue;
            }
            Self::route_peer_envelope(server, ready, id, epoch, env.clone())?;
        }
        Ok(had_frame)
    }
    #[cfg(test)]
    fn route(&mut self, peer: &ReadyPeer, epoch: u64, env: Envelope) -> Result<()> {
        self.route_with_pixels(peer, epoch, env, None)
    }
    fn route_with_pixels(
        &mut self,
        peer: &ReadyPeer,
        epoch: u64,
        env: Envelope,
        pre_pixels: Option<Result<VerifiedPixels>>,
    ) -> Result<()> {
        peer.check_sender(&env)?;
        let now_ns = self.now()?;
        self.route_now_ns = Some(now_ns);
        let result = self.route_at_with_pixels(now_ns, peer, epoch, env, pre_pixels);
        self.route_now_ns = None;
        result
    }
    #[cfg(test)]
    fn route_at(&mut self, now_ns: u64, peer: &ReadyPeer, epoch: u64, env: Envelope) -> Result<()> {
        self.route_at_with_pixels(now_ns, peer, epoch, env, None)
    }
    fn route_at_with_pixels(
        &mut self,
        now_ns: u64,
        peer: &ReadyPeer,
        epoch: u64,
        env: Envelope,
        pre_pixels: Option<Result<VerifiedPixels>>,
    ) -> Result<()> {
        self.frame_clock = if env.from.component == Component::Daemon {
            Self::daemon_frame_ref(&env.body).map(timings::Clock::new)
        } else {
            None
        };
        if let (Some(clock), Some(Ok(pixels))) = (&mut self.frame_clock, &pre_pixels) {
            clock.read(pixels);
        }
        let result = self.route_at_inner(now_ns, peer, epoch, env, pre_pixels);
        if let Some(clock) = self.frame_clock.take() {
            if clock.accepted {
                self.frame_timings.submit(clock.finish());
            }
        }
        result
    }
    fn route_at_inner(
        &mut self,
        now_ns: u64,
        peer: &ReadyPeer,
        epoch: u64,
        env: Envelope,
        pre_pixels: Option<Result<VerifiedPixels>>,
    ) -> Result<()> {
        let boundary_started = Instant::now();
        self.replay
            .record(&env.session_id, &env.from, &env.nonce, env.seq)?;
        // [TARGET, unit decision] An authenticated, replay-reserved probe ack
        // changes no surface state and retains no journal witness.
        if env.from.component == Component::Daemon {
            if let Command::SurfaceEvent(event) = &env.body {
                if let SurfaceEvent::Case4(e) = event.as_ref() {
                    if e.data.surface_id == "daemon"
                        && e.data.code == "DAEMON_KEEPALIVE"
                        && e.data.detail == "core-keepalive"
                    {
                        return Ok(());
                    }
                }
            }
        }
        let raw = serde_json::to_string(&env)?;
        let boundary = VerifiedPixels::from_bytes(raw.into_bytes())?
            .retain_in_authority(&mut self.authority)?;
        if let Some(clock) = &mut self.frame_clock {
            clock.row.witness_journal_ns += boundary_started.elapsed().as_nanos();
        }
        match (&env.from.component, &env.body) {
            (Component::Ui, Command::RecordRequest(request)) => {
                return self.capture_wire(now_ns, &env, request, boundary);
            }
            (Component::Agent, Command::MvToolCall(call)) => {
                return self.tool_call(peer, epoch, &env, call, boundary);
            }
            (Component::Ui | Component::Agent, Command::SurfaceRequest(request)) => {
                if let crate::wire::payload::SurfaceRequest::Case5(input_req) = request.as_ref() {
                    if env.from.component == Component::Ui {
                        return self.human_input_at(now_ns, &env, input_req, boundary);
                    }
                    let out = self.authority.apply_with_witnesses(
                        Input::Refuse {
                            reason: Refusal::Policy,
                        },
                        vec![boundary],
                    )?;
                    return self.refuse_at(
                        now_ns,
                        &env.from,
                        &input_req.params.proposal_id,
                        Refusal::Policy,
                        out.core_seq,
                    );
                }
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
                        self.authority
                            .state()
                            .surfaces
                            .get(id)
                            .is_some_and(|s| s.live)
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
                    "destroy" => {
                        if let Some(sid) = sid {
                            self.human_inputs.retain(|_, h| h.surface_id != sid);
                        }
                        self.observers.insert(env.from.clone());
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
                        let Some(out) =
                            self.frame(now_ns, &e.data.frame_ref, boundary, pre_pixels)?
                        else {
                            return Ok(());
                        };
                        Some(out)
                    }
                    SurfaceEvent::Case3(_) | SurfaceEvent::Case4(_) => Some(
                        self.authority
                            .apply_with_witnesses(Input::SurfaceNotice, vec![boundary])?,
                    ),
                };
                let settled_seq = out.as_ref().map(|o| o.core_seq);
                if let Some(out) = out {
                    if let Some(reason) = out.reason {
                        if let Err(error) =
                            self.refuse_at(now_ns, &env.from, &env.msg_id, reason, out.core_seq)
                        {
                            if !matches!(
                                error.downcast_ref::<SendFailure>(),
                                Some(SendFailure::QueueOverflow(_))
                            ) {
                                return Err(error);
                            }
                        }
                        return Ok(());
                    }
                    self.notify_cancellations_at(now_ns, &out.cancelled, out.core_seq)?;
                }
                if let SurfaceEvent::Case1(e) = event.as_ref() {
                    if e.data.surface.state == SurfaceState::Destroyed {
                        self.human_inputs
                            .retain(|_, h| h.surface_id != e.data.surface.surface_id);
                    } else if e.data.surface.state == SurfaceState::Lost {
                        let mut matching: Vec<_> = self
                            .human_inputs
                            .iter()
                            .filter(|(_, h)| h.surface_id == e.data.surface.surface_id)
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect();
                        matching.sort_by_key(|(_, h)| h.seq);
                        for (daemon_pid, human) in matching {
                            let seq = self.settle_human_input_in_journal(&daemon_pid)?;
                            self.human_inputs.remove(&daemon_pid);
                            if self.connections.contains_key(&human.ui) {
                                if let Err(error) = self.refuse_at(
                                    now_ns,
                                    &human.ui,
                                    &human.ui_proposal_id,
                                    Refusal::Policy,
                                    seq,
                                ) {
                                    if error.downcast_ref::<SendFailure>().is_none() {
                                        return Err(error);
                                    }
                                }
                            }
                        }
                    } else if e.data.surface.control != crate::wire::payload::SurfaceControl::Human
                    {
                        for h in self.human_inputs.values_mut() {
                            if h.surface_id == e.data.surface.surface_id {
                                h.case4_expired = true;
                            }
                        }
                    }
                }
                let prior_visibility = match event.as_ref() {
                    SurfaceEvent::Case1(e) => self
                        .tool_state
                        .layout_visibility(&e.data.surface.surface_id),
                    _ => None,
                };
                #[cfg(test)]
                let t_fan = Instant::now();
                self.tool_state.retain(&env.body);
                self.tool_state.prune(self.authority.state());
                self.poll_tool_waiters_at(now_ns)?;
                let body = match event.as_ref() {
                    SurfaceEvent::Case1(e) => self
                        .tool_state
                        .surface_event(&e.data.surface.surface_id, self.authority.state())
                        .or_else(|| {
                            tools::ToolState::terminal_surface_event(
                                &e.data.surface,
                                self.authority.state(),
                                prior_visibility.as_deref(),
                            )
                        })
                        .unwrap_or_else(|| env.body.clone()),
                    _ => env.body.clone(),
                };
                self.fanout_at(now_ns, body);
                if let (SurfaceEvent::Case4(e), Some(seq)) = (event.as_ref(), settled_seq) {
                    if e.data.detail.starts_with("input failed:") {
                        if let Some(pid) = self
                            .human_inputs
                            .iter()
                            .filter(|(_, h)| h.surface_id == e.data.surface_id && !h.case4_expired)
                            .min_by_key(|(_, h)| h.seq)
                            .map(|(k, _)| k.clone())
                        {
                            if let Some(human) = self.human_inputs.remove(&pid) {
                                let reason = adapter_input_refusal(&e.data.detail);
                                if self.connections.contains_key(&human.ui) {
                                    if let Err(error) = self.refuse_at(
                                        now_ns,
                                        &human.ui,
                                        &human.ui_proposal_id,
                                        reason,
                                        seq,
                                    ) {
                                        if error.downcast_ref::<SendFailure>().is_none() {
                                            return Err(error);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                #[cfg(test)]
                crate::journal::STAGE_TIMINGS.with(|cell| {
                    let mut s = cell.get();
                    s.fanout_ns += t_fan.elapsed().as_nanos();
                    cell.set(s);
                });
            }
            (Component::Daemon, Command::FrameRef(frame)) => {
                if epoch != self.authority.state().epoch {
                    return Err(invalid("old executor"));
                }
                let Some(out) = self.frame(now_ns, frame, boundary, pre_pixels)? else {
                    return Ok(());
                };
                if let Some(reason) = out.reason {
                    if let Err(error) =
                        self.refuse_at(now_ns, &env.from, &env.msg_id, reason, out.core_seq)
                    {
                        if !matches!(
                            error.downcast_ref::<SendFailure>(),
                            Some(SendFailure::QueueOverflow(_))
                        ) {
                            return Err(error);
                        }
                    }
                    return Ok(());
                }
                self.fanout_at(now_ns, env.body.clone());
            }
            (Component::Daemon, Command::Observation(obs)) => {
                if epoch != self.authority.state().epoch {
                    return Err(invalid("old executor"));
                }
                let Some(witnesses) =
                    self.accept_and_retain_daemon_observation(obs, boundary.clone())?
                else {
                    return self.unsupported_at(now_ns, &env, boundary);
                };
                self.authority
                    .apply_with_witnesses(Input::SurfaceNotice, witnesses)?;
                self.tool_state.retain(&env.body);
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
                if !self
                    .authority
                    .state()
                    .surfaces
                    .get(&sid)
                    .is_some_and(|s| s.live || self.authority.state().is_destroyed(&sid))
                {
                    return self.unsupported_at(now_ns, &env, boundary);
                }
                let input = if take {
                    Input::TakeControl { surface_id: sid }
                } else {
                    Input::ReleaseControl { surface_id: sid }
                };
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
                if take {
                    if let Some(sid) = value["params"]["surface_id"].as_str() {
                        self.tool_state.clear_surface_ground_truth(sid);
                    }
                }
                self.notify_cancellations_at(now_ns, &out.cancelled, out.core_seq)?;
                if !take {
                    if let Some(sid) = value["params"]["surface_id"].as_str() {
                        for h in self.human_inputs.values_mut() {
                            if h.surface_id == sid {
                                h.case4_expired = true;
                            }
                        }
                    }
                }
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
                if let Some(human) = self.human_inputs.get(&receipt.proposal_id).cloned() {
                    return self.human_input_receipt_at(
                        now_ns,
                        &env,
                        &receipt.proposal_id,
                        &human,
                        receipt,
                        boundary,
                    );
                }
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
                let was_draining = self
                    .authority
                    .state()
                    .draining
                    .contains_key(&receipt.proposal_id);
                let input = if was_draining {
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
                if was_draining {
                    self.tool_state
                        .verification_contexts
                        .remove(&receipt.proposal_id);
                    self.poll_tool_waiters_at(now_ns)?;
                    return Ok(());
                }
                let agent = self
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == Component::Agent)
                    .ok_or_else(|| invalid("no agent"))?
                    .endpoint
                    .clone();
                let recomputed = Command::ActionReceipt(Box::new(
                    self.tool_state
                        .recompute_daemon_receipt(receipt, &self.root),
                ));
                self.tool_state.retain(&recomputed);
                if let Err(error) = self.send_at(now_ns, &agent, recomputed) {
                    if error.downcast_ref::<SendFailure>().is_none() {
                        return Err(error);
                    }
                }
                self.poll_tool_waiters_at(now_ns)?;
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
            return self.proposal_refusal(
                env,
                tool,
                &proposal.proposal_id,
                Refusal::Policy,
                boundary,
            );
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
                self.tool_state.evict_proposal(&proposal.proposal_id);
            }
            return Err(error);
        }
        if admitted {
            let out = self.authority.apply(Input::Dispatch {
                proposal_id: proposal.proposal_id.clone(),
                now_ns,
            })?;
            if out.dispatch {
                self.tool_state.retain_proposal(proposal);
                let body = serde_json::from_value(
                    serde_json::json!({"schema":"surface_request/v0.2","op":"input","params":{"surface_id":proposal.surface_id,"proposal_id":proposal.proposal_id,"origin":"agent","action":proposal.action}}),
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
                    self.tool_state.evict_proposal(&proposal.proposal_id);
                    self.proposal_dispatch_refusal(
                        env,
                        tool,
                        &proposal.proposal_id,
                        Refusal::Policy,
                        failed.core_seq,
                    )?;
                }
            } else {
                self.tool_state.evict_proposal(&proposal.proposal_id);
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
        for id in ids {
            self.tool_state.evict_proposal(id);
        }
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
        self.poll_tool_waiters_at(now_ns)
    }
    fn poll_tool_waiters_tick(&mut self) -> Result<()> {
        let now_ns = self.route_now_ns.map_or_else(|| self.now(), Ok)?;
        self.poll_tool_waiters_at(now_ns)
    }
    fn poll_tool_waiters_at(&mut self, now_ns: u64) -> Result<()> {
        let prev = self.route_now_ns.replace(now_ns);
        let result = self.poll_tool_waiters();
        self.route_now_ns = prev;
        result
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
        let raw_slot = value["params"]["slot_id"]
            .as_str()
            .ok_or_else(|| invalid("slot required"))?;
        let sid = if self.authority.state().is_destroyed(raw_slot) {
            raw_slot.to_owned()
        } else {
            self.tool_state.slot_surface(raw_slot).to_owned()
        };
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
    fn human_input_at(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        input_req: &crate::wire::payload::SurfaceRequestCase5,
        boundary: Witness,
    ) -> Result<()> {
        let daemon = self
            .config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Daemon)
            .ok_or_else(|| invalid("no daemon"))?
            .endpoint
            .clone();
        if matches!(
            input_req.params.origin,
            crate::wire::Optional::Present(crate::wire::payload::SurfaceRequestInputOrigin::Agent)
        ) || !self.connections.contains_key(&daemon)
            || self.human_inputs.len() >= 100_000
        {
            let out = self.authority.apply_with_witnesses(
                Input::Refuse {
                    reason: Refusal::Policy,
                },
                vec![boundary],
            )?;
            return self.refuse_at(
                now_ns,
                &env.from,
                &input_req.params.proposal_id,
                Refusal::Policy,
                out.core_seq,
            );
        }
        let out = self.authority.apply_with_witnesses(
            Input::HumanInput {
                request: input_req.clone(),
            },
            vec![boundary],
        )?;
        if let Some(reason) = out.reason {
            return self.refuse_at(
                now_ns,
                &env.from,
                &input_req.params.proposal_id,
                reason,
                out.core_seq,
            );
        }
        self.tool_state
            .clear_surface_ground_truth(&input_req.params.surface_id);
        let daemon_proposal_id = if input_req.params.proposal_id.is_empty() {
            format!("human-input-{}", out.core_seq)
        } else {
            input_req.params.proposal_id.clone()
        };
        let daemon_body =
            Command::SurfaceRequest(Box::new(crate::wire::payload::SurfaceRequest::Case5(
                Box::new(crate::wire::payload::SurfaceRequestCase5 {
                    schema: crate::wire::payload::SurfaceRequestCase0Schema::Value,
                    op: crate::wire::payload::SurfaceRequestCase5Op::Value,
                    params: crate::wire::payload::SurfaceRequestCase5Params {
                        surface_id: input_req.params.surface_id.clone(),
                        proposal_id: daemon_proposal_id.clone(),
                        origin: crate::wire::Optional::Present(
                            crate::wire::payload::SurfaceRequestInputOrigin::Human,
                        ),
                        action: input_req.params.action.clone(),
                    },
                }),
            )));
        if let Err(error) = self.send_at(now_ns, &daemon, daemon_body) {
            if error.downcast_ref::<SendFailure>().is_none() {
                return Err(error);
            }
            let failed_seq = self.settle_human_input_in_journal(&daemon_proposal_id)?;
            if let Err(ui_err) = self.refuse_at(
                now_ns,
                &env.from,
                &input_req.params.proposal_id,
                Refusal::Policy,
                failed_seq,
            ) {
                if ui_err.downcast_ref::<SendFailure>().is_none() {
                    return Err(ui_err);
                }
            }
            return Ok(());
        }
        self.human_inputs.insert(
            daemon_proposal_id,
            HumanInputPending {
                seq: out.core_seq,
                ui: env.from.clone(),
                surface_id: input_req.params.surface_id.clone(),
                ui_proposal_id: input_req.params.proposal_id.clone(),
                case4_expired: false,
            },
        );
        Ok(())
    }
    fn human_input_receipt_at(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        daemon_proposal_id: &str,
        human: &HumanInputPending,
        receipt: &crate::wire::payload::ActionReceipt,
        boundary: Witness,
    ) -> Result<()> {
        if receipt.verified || !receipt.error.is_empty() {
            let reason = if receipt.verified {
                Refusal::Policy
            } else {
                adapter_input_refusal(&receipt.error)
            };
            let out = self
                .authority
                .apply_with_witnesses(Input::Refuse { reason }, vec![boundary])?;
            self.human_inputs.remove(daemon_proposal_id);
            if self.connections.contains_key(&human.ui) {
                if let Err(error) = self.refuse_at(
                    now_ns,
                    &human.ui,
                    &human.ui_proposal_id,
                    reason,
                    out.core_seq,
                ) {
                    if error.downcast_ref::<SendFailure>().is_none() {
                        return Err(error);
                    }
                }
            }
            return Ok(());
        }
        let out = self
            .authority
            .apply_with_witnesses(Input::SurfaceNotice, vec![boundary])?;
        self.human_inputs.remove(daemon_proposal_id);
        self.tool_state.retain(&env.body);
        if self.connections.contains_key(&human.ui) {
            let verdict = serde_json::from_value(serde_json::json!({
                "schema": "action_verdict/v0.2",
                "proposal_id": human.ui_proposal_id,
                "decision": "admitted",
                "core_seq": out.core_seq,
            }))?;
            if let Err(error) =
                self.send_at(now_ns, &human.ui, Command::ActionVerdict(Box::new(verdict)))
            {
                if error.downcast_ref::<SendFailure>().is_none() {
                    return Err(error);
                }
            }
        }
        Ok(())
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
impl Drop for Server {
    fn drop(&mut self) {
        if let Err(err) = self.shutdown() {
            eprintln!("core server drop shutdown failed: {err}");
        }
    }
}

// [TARGET, unit decision] Pre-tombstone archives cannot be replayed under the
// terminal-ID reducer. Preserve them unchanged and require a fresh session.
// This diagnostic runs only after strict recovery refused; it never admits data.
fn legacy_destroy_archive(path: &Path, root: &Path) -> bool {
    let check_event_file = |seq: u64| -> Option<bool> {
        let file = fs::File::open(root.join("events").join(format!("{seq}.json"))).ok()?;
        let mut bytes = Vec::new();
        file.take(MAX_FRAME_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > MAX_FRAME_BYTES {
            return None;
        }
        let event: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        Some(
            event["input"]["event"] == "Lifecycle"
                && event["input"]["update"]["kind"] == "Destroyed"
                && event["outcome"]["reason"].is_null()
                && event["state"].get("destroyed").is_none(),
        )
    };
    let inspect = || -> Option<bool> {
        let meta = fs::metadata(path).ok()?;
        if meta.len() > 64 * 1024 * 1024 {
            return None;
        }
        let events_dir = root.join("events");
        if !events_dir.is_dir() {
            return Some(false);
        }
        for seq in 1..=100_000_u64 {
            let event_path = events_dir.join(format!("{seq}.json"));
            if !event_path.exists() {
                break;
            }
            if check_event_file(seq) == Some(true) {
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
struct ServeGuard {
    server: Arc<Mutex<Server>>,
}
impl Drop for ServeGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.server.lock() {
            if let Err(err) = s.authority.flush_sync() {
                eprintln!("core serve teardown flush failed: {err}");
            }
        }
    }
}
/// Runs until cancelled by its owner. All tasks use bounded per-peer queues.
pub async fn serve(listener: UnixListener, server: Arc<Mutex<Server>>, uid: u32) -> Result<()> {
    let _guard = ServeGuard {
        server: server.clone(),
    };
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
    stream: UnixStream,
    accepted: tokio::time::Instant,
    server: Arc<Mutex<Server>>,
    uid: u32,
) -> Result<()> {
    connection_with_liveness(
        stream,
        accepted,
        server,
        uid,
        crate::wire::WireLimits::default(),
        Duration::from_secs(10),
    )
    .await
}

async fn connection_with_liveness(
    mut stream: UnixStream,
    accepted: tokio::time::Instant,
    server: Arc<Mutex<Server>>,
    uid: u32,
    limits: crate::wire::WireLimits,
    probe_interval: Duration,
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
    let is_daemon = ready.endpoint().component == Component::Daemon;
    let result = async {
        let mut batch: Vec<Envelope> = Vec::new();
        // [TARGET, unit decision] Core initiates contract-valid list probes.
        // Only daemon replies refresh read_frame's unchanged idle deadline;
        // sending probes cannot keep a silent or wedged daemon alive.
        let mut next_probe = Instant::now() + probe_interval;
        loop {
            if closed.load(std::sync::atomic::Ordering::Acquire) {
                return Err(invalid("connection closed"));
            }
            // Polling avoids an unbounded channel or requiring extra Tokio features.
            let reading = crate::transport::read_frame_with_limits(&mut reader, &limits);
            tokio::pin!(reading);
            let env = loop {
                if !batch.is_empty() {
                    if let std::task::Poll::Ready(result) = std::future::poll_fn(|cx| {
                        let mut unconstrained = tokio::task::unconstrained(reading.as_mut());
                        match std::pin::Pin::new(&mut unconstrained).poll(cx) {
                            std::task::Poll::Ready(res) => {
                                std::task::Poll::Ready(std::task::Poll::Ready(res))
                            }
                            std::task::Poll::Pending => {
                                std::task::Poll::Ready(std::task::Poll::Pending)
                            }
                        }
                    })
                    .await
                    {
                        break result?;
                    }
                    let had_frame = Server::route_daemon_batch(
                        &server,
                        &ready,
                        id,
                        epoch,
                        std::mem::take(&mut batch),
                    )
                    .await?;
                    if had_frame {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                }
                if let Ok(result) = tokio::time::timeout(
                    Duration::from_millis(2),
                    tokio::task::unconstrained(&mut reading),
                )
                .await
                {
                    break result?;
                }
                if is_daemon && Instant::now() >= next_probe {
                    let mut guard = server.lock().map_err(|_| invalid("poisoned authority"))?;
                    let now = guard.now()?;
                    guard.send_tagged_at(
                        now, ready.endpoint(),
                        Command::SurfaceRequest(Box::new(serde_json::from_value(
                            serde_json::json!({"schema":"surface_request/v0.2","op":"list","params":{}}),
                        )?)),
                        "core-keepalive",
                    )?;
                    next_probe = Instant::now() + probe_interval;
                }
                server
                    .lock()
                    .map_err(|_| invalid("poisoned authority"))?
                    .poll_tool_waiters_tick()?;
                if closed.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(invalid("connection closed"));
                }
            };
            // Only graceful EOF drains buffered daemon batches; abort or read error
            // drops any un-routed batch immediately by design (no delivery promise on abort).
            let Some(env) = env else {
                if !batch.is_empty() {
                    Server::route_daemon_batch(
                        &server,
                        &ready,
                        id,
                        epoch,
                        std::mem::take(&mut batch),
                    )
                    .await?;
                }
                return Ok(());
            };
            if is_daemon {
                batch.push(env);
                if batch.len() >= 32 {
                    let had_frame = Server::route_daemon_batch(
                        &server,
                        &ready,
                        id,
                        epoch,
                        std::mem::take(&mut batch),
                    )
                    .await?;
                    server
                        .lock()
                        .map_err(|_| invalid("poisoned authority"))?
                        .poll_tool_waiters_tick()?;
                    if had_frame {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                }
                continue;
            }
            Server::route_peer_envelope(&server, &ready, id, epoch, env)?;
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
            let _ = self.server.shutdown();
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
    fn daemon_liveness_probes_preserve_idle_connection_but_silent_peer_expires() {
        run(async {
            for responsive in [true, false] {
                let f = Fixture::new();
                let server = Arc::new(Mutex::new(
                    Server::open(
                        f.server.config.clone(),
                        &f.root.join("liveness"),
                        effective_uid().unwrap(),
                    )
                    .unwrap(),
                ));
                let reg = f
                    .server
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == Component::Daemon)
                    .unwrap();
                let hello = f.envelope(
                    Component::Daemon,
                    1,
                    serde_json::to_value(&reg.hello).unwrap(),
                );
                let (a, mut b) = UnixStream::pair().unwrap();
                let mut limits = crate::wire::WireLimits::default();
                limits.read_deadline = Duration::from_millis(150);
                let task = tokio::spawn(connection_with_liveness(
                    a,
                    tokio::time::Instant::now(),
                    server.clone(),
                    effective_uid().unwrap(),
                    limits,
                    Duration::from_millis(30),
                ));
                write_frame(&mut b, &hello).await.unwrap();
                assert!(matches!(
                    read_frame(&mut b).await.unwrap().unwrap().body,
                    Command::Hello(_)
                ));
                let started = Instant::now();
                let mut seq = 1;
                while started.elapsed() < Duration::from_millis(400) {
                    let next = tokio::time::timeout(Duration::from_millis(200), read_frame(&mut b))
                        .await
                        .unwrap();
                    match next {
                        Ok(Some(probe)) => {
                            assert!(probe.msg_id.starts_with("core-keepalive-"));
                            if responsive {
                                seq += 1;
                                let ack = f.envelope(Component::Daemon, seq, json!({"schema":"surface_event/v0.2","event":"error","data":{"surface_id":"daemon","code":"DAEMON_KEEPALIVE","detail":"core-keepalive"}}));
                                write_frame(&mut b, &ack).await.unwrap();
                            }
                        }
                        Ok(None) | Err(_) => {
                            assert!(!responsive, "responsive daemon closed");
                            break;
                        }
                    }
                }
                if responsive {
                    assert!(
                        !task.is_finished(),
                        "daemon must survive multiple idle deadlines"
                    );
                    drop(b);
                    assert!(task.await.unwrap().is_ok());
                } else {
                    assert!(
                        task.await.unwrap().is_err(),
                        "silent peer must time out despite probes"
                    );
                }
                server.lock().unwrap().close().unwrap();
            }
        });
    }

    #[test]
    fn nv_a1_nested_frames_and_no_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let mut f = Fixture::new();
        let root = PathBuf::from(format!(
            "/dev/shm/mv-nv-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let direct = root.with_extension("frame");
        fs::write(&direct, b"pixels").unwrap();
        fs::set_permissions(&direct, fs::Permissions::from_mode(0o600)).unwrap();
        let nested = root.join("frame");
        fs::write(&nested, b"pixels").unwrap();
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o600)).unwrap();
        let link = root.with_extension("link");
        std::os::unix::fs::symlink(&direct, &link).unwrap();
        let mut frame: FrameRef = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        frame.width = 2;
        frame.height = 1;
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
        use std::os::unix::fs::PermissionsExt;
        let mut f = Fixture::new();
        let shm = ShmFixture::new();
        let root = &shm.0;
        let adapter = root.join("frames-ABC123");
        fs::create_dir_all(&adapter).unwrap();
        let frame_path = adapter.join("f.rgb");
        fs::write(&frame_path, b"pixels").unwrap();
        fs::set_permissions(&frame_path, fs::Permissions::from_mode(0o600)).unwrap();
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
        frame.width = 2;
        frame.height = 1;
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
        fs::set_permissions(&contract_path, fs::Permissions::from_mode(0o600)).unwrap();
        frame.ramws_path = contract_path.to_str().unwrap().into();
        let contract_admitted = f.server.witness(&frame).is_ok();
        frame.ramws_path = frame_path.to_str().unwrap().into();
        let adapter_admitted = f.server.witness(&frame).is_ok();
        let outside = f.root.join("outside.rgb");
        fs::write(&outside, b"pixels").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
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
            use std::os::unix::fs::PermissionsExt;
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
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            let mut frame: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            frame["width"] = 2.into();
            frame["height"] = 1.into();
            frame["generation"] = 2.into();
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
            frame["generation"] = 3.into();
            f.route(Component::Daemon, 3, frame.clone()).await.unwrap();
            assert!(
                ui.try_recv().is_err(),
                "refused FrameRef must not be published"
            );
            frame["generation"] = 4.into();
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
            drop(reader);
            task.abort();
            let _ = task.await;
            drop(server);
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
            receipt["verified"] = false.into();
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
            drop((first, third));
            task.abort();
            let _ = task.await;
            drop(server);
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
            drop(stream);
            task.abort();
            let _ = task.await;
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
    #[test]
    fn nv_poll_tick_samples_clock_once_and_never_loses_waiters_on_ceiling_crossing() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let daemon = f.attach(Component::Daemon, 8);
            let agent = f.attach(Component::Agent, 8);
            f.route(Component::Agent, 2, f.proposal()).await.unwrap();
            let _ = agent.try_recv().unwrap();
            let _ = daemon.try_recv().unwrap();
            for seq in [3, 4] {
                f.route(
                    Component::Agent,
                    seq,
                    json!({
                        "schema": "mv_tool_call/v0.2",
                        "request_id": format!("wait-{seq}"),
                        "op": "wait_verify",
                        "args": {"proposal_id": "nv-proposal", "timeout_ms": 60_000}
                    }),
                )
                .await
                .unwrap();
            }
            assert!(agent.try_recv().is_err());

            let mut receipt: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/action_receipt.valid.json"
            ))
            .unwrap();
            receipt["proposal_id"] = "nv-proposal".into();
            f.server.tool_state.retain(&Command::ActionReceipt(Box::new(
                serde_json::from_value(receipt).unwrap(),
            )));

            // Negative control at the ceiling: an idle poll tick at/above
            // MAX_WIRE_INTEGER must fail closed before retain dequeues waiters.
            f.server.origin = Instant::now();
            f.server.clock_offset = Duration::from_nanos(MAX_WIRE_INTEGER);
            f.server.clock_step_ns.store(0, Ordering::Relaxed);
            let ceiling_err = f.server.poll_tool_waiters_tick().unwrap_err();
            assert!(
                ceiling_err.downcast_ref::<ClockCeilingError>().is_some(),
                "expected ClockCeilingError at poll entry, got: {ceiling_err}"
            );
            assert!(agent.try_recv().is_err());

            // Start 500 ms below the ceiling and step 600 ms per sample:
            // sample 0 (-500 ms) is valid; sample 1 (+100 ms) crosses MAX_WIRE_INTEGER.
            // One idle poll tick must sample once and reply to both waiters identically.
            f.server.clock_offset = Duration::from_nanos(MAX_WIRE_INTEGER - 500_000_000);
            f.server.clock_step_ns.store(600_000_000, Ordering::Relaxed);
            f.server.clock_samples.store(0, Ordering::Relaxed);
            f.server
                .poll_tool_waiters_tick()
                .expect("idle poll starting below ceiling must not fail mid-tick");
            assert_eq!(
                f.server.clock_samples.load(Ordering::Relaxed),
                1,
                "idle poll tick must sample now() exactly once across woken waiters"
            );
            let first = agent.try_recv().expect("first waiter reply must arrive");
            let second = agent
                .try_recv()
                .expect("second waiter reply must not be lost");
            assert_eq!(first.ts_ns.get(), second.ts_ns.get());
            assert_eq!(
                serde_json::to_value(&first.body).unwrap()["request_id"],
                "nv-Agent-3"
            );
            assert_eq!(
                serde_json::to_value(&second.body).unwrap()["request_id"],
                "nv-Agent-4"
            );
        });
    }
    #[test]
    fn nv_w3_server_shutdown_and_fixture_drop_flush_pending_frame_batches() {
        fn snapshot_session_tree(session: &Path) -> Vec<(String, u64, u64, i64)> {
            let mut entries = Vec::new();
            for rel in ["", "events", "artifacts"] {
                let dir = if rel.is_empty() {
                    session.to_path_buf()
                } else {
                    session.join(rel)
                };
                let mut paths: Vec<_> = fs::read_dir(&dir)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .collect();
                paths.sort();
                for p in paths {
                    let m = fs::symlink_metadata(&p).unwrap();
                    if m.is_file() {
                        let name = p
                            .strip_prefix(session)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned();
                        entries.push((name, m.len(), m.ino(), m.mtime_nsec()));
                    }
                }
            }
            entries
        }

        run(async {
            use std::os::unix::fs::PermissionsExt;
            let mut f = Fixture::new();
            f.seed();
            let _ui = f.attach(Component::Ui, 32);
            let _daemon = f.attach(Component::Daemon, 32);
            let shm = ShmFixture::new();
            let session_root = f.server.root.clone();
            crate::journal::hold_sync_worker_for_test(&session_root);
            for gen in 2..=10u64 {
                let bytes = format!("w3-frame-pixels-{gen:02}").into_bytes();
                let frame_path = shm.0.join(format!("f-{gen}.rgb"));
                fs::write(&frame_path, &bytes).unwrap();
                fs::set_permissions(&frame_path, fs::Permissions::from_mode(0o600)).unwrap();
                let mut frame: Value = serde_json::from_str(include_str!(
                    "../../../contracts/examples/v0.2/frame_ref.valid.json"
                ))
                .unwrap();
                frame["width"] = 6.into();
                frame["height"] = 1.into();
                frame["generation"] = gen.into();
                frame["ramws_path"] = frame_path.to_str().unwrap().into();
                frame["sha256"] = sha256_hex(&bytes).into();
                f.route(Component::Daemon, gen, frame).await.unwrap();
                if gen == 9 {
                    std::thread::sleep(Duration::from_millis(55));
                }
            }
            std::thread::sleep(Duration::from_millis(55));
            // Negative control: clearing peer state without journal flush leaves the
            // in-flight worker batch (gen 2..=9) and pending 9th frame (gen 10) unpromoted.
            f.server.connections.clear();
            assert!(
                session_root.join("checkpoint.next").exists(),
                "9th frame must leave a pending checkpoint.next before shutdown"
            );
            let cp_before: Value =
                serde_json::from_slice(&fs::read(session_root.join("checkpoint.json")).unwrap())
                    .unwrap();
            assert_eq!(
                cp_before["count"], 2,
                "negative control: without shutdown flush, checkpoint.json stays at seed count"
            );

            crate::journal::release_test_sync_hold(&session_root);
            f.server.shutdown().unwrap();
            assert!(
                !session_root.join("checkpoint.next").exists(),
                "Server::shutdown must flush and promote checkpoint.next before returning"
            );
            let snap_immediately = snapshot_session_tree(&session_root);
            let cp_after: Value =
                serde_json::from_slice(&fs::read(session_root.join("checkpoint.json")).unwrap())
                    .unwrap();
            assert_eq!(cp_after["count"], 11);
            let replayed =
                crate::journal::scan(&session_root.join("journal.jsonl"), &session_root).unwrap();
            assert_eq!(&replayed.state, f.server.authority.state());
            std::thread::sleep(Duration::from_millis(20));
            assert_eq!(
                snapshot_session_tree(&session_root),
                snap_immediately,
                "session directory must be quiescent after Server::shutdown returns"
            );

            // Also verify Server::drop directly when a new frame batch is in flight/pending.
            let _ui = f.attach(Component::Ui, 32);
            let _daemon = f.attach(Component::Daemon, 32);
            crate::journal::hold_sync_worker_for_test(&session_root);
            for gen in 11..=19u64 {
                let bytes = format!("w3-frame-pixels-{gen:02}").into_bytes();
                let frame_path = shm.0.join(format!("f-{gen}.rgb"));
                fs::write(&frame_path, &bytes).unwrap();
                fs::set_permissions(&frame_path, fs::Permissions::from_mode(0o600)).unwrap();
                let mut frame: Value = serde_json::from_str(include_str!(
                    "../../../contracts/examples/v0.2/frame_ref.valid.json"
                ))
                .unwrap();
                frame["width"] = 6.into();
                frame["height"] = 1.into();
                frame["generation"] = gen.into();
                frame["ramws_path"] = frame_path.to_str().unwrap().into();
                frame["sha256"] = sha256_hex(&bytes).into();
                f.route(Component::Daemon, gen, frame).await.unwrap();
                if gen == 18 {
                    std::thread::sleep(Duration::from_millis(55));
                }
            }
            std::thread::sleep(Duration::from_millis(55));
            assert!(session_root.join("checkpoint.next").exists());
            let cp_before_drop: Value =
                serde_json::from_slice(&fs::read(session_root.join("checkpoint.json")).unwrap())
                    .unwrap();
            assert_eq!(cp_before_drop["count"], 11);

            crate::journal::release_test_sync_hold(&session_root);
            let mut dummy_cfg = f.server.config.clone();
            dummy_cfg.session_id = "unused-drop".into();
            let dummy_server = Server::open(
                dummy_cfg,
                &f.root.join("unused-drop"),
                effective_uid().unwrap(),
            )
            .unwrap();
            let dropped_server = std::mem::replace(&mut f.server, dummy_server);
            drop(dropped_server);
            assert!(
                !session_root.join("checkpoint.next").exists(),
                "Server::drop must flush and promote checkpoint.next before Fixture::drop removes session dir"
            );
            let cp_after_drop: Value =
                serde_json::from_slice(&fs::read(session_root.join("checkpoint.json")).unwrap())
                    .unwrap();
            assert_eq!(cp_after_drop["count"], 20);
        });
    }
    #[test]
    fn r3_t1_16_superseded_frame_checks_clock_ceiling_before_replay_record() {
        run(async {
            use std::os::unix::fs::PermissionsExt;
            let mut f = Fixture::new();
            f.seed();
            let _ui = f.attach(Component::Ui, 8);
            let _daemon = f.attach(Component::Daemon, 8);
            let shm = ShmFixture::new();
            let p2 = shm.0.join("f2.rgb");
            let p3 = shm.0.join("f3.rgb");
            fs::write(&p2, b"rgb").unwrap();
            fs::write(&p3, b"BGR").unwrap();
            fs::set_permissions(&p2, fs::Permissions::from_mode(0o600)).unwrap();
            fs::set_permissions(&p3, fs::Permissions::from_mode(0o600)).unwrap();

            let make_frame = |gen: u64, path: &Path, bytes: &[u8]| -> Value {
                let mut frame: Value = serde_json::from_str(include_str!(
                    "../../../contracts/examples/v0.2/frame_ref.valid.json"
                ))
                .unwrap();
                frame["width"] = 1.into();
                frame["height"] = 1.into();
                frame["generation"] = gen.into();
                frame["ramws_path"] = path.to_str().unwrap().into();
                frame["sha256"] = sha256_hex(bytes).into();
                frame
            };
            let env2 = f.envelope(Component::Daemon, 2, make_frame(2, &p2, b"rgb"));
            let env3 = f.envelope(Component::Daemon, 3, make_frame(3, &p3, b"BGR"));

            let reg = f
                .server
                .config
                .peers
                .iter()
                .find(|r| r.endpoint.component == Component::Daemon)
                .unwrap()
                .clone();
            let policy = HandshakePolicy::new(
                effective_uid().unwrap(),
                reg.endpoint.clone(),
                f.server.config.core.endpoint.clone(),
                "nv-session".into(),
                reg.hello.clone(),
            )
            .unwrap();
            let hello = f.envelope(
                Component::Daemon,
                1,
                serde_json::to_value(&reg.hello).unwrap(),
            );
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

            // At/above the clock ceiling, skipping a superseded frame in route_daemon_batch
            // must fail with ClockCeilingError before recording replay state.
            f.server.origin = Instant::now();
            f.server.clock_offset = Duration::from_nanos(MAX_WIRE_INTEGER);
            let before_state = f.server.snapshot().unwrap();
            let frame2: FrameRef = serde_json::from_value(make_frame(2, &p2, b"rgb")).unwrap();
            let err = f
                .server
                .skip_superseded_frame(&peer, 1, &env2, &frame2)
                .unwrap_err();
            assert!(
                err.downcast_ref::<ClockCeilingError>().is_some(),
                "skip_superseded_frame at ceiling must fail with ClockCeilingError: {err}"
            );
            assert_eq!(
                f.server.snapshot().unwrap(),
                before_state,
                "replay state must remain untouched when clock ceiling refuses superseded frame"
            );

            // Negative control: once the clock is below the ceiling, the same seq=2
            // envelope was not burned in replay and can be superseded cleanly by seq=3.
            f.server.origin = Instant::now();
            f.server.clock_offset = Duration::ZERO;
            let skipped = f
                .server
                .skip_superseded_frame(&peer, 1, &env2, &frame2)
                .unwrap();
            assert!(skipped);
            f.server.route(&peer, 1, env3).unwrap();
            assert_eq!(
                f.server.authority.state().surfaces["surface-demo"]
                    .frame
                    .as_ref()
                    .unwrap()
                    .generation,
                3
            );
        });
    }
    #[test]
    fn r3_t1_17_can_supersede_frame_rejects_symlink_parent_and_batch_retires_daemon() {
        run(async {
            use std::os::unix::fs::PermissionsExt;
            let mut f = Fixture::new();
            f.seed();
            let _ui = f.attach(Component::Ui, 8);
            let _daemon = f.attach(Component::Daemon, 8);
            let shm = ShmFixture::new();
            let real_dir = shm.0.join("real");
            fs::create_dir(&real_dir).unwrap();
            let symlink_dir = shm.0.join("symlink-parent");
            std::os::unix::fs::symlink(&real_dir, &symlink_dir).unwrap();

            let p2_target = real_dir.join("f2.rgb");
            let p2_via_symlink = symlink_dir.join("f2.rgb");
            let p3_legit = real_dir.join("f3.rgb");
            fs::write(&p2_target, b"rgb").unwrap();
            fs::write(&p3_legit, b"BGR").unwrap();
            fs::set_permissions(&p2_target, fs::Permissions::from_mode(0o600)).unwrap();
            fs::set_permissions(&p3_legit, fs::Permissions::from_mode(0o600)).unwrap();

            let make_frame = |gen: u64, path: &Path, bytes: &[u8]| -> Value {
                let mut frame: Value = serde_json::from_str(include_str!(
                    "../../../contracts/examples/v0.2/frame_ref.valid.json"
                ))
                .unwrap();
                frame["width"] = 1.into();
                frame["height"] = 1.into();
                frame["generation"] = gen.into();
                frame["ramws_path"] = path.to_str().unwrap().into();
                frame["sha256"] = sha256_hex(bytes).into();
                frame
            };
            let frame2_bad: FrameRef =
                serde_json::from_value(make_frame(2, &p2_via_symlink, b"rgb")).unwrap();
            let frame3_ok: FrameRef =
                serde_json::from_value(make_frame(3, &p3_legit, b"BGR")).unwrap();
            assert!(
                !f.server.can_supersede_frame(1, &frame2_bad),
                "can_supersede_frame must reject a frame whose parent directory is a symlink"
            );
            assert!(
                f.server.can_supersede_frame(1, &frame3_ok),
                "negative control: legitimate anchored shm directory must be accepted"
            );

            let reg = f
                .server
                .config
                .peers
                .iter()
                .find(|r| r.endpoint.component == Component::Daemon)
                .unwrap()
                .clone();
            let policy = HandshakePolicy::new(
                effective_uid().unwrap(),
                reg.endpoint.clone(),
                f.server.config.core.endpoint.clone(),
                "nv-session".into(),
                reg.hello.clone(),
            )
            .unwrap();
            let hello = f.envelope(
                Component::Daemon,
                1,
                serde_json::to_value(&reg.hello).unwrap(),
            );
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

            let env2_bad = f.envelope(Component::Daemon, 2, make_frame(2, &p2_via_symlink, b"rgb"));
            let env3_ok = f.envelope(Component::Daemon, 3, make_frame(3, &p3_legit, b"BGR"));
            assert!(
                !f.server
                    .skip_superseded_frame(&peer, 1, &env2_bad, &frame2_bad)
                    .unwrap(),
                "skip_superseded_frame must refuse symlink-parent shm path"
            );
            assert!(
                f.server.route(&peer, 1, env2_bad).is_err(),
                "routing symlink-parent frame must fail anchored check and retire daemon"
            );
            assert_eq!(
                f.server.authority.state().surfaces["surface-demo"]
                    .frame
                    .as_ref()
                    .unwrap()
                    .generation,
                1,
                "failed frame must not commit"
            );
            assert!(
                f.server
                    .skip_superseded_frame(&peer, 1, &env3_ok, &frame3_ok)
                    .unwrap(),
                "negative control: legitimate frame passes skip_superseded_frame"
            );
        });
    }

    fn prepare_legacy_destroy_fixture(f: &mut Fixture) -> (Config, PathBuf, PathBuf, Vec<u8>) {
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
        fs::write(&path, &journal).unwrap();
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
        (config, root, path, journal)
    }

    #[test]
    fn r4_legacy_destroy_corrupt_variant_reaches_upgrade_required_gate() {
        let mut f = Fixture::new();
        let (config, root, path, _journal) = prepare_legacy_destroy_fixture(&mut f);
        assert_eq!(
            Authority::recover(&path, &root).err(),
            Some(crate::journal::JournalError::Corrupt)
        );
        let Err(err) = Server::open(config, &f.root, effective_uid().unwrap()) else {
            panic!("expected UPGRADE-REQUIRED error");
        };
        assert!(err.to_string().contains("UPGRADE-REQUIRED"), "got: {err}");
    }

    #[test]
    fn r4_legacy_destroy_empty_variant_reaches_upgrade_required_gate() {
        let mut f = Fixture::new();
        let (config, root, path, _journal) = prepare_legacy_destroy_fixture(&mut f);
        fs::write(&path, b"").unwrap();
        assert_eq!(
            Authority::recover(&path, &root).err(),
            Some(crate::journal::JournalError::Empty)
        );
        let Err(err) = Server::open(config, &f.root, effective_uid().unwrap()) else {
            panic!("expected UPGRADE-REQUIRED error");
        };
        assert!(err.to_string().contains("UPGRADE-REQUIRED"), "got: {err}");
    }

    #[test]
    fn r4_legacy_destroy_blank_variant_reaches_upgrade_required_gate() {
        let mut f = Fixture::new();
        let (config, root, path, journal) = prepare_legacy_destroy_fixture(&mut f);
        let first_nl = journal.iter().position(|&b| b == b'\n').unwrap();
        let mut blank_after_header = journal[..=first_nl].to_vec();
        blank_after_header.push(b'\n');
        fs::write(&path, &blank_after_header).unwrap();
        assert_eq!(
            Authority::recover(&path, &root).err(),
            Some(crate::journal::JournalError::Blank)
        );
        let Err(err) = Server::open(config, &f.root, effective_uid().unwrap()) else {
            panic!("expected UPGRADE-REQUIRED error");
        };
        assert!(err.to_string().contains("UPGRADE-REQUIRED"), "got: {err}");
    }

    #[test]
    fn r4_legacy_destroy_utf8_bom_variant_reaches_upgrade_required_gate() {
        let mut f = Fixture::new();
        let (config, root, path, journal) = prepare_legacy_destroy_fixture(&mut f);
        let mut with_bom = b"\xEF\xBB\xBF".to_vec();
        with_bom.extend_from_slice(&journal);
        fs::write(&path, &with_bom).unwrap();
        assert_eq!(
            Authority::recover(&path, &root).err(),
            Some(crate::journal::JournalError::Utf8Bom)
        );
        let Err(err) = Server::open(config, &f.root, effective_uid().unwrap()) else {
            panic!("expected UPGRADE-REQUIRED error");
        };
        assert!(err.to_string().contains("UPGRADE-REQUIRED"), "got: {err}");
    }

    #[test]
    fn r4_legacy_destroy_missing_lf_variant_reaches_upgrade_required_gate() {
        let mut f = Fixture::new();
        let (config, root, path, journal) = prepare_legacy_destroy_fixture(&mut f);
        let first_nl = journal.iter().position(|&b| b == b'\n').unwrap();
        fs::write(&path, &journal[..first_nl]).unwrap();
        assert_eq!(
            Authority::recover(&path, &root).err(),
            Some(crate::journal::JournalError::MissingLf)
        );
        let Err(err) = Server::open(config, &f.root, effective_uid().unwrap()) else {
            panic!("expected UPGRADE-REQUIRED error");
        };
        assert!(err.to_string().contains("UPGRADE-REQUIRED"), "got: {err}");
    }

    #[test]
    fn r4_legacy_destroy_oversize_variant_reaches_upgrade_required_gate() {
        let mut f = Fixture::new();
        let (config, root, path, _journal) = prepare_legacy_destroy_fixture(&mut f);
        let mut oversize = vec![b'x'; MAX_FRAME_BYTES + 16];
        oversize.push(b'\n');
        fs::write(&path, &oversize).unwrap();
        assert_eq!(
            Authority::recover(&path, &root).err(),
            Some(crate::journal::JournalError::Oversize)
        );
        let Err(err) = Server::open(config, &f.root, effective_uid().unwrap()) else {
            panic!("expected UPGRADE-REQUIRED error");
        };
        assert!(err.to_string().contains("UPGRADE-REQUIRED"), "got: {err}");
    }

    #[test]
    fn r4_legacy_destroy_unsealed_variant_reaches_upgrade_required_gate() {
        let mut f = Fixture::new();
        let (config, root, path, journal) = prepare_legacy_destroy_fixture(&mut f);
        // Keep only the header + first 2 valid pre-destroy records in journal.jsonl while
        // events/3.json (the pre-tombstone Destroyed sidecar) and checkpoint.json (count=4)
        // remain on disk: scan replays 1..=2 cleanly and fails at the events/ directory check
        // with Unsealed, and rollback fails because journal.jsonl has < 4 records.
        let prefix: String = String::from_utf8(journal)
            .unwrap()
            .lines()
            .take(3)
            .map(|l| format!("{l}\n"))
            .collect();
        fs::write(&path, prefix.as_bytes()).unwrap();
        assert_eq!(
            Authority::recover(&path, &root).err(),
            Some(crate::journal::JournalError::Unsealed)
        );
        let Err(err) = Server::open(config, &f.root, effective_uid().unwrap()) else {
            panic!("expected UPGRADE-REQUIRED error");
        };
        assert!(err.to_string().contains("UPGRADE-REQUIRED"), "got: {err}");
    }

    #[test]
    fn rv11_02_saturated_daemon_queue_refuses_human_input_before_commit() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let ui = f.attach(Component::Ui, 16);
            let daemon = f.attach(Component::Daemon, 1);
            f.route(
                Component::Ui,
                2,
                serde_json::json!({
                    "schema": "ui_intent/v0.2",
                    "request_id": "rv11-02-take",
                    "op": "take_control",
                    "params": { "surface_id": "surface-demo" }
                }),
            )
            .await
            .unwrap();
            // Daemon capacity is 1 and now holds the forwarded take_control request (saturated).
            f.route(
                Component::Ui,
                3,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-saturated-1",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["Return"] }
                    }
                }),
            )
            .await
            .unwrap();

            let verdict = serde_json::to_value(ui.try_recv().unwrap().body).unwrap();
            assert_eq!(verdict["schema"], "action_verdict/v0.2");
            assert_eq!(verdict["proposal_id"], "hi-saturated-1");
            assert_eq!(verdict["decision"], "refused");
            assert_eq!(verdict["reason_code"], "POLICY");
            assert!(f.server.human_inputs.is_empty());

            // Verify no HumanInput event was journalled and recovery does not resurrect hi-saturated-1.
            let seq = f.server.authority.state().core_seq;
            let last_ev: Value = serde_json::from_slice(
                &fs::read(f.server.root.join(format!("events/{seq}.json"))).unwrap(),
            )
            .unwrap();
            assert_ne!(
                last_ev["input"]["event"], "HumanInput",
                "saturated daemon queue must not commit a HumanInput event"
            );

            // Negative control: draining one slot from daemon queue admits the next human input.
            let _ = daemon.try_recv().unwrap();
            f.route(
                Component::Ui,
                4,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-free-slot-1",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["Return"] }
                    }
                }),
            )
            .await
            .unwrap();
            assert!(f.server.human_inputs.contains_key("hi-free-slot-1"));
            let _ = daemon.try_recv().unwrap();

            let cfg = f.server.config.clone();
            let mut dummy_cfg = cfg.clone();
            dummy_cfg.session_id = "unused-rv11-02".into();
            let dummy =
                Server::open(dummy_cfg, &f.root.join("unused"), effective_uid().unwrap()).unwrap();
            let old = std::mem::replace(&mut f.server, dummy);
            drop(old);
            let recovered = Server::open(cfg, &f.root, effective_uid().unwrap()).unwrap();
            assert!(!recovered.human_inputs.contains_key("hi-saturated-1"));
            assert!(recovered.human_inputs.contains_key("hi-free-slot-1"));
        });
    }

    #[test]
    fn rv11_03_lookahead_verifies_superseding_pixels_and_breaks_on_invalid_intermediate() {
        run(async {
            use std::os::unix::fs::PermissionsExt;
            let mut f = Fixture::new();
            f.seed();
            let shm = ShmFixture::new();

            let p33 = shm.0.join("f33.rgb");
            let p34_bad_sha = shm.0.join("f34-bad-sha.rgb");
            let p34_oversize = shm.0.join("f34-oversize.rgb");
            let p35_ok = shm.0.join("f35-ok.rgb");

            let bytes33 = vec![0x11_u8; 300];
            let bytes35 = vec![0x33_u8; 300];
            fs::write(&p33, &bytes33).unwrap();
            fs::write(&p34_bad_sha, vec![0xff_u8; 300]).unwrap();
            fs::write(&p35_ok, &bytes35).unwrap();
            {
                use std::os::unix::fs::OpenOptionsExt;
                let file = fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&p34_oversize)
                    .unwrap();
                file.set_len(65 * 1024 * 1024).unwrap();
            }
            for p in [&p33, &p34_bad_sha, &p35_ok] {
                fs::set_permissions(p, fs::Permissions::from_mode(0o600)).unwrap();
            }

            let make_frame_ev = |gen: u64, path: &Path, sha: String| -> Value {
                let mut frame: Value = serde_json::from_str(include_str!(
                    "../../../contracts/examples/v0.2/frame_ref.valid.json"
                ))
                .unwrap();
                frame["width"] = 10.into();
                frame["height"] = 10.into();
                frame["generation"] = gen.into();
                frame["ramws_path"] = path.to_str().unwrap().into();
                frame["sha256"] = sha.into();
                serde_json::json!({
                    "schema": "surface_event/v0.2",
                    "event": "frame_ready",
                    "data": { "frame_ref": frame }
                })
            };

            let reg = f
                .server
                .config
                .peers
                .iter()
                .find(|r| r.endpoint.component == Component::Daemon)
                .unwrap()
                .clone();
            let policy = HandshakePolicy::new(
                effective_uid().unwrap(),
                reg.endpoint.clone(),
                f.server.config.core.endpoint.clone(),
                "nv-session".into(),
                reg.hello.clone(),
            )
            .unwrap();
            let hello = f.envelope(
                Component::Daemon,
                1,
                serde_json::to_value(&reg.hello).unwrap(),
            );
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

            let _daemon = f.attach(Component::Daemon, 16);
            let batch_a = vec![
                f.envelope(
                    Component::Daemon,
                    2,
                    make_frame_ev(33, &p33, sha256_hex(&bytes33)),
                ),
                f.envelope(
                    Component::Daemon,
                    3,
                    make_frame_ev(34, &p34_bad_sha, sha256_hex(b"wrong-sha")),
                ),
            ];
            let batch_b = vec![
                f.envelope(
                    Component::Daemon,
                    4,
                    make_frame_ev(35, &p35_ok, sha256_hex(&bytes35)),
                ),
                f.envelope(
                    Component::Daemon,
                    5,
                    make_frame_ev(36, &p34_oversize, sha256_hex(&bytes35)),
                ),
                f.envelope(
                    Component::Daemon,
                    6,
                    make_frame_ev(37, &p35_ok, sha256_hex(&bytes35)),
                ),
            ];
            let batch_c = vec![
                f.envelope(
                    Component::Daemon,
                    7,
                    make_frame_ev(38, &p33, sha256_hex(&bytes33)),
                ),
                f.envelope(
                    Component::Daemon,
                    8,
                    make_frame_ev(39, &p35_ok, sha256_hex(&bytes35)),
                ),
            ];
            let mut dummy_cfg = f.server.config.clone();
            dummy_cfg.session_id = "unused-rv11-03".into();
            let dummy =
                Server::open(dummy_cfg, &f.root.join("unused"), effective_uid().unwrap()).unwrap();
            let srv = Arc::new(Mutex::new(std::mem::replace(&mut f.server, dummy)));

            // (a) [f33 valid, f34 valid-metadata but mismatched sha]: f33 must commit before f34 fails.
            assert!(Server::route_daemon_batch(&srv, &peer, 1, 1, batch_a)
                .await
                .is_err());
            assert_eq!(
                srv.lock().unwrap().authority.state().surfaces["surface-demo"]
                    .frame
                    .as_ref()
                    .unwrap()
                    .generation,
                33,
                "mismatched-sha successor f34 must not cause valid predecessor f33 to be skipped"
            );

            // (b) Trio [f35 valid, f36 65MiB oversize intermediate, f37 valid]: f35 must commit.
            assert!(Server::route_daemon_batch(&srv, &peer, 1, 1, batch_b)
                .await
                .is_err());
            assert_eq!(
                srv.lock().unwrap().authority.state().surfaces["surface-demo"]
                    .frame
                    .as_ref()
                    .unwrap()
                    .generation,
                35,
                "oversize intermediate f36 must break lookahead so valid f35 commits"
            );

            // (c) Negative control: [f38 valid, f39 valid] coalesces to f39.
            assert!(Server::route_daemon_batch(&srv, &peer, 1, 1, batch_c)
                .await
                .unwrap());
            assert_eq!(
                srv.lock().unwrap().authority.state().surfaces["surface-demo"]
                    .frame
                    .as_ref()
                    .unwrap()
                    .generation,
                39
            );
            f.server = Arc::try_unwrap(srv).ok().unwrap().into_inner().unwrap();
        });
    }

    #[test]
    fn rv11_04_human_inputs_expire_on_retire_destroy_and_release_control() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let ui = f.attach(Component::Ui, 16);
            let daemon = f.attach(Component::Daemon, 16);
            f.route(
                Component::Ui,
                2,
                serde_json::json!({
                    "schema": "ui_intent/v0.2",
                    "request_id": "rv11-04-take-1",
                    "op": "take_control",
                    "params": { "surface_id": "surface-demo" }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();

            // 1. Admit hi-1, then release_control + take_control, admit hi-2, emit Case4("input failed: ..."):
            // failure must route to hi-2, not stale hi-1.
            f.route(
                Component::Ui,
                3,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-1",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["a"] }
                    }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();
            assert!(f.server.human_inputs.contains_key("hi-1"));

            f.route(
                Component::Ui,
                4,
                serde_json::json!({
                    "schema": "ui_intent/v0.2",
                    "request_id": "rv11-04-release-1",
                    "op": "release_control",
                    "params": { "surface_id": "surface-demo" }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();
            assert!(
                f.server.human_inputs["hi-1"].case4_expired,
                "release_control must mark pending human_inputs case4_expired while keeping the receipt fence"
            );

            f.route(
                Component::Ui,
                5,
                serde_json::json!({
                    "schema": "ui_intent/v0.2",
                    "request_id": "rv11-04-take-2",
                    "op": "take_control",
                    "params": { "surface_id": "surface-demo" }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();

            f.route(
                Component::Ui,
                6,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-2",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["b"] }
                    }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();

            f.route(
                Component::Daemon,
                2,
                serde_json::json!({
                    "schema": "surface_event/v0.2",
                    "event": "error",
                    "data": {
                        "surface_id": "surface-demo",
                        "code": "unsupported",
                        "detail": "input failed: unsupported: input action"
                    }
                }),
            )
            .await
            .unwrap();
            let _ = ui.try_recv().unwrap(); // surface_event error fanout
            let verdict = serde_json::to_value(ui.try_recv().unwrap().body).unwrap();
            assert_eq!(verdict["schema"], "action_verdict/v0.2");
            assert_eq!(verdict["proposal_id"], "hi-2");

            let frame_ref: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            f.route(
                Component::Daemon,
                3,
                serde_json::json!({
                    "schema": "action_receipt/v0.2",
                    "proposal_id": "hi-1",
                    "executed_at_ns": 1500,
                    "after_frame": frame_ref,
                    "verified": false,
                    "verification": { "method": "pixel", "detail": "ok" },
                    "error": ""
                }),
            )
            .await
            .unwrap();
            let hi1_verdict = serde_json::to_value(ui.try_recv().unwrap().body).unwrap();
            assert_eq!(hi1_verdict["proposal_id"], "hi-1");
            assert_eq!(hi1_verdict["decision"], "admitted");
            assert!(f.server.human_inputs.is_empty());

            // 2. Retire daemon settles pending human_inputs with Policy verdict; surface destroy clears pending.
            f.route(
                Component::Ui,
                7,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-retire-1",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["c"] }
                    }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();
            let daemon_ep = f
                .server
                .config
                .peers
                .iter()
                .find(|p| p.endpoint.component == Component::Daemon)
                .unwrap()
                .endpoint
                .clone();
            let daemon_conn_id = f.server.connections[&daemon_ep].id;
            f.server.retire(&daemon_ep, daemon_conn_id);
            assert!(f.server.human_inputs.is_empty());
            let retire_verdict = serde_json::to_value(ui.try_recv().unwrap().body).unwrap();
            assert_eq!(retire_verdict["proposal_id"], "hi-retire-1");
            assert_eq!(retire_verdict["decision"], "refused");
            assert_eq!(retire_verdict["reason_code"], "POLICY");

            let _daemon = f.attach(Component::Daemon, 16);
            f.route(
                Component::Ui,
                8,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-destroy-1",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["d"] }
                    }
                }),
            )
            .await
            .unwrap();
            f.route(
                Component::Ui,
                9,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "destroy",
                    "params": { "surface_id": "surface-demo" }
                }),
            )
            .await
            .unwrap();
            assert!(f.server.human_inputs.is_empty());
            f.route(
                Component::Daemon,
                4,
                serde_json::json!({
                    "schema": "surface_event/v0.2",
                    "event": "error",
                    "data": {
                        "surface_id": "surface-demo",
                        "code": "unsupported",
                        "detail": "input failed: post-destroy"
                    }
                }),
            )
            .await
            .unwrap();
            let _ = ui.try_recv().unwrap(); // surface_event error fanout
            assert!(
                ui.try_recv().is_err(),
                "post-destroy Case4 failure must not emit a stale verdict"
            );
        });
    }

    #[test]
    fn rv11_05_refused_human_input_receipt_does_not_retain_in_tool_state() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let _ui = f.attach(Component::Ui, 16);
            let _daemon = f.attach(Component::Daemon, 16);
            f.route(
                Component::Ui,
                2,
                serde_json::json!({
                    "schema": "ui_intent/v0.2",
                    "request_id": "rv11-05-take",
                    "op": "take_control",
                    "params": { "surface_id": "surface-demo" }
                }),
            )
            .await
            .unwrap();
            f.route(
                Component::Ui,
                3,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-refused-rcpt",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["a"] }
                    }
                }),
            )
            .await
            .unwrap();
            f.route(
                Component::Ui,
                4,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-admitted-rcpt",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["b"] }
                    }
                }),
            )
            .await
            .unwrap();

            let frame_ref: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            f.route(
                Component::Daemon,
                2,
                serde_json::json!({
                    "schema": "action_receipt/v0.2",
                    "proposal_id": "hi-refused-rcpt",
                    "executed_at_ns": 1000,
                    "after_frame": frame_ref,
                    "verified": false,
                    "verification": { "method": "pixel", "detail": "failed" },
                    "error": "input failed: unsupported: input action"
                }),
            )
            .await
            .unwrap();
            f.route(
                Component::Daemon,
                3,
                serde_json::json!({
                    "schema": "action_receipt/v0.2",
                    "proposal_id": "hi-admitted-rcpt",
                    "executed_at_ns": 2000,
                    "after_frame": frame_ref,
                    "verified": false,
                    "verification": { "method": "pixel", "detail": "ok" },
                    "error": ""
                }),
            )
            .await
            .unwrap();

            let agent = f.attach(Component::Agent, 16);
            f.route(
                Component::Agent,
                2,
                serde_json::json!({
                    "schema": "mv_tool_call/v0.2",
                    "request_id": "req-wait-1",
                    "op": "wait_verify",
                    "args": { "proposal_id": "hi-refused-rcpt", "timeout_ms": 10 }
                }),
            )
            .await
            .unwrap();
            let res_refused = serde_json::to_value(agent.try_recv().unwrap().body).unwrap();
            assert_eq!(
                res_refused["code"], "NOT_FOUND",
                "refused human-input receipt must not be retained in live tool_state"
            );

            f.route(
                Component::Agent,
                3,
                serde_json::json!({
                    "schema": "mv_tool_call/v0.2",
                    "request_id": "req-wait-2",
                    "op": "wait_verify",
                    "args": { "proposal_id": "hi-admitted-rcpt", "timeout_ms": 10 }
                }),
            )
            .await
            .unwrap();
            let res_admitted = serde_json::to_value(agent.try_recv().unwrap().body).unwrap();
            assert_eq!(
                res_admitted["code"], "VERIFICATION_FAILED",
                "negative control: admitted human-input receipt must still be retained in tool_state"
            );

            let cfg = f.server.config.clone();
            let mut dummy_cfg = cfg.clone();
            dummy_cfg.session_id = "unused-rv11-05".into();
            let dummy =
                Server::open(dummy_cfg, &f.root.join("unused"), effective_uid().unwrap()).unwrap();
            let old = std::mem::replace(&mut f.server, dummy);
            drop(old);
            f.server = Server::open(cfg, &f.root, effective_uid().unwrap()).unwrap();
            let agent_rec = f.attach(Component::Agent, 16);
            f.route(
                Component::Agent,
                4,
                serde_json::json!({
                    "schema": "mv_tool_call/v0.2",
                    "request_id": "req-wait-3",
                    "op": "wait_verify",
                    "args": { "proposal_id": "hi-refused-rcpt", "timeout_ms": 10 }
                }),
            )
            .await
            .unwrap();
            let rec_refused = serde_json::to_value(agent_rec.try_recv().unwrap().body).unwrap();
            assert_eq!(rec_refused["code"], "NOT_FOUND");
            f.route(
                Component::Agent,
                5,
                serde_json::json!({
                    "schema": "mv_tool_call/v0.2",
                    "request_id": "req-wait-4",
                    "op": "wait_verify",
                    "args": { "proposal_id": "hi-admitted-rcpt", "timeout_ms": 10 }
                }),
            )
            .await
            .unwrap();
            let rec_admitted = serde_json::to_value(agent_rec.try_recv().unwrap().body).unwrap();
            assert_eq!(rec_admitted["code"], "VERIFICATION_FAILED");
        });
    }

    #[test]
    fn rv11_07_read_shm_pixels_under_honours_custom_shm_root() {
        use std::os::unix::fs::PermissionsExt;
        let custom_root = std::env::temp_dir().join(format!(
            "mv-rv11-07-shm-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&custom_root);
        fs::create_dir_all(&custom_root).unwrap();
        fs::set_permissions(&custom_root, fs::Permissions::from_mode(0o700)).unwrap();

        let pixels = b"RGB";
        let leaf = custom_root.join("frame.rgb");
        fs::write(&leaf, pixels).unwrap();
        fs::set_permissions(&leaf, fs::Permissions::from_mode(0o600)).unwrap();

        let mut frame: FrameRef = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        frame.width = 1;
        frame.height = 1;
        frame.sha256 = sha256_hex(pixels);
        frame.ramws_path = leaf.to_str().unwrap().into();

        let verified = Server::read_shm_pixels_under(&custom_root, &frame).unwrap();
        assert_eq!(verified.into_bytes(), pixels);

        // Negative controls: shm_root itself and ParentDir traversal are rejected.
        frame.ramws_path = custom_root.to_str().unwrap().into();
        assert!(Server::read_shm_pixels_under(&custom_root, &frame).is_err());
        frame.ramws_path = custom_root.join("../frame.rgb").to_str().unwrap().into();
        assert!(Server::read_shm_pixels_under(&custom_root, &frame).is_err());

        let _ = fs::remove_dir_all(&custom_root);
    }

    #[test]
    fn r5_d1_release_control_preserves_receipt_fence_and_matches_crash_recovery() {
        run(async {
            let run_variant = |crash_after_release: bool| async move {
                let mut f = Fixture::new();
                f.seed();
                let mut ui = f.attach(Component::Ui, 16);
                let mut daemon = f.attach(Component::Daemon, 16);
                let mut agent = f.attach(Component::Agent, 16);
                f.route(
                    Component::Ui,
                    2,
                    serde_json::json!({
                        "schema": "ui_intent/v0.2",
                        "request_id": "r5-d1-take",
                        "op": "take_control",
                        "params": { "surface_id": "surface-demo" }
                    }),
                )
                .await
                .unwrap();
                let _ = daemon.try_recv().unwrap();

                f.route(
                    Component::Ui,
                    3,
                    serde_json::json!({
                        "schema": "surface_request/v0.2",
                        "op": "input",
                        "params": {
                            "surface_id": "surface-demo",
                            "proposal_id": "hi-d1-1",
                            "origin": "human",
                            "action": { "type": "key", "keys": ["a"] }
                        }
                    }),
                )
                .await
                .unwrap();
                let _ = daemon.try_recv().unwrap();

                f.route(
                    Component::Ui,
                    4,
                    serde_json::json!({
                        "schema": "ui_intent/v0.2",
                        "request_id": "r5-d1-release",
                        "op": "release_control",
                        "params": { "surface_id": "surface-demo" }
                    }),
                )
                .await
                .unwrap();
                let _ = daemon.try_recv().unwrap();

                if crash_after_release {
                    let cfg = f.server.config.clone();
                    let mut dummy_cfg = cfg.clone();
                    dummy_cfg.session_id = "unused-r5-d1".into();
                    let dummy =
                        Server::open(dummy_cfg, &f.root.join("unused"), effective_uid().unwrap())
                            .unwrap();
                    let old = std::mem::replace(&mut f.server, dummy);
                    drop(old);
                    f.server = Server::open(cfg, &f.root, effective_uid().unwrap()).unwrap();
                    ui = f.attach(Component::Ui, 16);
                    daemon = f.attach(Component::Daemon, 16);
                    agent = f.attach(Component::Agent, 16);
                }

                let fence_mid = f.server.human_inputs.clone();
                assert!(fence_mid.contains_key("hi-d1-1"));
                assert!(fence_mid["hi-d1-1"].case4_expired);

                let frame_ref: Value = serde_json::from_str(include_str!(
                    "../../../contracts/examples/v0.2/frame_ref.valid.json"
                ))
                .unwrap();
                f.route(
                    Component::Daemon,
                    2,
                    serde_json::json!({
                        "schema": "action_receipt/v0.2",
                        "proposal_id": "hi-d1-1",
                        "executed_at_ns": 2000,
                        "after_frame": frame_ref,
                        "verified": false,
                        "verification": { "method": "pixel", "detail": "ok" },
                        "error": ""
                    }),
                )
                .await
                .unwrap();
                let verdict = serde_json::to_value(ui.try_recv().unwrap().body).unwrap();
                assert_eq!(verdict["schema"], "action_verdict/v0.2");
                assert_eq!(verdict["proposal_id"], "hi-d1-1");
                assert_eq!(verdict["decision"], "admitted");
                assert!(
                    agent.try_recv().is_err(),
                    "human input receipt after release_control must not misroute to agent"
                );
                assert!(f.server.human_inputs.is_empty());
                let _ = daemon;
                (
                    fence_mid,
                    verdict,
                    f.server.human_inputs.clone(),
                    f.server.snapshot().unwrap(),
                )
            };

            let (live_mid, live_verdict, live_end, live_snap) = run_variant(false).await;
            let (rec_mid, rec_verdict, rec_end, rec_snap) = run_variant(true).await;
            assert_eq!(live_mid, rec_mid);
            assert_eq!(live_verdict, rec_verdict);
            assert_eq!(live_end, rec_end);
            assert_eq!(live_snap, rec_snap);
        });
    }

    #[test]
    fn r5_d2_retire_settlement_is_journaled_and_never_resurrects_on_crash_recovery() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let ui = f.attach(Component::Ui, 16);
            let daemon = f.attach(Component::Daemon, 16);
            f.route(
                Component::Ui,
                2,
                serde_json::json!({
                    "schema": "ui_intent/v0.2",
                    "request_id": "r5-d2-take",
                    "op": "take_control",
                    "params": { "surface_id": "surface-demo" }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();

            f.route(
                Component::Ui,
                3,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-d2-daemon-retire",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["a"] }
                    }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();

            let daemon_ep = f
                .server
                .config
                .peers
                .iter()
                .find(|p| p.endpoint.component == Component::Daemon)
                .unwrap()
                .endpoint
                .clone();
            let daemon_conn_id = f.server.connections[&daemon_ep].id;
            let seq_before_retire = f.server.authority.state().core_seq;
            f.server.retire(&daemon_ep, daemon_conn_id);
            let seq_after_retire = f.server.authority.state().core_seq;
            assert_eq!(
                seq_after_retire,
                seq_before_retire + 1,
                "daemon retire must journal the refusal settlement before emitting verdict"
            );
            let v1 = serde_json::to_value(ui.try_recv().unwrap().body).unwrap();
            assert_eq!(v1["proposal_id"], "hi-d2-daemon-retire");
            assert_eq!(v1["decision"], "refused");
            assert_eq!(v1["reason_code"], "POLICY");
            assert_eq!(v1["core_seq"], seq_after_retire);

            // Crash + reopen after daemon retire: hi-d2-daemon-retire must not resurrect.
            let cfg = f.server.config.clone();
            let mut dummy_cfg = cfg.clone();
            dummy_cfg.session_id = "unused-r5-d2-a".into();
            let dummy = Server::open(
                dummy_cfg,
                &f.root.join("unused-a"),
                effective_uid().unwrap(),
            )
            .unwrap();
            let old = std::mem::replace(&mut f.server, dummy);
            drop(old);
            f.server = Server::open(cfg.clone(), &f.root, effective_uid().unwrap()).unwrap();
            assert!(
                f.server.human_inputs.is_empty(),
                "recovered server must not resurrect human input settled by daemon retire"
            );

            let ui_rec = f.attach(Component::Ui, 16);
            let _daemon_rec = f.attach(Component::Daemon, 16);
            let daemon_conn_id_2 = f.server.connections[&daemon_ep].id;
            f.server.retire(&daemon_ep, daemon_conn_id_2);
            assert!(
                ui_rec.try_recv().is_err(),
                "second daemon retire after recovery must not emit a duplicate verdict"
            );

            // Also test UI-disconnect drop: admit hi-d2-ui-drop, retire UI, crash+reopen, verify no resurrection.
            let _daemon_rec2 = f.attach(Component::Daemon, 16);
            f.route(
                Component::Ui,
                4,
                serde_json::json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": "surface-demo",
                        "proposal_id": "hi-d2-ui-drop",
                        "origin": "human",
                        "action": { "type": "key", "keys": ["b"] }
                    }
                }),
            )
            .await
            .unwrap();
            assert!(f.server.human_inputs.contains_key("hi-d2-ui-drop"));
            let ui_ep = f
                .server
                .config
                .peers
                .iter()
                .find(|p| p.endpoint.component == Component::Ui)
                .unwrap()
                .endpoint
                .clone();
            let ui_conn_id = f.server.connections[&ui_ep].id;
            f.server.retire(&ui_ep, ui_conn_id);
            assert!(f.server.human_inputs.is_empty());

            let mut dummy_cfg2 = cfg.clone();
            dummy_cfg2.session_id = "unused-r5-d2-b".into();
            let dummy2 = Server::open(
                dummy_cfg2,
                &f.root.join("unused-b"),
                effective_uid().unwrap(),
            )
            .unwrap();
            let old2 = std::mem::replace(&mut f.server, dummy2);
            drop(old2);
            f.server = Server::open(cfg, &f.root, effective_uid().unwrap()).unwrap();
            assert!(
                f.server.human_inputs.is_empty(),
                "recovered server must not resurrect human input dropped on UI disconnect"
            );
            let ui_rec2 = f.attach(Component::Ui, 16);
            let _daemon_rec3 = f.attach(Component::Daemon, 16);
            let daemon_conn_id_3 = f.server.connections[&daemon_ep].id;
            f.server.retire(&daemon_ep, daemon_conn_id_3);
            assert!(ui_rec2.try_recv().is_err());
        });
    }

    #[test]
    fn r5_d3_commit_failure_on_admitted_human_input_forwards_nothing_to_daemon() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let ui = f.attach(Component::Ui, 16);
            let daemon = f.attach(Component::Daemon, 16);
            f.route(
                Component::Ui,
                2,
                serde_json::json!({
                    "schema": "ui_intent/v0.2",
                    "request_id": "r5-d3-take",
                    "op": "take_control",
                    "params": { "surface_id": "surface-demo" }
                }),
            )
            .await
            .unwrap();
            let _ = daemon.try_recv().unwrap();

            // Inject commit failure during the HumanInput append (after boundary witness retain).
            let session_root = f.server.root.clone();
            crate::journal::fail_next_after_journal_sync(&session_root);

            let err = f
                .route(
                    Component::Ui,
                    3,
                    serde_json::json!({
                        "schema": "surface_request/v0.2",
                        "op": "input",
                        "params": {
                            "surface_id": "surface-demo",
                            "proposal_id": "hi-d3-commit-fail",
                            "origin": "human",
                            "action": { "type": "key", "keys": ["a"] }
                        }
                    }),
                )
                .await;
            assert!(
                err.is_err(),
                "commit failure during human_input_at must return Err"
            );
            assert!(
                daemon.try_recv().is_err(),
                "commit failure must forward nothing to daemon"
            );
            assert!(
                ui.try_recv().is_err(),
                "commit failure must not emit an uncommitted verdict"
            );
            assert!(f.server.human_inputs.is_empty());

            // Subsequent attempt on the now-poisoned journal also forwards nothing.
            let err2 = f
                .route(
                    Component::Ui,
                    4,
                    serde_json::json!({
                        "schema": "surface_request/v0.2",
                        "op": "input",
                        "params": {
                            "surface_id": "surface-demo",
                            "proposal_id": "hi-d3-poisoned",
                            "origin": "human",
                            "action": { "type": "key", "keys": ["b"] }
                        }
                    }),
                )
                .await;
            assert!(err2.is_err());
            assert!(daemon.try_recv().is_err());
            assert!(f.server.human_inputs.is_empty());
        });
    }

    #[test]
    fn r5_d4_refused_destroy_on_current_archive_does_not_misreport_upgrade_required() {
        run(async {
            let mut f = Fixture::new();
            f.seed();
            let _ui = f.attach(Component::Ui, 16);
            let daemon = f.attach(Component::Daemon, 16);

            // Daemon sends Case1 Destroyed for unknown surface "ghost" -> refused with Policy,
            // state.destroyed remains empty (so "destroyed" key is absent in events/<seq>.json).
            f.route(
                Component::Daemon,
                2,
                serde_json::json!({
                    "schema": "surface_event/v0.2",
                    "event": "state_changed",
                    "data": {
                        "surface": {
                            "schema": "surface/v0.2",
                            "surface_id": "ghost",
                            "kind": "game_capsule",
                            "display": ":101",
                            "geometry": { "w": 800, "h": 600 },
                            "state": "destroyed",
                            "visibility": "unfolded",
                            "control": "agent",
                            "profile_id": "profile-demo"
                        }
                    }
                }),
            )
            .await
            .unwrap();
            let refusal = serde_json::to_value(daemon.try_recv().unwrap().body).unwrap();
            assert_eq!(refusal["decision"], "refused");
            assert_eq!(refusal["reason_code"], "POLICY");

            let seq = f.server.authority.state().core_seq;
            let ev: Value = serde_json::from_slice(
                &fs::read(f.server.root.join(format!("events/{seq}.json"))).unwrap(),
            )
            .unwrap();
            assert_eq!(ev["input"]["event"], "Lifecycle");
            assert_eq!(ev["input"]["update"]["kind"], "Destroyed");
            assert_eq!(ev["outcome"]["reason"], "POLICY");
            assert!(ev["state"].get("destroyed").is_none());

            let cfg = f.server.config.clone();
            let session_root = f.server.root.clone();
            let journal_path = session_root.join("journal.jsonl");
            let mut dummy_cfg = cfg.clone();
            dummy_cfg.session_id = "unused-r5-d4".into();
            let dummy =
                Server::open(dummy_cfg, &f.root.join("unused"), effective_uid().unwrap()).unwrap();
            let old = std::mem::replace(&mut f.server, dummy);
            drop(old);

            // Truncate journal.jsonl to 0 bytes -> Empty error, must NOT misreport UPGRADE-REQUIRED.
            fs::write(&journal_path, b"").unwrap();
            assert_eq!(
                Authority::recover(&journal_path, &session_root).err(),
                Some(crate::journal::JournalError::Empty)
            );
            let Err(err) = Server::open(cfg, &f.root, effective_uid().unwrap()) else {
                panic!("expected Empty error on truncated journal");
            };
            let msg = err.to_string();
            assert!(
                !msg.contains("UPGRADE-REQUIRED"),
                "refused destroy on current archive must not report UPGRADE-REQUIRED, got: {msg}"
            );
            assert!(
                msg.contains("Corrupt(empty)"),
                "expected Corrupt(empty), got: {msg}"
            );
        });
    }

    #[test]
    fn daemon_refusal_propagates_disconnected_and_swallows_queue_overflow() {
        use std::os::unix::fs::PermissionsExt;
        run(async {
            let mut f = Fixture::new();
            f.seed();
            f.server
                .authority
                .apply(Input::Lifecycle {
                    surface_id: "surface-demo".into(),
                    update: LifecycleUpdate::Destroyed,
                })
                .unwrap();

            let shm_dir = PathBuf::from(format!(
                "/dev/shm/mv-d1-disc-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&shm_dir).unwrap();
            fs::set_permissions(&shm_dir, fs::Permissions::from_mode(0o700)).unwrap();
            let shm_file = shm_dir.join("f.rgb");
            let pixels = vec![10u8; 1280 * 720 * 3];
            fs::write(&shm_file, &pixels).unwrap();
            fs::set_permissions(&shm_file, fs::Permissions::from_mode(0o600)).unwrap();

            let frame_body = serde_json::json!({
                "schema": "frame_ref/v0.2",
                "surface_id": "surface-demo",
                "generation": 2,
                "tick": 2,
                "ts_ns": 2000,
                "width": 1280,
                "height": 720,
                "format": "rgb24",
                "ramws_path": shm_file.to_str().unwrap(),
                "sha256": sha256_hex(&pixels),
                "capture_us": 50
            });
            let event_body = serde_json::json!({
                "schema": "surface_event/v0.2",
                "event": "state_changed",
                "data": {
                    "surface": {
                        "schema": "surface/v0.2",
                        "surface_id": "surface-demo",
                        "kind": "game_capsule",
                        "display": "display-nv",
                        "geometry": { "w": 1280, "h": 720 },
                        "state": "destroyed",
                        "visibility": "unfolded",
                        "control": "agent",
                        "profile_id": "profile-demo"
                    }
                }
            });

            let daemon_ep = f.endpoint(Component::Daemon);
            let daemon_rx = f.attach(Component::Daemon, 1);
            // Fill the 1-slot queue so the next refusal hits QueueOverflow(daemon), which is swallowed.
            f.server
                .send(
                    &daemon_ep,
                    Command::Hello(Box::new(f.server.config.core.hello.clone())),
                )
                .unwrap();
            assert!(f
                .route(Component::Daemon, 2, frame_body.clone())
                .await
                .is_ok());
            assert!(f
                .route(Component::Daemon, 3, event_body.clone())
                .await
                .is_ok());

            // Drop the receiver so the next refusal hits SendFailure::Disconnected(daemon), which must propagate.
            drop(daemon_rx);
            let err_frame = f
                .route(Component::Daemon, 4, frame_body)
                .await
                .expect_err("expected Disconnected on FrameRef refusal with dropped daemon rx");
            assert!(matches!(
                err_frame.downcast_ref::<SendFailure>(),
                Some(SendFailure::Disconnected(ep)) if ep == &daemon_ep
            ));

            let err_event = f
                .route(Component::Daemon, 5, event_body)
                .await
                .expect_err("expected Disconnected on SurfaceEvent refusal with dropped daemon rx");
            assert!(matches!(
                err_event.downcast_ref::<SendFailure>(),
                Some(SendFailure::Disconnected(ep)) if ep == &daemon_ep
            ));

            let _ = fs::remove_dir_all(&shm_dir);
        });
    }
}

#[cfg(test)]
mod reconnect_tests;

#[cfg(test)]
mod b1_stale_frame_tests;
