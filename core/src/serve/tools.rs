//! [TARGET, unit decision] Tool read views are rebuilt from committed boundary
//! witnesses; authority state fences every observation and owns control/liveness.
//! List cursors are exclusive surface IDs in lexical order. Results echo envelope
//! msg_id, as required by mv_tool_result. Nested payloads retain their v0.2
//! contract tags and field sets. SurfaceNotice journals read calls.
//! Waits hold no authority lock, resolve cancellations (including draining work),
//! and expire with a typed timeout. List returns live surfaces only; dead views
//! and layout overrides are pruned against authority on lifecycle/recovery. Receipts currently
//! carry no focus proof or input monotonic timestamp: never fabricate those fields
//! to claim verified success; return VERIFICATION_FAILED once such a receipt arrives.
use super::*;
use crate::wire::payload::{ActionVerdict, MvToolCall};
use serde_json::{json, Value};
use std::collections::VecDeque;

// [TARGET, unit decision] Retain the latest 128 receipts by arrival, including replay.
const RECEIPT_CAP: usize = 128;

#[derive(Default)]
pub(super) struct ToolState {
    surfaces: BTreeMap<String, Value>,
    frames: BTreeMap<String, Value>,
    receipts: BTreeMap<String, Value>,
    waiters: Vec<Waiter>,
    receipt_order: VecDeque<String>,
    layout: BTreeMap<String, String>,
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
                            self.layout.remove(id);
                        } else {
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
            Command::ActionReceipt(receipt) => {
                let id = &receipt.proposal_id;
                self.receipt_order.retain(|old| old != id);
                self.receipt_order.push_back(id.clone());
                self.receipts.insert(id.clone(), value);
                while self.receipt_order.len() > RECEIPT_CAP {
                    if let Some(old) = self.receipt_order.pop_front() {
                        self.receipts.remove(&old);
                    }
                }
            }
            Command::UiIntent(_) => {
                if let (Some(id), Some(op)) =
                    (value["params"]["slot_id"].as_str(), value["op"].as_str())
                {
                    let visibility = match op {
                        "fold" => Some("folded"),
                        "unfold" => Some("unfolded"),
                        _ => None,
                    };
                    if let (Some(surface), Some(visibility)) =
                        (self.surfaces.get_mut(id), visibility)
                    {
                        surface["visibility"] = visibility.into();
                        self.layout.insert(id.to_owned(), visibility.to_owned());
                    }
                }
            }
            _ => {}
        }
    }
    pub(super) fn has_surface(&self, id: &str) -> bool {
        self.surfaces.contains_key(id)
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
    pub(super) fn prune(&mut self, state: &CoreState) {
        let live = |id: &String| state.surfaces.get(id).is_some_and(|s| s.live);
        self.surfaces.retain(|id, _| live(id));
        self.frames.retain(|id, _| live(id));
        self.layout.retain(|id, _| live(id));
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
impl Server {
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
                self.tool_result(
                    &env.from,
                    &env.msg_id,
                    "observe",
                    json!({"status":"ok",
                    "observation":{"schema":"observation/v0.2","frame_ref":frame}}),
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
                json!({"status":"error","code":"VERIFICATION_FAILED",
                    "detail":"Receipt settled execution; focus proof and input_mono_ns are absent"})
            } else if !self.authority.state().pending.contains_key(&proposal) {
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
