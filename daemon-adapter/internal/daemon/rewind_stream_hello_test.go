package daemon

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

func TestStreamingRewindRequiresAuthenticatedHelloWithoutCommitPin(t *testing.T) {
	t.Setenv("MV_EXPECTED_CORE_COMMIT", "")
	body, err := os.ReadFile("../../../contracts/examples/v0.2/rewind_request.valid.pause.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, helloFirst := range []bool{false, true} {
		name := "rewind-first-refused"
		if helloFirst {
			name = "hello-then-rewind-accepted"
		}
		t.Run(name, func(t *testing.T) {
			cfg := guestStreamingConfig(t)
			cfg.SocketPath = filepath.Join(t.TempDir(), "core.sock")
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if err = listener.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			reg := ipc.Envelope{Schema: "envelope/v0.2", MsgID: "registration", From: ipc.Endpoint{Component: "core", Instance: "core-test"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon-test"}, SessionID: "session-test", Seq: 1, Nonce: "registration-nonce", Body: json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`)}
			var calls atomic.Int32
			dispatched := make(chan struct{}, 1)
			done := make(chan error, 1)
			go func() {
				done <- connectStreaming(ctx, cfg, &lifecyclePolicy{}, reg, func(_ context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
					if strings.Contains(string(e.Body), "rewind_request/v0.2") {
						calls.Add(1)
						dispatched <- struct{}{}
					}
					return nil, nil
				})
			}()
			conn, err := listener.AcceptUnix()
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			framer, err := ipc.NewFramer(conn, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = framer.Read(ctx); err != nil {
				t.Fatal(err)
			}
			seq := uint64(0)
			send := func(payload json.RawMessage) {
				seq++
				e := reg
				e.Body = payload
				e.Schema = ipc.EnvelopeSchema(payload)
				e.Seq = seq
				e.Nonce = name + string(rune('a'+seq))
				raw, err := json.Marshal(e)
				if err != nil {
					t.Fatal(err)
				}
				if err = framer.Write(ctx, raw); err != nil {
					t.Fatal(err)
				}
			}
			if helloFirst {
				send(json.RawMessage(`{"schema":"hello/v0.2","component":"core"}`))
			}
			if ipc.EnvelopeSchema(body) != "rewind_envelope/v0.2" {
				t.Fatal("canonical fixture is not rewind family")
			}
			send(body)
			if helloFirst {
				select {
				case <-dispatched:
				case err := <-done:
					t.Fatalf("valid hello route ended: %v", err)
				case <-ctx.Done():
					t.Fatal("valid hello route did not dispatch")
				}
				if calls.Load() != 1 {
					t.Fatal("wrong dispatch count")
				}
				cancel()
				<-done
			} else {
				select {
				case <-dispatched:
					t.Fatal("rewind reached handler without authenticated hello")
				case err := <-done:
					if err == nil || !strings.Contains(err.Error(), "authenticated core hello required") {
						t.Fatalf("wrong refusal: %v", err)
					}
				case <-ctx.Done():
					t.Fatal("missing pre-hello refusal")
				}
				if calls.Load() != 0 {
					t.Fatal("pre-hello dispatch")
				}
			}
		})
	}
}
