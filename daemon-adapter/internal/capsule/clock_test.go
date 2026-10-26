package capsule

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

// Source: SW-0103 inv. 5 (Arithmetic safety & exact clock mapping)
func TestCaptureClockMapping(t *testing.T) {
	binDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "state")
	ramRoot, err := os.MkdirTemp("/dev/shm", "clock-test-shm-")
	if err != nil {
		t.Skip("skipping /dev/shm test if unavailable")
	}
	defer os.RemoveAll(ramRoot)

	framesDir := filepath.Join(ramRoot, "demo-run", "frames", "w1")
	if err := os.MkdirAll(framesDir, 0700); err != nil {
		t.Fatal(err)
	}

	framePath := filepath.Join(framesDir, "f.png")
	scriptPath := filepath.Join(binDir, "srf-identity-surface")

	_ = os.WriteFile(framePath, []byte("dummy"), 0600)

	// Script writer helper
	writeScriptWithNSAndSize := func(ns uint64, width, height int) {
		s := fmt.Sprintf(`#!/bin/sh
cmd="$1"
if [ "$cmd" = "start" ]; then
    echo '{"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}]}'
    exit 0
elif [ "$cmd" = "frame" ]; then
    echo '{"path": "%s", "seq": 1, "sha256_rgb24": "%s", "width": %d, "height": %d, "capture_mono_ns": %d, "generation": "srf-id-demo", "window": {"id": "w1", "x": 0, "y": 0, "w": %d, "h": %d, "title": "", "url": ""}}'
    exit 0
fi
`, framePath, hex.EncodeToString(make([]byte, 32)), width, height, ns, width, height)
		_ = os.WriteFile(scriptPath, []byte(s), 0755)
	}

	writeScriptWithNSAndSize(2000, 2, 1)

	runner, err := NewProcessRunner(binDir, []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + stateDir}, 4096, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	originNS := uint64(1000)
	var currentClock atomic.Uint64
	currentClock.Store(1500)

	clockFunc := func() uint64 {
		return currentClock.Load()
	}

	cfg := Config{
		BinDir:         binDir,
		MaxSurfaces:    10,
		MaxOutputBytes: 4096,
		Timeout:        2 * time.Second,
		OriginNS:       originNS,
		Profiles: map[string]Profile{
			"id-demo": {Kind: "browser", NativeKind: "browser", Display: ":0", Width: 2, Height: 1, RAMRoot: ramRoot},
		},
	}

	mgr, err := NewManager(cfg, runner, clockFunc)
	if err != nil {
		t.Fatal(err)
	}

	req := Request{
		Schema: "surface_request/v0.2",
		Op:     "create",
		Params: []byte(`{"kind":"browser","profile_id":"id-demo","geometry":{"w":2,"h":1}}`),
	}
	resp, err := mgr.Handle(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		Data struct {
			Surface struct {
				SurfaceID string `json:"surface_id"`
			} `json:"surface"`
		} `json:"data"`
	}
	_ = cli.ParseLine(resp[0], 4096, &created)
	surfaceID := created.Data.Surface.SurfaceID

	// Test 1: CaptureMonoNS < OriginNS -> Refused
	writeScriptWithNSAndSize(500, 2, 1) // 500 < OriginNS (1000)
	currentClock.Store(1500)
	_, _, err = mgr.Capture(context.Background(), surfaceID)
	if err == nil {
		t.Fatal("expected refusal when CaptureMonoNS < OriginNS")
	}

	// Test 2: CaptureMonoNS < before -> Refused
	writeScriptWithNSAndSize(1200, 2, 1) // before clock set to 1500
	currentClock.Store(1500)
	_, _, err = mgr.Capture(context.Background(), surfaceID)
	if err == nil {
		t.Fatal("expected refusal when CaptureMonoNS < before clock")
	}

	// Test 3: CaptureMonoNS > after -> Refused
	writeScriptWithNSAndSize(3000, 2, 1) // frame claims ns=3000, but after clock will be 2500
	currentClock.Store(1500)
	// We advance clock inside execution by having clock return 2500 on second read
	var callCount atomic.Int32
	steppingClock := func() uint64 {
		if callCount.Add(1) == 1 {
			return 1500 // before
		}
		return 2500 // after
	}
	mgrWithStepClock, _ := NewManager(cfg, runner, steppingClock)
	// Need to register binding on mgrWithStepClock
	mgrWithStepClock.bindings[surfaceID] = mgr.bindings[surfaceID]
	_, _, err = mgrWithStepClock.Capture(context.Background(), surfaceID)
	if err == nil {
		t.Fatal("expected refusal when CaptureMonoNS > after clock")
	}

	// Test 4: Arithmetic / width*height geometry overflow product refused
	writeScriptWithNSAndSize(2000, 99999, 99999)
	currentClock.Store(1500)
	_, _, err = mgr.Capture(context.Background(), surfaceID)
	if err == nil {
		t.Fatal("expected refusal for frame geometry exceeding surface profile bounds")
	}

	// Test 5: Valid Capture -> TSNS = CaptureMonoNS - OriginNS, CaptureUS = (after - before) / 1000
	writeScriptWithNSAndSize(2000, 2, 1) // CaptureMonoNS = 2000
	callCount.Store(0)                   // reset
	// steppingClock returns 1500 before, 2500 after -> CaptureUS = (2500-1500)/1000 = 1 us
	// TSNS = 2000 - 1000 = 1000 ns
	_, frame, err := mgrWithStepClock.Capture(context.Background(), surfaceID)
	if err != nil {
		t.Fatalf("valid capture failed: %v", err)
	}
	if frame.TSNS != 1000 {
		t.Errorf("expected TSNS=1000, got %d", frame.TSNS)
	}
	if frame.CaptureUS != 1 {
		t.Errorf("expected CaptureUS=1, got %d", frame.CaptureUS)
	}
}
