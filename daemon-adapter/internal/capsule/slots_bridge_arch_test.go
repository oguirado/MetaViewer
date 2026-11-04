package capsule

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The slot helper image is chosen per host architecture from local images only.
// A fake docker first on PATH records every probe, so the real candidate list is
// asserted without a Docker daemon and without injecting cfg.Slots.
func TestSlotHelperImageCandidatesFollowHostArchitecture(t *testing.T) {
	bin, root := t.TempDir(), t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker-argv.log")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + calls + "'\nexit 1\n"
	if e := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	r, e := NewProcessRunner(bin, []string{"PATH=" + os.Getenv("PATH"), "SRF_IDENTITY_STORE_ROOT=" + root}, 4096, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	m := &Manager{cfg: Config{Timeout: 5 * time.Second}, runner: r}
	want := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	e = m.initSlots()
	if want == "" {
		if e == nil || e.Error() != "SLOT_ARCHITECTURE_UNSUPPORTED" {
			t.Fatalf("unsupported architecture %s accepted: %v", runtime.GOARCH, e)
		}
		return
	}
	if e == nil || e.Error() != "SLOT_HELPER_IMAGE_ABSENT" {
		t.Fatalf("absent helper images not refused: %v", e)
	}
	if m.slots != nil {
		t.Fatal("slot store configured without a helper image")
	}
	raw, e := os.ReadFile(calls)
	if e != nil {
		t.Fatal("docker was never probed", e)
	}
	got := strings.Split(strings.TrimSpace(string(raw)), "\n")
	expected := []string{
		"image inspect opensuperficies-identity-browser-" + want + ":0.2.0",
		"image inspect opensuperficies-identity-browser-" + want + ":0.1.1",
	}
	if strings.Join(got, "|") != strings.Join(expected, "|") {
		t.Fatalf("helper image candidates on %s: got %q, want %q", runtime.GOARCH, got, expected)
	}
}
