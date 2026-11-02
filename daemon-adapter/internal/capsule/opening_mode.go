package capsule

import (
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func (r *ProcessRunner) consumeOpeningRequest(profile string) (string, string, bool, error) {
	if !profileID.MatchString(profile) {
		return "", "", false, fault("configuration", "invalid opening profile")
	}
	if err := r.validateStateDir(); err != nil {
		return "", "", false, err
	}
	dir := filepath.Join(r.stateDir, "opening-modes")
	st, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || st.Mode() != os.ModeDir|0700 {
		return "", "", false, fault("configuration", "private opening directory required")
	}
	path := filepath.Join(dir, profile+".json")
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(err) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err = f.Stat()
	if err != nil {
		return "", "", false, err
	}
	owner, ok = st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 || st.Size() > 1024 {
		return "", "", false, fault("configuration", "private opening request required")
	}
	raw := make([]byte, st.Size())
	if _, err = f.ReadAt(raw, 0); err != nil {
		return "", "", false, err
	}
	var q struct {
		Schema     string `json:"schema"`
		Profile    string `json:"profile_id"`
		Mode       string `json:"mode"`
		HostBinary string `json:"host_binary,omitempty"`
	}
	if err := cli.ParseLine(raw, 1024, &q); err != nil {
		return "", "", false, err
	}
	if q.Schema != "metaviewer.opening_mode/v0.3" || q.Profile != profile || (q.Mode != "human" && q.Mode != "agent") {
		return "", "", false, fault("configuration", "opening mode refused")
	}
	if err := os.Remove(path); err != nil {
		return "", "", false, err
	}
	return q.Mode, q.HostBinary, true, nil
}

// ConsumeOpeningMode consumes only a private host request; never identity data.
// Missing requests retain the legacy default. Malformed requests never default.
func (r *ProcessRunner) ConsumeOpeningMode(profile string, fallback string) (string, error) {
	mode, hostBinary, found, err := r.consumeOpeningRequest(profile)
	if err != nil {
		return "", err
	}
	if !found {
		return fallback, nil
	}
	if hostBinary != "" {
		return "", fault("configuration", "opening mode refused")
	}
	return mode, nil
}

// ConsumeOpeningProgramMode consumes a private per-create host program request and its opening mode.
func (r *ProcessRunner) ConsumeOpeningProgramMode(profile string) (string, string, error) {
	mode, hostBinary, found, err := r.consumeOpeningRequest(profile)
	if err != nil {
		return "", "", err
	}
	if !found {
		return "", "", nil
	}
	if (mode != "agent" && mode != "human") || strings.TrimSpace(hostBinary) == "" {
		return "", "", fault("configuration", "opening mode refused")
	}
	return hostBinary, mode, nil
}

// ConsumeOpeningProgram consumes a private per-create host program request.
func (r *ProcessRunner) ConsumeOpeningProgram(profile string) (string, error) {
	hostBinary, _, err := r.ConsumeOpeningProgramMode(profile)
	return hostBinary, err
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
