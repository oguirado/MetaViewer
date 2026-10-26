// [TARGET, unit decision] Compile through go -overlay from this test-only
// surface; exercise the committed adapter with real fake-CLI child output.
package cli_test

import (
	"context"
	"errors"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestW1FakeCLIContract(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	args := []string{os.Getenv("MV_W1_FAKE_CLI"), "--family", "identity", "start",
		"--identity", "wall", "--store-root", "/fixture/store", "--registry", "/fixture/registry"}
	output, err := exec.CommandContext(ctx, os.Getenv("MV_W1_PYTHON"), args...).Output()
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		Kind      string `json:"kind"`
		Container string `json:"container"`
		RunID     string `json:"run_id"`
		Windows   []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
			URL   string `json:"url"`
			X     int    `json:"x"`
			Y     int    `json:"y"`
			W     int    `json:"w"`
			H     int    `json:"h"`
		} `json:"windows"`
	}
	if err := cli.ParseLine(output, 65536, &value); err != nil {
		t.Fatal(err)
	}
	if value.Kind != "browser" || value.Container != "srf-id-wall" || len(value.Windows) != 1 {
		t.Fatalf("unexpected fake identity: %+v", value)
	}
	for _, mutant := range [][]byte{append(append([]byte{}, output...), output...),
		[]byte(`{"unknown":true}`), []byte(`{"kind":"browser","kind":"vm"}`)} {
		if cli.ParseLine(mutant, 65536, &value) == nil {
			t.Fatal("mutant accepted")
		}
	}
	failedArgs := []string{os.Getenv("MV_W1_FAKE_CLI"), "--family", "identity", "--fault", "6", "start"}
	refused, err := exec.CommandContext(ctx, os.Getenv("MV_W1_PYTHON"), failedArgs...).Output()
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("missing refusal: %v %s", err, refused)
	}
	fault := cli.ExitFault("srf-identity-surface", exit.ExitCode(), "private stderr")
	var typed *cli.Fault
	if !errors.As(fault, &typed) {
		t.Fatalf("missing typed fault: %v", fault)
	}
	event, err := capsule.NewErrorEvent("surface-test", typed)
	if err != nil || event.Data.Code != "refused" {
		t.Fatalf("wrong refusal: %+v %v", event, err)
	}
}
