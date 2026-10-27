use metaviewer_core::supervisor::*;
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

fn tool(name: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("PATH required"))
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("required fixture tool missing: {name}"))
        .canonicalize()
        .unwrap()
}

fn supervisor(runtime: PathBuf) -> Supervisor {
    let mut supervisor = Supervisor::new(SupervisorLimits {
        startup_timeout: Duration::from_secs(2),
        graceful_timeout: Duration::from_millis(50),
        reap_timeout: Duration::from_secs(2),
        poll_interval: Duration::from_millis(50),
        stderr_chunk_bytes: 128,
        max_diagnostics_bytes: 128,
        max_descendants: 4,
    })
    .unwrap();
    supervisor.set_reaper_runtime(runtime).unwrap();
    supervisor
}

fn spec(program: PathBuf) -> LaunchSpec {
    LaunchSpec {
        service: ServiceId::Daemon,
        program,
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
fn completed_failed_start_retries_to_ready_without_draining_losses() {
    run(async {
        let mut supervisor = supervisor(tool("python3"));
        for _ in 0..2 {
            assert_eq!(
                supervisor.start(spec(tool("false"))).await.unwrap_err(),
                SupervisorError::SpawnFailed { errno: None }
            );
        }
        let mut repaired = spec(tool("sleep"));
        repaired.args = vec!["30".into()];
        supervisor.start(repaired).await.unwrap();
        let ready = supervisor.confirm_ready(ServiceId::Daemon, 1).await;
        let dispatch = supervisor.authorize_dispatch(ServiceId::Daemon, 1).await;
        let receipt = supervisor.stop(ServiceId::Daemon).await.unwrap();
        assert!(receipt.complete);
        assert_eq!(ready.as_ref().unwrap().lifecycle, Lifecycle::Ready);
        assert!(ready.unwrap().available);
        assert_eq!(dispatch, Ok(()));
        let losses = supervisor.take_losses();
        assert_eq!(losses.len(), 1);
        assert_eq!(losses[0].reason, LossReason::Shutdown);
    });
}

#[test]
fn incomplete_start_cleanup_retains_entry_and_loss() {
    run(async {
        // A failing runtime supplies no cleanup evidence. It exits immediately,
        // so this control leaves no live child.
        let mut supervisor = supervisor(tool("false"));
        let recipe = spec(tool("false"));
        assert_eq!(
            supervisor.start(recipe.clone()).await.unwrap_err(),
            SupervisorError::CleanupIncomplete
        );
        assert_eq!(
            supervisor.start(recipe).await.unwrap_err(),
            SupervisorError::AlreadyRunning
        );
        let status = supervisor.refresh_status(ServiceId::Daemon).await.unwrap();
        assert_eq!(status.lifecycle, Lifecycle::Unavailable);
        assert!(!status.available);
        assert_eq!(
            supervisor.authorize_dispatch(ServiceId::Daemon, 1).await,
            Err(SupervisorError::Unavailable)
        );
        assert!(!supervisor.stop(ServiceId::Daemon).await.unwrap().complete);
        let losses = supervisor.take_losses();
        assert_eq!(losses.len(), 1);
        assert_eq!(losses[0].reason, LossReason::Exit);
    });
}
