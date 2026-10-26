#![forbid(unsafe_code)]
use metaviewer_core::admission::{CoreState, Input};
use metaviewer_core::journal::{scan, Journal, JournalError};
use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    dir: PathBuf,
    root: PathBuf,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "mv-t1-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let root = dir.join("sessions/session-1");
        Self {
            path: root.join("journal.jsonl"),
            root,
            dir,
        }
    }
    fn populated(&self) {
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&self.dir, &state).unwrap();
        let out = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out, &state, vec![]).unwrap();
    }
    fn checkpoint(&self) -> (Vec<u8>, u64) {
        let p = self.root.join("checkpoint.json");
        (fs::read(&p).unwrap(), fs::metadata(p).unwrap().ino())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.dir).unwrap();
    }
}
#[test]
fn orphan_is_unsealed_in_scan_recover_and_cli() {
    let f = Fixture::new();
    f.populated();
    assert!(scan(&f.path, &f.root).is_ok());
    fs::write(f.root.join("events/2.json"), b"orphan").unwrap();
    assert!(matches!(
        scan(&f.path, &f.root),
        Err(JournalError::Unsealed)
    ));
    assert!(matches!(
        Journal::recover(&f.path, &f.root),
        Err(JournalError::Unsealed)
    ));
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .arg("--journal")
        .arg(&f.path)
        .arg("--witness-root")
        .arg(&f.root)
        .arg("--verify-only")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
}
#[test]
fn invalid_transition_is_refused_before_write_without_poison() {
    let f = Fixture::new();
    let mut state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    let before = (fs::read(&f.path).unwrap(), f.checkpoint());
    let good = state.apply(&Input::Connect).unwrap();
    let mut bad = good.clone();
    bad.dispatch = !bad.dispatch;
    assert_eq!(
        j.append(&Input::Connect, &bad, &state, vec![]),
        Err(JournalError::Invalid)
    );
    assert_eq!((fs::read(&f.path).unwrap(), f.checkpoint()), before);
    assert!(!f.root.join("events/1.json").exists());
    let mut bad_state = state.clone();
    bad_state.remaining_budget -= 1;
    assert_eq!(
        j.append(&Input::Connect, &good, &bad_state, vec![]),
        Err(JournalError::Invalid)
    );
    assert_eq!((fs::read(&f.path).unwrap(), f.checkpoint()), before);
    j.append(&Input::Connect, &good, &state, vec![]).unwrap();
    assert_eq!(scan(&f.path, &f.root).unwrap().state, state);
}
#[test]
fn clean_double_recover_preserves_checkpoint_identity() {
    let f = Fixture::new();
    f.populated();
    let before = f.checkpoint();
    let mut snapshots = Vec::new();
    for _ in 0..2 {
        let (j, s) = Journal::recover(&f.path, &f.root).unwrap();
        snapshots.push(s.snapshot().unwrap());
        drop(j);
        assert_eq!(f.checkpoint(), before);
    }
    assert_eq!(snapshots[0], snapshots[1]);
}
#[test]
fn refused_recover_preserves_checkpoint_identity() {
    let f = Fixture::new();
    f.populated();
    let before = f.checkpoint();
    fs::write(f.root.join("events/2.json"), b"orphan").unwrap();
    assert!(matches!(
        Journal::recover(&f.path, &f.root),
        Err(JournalError::Unsealed)
    ));
    assert_eq!(f.checkpoint(), before);
}
#[test]
fn stale_next_cleanup_preserves_current_and_promotion_requires_proof() {
    let f = Fixture::new();
    f.populated();
    let before = f.checkpoint();
    fs::write(f.root.join("checkpoint.next"), b"stale").unwrap();
    drop(Journal::recover(&f.path, &f.root).unwrap());
    assert!(!f.root.join("checkpoint.next").exists());
    assert_eq!(f.checkpoint(), before);
    fs::rename(
        f.root.join("checkpoint.json"),
        f.root.join("checkpoint.next"),
    )
    .unwrap();
    drop(Journal::recover(&f.path, &f.root).unwrap());
    assert!(scan(&f.path, &f.root).is_ok());
    fs::remove_file(f.root.join("checkpoint.json")).unwrap();
    fs::write(f.root.join("checkpoint.next"), b"{}").unwrap();
    assert!(Journal::recover(&f.path, &f.root).is_err());
    assert!(!f.root.join("checkpoint.json").exists());
}
