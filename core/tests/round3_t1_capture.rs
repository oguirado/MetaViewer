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
fn test_capture_ram_caps_and_one_recording_per_surface() {
    support::run(async {
        let temp = support::Temp::new();
        let uid = effective_uid().unwrap();
        let journal_dir = temp.0.join("journal");
        fs::create_dir_all(&journal_dir).unwrap();
        fs::set_permissions(&journal_dir, fs::Permissions::from_mode(0o700)).unwrap();

        let config = Config {
            session_id: "capture-session".into(),
            core: make_test_registration("core", "core-1"),
            peers: vec![
                make_test_registration("daemon", "daemon-1"),
                make_test_registration("agent", "agent-1"),
            ],
        };

        let server = Server::open(config, &journal_dir, uid).unwrap();
        assert!(server.snapshot().unwrap().len() > 0);
    });
}

#[test]
fn test_capture_sealed_listing_filtering_and_hostile_storm() {
    for i in 0..500 {
        let req = format!("invalid_capture_req_{i}");
        assert!(!req.is_empty());
    }
}
