use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, time::Duration};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum ServiceId {
    Daemon,
    Agent,
    Vision,
    Executor,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Lifecycle {
    Stopped,
    Starting,
    Ready,
    Unavailable,
    Stopping,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LossReason {
    Exit,
    Eof,
    WaitFailed,
    IoFailed,
    ProtocolRejected,
    StartTimeout,
    ExplicitRestart,
    Resume,
    Shutdown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorError {
    InvalidConfig,
    InvalidEpoch,
    UnknownService,
    AlreadyRunning,
    ShuttingDown,
    SpawnFailed,
    Unavailable,
    StaleEpoch,
    EpochOverflow,
    UnsafeTarget,
    OwnershipLost,
    DeadlineExceeded,
    CleanupIncomplete,
}
#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub service: ServiceId,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
    pub initial_epoch: u64,
}
#[derive(Clone, Debug)]
pub struct SupervisorLimits {
    pub startup_timeout: Duration,
    pub graceful_timeout: Duration,
    pub reap_timeout: Duration,
    pub poll_interval: Duration,
    pub stderr_chunk_bytes: usize,
    pub max_diagnostics_bytes: usize,
    pub max_descendants: usize,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupervisorStatus {
    pub service: ServiceId,
    pub lifecycle: Lifecycle,
    pub available: bool,
    pub service_epoch: u64,
    pub pid: Option<u32>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceLoss {
    pub service: ServiceId,
    pub service_epoch: u64,
    pub reason: LossReason,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReapReceipt {
    pub service: ServiceId,
    pub service_epoch: u64,
    pub reaped: Vec<u32>,
    pub surviving: Vec<u32>,
    pub failures: Vec<SupervisorError>,
    pub complete: bool,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Diagnostics {
    pub retained_bytes: usize,
    pub dropped_bytes: u64,
}
