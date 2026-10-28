package record

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func requireDestinationRefusal(t *testing.T, events []Event, err error, wantPrefix string) {
	t.Helper()
	requireRefused(t, events, err)
	ev := events[0]
	if ev.ReasonCode != "POLICY" {
		t.Fatalf("reason_code = %q, want POLICY (detail=%q)", ev.ReasonCode, ev.Detail)
	}
	if !strings.HasPrefix(ev.Detail, wantPrefix+": ") {
		t.Fatalf("detail = %q, want prefix %q", ev.Detail, wantPrefix+": ")
	}
	if strings.Contains(ev.Detail, "/") {
		t.Fatalf("detail leaked host path: %q", ev.Detail)
	}
}

func validateEventsAgainstContractAndTools(t *testing.T, events ...Event) {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Fatalf("python3 required for contract/tools validation: %v", err)
	}
	_, callerFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(callerFile), "..", "..", ".."))
	raw, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	script := `
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "tools"))
sys.path.insert(0, str(root / "agents"))
import check_contracts
from metaviewer_agents import tools

validator = check_contracts.Validator(root / "contracts" / "v0.2")
schema = validator.load("record_event.schema.json")
events = json.loads(sys.stdin.read())
for ev in events:
    validator.validate(ev, schema)
    try:
        checked = tools._check_record_event(
            ev,
            request_id=ev["request_id"],
            surface_id=ev["surface_id"],
            recording_id=ev["recording_id"],
        )
        if ev["event"] == "refused":
            raise AssertionError("expected ToolRefusal on refused event")
        assert checked["event"] == ev["event"]
    except tools.ToolRefusal as exc:
        if ev["event"] != "refused":
            raise
        assert exc.reason_code == ev["reason_code"]
`
	cmd := exec.Command(py, "-c", script, repoRoot)
	cmd.Stdin = bytes.NewReader(raw)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("contract/tools validation failed: %v\n%s", err, out)
	}
}

type treeSnapshot map[string]int64

func snapshotTree(t *testing.T, root string) treeSnapshot {
	t.Helper()
	snap := make(treeSnapshot)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, rErr := filepath.Rel(root, path)
		if rErr != nil {
			return rErr
		}
		if rel == "." {
			return nil
		}
		info, iErr := d.Info()
		if iErr != nil {
			return iErr
		}
		if d.IsDir() {
			snap[rel+"/"] = 0
		} else {
			snap[rel] = info.Size()
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func TestSyntheticFiveMinuteRAMDiffAndSealedExport(t *testing.T) {
	source, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}

	scratch := t.TempDir()
	homeDir := filepath.Join(scratch, "home")
	workDir := filepath.Join(scratch, "work")
	tmpDir := filepath.Join(scratch, "tmp")
	destDir := filepath.Join(scratch, "export")
	outsideDir := t.TempDir()
	for _, d := range []string{homeDir, workDir, tmpDir, destDir} {
		if err := os.MkdirAll(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", homeDir)
	t.Setenv("TMPDIR", tmpDir)
	t.Chdir(workDir)

	m := manager(t, runner, size*2, &Destination{CapabilityID: "cap-export", Path: destDir})
	ctx := context.Background()

	beforeRAM := snapshotTree(t, scratch)

	if _, err := m.Handle(ctx, start(size*2)); err != nil {
		t.Fatal(err)
	}
	for second := uint64(0); second < 300; second++ {
		runner.reply = update(t, reply, map[string]any{
			"seq":             second + 1,
			"generation":      second + 1,
			"capture_mono_ns": 100 + (second+1)*1_000_000_000,
		})
		events, err := m.Poll(ctx, fmt.Sprintf("poll-%d", second+1), "r")
		if err != nil {
			t.Fatal(err)
		}
		captured := events[len(events)-1]
		if captured.Event != "frame_captured" || !strings.HasPrefix(captured.RAMPath, "/dev/shm/") {
			t.Fatalf("capture escaped RAM at second %d: %+v", second, captured)
		}
	}
	stopEvents, err := m.Handle(ctx, stop("ram_stop"))
	if err != nil || len(stopEvents) != 1 || stopEvents[0].Event != "stopped" || stopEvents[0].FrameCount == nil || *stopEvents[0].FrameCount != 2 {
		t.Fatalf("unexpected ram_stop result: %+v %v", stopEvents, err)
	}

	afterRAM := snapshotTree(t, scratch)
	if !reflect.DeepEqual(beforeRAM, afterRAM) {
		t.Fatalf("5-minute RAM recording dirtied disk tree: before=%v after=%v", beforeRAM, afterRAM)
	}

	// Negative control 5: export to unconfigured destination dir outside configured temp dir is refused.
	unconfEvents, err := m.Handle(ctx, disk(outsideDir, "cap-export"))
	requireDestinationRefusal(t, unconfEvents, err, "DESTINATION_UNSET")
	if entries, rErr := os.ReadDir(outsideDir); rErr != nil || len(entries) != 0 {
		t.Fatalf("unconfigured destination was written: %v %v", entries, rErr)
	}

	// Positive sealed-RAM export to configured destination directory (including max_fps above capture-time MaxFPS).
	exportEvents, err := m.Handle(ctx, payload("disk_start", map[string]any{"surface_id": "s", "recording_id": "r", "destination_capability_id": "cap-export", "destination_path": destDir, "max_fps": 60}))
	if err != nil || len(exportEvents) != 1 || exportEvents[0].Event != "exported" {
		t.Fatalf("sealed-RAM export failed: %+v %v", exportEvents, err)
	}
	exported := exportEvents[0]
	wantTarPath := filepath.Join(destDir, fmt.Sprintf("r-%s.tar", exported.SHA256))
	if exported.DestinationCapabilityID != "cap-export" || exported.DestinationPath != wantTarPath {
		t.Fatalf("unexpected exported destination metadata: %+v (want %s)", exported, wantTarPath)
	}
	tarBytes, err := os.ReadFile(wantTarPath)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(tarBytes)
	if exported.ByteCount == nil || *exported.ByteCount != uint64(len(tarBytes)) || exported.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("exported tar digest/size mismatch: event=%+v len=%d", exported, len(tarBytes))
	}

	// Verify archive contents match the 2 retained frames.
	origPNG, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(bytes.NewReader(tarBytes))
	for i := 1; i <= 2; i++ {
		hdr, hErr := tr.Next()
		if hErr != nil || hdr.Name != fmt.Sprintf("frame-%06d.png", i) {
			t.Fatalf("entry %d header: %+v %v", i, hdr, hErr)
		}
		payloadBytes, pErr := io.ReadAll(tr)
		if pErr != nil || !bytes.Equal(payloadBytes, origPNG) {
			t.Fatalf("entry %d payload mismatch: %v", i, pErr)
		}
	}
	if _, err := tr.Next(); err != io.EOF {
		t.Fatalf("unexpected extra tar entry: %v", err)
	}

	// Verify only the single tar archive under export/ was added to scratch.
	afterExport := snapshotTree(t, scratch)
	relTar, err := filepath.Rel(scratch, wantTarPath)
	if err != nil {
		t.Fatal(err)
	}
	expectedAfterExport := make(treeSnapshot, len(beforeRAM)+1)
	for k, v := range beforeRAM {
		expectedAfterExport[k] = v
	}
	expectedAfterExport[relTar] = int64(len(tarBytes))
	if !reflect.DeepEqual(afterExport, expectedAfterExport) {
		t.Fatalf("export wrote outside configured directory: got=%v want=%v", afterExport, expectedAfterExport)
	}

	// Negative control 4: double export of the same sealed RAM recording collides on O_EXCL with POLICY / DESTINATION_EXISTS.
	dupEvents, err := m.Handle(ctx, disk(destDir, "cap-export"))
	requireDestinationRefusal(t, dupEvents, err, "DESTINATION_EXISTS")

	// Releasing the sealed RAM recording reclaims /dev/shm pins while preserving the exported tar.
	if err := m.Release("r"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wantTarPath); err != nil {
		t.Fatalf("Release deleted exported tar: %v", err)
	}

	// Negative control 1: sealed-RAM export without configured Destination refuses with POLICY / DESTINATION_UNSET.
	mUnset := manager(t, runner, size, nil)
	if _, err := mUnset.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := mUnset.Poll(ctx, "poll-unset", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := mUnset.Handle(ctx, stop("ram_stop")); err != nil {
		t.Fatal(err)
	}
	unsetEvents, err := mUnset.Handle(ctx, disk(destDir, "cap-export"))
	requireDestinationRefusal(t, unsetEvents, err, "DESTINATION_UNSET")

	// Negative control 2: export of an active (unsealed) RAM recording refuses with POLICY.
	mActive := manager(t, runner, size, &Destination{CapabilityID: "cap-export", Path: destDir})
	if _, err := mActive.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	activeEvents, err := mActive.Handle(ctx, disk(destDir, "cap-export"))
	requireRefused(t, activeEvents, err)
	if activeEvents[0].ReasonCode != "POLICY" {
		t.Fatalf("active recording export reason_code = %q, want POLICY", activeEvents[0].ReasonCode)
	}

	// Negative control 3: export of sealed RAM recording when destination directory is missing refuses with POLICY / DESTINATION_UNAVAILABLE.
	missingDir := filepath.Join(t.TempDir(), "missing-export-dir")
	mMissing := manager(t, runner, size, &Destination{CapabilityID: "cap-export", Path: missingDir})
	if _, err := mMissing.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := mMissing.Poll(ctx, "poll-missing", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := mMissing.Handle(ctx, stop("ram_stop")); err != nil {
		t.Fatal(err)
	}
	missingEvents, err := mMissing.Handle(ctx, disk(missingDir, "cap-export"))
	requireDestinationRefusal(t, missingEvents, err, "DESTINATION_UNAVAILABLE")

	validateEventsAgainstContractAndTools(t, stopEvents[0], unconfEvents[0], exported, dupEvents[0], unsetEvents[0], activeEvents[0], missingEvents[0])
}

func TestExportTypedDestinationFailures(t *testing.T) {
	_, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	ctx := context.Background()

	t.Run("missing_parent", func(t *testing.T) {
		missingDest := filepath.Join(t.TempDir(), "absent-parent", "capture.tar")
		m := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: missingDest})
		if _, err := m.Handle(ctx, disk(missingDest, "cap")); err != nil {
			t.Fatal(err)
		}
		if _, err := m.Poll(ctx, "poll", "r"); err != nil {
			t.Fatal(err)
		}
		events, err := m.Handle(ctx, stop("disk_stop"))
		requireDestinationRefusal(t, events, err, "DESTINATION_UNAVAILABLE")
		validateEventsAgainstContractAndTools(t, events...)
	})

	t.Run("vanished_or_replaced_grant", func(t *testing.T) {
		grantDir := filepath.Join(t.TempDir(), "grant-dir")
		if err := os.Mkdir(grantDir, 0700); err != nil {
			t.Fatal(err)
		}
		m := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: grantDir})
		if _, err := m.Handle(ctx, disk(grantDir, "cap")); err != nil {
			t.Fatal(err)
		}
		if _, err := m.Poll(ctx, "poll", "r"); err != nil {
			t.Fatal(err)
		}
		// Replace the pinned directory with a fresh directory inode at the same path.
		if err := os.RemoveAll(grantDir); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(grantDir, 0700); err != nil {
			t.Fatal(err)
		}
		events, err := m.Handle(ctx, stop("disk_stop"))
		requireDestinationRefusal(t, events, err, "DESTINATION_UNAVAILABLE")
		if entries, rErr := os.ReadDir(grantDir); rErr != nil || len(entries) != 0 {
			t.Fatalf("replaced grant directory was written: %v %v", entries, rErr)
		}
		validateEventsAgainstContractAndTools(t, events...)
	})

	t.Run("non_creatable_readonly_destination", func(t *testing.T) {
		roDir := filepath.Join(t.TempDir(), "readonly-dir")
		if err := os.Mkdir(roDir, 0700); err != nil {
			t.Fatal(err)
		}
		dest := filepath.Join(roDir, "capture.tar")
		m := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: dest})
		if _, err := m.Handle(ctx, disk(dest, "cap")); err != nil {
			t.Fatal(err)
		}
		if _, err := m.Poll(ctx, "poll", "r"); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(roDir, 0500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(roDir, 0700) })
		events, err := m.Handle(ctx, stop("disk_stop"))
		requireDestinationRefusal(t, events, err, "DESTINATION_UNAVAILABLE")
		validateEventsAgainstContractAndTools(t, events...)
	})

	t.Run("existing_destination_collision", func(t *testing.T) {
		dest := filepath.Join(t.TempDir(), "existing.tar")
		original := []byte("do not overwrite")
		if err := os.WriteFile(dest, original, 0600); err != nil {
			t.Fatal(err)
		}
		m := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: dest})
		if _, err := m.Handle(ctx, disk(dest, "cap")); err != nil {
			t.Fatal(err)
		}
		if _, err := m.Poll(ctx, "poll", "r"); err != nil {
			t.Fatal(err)
		}
		events, err := m.Handle(ctx, stop("disk_stop"))
		requireDestinationRefusal(t, events, err, "DESTINATION_EXISTS")
		got, err := os.ReadFile(dest)
		if err != nil || !bytes.Equal(got, original) {
			t.Fatalf("existing destination modified: %q %v", got, err)
		}
		validateEventsAgainstContractAndTools(t, events...)
	})

	t.Run("negative_controls_valid_export_and_policy_refusal", func(t *testing.T) {
		destDir := t.TempDir()
		m := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: destDir})

		// Unauthorized capability refuses with POLICY and DESTINATION_UNSET prefix on both fresh and sealed disk_start.
		policyEvents, err := m.Handle(ctx, disk(destDir, "wrong-cap"))
		requireDestinationRefusal(t, policyEvents, err, "DESTINATION_UNSET")

		// Valid export to clean authorized directory succeeds.
		if _, err := m.Handle(ctx, disk(destDir, "cap")); err != nil {
			t.Fatal(err)
		}
		if _, err := m.Poll(ctx, "poll", "r"); err != nil {
			t.Fatal(err)
		}
		events, err := m.Handle(ctx, stop("disk_stop"))
		if err != nil || len(events) != 2 || events[0].Event != "stopped" || events[1].Event != "exported" {
			t.Fatalf("valid export failed: %+v %v", events, err)
		}
		tarBytes, err := os.ReadFile(events[1].DestinationPath)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(tarBytes)
		if events[1].ByteCount == nil || *events[1].ByteCount != uint64(len(tarBytes)) || events[1].SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("valid export digest/size mismatch: %+v", events[1])
		}
		validateEventsAgainstContractAndTools(t, policyEvents[0], events[0], events[1])
	})
}

func TestExportDirPathBoundClockCeilingAndConsistentDestinationMismatch(t *testing.T) {
	_, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	ctx := context.Background()

	// 1. exportDir full destination_path > 4096 chars is refused before creating anything on disk.
	baseDir := t.TempDir()
	longDir := baseDir
	for len(longDir) < 3950 {
		longDir = filepath.Join(longDir, strings.Repeat("d", 180))
	}
	rem := 4020 - len(longDir) - 1
	if rem > 0 {
		longDir = filepath.Join(longDir, strings.Repeat("e", rem))
	}
	if err := os.MkdirAll(longDir, 0700); err != nil {
		t.Fatal(err)
	}
	mLong := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: longDir})
	if _, err := mLong.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := mLong.Poll(ctx, "poll-long", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := mLong.Handle(ctx, stop("ram_stop")); err != nil {
		t.Fatal(err)
	}
	longEvents, err := mLong.Handle(ctx, disk(longDir, "cap"))
	requireDestinationRefusal(t, longEvents, err, "DESTINATION_UNAVAILABLE")
	if entries, rErr := os.ReadDir(longDir); rErr != nil || len(entries) != 0 {
		t.Fatalf("over-length exportDir created files: %v %v", entries, rErr)
	}
	validateEventsAgainstContractAndTools(t, longEvents...)

	// Positive control: nested destination directory whose full export path fits within 4096 chars succeeds.
	okDir := baseDir
	for len(okDir) < 3600 {
		okDir = filepath.Join(okDir, strings.Repeat("p", 180))
	}
	if err := os.MkdirAll(okDir, 0700); err != nil {
		t.Fatal(err)
	}
	mOK := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: okDir})
	if _, err := mOK.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := mOK.Poll(ctx, "poll-ok", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := mOK.Handle(ctx, stop("ram_stop")); err != nil {
		t.Fatal(err)
	}
	okEvents, err := mOK.Handle(ctx, payload("disk_start", map[string]any{
		"surface_id":                "s",
		"recording_id":              "r",
		"destination_capability_id": "cap",
		"destination_path":          okDir,
		"max_fps":                   120,
	}))
	if err != nil || len(okEvents) != 1 || okEvents[0].Event != "exported" {
		t.Fatalf("bounded nested export failed: %+v %v", okEvents, err)
	}
	if len(okEvents[0].DestinationPath) > 4096 {
		t.Fatalf("destination_path length %d > 4096", len(okEvents[0].DestinationPath))
	}
	if _, err := os.Stat(okEvents[0].DestinationPath); err != nil {
		t.Fatalf("stat exported path failed: %v", err)
	}
	validateEventsAgainstContractAndTools(t, okEvents...)

	// 2. Identical destination mismatch on fresh vs sealed recording returns identical POLICY code and detail.
	grantDir := t.TempDir()
	otherDir := t.TempDir()
	mMismatch := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: grantDir})
	freshMismatch, fErr := mMismatch.Handle(ctx, disk(otherDir, "cap"))
	requireDestinationRefusal(t, freshMismatch, fErr, "DESTINATION_UNSET")
	if _, err := mMismatch.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := mMismatch.Poll(ctx, "poll-m", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := mMismatch.Handle(ctx, stop("ram_stop")); err != nil {
		t.Fatal(err)
	}
	sealedMismatch, sErr := mMismatch.Handle(ctx, disk(otherDir, "cap"))
	requireDestinationRefusal(t, sealedMismatch, sErr, "DESTINATION_UNSET")
	if freshMismatch[0].ReasonCode != sealedMismatch[0].ReasonCode || freshMismatch[0].Detail != sealedMismatch[0].Detail {
		t.Fatalf("mismatch inconsistency: fresh=%+v vs sealed=%+v", freshMismatch[0], sealedMismatch[0])
	}
	validateEventsAgainstContractAndTools(t, freshMismatch[0], sealedMismatch[0])

	// 3. 2^53 - 1 wire clock ceiling enforced on lifecycle/refused events.
	var f struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal(reply, &f)
	clockVal := uint64(1 << 53)
	mCeil, err := NewManager(Config{
		Runner:      runner,
		Clock:       func() uint64 { return clockVal },
		OriginNS:    100,
		BinDir:      t.TempDir(),
		Surfaces:    map[string]Surface{"s": {Family: "srf-identity-surface", Container: "capsule", Window: "w1", FramesRoot: filepath.Dir(f.Path)}},
		MemoryBytes: size * 4,
		RingBytes:   size,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mCeil.Close() })
	ceilEvents, ceilErr := mCeil.Handle(ctx, start(size))
	requireRefused(t, ceilEvents, ceilErr)
	if ceilEvents[0].ReasonCode != "POLICY" || ceilEvents[0].MonoNS > maxWireMonoNS {
		t.Fatalf("expected POLICY refusal with clamped mono_ns <= %d, got %+v", maxWireMonoNS, ceilEvents[0])
	}
	clockVal = maxWireMonoNS
	atCeilEvents, atCeilErr := mCeil.Handle(ctx, start(size))
	if atCeilErr != nil || len(atCeilEvents) != 1 || atCeilEvents[0].Event != "started" || atCeilEvents[0].MonoNS != maxWireMonoNS {
		t.Fatalf("expected started event at exact 2^53-1 ceiling, got %+v %v", atCeilEvents, atCeilErr)
	}
	validateEventsAgainstContractAndTools(t, ceilEvents[0], atCeilEvents[0])
}
