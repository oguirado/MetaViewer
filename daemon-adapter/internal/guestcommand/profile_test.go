package guestcommand

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProfileUsesClosedPinnedRuntimeAndTemplate(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	runtime := filepath.Join(root, "runtime")
	os.Mkdir(state, 0700)
	os.Mkdir(runtime, 0700)
	write := func(name string) Pin {
		path := filepath.Join(root, name)
		os.WriteFile(path, []byte(name), 0700)
		h := sha256.Sum256([]byte(name))
		return Pin{path, hex.EncodeToString(h[:])}
	}
	py, runner := write("python"), write("runner.py")
	owner := "actor-" + strings.Repeat("a", 64)
	config := map[string]any{"schema": "guest-command-host-config/v1", "owner_id": owner, "generation": 1, "runtime_admitted": false, "runtime_root": runtime, "external_cgroup": "/sys/fs/cgroup/not-admitted", "startup_seconds": 20, "stop_seconds": 5, "artifacts": map[string]Pin{"engine": py, "kernel": py, "broker": py, "busybox": py}}
	raw, _ := json.Marshal(config)
	p := Profile{Schema: "mv-guest-command-host/v1", OwnerID: owner, GuardianUnit: "own.scope", Python: py, PythonPrefix: root, Runner: runner, ControllerRelative: "guest_command_runtime/controller.py", ConfigTemplate: raw, StateRoot: state, RuntimeRoot: runtime}
	for _, name := range []string{"__init__", "_schemas", "wire", "schema", "config", "image", "native_checks", "native", "protocol", "storage", "controller"} {
		pin := write(name + ".py")
		p.Files = append(p.Files, File{Relative: "guest_command_runtime/" + name + ".py", Path: pin.Path, SHA256: pin.SHA256})
	}
	file := filepath.Join(root, "profile.json")
	save := func() { b, _ := json.Marshal(p); os.WriteFile(file, b, 0600) }
	save()
	if _, e := Load(file); e != nil {
		t.Fatal(e)
	}
	p.Files[0].Relative = "../escape.py"
	save()
	if _, e := Load(file); e == nil {
		t.Fatal("unclosed source set")
	}
}
