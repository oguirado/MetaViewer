use metaviewer_core::{
    decode_envelope,
    headless::{actor_id, State},
    wire::headless::{HeadlessEvent, HeadlessRequest},
    Component, Endpoint,
};
use serde_json::{json, Value};
fn ep(component: Component, id: &str) -> Endpoint {
    Endpoint {
        component,
        instance: id.into(),
    }
}
fn agent() -> Endpoint {
    ep(Component::Agent, "registered")
}
fn ui() -> Endpoint {
    ep(Component::Ui, "creator")
}
fn req(id: &str, op: &str, params: Value) -> HeadlessRequest {
    serde_json::from_value(
        json!({"schema":"headless_request/v0.2","request_id":id,"op":op,"params":params}),
    )
    .unwrap()
}
fn create() -> HeadlessRequest {
    req(
        "request-create",
        "create",
        json!({"template":"headless-sumsq"}),
    )
}
fn session(phase: &str, job: Value) -> Value {
    json!({"schema":"headless_session/v0.2","workload_id":"workload-test","generation":1,"owner_id":actor_id(&agent()),"profile_id":"headless-sumsq-v1","backend":"firecracker","isa":"aarch64","phase":phase,"ownership":if phase=="stopped"{"released"}else{"held"},"job":job})
}
fn event(
    id: &str,
    rid: &str,
    kind: &str,
    phase: &str,
    job: Value,
    op: Option<&str>,
) -> HeadlessEvent {
    let mut data = json!({"session":session(phase,job)});
    if let Some(op) = op {
        data["op"] = json!(op);
        if kind == "outcome_unknown" {
            data["code"] = json!("OUTCOME_UNKNOWN");
        }
    }
    serde_json::from_value(json!({"schema":"headless_event/v0.2","event_id":id,"request_id":rid,"event":kind,"data":data})).unwrap()
}
fn ready() -> State {
    let mut s = State::default();
    s.submit(&create(), &ui(), &agent(), 1, false).unwrap();
    s.observe(
        &event(
            "event-a",
            "request-create",
            "accepted",
            "starting",
            Value::Null,
            Some("create"),
        ),
        1,
    )
    .unwrap();
    s.observe(
        &event(
            "event-b",
            "request-create",
            "state_changed",
            "ready",
            Value::Null,
            None,
        ),
        1,
    )
    .unwrap();
    s
}
fn run() -> HeadlessRequest {
    req(
        "request-run",
        "run",
        json!({"workload_id":"workload-test","generation":1,"job_id":"job-test","operation":"sumsq","n":10}),
    )
}
fn job(status: &str, value: Value) -> Value {
    json!({"job_id":"job-test","operation":"sumsq","n":10,"status":status,"value":value})
}
#[test]
fn headless_full_lifecycle_keeps_identity() {
    let mut s = ready();
    s.submit(&run(), &agent(), &agent(), 1, false).unwrap();
    s.observe(
        &event(
            "event-c",
            "request-run",
            "accepted",
            "running",
            job("accepted", Value::Null),
            Some("run"),
        ),
        1,
    )
    .unwrap();
    s.observe(
        &event(
            "event-d",
            "request-run",
            "completed",
            "completed",
            job("completed", json!(385)),
            None,
        ),
        1,
    )
    .unwrap();
    let r = req(
        "request-stop",
        "stop",
        json!({"workload_id":"workload-test","generation":1}),
    );
    s.submit(&r, &ui(), &agent(), 1, false).unwrap();
    s.observe(
        &event(
            "event-e",
            "request-stop",
            "accepted",
            "stopping",
            job("completed", json!(385)),
            Some("stop"),
        ),
        1,
    )
    .unwrap();
    s.observe(
        &event(
            "event-f",
            "request-stop",
            "state_changed",
            "stopped",
            job("completed", json!(385)),
            None,
        ),
        1,
    )
    .unwrap();
    assert!(!s.held);
    assert_eq!(
        s.submit(&create(), &ui(), &agent(), 1, false),
        Err("DUPLICATE_REQUEST")
    );
}
#[test]
fn headless_cross_owner_and_role_spoof_refused() {
    let mut s = ready();
    let old = s.clone();
    assert_eq!(
        s.submit(&run(), &ep(Component::Ui, "other"), &agent(), 1, false),
        Err("OWNER_MISMATCH")
    );
    assert_eq!(s, old);
    assert_eq!(
        s.submit(&run(), &ep(Component::Agent, "other"), &agent(), 1, false),
        Err("OWNER_MISMATCH")
    );
    assert_eq!(
        s.submit(&run(), &ep(Component::Daemon, "daemon"), &agent(), 1, false),
        Err("OWNER_MISMATCH")
    );
}
#[test]
fn headless_graphical_history_blocks_start() {
    let mut s = State::default();
    assert_eq!(s.submit(&create(), &ui(), &agent(), 1, true), Err("BUSY"));
    assert!(!s.held);
}
#[test]
fn headless_unknown_never_accepts_late_completion() {
    let mut s = ready();
    s.submit(&run(), &ui(), &agent(), 1, false).unwrap();
    s.observe(
        &event(
            "event-c",
            "request-run",
            "accepted",
            "running",
            job("accepted", Value::Null),
            Some("run"),
        ),
        1,
    )
    .unwrap();
    s.observe(
        &event(
            "event-d",
            "request-run",
            "outcome_unknown",
            "uncertain",
            job("unknown", Value::Null),
            Some("run"),
        ),
        1,
    )
    .unwrap();
    let old = s.clone();
    assert_eq!(
        s.observe(
            &event(
                "event-e",
                "request-run",
                "completed",
                "completed",
                job("completed", json!(385)),
                None
            ),
            1
        ),
        Err("NO_PENDING_REQUEST")
    );
    assert_eq!(s, old);
    assert!(s.held);
}
#[test]
fn headless_wrong_job_result_preserves_reservation() {
    let mut s = ready();
    s.submit(&run(), &ui(), &agent(), 1, false).unwrap();
    s.observe(
        &event(
            "event-c",
            "request-run",
            "accepted",
            "running",
            job("accepted", Value::Null),
            Some("run"),
        ),
        1,
    )
    .unwrap();
    let old = s.clone();
    assert_eq!(
        s.observe(
            &event(
                "event-d",
                "request-run",
                "completed",
                "completed",
                job("completed", json!(386)),
                None
            ),
            1
        ),
        Err("JOB_RESULT")
    );
    assert_eq!(s, old);
}
#[test]
fn headless_foreign_session_and_stale_epoch_fail_closed() {
    let mut s = State::default();
    s.submit(&create(), &ui(), &agent(), 1, false).unwrap();
    let good = event(
        "event-a",
        "request-create",
        "accepted",
        "starting",
        Value::Null,
        Some("create"),
    );
    let mut bad = good.clone();
    bad.0["data"]["session"]["owner_id"] = json!("actor-foreign");
    assert_eq!(s.observe(&bad, 1), Err("FOREIGN_SESSION"));
    assert_eq!(s.observe(&good, 2), Err("STALE_EPOCH"));
    assert!(s.held);
}
#[test]
fn headless_duplicate_and_stale_generation_refused() {
    let mut s = ready();
    let mut bad = run();
    bad.0["params"]["generation"] = json!(2);
    assert_eq!(
        s.submit(&bad, &ui(), &agent(), 1, false),
        Err("STALE_GENERATION")
    );
    s.submit(&run(), &ui(), &agent(), 1, false).unwrap();
    assert_eq!(
        s.submit(&run(), &ui(), &agent(), 1, false),
        Err("DUPLICATE_REQUEST")
    );
}
#[test]
fn headless_disconnect_retains_unknown_and_consumed_job() {
    let mut s = ready();
    s.submit(&run(), &ui(), &agent(), 1, false).unwrap();
    s.observe(
        &event(
            "event-c",
            "request-run",
            "accepted",
            "running",
            job("accepted", Value::Null),
            Some("run"),
        ),
        1,
    )
    .unwrap();
    s.uncertain();
    assert!(s.held);
    assert_eq!(s.session.as_ref().unwrap()["job"]["status"], "unknown");
    assert!(s.pending.is_none());
}
#[test]
fn headless_json_decoder_rejects_bool_and_foreign_namespace() {
    let mut raw = create().0;
    raw["request_id"] = json!("workload-spoof");
    assert!(serde_json::from_value::<HeadlessRequest>(raw).is_err());
    let mut raw = run().0;
    raw["params"]["n"] = json!(true);
    assert!(serde_json::from_value::<HeadlessRequest>(raw).is_err());
}
#[test]
fn headless_new_envelope_families_decode() {
    let body = create().0;
    let envelope = json!({"schema":"capsule_envelope/v0.2","msg_id":"message-test","ts_ns":0,"from":{"component":"ui","instance":"ui"},"to":{"component":"core","instance":"core"},"session_id":"test","seq":1,"nonce":"n","body":body});
    assert!(decode_envelope(&envelope.to_string()).is_ok());
}
#[test]
fn headless_mismatched_request_and_event_replay_preserve_state() {
    let mut s = State::default();
    s.submit(&create(), &ui(), &agent(), 1, false).unwrap();
    let mut e = event(
        "event-a",
        "request-create",
        "accepted",
        "starting",
        Value::Null,
        Some("create"),
    );
    e.0["request_id"] = json!("request-foreign");
    assert_eq!(s.observe(&e, 1), Err("REQUEST_CORRELATION"));
    e.0["request_id"] = json!("request-create");
    s.observe(&e, 1).unwrap();
    let before = s.clone();
    assert_eq!(s.observe(&e, 1), Err("DUPLICATE_EVENT"));
    assert_eq!(s, before);
}
#[test]
fn headless_first_backend_must_be_arm_firecracker() {
    let mut s = State::default();
    s.submit(&create(), &ui(), &agent(), 1, false).unwrap();
    let mut e = event(
        "event-a",
        "request-create",
        "accepted",
        "starting",
        Value::Null,
        Some("create"),
    );
    e.0["data"]["session"]["backend"] = json!("qemu");
    assert_eq!(s.observe(&e, 1), Err("FOREIGN_SESSION"));
    assert!(s.held);
    assert!(s.session.is_none());
}
#[test]
fn headless_loss_before_run_accept_still_reserves_unknown_job() {
    let mut s = ready();
    s.submit(&run(), &ui(), &agent(), 1, false).unwrap();
    s.uncertain();
    let snapshot = s.session.unwrap();
    assert_eq!(snapshot["job"]["job_id"], "job-test");
    assert_eq!(snapshot["job"]["status"], "unknown");
    assert_eq!(snapshot["job"]["value"], Value::Null);
}
#[test]
fn headless_stop_survives_exhausted_action_budget() {
    use metaviewer_core::admission::{CoreState, Input};
    let mut state = CoreState::new("headless-budget", 1).unwrap();
    assert!(state
        .apply(&Input::HeadlessRequest {
            request: create(),
            caller: ui(),
            agent: agent(),
            graphical_seen: false,
            received_ns: 0
        })
        .unwrap()
        .reason
        .is_none());
    for e in [
        event(
            "event-a",
            "request-create",
            "accepted",
            "starting",
            Value::Null,
            Some("create"),
        ),
        event(
            "event-b",
            "request-create",
            "state_changed",
            "ready",
            Value::Null,
            None,
        ),
    ] {
        assert!(state
            .apply(&Input::HeadlessEvent {
                notice: e,
                executor_epoch: 0
            })
            .unwrap()
            .reason
            .is_none());
    }
    assert_eq!(state.remaining_budget, 0);
    let stop = req(
        "request-stop",
        "stop",
        json!({"workload_id":"workload-test","generation":1}),
    );
    assert!(state
        .apply(&Input::HeadlessRequest {
            request: stop,
            caller: ui(),
            agent: agent(),
            graphical_seen: false,
            received_ns: 0
        })
        .unwrap()
        .reason
        .is_none());
    assert_eq!(state.remaining_budget, 0);
}

#[test]
fn headless_daemon_cannot_reuse_core_event_namespace() {
    let mut s = State::default();
    s.submit(&create(), &ui(), &agent(), 1, false).unwrap();
    let e = event(
        "event-core-10",
        "request-create",
        "accepted",
        "starting",
        Value::Null,
        Some("create"),
    );
    assert_eq!(s.observe(&e, 1), Err("DUPLICATE_EVENT"));
    assert!(s.session.is_none());
}
