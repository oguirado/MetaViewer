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
use std::os::unix::fs::OpenOptionsExt;
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
    serial: u64,
    observers: BTreeSet<Endpoint>,
    subscriptions: BTreeSet<(Endpoint, String)>,
    unsubscribed: BTreeSet<(Endpoint, String)>,
    tool_state: tools::ToolState,
}
impl Server {
    pub fn open(config: Config, state_dir: &Path, uid: u32) -> Result<Self> {
        config.validate(uid)?;
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
            Authority::recover(&path, &root)?
        } else {
            Authority::create(state_dir, initial)?
        };
        if authority.state().session_id != config.session_id {
            return Err(invalid("recovered session mismatch"));
        }
        let mut replay = ReplayTable::new(100_000)?;
        // Boundary envelope witnesses also persist sender nonce/sequence evidence.
        // Artifacts are validated by recovery before they are considered here.
        let mut envelopes = BTreeMap::new();
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
                            envelopes.insert((env.from.clone(), env.seq), env);
                        }
                    }
                }
            }
        }
        for env in envelopes.into_values() {
            replay.record(&env.session_id, &env.from, &env.nonce, env.seq)?;
        }
        Ok(Self {
            config,
            authority,
            root,
            replay,
            connections: BTreeMap::new(),
            origin: Instant::now(),
            serial: 0,
            observers: BTreeSet::new(),
            subscriptions: BTreeSet::new(),
            unsubscribed: BTreeSet::new(),
            tool_state,
        })
    }
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        Ok(self.authority.state().snapshot()?)
    }
    fn now(&self) -> Result<u64> {
        Ok(u64::try_from(self.origin.elapsed().as_nanos())?)
    }
    fn send(&mut self, to: &Endpoint, body: Command) -> Result<()> {
        self.serial = self
            .serial
            .checked_add(1)
            .ok_or_else(|| invalid("sequence exhausted"))?;
        let env = Envelope {
            schema: "envelope/v0.2".into(),
            msg_id: format!("core-{}-{}", self.authority.state().epoch, self.serial),
            ts_ns: Clock::new(self.now()?),
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
            .ok_or_else(|| invalid("recipient disconnected"))?;
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
    fn fanout(&mut self, body: Command) {
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
            let _ = self.send(&peer, body.clone());
        }
    }
    fn witness(&mut self, frame: &FrameRef) -> Result<Witness> {
        let path = Path::new(&frame.ramws_path);
        if !path.starts_with("/dev/shm")
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(invalid("frame outside shared memory"));
        }
        let mut prefix = PathBuf::new();
        for part in path.components() {
            prefix.push(part.as_os_str());
            if fs::symlink_metadata(&prefix)?.file_type().is_symlink() {
                return Err(invalid("symlink frame path"));
            }
        }
        // Linux O_NOFOLLOW | O_NONBLOCK; avoid blocking on an attacker-owned FIFO.
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x20000 | 0x800)
            .open(path)?;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > 64 * 1024 * 1024 {
            return Err(invalid("invalid frame witness"));
        }
        let mut bytes = Vec::new();
        file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != meta.len() || sha256_hex(&bytes) != frame.sha256 {
            return Err(invalid("frame digest mismatch"));
        }
        Ok(self.authority.retain_witness(&bytes)?)
    }
    fn frame(&mut self, frame: &FrameRef, boundary: Witness) -> Result<()> {
        let witness = self.witness(frame)?;
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
            self.tool_state
                .retain(&Command::FrameRef(Box::new(frame.clone())));
        }
        Ok(())
    }
    fn route(&mut self, peer: &ReadyPeer, epoch: u64, env: Envelope) -> Result<()> {
        peer.check_sender(&env)?;
        self.replay
            .record(&env.session_id, &env.from, &env.nonce, env.seq)?;
        let raw = serde_json::to_string(&env)?;
        let boundary = self.authority.retain_witness(raw.as_bytes())?;
        match (&env.from.component, &env.body) {
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
                    return self.unsupported(&env, boundary);
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
                    return self.unsupported(&env, boundary);
                }
                let sid = value["params"]["surface_id"].as_str();
                if matches!(op, "destroy" | "frame_subscribe" | "frame_unsubscribe")
                    && !sid.is_some_and(|id| self.authority.state().surfaces.contains_key(id))
                {
                    return self.unsupported(&env, boundary);
                }
                let out = self.authority.apply_with_witnesses(
                    Input::SurfaceRequest {
                        request: request.as_ref().clone(),
                    },
                    vec![boundary],
                )?;
                if let Some(reason) = out.reason {
                    return self.refuse(&env.from, &env.msg_id, reason, out.core_seq);
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
                self.send(&daemon, env.body.clone())?;
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
                        self.frame(&e.data.frame_ref, boundary)?;
                        None
                    }
                    SurfaceEvent::Case4(e)
                        if self
                            .authority
                            .state()
                            .surfaces
                            .contains_key(&e.data.surface_id) =>
                    {
                        Some(self.authority.apply_with_witnesses(
                            Input::Lifecycle {
                                surface_id: e.data.surface_id.clone(),
                                update: LifecycleUpdate::Lost,
                            },
                            vec![boundary],
                        )?)
                    }
                    SurfaceEvent::Case3(_) | SurfaceEvent::Case4(_) => Some(
                        self.authority
                            .apply_with_witnesses(Input::SurfaceNotice, vec![boundary])?,
                    ),
                };
                if let Some(out) = out {
                    if let Some(reason) = out.reason {
                        return self.refuse(&env.from, &env.msg_id, reason, out.core_seq);
                    }
                    self.notify_cancellations(&out.cancelled, out.core_seq)?;
                }
                self.tool_state.retain(&env.body);
                self.fanout(env.body.clone());
            }
            (Component::Daemon, Command::FrameRef(frame)) => {
                if epoch != self.authority.state().epoch {
                    return Err(invalid("old executor"));
                }
                self.frame(frame, boundary)?;
                self.fanout(env.body.clone());
            }
            (Component::Agent, Command::ActionProposal(proposal)) => {
                self.admit_proposal(peer, &env, proposal, boundary, None)?;
            }

            (Component::Ui, Command::UiIntent(request)) => {
                let value = serde_json::to_value(request)?;
                let take = match value["op"].as_str() {
                    Some("take_control") => true,
                    Some("release_control") => false,
                    _ => return self.unsupported(&env, boundary),
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
                    return self.unsupported(&env, boundary);
                }
                let out = self.authority.apply_with_witnesses(input, vec![boundary])?;
                if let Some(reason) = out.reason {
                    return self.refuse(
                        &env.from,
                        value["request_id"].as_str().unwrap_or(&env.msg_id),
                        reason,
                        out.core_seq,
                    );
                }
                self.notify_cancellations(&out.cancelled, out.core_seq)?;
                let daemon = self
                    .config
                    .peers
                    .iter()
                    .find(|p| p.endpoint.component == Component::Daemon)
                    .ok_or_else(|| invalid("no daemon"))?
                    .endpoint
                    .clone();
                let mut params = serde_json::json!({"surface_id":value["params"]["surface_id"]});
                if take {
                    params["owner"] = "human".into();
                }
                let body = serde_json::from_value(
                    serde_json::json!({"schema":"surface_request/v0.2","op":value["op"],"params":params}),
                )?;
                self.send(&daemon, Command::SurfaceRequest(Box::new(body)))?;
            }
            (Component::Daemon, Command::ActionReceipt(receipt)) => {
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
                    return self.refuse(&env.from, &receipt.proposal_id, reason, out.core_seq);
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
                self.send(&agent, env.body.clone())?;
                self.poll_tool_waiters()?;
            }
            _ => return self.unsupported(&env, boundary),
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
            self.now()?,
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
        self.proposal_verdict(env, tool, verdict)?;
        if admitted {
            let out = self.authority.apply(Input::Dispatch {
                proposal_id: proposal.proposal_id.clone(),
                now_ns: self.now()?,
            })?;
            if out.dispatch {
                let body = serde_json::from_value(
                    serde_json::json!({"schema":"surface_request/v0.2","op":"input","params":{"surface_id":proposal.surface_id,"proposal_id":proposal.proposal_id,"action":proposal.action}}),
                )?;
                self.send(&daemon, Command::SurfaceRequest(Box::new(body)))?;
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
    fn notify_cancellations(&mut self, ids: &[String], seq: u64) -> Result<()> {
        let agent = self.agent()?;
        if self.connections.contains_key(&agent) {
            for id in ids {
                if let Err(error) = self.refuse(&agent, id, Refusal::SurfaceNotAgentControlled, seq)
                {
                    // A slow agent must never prevent forwarding human control
                    // to the daemon. Saturation has its own reserved diagnostic.
                    if error.downcast_ref::<SendFailure>().is_none() {
                        return Err(error);
                    }
                }
            }
        }
        Ok(())
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
        let surface = Surface {
            display: s.display.clone(),
            owner: self.agent()?,
            agent_controlled: s.control == SurfaceControl::Agent,
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
    fn unsupported(&mut self, env: &Envelope, boundary: Witness) -> Result<()> {
        let value = serde_json::to_value(&env.body)?;
        let id = value["request_id"].as_str().unwrap_or(&env.msg_id);
        let out = self.authority.apply_with_witnesses(
            Input::Refuse {
                reason: Refusal::Policy,
            },
            vec![boundary],
        )?;
        self.refuse(&env.from, id, Refusal::Policy, out.core_seq)
    }
    fn refuse(&mut self, peer: &Endpoint, id: &str, reason: Refusal, seq: u64) -> Result<()> {
        let body = serde_json::from_value(
            serde_json::json!({"schema":"action_verdict/v0.2", "proposal_id":id,"decision":"refused","reason_code":reason,"core_seq":seq}),
        )?;
        self.send(peer, Command::ActionVerdict(Box::new(body)))
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
    let (id, epoch) = {
        let mut s = server.lock().map_err(|_| invalid("poisoned authority"))?;
        if s.connections.contains_key(ready.endpoint()) {
            return Err(invalid("endpoint already connected"));
        }
        s.replay
            .record(&env.session_id, &env.from, &env.nonce, env.seq)?;
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
        s.send(ready.endpoint(), Command::Hello(Box::new(hello)))?;
        (id, epoch)
    };
    let (mut reader, mut writer) = stream.into_split();
    let writer_closed = closed.clone();
    let writer_task = tokio::spawn(async move {
        while !writer_closed.load(std::sync::atomic::Ordering::Acquire) {
            let notification = terminal.lock().ok().and_then(|mut slot| slot.take());
            if let Some(env) = notification {
                let _ = write_frame(&mut writer, &env).await;
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
                if !matches!(
                    error.downcast_ref::<SendFailure>(),
                    Some(SendFailure::QueueOverflow(_))
                ) {
                    return Err(error);
                }
            }
        }
    }
    .await;
    closed.store(true, std::sync::atomic::Ordering::Release);
    writer_task.abort();
    let mut s = server.lock().map_err(|_| invalid("poisoned authority"))?;
    if s.connections
        .get(ready.endpoint())
        .is_some_and(|c| c.id == id)
    {
        s.connections.remove(ready.endpoint());
        s.tool_state.remove_peer(ready.endpoint());
        s.observers.remove(ready.endpoint());
        s.subscriptions.retain(|(peer, _)| peer != ready.endpoint());
        s.unsubscribed.retain(|(peer, _)| peer != ready.endpoint());
    }
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
