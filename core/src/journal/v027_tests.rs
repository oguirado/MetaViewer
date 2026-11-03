use super::*;

#[test]
fn v027_cj02_failed_create_can_retry_without_deleting_existing_session() {
    let base = std::env::temp_dir().join(format!("mv-v027-create-{}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
    let root = base.join("sessions/session-1");
    let state = CoreState::session("session-1").unwrap();
    fail_next_checkpoint_before_rename(&root);
    assert!(matches!(
        Journal::create(&base, &state),
        Err(JournalError::Io)
    ));
    clear_root_hooks(&root);
    let mut journal = Journal::create(&base, &state)
        .expect("failed initialization must allow same-session retry");
    let before = fs::read(root.join("genesis.json")).unwrap();
    assert!(Journal::create(&base, &state).is_err());
    assert_eq!(fs::read(root.join("genesis.json")).unwrap(), before);
    journal.close().unwrap();
    drop(journal);
    let (journal, recovered) = Journal::recover(&root.join("journal.jsonl"), &root).unwrap();
    assert_eq!(recovered, state);
    drop(journal);
    fs::remove_dir_all(base).unwrap();
}
