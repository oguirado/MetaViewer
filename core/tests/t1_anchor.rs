#![forbid(unsafe_code)]
use metaviewer_core::admission::{CoreState, Input};
use metaviewer_core::journal::{
    anchor::verify_with_anchor, scan, sha256_hex, Journal, JournalError,
};
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    dir: PathBuf,
    root: PathBuf,
    anchor: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "mv-anchor-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let f = Self {
            root: dir.join("sessions/session-1"),
            anchor: dir.join("protected-head.json"),
            dir,
        };
        f.history(10);
        fs::copy(f.root.join("checkpoint.json"), &f.anchor).unwrap();
        f
    }
    fn history(&self, budget: u64) {
        let mut state = CoreState::new("session-1", budget).unwrap();
        let mut j = Journal::create(&self.dir, &state).unwrap();
        let out = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out, &state, vec![]).unwrap();
    }
    fn cli(&self) -> std::process::Output {
        std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
            .arg("--journal")
            .arg(self.root.join("journal.jsonl"))
            .arg("--witness-root")
            .arg(&self.root)
            .arg("--anchor")
            .arg(&self.anchor)
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.dir).unwrap();
    }
}
#[test]
fn protected_anchor_accepts_genuine_and_rejects_complete_reforgery() {
    let f = Fixture::new();
    let replay = verify_with_anchor(&f.root, &f.anchor).unwrap();
    let expected_digest = sha256_hex(&replay.state.snapshot().unwrap());
    let genuine = f.cli();
    assert_eq!(genuine.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(genuine.stdout).unwrap().trim(),
        expected_digest
    );
    let verify_only = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .arg("--journal")
        .arg(f.root.join("journal.jsonl"))
        .arg("--witness-root")
        .arg(&f.root)
        .arg("--anchor")
        .arg(&f.anchor)
        .arg("--verify-only")
        .output()
        .unwrap();
    assert!(verify_only.status.success());
    assert!(verify_only.stdout.is_empty());
    fs::remove_dir_all(&f.root).unwrap();
    f.history(11);
    // Negative control: a consistent replacement is valid under local checking.
    assert!(scan(&f.root.join("journal.jsonl"), &f.root).is_ok());
    assert!(matches!(
        verify_with_anchor(&f.root, &f.anchor),
        Err(JournalError::Corrupt)
    ));
    let forged = f.cli();
    assert_eq!(forged.status.code(), Some(2));
    assert!(forged.stdout.is_empty());
    assert!(String::from_utf8_lossy(&forged.stderr).contains("Corrupt"));
}
#[test]
fn tampered_missing_and_internal_anchors_fail_closed() {
    let f = Fixture::new();
    let original = fs::read(&f.anchor).unwrap();
    for field in ["schema", "count", "tail", "archive", "genesis"] {
        let mut v: serde_json::Value = serde_json::from_slice(&original).unwrap();
        if field == "count" {
            v[field] = serde_json::json!(2);
        } else {
            v[field] = serde_json::json!("tampered");
        }
        fs::write(
            &f.anchor,
            metaviewer_core::journal::canonical_bytes(&v).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            verify_with_anchor(&f.root, &f.anchor),
            Err(JournalError::Corrupt)
        ));
        let out = f.cli();
        assert_eq!(out.status.code(), Some(2));
        assert!(out.stdout.is_empty());
    }
    fs::remove_file(&f.anchor).unwrap();
    assert!(matches!(
        verify_with_anchor(&f.root, &f.anchor),
        Err(JournalError::Corrupt)
    ));
    assert_eq!(f.cli().status.code(), Some(2));
    let mut f = f;
    f.anchor = f.root.join("checkpoint.json");
    assert_eq!(f.cli().status.code(), Some(2));
}

#[test]
fn symlink_and_noncanonical_anchors_are_refused() {
    let f = Fixture::new();
    let saved = f.dir.join("saved-head.json");
    fs::rename(&f.anchor, &saved).unwrap();
    std::os::unix::fs::symlink(&saved, &f.anchor).unwrap();
    assert!(matches!(
        verify_with_anchor(&f.root, &f.anchor),
        Err(JournalError::Corrupt)
    ));
    fs::remove_file(&f.anchor).unwrap();
    let mut bytes = fs::read(saved).unwrap();
    bytes.push(b'\n');
    fs::write(&f.anchor, bytes).unwrap();
    assert!(matches!(
        verify_with_anchor(&f.root, &f.anchor),
        Err(JournalError::Corrupt)
    ));
}
