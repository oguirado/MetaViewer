//! Serialized lifecycle owner; authenticated transport alone confirms readiness.
//! [TARGET, unit decision] A configured bundled Python interpreter runs a private
//! per-service subreaper, preserving the crate's unsafe-code prohibition. Service
//! traffic stays on authenticated sockets; stdout/stdin of the reaper are private
//! lifecycle evidence/control pipes. No interpreter or launch recipe is inferred.
//! Python exposes pidfds and the subreaper syscall without unsafe Rust. The host
//! supplies a canonical absolute interpreter path through set_reaper_runtime;
//! Command uses that exact path and never searches PATH for an interpreter.
//! [TARGET, unit decision] Limits are caller supplied, capped at a minute and
//! bounded storage; explicit restart requires draining losses. Resume revokes and
//! stops services without automatic recovery. Core consumes losses before effects.
//! [TARGET, unit decision] Spawn failures preserve the optional OS errno through
//! the public error; synthetic pipe/evidence failures have no OS errno. Executable
//! test fixtures are immutable repository files, excluding inherited-writer races.
//! Scope: this module implements lifecycle authority within the admitted corpus.
mod launch;
mod process;
mod types;
pub use launch::environment_key_allowed;
pub use types::*;

use process::OwnedProcess;
use std::{collections::BTreeMap, path::PathBuf, time::Instant};

struct Entry {
    spec: LaunchSpec,
    epoch: u64,
    lifecycle: Lifecycle,
    started: Instant,
    process: Option<OwnedProcess>,
    loss_recorded: bool,
    receipt: Option<ReapReceipt>,
}

pub struct Supervisor {
    limits: SupervisorLimits,
    runtime: Option<PathBuf>,
    entries: BTreeMap<ServiceId, Entry>,
    losses: Vec<ServiceLoss>,
    shutting_down: bool,
}

impl Supervisor {
    pub fn new(limits: SupervisorLimits) -> Result<Self, SupervisorError> {
        launch::validate_limits(&limits)?;
        Ok(Self {
            limits,
            runtime: None,
            entries: BTreeMap::new(),
            losses: Vec::new(),
            shutting_down: false,
        })
    }

    /// The host validates the interpreter against its pinned bundle before setting it.
    pub fn set_reaper_runtime(&mut self, path: PathBuf) -> Result<(), SupervisorError> {
        if !self.entries.is_empty() || !launch::canonical_file(&path) {
            return Err(SupervisorError::InvalidConfig);
        }
        self.runtime = Some(path);
        Ok(())
    }

    pub async fn start(&mut self, spec: LaunchSpec) -> Result<SupervisorStatus, SupervisorError> {
        if self.shutting_down {
            return Err(SupervisorError::ShuttingDown);
        }
        // Repeated start cannot reset a stopped service's authority generation.
        if self.entries.contains_key(&spec.service) {
            return Err(SupervisorError::AlreadyRunning);
        }
        launch::validate(&spec)?;
        if self.runtime.is_none() {
            return Err(SupervisorError::InvalidConfig);
        }
        let id = spec.service;
        self.entries.insert(
            id,
            Entry {
                epoch: spec.initial_epoch,
                spec,
                lifecycle: Lifecycle::Stopped,
                started: Instant::now(),
                process: None,
                loss_recorded: false,
                receipt: None,
            },
        );
        let result = self.launch(id).await;
        if result.is_err()
            && self
                .entries
                .get(&id)
                .is_some_and(|e| e.process.is_none() && e.receipt.is_none())
        {
            self.entries.remove(&id);
        }
        result
    }

    async fn launch(&mut self, id: ServiceId) -> Result<SupervisorStatus, SupervisorError> {
        let e = self
            .entries
            .get_mut(&id)
            .ok_or(SupervisorError::UnknownService)?;
        e.started = Instant::now();
        e.lifecycle = Lifecycle::Starting;
        e.loss_recorded = false;
        e.receipt = None;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or(SupervisorError::InvalidConfig)?;
        let process = OwnedProcess::spawn(runtime, &e.spec, &self.limits);
        match process {
            Ok(p) => e.process = Some(p),
            Err(error) => {
                e.lifecycle = Lifecycle::Unavailable;
                return Err(error);
            }
        }
        // Private spawn acknowledgement does not authenticate the service.
        loop {
            let e = self
                .entries
                .get_mut(&id)
                .ok_or(SupervisorError::UnknownService)?;
            let p = e.process.as_mut().ok_or(SupervisorError::Unavailable)?;
            if p.pid().is_some() && p.valid() && p.root_alive() {
                return self.status(id);
            }
            if p.poll()?.is_some() || !p.valid() {
                self.record_loss(id, LossReason::Exit)?;
                let receipt = self.stop_inner(id).await?;
                return Err(if receipt.complete {
                    SupervisorError::SpawnFailed { errno: None }
                } else {
                    SupervisorError::CleanupIncomplete
                });
            }
            if e.started.elapsed() >= self.limits.startup_timeout {
                self.record_loss(id, LossReason::StartTimeout)?;
                let receipt = self.stop_inner(id).await?;
                return Err(if receipt.complete {
                    SupervisorError::DeadlineExceeded
                } else {
                    SupervisorError::CleanupIncomplete
                });
            }
            tokio::time::sleep(self.limits.poll_interval).await;
        }
    }

    fn status(&self, id: ServiceId) -> Result<SupervisorStatus, SupervisorError> {
        let e = self
            .entries
            .get(&id)
            .ok_or(SupervisorError::UnknownService)?;
        Ok(SupervisorStatus {
            service: id,
            lifecycle: e.lifecycle,
            available: e.lifecycle == Lifecycle::Ready
                && !e.loss_recorded
                && !self.shutting_down
                && !self.losses.iter().any(|loss| loss.service == id),
            service_epoch: e.epoch,
            pid: e.process.as_ref().and_then(OwnedProcess::pid),
        })
    }

    fn record_loss(&mut self, id: ServiceId, reason: LossReason) -> Result<(), SupervisorError> {
        let e = self
            .entries
            .get_mut(&id)
            .ok_or(SupervisorError::UnknownService)?;
        e.lifecycle = Lifecycle::Unavailable;
        if !e.loss_recorded {
            self.losses.push(ServiceLoss {
                service: id,
                service_epoch: e.epoch,
                reason,
            });
            e.loss_recorded = true;
        }
        Ok(())
    }

    pub async fn refresh_status(
        &mut self,
        id: ServiceId,
    ) -> Result<SupervisorStatus, SupervisorError> {
        let e = self
            .entries
            .get_mut(&id)
            .ok_or(SupervisorError::UnknownService)?;
        if matches!(e.lifecycle, Lifecycle::Starting | Lifecycle::Ready) {
            let reason = match e.process.as_mut() {
                Some(p) => match p.poll() {
                    Err(_) => Some(LossReason::WaitFailed),
                    Ok(Some(_)) => Some(LossReason::Exit),
                    Ok(None) if !p.valid() || !p.root_alive() => Some(LossReason::Exit),
                    Ok(None)
                        if e.lifecycle == Lifecycle::Starting
                            && e.started.elapsed() >= self.limits.startup_timeout =>
                    {
                        Some(LossReason::StartTimeout)
                    }
                    _ => None,
                },
                None => Some(LossReason::Exit),
            };
            if let Some(reason) = reason {
                self.record_loss(id, reason)?;
            }
        }
        self.status(id)
    }

    /// Caller must authenticate the contract hello and serialize with admission.
    pub async fn confirm_ready(
        &mut self,
        id: ServiceId,
        epoch: u64,
    ) -> Result<SupervisorStatus, SupervisorError> {
        let status = self.refresh_status(id).await?;
        if status.service_epoch != epoch {
            return Err(SupervisorError::StaleEpoch);
        }
        if self.shutting_down || !matches!(status.lifecycle, Lifecycle::Starting | Lifecycle::Ready)
        {
            return Err(SupervisorError::Unavailable);
        }
        self.entries
            .get_mut(&id)
            .ok_or(SupervisorError::UnknownService)?
            .lifecycle = Lifecycle::Ready;
        self.status(id)
    }

    pub async fn report_loss(
        &mut self,
        id: ServiceId,
        epoch: u64,
        reason: LossReason,
    ) -> Result<(), SupervisorError> {
        if self.status(id)?.service_epoch != epoch {
            return Err(SupervisorError::StaleEpoch);
        }
        self.record_loss(id, reason)
    }
    /// Call immediately before a core handoff, under the same serialized owner.
    pub async fn authorize_dispatch(
        &mut self,
        id: ServiceId,
        epoch: u64,
    ) -> Result<(), SupervisorError> {
        let status = self.refresh_status(id).await?;
        if status.service_epoch != epoch {
            return Err(SupervisorError::StaleEpoch);
        }
        if !status.available {
            return Err(SupervisorError::Unavailable);
        }
        Ok(())
    }
    pub fn take_losses(&mut self) -> Vec<ServiceLoss> {
        std::mem::take(&mut self.losses)
    }
    pub fn diagnostics(&self, id: ServiceId) -> Result<Diagnostics, SupervisorError> {
        self.entries
            .get(&id)
            .ok_or(SupervisorError::UnknownService)?
            .process
            .as_ref()
            .map(OwnedProcess::diagnostics)
            .ok_or(SupervisorError::Unavailable)
    }

    pub async fn restart(&mut self, id: ServiceId) -> Result<SupervisorStatus, SupervisorError> {
        if self.shutting_down {
            return Err(SupervisorError::ShuttingDown);
        }
        if self.losses.iter().any(|loss| loss.service == id) {
            return Err(SupervisorError::Unavailable);
        }
        self.record_loss(id, LossReason::ExplicitRestart)?;
        if !self.stop_inner(id).await?.complete {
            return Err(SupervisorError::CleanupIncomplete);
        }
        let e = self
            .entries
            .get_mut(&id)
            .ok_or(SupervisorError::UnknownService)?;
        e.epoch = e
            .epoch
            .checked_add(1)
            .ok_or(SupervisorError::EpochOverflow)?;
        self.launch(id).await
    }

    pub async fn revoke_for_resume(&mut self) -> Result<Vec<ServiceLoss>, SupervisorError> {
        let ids: Vec<_> = self.entries.keys().copied().collect();
        let mut losses = Vec::new();
        let mut failure = false;
        for id in ids {
            self.record_loss(id, LossReason::Resume)?;
            let e = self
                .entries
                .get_mut(&id)
                .ok_or(SupervisorError::UnknownService)?;
            losses.push(ServiceLoss {
                service: id,
                service_epoch: e.epoch,
                reason: LossReason::Resume,
            });
            if let Some(next) = e.epoch.checked_add(1) {
                e.epoch = next;
            } else {
                failure = true;
            }
            failure |= !self.stop_inner(id).await?.complete;
        }
        if failure {
            Err(SupervisorError::CleanupIncomplete)
        } else {
            Ok(losses)
        }
    }

    pub async fn stop(&mut self, id: ServiceId) -> Result<ReapReceipt, SupervisorError> {
        if !matches!(
            self.status(id)?.lifecycle,
            Lifecycle::Stopped | Lifecycle::Unavailable
        ) {
            self.record_loss(id, LossReason::Shutdown)?;
        }
        self.stop_inner(id).await
    }

    async fn stop_inner(&mut self, id: ServiceId) -> Result<ReapReceipt, SupervisorError> {
        let e = self
            .entries
            .get_mut(&id)
            .ok_or(SupervisorError::UnknownService)?;
        if let Some(receipt) = e.receipt.as_ref().filter(|receipt| receipt.complete) {
            return Ok(receipt.clone());
        }
        e.lifecycle = Lifecycle::Stopping;
        let mut receipt = ReapReceipt {
            service: id,
            service_epoch: e.epoch,
            reaped: Vec::new(),
            surviving: Vec::new(),
            failures: Vec::new(),
            complete: true,
        };
        if let Some(p) = e.process.as_mut() {
            if let Err(err) = p.request_stop() {
                receipt.failures.push(err);
            }
            let until = Instant::now()
                + self.limits.graceful_timeout
                + self.limits.reap_timeout
                + self.limits.poll_interval * 4;
            loop {
                match p.poll() {
                    Ok(Some(_)) if p.readers_finished() => break,
                    Err(err) => {
                        receipt.failures.push(err);
                        break;
                    }
                    _ => {}
                }
                if Instant::now() >= until {
                    receipt.failures.push(SupervisorError::DeadlineExceeded);
                    break;
                }
                tokio::time::sleep(self.limits.poll_interval).await;
            }
            match p.finish() {
                Ok(reaped) => receipt.reaped = reaped,
                Err(err) => {
                    receipt.failures.push(err);
                    receipt.surviving.push(p.child.id());
                    if let Some(pid) = p.pid() {
                        receipt.surviving.push(pid);
                    }
                }
            }
        }
        receipt.complete = receipt.failures.is_empty();
        if receipt.complete {
            e.process.take();
        }
        e.lifecycle = if receipt.complete {
            Lifecycle::Stopped
        } else {
            Lifecycle::Unavailable
        };
        e.receipt = Some(receipt.clone());
        Ok(receipt)
    }

    pub async fn reap_all(&mut self) -> Vec<ReapReceipt> {
        self.shutting_down = true;
        let ids: Vec<_> = self.entries.keys().copied().collect();
        let mut receipts = Vec::new();
        for id in ids {
            if let Ok(receipt) = self.stop(id).await {
                receipts.push(receipt);
            }
        }
        receipts
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    fn limits() -> SupervisorLimits {
        SupervisorLimits {
            startup_timeout: std::time::Duration::from_secs(1),
            graceful_timeout: std::time::Duration::from_millis(10),
            reap_timeout: std::time::Duration::from_secs(1),
            poll_interval: std::time::Duration::from_millis(1),
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
    #[test]
    fn failed_receipt_is_retried_but_complete_receipt_is_cached() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut s = Supervisor::new(limits()).unwrap();
                let recipe = spec();
                // A checked-in executable is never opened for writing by test threads.
                // Closing a local writer alone cannot exclude fork-inherited writers.
                let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("src/supervisor/testdata/receipt-runtime.sh");
                let process = OwnedProcess::spawn(&runtime, &recipe, &limits()).unwrap();
                let reaper_pid = process.child.id();
                let failed = ReapReceipt {
                    service: recipe.service,
                    service_epoch: 1,
                    reaped: vec![],
                    surviving: vec![],
                    failures: vec![SupervisorError::DeadlineExceeded],
                    complete: false,
                };
                s.entries.insert(
                    recipe.service,
                    Entry {
                        spec: recipe,
                        epoch: 1,
                        lifecycle: Lifecycle::Unavailable,
                        started: Instant::now(),
                        process: Some(process),
                        loss_recorded: false,
                        receipt: Some(failed),
                    },
                );
                let receipt = s.stop(ServiceId::Daemon).await.unwrap();
                assert!(receipt.complete);
                assert!(receipt.reaped.contains(&reaper_pid));
                assert!(!std::path::Path::new(&format!("/proc/{reaper_pid}")).exists());
                assert_eq!(s.stop(ServiceId::Daemon).await.unwrap(), receipt);
            });
    }
    #[test]
    fn busy_executable_preserves_errno_without_poisoning_entries() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let path =
                    std::env::temp_dir().join(format!("supervisor-busy-{}", std::process::id()));
                let mut writer = std::fs::File::create(&path).unwrap();
                writer.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
                writer
                    .set_permissions(std::fs::Permissions::from_mode(0o700))
                    .unwrap();
                let mut supervisor = Supervisor::new(limits()).unwrap();
                supervisor.set_reaper_runtime(path.clone()).unwrap();
                // Linux rejects exec while any writer owns the inode. Keeping it
                // open models the inherited descriptor without scheduling or sleeps.
                assert_eq!(
                    supervisor.start(spec()).await.unwrap_err(),
                    SupervisorError::SpawnFailed { errno: Some(26) }
                );
                assert!(supervisor.entries.is_empty());
                drop(writer);
                std::fs::remove_file(path).unwrap();
            });
    }
    #[test]
    fn initial_spawn_failure_does_not_poison_entries() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let path =
                    std::env::temp_dir().join(format!("supervisor-nonexec-{}", std::process::id()));
                std::fs::write(&path, b"not executable").unwrap();
                let mut s = Supervisor::new(limits()).unwrap();
                s.set_reaper_runtime(path.clone()).unwrap();
                assert_eq!(
                    s.start(spec()).await.unwrap_err(),
                    SupervisorError::SpawnFailed { errno: Some(13) }
                );
                assert_eq!(
                    s.start(spec()).await.unwrap_err(),
                    SupervisorError::SpawnFailed { errno: Some(13) }
                );
                assert!(s.entries.is_empty());
                std::fs::remove_file(path).unwrap();
            });
    }
}
