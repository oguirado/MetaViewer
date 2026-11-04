package capsule

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

const defaultHoldCleanupTimeout = 5 * time.Second

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

type holdFifoHooks struct {
	cleanupTimeout    time.Duration
	beforeOpenReady   func()
	afterOpenReady    func()
	beforeOpenRelease func()
	beforeWaitDone    func()
}

type fifoHold struct {
	ready   string
	release string
	stop    chan struct{}
	done    chan struct{}
	timeout time.Duration
	hooks   holdFifoHooks
	closed  bool
}

func newHoldFifos(t *testing.T, releaseAfter time.Duration, hooks holdFifoHooks) *fifoHold {
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
	timeout := hooks.cleanupTimeout
	if timeout <= 0 {
		timeout = defaultHoldCleanupTimeout * processTimeoutScale()
	}
	h := &fifoHold{
		ready:   ready,
		release: release,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		timeout: timeout,
		hooks:   hooks,
	}
	// [TARGET, unit decision] Open both FIFO ends with O_RDWR and gate every stage
	// on h.stop so the helper goroutine never blocks in open(2) when the child exits
	// early or when cleanup runs before the goroutine reaches ready/release.
	var rf *os.File
	if hooks.beforeOpenReady == nil {
		var err error
		rf, err = os.OpenFile(ready, os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
	}
	go func() {
		defer close(h.done)
		if rf == nil {
			hooks.beforeOpenReady()
			select {
			case <-h.stop:
				return
			default:
			}
			var err error
			rf, err = os.OpenFile(ready, os.O_RDWR, 0)
			if err != nil {
				return
			}
		}
		if hooks.afterOpenReady != nil {
			hooks.afterOpenReady()
		}
		select {
		case <-h.stop:
			_ = rf.Close()
			return
		default:
		}
		buf := make([]byte, 8)
		_, _ = rf.Read(buf)
		_ = rf.Close()
		if hooks.beforeOpenRelease != nil {
			hooks.beforeOpenRelease()
		}
		select {
		case <-h.stop:
			return
		default:
		}
		wf, err := os.OpenFile(release, os.O_RDWR, 0)
		if err != nil {
			return
		}
		defer wf.Close()
		if releaseAfter > 0 {
			timer := time.NewTimer(releaseAfter)
			defer timer.Stop()
			select {
			case <-timer.C:
				_, _ = wf.Write([]byte("x"))
			case <-h.stop:
				return
			}
		}
		<-h.stop
	}()
	return h
}

func (h *fifoHold) Close() error {
	if !h.closed {
		h.closed = true
		close(h.stop)
	}
	if f, err := syscall.Open(h.ready, syscall.O_RDWR|syscall.O_NONBLOCK, 0); err == nil {
		_, _ = syscall.Write(f, []byte("x"))
		defer syscall.Close(f)
	}
	if f, err := syscall.Open(h.release, syscall.O_RDWR|syscall.O_NONBLOCK, 0); err == nil {
		defer syscall.Close(f)
	}
	if h.hooks.beforeWaitDone != nil {
		h.hooks.beforeWaitDone()
	}
	timer := time.NewTimer(h.timeout)
	defer timer.Stop()
	select {
	case <-h.done:
		return nil
	case <-timer.C:
		return fmt.Errorf("holdFifos cleanup timed out after %v waiting for helper goroutine", h.timeout)
	}
}

// holdFifos creates a (ready, release) FIFO pair. A background goroutine waits
// for the child to signal readiness on readyFifo, then holds releaseFifo open
// until cleanup runs (or releases after releaseAfter if non-zero).
func holdFifos(t *testing.T, releaseAfter time.Duration) (string, string) {
	t.Helper()
	h := newHoldFifos(t, releaseAfter, holdFifoHooks{})
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Fatal(err)
		}
	})
	return h.ready, h.release
}

func TestHoldFifosCleanupOrdering(t *testing.T) {
	waitStage := func(t *testing.T, ch <-chan struct{}, label string) {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(100 * time.Millisecond * processTimeoutScale()):
			t.Fatalf("timed out waiting for %s", label)
		}
	}

	t.Run("cleanup_before_release_open", func(t *testing.T) {
		atRelease := make(chan struct{})
		proceedRelease := make(chan struct{})
		h := newHoldFifos(t, 0, holdFifoHooks{
			cleanupTimeout: 100 * time.Millisecond * processTimeoutScale(),
			beforeOpenRelease: func() {
				close(atRelease)
				<-proceedRelease
			},
			beforeWaitDone: func() {
				close(proceedRelease)
			},
		})
		f, err := os.OpenFile(h.ready, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte("ready")); err != nil {
			_ = f.Close()
			t.Fatal(err)
		}
		_ = f.Close()
		waitStage(t, atRelease, "beforeOpenRelease")
		if err := h.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("cleanup_before_ready_open", func(t *testing.T) {
		atReady := make(chan struct{})
		proceedReady := make(chan struct{})
		h := newHoldFifos(t, 0, holdFifoHooks{
			cleanupTimeout: 100 * time.Millisecond * processTimeoutScale(),
			beforeOpenReady: func() {
				close(atReady)
				<-proceedReady
			},
			beforeWaitDone: func() {
				close(proceedReady)
			},
		})
		waitStage(t, atReady, "beforeOpenReady")
		if err := h.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("cleanup_without_child_activity", func(t *testing.T) {
		readyOpened := make(chan struct{})
		h := newHoldFifos(t, 0, holdFifoHooks{
			cleanupTimeout: 100 * time.Millisecond * processTimeoutScale(),
			afterOpenReady: func() {
				close(readyOpened)
			},
		})
		waitStage(t, readyOpened, "afterOpenReady")
		if err := h.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("cleanup_bound_fires_when_helper_wedged", func(t *testing.T) {
		atReady := make(chan struct{})
		unblock := make(chan struct{})
		h := newHoldFifos(t, 0, holdFifoHooks{
			cleanupTimeout: 20 * time.Millisecond,
			beforeOpenReady: func() {
				close(atReady)
				<-unblock
			},
		})
		defer func() {
			close(unblock)
			select {
			case <-h.done:
			case <-time.After(100 * time.Millisecond * processTimeoutScale()):
			}
		}()
		waitStage(t, atReady, "beforeOpenReady")
		err := h.Close()
		if err == nil || !strings.Contains(err.Error(), "holdFifos cleanup timed out") {
			t.Fatalf("expected holdFifos cleanup timeout error, got %v", err)
		}
	})
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

// A writable demonstration owns the native control lock until sealing. Capture
// must wait without spawning a frame command or declaring the capsule absent.
func TestDemoControlLockDefersFrameAndResumes(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	os.Chmod(state, 0700)
	binary := filepath.Join(root, "srf-identity-surface")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf 'frame-resumed'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(filepath.Join(state, "control.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	r, err := NewProcessRunner(root, []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + state}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	args := []string{binary, "frame", "--container", "srf-id-demo"}
	for i := 0; i < 3; i++ {
		out, err := r.Run(context.Background(), args, nil)
		var f *cli.Fault
		if !errors.As(err, &f) || f.Code != "native_busy" || IsAbsenceFault(err) || len(out) != 0 {
			t.Fatalf("recording contention must defer capture, got %q, %v", out, err)
		}
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	out, err := r.Run(context.Background(), args, nil)
	if err != nil || string(out) != "frame-resumed" {
		t.Fatalf("capture did not resume after seal: %q %v", out, err)
	}
}
