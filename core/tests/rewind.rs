#[path = "../src/rewind.rs"]
mod rewind;
use rewind::*;
use serde_json::json;
use sha2::{Digest, Sha256};
fn native(n: u64) -> NativeId {
    NativeId {
        run_id: format!("run-{n}"),
        pid: 100 + n,
        start_tick: 1000 + n,
        invocation: format!("{n:032x}"),
    }
}
fn owner() -> String {
    format!("actor-{:x}", Sha256::digest(b"agent:agent-one"))
}
fn setup() -> State {
    let g = json!({"schema":"guest_command_session/v0.2","owner_id":owner(),"workload_id":"workload-one","generation":1,"backend":"firecracker","isa":"aarch64","profile_id":"guest-command-arm64-v1","phase":"ready","ownership":"held","jobs_started":0,"job":null,"controls":{"cancel":null,"stop":null}});
    State::initialize(
        &g,
        Participants {
            agent: "agent-one",
            creator: "ui-one",
        },
        "session-one",
        7,
        1,
        &"a".repeat(64),
        native(1),
    )
    .unwrap()
}
fn caller() -> Principal {
    Principal::Ui("ui-one".into())
}
fn request(s: &State, op: Op, name: &str) -> Request {
    let v = s.status();
    Request {
        schema: "rewind_request/v0.2".into(),
        request_id: format!("request-{name}"),
        op: op.clone(),
        params: Params {
            workload_id: "workload-one".into(),
            generation: v["generation"].as_u64().unwrap(),
            authority_epoch: v["authority_epoch"].as_u64().unwrap(),
            label: if op == Op::Mark {
                Some("Before edit".into())
            } else {
                None
            },
            point_id: None,
        },
    }
}
fn fenced(n: u64) -> Fenced {
    Fenced {
        native: native(n),
        no_job: true,
        socket_closed: true,
        paused: true,
    }
}
fn ready(d: &Dispatch, n: u64) -> Ready {
    Ready {
        native: native(n),
        generation: d.generation,
        authority_epoch: d.authority_epoch,
        reseeded: true,
        hello_ready: true,
    }
}
fn closed(n: u64, attempt: Option<String>) -> Closed {
    Closed {
        native: native(n),
        attempt_id: attempt,
        inventory_complete: true,
        pid_absent: true,
        service_absent: true,
        cgroup_empty: true,
        mappings_released: true,
    }
}
fn event(d: &Dispatch, n: &str, outcome: Outcome) -> Event {
    Event {
        event_id: format!("event-{n}"),
        request_id: d.request.request_id.clone(),
        owner_id: owner(),
        workload_id: "workload-one".into(),
        generation: d.generation,
        authority_epoch: d.authority_epoch,
        outcome,
    }
}
fn pause(s: &mut State, name: &str) {
    let d = s
        .submit(
            request(s, Op::Pause, name),
            &caller(),
            7,
            CommandGate::Quiescent,
        )
        .unwrap();
    s.observe(event(&d, name, Outcome::Paused(fenced(1))), 7)
        .unwrap();
}
fn mark(s: &mut State, name: &str) -> String {
    mark_counter(s, name, 73)
}
fn mark_counter(s: &mut State, name: &str, counter: u64) -> String {
    let origin = s.status();
    let d = s
        .submit(
            request(s, Op::Mark, name),
            &caller(),
            7,
            CommandGate::Quiescent,
        )
        .unwrap();
    let id = d.allocated_point.clone().unwrap();
    let p = Point {
        schema: "rewind_point/v0.2".into(),
        point_id: id.clone(),
        label: "Before edit".into(),
        created_mono_ns: 123,
        created_order: origin["points"].as_array().unwrap().len() as u64 + 1,
        source_generation: origin["generation"].as_u64().unwrap(),
        source_authority_epoch: origin["authority_epoch"].as_u64().unwrap(),
        compatibility_sha256: "a".repeat(64),
        state_sha256: "b".repeat(64),
        memory_sha256: "c".repeat(64),
        state_bytes: 4096,
        memory_bytes: 268435456,
        counter_value: Some(counter),
        status: "usable".into(),
        active_references: 0,
    };
    let resumed = if origin["phase"] == "ready" {
        Some(ready(&d, 1))
    } else {
        None
    };
    s.observe(
        event(
            &d,
            name,
            Outcome::Marked {
                point: Box::new(p),
                fence: fenced(1),
                resumed,
            },
        ),
        7,
    )
    .unwrap();
    id
}
#[test]
fn initialized_owner_and_no_counter_authority() {
    let s = setup();
    assert!(s.command_allowed(&owner(), 1, 7));
    assert_eq!(s.status()["authority"], "core");
    assert_eq!(s.status()["points"], json!([]));
}
#[test]
fn rejects_foreign_stale_busy_without_mutation() {
    let s = setup();
    for kind in 0..5 {
        let mut state = s.clone();
        let before = state.clone();
        let mut r = request(&state, Op::Pause, "bad");
        let mut c = caller();
        let mut epoch = 7;
        let mut active = CommandGate::Quiescent;
        match kind {
            0 => c = Principal::Agent("other".into()),
            1 => r.params.generation = 2,
            2 => epoch = 8,
            3 => active = CommandGate::Active,
            _ => r.params.workload_id = "workload-other".into(),
        };
        assert!(state.submit(r, &c, epoch, active).is_err());
        assert_eq!(state, before);
    }
}
#[test]
fn pause_resume_allocates_before_dispatch_and_late_output_refused() {
    let mut s = setup();
    pause(&mut s, "pause");
    let d = s
        .submit(
            request(&s, Op::Resume, "resume"),
            &caller(),
            7,
            CommandGate::Quiescent,
        )
        .unwrap();
    assert_eq!((d.generation, d.authority_epoch), (2, 2));
    assert!(!s.command_allowed(&owner(), 1, 7));
    assert!(!s.command_allowed(&owner(), 2, 7));
    let mut bad = event(&d, "old", Outcome::Resumed(ready(&d, 1)));
    bad.generation = 1;
    let before = s.clone();
    assert!(s.observe(bad, 7).is_err());
    assert_eq!(s, before);
    s.observe(event(&d, "new", Outcome::Resumed(ready(&d, 1))), 7)
        .unwrap();
    assert!(s.command_allowed(&owner(), 2, 7));
}
#[test]
fn mark_from_ready_resumes_and_paused_mark_stays_paused() {
    let mut s = setup();
    let one = mark(&mut s, "one");
    assert_eq!(s.status()["phase"], "ready");
    assert_eq!(s.status()["generation"], 2);
    pause(&mut s, "pause");
    let two = mark(&mut s, "two");
    assert_ne!(one, two);
    assert_eq!(s.status()["phase"], "paused");
    assert_eq!(s.status()["generation"], 2);
    assert!(s
        .submit(
            request(&s, Op::Mark, "third"),
            &caller(),
            7,
            CommandGate::Quiescent
        )
        .is_err());
}
#[test]
fn full_restore_requires_old_closure_and_new_identity() {
    let mut s = setup();
    let id = mark(&mut s, "mark");
    pause(&mut s, "pause");
    let mut r = request(&s, Op::Restore, "restore");
    r.params.point_id = Some(id.clone());
    let d = s.submit(r, &caller(), 7, CommandGate::Quiescent).unwrap();
    let mut c = closed(1, d.attempt_id.clone());
    c.mappings_released = false;
    let before = s.clone();
    assert!(s
        .observe(
            event(
                &d,
                "bad",
                Outcome::Restored {
                    old_closed: c,
                    ready: ready(&d, 2)
                }
            ),
            7
        )
        .is_err());
    assert_eq!(s, before);
    s.observe(
        event(
            &d,
            "ok",
            Outcome::Restored {
                old_closed: closed(1, d.attempt_id.clone()),
                ready: ready(&d, 2),
            },
        ),
        7,
    )
    .unwrap();
    assert_eq!(s.status()["points"][0]["active_references"], 1);
    assert!(s.evict(&id, 7).is_err());
    assert!(s.closed(&closed(1, None), 7).is_err());
    s.closed(&closed(2, None), 7).unwrap();
    assert_eq!(s.status()["ownership"], "released");
    assert_eq!(s.status()["points"][0]["active_references"], 0);
}
#[test]
fn missing_reseed_never_opens_commands() {
    let mut s = setup();
    pause(&mut s, "pause");
    let d = s
        .submit(
            request(&s, Op::Resume, "resume"),
            &caller(),
            7,
            CommandGate::Quiescent,
        )
        .unwrap();
    let mut p = ready(&d, 1);
    p.reseeded = false;
    assert!(s.observe(event(&d, "bad", Outcome::Resumed(p)), 7).is_err());
    assert!(!s.command_allowed(&owner(), d.generation, 7));
}
#[test]
fn ambiguous_result_retains_pending_and_forbids_replay() {
    let mut s = setup();
    pause(&mut s, "pause");
    let d = s
        .submit(
            request(&s, Op::Resume, "resume"),
            &caller(),
            7,
            CommandGate::Quiescent,
        )
        .unwrap();
    s.observe(event(&d, "unknown", Outcome::Unknown), 7)
        .unwrap();
    assert_eq!(s.status()["ownership"], "held");
    assert!(s.status()["pending_request_id"].is_string());
    assert!(s
        .observe(event(&d, "late", Outcome::Resumed(ready(&d, 1))), 7)
        .is_err());
    assert!(s
        .submit(
            request(&s, Op::Resume, "again"),
            &caller(),
            7,
            CommandGate::Quiescent
        )
        .is_err());
}
#[test]
fn recovery_requires_explicit_safe_pause_and_last_good() {
    let mut s = setup();
    let id = mark(&mut s, "mark");
    pause(&mut s, "pause");
    let mut r = request(&s, Op::Restore, "restore");
    r.params.point_id = Some(id.clone());
    let d = s.submit(r, &caller(), 7, CommandGate::Quiescent).unwrap();
    s.observe(
        event(
            &d,
            "failed",
            Outcome::RestoreFailedPaused {
                fence: fenced(1),
                attempt_closed: closed(2, d.attempt_id.clone()),
            },
        ),
        7,
    )
    .unwrap();
    assert_eq!(s.status()["phase"], "uncertain");
    assert_eq!(s.status()["last_good_usable"], id);
    let mut retry = request(&s, Op::Restore, "explicit-new-intent");
    retry.params.point_id = Some(id);
    assert!(s
        .submit(
            retry,
            &Principal::Agent("agent-one".into()),
            7,
            CommandGate::Quiescent
        )
        .is_ok());
}
#[test]
fn unknown_restore_cannot_release_unbound_attempt() {
    let mut s = setup();
    let id = mark(&mut s, "mark");
    pause(&mut s, "pause");
    let mut r = request(&s, Op::Restore, "restore");
    r.params.point_id = Some(id);
    let d = s.submit(r, &caller(), 7, CommandGate::Quiescent).unwrap();
    s.unknown();
    assert!(s.closed(&closed(1, None), 7).is_err());
    assert_eq!(s.status()["ownership"], "held");
    s.closed(&closed(1, d.attempt_id.clone()), 7).unwrap();
    assert_eq!(s.status()["ownership"], "released");
}
#[test]
fn wrong_executor_event_does_not_mutate() {
    let mut s = setup();
    let d = s
        .submit(
            request(&s, Op::Pause, "pause"),
            &caller(),
            7,
            CommandGate::Quiescent,
        )
        .unwrap();
    let before = s.clone();
    assert!(s
        .observe(event(&d, "pause", Outcome::Paused(fenced(1))), 8)
        .is_err());
    assert_eq!(s, before);
}

#[test]
fn unknown_command_gate_and_null_extra_fields_refuse() {
    let mut s = setup();
    assert!(s
        .submit(
            request(&s, Op::Mark, "unknown"),
            &caller(),
            7,
            CommandGate::Unknown
        )
        .is_err());
    let mut raw = serde_json::to_value(request(&s, Op::Pause, "null")).unwrap();
    raw["params"]["label"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<Request>(raw).is_err());
}
#[test]
fn a_safe_failed_pause_is_held_not_fake_closed() {
    let mut s = setup();
    let d = s
        .submit(
            request(&s, Op::Pause, "pause"),
            &caller(),
            7,
            CommandGate::Quiescent,
        )
        .unwrap();
    s.observe(event(&d, "failed", Outcome::FailedPaused(fenced(1))), 7)
        .unwrap();
    assert_eq!(s.status()["phase"], "uncertain");
    assert_eq!(s.status()["ownership"], "held");
    assert!(s
        .submit(
            request(&s, Op::Resume, "retry"),
            &caller(),
            7,
            CommandGate::Quiescent
        )
        .is_err());
}
#[test]
fn draft_status_shapes() {
    let mut s = setup();
    println!("RW07_STATUS {}", s.status());
    let id = mark(&mut s, "mark-status");
    println!("RW07_STATUS {}", s.status());
    pause(&mut s, "pause-status");
    println!("RW07_STATUS {}", s.status());
    let mut r = request(&s, Op::Restore, "restore-status");
    r.params.point_id = Some(id);
    let d = s.submit(r, &caller(), 7, CommandGate::Quiescent).unwrap();
    println!("RW07_STATUS {}", s.status());
    s.observe(
        event(
            &d,
            "restored-status",
            Outcome::Restored {
                old_closed: closed(1, d.attempt_id.clone()),
                ready: ready(&d, 2),
            },
        ),
        7,
    )
    .unwrap();
    println!("RW07_STATUS {}", s.status());
    s.closed(&closed(2, None), 7).unwrap();
    println!("RW07_STATUS {}", s.status());
}

#[test]
fn guest_counter_is_passive_metadata_not_epoch_authority() {
    let mut s = setup();
    mark_counter(&mut s, "counter", 9007199254740991);
    assert_eq!(
        s.status()["points"][0]["counter_value"],
        9007199254740991u64
    );
    assert_eq!(s.status()["generation"], 2);
    assert_eq!(s.status()["authority_epoch"], 2);
}
#[test]
fn foreign_correlations_never_mutate_or_finish() {
    for kind in 0..4 {
        let mut s = setup();
        let d = s
            .submit(
                request(&s, Op::Pause, "pause"),
                &caller(),
                7,
                CommandGate::Quiescent,
            )
            .unwrap();
        let before = s.clone();
        let mut e = event(&d, "test", Outcome::Paused(fenced(1)));
        match kind {
            0 => e.owner_id = "actor-foreign".into(),
            1 => e.workload_id = "workload-other".into(),
            2 => e.request_id = "request-other".into(),
            _ => e.authority_epoch += 1,
        };
        assert!(s.observe(e, 7).is_err());
        assert_eq!(s, before);
    }
}

#[test]
fn restored_same_pid_start_with_renamed_identity_refuses() {
    let mut s = setup();
    let id = mark(&mut s, "mark");
    pause(&mut s, "pause");
    let mut r = request(&s, Op::Restore, "restore");
    r.params.point_id = Some(id);
    let d = s.submit(r, &caller(), 7, CommandGate::Quiescent).unwrap();
    let mut ready = ready(&d, 1);
    ready.native.run_id = "run-renamed".into();
    ready.native.invocation = "f".repeat(32);
    let before = s.clone();
    assert!(s
        .observe(
            event(
                &d,
                "bad-physical",
                Outcome::Restored {
                    old_closed: closed(1, d.attempt_id.clone()),
                    ready
                }
            ),
            7
        )
        .is_err());
    assert_eq!(s, before);
}
