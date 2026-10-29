mod support;
use metaviewer_core::journal::sha256_hex;
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
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
}

// /dev/shm is the admitted frame transport namespace, not a machine-specific
// fixture path. All session/socket state lives in the platform temp directory.
struct Pixels(std::path::PathBuf);
impl Drop for Pixels {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn rows(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn accepted_full_size_frames_have_disjoint_stages_and_refusals_have_no_row() {
    for refusal in ["digest", "oversized", "unknown"] {
        support::run(async {
            let temp = support::Temp::new();
            let socket = temp.0.join("runtime/core.sock");
            let uid = support::uid();
            let listener = serve::bind(&socket, uid).await.unwrap();
            let state = temp.0.join("state");
            let server = Arc::new(Mutex::new(Server::open(config(), &state, uid).unwrap()));
            let task = tokio::spawn(serve::serve(listener, server.clone(), uid));
            let mut daemon = Peer::connect(&socket, "daemon").await;
            let mut ui = Peer::connect(&socket, "ui").await;
            let surface: Value = serde_json::from_str(include_str!(
                "../../contracts/examples/v0.2/surface.valid.json"
            ))
            .unwrap();
            daemon
            .send(
                json!({"schema":"surface_event/v0.2","event":"created","data":{"surface":surface}}),
            )
            .await;
            ui.receive().await;
            let path = std::path::Path::new("/dev/shm").join(format!(
                "mv-timings-{}-{}",
                std::process::id(),
                temp.0.file_name().unwrap().to_str().unwrap()
            ));
            let pixels = Pixels(path);
            let bytes = vec![37u8; 1280 * 900 * 3];
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&pixels.0)
                .unwrap();
            std::io::Write::write_all(&mut file, &bytes).unwrap();
            drop(file);
            let mut frame: Value = serde_json::from_str(include_str!(
                "../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            frame["ramws_path"] = pixels.0.to_str().unwrap().into();
            frame["sha256"] = sha256_hex(&bytes).into();
            frame["width"] = 1280.into();
            frame["height"] = 900.into();
            for generation in 1..=3 {
                frame["generation"] = generation.into();
                // Exercise both daemon route representations without burst coalescing.
                if generation == 2 {
                    daemon.send(json!({"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":frame}})).await;
                } else {
                    daemon.send(frame.clone()).await;
                }
                ui.receive().await;
            }
            frame["generation"] = 4.into();
            match refusal {
                "digest" => frame["sha256"] = "0".repeat(64).into(),
                "unknown" => frame["surface_id"] = "unknown-surface".into(),
                "oversized" => std::fs::OpenOptions::new()
                    .write(true)
                    .open(&pixels.0)
                    .unwrap()
                    .set_len(64 * 1024 * 1024 + 1)
                    .unwrap(),
                _ => unreachable!(),
            }
            let refusal_msg_id = format!(
                "{}-{}",
                daemon.registration.endpoint.instance,
                daemon.seq + 1
            );
            daemon.send(frame).await;
            if refusal == "unknown" {
                let verdict = serde_json::to_value(daemon.receive().await.body).unwrap();
                assert_eq!(verdict["schema"], "action_verdict/v0.2");
                assert_eq!(verdict["decision"], "refused");
                assert_eq!(verdict["reason_code"], "STALE_FRAME");
                assert_eq!(verdict["proposal_id"], refusal_msg_id);
                assert!(
                    tokio::time::timeout(
                        Duration::from_millis(100),
                        read_frame(&mut daemon.socket)
                    )
                    .await
                    .is_err(),
                    "unknown surface must yield exactly one verdict and keep the connection"
                );
            } else {
                // Witness and oversize failures retain teardown.
                let refused =
                    tokio::time::timeout(Duration::from_secs(5), read_frame(&mut daemon.socket))
                        .await
                        .unwrap();
                assert!(!matches!(refused, Ok(Some(_))), "{refused:?}");
            }
            server.lock().unwrap().shutdown().unwrap();
            let path = state.join("sessions/serve-session/artifacts/frame_timings.jsonl");
            let rows = rows(&path);
            assert_eq!(rows.len(), 3);
            let mut keys = vec![
                "surface_id",
                "generation",
                "width",
                "height",
                "byte_len",
                "shm_read_ns",
                "hash_ns",
                "skipped_hash_ns",
                "hash_skipped",
                "witness_journal_ns",
                "capture_ns",
                "fanout_ns",
                "total_ns",
            ];
            keys.sort_unstable();
            for (index, row) in rows.iter().enumerate() {
                assert_eq!(
                    row.as_object()
                        .unwrap()
                        .keys()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                    keys
                );
                assert_eq!(row["surface_id"], "surface-demo");
                assert_eq!(row["generation"], (index + 1) as u64);
                assert_eq!(row["width"], 1280);
                assert_eq!(row["height"], 900);
                assert_eq!(row["byte_len"], bytes.len() as u64);
                if index == 0 {
                    assert_eq!(row["hash_skipped"], false, "{row}");
                    assert_eq!(row["skipped_hash_ns"].as_u64().unwrap(), 0, "{row}");
                    assert!(row["hash_ns"].as_u64().unwrap() > 0, "{row}");
                } else {
                    assert_eq!(row["hash_skipped"], true, "{row}");
                    assert!(row["skipped_hash_ns"].as_u64().unwrap() > 0, "{row}");
                    assert_eq!(row["hash_ns"].as_u64().unwrap(), 0, "{row}");
                }
                let sum: u64 = [
                    "shm_read_ns",
                    "hash_ns",
                    "skipped_hash_ns",
                    "witness_journal_ns",
                    "capture_ns",
                    "fanout_ns",
                ]
                .iter()
                .map(|key| row[key].as_u64().unwrap())
                .sum();
                assert!(row["total_ns"].as_u64().unwrap() >= sum, "{row}");
            }
            task.abort();
            let _ = task.await;
        });
    }
}
