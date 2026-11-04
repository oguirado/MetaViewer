use metaviewer_core::{
    admission::{CoreState, Input},
    wire::rewind::{RewindEvent, RewindRequest},
    Component, Endpoint,
};
use serde_json::{json, Value};
fn agent() -> Endpoint {
    Endpoint {
        component: Component::Agent,
        instance: "agent-one".into(),
    }
}
fn ui() -> Endpoint {
    Endpoint {
        component: Component::Ui,
        instance: "ui-one".into(),
    }
}
fn state() -> CoreState {
    let mut c = CoreState::session("rewind-test").unwrap();
    c.epoch = 1;
    let owner = metaviewer_core::headless::actor_id(&agent());
    c.guest_command.held = true;
    c.guest_command.started = true;
    c.guest_command.reservation = Some("reservation-test".into());
    c.guest_command.create_id = Some("request-create".into());
    c.guest_command.actor = Some(owner.clone());
    c.guest_command.creator = Some(ui());
    c.guest_command.session = Some(
        json!({"schema":"guest_command_session/v0.2","workload_id":"workload-one","generation":1,"owner_id":owner,"profile_id":"guest-command-arm64-v1","backend":"firecracker","isa":"aarch64","phase":"ready","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}}),
    );
    c
}
fn request(c: &CoreState, op: &str, id: &str) -> RewindRequest {
    let (g, e) = c
        .rewind
        .target
        .as_ref()
        .map(|t| (t.generation, t.authority_epoch))
        .unwrap_or((1, 1));
    let mut params = json!({"workload_id":"workload-one","generation":g,"authority_epoch":e});
    if op == "mark" {
        params["label"] = json!("Before edit");
    }
    if op == "restore" {
        params["point_id"] = c.rewind.session.as_ref().unwrap()["last_good_usable"].clone();
    }
    serde_json::from_value(json!({"schema":"rewind_request/v0.2","request_id":format!("request-{id}"),"op":op,"params":params})).unwrap()
}
fn submit(c: &mut CoreState, r: &RewindRequest) {
    assert!(c
        .apply(&Input::RewindRequest {
            request: r.clone(),
            caller: ui(),
            agent: agent(),
            received_ns: 10,
            enabled: true
        })
        .unwrap()
        .reason
        .is_none());
}
fn event(c: &CoreState, r: &RewindRequest, kind: &str) -> Value {
    let t = c.rewind.target.as_ref().unwrap();
    let mut s = c.rewind.status().unwrap_or_else(|| {
        serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/rewind_session.valid.json"
        ))
        .unwrap()
    });
    s["workload_id"] = json!(t.workload_id);
    s["owner_id"] = json!(t.owner_id);
    s["generation"] = json!(t.generation);
    s["authority_epoch"] = json!(t.authority_epoch);
    if c.rewind.session.is_none() {
        s["points"] = json!([]);
        s["last_good_usable"] = Value::Null;
    }
    s["phase"] = json!(if kind == "accepted" {
        match r.0["op"].as_str().unwrap() {
            "pause" => "pausing",
            "resume" => "resuming",
            "mark" => "marking",
            _ => "restoring",
        }
    } else if kind == "outcome_unknown" {
        "uncertain"
    } else if r.0["op"] == "pause" {
        "paused"
    } else {
        "ready"
    });
    s["pending_request_id"] = if kind == "completed" {
        Value::Null
    } else {
        r.0["request_id"].clone()
    };
    let mut data = json!({"op":r.0["op"]});
    if kind == "completed" {
        data["point_id"] = Value::Null;
    }
    if kind == "outcome_unknown" {
        data["code"] = json!("NATIVE");
    }
    json!({"schema":"rewind_event/v0.2","event_id":format!("event-{}-{kind}",r.0["request_id"].as_str().unwrap()),"request_id":r.0["request_id"],"owner_id":t.owner_id,"event":kind,"session":s,"data":data})
}
fn observe(c: &mut CoreState, e: Value) {
    let e: RewindEvent = serde_json::from_value(e).unwrap();
    assert!(c
        .apply(&Input::RewindEvent {
            notice: e,
            executor_epoch: 1
        })
        .unwrap()
        .reason
        .is_none());
}
fn pause(c: &mut CoreState) {
    let r = request(c, "pause", "pause");
    submit(c, &r);
    observe(c, event(c, &r, "accepted"));
    observe(c, event(c, &r, "completed"));
}
fn mark(c: &mut CoreState) {
    mark_named(c, "mark")
}
fn mark_named(c: &mut CoreState, name: &str) {
    let r = request(c, "mark", name);
    submit(c, &r);
    observe(c, event(c, &r, "accepted"));
    let p = c.rewind.pending.as_ref().unwrap();
    let id = p.point_id.clone().unwrap();
    let mut e = event(c, &r, "completed");
    let mut point: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/rewind_point.valid.json"
    ))
    .unwrap();
    point["point_id"] = json!(id);
    point["created_order"] = json!(p.point_order.unwrap());
    point["source_generation"] = json!(p.origin_generation);
    point["source_authority_epoch"] = json!(p.origin_epoch);
    let mut ps = c.rewind.status().unwrap()["points"]
        .as_array()
        .unwrap()
        .clone();
    ps.retain(|q| p.victim_id.as_ref().is_none_or(|id| q["point_id"] != *id));
    ps.push(point);
    e["session"]["points"] = json!(ps);
    e["session"]["last_good_usable"] = json!(id);
    e["data"]["point_id"] = json!(id);
    observe(c, e);
}
#[test]
fn initialized_only_after_correlated_daemon_metadata() {
    let mut c = state();
    let r = request(&c, "pause", "pause");
    submit(&mut c, &r);
    assert!(c.rewind.status().is_none());
    assert!(!c.rewind.allows_command());
    {
        let e = event(&c, &r, "accepted");
        observe(&mut c, e);
    }
    assert_eq!(c.rewind.status().unwrap()["phase"], "pausing");
}
#[test]
fn core_target_precedes_dispatch_but_gc_projection_waits_ready() {
    let mut c = state();
    pause(&mut c);
    let r = request(&c, "resume", "resume");
    submit(&mut c, &r);
    assert_eq!(c.rewind.target.as_ref().unwrap().generation, 2);
    assert_eq!(c.guest_command.session.as_ref().unwrap()["generation"], 1);
    {
        let e = event(&c, &r, "accepted");
        observe(&mut c, e);
    }
    {
        let e = event(&c, &r, "completed");
        observe(&mut c, e);
    }
    assert_eq!(c.guest_command.session.as_ref().unwrap()["generation"], 2);
    assert!(c.rewind.allows_command());
}
#[test]
fn foreign_and_disabled_requests_do_not_initialize() {
    for enabled in [false, true] {
        let mut c = state();
        let r = request(&c, "pause", "pause");
        let caller = Endpoint {
            component: Component::Agent,
            instance: "foreign".into(),
        };
        let out = c
            .apply(&Input::RewindRequest {
                request: r,
                caller,
                agent: agent(),
                received_ns: 0,
                enabled,
            })
            .unwrap();
        assert!(out.reason.is_some());
        assert!(c.rewind.is_empty());
    }
}
#[test]
fn stale_wrong_executor_events_never_mutate_rewind() {
    let mut c = state();
    let r = request(&c, "pause", "pause");
    submit(&mut c, &r);
    let before = c.rewind.clone();
    let e: RewindEvent = serde_json::from_value(event(&c, &r, "accepted")).unwrap();
    assert!(c
        .apply(&Input::RewindEvent {
            notice: e,
            executor_epoch: 2
        })
        .unwrap()
        .reason
        .is_some());
    assert_eq!(c.rewind, before);
}
#[test]
fn unknown_preserves_ring_and_refuses_automatic_replay() {
    let mut c = state();
    mark(&mut c);
    pause(&mut c);
    let r = request(&c, "restore", "restore");
    submit(&mut c, &r);
    {
        let e = event(&c, &r, "accepted");
        observe(&mut c, e);
    }
    let points = c.rewind.status().unwrap()["points"].clone();
    {
        let e = event(&c, &r, "outcome_unknown");
        observe(&mut c, e);
    }
    assert_eq!(c.rewind.status().unwrap()["points"], points);
    let again = request(&c, "restore", "again");
    assert!(c
        .apply(&Input::RewindRequest {
            request: again,
            caller: ui(),
            agent: agent(),
            received_ns: 0,
            enabled: true
        })
        .unwrap()
        .reason
        .is_some());
}
#[test]
fn recovery_ready_allows_only_new_explicit_restore() {
    let mut c = state();
    mark(&mut c);
    pause(&mut c);
    let r = request(&c, "restore", "restore");
    submit(&mut c, &r);
    {
        let e = event(&c, &r, "accepted");
        observe(&mut c, e);
    }
    {
        let e = event(&c, &r, "outcome_unknown");
        observe(&mut c, e);
    }
    let mut recovery = event(&c, &r, "outcome_unknown");
    recovery["event"] = json!("recovery_ready");
    recovery["event_id"] = json!("event-recovery");
    recovery["session"]["phase"] = json!("recoverable");
    recovery["session"]["pending_request_id"] = Value::Null;
    recovery["data"] = json!({"op":"restore","failed_request_id":r.0["request_id"],"point_id":r.0["params"]["point_id"],"no_active_vmm":true});
    observe(&mut c, recovery);
    assert!(!c.rewind.allows_command());
    let next = request(&c, "restore", "new-manual");
    submit(&mut c, &next);
    assert_eq!(c.rewind.target.as_ref().unwrap().generation, 4);
}
#[test]
fn serialized_state_retains_pending_target_and_unknown() {
    let mut c = state();
    pause(&mut c);
    let r = request(&c, "resume", "resume");
    submit(&mut c, &r);
    c.apply(&Input::RewindUncertain).unwrap();
    let decoded: CoreState = serde_json::from_slice(&c.snapshot().unwrap()).unwrap();
    assert_eq!(decoded.rewind, c.rewind);
    assert!(!decoded.rewind.allows_command());
}

#[test]
fn overflow_refuses_without_changing_target() {
    let mut c = state();
    pause(&mut c);
    c.rewind.target.as_mut().unwrap().generation = 9_007_199_254_740_991;
    let r = request(&c, "resume", "overflow");
    let before = c.rewind.clone();
    assert!(c
        .apply(&Input::RewindRequest {
            request: r,
            caller: ui(),
            agent: agent(),
            received_ns: 0,
            enabled: true
        })
        .unwrap()
        .reason
        .is_some());
    assert_eq!(c.rewind, before);
}
#[test]
fn stop_uses_new_resource_generation_and_closure_releases_rewind() {
    let mut c = state();
    pause(&mut c);
    let r = request(&c, "resume", "resume-stop");
    submit(&mut c, &r);
    assert_eq!(c.guest_command.session.as_ref().unwrap()["generation"], 1);
    let stop:metaviewer_core::wire::guest_command::GuestCommandRequest=serde_json::from_value(json!({"schema":"guest_command_request/v0.2","request_id":"request-stop","op":"stop","params":{"workload_id":"workload-one","generation":2}})).unwrap();
    assert!(c
        .apply(&Input::GuestCommandRequest {
            request: stop,
            caller: ui(),
            agent: agent(),
            other_resources: false,
            received_ns: 20
        })
        .unwrap()
        .reason
        .is_none());
    assert!(c.rewind.stopping);
    assert_eq!(c.guest_command.session.as_ref().unwrap()["generation"], 2);
    let mut snap = c.guest_command.session.clone().unwrap();
    snap["phase"] = json!("stopping");
    snap["controls"]["stop"] = json!({"request_id":"request-stop","ack":"accepted"});
    let e:metaviewer_core::wire::guest_command::GuestCommandEvent=serde_json::from_value(json!({"schema":"guest_command_event/v0.2","event_id":"event-stop-accepted","request_id":"request-stop","reservation_id":"reservation-test","owner_id":metaviewer_core::headless::actor_id(&agent()),"event":"accepted","session":snap,"data":{"op":"stop"}})).unwrap();
    assert!(c
        .apply(&Input::GuestCommandEvent {
            notice: e,
            executor_epoch: 1
        })
        .unwrap()
        .reason
        .is_none());
    snap["phase"] = json!("stopped");
    snap["ownership"] = json!("released");
    let e:metaviewer_core::wire::guest_command::GuestCommandEvent=serde_json::from_value(json!({"schema":"guest_command_event/v0.2","event_id":"event-stopped","request_id":"request-stop","reservation_id":"reservation-test","owner_id":metaviewer_core::headless::actor_id(&agent()),"event":"stopped","session":snap,"data":{"native_absent":true}})).unwrap();
    assert!(c
        .apply(&Input::GuestCommandEvent {
            notice: e,
            executor_epoch: 1
        })
        .unwrap()
        .reason
        .is_none());
    assert!(!c.guest_command.held);
    assert_eq!(c.rewind.status().unwrap()["ownership"], "released");
    c.apply(&Input::Connect).unwrap();
    assert_eq!(c.rewind.status().unwrap()["phase"], "stopped");
}

#[test]
fn third_mark_rotates_only_unmapped_oldest_and_failure_preserves_ring() {
    let mut c = state();
    mark_named(&mut c, "first");
    mark_named(&mut c, "second");
    let before = c.rewind.status().unwrap()["points"].clone();
    c.rewind.session.as_mut().unwrap()["points"][0]["active_references"] = json!(1);
    let protected = c.rewind.status().unwrap()["points"][0]["point_id"].clone();
    let r = request(&c, "mark", "third");
    submit(&mut c, &r);
    assert_eq!(
        c.rewind
            .pending
            .as_ref()
            .unwrap()
            .victim_id
            .as_ref()
            .unwrap(),
        before[1]["point_id"].as_str().unwrap()
    );
    let e = event(&c, &r, "accepted");
    observe(&mut c, e);
    let e = event(&c, &r, "outcome_unknown");
    observe(&mut c, e);
    assert_eq!(
        c.rewind.status().unwrap()["points"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        c.rewind.status().unwrap()["points"][0]["point_id"],
        protected
    );
}
#[test]
fn third_successful_mark_keeps_two_and_never_reuses_point_id() {
    let mut c = state();
    mark_named(&mut c, "first");
    mark_named(&mut c, "second");
    let first = c.rewind.status().unwrap()["points"][0]["point_id"].clone();
    let second = c.rewind.status().unwrap()["points"][1]["point_id"].clone();
    mark_named(&mut c, "third");
    let s = c.rewind.status().unwrap();
    assert_eq!(s["points"].as_array().unwrap().len(), 2);
    assert_eq!(s["points"][0]["point_id"], second);
    assert_ne!(s["points"][1]["point_id"], first);
    assert_eq!(s["points"][1]["created_order"], 3);
}

#[test]
fn first_unknown_cannot_invent_points_or_last_good() {
    let mut c = state();
    let r = request(&c, "pause", "first-unknown");
    submit(&mut c, &r);
    let mut e = event(&c, &r, "outcome_unknown");
    let point: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/rewind_point.valid.json"
    ))
    .unwrap();
    e["session"]["points"] = json!([point]);
    e["session"]["last_good_usable"] = json!("point-one");
    let e: RewindEvent = serde_json::from_value(e).unwrap();
    let before = c.rewind.clone();
    assert!(c
        .apply(&Input::RewindEvent {
            notice: e,
            executor_epoch: 1
        })
        .unwrap()
        .reason
        .is_some());
    assert_eq!(c.rewind, before);
}
#[test]
fn first_unknown_requires_actual_pending_id() {
    let mut c = state();
    let r = request(&c, "pause", "first-pending");
    submit(&mut c, &r);
    let mut e = event(&c, &r, "outcome_unknown");
    e["session"]["pending_request_id"] = json!("request-foreign");
    let e: RewindEvent = serde_json::from_value(e).unwrap();
    let before = c.rewind.clone();
    assert!(c
        .apply(&Input::RewindEvent {
            notice: e,
            executor_epoch: 1
        })
        .unwrap()
        .reason
        .is_some());
    assert_eq!(c.rewind, before);
}
#[test]
fn first_unknown_empty_metadata_is_valid_but_fenced() {
    let mut c = state();
    let r = request(&c, "pause", "first-valid");
    submit(&mut c, &r);
    let e = event(&c, &r, "outcome_unknown");
    observe(&mut c, e);
    assert_eq!(c.rewind.status().unwrap()["points"], json!([]));
    assert!(c.rewind.status().unwrap()["last_good_usable"].is_null());
    assert!(!c.rewind.allows_command());
}
#[test]
fn stop_racing_unknown_keeps_schema_valid_uncertainty() {
    let mut c = state();
    let r = request(&c, "pause", "stop-unknown");
    submit(&mut c, &r);
    let e = event(&c, &r, "accepted");
    observe(&mut c, e);
    c.rewind.begin_stop();
    let mut e = event(&c, &r, "outcome_unknown");
    observe(&mut c, e.clone());
    assert_eq!(c.rewind.status().unwrap()["phase"], "uncertain");
    assert!(c.rewind.stopping);
    e["session"] = c.rewind.status().unwrap();
    assert!(serde_json::from_value::<RewindEvent>(e).is_ok());
    assert!(!c.rewind.allows_command());
}
#[test]
fn stop_racing_recovery_refuses_reopen_without_mutation() {
    let mut c = state();
    mark(&mut c);
    pause(&mut c);
    let r = request(&c, "restore", "stop-recover");
    submit(&mut c, &r);
    let e = event(&c, &r, "accepted");
    observe(&mut c, e);
    let e = event(&c, &r, "outcome_unknown");
    observe(&mut c, e);
    c.rewind.begin_stop();
    let mut e = event(&c, &r, "outcome_unknown");
    e["event"] = json!("recovery_ready");
    e["event_id"] = json!("event-stop-recovery");
    e["session"]["phase"] = json!("recoverable");
    e["session"]["pending_request_id"] = Value::Null;
    e["data"] = json!({"op":"restore","failed_request_id":r.0["request_id"],"point_id":r.0["params"]["point_id"],"no_active_vmm":true});
    let e: RewindEvent = serde_json::from_value(e).unwrap();
    let before = c.rewind.clone();
    assert!(c
        .apply(&Input::RewindEvent {
            notice: e,
            executor_epoch: 1
        })
        .unwrap()
        .reason
        .is_some());
    assert_eq!(c.rewind, before);
    assert!(!c.rewind.allows_command());
}
#[test]
fn stop_racing_completed_never_opens_commands() {
    let mut c = state();
    pause(&mut c);
    let r = request(&c, "resume", "stop-complete");
    submit(&mut c, &r);
    let e = event(&c, &r, "accepted");
    observe(&mut c, e);
    c.rewind.begin_stop();
    let mut e = event(&c, &r, "completed");
    observe(&mut c, e.clone());
    e["session"] = c.rewind.status().unwrap();
    assert!(serde_json::from_value::<RewindEvent>(e).is_ok());
    assert_eq!(c.rewind.status().unwrap()["phase"], "stopping");
    assert!(!c.rewind.allows_command());
}

#[test]
fn admitted_advancing_refusal_keeps_committed_target_and_unknown() {
    let mut c = state();
    let r = request(&c, "mark", "refused-mark");
    submit(&mut c, &r);
    let e:RewindEvent=serde_json::from_value(json!({"schema":"rewind_event/v0.2","event_id":"event-refused","request_id":r.0["request_id"],"owner_id":metaviewer_core::headless::actor_id(&agent()),"event":"refused","session":null,"data":{"op":"mark","code":"UNAVAILABLE"}})).unwrap();
    assert!(c
        .apply(&Input::RewindEvent {
            notice: e,
            executor_epoch: 1
        })
        .unwrap()
        .reason
        .is_none());
    assert_eq!(c.rewind.target.as_ref().unwrap().generation, 2);
    assert!(c.rewind.unknown);
    assert!(c.rewind.pending.is_some());
    assert!(!c.rewind.allows_command());
}
#[test]
fn unknown_null_preserves_previously_committed_metadata() {
    let mut c = state();
    mark(&mut c);
    pause(&mut c);
    let r = request(&c, "restore", "null-unknown");
    submit(&mut c, &r);
    let before = c.rewind.status().unwrap()["points"].clone();
    let e:RewindEvent=serde_json::from_value(json!({"schema":"rewind_event/v0.2","event_id":"event-null-unknown","request_id":r.0["request_id"],"owner_id":metaviewer_core::headless::actor_id(&agent()),"event":"outcome_unknown","session":null,"data":{"op":"restore","code":"NATIVE"}})).unwrap();
    assert!(c
        .apply(&Input::RewindEvent {
            notice: e,
            executor_epoch: 1
        })
        .unwrap()
        .reason
        .is_none());
    assert_eq!(c.rewind.status().unwrap()["points"], before);
    assert_eq!(c.rewind.status().unwrap()["phase"], "uncertain");
}
