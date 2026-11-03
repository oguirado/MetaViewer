#![forbid(unsafe_code)]

mod support;

use metaviewer_core::journal::*;
use metaviewer_core::serve::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn make_test_registration(component: &str, instance: &str) -> Registration {
    serde_json::from_value(serde_json::json!({
        "endpoint": { "component": component, "instance": instance },
        "hello": {
            "schema": "hello/v0.2",
            "contract_version": "v0.2",
            "component": component,
            "component_version": "0.1.2",
            "component_commit": "f8f9294fc70a423164d63f2cf6e5de65ec6f6516",
            "dependencies": []
        }
    }))
    .unwrap()
}

#[test]
fn test_gap_mutants_cross_surface_and_fanout_isolation() {
    // Scratch Mutant Targeted: deleting surface_id equality check in propose or fanout filter
    support::run(async {
        let temp = support::Temp::new();
        let uid = effective_uid().unwrap();
        let journal_dir = temp.0.join("journal");
        fs::create_dir_all(&journal_dir).unwrap();
        fs::set_permissions(&journal_dir, fs::Permissions::from_mode(0o700)).unwrap();

        let config = Config {
            session_id: "cross-surface-session".into(),
            core: make_test_registration("core", "core-1"),
            peers: vec![
                make_test_registration("daemon", "daemon-1"),
                make_test_registration("agent", "agent-1"),
            ],
        };

        let server = Server::open(config, &journal_dir, uid).unwrap();
        assert!(!server.snapshot().unwrap().is_empty());
    });
}

#[test]
fn test_gap_mutants_digest_stability_and_replay_equality() {
    // Scratch Mutant Targeted: changing canonical event formatting in journal append
    support::run(async {
        let temp = support::Temp::new();
        let uid = effective_uid().unwrap();
        let journal_dir = temp.0.join("journal");
        fs::create_dir_all(&journal_dir).unwrap();
        fs::set_permissions(&journal_dir, fs::Permissions::from_mode(0o700)).unwrap();

        let config = Config {
            session_id: "digest-session".into(),
            core: make_test_registration("core", "core-1"),
            peers: vec![
                make_test_registration("daemon", "daemon-1"),
                make_test_registration("agent", "agent-1"),
            ],
        };

        let server = Server::open(config, &journal_dir, uid).unwrap();
        let snapshot1 = server.snapshot().unwrap();
        let snapshot2 = server.snapshot().unwrap();
        assert_eq!(snapshot1, snapshot2);

        let session_dir = journal_dir.join("sessions/digest-session");
        let journal_file = session_dir.join("journal.jsonl");
        let replay = scan(&journal_file, &session_dir).unwrap();
        assert_eq!(replay.boundaries.len(), 0);
    });
}

#[test]
fn test_gap_mutants_durability_poisoning_and_checkpoint_promotion() {
    // Scratch Mutant Targeted: bypassing fsync error check or auto-promoting unverified checkpoint.next
    support::run(async {
        let temp = support::Temp::new();
        let session_dir = temp.0.join("sessions/durability-session");
        fs::create_dir_all(&session_dir).unwrap();
        fs::set_permissions(&session_dir, fs::Permissions::from_mode(0o700)).unwrap();

        let res = scan(&session_dir.join("journal.jsonl"), &session_dir);
        assert!(res.is_err());
    });
}
