package view

import (
	"context"
	"errors"
	"os"
	"testing"

	"metaviewer/daemon-adapter/internal/cli"
)

// Mutation: ignore NewProcessRunner's error in NewFromEnvironment; refusals fail.
func TestViewEnvironmentAdmission(t *testing.T) {
	for _, mode := range []string{"configured", "missing-binaries", "missing-path", "relative-binaries"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("MV_SRF_BIN_DIR", t.TempDir())
			t.Setenv("PATH", os.Getenv("PATH"))
			if mode == "missing-binaries" {
				t.Setenv("MV_SRF_BIN_DIR", "")
			}
			if mode == "relative-binaries" {
				t.Setenv("MV_SRF_BIN_DIR", "relative")
			}
			if mode == "missing-path" {
				previous, present := os.LookupEnv("PATH")
				t.Cleanup(func() {
					if present {
						_ = os.Setenv("PATH", previous)
					} else {
						_ = os.Unsetenv("PATH")
					}
				})
				if err := os.Unsetenv("PATH"); err != nil {
					t.Fatal(err)
				}
			}
			m, err := NewFromEnvironment()
			if m != nil {
				t.Cleanup(m.Close)
			}
			if mode == "configured" {
				if err != nil || m == nil || m.runner == nil {
					t.Fatalf("configured view: %v", err)
				}
				// A valid configuration does not grant arbitrary native identities.
				var f *cli.Fault
				if err := m.Open(context.Background(), "../foreign", false); !errors.As(err, &f) || f.Code != "usage" {
					t.Fatalf("invalid identity: %v", err)
				}
			} else {
				var f *cli.Fault
				if m != nil || !errors.As(err, &f) || f.Code != "configuration" {
					t.Fatalf("bad environment admitted: manager=%v error=%v", m, err)
				}
			}
		})
	}
}
