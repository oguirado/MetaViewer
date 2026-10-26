package capsule

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

	"metaviewer/daemon-adapter/internal/cli"
)

// [TARGET, unit decision] Executables and environment are configured at the
// trusted seam; no request may add an executable, environment key or shell text.
type ProcessRunner struct {
	stateDir string
	stat     func(string) (os.FileInfo, error)
	env      []string
	limit    int
	timeout  time.Duration
	root     string
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
	return &ProcessRunner{env: childEnv, stateDir: stateDir, stat: os.Lstat, limit: maxOutput, timeout: timeout, root: filepath.Clean(binDir)}, nil
}

// [TARGET, unit decision] State configuration is captured with the trusted
// environment and revalidated before every identity verb. Reject symlinks and
// special permission bits; create only the final directory, never its parents.
func (r *ProcessRunner) validateStateDir() error {
	refuse := func() error {
		return fault("configuration", "MV_SRF_STATE_DIR must be a current-uid directory with mode 0700")
	}
	if r.stateDir == "" {
		return refuse()
	}
	st, err := r.stat(r.stateDir)
	if os.IsNotExist(err) {
		if err = os.Mkdir(r.stateDir, 0700); err != nil && !os.IsExist(err) {
			return refuse()
		}
		st, err = r.stat(r.stateDir)
	}
	if err != nil {
		return refuse()
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || !st.IsDir() || st.Mode() != os.ModeDir|0700 {
		return refuse()
	}
	return nil
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
func (r *ProcessRunner) Run(ctx context.Context, argv []string, stdin []byte) ([]byte, error) {
	if len(argv) < 2 || filepath.Dir(argv[0]) != r.root || (filepath.Base(argv[0]) != "srf-identity-surface" && filepath.Base(argv[0]) != "srf-holdings-capsule") {
		return nil, fault("execution", "unadmitted executable")
	}
	if filepath.Base(argv[0]) == "srf-identity-surface" {
		if err := r.validateStateDir(); err != nil {
			return nil, &preSpawnRefusal{err}
		}
		// Own the flag so callers cannot override the configured directory.
		for _, arg := range argv[2:] {
			if arg == "--state-dir" || strings.HasPrefix(arg, "--state-dir=") || arg == "-state-dir" || strings.HasPrefix(arg, "-state-dir=") {
				return nil, fault("configuration", "state directory flag is adapter-owned")
			}
		}
		argv = append(append([]string(nil), argv...), "--state-dir", r.stateDir)
	}
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = append([]string(nil), r.env...)
	cmd.Stdin = bytes.NewReader(stdin)
	out := &cappedBuffer{limit: r.limit}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	if e := cmd.Run(); e != nil {
		if ctx.Err() != nil {
			return nil, fault("uncertain", "native command deadline or cancellation")
		}
		var exit *exec.ExitError
		if errors.As(e, &exit) {
			return nil, cli.ExitFault(filepath.Base(argv[0]), exit.ExitCode(), "")
		}
		return nil, fault("uncertain", "native command failed without a verified result")
	}
	return out.buffer.Bytes(), nil
}

// NewRuntime resolves the native binary directory only from the admitted environment.
func NewRuntime(cfg Config, clock cli.Clock) (*Manager, error) {
	cfg.BinDir = os.Getenv("MV_SRF_BIN_DIR")
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
