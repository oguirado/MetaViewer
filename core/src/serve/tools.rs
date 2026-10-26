//! [TARGET, unit decision] Tool read views are rebuilt from committed boundary
//! witnesses; authority state fences every observation and owns control/liveness.
//! List cursors are exclusive surface IDs in lexical order. Results echo envelope
//! msg_id, as required by mv_tool_result. Embedded v0.1 payload tags are a contract
//! projection, not a different source of state. SurfaceNotice journals read calls.
//! Waits hold no authority lock and expire with a typed timeout. Receipts currently
//! carry no focus proof or input monotonic timestamp: never fabricate those fields
//! to claim verified success; return VERIFICATION_FAILED once such a receipt arrives.
use super::*;
use crate::wire::payload::{ActionVerdict, MvToolCall};
use serde_json::{json, Value};

#[derive(Default)]
pub(super) struct ToolState {
    surfaces: BTreeMap<String, Value>,
    frames: BTreeMap<String, Value>,
    receipts: BTreeMap<String, Value>,
    waiters: Vec<Waiter>,
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
                        self.surfaces.insert(id.to_owned(), surface.clone());
                    }
                }
                SurfaceEvent::Case2(_) => self.retain_frame(&value["data"]["frame_ref"]),
                _ => {}
            },
            Command::FrameRef(_) => self.retain_frame(&value),
            Command::ActionReceipt(receipt) => {
                self.receipts.insert(receipt.proposal_id.clone(), value);
            }
            _ => {}
        }
    }
    fn retain_frame(&mut self, frame: &Value) {
        if let Some(id) = frame["surface_id"].as_str() {
            self.frames.insert(id.to_owned(), frame.clone());
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
                let Some(mut frame) = self.tool_state.frames.get(sid).cloned().filter(|frame| {
                    surface.frame.as_ref().is_some_and(|current| {
                        frame["sha256"] == current.sha256
                            && frame["generation"] == current.generation
                    })
                }) else {
                    return self.tool_error(env, "observe", "UNAVAILABLE", "No current frame");
                };
                frame["schema"] = "frame_ref/v0.1".into();
                self.tool_result(
                    &env.from,
                    &env.msg_id,
                    "observe",
                    json!({"status":"ok",
                    "observation":{"schema":"observation/v0.1","frame_ref":frame}}),
                )
            }
            MvToolCall::Case1(call) => {
                let cursor = match &call.args.cursor {
                    crate::wire::payload::MvToolCallCase1ArgsCursor::Case0(id) => Some(id.as_str()),
                    crate::wire::payload::MvToolCallCase1ArgsCursor::Case1(()) => None,
                };
                let mut entries = Vec::new();
                for (id, state) in &self.authority.state().surfaces {
                    if cursor.is_some_and(|cursor| id.as_str() <= cursor) {
                        continue;
                    }
                    let Some(mut surface) = self.tool_state.surfaces.get(id).cloned() else {
                        return self.tool_error(
                            env,
                            "list",
                            "UNAVAILABLE",
                            "Missing surface metadata",
                        );
                    };
                    surface["schema"] = "surface/v0.1".into();
                    // Metadata cannot reverse authority's human takeover fence.
                    surface["control"] = if state.agent_controlled {
                        "agent"
                    } else {
                        "human"
                    }
                    .into();
                    if !state.live && surface["state"] == "active" {
                        surface["state"] = "lost".into();
                    }
                    entries.push(surface);
                    if entries.len() > call.args.limit as usize {
                        break;
                    }
                }
                let next = if entries.len() > call.args.limit as usize {
                    entries.pop();
                    entries
                        .last()
                        .map(|s| s["surface_id"].clone())
                        .unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
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
        self.tool_state.waiters.retain(|waiter| {
            if receipts.contains_key(&waiter.proposal_id) || now >= waiter.deadline {
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
            let mut value = serde_json::to_value(&verdict)?;
            if value["decision"] == "admitted" {
                value["schema"] = "action_verdict/v0.1".into();
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
