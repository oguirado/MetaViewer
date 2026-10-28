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
			pidFile := filepath.Join(bin, "pids")
			binary := filepath.Join(bin, "srf-identity-surface")
			// argv supplies the executable path; no shell interpolation of paths.
			script := "#!/bin/sh\n\"$2\" 30 &\nchild=$!\nprintf '%s %s\\n' \"$$\" \"$child\" > \"$3\"\nwait \"$child\"\n"
			if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			const runnerTimeout = 3 * time.Second
			const deadlineTimeout = 500 * time.Millisecond
			const reapBudget = 200 * time.Millisecond
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
			go func() { _, err := r.Run(ctx, []string{binary, "start", sleep, pidFile}, nil); done <- err }()
			var pids []int
			identities := map[int]string{}
			t.Cleanup(func() {
				cancel()
				for pid, identity := range identities {
					if current, live := reapProcessIdentity(pid); live && current == identity {
						_ = syscall.Kill(pid, syscall.SIGKILL)
					}
				}
			})
			deadline := time.Now().Add(runnerTimeout)
			for time.Now().Before(deadline) {
				raw, err := os.ReadFile(pidFile)
				if err == nil && len(strings.Fields(string(raw))) == 2 {
					for _, word := range strings.Fields(string(raw)) {
						pid, err := strconv.Atoi(word)
						if err != nil || pid <= 1 || pid == os.Getpid() {
							t.Fatalf("invalid child pid: %q", word)
						}
						identity, live := reapProcessIdentity(pid)
						if !live {
							t.Fatalf("fixture did not start live process %d", pid)
						}
						pids = append(pids, pid)
						identities[pid] = identity
					}
					break
				}
				time.Sleep(time.Millisecond)
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
			sentinelIdentity, live := reapProcessIdentity(sentinel.Process.Pid)
			if !live {
				t.Fatal("sentinel did not start")
			}
			if mode == "cancel" {
				cancel()
			}
			select {
			case err := <-done:
				var f *cli.Fault
				if !errors.As(err, &f) || f.Code != "uncertain" {
					t.Fatalf("cancel result: %v", err)
				}
			case <-time.After(runnerTimeout):
				t.Fatal("Run did not join")
			}
			// A zombie has exited and cannot execute or hold descriptors. Its
			// adoption/reap belongs to init; require no surviving executable child.
			// SIGKILL to the process group is asynchronous across group members:
			// cmd.Run() waits only for the leader, while the kernel may finish
			// transitioning a sibling descendant to Z/X on another core shortly
			// after the leader is reaped.
			if surviving := waitDescendantsExited(pids, identities, reapBudget); len(surviving) != 0 {
				for _, pid := range surviving {
					t.Errorf("surviving native descendant pid=%d", pid)
				}
			}
			if identity, live := reapProcessIdentity(sentinel.Process.Pid); !live || identity != sentinelIdentity {
				t.Fatal("unrelated child was killed")
			}
			// Negative control: a live child with matching identity is detected as surviving.
			if surviving := waitDescendantsExited([]int{sentinel.Process.Pid}, map[int]string{sentinel.Process.Pid: sentinelIdentity}, 5*time.Millisecond); len(surviving) != 1 || surviving[0] != sentinel.Process.Pid {
				t.Fatalf("negative control failed to detect surviving process: %v", surviving)
			}
		})
	}
}

func waitDescendantsExited(pids []int, identities map[int]string, budget time.Duration) []int {
	deadline := time.Now().Add(budget)
	var surviving []int
	for _, pid := range pids {
		for {
			identity, live := reapProcessIdentity(pid)
			if !live || identity != identities[pid] {
				break
			}
			if !time.Now().Before(deadline) {
				surviving = append(surviving, pid)
				break
			}
			time.Sleep(time.Millisecond)
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
