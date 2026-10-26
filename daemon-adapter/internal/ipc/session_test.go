package ipc

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// This policy is a test double only; production must supply durable admission.
type denyPolicy struct {
	mu    sync.Mutex
	calls int
}

func (p *denyPolicy) ValidateEnvelope([]byte) (Envelope, error) {
	p.mu.Lock()
	p.calls++
	p.mu.Unlock()
	return Envelope{}, io.ErrUnexpectedEOF
}
func (*denyPolicy) Authenticate(context.Context, PeerCredentials, Envelope) error {
	return io.ErrUnexpectedEOF
}
func (*denyPolicy) Reserve(context.Context, SenderKey, uint64, string) error {
	return io.ErrUnexpectedEOF
}
func (*denyPolicy) Wrap(context.Context, Envelope, json.RawMessage) (Envelope, error) {
	return Envelope{}, io.ErrUnexpectedEOF
}
func TestServeAdmissionAndCancellation(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s.sock")
	cfg := testConfig(path)
	listener, err := Listen(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &denyPolicy{}
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, listener, cfg, p, func(context.Context, Envelope) ([]json.RawMessage, error) {
			t.Error("invalid message reached handler")
			return nil, nil
		}, io.Discard)
	}()
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	cred, err := PeerCred(client)
	if err != nil || cred.UID != cfg.UID {
		t.Fatalf("peer credential extraction: %+v %v", cred, err)
	}
	if _, err := io.WriteString(client, "{}\n"); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 1)
	if _, err := client.Read(data); err == nil {
		t.Fatal("invalid request connection retained")
	}
	client.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not join")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.calls != 1 {
		t.Fatal("admitted peer did not reach validation")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("socket left after shutdown: %v", err)
	}
}
func TestServeRequiresPolicy(t *testing.T) {
	if Serve(context.Background(), nil, testConfig("unused"), nil, nil, io.Discard) == nil {
		t.Fatal("missing policy accepted")
	}
}
