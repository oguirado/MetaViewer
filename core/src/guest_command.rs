//! One authenticated guest-command workload with independent run/control correlation.
//! All callers and native witnesses are authenticated by serve; IDs are not authority.
use crate::wire::guest_command::{GuestCommandEvent, GuestCommandRequest, GuestTransportMetadata};
use crate::{Component, Endpoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
fn need(b: bool, e: &'static str) -> Result<(), &'static str> {
    if b {
        Ok(())
    } else {
        Err(e)
    }
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn reservation_id(session: &str, request: &str) -> String {
    let mut bytes = b"MetaViewer/guest-command/reservation/v1\0".to_vec();
    for part in [session.as_bytes(), request.as_bytes()] {
        bytes.extend_from_slice(&(part.len() as u32).to_be_bytes());
        bytes.extend_from_slice(part);
    }
    format!("reservation-{}", crate::journal::sha256_hex(&bytes))
}
/// Strict standard base64: padding and unused low bits must be canonical.
pub fn decode64(s: &str, limit: usize) -> Result<Vec<u8>, &'static str> {
    need(
        s.len().is_multiple_of(4) && s.len() / 4 <= limit.div_ceil(3),
        "INVALID",
    )?;
    let mut out = Vec::new();
    let chunks = s.as_bytes().chunks(4);
    let total = chunks.len();
    for (i, c) in chunks.enumerate() {
        let val = |b: u8| -> Result<u8, &'static str> {
            match b {
                b'A'..=b'Z' => Ok(b - b'A'),
                b'a'..=b'z' => Ok(b - b'a' + 26),
                b'0'..=b'9' => Ok(b - b'0' + 52),
                b'+' => Ok(62),
                b'/' => Ok(63),
                _ => Err("INVALID"),
            }
        };
        let a = val(c[0])?;
        let b = val(c[1])?;
        out.push((a << 2) | (b >> 4));
        if c[2] == b'=' {
            need(c[3] == b'=' && i + 1 == total && b & 15 == 0, "INVALID")?;
        } else {
            let d = val(c[2])?;
            out.push((b << 4) | (d >> 2));
            if c[3] == b'=' {
                need(i + 1 == total && d & 3 == 0, "INVALID")?;
            } else {
                out.push((d << 6) | val(c[3])?);
            }
        }
    }
    need(out.len() <= limit, "INVALID")?;
    Ok(out)
}
pub fn prepare_exec(r: &Value, reservation: &str) -> Result<Value, &'static str> {
    let p = &r["params"];
    let command = p["command_utf8"].as_str().ok_or("INVALID")?;
    let cwd = p["cwd"].as_str().ok_or("INVALID")?;
    need(
        !command.is_empty() && command.len() <= 16384 && !command.contains('\0'),
        "INVALID",
    )?;
    need(
        cwd.len() <= 1024
            && !cwd.chars().any(|c| c < ' ' || c == '\u{7f}')
            && (cwd.is_empty()
                || (!cwd.starts_with('/')
                    && cwd
                        .split('/')
                        .all(|s| !s.is_empty() && s != "." && s != ".." && s.len() <= 255))),
        "INVALID",
    )?;
    let stdin = decode64(p["stdin_b64"].as_str().ok_or("INVALID")?, 49152)?;
    let meta = json!({"kind":"exec","workload_id":p["workload_id"],"generation":p["generation"],"reservation_id":reservation,"request_id":r["request_id"],"job_id":p["job_id"],"cwd":cwd,"timeout_ms":p["timeout_ms"],"command_bytes":command.len(),"stdin_bytes":stdin.len()});
    let _: GuestTransportMetadata = serde_json::from_value(meta.clone()).map_err(|_| "INVALID")?;
    need(
        serde_json::to_vec(&meta).map_err(|_| "INVALID")?.len() <= 4096
            && command.len() + stdin.len() <= 65536,
        "INVALID",
    )?;
    Ok(meta)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub request: Value,
    pub caller: Endpoint,
    pub accepted: bool,
    pub deadline_ns: Option<u64>,
    pub unknown: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub started: bool,
    pub create_id: Option<String>,
    pub held: bool,
    pub creator: Option<Endpoint>,
    pub actor: Option<String>,
    pub reservation: Option<String>,
    pub session: Option<Value>,
    pub unknown: bool,
    pub pending: BTreeMap<String, Pending>,
    pub requests: BTreeSet<String>,
    pub rejected: BTreeSet<String>,
    pub events: BTreeSet<String>,
    pub jobs: BTreeSet<String>,
    pub run_id: Option<String>,
    pub run_params: Option<Value>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_index: u64,
    pub stderr_index: u64,
}
impl State {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
    pub fn submit(
        &mut self,
        r: &GuestCommandRequest,
        caller: &Endpoint,
        agent: &Endpoint,
        session_id: &str,
        now: u64,
        other: bool,
    ) -> Result<(), &'static str> {
        let mut next = self.clone();
        next.submit_inner(r, caller, agent, session_id, now, other)?;
        *self = next;
        Ok(())
    }
    fn submit_inner(
        &mut self,
        r: &GuestCommandRequest,
        caller: &Endpoint,
        agent: &Endpoint,
        sid: &str,
        now: u64,
        other: bool,
    ) -> Result<(), &'static str> {
        let _: GuestCommandRequest = serde_json::from_value(r.0.clone()).map_err(|_| "INVALID")?;
        need(
            matches!(caller.component, Component::Ui | Component::Agent)
                && (caller.component != Component::Agent || caller == agent),
            "OWNER",
        )?;
        let id = text(&r.0, "request_id");
        let op = text(&r.0, "op");
        let p = &r.0["params"];
        need(
            !self.requests.contains(id) && !self.rejected.contains(id) && self.requests.len() < 256,
            "DUPLICATE",
        )?;
        need(
            self.rejected.len() < 256 || matches!(op, "cancel" | "stop"),
            "CAPACITY",
        )?;
        if op == "create" {
            need(!self.started && !other, "CAPACITY")?;
            self.started = true;
            self.create_id = Some(id.to_owned());
            self.held = true;
            self.creator = Some(caller.clone());
            self.actor = Some(crate::headless::actor_id(agent));
            self.reservation = Some(reservation_id(sid, id));
        } else {
            need(
                self.creator.as_ref() == Some(caller) || caller == agent,
                "OWNER",
            )?;
            let s = self.session.as_ref().ok_or("UNAVAILABLE")?;
            need(
                self.held
                    && p["workload_id"] == s["workload_id"]
                    && p["generation"] == s["generation"],
                "STALE",
            )?;
            if op == "run" {
                need(
                    !self.unknown && text(s, "phase") == "ready" && self.pending.is_empty(),
                    "BUSY",
                )?;
                need(
                    self.jobs.len() < 64 && !self.jobs.contains(text(p, "job_id")),
                    "DUPLICATE",
                )?;
                prepare_exec(&r.0, self.reservation.as_deref().ok_or("UNAVAILABLE")?)?;
                self.jobs.insert(text(p, "job_id").into());
                self.run_id = Some(id.into());
                self.run_params = Some(p.clone());
                // Retire only the previous job's resolved controls here. A Stop
                // admitted after this Run intent must survive a delayed Run ACK.
                self.session.as_mut().unwrap()["controls"] = json!({"cancel":null,"stop":null});
                self.stdout.clear();
                self.stderr.clear();
                self.stdout_index = 0;
                self.stderr_index = 0;
            } else if op == "cancel" {
                need(
                    !self.unknown
                        && matches!(text(s, "phase"), "running")
                        && self.run_id.is_some()
                        && s["job"]["job_id"] == p["job_id"]
                        && s["controls"]["cancel"].is_null()
                        && s["controls"]["stop"].is_null(),
                    "BUSY",
                )?;
                let s = self.session.as_mut().unwrap();
                s["controls"]["cancel"] = json!({"request_id":id,"ack":"pending"});
                s["phase"] = json!("cancelling");
            } else {
                need(
                    !self
                        .pending
                        .values()
                        .any(|p| text(&p.request, "op") == "stop"),
                    "BUSY",
                )?;
                let s = self.session.as_mut().unwrap();
                s["controls"]["stop"] = json!({"request_id":id,"ack":"pending"});
                s["phase"] = json!("stopping");
            }
        }
        let duration = if op == "run" {
            p["timeout_ms"]
                .as_u64()
                .ok_or("INVALID")?
                .checked_mul(1_000_000)
                .and_then(|n| n.checked_add(5_000_000_000))
                .ok_or("INVALID")?
        } else {
            15_000_000_000
        };
        let deadline = now
            .checked_add(duration)
            .filter(|n| *n <= crate::MAX_WIRE_INTEGER)
            .ok_or("DEADLINE")?;
        self.requests.insert(id.into());
        self.pending.insert(
            id.into(),
            Pending {
                request: r.0.clone(),
                caller: caller.clone(),
                accepted: false,
                deadline_ns: Some(deadline),
                unknown: false,
            },
        );
        Ok(())
    }
    fn active_phase(s: &Value) -> &'static str {
        if !s["controls"]["stop"].is_null() {
            "stopping"
        } else if matches!(
            s["controls"]["cancel"]["ack"].as_str(),
            Some("pending" | "accepted")
        ) {
            "cancelling"
        } else {
            "running"
        }
    }
    fn phase(s: &Value) -> &'static str {
        let pending = |op: &str| s["controls"][op]["ack"] == "pending";
        if pending("cancel") || pending("stop") {
            "awaiting_control"
        } else if !s["controls"]["stop"].is_null() {
            "stopping"
        } else {
            "ready"
        }
    }
    // A daemon event can precede observation of a locally queued control. Only
    // unaccepted pending controls may be absent; never erase their core intent.
    fn snapshot_matches(&self, incoming: &Value, expected: &Value) -> bool {
        if incoming == expected {
            return true;
        }
        if self.unknown
            || matches!(
                text(expected, "phase"),
                "starting" | "uncertain" | "stopped"
            )
        {
            return false;
        }
        for mask in 1..4 {
            let mut projected = expected.clone();
            let mut valid = true;
            for (bit, op) in [(1, "cancel"), (2, "stop")] {
                if mask & bit == 0 {
                    continue;
                }
                let control = &expected["controls"][op];
                let pending = control["request_id"]
                    .as_str()
                    .and_then(|id| self.pending.get(id));
                if control["ack"] != "pending"
                    || !pending.is_some_and(|p| !p.accepted && text(&p.request, "op") == op)
                {
                    valid = false;
                    break;
                }
                projected["controls"][op] = Value::Null;
            }
            if !valid {
                continue;
            }
            projected["phase"] = json!(if matches!(
                text(&projected["job"], "state"),
                "running" | "cancelling"
            ) {
                Self::active_phase(&projected)
            } else {
                Self::phase(&projected)
            });
            if incoming == &projected {
                return true;
            }
        }
        false
    }
    fn unknown_projection(&self, request: Option<&Value>) -> Option<Value> {
        let mut s = self.session.clone()?;
        s["phase"] = json!("uncertain");
        s["ownership"] = json!("held");
        if let Some(r) = request {
            if text(r, "op") == "run"
                && self.run_id.as_deref() == Some(text(r, "request_id"))
                && text(&s["job"], "job_id") != text(&r["params"], "job_id")
            {
                s["job"] = json!({"job_id":r["params"]["job_id"],"state":"unknown","exit_code":null,"signal":null,"stdout_bytes":self.stdout.len(),"stderr_bytes":self.stderr.len(),"output_complete":false});
                s["jobs_started"] = json!(self.jobs.len());
            } else if matches!(text(&s["job"], "state"), "running" | "cancelling") {
                s["job"]["state"] = json!("unknown");
                s["job"]["output_complete"] = json!(false);
            }
        }
        Some(s)
    }
    pub fn uncertain(&mut self) {
        if !self.held {
            return;
        }
        let run = self
            .run_id
            .as_ref()
            .and_then(|id| self.pending.get(id))
            .map(|p| p.request.clone());
        self.session = self.unknown_projection(run.as_ref());
        self.unknown = true;
        for p in self.pending.values_mut() {
            p.unknown = true;
            p.deadline_ns = None;
        }
    }
    pub fn expired(&self, now: u64) -> bool {
        self.pending
            .values()
            .any(|p| p.deadline_ns.is_some_and(|d| now >= d))
    }
    pub fn observe(&mut self, e: &GuestCommandEvent) -> Result<(), &'static str> {
        let mut n = self.clone();
        n.observe_inner(e)?;
        *self = n;
        Ok(())
    }
    fn observe_inner(&mut self, e: &GuestCommandEvent) -> Result<(), &'static str> {
        let _: GuestCommandEvent = serde_json::from_value(e.0.clone()).map_err(|_| "INVALID")?;
        let e = &e.0;
        let id = text(e, "request_id");
        let kind = text(e, "event");
        let data = &e["data"];
        let incoming = &e["session"];
        need(
            !text(e, "event_id").starts_with("event-core-")
                && !self.events.contains(text(e, "event_id"))
                && self.events.len() < 8192,
            "DUPLICATE",
        )?;
        need(
            self.held
                && e["owner_id"].as_str() == self.actor.as_deref()
                && e["reservation_id"].as_str() == self.reservation.as_deref(),
            "OWNER",
        )?;
        let pending = match self.pending.get(id).cloned() {
            Some(p) => p,
            None if kind == "outcome_unknown"
                && data["op"] == "create"
                && self.create_id.as_deref() == Some(id)
                && self.session.is_some()
                && self.pending.is_empty() =>
            {
                Pending {
                    request: json!({"request_id":id,"op":"create"}),
                    caller: self.creator.clone().ok_or("OWNER")?,
                    accepted: true,
                    deadline_ns: None,
                    unknown: false,
                }
            }
            None => return Err("UNAVAILABLE"),
        };
        let op = text(&pending.request, "op");
        need(!self.unknown || op == "stop", "UNAVAILABLE")?;
        if !incoming.is_null() {
            need(
                incoming["owner_id"].as_str() == self.actor.as_deref()
                    && incoming["profile_id"] == "guest-command-arm64-v1"
                    && incoming["backend"] == "firecracker"
                    && incoming["isa"] == "aarch64",
                "OWNER",
            )?;
            if let Some(s) = &self.session {
                need(
                    incoming["workload_id"] == s["workload_id"]
                        && incoming["generation"] == s["generation"],
                    "STALE",
                )?;
            }
        }
        let mut expected = self.session.clone();
        match kind {
            "refused" => {
                need(!pending.accepted && data["op"] == op, "INVALID")?;
                if op == "create" {
                    need(incoming.is_null(), "INVALID")?;
                    self.held = false;
                } else {
                    let s = expected.as_mut().ok_or("INVALID")?;
                    if op == "cancel" || op == "stop" {
                        s["controls"][op]["ack"] = json!("refused");
                        if op == "stop" {
                            s["controls"]["stop"] = Value::Null;
                        }
                        s["phase"] = json!(if self
                            .run_id
                            .as_ref()
                            .is_some_and(|r| self.pending.contains_key(r))
                        {
                            Self::active_phase(s)
                        } else {
                            Self::phase(s)
                        });
                    }
                    need(
                        expected
                            .as_ref()
                            .is_some_and(|s| self.snapshot_matches(incoming, s)),
                        "INVALID",
                    )?;
                    self.session = expected;
                }
                self.pending.remove(id);
            }
            "accepted" => {
                need(
                    !pending.accepted && data["op"] == op && !incoming.is_null(),
                    "INVALID",
                )?;
                if op == "create" {
                    need(
                        expected.is_none()
                            && incoming["phase"] == "starting"
                            && incoming["ownership"] == "held"
                            && incoming["jobs_started"] == 0
                            && incoming["job"].is_null()
                            && incoming["controls"] == json!({"cancel":null,"stop":null}),
                        "INVALID",
                    )?;
                    expected = Some(incoming.clone());
                } else {
                    let s = expected.as_mut().ok_or("INVALID")?;
                    match op {
                        "run" => {
                            s["job"] = json!({"job_id":pending.request["params"]["job_id"],"state":"running","exit_code":null,"signal":null,"stdout_bytes":0,"stderr_bytes":0,"output_complete":false});
                            s["jobs_started"] = json!(self.jobs.len());
                            s["phase"] = json!(Self::active_phase(s));
                        }
                        "cancel" => {
                            need(
                                self.run_id
                                    .as_ref()
                                    .is_some_and(|r| self.pending.contains_key(r)),
                                "INVALID",
                            )?;
                            s["controls"]["cancel"]["ack"] = json!("accepted");
                            s["job"]["state"] = json!("cancelling");
                            s["phase"] = json!(if s["controls"]["stop"].is_null() {
                                "cancelling"
                            } else {
                                "stopping"
                            });
                        }
                        "stop" => {
                            s["controls"]["stop"]["ack"] = json!("accepted");
                            s["phase"] = json!(if self
                                .run_id
                                .as_ref()
                                .is_some_and(|r| self.pending.contains_key(r))
                            {
                                "stopping"
                            } else {
                                Self::phase(s)
                            });
                        }
                        _ => return Err("INVALID"),
                    }
                    need(
                        expected
                            .as_ref()
                            .is_some_and(|s| self.snapshot_matches(incoming, s)),
                        "INVALID",
                    )?;
                }
                self.session = expected;
                self.pending.get_mut(id).unwrap().accepted = true;
            }
            "ready" => {
                need(op == "create" && pending.accepted, "INVALID")?;
                let s = expected.as_mut().ok_or("INVALID")?;
                s["phase"] = json!(Self::phase(s));
                need(
                    expected
                        .as_ref()
                        .is_some_and(|s| self.snapshot_matches(incoming, s)),
                    "INVALID",
                )?;
                self.session = expected;
                self.pending.remove(id);
            }
            "output" => {
                need(
                    op == "run" && pending.accepted && self.run_id.as_deref() == Some(id),
                    "INVALID",
                )?;
                let s = expected.as_mut().ok_or("INVALID")?;
                need(data["job_id"] == s["job"]["job_id"], "INVALID")?;
                let raw = decode64(data["data_b64"].as_str().ok_or("INVALID")?, 16384)?;
                need(
                    !raw.is_empty() && self.stdout.len() + self.stderr.len() + raw.len() <= 65536,
                    "INVALID",
                )?;
                match text(data, "stream") {
                    "stdout" => {
                        need(data["chunk_index"] == self.stdout_index, "INVALID")?;
                        self.stdout.extend(raw);
                        self.stdout_index += 1;
                    }
                    "stderr" => {
                        need(data["chunk_index"] == self.stderr_index, "INVALID")?;
                        self.stderr.extend(raw);
                        self.stderr_index += 1;
                    }
                    _ => return Err("INVALID"),
                }
                s["job"]["stdout_bytes"] = json!(self.stdout.len());
                s["job"]["stderr_bytes"] = json!(self.stderr.len());
                need(
                    expected
                        .as_ref()
                        .is_some_and(|s| self.snapshot_matches(incoming, s)),
                    "INVALID",
                )?;
                self.session = expected;
            }
            "job_finished" => {
                need(
                    op == "run" && pending.accepted && self.run_id.as_deref() == Some(id),
                    "INVALID",
                )?;
                let s = expected.as_mut().ok_or("INVALID")?;
                need(data["job_id"] == s["job"]["job_id"], "INVALID")?;
                for ctl in ["cancel", "stop"] {
                    let observed = if s["controls"][ctl]["ack"] == "accepted" {
                        s["controls"][ctl]["request_id"].clone()
                    } else {
                        Value::Null
                    };
                    need(data[format!("{ctl}_request_id")] == observed, "INVALID")?;
                }
                let cause = text(data, "cause");
                need(
                    cause != "cancel" || !data["cancel_request_id"].is_null(),
                    "INVALID",
                )?;
                need(
                    cause != "stop" || !data["stop_request_id"].is_null(),
                    "INVALID",
                )?;
                need(
                    data["stdout_sent_bytes"] == self.stdout.len()
                        && data["stderr_sent_bytes"] == self.stderr.len()
                        && data["stdout_sha256"] == crate::journal::sha256_hex(&self.stdout)
                        && data["stderr_sha256"] == crate::journal::sha256_hex(&self.stderr),
                    "INVALID",
                )?;
                let j = &incoming["job"];
                need(
                    j["exit_code"].is_null() != j["signal"].is_null()
                        && j["output_complete"] == json!(cause != "output_limit"),
                    "INVALID",
                )?;
                s["job"]["state"] = json!(match cause {
                    "exit" => "exited",
                    "cancel" | "stop" => "cancelled",
                    "timeout" => "timed_out",
                    "output_limit" => "output_limit",
                    _ => return Err("INVALID"),
                });
                s["job"]["exit_code"] = j["exit_code"].clone();
                s["job"]["signal"] = j["signal"].clone();
                s["job"]["output_complete"] = j["output_complete"].clone();
                s["phase"] = json!(Self::phase(s));
                need(
                    expected
                        .as_ref()
                        .is_some_and(|s| self.snapshot_matches(incoming, s)),
                    "INVALID",
                )?;
                self.session = expected;
                self.pending.remove(id);
                let cancel = self.session.as_ref().unwrap()["controls"]["cancel"].clone();
                if cancel["ack"] == "accepted" {
                    self.pending.remove(text(&cancel, "request_id"));
                }
            }
            "stopped" => {
                need(
                    op == "stop" && (pending.accepted || self.unknown),
                    "INVALID",
                )?;
                need(
                    self.unknown
                        || !self
                            .run_id
                            .as_ref()
                            .is_some_and(|r| self.pending.contains_key(r)),
                    "BUSY",
                )?;
                let s = expected.as_mut().ok_or("INVALID")?;
                need(
                    self.unknown || s["controls"]["cancel"]["ack"] != "pending",
                    "BUSY",
                )?;
                s["phase"] = json!("stopped");
                s["ownership"] = json!("released");
                need(
                    expected
                        .as_ref()
                        .is_some_and(|s| self.snapshot_matches(incoming, s)),
                    "INVALID",
                )?;
                self.session = expected;
                self.held = false;
                self.pending.clear();
            }
            "outcome_unknown" => {
                need(data["op"] == op, "INVALID")?;
                let projected = self.unknown_projection(Some(&pending.request));
                need(
                    projected.as_ref().unwrap_or(&Value::Null) == incoming,
                    "INVALID",
                )?;
                self.uncertain();
            }
            _ => return Err("INVALID"),
        }
        self.events.insert(text(e, "event_id").into());
        Ok(())
    }
}

#[cfg(test)]
mod actual_control_snapshot_tests {
    use super::*;
    fn peer(component: Component) -> Endpoint {
        Endpoint {
            component,
            instance: "control-snapshot-fixture".into(),
        }
    }
    fn request(op: &str, id: &str, params: Value) -> GuestCommandRequest {
        serde_json::from_value(
            json!({"schema":"guest_command_request/v0.2","request_id":id,"op":op,"params":params}),
        )
        .unwrap()
    }
    fn submit(s: &mut State, request: &GuestCommandRequest) {
        s.submit(
            request,
            &peer(Component::Ui),
            &peer(Component::Agent),
            "control-snapshot-session",
            0,
            false,
        )
        .unwrap();
    }
    fn event(s: &State, id: &str, kind: &str, session: Value, data: Value) -> GuestCommandEvent {
        serde_json::from_value(json!({"schema":"guest_command_event/v0.2","event_id":format!("event-{id}-{kind}"),"request_id":format!("request-{id}"),"reservation_id":s.reservation,"owner_id":s.actor,"event":kind,"session":session,"data":data})).unwrap()
    }
    fn running_with_marker() -> State {
        let mut s = State::default();
        submit(
            &mut s,
            &request(
                "create",
                "request-create",
                json!({"profile_id":"guest-command-arm64-v1"}),
            ),
        );
        let mut snapshot = json!({"schema":"guest_command_session/v0.2","workload_id":"workload-fixture","generation":1,"owner_id":s.actor,"profile_id":"guest-command-arm64-v1","backend":"firecracker","isa":"aarch64","phase":"starting","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}});
        s.observe(&event(
            &s,
            "create",
            "accepted",
            snapshot.clone(),
            json!({"op":"create"}),
        ))
        .unwrap();
        snapshot["phase"] = json!("ready");
        s.observe(&event(&s, "create", "ready", snapshot.clone(), json!({})))
            .unwrap();
        submit(
            &mut s,
            &request(
                "run",
                "request-run",
                json!({"workload_id":"workload-fixture","generation":1,"job_id":"job-fixture","command_utf8":"printf CHILD_READY","cwd":"","stdin_b64":"","timeout_ms":10000}),
            ),
        );
        snapshot["phase"] = json!("running");
        snapshot["jobs_started"] = json!(1);
        snapshot["job"] = json!({"job_id":"job-fixture","state":"running","exit_code":null,"signal":null,"stdout_bytes":0,"stderr_bytes":0,"output_complete":false});
        s.observe(&event(
            &s,
            "run",
            "accepted",
            snapshot.clone(),
            json!({"op":"run"}),
        ))
        .unwrap();
        snapshot["job"]["stdout_bytes"] = json!(12);
        s.observe(&event(&s,"run","output",snapshot,json!({"job_id":"job-fixture","stream":"stdout","chunk_index":0,"data_b64":"Q0hJTERfUkVBRFkK"}))).unwrap();
        s
    }
    fn accepted_control(s: &mut State, op: &str, state: &str) -> GuestCommandEvent {
        let mut params = json!({"workload_id":"workload-fixture","generation":1});
        if op == "cancel" {
            params["job_id"] = json!("job-fixture");
        }
        submit(s, &request(op, &format!("request-{op}"), params));
        let mut snapshot = s.session.clone().unwrap();
        snapshot["controls"][op]["ack"] = json!("accepted");
        snapshot["phase"] = json!(if op == "cancel" {
            "cancelling"
        } else {
            "stopping"
        });
        snapshot["job"]["state"] = json!(state);
        event(s, op, "accepted", snapshot, json!({"op":op}))
    }
    #[test]
    fn actual_cancel_ack_cancelling_job_snapshot_is_accepted() {
        // Matches observed controller journal row31: accepted Cancel, running
        // output retained, job.state=cancelling, phase=cancelling, same tuple.
        let mut s = running_with_marker();
        let e = accepted_control(&mut s, "cancel", "cancelling");
        s.observe(&e).expect("valid actual Cancel ACK snapshot");
        assert_eq!(s.session.as_ref().unwrap()["job"]["state"], "cancelling");
        assert_eq!(s.stdout, b"CHILD_READY\n");
        assert!(s.held);
    }
    #[test]
    fn malformed_cancel_ack_terminal_job_is_refused() {
        for state in ["running", "exited", "unknown"] {
            let mut s = running_with_marker();
            let e = accepted_control(&mut s, "cancel", state);
            let before = s.clone();
            assert!(s.observe(&e).is_err());
            assert_eq!(s, before);
        }
    }
    #[test]
    fn stop_ack_preserves_running_job_and_rejects_invented_cancelling_state() {
        let mut s = running_with_marker();
        let e = accepted_control(&mut s, "stop", "running");
        s.observe(&e).unwrap();
        assert_eq!(s.session.as_ref().unwrap()["job"]["state"], "running");
        assert!(s.held);
        let mut s = running_with_marker();
        let e = accepted_control(&mut s, "stop", "cancelling");
        assert!(s.observe(&e).is_err());
        let mut s = running_with_marker();
        let e = accepted_control(&mut s, "cancel", "cancelling");
        s.observe(&e).unwrap();
        let e = accepted_control(&mut s, "stop", "cancelling");
        s.observe(&e).unwrap();
        assert_eq!(s.session.as_ref().unwrap()["job"]["state"], "cancelling");
    }
}
