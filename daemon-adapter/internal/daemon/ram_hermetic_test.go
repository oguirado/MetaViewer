package daemon

// [TARGET, unit decision] All daemon tests get a private fallback admission
// directory; wire fixtures additionally use t.TempDir. Watch the host path even
// when the caller has supplied MV_RAM_ADMISSION_DIR (including the whole gate).
import (
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
	"metaviewer/daemon-adapter/internal/record"
)

type realAdmissionGuard struct {
	fd   int
	name string
}

func watchRealAdmission(path string) (*realAdmissionGuard, error) {
	g := &realAdmissionGuard{fd: -1}
	if path == "" {
		return g, nil
	} // No absolute runtime means production refuses.
	watch := path
	for {
		_, err := os.Stat(watch)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return nil, err
		}
		g.name = filepath.Base(watch)
		watch = filepath.Dir(watch)
	}
	fd, err := syscall.InotifyInit1(syscall.IN_NONBLOCK | syscall.IN_CLOEXEC)
	if err != nil {
		return nil, err
	}
	g.fd = fd
	if _, err := syscall.InotifyAddWatch(fd, watch, syscall.IN_CREATE|syscall.IN_MOVED_TO|syscall.IN_DELETE_SELF|syscall.IN_MOVE_SELF); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return g, nil
}
func (g *realAdmissionGuard) check() error {
	if g.fd < 0 {
		return nil
	}
	defer syscall.Close(g.fd)
	buf := make([]byte, 65536)
	for {
		n, err := syscall.Read(g.fd, buf)
		if err == syscall.EAGAIN {
			return nil
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("admission watch unexpectedly closed")
		}
		for off := 0; off < n; {
			if n-off < 16 {
				return fmt.Errorf("truncated admission watch event")
			}
			mask := binary.NativeEndian.Uint32(buf[off+4:])
			size := int(binary.NativeEndian.Uint32(buf[off+12:]))
			if size > n-off-16 {
				return fmt.Errorf("truncated admission watch name")
			}
			name := strings.TrimRight(string(buf[off+16:off+16+size]), "\x00")
			if g.name == "" || name == g.name || mask&(syscall.IN_Q_OVERFLOW|syscall.IN_IGNORED|syscall.IN_DELETE_SELF|syscall.IN_MOVE_SELF) != 0 {
				return fmt.Errorf("MUT-REAL-DIR-WRITE: host admission directory changed (%q)", name)
			}
			off += 16 + size
		}
	}
}
func TestMain(m *testing.M) {
	real := ""
	if runtime := os.Getenv("XDG_RUNTIME_DIR"); filepath.IsAbs(runtime) {
		real = filepath.Join(runtime, "metaviewer", "ram-admission")
	}
	guard, err := watchRealAdmission(real)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	private, err := os.MkdirTemp("", "mv-daemon-admission-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.Setenv("MV_RAM_ADMISSION_DIR", private); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Installed once, before m.Run: no races and no host RAM dependency.
	admissionMemory = func() (ramMemory, error) {
		return ramMemory{available: ramFloorKB + 1024*ramReserveKB, total: 1024 * 1024 * 1024}, nil
	}
	rc := m.Run()
	if err := guard.check(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		rc = 1
	}
	if err := os.RemoveAll(private); err != nil {
		fmt.Fprintln(os.Stderr, err)
		rc = 1
	}
	os.Exit(rc)
}
func isolatedWireHandler(t *testing.T, m *capsule.Manager, profiles map[string]capsule.Profile, pubs map[string]*frames.Publisher, origin uint64, recorders ...*record.Manager) ipc.Handler {
	t.Helper()
	privateAdmission(t)
	return wireHandler(m, profiles, pubs, origin, recorders...)
}
func privateAdmission(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MV_RAM_ADMISSION_DIR", dir)
	return dir
}
func TestRealAdmissionGuardRejectsTransientEntry(t *testing.T) {
	dir := t.TempDir()
	guard, err := watchRealAdmission(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "reservation")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := guard.check(); err == nil {
		t.Fatal("MUT-REAL-DIR-WRITE: transient write accepted")
	}
}
func TestRealAdmissionGuardAllowsPrivateAdmission(t *testing.T) {
	dir := t.TempDir()
	guard, err := watchRealAdmission(dir)
	if err != nil {
		t.Fatal(err)
	}
	privateAdmission(t)
	admission, err := lockAdmissionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if err := syncAdmissionRecords(admission.Name(), "fixture", map[string]bool{"demo": true}); err != nil {
		t.Fatal(err)
	}
	admission.Close()
	if err := guard.check(); err != nil {
		t.Fatal(err)
	}
}
func TestRealAdmissionGuardMissingDirectory(t *testing.T) {
	root := t.TempDir()
	guard, err := watchRealAdmission(filepath.Join(root, "metaviewer", "ram-admission"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "metaviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := guard.check(); err == nil {
		t.Fatal("new host admission ancestor accepted")
	}
}

// The mutation runs against a synthetic host runtime, never the operator's path.
// The child test itself passes; TestMain must turn the run red after the write.
func TestAdmissionIsolationMutation(t *testing.T) {
	if os.Getenv("MV_TEST_REAL_DIR_MUTATION") == "1" {
		t.Setenv("MV_RAM_ADMISSION_DIR", "") // MUT-REAL-DIR-WRITE: remove isolation.
		dir, err := lockAdmissionDirectory()
		if err != nil {
			t.Fatal(err)
		}
		defer dir.Close()
		if err := syncAdmissionRecords(dir.Name(), "mutation", map[string]bool{"demo": true}); err != nil {
			t.Fatal(err)
		}
		return
	}
	runtime := t.TempDir()
	if err := os.MkdirAll(filepath.Join(runtime, "metaviewer", "ram-admission"), 0700); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-test.run=^TestAdmissionIsolationMutation$")
	cmd.Env = append(os.Environ(), "XDG_RUNTIME_DIR="+runtime, "MV_TEST_REAL_DIR_MUTATION=1")
	output, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "MUT-REAL-DIR-WRITE: host admission directory changed") {
		t.Fatalf("mutation was not rejected by TestMain: %v %s", err, output)
	}
}
