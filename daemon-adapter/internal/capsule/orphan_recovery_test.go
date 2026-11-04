package capsule

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOrphanReleaseAbsenceGate(t *testing.T) {
	root, state, bin := t.TempDir(), t.TempDir(), t.TempDir()
	if err := os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "locks"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(state, "views"), 0700); err != nil {
		t.Fatal(err)
	}
	docker := filepath.Join(bin, "docker")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	r, err := NewProcessRunner(bin, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state, "SRF_IDENTITY_STORE_ROOT=" + root}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	write := func(path, text string, mode os.FileMode) {
		t.Helper()
		if e := os.WriteFile(path, []byte(text), mode); e != nil {
			t.Fatal(e)
		}
	}
	lease := filepath.Join(root, "locks", "demo.json")
	write(docker, "#!/bin/sh\nif [ \"$1\" = context ]; then echo '\"unix:///var/run/docker.sock\"'; fi\n", 0700)
	if releasedIdentityAbsent(context.Background(), r, "demo") {
		t.Fatal("missing lease cannot pass")
	}
	write(lease, `{"active":false,"holder":"srf-id-demo"}`, 0600)
	if !releasedIdentityAbsent(context.Background(), r, "demo") {
		t.Fatal("verified release should pass")
	}
	for _, raw := range []string{`{}`, `{"active":true,"holder":"srf-id-demo"}`, `{"active":false,"holder":"srf-id-cuentas-1"}`, `{"active":false,"holder":"foreign"}`} {
		write(lease, raw, 0600)
		if releasedIdentityAbsent(context.Background(), r, "demo") {
			t.Fatalf("unsafe lease passed: %s", raw)
		}
	}
	write(lease, `{"active":false,"holder":"srf-id-demo"}`, 0600)
	for _, suffix := range []string{".pid", ".login-pending"} {
		registration := filepath.Join(state, "views", "srf-id-demo"+suffix)
		write(registration, "1", 0600)
		if releasedIdentityAbsent(context.Background(), r, "demo") {
			t.Fatal("view registration passed")
		}
		if e := os.Remove(registration); e != nil {
			t.Fatal(e)
		}
	}
	for _, script := range []string{
		"#!/bin/sh\nif [ \"$1\" = context ]; then echo '\"unix:///var/run/docker.sock\"'; else echo srf-id-demo; fi\n",
		"#!/bin/sh\nexit 1\n",
		"#!/bin/sh\necho '\"tcp://foreign:2375\"'\n",
	} {
		write(docker, script, 0700)
		if releasedIdentityAbsent(context.Background(), r, "demo") {
			t.Fatal("present or unknown inventory passed")
		}
	}
}
