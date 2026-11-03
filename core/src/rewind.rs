//! Standalone pure REWIND reducer; intentionally not registered in the live core.
//! Callers MUST authenticate principals and obtain native observations through an
//! owned adapter. Synthetic structs are test inputs, never physical witnesses.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
const MAX: u64 = 9_007_199_254_740_991;
fn need(ok: bool, code: &'static str) -> Result<(), &'static str> {
    if ok {
        Ok(())
    } else {
        Err(code)
    }
}
fn id(s: &str, prefix: &str) -> bool {
    let Some(t) = s.strip_prefix(prefix) else {
        return false;
    };
    !t.is_empty()
        && t.len() <= 64
        && t.as_bytes()[0].is_ascii_alphanumeric()
        && t.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}
fn hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn label(s: &str) -> bool {
    s.chars().count() <= 80
        && !s
            .chars()
            .any(|c| c < ' ' || c == '\u{7f}' || c == '/' || c == '\\')
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    Ui(String),
    Agent(String),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandGate {
    Quiescent,
    Active,
    Unknown,
}
fn optional_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Pause,
    Resume,
    Mark,
    Restore,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    pub workload_id: String,
    pub generation: u64,
    pub authority_epoch: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_text"
    )]
    pub label: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_text"
    )]
    pub point_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub request_id: String,
    pub op: Op,
    pub params: Params,
}
impl Request {
    fn validate(&self) -> Result<(), &'static str> {
        need(
            self.schema == "rewind_request/v0.2"
                && id(&self.request_id, "request-")
                && id(&self.params.workload_id, "workload-")
                && (1..=MAX).contains(&self.params.generation)
                && (1..=MAX).contains(&self.params.authority_epoch),
            "INVALID",
        )?;
        need(
            match self.op {
                Op::Mark => {
                    self.params.label.as_ref().is_some_and(|s| label(s))
                        && self.params.point_id.is_none()
                }
                Op::Restore => {
                    self.params.label.is_none()
                        && self
                            .params
                            .point_id
                            .as_ref()
                            .is_some_and(|s| id(s, "point-"))
                }
                _ => self.params.label.is_none() && self.params.point_id.is_none(),
            },
            "INVALID",
        )
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub schema: String,
    pub point_id: String,
    pub label: String,
    pub created_order: u64,
    pub created_mono_ns: u64,
    pub source_generation: u64,
    pub source_authority_epoch: u64,
    pub compatibility_sha256: String,
    pub state_sha256: String,
    pub memory_sha256: String,
    pub state_bytes: u64,
    pub memory_bytes: u64,
    pub counter_value: Option<u64>,
    pub status: String,
    pub active_references: u64,
}
impl Point {
    fn valid(&self) -> bool {
        self.schema == "rewind_point/v0.2"
            && id(&self.point_id, "point-")
            && label(&self.label)
            && [
                self.created_order,
                self.created_mono_ns,
                self.source_generation,
                self.source_authority_epoch,
                self.state_bytes,
                self.memory_bytes,
            ]
            .iter()
            .all(|n| (1..=MAX).contains(n))
            && [
                &self.compatibility_sha256,
                &self.state_sha256,
                &self.memory_sha256,
            ]
            .iter()
            .all(|s| hex(s))
            && self.counter_value.is_none_or(|n| n <= MAX)
            && ["usable", "unavailable"].contains(&self.status.as_str())
            && self.active_references <= 1
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeId {
    pub run_id: String,
    pub pid: u64,
    pub start_tick: u64,
    pub invocation: String,
}
impl NativeId {
    fn valid(&self) -> bool {
        id(&self.run_id, "run-")
            && (2..=MAX).contains(&self.pid)
            && (1..=MAX).contains(&self.start_tick)
            && self.invocation.len() == 32
            && self
                .invocation
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Closed {
    pub native: NativeId,
    pub attempt_id: Option<String>,
    pub inventory_complete: bool,
    pub pid_absent: bool,
    pub service_absent: bool,
    pub cgroup_empty: bool,
    pub mappings_released: bool,
}
impl Closed {
    fn proves(&self, n: &NativeId) -> bool {
        &self.native == n
            && self.inventory_complete
            && self.pid_absent
            && self.service_absent
            && self.cgroup_empty
            && self.mappings_released
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fenced {
    pub native: NativeId,
    pub no_job: bool,
    pub socket_closed: bool,
    pub paused: bool,
}
impl Fenced {
    fn proves(&self, n: &NativeId) -> bool {
        &self.native == n && self.no_job && self.socket_closed && self.paused
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ready {
    pub native: NativeId,
    pub generation: u64,
    pub authority_epoch: u64,
    pub reseeded: bool,
    pub hello_ready: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Paused(Fenced),
    Marked {
        point: Box<Point>,
        fence: Fenced,
        resumed: Option<Ready>,
    },
    Resumed(Ready),
    Restored {
        old_closed: Closed,
        ready: Ready,
    },
    /// Correlated terminal failure only when the owned VM is demonstrably paused.
    FailedPaused(Fenced),
    RestoreFailedPaused {
        fence: Fenced,
        attempt_closed: Closed,
    },
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub event_id: String,
    pub request_id: String,
    pub owner_id: String,
    pub workload_id: String,
    pub generation: u64,
    pub authority_epoch: u64,
    pub outcome: Outcome,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dispatch {
    pub request: Request,
    pub owner_id: String,
    pub generation: u64,
    pub authority_epoch: u64,
    pub allocated_point: Option<String>,
    pub attempt_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Pending {
    dispatch: Dispatch,
    origin_phase: String,
    origin_generation: u64,
    origin_epoch: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    workload: String,
    owner: String,
    agent: String,
    creator: String,
    session_id: String,
    executor_epoch: u64,
    epoch: u64,
    generation: u64,
    compatibility: String,
    phase: String,
    native: NativeId,
    points: Vec<Point>,
    last_good: Option<String>,
    pending: Option<Pending>,
    requests: BTreeSet<String>,
    events: BTreeSet<String>,
    next_point: u64,
    recoverable: bool,
    attempt: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Participants<'a> {
    pub agent: &'a str,
    pub creator: &'a str,
}
impl State {
    /// The adapter must supply a confirmed authenticated GC snapshot and native identity.
    /// This constructor only verifies their internal consistency; it performs no observation.
    pub fn initialize(
        gc: &Value,
        participants: Participants<'_>,
        session_id: &str,
        executor_epoch: u64,
        authority_epoch: u64,
        compatibility: &str,
        native: NativeId,
    ) -> Result<Self, &'static str> {
        let Participants { agent, creator } = participants;
        let owner = format!(
            "actor-{:x}",
            Sha256::digest(format!("agent:{agent}").as_bytes())
        );
        let workload = gc["workload_id"].as_str().unwrap_or("");
        let generation = gc["generation"].as_u64().unwrap_or(0);
        need(
            !agent.is_empty()
                && agent.len() <= 128
                && !creator.is_empty()
                && creator.len() <= 128
                && !session_id.is_empty()
                && session_id.len() <= 128
                && (1..=MAX).contains(&executor_epoch)
                && (1..=MAX).contains(&authority_epoch)
                && hex(compatibility)
                && native.valid(),
            "INVALID",
        )?;
        need(
            gc.as_object().is_some_and(|v| {
                [
                    "schema",
                    "owner_id",
                    "backend",
                    "isa",
                    "profile_id",
                    "phase",
                    "ownership",
                    "job",
                    "controls",
                    "generation",
                    "workload_id",
                    "jobs_started",
                ]
                .iter()
                .all(|k| v.contains_key(*k))
                    && v.len() == 12
            }) && gc["controls"].as_object().is_some_and(|v| {
                v.len() == 2 && v.contains_key("cancel") && v.contains_key("stop")
            }),
            "UNCONFIRMED",
        )?;
        need(
            gc["schema"] == "guest_command_session/v0.2"
                && gc["owner_id"] == owner
                && gc["backend"] == "firecracker"
                && gc["isa"] == "aarch64"
                && gc["profile_id"] == "guest-command-arm64-v1"
                && gc["phase"] == "ready"
                && gc["ownership"] == "held"
                && gc["jobs_started"].as_u64().is_some_and(|n| n <= 64)
                && gc["job"].is_null()
                && gc["controls"]["cancel"].is_null()
                && gc["controls"]["stop"].is_null()
                && id(workload, "workload-")
                && (1..=MAX).contains(&generation),
            "UNCONFIRMED",
        )?;
        Ok(Self {
            workload: workload.into(),
            owner,
            agent: agent.into(),
            creator: creator.into(),
            session_id: session_id.into(),
            executor_epoch,
            epoch: authority_epoch,
            generation,
            compatibility: compatibility.into(),
            phase: "ready".into(),
            native,
            points: vec![],
            last_good: None,
            pending: None,
            requests: BTreeSet::new(),
            events: BTreeSet::new(),
            next_point: 1,
            recoverable: false,
            attempt: None,
        })
    }
    pub fn status(&self) -> Value {
        json!({"schema":"rewind_session/v0.2","workload_id":self.workload,"generation":self.generation,"authority_epoch":self.epoch,"owner_id":self.owner,"authority":"core","guest_counter":null,"compatibility_sha256":self.compatibility,"profile_id":"rewind-arm64-v1","backend":"firecracker","isa":"aarch64","disk_scope":"immutable-boot-and-ram-workspace","external_effects_warning":"External effects are not rewound.","phase":self.phase,"ownership":if self.phase=="stopped"{"released"}else{"held"},"pending_request_id":self.pending.as_ref().map(|p|&p.dispatch.request.request_id),"points":self.points,"last_good_usable":self.last_good})
    }
    fn caller(&self, p: &Principal) -> bool {
        match p {
            Principal::Ui(s) => s == &self.creator,
            Principal::Agent(s) => s == &self.agent,
        }
    }
    pub fn command_allowed(&self, owner: &str, generation: u64, executor_epoch: u64) -> bool {
        owner == self.owner
            && generation == self.generation
            && executor_epoch == self.executor_epoch
            && self.phase == "ready"
            && self.pending.is_none()
    }
    pub fn submit(
        &mut self,
        r: Request,
        p: &Principal,
        executor_epoch: u64,
        command_gate: CommandGate,
    ) -> Result<Dispatch, &'static str> {
        let mut next = self.clone();
        let out = next.submit_inner(r, p, executor_epoch, command_gate)?;
        *self = next;
        Ok(out)
    }
    fn submit_inner(
        &mut self,
        r: Request,
        p: &Principal,
        executor_epoch: u64,
        command_gate: CommandGate,
    ) -> Result<Dispatch, &'static str> {
        r.validate()?;
        need(self.caller(p), "OWNER")?;
        need(executor_epoch == self.executor_epoch, "STALE")?;
        need(
            r.params.workload_id == self.workload
                && r.params.generation == self.generation
                && r.params.authority_epoch == self.epoch,
            "STALE",
        )?;
        need(
            self.pending.is_none() && command_gate == CommandGate::Quiescent,
            "BUSY",
        )?;
        need(self.phase != "stopped", "CLOSED")?;
        need(
            !self.requests.contains(&r.request_id) && self.requests.len() < 256,
            "DUPLICATE",
        )?;
        let original = self.phase.clone();
        match r.op {
            Op::Pause => need(self.phase == "ready", "BUSY")?,
            Op::Resume => need(self.phase == "paused", "BUSY")?,
            Op::Mark => {
                need(self.phase == "ready" || self.phase == "paused", "BUSY")?;
                need(self.points.len() < 2, "CAPACITY")?;
            }
            Op::Restore => {
                let chosen = r.params.point_id.as_ref().ok_or("INVALID")?;
                need(
                    self.phase == "paused"
                        || self.phase == "uncertain"
                            && self.recoverable
                            && self.last_good.as_ref() == Some(chosen),
                    "BUSY",
                )?;
                need(
                    self.points.iter().any(|p| {
                        &p.point_id == chosen
                            && p.status == "usable"
                            && p.compatibility_sha256 == self.compatibility
                    }),
                    "POINT_UNAVAILABLE",
                )?;
            }
        }
        let old_generation = self.generation;
        let old_epoch = self.epoch;
        if matches!(r.op, Op::Resume | Op::Restore) || r.op == Op::Mark && original == "ready" {
            self.generation = self
                .generation
                .checked_add(1)
                .filter(|n| *n <= MAX)
                .ok_or("EXHAUSTED")?;
            self.epoch = self
                .epoch
                .checked_add(1)
                .filter(|n| *n <= MAX)
                .ok_or("EXHAUSTED")?;
        }
        let point = if r.op == Op::Mark {
            let mut h = Sha256::new();
            for s in [&self.session_id, &self.workload, &r.request_id] {
                h.update((s.len() as u64).to_be_bytes());
                h.update(s.as_bytes());
            }
            Some(format!("point-{:x}", h.finalize()))
        } else {
            None
        };
        self.phase = match r.op {
            Op::Pause => "pausing",
            Op::Resume => "resuming",
            Op::Mark => "marking",
            Op::Restore => "restoring",
        }
        .into();
        let out = Dispatch {
            request: r.clone(),
            owner_id: self.owner.clone(),
            generation: self.generation,
            authority_epoch: self.epoch,
            allocated_point: point,
            attempt_id: if r.op == Op::Restore {
                Some(format!(
                    "attempt-{}",
                    r.request_id.trim_start_matches("request-")
                ))
            } else {
                None
            },
        };
        self.attempt = out.attempt_id.clone();
        self.requests.insert(r.request_id.clone());
        self.pending = Some(Pending {
            dispatch: out.clone(),
            origin_phase: original,
            origin_generation: old_generation,
            origin_epoch: old_epoch,
        });
        self.recoverable = false;
        Ok(out)
    }
    fn ready(&self, p: &Ready) -> bool {
        p.native.valid()
            && p.generation == self.generation
            && p.authority_epoch == self.epoch
            && p.reseeded
            && p.hello_ready
    }
    pub fn observe(&mut self, e: Event, executor_epoch: u64) -> Result<(), &'static str> {
        let mut next = self.clone();
        next.observe_inner(e, executor_epoch)?;
        *self = next;
        Ok(())
    }
    fn observe_inner(&mut self, e: Event, executor_epoch: u64) -> Result<(), &'static str> {
        need(
            executor_epoch == self.executor_epoch
                && e.owner_id == self.owner
                && e.workload_id == self.workload
                && e.generation == self.generation
                && e.authority_epoch == self.epoch,
            "STALE",
        )?;
        need(
            id(&e.event_id, "event-")
                && !self.events.contains(&e.event_id)
                && self.events.len() < 1024,
            "DUPLICATE",
        )?;
        let pending = self.pending.clone().ok_or("OUT_OF_ORDER")?;
        need(
            self.phase != "uncertain"
                || matches!(
                    e.outcome,
                    Outcome::Unknown
                        | Outcome::FailedPaused(_)
                        | Outcome::RestoreFailedPaused { .. }
                ),
            "UNCERTAIN",
        )?;
        need(
            e.request_id == pending.dispatch.request.request_id,
            "CORRELATION",
        )?;
        let mut finish = true;
        match e.outcome {
            Outcome::Unknown => {
                self.phase = "uncertain".into();
                self.recoverable = false;
                finish = false;
            }
            Outcome::FailedPaused(proof) => {
                need(
                    pending.dispatch.request.op != Op::Restore && proof.proves(&self.native),
                    "UNPROVEN",
                )?;
                self.phase = "uncertain".into();
                self.recoverable = true;
            }
            Outcome::RestoreFailedPaused {
                fence,
                attempt_closed,
            } => {
                need(
                    pending.dispatch.request.op == Op::Restore
                        && fence.proves(&self.native)
                        && attempt_closed.native.valid()
                        && (attempt_closed.native.pid != self.native.pid
                            || attempt_closed.native.start_tick != self.native.start_tick)
                        && attempt_closed.inventory_complete
                        && attempt_closed.attempt_id == self.attempt
                        && attempt_closed.pid_absent
                        && attempt_closed.service_absent
                        && attempt_closed.cgroup_empty
                        && attempt_closed.mappings_released,
                    "UNPROVEN",
                )?;
                self.attempt = None;
                self.phase = "uncertain".into();
                self.recoverable = true;
            }
            Outcome::Paused(proof) => {
                need(
                    pending.dispatch.request.op == Op::Pause && proof.proves(&self.native),
                    "UNPROVEN",
                )?;
                self.phase = "paused".into();
            }
            Outcome::Resumed(proof) => {
                need(
                    pending.dispatch.request.op == Op::Resume
                        && self.ready(&proof)
                        && proof.native == self.native,
                    "UNPROVEN",
                )?;
                self.phase = "ready".into();
            }
            Outcome::Marked {
                point,
                fence,
                resumed,
            } => {
                need(
                    pending.dispatch.request.op == Op::Mark
                        && fence.proves(&self.native)
                        && point.valid()
                        && Some(&point.point_id) == pending.dispatch.allocated_point.as_ref()
                        && point.label
                            == pending
                                .dispatch
                                .request
                                .params
                                .label
                                .clone()
                                .unwrap_or_default()
                        && point.source_generation == pending.origin_generation
                        && point.source_authority_epoch == pending.origin_epoch
                        && point.compatibility_sha256 == self.compatibility
                        && point.created_order == self.next_point
                        && point.status == "usable"
                        && point.active_references == 0,
                    "UNPROVEN",
                )?;
                if pending.origin_phase == "ready" {
                    need(
                        resumed
                            .as_ref()
                            .is_some_and(|p| self.ready(p) && p.native == self.native),
                        "UNPROVEN",
                    )?;
                    self.phase = "ready".into();
                } else {
                    need(resumed.is_none(), "UNPROVEN")?;
                    self.phase = "paused".into();
                }
                self.last_good = Some(point.point_id.clone());
                self.points.push(*point);
                self.next_point = self
                    .next_point
                    .checked_add(1)
                    .filter(|n| *n <= MAX)
                    .ok_or("EXHAUSTED")?;
            }
            Outcome::Restored { old_closed, ready } => {
                need(
                    pending.dispatch.request.op == Op::Restore
                        && old_closed.proves(&self.native)
                        && old_closed.attempt_id == self.attempt
                        && self.ready(&ready)
                        && (ready.native.pid != self.native.pid
                            || ready.native.start_tick != self.native.start_tick),
                    "UNPROVEN",
                )?;
                let chosen = pending
                    .dispatch
                    .request
                    .params
                    .point_id
                    .as_ref()
                    .ok_or("INVALID")?;
                for p in &mut self.points {
                    p.active_references = if &p.point_id == chosen { 1 } else { 0 };
                }
                self.native = ready.native;
                self.attempt = None;
                self.phase = "ready".into();
            }
        }
        self.events.insert(e.event_id);
        if finish {
            self.pending = None;
        }
        Ok(())
    }
    /// Timeout/ambiguous send is a durable fence; it never rolls back allocated counters.
    pub fn unknown(&mut self) {
        if self.phase != "stopped" {
            self.phase = "uncertain".into();
            self.recoverable = false;
        }
    }
    /// Explicit physical close notification, independent of pending request settlement.
    pub fn closed(&mut self, proof: &Closed, executor_epoch: u64) -> Result<(), &'static str> {
        need(
            executor_epoch == self.executor_epoch
                && proof.proves(&self.native)
                && proof.attempt_id == self.attempt,
            "UNPROVEN",
        )?;
        for p in &mut self.points {
            p.active_references = 0;
        }
        self.phase = "stopped".into();
        self.pending = None;
        self.attempt = None;
        self.recoverable = false;
        Ok(())
    }
    /// Eviction only after an owned host reference-release observation.
    pub fn evict(&mut self, point_id: &str, executor_epoch: u64) -> Result<(), &'static str> {
        need(
            executor_epoch == self.executor_epoch
                && self.pending.is_none()
                && self.attempt.is_none()
                && ["ready", "paused", "stopped"].contains(&self.phase.as_str()),
            "BUSY",
        )?;
        let i = self
            .points
            .iter()
            .position(|p| p.point_id == point_id)
            .ok_or("POINT_UNAVAILABLE")?;
        need(self.points[i].active_references == 0, "HELD")?;
        self.points.remove(i);
        if self.last_good.as_deref() == Some(point_id) {
            self.last_good = self
                .points
                .iter()
                .rev()
                .find(|p| p.status == "usable")
                .map(|p| p.point_id.clone());
        }
        Ok(())
    }
}
