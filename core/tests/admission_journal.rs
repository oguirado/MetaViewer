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
            "mv-admit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn canonical_and_hash_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_hex(&vec![b'a'; 1_000_000]),
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
    assert_eq!(
        canonical_bytes(&json!({"z":0,"a":[{"b":"é","a":1}]})).unwrap(),
        "{\"a\":[{\"a\":1,\"b\":\"é\"}],\"z\":0}".as_bytes()
    );
    assert!(canonical_bytes(&json!({"x":1.2})).is_err());
}
#[test]
fn durable_replay_exact_boundaries_and_exclusive_writer() {
    let t = Temp::new();
    let initial = CoreState::new("session-1", 10).unwrap();
    let mut core = Authority::create(&t.0, initial).unwrap();
    assert!(Authority::recover(
        &t.0.join("sessions/session-1/journal.jsonl"),
        &t.0.join("sessions/session-1")
    )
    .is_err());
    let first = core.apply(Input::Connect).unwrap();
    assert_eq!(first.core_seq, 1);
    let golden = core.state().snapshot().unwrap();
    core.apply(Input::Connect).unwrap();
    let final_state = core.state().snapshot().unwrap();
    drop(core);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();
    let replay = scan(&path, root).unwrap();
    assert_eq!(replay.boundaries, vec![golden, final_state.clone()]);
    assert_eq!(replay.state.snapshot().unwrap(), final_state);
    let recovered = Authority::recover(&path, root).unwrap();
    assert_eq!(recovered.state().snapshot().unwrap(), final_state);
    drop(recovered);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .args([
            "--journal",
            path.to_str().unwrap(),
            "--witness-root",
            root.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        sha256_hex(&final_state)
    );
}

#[test]
fn replay_digest_is_stable_across_scans_timezones_and_process_input() {
    // Mutation: replace mv-replay's snapshot digest with sha256_hex(b"wrong").
    use std::io::Write;
    use std::process::{Command, Stdio};
    let t = Temp::new();
    let (mut authority, witness) = setup_admission(&t);
    authority
        .apply_with_witnesses(
            Input::Propose(admission_fixture(1, &witness.sha256)),
            vec![witness.clone()],
        )
        .unwrap();
    let snapshot = authority.state().snapshot().unwrap();
    drop(authority);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();
    let original = fs::read(&path).unwrap();
    let expected = sha256_hex(&snapshot);
    for _ in 0..2 {
        let replay = scan(&path, root).unwrap();
        assert_eq!(replay.state.snapshot().unwrap(), snapshot);
        assert_eq!(sha256_hex(&replay.state.snapshot().unwrap()), expected);
    }
    let cli = |tz: &str, input: &[u8]| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mv-replay"))
            .arg("--journal")
            .arg(&path)
            .arg("--witness-root")
            .arg(root)
            .env("TZ", tz)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    };
    for (tz, input) in [
        ("UTC0", b"first ignored input\n".as_slice()),
        ("JST-9", b"different ignored input\n".as_slice()),
    ] {
        let output = cli(tz, input);
        assert!(output.status.success(), "{:?}", output);
        assert_eq!(output.stdout, format!("{expected}\n").as_bytes());
        assert!(output.stderr.is_empty());
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(fs::read(&path).unwrap(), original);
    // Negative control: identical journal, corrupted retained witness.
    fs::write(
        root.join("artifacts").join(&witness.sha256),
        b"corrupted frame",
    )
    .unwrap();
    assert!(scan(&path, root).is_err());
    let rejected = cli("UTC0", b"");
    assert_eq!(rejected.status.code(), Some(4));
    assert!(rejected.stdout.is_empty());
    assert!(!rejected.stderr.is_empty());
}
#[test]
fn corruption_tail_deletion_duplicate_and_artifact_mutants_refuse() {
    for mode in 0..5 {
        let t = Temp::new();
        let mut c = Authority::create(&t.0, CoreState::new("session-1", 10).unwrap()).unwrap();
        c.apply(Input::Connect).unwrap();
        c.apply(Input::Connect).unwrap();
        drop(c);
        let path = t.0.join("sessions/session-1/journal.jsonl");
        let root = path.parent().unwrap();
        let original = fs::read_to_string(&path).unwrap();
        let mut lines: Vec<String> = original.lines().map(str::to_owned).collect();
        match mode {
            0 => {
                lines[2] = lines[2].replace("surface_changed", "received");
                fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
            }
            1 => {
                lines.pop();
                fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
            }
            2 => {
                lines.push(lines[2].clone());
                fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
            }
            3 => {
                fs::write(root.join("events/2.json"), b"{}").unwrap();
            }
            _ => {
                fs::remove_file(root.join("checkpoint.json")).unwrap();
            }
        }
        assert!(scan(&path, root).is_err(), "mutant {mode} accepted");
    }
}
#[test]
fn caps_and_storage_failure_grant_no_state() {
    let t = Temp::new();
    let mut c = Authority::create(&t.0, CoreState::new("session-1", 10).unwrap()).unwrap();
    let before = c.state().snapshot().unwrap();
    fs::remove_dir(t.0.join("sessions/session-1/events")).unwrap();
    assert!(c.apply(Input::Connect).is_err());
    assert_eq!(c.state().snapshot().unwrap(), before);
    assert!(c.apply(Input::Connect).is_err());
}
#[test]
fn witnesses_confined_hashed_and_symlinks_refused() {
    let t = Temp::new();
    let mut c = Authority::create(&t.0, CoreState::new("session-1", 10).unwrap()).unwrap();
    let w = c.retain_witness(b"synthetic-state").unwrap();
    c.apply_with_witnesses(Input::Connect, vec![w.clone()])
        .unwrap();
    drop(c);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();
    assert!(scan(&path, root).is_ok());
    let artifact = root.join("artifacts").join(&w.sha256);
    fs::write(&artifact, b"corrupted-state").unwrap();
    assert_eq!(scan(&path, root).unwrap_err(), JournalError::Witness);
    fs::remove_file(&artifact).unwrap();
    std::os::unix::fs::symlink(t.0.join("outside"), &artifact).unwrap();
    fs::write(t.0.join("outside"), b"synthetic-state").unwrap();
    assert_eq!(scan(&path, root).unwrap_err(), JournalError::Witness);
}

fn admission_fixture(n: u64, hash: &str) -> AdmissionRequest {
    let raw = json!({"schema":"envelope/v0.2","msg_id":format!("input-{n}"),"ts_ns":0,"from":{"component":"agent","instance":"agent-1"},"to":{"component":"core","instance":"core-1"},"session_id":"session-1","seq":n,"nonce":format!("nonce-{n}"),"body":{"schema":"action_proposal/v0.2","proposal_id":format!("proposal-{n}"),"surface_id":"surface-1","based_on_frame":{"sha256":hash,"generation":1},"action":{"type":"click","x":1,"y":2,"button":"left"},"expectation":{"type":"text_present","text":"ready"},"budget":{"max_ms":10,"max_retries":0}}});
    AdmissionRequest::decode(
        &format!("  {raw}  "),
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
fn setup_admission(t: &Temp) -> (Authority, Witness) {
    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    let witness = c.retain_witness(b"synthetic-frame").unwrap();
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
fn admission_refusal_dispatch_rebuild_every_boundary_and_restart_dedup() {
    let t = Temp::new();
    let (mut c, w) = setup_admission(&t);
    let p = admission_fixture(1, &w.sha256);
    let mut golden = scan(
        &t.0.join("sessions/session-1/journal.jsonl"),
        &t.0.join("sessions/session-1"),
    )
    .unwrap()
    .boundaries;
    let inputs = vec![
        Input::Propose(p.clone()),
        Input::Propose(p.clone()),
        Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 1,
        },
        Input::Receipt {
            proposal_id: "proposal-1".into(),
            epoch: 1,
        },
        Input::TakeControl {
            surface_id: "surface-1".into(),
        },
        Input::ReleaseControl {
            surface_id: "surface-1".into(),
        },
    ];
    let mut outcomes = Vec::new();
    for input in inputs {
        outcomes.push(c.apply_with_witnesses(input, vec![w.clone()]).unwrap());
        golden.push(c.state().snapshot().unwrap());
    }
    assert_eq!(outcomes[0].reason, None);
    assert_eq!(outcomes[1].reason, Some(metaviewer_core::Refusal::Policy));
    assert!(outcomes[2].dispatch);
    let final_state = c.state().snapshot().unwrap();
    drop(c);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();
    let replay = scan(&path, root).unwrap();
    assert_eq!(replay.boundaries, golden);
    assert_eq!(replay.state.snapshot().unwrap(), final_state);
    let mut recovered = Authority::recover(&path, root).unwrap();
    assert_eq!(
        recovered.apply(Input::Propose(p)).unwrap().reason,
        Some(metaviewer_core::Refusal::Policy)
    );
    let event: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("events/3.json")).unwrap()).unwrap();
    assert!(event["input"]["raw"].as_str().unwrap().starts_with("  "));
}
#[test]
fn simultaneous_admissions_commit_exactly_one_reservation() {
    let t = Temp::new();
    let (c, w) = setup_admission(&t);
    let c = std::sync::Arc::new(std::sync::Mutex::new(c));
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = (1..=2)
        .map(|n| {
            let c = c.clone();
            let w = w.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                c.lock()
                    .unwrap()
                    .apply_with_witnesses(Input::Propose(admission_fixture(n, &w.sha256)), vec![w])
                    .unwrap()
            })
        })
        .collect();
    let outcomes: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|o| o.reason.is_none()).count(), 1);
    let guard = c.lock().unwrap();
    assert_eq!(guard.state().pending.len(), 1);
    assert_eq!(guard.state().remaining_budget, 9999);
    assert_eq!(guard.state().core_seq, 4);
}
#[test]
fn missing_required_frame_witness_never_commits() {
    let t = Temp::new();
    let (mut c, w) = setup_admission(&t);
    let before = c.state().snapshot().unwrap();
    assert_eq!(
        c.apply(Input::Propose(admission_fixture(1, &w.sha256))),
        Err(JournalError::Witness)
    );
    assert_eq!(c.state().snapshot().unwrap(), before);
    assert!(c
        .apply_with_witnesses(Input::Propose(admission_fixture(1, &w.sha256)), vec![w])
        .is_ok());
}
#[test]
fn cli_error_codes_and_verify_only_output() {
    let t = Temp::new();
    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    drop(c);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();
    let run = |extra: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
            .args([
                "--journal",
                path.to_str().unwrap(),
                "--witness-root",
                root.to_str().unwrap(),
            ])
            .args(extra)
            .output()
            .unwrap()
    };
    let ok = run(&["--verify-only"]);
    assert!(ok.status.success());
    assert!(ok.stdout.is_empty());
    let invalid = run(&["--bogus"]);
    assert_eq!(invalid.status.code(), Some(2));
    assert!(invalid.stdout.is_empty());
    let original = fs::read_to_string(&path).unwrap();
    let last = original.lines().last().unwrap();
    fs::write(&path, format!("{original}{last}\n")).unwrap();
    let duplicate = run(&[]);
    assert_eq!(duplicate.status.code(), Some(3));
    assert!(duplicate.stdout.is_empty());
}

#[test]
fn wire_verdict_is_closed_and_refusal_is_durable() {
    let t = Temp::new();
    let (mut c, w) = setup_admission(&t);
    let request = admission_fixture(1, &w.sha256);
    let admitted = serde_json::to_value(c.admit(request.clone(), vec![w]).unwrap()).unwrap();
    assert_eq!(
        admitted,
        json!({"schema":"action_verdict/v0.2","proposal_id":"proposal-1","decision":"admitted","core_seq":3})
    );
    let refused = serde_json::to_value(c.admit(request, vec![]).unwrap()).unwrap();
    assert_eq!(
        refused,
        json!({"schema":"action_verdict/v0.2","proposal_id":"proposal-1","decision":"refused","reason_code":"POLICY","core_seq":4})
    );
    drop(c);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    assert_eq!(
        scan(&path, path.parent().unwrap())
            .unwrap()
            .boundaries
            .len(),
        4
    );
}
#[test]
fn truncated_and_oversized_journals_refuse() {
    let t = Temp::new();
    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    drop(c);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();
    let mut bytes = fs::read(&path).unwrap();
    bytes.pop();
    fs::write(&path, &bytes).unwrap();
    assert!(scan(&path, root).is_err());
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert!(scan(&path, root).is_err());
}

#[test]
fn uncommitted_artifact_and_missing_committed_event_stop_recovery() {
    let t = Temp::new();
    let mut c = Authority::create(&t.0, CoreState::session("session-1").unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    drop(c);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();
    fs::write(root.join("events/2.json"), b"uncommitted").unwrap();
    assert!(matches!(
        Authority::recover(&path, root),
        Err(JournalError::Unsealed)
    ));
    fs::remove_file(root.join("events/2.json")).unwrap();
    fs::remove_file(root.join("events/1.json")).unwrap();
    assert!(scan(&path, root).is_err());
}
#[test]
fn witness_corruption_uses_cli_witness_exit() {
    let t = Temp::new();
    let (mut c, w) = setup_admission(&t);
    c.apply_with_witnesses(
        Input::Propose(admission_fixture(1, &w.sha256)),
        vec![w.clone()],
    )
    .unwrap();
    drop(c);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();
    fs::write(root.join("artifacts").join(w.sha256), b"mutated").unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .args([
            "--journal",
            path.to_str().unwrap(),
            "--witness-root",
            root.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4));
    assert!(out.stdout.is_empty());
}

#[test]
fn pending_checkpoint_recovers_only_a_proven_chain() {
    for pending_is_current in [false, true] {
        let t = Temp::new();
        let mut c = Authority::create(&t.0, CoreState::new("session-1", 10).unwrap()).unwrap();
        let root = t.0.join("sessions/session-1");
        let old = fs::read(root.join("checkpoint.json")).unwrap();
        c.apply(Input::Connect).unwrap();
        drop(c);
        if pending_is_current {
            // Crash after fsync(next), before rename(next, current).
            fs::rename(root.join("checkpoint.json"), root.join("checkpoint.next")).unwrap();
            fs::write(root.join("checkpoint.json"), &old).unwrap();
        } else {
            fs::write(root.join("checkpoint.next"), &old).unwrap();
        }
        let path = root.join("journal.jsonl");
        let mut recovered = Authority::recover(&path, &root).unwrap_or_else(|error| {
            panic!(
                "pending_is_current={pending_is_current}, root={root:?}: recover failed: {error:?}"
            )
        });
        assert_eq!(recovered.state().core_seq, 1);
        recovered.apply(Input::Connect).unwrap();
        drop(recovered);
        assert!(!root.join("checkpoint.next").exists());
        assert_eq!(scan(&path, &root).unwrap().state.core_seq, 2);
        // Neither a corrupt current nor an unrelated next may certify a chain.
        fs::write(root.join("checkpoint.json"), &old).unwrap();
        fs::write(root.join("checkpoint.next"), b"{}").unwrap();
        assert!(Authority::recover(&path, &root).is_err());
    }
}
#[test]
fn journal_directories_require_private_mode_and_owner() {
    let t = Temp::new();
    fs::set_permissions(&t.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Authority::create(&t.0, CoreState::new("session-1", 10).unwrap()).is_err());
    fs::set_permissions(&t.0, fs::Permissions::from_mode(0o700)).unwrap();
    let c = Authority::create(&t.0, CoreState::new("session-1", 10).unwrap()).unwrap();
    drop(c);
    let root = t.0.join("sessions/session-1");
    for dir in [
        t.0.clone(),
        t.0.join("sessions"),
        root.clone(),
        root.join("events"),
        root.join("artifacts"),
    ] {
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Authority::recover(&root.join("journal.jsonl"), &root).is_err());
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert!(Authority::recover(&root.join("journal.jsonl"), &root).is_ok());
}
