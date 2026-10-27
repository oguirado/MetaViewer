package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// Mutation: change len(clients) >= cfg.MaxConnections to >; cap-one fails.
func TestSecondClientBeyondCapRefused(t *testing.T) {
	for _, capacity := range []int{1, 2} {
		name := "one"
		if capacity == 2 {
			name = "two"
		}
		t.Run(name, func(t *testing.T) {
			cfg := dispatchConfig(t)
			cfg.MaxConnections = capacity
			var calls atomic.Int32
			first, _, _ := startDispatch(t, cfg, &allowPolicy{}, func(_ context.Context, e Envelope) ([]json.RawMessage, error) {
				calls.Add(1)
				return []json.RawMessage{json.RawMessage(`{"accepted":true}`)}, nil
			})
			sendEnvelope(t, first, dispatchEnvelope(1, "hello/v0.2"))
			if _, err := first.Read(context.Background()); err != nil {
				t.Fatalf("first hello: %v", err)
			}
			second, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer second.Close()
			if err := second.SetDeadline(time.Now().Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			f, err := NewFramer(second, cfg)
			if err != nil {
				t.Fatal(err)
			}
			e := dispatchEnvelope(1, "hello/v0.2")
			e.From.Instance = "second"
			raw, err := json.Marshal(e)
			if err != nil {
				t.Fatal(err)
			}
			writeErr := f.Write(context.Background(), raw)
			_, readErr := f.Read(context.Background())
			if capacity == 1 {
				// No authenticated envelope exists yet: refusal is a transport
				// close, not an invented unsolicited typed application reply.
				if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, syscall.ECONNRESET) {
					t.Fatalf("cap refusal must close, write=%v read=%v", writeErr, readErr)
				}
				if calls.Load() != 1 {
					t.Fatalf("refused client invoked handler: %d", calls.Load())
				}
			} else {
				if writeErr != nil || readErr != nil || calls.Load() != 2 {
					t.Fatalf("spare capacity refused: write=%v read=%v calls=%d", writeErr, readErr, calls.Load())
				}
			}
			sendEnvelope(t, first, dispatchEnvelope(2, "surface_request/v0.2"))
			if _, err := first.Read(context.Background()); err != nil {
				t.Fatalf("first session damaged: %v", err)
			}
			want := int32(capacity + 1)
			if calls.Load() != want {
				t.Fatalf("handler count=%d want=%d", calls.Load(), want)
			}
		})
	}
}
