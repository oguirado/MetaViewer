package capsule

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

// Mutation: replace group cancellation with cmd.Process.Kill; the descendant
// retains its original /proc identity and remains executable after Run returns.
func TestTimeoutAndCancelReapDescendants(t *testing.T) {
	for _, mode := range []string{"deadline", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			sleep, err := exec.LookPath("sleep")
			if err != nil {
				t.Fatal(err)
			}
			bin := t.TempDir()
			pidPipe := filepath.Join(bin, "pids.fifo")
			if err := syscall.Mkfifo(pidPipe, 0600); err != nil {
				t.Fatal(err)
			}
			binary := filepath.Join(bin, "srf-identity-surface")
			// argv supplies the executable path; no shell interpolation of paths.
			script := "#!/bin/sh\n\"$2\" 30 &\nchild=$!\nprintf '%s %s\\n' \"$$\" \"$child\" > \"$3\"\nwait \"$child\"\n"
			if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			const runnerTimeout = 3 * time.Second
			const deadlineTimeout = 500 * time.Millisecond
			r, err := NewProcessRunner(bin, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + filepath.Join(t.TempDir(), "state")}, 4096, runnerTimeout)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "deadline" {
				ctx, cancel = context.WithTimeout(ctx, deadlineTimeout)
				defer cancel()
			}
			done := make(chan error, 1)
			go func() { _, err := r.Run(ctx, []string{binary, "start", sleep, pidPipe}, nil); done <- err }()
			var pids []int
			identities := map[int]string{}
			pidfds := map[int]int{}
			t.Cleanup(func() {
				cancel()
				for _, fd := range pidfds {
					_ = syscall.Close(fd)
				}
				for pid, identity := range identities {
					if current, live := reapProcessIdentity(pid); live && current == identity {
						_ = syscall.Kill(pid, syscall.SIGKILL)
					}
				}
			})
			raw, err := os.ReadFile(pidPipe)
			if err != nil {
				t.Fatalf("read pid pipe: %v", err)
			}
			for _, word := range strings.Fields(string(raw)) {
				pid, err := strconv.Atoi(word)
				if err != nil || pid <= 1 || pid == os.Getpid() {
					t.Fatalf("invalid child pid: %q", word)
				}
				fd, err := openPidfd(pid)
				if err != nil {
					t.Fatalf("pidfd_open(%d): %v", pid, err)
				}
				pidfds[pid] = fd
				identity, live := reapProcessIdentity(pid)
				if !live {
					t.Fatalf("fixture did not start live process %d", pid)
				}
				pids = append(pids, pid)
				identities[pid] = identity
			}
			if len(pids) != 2 {
				t.Fatal("CLI and descendant did not announce readiness")
			}
			// Negative control: an unrelated live child must survive cancellation.
			sentinel := exec.Command(sleep, "30")
			if err := sentinel.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = sentinel.Process.Kill(); _ = sentinel.Wait() })
			sentinelPidfd, err := openPidfd(sentinel.Process.Pid)
			if err != nil {
				t.Fatalf("pidfd_open(sentinel): %v", err)
			}
			t.Cleanup(func() { _ = syscall.Close(sentinelPidfd) })
			sentinelIdentity, live := reapProcessIdentity(sentinel.Process.Pid)
			if !live {
				t.Fatal("sentinel did not start")
			}
			if mode == "cancel" {
				cancel()
			}
			err = <-done
			var f *cli.Fault
			if !errors.As(err, &f) || f.Code != "uncertain" {
				t.Fatalf("cancel result: %v", err)
			}
			// A zombie has exited and cannot execute or hold descriptors. Its
			// adoption/reap belongs to init; require no surviving executable child.
			// SIGKILL to the process group is asynchronous across group members:
			// wait on the kernel pidfd exit notification when the sibling is already
			// terminating in the kernel, then assert once after the event fires.
			if surviving := waitDescendantsExited(pids, identities, pidfds); len(surviving) != 0 {
				for _, pid := range surviving {
					t.Errorf("surviving native descendant pid=%d", pid)
				}
			}
			if identity, live := reapProcessIdentity(sentinel.Process.Pid); !live || identity != sentinelIdentity {
				t.Fatal("unrelated child was killed")
			}
			// Negative control: a live child with matching identity is detected as surviving.
			if surviving := waitDescendantsExited([]int{sentinel.Process.Pid}, map[int]string{sentinel.Process.Pid: sentinelIdentity}, map[int]int{sentinel.Process.Pid: sentinelPidfd}); len(surviving) != 1 || surviving[0] != sentinel.Process.Pid {
				t.Fatalf("negative control failed to detect surviving process: %v", surviving)
			}
		})
	}
}

const (
	sysPidfdOpen = 434
	pfExiting    = 0x4
)

func openPidfd(pid int) (int, error) {
	fd, _, errno := syscall.Syscall(sysPidfdOpen, uintptr(pid), 0, 0)
	if errno != 0 {
		return -1, errno
	}
	return int(fd), nil
}

func waitPidfdExit(pidfd int) error {
	epfd, err := syscall.EpollCreate1(syscall.EPOLL_CLOEXEC)
	if err != nil {
		return err
	}
	defer syscall.Close(epfd)
	ev := syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(pidfd)}
	if err := syscall.EpollCtl(epfd, syscall.EPOLL_CTL_ADD, pidfd, &ev); err != nil {
		return err
	}
	var events [1]syscall.EpollEvent
	for {
		n, err := syscall.EpollWait(epfd, events[:], -1)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
	}
}

func isKernelTerminating(pid int, expectedIdentity string) bool {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	end := strings.LastIndexByte(string(raw), ')')
	if end < 0 {
		return false
	}
	fields := strings.Fields(string(raw[end+1:]))
	if len(fields) <= 19 || fields[19] != expectedIdentity || fields[0] == "Z" || fields[0] == "X" {
		return false
	}
	if flags, err := strconv.ParseUint(fields[6], 10, 64); err == nil && flags&pfExiting != 0 {
		return true
	}
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return false
	}
	const sigkillBit = uint64(1) << (uint(syscall.SIGKILL) - 1)
	for _, line := range strings.Split(string(status), "\n") {
		if rest, ok := strings.CutPrefix(line, "SigPnd:\t"); ok {
			if mask, err := strconv.ParseUint(strings.TrimSpace(rest), 16, 64); err == nil && mask&sigkillBit != 0 {
				return true
			}
		}
		if rest, ok := strings.CutPrefix(line, "ShdPnd:\t"); ok {
			if mask, err := strconv.ParseUint(strings.TrimSpace(rest), 16, 64); err == nil && mask&sigkillBit != 0 {
				return true
			}
		}
	}
	return false
}

func waitDescendantsExited(pids []int, identities map[int]string, pidfds map[int]int) []int {
	var surviving []int
	for _, pid := range pids {
		if fd, ok := pidfds[pid]; ok && isKernelTerminating(pid, identities[pid]) {
			_ = waitPidfdExit(fd)
		}
		if identity, live := reapProcessIdentity(pid); live && identity == identities[pid] {
			surviving = append(surviving, pid)
		}
	}
	return surviving
}

func reapProcessIdentity(pid int) (string, bool) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", false
	}
	end := strings.LastIndexByte(string(raw), ')')
	if end < 0 {
		return "", false
	}
	fields := strings.Fields(string(raw[end+1:]))
	if len(fields) <= 19 {
		return "", false
	}
	return fields[19], fields[0] != "Z" && fields[0] != "X"
}
