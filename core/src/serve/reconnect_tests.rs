use super::*;
use serde_json::json;
mod support {
    pub fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }
    pub fn uid() -> u32 {
        super::effective_uid().unwrap()
    }
    pub struct Temp(pub std::path::PathBuf);
    impl Temp {
        pub fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "mv-reconnect-overflow-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
}
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

async fn attach(
    server: Arc<Mutex<Server>>,
    nonce: &str,
    component: &str,
) -> (UnixStream, tokio::task::JoinHandle<Result<()>>) {
    let (mut client, socket) = UnixStream::pair().unwrap();
    let task = tokio::spawn(connection(
        socket,
        tokio::time::Instant::now(),
        server,
        support::uid(),
    ));
    let env = decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":nonce,"ts_ns":0,"from":registration(component).endpoint,"to":registration("core").endpoint,"session_id":"reconnect","seq":1,"nonce":nonce,"body":registration(component).hello}).to_string()).unwrap();
    write_frame(&mut client, &env).await.unwrap();
    (client, task)
}
#[test]
fn queue_overflow_reconnects_with_restarted_sequence() {
    support::run(async {
        let temp = support::Temp::new();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &temp.0.join("state"), support::uid()).unwrap(),
        ));
        let (mut first, task) = attach(server.clone(), "overflow-first", "ui").await;
        assert!(matches!(
            read_frame(&mut first).await.unwrap().unwrap().body,
            Command::Hello(_)
        ));
        {
            // No await while filling: the actual writer cannot race the saturation fixture.
            let mut s = server.lock().unwrap();
            let body = Command::Hello(Box::new(registration("core").hello));
            for _ in 0..MAX_SEND_QUEUE {
                s.send(&registration("ui").endpoint, body.clone()).unwrap();
            }
            let error = s.send(&registration("ui").endpoint, body).unwrap_err();
            assert!(matches!(
                error.downcast_ref::<SendFailure>(),
                Some(SendFailure::QueueOverflow(_))
            ));
        }
        let terminal = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut first))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(terminal.body).unwrap()["data"]["code"],
            "QUEUE_OVERFLOW"
        );
        let _ = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        let (mut second, task) = attach(server.clone(), "overflow-second", "ui").await;
        let reply = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut second))
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            reply.expect("overflow endpoint must reconnect").body,
            Command::Hello(_)
        ));
        drop(second);
        task.await.unwrap().unwrap();
    });
}

#[test]
fn daemon_reconnect_journal_retains_both_generations_nonce_evidence() {
    support::run(async {
        let temp = support::Temp::new();
        let state = temp.0.join("state");
        let server = Arc::new(Mutex::new(
            Server::open(config(), &state, support::uid()).unwrap(),
        ));
        for nonce in ["daemon-first", "daemon-second"] {
            let (mut socket, task) = attach(server.clone(), nonce, "daemon").await;
            assert!(matches!(
                read_frame(&mut socket).await.unwrap().unwrap().body,
                Command::Hello(_)
            ));
            drop(socket);
            task.await.unwrap().unwrap();
        }
        drop(server);
        let recovered = Server::open(config(), &state, support::uid()).unwrap();
        for nonce in ["daemon-first", "daemon-second"] {
            assert!(recovered.replay.contains(
                "reconnect",
                &registration("daemon").endpoint,
                nonce
            ));
        }
    });
}
