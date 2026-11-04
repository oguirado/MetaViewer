//! Public-event REWIND integration. Physical evidence is owned by the registered
//! daemon; this reducer never invents PID, mapping, entropy or closure records.
use crate::wire::rewind::{RewindEvent, RewindRequest};
use crate::{Component, Endpoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
const MAX: u64 = 9_007_199_254_740_991;
fn need(b: bool, e: &'static str) -> Result<(), &'static str> {
    if b {
        Ok(())
    } else {
        Err(e)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub workload_id: String,
    pub owner_id: String,
    pub generation: u64,
    pub authority_epoch: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub request: Value,
    pub accepted: bool,
    pub origin_phase: String,
    pub origin_generation: u64,
    pub origin_epoch: u64,
    pub point_id: Option<String>,
    #[serde(default)]
    pub victim_id: Option<String>,
    #[serde(default)]
    pub point_order: Option<u64>,
    pub deadline_ns: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub target: Option<Target>,
    pub session: Option<Value>,
    pub pending: Option<Pending>,
    pub unknown: bool,
    #[serde(default)]
    pub stopping: bool,
    pub creator: Option<Endpoint>,
    pub requests: BTreeSet<String>,
    pub events: BTreeSet<String>,
}
impl State {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
    pub fn status(&self) -> Option<Value> {
        self.session.clone()
    }
    pub fn allows_command(&self) -> bool {
        self.is_empty()
            || !self.unknown
                && !self.stopping
                && self.pending.is_none()
                && self.session.as_ref().is_none_or(|s| s["phase"] == "ready")
    }
    pub fn stale_gc(&self, event: &Value) -> bool {
        self.target.as_ref().is_some_and(|t| {
            event["session"].is_object()
                && (event["session"]["workload_id"] != t.workload_id
                    || event["session"]["generation"] != t.generation)
        })
    }
    pub fn submit(
        &mut self,
        r: &RewindRequest,
        gc: &crate::guest_command::State,
        caller: &Endpoint,
        agent: &Endpoint,
        sid: &str,
        now: u64,
    ) -> Result<(), &'static str> {
        let mut n = self.clone();
        n.submit_inner(r, gc, caller, agent, sid, now)?;
        *self = n;
        Ok(())
    }
    fn submit_inner(
        &mut self,
        r: &RewindRequest,
        gc: &crate::guest_command::State,
        caller: &Endpoint,
        agent: &Endpoint,
        sid: &str,
        now: u64,
    ) -> Result<(), &'static str> {
        need(
            (caller.component == Component::Ui && gc.creator.as_ref() == Some(caller))
                || (caller.component == Component::Agent && caller == agent),
            "OWNER",
        )?;
        let g = gc.session.as_ref().ok_or("UNAVAILABLE")?;
        need(
            gc.held
                && (!gc.unknown
                    || self
                        .session
                        .as_ref()
                        .is_some_and(|s| s["phase"] == "recoverable"))
                && gc.pending.is_empty()
                && g["ownership"] == "held"
                && !matches!(
                    g["job"]["state"].as_str(),
                    Some("running" | "cancelling" | "unknown")
                ),
            "BUSY",
        )?;
        if self.target.is_none() {
            need(g["phase"] == "ready", "BUSY")?;
            self.target = Some(Target {
                workload_id: g["workload_id"].as_str().ok_or("INVALID")?.into(),
                owner_id: crate::headless::actor_id(agent),
                generation: g["generation"].as_u64().ok_or("INVALID")?,
                authority_epoch: 1,
            });
            self.creator = gc.creator.clone();
        }
        let t = self.target.as_mut().unwrap();
        let p = &r.0["params"];
        let rid = r.0["request_id"].as_str().ok_or("INVALID")?;
        let op = r.0["op"].as_str().ok_or("INVALID")?;
        need(
            g["owner_id"] == t.owner_id && g["workload_id"] == t.workload_id,
            "OWNER",
        )?;
        need(
            p["workload_id"] == t.workload_id
                && p["generation"] == t.generation
                && p["authority_epoch"] == t.authority_epoch,
            "STALE",
        )?;
        need(
            !self.unknown && !self.stopping && self.pending.is_none(),
            "BUSY",
        )?;
        need(
            self.requests.len() < 256 && !self.requests.contains(rid),
            "DUPLICATE",
        )?;
        let phase = self
            .session
            .as_ref()
            .and_then(|s| s["phase"].as_str())
            .unwrap_or("ready")
            .to_owned();
        let points = self.session.as_ref().and_then(|s| s["points"].as_array());
        match op {
            "pause" => need(phase == "ready", "BUSY")?,
            "resume" => need(phase == "paused", "BUSY")?,
            "mark" => {
                need(phase == "ready" || phase == "paused", "BUSY")?;
                need(
                    points.is_none_or(|p| {
                        p.len() < 2 || p.iter().any(|q| q["active_references"] == 0)
                    }),
                    "CAPACITY",
                )?;
                need(
                    points.is_none_or(|p| {
                        p.iter()
                            .filter_map(|q| q["created_order"].as_u64())
                            .max()
                            .unwrap_or(0)
                            < MAX
                    }),
                    "CAPACITY",
                )?;
            }
            "restore" => {
                need(phase == "paused" || phase == "recoverable", "BUSY")?;
                if phase == "recoverable" {
                    need(
                        self.session
                            .as_ref()
                            .is_some_and(|s| s["last_good_usable"] == p["point_id"]),
                        "POINT_UNAVAILABLE",
                    )?;
                }
                need(
                    points.is_some_and(|ps| {
                        ps.iter().any(|x| {
                            x["point_id"] == p["point_id"]
                                && x["status"] == "usable"
                                && Some(&x["compatibility_sha256"])
                                    == self.session.as_ref().map(|s| &s["compatibility_sha256"])
                        })
                    }),
                    "POINT_UNAVAILABLE",
                )?;
            }
            _ => return Err("INVALID"),
        }
        let origin_generation = t.generation;
        let origin_epoch = t.authority_epoch;
        if op == "resume" || op == "restore" || op == "mark" && phase == "ready" {
            t.generation = t
                .generation
                .checked_add(1)
                .filter(|n| *n <= MAX)
                .ok_or("CAPACITY")?;
            t.authority_epoch = t
                .authority_epoch
                .checked_add(1)
                .filter(|n| *n <= MAX)
                .ok_or("CAPACITY")?;
        }
        let point_id = if op == "mark" {
            let mut h = Sha256::new();
            for x in [sid, t.workload_id.as_str(), rid] {
                h.update((x.len() as u64).to_be_bytes());
                h.update(x.as_bytes());
            }
            Some(format!("point-{:x}", h.finalize()))
        } else {
            None
        };
        let victim_id = if op == "mark" {
            points.filter(|ps| ps.len() == 2).and_then(|ps| {
                ps.iter()
                    .filter(|q| q["active_references"] == 0)
                    .min_by_key(|q| {
                        (
                            q["created_order"].as_u64().unwrap_or(MAX),
                            q["point_id"].as_str().unwrap_or(""),
                        )
                    })
                    .and_then(|q| q["point_id"].as_str())
                    .map(str::to_owned)
            })
        } else {
            None
        };
        let point_order = if op == "mark" {
            Some(
                points
                    .map(|ps| {
                        ps.iter()
                            .filter_map(|q| q["created_order"].as_u64())
                            .max()
                            .unwrap_or(0)
                    })
                    .unwrap_or(0)
                    + 1,
            )
        } else {
            None
        };
        self.requests.insert(rid.into());
        self.pending = Some(Pending {
            request: r.0.clone(),
            accepted: false,
            origin_phase: phase,
            origin_generation,
            origin_epoch,
            point_id,
            victim_id,
            point_order,
            deadline_ns: now.checked_add(35_000_000_000).ok_or("CAPACITY")?,
        });
        if let Some(s) = self.session.as_mut() {
            s["generation"] = json!(t.generation);
            s["authority_epoch"] = json!(t.authority_epoch);
            s["pending_request_id"] = json!(rid);
            s["phase"] = json!(match op {
                "pause" => "pausing",
                "resume" => "resuming",
                "mark" => "marking",
                _ => "restoring",
            });
        }
        Ok(())
    }
    fn tuple(&self, s: &Value) -> bool {
        self.target.as_ref().is_some_and(|t| {
            s["workload_id"] == t.workload_id
                && s["owner_id"] == t.owner_id
                && s["generation"] == t.generation
                && s["authority_epoch"] == t.authority_epoch
                && s["ownership"] == "held"
        })
    }
    pub fn observe(&mut self, e: &RewindEvent) -> Result<(), &'static str> {
        let mut n = self.clone();
        n.observe_inner(e)?;
        if n.stopping && matches!(e.0["event"].as_str(), Some("accepted" | "completed")) {
            if let Some(s) = n.session.as_mut() {
                s["phase"] = json!("stopping");
            }
        }
        *self = n;
        Ok(())
    }
    fn observe_inner(&mut self, e: &RewindEvent) -> Result<(), &'static str> {
        let t = self.target.as_ref().ok_or("UNAVAILABLE")?;
        let p = self.pending.clone().ok_or("CORRELATION")?;
        let v = &e.0;
        let rid = p.request["request_id"].as_str().ok_or("INVALID")?;
        let op = p.request["op"].as_str().ok_or("INVALID")?;
        let kind = v["event"].as_str().ok_or("INVALID")?;
        let eid = v["event_id"].as_str().ok_or("INVALID")?;
        need(
            v["owner_id"] == t.owner_id && v["request_id"] == rid && v["data"]["op"] == op,
            "CORRELATION",
        )?;
        need(
            self.events.len() < 1024 && !self.events.contains(eid),
            "DUPLICATE",
        )?;
        if kind == "refused" {
            self.events.insert(eid.into());
            self.mark_unknown();
            return Ok(());
        }
        if kind == "outcome_unknown" && v["session"].is_null() {
            self.events.insert(eid.into());
            self.mark_unknown();
            return Ok(());
        }
        let s = &v["session"];
        need(self.tuple(s), "STALE")?;
        if let Some(old) = &self.session {
            need(
                s["compatibility_sha256"] == old["compatibility_sha256"],
                "IMMUTABLE",
            )?;
        }
        let old_points = self
            .session
            .as_ref()
            .map(|s| s["points"].clone())
            .unwrap_or(json!([]));
        match kind {
            "recovery_ready" => {
                need(
                    !self.stopping
                        && self.unknown
                        && op == "restore"
                        && v["data"]["failed_request_id"] == rid
                        && v["data"]["point_id"] == p.request["params"]["point_id"]
                        && v["data"]["no_active_vmm"] == true
                        && s["phase"] == "recoverable"
                        && s["pending_request_id"].is_null(),
                    "ORDER",
                )?;
                let mut expected = old_points.clone();
                for q in expected.as_array_mut().ok_or("INVALID")? {
                    q["active_references"] = json!(0);
                }
                need(
                    s["points"] == expected
                        && s["last_good_usable"] == p.request["params"]["point_id"],
                    "IMMUTABLE",
                )?;
                validate_points(s)?;
                self.session = Some(s.clone());
                self.pending = None;
                self.unknown = false;
            }
            "accepted" => {
                need(!p.accepted && !self.unknown, "ORDER")?;
                need(
                    s["phase"]
                        == match op {
                            "pause" => "pausing",
                            "resume" => "resuming",
                            "mark" => "marking",
                            _ => "restoring",
                        }
                        && s["pending_request_id"] == rid
                        && s["points"] == old_points
                        && self
                            .session
                            .as_ref()
                            .is_none_or(|old| s["last_good_usable"] == old["last_good_usable"]),
                    "ORDER",
                )?;
                validate_points(s)?;
                self.pending.as_mut().unwrap().accepted = true;
                self.session = Some(s.clone());
            }
            "outcome_unknown" => {
                need(
                    s["phase"] == "uncertain" && s["pending_request_id"] == rid,
                    "ORDER",
                )?;
                let last = self
                    .session
                    .as_ref()
                    .map(|old| old["last_good_usable"].clone())
                    .unwrap_or(Value::Null);
                need(
                    s["points"] == old_points && s["last_good_usable"] == last,
                    "IMMUTABLE",
                )?;
                validate_points(s)?;
                if self.session.is_none() {
                    self.session = Some(s.clone());
                } else if let Some(old) = self.session.as_mut() {
                    old["guest_counter"] = s["guest_counter"].clone();
                }
                self.mark_unknown();
            }
            "completed" => {
                need(
                    p.accepted && !self.unknown && s["pending_request_id"].is_null(),
                    "ORDER",
                )?;
                let phase = if op == "pause" || op == "mark" && p.origin_phase == "paused" {
                    "paused"
                } else {
                    "ready"
                };
                need(s["phase"] == phase, "ORDER")?;
                if op == "mark" {
                    let ps = s["points"].as_array().ok_or("INVALID")?;
                    let original = old_points.as_array().ok_or("INVALID")?;
                    let olds: Vec<Value> = original
                        .iter()
                        .filter(|q| p.victim_id.as_ref().is_none_or(|id| q["point_id"] != *id))
                        .cloned()
                        .collect();
                    need(
                        ps.len() == olds.len() + 1 && ps[..olds.len()] == olds[..],
                        "IMMUTABLE",
                    )?;
                    let q = ps.last().ok_or("INVALID")?;
                    need(
                        q["point_id"]
                            == p.point_id.as_ref().map(|x| json!(x)).unwrap_or(Value::Null)
                            && v["data"]["point_id"] == q["point_id"]
                            && q["source_generation"] == p.origin_generation
                            && q["source_authority_epoch"] == p.origin_epoch
                            && q["label"] == p.request["params"]["label"]
                            && q["compatibility_sha256"] == s["compatibility_sha256"]
                            && q["status"] == "usable"
                            && q["active_references"] == 0
                            && q["created_order"].as_u64() == p.point_order
                            && s["last_good_usable"] == q["point_id"],
                        "POINT",
                    )?;
                } else if op == "restore" {
                    need(
                        v["data"]["point_id"] == p.request["params"]["point_id"],
                        "POINT",
                    )?;
                    let mut expected = old_points.clone();
                    for q in expected.as_array_mut().ok_or("INVALID")? {
                        q["active_references"] =
                            json!(if q["point_id"] == p.request["params"]["point_id"] {
                                1
                            } else {
                                0
                            });
                    }
                    need(
                        s["points"] == expected
                            && s["last_good_usable"] == p.request["params"]["point_id"],
                        "IMMUTABLE",
                    )?;
                } else {
                    need(
                        s["points"] == old_points
                            && v["data"]["point_id"].is_null()
                            && self
                                .session
                                .as_ref()
                                .is_none_or(|old| s["last_good_usable"] == old["last_good_usable"]),
                        "IMMUTABLE",
                    )?;
                }
                validate_points(s)?;
                self.session = Some(s.clone());
                self.pending = None;
            }
            _ => return Err("INVALID"),
        }
        self.events.insert(eid.into());
        Ok(())
    }
    pub fn mark_unknown(&mut self) {
        if self.target.is_some()
            && self
                .session
                .as_ref()
                .is_none_or(|s| s["phase"] != "stopped")
        {
            self.unknown = true;
            if let Some(s) = self.session.as_mut() {
                s["phase"] = json!("uncertain");
            }
        }
    }
    pub fn expired(&self, now: u64) -> bool {
        !self.unknown && self.pending.as_ref().is_some_and(|p| now >= p.deadline_ns)
    }
    pub fn prepare_stop(
        &self,
        r: &Value,
        gc: &mut crate::guest_command::State,
    ) -> Result<(), &'static str> {
        if r["op"] == "stop" {
            if let Some(t) = &self.target {
                need(
                    r["params"]["workload_id"] == t.workload_id
                        && r["params"]["generation"] == t.generation,
                    "STALE",
                )?;
                if let Some(g) = gc.session.as_mut() {
                    g["generation"] = json!(t.generation);
                }
            }
        }
        Ok(())
    }
    pub fn begin_stop(&mut self) {
        if self.target.is_some() {
            self.stopping = true;
            if let Some(s) = self.session.as_mut() {
                s["phase"] = json!("stopping");
            }
        }
    }
    pub fn gc_stopped(&mut self, g: &Value) {
        if self
            .target
            .as_ref()
            .is_some_and(|t| g["workload_id"] == t.workload_id && g["generation"] == t.generation)
            && g["phase"] == "stopped"
            && g["ownership"] == "released"
        {
            if let Some(s) = self.session.as_mut() {
                s["phase"] = json!("stopped");
                s["ownership"] = json!("released");
                s["pending_request_id"] = Value::Null;
                if let Some(ps) = s["points"].as_array_mut() {
                    for p in ps {
                        p["active_references"] = json!(0);
                    }
                }
            }
            self.pending = None;
            self.unknown = false;
            self.stopping = false;
        }
    }
}
fn validate_points(s: &Value) -> Result<(), &'static str> {
    let ps = s["points"].as_array().ok_or("INVALID")?;
    let mut ids = BTreeSet::new();
    for p in ps {
        need(
            ids.insert(p["point_id"].as_str().ok_or("INVALID")?)
                && p["compatibility_sha256"] == s["compatibility_sha256"],
            "POINT",
        )?;
    }
    need(
        s["last_good_usable"].is_null()
            || ps
                .iter()
                .any(|p| p["point_id"] == s["last_good_usable"] && p["status"] == "usable"),
        "POINT",
    )
}
