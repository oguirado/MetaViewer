use metaviewer_core::{
    admission::{CoreState, Frame, Input, LifecycleUpdate, Surface},
    headless::actor_id,
    wire::graphical_session::{GraphicalSessionEvent, GraphicalSessionRequest},
    Component, Endpoint, Refusal,
};
use serde_json::{json, Value};

fn ep(component: Component, instance: &str) -> Endpoint {
    Endpoint { component, instance: instance.into() }
}
fn agent() -> Endpoint { ep(Component::Agent, "registered-agent") }
fn ui() -> Endpoint { ep(Component::Ui, "creator-ui") }
fn daemon() -> Endpoint { ep(Component::Daemon, "registered-daemon") }
fn runtime_id() -> String { format!("runtime-{}", "a".repeat(64)) }
fn core() -> CoreState {
    let mut state = CoreState::new("graphical-session-test", 64).unwrap();
    state.apply(&Input::Surface {
        id: "surface-qemu".into(),
        surface: Surface {
            display: "display-1".into(), owner: agent(), agent_controlled: true,
            live: true,
            frame: Some(Frame { sha256: "b".repeat(64), generation: 1, width: 64, height: 64 }),
            refresh_after: None, allowed_verbs: vec![],
        },
    }).unwrap();
    state
}
fn request(op: &str, id: &str, generation: Option<u64>, epoch: Option<u64>) -> GraphicalSessionRequest {
    let params = match op {
        "attach" => json!({}),
        "mark" => json!({"label":"checkpoint"}),
        "restore" => json!({"point_id":"point-one"}),
        _ => panic!("test operation"),
    };
    let mut value = json!({"schema":"graphical_session_request/v0.2","request_id":id,
        "surface_id":"surface-qemu","owner_id":actor_id(&agent()),"op":op,"params":params});
    if let Some(g) = generation { value["generation"] = json!(g); }
    if let Some(e) = epoch { value["authority_epoch"] = json!(e); }
    serde_json::from_value(value).unwrap()
}
fn submit(state: &mut CoreState, caller: Endpoint, req: GraphicalSessionRequest) -> metaviewer_core::admission::Outcome {
    state.apply(&Input::GraphicalSessionRequest {
        request: req, caller, agent: agent(), daemon: daemon(), enabled: true,
        capture_busy: false, received_ns: 100,
    }).unwrap()
}
fn session(phase: &str, generation: u64, authority_epoch: u64, points: Vec<Value>) -> Value {
    json!({"schema":"graphical_session/v0.2","surface_id":"surface-qemu","runtime_id":runtime_id(),
        "owner_id":actor_id(&agent()),"generation":generation,"authority_epoch":authority_epoch,"authority":"core",
        "phase":phase,"ownership":"held","pending_request_id":if phase=="pending" || phase=="outcome_unknown" {json!("request-current")} else {Value::Null},
        "points":points,"backend":"qemu","isa":"aarch64"})
}
fn event(op: &str, status: &str, request_id: &str, gen: u64, epoch: u64, ses: Value, point: Value, frame: Value) -> GraphicalSessionEvent {
    let completed_restore = op == "restore" && status == "completed";
    let mut value = json!({"schema":"graphical_session_event/v0.2","event_id":format!("event-{op}-{status}-{request_id}"),
        "request_id":request_id,"owner_id":actor_id(&agent()),"surface_id":"surface-qemu","generation":gen,
        "authority_epoch":epoch,"op":op,"event":status,
        "reason_code":if status=="refused" {json!("POLICY")} else if status=="outcome_unknown" {json!("OUTCOME_UNKNOWN")} else {Value::Null},
        "point_id":point,"session":ses,"elapsed_ms":if status=="completed" {json!(11)} else {Value::Null},
        "frame_sha256":if completed_restore {frame.clone()} else {Value::Null},
        "frame_generation":if completed_restore {json!(2)} else {Value::Null}});
    if status == "outcome_unknown" { value["reason_code"] = json!("OUTCOME_UNKNOWN"); }
    serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("event decode {error}: {value}"))
}
fn complete_attach(state: &mut CoreState) {
    let req = request("attach", "request-attach", None, None);
    assert!(submit(state, ui(), req).dispatch);
    let notice = event("attach", "completed", "request-attach", 1, 1, session("ready", 1, 1, vec![]), Value::Null, Value::Null);
    let out = state.apply(&Input::GraphicalSessionEvent { notice, sender: daemon(), executor_epoch: 0 }).unwrap();
    assert_eq!(out.reason, None);
}
fn mark_point() -> Value {
    json!({"point_id":"point-one","generation":1,"label":"checkpoint","manifest_sha256":"c".repeat(64),"created_mono_ns":200})
}
fn point(id: &str) -> Value {
    json!({"point_id":id,"generation":1,"label":"checkpoint","manifest_sha256":"c".repeat(64),"created_mono_ns":200})
}

#[test]
fn wire_rejects_malformed_runtime_ids_and_unknown_refusal_codes() {
    let valid = event("attach", "completed", "request-attach", 1, 1,
        session("ready", 1, 1, vec![]), Value::Null, Value::Null).0;
    let bad_ids = vec!["runtime-short".to_owned(), format!("runtime-{}", "A".repeat(64)),
        format!("runtime-{}", "g".repeat(64)), format!("other-{}", "a".repeat(64))];
    for bad in bad_ids {
        let mut candidate = valid.clone();
        candidate["session"]["runtime_id"] = json!(bad);
        assert!(serde_json::from_value::<GraphicalSessionEvent>(candidate).is_err());
    }
    let mut invalid_reason = event("mark", "refused", "request-mark", 1, 1,
        session("ready", 1, 1, vec![]), Value::Null, Value::Null).0;
    invalid_reason["reason_code"] = json!("OUTCOME_UNKNOWN\n");
    assert!(serde_json::from_value::<GraphicalSessionEvent>(invalid_reason).is_err());
    let mut wrong_tag = valid.clone();
    wrong_tag["schema"] = json!("surface_event/v0.2");
    assert!(serde_json::from_value::<GraphicalSessionEvent>(wrong_tag).is_err());
}

#[test]
fn lost_operation_emits_uncertain_and_creator_stop_retires_only_held_surface() {
    let mut state = core(); complete_attach(&mut state);
    assert!(submit(&mut state, ui(), request("mark", "request-loss", Some(1), Some(1))).dispatch);
    state.apply(&Input::Lifecycle { surface_id: "surface-qemu".into(), update: LifecycleUpdate::Lost }).unwrap();
    let unknown = state.graphical_session.saved_reply("request-loss").unwrap();
    assert_eq!(unknown["event"], "outcome_unknown");
    assert!(state.graphical_session.blocks_mutation("surface-qemu"));
    assert!(state.graphical_session.creator_can_stop("surface-qemu", &ui()));
    assert!(!state.graphical_session.creator_can_stop("surface-qemu", &ep(Component::Ui, "other-ui")));

    let stop: metaviewer_core::wire::payload::SurfaceRequest = serde_json::from_value(json!({
        "schema":"surface_request/v0.2","op":"destroy","params":{"surface_id":"surface-qemu"}
    })).unwrap();
    let out = state.apply(&Input::SurfaceRequest { request: stop }).unwrap();
    assert_eq!(out.reason, None);
    assert!(state.graphical_session.pending.is_some(), "a Stop request does not prove physical closure");
    state.apply(&Input::Lifecycle { surface_id: "surface-qemu".into(), update: LifecycleUpdate::Destroyed }).unwrap();
    assert!(state.graphical_session.pending.is_none());
    assert_eq!(state.graphical_session.session.as_ref().unwrap()["ownership"], "released");
}

#[test]
fn creator_can_stop_ready_graphical_session_after_human_takeover() {
    let mut state = core(); complete_attach(&mut state);
    assert_eq!(state.apply(&Input::TakeControl { surface_id: "surface-qemu".into() }).unwrap().reason, None);
    assert!(!state.surfaces["surface-qemu"].agent_controlled);
    assert!(state.graphical_session.creator_can_stop("surface-qemu", &ui()));
    assert!(!state.graphical_session.creator_can_stop("surface-qemu", &ep(Component::Ui, "other-ui")));
    let stop: metaviewer_core::wire::payload::SurfaceRequest = serde_json::from_value(json!({
        "schema":"surface_request/v0.2","op":"destroy","params":{"surface_id":"surface-qemu"}
    })).unwrap();
    assert_eq!(state.apply(&Input::SurfaceRequest { request: stop }).unwrap().reason, None);
    assert_eq!(state.graphical_session.session.as_ref().unwrap()["ownership"], "held", "Stop admission is not physical closure evidence");
    state.apply(&Input::Lifecycle { surface_id: "surface-qemu".into(), update: LifecycleUpdate::Destroyed }).unwrap();
    assert_eq!(state.graphical_session.session.as_ref().unwrap()["ownership"], "released");
}

#[test]
fn unrelated_browser_create_is_allowed_but_vm_fallback_and_bound_profile_are_fenced() {
    use metaviewer_core::wire::payload::SurfaceRequest;
    let mut state = core();
    state.profile_surfaces.insert("surface-qemu".into(), "vm-profile".into());
    assert!(submit(&mut state, ui(), request("attach", "request-attach", None, None)).dispatch);
    let create = |kind: &str, profile: &str| -> SurfaceRequest {
        serde_json::from_value(json!({"schema":"surface_request/v0.2","op":"create","params":{
            "kind":kind,"geometry":{"w":800,"h":600},"profile_id":profile
        }})).unwrap()
    };
    let allowed = state.apply(&Input::SurfaceRequest { request: create("browser", "browser-profile") }).unwrap();
    assert_eq!(allowed.reason, None);
    assert_eq!(state.remaining_budget, 62);
    let same_profile = state.apply(&Input::SurfaceRequest { request: create("browser", "vm-profile") }).unwrap();
    assert_eq!(same_profile.reason, Some(Refusal::Policy));
    let vm_other_profile = state.apply(&Input::SurfaceRequest { request: create("vm", "other-vm") }).unwrap();
    assert_eq!(vm_other_profile.reason, None, "known held profile scopes the fence to that profile");

    let mut no_binding = core();
    assert!(submit(&mut no_binding, ui(), request("attach", "request-attach", None, None)).dispatch);
    assert_eq!(no_binding.apply(&Input::SurfaceRequest { request: create("browser", "browser-profile") }).unwrap().reason, None);
    assert_eq!(no_binding.apply(&Input::SurfaceRequest { request: create("vm", "other-vm") }).unwrap().reason, Some(Refusal::Policy));
}

#[test]
fn physical_destroy_releases_session_and_clears_only_graphical_idempotency_journal() {
    let mut state = core(); complete_attach(&mut state);
    assert!(!state.graphical_session.history.is_empty());
    assert!(!state.graphical_session.events.is_empty());
    state.apply(&Input::Lifecycle { surface_id: "surface-qemu".into(), update: LifecycleUpdate::Destroyed }).unwrap();
    assert!(state.graphical_session.history.is_empty());
    assert!(state.graphical_session.events.is_empty());
    assert_eq!(state.graphical_session.session.as_ref().unwrap()["ownership"], "released");
}

#[test]
fn graphical_event_capacity_refuses_before_mutating_pending_or_history() {
    let mut state = core(); complete_attach(&mut state);
    assert!(submit(&mut state, ui(), request("mark", "request-capacity", Some(1), Some(1))).dispatch);
    for n in 0..128 {
        state.graphical_session.events.insert(format!("seed-{n}"), json!({"event_id":format!("seed-{n}")}));
    }
    let before_pending = state.graphical_session.pending.clone();
    let before_reply = state.graphical_session.saved_reply("request-capacity").cloned();
    let done = event("mark", "completed", "request-capacity", 1, 1,
        session("ready", 1, 1, vec![mark_point()]), json!("point-one"), Value::Null);
    let out = state.apply(&Input::GraphicalSessionEvent { notice: done, sender: daemon(), executor_epoch: 0 }).unwrap();
    assert_eq!(out.reason, Some(Refusal::BudgetExceeded));
    assert_eq!(state.graphical_session.pending, before_pending);
    assert_eq!(state.graphical_session.saved_reply("request-capacity"), before_reply.as_ref());
}

#[test]
fn attach_is_ui_and_registered_actor_bound_and_duplicate_is_not_redispatched() {
    let mut state = core();
    let req = request("attach", "request-attach", None, None);
    let denied = submit(&mut state, agent(), req.clone());
    assert_eq!(denied.reason, Some(Refusal::Policy));
    let mut forged = req.0.clone(); forged["owner_id"] = json!("actor-forged");
    let forged: GraphicalSessionRequest = serde_json::from_value(forged).unwrap();
    assert_eq!(submit(&mut state, ui(), forged).reason, Some(Refusal::Policy));

    let accepted = submit(&mut state, ui(), req.clone());
    assert!(accepted.dispatch);
    assert!(state.graphical_session.session.is_none(), "core must not invent native runtime identity");
    let budget = state.remaining_budget;
    let duplicate = submit(&mut state, ui(), req);
    assert_eq!(duplicate.reason, None);
    assert!(!duplicate.dispatch);
    assert_eq!(state.remaining_budget, budget);
}

#[test]
fn mark_preserves_generation_and_rejects_wrong_daemon_or_stale_tuple() {
    let mut state = core(); complete_attach(&mut state);
    let req = request("mark", "request-mark", Some(1), Some(1));
    assert!(submit(&mut state, ui(), req).dispatch);
    let point = mark_point();
    let notice = event("mark", "completed", "request-mark", 1, 1,
        session("ready", 1, 1, vec![point.clone()]), json!("point-one"), Value::Null);
    let wrong = state.apply(&Input::GraphicalSessionEvent { notice: notice.clone(), sender: ep(Component::Daemon,"impostor"), executor_epoch: 0 }).unwrap();
    assert_eq!(wrong.reason, Some(Refusal::Policy));
    assert!(state.graphical_session.pending.is_some());
    let stale = event("mark", "completed", "request-mark", 2, 1,
        session("ready", 2, 1, vec![point]), json!("point-one"), Value::Null);
    let stale = state.apply(&Input::GraphicalSessionEvent { notice: stale, sender: daemon(), executor_epoch: 0 }).unwrap();
    assert_eq!(stale.reason, Some(Refusal::StaleFrame));
    assert!(state.graphical_session.pending.is_some());
}

#[test]
fn unknown_fences_mutations_but_budget_exhaustion_does_not_block_destroy() {
    let mut state = core(); complete_attach(&mut state);
    assert!(submit(&mut state, ui(), request("mark", "request-mark", Some(1), Some(1))).dispatch);
    state.apply(&Input::GraphicalSessionUncertain).unwrap();
    assert!(state.graphical_session.blocks_mutation("surface-qemu"));
    state.remaining_budget = 0;
    let destroy = serde_json::from_value(json!({"schema":"surface_request/v0.2","op":"destroy","params":{"surface_id":"surface-qemu"}})).unwrap();
    let out = state.apply(&Input::SurfaceRequest { request: destroy }).unwrap();
    assert_eq!(out.reason, None);
    assert_eq!(state.remaining_budget, 0);
    state.apply(&Input::Lifecycle { surface_id:"surface-qemu".into(), update:LifecycleUpdate::Destroyed }).unwrap();
    assert!(state.graphical_session.pending.is_none());
    assert_eq!(state.graphical_session.session.as_ref().unwrap()["ownership"], "released");
    let late = event("mark", "completed", "request-mark", 1, 1,
        session("ready", 1, 1, vec![mark_point()]), json!("point-one"), Value::Null);
    let late = state.apply(&Input::GraphicalSessionEvent {notice:late,sender:daemon(),executor_epoch:0}).unwrap();
    assert_eq!(late.reason, Some(Refusal::Policy));
    assert_eq!(state.graphical_session.session.as_ref().unwrap()["ownership"], "released");
}

#[test]
fn point_budget_is_checked_before_native_dispatch() {
    let mut state=core(); complete_attach(&mut state);
    for n in 1..=4 {
        let request_id=format!("request-mark-{n}");
        assert!(submit(&mut state,ui(),request("mark",&request_id,Some(1),Some(1))).dispatch);
        let old=state.graphical_session.session.as_ref().unwrap()["points"].as_array().unwrap().clone();
        let mut points=old; points.push(point(&format!("point-p{n}")));
        let done=event("mark","completed",&request_id,1,1,session("ready",1,1,points),json!(format!("point-p{n}")),Value::Null);
        assert_eq!(state.apply(&Input::GraphicalSessionEvent {notice:done,sender:daemon(),executor_epoch:0}).unwrap().reason,None);
    }
    let refused=submit(&mut state,ui(),request("mark","request-mark-5",Some(1),Some(1)));
    assert_eq!(refused.reason,Some(Refusal::BudgetExceeded));
    assert!(!refused.dispatch);
    assert!(state.graphical_session.pending.is_none());
}

#[test]
fn restore_requires_new_authoritative_frame_and_advances_generation_only_on_completion() {
    let mut state = core(); complete_attach(&mut state);
    assert!(submit(&mut state, ui(), request("mark", "request-mark", Some(1), Some(1))).dispatch);
    let point = mark_point();
    let done = event("mark","completed","request-mark",1,1,session("ready",1,1,vec![point.clone()]),json!("point-one"),Value::Null);
    assert_eq!(state.apply(&Input::GraphicalSessionEvent {notice:done,sender:daemon(),executor_epoch:0}).unwrap().reason,None);
    assert!(submit(&mut state, ui(), request("restore", "request-restore", Some(1), Some(1))).dispatch);
    let restored=event("restore","completed","request-restore",2,2,session("ready",2,2,vec![point]),json!("point-one"),json!("d".repeat(64)));
    let premature=state.apply(&Input::GraphicalSessionEvent {notice:restored.clone(),sender:daemon(),executor_epoch:0}).unwrap();
    assert_eq!(premature.reason,Some(Refusal::StaleFrame));
    assert!(state.graphical_session.pending.is_some());
    let next_frame = Frame {sha256:"d".repeat(64),generation:2,width:64,height:64};
    state.apply(&Input::Frame {surface_id:"surface-qemu".into(),frame:next_frame}).unwrap();
    let out=state.apply(&Input::GraphicalSessionEvent {notice:restored,sender:daemon(),executor_epoch:0}).unwrap();
    assert_eq!(out.reason,None);
    let s=state.graphical_session.session.as_ref().unwrap();
    assert_eq!(s["generation"],2);
    assert_eq!(s["authority_epoch"],2);
}

#[test]
fn creator_can_restore_after_taking_human_input_control() {
    let mut state=core();complete_attach(&mut state);
    assert!(submit(&mut state,ui(),request("mark","request-mark",Some(1),Some(1))).dispatch);
    let marked=event("mark","completed","request-mark",1,1,session("ready",1,1,vec![mark_point()]),json!("point-one"),Value::Null);
    assert_eq!(state.apply(&Input::GraphicalSessionEvent {notice:marked,sender:daemon(),executor_epoch:0}).unwrap().reason,None);
    assert_eq!(state.apply(&Input::TakeControl {surface_id:"surface-qemu".into()}).unwrap().reason,None);
    assert!(!state.surfaces["surface-qemu"].agent_controlled);
    assert_eq!(state.surfaces["surface-qemu"].owner,agent());
    let req=request("restore","request-after-takeover",Some(1),Some(1));
    assert!(submit(&mut state,ui(),req).dispatch,"creator UI must retain Back after typing in human control");
}

#[test]
fn unknown_second_attach_does_not_resurrect_a_closed_surface_session() {
    let mut state=core();complete_attach(&mut state);
    state.apply(&Input::Lifecycle {surface_id:"surface-qemu".into(),update:LifecycleUpdate::Destroyed}).unwrap();
    let mut second=core().surfaces["surface-qemu"].clone();second.display="display-second".into();
    state.apply(&Input::Surface {id:"surface-second".into(),surface:second}).unwrap();
    let mut next=request("attach","request-second",None,None).0;next["surface_id"]=json!("surface-second");
    assert!(submit(&mut state,ui(),serde_json::from_value(next).unwrap()).dispatch);
    assert!(state.graphical_session.session.is_none(),"new attach must not retain a closed runtime tuple");
    state.apply(&Input::GraphicalSessionUncertain).unwrap();
    assert_eq!(state.graphical_session.held_surface(),Some("surface-second"));
    assert!(state.graphical_session.blocks_mutation("surface-second"));
    assert!(state.graphical_session.session.is_none());
}

#[test]
fn native_completion_cannot_invent_attach_points_or_reuse_mark_identity() {
    let mut state = core();
    assert!(submit(&mut state, ui(), request("attach", "request-attach", None, None)).dispatch);
    let forged = event("attach", "completed", "request-attach", 1, 1,
        session("ready", 1, 1, vec![mark_point()]), Value::Null, Value::Null);
    let out = state.apply(&Input::GraphicalSessionEvent {notice:forged,sender:daemon(),executor_epoch:0}).unwrap();
    assert_eq!(out.reason, Some(Refusal::Policy));
    assert!(state.graphical_session.session.is_none());
    let mut state = core(); complete_attach(&mut state);
    assert!(submit(&mut state, ui(), request("mark", "request-first", Some(1), Some(1))).dispatch);
    let good = event("mark", "completed", "request-first", 1, 1,
        session("ready", 1, 1, vec![mark_point()]), json!("point-one"), Value::Null);
    assert_eq!(state.apply(&Input::GraphicalSessionEvent {notice:good,sender:daemon(),executor_epoch:0}).unwrap().reason,None);
    assert!(submit(&mut state, ui(), request("mark", "request-duplicate", Some(1), Some(1))).dispatch);
    let duplicate = event("mark", "completed", "request-duplicate", 1, 1,
        session("ready", 1, 1, vec![mark_point(),mark_point()]), json!("point-one"), Value::Null);
    let out = state.apply(&Input::GraphicalSessionEvent {notice:duplicate,sender:daemon(),executor_epoch:0}).unwrap();
    assert_eq!(out.reason, Some(Refusal::BudgetExceeded));
    assert!(state.graphical_session.pending.is_some());
    assert_eq!(state.graphical_session.session.as_ref().unwrap()["points"].as_array().unwrap().len(),1);
}
