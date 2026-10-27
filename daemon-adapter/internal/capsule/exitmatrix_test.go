package capsule

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

// Source: SW-0251 POSIX Shell, AWK, and Inter-Process Communication Pipelines
// INV-STATUS: status mapping for process exit codes.
// INV-SIGSTATUS: death of child by signal.
// OmniCodex PL60: Bash interop and execution contract.
func TestExitMatrix(t *testing.T) {
	binDir := t.TempDir()
	stateDir := filepath.Join(t.TempDir(), "state")

	scriptPath := filepath.Join(binDir, "srf-identity-surface")
	scriptContent := `#!/bin/sh
cmd="$1"
if [ "$cmd" = "stderr_garbage" ]; then
    echo "GARBAGE STDERR WARNING" >&2
    echo '{"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}]}'
    exit 0
elif [ "$cmd" = "exit" ]; then
    code="$2"
    echo "GARBAGE STDERR BEFORE EXIT $code" >&2
    if [ "$code" = "0" ]; then
        echo '{"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}]}'
    fi
    exit "$code"
elif [ "$cmd" = "sigkill" ]; then
    echo "DYING BY SIGKILL" >&2
    kill -9 $$
elif [ "$cmd" = "sleep" ]; then
    sleep 10
else
    echo '{"container": "srf-id-demo", "run_id": "demo-run", "windows": [{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}]}'
    exit 0
fi
`
	if err := os.WriteFile(scriptPath, []byte(scriptContent), 0755); err != nil {
		t.Fatal(err)
	}

	runner, err := NewProcessRunner(binDir, []string{"PATH=/usr/bin:/bin", "MV_SRF_STATE_DIR=" + stateDir}, 4096, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	// 1. Exit status matrix 0..8
	expectedCodes := map[int]string{
		0: "", // success
		1: "invalid_exit",
		2: "usage",
		3: "setup",
		4: "unavailable",
		5: "malformed",
		6: "refused",
		7: "cli_failed",
		8: "invalid_exit",
	}

	for exitCode, expectedFaultCode := range expectedCodes {
		out, err := runner.Run(context.Background(), []string{scriptPath, "exit", fmt.Sprintf("%d", exitCode)}, nil)
		if exitCode == 0 {
			if err != nil {
				t.Fatalf("exit code 0 failed unexpectedly: %v", err)
			}
			if len(out) == 0 {
				t.Fatal("expected stdout output for exit code 0")
			}
		} else {
			if err == nil {
				t.Fatalf("expected error for exit code %d, got nil", exitCode)
			}
			f, ok := err.(*cli.Fault)
			if !ok {
				t.Fatalf("expected *cli.Fault for exit code %d, got %T: %v", exitCode, err, err)
			}
			if f.Code != expectedFaultCode {
				t.Errorf("exit code %d: expected fault code %q, got %q", exitCode, expectedFaultCode, f.Code)
			}
		}
	}

	// 2. Killed by signal
	_, err = runner.Run(context.Background(), []string{scriptPath, "sigkill"}, nil)
	if err == nil {
		t.Fatal("expected error for process killed by SIGKILL")
	}
	f, ok := err.(*cli.Fault)
	if !ok {
		t.Fatalf("expected *cli.Fault for signal death, got %T: %v", err, err)
	}
	if f.Code != "uncertain" {
		t.Errorf("signal death: expected fault code 'uncertain', got %q", f.Code)
	}

	// 3. Stderr garbage output does not leak into stdout
	out, err := runner.Run(context.Background(), []string{scriptPath, "stderr_garbage"}, nil)
	if err != nil {
		t.Fatalf("stderr_garbage test failed: %v", err)
	}
	if string(out) == "GARBAGE STDERR WARNING\n" || len(out) == 0 {
		t.Fatalf("stderr leaked into stdout: %q", string(out))
	}

	// 4. Timeout context produces fault with code "uncertain"
	ctxTimeout, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = runner.Run(ctxTimeout, []string{scriptPath, "sleep"}, nil)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	f, ok = err.(*cli.Fault)
	if !ok {
		t.Fatalf("expected *cli.Fault on timeout, got %T: %v", err, err)
	}
	if f.Code != "uncertain" {
		t.Errorf("timeout: expected fault code 'uncertain', got %q", f.Code)
	}
}
