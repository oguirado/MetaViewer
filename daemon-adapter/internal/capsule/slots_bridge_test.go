package capsule

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSlotCustodyRefusesPendingLoginAndNativePresence(t *testing.T) {
	bin, state := t.TempDir(), t.TempDir()
	if e := os.Chmod(state, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.Mkdir(filepath.Join(state, "views"), 0700); e != nil {
		t.Fatal(e)
	}
	docker := filepath.Join(bin, "docker")
	if e := os.WriteFile(docker, []byte("#!/bin/sh\nexit 0\n"), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	r, e := NewProcessRunner(bin, []string{"PATH=" + os.Getenv("PATH"), "MV_SRF_STATE_DIR=" + state}, 4096, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	m := &Manager{runner: r}
	ctx := context.Background()
	if e = m.slotStopped(ctx, "demo"); e != nil {
		t.Fatal("stopped profile refused", e)
	}
	root := t.TempDir()
	if e = os.Mkdir(filepath.Join(root, "locks"), 0700); e != nil {
		t.Fatal(e)
	}
	r.env = append(r.env, "SRF_IDENTITY_STORE_ROOT="+root)
	lease := filepath.Join(root, "locks", "demo.json")
	if e = os.WriteFile(lease, []byte(`{"active":true}`), 0600); e != nil {
		t.Fatal(e)
	}
	if e = m.slotStopped(ctx, "demo"); e == nil || e.Error() != "IDENTITY_BOUND" {
		t.Fatal("active native lease accepted", e)
	}
	if e = os.WriteFile(lease, []byte(`{}`), 0600); e != nil {
		t.Fatal(e)
	}
	if e = m.slotStopped(ctx, "demo"); e == nil {
		t.Fatal("unknown native lease passed")
	}
	if e = os.WriteFile(lease, []byte(`{"active":false}`), 0600); e != nil {
		t.Fatal(e)
	}
	if e = m.slotStopped(ctx, "demo"); e != nil {
		t.Fatal(e)
	}
	marker := filepath.Join(state, "views", "srf-id-demo.login-pending")
	if e = os.WriteFile(marker, []byte("pending"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = m.slotStopped(ctx, "demo"); e == nil || e.Error() != "LOGIN_IN_PROGRESS" {
		t.Fatal("pending login accepted", e)
	}
	if e = os.Remove(marker); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(docker, []byte("#!/bin/sh\necho srf-id-demo\n"), 0700); e != nil {
		t.Fatal(e)
	}
	if e = m.slotStopped(ctx, "demo"); e == nil || e.Error() != "IDENTITY_BOUND" {
		t.Fatal("native container accepted", e)
	}
	if e = os.WriteFile(docker, []byte("#!/bin/sh\nexit 1\n"), 0700); e != nil {
		t.Fatal(e)
	}
	if e = m.slotStopped(ctx, "demo"); e == nil {
		t.Fatal("missing native evidence passed")
	}
}
