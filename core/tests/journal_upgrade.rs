#![forbid(unsafe_code)]
mod support;

use metaviewer_core::admission::{Authority, CoreState, Input};
use metaviewer_core::journal::{canonical_bytes, scan, Journal, JournalError};
use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn fixture() -> support::Temp {
    let temp = support::Temp::new();
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o700)).unwrap();
    let mut authority =
        Authority::create(&temp.0, CoreState::session("session-1").unwrap()).unwrap();
    authority.apply(Input::Connect).unwrap();
    drop(authority);
    temp
}

fn rewrite_header(root: &Path, change: impl FnOnce(&mut Value)) {
    let path = root.join("journal.jsonl");
    let original = fs::read_to_string(&path).unwrap();
    let (header, records) = original.split_once('\n').unwrap();
    let mut header: Value = serde_json::from_str(header).unwrap();
    change(&mut header);
    let mut bytes = canonical_bytes(&header).unwrap();
    bytes.push(b'\n');
    bytes.extend_from_slice(records.as_bytes());
    fs::write(path, bytes).unwrap();
}

#[test]
fn old_version_requires_upgrade_with_versions_and_recovery_runbook() {
    let temp = fixture();
    let root = temp.0.join("sessions/session-1");
    rewrite_header(&root, |h| h["core_version"] = "0.0.0".into());
    let path = root.join("journal.jsonl");
    let before = fs::read(&path).unwrap();
    let error = scan(&path, &root).unwrap_err();
    assert_eq!(
        error,
        JournalError::UpgradeRequired {
            expected: env!("CARGO_PKG_VERSION").into(),
            found: "0.0.0".into(),
        }
    );
    let message = error.to_string();
    for expected in [
        "UPGRADE-REQUIRED",
        env!("CARGO_PKG_VERSION"),
        "0.0.0",
        "archive",
        "session directory",
        "fresh session",
    ] {
        assert!(
            message.contains(expected),
            "missing {expected:?}: {message}"
        );
    }
    assert!(matches!(
        Journal::recover(&path, &root),
        Err(JournalError::UpgradeRequired { expected, found })
            if expected == env!("CARGO_PKG_VERSION") && found == "0.0.0"
    ));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn tampered_current_version_record_remains_corrupt() {
    let temp = fixture();
    let root = temp.0.join("sessions/session-1");
    let path = root.join("journal.jsonl");
    let original = fs::read_to_string(&path).unwrap();
    let (header, record) = original.trim_end().split_once('\n').unwrap();
    let mut record: Value = serde_json::from_str(record).unwrap();
    record["prev_sha256"] = "f".repeat(64).into();
    let record = String::from_utf8(canonical_bytes(&record).unwrap()).unwrap();
    fs::write(&path, format!("{header}\n{record}\n")).unwrap();
    assert_eq!(scan(&path, &root).unwrap_err(), JournalError::Corrupt);
    assert!(matches!(
        Journal::recover(&path, &root),
        Err(JournalError::Corrupt)
    ));
}

#[test]
fn invalid_schema_is_corrupt_even_with_old_version() {
    let temp = fixture();
    let root = temp.0.join("sessions/session-1");
    rewrite_header(&root, |h| {
        h["core_version"] = "0.0.0".into();
        h["schema"] = "invalid".into();
    });
    assert_eq!(
        scan(&root.join("journal.jsonl"), &root).unwrap_err(),
        JournalError::Corrupt
    );
}

#[test]
fn fresh_session_opens_and_recovers() {
    let temp = fixture();
    let root = temp.0.join("sessions/session-1");
    let path = root.join("journal.jsonl");
    let replay = scan(&path, &root).unwrap();
    let (journal, state) = Journal::recover(&path, &root).unwrap();
    assert_eq!(state.snapshot().unwrap(), replay.state.snapshot().unwrap());
    drop(journal);
}
