use super::*;
use std::time::Duration;

fn limits() -> SupervisorLimits {
    SupervisorLimits {
        startup_timeout: Duration::from_millis(20),
        graceful_timeout: Duration::from_millis(1),
        reap_timeout: Duration::from_secs(1),
        poll_interval: Duration::from_secs(1),
        stderr_chunk_bytes: 128,
        max_diagnostics_bytes: 128,
        max_descendants: 4,
    }
}
fn spec() -> LaunchSpec {
    LaunchSpec {
        service: ServiceId::Daemon,
        program: std::env::current_exe().unwrap().canonicalize().unwrap(),
        args: vec![],
        cwd: std::env::temp_dir().canonicalize().unwrap(),
        environment: BTreeMap::new(),
        initial_epoch: 1,
    }
}
fn run(future: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future);
}
#[test]
fn v027_cr03_startup_sleep_respects_remaining_deadline() {
    run(async {
        let mut supervisor = Supervisor::new(limits()).unwrap();
        supervisor
            .set_reaper_runtime(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("src/supervisor/testdata/receipt-runtime.sh")
                    .canonicalize()
                    .unwrap(),
            )
            .unwrap();
        let started = Instant::now();
        let result = supervisor.start(spec()).await;
        let elapsed = started.elapsed();
        // Cleanup may use a full poll interval; startup must not add another.
        assert_eq!(result.unwrap_err(), SupervisorError::DeadlineExceeded);
        assert!(
            elapsed < Duration::from_millis(1600),
            "startup overshot: {elapsed:?}"
        );
    });
}
#[test]
fn v027_cr03_stop_sleep_respects_remaining_deadline() {
    run(async {
        let mut limits = limits();
        limits.graceful_timeout = Duration::from_millis(200);
        let mut supervisor = Supervisor::new(limits.clone()).unwrap();
        let spec = spec();
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/supervisor/testdata/v027-delayed-stop.sh");
        let process = OwnedProcess::spawn(&runtime, &spec, &limits).unwrap();
        supervisor.entries.insert(
            spec.service,
            Entry {
                epoch: spec.initial_epoch,
                spec,
                lifecycle: Lifecycle::Starting,
                started: Instant::now(),
                process: Some(process),
                loss_recorded: false,
                receipt: None,
            },
        );
        let started = Instant::now();
        let receipt = supervisor.stop_inner(ServiceId::Daemon).await.unwrap();
        let elapsed = started.elapsed();
        // Reap the synthetic child even when the timing assertion will fail.
        if let Some(process) = supervisor
            .entries
            .get_mut(&ServiceId::Daemon)
            .unwrap()
            .process
            .as_mut()
        {
            process.child.wait().unwrap();
            while !process.readers_finished() {
                std::thread::yield_now();
            }
        }
        assert!(
            !receipt.complete,
            "terminal proof arrived after the stop deadline"
        );
        assert!(
            elapsed < Duration::from_millis(5700),
            "stop overshot: {elapsed:?}"
        );
    });
}
