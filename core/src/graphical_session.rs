//! Core authority for graphical QEMU rewind sessions. This state is deliberately
//! separate from guest-command and MicroVM rewind state.
use crate::admission::{Frame, Surface};
use crate::wire::graphical_session::{GraphicalSessionEvent, GraphicalSessionRequest};
use crate::{Component, Endpoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_HISTORY: usize = 128;
const MAX_POINTS: usize = 4;
const DEADLINE_NS: u64 = 28_000_000_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub request: Value,
    pub caller: Endpoint,
    pub daemon: Endpoint,
    pub executor_epoch: u64,
    pub deadline_ns: u64,
    pub origin_generation: u64,
    pub origin_authority_epoch: u64,
    pub before_session: Option<Value>,
    pub before_frame: Option<Frame>,
    pub uncertain: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryEntry {
    pub request: Value,
    pub caller: Endpoint,
    pub reply: Value,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct State {
    pub session: Option<Value>,
    pub creator: Option<Endpoint>,
    pub pending: Option<Pending>,
    pub history: BTreeMap<String, HistoryEntry>,
    pub events: BTreeMap<String, Value>,
}
impl State {
    pub fn is_empty(&self) -> bool { self == &Self::default() }
    pub fn blocks_mutation(&self, surface_id: &str) -> bool {
        let pending_for_surface = self.pending.as_ref().is_some_and(|p| p.request["surface_id"] == surface_id);
        let unknown_for_surface = self.session.as_ref().is_some_and(|s| {
            s["surface_id"] == surface_id && matches!(s["phase"].as_str(), Some("outcome_unknown" | "stopping"))
        });
        pending_for_surface || unknown_for_surface
    }
    pub fn held_surface(&self) -> Option<&str> {
        if let Some(p) = &self.pending { return p.request["surface_id"].as_str(); }
        self.session.as_ref().filter(|s| s["ownership"] == "held").and_then(|s| s["surface_id"].as_str())
    }
    pub fn creator_can_stop(&self, surface_id: &str, caller: &crate::Endpoint) -> bool {
        caller.component == Component::Ui
            && self.held_surface() == Some(surface_id)
            && self.creator.as_ref() == Some(caller)
    }
    pub fn can_stop(
        &self,
        surface_id: &str,
        caller: &crate::Endpoint,
        registered_owner: Option<&crate::Endpoint>,
    ) -> bool {
        if self.creator_can_stop(surface_id, caller) {
            return true;
        }
        if self.held_surface() != Some(surface_id)
            || caller.component != Component::Agent
            || registered_owner != Some(caller)
        {
            return false;
        }
        let owner_id = self.pending.as_ref()
            .and_then(|pending| pending.request["owner_id"].as_str())
            .or_else(|| self.session.as_ref().and_then(|session| session["owner_id"].as_str()));
        let caller_id = crate::headless::actor_id(caller);
        owner_id == Some(caller_id.as_str())
    }
    pub fn blocks_profile_create(&self, profile_id: &str, kind: &str, bindings: &BTreeMap<String, String>) -> bool {
        let Some(surface_id) = self.held_surface() else { return false; };
        match bindings.get(surface_id) {
            Some(held_profile) => held_profile == profile_id,
            None => kind == "vm",
        }
    }
    pub fn blocks_profile_registration(
        &self,
        profile_id: Option<&str>,
        bindings: &BTreeMap<String, String>,
        admitted_profile_creates: &BTreeSet<String>,
    ) -> bool {
        if self.held_surface().is_none() { return false; }
        let Some(profile_id) = profile_id else { return true; };
        if !admitted_profile_creates.contains(profile_id) {
            return true;
        }
        // The admitted-profile set proves this profile passed its typed SurfaceRequest
        // fence. Reuse that profile-scoping predicate for its later registration.
        self.blocks_profile_create(profile_id, "browser", bindings)
    }
    pub fn saved_reply(&self, request_id: &str) -> Option<&Value> {
        self.history.get(request_id).map(|r| &r.reply)
    }
    pub fn history_request_matches(&self, request_id: &str, request: &Value, caller: &Endpoint) -> Option<bool> {
        self.history.get(request_id).map(|r| r.request == *request && r.caller == *caller)
    }
    pub fn request(
        &mut self,
        request: &GraphicalSessionRequest,
        caller: &Endpoint,
        agent: &Endpoint,
        daemon: &Endpoint,
        surfaces: &BTreeMap<String, Surface>,
        destroyed: &BTreeSet<String>,
        busy: bool,
        enabled: bool,
        budget: u64,
        now_ns: u64,
        executor_epoch: u64,
        core_seq: u64,
    ) -> Result<bool, &'static str> {
        let r = &request.0;
        let request_id = text(r, "request_id");
        let surface_id = text(r, "surface_id");
        let op = text(r, "op");
        if let Some(same) = self.history_request_matches(request_id, r, caller) {
            return if same { Ok(false) } else { Err("POLICY") };
        }
        if !enabled || caller.component != Component::Ui || agent.component != Component::Agent || daemon.component != Component::Daemon {
            return Err("UNAVAILABLE");
        }
        if budget == 0 { return Err("CAPACITY"); }
        if self.history.len() >= MAX_HISTORY { return Err("CAPACITY"); }
        let surface = surfaces.get(surface_id).ok_or("UNAVAILABLE")?;
        let expected_owner = crate::headless::actor_id(agent);
        // Input control may be human while the registered agent still owns the VM.
        if destroyed.contains(surface_id) || !surface.live || surface.owner != *agent
            || text(r, "owner_id") != expected_owner {
            return Err("POLICY");
        }
        if busy || self.pending.is_some() { return Err("BUSY"); }
        let (generation, authority_epoch, before_frame) = match op {
            "attach" => {
                if self.session.as_ref().is_some_and(|s| s["ownership"] != "released") || self.creator.is_some() {
                    return Err("BUSY");
                }
                (1, 1, surface.frame.clone())
            }
            "mark" | "restore" => {
                let s = self.session.as_ref().ok_or("UNAVAILABLE")?;
                let creator = self.creator.as_ref().ok_or("UNAVAILABLE")?;
                if creator != caller || s["surface_id"] != surface_id || s["owner_id"] != expected_owner
                    || s["ownership"] != "held" || s["phase"] != "ready" {
                    return Err("BUSY");
                }
                let generation = r["generation"].as_u64().ok_or("STALE")?;
                let authority_epoch = r["authority_epoch"].as_u64().ok_or("STALE")?;
                if generation != s["generation"].as_u64().unwrap_or(0)
                    || authority_epoch != s["authority_epoch"].as_u64().unwrap_or(0) {
                    return Err("STALE");
                }
                if op == "restore" {
                    let point_id = text(&r["params"], "point_id");
                    if point_id.len() > 30 { return Err("POINT_UNAVAILABLE"); }
                    if !s["points"].as_array().is_some_and(|points| points.iter().any(|p| p["point_id"] == point_id)) {
                        return Err("POINT_UNAVAILABLE");
                    }
                } else if s["points"].as_array().is_none_or(|points| points.len() >= MAX_POINTS) {
                    return Err("CAPACITY");
                }
                (generation, authority_epoch, surface.frame.clone())
            }
            _ => return Err("POLICY"),
        };
        if now_ns.checked_add(DEADLINE_NS).filter(|v| *v <= crate::MAX_WIRE_INTEGER).is_none() { return Err("CAPACITY"); }
        let deadline_ns = now_ns + DEADLINE_NS;
        let event = self.accepted_event(r, caller, generation, authority_epoch, core_seq);
        let session = if op == "attach" { None } else {
            let mut current = self.session.clone().ok_or("UNAVAILABLE")?;
            current["phase"] = json!("pending");
            current["pending_request_id"] = json!(request_id);
            Some(current)
        };
        self.history.insert(request_id.to_owned(), HistoryEntry { request: r.clone(), caller: caller.clone(), reply: event.clone() });
        let before_session = if op == "attach" { None } else { self.session.clone() };
        self.pending = Some(Pending { request: r.clone(), caller: caller.clone(), daemon: daemon.clone(), executor_epoch, deadline_ns, origin_generation: generation, origin_authority_epoch: authority_epoch, before_session, before_frame, uncertain: false });
        if op == "attach" { self.creator = Some(caller.clone()); self.session=None; }
        if let Some(session) = session { self.session = Some(session); }
        self.history.get_mut(request_id).expect("inserted history").reply = event;
        Ok(true)
    }
    fn accepted_event(&self, r: &Value, caller: &Endpoint, generation: u64, authority_epoch: u64, core_seq: u64) -> Value {
        let op = text(r, "op");
        let _ = caller;
        json!({"schema":"graphical_session_event/v0.2","event_id":format!("event-core-{core_seq}"),"request_id":r["request_id"],"owner_id":r["owner_id"],"surface_id":r["surface_id"],"generation":generation,"authority_epoch":authority_epoch,"op":op,"event":"accepted","reason_code":null,"point_id":if op=="restore" {r["params"]["point_id"].clone()} else {Value::Null},"session":self.session_for_accept(r),"elapsed_ms":null,"frame_sha256":null,"frame_generation":null})
    }
    fn session_for_accept(&self, r: &Value) -> Value {
        if r["op"] == "attach" { Value::Null } else {
            let mut s = self.session.clone().unwrap_or(Value::Null);
            if !s.is_null() { s["phase"] = json!("pending"); s["pending_request_id"] = r["request_id"].clone(); }
            s
        }
    }
    pub fn refusal_event(&self, r: &Value, caller: &Endpoint, code: &str, core_seq: u64) -> Value {
        let sid = text(r, "surface_id");
        let current = self.session.as_ref().filter(|s| {
            self.creator.as_ref() == Some(caller)
                && s["surface_id"] == sid
                && s["owner_id"] == r["owner_id"]
        }).cloned().unwrap_or(Value::Null);
        let generation = r["generation"].as_u64().or_else(|| current["generation"].as_u64()).unwrap_or(1);
        let epoch = r["authority_epoch"].as_u64().or_else(|| current["authority_epoch"].as_u64()).unwrap_or(1);
        let _ = caller;
        json!({"schema":"graphical_session_event/v0.2","event_id":format!("event-core-{core_seq}"),"request_id":r["request_id"],"owner_id":r["owner_id"],"surface_id":sid,"generation":generation,"authority_epoch":epoch,"op":r["op"],"event":"refused","reason_code":code,"point_id":null,"session":if current.is_null(){Value::Null}else{current},"elapsed_ms":null,"frame_sha256":null,"frame_generation":null})
    }
    pub fn observe(
        &mut self,
        notice: &GraphicalSessionEvent,
        sender: &Endpoint,
        executor_epoch: u64,
        surfaces: &BTreeMap<String, Surface>,
    ) -> Result<Option<Endpoint>, &'static str> {
        let e=&notice.0; let event_id=text(e,"event_id");
        if let Some(old)=self.events.get(event_id) { return if old==e { Ok(None) } else { Err("POLICY") }; }
        if self.events.len() >= MAX_HISTORY { return Err("CAPACITY"); }
        let p=self.pending.clone().ok_or("POLICY")?;
        if p.uncertain || p.daemon!=*sender || executor_epoch!=p.executor_epoch || e["event"]=="accepted"
            || e["request_id"]!=p.request["request_id"] || e["op"]!=p.request["op"]
            || e["surface_id"]!=p.request["surface_id"] || e["owner_id"]!=p.request["owner_id"] {
            return Err("POLICY");
        }
        let op=text(&p.request,"op"); let status=text(e,"event");
        if status=="outcome_unknown" {
            if e["reason_code"]!="OUTCOME_UNKNOWN" { return Err("POLICY"); }
            if !e["session"].is_null() {
                let mut s=e["session"].clone();
                self.check_binding(&s,&p)?;
                if s["phase"]!="outcome_unknown" || s["ownership"]!="held" { return Err("POLICY"); }
                if op=="attach" {
                    if s["generation"]!=1 || s["authority_epoch"]!=1 { return Err("STALE"); }
                } else if s["generation"]!=p.origin_generation || s["authority_epoch"]!=p.origin_authority_epoch
                    || s["points"]!=p.before_session.as_ref().ok_or("POLICY")?["points"] { return Err("STALE"); }
                s["phase"]=json!("outcome_unknown"); s["ownership"]=json!("held"); s["pending_request_id"]=p.request["request_id"].clone();
                self.session=Some(s);
            }
            self.pending.as_mut().unwrap().uncertain=true;
        } else if status=="refused" {
            if e["reason_code"].is_null() || e["reason_code"]=="OUTCOME_UNKNOWN" { return Err("POLICY"); }
            if op=="attach" {
                if !e["session"].is_null() { return Err("POLICY"); }
                self.session=None; self.creator=None;
            } else {
                let s=e["session"].as_object().ok_or("POLICY")?;
                self.check_binding(&Value::Object(s.clone()),&p)?;
                if e["generation"]!=p.origin_generation || e["authority_epoch"]!=p.origin_authority_epoch { return Err("STALE"); }
                let old=p.before_session.as_ref().ok_or("POLICY")?;
                if s["phase"]!="ready" || s["ownership"]!="held" || s["points"]!=old["points"] { return Err("POLICY"); }
                self.session=Some(Value::Object(s.clone()));
            }
            self.pending=None;
        } else if status=="completed" {
            let s=e["session"].as_object().ok_or("POLICY")?; let session=Value::Object(s.clone());
            self.check_binding(&session,&p)?;
            if session["phase"]!="ready" || session["ownership"]!="held" || !e["reason_code"].is_null() { return Err("POLICY"); }
            match op {
                "attach" => {
                    if session["generation"]!=1 || session["authority_epoch"]!=1 || e["generation"]!=1 || e["authority_epoch"]!=1 { return Err("STALE"); }
                    if session["points"].as_array().is_none_or(|points| !points.is_empty()) { return Err("POLICY"); }
                }
                "mark" => {
                    if e["generation"]!=p.origin_generation || e["authority_epoch"]!=p.origin_authority_epoch
                        || session["generation"]!=p.origin_generation || session["authority_epoch"]!=p.origin_authority_epoch { return Err("STALE"); }
                    let old=p.before_session.as_ref().ok_or("POLICY")?;
                    let old_points=old["points"].as_array().ok_or("POLICY")?; let new_points=session["points"].as_array().ok_or("POLICY")?;
                    if old_points.len()>=MAX_POINTS || new_points.len()!=old_points.len()+1 || new_points[..old_points.len()]!=old_points[..]
                        || old_points.iter().any(|pt| pt["point_id"]==e["point_id"])
                        || new_points.last().is_none_or(|pt| pt["point_id"]!=e["point_id"] || pt["generation"]!=p.origin_generation || pt["label"]!=p.request["params"]["label"]) { return Err("CAPACITY"); }
                }
                "restore" => {
                    let expected_gen=p.origin_generation.checked_add(1).ok_or("STALE")?;
                    let expected_epoch=p.origin_authority_epoch.checked_add(1).ok_or("STALE")?;
                    if session["generation"]!=expected_gen || session["authority_epoch"]!=expected_epoch || e["generation"]!=expected_gen || e["authority_epoch"]!=expected_epoch
                        || session["points"]!=p.before_session.as_ref().ok_or("POLICY")?["points"] { return Err("STALE"); }
                    let frame=surfaces.get(text(&p.request,"surface_id")).and_then(|s|s.frame.as_ref()).ok_or("STALE")?;
                    if p.before_frame.as_ref().is_none_or(|old| frame.generation<=old.generation)
                        || e["frame_sha256"]!=frame.sha256 || e["frame_generation"]!=frame.generation { return Err("STALE"); }
                }
                _=>return Err("POLICY")
            }
            self.session=Some(session); self.pending=None;
        } else { return Err("POLICY"); }
        self.events.insert(event_id.to_owned(),e.clone());
        if let Some(h)=self.history.get_mut(text(&p.request,"request_id")) { h.reply=e.clone(); }
        Ok(Some(p.caller))
    }
    fn check_binding(&self, session:&Value, pending:&Pending)->Result<(), &'static str> {
        if session["surface_id"]!=pending.request["surface_id"] || session["owner_id"]!=pending.request["owner_id"]
            || !valid_runtime_id(session["runtime_id"].as_str().unwrap_or(""))
            || session["authority"]!="core" || session["backend"]!="qemu" || session["isa"]!="aarch64" { return Err("POLICY"); }
        if pending.request["op"]!="attach" {
            let old=self.session.as_ref().ok_or("POLICY")?;
            if session["runtime_id"]!=old["runtime_id"] { return Err("POLICY"); }
        }
        Ok(())
    }
    pub fn uncertain(&mut self, core_seq:u64) -> Option<Value> {
        let Some(p)=self.pending.as_mut() else {
            if let Some(s)=self.session.as_mut().filter(|s| s["ownership"]=="held") {
                s["phase"]=json!("outcome_unknown");
                s["pending_request_id"]=Value::Null;
            }
            return None;
        };
        if p.uncertain { return None; }
        p.uncertain=true;
        if let Some(s)=self.session.as_mut() { s["phase"]=json!("outcome_unknown"); s["ownership"]=json!("held"); s["pending_request_id"]=p.request["request_id"].clone(); }
        let r=&p.request;
        let event=json!({"schema":"graphical_session_event/v0.2","event_id":format!("event-core-{core_seq}"),"request_id":r["request_id"],"owner_id":r["owner_id"],"surface_id":r["surface_id"],"generation":p.origin_generation,"authority_epoch":p.origin_authority_epoch,"op":r["op"],"event":"outcome_unknown","reason_code":"OUTCOME_UNKNOWN","point_id":null,"session":self.session.clone().unwrap_or(Value::Null),"elapsed_ms":null,"frame_sha256":null,"frame_generation":null});
        if let Some(h)=self.history.get_mut(text(r,"request_id")) { h.reply=event.clone(); }
        Some(event)
    }
    pub fn destroyed(&mut self, surface_id:&str) {
        let matches=self.held_surface()==Some(surface_id) || self.session.as_ref().is_some_and(|s|s["surface_id"]==surface_id);
        if !matches { return; }
        self.pending=None;
        if let Some(s)=self.session.as_mut() { s["phase"]=json!("stopped"); s["ownership"]=json!("released"); s["pending_request_id"]=Value::Null; }
        self.creator=None;
        self.history.clear();
        self.events.clear();
    }
}
fn text<'a>(value:&'a Value,key:&str)->&'a str { value[key].as_str().unwrap_or("") }
fn valid_runtime_id(value:&str)->bool {
    value.strip_prefix("runtime-").is_some_and(|suffix| suffix.len()==64
        && suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
