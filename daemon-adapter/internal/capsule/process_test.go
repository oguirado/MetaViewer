package capsule

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

func processTimeoutScale() time.Duration {
	if raw := strings.TrimSpace(os.Getenv("MV_CI_TIMEOUT_SCALE")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 1 {
			return time.Duration(n)
		}
	}
	if os.Getenv("CI") != "" || os.Getenv("GITHUB_ACTIONS") != "" {
		return 2
	}
	return 1
}

// holdFifos creates a (ready, release) FIFO pair. A background goroutine waits
// for the child to signal readiness on readyFifo, then holds releaseFifo open
// until closeHold runs (or releases after releaseAfter if non-zero).
func holdFifos(t *testing.T, releaseAfter time.Duration) (string, string) {
	t.Helper()
	dir := t.TempDir()
	ready := filepath.Join(dir, "ready.fifo")
	release := filepath.Join(dir, "release.fifo")
	if err := syscall.Mkfifo(ready, 0600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(release, 0600); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	var closed bool
	t.Cleanup(func() {
		if !closed {
			closed = true
			close(stop)
		}
		if f, err := syscall.Open(ready, syscall.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
			_ = syscall.Close(f)
		}
		if f, err := syscall.Open(release, syscall.O_RDONLY|syscall.O_NONBLOCK, 0); err == nil {
			_ = syscall.Close(f)
		}
		<-done
	})
	go func() {
		defer close(done)
		rf, err := os.OpenFile(ready, os.O_RDONLY, 0)
		if err != nil {
			return
		}
		buf := make([]byte, 8)
		_, _ = rf.Read(buf)
		_ = rf.Close()
		wf, err := os.OpenFile(release, os.O_WRONLY, 0)
		if err != nil {
			return
		}
		defer wf.Close()
		if releaseAfter > 0 {
			select {
			case <-time.After(releaseAfter):
				_, _ = wf.Write([]byte("x"))
			case <-stop:
			}
		} else {
			<-stop
		}
	}()
	return ready, release
}

func TestProcessBoundary(t *testing.T) {
	root, e := filepath.Abs("testdata")
	if e != nil {
		t.Fatal(e)
	}
	scale := processTimeoutScale()
	env := []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + filepath.Join(t.TempDir(), "state")}
	// [TARGET, unit decision] Separate admitted-call budget (5 s * scale) from
	// timeout-refusal budget (50 ms * scale) so loaded CI runners never fail
	// start/environment on wall-clock startup latency while delay blocks on a
	// test-controlled FIFO until the runner timeout kills it.
	r, e := NewProcessRunner(root, env, 4096, 5*time.Second*scale)
	if e != nil {
		t.Fatal(e)
	}
	delayTimeout := 50 * time.Millisecond * scale
	rDelay, e := NewProcessRunner(root, env, 4096, delayTimeout)
	if e != nil {
		t.Fatal(e)
	}
	readyFifo, releaseFifo := holdFifos(t, 5*delayTimeout)
	binary := filepath.Join(root, "srf-identity-surface")
	out, e := r.Run(context.Background(), []string{binary, "start"}, nil)
	if e != nil || len(out) == 0 {
		t.Fatalf("fake CLI failed: %v", e)
	}
	t.Setenv("UNADMITTED_TEST_SECRET", "synthetic")
	out, e = r.Run(context.Background(), []string{binary, "environment"}, nil)
	if e != nil || string(out) != "{\"clean\": true}\n" {
		t.Fatal("ambient environment escaped")
	}
	for _, verb := range []string{"overflow", "delay", "refused"} {
		runner := r
		argv := []string{binary, verb}
		if verb == "delay" {
			runner = rDelay
			argv = []string{binary, verb, readyFifo, releaseFifo}
		}
		if _, e = runner.Run(context.Background(), argv, nil); e == nil {
			t.Fatalf("unbounded or failed CLI accepted: %s", verb)
		} else if verb == "delay" {
			// Mutant guard: if ProcessRunner no longer enforces its configured
			// timeout, releaseFifo unblocks after 5x delayTimeout (post-ready)
			// and the child exits 0, failing the e == nil check above.
			var f *cli.Fault
			if !errors.As(e, &f) || f.Code != "uncertain" {
				t.Fatalf("expected uncertain timeout fault for delay, got %v", e)
			}
		}
	}
	if _, e = r.Run(context.Background(), []string{"/bin/sh", "-c", "true"}, nil); e == nil {
		t.Fatal("unadmitted executable accepted")
	}
	if _, e = NewProcessRunner(root, []string{"PATH=/usr/bin:/bin", "UNADMITTED_TEST_SECRET=x"}, 4096, time.Second); e == nil {
		t.Fatal("unadmitted environment accepted")
	}
}

func TestRuntimeRequiresBinaryEnvironment(t *testing.T) {
	t.Setenv("MV_SRF_BIN_DIR", "")
	if _, e := NewRuntime(Config{}, func() uint64 { return 1 }); e == nil {
		t.Fatal("missing binary environment accepted")
	}
}
