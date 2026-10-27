#![forbid(unsafe_code)]
mod support;
use metaviewer_core::supervisor::*;
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

fn python() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("PATH required"))
        .map(|directory| directory.join("python3"))
        .find(|path| path.is_file())
        .expect("python3 fixture runtime required")
        .canonicalize()
        .unwrap()
}

// Each service has a child, grandchild and sibling that ignore SIGTERM.
// Every process publishes readiness only after its signal handler is installed.
const TREE: &str = r#"
import os, signal, subprocess, sys, time
leaf = '''import os, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(sys.argv[1], 'w') as f: f.write(str(os.getpid()))
time.sleep(60)
'''
branch = '''import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
subprocess.Popen([sys.executable, '-c', sys.argv[2], sys.argv[1] + '-grandchild'])
with open(sys.argv[1] + '-child', 'w') as f: f.write(str(os.getpid()))
time.sleep(60)
'''
subprocess.Popen([sys.executable, '-c', branch, sys.argv[1], leaf])
subprocess.Popen([sys.executable, '-c', leaf, sys.argv[1] + '-sibling'])
with open(sys.argv[1] + '-root', 'w') as f: f.write(str(os.getpid()))
time.sleep(60)
"#;

fn matching_processes(token: &[u8]) -> Vec<u32> {
    std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.unwrap();
            let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
            let command = std::fs::read(entry.path().join("cmdline")).ok()?;
            command
                .windows(token.len())
                .any(|window| window == token)
                .then_some(pid)
        })
        .collect()
}

#[test]
fn shutdown_reaps_all_children_and_sigterm_ignoring_grandchildren() {
    // Mutation: omit one service from Supervisor::reap_all's ids collection.
    // Runs unchanged inside a CI PID namespace; no namespace privilege required.
    support::run(async {
        let temp = support::Temp::new();
        let runtime = python();
        let mut supervisor = Supervisor::new(SupervisorLimits {
            startup_timeout: Duration::from_secs(3),
            graceful_timeout: Duration::from_millis(100),
            reap_timeout: Duration::from_secs(3),
            poll_interval: Duration::from_millis(10),
            stderr_chunk_bytes: 128,
            max_diagnostics_bytes: 128,
            max_descendants: 32,
        })
        .unwrap();
        supervisor.set_reaper_runtime(runtime.clone()).unwrap();
        let cwd = temp.0.join("empty-cwd");
        std::fs::create_dir(&cwd).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cwd, std::fs::Permissions::from_mode(0o555)).unwrap();
        let mut markers = Vec::new();
        for (service, name) in [(ServiceId::Daemon, "daemon"), (ServiceId::Agent, "agent")] {
            let marker = temp.0.join(name);
            markers.push(marker.clone());
            supervisor
                .start(LaunchSpec {
                    service,
                    program: runtime.clone(),
                    args: vec![
                        "-I".into(),
                        "-S".into(),
                        "-B".into(),
                        "-c".into(),
                        TREE.into(),
                        marker.into_os_string(),
                    ],
                    cwd: cwd.canonicalize().unwrap(),
                    environment: BTreeMap::new(),
                    initial_epoch: 1,
                })
                .await
                .unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let paths: Vec<_> = markers
            .iter()
            .flat_map(|marker| {
                ["root", "child", "grandchild", "sibling"]
                    .map(|suffix| PathBuf::from(format!("{}-{suffix}", marker.display())))
            })
            .collect();
        while !paths.iter().all(|path| {
            std::fs::read_to_string(path).is_ok_and(|value| value.parse::<u32>().is_ok())
        }) && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pids: Vec<_> = paths
            .iter()
            .filter_map(|path| std::fs::read_to_string(path).ok()?.parse::<u32>().ok())
            .collect();
        let token = temp.0.as_os_str().as_encoded_bytes();
        let before = matching_processes(token);
        // An unowned service cannot be stopped and must not affect live trees.
        let unknown = supervisor.stop(ServiceId::Vision).await;
        let alive_before = pids
            .iter()
            .all(|pid| std::path::Path::new(&format!("/proc/{pid}")).exists());
        let receipts = supervisor.reap_all().await;
        // Finish cleanup before assertions so an assertion cannot strand fixtures.
        assert_eq!(unknown, Err(SupervisorError::UnknownService));
        assert_eq!(pids.len(), 8, "fixtures failed to publish readiness");
        assert!(alive_before);
        assert!(
            pids.iter().all(|pid| before.contains(pid)),
            "independent /proc scan missed fixtures"
        );
        assert_eq!(receipts.len(), 2);
        for receipt in &receipts {
            assert!(receipt.complete, "{receipt:?}");
            assert!(receipt.surviving.is_empty(), "{receipt:?}");
            assert!(receipt.failures.is_empty(), "{receipt:?}");
        }
        for pid in pids {
            assert!(
                receipts.iter().any(|receipt| receipt.reaped.contains(&pid)),
                "missing reap evidence for {pid}"
            );
            assert!(
                !std::path::Path::new(&format!("/proc/{pid}")).exists(),
                "survivor or zombie {pid}"
            );
        }
        assert!(
            matching_processes(token).is_empty(),
            "orphan tree remains in /proc"
        );
        assert!(std::path::Path::new(&format!("/proc/{}", std::process::id())).exists());
    });
}
