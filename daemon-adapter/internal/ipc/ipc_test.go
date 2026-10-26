package ipc

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testConfig(path string) Config {
	return Config{SocketPath: path, UID: uint32(os.Getuid()), MaxFrameBytes: 64, MaxDepth: 8, MaxStringBytes: 64, MaxKeys: 8, MaxArrayItems: 8, MaxReplayEntries: 8, MaxConnections: 2, ReadTimeout: 50 * time.Millisecond, WriteTimeout: 50 * time.Millisecond, ProbeTimeout: 50 * time.Millisecond, ShutdownTimeout: time.Second}
}
func TestRuntimeSocketPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	uid := uint32(os.Getuid())
	if _, err := RuntimeSocketPath(dir, uid); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"", "relative"} {
		if _, err := RuntimeSocketPath(p, uid); err == nil {
			t.Fatal("unsafe runtime accepted")
		}
	}
	if _, err := RuntimeSocketPath(dir, uid+1); err == nil {
		t.Fatal("foreign runtime accepted")
	}
	if err := os.Chmod(dir, 0777); err != nil {
		t.Fatal(err)
	}
	if _, err := RuntimeSocketPath(dir, uid); err == nil {
		t.Fatal("public runtime accepted")
	}
}
func TestSocketReplacement(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s.sock")
	cfg := testConfig(path)
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(context.Background(), cfg); err == nil {
		t.Fatal("regular file accepted")
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "keep" {
		t.Fatal("regular file removed")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	l, err := Listen(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode().Perm() != 0600 {
		t.Fatalf("bad mode: %v", err)
	}
	if _, err := Listen(context.Background(), cfg); err == nil {
		t.Fatal("live socket replaced")
	}
	l.SetUnlinkOnClose(false)
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := Listen(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer CloseListener(next)
}
func TestPeerAdmission(t *testing.T) {
	uid := uint32(os.Getuid())
	if !PeerAdmitted(PeerCredentials{UID: uid}, uid) || PeerAdmitted(PeerCredentials{UID: uid + 1}, uid) || PeerAdmitted(PeerCredentials{UID: 0}, 1) {
		t.Fatal("uid equality bypassed")
	}
}
func TestFrameBoundary(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	cfg := testConfig("unused")
	cfg.MaxFrameBytes = 3
	f, err := NewFramer(a, cfg)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, e := io.WriteString(b, "{}\n{}\n"); done <- e }()
	for range 2 {
		if _, err := f.Read(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	go func() { _, e := io.WriteString(b, " {}\n"); done <- e }()
	if _, err := f.Read(context.Background()); err == nil {
		t.Fatal("oversize accepted")
	}
	b.Close()
	<-done
}
func TestReadWriteDeadline(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	f, err := NewFramer(a, testConfig("unused"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(context.Background()); err == nil {
		t.Fatal("read stall accepted")
	}
	if err := f.Write(context.Background(), []byte("{}")); err == nil {
		t.Fatal("write stall accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.Read(ctx); err == nil {
		t.Fatal("cancel ignored")
	}
	if err := f.Write(context.Background(), []byte("{}\n")); err == nil {
		t.Fatal("raw LF accepted")
	}
}
func TestJSONBounds(t *testing.T) {
	cfg := testConfig("unused")
	if err := ValidateJSON([]byte(`{"a":[1]}`), cfg); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{`{"a":1,"a":2}`, `{} {}`, `{"a":[[[[[[[[[]]]]]]]]]}`, string([]byte{'"', 255, '"'})} {
		if ValidateJSON([]byte(s), cfg) == nil {
			t.Errorf("accepted %q", s)
		}
	}
}

func TestSafeCleanupPreservesReplacement(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s.sock")
	listener, err := Listen(context.Background(), testConfig(path))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if CloseListener(listener) == nil {
		t.Fatal("replacement not reported")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "replacement" {
		t.Fatal("replacement removed")
	}
}
func TestJSONLimitTwins(t *testing.T) {
	cfg := testConfig("unused")
	cfg.MaxStringBytes = 2
	cfg.MaxArrayItems = 2
	cfg.MaxKeys = 2
	cfg.MaxDepth = 2
	for _, s := range []string{`{"ab":[1,2]}`, `"ab"`, `[[],[]]`} {
		if err := ValidateJSON([]byte(s), cfg); err != nil {
			t.Fatalf("positive %s: %v", s, err)
		}
	}
	for _, s := range []string{`{"abc":1}`, `"abc"`, `[1,2,3]`, `{"a":1,"b":2,"c":3}`, `[[[]]]`} {
		if ValidateJSON([]byte(s), cfg) == nil {
			t.Errorf("limit ignored: %s", s)
		}
	}
}
func TestWriteFramePositive(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	f, err := NewFramer(a, testConfig("unused"))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- f.Write(context.Background(), []byte("{}")) }()
	line := make([]byte, 3)
	if _, err := io.ReadFull(b, line); err != nil {
		t.Fatal(err)
	}
	if string(line) != "{}\n" {
		t.Fatal("bad framing")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestSocketCleanup(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s.sock")
	l, err := Listen(context.Background(), testConfig(path))
	if err != nil {
		t.Fatal(err)
	}
	if err := CloseListener(l); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("socket not removed: %v", err)
	}
}
func TestConfigRefusesMissingLimits(t *testing.T) {
	if (Config{}).Validate() == nil {
		t.Fatal("implicit policy accepted")
	}
	if err := testConfig("unused").Validate(); err != nil {
		t.Fatal(err)
	}
}
