package capsule

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

// ScriptRunner is a mutex-guarded test runner that executes fake native CLI actions.
type ScriptRunner struct {
	mu      sync.Mutex
	binDir  string
	ramRoot string
}

func (sr *ScriptRunner) Run(ctx context.Context, argv []string, stdin []byte) ([]byte, error) {
	sr.mu.Lock()
	defer sr.mu.Unlock()

	verb := argv[1]
	if verb == "start" {
		return []byte(`{"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}]}`), nil
	} else if verb == "stop" {
		var container string
		for i, arg := range argv {
			if arg == "--container" && i+1 < len(argv) {
				container = argv[i+1]
			}
		}
		return []byte(fmt.Sprintf(`{"stopped": %q, "removed_verified": true}`, container)), nil
	} else if verb == "frame" {
		framesDir := filepath.Join(sr.ramRoot, "demo-run", "frames", "w1")
		_ = os.MkdirAll(framesDir, 0700)
		framePath := filepath.Join(framesDir, "f.png")
		if _, err := os.Stat(framePath); os.IsNotExist(err) {
			_ = os.WriteFile(framePath, []byte("dummy"), 0600)
		}
		sha := hex.EncodeToString(make([]byte, 32))
		return []byte(fmt.Sprintf(`{"path": %q, "seq": 1, "sha256_rgb24": %q, "width": 2, "height": 1, "capture_mono_ns": 2000, "generation": "srf-id-demo", "window": {"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}}`, framePath, sha)), nil
	} else if verb == "input" {
		return []byte(`{"surface_id": "w1", "kind": "click", "input_mono_ns": 2000, "focus_verified": true, "result": "ok"}`), nil
	}
	return nil, &cli.Fault{Code: "cli_failed", Detail: "unknown verb"}
}

// Source: SW-0102, SW-0103, SW-0198
func TestFullGateStress(t *testing.T) {
	ramRoot, err := os.MkdirTemp("/dev/shm", "stress-shm-")
	if err != nil {
		t.Skip("skipping /dev/shm stress test")
	}
	defer os.RemoveAll(ramRoot)

	binDir := t.TempDir()
	runner := &ScriptRunner{binDir: binDir, ramRoot: ramRoot}

	cfg := Config{
		BinDir:         binDir,
		MaxSurfaces:    50,
		MaxOutputBytes: 4096,
		Timeout:        2 * time.Second,
		OriginNS:       1000,
		Profiles: map[string]Profile{
			"id-demo": {Kind: "browser", NativeKind: "browser", Display: ":0", Width: 2, Height: 1, RAMRoot: ramRoot},
		},
	}

	mgr, err := NewManager(cfg, runner, func() uint64 { return 2000 })
	if err != nil {
		t.Fatal(err)
	}

	N := 30
	var wg sync.WaitGroup
	wg.Add(N)

	for i := 0; i < N; i++ {
		go func(idx int) {
			defer wg.Done()
			ctx := context.Background()

			// 1. Create surface
			reqCreate := Request{
				Schema: "surface_request/v0.2",
				Op:     "create",
				Params: []byte(`{"kind":"browser","profile_id":"id-demo","geometry":{"w":2,"h":1}}`),
			}
			resp, err := mgr.Handle(ctx, reqCreate)
			if err != nil || len(resp) == 0 {
				return
			}

			var created struct {
				Data struct {
					Surface struct {
						SurfaceID string `json:"surface_id"`
					} `json:"surface"`
				} `json:"data"`
			}
			if err := cli.ParseLine(resp[0], 4096, &created); err != nil {
				return
			}
			sID := created.Data.Surface.SurfaceID

			// 2. Input
			reqInput := Request{
				Schema: "surface_request/v0.2",
				Op:     "input",
				Params: []byte(fmt.Sprintf(`{"surface_id":%q,"proposal_id":"p1","action":{"type":"click","x":0,"y":0,"button":"left"}}`, sID)),
			}
			_, _ = mgr.Handle(ctx, reqInput)

			// 3. Capture
			_, _, _ = mgr.Capture(ctx, sID)

			// 4. Destroy
			reqDestroy := Request{
				Schema: "surface_request/v0.2",
				Op:     "destroy",
				Params: []byte(fmt.Sprintf(`{"surface_id":%q}`, sID)),
			}
			_, _ = mgr.Handle(ctx, reqDestroy)
		}(i)
	}

	wg.Wait()
}
