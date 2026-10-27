use metaviewer_core::supervisor::*;
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

fn tool(name: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("PATH required"))
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("required fixture tool missing: {name}"))
        .canonicalize()
        .unwrap()
}

fn supervisor() -> Supervisor {
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
    supervisor.set_reaper_runtime(tool("python3")).unwrap();
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

struct NonExecutable(PathBuf);
impl Drop for NonExecutable {
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).unwrap();
    }
}

#[test]
fn non_executable_service_start_is_retryable() {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::temp_dir().join(format!("nv-nonexec-{}", std::process::id()));
    let fixture = NonExecutable(path.clone());
    std::fs::write(&path, b"not executable").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    run(async {
        let mut supervisor = supervisor();
        let recipe = spec(fixture.0.canonicalize().unwrap());
        let first = supervisor.start(recipe.clone()).await.unwrap_err();
        assert_eq!(first, SupervisorError::SpawnFailed { errno: Some(13) });
        assert_eq!(supervisor.start(recipe).await.unwrap_err(), first);
    });
}

#[test]
fn exited_service_start_is_retryable() {
    run(async {
        let mut supervisor = supervisor();
        let recipe = spec(tool("false"));
        let first = supervisor.start(recipe.clone()).await.unwrap_err();
        assert_eq!(first, SupervisorError::SpawnFailed { errno: None });
        assert_eq!(supervisor.start(recipe).await.unwrap_err(), first);
        // Failed initial attempts must not leave losses blocking a repaired recipe.
        let mut repaired = spec(tool("sleep"));
        repaired.args = vec!["30".into()];
        supervisor.start(repaired).await.unwrap();
        assert!(supervisor.take_losses().is_empty());
        supervisor
            .confirm_ready(ServiceId::Daemon, 1)
            .await
            .unwrap();
        supervisor
            .authorize_dispatch(ServiceId::Daemon, 1)
            .await
            .unwrap();
        assert!(supervisor.stop(ServiceId::Daemon).await.unwrap().complete);
    });
}

#[test]
fn running_and_successfully_stopped_services_reject_duplicate_start() {
    run(async {
        let mut supervisor = supervisor();
        let mut recipe = spec(tool("sleep"));
        recipe.args = vec!["30".into()];
        supervisor.start(recipe.clone()).await.unwrap();
        let duplicate = supervisor.start(recipe.clone()).await;
        assert!(supervisor.stop(ServiceId::Daemon).await.unwrap().complete);
        assert_eq!(duplicate.unwrap_err(), SupervisorError::AlreadyRunning);
        assert_eq!(
            supervisor.start(recipe).await.unwrap_err(),
            SupervisorError::AlreadyRunning
        );
    });
}
