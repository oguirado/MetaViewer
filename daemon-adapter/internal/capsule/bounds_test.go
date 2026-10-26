package capsule

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

// Source: SW-0103 §2.2–2.3 (Carrier-Thread Exhaustion)
// Source: SW-0095 INV-EXIT, INV-FIT (Scheduler bounds)
func TestCaptureGoroutineBounds(t *testing.T) {
	binDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "state")

	scriptPath := filepath.Join(binDir, "srf-identity-surface")
	scriptContent := `#!/bin/sh
cmd="$1"
if [ "$cmd" = "sleep" ] || [ "$cmd" = "frame" ]; then
    sleep 5
    exit 0
else
    echo '{"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}]}'
    exit 0
fi
`
	if err := os.WriteFile(scriptPath, []byte(scriptContent), 0755); err != nil {
		t.Fatal(err)
	}

	runner, err := NewProcessRunner(binDir, []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + stateDir}, 4096, 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}

	cfg := Config{
		BinDir:         binDir,
		MaxSurfaces:    10,
		MaxOutputBytes: 4096,
		Timeout:        50 * time.Millisecond,
		OriginNS:       1000,
		Profiles: map[string]Profile{
			"id-demo": {Kind: "browser", NativeKind: "browser", Display: ":0", Width: 2, Height: 1, RAMRoot: "/dev/shm"},
		},
	}

	mgr, err := NewManager(cfg, runner, func() uint64 { return 2000 })
	if err != nil {
		t.Fatal(err)
	}

	// Create a surface
	req := Request{
		Schema: "surface_request/v0.2",
		Op:     "create",
		Params: []byte(`{"kind":"browser","profile_id":"id-demo","geometry":{"w":2,"h":1}}`),
	}
	resp, err := mgr.Handle(context.Background(), req)
	if err != nil || len(resp) == 0 {
		t.Fatalf("failed to create surface: %v", err)
	}

	var surfaceID string
	var createdEv struct {
		Data struct {
			Surface struct {
				SurfaceID string `json:"surface_id"`
			} `json:"surface"`
		} `json:"data"`
	}
	_ = cli.ParseLine(resp[0], 4096, &createdEv)
	surfaceID = createdEv.Data.Surface.SurfaceID

	baselineRoutines := runtime.NumGoroutine()

	// Launch N concurrent Capture calls against sleeping script
	N := 20
	var wg sync.WaitGroup
	wg.Add(N)

	for i := 0; i < N; i++ {
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			_, _, err := mgr.Capture(ctx, surfaceID)
			if err == nil {
				t.Errorf("expected error on timed out capture")
			}
		}()
	}

	wg.Wait()

	// Wait for goroutines to clean up
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		if runtime.NumGoroutine() <= baselineRoutines+2 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}

	if runtime.NumGoroutine() > baselineRoutines+2 {
		t.Fatalf("goroutine leak detected: baseline %d, current %d", baselineRoutines, runtime.NumGoroutine())
	}
}
