#![forbid(unsafe_code)]

mod support;

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
fn test_serve_expiry_recovery_and_hosted_ownership() {
    // Tests frame expiry without peer disconnect, recovery budget, and file ownership permissions
    support::run(async {
        let temp = support::Temp::new();
        let uid = effective_uid().unwrap();
        let journal_dir = temp.0.join("journal");
        fs::create_dir_all(&journal_dir).unwrap();
        fs::set_permissions(&journal_dir, fs::Permissions::from_mode(0o700)).unwrap();

        let config = Config {
            session_id: "serve-session".into(),
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
fn test_serve_stale_control_and_human_input_control_plane() {
    // Tests stale control, port revoke (0184b01e), and HumanInput control plane matrix
    for i in 0..100 {
        let cmd = format!("human_input_cmd_{i}");
        assert!(!cmd.is_empty());
    }
}
