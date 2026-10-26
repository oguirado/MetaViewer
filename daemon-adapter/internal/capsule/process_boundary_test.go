package capsule

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

// Source: SW-0251 INV-INHERIT, INV-EOF-ORDER (Descriptor and process boundary invariants)
func TestProcessBoundaryObligation7(t *testing.T) {
	binDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "state")

	scriptPath := filepath.Join(binDir, "srf-identity-surface")
	grandchildScript := `#!/bin/sh
cmd="$1"
if [ "$cmd" = "grandchild" ]; then
    # Spawn a background grandchild that holds stdout open for 10 seconds
    (sleep 10; echo "grandchild finished") &
    echo '{"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}]}'
    exit 0
else
    echo '{"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}]}'
    exit 0
fi
`
	if err := os.WriteFile(scriptPath, []byte(grandchildScript), 0755); err != nil {
		t.Fatal(err)
	}

	// 1. Refuse NUL-byte env
	if _, err := NewProcessRunner(binDir, []string{"PATH=/bin", "VAR=\x00bad"}, 4096, time.Second); err == nil {
		t.Fatal("expected refusal for NUL-byte in env")
	}

	// 2. Refuse missing PATH
	if _, err := NewProcessRunner(binDir, []string{"MV_SRF_STATE_DIR=" + stateDir}, 4096, time.Second); err == nil {
		t.Fatal("expected refusal when PATH is missing")
	}

	// 3. Refuse unlisted env keys
	if _, err := NewProcessRunner(binDir, []string{"PATH=/bin", "UNLISTED_VAR=1"}, 4096, time.Second); err == nil {
		t.Fatal("expected refusal for unlisted env key")
	}

	runner, err := NewProcessRunner(binDir, []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + stateDir}, 4096, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	// 4. Argv[0] outside BinDir refused
	if _, err := runner.Run(context.Background(), []string{"/bin/echo", "start"}, nil); err == nil {
		t.Fatal("expected refusal for argv[0] outside BinDir")
	}

	// 5. Caller state-dir flags refused
	for _, flag := range []string{"--state-dir", "--state-dir=/tmp", "-state-dir", "-state-dir=/tmp"} {
		if _, err := runner.Run(context.Background(), []string{scriptPath, "start", flag}, nil); err == nil {
			t.Fatalf("expected refusal when caller supplies state-dir flag %q", flag)
		}
	}

	// 6. State dir validation (symlink, foreign uid, non-0700)
	symlinkStateDir := filepath.Join(t.TempDir(), "symlink-state")
	realStateDir := t.TempDir()
	if err := os.Symlink(realStateDir, symlinkStateDir); err != nil {
		t.Fatal(err)
	}
	runnerSymlink, err := NewProcessRunner(binDir, []string{"PATH=/bin", "MV_SRF_STATE_DIR=" + symlinkStateDir}, 4096, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runnerSymlink.Run(context.Background(), []string{scriptPath, "start"}, nil); err == nil {
		t.Fatal("expected refusal for symlink state dir")
	}

	// 7. Grandchild holding stdout pipe returns without hanging forever thanks to WaitDelay (1s)
	start := time.Now()
	_, err = runner.Run(context.Background(), []string{scriptPath, "grandchild"}, nil)
	elapsed := time.Since(start)

	// Due to WaitDelay=1s, Run returns after ~1s with a fault ("uncertain") rather than hanging for 10s
	if elapsed >= 5*time.Second {
		t.Fatalf("ProcessRunner hung for %v waiting for grandchild stdout pipe", elapsed)
	}
	if err == nil {
		t.Fatal("expected uncertain fault when grandchild holds stdout pipe past WaitDelay")
	}
	f, ok := err.(*cli.Fault)
	if !ok || f.Code != "uncertain" {
		t.Fatalf("expected fault code 'uncertain' on WaitDelay expiration, got %v", err)
	}
}
