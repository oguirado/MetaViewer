use crate::{guard::GuestAuthority, refused, sandbox::*, Result};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobName(String);
impl JobName {
    pub fn new(value: &str) -> Result<Self> {
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        {
            return Err(refused("invalid internal job name"));
        }
        Ok(Self(value.to_owned()))
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    memory: u64,
    pids: u32,
}
impl Limits {
    pub fn new(memory: u64, pids: u32, guest_memory: u64) -> Result<Self> {
        if guest_memory == 0
            || guest_memory > 256 * 1024 * 1024
            || memory == 0
            || memory >= guest_memory
            || pids == 0
            || pids > 64
        {
            return Err(refused("explicit bounded guest job limits required"));
        }
        Ok(Self { memory, pids })
    }
}

fn read_control(parent: RawFd, name: &str) -> Result<String> {
    let name = cstring(name)?;
    let fd = owned(unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    })?;
    let mut value = String::new();
    std::fs::File::from(fd)
        .take(65537)
        .read_to_string(&mut value)?;
    if value.len() > 65536 {
        return Err(refused("cgroup control exceeds bound"));
    }
    Ok(value)
}
fn write_control(parent: RawFd, name: &str, value: &str) -> Result<()> {
    let name = cstring(name)?;
    let fd = owned(unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    })?;
    filesystem(fd.as_raw_fd(), libc::CGROUP2_SUPER_MAGIC)?;
    std::fs::File::from(fd).write_all(value.as_bytes())
}
fn mkdir(parent: RawFd, name: &str) -> Result<OwnedFd> {
    let c = cstring(name)?;
    if unsafe { libc::mkdirat(parent, c.as_ptr(), 0o700) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let fd = open_directory(parent, name)?;
    require_root_directory(fd.as_raw_fd())?;
    Ok(fd)
}

pub struct JobCgroups {
    jobs: OwnedFd,
    issued: BTreeSet<String>,
}
pub struct JobCgroup {
    fd: OwnedFd,
}
impl JobCgroups {
    /// Requires existing mounts; it never mounts over a host path.
    pub fn prepare(authority: &GuestAuthority) -> Result<Self> {
        authority.check()?;
        for (path, magic) in [
            ("/proc", libc::PROC_SUPER_MAGIC),
            ("/sys", libc::SYSFS_MAGIC),
            ("/sys/fs/cgroup", libc::CGROUP2_SUPER_MAGIC),
        ] {
            let fd = open_directory(libc::AT_FDCWD, path)?;
            filesystem(fd.as_raw_fd(), magic)?;
        }
        let root = open_directory(libc::AT_FDCWD, "/sys/fs/cgroup")?;
        let controllers = read_control(root.as_raw_fd(), "cgroup.controllers")?;
        if !["memory", "pids"]
            .iter()
            .all(|c| controllers.split_whitespace().any(|v| v == *c))
        {
            return Err(refused("memory/pids controllers unavailable"));
        }
        write_control(root.as_raw_fd(), "cgroup.subtree_control", "+memory +pids")?;
        let jobs = mkdir(root.as_raw_fd(), "terminal-jobs")?;
        write_control(jobs.as_raw_fd(), "cgroup.subtree_control", "+memory +pids")?;
        Ok(Self {
            jobs,
            issued: BTreeSet::new(),
        })
    }
    #[cfg(feature = "rewind-profile")]
    pub(crate) fn quiescent(&self, authority: &GuestAuthority) -> Result<bool> {
        authority.check()?;
        populated_zero(&read_control(self.jobs.as_raw_fd(), "cgroup.events")?)
    }
    pub fn create(
        &mut self,
        authority: &GuestAuthority,
        name: &JobName,
        limits: Limits,
    ) -> Result<JobCgroup> {
        authority.check()?;
        if self.issued.len() >= 64 || !self.issued.insert(name.0.clone()) {
            return Err(refused("job cgroup name consumed"));
        }
        let fd = mkdir(self.jobs.as_raw_fd(), &name.0)?;
        write_control(fd.as_raw_fd(), "memory.max", &limits.memory.to_string())?;
        write_control(fd.as_raw_fd(), "memory.swap.max", "0")?;
        write_control(fd.as_raw_fd(), "pids.max", &limits.pids.to_string())?;
        if read_control(fd.as_raw_fd(), "memory.max")?.trim() != limits.memory.to_string()
            || read_control(fd.as_raw_fd(), "memory.swap.max")?.trim() != "0"
            || read_control(fd.as_raw_fd(), "pids.max")?.trim() != limits.pids.to_string()
            || read_control(fd.as_raw_fd(), "cgroup.type")?.trim() != "domain"
        {
            return Err(refused("job cgroup limits not applied"));
        }
        // Opening this exact kernel control verifies support without issuing a kill.
        let name = cstring("cgroup.kill")?;
        let _kill = owned(unsafe {
            libc::openat(
                fd.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        })?;
        Ok(JobCgroup { fd })
    }
}
impl JobCgroup {
    pub fn attach_blocked_child(&self, authority: &GuestAuthority, pid: libc::pid_t) -> Result<()> {
        authority.check()?;
        if pid <= 1 {
            return Err(refused("child identity required"));
        }
        write_control(self.fd.as_raw_fd(), "cgroup.procs", &pid.to_string())?;
        let members = read_control(self.fd.as_raw_fd(), "cgroup.procs")?;
        if members.split_whitespace().collect::<Vec<_>>() != vec![pid.to_string()] {
            return Err(refused("unexpected cgroup members before child release"));
        }
        Ok(())
    }
    pub fn kill_descendants(&self, authority: &GuestAuthority) -> Result<()> {
        authority.check()?;
        write_control(self.fd.as_raw_fd(), "cgroup.kill", "1")
    }
    pub fn empty(&self, authority: &GuestAuthority) -> Result<bool> {
        authority.check()?;
        populated_zero(&read_control(self.fd.as_raw_fd(), "cgroup.events")?)
    }
}
pub fn populated_zero(text: &str) -> Result<bool> {
    let values: Vec<_> = text
        .lines()
        .filter_map(|l| l.strip_prefix("populated "))
        .collect();
    match values.as_slice() {
        ["0"] => Ok(true),
        ["1"] => Ok(false),
        _ => Err(refused("missing/duplicate populated witness")),
    }
}

#[derive(Default, Debug, Clone, Copy)]
pub struct Completion {
    leader_reaped: bool,
    descendants_empty: bool,
    no_unreaped_children: bool,
    stdout_eof: bool,
    stderr_eof: bool,
    failed: bool,
}
impl Completion {
    pub fn confirmed(&self) -> bool {
        !self.failed
            && self.leader_reaped
            && self.descendants_empty
            && self.no_unreaped_children
            && self.stdout_eof
            && self.stderr_eof
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Deadline {
    end_ms: u64,
}
impl Deadline {
    pub fn new(now_ms: u64, timeout_ms: u64, session_end_ms: u64) -> Result<Self> {
        if timeout_ms == 0 || timeout_ms > 60000 || now_ms >= session_end_ms {
            return Err(refused("invalid remaining job lifetime"));
        }
        let end = now_ms
            .checked_add(timeout_ms)
            .ok_or_else(|| refused("deadline overflow"))?
            .min(session_end_ms);
        Ok(Self { end_ms: end })
    }
    pub fn remaining(&self, now_ms: u64) -> u64 {
        self.end_ms.saturating_sub(now_ms)
    }
}
pub fn poll_job(
    authority: &GuestAuthority,
    fds: &mut [libc::pollfd],
    deadline: Deadline,
    now_ms: u64,
) -> Result<usize> {
    authority.check()?;
    if fds.len() > 4 {
        return Err(refused("poll set bound"));
    }
    let left = deadline.remaining(now_ms);
    if left == 0 {
        return Ok(0);
    }
    let n = unsafe {
        libc::poll(
            fds.as_mut_ptr(),
            fds.len() as libc::nfds_t,
            left.min(100) as i32,
        )
    };
    if n < 0 {
        let e = std::io::Error::last_os_error();
        if e.kind() == std::io::ErrorKind::Interrupted {
            return Ok(0);
        };
        return Err(e);
    }
    Ok(n as usize)
}
pub struct Reaped {
    pub pid: libc::pid_t,
    pub status: i32,
}
pub fn reap_available(authority: &GuestAuthority) -> Result<(Vec<Reaped>, bool)> {
    authority.check()?;
    let mut out = Vec::new();
    loop {
        let mut status = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid > 0 {
            out.push(Reaped { pid, status });
            continue;
        }
        if pid == 0 {
            return Ok((out, false));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if error.raw_os_error() == Some(libc::ECHILD) {
            return Ok((out, true));
        }
        return Err(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closure_requires_all_independent_witnesses() {
        let good = Completion {
            leader_reaped: true,
            descendants_empty: true,
            no_unreaped_children: true,
            stdout_eof: true,
            stderr_eof: true,
            failed: false,
        };
        assert!(good.confirmed());
        for n in 0..6 {
            let mut c = Completion { ..good };
            match n {
                0 => c.leader_reaped = false,
                1 => c.descendants_empty = false,
                2 => c.no_unreaped_children = false,
                3 => c.stdout_eof = false,
                4 => c.stderr_eof = false,
                _ => c.failed = true,
            }
            assert!(!c.confirmed());
        }
    }
    #[test]
    fn no_unknown_empty_or_limit_fallback() {
        assert!(populated_zero("populated 0\nfrozen 0\n").unwrap());
        assert!(!populated_zero("populated 1\n").unwrap());
        for v in ["", "populated 0\npopulated 0", "populated false"] {
            assert!(populated_zero(v).is_err());
        }
        assert!(Limits::new(64 << 20, 32, 256 << 20).is_ok());
        assert!(Limits::new(256 << 20, 32, 256 << 20).is_err());
        assert!(Limits::new(1, 65, 256 << 20).is_err());
        for n in ["", "../job", "job/name"] {
            assert!(JobName::new(n).is_err());
        }
    }
    #[test]
    fn deadlines_never_extend_session_or_overflow() {
        let d = Deadline::new(100, 50, 120).unwrap();
        assert_eq!(d.remaining(110), 10);
        assert_eq!(d.remaining(120), 0);
        assert!(Deadline::new(u64::MAX - 1, 10, u64::MAX).is_err());
        assert!(Deadline::new(1, 0, 10).is_err());
    }
}
