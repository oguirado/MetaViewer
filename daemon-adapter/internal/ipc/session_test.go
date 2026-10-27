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

func TestServeHandlerShutdownTimeoutAndCancellation(t *testing.T) {
	t.Run("ctx_aware_slow_handler_completes_before_deadline", func(t *testing.T) {
		cfg := dispatchConfig(t)
		cfg.ShutdownTimeout = 500 * time.Millisecond
		l, err := Listen(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		p := &allowPolicy{}
		entered := make(chan struct{})
		finished := make(chan struct{})
		done := make(chan error, 1)
		go func() {
			done <- Serve(ctx, l, cfg, p, func(hCtx context.Context, e Envelope) ([]json.RawMessage, error) {
				close(entered)
				<-hCtx.Done()
				time.Sleep(20 * time.Millisecond)
				close(finished)
				return nil, hCtx.Err()
			}, io.Discard)
		}()
		c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		f, err := NewFramer(c, cfg)
		if err != nil {
			t.Fatal(err)
		}
		sendEnvelope(t, f, dispatchEnvelope(1, "hello/v0.2"))
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("handler did not start")
		}
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("ctx-aware slow handler failed shutdown: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("Serve did not join ctx-aware handler")
		}
		select {
		case <-finished:
		default:
			t.Fatal("Serve returned before ctx-aware handler finished")
		}
	})

	t.Run("negative_control_ctx_ignoring_handler_times_out_and_skips_post_shutdown_wrap", func(t *testing.T) {
		cfg := dispatchConfig(t)
		cfg.ShutdownTimeout = 30 * time.Millisecond
		l, err := Listen(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		p := &allowPolicy{}
		entered := make(chan struct{})
		release := make(chan struct{})
		exited := make(chan struct{})
		done := make(chan error, 1)
		go func() {
			done <- Serve(ctx, l, cfg, p, func(_ context.Context, _ Envelope) ([]json.RawMessage, error) {
				defer close(exited)
				close(entered)
				<-release
				return []json.RawMessage{json.RawMessage(`{"ok":true}`)}, nil
			}, io.Discard)
		}()
		c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
		if err != nil {
			close(release)
			t.Fatal(err)
		}
		defer c.Close()
		f, err := NewFramer(c, cfg)
		if err != nil {
			close(release)
			t.Fatal(err)
		}
		sendEnvelope(t, f, dispatchEnvelope(1, "hello/v0.2"))
		select {
		case <-entered:
		case <-time.After(time.Second):
			close(release)
			t.Fatal("handler did not start")
		}
		cancel()
		select {
		case err := <-done:
			if err == nil || err.Error() != "handler shutdown deadline exceeded" {
				close(release)
				t.Fatalf("expected handler shutdown deadline exceeded, got %v", err)
			}
		case <-time.After(time.Second):
			close(release)
			t.Fatal("Serve hung on ctx-ignoring handler")
		}
		close(release)
		select {
		case <-exited:
		case <-time.After(time.Second):
			t.Fatal("abandoned handler did not exit after release")
		}
		// Give the connection goroutine a brief moment to run post-handler statements.
		time.Sleep(10 * time.Millisecond)
		p.mu.Lock()
		wrappedAfterShutdown := p.seq
		p.mu.Unlock()
		if wrappedAfterShutdown != 0 {
			t.Fatalf("abandoned handler mutated authority Wrap after shutdown: seq=%d", wrappedAfterShutdown)
		}
	})
}
