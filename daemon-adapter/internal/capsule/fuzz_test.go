package capsule

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Source: SW-0102 F8 (handle reused / stale parameter interpretation)
// Source: SW-0198 INV-2 (exact bounds and validation safety)
func FuzzCreateParams(f *testing.F) {
	seeds := [][]byte{
		[]byte(`{"kind":"browser","profile_id":"id-demo","geometry":{"w":2,"h":1}}`),
		[]byte(`{"kind":"browser","profile_id":"id-demo","geometry":{"w":2,"h":1},"extra":true}`),
		[]byte(`{"surface_id":"s1","proposal_id":"p1","action":{"type":"click","x":1,"y":0,"button":"left"}}`),
	}
	if seedData, err := os.ReadFile("../../testdata/cli_identity_valid.json"); err == nil {
		seeds = append(seeds, seedData)
	}

	for _, seed := range seeds {
		f.Add(seed)
	}

	binDir, err := filepath.Abs("testdata")
	if err != nil {
		f.Fatal(err)
	}
	stateDir := filepath.Join(f.TempDir(), "state")
	runner, err := NewProcessRunner(binDir, []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + stateDir}, 4096, 2*time.Second)
	if err != nil {
		f.Fatal(err)
	}

	cfg := Config{
		BinDir:         binDir,
		MaxSurfaces:    10,
		MaxOutputBytes: 4096,
		Timeout:        2 * time.Second,
		OriginNS:       1000,
		Profiles: map[string]Profile{
			"id-demo": {Kind: "browser", NativeKind: "browser", Display: ":0", Width: 2, Height: 1, RAMRoot: "/dev/shm"},
		},
	}
	mgr, err := NewManager(cfg, runner, func() uint64 { return 2000 })
	if err != nil {
		f.Fatal(err)
	}

	f.Fuzz(func(t *testing.T, params []byte) {
		req := Request{
			Schema: "surface_request/v0.2",
			Op:     "create",
			Params: json.RawMessage(params),
		}
		// Must not panic under any parameters input.
		_, _ = mgr.Handle(context.Background(), req)

		reqInput := Request{
			Schema: "surface_request/v0.2",
			Op:     "input",
			Params: json.RawMessage(params),
		}
		_, _ = mgr.Handle(context.Background(), reqInput)
	})
}
