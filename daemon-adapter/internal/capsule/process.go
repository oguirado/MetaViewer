package capsule

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

// [TARGET, unit decision] Executables and environment are configured at the
// trusted seam; no request may add an executable, environment key or shell text.
type ProcessRunner struct {
	// Native identity commands share a control lock. Keep our probe and the
	// following command in one cancellable lane so our own captures cannot be
	// mistaken for an external recorder holding that lock.
	nativeGate chan struct{}
	stateDir   string
	stat       func(string) (os.FileInfo, error)
	env        []string
	limit      int
	timeout    time.Duration
	root       string
}

func NewProcessRunner(binDir string, environment []string, maxOutput int, timeout time.Duration) (*ProcessRunner, error) {
	if !filepath.IsAbs(binDir) || maxOutput < 1 || maxOutput > 1<<20 || timeout <= 0 || timeout > 3*time.Minute {
		return nil, fault("configuration", "bounded process configuration required")
	}
	allowed := map[string]bool{"PATH": true, "HOME": true, "XDG_RUNTIME_DIR": true, "MV_SRF_STATE_DIR": true, "SRF_IDENTITY_STORE_ROOT": true, "SRF_PROXY_REGISTRY": true, "SRF_EGRESS_PROXY": true}
	var stateDir string
	var childEnv []string
	seen := map[string]bool{}
	for _, v := range environment {
		k, _, ok := strings.Cut(v, "=")
		if !ok || !allowed[k] || seen[k] || strings.ContainsRune(v, 0) {
			return nil, fault("configuration", "unadmitted process environment")
		}
		seen[k] = true
		if k == "MV_SRF_STATE_DIR" {
			_, stateDir, _ = strings.Cut(v, "=")
		} else {
			childEnv = append(childEnv, v)
		}
	}
	if !seen["PATH"] {
		return nil, fault("configuration", "explicit process search path required")
	}
	return &ProcessRunner{nativeGate: make(chan struct{}, 1), env: childEnv, stateDir: stateDir, stat: stateDirInfo, limit: maxOutput, timeout: timeout, root: filepath.Clean(binDir)}, nil
}

// [TARGET, unit decision] State configuration is captured with the trusted
// environment and revalidated before every identity verb. Reject symlinks and
// special permission bits; create only the final directory, never its parents.
func (r *ProcessRunner) validateStateDir() error {
	refuse := func() error {
		return fault("configuration", "MV_SRF_STATE_DIR must be a current-uid directory with mode 0700")
	}
	if !filepath.IsAbs(r.stateDir) || filepath.Clean(r.stateDir) != r.stateDir {
		return refuse()
	}
	st, err := r.stat(r.stateDir)
	if err != nil {
		return refuse()
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || !st.IsDir() || st.Mode() != os.ModeDir|0700 {
		return refuse()
	}
	return nil
}

// The native writable viewer holds control.lock through demo sealing. Probe
// contention without waiting or changing that owner's lock. Never infer absence
// from this condition or launch frame commands that block behind the recorder.
func (r *ProcessRunner) deferBusyFrame() error {
	fd, err := syscall.Open(filepath.Join(r.stateDir, "control.lock"), syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return &preSpawnRefusal{fault("configuration", "native control lock unavailable")}
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != uint32(os.Getuid()) || st.Mode&0777 != 0600 {
		return &preSpawnRefusal{fault("configuration", "native control lock invalid")}
	}
	err = syscall.Flock(fd, syscall.LOCK_SH|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return &preSpawnRefusal{fault("native_busy", "native control lock held")}
	}
	if err != nil {
		return &preSpawnRefusal{fault("configuration", "native control lock probe failed")}
	}
	return syscall.Flock(fd, syscall.LOCK_UN)
}

// preSpawnRefusal is evidence produced only before exec. A generic configuration
// fault from a Runner is insufficient to clear a native-effect quarantine.
type preSpawnRefusal struct{ error }

func (e *preSpawnRefusal) Unwrap() error { return e.error }

type cappedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.buffer.Len() {
		return 0, errors.New("native output cap exceeded")
	}
	return b.buffer.Write(p)
}
func extractHostProgramRefusal(outputs ...string) string {
	for _, s := range outputs {
		idx := strings.Index(s, "host_program_unavailable:")
		if idx < 0 {
			continue
		}
		line := s[idx:]
		if nl := strings.IndexAny(line, "\r\n"); nl >= 0 {
			line = line[:nl]
		}
		if q := strings.IndexByte(line, '"'); q >= 0 {
			line = line[:q]
		}
		line = strings.TrimSpace(line)
		if len(line) > 256 {
			line = line[:256]
		}
		if len(line) > len("host_program_unavailable:") {
			return line
		}
	}
	return ""
}

func extractHostWindowRefusal(outputs ...string) string {
	for _, s := range outputs {
		idx := strings.Index(s, "host_window_unavailable:")
		if idx < 0 {
			continue
		}
		line := s[idx:]
		if nl := strings.IndexAny(line, "\r\n"); nl >= 0 {
			line = line[:nl]
		}
		if q := strings.IndexByte(line, '"'); q >= 0 {
			line = line[:q]
		}
		line = strings.TrimSpace(line)
		if len(line) > 256 {
			line = line[:256]
		}
		if len(line) > len("host_window_unavailable:") {
			return line
		}
	}
	return ""
}

func readOneXWDStream(r io.Reader) ([]byte, string, error) {
	h := make([]byte, 100)
	n, err := io.ReadFull(r, h)
	if err != nil {
		return nil, string(h[:n]), err
	}
	be := binary.BigEndian
	size := int(be.Uint32(h[0:]))
	w, ht := int(be.Uint32(h[16:])), int(be.Uint32(h[20:]))
	order, bpp, bpl, ncolors := be.Uint32(h[28:]), be.Uint32(h[44:]), int(be.Uint32(h[48:])), int(be.Uint32(h[76:]))
	if size < 100 || size > 4096 || be.Uint32(h[4:]) != 7 || be.Uint32(h[8:]) != 2 || order > 1 || bpp != 32 || w < 1 || ht < 1 || w > 4096 || ht > 4096 || bpl < 4*w || bpl > 4*w+64 || ncolors < 0 || ncolors > 256 {
		tail, _ := io.ReadAll(io.LimitReader(r, 1024))
		return nil, string(h) + string(tail), errors.New("invalid XWD header")
	}
	restLen := (size - 100) + ncolors*12 + bpl*ht
	buf := make([]byte, 100+restLen)
	copy(buf, h)
	if _, err := io.ReadFull(r, buf[100:]); err != nil {
		return nil, "", err
	}
	return buf, "", nil
}

func extractExitReason(stderr string) string {
	for _, rawLine := range strings.Split(stderr, "\n") {
		var b strings.Builder
		for _, r := range strings.TrimSpace(strings.TrimSuffix(rawLine, "\r")) {
			if r >= 0x20 && r != 0x7f {
				b.WriteRune(r)
			}
		}
		line := strings.TrimSpace(b.String())
		if line == "" {
			continue
		}
		if len(line) > 256 {
			line = line[:256]
		}
		return line
	}
	return ""
}

func (r *ProcessRunner) SearchPath() string {
	for _, entry := range r.env {
		if k, v, ok := strings.Cut(entry, "="); ok && k == "PATH" {
			return v
		}
	}
	return ""
}

func (r *ProcessRunner) Run(ctx context.Context, argv []string, stdin []byte) ([]byte, error) {
	adminShow := len(argv) == 4 && filepath.Base(argv[0]) == "srf-identity-admin" && argv[1] == "show" && argv[2] == "--id" && storedIdentityID.MatchString(argv[3]) && !protectedIdentity(argv[3]) && len(stdin) == 0
	// Native browser creation uses the default chromium engine; program copy
	// alone selects --browser program. Keep the create seam closed and path-free.
	adminCreate := (len(argv) == 8 || len(argv) == 10) && filepath.Base(argv[0]) == "srf-identity-admin" && argv[1] == "create" && argv[2] == "--id" && storedIdentityID.MatchString(argv[3]) && !protectedIdentity(argv[3]) && argv[4] == "--label" && argv[5] == argv[3] && len(stdin) == 0 && ((len(argv) == 8 && argv[6] == "--domains" && argv[7] == "") || (len(argv) == 10 && argv[6] == "--browser" && argv[7] == "program" && argv[8] == "--domains" && argv[9] == ""))
	hostWin := len(argv) >= 2 && filepath.Base(argv[0]) == "srf-host-window" && (argv[1] == "list" || argv[1] == "capture" || argv[1] == "input")
	if len(argv) < 2 || filepath.Dir(argv[0]) != r.root || (!adminShow && !adminCreate && !hostWin && filepath.Base(argv[0]) != "srf-identity-surface" && filepath.Base(argv[0]) != "srf-holdings-capsule") {
		return nil, fault("execution", "unadmitted executable")
	}
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	if filepath.Base(argv[0]) == "srf-identity-surface" {
		select {
		case r.nativeGate <- struct{}{}:
			defer func() { <-r.nativeGate }()
		case <-ctx.Done():
			return nil, &preSpawnRefusal{fault("timeout", "native command queue deadline")}
		}
		if err := r.validateStateDir(); err != nil {
			return nil, &preSpawnRefusal{err}
		}
		if argv[1] == "frame" {
			if err := r.deferBusyFrame(); err != nil {
				return nil, err
			}
		}
		// Own the flag so callers cannot override the configured directory.
		for _, arg := range argv[1:] {
			if arg == "--" || arg == "--state-dir" || strings.HasPrefix(arg, "--state-dir=") || arg == "-state-dir" || strings.HasPrefix(arg, "-state-dir=") {
				return nil, fault("configuration", "state directory flag is adapter-owned")
			}
		}
		argv = append(append([]string(nil), argv...), "--state-dir", r.stateDir)
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	// [TARGET, unit decision] Own a fresh group for this native invocation.
	// CommandContext's default Kill reaches only the leader, leaving helpers
	// executing after a cancelled operation. Never accept a caller-supplied PID.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.Env = append([]string(nil), r.env...)
	cmd.Stdin = bytes.NewReader(stdin)
	errBuf := &cappedBuffer{limit: min(r.limit, 4096)}
	cmd.Stderr = errBuf
	cmd.WaitDelay = time.Second
	if hostWin && argv[1] == "capture" {
		stdoutPipe, err := cmd.StdoutPipe()
		if err != nil {
			return nil, &preSpawnRefusal{fault("execution", "native pipe failed before start")}
		}
		if e := cmd.Start(); e != nil {
			stdoutPipe.Close()
			if ctx.Err() != nil {
				return nil, fault("uncertain", "native command deadline or cancellation")
			}
			if cmd.Process == nil {
				return nil, &preSpawnRefusal{fault("execution", "native executable failed before start")}
			}
			return nil, fault("uncertain", "native command failed without a verified result")
		}
		xwd, outSample, readErr := readOneXWDStream(stdoutPipe)
		_ = stdoutPipe.Close()
		if readErr == nil && cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		waitErr := cmd.Wait()
		if readErr == nil {
			return xwd, nil
		}
		if ctx.Err() != nil {
			return nil, fault("uncertain", "native command deadline or cancellation")
		}
		if reason := extractHostWindowRefusal(errBuf.buffer.String(), outSample); reason != "" {
			return nil, &preSpawnRefusal{fault("host_window_unavailable", reason)}
		}
		if reason := extractExitReason(errBuf.buffer.String()); reason != "" {
			return nil, &preSpawnRefusal{fault("host_window_unavailable", "host_window_unavailable: "+reason)}
		}
		if waitErr != nil {
			var exit *exec.ExitError
			if errors.As(waitErr, &exit) {
				return nil, &preSpawnRefusal{cli.ExitFault("srf-host-window", exit.ExitCode(), "")}
			}
		}
		return nil, &preSpawnRefusal{fault("host_window_unavailable", "host_window_unavailable: invalid or truncated XWD capture")}
	}
	out := &cappedBuffer{limit: r.limit}
	cmd.Stdout = out
	if e := cmd.Start(); e != nil {
		if ctx.Err() != nil {
			return nil, fault("uncertain", "native command deadline or cancellation")
		}
		if cmd.Process == nil {
			return nil, &preSpawnRefusal{fault("execution", "native executable failed before start")}
		}
		return nil, fault("uncertain", "native command failed without a verified result")
	}
	if e := cmd.Wait(); e != nil {
		if ctx.Err() != nil {
			return nil, fault("uncertain", "native command deadline or cancellation")
		}
		var exit *exec.ExitError
		if errors.As(e, &exit) {
			if exit.ExitCode() == 2 && filepath.Base(argv[0]) == "srf-identity-surface" {
				if reason := extractHostProgramRefusal(errBuf.buffer.String(), out.buffer.String()); reason != "" {
					return nil, &preSpawnRefusal{fault("host_program_unavailable", reason)}
				}
			}
			if filepath.Base(argv[0]) == "srf-host-window" {
				if reason := extractHostWindowRefusal(errBuf.buffer.String(), out.buffer.String()); reason != "" {
					return nil, &preSpawnRefusal{fault("host_window_unavailable", reason)}
				}
				if reason := extractExitReason(errBuf.buffer.String()); reason != "" {
					return nil, &preSpawnRefusal{fault("host_window_unavailable", "host_window_unavailable: "+reason)}
				}
			}
			errFault := cli.ExitFault(filepath.Base(argv[0]), exit.ExitCode(), "")
			if reason := extractExitReason(errBuf.buffer.String()); reason != "" {
				var f *cli.Fault
				if errors.As(errFault, &f) {
					f.Detail = f.Detail + ": " + reason
				}
			}
			return nil, errFault
		}
		return nil, fault("uncertain", "native command failed without a verified result")
	}
	return out.buffer.Bytes(), nil
}

// NewRuntime resolves the native binary directory only from the admitted environment.
func NewRuntime(cfg Config, clock cli.Clock) (*Manager, error) {
	cfg.BinDir = os.Getenv("MV_SRF_BIN_DIR")
	cfg.SlotLiveProfile = os.Getenv("MV_SRF_LIVE_PROFILE")
	// [TARGET, unit decision] Optional trusted runtime knobs use the same bounded
	// validation as Config. Invalid explicit values fail startup, never default.
	if raw, ok := os.LookupEnv("MV_LIVENESS_INTERVAL"); ok {
		value, err := time.ParseDuration(raw)
		if err != nil || value <= 0 {
			return nil, fault("configuration", "invalid MV_LIVENESS_INTERVAL")
		}
		cfg.LivenessInterval = value
	}
	if raw, ok := os.LookupEnv("MV_LIVENESS_MISSES"); ok {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			return nil, fault("configuration", "invalid MV_LIVENESS_MISSES")
		}
		cfg.LivenessMisses = value
	}
	var environment []string
	for _, key := range []string{"PATH", "HOME", "XDG_RUNTIME_DIR", "MV_SRF_STATE_DIR", "SRF_IDENTITY_STORE_ROOT", "SRF_PROXY_REGISTRY", "SRF_EGRESS_PROXY"} {
		if value, ok := os.LookupEnv(key); ok {
			environment = append(environment, key+"="+value)
		}
	}
	runner, e := NewProcessRunner(cfg.BinDir, environment, cfg.MaxOutputBytes, cfg.Timeout)
	if e != nil {
		return nil, e
	}
	return NewManager(cfg, runner, clock)
}
