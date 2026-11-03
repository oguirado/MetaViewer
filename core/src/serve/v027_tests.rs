use super::*;
use serde_json::json;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "mv-v027-wire-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn run(future: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future);
}
fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-v027")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
}
fn config() -> Config {
    Config {
        session_id: "v027".into(),
        core: registration("core"),
        peers: vec![
            registration("daemon"),
            registration("agent"),
            registration("ui"),
        ],
    }
}
fn envelope(component: &str, seq: u64, nonce: &str, body: serde_json::Value) -> Envelope {
    decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":nonce,"ts_ns":0,"from":registration(component).endpoint,"to":registration("core").endpoint,"session_id":"v027","seq":seq,"nonce":nonce,"body":body}).to_string()).unwrap()
}
async fn attach(
    server: Arc<Mutex<Server>>,
    component: &str,
    nonce: &str,
    probe: Duration,
) -> (UnixStream, tokio::task::JoinHandle<Result<()>>) {
    let (mut client, socket) = UnixStream::pair().unwrap();
    let task = tokio::spawn(connection_with_liveness(
        socket,
        tokio::time::Instant::now(),
        server,
        effective_uid().unwrap(),
        crate::wire::WireLimits::default(),
        probe,
    ));
    write_frame(
        &mut client,
        &envelope(
            component,
            1,
            nonce,
            serde_json::to_value(registration(component).hello).unwrap(),
        ),
    )
    .await
    .unwrap();
    (client, task)
}
async fn receive(client: &mut UnixStream) -> Envelope {
    tokio::time::timeout(Duration::from_secs(3), read_frame(client))
        .await
        .unwrap()
        .unwrap()
        .expect("typed terminal required before EOF")
}
#[test]
fn v027_cr01_replay_exhaustion_reports_terminal_and_reconnect_refusal() {
    run(async {
        let f = Fixture::new();
        let mut s = Server::open(config(), &f.0.join("state"), effective_uid().unwrap()).unwrap();
        s.replay = ReplayTable::new(1).unwrap();
        let server = Arc::new(Mutex::new(s));
        let (mut client, task) =
            attach(server.clone(), "ui", "first", Duration::from_secs(10)).await;
        assert!(matches!(receive(&mut client).await.body, Command::Hello(_)));
        let before = server.lock().unwrap().authority.state().snapshot().unwrap();
        write_frame(
            &mut client,
            &envelope(
                "ui",
                2,
                "exhausted",
                json!({"schema":"surface_request/v0.2","op":"list","params":{}}),
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(receive(&mut client).await.body).unwrap()["data"]["code"],
            "REPLAY_EXHAUSTED"
        );
        let _ = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            server.lock().unwrap().authority.state().snapshot().unwrap(),
            before
        );
        assert_eq!(server.lock().unwrap().replay.snapshot().entries.len(), 1);
        let (mut client, task) =
            attach(server.clone(), "ui", "fresh", Duration::from_secs(10)).await;
        assert_eq!(
            serde_json::to_value(receive(&mut client).await.body).unwrap()["data"]["code"],
            "REPLAY_EXHAUSTED"
        );
        assert!(task.await.unwrap().is_err());
        // Exhaustion must never clear old nonce evidence or bypass duplicate checks.
        let s = server.lock().unwrap();
        assert!(s
            .replay
            .contains("v027", &registration("ui").endpoint, "first"));
    });
}

#[test]
fn v027_cr02_keepalive_overflow_drains_reserved_terminal() {
    run(async {
        let f = Fixture::new();
        let server = Arc::new(Mutex::new(
            Server::open(config(), &f.0.join("state"), effective_uid().unwrap()).unwrap(),
        ));
        let (mut client, task) = attach(
            server.clone(),
            "daemon",
            "keepalive",
            Duration::from_millis(100),
        )
        .await;
        assert!(matches!(receive(&mut client).await.body, Command::Hello(_)));
        {
            let mut s = server.lock().unwrap();
            // Force a production write to await socket capacity while its reader
            // remains responsive enough to run the next keepalive probe.
            let body = Command::SurfaceEvent(Box::new(serde_json::from_value(json!({"schema":"surface_event/v0.2","event":"error","data":{"surface_id":"daemon","code":"PREFILL","detail":"\u{1}".repeat(65_000)}})).unwrap()));
            s.send(&registration("daemon").endpoint, body).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(3), client.readable())
            .await
            .unwrap()
            .unwrap();
        let terminal = {
            let mut s = server.lock().unwrap();
            let daemon = registration("daemon").endpoint;
            let env = s
                .outbound_at(
                    0,
                    &daemon,
                    Command::Hello(Box::new(registration("core").hello)),
                    "prefill",
                )
                .unwrap();
            let connection = &s.connections[&daemon];
            // Fill only the normal queue, without creating a terminal ourselves.
            // A probe may already be queued under full-suite scheduling load.
            for _ in 0..=MAX_SEND_QUEUE {
                if matches!(
                    connection.queue.try_send(env.clone()),
                    Err(mpsc::TrySendError::Full(_))
                ) {
                    break;
                }
            }
            connection.terminal.clone()
        };
        // Observe the keepalive's reserved terminal before unblocking the writer.
        tokio::time::timeout(Duration::from_secs(3), async {
            while terminal.lock().unwrap().is_none() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        let mut overflow = false;
        for _ in 0..MAX_SEND_QUEUE + 2 {
            let body = serde_json::to_value(receive(&mut client).await.body).unwrap();
            if body["data"]["code"] == "QUEUE_OVERFLOW" {
                overflow = true;
                break;
            }
        }
        assert!(
            overflow,
            "keepalive must deliver its reserved overflow terminal"
        );
        let _ = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
    });
}
