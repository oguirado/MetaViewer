package daemon

import (
	"context"
	"encoding/json"
	"io"
	"metaviewer/daemon-adapter/internal/ipc"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunSuppliedPolicy(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	cfg := ipc.Config{SocketPath: filepath.Join(dir, "s.sock"), UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 32, MaxConnections: 1, HelloTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: time.Second, ProbeTimeout: time.Millisecond, ShutdownTimeout: time.Second}
	runtime := Runtime{Config: cfg, Policy: &lifecyclePolicy{}, Handler: func(context.Context, ipc.Envelope) ([]json.RawMessage, error) { return nil, nil }}
	bad := runtime
	bad.Policy = nil
	if Run(context.Background(), nil, io.Discard, bad) == 0 {
		t.Fatal("missing authority accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- Run(ctx, nil, io.Discard, runtime) }()
	deadline := time.Now().Add(time.Second)
	connected := false
	for time.Now().Before(deadline) {
		conn, err := net.Dial("unix", cfg.SocketPath)
		if err == nil {
			conn.Close()
			connected = true
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case rc := <-done:
		if rc != 0 || !connected {
			t.Fatalf("startup rc=%d connected=%v", rc, connected)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not join")
	}
}
