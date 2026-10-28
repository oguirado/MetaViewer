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
    static ADAPTER_BYTES: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let bytes = ADAPTER_BYTES.get_or_init(|| {
        let tmp =
            std::env::temp_dir().join(format!("mv-daemon-adapter-build-{}", std::process::id()));
        let go = std::env::var_os("GO").unwrap_or_else(|| "go".into());
        let output = ProcessCommand::new(go)
            .current_dir(repo_root().join("daemon-adapter"))
            .args(["build", "-o"])
            .arg(&tmp)
            .arg("./cmd/mv-daemon-adapter")
            .output()
            .expect("invoke go build for mv-daemon-adapter");
        assert!(
            output.status.success(),
            "go build mv-daemon-adapter failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let data = fs::read(&tmp).expect("read built mv-daemon-adapter");
        let _ = fs::remove_file(&tmp);
        data
    });
    let binary = out_dir.join("mv-daemon-adapter");
    fs::write(&binary, bytes).expect("write mv-daemon-adapter");
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
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
    static FAKE_SRF_BYTES: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let helper_bytes = FAKE_SRF_BYTES.get_or_init(|| {
        let tmp_dir = std::env::temp_dir().join(format!("mv-fake-srf-build-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(&tmp_dir).unwrap();
        let src_path = tmp_dir.join("main.go");
        let bin_path = tmp_dir.join("srf-helper");
        let go_src = r#"package main
import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)
func monoNS() uint64 {
	var ts syscall.Timespec
	syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	return uint64(ts.Sec)*1000000000 + uint64(ts.Nsec)
}
func main() {
	if len(os.Args) < 2 { os.Exit(2) }
	op := os.Args[1]
	root := os.Getenv("SRF_IDENTITY_STORE_ROOT")
	hasFlag := func(flag string) bool {
		for _, a := range os.Args[1:] { if a == flag { return true } }
		return false
	}
	var stdinText string
	if hasFlag("--type-stdin") {
		b, _ := io.ReadAll(os.Stdin)
		stdinText = string(b)
	}
	if root != "" {
		f, err := os.OpenFile(filepath.Join(root, "srf-calls.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err == nil {
			line, _ := json.Marshal(map[string]any{"op": op, "argv": os.Args[1:], "stdin": stdinText})
			f.Write(append(line, '\n'))
			f.Close()
		}
	}
	switch op {
	case "start":
		fmt.Println(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"fake","url":""}]}`)
	case "frame":
		if root != "" {
			if raw, err := os.ReadFile(filepath.Join(root, "frame_delay_ms")); err == nil {
				if ms, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64); err == nil && ms > 0 {
					time.Sleep(time.Duration(ms * float64(time.Millisecond)))
				}
			}
		}
		pngPath := filepath.Join(root, "demo-run/frames/w1/f.png")
		sha := os.Getenv("MV_FAKE_RGB_SHA")
		now := monoNS()
		fmt.Printf(`{"path":%q,"seq":%d,"sha256_rgb24":%q,"width":2,"height":1,"capture_mono_ns":%d,"generation":"srf-id-demo","window":{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"fake","url":""}}`+"\n", pngPath, now, sha, now)
	case "input":
		kind := "key"
		if hasFlag("--click") { kind = "click" } else if hasFlag("--type-stdin") { kind = "text" }
		fmt.Printf(`{"surface_id":"w1","kind":%q,"input_mono_ns":%d,"focus_verified":true,"result":"ok"}`+"\n", kind, monoNS())
	case "stop":
		fmt.Println(`{"stopped":"srf-id-demo","removed_verified":true}`)
	default:
		os.Exit(2)
	}
}
"#;
        fs::write(&src_path, go_src).unwrap();
        let go = std::env::var_os("GO").unwrap_or_else(|| "go".into());
        let out = ProcessCommand::new(go)
            .current_dir(&tmp_dir)
            .args(["build", "-o"])
            .arg(&bin_path)
            .arg(&src_path)
            .output()
            .expect("build fake srf helper");
        assert!(out.status.success(), "go build fake srf failed: {}", String::from_utf8_lossy(&out.stderr));
        let data = fs::read(&bin_path).unwrap();
        let _ = fs::remove_dir_all(&tmp_dir);
        data
    });
    let helper_path = shm_root.join("srf-helper-bin");
    fs::write(&helper_path, helper_bytes).unwrap();
    fs::set_permissions(&helper_path, fs::Permissions::from_mode(0o700)).unwrap();
    let script = format!(
        "#!/bin/sh\nexport MV_FAKE_RGB_SHA={sha:?}\nexec {helper:?} \"$@\"\n",
        sha = rgb_sha,
        helper = helper_path.to_str().unwrap()
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
    let bin_dir = paths.shm_root.join("bin");
    let runtime_dir = paths.shm_root.join("runtime");
    let core_state = paths.shm_root.join("core-state");
    let srf_state = paths.shm_root.join("srf-state");
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

        // 3. Positive: click, key, and type human inputs from UI through real core to real adapter are applied
        // without waiting for pixel verification (even when frame capture takes 250 ms).
        fs::write(paths.shm_root.join("frame_delay_ms"), "250\n").unwrap();
        for (proposal_id, action) in [
            (
                "hi-real-click",
                json!({ "type": "click", "x": 1, "y": 0, "button": "left" }),
            ),
            ("hi-real-key", json!({ "type": "key", "keys": ["Return"] })),
            ("hi-real-type", json!({ "type": "type", "text": "a" })),
        ] {
            let started = std::time::Instant::now();
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
            let elapsed = started.elapsed();
            eprintln!(
                "[MEASURED] human_input_real_adapter latency for {proposal_id}: {:.2} ms",
                elapsed.as_secs_f64() * 1000.0
            );
            assert!(
                elapsed < Duration::from_millis(150),
                "expected human input {proposal_id} latency < 150 ms without pixel capture wait, got {elapsed:?}"
            );

            assert!(
                adapter.try_wait().unwrap().is_none(),
                "real mv-daemon-adapter exited prematurely during human input {proposal_id}"
            );
        }

        // Verify srf-identity-surface frame was called only once (for create) and never for human-origin input.
        let calls_raw = fs::read_to_string(paths.shm_root.join("srf-calls.jsonl")).unwrap();
        let frame_calls: Vec<Value> = calls_raw
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|v| v["op"] == "frame")
            .collect();
        assert_eq!(
            frame_calls.len(),
            1,
            "human-origin input must not trigger post-input frame capture, got {frame_calls:?}"
        );

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

#[test]
fn real_core_and_real_daemon_adapter_200_char_typing_burst_and_next_intent_succeeds() {
    let paths = TempPaths::new("burst200");
    let bin_dir = paths.shm_root.join("bin");
    let runtime_dir = paths.shm_root.join("runtime");
    let srf_state = paths.shm_root.join("srf-state");
    let core_state = paths.shm_root.join("core-state");
    for d in [
        &bin_dir,
        &runtime_dir,
        &runtime_dir.join("metaviewer"),
        &srf_state,
        &core_state,
    ] {
        fs::create_dir_all(d).unwrap();
        fs::set_permissions(d, fs::Permissions::from_mode(0o700)).unwrap();
    }
    write_fake_srf_cli(&bin_dir, &paths.shm_root);
    let adapter_bin = build_real_daemon_adapter(&bin_dir);

    let session_id = "burst200-hi-session";
    let socket = runtime_dir.join("metaviewer/core.sock");
    let config = Config {
        session_id: session_id.into(),
        core: registration("core", "0.1.2", DAEMON_COMMIT),
        peers: vec![
            registration("daemon", "0.1.1", DAEMON_COMMIT),
            registration("agent", "0.1.0", DAEMON_COMMIT),
            registration("ui", "0.1.0", DAEMON_COMMIT),
        ],
    };
    let ui_config_path = paths.temp_root.join("ui-core-config.json");
    let ui_config_json = json!({
        "session_id": session_id,
        "core": {
            "endpoint": { "component": "core", "instance": "core-1" },
            "hello": {
                "schema": "hello/v0.2",
                "contract_version": "v0.2",
                "component": "core",
                "component_version": "0.1.2",
                "component_commit": DAEMON_COMMIT,
                "dependencies": []
            }
        },
        "peers": [{
            "endpoint": { "component": "ui", "instance": "ui-1" },
            "hello": {
                "schema": "hello/v0.2",
                "contract_version": "v0.2",
                "component": "ui",
                "component_version": "0.1.0",
                "component_commit": DAEMON_COMMIT,
                "dependencies": []
            }
        }]
    });
    fs::write(&ui_config_path, ui_config_json.to_string()).unwrap();
    fs::set_permissions(&ui_config_path, fs::Permissions::from_mode(0o600)).unwrap();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let uid = effective_uid().unwrap();
        let listener = serve::bind(&socket, uid).await.unwrap();
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
        let mut agent = TestPeer::connect(&socket, session_id, Component::Agent, "agent").await;

        for _ in 0..200 {
            let snap: Value =
                serde_json::from_slice(&server.lock().unwrap().snapshot().unwrap()).unwrap();
            if snap["epoch"].as_u64() == Some(1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        agent
            .send(json!({
                "schema": "surface_request/v0.2",
                "op": "create",
                "params": {
                    "kind": "browser",
                    "profile_id": "demo",
                    "geometry": { "w": 2, "h": 1 }
                }
            }))
            .await;
        let body = agent.receive_json().await;
        assert_eq!(body["event"], "created");
        let surface_id = body["data"]["surface"]["surface_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let ready = agent.receive_json().await;
        assert_eq!(ready["event"], "frame_ready");

        let expected_text: String = (0..200)
            .map(|i| char::from(b'0' + (i % 74) as u8))
            .collect();
        let driver_path = paths.temp_root.join("burst_driver.mjs");
        let ui_dir = repo_root().join("ui/electron");
        let driver_src = format!(
            r#"import assert from 'node:assert/strict';
import {{ EventEmitter }} from 'node:events';
import {{ pathToFileURL }} from 'node:url';
import {{ join }} from 'node:path';

const uiDir = {ui_dir:?};
const surfaceId = {surface_id:?};
const expectedText = {expected_text:?};

const {{ createMainBindings }} = await import(pathToFileURL(join(uiDir, 'hostBindings.js')).href);
const {{ installAuthorityWire }} = await import(pathToFileURL(join(uiDir, 'authorityWire.js')).href);
const {{ createPreloadFacade }} = await import(pathToFileURL(join(uiDir, 'preload.js')).href);

const createMessageChannel = () => {{
  const port1 = new EventEmitter();
  Object.assign(port1, {{ postMessage() {{}}, start() {{}}, close() {{}} }});
  const port2 = {{ close() {{}} }};
  return {{ port1, port2 }};
}};

const host = await createMainBindings({{ env: process.env, createMessageChannel }});
const handlers = new Map();
const frame = {{ origin: 'app://metaviewer', url: 'app://metaviewer/index.html' }};
const contents = {{ id: 1, mainFrame: frame, isDestroyed: () => false, postMessage() {{}} }};
const event = {{ sender: contents, senderFrame: frame }};
const ipcMain = {{
  handle: (channel, fn) => handlers.set(channel, fn),
  removeHandler: (channel) => handlers.delete(channel),
}};
const wire = installAuthorityWire({{
  ipcMain,
  contents,
  core: host.core,
  frames: null,
  env: process.env,
  argv: [],
}});
const api = createPreloadFacade({{
  transport: {{
    nested: false,
    invoke: (channel, args) => handlers.get(channel)(event, ...args),
    subscribe: () => () => {{}},
  }},
  bridge: {{ exposeInMainWorld() {{}} }},
}});

const boundStreamId = 1;
await api.authority.intent(JSON.stringify({{
  schema: 'ui_intent/v0.2',
  request_id: 'req-take-real-burst',
  op: 'take_control',
  params: {{ surface_id: surfaceId }},
}}));

const results = [];
api.input.onResult((ev) => results.push(ev));

const promises = [];
const t0 = performance.now();
for (let i = 0; i < expectedText.length; i += 1) {{
  promises.push(
    api.input.send({{
      schema: 'surface_input/v1',
      surface_id: surfaceId,
      stream_id: boundStreamId,
      seq: i + 1,
      events: [{{ kind: 'type', text: expectedText[i] }}],
    }}),
  );
  if (i + 1 < expectedText.length) {{
    await new Promise((r) => setTimeout(r, 10));
  }}
}}
const outcomes = await Promise.all(promises);
const totalElapsedMs = performance.now() - t0;
for (const out of outcomes) {{
  assert.deepEqual(out, {{ ok: true, accepted: 1 }});
}}
assert.equal(results.length, 200);
assert.deepEqual(results.map((r) => r.seq), Array.from({{ length: 200 }}, (_, i) => i + 1));
for (const r of results) {{
  assert.equal(r.ok, true);
  assert.equal(r.code, null);
}}

// Next intent succeeds immediately after 200-char burst.
await api.authority.intent(JSON.stringify({{
  schema: 'ui_intent/v0.2',
  request_id: 'req-release-real-burst',
  op: 'release_control',
  params: {{ surface_id: surfaceId }},
}}));

// Negative control: input after release_control returns NOT_IN_CONTROL without disposing wire.
const afterRelease = await api.input.send({{
  schema: 'surface_input/v1',
  surface_id: surfaceId,
  stream_id: boundStreamId,
  seq: 201,
  events: [{{ kind: 'type', text: 'z' }}],
}});
assert.deepEqual(afterRelease, {{ ok: false, code: 'NOT_IN_CONTROL' }});
assert.equal(host.core.getStatus().availability, 'live');

await api.authority.intent(JSON.stringify({{
  schema: 'ui_intent/v0.2',
  request_id: 'req-retake-real-burst',
  op: 'take_control',
  params: {{ surface_id: surfaceId }},
}}));

console.error(`[MEASURED] 200-char burst @ 10ms intervals total elapsed: ${{totalElapsedMs.toFixed(1)}} ms`);
await wire.dispose();
await host.core.dispose();
"#,
            ui_dir = ui_dir.to_str().unwrap(),
            surface_id = surface_id,
            expected_text = expected_text,
        );
        fs::write(&driver_path, driver_src).unwrap();

        let node = std::env::var_os("NODE").unwrap_or_else(|| "node".into());
        let rt_dir_clone = runtime_dir.clone();
        let cfg_path_clone = ui_config_path.clone();
        let drv_path_clone = driver_path.clone();
        let node_out = tokio::task::spawn_blocking(move || {
            ProcessCommand::new(node)
                .arg(&drv_path_clone)
                .env("XDG_RUNTIME_DIR", &rt_dir_clone)
                .env("XDG_CONFIG_HOME", rt_dir_clone.join("config"))
                .env("MV_CORE_CONFIG", &cfg_path_clone)
                .output()
                .expect("spawn node burst driver")
        })
        .await
        .unwrap();

        let stderr = String::from_utf8_lossy(&node_out.stderr);
        eprintln!("{stderr}");
        assert!(
            node_out.status.success(),
            "node burst driver failed (rc={:?}):\nstdout: {}\nstderr: {}",
            node_out.status.code(),
            String::from_utf8_lossy(&node_out.stdout),
            stderr
        );

        let calls_raw = fs::read_to_string(paths.shm_root.join("srf-calls.jsonl")).unwrap();
        let calls: Vec<Value> = calls_raw
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect();
        let type_calls: Vec<&Value> = calls
            .iter()
            .filter(|v| {
                v["op"] == "input"
                    && v["argv"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|x| x == "--type-stdin"))
            })
            .collect();
        assert!(
            !type_calls.is_empty() && type_calls.len() < 200,
            "expected coalesced type calls (< 200), got {}",
            type_calls.len()
        );
        let received_text: String = type_calls
            .iter()
            .map(|v| v["stdin"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            received_text, expected_text,
            "all 200 typed characters must arrive at adapter in order without drops"
        );
        eprintln!(
            "[MEASURED] 200-char burst coalesced into {} native adapter text chunks",
            type_calls.len()
        );

        assert!(adapter.try_wait().unwrap().is_none());
        drop(agent);
        server_task.abort();
        let _ = server_task.await;
        let _ = adapter.kill();
        let _ = adapter.wait();
    });
}
