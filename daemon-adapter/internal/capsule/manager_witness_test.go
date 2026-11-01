package capsule

// [TARGET, unit decision] Witness and allowlist keys follow validated native
// readiness, including random names; malformed readiness publishes no witness.
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"metaviewer/daemon-adapter/internal/cli"
)

func witnessNativeReply(t *testing.T, m *Manager, reply string) {
	t.Helper()
	script := "#!/bin/sh\ncase \"$1\" in\nstart) printf '%s\\n' '" + reply + "';;\nesac\n"
	if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-identity-surface"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
}

func TestWitnessBindsNativeContainer(t *testing.T) {
	for _, tc := range []struct{ name, capabilities, record, mode string }{
		{"open", `{"net_modes":["open"]}`, "open", "open"},
		{"legacy", `{}`, "open", "legacy"},
		{"absent-record", `{}`, "", "legacy"},
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
			if tc.mode == "proxied" {
				if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-egress-proxy"), []byte("#!/bin/sh\nexit 99\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			var entropy [6]byte
			if _, err := rand.Read(entropy[:]); err != nil {
				t.Fatal(err)
			}
			container := "srf-id-" + hex.EncodeToString(entropy[:])
			witnessNativeReply(t, m, strings.Replace(startOK, "srf-id-demo", container, 1))
			if _, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(state, "egress", "demo.started.json")
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var witness EgressStarted
			if err := json.Unmarshal(data, &witness); err != nil {
				t.Fatal(err)
			}
			digest, err := egressRecordDigest(state, "demo")
			if err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if witness.CapsuleID != container || witness.Schema != egressStartedSchema || witness.EffectiveMode != tc.mode || witness.RecordSHA256 != digest || witness.StartMonoNS != 200 || witness.StartWallNS <= 0 || info.Mode().Perm() != 0400 {
				t.Fatalf("witness does not match native start: %s", data)
			}
			if tc.mode == "proxied" {
				data, err := os.ReadFile(filepath.Join(state, "egress", "demo.policy.json"))
				if err != nil {
					t.Fatal(err)
				}
				var policy struct {
					Approved map[string][]string `json:"approved"`
				}
				if err := json.Unmarshal(data, &policy); err != nil {
					t.Fatal(err)
				}
				if len(policy.Approved) != 1 || len(policy.Approved[container]) != 1 || policy.Approved[container][0] != "example.com" {
					t.Fatalf("policy does not match native container: %s", data)
				}
			}
		})
	}
}

func TestWitnessRefusesMissingNativeContainer(t *testing.T) {
	for _, container := range []string{"", "invalid", "srf-id-../../outside"} {
		t.Run(container, func(t *testing.T) {
			m, state, _ := networkTestManager(t, `{"net_modes":["open"]}`, false)
			// Seed stale evidence so refusal must also invalidate the old witness.
			if _, err := writePrivateEgressFile(state, "demo.started.json", EgressStarted{CapsuleID: "srf-id-old"}, 0400); err != nil {
				t.Fatal(err)
			}
			witnessNativeReply(t, m, strings.Replace(startOK, "srf-id-demo", container, 1))
			events, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
			if _, statErr := os.Stat(filepath.Join(state, "egress", "demo.started.json")); !os.IsNotExist(statErr) {
				t.Fatalf("unvalidated native container published witness: %v", statErr)
			}
			var typed *cli.Fault
			if !errors.As(err, &typed) || typed.Code != "uncertain" || !strings.Contains(err.Error(), "invalid identity readiness or binding") || len(events) != 0 {
				t.Fatalf("expected typed readiness refusal, events=%s err=%v", events, err)
			}
		})
	}
}

func TestWitnessRefusesFailedPolicyRebind(t *testing.T) {
	m, state, _ := networkTestManager(t, `{"net_modes":["proxied"]}`, false)
	if err := StoreEgress(state, "demo", Egress{egressSchema, "allowlisted", []string{"example.com"}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-egress-proxy"), []byte("#!/bin/sh\nexit 99\n"), 0700); err != nil {
		t.Fatal(err)
	}
	// Simulate an operator record change while native start is in flight.
	reply := strings.Replace(startOK, "srf-id-demo", "srf-id-f55be76bf16b", 1)
	recordPath := "'" + strings.ReplaceAll(filepath.Join(state, "egress", "demo.json"), "'", "'\"'\"'") + "'"
	script := "#!/bin/sh\ncase \"$1\" in\nstart) printf '%s\\n' '{\"schema\":\"metaviewer.capsule_egress/v1\",\"mode\":\"open\",\"domains\":[]}' > " + recordPath + "\nprintf '%s\\n' '" + reply + "';;\nesac\n"
	if err := os.WriteFile(filepath.Join(m.cfg.BinDir, "srf-identity-surface"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	events, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
	var typed *cli.Fault
	if !errors.As(err, &typed) || typed.Code != "uncertain" || !strings.Contains(err.Error(), "egress record changed during network preparation") || len(events) != 0 {
		t.Fatalf("expected typed policy rebind refusal, events=%s err=%v", events, err)
	}
	if _, err := os.Stat(filepath.Join(state, "egress", "demo.started.json")); !os.IsNotExist(err) {
		t.Fatalf("failed policy rebind published witness: %v", err)
	}
}
