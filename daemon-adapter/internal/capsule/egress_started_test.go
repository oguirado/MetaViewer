package capsule

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEgressStartedLifecycle(t *testing.T) {
	for _, tc := range []struct{ name, capabilities, record, want string }{
		{"open", `{"net_modes":["open"]}`, "open", "open"},
		{"unsupported-open", `{}`, "open", "legacy"},
		{"absent", `{}`, "", "legacy"},
		{"proxied", `{"net_modes":["proxied"]}`, "allowlisted", "proxied"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, state, _ := networkTestManager(t, tc.capabilities, false)
			if tc.record != "" {
				domains := []string{}
				if tc.record == "allowlisted" {
					domains = []string{"example.com"}
				}
				if err := StoreEgress(state, "demo", Egress{egressSchema, tc.record, domains}); err != nil {
					t.Fatal(err)
				}
			}
			if tc.want == "proxied" {
				if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-egress-proxy"), []byte("#!/bin/sh\nexit 99\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			script := "#!/bin/sh\ncase \"$1\" in\nstart) printf '%s\\n' '" + startOK + "';;\nstop) printf '%s\\n' '{\"stopped\":\"srf-id-demo\",\"removed_verified\":true}';;\nesac\n"
			if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-identity-surface"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			var old []byte
			var oldFile *os.File
			for generation := 0; generation < 2; generation++ {
				_, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
				if err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(state, "egress", "demo.started.json")
				b, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				var witness EgressStarted
				if err := json.Unmarshal(b, &witness); err != nil {
					t.Fatal(err)
				}
				sum, err := egressRecordDigest(state, "demo")
				if err != nil {
					t.Fatal(err)
				}
				st, err := os.Stat(path)
				if err != nil {
					t.Fatal(err)
				}
				if st.Mode().Perm() != 0400 || witness.Schema != egressStartedSchema || witness.CapsuleID != "srf-id-demo" || witness.EffectiveMode != tc.want || witness.RecordSHA256 != sum || witness.StartMonoNS != 200 || witness.StartWallNS <= 0 {
					t.Fatalf("invalid witness: %s, mode %v", b, st.Mode())
				}
				if generation == 0 {
					old = b
					oldFile, err = os.Open(path)
					if err != nil {
						t.Fatal(err)
					}
					defer oldFile.Close()
					// Atomic replacement must not modify an already opened inode.
					replacement := witness
					replacement.StartWallNS++
					if _, err := writePrivateEgressFile(state, "demo.started.json", replacement, 0400); err != nil {
						t.Fatal(err)
					}
					held := make([]byte, len(old))
					if _, err := oldFile.ReadAt(held, 0); err != nil {
						t.Fatal(err)
					}
					if string(held) != string(old) {
						t.Fatal("witness overwritten in place")
					}
					fresh, err := os.ReadFile(path)
					if err != nil || string(fresh) == string(old) {
						t.Fatalf("replacement not published: %v", err)
					}
				}
				var activeID string
				for id, binding := range m.bindings {
					if binding.Surface.State == "active" {
						activeID = id
					}
				}
				_, err = m.Handle(context.Background(), req("destroy", `{"surface_id":"`+activeID+`"}`))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("stop retained witness: %v", err)
				}
			}
			entries, err := os.ReadDir(filepath.Join(state, "egress"))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".egress-") {
					t.Fatal("temporary publication leaked")
				}
			}
		})
	}
}
