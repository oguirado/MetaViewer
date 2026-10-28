#![forbid(unsafe_code)]
//! [TARGET, unit decision] Trusted host events form a private replay ABI, not
//! component messages. Callers serialize Authority access and authenticate host
//! events; proposals enter only through closed decoding and peer binding.
//! [TARGET, unit decision] Scroll dx/dy must fit signed 32-bit executor inputs;
//! larger deltas return OutOfBounds before reservation and again before dispatch.
//! [TARGET, unit decision] Scroll and wait are unsupported by the native adapter;
//! after numeric/budget rails they receive Policy before reservation or dispatch.
//! Budget counts admitted attempts; unknown dispatched work is never refunded.
//! Each proposal is dispatched at most once, below its retry ceiling; retries
//! require a new frame-bound admission. Receipt here settles execution only,
//! and never claims that an outcome was verified.
//! [TARGET, unit decision] Destroyed IDs are terminal tombstones. Metadata updates
//! preserve admitted verbs; DispatchFailed releases only provably unqueued work,
//! without refunding its admitted-attempt budget.
//! [TARGET, unit decision] Metadata updates can restore liveness; only explicit
//! Lost/Destroyed transitions revoke it. Control cession still cancels work.
//! [TARGET, unit decision] HumanInput admits UI surface_request/v0.2 op="input"
//! (click/key/type) only when the surface is live, not agent_controlled, free of
//! lease/draining conflicts, within frame bounds, and with remaining budget.
use crate::wire::payload::{ActionProposal, ActionProposalAction, ActionProposalExpectation};
use crate::{decode_envelope, Command, Component, Endpoint, Envelope, Refusal};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

crate::wire::error_type!(AdmissionError {
    InvalidInput,
    OutOfBounds,
    Overflow
});
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionRequest {
    raw: String,
    envelope: Envelope,
    epoch: u64,
    received_ns: u64,
}
impl AdmissionRequest {
    pub fn decode(
        raw: &str,
        peer: &Endpoint,
        session: &str,
        epoch: u64,
        received_ns: u64,
    ) -> Result<Self, AdmissionError> {
        let envelope = decode_envelope(raw).map_err(|error| match error {
            crate::DecodeError::OutOfBounds => AdmissionError::OutOfBounds,
            _ => AdmissionError::InvalidInput,
        })?;
        if envelope.from != *peer
            || envelope.session_id != session
            || envelope.to.component != Component::Core
            || !matches!(envelope.body, Command::ActionProposal(_))
        {
            return Err(AdmissionError::InvalidInput);
        }
        Ok(Self {
            raw: raw.into(),
            envelope,
            epoch,
            received_ns,
        })
    }
    pub(crate) fn proposal(&self) -> Result<&ActionProposal, AdmissionError> {
        match &self.envelope.body {
            Command::ActionProposal(p) => Ok(p),
            _ => Err(AdmissionError::InvalidInput),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub sha256: String,
    pub generation: u64,
    pub width: u64,
    pub height: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Surface {
    pub display: String,
    pub owner: Endpoint,
    pub agent_controlled: bool,
    pub live: bool,
    pub frame: Option<Frame>,
    pub refresh_after: Option<u64>,
    pub allowed_verbs: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    request: AdmissionRequest,
    deadline_ns: u64,
    dispatched: bool,
    unknown: bool,
}
/// [TARGET, unit decision] Private, journalled daemon lifecycle ABI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "surface", deny_unknown_fields)]
pub enum LifecycleUpdate {
    Created(Surface),
    Updated(Surface),
    Lost,
    Destroyed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", deny_unknown_fields)]
pub enum Input {
    /// [TARGET, unit decision] Journal closed lifecycle requests before forwarding.
    SurfaceRequest {
        request: crate::wire::payload::SurfaceRequest,
    },
    /// A daemon error is an observation, not a surface authority transition.
    SurfaceNotice,
    /// [TARGET, unit decision] Daemon lifecycle changes preserve authority fences.
    Lifecycle {
        surface_id: String,
        update: LifecycleUpdate,
    },
    Refuse {
        reason: Refusal,
    },
    Connect,
    Surface {
        id: String,
        surface: Surface,
    },
    Frame {
        surface_id: String,
        frame: Frame,
    },
    Propose(AdmissionRequest),
    Dispatch {
        proposal_id: String,
        now_ns: u64,
    },
    DispatchFailed {
        proposal_id: String,
        epoch: u64,
    },
    Receipt {
        proposal_id: String,
        epoch: u64,
    },
    TakeControl {
        surface_id: String,
    },
    ReleaseControl {
        surface_id: String,
    },
    Drain {
        proposal_id: String,
        epoch: u64,
    },
    HumanInput {
        request: crate::wire::payload::SurfaceRequestCase5,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub core_seq: u64,
    pub reason: Option<Refusal>,
    pub dispatch: bool,
    pub cancelled: Vec<String>,
    pub cancellation_reason: Option<Refusal>,
    pub control_ready: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreState {
    pub session_id: String,
    pub core_seq: u64,
    pub epoch: u64,
    pub remaining_budget: u64,
    pub surfaces: BTreeMap<String, Surface>,
    /// Surface keys; display conflicts are checked against every leased surface.
    pub leases: BTreeMap<String, String>,
    pub pending: BTreeMap<String, Pending>,
    pub draining: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    destroyed: BTreeSet<String>,
    seen: BTreeSet<String>,
    messages: BTreeSet<String>,
    lane_nonces: BTreeMap<String, BTreeSet<String>>,
    lane_sequences: BTreeMap<String, u64>,
    nonces: BTreeMap<String, BTreeSet<String>>,
    sequences: BTreeMap<String, u64>,
}
fn identity(endpoint: &Endpoint) -> Result<String, AdmissionError> {
    serde_json::to_string(endpoint).map_err(|_| AdmissionError::InvalidInput)
}
impl CoreState {
    pub fn session(session_id: &str) -> Result<Self, AdmissionError> {
        Self::new(session_id, 10_000)
    }
    pub fn new(session_id: &str, budget: u64) -> Result<Self, AdmissionError> {
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(AdmissionError::InvalidInput);
        }
        Ok(Self {
            session_id: session_id.into(),
            core_seq: 0,
            epoch: 0,
            remaining_budget: budget,
            surfaces: BTreeMap::new(),
            leases: BTreeMap::new(),
            pending: BTreeMap::new(),
            draining: BTreeMap::new(),
            destroyed: BTreeSet::new(),
            seen: BTreeSet::new(),
            messages: BTreeSet::new(),
            lane_nonces: BTreeMap::new(),
            lane_sequences: BTreeMap::new(),
            nonces: BTreeMap::new(),
            sequences: BTreeMap::new(),
        })
    }
    pub fn snapshot(&self) -> Result<Vec<u8>, AdmissionError> {
        crate::journal::canonical_bytes(
            &serde_json::to_value(self).map_err(|_| AdmissionError::InvalidInput)?,
        )
        .map_err(|_| AdmissionError::InvalidInput)
    }
    pub fn domain_snapshot(&self) -> Result<Vec<u8>, AdmissionError> {
        crate::journal::canonical_bytes(&serde_json::json!({"surfaces":self.surfaces,"leases":self.leases,"pending":self.pending,"draining":self.draining,"destroyed":self.destroyed,"budget":self.remaining_budget,"epoch":self.epoch})).map_err(|_|AdmissionError::InvalidInput)
    }
    pub fn is_destroyed(&self, id: &str) -> bool {
        self.destroyed.contains(id)
    }
    /// Pure deterministic reduction. Persistence callers publish only after fsync.
    pub fn apply(&mut self, input: &Input) -> Result<Outcome, AdmissionError> {
        let mut candidate = self.clone();
        let out = candidate.reduce(input)?;
        *self = candidate;
        Ok(out)
    }
    fn reduce(&mut self, input: &Input) -> Result<Outcome, AdmissionError> {
        let next = self
            .core_seq
            .checked_add(1)
            .ok_or(AdmissionError::Overflow)?;
        let mut out = Outcome {
            core_seq: next,
            reason: None,
            dispatch: false,
            cancelled: Vec::new(),
            cancellation_reason: None,
            control_ready: false,
        };
        match input {
            Input::SurfaceRequest { request } => {
                let value =
                    serde_json::to_value(request).map_err(|_| AdmissionError::InvalidInput)?;
                if !matches!(
                    value["op"].as_str(),
                    Some("create" | "destroy" | "list" | "frame_subscribe" | "frame_unsubscribe")
                ) || value["params"]["surface_id"]
                    .as_str()
                    .is_some_and(|id| self.is_destroyed(id))
                {
                    out.reason = Some(Refusal::Policy);
                } else if self.remaining_budget == 0 {
                    out.reason = Some(Refusal::BudgetExceeded);
                } else {
                    self.remaining_budget -= 1;
                }
            }
            Input::HumanInput { request } => {
                let p = &request.params;
                if let ActionProposalAction::Case3(a) = &p.action {
                    if i32::try_from(a.dx).is_err() || i32::try_from(a.dy).is_err() {
                        out.reason = Some(Refusal::OutOfBounds);
                        self.core_seq = next;
                        return Ok(out);
                    }
                }
                if self.is_destroyed(&p.surface_id)
                    || self.epoch == 0
                    || self.seen.contains(&p.proposal_id)
                    || self.pending.contains_key(&p.proposal_id)
                    || self.draining.contains_key(&p.proposal_id)
                {
                    out.reason = Some(Refusal::Policy);
                } else if let Some(s) = self.surfaces.get(&p.surface_id) {
                    let conflict = self.draining.values().any(|sid| sid == &p.surface_id)
                        || self.leases.iter().any(|(sid, _)| {
                            sid == &p.surface_id
                                || self
                                    .surfaces
                                    .get(sid)
                                    .is_some_and(|other| other.display == s.display)
                        });
                    if !s.live {
                        out.reason = Some(Refusal::Policy);
                    } else if s.agent_controlled || conflict {
                        out.reason = Some(Refusal::LockedByOther);
                    } else if matches!(
                        p.action,
                        ActionProposalAction::Case4(_) | ActionProposalAction::Case5(_)
                    ) {
                        out.reason = Some(Refusal::Policy);
                    } else if let ActionProposalAction::Case1(a) = &p.action {
                        if a.keys.join("+").len() > 32 {
                            out.reason = Some(Refusal::Policy);
                        } else if self.remaining_budget == 0 {
                            out.reason = Some(Refusal::BudgetExceeded);
                        }
                    } else if let ActionProposalAction::Case2(a) = &p.action {
                        if a.text.is_empty() || a.text.len() > 16384 || a.text.contains('\0') {
                            out.reason = Some(Refusal::Policy);
                        } else if self.remaining_budget == 0 {
                            out.reason = Some(Refusal::BudgetExceeded);
                        }
                    } else if let ActionProposalAction::Case0(a) = &p.action {
                        if s.frame
                            .as_ref()
                            .is_some_and(|f| a.x >= f.width || a.y >= f.height)
                        {
                            out.reason = Some(Refusal::OutOfBounds);
                        } else if self.remaining_budget == 0 {
                            out.reason = Some(Refusal::BudgetExceeded);
                        }
                    } else if matches!(p.action, ActionProposalAction::Case3(_))
                        && self.remaining_budget == 0
                    {
                        out.reason = Some(Refusal::BudgetExceeded);
                    }
                    if out.reason.is_none() {
                        self.remaining_budget = self
                            .remaining_budget
                            .checked_sub(1)
                            .ok_or(AdmissionError::Overflow)?;
                        self.seen.insert(p.proposal_id.clone());
                        out.dispatch = true;
                    }
                } else {
                    out.reason = Some(Refusal::Policy);
                }
            }
            Input::SurfaceNotice => {}
            Input::Refuse { reason } => out.reason = Some(*reason),
            Input::Lifecycle { surface_id, .. }
            | Input::Frame { surface_id, .. }
            | Input::TakeControl { surface_id }
            | Input::ReleaseControl { surface_id }
                if self.is_destroyed(surface_id) =>
            {
                out.reason = Some(Refusal::Policy);
            }
            Input::Lifecycle { surface_id, update } => match update {
                LifecycleUpdate::Created(surface) => {
                    if surface_id.is_empty()
                        || surface.display.is_empty()
                        || surface.frame.is_some()
                        || self.surfaces.contains_key(surface_id)
                    {
                        out.reason = Some(Refusal::Policy);
                    } else {
                        self.surfaces.insert(surface_id.clone(), surface.clone());
                    }
                }
                _ => {
                    if let Some(old) = self.surfaces.get_mut(surface_id) {
                        match update {
                            LifecycleUpdate::Updated(surface) => {
                                if surface.display.is_empty() || surface.frame.is_some() {
                                    return Err(AdmissionError::InvalidInput);
                                }
                                old.display = surface.display.clone();
                                old.live |= surface.live;
                                old.agent_controlled &= surface.agent_controlled;
                                // Wire metadata carries no capability grant.
                            }
                            LifecycleUpdate::Lost => old.live = false,
                            LifecycleUpdate::Destroyed => {
                                old.live = false;
                                self.destroyed.insert(surface_id.clone());
                            }
                            LifecycleUpdate::Created(_) => unreachable!(),
                        }
                        old.refresh_after = Some(next);
                        if !old.live || !old.agent_controlled {
                            out.cancelled = self.cancel_surface(surface_id);
                            out.cancellation_reason = Some(Refusal::SurfaceNotAgentControlled);
                        }
                    } else {
                        out.reason = Some(Refusal::Policy);
                    }
                }
            },
            Input::Connect => {
                self.epoch = self.epoch.checked_add(1).ok_or(AdmissionError::Overflow)?;
                for p in self.pending.values_mut() {
                    p.unknown = true;
                }
                for s in self.surfaces.values_mut() {
                    s.refresh_after = Some(next);
                }
            }
            Input::Surface { id, surface } => {
                if id.is_empty() || surface.display.is_empty() || self.surfaces.contains_key(id) {
                    return Err(AdmissionError::InvalidInput);
                }
                if let Some(f) = &surface.frame {
                    validate_frame(f)?;
                }
                self.surfaces.insert(id.clone(), surface.clone());
            }
            Input::Frame { surface_id, frame } => {
                validate_frame(frame)?;
                let s = self
                    .surfaces
                    .get_mut(surface_id)
                    .ok_or(AdmissionError::InvalidInput)?;
                if s.frame
                    .as_ref()
                    .is_some_and(|f| frame.generation < f.generation)
                {
                    return Err(AdmissionError::InvalidInput);
                }
                if s.refresh_after.is_some_and(|fence| next > fence) {
                    s.refresh_after = None;
                }
                s.frame = Some(frame.clone());
            }
            Input::Propose(r) => {
                let p = r.proposal()?;
                // Decode again on replay, including request values built by deserialization.
                let decoded = AdmissionRequest::decode(
                    &r.raw,
                    &r.envelope.from,
                    &self.session_id,
                    r.epoch,
                    r.received_ns,
                )?;
                if decoded.envelope != r.envelope {
                    return Err(AdmissionError::InvalidInput);
                }
                let who = identity(&r.envelope.from)?;
                let duplicate = self.seen.contains(&p.proposal_id)
                    || self.messages.contains(&r.envelope.msg_id)
                    || self
                        .nonces
                        .get(&who)
                        .is_some_and(|n| n.contains(&r.envelope.nonce))
                    || self
                        .sequences
                        .get(&who)
                        .is_some_and(|s| r.envelope.seq <= *s);
                out.reason = if duplicate {
                    Some(Refusal::Policy)
                } else {
                    self.check(r, r.received_ns, false)?
                };
                if !duplicate {
                    self.seen.insert(p.proposal_id.clone());
                    self.messages.insert(r.envelope.msg_id.clone());
                    self.nonces
                        .entry(who.clone())
                        .or_default()
                        .insert(r.envelope.nonce.clone());
                    self.sequences.insert(who, r.envelope.seq);
                }
                if out.reason.is_none() {
                    if let ActionProposalAction::Case5(a) = &p.action {
                        let key = lane_key(r, p)?;
                        self.lane_nonces
                            .entry(key.clone())
                            .or_default()
                            .insert(a.payload.nonce.clone());
                        self.lane_sequences.insert(key, a.payload.seq);
                    }
                    let deadline_ns = deadline(r)?;
                    self.remaining_budget = self
                        .remaining_budget
                        .checked_sub(1)
                        .ok_or(AdmissionError::Overflow)?;
                    self.leases
                        .insert(p.surface_id.clone(), p.proposal_id.clone());
                    self.pending.insert(
                        p.proposal_id.clone(),
                        Pending {
                            request: r.clone(),
                            deadline_ns,
                            dispatched: false,
                            unknown: false,
                        },
                    );
                }
            }
            Input::Dispatch {
                proposal_id,
                now_ns,
            } => match self.pending.get(proposal_id).cloned() {
                None => out.reason = Some(Refusal::Policy),
                Some(p) => {
                    out.reason = if p.dispatched || p.unknown {
                        Some(Refusal::Policy)
                    } else {
                        self.check(&p.request, *now_ns, true)?
                    };
                    if out.reason.is_none() {
                        self.pending
                            .get_mut(proposal_id)
                            .ok_or(AdmissionError::InvalidInput)?
                            .dispatched = true;
                        out.dispatch = true;
                    } else if !p.dispatched && !p.unknown {
                        // A failed recheck consumes the old permit; require admission anew.
                        self.remove_pending(proposal_id);
                    }
                }
            },
            Input::DispatchFailed { proposal_id, epoch } => {
                if *epoch != self.epoch
                    || self
                        .pending
                        .get(proposal_id)
                        .is_none_or(|p| p.unknown || p.request.epoch != *epoch)
                {
                    out.reason = Some(Refusal::Policy);
                } else {
                    self.remove_pending(proposal_id);
                }
            }
            Input::Receipt { proposal_id, epoch } => {
                if self.pending.get(proposal_id).is_none_or(|p| {
                    *epoch != self.epoch || p.request.epoch != *epoch || !p.dispatched || p.unknown
                }) {
                    out.reason = Some(Refusal::Policy);
                } else {
                    self.remove_pending(proposal_id);
                }
            }
            Input::TakeControl { surface_id } => {
                let s = self
                    .surfaces
                    .get_mut(surface_id)
                    .ok_or(AdmissionError::InvalidInput)?;
                s.agent_controlled = false;
                s.refresh_after = Some(next);
                out.cancelled = self.cancel_surface(surface_id);
                out.control_ready = !self.draining.values().any(|sid| sid == surface_id);
                // Each cancelled proposal carries the typed takeover refusal.
                out.cancellation_reason = Some(Refusal::SurfaceNotAgentControlled);
            }
            Input::ReleaseControl { surface_id } => {
                if self.draining.values().any(|sid| sid == surface_id) {
                    out.reason = Some(Refusal::Policy);
                } else {
                    let s = self
                        .surfaces
                        .get_mut(surface_id)
                        .ok_or(AdmissionError::InvalidInput)?;
                    s.agent_controlled = true;
                    s.refresh_after = Some(next);
                }
            }
            Input::Drain { proposal_id, epoch } => {
                if *epoch != self.epoch {
                    out.reason = Some(Refusal::Policy);
                } else if let Some(surface_id) = self.draining.remove(proposal_id) {
                    if self.leases.get(&surface_id) == Some(proposal_id) {
                        self.leases.remove(&surface_id);
                    }
                    out.control_ready = !self.draining.values().any(|sid| sid == &surface_id);
                } else {
                    out.reason = Some(Refusal::Policy);
                }
            }
        }
        self.core_seq = next;
        Ok(out)
    }
    fn cancel_surface(&mut self, surface_id: &str) -> Vec<String> {
        let ids: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(id, p)| {
                p.request
                    .proposal()
                    .ok()
                    .filter(|p| p.surface_id == surface_id)
                    .map(|_| id.clone())
            })
            .collect();
        for id in &ids {
            if self
                .pending
                .get(id)
                .is_some_and(|p| p.dispatched || p.unknown)
            {
                self.draining.insert(id.clone(), surface_id.into());
                self.pending.remove(id);
            } else {
                self.remove_pending(id);
            }
        }
        ids
    }
    fn remove_pending(&mut self, id: &str) {
        if let Some(p) = self.pending.remove(id) {
            if let Ok(p) = p.request.proposal() {
                if self.leases.get(&p.surface_id).is_some_and(|v| v == id) {
                    self.leases.remove(&p.surface_id);
                }
            }
        }
    }
    fn check(
        &self,
        r: &AdmissionRequest,
        now: u64,
        dispatch: bool,
    ) -> Result<Option<Refusal>, AdmissionError> {
        let p = r.proposal()?;
        let Some(s) = self.surfaces.get(&p.surface_id) else {
            return Ok(Some(Refusal::StaleFrame));
        };
        let Some(f) = &s.frame else {
            return Ok(Some(Refusal::StaleFrame));
        };
        if !s.agent_controlled || !s.live || s.owner != r.envelope.from {
            return Ok(Some(Refusal::SurfaceNotAgentControlled));
        }
        if s.refresh_after.is_some()
            || f.sha256 != p.based_on_frame.sha256
            || f.generation != p.based_on_frame.generation
        {
            return Ok(Some(Refusal::StaleFrame));
        }
        let conflict = self.leases.iter().any(|(sid, id)| {
            (sid == &p.surface_id
                || self
                    .surfaces
                    .get(sid)
                    .is_some_and(|other| other.display == s.display))
                && (!dispatch || id != &p.proposal_id)
        });
        if conflict || (dispatch && self.leases.get(&p.surface_id) != Some(&p.proposal_id)) {
            return Ok(Some(Refusal::LockedByOther));
        }
        if (!dispatch && self.remaining_budget == 0)
            || deadline(r).is_err()
            || deadline(r).is_ok_and(|d| now >= d)
            || now < r.received_ns
        {
            return Ok(Some(Refusal::BudgetExceeded));
        }
        if let ActionProposalAction::Case4(a) = &p.action {
            if a.ms > p.budget.max_ms {
                return Ok(Some(Refusal::BudgetExceeded));
            }
        }
        // [TARGET, unit decision] Scroll deltas must fit a signed 32-bit executor
        // input before reservation or dispatch; bounds are inclusive.
        if let ActionProposalAction::Case3(a) = &p.action {
            if i32::try_from(a.dx).is_err() || i32::try_from(a.dy).is_err() {
                return Ok(Some(Refusal::OutOfBounds));
            }
        }
        if matches!(
            p.action,
            ActionProposalAction::Case3(_) | ActionProposalAction::Case4(_)
        ) {
            return Ok(Some(Refusal::Policy));
        }
        if let ActionProposalAction::Case0(a) = &p.action {
            if a.x >= f.width || a.y >= f.height {
                return Ok(Some(Refusal::OutOfBounds));
            }
        }
        if let ActionProposalExpectation::Case0(e) = &p.expectation {
            let b = &e.bbox;
            if b.w == 0
                || b.h == 0
                || b.x.checked_add(b.w).is_none_or(|x| x > f.width)
                || b.y.checked_add(b.h).is_none_or(|y| y > f.height)
            {
                return Ok(Some(Refusal::OutOfBounds));
            }
        }
        if r.epoch != self.epoch || self.epoch == 0 || r.envelope.from.component != Component::Agent
        {
            return Ok(Some(Refusal::Policy));
        }
        if let ActionProposalExpectation::Case2(e) = &p.expectation {
            if e.min_tick > e.max_tick {
                return Ok(Some(Refusal::Policy));
            }
        }
        if let ActionProposalAction::Case5(a) = &p.action {
            let key = lane_key(r, p)?;
            if !s.allowed_verbs.contains(&a.verb)
                || (!dispatch
                    && (self
                        .lane_nonces
                        .get(&key)
                        .is_some_and(|n| n.contains(&a.payload.nonce))
                        || self
                            .lane_sequences
                            .get(&key)
                            .is_some_and(|seq| a.payload.seq <= *seq)))
            {
                return Ok(Some(Refusal::Policy));
            }
        }
        Ok(None)
    }
}
fn lane_key(r: &AdmissionRequest, p: &ActionProposal) -> Result<String, AdmissionError> {
    serde_json::to_string(&(&r.envelope.from, &p.surface_id))
        .map_err(|_| AdmissionError::InvalidInput)
}
fn deadline(r: &AdmissionRequest) -> Result<u64, AdmissionError> {
    r.proposal()?
        .budget
        .max_ms
        .checked_mul(1_000_000)
        .and_then(|n| r.received_ns.checked_add(n))
        .ok_or(AdmissionError::Overflow)
}
fn validate_frame(f: &Frame) -> Result<(), AdmissionError> {
    if f.width == 0
        || f.height == 0
        || f.sha256.len() != 64
        || !f
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Err(AdmissionError::InvalidInput)
    } else {
        Ok(())
    }
}

/// [TARGET, unit decision] The serializer owns this handle; success follows
/// durable dependency publication and journal fsync, never merely a state plan.
pub struct Authority {
    state: CoreState,
    journal: crate::journal::Journal,
}
impl Authority {
    pub fn create(
        state_dir: &std::path::Path,
        state: CoreState,
    ) -> Result<Self, crate::journal::JournalError> {
        let journal = crate::journal::Journal::create(state_dir, &state)?;
        Ok(Self { state, journal })
    }
    pub fn recover(
        path: &std::path::Path,
        root: &std::path::Path,
    ) -> Result<Self, crate::journal::JournalError> {
        let (journal, state) = crate::journal::Journal::recover(path, root)?;
        Ok(Self { state, journal })
    }
    pub fn state(&self) -> &CoreState {
        &self.state
    }
    pub fn retain_witness(
        &mut self,
        bytes: &[u8],
    ) -> Result<crate::journal::Witness, crate::journal::JournalError> {
        self.journal.retain_witness(bytes)
    }
    pub fn retain_verified_witness(
        &mut self,
        sha256: &str,
        bytes: &[u8],
    ) -> Result<crate::journal::Witness, crate::journal::JournalError> {
        self.journal.retain_verified_witness(sha256, bytes)
    }
    pub fn retain_frame_witness(
        &mut self,
        sha256: &str,
        bytes: &[u8],
    ) -> Result<crate::journal::Witness, crate::journal::JournalError> {
        self.journal.retain_frame_witness(sha256, bytes)
    }
    pub fn flush_sync(&mut self) -> Result<(), crate::journal::JournalError> {
        self.journal.flush_sync()
    }
    pub fn admit(
        &mut self,
        request: AdmissionRequest,
        witnesses: Vec<crate::journal::Witness>,
    ) -> Result<crate::wire::payload::ActionVerdict, crate::journal::JournalError> {
        let proposal_id = request
            .proposal()
            .map_err(|_| crate::journal::JournalError::Invalid)?
            .proposal_id
            .clone();
        let out = self.apply_with_witnesses(Input::Propose(request), witnesses)?;
        let value = match out.reason {
            Some(reason) => {
                serde_json::json!({"schema":"action_verdict/v0.2","proposal_id":proposal_id,"decision":"refused","reason_code":reason,"core_seq":out.core_seq})
            }
            None => {
                serde_json::json!({"schema":"action_verdict/v0.2","proposal_id":proposal_id,"decision":"admitted","core_seq":out.core_seq})
            }
        };
        serde_json::from_value(value).map_err(|_| crate::journal::JournalError::Invalid)
    }
    pub fn apply(&mut self, input: Input) -> Result<Outcome, crate::journal::JournalError> {
        self.apply_with_witnesses(input, Vec::new())
    }
    pub fn apply_with_witnesses(
        &mut self,
        input: Input,
        witnesses: Vec<crate::journal::Witness>,
    ) -> Result<Outcome, crate::journal::JournalError> {
        let mut next = self.state.clone();
        let out = next
            .apply(&input)
            .map_err(|_| crate::journal::JournalError::Invalid)?;
        self.journal.append(&input, &out, &next, witnesses)?;
        self.state = next;
        Ok(out)
    }
}
