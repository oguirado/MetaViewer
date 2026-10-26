use metaviewer_core::supervisor::*;
use std::time::Duration;

fn limits() -> SupervisorLimits {
    SupervisorLimits {
        startup_timeout: Duration::from_secs(2),
        graceful_timeout: Duration::from_millis(30),
        reap_timeout: Duration::from_secs(2),
        poll_interval: Duration::from_millis(5),
        stderr_chunk_bytes: 1024,
        max_diagnostics_bytes: 4096,
        max_descendants: 128,
    }
}

#[test]
fn explicit_budgets_are_required() {
    assert!(Supervisor::new(limits()).is_ok());
    let mut bad = limits();
    bad.reap_timeout = Duration::ZERO;
    assert!(matches!(
        Supervisor::new(bad),
        Err(SupervisorError::InvalidConfig)
    ));
    let mut bad = limits();
    bad.max_descendants = 0;
    assert!(matches!(
        Supervisor::new(bad),
        Err(SupervisorError::InvalidConfig)
    ));
}

#[test]
fn environment_is_closed_even_when_explicitly_allowlisted() {
    for key in [
        "LD_PRELOAD",
        "DYLD_LIBRARY_PATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "NODE_OPTIONS",
        "ELECTRON_RUN_AS_NODE",
        "BASH_ENV",
        "ENV",
        "GCONV_PATH",
        "GLIBC_TUNABLES",
        "LOCPATH",
        "NLSPATH",
        "TZDIR",
    ] {
        assert!(!environment_key_allowed(key), "{key}");
    }
    assert!(!environment_key_allowed("bad=name"));
    assert!(!environment_key_allowed(""));
    assert!(environment_key_allowed("MV_FIXTURE"));
    assert!(environment_key_allowed("LANG"));
}

#[test]
fn no_runtime_or_relative_recipe_can_launch() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut s = Supervisor::new(limits()).unwrap();
        let mut spec = LaunchSpec {
            service: ServiceId::Daemon,
            program: std::env::current_exe().unwrap().canonicalize().unwrap(),
            args: Vec::new(),
            cwd: std::env::temp_dir().canonicalize().unwrap(),
            environment: Default::default(),
            initial_epoch: 0,
        };
        assert_eq!(
            s.start(spec.clone()).await.unwrap_err(),
            SupervisorError::InvalidEpoch
        );
        spec.initial_epoch = 1;
        assert_eq!(
            s.start(spec.clone()).await.unwrap_err(),
            SupervisorError::InvalidConfig
        );
        spec.program = "untrusted-relative".into();
        assert_eq!(
            s.start(spec).await.unwrap_err(),
            SupervisorError::InvalidConfig
        );
        assert_eq!(
            s.set_reaper_runtime("relative".into()),
            Err(SupervisorError::InvalidConfig)
        );
        assert_eq!(
            s.refresh_status(ServiceId::Daemon).await.unwrap_err(),
            SupervisorError::UnknownService
        );
    });
}
