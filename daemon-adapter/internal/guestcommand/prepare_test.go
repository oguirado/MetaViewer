package guestcommand

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareRewindRuntimeFitsNativePathBudget(t *testing.T) {
	for _, rewind := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal", true: "rewind"}[rewind], func(t *testing.T) {
			// Same exact-length root allocated by the normal ARM64 session helper.
			root := filepath.Join("/dev/shm", "metaviewer-arm64-"+nonce()[:24]+"-")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(root) })
			state, runtime := filepath.Join(root, "state"), filepath.Join(root, "r")
			for _, path := range []string{state, runtime} {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			pin := func(name string, mode os.FileMode) Pin {
				path := filepath.Join(root, name)
				data := []byte("synthetic " + name)
				if err := os.WriteFile(path, data, mode); err != nil {
					t.Fatal(err)
				}
				h := sha256.Sum256(data)
				return Pin{Path: path, SHA256: hex.EncodeToString(h[:])}
			}
			m := &Manager{profile: &Profile{OwnerID: "actor-" + strings.Repeat("a", 64),
				StateRoot: state, RuntimeRoot: runtime, Rewind: rewind,
				Python: pin("python", 0700), Runner: pin("runner.py", 0600), ConfigTemplate: json.RawMessage(`{}`)},
				reservation: filepath.Join(state, "reservation.json"), sessionID: "session-test"}
			attempt, _, err := m.prepare()
			if err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(attempt, "launch.json"))
			if err != nil {
				t.Fatal(err)
			}
			var launch struct {
				RuntimeRoot string `json:"runtime_root"`
			}
			if err = json.Unmarshal(raw, &launch); err != nil {
				t.Fatal(err)
			}
			prefix := "headless-"
			if rewind {
				prefix = "r-"
				if len([]byte(launch.RuntimeRoot)) > 70 {
					t.Fatalf("native runtime path exceeds unchanged 70-byte gate: %d %s", len([]byte(launch.RuntimeRoot)), launch.RuntimeRoot)
				}
			}
			if !strings.HasPrefix(filepath.Base(launch.RuntimeRoot), prefix) {
				t.Fatalf("wrong runtime prefix for rewind=%v: %s", rewind, launch.RuntimeRoot)
			}
			info, err := os.Stat(launch.RuntimeRoot)
			if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
				t.Fatalf("runtime custody: %v %v", info, err)
			}
		})
	}
}
