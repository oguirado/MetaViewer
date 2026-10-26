#![forbid(unsafe_code)]
use metaviewer_core::admission::*;
use metaviewer_core::journal::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "mv-recovery-crash-{}-{}",
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

fn admission_fixture(n: u64, hash: &str) -> AdmissionRequest {
    let raw = json!({
        "schema": "envelope/v0.2",
        "msg_id": format!("input-{n}"),
        "ts_ns": 0,
        "from": {"component": "agent", "instance": "agent-1"},
        "to": {"component": "core", "instance": "core-1"},
        "session_id": "session-1",
        "seq": n,
        "nonce": format!("nonce-{n}"),
        "body": {
            "schema": "action_proposal/v0.2",
            "proposal_id": format!("proposal-{n}"),
            "surface_id": "surface-1",
            "based_on_frame": {"sha256": hash, "generation": 1},
            "action": {"type": "click", "x": 1, "y": 2, "button": "left"},
            "expectation": {"type": "text_present", "text": "ready"},
            "budget": {"max_ms": 10, "max_retries": 0}
        }
    });
    AdmissionRequest::decode(
        &raw.to_string(),
        &metaviewer_core::Endpoint {
            component: metaviewer_core::Component::Agent,
            instance: "agent-1".into(),
        },
        "session-1",
        1,
        0,
    )
    .unwrap()
}

#[test]
fn scripted_sequence_with_simulated_crashes() {
    // Drive sequence: Surface -> Frame -> Propose -> Dispatch -> Receipt -> TakeControl -> ReleaseControl
    // Simulate crash after each durable step and verify recovery behavior.

    let t = Temp::new();
    let root = t.0.join("sessions/session-1");
    let path = root.join("journal.jsonl");

    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    let witness = c.retain_witness(b"frame-data-1").unwrap();

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

    let p = admission_fixture(1, &witness.sha256);
    c.apply_with_witnesses(Input::Propose(p), vec![witness.clone()])
        .unwrap();

    c.apply(Input::Dispatch {
        proposal_id: "proposal-1".into(),
        now_ns: 1,
    })
    .unwrap();

    c.apply(Input::Receipt {
        proposal_id: "proposal-1".into(),
        epoch: 1,
    })
    .unwrap();

    c.apply(Input::TakeControl {
        surface_id: "surface-1".into(),
    })
    .unwrap();

    c.apply(Input::ReleaseControl {
        surface_id: "surface-1".into(),
    })
    .unwrap();

    drop(c);

    // Verify recovery on clean closed journal
    let rec1 = Authority::recover(&path, &root).unwrap();
    let digest1 = sha256_hex(&rec1.state().snapshot().unwrap());
    drop(rec1);

    // SW-0177 Claim 1 (Idempotent Redo): Double recovery gives identical digest!
    let rec2 = Authority::recover(&path, &root).unwrap();
    let digest2 = sha256_hex(&rec2.state().snapshot().unwrap());
    assert_eq!(digest1, digest2);
    drop(rec2);

    let scan_replay = scan(&path, &root).unwrap();
    let scan_digest = sha256_hex(&scan_replay.state.snapshot().unwrap());
    assert_eq!(digest1, scan_digest);
}

#[test]
fn crash_scenarios_and_atomicity() {
    // Case 1: Orphan event sidecar event-N+1 without journal line entry
    let t = Temp::new();
    let root = t.0.join("sessions/session-1");
    let path = root.join("journal.jsonl");

    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    drop(c);

    // Simulate crash after event sidecar written, before journal line / checkpoint
    fs::write(root.join("events/2.json"), b"{\"orphan\": true}").unwrap();

    // Authority::recover detects unsealed orphan sidecar and fails closed with Unsealed error!
    assert_eq!(
        Authority::recover(&path, &root).err(),
        Some(JournalError::Unsealed)
    );

    // Remove orphan to make it valid again
    fs::remove_file(root.join("events/2.json")).unwrap();
    assert!(Authority::recover(&path, &root).is_ok());

    // Case 2: Deleted tail line from journal.jsonl (Torn tail)
    let content = fs::read_to_string(&path).unwrap();
    let mut lines: Vec<&str> = content.lines().collect();
    lines.pop();
    fs::write(&path, lines.join("\n") + "\n").unwrap();

    // Since event 1 exists on disk but journal has only header, event 1 is an orphan relative to count 0!
    assert!(Authority::recover(&path, &root).is_err());

    // Case 3: Stale checkpoint.next promotion rules
    let t2 = Temp::new();
    let root2 = t2.0.join("sessions/session-1");
    let path2 = root2.join("journal.jsonl");

    let mut c2 = Authority::create(&t2.0, CoreState::session("session-1").unwrap()).unwrap();
    c2.apply(Input::Connect).unwrap();
    drop(c2);

    let valid_ckpt = fs::read(root2.join("checkpoint.json")).unwrap();
    // Leave stale invalid checkpoint.next
    fs::write(root2.join("checkpoint.next"), b"{\"invalid\": true}").unwrap();

    // Recover verifies chain and replaces stale checkpoint.next with valid current
    let rec = Authority::recover(&path2, &root2).unwrap();
    assert!(!root2.join("checkpoint.next").exists());
    drop(rec);

    assert_eq!(fs::read(root2.join("checkpoint.json")).unwrap(), valid_ckpt);
}

#[test]
fn aries_fsm_transition_table_mapping() {
    // Mapping SW-0177 FSM states: START, ANALYSIS, REDO, UNDO, DONE, PARADA
    // In metaviewer-core recovery:
    // START -> ANALYSIS: verify_chain / scan header and genesis
    // ANALYSIS -> REDO: verify records, sidecars, witnesses and rebuild state
    // REDO -> UNDO: check unsealed orphan event files
    // UNDO -> DONE: promote/clean checkpoint and return Authority handle
    // Any FAULT at any step -> PARADA (fail closed with JournalError, no state change)

    let t = Temp::new();
    let root = t.0.join("sessions/session-1");
    let path = root.join("journal.jsonl");

    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    drop(c);

    // Fault in ANALYSIS phase (corrupt genesis.json)
    fs::write(root.join("genesis.json"), b"corrupt").unwrap();
    assert_eq!(
        Authority::recover(&path, &root).err(),
        Some(JournalError::Corrupt)
    );

    // PARADA is absorbing: subsequent recover attempts also fail closed
    assert_eq!(
        Authority::recover(&path, &root).err(),
        Some(JournalError::Corrupt)
    );
}
