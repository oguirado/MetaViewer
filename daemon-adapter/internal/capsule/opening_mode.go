package capsule

import (
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"path/filepath"
	"syscall"
)

// ConsumeOpeningMode consumes only a private host request; never identity data.
// Missing requests retain the legacy default. Malformed requests never default.
func (r *ProcessRunner) ConsumeOpeningMode(profile string, fallback string) (string, error) {
	if !profileID.MatchString(profile) {
		return "", fault("configuration", "invalid opening profile")
	}
	if err := r.validateStateDir(); err != nil {
		return "", err
	}
	dir := filepath.Join(r.stateDir, "opening-modes")
	st, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		return fallback, nil
	}
	if err != nil {
		return "", err
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || st.Mode() != os.ModeDir|0700 {
		return "", fault("configuration", "private opening directory required")
	}
	path := filepath.Join(dir, profile+".json")
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(err) {
		return fallback, nil
	}
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err = f.Stat()
	if err != nil {
		return "", err
	}
	owner, ok = st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 || st.Size() > 1024 {
		return "", fault("configuration", "private opening request required")
	}
	raw := make([]byte, st.Size())
	if _, err = f.ReadAt(raw, 0); err != nil {
		return "", err
	}
	var q struct {
		Schema  string `json:"schema"`
		Profile string `json:"profile_id"`
		Mode    string `json:"mode"`
	}
	if err := cli.ParseLine(raw, 1024, &q); err != nil {
		return "", err
	}
	if q.Schema != "metaviewer.opening_mode/v0.3" || q.Profile != profile || (q.Mode != "human" && q.Mode != "agent") {
		return "", fault("configuration", "opening mode refused")
	}
	if err := os.Remove(path); err != nil {
		return "", err
	}
	return q.Mode, nil
}
