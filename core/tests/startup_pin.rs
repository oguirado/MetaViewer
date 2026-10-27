mod support;

use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

// [TARGET, unit decision] The compiled Cargo package version pins the core's
// trusted startup registration. No external dependency-pin ABI is needed.
struct Startup {
    child: Child,
    temp: support::Temp,
}
impl Startup {
    fn spawn(version: &str) -> Self {
        let temp = support::Temp::new();
        std::fs::set_permissions(&temp.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registration = |component: &str, version: &str| {
            json!({"endpoint":{"component":component,"instance":format!("{component}-startup")},
                "hello":{"schema":"hello/v0.2","contract_version":"v0.2",
                "component":component,"component_version":version,
                "component_commit":"0123456789abcdef0123456789abcdef01234567",
                "dependencies":[]}})
        };
        let config = temp.0.join("config.json");
        std::fs::write(
            &config,
            json!({"session_id":"startup-pin", "core":registration("core", version),
                "peers":[registration("agent", "0.2.0"), registration("daemon", "0.2.0")]})
            .to_string(),
        )
        .unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_metaviewer-core"))
            .env("MV_CORE_CONFIG", config)
            .env("XDG_RUNTIME_DIR", &temp.0)
            .env("XDG_STATE_HOME", temp.0.join("state"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        Self { child, temp }
    }
    fn stderr(&mut self) -> String {
        use std::io::Read;
        let mut text = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }
}
impl Drop for Startup {
    fn drop(&mut self) {
        let _ = self.child.kill();
        self.child.wait().unwrap();
    }
}

#[test]
fn startup_refuses_pin_mismatch_rc2() {
    let mut startup = Startup::spawn("mismatched-startup-pin");
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = startup.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "startup accepted a mismatched pin"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(status.code(), Some(2));
    let stderr = startup.stderr();
    assert!(
        stderr.contains("version") || stderr.contains("pin") || stderr.contains("PIN"),
        "{stderr}"
    );
    assert!(!startup.temp.0.join("metaviewer/core.sock").exists());
    assert!(!startup.temp.0.join("state").exists());
}

#[test]
fn startup_accepts_matching_pin() {
    let mut startup = Startup::spawn(env!("CARGO_PKG_VERSION"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = startup.child.try_wait().unwrap() {
            panic!("matching startup exited {status}: {}", startup.stderr());
        }
        if startup
            .temp
            .0
            .join("state/metaviewer/sessions/startup-pin/journal.jsonl")
            .is_file()
            && std::os::unix::net::UnixStream::connect(startup.temp.0.join("metaviewer/core.sock"))
                .is_ok()
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "matching startup did not become ready"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(startup.child.try_wait().unwrap().is_none());
    startup.child.kill().unwrap();
    startup.child.wait().unwrap();
    let stderr = startup.stderr();
    assert!(
        !stderr.contains("version") && !stderr.contains("pin") && !stderr.contains("PIN"),
        "{stderr}"
    );
}
