//! Original filter, using the pinned libc Linux ABI constants.
//! AUDIT_ARCH_AARCH64 and seccomp_data offsets follow linux/audit.h and seccomp.h.
use crate::{refused, Result};

pub const ARCH_AARCH64: u32 = 0xc000_00b7;
fn stmt(code: u32, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code: code as u16,
        jt: 0,
        jf: 0,
        k,
    }
}
fn jump(code: u32, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter {
        code: code as u16,
        jt,
        jf,
        k,
    }
}
fn deny(errno: i32) -> libc::sock_filter {
    stmt(
        libc::BPF_RET | libc::BPF_K,
        libc::SECCOMP_RET_ERRNO | errno as u32,
    )
}
pub fn filter() -> Vec<libc::sock_filter> {
    let mut f = vec![
        stmt(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 4),
        jump(
            libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
            ARCH_AARCH64,
            1,
            0,
        ),
        stmt(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_KILL_PROCESS),
        stmt(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 0),
    ];
    let forbidden = [
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_kcmp,
        libc::SYS_pidfd_getfd,
        libc::SYS_userfaultfd,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_register,
        libc::SYS_io_uring_enter,
        libc::SYS_open_by_handle_at,
        libc::SYS_name_to_handle_at,
        libc::SYS_reboot,
        libc::SYS_kexec_load,
        libc::SYS_kexec_file_load,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_open_tree,
        libc::SYS_move_mount,
        libc::SYS_mount_setattr,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_keyctl,
        libc::SYS_capset,
        libc::SYS_prctl,
    ];
    for nr in forbidden {
        f.push(jump(
            libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
            nr as u32,
            0,
            1,
        ));
        f.push(deny(libc::EPERM));
    }
    f.push(jump(
        libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
        libc::SYS_clone3 as u32,
        0,
        1,
    ));
    f.push(deny(libc::ENOSYS)); // Permit libc's constrained legacy clone fallback.
    for nr in [libc::SYS_socket, libc::SYS_socketpair] {
        f.push(jump(
            libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
            nr as u32,
            0,
            4,
        ));
        f.push(stmt(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 16));
        f.push(jump(
            libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
            libc::AF_UNIX as u32,
            1,
            0,
        ));
        f.push(deny(libc::EPERM));
        f.push(stmt(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_ALLOW));
    }
    let namespaces = libc::CLONE_NEWCGROUP
        | libc::CLONE_NEWIPC
        | libc::CLONE_NEWNET
        | libc::CLONE_NEWNS
        | libc::CLONE_NEWPID
        | libc::CLONE_NEWUSER
        | libc::CLONE_NEWUTS
        | libc::CLONE_NEWTIME;
    f.push(jump(
        libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
        libc::SYS_clone as u32,
        0,
        4,
    ));
    f.push(stmt(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 16));
    f.push(jump(
        libc::BPF_JMP | libc::BPF_JSET | libc::BPF_K,
        namespaces as u32,
        0,
        1,
    ));
    f.push(deny(libc::EPERM));
    f.push(stmt(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_ALLOW));
    f.push(stmt(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_ALLOW));
    f
}

/// Called only in the guarded fork child, after chroot and credential changes.
pub(crate) unsafe fn install_in_child(program: &[libc::sock_filter]) -> Result<()> {
    if program.is_empty() || program.len() > 4096 {
        return Err(refused("filter size"));
    }
    let p = libc::sock_fprog {
        len: program.len() as u16,
        filter: program.as_ptr().cast_mut(),
    };
    if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
        || libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &p) != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn eval(nr: libc::c_long, arg: u32, arch: u32) -> u32 {
        let f = filter();
        let mut pc = 0usize;
        let mut a = 0;
        while pc < f.len() {
            let x = &f[pc];
            match x.code as u32 {
                c if c == libc::BPF_LD | libc::BPF_W | libc::BPF_ABS => {
                    a = match x.k {
                        0 => nr as u32,
                        4 => arch,
                        16 => arg,
                        _ => panic!("unexpected load"),
                    }
                }
                c if c == libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K => {
                    pc += if a == x.k { x.jt } else { x.jf } as usize
                }
                c if c == libc::BPF_JMP | libc::BPF_JSET | libc::BPF_K => {
                    pc += if a & x.k != 0 { x.jt } else { x.jf } as usize
                }
                c if c == libc::BPF_RET | libc::BPF_K => return x.k,
                _ => panic!("unexpected instruction"),
            }
            pc += 1;
        }
        panic!("no return")
    }
    #[test]
    fn network_management_and_namespace_escape_denied() {
        for n in [
            libc::SYS_unshare,
            libc::SYS_setns,
            libc::SYS_io_uring_setup,
            libc::SYS_mount,
            libc::SYS_ptrace,
            libc::SYS_bpf,
            libc::SYS_pidfd_getfd,
        ] {
            assert_eq!(
                eval(n, 0, ARCH_AARCH64),
                libc::SECCOMP_RET_ERRNO | libc::EPERM as u32
            );
        }
        for a in [
            libc::AF_VSOCK,
            libc::AF_INET,
            libc::AF_INET6,
            libc::AF_PACKET,
            libc::AF_NETLINK,
        ] {
            assert_ne!(
                eval(libc::SYS_socket, a as u32, ARCH_AARCH64),
                libc::SECCOMP_RET_ALLOW
            );
        }
        assert_eq!(
            eval(libc::SYS_socket, libc::AF_UNIX as u32, ARCH_AARCH64),
            libc::SECCOMP_RET_ALLOW
        );
        assert_ne!(
            eval(libc::SYS_clone, libc::CLONE_NEWUSER as u32, ARCH_AARCH64),
            libc::SECCOMP_RET_ALLOW
        );
        assert_eq!(
            eval(libc::SYS_clone, libc::SIGCHLD as u32, ARCH_AARCH64),
            libc::SECCOMP_RET_ALLOW
        );
        assert_eq!(
            eval(libc::SYS_read, 0, ARCH_AARCH64),
            libc::SECCOMP_RET_ALLOW
        );
        assert_eq!(eval(libc::SYS_read, 0, 0), libc::SECCOMP_RET_KILL_PROCESS);
    }
}
