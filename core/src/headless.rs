//! One bounded headless workload per core session; no surfaces, frames or guest input.
//! Caller authentication is supplied by serve, never by renderer fields.
use crate::wire::headless::{HeadlessEvent, HeadlessRequest};
use crate::{Component, Endpoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub request: Value,
    pub caller: Endpoint,
    pub epoch: u64,
    pub accepted: bool,
    pub deadline_ns: Option<u64>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub started: bool,
    pub held: bool,
    pub creator: Option<Endpoint>,
    pub actor: Option<String>,
    pub session: Option<Value>,
    pub pending: Option<Pending>,
    pub requests: BTreeSet<String>,
    pub events: BTreeSet<String>,
    pub jobs: BTreeSet<String>,
}
fn need(ok: bool, code: &'static str) -> Result<(), &'static str> {
    if ok {
        Ok(())
    } else {
        Err(code)
    }
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn actor_id(agent: &Endpoint) -> String {
    format!(
        "actor-{}",
        crate::journal::sha256_hex(format!("agent:{}", agent.instance).as_bytes())
    )
}
impl State {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
    pub fn submit(
        &mut self,
        request: &HeadlessRequest,
        caller: &Endpoint,
        agent: &Endpoint,
        epoch: u64,
        live_surfaces: bool,
    ) -> Result<(), &'static str> {
        let mut next = self.clone();
        next.submit_inner(request, caller, agent, epoch, live_surfaces)?;
        *self = next;
        Ok(())
    }
    fn submit_inner(
        &mut self,
        request: &HeadlessRequest,
        caller: &Endpoint,
        agent: &Endpoint,
        epoch: u64,
        live_surfaces: bool,
    ) -> Result<(), &'static str> {
        let _: HeadlessRequest =
            serde_json::from_value(request.0.clone()).map_err(|_| "BAD_REQUEST")?;
        need(
            matches!(caller.component, Component::Ui | Component::Agent),
            "OWNER_MISMATCH",
        )?;
        need(
            caller.component != Component::Agent || caller == agent,
            "OWNER_MISMATCH",
        )?;
        let r = &request.0;
        need(
            !self.requests.contains(text(r, "request_id")),
            "DUPLICATE_REQUEST",
        )?;
        need(self.requests.len() < 64, "POLICY")?;
        need(self.pending.is_none(), "BUSY")?;
        if text(r, "op") == "create" {
            need(!self.started, "OUT_OF_ORDER")?;
            need(!live_surfaces, "BUSY")?;
            self.started = true;
            self.held = true;
            self.creator = Some(caller.clone());
            self.actor = Some(actor_id(agent));
        } else {
            need(
                self.creator.as_ref() == Some(caller) || caller == agent,
                "OWNER_MISMATCH",
            )?;
            let session = self.session.as_ref().ok_or("UNKNOWN_WORKLOAD")?;
            need(
                r["params"]["workload_id"] == session["workload_id"],
                "UNKNOWN_WORKLOAD",
            )?;
            need(
                r["params"]["generation"] == session["generation"],
                "STALE_GENERATION",
            )?;
            need(self.held, "OUT_OF_ORDER")?;
            if text(r, "op") == "run" {
                need(
                    !self.jobs.contains(text(&r["params"], "job_id")),
                    "DUPLICATE_JOB",
                )?;
                need(
                    text(session, "phase") == "ready" && self.jobs.is_empty(),
                    "OUT_OF_ORDER",
                )?;
                self.jobs.insert(text(&r["params"], "job_id").into());
            } else {
                need(
                    matches!(text(session, "phase"), "ready" | "completed" | "uncertain"),
                    "OUT_OF_ORDER",
                )?;
            }
        }
        self.requests.insert(text(r, "request_id").into());
        self.pending = Some(Pending {
            request: r.clone(),
            caller: caller.clone(),
            epoch,
            accepted: false,
            deadline_ns: None,
        });
        Ok(())
    }
    pub fn observe(&mut self, event: &HeadlessEvent, epoch: u64) -> Result<(), &'static str> {
        let mut next = self.clone();
        next.observe_inner(event, epoch)?;
        *self = next;
        Ok(())
    }
    fn observe_inner(&mut self, event: &HeadlessEvent, epoch: u64) -> Result<(), &'static str> {
        let _: HeadlessEvent = serde_json::from_value(event.0.clone()).map_err(|_| "BAD_EVENT")?;
        let e = &event.0;
        // Core-generated refusals/unknown notifications use a reserved event namespace.
        need(
            !text(e, "event_id").starts_with("event-core-"),
            "DUPLICATE_EVENT",
        )?;
        let p = self.pending.clone().ok_or("NO_PENDING_REQUEST")?;
        need(p.epoch == epoch, "STALE_EPOCH")?;
        need(
            !self.events.contains(text(e, "event_id")) && self.events.len() < 128,
            "DUPLICATE_EVENT",
        )?;
        need(
            e["request_id"] == p.request["request_id"],
            "REQUEST_CORRELATION",
        )?;
        let op = text(&p.request, "op");
        let kind = text(e, "event");
        let data = &e["data"];
        if kind == "refused" {
            need(!p.accepted, "REFUSAL_AFTER_ACCEPT")?;
            let expected = self.session.as_ref();
            need(
                data["workload_id"]
                    == expected
                        .map(|s| s["workload_id"].clone())
                        .unwrap_or(Value::Null)
                    && data["generation"]
                        == expected
                            .map(|s| s["generation"].clone())
                            .unwrap_or(Value::Null),
                "REFUSAL_CORRELATION",
            )?;
            if op == "create" {
                self.held = false;
            }
            self.pending = None;
            self.events.insert(text(e, "event_id").into());
            return Ok(());
        }
        let s = &data["session"];
        need(
            Some(text(s, "owner_id")) == self.actor.as_deref()
                && text(s, "profile_id") == "headless-sumsq-v1"
                && text(s, "backend") == "firecracker"
                && text(s, "isa") == "aarch64",
            "FOREIGN_SESSION",
        )?;
        if let Some(old) = &self.session {
            need(
                s["workload_id"] == old["workload_id"] && s["generation"] == old["generation"],
                "STALE_SESSION",
            )?;
        }
        match kind {
            "accepted" => {
                need(!p.accepted && text(data, "op") == op, "ACCEPT_CORRELATION")?;
                let phase = match op {
                    "create" => "starting",
                    "run" => "running",
                    _ => "stopping",
                };
                need(
                    text(s, "phase") == phase && text(s, "ownership") == "held",
                    "ACCEPT_PHASE",
                )?;
                self.check_job(
                    s,
                    &p.request,
                    if op == "run" { Some("accepted") } else { None },
                )?;
                self.pending.as_mut().unwrap().accepted = true;
            }
            "state_changed" => {
                need(p.accepted, "STATE_BEFORE_ACCEPT")?;
                if op == "create" {
                    need(
                        text(s, "phase") == "ready" && s["job"].is_null(),
                        "CREATE_READY",
                    )?;
                } else {
                    need(
                        op == "stop"
                            && text(s, "phase") == "stopped"
                            && s["job"] == self.session.as_ref().unwrap()["job"],
                        "STOP_NOT_CONFIRMED",
                    )?;
                }
                self.pending = None;
            }
            "completed" => {
                need(
                    op == "run" && p.accepted && text(s, "phase") == "completed",
                    "COMPLETE_PHASE",
                )?;
                self.check_job(s, &p.request, Some("completed"))?;
                self.pending = None;
            }
            "outcome_unknown" => {
                need(
                    text(data, "op") == op
                        && text(s, "phase") == "uncertain"
                        && text(s, "ownership") == "held",
                    "UNKNOWN_PHASE",
                )?;
                self.check_job(
                    s,
                    &p.request,
                    if op == "run" { Some("unknown") } else { None },
                )?;
                self.pending = None;
            }
            _ => return Err("BAD_EVENT"),
        }
        self.session = Some(s.clone());
        self.held = text(s, "ownership") == "held";
        self.events.insert(text(e, "event_id").into());
        Ok(())
    }
    fn check_job(
        &self,
        s: &Value,
        request: &Value,
        status: Option<&str>,
    ) -> Result<(), &'static str> {
        let op = text(request, "op");
        if op == "create" {
            return need(s["job"].is_null(), "CREATE_JOB");
        }
        if op == "stop" {
            return need(
                self.session
                    .as_ref()
                    .is_some_and(|old| s["job"] == old["job"]),
                "STOP_JOB_CHANGED",
            );
        }
        let job = &s["job"];
        let params = &request["params"];
        need(
            job["job_id"] == params["job_id"]
                && job["n"] == params["n"]
                && Some(text(job, "status")) == status,
            "JOB_CORRELATION",
        )?;
        if status == Some("completed") {
            let n = params["n"].as_u64().ok_or("JOB_RESULT")?;
            need(
                job["value"].as_u64() == Some(n * (n + 1) * (2 * n + 1) / 6),
                "JOB_RESULT",
            )?;
        }
        Ok(())
    }
    /// Executor loss is never evidence that an owned guest vanished.
    pub fn uncertain(&mut self) {
        if self.held {
            if let Some(s) = self.session.as_mut() {
                s["phase"] = json!("uncertain");
                if let Some(p) = self
                    .pending
                    .as_ref()
                    .filter(|p| text(&p.request, "op") == "run")
                {
                    s["job"] = json!({"job_id":p.request["params"]["job_id"],"operation":"sumsq","n":p.request["params"]["n"],"status":"unknown","value":null});
                }
            }
            self.pending = None;
        }
    }
}
