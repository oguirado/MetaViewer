# ARM guest command broker candidate

This standalone Cargo project implements the reviewed MVGC transport and a
single-threaded guest PID1 command dispatcher. It is a source candidate, not a
runtime acceptance. It must never be launched as a host command.

Main first checks root, PID1 and AArch64. Its sole pre-boot-marker effect is the
minimal proc mount needed to read the kernel command line. It then requires one
`mv_guest_command=1` and one lower-hex `mv_nonce`, before mounting sysfs/cgroup2,
masking proc cmdline, creating the jail or opening the vsock listener. Any failed
startup or uncertain session leads to guest-only poweroff; the host still owns
independent native closure proof. Pure tests do not invoke main or forge the
nonconstructible GuestAuthority capability.

## Bootstrap and isolation

The pinned image supplies BusyBox and the initial directories/devices. Bootstrap
binds bin/etc/dev/proc read-only into a new read-only `/sandbox`, masks the global
proc cmdline with the empty protected image file, and mounts private `/work`
RAM for UID/GID 10000 [TARGET]. The workspace ceiling is 64 MiB [TARGET]. The
broker does not expose sysfs/cgroup controls inside the jail. Each child waits on
its private pipe until its immutable PID is assigned to a root-owned job cgroup.
Cwd is resolved inside the retained jail with nofollow directory walks. Child
setsid/chroot, drops groups/UID/GID/capabilities, sets no-new-privileges/seccomp,
closes inherited FDs, and execs fixed `/bin/sh -c` with a fixed environment.

The job cgroup ceiling is 128 MiB and 64 pids [TARGET], below the externally
admitted 256 MiB guest [TARGET]. Memory swap is zero [TARGET]. The current kernel
has no CFS_BANDWIDTH; no guest cpu.max is claimed. The external CPU cap and wall
lifetime remain mandatory. The seccomp filter rejects non-AArch64 ABI, non-Unix
sockets including AF_VSOCK, io_uring, namespaces, mounts and management access.

## Transport and lifecycle

One vsock connection on port 19001 [TARGET] accepts only peer host CID 2 [TARGET].
The kernel-configured guest CID 3 is a host-profile responsibility [TARGET].
The boot nonce authenticates the initial host HELLO; its owner/profile/tuple are
then immutable. A single guest sender emits ready, accepted, output,
job_finished and stopping. No native absence is asserted by guest events.

The parser checks the fixed header before allocating the bounded body, handles
fragmented frames without renewing their first-byte deadline, and preserves
independent directional sequences. The send queue is bounded at 128 KiB
[TARGET]; a blocked frame fails after at most 3000 ms, capped by guest lifetime
[TARGET]. It never retries a failed send or reconnects. Output counters increase
only when the full corresponding frame is written. Stdout/stderr chunks remain
separate and combine to at most 65536 retained bytes per job [TARGET]. Overflow
terminates the job and keeps draining; incomplete ordinary output cannot become
normal completion.

Commands execute sequentially, with at most 64 jobs [TARGET]. Workspace files
persist; shell state and background processes do not. Cancel and Stop ACKs are
queued before signaling. SIGTERM targets the retained process group, followed
by cgroup.kill after 250 ms [TARGET]. A normally exited shell also triggers
cgroup.kill for background descendants. Completion requires leader wait status,
all children reaped, cgroup populated=0, both pipe EOFs and all output frames
sent. A normal exit racing an accepted control retains the control ID and cause
exit. The next job is blocked until the terminal frame is sent. Stop fences all
future jobs and emits stopping only after cleanup; host native closure remains
independent.

Guest lifetime is 60000 ms from startup [TARGET], never extended. Job deadlines
reserve 1000 ms for closure [TARGET]. The host's shorter 55000 ms lifetime
[TARGET] remains external. Any socket/exec/cgroup/cleanup uncertainty powers off
and must remain unknown at the host; no fabricated job result is emitted.

## Validation boundary

Pure tests and a static ARM64 build cover syntax, framing, schema bounds,
identity, history, status decoding and foundation invariants. They do not prove
mount behavior, actual cgroup enforcement, vsock/BusyBox/seccomp compatibility,
real cancellation or native closure. Independent source review and a fresh
bounded guest proof are still required. Dependency versions match the existing
parent Cargo.lock. Static build uses existing Rust with
`-C target-feature=+crt-static -C relocation-model=static`; no host installs,
network, shell-command probes or guest effects belong in host tests.
