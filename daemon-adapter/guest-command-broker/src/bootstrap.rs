//! Fixed guest-only boot layout. Never invoked by pure host tests.
use crate::{
    guard::GuestAuthority,
    refused,
    sandbox::{cstring, filesystem, open_directory, require_root_directory},
    Result,
};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

pub const JOB_UID: u32 = 10000;
pub const JOB_GID: u32 = 10000;
pub const GUEST_MS: u64 = 60000;

pub struct Boot {
    pub nonce: String,
}
impl Boot {
    pub fn parse(cmdline: &str) -> Result<Self> {
        if cmdline.len() > 8192 || cmdline.contains('\0') {
            return Err(refused("cmdline bound"));
        }
        let markers: Vec<_> = cmdline
            .split_ascii_whitespace()
            .filter_map(|s| s.strip_prefix("mv_guest_command="))
            .collect();
        let nonces: Vec<_> = cmdline
            .split_ascii_whitespace()
            .filter_map(|s| s.strip_prefix("mv_nonce="))
            .collect();
        if markers != ["1"]
            || nonces.len() != 1
            || nonces[0].len() != 64
            || !nonces[0]
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(refused("guest boot binding"));
        }
        Ok(Self {
            nonce: nonces[0].to_owned(),
        })
    }
}
fn mount(
    a: &GuestAuthority,
    source: &str,
    target: &str,
    kind: &str,
    flags: libc::c_ulong,
    data: &str,
) -> Result<()> {
    a.check()?;
    let s = cstring(source)?;
    let t = cstring(target)?;
    let k = cstring(kind)?;
    let d = cstring(data)?;
    if unsafe { libc::mount(s.as_ptr(), t.as_ptr(), k.as_ptr(), flags, d.as_ptr().cast()) } != 0 {
        let error = std::io::Error::last_os_error();
        eprintln!(
            "guest_broker mount_failed target={} errno={:?}",
            target,
            error.raw_os_error()
        );
        return Err(error);
    }
    Ok(())
}
fn dir(a: &GuestAuthority, path: &str, mode: u32) -> Result<()> {
    a.check()?;
    std::fs::create_dir(path).map_err(|error| {
        eprintln!(
            "guest_broker mkdir_failed target={} errno={:?}",
            path,
            error.raw_os_error()
        );
        error
    })?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(())
}
fn bind_ro(a: &GuestAuthority, source: &str, target: &str, extra: libc::c_ulong) -> Result<()> {
    mount(a, source, target, "", libc::MS_BIND, "")?;
    mount(
        a,
        "",
        target,
        "",
        libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY | libc::MS_NOSUID | extra,
        "",
    )
}
/// Proc mount is the sole pre-marker effect, necessary to read the kernel cmdline.
pub fn read_boot(a: &GuestAuthority) -> Result<Boot> {
    a.check()?;
    let fd = open_directory(libc::AT_FDCWD, "/proc")?;
    require_root_directory(fd.as_raw_fd())?;
    mount(
        a,
        "proc",
        "/proc",
        "proc",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "hidepid=2",
    )?;
    let mounted = open_directory(libc::AT_FDCWD, "/proc")?;
    filesystem(mounted.as_raw_fd(), libc::PROC_SUPER_MAGIC)?;
    use std::io::Read;
    let mut raw = String::new();
    std::fs::File::open("/proc/cmdline")?
        .take(8193)
        .read_to_string(&mut raw)?;
    Boot::parse(&raw)
}
pub fn prepare(a: &GuestAuthority) -> Result<()> {
    a.check()?;
    // The kernel opened PID1's console descriptors before exec. Removing only
    // this validated fixed node keeps the console outside the job's /dev bind.
    match std::fs::symlink_metadata("/dev/console") {
        Ok(meta) => {
            if !console_metadata_valid(
                meta.uid(),
                meta.gid(),
                meta.mode(),
                meta.rdev(),
                meta.nlink(),
            ) {
                return Err(refused("console node custody"));
            }
            std::fs::remove_file("/dev/console")?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    unsafe {
        libc::umask(0o077);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    mount(
        a,
        "sysfs",
        "/sys",
        "sysfs",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "",
    )?;
    mount(
        a,
        "cgroup2",
        "/sys/fs/cgroup",
        "cgroup2",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "",
    )?;
    // Mask globally before fork, so even an alternate proc path has no boot nonce.
    let empty = std::fs::symlink_metadata("/etc/empty-cmdline")?;
    if !empty.is_file() || empty.len() != 0 || empty.permissions().mode() & 0o022 != 0 {
        return Err(refused("empty cmdline source"));
    }
    bind_ro(
        a,
        "/etc/empty-cmdline",
        "/proc/cmdline",
        libc::MS_NODEV | libc::MS_NOEXEC,
    )?;
    dir(a, "/sandbox", 0o755)?;
    mount(
        a,
        "tmpfs",
        "/sandbox",
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV,
        "size=2m,mode=0755",
    )?;
    for name in ["bin", "etc", "dev", "proc", "work"] {
        dir(a, &format!("/sandbox/{name}"), 0o755)?;
    }
    bind_ro(a, "/bin", "/sandbox/bin", libc::MS_NODEV)?;
    bind_ro(a, "/etc", "/sandbox/etc", libc::MS_NODEV | libc::MS_NOEXEC)?;
    bind_ro(a, "/dev", "/sandbox/dev", libc::MS_NOEXEC)?;
    bind_ro(
        a,
        "/proc",
        "/sandbox/proc",
        libc::MS_NODEV | libc::MS_NOEXEC,
    )?;
    // A nonrecursive proc bind does not propagate the global cmdline submount.
    // Mask the jail view independently before it can be admitted by Jail::verify.
    bind_ro(
        a,
        "/etc/empty-cmdline",
        "/sandbox/proc/cmdline",
        libc::MS_NODEV | libc::MS_NOEXEC,
    )?;
    mount(
        a,
        "tmpfs",
        "/sandbox/work",
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV,
        "size=64m,mode=0700,uid=10000,gid=10000",
    )?;
    dir(a, "/sandbox/work/tmp", 0o700)?;
    let tmp = cstring("/sandbox/work/tmp")?;
    if unsafe { libc::chown(tmp.as_ptr(), JOB_UID, JOB_GID) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    mount(
        a,
        "",
        "/sandbox",
        "",
        libc::MS_REMOUNT | libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV,
        "",
    )?;
    Ok(())
}
fn console_metadata_valid(uid: u32, gid: u32, mode: u32, rdev: u64, nlink: u64) -> bool {
    uid == 0
        && gid == 0
        && mode & libc::S_IFMT == libc::S_IFCHR
        && mode & 0o7777 == 0o600
        && libc::major(rdev) == 5
        && libc::minor(rdev) == 1
        && nlink == 1
}
pub fn now_ms() -> Result<u64> {
    let mut t = std::mem::MaybeUninit::<libc::timespec>::uninit();
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, t.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let t = unsafe { t.assume_init() };
    Ok(t.tv_sec as u64 * 1000 + t.tv_nsec as u64 / 1_000_000)
}
pub fn poweroff(a: &GuestAuthority) -> Result<()> {
    a.check()?;
    if unsafe { libc::reboot(libc::RB_POWER_OFF) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn console_unlink_requires_exact_fixed_node_metadata() {
        let mode = libc::S_IFCHR | 0o600;
        let dev = libc::makedev(5, 1);
        assert!(console_metadata_valid(0, 0, mode, dev, 1));
        for (uid, gid, m, d, n) in [
            (1, 0, mode, dev, 1),
            (0, 1, mode, dev, 1),
            (0, 0, libc::S_IFLNK | 0o600, dev, 1),
            (0, 0, libc::S_IFCHR | 0o666, dev, 1),
            (0, 0, mode, libc::makedev(1, 3), 1),
            (0, 0, mode, dev, 2),
        ] {
            assert!(!console_metadata_valid(uid, gid, m, d, n));
        }
    }
    #[test]
    fn boot_binding_strict() {
        let ok = format!(
            "console=ttyAMA0 mv_guest_command=1 mv_nonce={}",
            "a".repeat(64)
        );
        assert!(Boot::parse(&ok).is_ok());
        for s in [
            ok.replace("=1", "=0"),
            format!("{ok} mv_guest_command=1"),
            format!("{ok} mv_nonce={}", "b".repeat(64)),
            ok.replace("aaaa", "AAAA"),
            "mv_guest_command=1".into(),
        ] {
            assert!(Boot::parse(&s).is_err());
        }
    }
}
