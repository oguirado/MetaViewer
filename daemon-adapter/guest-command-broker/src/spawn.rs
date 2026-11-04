use crate::{
    guard::GuestAuthority, output::Output, refused, sandbox::*, seccomp, supervision::JobCgroup,
    Result,
};
use std::ffi::CString;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

fn pipe() -> Result<(OwnedFd, OwnedFd)> {
    let mut p = [-1; 2];
    if unsafe { libc::pipe2(p.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((owned(p[0])?, owned(p[1])?))
}
fn nonblocking(fd: RawFd) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
pub struct Command {
    shell: CString,
    arg: CString,
    script: CString,
    env: Vec<CString>,
    input: Vec<u8>,
}
impl Command {
    pub fn new(script: &[u8], input: &[u8]) -> Result<Self> {
        if script.is_empty()
            || script.len() > 16384
            || input.len() > 49152
            || script.len() + input.len() > 65536
            || std::str::from_utf8(script).is_err()
        {
            return Err(refused("command/input bounds"));
        }
        Ok(Self {
            shell: cstring("/bin/sh")?,
            arg: cstring("-c")?,
            script: CString::new(script).map_err(|_| refused("command NUL"))?,
            env: ["PATH=/bin", "HOME=/work", "TMPDIR=/work", "LANG=C"]
                .iter()
                .map(|s| cstring(s))
                .collect::<Result<_>>()?,
            input: input.to_vec(),
        })
    }
}

#[derive(Default, Debug)]
pub struct Barrier {
    attached: bool,
    released: bool,
}
impl Barrier {
    pub fn record_attached(&mut self) -> Result<()> {
        if self.released || self.attached {
            return Err(refused("duplicate barrier attachment"));
        }
        self.attached = true;
        Ok(())
    }
    pub fn permit_release(&mut self) -> Result<()> {
        if !self.attached || self.released {
            return Err(refused("unattached/duplicate release"));
        }
        self.released = true;
        Ok(())
    }
}

/// Owns a real child after fork even if cgroup attachment/release fails.
/// Caller must retain it until verified reaping and cgroup/output closure.
#[must_use = "retain the child until cgroup, reaping and output closure are verified"]
pub struct Child {
    pid: libc::pid_t,
    gate: Option<OwnedFd>,
    input: Option<OwnedFd>,
    pub stdout: OwnedFd,
    pub stderr: OwnedFd,
    pub exec_error: OwnedFd,
    data: Vec<u8>,
    input_offset: usize,
    state: Barrier,
}
impl Child {
    /// Read-only identity paired with this object's private release barrier.
    /// ```compile_fail
    /// fn retarget(mut child: guest_command_broker::spawn::Child) {
    ///     child.pid = 42;
    /// }
    /// ```
    pub fn pid(&self) -> libc::pid_t {
        self.pid
    }

    /// The cwd is resolved through the verified jail, not an arbitrary fd.
    /// ```compile_fail
    /// use guest_command_broker::{guard::GuestAuthority, sandbox::Jail, spawn::{Child,Command}};
    /// fn outside(a: &GuestAuthority, j: &Jail, fd: &std::os::fd::OwnedFd, c: Command) {
    ///     let _ = Child::fork_blocked(a,j,fd,c,10000,10000);
    /// }
    /// ```
    pub fn fork_blocked(
        authority: &GuestAuthority,
        jail: &Jail,
        cwd: &RelativeCwd,
        command: Command,
        uid: u32,
        gid: u32,
    ) -> Result<Self> {
        authority.check()?;
        if uid == 0 || gid == 0 || !jail.identity_matches(uid, gid) {
            return Err(refused("matching unprivileged identity required"));
        }
        let cwd = jail.cwd(authority, cwd)?;
        if std::fs::read_dir("/proc/self/task")?
            .collect::<std::io::Result<Vec<_>>>()?
            .len()
            != 1
        {
            return Err(refused("single-threaded broker required before fork"));
        }
        for fd in 0..3 {
            if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
                return Err(refused("broker stdio descriptors required"));
            }
        }
        let (gate_r, gate_w) = pipe()?;
        let (input_r, input_w) = pipe()?;
        let (out_r, out_w) = pipe()?;
        let (err_r, err_w) = pipe()?;
        let (exec_r, exec_w) = pipe()?;
        nonblocking(input_w.as_raw_fd())?;
        nonblocking(out_r.as_raw_fd())?;
        nonblocking(err_r.as_raw_fd())?;
        nonblocking(exec_r.as_raw_fd())?;
        let argv = [
            command.shell.as_ptr(),
            command.arg.as_ptr(),
            command.script.as_ptr(),
            std::ptr::null(),
        ];
        let mut env: Vec<_> = command.env.iter().map(|s| s.as_ptr()).collect();
        env.push(std::ptr::null());
        let filter = seccomp::filter();
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if pid == 0 {
            unsafe {
                child_exec(
                    gate_r.as_raw_fd(),
                    input_r.as_raw_fd(),
                    out_w.as_raw_fd(),
                    err_w.as_raw_fd(),
                    exec_w.as_raw_fd(),
                    jail.root_fd(),
                    cwd.as_raw_fd(),
                    uid,
                    gid,
                    command.shell.as_ptr(),
                    argv.as_ptr(),
                    env.as_ptr(),
                    &filter,
                )
            }
        }
        drop(gate_r);
        drop(input_r);
        drop(out_w);
        drop(err_w);
        drop(exec_w);
        Ok(Self {
            pid,
            gate: Some(gate_w),
            input: Some(input_w),
            stdout: out_r,
            stderr: err_r,
            exec_error: exec_r,
            data: command.input,
            input_offset: 0,
            state: Barrier::default(),
        })
    }
    pub fn attach_and_release(
        &mut self,
        authority: &GuestAuthority,
        group: &JobCgroup,
    ) -> Result<()> {
        authority.check()?;
        group.attach_blocked_child(authority, self.pid)?;
        self.state.record_attached()?;
        self.state.permit_release()?;
        let gate = self
            .gate
            .take()
            .ok_or_else(|| refused("barrier already consumed"))?;
        if unsafe { libc::write(gate.as_raw_fd(), b"!".as_ptr().cast(), 1) } != 1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    /// Close stdin/barrier and signal only this retained child's process group.
    /// Cgroup kill remains mandatory for escaped/background descendants.
    pub fn terminate(&mut self, authority: &GuestAuthority, leader_reaped: bool) -> Result<()> {
        authority.check()?;
        self.input = None;
        if self.gate.take().is_some() {
            return Ok(());
        }
        if !leader_reaped && unsafe { libc::kill(-self.pid, libc::SIGTERM) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
    pub fn feed_input(&mut self, authority: &GuestAuthority) -> Result<bool> {
        authority.check()?;
        let Some(fd) = &self.input else {
            return Ok(true);
        };
        if self.input_offset == self.data.len() {
            self.input = None;
            return Ok(true);
        }
        let left = &self.data[self.input_offset..];
        let n = unsafe { libc::write(fd.as_raw_fd(), left.as_ptr().cast(), left.len()) };
        if n < 0 {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() == Some(libc::EPIPE) {
                self.input = None;
                return Ok(true);
            }
            if e.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(false);
            };
            return Err(e);
        }
        self.input_offset += n as usize;
        Ok(false)
    }
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}
#[allow(clippy::too_many_arguments)]
unsafe fn child_exec(
    gate: RawFd,
    input: RawFd,
    out: RawFd,
    err: RawFd,
    exec_err: RawFd,
    root: RawFd,
    cwd: RawFd,
    uid: u32,
    gid: u32,
    shell: *const libc::c_char,
    argv: *const *const libc::c_char,
    env: *const *const libc::c_char,
    filter: &[libc::sock_filter],
) -> ! {
    let fail = || {
        let code = libc::EACCES.to_ne_bytes();
        libc::write(exec_err, code.as_ptr().cast(), code.len());
        libc::_exit(126)
    };
    let mut token = 0u8;
    if libc::read(gate, (&mut token as *mut u8).cast(), 1) != 1 || token != b'!' {
        fail()
    }
    if libc::setsid() < 0 {
        fail()
    }
    if libc::dup2(input, 0) < 0
        || libc::dup2(out, 1) < 0
        || libc::dup2(err, 2) < 0
        || libc::fchdir(root) != 0
        || libc::chroot(c".".as_ptr()) != 0
        || libc::fchdir(cwd) != 0
    {
        fail()
    }
    for (resource, limit) in [
        (libc::RLIMIT_CORE, 0),
        (libc::RLIMIT_NOFILE, 64),
        (libc::RLIMIT_FSIZE, 64 * 1024 * 1024),
    ] {
        let value = libc::rlimit {
            rlim_cur: limit,
            rlim_max: limit,
        };
        if libc::setrlimit(resource, &value) != 0 {
            fail()
        }
    }
    if libc::setgroups(0, std::ptr::null()) != 0
        || libc::prctl(libc::PR_SET_KEEPCAPS, 0, 0, 0, 0) != 0
        || libc::setresgid(gid, gid, gid) != 0
        || libc::setresuid(uid, uid, uid) != 0
    {
        fail()
    }
    let mut signals = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
    if libc::sigemptyset(signals.as_mut_ptr()) != 0
        || libc::sigprocmask(libc::SIG_SETMASK, signals.as_ptr(), std::ptr::null_mut()) != 0
    {
        fail()
    }
    libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    let header = CapHeader {
        version: 0x2008_0522,
        pid: 0,
    };
    let data = [
        CapData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
        CapData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
    ];
    if libc::syscall(libc::SYS_capset, &header, data.as_ptr()) != 0
        || libc::geteuid() != uid
        || libc::getegid() != gid
    {
        fail()
    }
    // Preserve only stdio and an exec-error pipe that closes atomically on exec.
    let error_fd = if exec_err == 3 {
        if libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
            fail()
        }
        3
    } else {
        if libc::dup3(exec_err, 3, libc::O_CLOEXEC) < 0 {
            fail()
        }
        3
    };
    if libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) != 0 {
        let code = libc::EACCES.to_ne_bytes();
        libc::write(error_fd, code.as_ptr().cast(), code.len());
        libc::_exit(126)
    }
    if seccomp::install_in_child(filter).is_err() {
        let code = libc::EACCES.to_ne_bytes();
        libc::write(error_fd, code.as_ptr().cast(), code.len());
        libc::_exit(126)
    }
    libc::execve(shell, argv, env);
    let code = libc::EACCES.to_ne_bytes();
    libc::write(error_fd, code.as_ptr().cast(), code.len());
    libc::_exit(126)
}

/// At most 64 KiB per call, so a continuously writing child cannot starve timeout checks.
pub fn drain(
    authority: &GuestAuthority,
    fd: &OwnedFd,
    stderr: bool,
    output: &mut Output,
) -> Result<bool> {
    authority.check()?;
    let mut b = [0u8; 4096];
    for _ in 0..16 {
        let n = unsafe { libc::read(fd.as_raw_fd(), b.as_mut_ptr().cast(), b.len()) };
        if n == 0 {
            return Ok(true);
        };
        if n < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(false);
            };
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            };
            return Err(e);
        };
        output.push(stderr, &b[..n as usize]);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spawn_api_requires_relative_cwd_and_only_exposes_pid_copy() {
        let _: fn(&GuestAuthority, &Jail, &RelativeCwd, Command, u32, u32) -> Result<Child> =
            Child::fork_blocked;
        let _: fn(&Child) -> libc::pid_t = Child::pid;
    }
    #[test]
    fn barrier_never_releases_before_membership_or_twice() {
        let mut b = Barrier::default();
        assert!(b.permit_release().is_err());
        b.record_attached().unwrap();
        assert!(b.record_attached().is_err());
        b.permit_release().unwrap();
        assert!(b.permit_release().is_err());
    }
    #[test]
    fn command_constructor_has_no_effectful_fallback() {
        assert!(Command::new(b"echo ok", b"input").is_ok());
        assert!(Command::new(b"", b"").is_err());
        assert!(Command::new(b"x\0y", b"").is_err());
        assert!(Command::new(&[255], b"").is_err());
        assert!(Command::new(b"x", &vec![0; 65537]).is_err());
    }
}
