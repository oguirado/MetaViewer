use super::{Diagnostics, LaunchSpec, SupervisorError, SupervisorLimits};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

pub(crate) fn validate_signal_target(
    raw_pid: i64,
    own_pid: i32,
    own_pgid: i32,
    owned: bool,
) -> Result<i32, SupervisorError> {
    let pid = i32::try_from(raw_pid).map_err(|_| SupervisorError::UnsafeTarget)?;
    if pid <= 1 || pid == own_pid || pid == own_pgid || !owned {
        return Err(SupervisorError::UnsafeTarget);
    }
    Ok(pid)
}

fn proc_identity(pid: u32) -> Result<(u64, bool, i32), SupervisorError> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|_| SupervisorError::OwnershipLost)?;
    let (_, tail) = text
        .rsplit_once(')')
        .ok_or(SupervisorError::OwnershipLost)?;
    let parts: Vec<_> = tail.split_whitespace().collect();
    let start = parts
        .get(19)
        .and_then(|s| s.parse().ok())
        .ok_or(SupervisorError::OwnershipLost)?;
    let pgid = parts
        .get(2)
        .and_then(|s| s.parse().ok())
        .ok_or(SupervisorError::OwnershipLost)?;
    Ok((
        start,
        !matches!(parts.first(), Some(&"Z") | Some(&"X")),
        pgid,
    ))
}

#[derive(Default)]
struct Evidence {
    root: Option<(u32, u64)>,
    reaped: BTreeSet<u32>,
    invalid: bool,
    diagnostics: Diagnostics,
}

pub(crate) struct OwnedProcess {
    pub child: Child,
    evidence: Arc<Mutex<Evidence>>,
    readers: Vec<JoinHandle<()>>,
    terminal: Option<bool>,
}

impl OwnedProcess {
    pub fn spawn(
        runtime: &std::path::Path,
        spec: &LaunchSpec,
        limits: &SupervisorLimits,
    ) -> Result<Self, SupervisorError> {
        let mut command = Command::new(runtime);
        command
            .args(["-I", "-S", "-B", "-u", "-c", include_str!("reaper.py")])
            .arg(limits.graceful_timeout.as_secs_f64().to_string())
            .arg(limits.reap_timeout.as_secs_f64().to_string())
            .arg(limits.poll_interval.as_secs_f64().to_string())
            .arg(limits.max_descendants.to_string())
            .arg(&spec.cwd)
            .arg(&spec.program)
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &spec.environment {
            if key.to_str().is_some_and(super::environment_key_allowed) {
                command.env(key, value);
            }
        }
        let mut child = command.spawn().map_err(|_| SupervisorError::SpawnFailed)?;
        let evidence = Arc::new(Mutex::new(Evidence::default()));
        let stdout = child.stdout.take().ok_or(SupervisorError::SpawnFailed)?;
        let stderr = child.stderr.take().ok_or(SupervisorError::SpawnFailed)?;
        let output = Arc::clone(&evidence);
        let cap = limits.max_descendants;
        let root_reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut first = true;
            loop {
                let mut bytes = Vec::new();
                let result = reader.by_ref().take(32).read_until(b'\n', &mut bytes);
                let Ok(n) = result else {
                    output.lock().expect("evidence lock").invalid = true;
                    break;
                };
                if n == 0 {
                    break;
                }
                let pid = std::str::from_utf8(&bytes)
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok());
                let mut shared = output.lock().expect("evidence lock");
                let Some(pid) = pid.filter(|pid| *pid > 1 && *pid <= i32::MAX as u32) else {
                    shared.invalid = true;
                    break;
                };
                if first {
                    first = false;
                    match proc_identity(pid) {
                        Ok((start, true, _)) => shared.root = Some((pid, start)),
                        _ => shared.invalid = true,
                    }
                } else if shared.reaped.len() < cap {
                    shared.reaped.insert(pid);
                } else {
                    shared.invalid = true;
                    break;
                }
            }
        });
        let output = Arc::clone(&evidence);
        let chunk = limits.stderr_chunk_bytes;
        let cap = limits.max_diagnostics_bytes;
        let stderr_reader = std::thread::spawn(move || {
            let mut reader = stderr;
            let mut buffer = vec![0; chunk];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Count bounded diagnostics without retaining potentially sensitive bytes.
                        let mut shared = output.lock().expect("evidence lock");
                        let retained = n.min(cap - shared.diagnostics.retained_bytes);
                        shared.diagnostics.retained_bytes += retained;
                        shared.diagnostics.dropped_bytes = shared
                            .diagnostics
                            .dropped_bytes
                            .saturating_add((n - retained) as u64);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        output.lock().expect("evidence lock").invalid = true;
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            evidence,
            readers: vec![root_reader, stderr_reader],
            terminal: None,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.evidence
            .lock()
            .expect("evidence lock")
            .root
            .map(|r| r.0)
    }
    pub fn root_alive(&self) -> bool {
        self.evidence
            .lock()
            .expect("evidence lock")
            .root
            .is_some_and(|(pid, start)| {
                proc_identity(pid).is_ok_and(|(current, live, _)| live && start == current)
            })
    }
    pub fn valid(&self) -> bool {
        !self.evidence.lock().expect("evidence lock").invalid
    }
    pub fn diagnostics(&self) -> Diagnostics {
        self.evidence.lock().expect("evidence lock").diagnostics
    }
    pub fn poll(&mut self) -> Result<Option<bool>, SupervisorError> {
        if let Some(terminal) = self.terminal {
            return Ok(Some(terminal));
        }
        let status = self
            .child
            .try_wait()
            .map_err(|_| SupervisorError::OwnershipLost)?;
        if let Some(status) = status {
            let success = matches!(status.code(), Some(0 | 10));
            self.terminal = Some(success);
            Ok(Some(success))
        } else {
            Ok(None)
        }
    }
    pub fn request_stop(&mut self) -> Result<(), SupervisorError> {
        // Closing the private control pipe asks the retained reaper to stop.
        let own = i32::try_from(std::process::id()).map_err(|_| SupervisorError::UnsafeTarget)?;
        let (_, _, group) = proc_identity(std::process::id())?;
        validate_signal_target(i64::from(self.child.id()), own, group, true)?;
        self.child.stdin.take();
        Ok(())
    }
    pub fn finish(&mut self) -> Result<Vec<u32>, SupervisorError> {
        if self.poll()? != Some(true) {
            return Err(SupervisorError::CleanupIncomplete);
        }
        if self.readers.iter().any(|t| !t.is_finished()) {
            return Err(SupervisorError::DeadlineExceeded);
        }
        for reader in self.readers.drain(..) {
            if reader.join().is_err() {
                return Err(SupervisorError::CleanupIncomplete);
            }
        }
        let shared = self.evidence.lock().expect("evidence lock");
        if shared.invalid
            || shared
                .root
                .is_none_or(|(pid, _)| !shared.reaped.contains(&pid))
        {
            return Err(SupervisorError::CleanupIncomplete);
        }
        let mut reaped: Vec<_> = shared.reaped.iter().copied().collect();
        reaped.push(self.child.id());
        Ok(reaped)
    }
    pub fn readers_finished(&self) -> bool {
        self.readers.iter().all(|t| t.is_finished())
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // Explicit stop is the proof boundary; drop requests cleanup without signalling a stale PID.
        self.child.stdin.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signal_policy_rejects_unsafe_targets() {
        for pid in [-1, 0, 1, 42, 43, i64::from(i32::MAX) + 1] {
            assert_eq!(
                validate_signal_target(pid, 42, 43, true),
                Err(SupervisorError::UnsafeTarget)
            );
        }
        assert_eq!(
            validate_signal_target(44, 42, 43, false),
            Err(SupervisorError::UnsafeTarget)
        );
        assert_eq!(validate_signal_target(44, 42, 43, true), Ok(44));
    }
}
