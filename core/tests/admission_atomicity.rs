#![forbid(unsafe_code)]
use metaviewer_core::admission::*;
use metaviewer_core::journal::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "mv-admission-atom-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn admission_fixture(
    n: u64,
    agent_inst: &str,
    hash: &str,
    surface_id: &str,
    action_override: Option<serde_json::Value>,
) -> AdmissionRequest {
    let action = action_override
        .unwrap_or_else(|| json!({"type": "click", "x": 1, "y": 2, "button": "left"}));
    let raw = json!({
        "schema": "envelope/v0.2",
        "msg_id": format!("input-{n}"),
        "ts_ns": 0,
        "from": {"component": "agent", "instance": agent_inst},
        "to": {"component": "core", "instance": "core-1"},
        "session_id": "session-1",
        "seq": n,
        "nonce": format!("nonce-{n}"),
        "body": {
            "schema": "action_proposal/v0.2",
            "proposal_id": format!("proposal-{n}"),
            "surface_id": surface_id,
            "based_on_frame": {"sha256": hash, "generation": 1},
            "action": action,
            "expectation": {"type": "text_present", "text": "ready"},
            "budget": {"max_ms": 10, "max_retries": 0}
        }
    });
    AdmissionRequest::decode(
        &raw.to_string(),
        &metaviewer_core::Endpoint {
            component: metaviewer_core::Component::Agent,
            instance: agent_inst.into(),
        },
        "session-1",
        1,
        0,
    )
    .unwrap()
}

fn setup_authority(t: &Temp) -> (Authority, Witness) {
    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    let witness = c.retain_witness(b"frame-witness-1").unwrap();

    let surface = Surface {
        display: "display-1".into(),
        owner: metaviewer_core::Endpoint {
            component: metaviewer_core::Component::Agent,
            instance: "agent-1".into(),
        },
        agent_controlled: true,
        live: true,
        frame: Some(Frame {
            sha256: witness.sha256.clone(),
            generation: 1,
            width: 10,
            height: 10,
        }),
        refresh_after: None,
        allowed_verbs: vec![],
    };
    c.apply_with_witnesses(
        Input::Surface {
            id: "surface-1".into(),
            surface,
        },
        vec![witness.clone()],
    )
    .unwrap();
    (c, witness)
}

#[test]
fn failure_atomicity_and_refusal_matrix() {
    let t = Temp::new();
    let (mut c, w) = setup_authority(&t);

    // Snapshot domain state before refusals
    let domain_before = c.state().domain_snapshot().unwrap();
    let seq_before = c.state().core_seq;

    // 1. Refusal: STALE_FRAME (wrong sha256)
    let p_stale = admission_fixture(
        10,
        "agent-1",
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "surface-1",
        None,
    );
    let v_stale = serde_json::to_value(c.admit(p_stale, vec![w.clone()]).unwrap()).unwrap();
    assert_eq!(v_stale["decision"], "refused");
    assert_eq!(v_stale["reason_code"], "STALE_FRAME");
    // Domain snapshot (surfaces, leases, pending, draining, budget, epoch) must remain strictly UNCHANGED
    assert_eq!(c.state().domain_snapshot().unwrap(), domain_before);
    assert_eq!(c.state().core_seq, seq_before + 1); // core_seq increments because refusal is journaled

    // 2. Refusal: SURFACE_NOT_AGENT_CONTROLLED
    let p_not_owner = admission_fixture(11, "agent-2", &w.sha256, "surface-1", None);
    let v_not_owner = serde_json::to_value(c.admit(p_not_owner, vec![w.clone()]).unwrap()).unwrap();
    assert_eq!(v_not_owner["decision"], "refused");
    assert_eq!(v_not_owner["reason_code"], "SURFACE_NOT_AGENT_CONTROLLED");
    assert_eq!(c.state().domain_snapshot().unwrap(), domain_before);

    // 3. Refusal: LOCKED_BY_OTHER
    // First admit p_valid on surface-1
    let p_valid = admission_fixture(12, "agent-1", &w.sha256, "surface-1", None);
    let v_valid = serde_json::to_value(c.admit(p_valid, vec![w.clone()]).unwrap()).unwrap();
    assert_eq!(v_valid["decision"], "admitted");

    let domain_after_valid = c.state().domain_snapshot().unwrap();

    // Now try second proposal on surface-1 -> LOCKED_BY_OTHER
    let p_locked = admission_fixture(13, "agent-1", &w.sha256, "surface-1", None);
    let v_locked = serde_json::to_value(c.admit(p_locked, vec![w.clone()]).unwrap()).unwrap();
    assert_eq!(v_locked["decision"], "refused");
    assert_eq!(v_locked["reason_code"], "LOCKED_BY_OTHER");
    assert_eq!(c.state().domain_snapshot().unwrap(), domain_after_valid);

    // 4. Refusal: OUT_OF_BOUNDS (click x=99 >= width 10)
    let t2 = Temp::new();
    let (mut c2, w2) = setup_authority(&t2);
    let domain_before2 = c2.state().domain_snapshot().unwrap();

    let p_oob = admission_fixture(
        20,
        "agent-1",
        &w2.sha256,
        "surface-1",
        Some(json!({"type": "click", "x": 99, "y": 2, "button": "left"})),
    );
    let v_oob = serde_json::to_value(c2.admit(p_oob, vec![w2.clone()]).unwrap()).unwrap();
    assert_eq!(v_oob["decision"], "refused");
    assert_eq!(v_oob["reason_code"], "OUT_OF_BOUNDS");
    assert_eq!(c2.state().domain_snapshot().unwrap(), domain_before2);

    // 5. Refusal: BUDGET_EXCEEDED (remaining_budget == 0)
    let t3 = Temp::new();
    let mut c3 = Authority::create(&t3.0, CoreState::new("session-1", 0).unwrap()).unwrap();
    c3.apply(Input::Connect).unwrap();
    let w3 = c3.retain_witness(b"frame-3").unwrap();
    c3.apply_with_witnesses(
        Input::Surface {
            id: "surface-1".into(),
            surface: Surface {
                display: "display-1".into(),
                owner: metaviewer_core::Endpoint {
                    component: metaviewer_core::Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: Some(Frame {
                    sha256: w3.sha256.clone(),
                    generation: 1,
                    width: 10,
                    height: 10,
                }),
                refresh_after: None,
                allowed_verbs: vec![],
            },
        },
        vec![w3.clone()],
    )
    .unwrap();

    let domain_before3 = c3.state().domain_snapshot().unwrap();
    let p_budget = admission_fixture(30, "agent-1", &w3.sha256, "surface-1", None);
    let v_budget = serde_json::to_value(c3.admit(p_budget, vec![w3.clone()]).unwrap()).unwrap();
    assert_eq!(v_budget["decision"], "refused");
    assert_eq!(v_budget["reason_code"], "BUDGET_EXCEEDED");
    assert_eq!(c3.state().domain_snapshot().unwrap(), domain_before3);

    // 6. Refusal: POLICY (duplicate msg_id / proposal_id)
    let t4 = Temp::new();
    let (mut c4, w4) = setup_authority(&t4);
    let p_pol1 = admission_fixture(40, "agent-1", &w4.sha256, "surface-1", None);
    c4.admit(p_pol1.clone(), vec![w4.clone()]).unwrap();
    let domain_after_pol1 = c4.state().domain_snapshot().unwrap();

    let v_pol2 = serde_json::to_value(c4.admit(p_pol1, vec![w4.clone()]).unwrap()).unwrap();
    assert_eq!(v_pol2["decision"], "refused");
    assert_eq!(v_pol2["reason_code"], "POLICY");
    assert_eq!(c4.state().domain_snapshot().unwrap(), domain_after_pol1);
}

#[test]
fn error_paths_leave_bytes_untouched_and_poison_handle() {
    let t = Temp::new();
    let (mut c, w) = setup_authority(&t);

    let state_before = c.state().snapshot().unwrap();

    // 1. Pre-state rejection: Invalid input (missing witness for Propose)
    let p = admission_fixture(1, "agent-1", &w.sha256, "surface-1", None);
    let err_witness = c.apply(Input::Propose(p));
    assert_eq!(err_witness.err(), Some(JournalError::Witness));

    // For Err paths (e.g. JournalError), state handle and snapshot must remain 100% untouched!
    assert_eq!(c.state().snapshot().unwrap(), state_before);

    // 2. Failed append / storage failure poisons handle until recovery
    let root = t.0.join("sessions/session-1");
    let events_dir = root.join("events");
    // Make events directory read-only (mode 0500) to force storage failure during publish
    fs::set_permissions(&events_dir, fs::Permissions::from_mode(0o500)).unwrap();

    let p_fail = admission_fixture(2, "agent-1", &w.sha256, "surface-1", None);
    let res = c.apply_with_witnesses(Input::Propose(p_fail), vec![w.clone()]);
    assert!(res.is_err());

    // Subsequent operation on poisoned handle returns Poisoned error!
    let res_poisoned = c.retain_witness(b"test");
    assert_eq!(res_poisoned.err(), Some(JournalError::Poisoned));

    // Restore permissions on events directory and recover
    fs::set_permissions(&events_dir, fs::Permissions::from_mode(0o700)).unwrap();
    drop(c);

    let path = root.join("journal.jsonl");
    let recovered = Authority::recover(&path, &root);
    assert!(recovered.is_ok());
}
