#![forbid(unsafe_code)]
mod support;
use metaviewer_core::journal::sha256_hex;
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
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
}
impl Peer {
    async fn connect(path: &std::path::Path, component: &str) -> Self {
        let mut p = Self {
            socket: UnixStream::connect(path).await.unwrap(),
            config: config(),
            registration: registration(component),
            seq: 0,
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
        decode_envelope(&json!({"schema":"envelope/v0.2","msg_id":format!("{}-{}", self.registration.endpoint.instance,self.seq),"ts_ns":0,"from":self.registration.endpoint,"to":self.config.core.endpoint,"session_id":self.config.session_id,"seq":self.seq,"nonce":format!("{}-{}",self.registration.endpoint.instance,self.seq),"body":body}).to_string()).unwrap()
    }
    async fn receive(&mut self) -> Envelope {
        let env = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut self.socket))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        env
    }
    async fn verdict(&mut self, decision: &str, reason: Option<&str>) {
        let env = self.receive().await;
        let value = serde_json::to_value(env.body).unwrap();
        assert_eq!(value["decision"], decision, "{value}");
        if let Some(reason) = reason {
            assert_eq!(value["reason_code"], reason);
        }
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
        let directory = std::path::PathBuf::from(format!(
            "/dev/shm/mv-wire-{}-{}-frame",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("frame.rgb");
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
            "../../contracts/examples/v0.2/frame_ref.valid.json"
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
        let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
    }
}

#[test]
fn config_registration_fences() {
    support::run(async {
        let temp = support::Temp::new();
        std::fs::set_permissions(&temp.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        let uid = support::uid();
        assert!(Server::open(config(), &temp.0.join("valid"), uid).is_ok());
        for component in [Component::Agent, Component::Daemon] {
            let mut missing = config();
            missing.peers.retain(|p| p.endpoint.component != component);
            let err = Server::open(missing, &temp.0.join("missing"), uid)
                .err()
                .expect("missing registration admitted");
            assert!(err.to_string().contains("one agent and one daemon"));
            let mut doubled = config();
            let mut extra = doubled
                .peers
                .iter()
                .find(|p| p.endpoint.component == component)
                .unwrap()
                .clone();
            extra.endpoint.instance.push_str("-second");
            doubled.peers.push(extra);
            assert!(Server::open(doubled, &temp.0.join("double"), uid).is_err());
        }
        let mut duplicate = config();
        duplicate.peers.push(registration("ui"));
        let err = Server::open(duplicate, &temp.0.join("duplicate"), uid)
            .err()
            .unwrap();
        assert!(err.to_string().contains("duplicate"));
    });
}
fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir(to).unwrap();
    std::fs::set_permissions(to, std::fs::metadata(from).unwrap().permissions()).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), dest).unwrap();
        }
    }
}
#[test]
fn recovered_session_must_match_requested_identity() {
    support::run(async {
        let temp = support::Temp::new();
        std::fs::set_permissions(&temp.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        let uid = support::uid();
        let mut a = config();
        a.session_id = "ws3-a".into();
        drop(Server::open(a.clone(), &temp.0, uid).unwrap());
        copy_tree(
            &temp.0.join("sessions/ws3-a"),
            &temp.0.join("sessions/ws3-b"),
        );
        drop(Server::open(a, &temp.0, uid).unwrap());
        let mut b = config();
        b.session_id = "ws3-b".into();
        let err = Server::open(b, &temp.0, uid)
            .err()
            .expect("foreign session recovered");
        assert!(
            err.to_string().contains("recovered session mismatch"),
            "{err}"
        );
    });
}
async fn start() -> (
    support::Temp,
    tokio::task::JoinHandle<serve::Result<()>>,
    Peer,
    Peer,
) {
    let temp = support::Temp::new();
    let socket = temp.0.join("runtime/core.sock");
    let uid = support::uid();
    let listener = serve::bind(&socket, uid).await.unwrap();
    let server = Arc::new(Mutex::new(
        Server::open(config(), &temp.0.join("state"), uid).unwrap(),
    ));
    let task = tokio::spawn(serve::serve(listener, server, uid));
    let mut daemon = Peer::connect(&socket, "daemon").await;
    let mut ui = Peer::connect(&socket, "ui").await;
    let mut surface: Value = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/surface.valid.json"
    ))
    .unwrap();
    surface["control"] = "human".into();
    daemon
        .send(json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface}}))
        .await;
    assert!(matches!(ui.receive().await.body, Command::SurfaceEvent(_)));
    (temp, task, daemon, ui)
}
#[test]
fn shm_leaf_mode_blocks_frame_fanout() {
    support::run(async {
        for mode in [0o640, 0o600] {
            let (_temp, task, mut daemon, mut ui) = start().await;
            let frame = SharedFrame::new();
            std::fs::set_permissions(&frame.0, std::fs::Permissions::from_mode(mode)).unwrap();
            let value = frame.value(1);
            daemon.send(value.clone()).await;
            if mode == 0o640 {
                assert!(
                    tokio::time::timeout(Duration::from_millis(150), read_frame(&mut ui.socket))
                        .await
                        .is_err(),
                    "unsafe frame reached UI"
                );
            } else {
                assert_eq!(
                    serde_json::to_value(ui.receive().await.body).unwrap(),
                    value
                );
            }
            task.abort();
            let _ = task.await;
        }
    });
}
#[test]
fn agent_origin_refused_human_origin_forwarded() {
    support::run(async {
        let (_temp, task, mut daemon, mut ui) = start().await;
        let input = |origin: &str| json!({"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"surface-demo","proposal_id":"ws3-input","origin":origin,"action":{"type":"type","text":"ready"}}});
        ui.send(input("agent")).await;
        ui.verdict("refused", Some("POLICY")).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), read_frame(&mut daemon.socket))
                .await
                .is_err(),
            "spoofed agent input forwarded"
        );
        ui.send(input("human")).await;
        let forwarded = serde_json::to_value(daemon.receive().await.body).unwrap();
        assert_eq!(forwarded["op"], "input");
        assert_eq!(
            forwarded["params"]["action"],
            input("human")["params"]["action"]
        );
        task.abort();
        let _ = task.await;
    });
}
