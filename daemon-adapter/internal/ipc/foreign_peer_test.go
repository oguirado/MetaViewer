package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// Mutation: bypass !PeerAdmitted in Serve; the foreign case dispatches hello.
// Configure the admitted UID relative to the real SO_PEERCRED UID. This exercises
// live credential refusal without privilege-dependent unshare/UID remapping.
func TestForeignUidLiveSocketRefused(t *testing.T) {
	for _, foreign := range []bool{false, true} {
		name := "matching"
		if foreign {
			name = "foreign"
		}
		t.Run(name, func(t *testing.T) {
			cfg := dispatchConfig(t)
			if foreign {
				cfg.UID ^= 1
			}
			// Listen's filesystem owner admission is separate. Build the trusted
			// listener here so Serve can see a real peer differing from cfg.UID.
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			var calls atomic.Int32
			done := make(chan error, 1)
			go func() {
				done <- Serve(ctx, listener, cfg, &allowPolicy{}, func(context.Context, Envelope) ([]json.RawMessage, error) {
					calls.Add(1)
					return []json.RawMessage{json.RawMessage(`{"accepted":true}`)}, nil
				}, io.Discard)
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case err := <-done:
					if err != nil {
						t.Error(err)
					}
				case <-time.After(2 * time.Second):
					t.Error("Serve did not join")
				}
			})
			conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			cred, err := PeerCred(conn)
			if err != nil || cred.UID != uint32(os.Getuid()) {
				t.Fatalf("real kernel credential: %+v %v", cred, err)
			}
			if (cred.UID != cfg.UID) != foreign {
				t.Fatal("foreign control did not differ")
			}
			f, err := NewFramer(conn, cfg)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(dispatchEnvelope(1, "hello/v0.2"))
			if err != nil {
				t.Fatal(err)
			}
			writeErr := f.Write(ctx, raw)
			_, readErr := f.Read(ctx)
			if foreign {
				if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, syscall.ECONNRESET) {
					t.Fatalf("foreign socket not closed: write=%v read=%v", writeErr, readErr)
				}
				if calls.Load() != 0 {
					t.Fatal("foreign peer reached handler")
				}
			} else if writeErr != nil || readErr != nil || calls.Load() != 1 {
				t.Fatalf("same UID refused: write=%v read=%v calls=%d", writeErr, readErr, calls.Load())
			}
		})
	}
}
