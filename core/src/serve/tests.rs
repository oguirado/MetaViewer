use super::*;
use serde_json::json;

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
}

#[test]
fn saturation_has_a_reserved_typed_signal_and_disconnect_is_distinct() {
    let root = std::env::temp_dir().join(format!("mv-queue-test-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let config = Config {
        session_id: "queue-session".into(),
        core: registration("core"),
        peers: vec![
            registration("agent"),
            registration("daemon"),
            registration("ui"),
        ],
    };
    let mut server = Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
    let peer = registration("ui").endpoint;
    let (tx, rx) = mpsc::sync_channel(1);
    let terminal = Arc::new(Mutex::new(None));
    server.connections.insert(
        peer.clone(),
        Connection {
            id: 1,
            epoch: 0,
            queue: tx,
            terminal: terminal.clone(),
        },
    );
    let body = Command::Hello(Box::new(config.core.hello));
    server.send(&peer, body.clone()).unwrap();
    assert!(terminal.lock().unwrap().is_none());
    let error = server.send(&peer, body.clone()).unwrap_err();
    assert!(
        matches!(error.downcast_ref::<SendFailure>(), Some(SendFailure::QueueOverflow(p)) if p == &peer)
    );
    let notification = terminal.lock().unwrap().take().unwrap();
    let raw = serde_json::to_string(&notification).unwrap();
    decode_envelope(&raw).unwrap();
    let value = serde_json::to_value(&notification.body).unwrap();
    assert_eq!(value["event"], "error");
    assert_eq!(value["data"]["code"], "QUEUE_OVERFLOW");
    // The queued normal message was not silently replaced by the diagnostic.
    assert!(matches!(rx.try_recv().unwrap().body, Command::Hello(_)));
    drop(rx);
    let error = server.send(&peer, body).unwrap_err();
    assert!(
        matches!(error.downcast_ref::<SendFailure>(), Some(SendFailure::Disconnected(p)) if p == &peer)
    );
    assert!(terminal.lock().unwrap().is_none());
    drop(server);
    fs::remove_dir_all(root).unwrap();
}
