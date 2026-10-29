package view

import (
	"context"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
)

func TestProtectedEntryPoints(t *testing.T) {
	for _, name := range []string{"srf-id-cuentas-1", "srf-id-perplexity-1", "srf-pg-notepad-1", "srf-pg-metaviewer-1", "srf-egress-proxy", "n8n", "distil-box"} {
		for _, id := range []string{name, " \t" + name + "\n"} {
			check := func(err error) {
				t.Helper()
				var f *cli.Fault
				if !errors.As(err, &f) || f.Code != "protected_container" {
					t.Fatalf("%q: %v", id, err)
				}
			}
			r := &fakeRunner{}
			m := NewManager(r)
			check(m.Open(context.Background(), id, false))
			check(m.Open(context.Background(), id, true))
			check(m.Stop(context.Background(), id))
			check(m.Paste(context.Background(), id, []byte("hi")))
			if r.calls != 0 {
				t.Fatal("manager dispatched")
			}
			m.Close()
			p := &ProcessRunner{}
			for _, verb := range []string{"view", "login"} {
				_, err := p.Start(context.Background(), []string{"srf-identity-surface", verb, "--container", id})
				check(err)
			}
			for _, verb := range []string{"view-stop", "paste-text"} {
				_, err := p.Run(context.Background(), []string{"srf-identity-surface", verb, "--container", id}, nil)
				check(err)
			}
		}
	}
}
