package capsule

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestProcessBoundary(t *testing.T) {
	root, e := filepath.Abs("testdata")
	if e != nil {
		t.Fatal(e)
	}
	r, e := NewProcessRunner(root, []string{"PATH=/usr/bin:/bin"}, 4096, 100*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	binary := filepath.Join(root, "srf-identity-surface")
	out, e := r.Run(context.Background(), []string{binary, "start"}, nil)
	if e != nil || len(out) == 0 {
		t.Fatalf("fake CLI failed: %v", e)
	}
	t.Setenv("UNADMITTED_TEST_SECRET", "synthetic")
	out, e = r.Run(context.Background(), []string{binary, "environment"}, nil)
	if e != nil || string(out) != "{\"clean\": true}\n" {
		t.Fatal("ambient environment escaped")
	}
	for _, verb := range []string{"overflow", "delay", "refused"} {
		if _, e = r.Run(context.Background(), []string{binary, verb}, nil); e == nil {
			t.Fatalf("unbounded or failed CLI accepted: %s", verb)
		}
	}
	if _, e = r.Run(context.Background(), []string{"/bin/sh", "-c", "true"}, nil); e == nil {
		t.Fatal("unadmitted executable accepted")
	}
	if _, e = NewProcessRunner(root, []string{"PATH=/usr/bin:/bin", "UNADMITTED_TEST_SECRET=x"}, 4096, time.Second); e == nil {
		t.Fatal("unadmitted environment accepted")
	}
}

func TestRuntimeRequiresBinaryEnvironment(t *testing.T) {
	t.Setenv("MV_SRF_BIN_DIR", "")
	if _, e := NewRuntime(Config{}, func() uint64 { return 1 }); e == nil {
		t.Fatal("missing binary environment accepted")
	}
}
