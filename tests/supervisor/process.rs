use metaviewer_core::supervisor::*;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn setup() -> (Supervisor, PathBuf) {
    let status = std::fs::read_to_string("/proc/1/status").unwrap();
    assert!(
        !status.lines().any(|line| line == "Name:\tsystemd"),
        "process gate requires a PID namespace"
    );
    assert_eq!(std::env::var("MV_SUPERVISOR_NAMESPACE").as_deref(), Ok("1"));
    let python =
        PathBuf::from(std::env::var_os("MV_TEST_PYTHON").expect("explicit test interpreter"));
    let mut supervisor = Supervisor::new(SupervisorLimits {
        startup_timeout: Duration::from_secs(3),
        graceful_timeout: Duration::from_millis(40),
        reap_timeout: Duration::from_secs(3),
        poll_interval: Duration::from_millis(5),
        stderr_chunk_bytes: 1024,
        max_diagnostics_bytes: 4096,
        max_descendants: 128,
    })
    .unwrap();
    supervisor.set_reaper_runtime(python.clone()).unwrap();
    (supervisor, python)
}

fn spec(python: &std::path::Path, code: &str, epoch: u64) -> LaunchSpec {
    LaunchSpec {
        service: ServiceId::Daemon,
        program: python.to_owned(),
        args: ["-I", "-S", "-B", "-c", code].map(OsString::from).to_vec(),
        cwd: std::env::temp_dir().canonicalize().unwrap(),
        environment: BTreeMap::new(),
        initial_epoch: epoch,
    }
}

const SLEEP: &str = "import time; time.sleep(60)";

#[test]
fn live_readiness_death_and_single_flight() {
    run(async {
        let (mut s, python) = setup();
        let launch = spec(&python, SLEEP, 1);
        let started = s.start(launch.clone()).await.unwrap();
        assert_eq!(started.lifecycle, Lifecycle::Starting);
        assert!(!started.available);
        assert_eq!(
            s.authorize_dispatch(ServiceId::Daemon, 1)
                .await
                .unwrap_err(),
            SupervisorError::Unavailable
        );
        assert_eq!(
            s.start(launch).await.unwrap_err(),
            SupervisorError::AlreadyRunning
        );
        assert_eq!(
            s.confirm_ready(ServiceId::Daemon, 2).await.unwrap_err(),
            SupervisorError::StaleEpoch
        );
        assert!(
            s.confirm_ready(ServiceId::Daemon, 1)
                .await
                .unwrap()
                .available
        );
        s.authorize_dispatch(ServiceId::Daemon, 1).await.unwrap();
        s.report_loss(ServiceId::Daemon, 1, LossReason::Eof)
            .await
            .unwrap();
        s.report_loss(ServiceId::Daemon, 1, LossReason::IoFailed)
            .await
            .unwrap();
        assert!(!s.refresh_status(ServiceId::Daemon).await.unwrap().available);
        assert_eq!(
            s.authorize_dispatch(ServiceId::Daemon, 1)
                .await
                .unwrap_err(),
            SupervisorError::Unavailable
        );
        assert_eq!(
            s.confirm_ready(ServiceId::Daemon, 1).await.unwrap_err(),
            SupervisorError::Unavailable
        );
        assert_eq!(s.take_losses().len(), 1);
        assert!(!s.refresh_status(ServiceId::Daemon).await.unwrap().available);
        let receipt = s.stop(ServiceId::Daemon).await.unwrap();
        assert!(receipt.complete, "{receipt:?}");
        assert!(s.stop(ServiceId::Daemon).await.unwrap().complete);
        assert!(!std::path::Path::new(&format!("/proc/{}", started.pid.unwrap())).exists());
    });
}

#[test]
fn restart_failure_consumes_epoch_and_resume_revokes() {
    run(async {
        let (mut s, python) = setup();
        let dir = std::env::temp_dir().join(format!("supervisor-restart-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let mut launch = spec(&python, SLEEP, 1);
        launch.cwd = dir.clone();
        s.start(launch).await.unwrap();
        s.confirm_ready(ServiceId::Daemon, 1).await.unwrap();
        std::fs::remove_dir(&dir).unwrap();
        assert_eq!(
            s.restart(ServiceId::Daemon).await.unwrap_err(),
            SupervisorError::SpawnFailed
        );
        assert_eq!(
            s.refresh_status(ServiceId::Daemon)
                .await
                .unwrap()
                .service_epoch,
            2
        );
        assert_eq!(s.take_losses()[0].reason, LossReason::ExplicitRestart);
        std::fs::create_dir(&dir).unwrap();
        assert_eq!(s.restart(ServiceId::Daemon).await.unwrap().service_epoch, 3);
        s.take_losses();
        s.confirm_ready(ServiceId::Daemon, 3).await.unwrap();
        assert_eq!(
            s.revoke_for_resume().await.unwrap()[0].reason,
            LossReason::Resume
        );
        assert_eq!(
            s.confirm_ready(ServiceId::Daemon, 3).await.unwrap_err(),
            SupervisorError::StaleEpoch
        );
        assert!(s.reap_all().await.iter().all(|r| r.complete));
        assert_eq!(
            s.start(spec(&python, SLEEP, 5)).await.unwrap_err(),
            SupervisorError::ShuttingDown
        );
        std::fs::remove_dir(&dir).unwrap();
    });
}

#[test]
fn shutdown_reaps_detached_tree_and_preserves_unrelated_child() {
    run(async {
        let (mut s, python) = setup();
        let mut sentinel = std::process::Command::new(&python)
            .args(["-I", "-S", "-B", "-c", "import time; time.sleep(1)"])
            .spawn()
            .unwrap();
        let code = "import os,signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\npid=os.fork()\nif pid == 0:\n os.setsid()\n os.fork()\nwhile True: time.sleep(.01)";
        let status = s.start(spec(&python, code, 1)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let receipts = s.reap_all().await;
        assert_eq!(receipts.len(), 1);
        assert!(receipts[0].complete, "{:?}", receipts[0]);
        assert!(receipts[0].reaped.len() >= 4, "{:?}", receipts[0]);
        for pid in &receipts[0].reaped {
            assert!(
                !std::path::Path::new(&format!("/proc/{pid}")).exists(),
                "owned orphan {pid}"
            );
        }
        assert!(receipts[0].reaped.contains(&status.pid.unwrap()));
        assert!(sentinel.try_wait().unwrap().is_none());
        assert!(sentinel.wait().unwrap().success());
    });
}

#[test]
fn stderr_flood_is_bounded_and_environment_scrubbed() {
    run(async {
        let (mut s, python) = setup();
        let code = "import os,sys,time\nassert 'LD_PRELOAD' not in os.environ\nassert 'PYTHONPATH' not in os.environ\nassert set(os.environ) <= {'MV_FIXTURE','LC_CTYPE'}\nassert os.environ['MV_FIXTURE']=='kept'\nsys.stderr.write('x'*200000);sys.stderr.flush()\ntime.sleep(60)";
        let mut launch = spec(&python, code, 1);
        for (key, val) in [
            ("MV_FIXTURE", "kept"),
            ("LD_PRELOAD", "forbidden"),
            ("PYTHONPATH", "forbidden"),
        ] {
            launch.environment.insert(key.into(), val.into());
        }
        assert_eq!(s.start(launch.clone()).await.unwrap_err(), SupervisorError::InvalidConfig);
        launch.environment.retain(|key, _| key == "MV_FIXTURE");
        s.start(launch).await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            s.confirm_ready(ServiceId::Daemon, 1)
                .await
                .unwrap()
                .available
        );
        let diagnostics = s.diagnostics(ServiceId::Daemon).unwrap();
        assert!(diagnostics.retained_bytes <= 4096);
        assert!(diagnostics.dropped_bytes > 0);
        assert!(s.reap_all().await[0].complete);
    });
}

#[test]
fn unexpected_exit_blocks_readiness_without_respawn() {
    run(async {
        let (mut s, python) = setup();
        s.start(spec(&python, "import time; time.sleep(.1)", 1))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(!s.refresh_status(ServiceId::Daemon).await.unwrap().available);
        assert_eq!(
            s.confirm_ready(ServiceId::Daemon, 1).await.unwrap_err(),
            SupervisorError::Unavailable
        );
        assert_eq!(s.take_losses()[0].reason, LossReason::Exit);
        assert!(s.reap_all().await[0].complete);
    });
}

#[test]
fn epoch_overflow_never_wraps_or_relaunches() {
    run(async {
        let (mut s, python) = setup();
        s.start(spec(&python, SLEEP, u64::MAX)).await.unwrap();
        assert_eq!(
            s.restart(ServiceId::Daemon).await.unwrap_err(),
            SupervisorError::EpochOverflow
        );
        let status = s.refresh_status(ServiceId::Daemon).await.unwrap();
        assert_eq!(status.service_epoch, u64::MAX);
        assert!(!status.available);
        assert!(s.reap_all().await[0].complete);
    });
}

#[test]
fn parent_exit_and_racing_forks_are_reaped() {
    run(async {
        let (mut s, python) = setup();
        let code = "import os,time\ntime.sleep(.05)\nif os.fork() != 0: os._exit(0)\nos.setsid()\nfor i in range(20):\n if os.fork() == 0:\n  time.sleep(60);os._exit(0)\n time.sleep(.002)\ntime.sleep(60)";
        s.start(spec(&python, code, 1)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!s.refresh_status(ServiceId::Daemon).await.unwrap().available);
        let receipt = s.reap_all().await.remove(0);
        assert!(receipt.complete, "{receipt:?}");
        assert!(receipt.reaped.len() >= 3);
        for pid in receipt.reaped {
            assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
        }
    });
}

#[test]
fn fresh_restart_stays_blocked_until_loss_is_consumed() {
    run(async {
        let (mut s, python) = setup();
        s.start(spec(&python, SLEEP, 1)).await.unwrap();
        s.confirm_ready(ServiceId::Daemon, 1).await.unwrap();
        let status = s.restart(ServiceId::Daemon).await.unwrap();
        assert_eq!(status.service_epoch, 2);
        assert!(
            !s.confirm_ready(ServiceId::Daemon, 2)
                .await
                .unwrap()
                .available
        );
        assert_eq!(
            s.authorize_dispatch(ServiceId::Daemon, 2).await,
            Err(SupervisorError::Unavailable)
        );
        assert_eq!(
            s.restart(ServiceId::Daemon).await.unwrap_err(),
            SupervisorError::Unavailable
        );
        assert_eq!(s.take_losses().len(), 1);
        s.authorize_dispatch(ServiceId::Daemon, 2).await.unwrap();
        assert!(s.reap_all().await[0].complete);
    });
}

#[test]
fn shutdown_visits_every_service_and_preserves_all_receipts() {
    run(async {
        let (mut s, python) = setup();
        let dir = std::env::temp_dir().join(format!("supervisor-readonly-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        s.start(spec(&python, SLEEP, 1)).await.unwrap();
        for service in [ServiceId::Agent, ServiceId::Vision, ServiceId::Executor] {
            let mut launch = spec(&python, SLEEP, 1);
            launch.service = service;
            launch.cwd = dir.clone();
            s.start(launch).await.unwrap();
        }
        let receipts = s.reap_all().await;
        assert_eq!(receipts.len(), 4);
        assert!(
            receipts.iter().all(|receipt| receipt.complete),
            "{receipts:?}"
        );
        assert_eq!(s.reap_all().await, receipts);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir(dir).unwrap();
    });
}

#[test]
fn unauthenticated_startup_expires_and_requires_cleanup() {
    run(async {
        let (mut s, python) = setup();
        let status = s.start(spec(&python, SLEEP, 1)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(3100)).await;
        assert!(!s.refresh_status(ServiceId::Daemon).await.unwrap().available);
        assert_eq!(
            s.confirm_ready(ServiceId::Daemon, 1).await.unwrap_err(),
            SupervisorError::Unavailable
        );
        assert_eq!(s.take_losses()[0].reason, LossReason::StartTimeout);
        assert!(s.reap_all().await[0].complete);
        assert!(!std::path::Path::new(&format!("/proc/{}", status.pid.unwrap())).exists());
    });
}

#[test]
fn fast_exit_has_complete_cleanup() {
    run(async {
        let (mut s, python) = setup();
        let result = s.start(spec(&python, "pass", 1)).await;
        assert!(result.is_ok() || matches!(result, Err(SupervisorError::SpawnFailed)));
        let receipt = s.stop(ServiceId::Daemon).await.unwrap();
        assert!(receipt.complete, "{receipt:?}");
        assert!(receipt.surviving.is_empty());
    });
}

#[test]
fn cumulative_descendants_do_not_exhaust_live_cap() {
    run(async {
        let (_, python) = setup();
        // Same live cap, more cumulative children than slots.
        let mut s = Supervisor::new(SupervisorLimits {
            startup_timeout: Duration::from_secs(3), graceful_timeout: Duration::from_millis(40),
            reap_timeout: Duration::from_secs(3), poll_interval: Duration::from_millis(5),
            stderr_chunk_bytes: 1024, max_diagnostics_bytes: 4096, max_descendants: 4,
        }).unwrap();
        s.set_reaper_runtime(python.clone()).unwrap();
        let code = "import os,time,ctypes\nctypes.CDLL(None).prctl(15,b'bad\\xff)comm',0,0,0)\nfor i in range(6):\n pid=os.fork()\n if pid==0:\n  if os.fork()==0: time.sleep(.02)\n  os._exit(0)\n os.waitpid(pid,0)\n time.sleep(.08)\ntime.sleep(60)";
        s.start(spec(&python, code, 1)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(s.confirm_ready(ServiceId::Daemon, 1).await.unwrap().available);
        assert!(s.take_losses().is_empty());
        assert!(s.stop(ServiceId::Daemon).await.unwrap().complete);
    });
}

#[test]
fn overflow_drains_even_unretained_descendants() {
    run(async {
        let (_, python) = setup();
        let mut s = Supervisor::new(SupervisorLimits {
            startup_timeout: Duration::from_secs(3), graceful_timeout: Duration::from_millis(40),
            reap_timeout: Duration::from_secs(3), poll_interval: Duration::from_millis(5),
            stderr_chunk_bytes: 1024, max_diagnostics_bytes: 4096, max_descendants: 4,
        }).unwrap();
        s.set_reaper_runtime(python.clone()).unwrap();
        let path = std::env::temp_dir().join(format!("supervisor-overflow-{}", std::process::id()));
        let mut launch = spec(&python, "import os,time\nf=open(os.environ['MV_PID_FILE'],'a',buffering=1)\nf.write(str(os.getpid())+'\\n')\ntime.sleep(.05)\nfor i in range(12):\n if os.fork()==0:\n  f.write(str(os.getpid())+'\\n');time.sleep(60);os._exit(0)\ntime.sleep(60)", 1);
        launch.environment.insert("MV_PID_FILE".into(), path.clone().into_os_string());
        s.start(launch).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _receipt = s.stop(ServiceId::Daemon).await.unwrap();
        let pids = std::fs::read_to_string(&path).unwrap();
        assert!(!pids.is_empty());
        for pid in pids.lines() {
            assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists(), "overflow survivor {pid}");
        }
        std::fs::remove_file(path).unwrap();
    });
}

#[test]
fn service_environment_does_not_reach_reaper() {
    run(async {
        let (mut s, python) = setup();
        let mut launch = spec(&python, "import os,time\nassert os.environ['MV_FIXTURE']=='target-only'\ntime.sleep(60)", 1);
        launch.environment.insert("MV_FIXTURE".into(), "target-only".into());
        let status = s.start(launch).await.unwrap();
        let stat = std::fs::read_to_string(format!("/proc/{}/stat", status.pid.unwrap())).unwrap();
        let parent = stat.rsplit_once(')').unwrap().1.split_whitespace().nth(1).unwrap();
        let environment = std::fs::read(format!("/proc/{parent}/environ")).unwrap();
        assert!(environment.is_empty(), "service environment leaked to runtime");
        assert!(s.confirm_ready(ServiceId::Daemon, 1).await.unwrap().available);
        assert!(s.stop(ServiceId::Daemon).await.unwrap().complete);
    });
}
