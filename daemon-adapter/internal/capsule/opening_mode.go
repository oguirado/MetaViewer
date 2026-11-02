package capsule

import (
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type HostWindowSpec struct {
	XID     uint32 `json:"xid"`
	Witness string `json:"witness"`
	Title   string `json:"title,omitempty"`
	Program string `json:"program,omitempty"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
}

func validHostWitness(w string) bool {
	if len(w) < 1 || len(w) > 128 {
		return false
	}
	for _, r := range w {
		if r <= 0x20 || r >= 0x7f || strings.ContainsRune(";|&$`<>(){}[]!#*?~\"'\\", r) {
			return false
		}
	}
	return true
}

func (r *ProcessRunner) consumeOpeningRequest(profile string, target string) (string, string, *HostWindowSpec, bool, error) {
	if !profileID.MatchString(profile) {
		return "", "", nil, false, fault("configuration", "invalid opening profile")
	}
	if err := r.validateStateDir(); err != nil {
		return "", "", nil, false, err
	}
	dir := filepath.Join(r.stateDir, "opening-modes")
	st, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		return "", "", nil, false, nil
	}
	if err != nil {
		return "", "", nil, false, err
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || st.Mode() != os.ModeDir|0700 {
		return "", "", nil, false, fault("configuration", "private opening directory required")
	}
	path := filepath.Join(dir, profile+".json")
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(err) {
		return "", "", nil, false, nil
	}
	if err != nil {
		return "", "", nil, false, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err = f.Stat()
	if err != nil {
		return "", "", nil, false, err
	}
	owner, ok = st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 || st.Size() > 2048 {
		return "", "", nil, false, fault("configuration", "private opening request required")
	}
	raw := make([]byte, st.Size())
	if _, err = f.ReadAt(raw, 0); err != nil {
		return "", "", nil, false, err
	}
	var q struct {
		Schema     string          `json:"schema"`
		Profile    string          `json:"profile_id"`
		Mode       string          `json:"mode"`
		HostBinary string          `json:"host_binary,omitempty"`
		HostWindow *HostWindowSpec `json:"host_window,omitempty"`
	}
	if err := cli.ParseLine(raw, 2048, &q); err != nil {
		return "", "", nil, false, err
	}
	if q.Schema != "metaviewer.opening_mode/v0.3" || q.Profile != profile || (q.Mode != "human" && q.Mode != "agent") {
		return "", "", nil, false, fault("configuration", "opening mode refused")
	}
	if target == "program" && q.HostWindow != nil && q.HostBinary == "" {
		return "", "", nil, false, nil
	}
	if target == "window" && q.HostWindow == nil {
		return "", "", nil, false, nil
	}
	if err := os.Remove(path); err != nil {
		return "", "", nil, false, err
	}
	return q.Mode, q.HostBinary, q.HostWindow, true, nil
}

// ConsumeOpeningMode consumes only a private host request; never identity data.
// Missing requests retain the legacy default. Malformed requests never default.
func (r *ProcessRunner) ConsumeOpeningMode(profile string, fallback string) (string, error) {
	mode, hostBinary, hostWin, found, err := r.consumeOpeningRequest(profile, "mode")
	if err != nil {
		return "", err
	}
	if !found {
		return fallback, nil
	}
	if hostBinary != "" || hostWin != nil {
		return "", fault("configuration", "opening mode refused")
	}
	return mode, nil
}

// ConsumeOpeningProgram consumes a private per-create host program request.
func (r *ProcessRunner) ConsumeOpeningProgram(profile string) (string, error) {
	mode, hostBinary, hostWin, found, err := r.consumeOpeningRequest(profile, "program")
	if err != nil {
		return "", err
	}
	if !found {
		return "", nil
	}
	if mode != "agent" || hostWin != nil || strings.TrimSpace(hostBinary) == "" {
		return "", fault("configuration", "opening mode refused")
	}
	return hostBinary, nil
}

// ConsumeOpeningWindow consumes a private per-create host desktop window request.
func (r *ProcessRunner) ConsumeOpeningWindow(profile string) (*HostWindowSpec, error) {
	mode, hostBinary, hostWin, found, err := r.consumeOpeningRequest(profile, "window")
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	if mode != "agent" || hostBinary != "" || hostWin == nil {
		return nil, fault("configuration", "opening mode refused")
	}
	if err := ValidateHostWindowSpec(hostWin); err != nil {
		return nil, err
	}
	return hostWin, nil
}

func ValidateHostWindowSpec(spec *HostWindowSpec) error {
	if spec == nil || spec.XID == 0 || !validHostWitness(spec.Witness) {
		return fault("host_window_unavailable", "host_window_unavailable: invalid xid or witness")
	}
	if len(spec.Title) > 512 || strings.ContainsRune(spec.Title, 0) || len(spec.Program) > 256 || strings.ContainsRune(spec.Program, 0) {
		return fault("host_window_unavailable", "host_window_unavailable: invalid window metadata")
	}
	if (spec.Width != 0 && (spec.Width < 1 || spec.Width > 4096)) || (spec.Height != 0 && (spec.Height < 1 || spec.Height > 4096)) {
		return fault("host_window_unavailable", "host_window_unavailable: invalid window geometry")
	}
	return nil
}

// ResolveHostBinary resolves a bare binary name via PATH or validates an
// explicit absolute path on the host without invoking any shell.
func ResolveHostBinary(raw string, pathEnv string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 256 {
		return "", fault("host_program_unavailable", "host_program_unavailable: binary name is required")
	}
	for _, c := range trimmed {
		if c <= 0x20 || c >= 0x7f || strings.ContainsRune(";|&$`<>(){}[]!#*?~\"'\\", c) {
			return "", fault("host_program_unavailable", "host_program_unavailable: "+trimmed+": invalid binary name")
		}
	}
	if strings.HasPrefix(trimmed, "/") {
		if filepath.Clean(trimmed) != trimmed {
			return "", fault("host_program_unavailable", "host_program_unavailable: "+trimmed+": path must be clean")
		}
		st, err := os.Stat(trimmed)
		if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0111 == 0 {
			return "", fault("host_program_unavailable", "host_program_unavailable: "+trimmed+": not found or not executable")
		}
		return trimmed, nil
	}
	if strings.Contains(trimmed, "/") || trimmed == "." || trimmed == ".." {
		return "", fault("host_program_unavailable", "host_program_unavailable: "+trimmed+": relative path refused")
	}
	for _, dir := range filepath.SplitList(pathEnv) {
		if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir {
			continue
		}
		candidate := filepath.Join(dir, trimmed)
		st, err := os.Stat(candidate)
		if err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0111 != 0 {
			return candidate, nil
		}
	}
	return "", fault("host_program_unavailable", "host_program_unavailable: "+trimmed+": not found in PATH")
}
