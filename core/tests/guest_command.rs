use metaviewer_core::{
    guest_command::{decode64, prepare_exec, reservation_id, State},
    wire::guest_command::{GuestCommandEvent, GuestCommandRequest},
    Component, Endpoint,
};
use serde_json::{json, Value};

#[test]
fn base64_limits_preserve_boundaries_without_integer_overflow() {
    assert_eq!(decode64("eA==", 1).unwrap(), b"x");
    assert!(decode64("eA==", 0).is_err());
    assert!(decode64("eAAA", 1).is_err());
    assert_eq!(decode64("eA==", usize::MAX).unwrap(), b"x");
    assert!(decode64("", 0).unwrap().is_empty());
}

fn ep(c: Component) -> Endpoint {
    Endpoint {
        component: c,
        instance: "synthetic".into(),
    }
}
fn request(op: &str, id: &str, params: Value) -> GuestCommandRequest {
    serde_json::from_value(
        json!({"schema":"guest_command_request/v0.2","request_id":id,"op":op,"params":params}),
    )
    .unwrap()
}
fn create() -> GuestCommandRequest {
    request(
        "create",
        "request-create",
        json!({"profile_id":"guest-command-arm64-v1"}),
    )
}
fn run(id: &str, job: &str) -> GuestCommandRequest {
    request(
        "run",
        id,
        json!({"workload_id":"workload-one","generation":1,"job_id":job,"command_utf8":"printf test","cwd":"","stdin_b64":"","timeout_ms":1000}),
    )
}
fn session() -> Value {
    json!({"schema":"guest_command_session/v0.2","workload_id":"workload-one","generation":1,"owner_id":metaviewer_core::headless::actor_id(&ep(Component::Agent)),"profile_id":"guest-command-arm64-v1","backend":"firecracker","isa":"aarch64","phase":"starting","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}})
}
fn event(
    state: &State,
    id: &str,
    eid: &str,
    kind: &str,
    s: Value,
    data: Value,
) -> GuestCommandEvent {
    serde_json::from_value(json!({"schema":"guest_command_event/v0.2","event_id":eid,"request_id":id,"reservation_id":state.reservation,"owner_id":state.actor,"session":s,"event":kind,"data":data})).unwrap()
}
fn submit(s: &mut State, r: &GuestCommandRequest) -> Result<(), &'static str> {
    s.submit(
        r,
        &ep(Component::Ui),
        &ep(Component::Agent),
        "session-one",
        0,
        false,
    )
}
fn ready() -> State {
    let mut s = State::default();
    submit(&mut s, &create()).unwrap();
    let v = session();
    s.observe(&event(
        &s,
        "request-create",
        "event-create",
        "accepted",
        v.clone(),
        json!({"op":"create"}),
    ))
    .unwrap();
    let mut v = v;
    v["phase"] = json!("ready");
    s.observe(&event(
        &s,
        "request-create",
        "event-ready",
        "ready",
        v,
        json!({}),
    ))
    .unwrap();
    s
}
fn running() -> State {
    let mut s = ready();
    submit(&mut s, &run("request-run", "job-one")).unwrap();
    let mut v = s.session.clone().unwrap();
    v["phase"] = json!("running");
    v["jobs_started"] = json!(1);
    v["job"] = json!({"job_id":"job-one","state":"running","exit_code":null,"signal":null,"stdout_bytes":0,"stderr_bytes":0,"output_complete":false});
    s.observe(&event(
        &s,
        "request-run",
        "event-run",
        "accepted",
        v,
        json!({"op":"run"}),
    ))
    .unwrap();
    s
}
fn finish_event(s: &State, cause: &str, eid: &str) -> GuestCommandEvent {
    let mut v = s.session.clone().unwrap();
    let mut cancel = Value::Null;
    let mut stop = Value::Null;
    for (key, target) in [("cancel", &mut cancel), ("stop", &mut stop)] {
        if v["controls"][key]["ack"] == "accepted" {
            *target = v["controls"][key]["request_id"].clone();
        }
    }
    v["job"]["state"] = json!(if cause == "exit" {
        "exited"
    } else {
        "cancelled"
    });
    v["job"]["exit_code"] = json!(0);
    v["job"]["output_complete"] = json!(true);
    v["phase"] = json!(if v["controls"]["cancel"]["ack"] == "pending"
        || v["controls"]["stop"]["ack"] == "pending"
    {
        "awaiting_control"
    } else if !v["controls"]["stop"].is_null() {
        "stopping"
    } else {
        "ready"
    });
    event(
        s,
        "request-run",
        eid,
        "job_finished",
        v,
        json!({"job_id":"job-one","cause":cause,"stdout_sha256":metaviewer_core::journal::sha256_hex(&s.stdout),"stderr_sha256":metaviewer_core::journal::sha256_hex(&s.stderr),"stdout_sent_bytes":s.stdout.len(),"stderr_sent_bytes":s.stderr.len(),"guest_job_empty":true,"cancel_request_id":cancel,"stop_request_id":stop}),
    )
}
#[test]
fn reserve_before_ack_and_unknown_holds() {
    let mut s = State::default();
    submit(&mut s, &create()).unwrap();
    assert!(s.held);
    assert!(s.session.is_none());
    s.uncertain();
    assert!(s.held && s.unknown);
    assert!(submit(&mut s, &create()).is_err());
}
#[test]
fn two_jobs_same_vm() {
    let mut s = running();
    s.observe(&finish_event(&s, "exit", "event-finish"))
        .unwrap();
    assert!(s.held);
    submit(&mut s, &run("request-two", "job-two")).unwrap();
    assert_eq!(s.jobs.len(), 2);
    assert!(submit(&mut s, &run("request-three", "job-one")).is_err());
}
#[test]
fn cancel_is_independent_and_requires_ack() {
    let mut s = running();
    let r = request(
        "cancel",
        "request-cancel",
        json!({"workload_id":"workload-one","generation":1,"job_id":"job-one"}),
    );
    submit(&mut s, &r).unwrap();
    let before = s.clone();
    assert!(s.observe(&finish_event(&s, "cancel", "event-bad")).is_err());
    assert_eq!(s, before);
    let mut v = s.session.clone().unwrap();
    v["controls"]["cancel"]["ack"] = json!("accepted");
    v["job"]["state"] = json!("cancelling");
    s.observe(&event(
        &s,
        "request-cancel",
        "event-cancel",
        "accepted",
        v,
        json!({"op":"cancel"}),
    ))
    .unwrap();
    s.observe(&finish_event(&s, "cancel", "event-finish"))
        .unwrap();
    assert_eq!(s.session.as_ref().unwrap()["phase"], "ready");
}
#[test]
fn exit_before_cancel_ack_is_not_ready() {
    let mut s = running();
    submit(
        &mut s,
        &request(
            "cancel",
            "request-cancel",
            json!({"workload_id":"workload-one","generation":1,"job_id":"job-one"}),
        ),
    )
    .unwrap();
    s.observe(&finish_event(&s, "exit", "event-finish"))
        .unwrap();
    assert_eq!(s.session.as_ref().unwrap()["phase"], "awaiting_control");
    assert!(submit(&mut s, &run("request-two", "job-two")).is_err());
    s.uncertain();
    assert_eq!(s.session.as_ref().unwrap()["job"]["state"], "exited");
}
#[test]
fn output_counts_digest_and_replay() {
    let mut s = running();
    let mut v = s.session.clone().unwrap();
    v["job"]["stdout_bytes"] = json!(1);
    let out = event(
        &s,
        "request-run",
        "event-output",
        "output",
        v,
        json!({"job_id":"job-one","stream":"stdout","chunk_index":0,"data_b64":"YQ=="}),
    );
    s.observe(&out).unwrap();
    assert!(s.observe(&out).is_err());
    let mut bad = finish_event(&s, "exit", "event-finish");
    bad.0["data"]["stdout_sent_bytes"] = json!(2);
    assert!(s.observe(&bad).is_err());
    s.observe(&finish_event(&s, "exit", "event-good")).unwrap();
}
#[test]
fn stale_owner_and_output_bad_padding() {
    let mut s = running();
    let mut e = finish_event(&s, "exit", "event-finish");
    e.0["owner_id"] = json!("actor-foreign");
    assert!(s.observe(&e).is_err());
    assert!(metaviewer_core::guest_command::decode64("AB==", 5).is_err());
    assert!(metaviewer_core::guest_command::decode64("YQ==", 5).is_ok());
}
#[test]
fn metadata_unicode_and_boolean_are_refused() {
    let mut r = run("request-run", "job-one");
    r.0["params"]["cwd"] = json!((0..16)
        .map(|_| "😀".repeat(60))
        .collect::<Vec<_>>()
        .join("/"));
    assert!(prepare_exec(&r.0, &reservation_id("session-one", "request-create")).is_err());
    r.0["params"]["cwd"] = json!("");
    r.0["params"]["generation"] = json!(true);
    assert!(prepare_exec(&r.0, &reservation_id("session-one", "request-create")).is_err());
}
#[test]
fn golden_reservation() {
    assert_eq!(
        reservation_id("session-18c3", "request-create-1"),
        "reservation-f917f2cbe5e1865d5d695346b082846751ac0762bf1b78322a040c1a25f9f3d6"
    );
}
#[test]
fn stop_requires_ack_terminal_and_exact_native_release() {
    let mut s = running();
    let r = request(
        "stop",
        "request-stop",
        json!({"workload_id":"workload-one","generation":1}),
    );
    submit(&mut s, &r).unwrap();
    let mut v = s.session.clone().unwrap();
    v["controls"]["stop"]["ack"] = json!("accepted");
    s.observe(&event(
        &s,
        "request-stop",
        "event-stop-ack",
        "accepted",
        v,
        json!({"op":"stop"}),
    ))
    .unwrap();
    let mut v = s.session.clone().unwrap();
    v["phase"] = json!("stopped");
    v["ownership"] = json!("released");
    assert!(s
        .observe(&event(
            &s,
            "request-stop",
            "event-premature",
            "stopped",
            v,
            json!({"native_absent":true})
        ))
        .is_err());
    s.observe(&finish_event(&s, "stop", "event-job-stop"))
        .unwrap();
    let mut v = s.session.clone().unwrap();
    v["phase"] = json!("stopped");
    v["ownership"] = json!("released");
    s.observe(&event(
        &s,
        "request-stop",
        "event-stopped",
        "stopped",
        v,
        json!({"native_absent":true}),
    ))
    .unwrap();
    assert!(!s.held);
}
#[test]
fn unknown_blocks_late_success_and_foreign_agent() {
    let mut s = running();
    let e = finish_event(&s, "exit", "event-late");
    s.uncertain();
    assert!(s.observe(&e).is_err());
    assert!(s.held);
    let mut s = State::default();
    let mut wrong = ep(Component::Agent);
    wrong.instance = "wrong".into();
    assert!(s
        .submit(
            &create(),
            &wrong,
            &ep(Component::Agent),
            "session-one",
            0,
            false
        )
        .is_err());
    assert!(!s.held);
}
#[test]
fn max_payload_and_cwd_canonical_size() {
    let mut r = run("request-run", "job-one");
    r.0["params"]["command_utf8"] = json!("x".repeat(16384));
    r.0["params"]["stdin_b64"] = json!("AAAA".repeat(16384));
    let m = prepare_exec(&r.0, &reservation_id("session-one", "request-create")).unwrap();
    assert_eq!(m["stdin_bytes"], 49152);
    assert_eq!(m["command_bytes"], 16384);
    r.0["params"]["cwd"] = json!([
        "\\".repeat(255),
        "\\".repeat(255),
        "\\".repeat(255),
        "\\".repeat(254),
        "a".into()
    ]
    .join("/"));
    assert!(
        serde_json::to_vec(
            &prepare_exec(&r.0, &reservation_id("session-one", "request-create")).unwrap()
        )
        .unwrap()
        .len()
            <= 4096
    );
}
#[test]
fn new_family_decodes_but_versions_extras_and_float_generation_refuse() {
    let body = create().0;
    let mut env = json!({"schema":"capsule_envelope/v0.2","msg_id":"m","ts_ns":0,"from":ep(Component::Ui),"to":ep(Component::Core),"session_id":"s","seq":1,"nonce":"n","body":body});
    assert!(metaviewer_core::decode_envelope(&env.to_string()).is_ok());
    env["body"]["owner_id"] = json!("spoof");
    assert!(metaviewer_core::decode_envelope(&env.to_string()).is_err());
    let mut r = run("request-run", "job-one");
    r.0["params"]["generation"] = json!(1.0);
    assert!(serde_json::from_value::<GuestCommandRequest>(r.0).is_err());
}

#[test]
fn all_reservation_golden_vectors() {
    assert_eq!(
        reservation_id("session-18c3", "request-create-1"),
        "reservation-f917f2cbe5e1865d5d695346b082846751ac0762bf1b78322a040c1a25f9f3d6"
    );
    assert_eq!(
        reservation_id("ab", "request-c"),
        "reservation-5f1ed4ceb96a5675bc2e4e9de079877d7e5807fce46f11104d448eb549ccb9d0"
    );
    assert_eq!(
        reservation_id("a", "request-bc"),
        "reservation-03994f1333f0d7fea1041ba8742d44cb927e112350ee5878ecd99a9cce341965"
    );
    assert_eq!(
        reservation_id("sésión-🦊", "request-create"),
        "reservation-99dc5c5c769c722144f4dfc279045d9b9eaeded3741a208c14860fe6072add5b"
    );
}
#[test]
fn idle_resource_loss_is_create_correlated_and_preserves_finished_job() {
    for completed in [false, true] {
        let mut s = if completed {
            let mut s = running();
            s.observe(&finish_event(&s, "exit", "event-finish"))
                .unwrap();
            s
        } else {
            ready()
        };
        let old = s.session.clone().unwrap()["job"].clone();
        let mut v = s.session.clone().unwrap();
        v["phase"] = json!("uncertain");
        let e = event(
            &s,
            "request-create",
            "event-resource-lost",
            "outcome_unknown",
            v,
            json!({"op":"create","code":"TRANSPORT"}),
        );
        s.observe(&e).unwrap();
        assert!(s.held && s.unknown);
        assert_eq!(s.session.as_ref().unwrap()["job"], old);
    }
}
#[test]
fn idle_resource_loss_cannot_use_arbitrary_past_request() {
    let mut s = running();
    s.observe(&finish_event(&s, "exit", "event-finish"))
        .unwrap();
    let mut v = s.session.clone().unwrap();
    v["phase"] = json!("uncertain");
    let e = event(
        &s,
        "request-run",
        "event-resource-lost",
        "outcome_unknown",
        v,
        json!({"op":"create","code":"TRANSPORT"}),
    );
    assert!(s.observe(&e).is_err());
    assert!(!s.unknown);
}

#[test]
fn resource_loss_during_pending_work_must_use_pending_id() {
    let mut s = running();
    let mut v = s.session.clone().unwrap();
    v["phase"] = json!("uncertain");
    v["job"]["state"] = json!("unknown");
    let e = event(
        &s,
        "request-create",
        "event-wrong-id",
        "outcome_unknown",
        v,
        json!({"op":"create","code":"TRANSPORT"}),
    );
    assert!(s.observe(&e).is_err());
}

#[test]
fn stop_refusal_preserves_live_cancel_state() {
    let mut s = running();
    submit(
        &mut s,
        &request(
            "cancel",
            "request-cancel",
            json!({"workload_id":"workload-one","generation":1,"job_id":"job-one"}),
        ),
    )
    .unwrap();
    let mut v = s.session.clone().unwrap();
    v["controls"]["cancel"]["ack"] = json!("accepted");
    v["job"]["state"] = json!("cancelling");
    s.observe(&event(
        &s,
        "request-cancel",
        "event-cancel",
        "accepted",
        v,
        json!({"op":"cancel"}),
    ))
    .unwrap();
    submit(
        &mut s,
        &request(
            "stop",
            "request-stop",
            json!({"workload_id":"workload-one","generation":1}),
        ),
    )
    .unwrap();
    let mut v = s.session.clone().unwrap();
    v["controls"]["stop"] = Value::Null;
    v["phase"] = json!("cancelling");
    s.observe(&event(
        &s,
        "request-stop",
        "event-refuse-stop",
        "refused",
        v,
        json!({"op":"stop","code":"UNAVAILABLE"}),
    ))
    .unwrap();
    assert_eq!(s.session.as_ref().unwrap()["phase"], "cancelling");
    assert!(s.held);
}

#[test]
fn run_ack_preserves_stop_admitted_while_run_ack_pending() {
    let mut s = ready();
    submit(&mut s, &run("request-run", "job-one")).unwrap();
    submit(
        &mut s,
        &request(
            "stop",
            "request-stop",
            json!({"workload_id":"workload-one","generation":1}),
        ),
    )
    .unwrap();
    let mut v = s.session.clone().unwrap();
    v["phase"] = json!("stopping");
    v["jobs_started"] = json!(1);
    v["job"] = json!({"job_id":"job-one","state":"running","exit_code":null,"signal":null,"stdout_bytes":0,"stderr_bytes":0,"output_complete":false});
    s.observe(&event(
        &s,
        "request-run",
        "event-delayed-run",
        "accepted",
        v,
        json!({"op":"run"}),
    ))
    .unwrap();
    assert_eq!(
        s.session.as_ref().unwrap()["controls"]["stop"],
        json!({"request_id":"request-stop","ack":"pending"})
    );
    assert_eq!(s.session.as_ref().unwrap()["phase"], "stopping");
    assert_eq!(s.pending.len(), 2);
    let mut v = s.session.clone().unwrap();
    v["controls"]["stop"]["ack"] = json!("accepted");
    s.observe(&event(
        &s,
        "request-stop",
        "event-stop-ack",
        "accepted",
        v,
        json!({"op":"stop"}),
    ))
    .unwrap();
    s.observe(&finish_event(&s, "stop", "event-stop-finish"))
        .unwrap();
    assert_eq!(s.session.as_ref().unwrap()["phase"], "stopping");
}
#[test]
fn lagged_run_ack_and_output_merge_only_unaccepted_local_stop() {
    let mut s = ready();
    submit(&mut s, &run("request-run", "job-one")).unwrap();
    submit(
        &mut s,
        &request(
            "stop",
            "request-stop",
            json!({"workload_id":"workload-one","generation":1}),
        ),
    )
    .unwrap();
    let mut wire = s.session.clone().unwrap();
    wire["controls"] = json!({"cancel":null,"stop":null});
    wire["phase"] = json!("running");
    wire["jobs_started"] = json!(1);
    wire["job"] = json!({"job_id":"job-one","state":"running","exit_code":null,"signal":null,"stdout_bytes":0,"stderr_bytes":0,"output_complete":false});
    s.observe(&event(
        &s,
        "request-run",
        "event-lagged-ack",
        "accepted",
        wire.clone(),
        json!({"op":"run"}),
    ))
    .unwrap();
    assert_eq!(
        s.session.as_ref().unwrap()["controls"]["stop"]["request_id"],
        "request-stop"
    );
    assert_eq!(s.session.as_ref().unwrap()["phase"], "stopping");
    wire["job"]["stdout_bytes"] = json!(1);
    s.observe(&event(
        &s,
        "request-run",
        "event-lagged-output",
        "output",
        wire,
        json!({"job_id":"job-one","stream":"stdout","chunk_index":0,"data_b64":"YQ=="}),
    ))
    .unwrap();
    assert_eq!(s.session.as_ref().unwrap()["phase"], "stopping");
    let mut finish = finish_event(&s, "exit", "event-lagged-finish");
    finish.0["session"]["controls"]["stop"] = Value::Null;
    finish.0["session"]["phase"] = json!("ready");
    s.observe(&finish).unwrap();
    assert_eq!(s.session.as_ref().unwrap()["phase"], "awaiting_control");
    assert_eq!(s.session.as_ref().unwrap()["job"]["state"], "exited");
}
#[test]
fn observed_stop_ack_cannot_be_removed_from_later_snapshot() {
    let mut s = running();
    submit(
        &mut s,
        &request(
            "stop",
            "request-stop",
            json!({"workload_id":"workload-one","generation":1}),
        ),
    )
    .unwrap();
    let mut v = s.session.clone().unwrap();
    v["controls"]["stop"]["ack"] = json!("accepted");
    s.observe(&event(
        &s,
        "request-stop",
        "event-ack",
        "accepted",
        v,
        json!({"op":"stop"}),
    ))
    .unwrap();
    let mut v = s.session.clone().unwrap();
    v["controls"]["stop"] = Value::Null;
    v["phase"] = json!("running");
    v["job"]["stdout_bytes"] = json!(1);
    assert!(s
        .observe(&event(
            &s,
            "request-run",
            "event-bad-output",
            "output",
            v,
            json!({"job_id":"job-one","stream":"stdout","chunk_index":0,"data_b64":"YQ=="})
        ))
        .is_err());
}
