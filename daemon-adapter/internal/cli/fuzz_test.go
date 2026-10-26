package cli

import (
	"os"
	"testing"
)

// Source: SW-0102 F8 (handle reused for a different operation)
// Source: SW-0198 INV-2 (exact bounds verification on inputs)
func FuzzParseLine(f *testing.F) {
	seeds := [][]byte{
		[]byte(`{"container":"srf-id-demo","run_id":"demo-run"}`),
		[]byte(`{"container":"srf-id-demo","run_id":"demo-run","extra":123}`),
		[]byte(`{"invalid_json":`),
		[]byte("{\n\"multiline\": true\n}"),
		[]byte(""),
	}
	if seedData, err := os.ReadFile("../../testdata/cli_identity_valid.json"); err == nil {
		seeds = append(seeds, seedData)
	}
	if seedData, err := os.ReadFile("../../testdata/cli_malformed.txt"); err == nil {
		seeds = append(seeds, seedData)
	}

	for _, seed := range seeds {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		var dst struct {
			Container string `json:"container"`
			RunID     string `json:"run_id"`
		}
		// Must not panic under any input.
		_ = ParseLine(data, 4096, &dst)
	})
}
