package view

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
)

// ProcessRunner separates the foreground readiness line from process completion.
// The short runner retains the shared executable and private-state checks.
type ProcessRunner struct {
	short    cli.Runner
	root     string
	stateDir string
	env      []string
}

func NewProcessRunner(root string, environment []string) (*ProcessRunner, error) {
	short, err := capsule.NewProcessRunner(root, environment, 65536, time.Minute)
	if err != nil {
		return nil, err
	}
	r := &ProcessRunner{short: short, root: filepath.Clean(root)}
	for _, value := range environment {
		key, v, _ := strings.Cut(value, "=")
		if key == "MV_SRF_STATE_DIR" {
			r.stateDir = v
		} else {
			r.env = append(r.env, value)
		}
	}
	return r, nil
}
func (r *ProcessRunner) Run(ctx context.Context, args []string, input []byte) ([]byte, error) {
	if len(args) < 2 || args[0] != "srf-identity-surface" || (args[1] != "view-stop" && args[1] != "paste-text") {
		return nil, fault("usage", "unsupported operator command")
	}
	argv := append([]string(nil), args...)
	argv[0] = filepath.Join(r.root, argv[0])
	return r.short.Run(ctx, argv, input)
}
func (r *ProcessRunner) Start(ctx context.Context, args []string) (*Process, error) {
	if len(args) != 4 || args[0] != "srf-identity-surface" || (args[1] != "view" && args[1] != "login") || args[2] != "--container" || !identity.MatchString(args[3]) {
		return nil, fault("usage", "invalid view command")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Refuse a changed private state root before launching the foreground helper.
	info, err := stateDirInfo(r.stateDir)
	if err != nil || !filepath.IsAbs(r.stateDir) || filepath.Clean(r.stateDir) != r.stateDir || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode() != os.ModeDir|0700 {
		return nil, fault("configuration", "private operator state directory required")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return nil, fault("configuration", "operator state owner mismatch")
	}
	argv := append(append([]string(nil), args[1:]...), "--state-dir", r.stateDir)
	childCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	cmd := exec.CommandContext(childCtx, filepath.Join(r.root, args[0]), argv...)
	cmd.Env = append([]string(nil), r.env...)
	cmd.Stderr = io.Discard
	// [TARGET, unit decision] Own a dedicated process group for the foreground
	// view helper so descendants that close inherited stdout/stderr are signaled
	// and terminated before final reap. Never derive PIDs from stdout text.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	killGroup := func(sig syscall.Signal) error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		pid := cmd.Process.Pid
		if pid <= 1 || pid == os.Getpid() || pid == syscall.Getpgrp() {
			return fault("refused", "unsafe view process identity")
		}
		err := syscall.Kill(-pid, sig)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.Cancel = func() error {
		return killGroup(syscall.SIGINT)
	}
	// The helper restores read-only mode on interrupt; allow that cleanup to finish.
	cmd.WaitDelay = 15 * time.Second
	ready := make(chan []byte, 1)
	cmd.Stdout = &announcementWriter{ready: ready}
	if err = cmd.Start(); err != nil {
		cancel()
		return nil, fault("execution", "view launch failed")
	}
	done := make(chan error, 1)
	reaped := make(chan struct{})
	go func() {
		waitErr := cmd.Wait()
		_ = killGroup(syscall.SIGKILL)
		done <- waitErr
		cancel()
		close(reaped)
	}()
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	var line []byte
	exited := false
	select {
	case line = <-ready:
	case err = <-done:
		exited = true
		// A fast helper may announce and exit before the scheduler resumes us.
		select {
		case line = <-ready:
		default:
		}
		if line == nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				return nil, cli.ExitFault("srf-identity-surface", exit.ExitCode(), "")
			}
			return nil, fault("malformed_cli", "view exited before announcement")
		}
	case <-ctx.Done():
		cancel()
		<-done
		return nil, ctx.Err()
	case <-timer.C:
		cancel()
		<-done
		return nil, fault("unavailable", "view readiness deadline")
	}
	if _, err = parseInfo(line); err != nil {
		cancel()
		// done may already have been consumed by the fast-exit branch.
		if !exited {
			<-done
		}
		return nil, err
	}
	return &Process{Announcement: line, Done: reaped, Close: func() { cancel(); <-reaped }}, nil
}

func stateDirInfo(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, syscall.EINVAL
	}
	flags := syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	fd, err := syscall.Open("/", flags, 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		if fd >= 0 {
			_ = syscall.Close(fd)
		}
	}()
	if path != "/" {
		for _, part := range strings.Split(path[1:], "/") {
			next, err := syscall.Openat(fd, part, flags, 0)
			if err != nil {
				return nil, err
			}
			_ = syscall.Close(fd)
			fd = next
		}
	}
	file := os.NewFile(uintptr(fd), path)
	fd = -1
	defer func() { _ = file.Close() }()
	return file.Stat()
}

// NewFromEnvironment is called only by the trusted host configuration layer.
func NewFromEnvironment() (*Manager, error) {
	var environment []string
	for _, key := range []string{"PATH", "HOME", "XDG_RUNTIME_DIR", "MV_SRF_STATE_DIR", "SRF_IDENTITY_STORE_ROOT", "SRF_PROXY_REGISTRY", "SRF_EGRESS_PROXY"} {
		if value, ok := os.LookupEnv(key); ok {
			environment = append(environment, key+"="+value)
		}
	}
	r, err := NewProcessRunner(os.Getenv("MV_SRF_BIN_DIR"), environment)
	if err != nil {
		return nil, err
	}
	return NewManager(r), nil
}

var _ Runner = (*ProcessRunner)(nil)

// The foreground helper announces once. Later output is drained without retention.
type announcementWriter struct {
	ready   chan []byte
	pending []byte
	sent    bool
}

func (w *announcementWriter) Write(p []byte) (int, error) {
	n := len(p)
	if w.sent {
		return n, nil
	}
	end := bytes.IndexByte(p, '\n')
	part := p
	if end >= 0 {
		part = p[:end+1]
	}
	if len(w.pending)+len(part) > 65536 {
		w.sent = true
		w.ready <- nil
		return n, nil
	}
	w.pending = append(w.pending, part...)
	if end >= 0 {
		w.sent = true
		w.ready <- w.pending
		w.pending = nil
	}
	return n, nil
}
