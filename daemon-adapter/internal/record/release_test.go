package record

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Keep the pre-fix regression executable before the local release API exists.
func releaseCapture(t *testing.T, m *Manager, id string) error {
	t.Helper()
	r, ok := any(m).(interface{ Release(string) error })
	if !ok {
		t.Fatal("Manager lacks recording release")
	}
	return r.Release(id)
}

func TestReleaseRestoresBudgetAndDeletesOnlyOwnedRAM(t *testing.T) {
	source, reply, size := fixture(t)
	m := manager(t, &fakeRunner{reply: reply}, size, nil)
	ctx := context.Background()
	var paths []string
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("r%d", i)
		if _, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s", "recording_id": id, "ring_bytes": size, "max_fps": 20})); err != nil {
			t.Fatal(err)
		}
		events, err := m.Poll(ctx, "poll", id)
		if err != nil {
			t.Fatal(err)
		}
		paths = append(paths, events[0].RAMPath)
		if _, err := m.Handle(ctx, payload("ram_stop", map[string]any{"surface_id": "s", "recording_id": id})); err != nil {
			t.Fatal(err)
		}
	}
	events, err := m.Handle(ctx, start(size))
	requireRefused(t, events, err)
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("r%d", i)
		if err := releaseCapture(t, m, id); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(paths[i]); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("owned frame retained: %v", err)
		}
		if _, ok := m.records[id]; ok {
			t.Fatal("released metadata retained")
		}
		events, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s", "recording_id": id, "ring_bytes": size, "max_fps": 20}))
		requireRefused(t, events, err)
		if events[0].ReasonCode != "POLICY" {
			t.Fatal(events)
		}
		if _, err := m.Poll(ctx, "late", id); err == nil {
			t.Fatal("released recording polled")
		}
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatal("producer frame removed", err)
	}
	for i := 0; i < 4; i++ {
		if _, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s", "recording_id": fmt.Sprintf("fresh%d", i), "ring_bytes": size, "max_fps": 20})); err != nil {
			t.Fatal("budget not reclaimed", err)
		}
	}
}

func TestReleaseRefusesUnknownAndActiveWithoutDeletingFrames(t *testing.T) {
	_, reply, size := fixture(t)
	m := manager(t, &fakeRunner{reply: reply}, size, nil)
	unknown := releaseCapture(t, m, "missing")
	if unknown == nil {
		t.Fatal("unknown release accepted")
	}
	if _, err := m.Handle(context.Background(), start(size)); err != nil {
		t.Fatal(err)
	}
	events, err := m.Poll(context.Background(), "poll", "r")
	if err != nil {
		t.Fatal(err)
	}
	active := releaseCapture(t, m, "r")
	if active == nil || errors.Is(active, unknown) {
		t.Fatal("active release needs distinct typed error")
	}
	if _, err := os.Stat(events[0].RAMPath); err != nil {
		t.Fatal("active frame deleted", err)
	}
	if m.records["r"].sealed {
		t.Fatal("active release sealed recording")
	}
	if _, err := m.Handle(context.Background(), stop("ram_stop")); err != nil {
		t.Fatal(err)
	}
	if err := releaseCapture(t, m, "r"); err != nil {
		t.Fatal(err)
	}
	if err := releaseCapture(t, m, "r"); !errors.Is(err, unknown) {
		t.Fatalf("repeated release = %v", err)
	}
}

func TestReleaseExportAndScreenshotKeepExternalArtifacts(t *testing.T) {
	for _, mode := range []string{"disk", "screenshot"} {
		t.Run(mode, func(t *testing.T) {
			source, reply, size := fixture(t)
			dest := filepath.Join(t.TempDir(), "capture.tar")
			m := manager(t, &fakeRunner{reply: reply}, size, &Destination{CapabilityID: "cap", Path: dest})
			ctx := context.Background()
			if mode == "disk" {
				if _, err := m.Handle(ctx, disk(dest, "cap")); err != nil {
					t.Fatal(err)
				}
				if _, err := m.Poll(ctx, "poll", "r"); err != nil {
					t.Fatal(err)
				}
				if _, err := m.Handle(ctx, stop("disk_stop")); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := m.Handle(ctx, payload("screenshot", map[string]any{"surface_id": "s", "capture_id": "r"})); err != nil {
					t.Fatal(err)
				}
			}
			owned := m.records["r"].frames[0].path
			if err := releaseCapture(t, m, "r"); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(owned); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("RAM retained", err)
			}
			if _, err := os.Stat(source); err != nil {
				t.Fatal(err)
			}
			if mode == "disk" {
				if _, err := os.Stat(dest); err != nil {
					t.Fatal("export deleted", err)
				}
			}
		})
	}
}

func TestFailedExportRemovesPartialAndAllowsExactGrantRetry(t *testing.T) {
	_, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	dest := filepath.Join(t.TempDir(), "capture.tar")
	m := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: dest})
	ctx := context.Background()
	if _, err := m.Handle(ctx, disk(dest, "cap")); err != nil {
		t.Fatal(err)
	}
	events, err := m.Poll(ctx, "poll", "r")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(events[0].RAMPath, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Handle(ctx, stop("disk_stop")); err == nil {
		t.Fatal("truncated export accepted")
	}
	if m.records["r"].sealed {
		t.Fatal("failed export sealed recording")
	}
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed export left partial destination: %v", err)
	}
	runner.reply = update(t, reply, map[string]any{"seq": 2, "generation": 2, "capture_mono_ns": 1100000100})
	if _, err := m.Poll(ctx, "poll", "r"); err != nil {
		t.Fatal(err)
	}
	events, err = m.Handle(ctx, stop("disk_stop"))
	if err != nil || len(events) != 2 || events[1].Event != "exported" {
		t.Fatalf("retry: %+v %v", events, err)
	}
}

func TestExportFailureDoesNotRemoveExistingDestination(t *testing.T) {
	_, reply, size := fixture(t)
	dest := filepath.Join(t.TempDir(), "capture.tar")
	want := []byte("existing operator file")
	if err := os.WriteFile(dest, want, 0600); err != nil {
		t.Fatal(err)
	}
	m := manager(t, &fakeRunner{reply: reply}, size, &Destination{CapabilityID: "cap", Path: dest})
	if _, err := m.Handle(context.Background(), disk(dest, "cap")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Handle(context.Background(), stop("disk_stop")); err == nil {
		t.Fatal("existing destination overwritten")
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != string(want) {
		t.Fatalf("existing destination changed: %q %v", got, err)
	}
}
