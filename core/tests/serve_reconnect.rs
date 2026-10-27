mod support;
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixStream;

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
}
fn config() -> Config {
    Config {
        session_id: "reconnect".into(),
        core: registration("core"),
        peers: vec![
            registration("daemon"),
            registration("agent"),
            registration("ui"),
        ],
    }
}
async fn hello(path: &std::path::Path, nonce: &str) -> UnixStream {
    let mut socket = UnixStream::connect(path).await.unwrap();
    let env = decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":nonce,"ts_ns":0,"from":registration("ui").endpoint,"to":registration("core").endpoint,"session_id":"reconnect","seq":1,"nonce":nonce,"body":registration("ui").hello}).to_string()).unwrap();
    write_frame(&mut socket, &env).await.unwrap();
    socket
}
async fn reply(socket: &mut UnixStream) -> Option<Envelope> {
    tokio::time::timeout(Duration::from_secs(2), read_frame(socket))
        .await
        .unwrap()
        .unwrap()
}
#[test]
fn reconnect_resets_sequence_but_preserves_nonce_and_live_connection_guards() {
    support::run(async {
        let temp = support::Temp::new();
        let path = temp.0.join("runtime/core.sock");
        let uid = support::uid();
        let listener = serve::bind(&path, uid).await.unwrap();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), uid).unwrap(),
        ));
        let task = tokio::spawn(serve::serve(listener, server, uid));
        let mut first = hello(&path, "first").await;
        assert!(matches!(
            reply(&mut first).await.unwrap().body,
            Command::Hello(_)
        ));
        let mut simultaneous = hello(&path, "simultaneous").await;
        assert!(reply(&mut simultaneous).await.is_none());
        drop(first);
        let mut reused = hello(&path, "first").await;
        assert!(
            reply(&mut reused).await.is_none(),
            "nonce survives teardown"
        );
        let mut second = hello(&path, "second").await;
        assert!(matches!(
            reply(&mut second)
                .await
                .expect("fresh nonce with restarted sequence must reconnect")
                .body,
            Command::Hello(_)
        ));
        task.abort();
        let _ = task.await;
    });
}

#[test]
fn reconnect_record_is_atomic_and_keeps_sequence_checks_within_connection() {
    let peer = registration("ui").endpoint;
    let mut replay = ReplayTable::new(3).unwrap();
    replay.record("reconnect", &peer, "old", 10).unwrap();
    let before = replay.snapshot();
    assert_eq!(
        replay.record_reconnect("reconnect", &peer, "old", 1),
        Err(ReplayError::DuplicateNonce)
    );
    assert_eq!(replay.snapshot(), before);
    replay
        .record_reconnect("reconnect", &peer, "new", 1)
        .unwrap();
    assert_eq!(
        replay.record("reconnect", &peer, "next", 1),
        Err(ReplayError::NonIncreasingSequence)
    );
    assert_eq!(
        replay.record("reconnect", &peer, "old", 2),
        Err(ReplayError::DuplicateNonce)
    );
    replay.record("reconnect", &peer, "next", 2).unwrap();
    let before = replay.snapshot();
    assert_eq!(
        replay.record_reconnect("reconnect", &peer, "full", 1),
        Err(ReplayError::CapacityExceeded)
    );
    assert_eq!(replay.snapshot(), before);
}
