//! [TARGET, unit decision] Tool read views are rebuilt from committed boundary
//! witnesses; authority state fences every observation and owns control/liveness.
//! List cursors are exclusive surface IDs in lexical order. Results echo envelope
//! msg_id, as required by mv_tool_result. Nested payloads retain their v0.2
//! contract tags and field sets. SurfaceNotice journals read calls.
//! Waits hold no authority lock, resolve cancellations (including draining work),
//! and expire with a typed timeout. List returns live surfaces only; dead views
//! and layout overrides are pruned against authority on lifecycle/recovery.
//! [TARGET, unit decision] Native focus and timing gate core-owned pixel
//! expectation verification. Missing semantic capture witnesses fail closed.
//! [TARGET, unit decision] Daemon observation/v0.2 envelopes with ground_truth
//! source holdings_lane are accepted only for the committed frame of a live
//! surface with a dispatched agent-origin proposal, joined to that frame and
//! proposal waiter, and exposed by observe; Case2 (state_sha256_change) invokes
//! verify_receipt and fails closed when witness checks fail or canonical state
//! JSON bytes are absent from capsule output.
use super::*;
use crate::wire::payload::{ActionVerdict, MvToolCall};
use serde_json::{json, Value};
use std::collections::VecDeque;

#[path = "canonical.rs"]
pub(crate) mod canonical;

// [TARGET, unit decision] Retain the latest 128 receipts by arrival, including replay.
const RECEIPT_CAP: usize = 128;
// [TARGET, unit decision] Bound unsettled proposal witness joins in arrival order.
const PROPOSAL_WITNESS_CAP: usize = 128;
// [TARGET, unit decision] Bound per-surface frame witness history for based_on_frame joins.
const FRAME_WITNESS_CAP: usize = 16;
// [TARGET, unit decision] Bound tool-view tombstones in arrival order; authority
// owns permanent non-revival on the wire, and eviction never drops a prefixed
// tombstone whose stripped surface ID is still live in `surfaces`.
const DESTROYED_CAP: usize = 128;

type ProposalWitness = (Option<Value>, Option<(Value, Value)>);

fn is_dispatched_current_epoch_agent_pending(
    state: &CoreState,
    pid: &str,
    surface_id: Option<&str>,
) -> bool {
    let Some(pending) = state.pending.get(pid) else {
        return false;
    };
    let Ok(val) = serde_json::to_value(pending) else {
        return false;
    };
    val["dispatched"].as_bool() == Some(true)
        && val["unknown"].as_bool() == Some(false)
        && val["request"]["epoch"].as_u64() == Some(state.epoch)
        && val["request"]["envelope"]["from"]["component"].as_str() == Some("agent")
        && surface_id.is_none_or(|sid| {
            val["request"]["envelope"]["body"]["surface_id"].as_str() == Some(sid)
        })
}

#[derive(Default)]
pub(super) struct ToolState {
    pub(super) surfaces: BTreeMap<String, Value>,
    destroyed: BTreeSet<String>,
    destroyed_order: VecDeque<String>,
    frames: BTreeMap<String, Value>,
    ground_truths: BTreeMap<String, VecDeque<(u64, String, Value)>>,
    proposal_witnesses: BTreeMap<String, ProposalWitness>,
    proposal_witness_order: VecDeque<String>,
    receipts: BTreeMap<String, Value>,
    pub(super) verification_contexts: BTreeMap<String, (Value, Value)>,
    waiters: Vec<Waiter>,
    receipt_order: VecDeque<String>,
    layout: BTreeMap<String, String>,
    pub(super) placements: BTreeMap<String, super::layout::Placement>,
}
struct Waiter {
    peer: Endpoint,
    request_id: String,
    proposal_id: String,
    deadline: Instant,
}
impl ToolState {
    pub(super) fn retain(&mut self, body: &Command) {
        let value = match serde_json::to_value(body) {
            Ok(value) => value,
            Err(_) => return,
        };
        match body {
            Command::SurfaceEvent(event) => match event.as_ref() {
                SurfaceEvent::Case0(_) | SurfaceEvent::Case1(_) => {
                    let surface = &value["data"]["surface"];
                    if let Some(id) = surface["surface_id"].as_str() {
                        if matches!(surface["state"].as_str(), Some("destroyed" | "lost")) {
                            self.surfaces.remove(id);
                            self.frames.remove(id);
                            self.clear_surface_ground_truth(id);
                            self.layout.remove(id);
                            self.placements.remove(id);
                            if surface["state"].as_str() == Some("destroyed") {
                                self.record_destroyed(id);
                            } else {
                                self.evict_destroyed();
                            }
                        } else if !self.destroyed.contains(id) {
                            let mut surface = surface.clone();
                            if matches!(event.as_ref(), SurfaceEvent::Case1(_)) {
                                if let Some(visibility) = self.layout.get(id) {
                                    surface["visibility"] = visibility.clone().into();
                                }
                            }
                            self.surfaces.insert(id.to_owned(), surface);
                        }
                    }
                }
                SurfaceEvent::Case2(_) => self.retain_frame(&value["data"]["frame_ref"]),
                _ => {}
            },
            Command::FrameRef(_) => self.retain_frame(&value),
            Command::Observation(obs) => {
                if obs.vision.is_missing() {
                    if let crate::wire::Optional::Present(gt) = &obs.ground_truth {
                        if gt.source == crate::wire::payload::ObservationGroundTruthSource::Value {
                            let sid = &obs.frame_ref.surface_id;
                            if let (Ok(frame_val), Ok(gt_val)) = (
                                serde_json::to_value(&obs.frame_ref),
                                serde_json::to_value(gt),
                            ) {
                                let matches_current = self
                                    .frames
                                    .get(sid)
                                    .is_some_and(|cur| frame_matches_committed(cur, &frame_val));
                                if matches_current {
                                    self.frames.insert(sid.clone(), frame_val.clone());
                                    let ring = self.ground_truths.entry(sid.clone()).or_default();
                                    ring.retain(|(gen, sha, _)| {
                                        !(*gen == obs.frame_ref.generation
                                            && *sha == obs.frame_ref.sha256)
                                    });
                                    ring.push_back((
                                        obs.frame_ref.generation,
                                        obs.frame_ref.sha256.clone(),
                                        gt_val.clone(),
                                    ));
                                    while ring.len() > FRAME_WITNESS_CAP {
                                        ring.pop_front();
                                    }
                                    let active_ids: Vec<String> = self
                                        .verification_contexts
                                        .iter()
                                        .filter(|(pid, (action, _))| {
                                            !self.receipts.contains_key(*pid)
                                                && action["surface_id"].as_str()
                                                    == Some(sid.as_str())
                                        })
                                        .map(|(pid, _)| pid.clone())
                                        .collect();
                                    for pid in active_ids {
                                        let is_based_on_frame = self
                                            .verification_contexts
                                            .get(&pid)
                                            .is_some_and(|(action, _)| {
                                                action["based_on_frame"]["generation"].as_u64()
                                                    == Some(obs.frame_ref.generation)
                                                    && action["based_on_frame"]["sha256"].as_str()
                                                        == Some(obs.frame_ref.sha256.as_str())
                                            });
                                        if is_based_on_frame {
                                            if let Some((_, before_frame)) =
                                                self.verification_contexts.get_mut(&pid)
                                            {
                                                *before_frame = frame_val.clone();
                                            }
                                            if let Some(entry) =
                                                self.proposal_witnesses.get_mut(&pid)
                                            {
                                                entry.0 = Some(gt_val.clone());
                                            }
                                        } else if let Some(entry) =
                                            self.proposal_witnesses.get_mut(&pid)
                                        {
                                            entry.1 = Some((frame_val.clone(), gt_val.clone()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Command::ActionProposal(proposal) => self.retain_proposal(proposal),
            Command::MvToolCall(call) => {
                if let MvToolCall::Case2(call) = call.as_ref() {
                    self.retain_proposal(&call.args.proposal);
                }
            }
            Command::ActionReceipt(receipt) => {
                let id = &receipt.proposal_id;
                self.receipt_order.retain(|old| old != id);
                self.receipt_order.push_back(id.clone());
                self.receipts.insert(id.clone(), value);
                while self.receipt_order.len() > RECEIPT_CAP {
                    if let Some(old) = self.receipt_order.pop_front() {
                        self.receipts.remove(&old);
                        self.verification_contexts.remove(&old);
                        self.proposal_witnesses.remove(&old);
                        self.proposal_witness_order.retain(|pid| pid != &old);
                    }
                }
            }
            Command::UiIntent(_) => {
                if value["op"].as_str() == Some("take_control") {
                    if let Some(sid) = value["params"]["surface_id"].as_str() {
                        self.clear_surface_ground_truth(sid);
                    }
                }
                if let (Some(id), Some(op)) =
                    (value["params"]["slot_id"].as_str(), value["op"].as_str())
                {
                    let id = self.slot_surface(id).to_owned();
                    if let Ok(next) = self.placement_change(&id, &value) {
                        self.placements.insert(id.clone(), next);
                    }
                    let visibility = match op {
                        "fold" => Some("folded"),
                        "unfold" => Some("unfolded"),
                        _ => None,
                    };
                    if let (Some(surface), Some(visibility)) =
                        (self.surfaces.get_mut(&id), visibility)
                    {
                        surface["visibility"] = visibility.into();
                        self.layout.insert(id.to_owned(), visibility.to_owned());
                    }
                }
            }
            _ => {}
        }
    }
    pub(super) fn ground_truth_for_frame(
        &self,
        surface_id: &str,
        generation: u64,
        sha256: &str,
    ) -> Option<&Value> {
        self.ground_truths
            .get(surface_id)?
            .iter()
            .find_map(|(gen, sha, gt)| (*gen == generation && sha == sha256).then_some(gt))
    }
    pub(super) fn evict_proposal(&mut self, proposal_id: &str) {
        if !self.receipts.contains_key(proposal_id) {
            self.verification_contexts.remove(proposal_id);
            self.proposal_witnesses.remove(proposal_id);
            self.proposal_witness_order.retain(|id| id != proposal_id);
        }
    }
    pub(super) fn clear_surface_ground_truth(&mut self, surface_id: &str) {
        self.ground_truths.remove(surface_id);
        let stale_ids: Vec<String> = self
            .verification_contexts
            .iter()
            .filter(|(pid, (action, _))| {
                !self.receipts.contains_key(*pid)
                    && action["surface_id"].as_str() == Some(surface_id)
            })
            .map(|(pid, _)| pid.clone())
            .collect();
        for pid in stale_ids {
            self.evict_proposal(&pid);
        }
    }
    pub(super) fn retain_proposal(&mut self, proposal: &crate::wire::payload::ActionProposal) {
        if let Some(frame) = self.frames.get(&proposal.surface_id).cloned() {
            if let Ok(value) = serde_json::to_value(proposal) {
                let stale_ids: Vec<String> = self
                    .verification_contexts
                    .iter()
                    .filter(|(pid, (action, _))| {
                        *pid != &proposal.proposal_id
                            && !self.receipts.contains_key(*pid)
                            && action["surface_id"].as_str() == Some(proposal.surface_id.as_str())
                    })
                    .map(|(pid, _)| pid.clone())
                    .collect();
                for pid in stale_ids {
                    self.evict_proposal(&pid);
                }
                let before_gt = self
                    .ground_truth_for_frame(
                        &proposal.surface_id,
                        proposal.based_on_frame.generation,
                        &proposal.based_on_frame.sha256,
                    )
                    .cloned();
                self.verification_contexts
                    .insert(proposal.proposal_id.clone(), (value, frame));
                self.proposal_witnesses
                    .insert(proposal.proposal_id.clone(), (before_gt, None));
                self.proposal_witness_order
                    .retain(|old| old != &proposal.proposal_id);
                self.proposal_witness_order
                    .push_back(proposal.proposal_id.clone());
                while self.proposal_witnesses.len() > PROPOSAL_WITNESS_CAP {
                    let Some(pos) = self
                        .proposal_witness_order
                        .iter()
                        .position(|cand| !self.receipts.contains_key(cand))
                        .or(if self.proposal_witness_order.is_empty() {
                            None
                        } else {
                            Some(0)
                        })
                    else {
                        break;
                    };
                    if let Some(old) = self.proposal_witness_order.remove(pos) {
                        self.proposal_witnesses.remove(&old);
                        if !self.receipts.contains_key(&old) {
                            self.verification_contexts.remove(&old);
                        }
                    }
                }
            }
        }
    }
    pub(super) fn verify_daemon_receipt(
        &self,
        receipt: &crate::wire::payload::ActionReceipt,
        root: &std::path::Path,
    ) -> Option<Value> {
        let (action, before) = self.verification_contexts.get(&receipt.proposal_id)?;
        let receipt_val = serde_json::to_value(receipt).ok()?;
        let witness = self.proposal_witnesses.get(&receipt.proposal_id);
        verified_native_fields_with_witness(
            action,
            before,
            &receipt_val,
            witness,
            &root.join("artifacts"),
        )
    }
    fn case2_witness_detail(
        &self,
        proposal_id: &str,
        receipt: &crate::wire::payload::ActionReceipt,
        root: &std::path::Path,
    ) -> Option<String> {
        use crate::wire::payload::{
            ActionProposal, ActionProposalExpectation, FrameRef, ObservationGroundTruth,
        };
        let (action, before_frame) = self.verification_contexts.get(proposal_id)?;
        let p: ActionProposal = serde_json::from_value(action.clone()).ok()?;
        let ActionProposalExpectation::Case2(want) = &p.expectation else {
            return None;
        };
        let Some((before_gt_val, Some((witness_frame_val, after_gt_val)))) =
            self.proposal_witnesses.get(proposal_id)
        else {
            return Some("missing holdings_lane ground_truth witness".into());
        };
        let Ok(witness_frame) = serde_json::from_value::<FrameRef>(witness_frame_val.clone())
        else {
            return Some("witness bound to foreign frame or surface".into());
        };
        let Ok(after_gt) = serde_json::from_value::<ObservationGroundTruth>(after_gt_val.clone())
        else {
            return Some("missing holdings_lane ground_truth witness".into());
        };
        let after_frame_val = serde_json::to_value(&receipt.after_frame).ok()?;
        if witness_frame.surface_id != p.surface_id
            || receipt.after_frame.surface_id != p.surface_id
            || !frame_matches_committed(witness_frame_val, &after_frame_val)
            || receipt.after_frame.generation <= p.based_on_frame.generation
        {
            return Some("witness bound to foreign frame or surface".into());
        }
        let before_gt = before_gt_val
            .as_ref()
            .and_then(|v| serde_json::from_value::<ObservationGroundTruth>(v.clone()).ok());
        if let Some(bgt) = &before_gt {
            if bgt.state_sha256 != want.before {
                return Some(
                    "before ground_truth state_sha256 does not match expectation.before".into(),
                );
            }
        }
        if after_gt.state_sha256 == want.before {
            return Some("state_sha256 unchanged from before digest".into());
        }
        if want.min_tick > want.max_tick
            || !(want.min_tick..=want.max_tick).contains(&after_gt.tick)
            || before_gt
                .as_ref()
                .is_some_and(|bgt| after_gt.tick <= bgt.tick)
        {
            return Some("witness tick outside expectation window".into());
        }
        let artifacts = root.join("artifacts");
        let has_state_artifacts = before_gt.as_ref().is_some_and(|bgt| {
            artifacts.join(&bgt.state_sha256).is_file()
                && artifacts.join(&after_gt.state_sha256).is_file()
        });
        if !has_state_artifacts {
            return Some(
                "holdings_lane witness joined; canonical state JSON bytes absent from capsule output"
                    .into(),
            );
        }
        if witness_frame != receipt.after_frame
            || receipt.after_frame.tick != after_gt.tick
            || before_gt
                .as_ref()
                .is_some_and(|bgt| before_frame["tick"].as_u64() != Some(bgt.tick))
        {
            return Some("witness tick does not match frame_ref.tick".into());
        }
        None
    }
    fn case2_wait_detail(&self, proposal_id: &str, root: &std::path::Path) -> Option<String> {
        let receipt_val = self.receipts.get(proposal_id)?;
        let receipt: crate::wire::payload::ActionReceipt =
            serde_json::from_value(receipt_val.clone()).ok()?;
        self.case2_witness_detail(proposal_id, &receipt, root)
    }
    pub(super) fn recompute_daemon_receipt(
        &self,
        receipt: &crate::wire::payload::ActionReceipt,
        root: &std::path::Path,
    ) -> crate::wire::payload::ActionReceipt {
        use crate::wire::payload::{
            ActionProposal, ActionProposalExpectation, ActionReceiptVerification,
            ActionReceiptVerificationMethod,
        };
        let mut recomputed = receipt.clone();
        let method = self
            .verification_contexts
            .get(&receipt.proposal_id)
            .and_then(|(action, _)| serde_json::from_value::<ActionProposal>(action.clone()).ok())
            .map(|p| match p.expectation {
                ActionProposalExpectation::Case0(_) => ActionReceiptVerificationMethod::Pixel,
                ActionProposalExpectation::Case1(_) | ActionProposalExpectation::Case3(_) => {
                    ActionReceiptVerificationMethod::Element
                }
                ActionProposalExpectation::Case2(_) => ActionReceiptVerificationMethod::StateSha256,
            })
            .unwrap_or_else(|| receipt.verification.method.clone());
        let is_case2 = method == ActionReceiptVerificationMethod::StateSha256;
        let case2_detail = self.case2_witness_detail(&receipt.proposal_id, receipt, root);
        if !receipt.verified && !is_case2 {
            if recomputed.verification.method != method || case2_detail.is_some() {
                recomputed.verification = ActionReceiptVerification {
                    method,
                    detail: case2_detail
                        .unwrap_or_else(|| "missing, invalid or unmatched witness".into()),
                };
            }
            return recomputed;
        }
        recomputed.verified = false;
        let verified_fields = if receipt.error.is_empty() {
            self.verify_daemon_receipt(receipt, root)
        } else {
            None
        };
        if let Some(fields) = verified_fields {
            recomputed.verified = true;
            if let Ok(verification) =
                serde_json::from_value(fields["receipt"]["verification"].clone())
            {
                recomputed.verification = verification;
            } else {
                recomputed.verification = ActionReceiptVerification {
                    method,
                    detail: "frame-bound witness matched".into(),
                };
            }
        } else {
            recomputed.verification = ActionReceiptVerification {
                method,
                detail: case2_detail
                    .unwrap_or_else(|| "missing, invalid or unmatched witness".into()),
            };
        }
        recomputed
    }
    fn record_destroyed(&mut self, id: &str) {
        self.destroyed_order.retain(|old| old != id);
        self.destroyed_order.push_back(id.to_owned());
        self.destroyed.insert(id.to_owned());
        self.evict_destroyed();
    }
    fn evict_destroyed(&mut self) {
        while self.destroyed_order.len() > DESTROYED_CAP {
            let Some(pos) = self.destroyed_order.iter().position(|cand| {
                !cand
                    .strip_prefix("cuk-ai-slot-")
                    .is_some_and(|base| self.surfaces.contains_key(base))
            }) else {
                break;
            };
            if let Some(evicted) = self.destroyed_order.remove(pos) {
                self.destroyed.remove(&evicted);
            }
        }
    }
    pub(super) fn has_surface(&self, id: &str) -> bool {
        self.surfaces.contains_key(id)
    }
    pub(super) fn is_destroyed_surface(&self, id: &str) -> bool {
        self.destroyed.contains(id)
    }
    pub(super) fn layout_visibility(&self, id: &str) -> Option<String> {
        self.layout.get(id).cloned()
    }
    pub(super) fn surface_event(&self, id: &str, state: &CoreState) -> Option<Command> {
        let mut surface = self.surfaces.get(id)?.clone();
        surface["control"] = if state.surfaces.get(id)?.agent_controlled {
            "agent"
        } else {
            "human"
        }
        .into();
        let event = serde_json::from_value(json!({"schema":"surface_event/v0.2",
            "event":"state_changed","data":{"surface":surface}}))
        .ok()?;
        Some(Command::SurfaceEvent(Box::new(event)))
    }
    pub(super) fn terminal_surface_event(
        surface: &crate::wire::payload::Surface,
        state: &CoreState,
        visibility_override: Option<&str>,
    ) -> Option<Command> {
        let mut surface_val = serde_json::to_value(surface).ok()?;
        let id = surface.surface_id.as_str();
        if let Some(auth) = state.surfaces.get(id) {
            surface_val["control"] = if auth.agent_controlled {
                "agent"
            } else {
                "human"
            }
            .into();
        }
        if let Some(visibility) = visibility_override {
            surface_val["visibility"] = visibility.into();
        }
        let event = serde_json::from_value(json!({
            "schema": "surface_event/v0.2",
            "event": "state_changed",
            "data": { "surface": surface_val }
        }))
        .ok()?;
        Some(Command::SurfaceEvent(Box::new(event)))
    }
    pub(super) fn prune(&mut self, state: &CoreState) {
        let dead: Vec<String> = self
            .surfaces
            .keys()
            .filter(|id| state.is_destroyed(id))
            .cloned()
            .collect();
        let live = |id: &String| state.surfaces.get(id).is_some_and(|s| s.live);
        self.surfaces.retain(|id, _| live(id));
        self.frames.retain(|id, _| live(id));
        self.ground_truths.retain(|id, _| live(id));
        self.layout.retain(|id, _| live(id));
        self.placements.retain(|id, _| live(id));
        self.verification_contexts.retain(|id, _| {
            is_dispatched_current_epoch_agent_pending(state, id, None)
                || self.receipts.contains_key(id)
        });
        self.proposal_witnesses.retain(|id, _| {
            is_dispatched_current_epoch_agent_pending(state, id, None)
                || self.receipts.contains_key(id)
        });
        self.proposal_witness_order
            .retain(|id| self.proposal_witnesses.contains_key(id));
        for id in dead {
            self.record_destroyed(&id);
        }
        self.evict_destroyed();
    }
    fn retain_frame(&mut self, frame: &Value) {
        if let Some(id) = frame["surface_id"].as_str() {
            if self.surfaces.contains_key(id) {
                self.frames.insert(id.to_owned(), frame.clone());
            }
        }
    }
    pub(super) fn remove_peer(&mut self, peer: &Endpoint) {
        self.waiters.retain(|w| &w.peer != peer);
    }
}
fn frame_matches_committed(committed: &Value, candidate: &Value) -> bool {
    if committed == candidate {
        return true;
    }
    let mut a = committed.clone();
    let mut b = candidate.clone();
    if let (Some(ao), Some(bo)) = (a.as_object_mut(), b.as_object_mut()) {
        ao.remove("tick");
        bo.remove("tick");
        return ao == bo;
    }
    false
}

impl Server {
    pub(super) fn accept_daemon_observation(
        &self,
        obs: &crate::wire::payload::Observation,
    ) -> bool {
        if !obs.vision.is_missing() {
            return false;
        }
        let crate::wire::Optional::Present(gt) = &obs.ground_truth else {
            return false;
        };
        if gt.source != crate::wire::payload::ObservationGroundTruthSource::Value {
            return false;
        }
        let sid = &obs.frame_ref.surface_id;
        let state = self.authority.state();
        if state.is_destroyed(sid) {
            return false;
        }
        let Some(surface) = state.surfaces.get(sid) else {
            return false;
        };
        if !surface.live || !surface.agent_controlled {
            return false;
        }
        let Some(current) = &surface.frame else {
            return false;
        };
        if current.sha256 != obs.frame_ref.sha256
            || current.generation != obs.frame_ref.generation
            || current.width != obs.frame_ref.width
            || current.height != obs.frame_ref.height
        {
            return false;
        }
        let Ok(frame_val) = serde_json::to_value(&obs.frame_ref) else {
            return false;
        };
        if !self
            .tool_state
            .frames
            .get(sid)
            .is_some_and(|cur| frame_matches_committed(cur, &frame_val))
        {
            return false;
        }
        if self.human_inputs.values().any(|h| h.surface_id == *sid) {
            return false;
        }
        self.tool_state
            .verification_contexts
            .iter()
            .any(|(pid, (action, _))| {
                !self.tool_state.receipts.contains_key(pid)
                    && action["surface_id"].as_str() == Some(sid.as_str())
                    && is_dispatched_current_epoch_agent_pending(state, pid, Some(sid.as_str()))
            })
    }
    pub(super) fn accept_and_retain_daemon_observation(
        &mut self,
        obs: &crate::wire::payload::Observation,
        boundary: Witness,
    ) -> Result<Option<Vec<Witness>>> {
        if !self.accept_daemon_observation(obs) {
            return Ok(None);
        }
        let crate::wire::Optional::Present(gt) = &obs.ground_truth else {
            return Ok(None);
        };
        let state_bytes =
            match self.read_holdings_state_sidecar(&obs.frame_ref.ramws_path, &gt.state_sha256) {
                Ok(bytes) => bytes,
                Err(()) => return Ok(None),
            };
        let mut witnesses = vec![boundary];
        if let Some(canonical_bytes) = state_bytes {
            let w_state = self.authority.retain_witness(&canonical_bytes)?;
            witnesses.push(w_state);
        }
        Ok(Some(witnesses))
    }
    fn read_holdings_state_sidecar(
        &self,
        ramws_path: &str,
        expected_sha256: &str,
    ) -> std::result::Result<Option<Vec<u8>>, ()> {
        let frame_path = Path::new(ramws_path);
        let Some(parent) = frame_path.parent() else {
            return Err(());
        };
        let Some(name) = frame_path.file_name().and_then(|n| n.to_str()) else {
            return Err(());
        };
        let mut candidates = vec![parent.join(format!(".state-{name}"))];
        if let Some(grandparent) = parent.parent() {
            if grandparent.starts_with("/dev/shm") {
                candidates.push(grandparent.join(format!(".state-{name}")));
            }
        }
        let uid = effective_uid().map_err(|_| ())?;
        let mut found: Option<Vec<u8>> = None;
        for cand in &candidates {
            let Ok((_dir, anchored)) = Self::open_anchored_shm_dir(Path::new("/dev/shm"), cand)
            else {
                return Err(());
            };
            let before = match fs::symlink_metadata(&anchored) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(()),
            };
            if !before.is_file()
                || before.file_type().is_symlink()
                || before.uid() != uid
                || (before.mode() & 0o077) != 0
                || before.len() == 0
                || before.len() > canonical::MAX_STATE_BYTES as u64
            {
                return Err(());
            }
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(frame_open_flags().map_err(|_| ())?)
                .open(&anchored)
                .map_err(|_| ())?;
            let meta = file.metadata().map_err(|_| ())?;
            if !meta.is_file()
                || before.dev() != meta.dev()
                || before.ino() != meta.ino()
                || meta.uid() != uid
                || (meta.mode() & 0o077) != 0
                || meta.len() != before.len()
            {
                return Err(());
            }
            let mut raw = Vec::with_capacity(meta.len() as usize);
            (&file)
                .take(canonical::MAX_STATE_BYTES as u64 + 1)
                .read_to_end(&mut raw)
                .map_err(|_| ())?;
            if raw.len() as u64 != meta.len() || raw.len() > canonical::MAX_STATE_BYTES {
                return Err(());
            }
            let after = file.metadata().map_err(|_| ())?;
            if !after.is_file()
                || after.dev() != meta.dev()
                || after.ino() != meta.ino()
                || after.uid() != uid
                || (after.mode() & 0o077) != 0
                || after.len() != meta.len()
            {
                return Err(());
            }
            let canonical_bytes =
                canonical::canonicalise_and_verify_state(&raw, expected_sha256).map_err(|_| ())?;
            if found.is_some() {
                return Err(());
            }
            found = Some(canonical_bytes);
        }
        Ok(found)
    }
    fn tool_result(&mut self, peer: &Endpoint, id: &str, op: &str, fields: Value) -> Result<()> {
        let mut value = json!({"schema":"mv_tool_result/v0.2","request_id":id,"op":op});
        value
            .as_object_mut()
            .ok_or_else(|| invalid("tool result"))?
            .extend(
                fields
                    .as_object()
                    .ok_or_else(|| invalid("tool fields"))?
                    .clone(),
            );
        self.send(
            peer,
            Command::MvToolResult(Box::new(serde_json::from_value(value)?)),
        )
    }
    fn tool_error(&mut self, env: &Envelope, op: &str, code: &str, detail: &str) -> Result<()> {
        self.tool_result(
            &env.from,
            &env.msg_id,
            op,
            json!({"status":"error","code":code,"detail":detail}),
        )
    }
    pub(super) fn tool_call(
        &mut self,
        peer: &ReadyPeer,
        _epoch: u64,
        env: &Envelope,
        call: &MvToolCall,
        boundary: Witness,
    ) -> Result<()> {
        if let MvToolCall::Case2(call) = call {
            // Reuse closed admission decoding and all reservation/dispatch gates.
            let mut proposal_env = env.clone();
            proposal_env.body = Command::ActionProposal(Box::new(call.args.proposal.clone()));
            return self.admit_proposal(
                peer,
                &proposal_env,
                &call.args.proposal,
                boundary,
                Some(&env.msg_id),
            );
        }
        self.authority
            .apply_with_witnesses(Input::SurfaceNotice, vec![boundary])?;
        match call {
            MvToolCall::Case0(call) => {
                let sid = &call.args.surface_id;
                let Some(surface) = self.authority.state().surfaces.get(sid) else {
                    return self.tool_error(env, "observe", "NOT_FOUND", "Unknown surface");
                };
                if !surface.live {
                    return self.tool_error(env, "observe", "UNAVAILABLE", "Surface is not live");
                }
                let Some(frame) = self.tool_state.frames.get(sid).cloned().filter(|frame| {
                    surface.frame.as_ref().is_some_and(|current| {
                        frame["sha256"] == current.sha256
                            && frame["generation"] == current.generation
                    })
                }) else {
                    return self.tool_error(env, "observe", "UNAVAILABLE", "No current frame");
                };
                let mut observation = json!({"schema":"observation/v0.2","frame_ref":frame});
                if surface.agent_controlled
                    && !self.human_inputs.values().any(|h| h.surface_id == *sid)
                {
                    if let Some(current) = &surface.frame {
                        if let Some(gt) = self.tool_state.ground_truth_for_frame(
                            sid,
                            current.generation,
                            &current.sha256,
                        ) {
                            observation["ground_truth"] = gt.clone();
                        }
                    }
                }
                self.tool_result(
                    &env.from,
                    &env.msg_id,
                    "observe",
                    json!({"status":"ok","observation":observation}),
                )
            }
            MvToolCall::Case1(call) => {
                let cursor = match &call.args.cursor {
                    crate::wire::payload::MvToolCallCase1ArgsCursor::Case0(id) => Some(id.as_str()),
                    crate::wire::payload::MvToolCallCase1ArgsCursor::Case1(()) => None,
                };
                let mut entries = Vec::new();
                let mut next = Value::Null;
                for (id, state) in &self.authority.state().surfaces {
                    if !state.live {
                        continue;
                    }
                    if cursor.is_some_and(|cursor| id.as_str() <= cursor) {
                        continue;
                    }
                    if entries.len() == call.args.limit as usize {
                        next = entries
                            .last()
                            .map(|s: &Value| s["surface_id"].clone())
                            .unwrap_or(Value::Null);
                        break;
                    }
                    let Some(mut surface) = self.tool_state.surfaces.get(id).cloned() else {
                        return self.tool_error(
                            env,
                            "list",
                            "UNAVAILABLE",
                            "Missing surface metadata",
                        );
                    };
                    // Metadata cannot reverse authority's human takeover fence.
                    surface["control"] = if state.agent_controlled {
                        "agent"
                    } else {
                        "human"
                    }
                    .into();
                    entries.push(surface);
                }
                self.tool_result(
                    &env.from,
                    &env.msg_id,
                    "list",
                    json!({"status":"ok","surfaces":entries,"next_cursor":next}),
                )
            }
            MvToolCall::Case3(call) => {
                let id = &call.args.proposal_id;
                if !self.tool_state.receipts.contains_key(id)
                    && !self.authority.state().pending.contains_key(id)
                    && !self.authority.state().draining.contains_key(id)
                {
                    return self.tool_error(env, "wait_verify", "NOT_FOUND", "Unknown proposal");
                }
                if self
                    .tool_state
                    .waiters
                    .iter()
                    .filter(|w| w.peer == env.from)
                    .count()
                    >= MAX_SEND_QUEUE
                {
                    return self.tool_error(
                        env,
                        "wait_verify",
                        "UNAVAILABLE",
                        "Too many pending waits",
                    );
                }
                self.tool_state.waiters.push(Waiter {
                    peer: env.from.clone(),
                    request_id: env.msg_id.clone(),
                    proposal_id: id.clone(),
                    deadline: Instant::now() + Duration::from_millis(call.args.timeout_ms),
                });
                self.poll_tool_waiters()
            }
            MvToolCall::Case2(_) => unreachable!("propose handled above"),
        }
    }
    pub(super) fn poll_tool_waiters(&mut self) -> Result<()> {
        let now = Instant::now();
        let mut ready = Vec::new();
        let receipts = &self.tool_state.receipts;
        let pending = &self.authority.state().pending;
        self.tool_state.waiters.retain(|waiter| {
            if receipts.contains_key(&waiter.proposal_id)
                || !pending.contains_key(&waiter.proposal_id)
                || now >= waiter.deadline
            {
                ready.push((
                    waiter.peer.clone(),
                    waiter.request_id.clone(),
                    waiter.proposal_id.clone(),
                ));
                false
            } else {
                true
            }
        });
        for (peer, request, proposal) in ready {
            let fields = if self.tool_state.receipts.contains_key(&proposal) {
                let witness = self.tool_state.proposal_witnesses.get(&proposal);
                self.tool_state
                    .verification_contexts
                    .get(&proposal)
                    .and_then(|(action, before)| {
                        verified_native_fields_with_witness(
                            action,
                            before,
                            &self.tool_state.receipts[&proposal],
                            witness,
                            &self.root.join("artifacts"),
                        )
                    })
                    .unwrap_or_else(|| {
                        let detail = self
                            .tool_state
                            .case2_wait_detail(&proposal, &self.root)
                            .unwrap_or_else(|| {
                                if self.tool_state.receipts[&proposal]
                                    .get("native_evidence")
                                    .is_none()
                                {
                                    "Receipt settled execution; focus proof and input_mono_ns are absent"
                                        .into()
                                } else {
                                    "Missing, stale or unmatched native/frame evidence".into()
                                }
                            });
                        json!({"status":"error","code":"VERIFICATION_FAILED","detail":detail})
                    })
            } else if !self.authority.state().pending.contains_key(&proposal) {
                self.tool_state.evict_proposal(&proposal);
                json!({"status":"error","code":"UNAVAILABLE","detail":"Proposal cancelled"})
            } else {
                json!({"status":"timeout","proposal_id":proposal,"verified":false})
            };
            // A failed reader must not prevent receipt settlement or another waiter.
            if let Err(error) = self.tool_result(&peer, &request, "wait_verify", fields) {
                if error.downcast_ref::<SendFailure>().is_none() {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    pub(super) fn proposal_verdict(
        &mut self,
        env: &Envelope,
        tool: Option<&str>,
        verdict: ActionVerdict,
    ) -> Result<()> {
        if serde_json::to_value(&verdict)?["decision"] == "admitted" {
            if let Command::ActionProposal(proposal) = &env.body {
                self.tool_state.prune(self.authority.state());
                self.tool_state.retain_proposal(proposal);
            }
        }
        if let Some(id) = tool {
            let value = serde_json::to_value(&verdict)?;
            if value["decision"] == "admitted" {
                self.tool_result(
                    &env.from,
                    id,
                    "propose",
                    json!({"status":"admitted","verdict":value}),
                )
            } else {
                self.tool_result(
                    &env.from,
                    id,
                    "propose",
                    json!({"status":"refused",
                    "reason_code":value["reason_code"],"detail":"Admission refused"}),
                )
            }
        } else {
            self.send(&env.from, Command::ActionVerdict(Box::new(verdict)))
        }
    }
    pub(super) fn proposal_refusal(
        &mut self,
        env: &Envelope,
        tool: Option<&str>,
        reason: Refusal,
        boundary: Witness,
    ) -> Result<()> {
        let out = self
            .authority
            .apply_with_witnesses(Input::Refuse { reason }, vec![boundary])?;
        self.proposal_dispatch_refusal(env, tool, &env.msg_id, reason, out.core_seq)
    }
    pub(super) fn proposal_dispatch_refusal(
        &mut self,
        env: &Envelope,
        tool: Option<&str>,
        proposal: &str,
        reason: Refusal,
        seq: u64,
    ) -> Result<()> {
        if let Some(id) = tool {
            self.tool_result(
                &env.from,
                id,
                "propose",
                json!({"status":"refused",
                "reason_code":reason,"detail":"Dispatch refused"}),
            )
        } else {
            self.refuse(&env.from, proposal, reason, seq)
        }
    }
}

#[cfg(test)]
#[path = "regression.rs"]
mod regression;

#[cfg(test)]
#[path = "tools_state_regression.rs"]
mod tools_state_regression;

// [TARGET, unit decision] This helper is reached only for authority-settled
// receipts. Read hash-addressed core artifacts, never executor-provided paths.
#[cfg(test)]
fn verified_native_fields(
    proposal: &Value,
    before: &Value,
    receipt: &Value,
    artifacts: &std::path::Path,
) -> Option<Value> {
    verified_native_fields_with_witness(proposal, before, receipt, None, artifacts)
}

fn verified_native_fields_with_witness(
    proposal: &Value,
    before: &Value,
    receipt: &Value,
    witness: Option<&ProposalWitness>,
    artifacts: &std::path::Path,
) -> Option<Value> {
    use crate::verify::{verify_receipt, Evidence, MAX_RGB_BYTES};
    use crate::wire::payload::{
        ActionProposal, ActionProposalExpectation, ActionReceipt, FrameRef, Observation,
    };
    use crate::wire::Optional;
    use std::io::Read;
    let p: ActionProposal = serde_json::from_value(proposal.clone()).ok()?;
    let r: ActionReceipt = serde_json::from_value(receipt.clone()).ok()?;
    let read = |hash: &str| -> Option<Vec<u8>> {
        // Strict decoding already validates the digest; guard direct test callers too.
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let file = std::fs::File::open(artifacts.join(hash)).ok()?;
        if file.metadata().ok()?.len() > MAX_RGB_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(MAX_RGB_BYTES + 1).read_to_end(&mut bytes).ok()?;
        Some(bytes)
    };
    if let ActionProposalExpectation::Case2(want) = &p.expectation {
        let (before_gt, Some((witness_frame_val, after_gt))) = witness? else {
            return None;
        };
        let witness_frame: FrameRef = serde_json::from_value(witness_frame_val.clone()).ok()?;
        if witness_frame.surface_id != p.surface_id
            || r.after_frame.surface_id != p.surface_id
            || witness_frame != r.after_frame
            || r.after_frame.generation <= p.based_on_frame.generation
        {
            return None;
        }
        let read_state = |hash: &str| -> Option<Vec<u8>> {
            if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            let file = std::fs::File::open(artifacts.join(hash)).ok()?;
            let len = file.metadata().ok()?.len();
            if len == 0 || len > canonical::MAX_STATE_BYTES as u64 {
                return None;
            }
            let mut bytes = Vec::with_capacity(len as usize);
            file.take(canonical::MAX_STATE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() > canonical::MAX_STATE_BYTES {
                return None;
            }
            Some(bytes)
        };
        let mut b_obj = json!({"schema":"observation/v0.2", "frame_ref":before.clone()});
        if let Some(bgt) = before_gt {
            b_obj["ground_truth"] = bgt.clone();
        }
        let mut a_obj = json!({"schema":"observation/v0.2", "frame_ref":serde_json::to_value(&r.after_frame).ok()?});
        a_obj["ground_truth"] = after_gt.clone();
        let b: Observation = serde_json::from_value(b_obj).ok()?;
        let a: Observation = serde_json::from_value(a_obj).ok()?;
        let before_state = match &b.ground_truth {
            Optional::Present(bgt) => read_state(&bgt.state_sha256),
            Optional::Missing => None,
        };
        let after_state = match &a.ground_truth {
            Optional::Present(agt) => read_state(&agt.state_sha256),
            Optional::Missing => None,
        };
        let before_rgb = read(&b.frame_ref.sha256);
        let after_rgb = read(&a.frame_ref.sha256);
        let verified = verify_receipt(
            &p,
            &b,
            &a,
            &r,
            &Evidence {
                before_rgb: before_rgb.as_deref(),
                after_rgb: after_rgb.as_deref(),
                semantic_frame_sha256: Some(&a.frame_ref.sha256),
                previous_state_sha256: Some(&want.before),
                before_state: before_state.as_deref(),
                after_state: after_state.as_deref(),
                ..Evidence::default()
            },
        );
        if !verified.verified {
            return None;
        }
        let input_mono_ns = match &r.native_evidence {
            Optional::Present(native) => {
                if native.surface_id != p.surface_id
                    || native.input_mono_ns < native.input_ts_ns
                    || native.input_ts_ns > r.executed_at_ns
                    || matches!(
                        &native.result,
                        Optional::Present(res)
                            if serde_json::to_value(res).ok().as_ref() != Some(&json!("ok"))
                    )
                {
                    return None;
                }
                native.input_mono_ns
            }
            Optional::Missing => r.executed_at_ns,
        };
        let mut result = serde_json::to_value(&verified).ok()?;
        result.as_object_mut()?.remove("native_evidence");
        return Some(
            json!({"status":"verified", "receipt":result, "focus_verified":true,
            "input_mono_ns":input_mono_ns, "frame_sha256":r.after_frame.sha256}),
        );
    }
    let Optional::Present(native) = &r.native_evidence else {
        return None;
    };
    let expected_kind = if proposal["action"]["type"] == "type" {
        json!("text")
    } else {
        proposal["action"]["type"].clone()
    };
    if native.surface_id != p.surface_id
        || native.focus_verified != Optional::Present(true)
        || !matches!(&native.native_surface_id, Optional::Present(id) if !id.is_empty())
        || serde_json::to_value(&native.kind).ok()? != expected_kind
        || serde_json::to_value(&native.result).ok()? != "ok"
        || native.input_mono_ns < native.input_ts_ns
        || native.input_ts_ns < before["ts_ns"].as_u64()?
        || native.input_ts_ns > r.executed_at_ns
    {
        return None;
    }
    let observation = |frame: Value| -> Option<Observation> {
        serde_json::from_value(json!({"schema":"observation/v0.2", "frame_ref":frame,
            "vision":{"summary":"", "changed_regions":[], "elements":[]}}))
        .ok()
    };
    let b = observation(before.clone())?;
    let a = observation(serde_json::to_value(&r.after_frame).ok()?)?;
    let before_rgb = read(&b.frame_ref.sha256)?;
    let after_rgb = read(&a.frame_ref.sha256)?;
    let verified = verify_receipt(
        &p,
        &b,
        &a,
        &r,
        &Evidence {
            before_rgb: Some(&before_rgb),
            after_rgb: Some(&after_rgb),
            ..Evidence::default()
        },
    );
    if !verified.verified {
        return None;
    }
    let mut result = serde_json::to_value(&verified).ok()?;
    // The wait result has its own frozen receipt projection; native witnesses
    // are exposed by the result's explicit focus/timestamp/hash fields.
    result.as_object_mut()?.remove("native_evidence");
    Some(
        json!({"status":"verified", "receipt":result, "focus_verified":true,
        "input_mono_ns":native.input_mono_ns, "frame_sha256":r.after_frame.sha256}),
    )
}
#[cfg(test)]
#[path = "receipt_evidence_tests.rs"]
mod receipt_evidence_tests;

#[cfg(test)]
mod holdings_witness_unit_tests {
    use super::*;

    fn test_frame(surface_id: &str, generation: u64, sha_byte: char) -> Value {
        let mut frame: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        let bytes = vec![sha_byte as u8; 100 * 60 * 3];
        frame["surface_id"] = surface_id.into();
        frame["generation"] = generation.into();
        frame["sha256"] = crate::journal::sha256_hex(&bytes).into();
        frame["width"] = 100.into();
        frame["height"] = 60.into();
        frame
    }

    fn test_proposal(
        proposal_id: &str,
        surface_id: &str,
        based_gen: u64,
        based_sha: &str,
        before_state_sha: &str,
    ) -> crate::wire::payload::ActionProposal {
        serde_json::from_value(json!({
            "schema": "action_proposal/v0.2",
            "proposal_id": proposal_id,
            "surface_id": surface_id,
            "based_on_frame": {
                "generation": based_gen,
                "sha256": based_sha
            },
            "action": {
                "type": "click",
                "x": 10,
                "y": 10,
                "button": "left"
            },
            "expectation": {
                "type": "state_sha256_change",
                "before": before_state_sha,
                "min_tick": 1,
                "max_tick": 20
            },
            "budget": {
                "max_ms": 500,
                "max_retries": 0
            }
        }))
        .unwrap()
    }

    fn test_observation(frame: &Value, state_sha: &str, tick: u64) -> Command {
        Command::Observation(Box::new(
            serde_json::from_value(json!({
                "schema": "observation/v0.2",
                "frame_ref": frame,
                "ground_truth": {
                    "source": "holdings_lane",
                    "state_sha256": state_sha,
                    "tick": tick
                }
            }))
            .unwrap(),
        ))
    }

    #[test]
    fn before_gt_binds_to_based_on_frame_not_current_frame() {
        let mut state = ToolState::default();
        let sid = "surface-holdings";
        let mut surf: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        surf["surface_id"] = sid.into();
        state.retain(&Command::SurfaceEvent(Box::new(
            serde_json::from_value(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": surf}
            }))
            .unwrap(),
        )));

        let f1 = test_frame(sid, 1, 'a');
        let f2 = test_frame(sid, 2, 'b');
        let d1 = "11".repeat(32);
        let d2 = "22".repeat(32);

        state.retain(&Command::FrameRef(Box::new(
            serde_json::from_value(f1.clone()).unwrap(),
        )));
        state.retain(&test_observation(&f1, &d1, 2));

        state.retain(&Command::FrameRef(Box::new(
            serde_json::from_value(f2.clone()).unwrap(),
        )));
        state.retain(&test_observation(&f2, &d2, 5));

        let p = test_proposal(
            "prop-based-on-f1",
            sid,
            1,
            f1["sha256"].as_str().unwrap(),
            &d1,
        );
        state.retain_proposal(&p);

        let stored_before = state
            .proposal_witnesses
            .get("prop-based-on-f1")
            .and_then(|(b, _)| b.clone())
            .expect("expected before_gt bound to frame1");
        assert_eq!(stored_before["state_sha256"], json!(d1));
        assert_eq!(stored_before["tick"], json!(2));
    }

    #[test]
    fn unsettled_proposal_witnesses_bounded_by_standalone_cap() {
        let mut state = ToolState::default();
        for i in 0..300 {
            let sid = format!("surface-cap-{i}");
            let mut surf: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/surface.valid.json"
            ))
            .unwrap();
            surf["surface_id"] = sid.clone().into();
            state.retain(&Command::SurfaceEvent(Box::new(
                serde_json::from_value(json!({
                    "schema": "surface_event/v0.2",
                    "event": "created",
                    "data": {"surface": surf}
                }))
                .unwrap(),
            )));
            let f = test_frame(&sid, 1, 'a');
            state.retain(&Command::FrameRef(Box::new(
                serde_json::from_value(f.clone()).unwrap(),
            )));
            let p = test_proposal(
                &format!("prop-cap-{i}"),
                &sid,
                1,
                f["sha256"].as_str().unwrap(),
                &"11".repeat(32),
            );
            state.retain_proposal(&p);
        }
        assert!(
            state.proposal_witnesses.len() <= 128,
            "proposal_witnesses grew unbounded: {}",
            state.proposal_witnesses.len()
        );
    }

    #[test]
    fn recovery_restores_only_unsettled_proposal_witnesses_no_superset() {
        use std::os::unix::fs::DirBuilderExt;
        let dir = std::env::temp_dir().join(format!("mv-tools-rec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .unwrap();
        let uid = std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(&dir).unwrap());
        let reg = |c: &str| -> Registration {
            serde_json::from_value(json!({
                "endpoint": {"component": c, "instance": format!("{c}-test")},
                "hello": {
                    "schema": "hello/v0.2",
                    "contract_version": "v0.2",
                    "component": c,
                    "component_version": "0.2.0",
                    "component_commit": "0123456789abcdef0123456789abcdef01234567",
                    "dependencies": []
                }
            }))
            .unwrap()
        };
        let cfg = Config {
            session_id: "rec-witness-session".into(),
            core: reg("core"),
            peers: vec![reg("daemon"), reg("agent"), reg("ui")],
        };
        let mut server = Server::open(cfg.clone(), &dir, uid).unwrap();
        server.authority.apply(Input::Connect).unwrap();

        let sid = "surface-holdings";
        let mut surf: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        surf["surface_id"] = sid.into();
        surf["kind"] = "game_capsule".into();
        surf["control"] = "agent".into();
        let created_env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": "m-create",
                "ts_ns": 0,
                "from": {"component": "daemon", "instance": "daemon-test"},
                "to": {"component": "core", "instance": "core-test"},
                "session_id": "rec-witness-session",
                "seq": 1,
                "nonce": "n-create",
                "body": {
                    "schema": "surface_event/v0.2",
                    "event": "created",
                    "data": {"surface": surf}
                }
            })
            .to_string(),
        )
        .unwrap();
        let w_create = server
            .authority
            .retain_witness(serde_json::to_string(&created_env).unwrap().as_bytes())
            .unwrap();
        server
            .authority
            .apply_with_witnesses(
                Input::Lifecycle {
                    surface_id: sid.into(),
                    update: LifecycleUpdate::Created(crate::admission::Surface {
                        display: ":99".into(),
                        owner: Endpoint {
                            component: Component::Agent,
                            instance: "agent-test".into(),
                        },
                        agent_controlled: true,
                        live: true,
                        frame: None,
                        refresh_after: None,
                        allowed_verbs: Vec::new(),
                    }),
                },
                vec![w_create],
            )
            .unwrap();
        server.tool_state.retain(&created_env.body);

        let f1 = test_frame(sid, 1, 'a');
        let f1_env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": "m-f1",
                "ts_ns": 0,
                "from": {"component": "daemon", "instance": "daemon-test"},
                "to": {"component": "core", "instance": "core-test"},
                "session_id": "rec-witness-session",
                "seq": 2,
                "nonce": "n-f1",
                "body": f1
            })
            .to_string(),
        )
        .unwrap();
        let w_f1 = server
            .authority
            .retain_witness(serde_json::to_string(&f1_env).unwrap().as_bytes())
            .unwrap();
        let w_f1_rgb = server
            .authority
            .retain_witness(&vec![b'a'; 100 * 60 * 3])
            .unwrap();
        server
            .authority
            .apply_with_witnesses(
                Input::Frame {
                    surface_id: sid.into(),
                    frame: crate::admission::Frame {
                        sha256: f1["sha256"].as_str().unwrap().into(),
                        generation: 1,
                        width: 100,
                        height: 60,
                    },
                },
                vec![w_f1, w_f1_rgb.clone()],
            )
            .unwrap();
        server.tool_state.retain(&f1_env.body);

        // Admit P1, then cancel it via TakeControl (no receipt, no waiter).
        let p1 = test_proposal(
            "P1",
            sid,
            1,
            f1["sha256"].as_str().unwrap(),
            &"11".repeat(32),
        );
        let p1_env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": "m-p1",
                "ts_ns": 0,
                "from": {"component": "agent", "instance": "agent-test"},
                "to": {"component": "core", "instance": "core-test"},
                "session_id": "rec-witness-session",
                "seq": 1,
                "nonce": "n-p1",
                "body": p1
            })
            .to_string(),
        )
        .unwrap();
        let p1_raw = serde_json::to_string(&p1_env).unwrap();
        let w_p1 = server.authority.retain_witness(p1_raw.as_bytes()).unwrap();
        let req1 = AdmissionRequest::decode(
            &p1_raw,
            &p1_env.from,
            "rec-witness-session",
            server.authority.state().epoch,
            10,
        )
        .unwrap();
        let v1 = server
            .authority
            .admit(req1, vec![w_p1, w_f1_rgb.clone()])
            .unwrap();
        server.tool_state.retain_proposal(&p1);
        server
            .authority
            .apply(Input::Dispatch {
                proposal_id: "P1".into(),
                now_ns: 10,
            })
            .unwrap();
        assert_eq!(serde_json::to_value(&v1).unwrap()["decision"], "admitted");

        // TakeControl cancels P1; Drain settles draining so ReleaseControl can proceed.
        server
            .authority
            .apply(Input::TakeControl {
                surface_id: sid.into(),
            })
            .unwrap();
        server
            .authority
            .apply(Input::Drain {
                proposal_id: "P1".into(),
                epoch: server.authority.state().epoch,
            })
            .unwrap();
        server
            .authority
            .apply(Input::ReleaseControl {
                surface_id: sid.into(),
            })
            .unwrap();

        let f2 = test_frame(sid, 2, 'b');
        let f2_env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": "m-f2",
                "ts_ns": 0,
                "from": {"component": "daemon", "instance": "daemon-test"},
                "to": {"component": "core", "instance": "core-test"},
                "session_id": "rec-witness-session",
                "seq": 3,
                "nonce": "n-f2",
                "body": f2
            })
            .to_string(),
        )
        .unwrap();
        let w_f2 = server
            .authority
            .retain_witness(serde_json::to_string(&f2_env).unwrap().as_bytes())
            .unwrap();
        let w_f2_rgb = server
            .authority
            .retain_witness(&vec![b'b'; 100 * 60 * 3])
            .unwrap();
        server
            .authority
            .apply_with_witnesses(
                Input::Frame {
                    surface_id: sid.into(),
                    frame: crate::admission::Frame {
                        sha256: f2["sha256"].as_str().unwrap().into(),
                        generation: 2,
                        width: 100,
                        height: 60,
                    },
                },
                vec![w_f2, w_f2_rgb.clone()],
            )
            .unwrap();
        server.tool_state.retain(&f2_env.body);

        // Admit P2 (live prunes P1), dispatch P2, then send Observation on f2.
        let p2 = test_proposal(
            "P2",
            sid,
            2,
            f2["sha256"].as_str().unwrap(),
            &"11".repeat(32),
        );
        let p2_env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": "m-p2",
                "ts_ns": 0,
                "from": {"component": "agent", "instance": "agent-test"},
                "to": {"component": "core", "instance": "core-test"},
                "session_id": "rec-witness-session",
                "seq": 2,
                "nonce": "n-p2",
                "body": p2
            })
            .to_string(),
        )
        .unwrap();
        let p2_raw = serde_json::to_string(&p2_env).unwrap();
        let w_p2 = server.authority.retain_witness(p2_raw.as_bytes()).unwrap();
        let req2 = AdmissionRequest::decode(
            &p2_raw,
            &p2_env.from,
            "rec-witness-session",
            server.authority.state().epoch,
            20,
        )
        .unwrap();
        server
            .authority
            .admit(req2, vec![w_p2, w_f2_rgb.clone()])
            .unwrap();
        server.tool_state.verification_contexts.retain(|id, _| {
            server.authority.state().pending.contains_key(id)
                || server.tool_state.receipts.contains_key(id)
        });
        server.tool_state.proposal_witnesses.retain(|id, _| {
            server.authority.state().pending.contains_key(id)
                || server.tool_state.receipts.contains_key(id)
        });
        server.tool_state.retain_proposal(&p2);
        server
            .authority
            .apply(Input::Dispatch {
                proposal_id: "P2".into(),
                now_ns: 20,
            })
            .unwrap();

        let obs_cmd = test_observation(&f2, &"33".repeat(32), 7);
        let obs_env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": "m-obs",
                "ts_ns": 0,
                "from": {"component": "daemon", "instance": "daemon-test"},
                "to": {"component": "core", "instance": "core-test"},
                "session_id": "rec-witness-session",
                "seq": 4,
                "nonce": "n-obs",
                "body": obs_cmd
            })
            .to_string(),
        )
        .unwrap();
        let w_obs = server
            .authority
            .retain_witness(serde_json::to_string(&obs_env).unwrap().as_bytes())
            .unwrap();
        server
            .authority
            .apply_with_witnesses(Input::SurfaceNotice, vec![w_obs])
            .unwrap();
        server.tool_state.retain(&obs_env.body);
        server.authority.flush_sync().unwrap();

        let live_snapshot = server.tool_state.proposal_witnesses.clone();
        drop(server);

        let reopened = Server::open(cfg, &dir, uid).unwrap();
        let recovered_snapshot = reopened.tool_state.proposal_witnesses.clone();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(
            live_snapshot.keys().collect::<Vec<_>>(),
            vec![&"P2".to_string()]
        );
        assert_eq!(recovered_snapshot, live_snapshot);
    }

    #[test]
    fn intake_rejects_undispatched_and_unknown_pending_whitebox() {
        use std::os::unix::fs::DirBuilderExt;
        let dir = std::env::temp_dir().join(format!("mv-tools-undisp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .unwrap();
        let uid = std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(&dir).unwrap());
        let reg = |c: &str| -> Registration {
            serde_json::from_value(json!({
                "endpoint": {"component": c, "instance": format!("{c}-test")},
                "hello": {
                    "schema": "hello/v0.2",
                    "contract_version": "v0.2",
                    "component": c,
                    "component_version": "0.2.0",
                    "component_commit": "0123456789abcdef0123456789abcdef01234567",
                    "dependencies": []
                }
            }))
            .unwrap()
        };
        let cfg = Config {
            session_id: "undisp-witness-session".into(),
            core: reg("core"),
            peers: vec![reg("daemon"), reg("agent"), reg("ui")],
        };
        let mut server = Server::open(cfg, &dir, uid).unwrap();
        server.authority.apply(Input::Connect).unwrap();

        let sid = "surface-holdings";
        let mut surf: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/surface.valid.json"
        ))
        .unwrap();
        surf["surface_id"] = sid.into();
        surf["kind"] = "game_capsule".into();
        surf["control"] = "agent".into();
        server
            .authority
            .apply(Input::Lifecycle {
                surface_id: sid.into(),
                update: LifecycleUpdate::Created(crate::admission::Surface {
                    display: ":99".into(),
                    owner: Endpoint {
                        component: Component::Agent,
                        instance: "agent-test".into(),
                    },
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: Vec::new(),
                }),
            })
            .unwrap();
        server.tool_state.retain(&Command::SurfaceEvent(Box::new(
            serde_json::from_value(json!({
                "schema": "surface_event/v0.2",
                "event": "created",
                "data": {"surface": surf}
            }))
            .unwrap(),
        )));

        let f1 = test_frame(sid, 1, 'a');
        let w_f1_rgb = server
            .authority
            .retain_witness(&vec![b'a'; 100 * 60 * 3])
            .unwrap();
        server
            .authority
            .apply_with_witnesses(
                Input::Frame {
                    surface_id: sid.into(),
                    frame: crate::admission::Frame {
                        sha256: f1["sha256"].as_str().unwrap().into(),
                        generation: 1,
                        width: 100,
                        height: 60,
                    },
                },
                vec![w_f1_rgb.clone()],
            )
            .unwrap();
        server.tool_state.retain(&Command::FrameRef(Box::new(
            serde_json::from_value(f1.clone()).unwrap(),
        )));

        let p1 = test_proposal(
            "P-undisp",
            sid,
            1,
            f1["sha256"].as_str().unwrap(),
            &"11".repeat(32),
        );
        let p1_env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": "m-p1",
                "ts_ns": 0,
                "from": {"component": "agent", "instance": "agent-test"},
                "to": {"component": "core", "instance": "core-test"},
                "session_id": "undisp-witness-session",
                "seq": 1,
                "nonce": "n-p1",
                "body": p1
            })
            .to_string(),
        )
        .unwrap();
        let p1_raw = serde_json::to_string(&p1_env).unwrap();
        let w_p1 = server.authority.retain_witness(p1_raw.as_bytes()).unwrap();
        let req1 = AdmissionRequest::decode(
            &p1_raw,
            &p1_env.from,
            "undisp-witness-session",
            server.authority.state().epoch,
            10,
        )
        .unwrap();
        server
            .authority
            .admit(req1, vec![w_p1, w_f1_rgb.clone()])
            .unwrap();
        server.tool_state.retain_proposal(&p1);

        let obs: crate::wire::payload::Observation = serde_json::from_value(json!({
            "schema": "observation/v0.2",
            "frame_ref": f1,
            "ground_truth": {
                "source": "holdings_lane",
                "state_sha256": "22".repeat(32),
                "tick": 3
            }
        }))
        .unwrap();

        // Undispatched proposal must NOT be accepted for daemon observation intake.
        assert!(
            !server.accept_daemon_observation(&obs),
            "undispatched pending proposal accepted daemon observation"
        );

        // Once dispatched in the current epoch, it is accepted.
        server
            .authority
            .apply(Input::Dispatch {
                proposal_id: "P-undisp".into(),
                now_ns: 10,
            })
            .unwrap();
        assert!(server.accept_daemon_observation(&obs));

        // Once Connect bumps epoch and marks pending unknown, it is rejected.
        server.authority.apply(Input::Connect).unwrap();
        assert!(!server.accept_daemon_observation(&obs));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
