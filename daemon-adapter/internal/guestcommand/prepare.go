package guestcommand

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
)

func writeNew(path string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func (m *Manager) prepare() (string, string, error) {
	if e := privateDir(m.profile.StateRoot); e != nil {
		return "", "", e
	}
	if e := privateDir(m.profile.RuntimeRoot); e != nil {
		return "", "", e
	}
	unit := "mv-guest-command-" + nonce() + ".service"
	// Durable conservative responsibility precedes process creation, including uncertain Start.
	if e := writeNew(m.reservation, map[string]any{"schema": "guest-command-reservation/v1", "unit": unit, "owner_id": m.profile.OwnerID, "status": "pending"}); e != nil {
		return "", "", e
	}
	attempt, e := os.MkdirTemp(m.profile.StateRoot, "attempt-")
	if e != nil {
		return "", "", e
	}
	runtimePrefix := "headless-"
	if m.profile.Rewind {
		// The protected rewind base has a 70-byte native Unix-path limit.
		// Keep the same exclusive allocation and custody, with a shorter name.
		runtimePrefix = "r-"
	}
	runtime, e := os.MkdirTemp(m.profile.RuntimeRoot, runtimePrefix)
	if e != nil {
		return "", "", e
	}
	state := filepath.Join(attempt, "state")
	if e = os.Mkdir(state, 0700); e != nil {
		return "", "", e
	}
	for _, f := range m.profile.Files {
		b, e := pinned(Pin{f.Path, f.SHA256}, 2<<20)
		if e != nil {
			return "", "", e
		}
		dest := filepath.Join(attempt, "bundle", f.Relative)
		if e = os.MkdirAll(filepath.Dir(dest), 0700); e != nil {
			return "", "", e
		}
		if e = os.WriteFile(dest, b, 0600); e != nil {
			return "", "", e
		}
	}
	b, e := pinned(m.profile.Runner, 1<<20)
	if e != nil {
		return "", "", e
	}
	if e = os.WriteFile(filepath.Join(attempt, "runner.py"), b, 0600); e != nil {
		return "", "", e
	}
	python, e := pinnedExecutable(m.profile.Python)
	if e != nil {
		return "", "", e
	}
	if e = os.WriteFile(filepath.Join(attempt, "python"), python, 0500); e != nil {
		return "", "", e
	}
	var config map[string]any
	if e = json.Unmarshal(m.profile.ConfigTemplate, &config); e != nil {
		return "", "", e
	}
	if e = writeNew(filepath.Join(attempt, "launch.json"), map[string]any{"files": m.profile.Files, "config": config, "state_dir": state, "runtime_root": runtime, "unit": unit, "session_id": m.sessionID}); e != nil {
		return "", "", e
	}
	identities := map[string]any{}
	for _, path := range []string{attempt, state, runtime} {
		st, e := os.Lstat(path)
		if e != nil {
			return "", "", e
		}
		s := st.Sys().(*syscall.Stat_t)
		identities[path] = map[string]any{"device": s.Dev, "inode": s.Ino}
	}
	if e = writeNew(m.reservation+".prepared", map[string]any{"unit": unit, "paths": identities}); e != nil {
		return "", "", e
	}
	return attempt, unit, nil
}
