use crate::{guard::GuestAuthority, refused, Result};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::MetadataExt;

pub(crate) fn cstring(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| refused("NUL in path"))
}
pub(crate) fn owned(fd: RawFd) -> Result<OwnedFd> {
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}
pub(crate) fn open_directory(parent: RawFd, name: &str) -> Result<OwnedFd> {
    let name = cstring(name)?;
    owned(unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    })
}
pub(crate) fn stat_fd(fd: RawFd) -> Result<libc::stat> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, st.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { st.assume_init() })
}
pub(crate) fn require_root_directory(fd: RawFd) -> Result<()> {
    let st = stat_fd(fd)?;
    if st.st_uid != 0 || st.st_mode & libc::S_IFMT != libc::S_IFDIR || st.st_mode & 0o022 != 0 {
        return Err(refused("root-owned non-writable directory required"));
    }
    Ok(())
}
pub(crate) fn filesystem(fd: RawFd, magic: libc::c_long) -> Result<()> {
    let mut st = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(fd, st.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { st.assume_init() }.f_type != magic {
        return Err(refused("wrong guest filesystem"));
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct RelativeCwd(Vec<String>);
impl RelativeCwd {
    pub fn new(value: &str) -> Result<Self> {
        if value.is_empty() {
            return Ok(Self(Vec::new()));
        }
        if value.len() > 1024 || value.starts_with('/') {
            return Err(refused("relative cwd required"));
        }
        let parts: Vec<_> = value.split('/').collect();
        if parts.iter().any(|s| {
            s.is_empty()
                || *s == "."
                || *s == ".."
                || s.len() > 255
                || s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        }) {
            return Err(refused("unsafe cwd component"));
        }
        Ok(Self(parts.into_iter().map(str::to_owned).collect()))
    }
}

/// Pre-existing guest jail only; this foundation does not fabricate a mounted jail.
pub struct Jail {
    root: OwnedFd,
    work: OwnedFd,
    uid: u32,
    gid: u32,
}
impl Jail {
    pub fn verify(authority: &GuestAuthority, uid: u32, gid: u32) -> Result<Self> {
        authority.check()?;
        if uid == 0 || gid == 0 {
            return Err(refused("unprivileged job identity required"));
        }
        let root = open_directory(libc::AT_FDCWD, "/sandbox")?;
        require_root_directory(root.as_raw_fd())?;
        for entry in std::fs::read_dir(format!("/proc/self/fd/{}", root.as_raw_fd()))? {
            let entry = entry?;
            let name = entry.file_name();
            if !matches!(name.to_str(), Some("bin" | "etc" | "dev" | "proc" | "work")) {
                return Err(refused("unexpected jail root entry"));
            }
        }
        for name in ["bin", "etc", "dev", "proc"] {
            let dir = open_directory(root.as_raw_fd(), name)?;
            require_root_directory(dir.as_raw_fd())?;
            let mut fs = std::mem::MaybeUninit::<libc::statvfs>::uninit();
            if unsafe { libc::fstatvfs(dir.as_raw_fd(), fs.as_mut_ptr()) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if unsafe { fs.assume_init() }.f_flag & libc::ST_RDONLY == 0 {
                return Err(refused("jail base mount is not read-only"));
            }
            if name == "dev" {
                let mut found_null = false;
                for entry in std::fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd()))? {
                    let entry = entry?;
                    let name = entry.file_name();
                    let st = entry.path().symlink_metadata()?;
                    if st.uid() != 0
                        || !allowed_device(name.to_str().unwrap_or(""), st.mode(), st.rdev())
                    {
                        return Err(refused("unapproved guest device"));
                    }
                    found_null |= name == "null";
                }
                if !found_null {
                    return Err(refused("guest null device missing"));
                }
            }
        }
        // No nonce-bearing cmdline is allowed inside the job's proc view.
        let path = cstring("proc/cmdline")?;
        let cmdline = owned(unsafe {
            libc::openat(
                root.as_raw_fd(),
                path.as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })?;
        let mut byte = 0u8;
        if unsafe { libc::read(cmdline.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) } != 0 {
            return Err(refused("job proc cmdline must be masked"));
        }
        let work = open_directory(root.as_raw_fd(), "work")?;
        filesystem(work.as_raw_fd(), libc::TMPFS_MAGIC)?;
        let st = stat_fd(work.as_raw_fd())?;
        if st.st_uid != uid || st.st_gid != gid || st.st_mode & 0o777 != 0o700 {
            return Err(refused("private job workspace required"));
        }
        let mut capacity = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::fstatvfs(work.as_raw_fd(), capacity.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let capacity = unsafe { capacity.assume_init() };
        if capacity
            .f_blocks
            .checked_mul(capacity.f_frsize)
            .is_none_or(|n| n > 64 * 1024 * 1024)
        {
            return Err(refused("workspace tmpfs exceeds foundation ceiling"));
        }
        Ok(Self {
            root,
            work,
            uid,
            gid,
        })
    }
    pub fn cwd(&self, authority: &GuestAuthority, relative: &RelativeCwd) -> Result<OwnedFd> {
        authority.check()?;
        // Re-resolve from this exact chroot descriptor. A detached/replaced
        // workspace must not turn a retained fd into an outside cwd.
        let mut fd = open_directory(self.root.as_raw_fd(), "work")?;
        let original = stat_fd(self.work.as_raw_fd())?;
        let current = stat_fd(fd.as_raw_fd())?;
        if original.st_dev != current.st_dev
            || original.st_ino != current.st_ino
            || current.st_uid != self.uid
            || current.st_gid != self.gid
            || current.st_mode & 0o777 != 0o700
        {
            return Err(refused("workspace identity or permissions changed"));
        }
        filesystem(fd.as_raw_fd(), libc::TMPFS_MAGIC)?;
        for part in &relative.0 {
            fd = open_directory(fd.as_raw_fd(), part)?;
        }
        Ok(fd)
    }
    pub(crate) fn root_fd(&self) -> RawFd {
        self.root.as_raw_fd()
    }
    pub(crate) fn identity_matches(&self, uid: u32, gid: u32) -> bool {
        self.uid == uid && self.gid == gid
    }
}
fn allowed_device(name: &str, mode: u32, rdev: u64) -> bool {
    let minor = match name {
        "null" => 3,
        "zero" => 5,
        "random" => 8,
        "urandom" => 9,
        _ => return false,
    };
    mode & libc::S_IFMT == libc::S_IFCHR && libc::major(rdev) == 1 && libc::minor(rdev) == minor
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cwd_construction_refuses_escape_and_aliases() {
        for s in ["/work", "..", "a/../b", "a//b", "./a", "a/", "a\0b"] {
            assert!(RelativeCwd::new(s).is_err(), "{s:?}");
        }
        assert!(RelativeCwd::new("").is_ok());
        assert!(RelativeCwd::new("project/src-1").is_ok());
    }
    #[test]
    fn device_allowlist_excludes_kernel_and_block_interfaces() {
        assert!(allowed_device(
            "null",
            libc::S_IFCHR | 0o666,
            libc::makedev(1, 3)
        ));
        assert!(!allowed_device(
            "mem",
            libc::S_IFCHR | 0o666,
            libc::makedev(1, 1)
        ));
        assert!(!allowed_device("null", libc::S_IFLNK | 0o777, 0));
        assert!(!allowed_device(
            "kvm",
            libc::S_IFCHR | 0o666,
            libc::makedev(10, 232)
        ));
    }
}
