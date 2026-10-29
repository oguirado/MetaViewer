package record

import (
	"context"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
)

func TestProtectedCapture(t *testing.T) {
	for _, name := range []string{"srf-id-cuentas-1", "srf-id-perplexity-1", "srf-pg-notepad-1", "srf-pg-metaviewer-1", "srf-egress-proxy", "n8n", "distil-box"} {
		for _, family := range []string{"srf-identity-surface", "srf-holdings-capsule"} {
			for _, id := range []string{name, " \t" + name + "\n"} {
				r := &fakeRunner{}
				m := manager(t, r, 1024, nil)
				s := m.cfg.Surfaces["s"]
				s.Container = id
				s.Family = family
				m.cfg.Surfaces["s"] = s
				_, err := m.capture(context.Background(), "q", "r", &recording{surface: "s"})
				var f *cli.Fault
				if !errors.As(err, &f) || f.Code != "protected_container" || r.calls != 0 {
					t.Fatalf("%s: %v calls=%d", id, err, r.calls)
				}
			}
		}
	}
}
