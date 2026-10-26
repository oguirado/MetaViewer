package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Test-only authority: replay state is deliberately in memory, not production policy.
type allowPolicy struct {
	mu               sync.Mutex
	seen             map[string]bool
	seq              uint64
	authErr, wrapErr bool
}

func (*allowPolicy) ValidateEnvelope(raw []byte) (Envelope, error) {
	var e Envelope
	err := json.Unmarshal(raw, &e)
	return e, err
}
func (p *allowPolicy) Authenticate(context.Context, PeerCredentials, Envelope) error {
	if p.authErr {
		return errors.New("authentication refused")
	}
	return nil
}
func (p *allowPolicy) Reserve(_ context.Context, k SenderKey, seq uint64, nonce string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.seen == nil {
		p.seen = map[string]bool{}
	}
	key := fmt.Sprintf("%q/%q/%q/%d/%q", k.SessionID, k.Component, k.Instance, seq, nonce)
	if p.seen[key] {
		return errors.New("replay")
	}
	p.seen[key] = true
	return nil
}
func (p *allowPolicy) Wrap(_ context.Context, e Envelope, b json.RawMessage) (Envelope, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.wrapErr {
		return Envelope{}, errors.New("wrap refused")
	}
	p.seq++
	e.From, e.To = e.To, e.From
	e.Seq = p.seq
	e.Nonce = fmt.Sprint("reply-", p.seq)
	e.Body = b
	return e, nil
}
func dispatchEnvelope(seq uint64, schema string) Envelope {
	return Envelope{Schema: "envelope/v0.2", SessionID: "session", Seq: seq, Nonce: fmt.Sprint("nonce-", seq), From: Endpoint{Component: "core", Instance: "core-test"}, To: Endpoint{Component: "daemon", Instance: "daemon-test"}, Body: json.RawMessage(`{"schema":"` + schema + `"}`)}
}
func startDispatch(t *testing.T, cfg Config, p Policy, h Handler) (*Framer, chan error, context.CancelFunc) {
	t.Helper()
	l, err := Listen(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, l, cfg, p, h, io.Discard) }()
	c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c.Close()
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(2 * time.Second):
			t.Error("serve failed to join")
		}
	})
	f, err := NewFramer(c, cfg)
	if err != nil {
		t.Fatal(err)
	}
	return f, done, cancel
}
func dispatchConfig(t *testing.T) Config {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	c := testConfig(filepath.Join(dir, "s.sock"))
	c.MaxFrameBytes = 8192
	c.MaxStringBytes = 4096
	c.MaxKeys = 128
	c.MaxDepth = 32
	c.HelloTimeout = time.Second
	c.ReadTimeout = time.Second
	c.WriteTimeout = time.Second
	return c
}
func sendEnvelope(t *testing.T, f *Framer, e Envelope) {
	t.Helper()
	raw, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Write(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
}
func TestServeDispatchHelloThenCommand(t *testing.T) {
	var calls atomic.Int32
	f, _, _ := startDispatch(t, dispatchConfig(t), &allowPolicy{}, func(_ context.Context, e Envelope) ([]json.RawMessage, error) {
		if string(e.Body) == `{"schema":"hello/v0.2"}` {
			return nil, nil
		}
		calls.Add(1)
		return []json.RawMessage{json.RawMessage(`{"ok":true}`)}, nil
	})
	sendEnvelope(t, f, dispatchEnvelope(1, "hello/v0.2"))
	sendEnvelope(t, f, dispatchEnvelope(2, "surface_request/v0.2"))
	raw, err := f.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var e Envelope
	if err = json.Unmarshal(raw, &e); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || e.Seq != 1 || e.From.Component != "daemon" || e.To.Component != "core" || string(e.Body) != `{"ok":true}` {
		t.Fatalf("dispatch/reply mismatch: %s, calls=%d", raw, calls.Load())
	}
}
func TestServeDispatchRefusals(t *testing.T) {
	for _, name := range []string{"schema", "seq-zero", "nonce-empty", "from", "to", "hello-first", "authenticate", "duplicate", "wrap", "body-invalid", "handler", "reply-write"} {
		t.Run(name, func(t *testing.T) {
			p := &allowPolicy{authErr: name == "authenticate", wrapErr: name == "wrap"}
			e := dispatchEnvelope(1, "hello/v0.2")
			switch name {
			case "schema":
				e.Schema = "envelope/v0.1"
			case "seq-zero":
				e.Seq = 0
			case "nonce-empty":
				e.Nonce = ""
			case "from":
				e.From.Component = "agents"
			case "to":
				e.To.Component = "core"
			case "hello-first":
				e.Body = json.RawMessage(`{"schema":"surface_request/v0.2"}`)
			case "body-invalid":
				e.Body = json.RawMessage(`[]`)
			case "duplicate":
				if err := p.Reserve(context.Background(), SenderKey{e.SessionID, e.From.Component, e.From.Instance}, e.Seq, e.Nonce); err != nil {
					t.Fatal(err)
				}
			}
			var calls atomic.Int32
			f, _, _ := startDispatch(t, dispatchConfig(t), p, func(context.Context, Envelope) ([]json.RawMessage, error) {
				calls.Add(1)
				if name == "handler" {
					return nil, errors.New("handler refused")
				}
				if name == "reply-write" {
					return []json.RawMessage{json.RawMessage(`{"oversize":"` + strings.Repeat("x", 9000) + `"}`)}, nil
				}
				return []json.RawMessage{json.RawMessage(`{"ok":true}`)}, nil
			})
			sendEnvelope(t, f, e)
			_, err := f.Read(context.Background())
			if err == nil {
				t.Fatal("refusal returned a reply")
			}
			var timeout net.Error
			if errors.As(err, &timeout) && timeout.Timeout() {
				t.Fatalf("connection not closed: %v", err)
			}
			want := int32(0)
			if name == "wrap" || name == "handler" || name == "reply-write" {
				want = 1
			}
			if calls.Load() != want {
				t.Fatalf("handler calls=%d want=%d", calls.Load(), want)
			}
		})
	}
}

func TestServeHelloDeadline(t *testing.T) {
	cfg := dispatchConfig(t)
	cfg.HelloTimeout = 5 * time.Second
	cfg.ReadTimeout = 30 * time.Second
	var calls atomic.Int32
	f, _, _ := startDispatch(t, cfg, &allowPolicy{}, func(context.Context, Envelope) ([]json.RawMessage, error) { calls.Add(1); return nil, nil })
	// Real contract boundary: a hello sent after 5.1 seconds cannot dispatch.
	late := time.NewTimer(5100 * time.Millisecond)
	defer late.Stop()
	<-late.C
	raw, err := json.Marshal(dispatchEnvelope(1, "hello/v0.2"))
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Write(context.Background(), raw) // A closed Unix peer may reject the write itself.
	wait, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err = f.Read(wait); err == nil {
		t.Fatal("late hello retained connection")
	} else {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			t.Fatalf("late hello connection not closed: %v", err)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("late hello reached handler")
	}
}

func TestServeIdleDeadlineAfterHello(t *testing.T) {
	cfg := dispatchConfig(t)
	cfg.HelloTimeout = 100 * time.Millisecond
	cfg.ReadTimeout = 500 * time.Millisecond
	f, _, _ := startDispatch(t, cfg, &allowPolicy{}, func(context.Context, Envelope) ([]json.RawMessage, error) {
		return []json.RawMessage{json.RawMessage(`{"ok":true}`)}, nil
	})
	// Keep the client observation deadline longer than the server idle deadline.
	f.cfg.ReadTimeout = time.Second
	sendEnvelope(t, f, dispatchEnvelope(1, "hello/v0.2"))
	if _, err := f.Read(context.Background()); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(200 * time.Millisecond)
	defer timer.Stop()
	<-timer.C
	sendEnvelope(t, f, dispatchEnvelope(2, "surface_request/v0.2"))
	if _, err := f.Read(context.Background()); err != nil {
		t.Fatalf("hello deadline leaked into authenticated idle: %v", err)
	}
	wait, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := f.Read(wait); err == nil {
		t.Fatal("idle peer retained")
	} else {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			t.Fatalf("idle deadline did not close peer: %v", err)
		}
	}
}

func TestConfigRequiresSeparateBoundedDeadlines(t *testing.T) {
	for _, tc := range []struct {
		name        string
		hello, idle time.Duration
	}{
		{"missing-hello", 0, 30 * time.Second}, {"hello-over-cap", 5*time.Second + time.Nanosecond, 30 * time.Second}, {"missing-idle", 5 * time.Second, 0}, {"idle-over-cap", 5 * time.Second, 30*time.Second + time.Nanosecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testConfig("unused")
			cfg.HelloTimeout = tc.hello
			cfg.ReadTimeout = tc.idle
			if cfg.Validate() == nil {
				t.Fatal("invalid deadline policy accepted")
			}
		})
	}
	cfg := testConfig("unused")
	cfg.HelloTimeout = 5 * time.Second
	cfg.ReadTimeout = 30 * time.Second
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}
