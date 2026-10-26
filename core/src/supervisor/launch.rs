use super::{LaunchSpec, SupervisorError, SupervisorLimits};
use std::{path::Path, time::Duration};

pub fn environment_key_allowed(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && !["LD_", "DYLD_", "PYTHON", "NODE_", "ELECTRON_"]
            .iter()
            .any(|prefix| key.starts_with(prefix))
        && !["BASH_ENV", "ENV", "GCONV_PATH", "HOSTALIASES", "ZDOTDIR", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "TZDIR"].contains(&key)
}

pub(crate) fn validate_limits(l: &SupervisorLimits) -> Result<(), SupervisorError> {
    if [
        l.startup_timeout,
        l.graceful_timeout,
        l.reap_timeout,
        l.poll_interval,
    ]
    .iter()
    .any(|d| d.is_zero() || *d > Duration::from_secs(60))
        || l.poll_interval > l.reap_timeout
        || l.stderr_chunk_bytes == 0
        || l.stderr_chunk_bytes > 65536
        || l.max_diagnostics_bytes == 0
        || l.max_diagnostics_bytes > 1048576
        || l.max_descendants == 0
        || l.max_descendants > 4096
    {
        return Err(SupervisorError::InvalidConfig);
    }
    Ok(())
}

pub(crate) fn canonical_file(path: &Path) -> bool {
    path.is_absolute() && path.canonicalize().is_ok_and(|p| p == path) && path.is_file()
}

pub(crate) fn validate(spec: &LaunchSpec) -> Result<(), SupervisorError> {
    if spec.initial_epoch == 0 {
        return Err(SupervisorError::InvalidEpoch);
    }
    if !canonical_file(&spec.program)
        || !spec.cwd.is_absolute()
        || !spec.cwd.is_dir()
        || !spec.cwd.canonicalize().is_ok_and(|p| p == spec.cwd)
        || spec.args.len() > 4096
        || spec.environment.len() > 256
        || spec
            .args
            .iter()
            .any(|s| s.len() > 65536 || s.as_encoded_bytes().contains(&0))
        || spec.environment.iter().any(|(k, v)| {
            !k.to_str().is_some_and(environment_key_allowed)
                || k.len() > 256
                || v.len() > 65536
                || k.as_encoded_bytes().contains(&0)
                || v.as_encoded_bytes().contains(&0)
        })
    {
        return Err(SupervisorError::InvalidConfig);
    }
    if spec.service != super::ServiceId::Daemon {
        // [TARGET, unit decision] Python recipes require isolated bundled imports.
        if !spec
            .args
            .starts_with(&["-I".into(), "-S".into(), "-B".into()])
        {
            return Err(SupervisorError::InvalidConfig);
        }
        let metadata = spec
            .cwd
            .metadata()
            .map_err(|_| SupervisorError::InvalidConfig)?;
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o222 != 0
            || std::fs::read_dir(&spec.cwd)
                .map_err(|_| SupervisorError::InvalidConfig)?
                .next()
                .is_some()
        {
            return Err(SupervisorError::InvalidConfig);
        }
    }
    Ok(())
}
