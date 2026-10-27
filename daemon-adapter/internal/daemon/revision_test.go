package daemon

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const adapterTestRevision = "1111111111111111111111111111111111111111"

func buildRevisionBinary(t *testing.T) string {
	t.Helper()
	goTool, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "adapter")
	cmd := exec.Command(goTool, "build", "-buildvcs=false", "-o", binary, "./cmd/mv-daemon-adapter")
	cmd.Dir = "../.."
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	return binary
}

func revisionEnvironment(t *testing.T) {
	t.Helper()
	bin, root := fakeNative(t)
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	if err := os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"MV_SRF_BIN_DIR": bin, "MV_SRF_STATE_DIR": state,
		"SRF_IDENTITY_STORE_ROOT": root, "SRF_PROXY_REGISTRY": filepath.Join(root, "proxies.json"),
		"XDG_RUNTIME_DIR": t.TempDir(), "MV_SESSION_ID": "revision-test",
		"MV_CORE_INSTANCE": "core-test", "MV_DAEMON_INSTANCE": "daemon-test",
		"MV_SRF_PROFILES": "", "MV_SRF_LIVE_PROFILE": "demo", "MV_SRF_LIVE_RAM_ROOT": root,
		"MV_CONTRACT_DIR":     filepath.Join(repo, "contracts/v0.2"),
		"MV_COMPONENT_COMMIT": adapterTestRevision, "MV_EXPECTED_CORE_COMMIT": "",
	} {
		t.Setenv(key, value)
	}
}

func TestStartupRefusesMissingRevision(t *testing.T) {
	binary := buildRevisionBinary(t)
	for _, tc := range []struct{ name, revision, diagnostic string }{
		{"missing", "", "valid build revision required"},
		{"malformed", "invalid", "valid build revision required"},
		{"valid", adapterTestRevision, "core.sock"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			revisionEnvironment(t)
			t.Setenv("MV_COMPONENT_COMMIT", tc.revision)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			output, err := exec.CommandContext(ctx, binary).CombinedOutput()
			var exit *exec.ExitError
			if ctx.Err() != nil || !errors.As(err, &exit) || exit.ExitCode() != 2 {
				t.Fatalf("expected startup rc=2, got %v: %s", err, output)
			}
			if !strings.Contains(string(output), tc.diagnostic) {
				t.Fatalf("expected %q: %s", tc.diagnostic, output)
			}
			if tc.name == "valid" && strings.Contains(string(output), "valid build revision required") {
				t.Fatalf("valid revision refused: %s", output)
			}
		})
	}
}
