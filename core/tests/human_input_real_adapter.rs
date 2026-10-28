#![forbid(unsafe_code)]

use metaviewer_core::serve::{self, effective_uid, Config, Registration, Server};
use metaviewer_core::wire::payload::Hello;
use metaviewer_core::{
    decode_envelope, handshake_at, read_frame, write_frame, Clock, Command, Component, Endpoint,
    Envelope, HandshakePolicy, WireLimits,
};
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixStream;
use tokio::time::{timeout, Instant};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

const DAEMON_COMMIT: &str = "f8f9294fc70a423164d63f2cf6e5de65ec6f6516";

struct TempPaths {
    temp_root: PathBuf,
    shm_root: PathBuf,
}

impl TempPaths {
    fn new(tag: &str) -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let temp_root = std::env::temp_dir().join(format!("mv-hi-{tag}-{pid}-{id}"));
        let shm_root = Path::new("/dev/shm").join(format!("mv-hi-shm-{tag}-{pid}-{id}"));
        let _ = fs::remove_dir_all(&temp_root);
        let _ = fs::remove_dir_all(&shm_root);
        fs::create_dir_all(&temp_root).unwrap();
        fs::set_permissions(&temp_root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(&shm_root).unwrap();
        fs::set_permissions(&shm_root, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            temp_root,
            shm_root,
        }
    }
}

impl Drop for TempPaths {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.temp_root);
        let _ = fs::remove_dir_all(&self.shm_root);
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .to_path_buf()
}

fn build_real_daemon_adapter(out_dir: &Path) -> PathBuf {
    let binary = out_dir.join("mv-daemon-adapter");
    let go = std::env::var_os("GO").unwrap_or_else(|| "go".into());
    let output = ProcessCommand::new(go)
        .current_dir(repo_root().join("daemon-adapter"))
        .args(["build", "-o"])
        .arg(&binary)
        .arg("./cmd/mv-daemon-adapter")
        .output()
        .expect("invoke go build for mv-daemon-adapter");
    assert!(
        output.status.success(),
        "go build mv-daemon-adapter failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    binary
}

fn write_fake_srf_cli(bin_dir: &Path, shm_root: &Path) {
    let frames_dir = shm_root.join("demo-run/frames/w1");
    fs::create_dir_all(&frames_dir).unwrap();
    fs::set_permissions(&frames_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let png_path = frames_dir.join("f.png");
    let gen = ProcessCommand::new("python3")
        .arg("-c")
        .arg(
            "import struct, sys, zlib; \
chunk = lambda tag, data: struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff); \
raw = b'\\x00\\xff\\x00\\x00\\x00\\xff\\x00'; \
png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''); \
open(sys.argv[1], 'wb').write(png)",
        )
        .arg(&png_path)
        .status()
        .expect("generate test png with python3");
    assert!(gen.success());
    fs::set_permissions(&png_path, fs::Permissions::from_mode(0o600)).unwrap();
    let rgb_sha = metaviewer_core::journal::sha256_hex(&[255, 0, 0, 0, 255, 0]);
    let script = format!(
        "#!/usr/bin/python3\n\
import json, sys, time\n\
op = sys.argv[1]\n\
if op == 'start':\n \
print(json.dumps({{'container': 'srf-id-demo', 'run_id': 'demo-run', 'windows': [{{'id': 'w1', 'x': 0, 'y': 0, 'w': 2, 'h': 1, 'title': 'fake', 'url': ''}}]}}))\n\
elif op == 'frame':\n \
print(json.dumps({{'path': {png:?}, 'seq': time.monotonic_ns(), 'sha256_rgb24': {sha:?}, 'width': 2, 'height': 1, 'capture_mono_ns': time.monotonic_ns(), 'generation': 'srf-id-demo', 'window': {{'id': 'w1', 'x': 0, 'y': 0, 'w': 2, 'h': 1, 'title': 'fake', 'url': ''}}}}))\n\
elif op == 'input':\n \
kind = 'click' if '--click' in sys.argv else ('text' if '--type-stdin' in sys.argv else 'key')\n \
print(json.dumps({{'surface_id': 'w1', 'kind': kind, 'input_mono_ns': time.monotonic_ns(), 'focus_verified': True, 'result': 'ok'}}))\n\
elif op == 'stop':\n \
print(json.dumps({{'stopped': 'srf-id-demo', 'removed_verified': True}}))\n\
else:\n \
sys.exit(2)\n",
        png = png_path.to_str().unwrap(),
        sha = rgb_sha
    );
    let cli_path = bin_dir.join("srf-identity-surface");
    fs::write(&cli_path, script).unwrap();
    fs::set_permissions(&cli_path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn spawn_real_daemon_adapter(
    binary: &Path,
    runtime_dir: &Path,
    srf_bin_dir: &Path,
    srf_state_dir: &Path,
    shm_root: &Path,
    session_id: &str,
) -> Child {
    let profiles = json!({
        "demo": {
            "Kind": "browser",
            "NativeKind": "browser",
            "RAMRoot": shm_root.to_str().unwrap(),
            "Display": ":100",
            "Width": 2,
            "Height": 1
        }
    })
    .to_string();
    ProcessCommand::new(binary)
        .current_dir(repo_root())
        .env("MV_SESSION_ID", session_id)
        .env("MV_CORE_INSTANCE", "core-1")
        .env("MV_DAEMON_INSTANCE", "daemon-1")
        .env("MV_SRF_BIN_DIR", srf_bin_dir)
        .env("MV_SRF_STATE_DIR", srf_state_dir)
        .env("MV_SRF_PROFILES", profiles)
        .env("MV_SRF_LIVE_RAM_ROOT", shm_root)
        .env("MV_SRF_LIVE_PROFILE", "demo")
        .env("SRF_IDENTITY_STORE_ROOT", shm_root)
        .env("SRF_PROXY_REGISTRY", shm_root.join("proxies.json"))
        .env("XDG_RUNTIME_DIR", runtime_dir)
        .env("MV_CONTRACT_DIR", repo_root().join("contracts/v0.2"))
        .env("MV_COMPONENT_COMMIT", DAEMON_COMMIT)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn mv-daemon-adapter")
}

fn registration(component: &str, version: &str, commit: &str) -> Registration {
    serde_json::from_value(json!({
        "endpoint": { "component": component, "instance": format!("{component}-1") },
        "hello": {
            "schema": "hello/v0.2",
            "contract_version": "v0.2",
            "component": component,
            "component_version": version,
            "component_commit": commit,
            "dependencies": []
        }
    }))
    .unwrap()
}

struct TestPeer {
    stream: UnixStream,
    from: Endpoint,
    to: Endpoint,
    session_id: String,
    prefix: String,
    seq: u64,
}

impl TestPeer {
    async fn connect(socket: &Path, session_id: &str, component: Component, name: &str) -> Self {
        let mut stream = UnixStream::connect(socket).await.unwrap();
        let from = Endpoint {
            component,
            instance: format!("{name}-1"),
        };
        let to = Endpoint {
            component: Component::Core,
            instance: "core-1".into(),
        };
        let hello: Hello = serde_json::from_value(json!({
            "schema": "hello/v0.2",
            "contract_version": "v0.2",
            "component": name,
            "component_version": "0.1.0",
            "component_commit": DAEMON_COMMIT,
            "dependencies": []
        }))
        .unwrap();
        let expected_core: Hello = serde_json::from_value(json!({
            "schema": "hello/v0.2",
            "contract_version": "v0.2",
            "component": "core",
            "component_version": "0.1.2",
            "component_commit": DAEMON_COMMIT,
            "dependencies": []
        }))
        .unwrap();
        let policy = HandshakePolicy::new(
            effective_uid().unwrap(),
            to.clone(),
            from.clone(),
            session_id.to_string(),
            expected_core,
        )
        .unwrap();
        let limits = WireLimits::default();
        let first = Envelope {
            schema: "envelope/v0.2".into(),
            msg_id: format!("{name}-hello"),
            ts_ns: Clock::new(1),
            from: from.clone(),
            to: to.clone(),
            session_id: session_id.into(),
            seq: 1,
            nonce: format!("{name}-hello"),
            body: Command::Hello(Box::new(hello)),
        };
        write_frame(&mut stream, &first).await.unwrap();
        handshake_at(&mut stream, &policy, &limits, Instant::now())
            .await
            .unwrap();
        Self {
            stream,
            from,
            to,
            session_id: session_id.into(),
            prefix: name.into(),
            seq: 1,
        }
    }

    async fn send(&mut self, body: Value) {
        self.seq += 1;
        let raw = json!({
            "schema": "envelope/v0.2",
            "msg_id": format!("{}-{}", self.prefix, self.seq),
            "ts_ns": self.seq * 1000,
            "from": self.from,
            "to": self.to,
            "session_id": self.session_id,
            "seq": self.seq,
            "nonce": format!("{}-{}", self.prefix, self.seq),
            "body": body
        })
        .to_string();
        let env = decode_envelope(&raw).unwrap();
        write_frame(&mut self.stream, &env).await.unwrap();
    }

    async fn receive_json(&mut self) -> Value {
        let env = timeout(Duration::from_secs(10), read_frame(&mut self.stream))
            .await
            .expect("timed out waiting for core frame")
            .expect("read core frame")
            .expect("unexpected EOF from core");
        serde_json::to_value(env.body).unwrap()
    }
}

#[test]
fn real_core_and_real_daemon_adapter_accept_human_input_and_settle_outcomes() {
    let paths = TempPaths::new("pos");
    let bin_dir = paths.temp_root.join("bin");
    let runtime_dir = paths.temp_root.join("runtime");
    let core_state = paths.temp_root.join("core-state");
    let srf_state = paths.temp_root.join("srf-state");
    for d in [
        &bin_dir,
        &runtime_dir,
        &runtime_dir.join("metaviewer"),
        &core_state,
        &srf_state,
    ] {
        fs::create_dir_all(d).unwrap();
        fs::set_permissions(d, fs::Permissions::from_mode(0o700)).unwrap();
    }
    write_fake_srf_cli(&bin_dir, &paths.shm_root);
    let adapter_bin = build_real_daemon_adapter(&bin_dir);
    let session_id = "real-hi-session";
    let socket = runtime_dir.join("metaviewer/core.sock");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let uid = effective_uid().unwrap();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let config = Config {
            session_id: session_id.into(),
            core: registration("core", "0.1.2", DAEMON_COMMIT),
            peers: vec![
                registration("daemon", "0.1.1", DAEMON_COMMIT),
                registration("agent", "0.1.0", DAEMON_COMMIT),
                registration("ui", "0.1.0", DAEMON_COMMIT),
            ],
        };
        let server = Arc::new(Mutex::new(Server::open(config, &core_state, uid).unwrap()));
        let srv = Arc::clone(&server);
        let server_task = tokio::spawn(async move {
            let _ = serve::serve(listener, srv, uid).await;
        });

        let mut adapter = spawn_real_daemon_adapter(
            &adapter_bin,
            &runtime_dir,
            &bin_dir,
            &srf_state,
            &paths.shm_root,
            session_id,
        );
        let mut ui = TestPeer::connect(&socket, session_id, Component::Ui, "ui").await;
        let mut agent = TestPeer::connect(&socket, session_id, Component::Agent, "agent").await;

        // Wait for the real daemon adapter to complete its handshake with the real core.
        for _ in 0..200 {
            let snap: Value =
                serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
            if snap["epoch"].as_u64() == Some(1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let snap: Value =
            serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
        assert_eq!(
            snap["epoch"].as_u64(),
            Some(1),
            "real daemon adapter did not connect"
        );

        // 1. Create a surface through the real core and real daemon adapter.
        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "create",
            "params": {
                "kind": "browser",
                "profile_id": "demo",
                "geometry": { "w": 2, "h": 1 }
            }
        }))
        .await;

        let mut surface_id = String::new();
        let mut frame_sha = String::new();
        let mut frame_gen = 0u64;
        while surface_id.is_empty() || frame_sha.is_empty() {
            let body = ui.receive_json().await;
            if body["schema"] == "surface_event/v0.2" && body["event"] == "created" {
                surface_id = body["data"]["surface"]["surface_id"]
                    .as_str()
                    .unwrap()
                    .to_owned();
            } else if body["schema"] == "surface_event/v0.2" && body["event"] == "frame_ready" {
                frame_sha = body["data"]["frame_ref"]["sha256"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                frame_gen = body["data"]["frame_ref"]["generation"].as_u64().unwrap();
            } else {
                panic!("unexpected message during surface create: {body}");
            }
        }

        // 1b. Negative control: human origin under agent control is refused with LOCKED_BY_OTHER.
        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": surface_id,
                "proposal_id": "hi-under-agent-ctrl",
                "origin": "human",
                "action": { "type": "key", "keys": ["Return"] }
            }
        }))
        .await;
        let refused_under_agent = ui.receive_json().await;
        assert_eq!(refused_under_agent["schema"], "action_verdict/v0.2");
        assert_eq!(refused_under_agent["proposal_id"], "hi-under-agent-ctrl");
        assert_eq!(refused_under_agent["decision"], "refused");
        assert_eq!(refused_under_agent["reason_code"], "LOCKED_BY_OTHER");

        // 1c. Negative control: agent never may send surface_request input with origin "human".
        agent
            .send(json!({
                "schema": "surface_request/v0.2",
                "op": "input",
                "params": {
                    "surface_id": surface_id,
                    "proposal_id": "ag-forged-human-origin",
                    "origin": "human",
                    "action": { "type": "key", "keys": ["Return"] }
                }
            }))
            .await;
        let ag_forged = agent.receive_json().await;
        assert_eq!(ag_forged["schema"], "action_verdict/v0.2");
        assert_eq!(ag_forged["proposal_id"], "ag-forged-human-origin");
        assert_eq!(ag_forged["decision"], "refused");
        assert_eq!(ag_forged["reason_code"], "POLICY");

        // 2. Take human control through the real core and real daemon adapter.
        ui.send(json!({
            "schema": "ui_intent/v0.2",
            "request_id": "take-real-1",
            "op": "take_control",
            "params": { "surface_id": surface_id }
        }))
        .await;
        loop {
            let body = ui.receive_json().await;
            if body["schema"] == "surface_event/v0.2"
                && body["event"] == "state_changed"
                && body["data"]["surface"]["control"] == "human"
            {
                break;
            }
        }

        // 2b. Negative control: agent proposal under human control is refused with SURFACE_NOT_AGENT_CONTROLLED.
        agent
            .send(json!({
                "schema": "action_proposal/v0.2",
                "proposal_id": "ag-prop-under-human",
                "surface_id": surface_id,
                "based_on_frame": { "sha256": frame_sha, "generation": frame_gen },
                "action": { "type": "key", "keys": ["Return"] },
                "expectation": {
                    "type": "changed_region",
                    "bbox": { "x": 0, "y": 0, "w": 1, "h": 1 }
                },
                "budget": { "max_ms": 1000, "max_retries": 0 }
            }))
            .await;
        let ag_refused = agent.receive_json().await;
        assert_eq!(ag_refused["schema"], "action_verdict/v0.2");
        assert_eq!(ag_refused["proposal_id"], "ag-prop-under-human");
        assert_eq!(ag_refused["decision"], "refused");
        assert_eq!(ag_refused["reason_code"], "SURFACE_NOT_AGENT_CONTROLLED");

        // 2c. Negative control: UI setting origin "agent" is refused with POLICY.
        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": surface_id,
                "proposal_id": "hi-forged-agent-origin",
                "origin": "agent",
                "action": { "type": "key", "keys": ["Return"] }
            }
        }))
        .await;
        let ui_forged = ui.receive_json().await;
        assert_eq!(ui_forged["schema"], "action_verdict/v0.2");
        assert_eq!(ui_forged["proposal_id"], "hi-forged-agent-origin");
        assert_eq!(ui_forged["decision"], "refused");
        assert_eq!(ui_forged["reason_code"], "POLICY");

        // 3. Positive: click, key, and type human inputs from UI through real core to real adapter are applied!
        for (proposal_id, action) in [
            (
                "hi-real-click",
                json!({ "type": "click", "x": 1, "y": 0, "button": "left" }),
            ),
            ("hi-real-key", json!({ "type": "key", "keys": ["Return"] })),
            ("hi-real-type", json!({ "type": "type", "text": "a" })),
        ] {
            ui.send(json!({
                "schema": "surface_request/v0.2",
                "op": "input",
                "params": {
                    "surface_id": surface_id,
                    "proposal_id": proposal_id,
                    "origin": "human",
                    "action": action
                }
            }))
            .await;

            let mut saw_applied_event = false;
            let mut saw_admitted_verdict = false;
            while !saw_applied_event || !saw_admitted_verdict {
                let body = ui.receive_json().await;
                if body["schema"] == "surface_event/v0.2"
                    && body["event"] == "input_applied"
                    && body["data"]["proposal_id"] == proposal_id
                {
                    saw_applied_event = true;
                } else if body["schema"] == "action_verdict/v0.2"
                    && body["proposal_id"] == proposal_id
                {
                    assert_eq!(
                        body["decision"], "admitted",
                        "expected human input {proposal_id} to be admitted after adapter receipt, got {body}"
                    );
                    saw_admitted_verdict = true;
                }
            }

            assert!(
                adapter.try_wait().unwrap().is_none(),
                "real mv-daemon-adapter exited prematurely during human input {proposal_id}"
            );
        }

        // 4. Negative control: unsupported scroll action in adapter returns refused POLICY verdict to UI.
        ui.send(json!({
            "schema": "surface_request/v0.2",
            "op": "input",
            "params": {
                "surface_id": surface_id,
                "proposal_id": "hi-real-scroll",
                "origin": "human",
                "action": { "type": "scroll", "dx": 0, "dy": -120 }
            }
        }))
        .await;
        loop {
            let body = ui.receive_json().await;
            if body["schema"] == "action_verdict/v0.2" && body["proposal_id"] == "hi-real-scroll" {
                assert_eq!(body["decision"], "refused");
                assert_eq!(body["reason_code"], "POLICY");
                break;
            }
        }

        drop(agent);
        drop(ui);
        server_task.abort();
        let _ = server_task.await;
        let _ = adapter.kill();
        let _ = adapter.wait();
    });
}

#[test]
fn real_daemon_adapter_exits_rc_2_on_disallowed_core_body() {
    let paths = TempPaths::new("neg");
    let bin_dir = paths.temp_root.join("bin");
    let runtime_dir = paths.temp_root.join("runtime");
    let srf_state = paths.temp_root.join("srf-state");
    for d in [
        &bin_dir,
        &runtime_dir,
        &runtime_dir.join("metaviewer"),
        &srf_state,
    ] {
        fs::create_dir_all(d).unwrap();
        fs::set_permissions(d, fs::Permissions::from_mode(0o700)).unwrap();
    }
    write_fake_srf_cli(&bin_dir, &paths.shm_root);
    let adapter_bin = build_real_daemon_adapter(&bin_dir);
    let session_id = "neg-hi-session";
    let socket = runtime_dir.join("metaviewer/core.sock");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let uid = effective_uid().unwrap();
        let listener = serve::bind(&socket, uid).await.unwrap();
        let adapter = spawn_real_daemon_adapter(
            &adapter_bin,
            &runtime_dir,
            &bin_dir,
            &srf_state,
            &paths.shm_root,
            session_id,
        );

        let (mut stream, _) = timeout(Duration::from_secs(10), listener.accept())
            .await
            .expect("accept adapter")
            .expect("unix accept");
        let daemon_hello = timeout(Duration::from_secs(5), read_frame(&mut stream))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&daemon_hello.body).unwrap()["schema"],
            "hello/v0.2"
        );

        let core_hello = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": "core-hello",
                "ts_ns": 1,
                "from": { "component": "core", "instance": "core-1" },
                "to": { "component": "daemon", "instance": "daemon-1" },
                "session_id": session_id,
                "seq": 1,
                "nonce": "core-hello",
                "body": {
                    "schema": "hello/v0.2",
                    "contract_version": "v0.2",
                    "component": "core",
                    "component_version": "0.1.2",
                    "component_commit": DAEMON_COMMIT,
                    "dependencies": []
                }
            })
            .to_string(),
        )
        .unwrap();
        write_frame(&mut stream, &core_hello).await.unwrap();

        // Positive control on adapter wire: create a surface and feed the exact surface_request/v0.2
        // op="input" envelopes (click, key, type) that core translates human input into.
        let mut seq = 1u64;
        let mut send_core = async |stream: &mut UnixStream, body: Value| {
            seq += 1;
            let env = decode_envelope(
                &json!({
                    "schema": "envelope/v0.2",
                    "msg_id": format!("core-req-{seq}"),
                    "ts_ns": seq * 1000,
                    "from": { "component": "core", "instance": "core-1" },
                    "to": { "component": "daemon", "instance": "daemon-1" },
                    "session_id": session_id,
                    "seq": seq,
                    "nonce": format!("core-req-{seq}"),
                    "body": body
                })
                .to_string(),
            )
            .unwrap();
            write_frame(stream, &env).await.unwrap();
        };

        send_core(
            &mut stream,
            json!({
                "schema": "surface_request/v0.2",
                "op": "create",
                "params": {
                    "kind": "browser",
                    "profile_id": "demo",
                    "geometry": { "w": 2, "h": 1 }
                }
            }),
        )
        .await;

        let created_env = timeout(Duration::from_secs(5), read_frame(&mut stream))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let created_body = serde_json::to_value(created_env.body).unwrap();
        assert_eq!(created_body["event"], "created");
        let sid = created_body["data"]["surface"]["surface_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let frame_env = timeout(Duration::from_secs(5), read_frame(&mut stream))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(frame_env.body).unwrap()["event"],
            "frame_ready"
        );

        // Negative control on adapter wire: origin "human" under agent control is refused with SURFACE_NOT_HUMAN_CONTROLLED.
        send_core(
            &mut stream,
            json!({
                "schema": "surface_request/v0.2",
                "op": "input",
                "params": {
                    "surface_id": sid,
                    "proposal_id": "human-under-agent-1",
                    "origin": "human",
                    "action": { "type": "key", "keys": ["Return"] }
                }
            }),
        )
        .await;
        let refused_human_reply = timeout(Duration::from_secs(5), read_frame(&mut stream))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let refused_human_body = serde_json::to_value(refused_human_reply.body).unwrap();
        assert_eq!(refused_human_body["schema"], "action_receipt/v0.2");
        assert_eq!(refused_human_body["proposal_id"], "human-under-agent-1");
        assert_eq!(
            refused_human_body["error"],
            "input failed: SURFACE_NOT_HUMAN_CONTROLLED: agent control blocks human input"
        );

        for (proposal_id, action) in [
            (
                "core-minted-click-1",
                json!({ "type": "click", "x": 1, "y": 0, "button": "left" }),
            ),
            (
                "core-minted-key-1",
                json!({ "type": "key", "keys": ["Return"] }),
            ),
            ("core-minted-type-1", json!({ "type": "type", "text": "a" })),
        ] {
            send_core(
                &mut stream,
                json!({
                    "schema": "surface_request/v0.2",
                    "op": "input",
                    "params": {
                        "surface_id": sid,
                        "proposal_id": proposal_id,
                        "origin": "agent",
                        "action": action
                    }
                }),
            )
            .await;

            let mut got_applied = false;
            let mut got_receipt = false;
            while !got_applied || !got_receipt {
                let reply = timeout(Duration::from_secs(5), read_frame(&mut stream))
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                let body = serde_json::to_value(reply.body).unwrap();
                if body["schema"] == "surface_event/v0.2" && body["event"] == "input_applied" {
                    assert_eq!(body["data"]["proposal_id"], proposal_id);
                    got_applied = true;
                } else if body["schema"] == "action_receipt/v0.2" {
                    assert_eq!(body["proposal_id"], proposal_id);
                    assert_eq!(body["error"], "");
                    got_receipt = true;
                }
            }
        }

        // Take human control on the real adapter wire: agent origin is refused, human origin is applied.
        send_core(
            &mut stream,
            json!({
                "schema": "surface_request/v0.2",
                "op": "take_control",
                "params": {
                    "surface_id": sid,
                    "owner": "human"
                }
            }),
        )
        .await;
        let take_reply = timeout(Duration::from_secs(5), read_frame(&mut stream))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let take_body = serde_json::to_value(take_reply.body).unwrap();
        assert_eq!(take_body["event"], "state_changed");
        assert_eq!(take_body["data"]["surface"]["control"], "human");

        send_core(
            &mut stream,
            json!({
                "schema": "surface_request/v0.2",
                "op": "input",
                "params": {
                    "surface_id": sid,
                    "proposal_id": "agent-under-human-1",
                    "origin": "agent",
                    "action": { "type": "key", "keys": ["Return"] }
                }
            }),
        )
        .await;
        let refused_agent_reply = timeout(Duration::from_secs(5), read_frame(&mut stream))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let refused_agent_body = serde_json::to_value(refused_agent_reply.body).unwrap();
        assert_eq!(refused_agent_body["schema"], "action_receipt/v0.2");
        assert_eq!(refused_agent_body["proposal_id"], "agent-under-human-1");
        assert_eq!(
            refused_agent_body["error"],
            "input failed: SURFACE_NOT_AGENT_CONTROLLED: human control blocks agent input"
        );

        send_core(
            &mut stream,
            json!({
                "schema": "surface_request/v0.2",
                "op": "input",
                "params": {
                    "surface_id": sid,
                    "proposal_id": "human-under-human-1",
                    "origin": "human",
                    "action": { "type": "key", "keys": ["Return"] }
                }
            }),
        )
        .await;
        let mut got_human_applied = false;
        let mut got_human_receipt = false;
        while !got_human_applied || !got_human_receipt {
            let reply = timeout(Duration::from_secs(5), read_frame(&mut stream))
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let body = serde_json::to_value(reply.body).unwrap();
            if body["schema"] == "surface_event/v0.2" && body["event"] == "input_applied" {
                assert_eq!(body["data"]["proposal_id"], "human-under-human-1");
                got_human_applied = true;
            } else if body["schema"] == "action_receipt/v0.2" {
                assert_eq!(body["proposal_id"], "human-under-human-1");
                assert_eq!(body["error"], "");
                got_human_receipt = true;
            }
        }

        // Negative control: sending a non-surface_request body (such as action_verdict/v0.2)
        // from core to the real daemon adapter causes it to exit with rc 2.
        send_core(
            &mut stream,
            json!({
                "schema": "action_verdict/v0.2",
                "proposal_id": "hi-old-untracked",
                "decision": "refused",
                "reason_code": "POLICY",
                "core_seq": 99
            }),
        )
        .await;

        let output = tokio::task::spawn_blocking(move || adapter.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(2),
            "expected real mv-daemon-adapter to exit with rc 2 on disallowed body, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("core surface request required"),
            "expected 'core surface request required' in stderr, got: {stderr}"
        );
    });
}
