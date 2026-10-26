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
            "mv-journal-tamper-{}-{}",
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

fn build_valid_journal(t: &Temp) -> (PathBuf, PathBuf, Witness) {
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
    let p = admission_fixture(1, &witness.sha256);
    c.apply_with_witnesses(Input::Propose(p), vec![witness.clone()])
        .unwrap();
    drop(c);
    let path = t.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap().to_path_buf();
    (path, root, witness)
}

fn run_cli(journal: &PathBuf, root: &PathBuf) -> (i32, String) {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .args([
            "--journal",
            journal.to_str().unwrap(),
            "--witness-root",
            root.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8(output.stdout).unwrap(),
    )
}

#[test]
fn tamper_matrix_byte_flips_and_exit_codes() {
    // Test 1: Flip bit/byte per record field in journal lines
    let t = Temp::new();
    let (journal, root, _w) = build_valid_journal(&t);
    let content = fs::read_to_string(&journal).unwrap();
    let mut lines: Vec<String> = content.lines().map(str::to_owned).collect();

    // Flip field in line 1 (event-1)
    let original_line = lines[1].clone();
    lines[1] = lines[1].replace("\"event-1\"", "\"event-999\"");
    fs::write(&journal, lines.join("\n") + "\n").unwrap();

    assert_eq!(scan(&journal, &root).unwrap_err(), JournalError::Corrupt);
    assert_eq!(
        Authority::recover(&journal, &root).err(),
        Some(JournalError::Corrupt)
    );
    let (code, _) = run_cli(&journal, &root);
    assert_eq!(code, 2);

    // Restore line 1 and tamper prev_sha256
    lines[1] = original_line;
    lines[2] = lines[2].replace(
        "\"prev_sha256\":\"",
        "\"prev_sha256\":\"0000000000000000000000000000000000000000000000000000000000000000",
    );
    fs::write(&journal, lines.join("\n") + "\n").unwrap();
    assert_eq!(scan(&journal, &root).unwrap_err(), JournalError::Corrupt);
    let (code, _) = run_cli(&journal, &root);
    assert_eq!(code, 2);
}

#[test]
fn tamper_matrix_middle_sidecar_deletion() {
    let t = Temp::new();
    let (journal, root, _w) = build_valid_journal(&t);

    // Delete middle event sidecar (2.json)
    let sidecar = root.join("events/2.json");
    fs::remove_file(&sidecar).unwrap();

    assert_eq!(scan(&journal, &root).unwrap_err(), JournalError::Io);
    let (code, _) = run_cli(&journal, &root);
    assert_eq!(code, 2);
}

#[test]
fn tamper_matrix_tail_truncation() {
    let t = Temp::new();
    let (journal, root, _w) = build_valid_journal(&t);

    // Truncate tail line
    let content = fs::read_to_string(&journal).unwrap();
    let mut lines: Vec<&str> = content.lines().collect();
    lines.pop(); // remove last line
    fs::write(&journal, lines.join("\n") + "\n").unwrap();

    // Scan fails because checkpoint mismatch or record count mismatch
    assert_eq!(scan(&journal, &root).unwrap_err(), JournalError::Corrupt);
    let (code, _) = run_cli(&journal, &root);
    assert_eq!(code, 2);
}

#[test]
fn tamper_matrix_checkpoint_fields() {
    let t = Temp::new();
    let (journal, root, _w) = build_valid_journal(&t);
    let ckpt_path = root.join("checkpoint.json");

    for field in ["count", "tail", "archive", "genesis"] {
        let ckpt_val: serde_json::Value =
            serde_json::from_slice(&fs::read(&ckpt_path).unwrap()).unwrap();
        let mut mutated = ckpt_val.clone();

        if field == "count" {
            mutated["count"] = json!(999u64);
        } else {
            mutated[field] =
                json!("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        }

        // Write canonical JSON back to checkpoint.json
        let canonical = canonical_bytes(&mutated).unwrap();
        fs::write(&ckpt_path, &canonical).unwrap();

        assert_eq!(scan(&journal, &root).unwrap_err(), JournalError::Corrupt);
        let (code, _) = run_cli(&journal, &root);
        assert_eq!(code, 2);
    }
}

#[test]
fn corollary_2_reforgery_and_anchor_demonstration() {
    // SW-0222 Corollary 2: Without an external anchor (or when checkpoint is rewritten in place),
    // an adversary who alters slot 3 onwards and recomputes hashes through slot N and updates checkpoint
    // will produce a journal that passes scan against that rewritten checkpoint!

    // Instead of constructing event 3 manually, let's create a second journal using Authority,
    // and replace event 3 / journal line 3 / checkpoint of journal 1 with that of journal 2!

    let t1 = Temp::new();
    let (journal1, root1, w1) = build_valid_journal(&t1);

    let ckpt_path1 = root1.join("checkpoint.json");
    let trusted_anchor_bytes = fs::read(&ckpt_path1).unwrap();
    let trusted_checkpoint: serde_json::Value =
        serde_json::from_slice(&trusted_anchor_bytes).unwrap();

    let t2 = Temp::new();
    let mut c2 = Authority::create(&t2.0, CoreState::session("session-1").unwrap()).unwrap();
    c2.apply(Input::Connect).unwrap();
    let witness2 = c2.retain_witness(b"synthetic-frame").unwrap();
    let surface2 = Surface {
        display: "display-1".into(),
        owner: metaviewer_core::Endpoint {
            component: metaviewer_core::Component::Agent,
            instance: "agent-1".into(),
        },
        agent_controlled: true,
        live: true,
        frame: Some(Frame {
            sha256: witness2.sha256.clone(),
            generation: 1,
            width: 10,
            height: 10,
        }),
        refresh_after: None,
        allowed_verbs: vec![],
    };
    c2.apply_with_witnesses(
        Input::Surface {
            id: "surface-1".into(),
            surface: surface2,
        },
        vec![witness2.clone()],
    )
    .unwrap();
    // In journal 2, event 3 is Input::Connect instead of Input::Propose
    c2.apply(Input::Connect).unwrap();
    drop(c2);

    let root2 = t2.0.join("sessions/session-1");
    let journal2 = root2.join("journal.jsonl");

    // Copy event 3, line 3, and checkpoint from journal 2 to journal 1
    fs::copy(root2.join("events/3.json"), root1.join("events/3.json")).unwrap();

    let lines1: Vec<String> = fs::read_to_string(&journal1)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    let lines2: Vec<String> = fs::read_to_string(&journal2)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();

    let forged_lines = vec![
        lines1[0].clone(),
        lines1[1].clone(),
        lines1[2].clone(),
        lines2[3].clone(),
    ];
    fs::write(&journal1, forged_lines.join("\n") + "\n").unwrap();

    fs::copy(root2.join("checkpoint.json"), &ckpt_path1).unwrap();

    // Re-forged journal 1 passes scan against the forged checkpoint!
    let scan_res = scan(&journal1, &root1);
    assert!(
        scan_res.is_ok(),
        "Corollary 2 verified: re-forged journal passes scan against forged local checkpoint: {:?}",
        scan_res.err()
    );

    // BUT when verified against the trusted anchor (external anchor):
    let current_ckpt_bytes = fs::read(&ckpt_path1).unwrap();
    let current_ckpt: serde_json::Value = serde_json::from_slice(&current_ckpt_bytes).unwrap();

    assert_ne!(
        current_ckpt, trusted_checkpoint,
        "Corollary 2 demonstration: External anchor detects rewritten/re-forged journal"
    );

    // Ensure witness exit code 4 is tested when witness is corrupted
    fs::write(root1.join("artifacts").join(&w1.sha256), b"corrupted").unwrap();
    let (code, _) = run_cli(&journal1, &root1);
    assert_eq!(code, 4);
}
