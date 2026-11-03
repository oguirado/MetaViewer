package capsule

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
	m := &Manager{runner: r, bindings: map[string]Binding{"old-surface": {Surface: Surface{ProfileID: "demo", State: "destroyed"}}}}
	ctx := context.Background()
	if e = m.slotStopped(ctx, "demo"); e != nil {
		t.Fatal("stopped profile refused", e)
	}
	// Destroyed bindings are retained for replay, but must not keep custody busy.
	m.bindings["old-surface"] = Binding{Surface: Surface{ProfileID: "demo", State: "active"}}
	if e = m.slotStopped(ctx, "demo"); e == nil {
		t.Fatal("active capsule accepted")
	}
	m.bindings["old-surface"] = Binding{Surface: Surface{ProfileID: "demo", State: "destroyed"}}
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

func TestSlotNativeBrowserMetadataAndCopyArguments(t *testing.T) {
	for _, browser := range []string{"chromium", "browser", "program", "foreign", ""} {
		kind, e := nativeSlotKind([]byte(`{"profile_id":"demo","browser":"`+browser+`"}`), "demo")
		if browser == "foreign" || browser == "" {
			if e == nil {
				t.Fatal("foreign metadata admitted")
			}
			continue
		}
		expected := "browser"
		if browser == "program" {
			expected = "program"
		}
		if e != nil || kind != expected {
			t.Fatal(browser, kind, e)
		}
		args := strings.Join(slotCreateArgs("bin", "copy-demo", kind), " ")
		if kind == "browser" && strings.Contains(args, "--browser") {
			t.Fatal("native browser creation must use default chromium", args)
		}
		if kind == "program" && !strings.Contains(args, "--browser program") {
			t.Fatal(args)
		}
	}
	if _, e := nativeSlotKind([]byte(`{"profile_id":"foreign","browser":"chromium"}`), "demo"); e == nil {
		t.Fatal("mismatched native identity admitted")
	}
}

func TestSlotCopyCreatePassesClosedProcessRunner(t *testing.T) {
	bin := t.TempDir()
	if e := os.WriteFile(filepath.Join(bin, "srf-identity-admin"), []byte("#!/bin/sh\nexit 0\n"), 0700); e != nil {
		t.Fatal(e)
	}
	runner, e := NewProcessRunner(bin, []string{"PATH=" + os.Getenv("PATH")}, 4096, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	for _, kind := range []string{"browser", "program"} {
		args := slotCreateArgs(bin, "copy-demo", kind)
		if _, e := runner.Run(context.Background(), args, nil); e != nil {
			t.Fatal(kind, e)
		}
		args = append(args, "--store-root", "/private")
		if _, e := runner.Run(context.Background(), args, nil); e == nil {
			t.Fatal("path override admitted")
		}
	}
}
