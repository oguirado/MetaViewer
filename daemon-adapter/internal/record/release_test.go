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

func TestUnregisterSurfaceReclaimsActiveRecordingAndPreservesActiveRefusal(t *testing.T) {
	source, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	framesRoot := filepath.Dir(source)
	m, err := NewManager(Config{
		Runner:   runner,
		Clock:    func() uint64 { return 10 },
		OriginNS: 100,
		BinDir:   t.TempDir(),
		Surfaces: map[string]Surface{
			"s1": {Family: "srf-identity-surface", Container: "capsule", Window: "w1", FramesRoot: framesRoot},
			"s2": {Family: "srf-identity-surface", Container: "capsule", Window: "w1", FramesRoot: framesRoot},
		},
		MemoryBytes: size * 2,
		RingBytes:   size,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	ctx := context.Background()

	// Start active recordings on both s1 and s2, filling the 2*size session memory budget.
	if _, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s1", "recording_id": "rec-s1", "ring_bytes": size, "max_fps": 20})); err != nil {
		t.Fatal(err)
	}
	ev1, err := m.Poll(ctx, "poll-s1", "rec-s1")
	if err != nil || len(ev1) != 1 {
		t.Fatalf("poll s1: %+v %v", ev1, err)
	}
	ownedS1 := ev1[0].RAMPath

	runner.reply = update(t, reply, map[string]any{"seq": 2, "generation": 2, "capture_mono_ns": 2_000_000_100})
	if _, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s2", "recording_id": "rec-s2", "ring_bytes": size, "max_fps": 20})); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Poll(ctx, "poll-s2", "rec-s2"); err != nil {
		t.Fatal(err)
	}

	// Budget is now full; starting a second recording on s2 is refused with BUDGET_EXCEEDED.
	overEvents, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s2", "recording_id": "rec-over", "ring_bytes": size, "max_fps": 20}))
	requireRefused(t, overEvents, err)
	if overEvents[0].ReasonCode != "BUDGET_EXCEEDED" {
		t.Fatalf("expected BUDGET_EXCEEDED before surface destroy, got %+v", overEvents)
	}

	// Negative control: Release on genuinely active recording on admitted surface s2 still returns ErrActiveRecording.
	if err := releaseCapture(t, m, "rec-s2"); !errors.Is(err, ErrActiveRecording) {
		t.Fatalf("Release on active recording on admitted surface = %v, want ErrActiveRecording", err)
	}

	// Destroy surface s1 via UnregisterSurface; active recording rec-s1 is sealed/cleaned up and Release succeeds.
	if err := m.UnregisterSurface("s1"); err != nil {
		t.Fatalf("UnregisterSurface s1 failed: %v", err)
	}
	if err := releaseCapture(t, m, "rec-s1"); err != nil {
		t.Fatalf("Release after UnregisterSurface failed: %v", err)
	}
	if _, err := os.Stat(ownedS1); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned RAM frame on destroyed surface was not removed: %v", err)
	}

	// Starting a new recording on s2 that requires the freed memory reservation now succeeds.
	started, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s2", "recording_id": "rec-s2-after", "ring_bytes": size, "max_fps": 20}))
	if err != nil || len(started) != 1 || started[0].Event != "started" {
		t.Fatalf("new recording after UnregisterSurface + Release failed: %+v %v", started, err)
	}
}

func TestUnregisterSurfaceReportsRemoveErrorAccountsReservationAndRetries(t *testing.T) {
	source, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	framesRoot := filepath.Dir(source)
	m, err := NewManager(Config{
		Runner:   runner,
		Clock:    func() uint64 { return 10 },
		OriginNS: 100,
		BinDir:   t.TempDir(),
		Surfaces: map[string]Surface{
			"s1": {Family: "srf-identity-surface", Container: "capsule", Window: "w1", FramesRoot: framesRoot},
			"s2": {Family: "srf-identity-surface", Container: "capsule", Window: "w1", FramesRoot: framesRoot},
		},
		MemoryBytes: size,
		RingBytes:   size,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	ctx := context.Background()

	if _, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s1", "recording_id": "rec-s1", "ring_bytes": size, "max_fps": 20})); err != nil {
		t.Fatal(err)
	}
	ev, err := m.Poll(ctx, "poll-s1", "rec-s1")
	if err != nil || len(ev) != 1 {
		t.Fatalf("poll s1: %+v %v", ev, err)
	}
	ownedPath := ev[0].RAMPath

	// A nonempty directory cannot be unlinked, including as namespace root.
	savedPath := ownedPath + ".saved"
	if err := os.Rename(ownedPath, savedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(ownedPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ownedPath, "obstruction"), []byte("retain"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := m.UnregisterSurface("s1"); err == nil {
		t.Fatal("expected UnregisterSurface to return Remove error for a nonempty directory")
	}
	if _, err := os.Stat(ownedPath); err != nil {
		t.Fatalf("expected owned copy to still exist after failed unlink: %v", err)
	}
	// While the owned copy remains on disk, its reservation is still accounted.
	overEvents, overErr := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s2", "recording_id": "rec-s2-blocked", "ring_bytes": size, "max_fps": 20}))
	requireRefused(t, overEvents, overErr)
	if overEvents[0].ReasonCode != "BUDGET_EXCEEDED" {
		t.Fatalf("expected BUDGET_EXCEEDED while failed unlink retains reservation, got %+v", overEvents)
	}

	// Restore the owned file and retry the same unlink and reservation release.
	if err := os.RemoveAll(ownedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(savedPath, ownedPath); err != nil {
		t.Fatal(err)
	}

	if err := m.UnregisterSurface("s1"); err != nil {
		t.Fatalf("retry UnregisterSurface failed: %v", err)
	}
	if _, err := os.Stat(ownedPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected owned copy to be unlinked on retry, got %v", err)
	}
	started, err := m.Handle(ctx, payload("ram_start", map[string]any{"surface_id": "s2", "recording_id": "rec-s2-ok", "ring_bytes": size, "max_fps": 20}))
	if err != nil || len(started) != 1 || started[0].Event != "started" {
		t.Fatalf("expected new recording to succeed after retry freed reservation: %+v %v", started, err)
	}
}
