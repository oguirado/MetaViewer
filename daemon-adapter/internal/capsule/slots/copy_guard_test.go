package slots

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// Copy provisions through a native helper while holding the destination guard,
// then immediately acquires that guard for Load. Helper descendants must never
// retain the descriptor after the adapter releases it.
func TestCopyGuardDoesNotEscapeIntoNativeHelper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "destination.guard")
	release, err := lock(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	probe := func() string {
		t.Helper()
		out, err := exec.Command("python3", "-c", `import os,sys
print('inherited' if any(os.path.realpath('/proc/self/fd/'+fd)==sys.argv[1] for fd in os.listdir('/proc/self/fd')) else 'closed')`, path).CombinedOutput()
		if err != nil {
			t.Fatal(err, string(out))
		}
		return strings.TrimSpace(string(out))
	}
	if got := probe(); got != "closed" {
		t.Fatalf("native helper inherited copy guard: %s", got)
	}
	// Negative control: the same probe must detect an explicitly inheritable fd.
	fd, err := syscall.Open(path, syscall.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if got := probe(); got != "inherited" {
		t.Fatalf("descriptor probe missed negative control: %s", got)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}
