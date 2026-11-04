use crate::{refused, Result};
use std::ffi::CStr;

/// A fresh observation must precede every operation which can change the guest.
/// The fields are private; callers cannot manufacture this authority.
pub struct GuestAuthority {
    _private: (),
}

pub fn admit_observation(pid: u32, uid: u32, machine: &str) -> Result<()> {
    if pid != 1 || uid != 0 || machine != "aarch64" {
        return Err(refused("root PID1 on aarch64 is required"));
    }
    Ok(())
}

impl GuestAuthority {
    pub fn detect() -> Result<Self> {
        Self::observe()?;
        Ok(Self { _private: () })
    }
    fn observe() -> Result<()> {
        let mut uts = std::mem::MaybeUninit::<libc::utsname>::uninit();
        if unsafe { libc::uname(uts.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let uts = unsafe { uts.assume_init() };
        let machine = unsafe { CStr::from_ptr(uts.machine.as_ptr()) }.to_string_lossy();
        admit_observation(
            unsafe { libc::getpid() } as u32,
            unsafe { libc::geteuid() },
            &machine,
        )
    }
    pub(crate) fn check(&self) -> Result<()> {
        Self::observe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_or_nonroot_observation_never_grants_effect_authority() {
        for (pid, uid, arch) in [(2, 0, "aarch64"), (1, 1000, "aarch64"), (1, 0, "x86_64")] {
            assert!(admit_observation(pid, uid, arch).is_err());
        }
        assert!(admit_observation(1, 0, "aarch64").is_ok());
        assert!(GuestAuthority::detect().is_err()); // This test must never run as guest PID1.
    }
}
