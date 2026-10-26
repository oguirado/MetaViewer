package ipc

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type dummyPolicy struct{}

func (p *dummyPolicy) ValidateEnvelope([]byte) (Envelope, error) {
	return Envelope{}, io.ErrUnexpectedEOF
}
func (*dummyPolicy) Authenticate(context.Context, PeerCredentials, Envelope) error {
	return io.ErrUnexpectedEOF
}
func (*dummyPolicy) Reserve(context.Context, SenderKey, uint64, string) error {
	return io.ErrUnexpectedEOF
}
func (*dummyPolicy) Wrap(context.Context, Envelope, json.RawMessage) (Envelope, error) {
	return Envelope{}, io.ErrUnexpectedEOF
}

// Source: SW-0103 §2.2–2.3 (Carrier-Thread Exhaustion)
// Source: SW-0095 INV-EXIT, INV-FIT (Scheduler bounds)
func TestIPCServerGoroutineBounds(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s.sock")
	cfg := Config{
		SocketPath:       path,
		UID:              uint32(os.Getuid()),
		HelloTimeout:     100 * time.Millisecond,
		ReadTimeout:      100 * time.Millisecond,
		WriteTimeout:     100 * time.Millisecond,
		ProbeTimeout:     100 * time.Millisecond,
		ShutdownTimeout:  100 * time.Millisecond,
		MaxFrameBytes:    4096,
		MaxDepth:         32,
		MaxStringBytes:   65536,
		MaxKeys:          256,
		MaxArrayItems:    4096,
		MaxReplayEntries: 10,
		MaxConnections:   50,
	}

	listener, err := Listen(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- Serve(ctx, listener, cfg, &dummyPolicy{}, func(context.Context, Envelope) ([]json.RawMessage, error) {
			return nil, nil
		}, io.Discard)
	}()

	baselineRoutines := runtime.NumGoroutine()

	// Connect N clients, then close them
	N := 15
	conns := make([]net.Conn, N)
	for i := 0; i < N; i++ {
		c, err := net.Dial("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		conns[i] = c
	}

	for _, c := range conns {
		_ = c.Close()
	}

	cancel()
	_ = listener.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		if runtime.NumGoroutine() <= baselineRoutines+2 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}

	if runtime.NumGoroutine() > baselineRoutines+2 {
		t.Fatalf("goroutine leak in IPC Serve: baseline %d, current %d", baselineRoutines, runtime.NumGoroutine())
	}
}
