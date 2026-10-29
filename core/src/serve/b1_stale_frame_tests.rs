mod support {
    use std::future::Future;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    pub fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    pub struct Temp(pub PathBuf);
    impl Temp {
        pub fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "metaviewer-b1-stale-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
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
    pub fn uid() -> u32 {
        tokio::net::UnixStream::pair()
            .unwrap()
            .0
            .peer_cred()
            .unwrap()
            .uid()
    }
}
use crate::journal::sha256_hex;
use crate::serve::{self, Config, Registration, Server};
use crate::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixStream;

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
}
fn config() -> Config {
    Config {
        session_id: "serve-session".into(),
        core: registration("core"),
        peers: vec![
            registration("daemon"),
            registration("agent"),
            registration("ui"),
        ],
    }
}
struct Peer {
    socket: UnixStream,
    config: Config,
    registration: Registration,
    seq: u64,
    nonce_prefix: String,
}
impl Peer {
    async fn connect(path: &std::path::Path, component: &str) -> Self {
        Self::connect_with_prefix(path, component, None).await
    }
    async fn connect_with_prefix(
        path: &std::path::Path,
        component: &str,
        prefix: Option<String>,
    ) -> Self {
        let reg = registration(component);
        let nonce_prefix = prefix.unwrap_or_else(|| reg.endpoint.instance.clone());
        let mut p = Self {
            socket: UnixStream::connect(path).await.unwrap(),
            config: config(),
            registration: reg,
            seq: 0,
            nonce_prefix,
        };
        p.send(serde_json::to_value(&p.registration.hello).unwrap())
            .await;
        let hello = p.receive().await;
        assert!(matches!(hello.body, Command::Hello(_)));
        p
    }
    async fn send(&mut self, body: Value) {
        self.seq += 1;
        let env = self.envelope(body);
        write_frame(&mut self.socket, &env).await.unwrap();
    }
    fn envelope(&self, body: Value) -> Envelope {
        decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":format!("{}-{}", self.nonce_prefix,self.seq),"ts_ns":0,"from":self.registration.endpoint,"to":self.config.core.endpoint,"session_id":self.config.session_id,"seq":self.seq,"nonce":format!("{}-{}",self.nonce_prefix,self.seq),"body":body}).to_string()).unwrap()
    }
    async fn receive(&mut self) -> Envelope {
        // read_frame already enforces the transport's configured read deadline.
        // An additional shorter watchdog makes host scheduling a test oracle.
        read_frame(&mut self.socket)
            .await
            .expect("test peer frame read failed")
            .unwrap_or_else(|| {
                panic!(
                    "core closed {} after seq {}",
                    self.registration.endpoint.instance, self.seq
                )
            })
    }
}

struct SharedFrame(std::path::PathBuf);
impl SharedFrame {
    const WIDTH: u64 = 100;
    const HEIGHT: u64 = 60;
    const BYTES: usize = (Self::WIDTH as usize) * (Self::HEIGHT as usize) * 3;
    fn new() -> Self {
        use std::os::unix::fs::OpenOptionsExt;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::path::PathBuf::from(format!(
            "/dev/shm/mv-wire-{}-{}-frame",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut file, &vec![b'f'; Self::BYTES]).unwrap();
        Self(path)
    }
    fn value(&self, generation: u64) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        value["width"] = Self::WIDTH.into();
        value["height"] = Self::HEIGHT.into();
        value["sha256"] = sha256_hex(&vec![b'f'; Self::BYTES]).into();
        value["ramws_path"] = self.0.to_str().unwrap().into();
        value["generation"] = generation.into();
        value
    }
}
impl Drop for SharedFrame {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
async fn start_server() -> (
    support::Temp,
    Arc<Mutex<Server>>,
    tokio::task::JoinHandle<serve::Result<()>>,
) {
    let temp = support::Temp::new();
    let socket = temp.0.join("runtime/core.sock");
    let uid = support::uid();
    let listener = serve::bind(&socket, uid).await.unwrap();
    let server = Arc::new(Mutex::new(
        Server::open(config(), &temp.0.join("state"), uid).unwrap(),
    ));
    let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
    (temp, server, task)
}
async fn setup() -> (
    support::Temp,
    Arc<Mutex<Server>>,
    tokio::task::JoinHandle<serve::Result<()>>,
    Peer,
    Peer,
    Peer,
) {
    let (temp, server, task) = start_server().await;
    let socket = temp.0.join("runtime/core.sock");
    let daemon = Peer::connect(&socket, "daemon").await;
    let agent = Peer::connect(&socket, "agent").await;
    let ui = Peer::connect(&socket, "ui").await;
    (temp, server, task, daemon, agent, ui)
}
fn surface() -> Value {
    serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap()
}
async fn created(daemon: &mut Peer, ui: &mut Peer) {
    daemon
        .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface()}}))
        .await;
    ui.receive().await;
}
async fn close_server(
    server: Arc<Mutex<Server>>,
    task: tokio::task::JoinHandle<serve::Result<()>>,
    daemon: Peer,
    agent: Peer,
    ui: Peer,
) {
    task.abort();
    let _ = task.await;
    drop((daemon, agent, ui));
    tokio::time::timeout(Duration::from_secs(2), async {
        while Arc::strong_count(&server) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("connection tasks must release server");
    drop(server);
}

// Both wire representations must preserve refusal durability and connection identity.
async fn check_refusal(unknown: bool, event: bool) {
    let (temp, server, task, mut daemon, agent, mut ui) = setup().await;
    created(&mut daemon, &mut ui).await;
    let shared = SharedFrame::new();
    daemon.send(shared.value(32)).await;
    ui.receive().await;
    let epoch = server.lock().unwrap().authority.state().epoch;
    let generations: &[u64] = if unknown { &[33] } else { &[20, 32, 31] };
    for &generation in generations {
        let mut frame = shared.value(generation);
        if unknown {
            frame["surface_id"] = "unknown-surface".into();
        }
        let body = if event {
            json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":frame}})
        } else {
            frame
        };
        let before = server.lock().unwrap().authority.state().core_seq;
        daemon.send(body).await;
        let verdict = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(verdict["decision"], "refused");
        assert_eq!(verdict["reason_code"], "STALE_FRAME");
        assert_eq!(
            verdict["proposal_id"],
            format!("daemon-test-{}", daemon.seq)
        );
        assert_eq!(verdict["core_seq"], before + 1);
        let mut locked = server.lock().unwrap();
        locked.authority.flush_sync().unwrap();
        let root = temp.0.join("state/sessions/serve-session");
        // scan validates every chain link and recomputes each stored outcome.
        let replay = crate::journal::scan(&root.join("journal.jsonl"), &root).unwrap();
        assert_eq!(replay.state.core_seq, before + 1);
        assert_eq!(
            replay.state.snapshot().unwrap(),
            locked.authority.state().snapshot().unwrap()
        );
        assert_eq!(replay.state.epoch, epoch);
        assert!(!replay.state.surfaces.contains_key("unknown-surface"));
        assert_eq!(
            replay.state.surfaces["surface-demo"]
                .frame
                .as_ref()
                .unwrap()
                .generation,
            32
        );
    }
    daemon.send(shared.value(33)).await;
    let valid = serde_json::to_value(ui.receive().await.body).unwrap();
    // Any refused-frame fanout would precede this frame and fail the assertion.
    assert_eq!(valid["generation"], 33);
    assert_eq!(server.lock().unwrap().authority.state().epoch, epoch);
    let root = temp.0.join("state/sessions/serve-session");
    server.lock().unwrap().authority.flush_sync().unwrap();
    let replay = crate::journal::scan(&root.join("journal.jsonl"), &root).unwrap();
    assert_eq!(
        replay.state.snapshot().unwrap(),
        server.lock().unwrap().authority.state().snapshot().unwrap()
    );
    close_server(server, task, daemon, agent, ui).await;
}
#[test]
fn b1_stale_generations_are_journalled_without_teardown() {
    support::run(async {
        for event in [false, true] {
            check_refusal(false, event).await;
        }
    });
}
#[test]
fn b1_unknown_surface_is_journalled_without_teardown() {
    support::run(async {
        for event in [false, true] {
            check_refusal(true, event).await;
        }
    });
}
