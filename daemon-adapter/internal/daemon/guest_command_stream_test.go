package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/ipc"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type guestStreamingPolicy struct {
	lifecyclePolicy
	reject bool
}

func (p *guestStreamingPolicy) Authenticate(ctx context.Context, c ipc.PeerCredentials, e ipc.Envelope) error {
	if p.reject && strings.Contains(string(e.Body), "guest_command_request") {
		return errors.New("unauthenticated")
	}
	return p.lifecyclePolicy.Authenticate(ctx, c, e)
}
func TestStreamingGuestCommandUsesAuthenticatedRegisteredRoute(t *testing.T) {
	for _, mode := range []string{"allowed", "auth-refused", "foreign-route", "unknown-schema"} {
		t.Run(mode, func(t *testing.T) {
			cfg := guestStreamingConfig(t)
			cfg.SocketPath = filepath.Join(t.TempDir(), "core.sock")
			listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
			if e != nil {
				t.Fatal(e)
			}
			defer listener.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			reg := ipc.Envelope{Schema: "envelope/v0.2", MsgID: "registration", From: ipc.Endpoint{Component: "core", Instance: "core-test"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon-test"}, SessionID: "session-test", Seq: 1, Nonce: "nonce-1", Body: json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`)}
			policy := &guestStreamingPolicy{reject: mode == "auth-refused"}
			var calls atomic.Int32
			done := make(chan error, 1)
			go func() {
				done <- connectStreaming(ctx, cfg, policy, reg, func(_ context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
					if strings.Contains(string(e.Body), "guest_command_request") {
						calls.Add(1)
						return []json.RawMessage{json.RawMessage(`{"schema":"guest_command_event/v0.2"}`)}, nil
					}
					return nil, nil
				})
			}()
			conn, e := listener.AcceptUnix()
			if e != nil {
				t.Fatal(e)
			}
			defer conn.Close()
			framer, e := ipc.NewFramer(conn, cfg)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = framer.Read(ctx); e != nil {
				t.Fatal(e)
			}
			hello := reg
			hello.Body = json.RawMessage(`{"schema":"hello/v0.2","component":"core"}`)
			raw, _ := json.Marshal(hello)
			if e = framer.Write(ctx, raw); e != nil {
				t.Fatal(e)
			}
			request := reg
			request.Seq = 2
			request.Nonce = "nonce-2"
			request.Body = json.RawMessage(`{"schema":"guest_command_request/v0.2","request_id":"request-1","op":"create","params":{"profile_id":"guest-command-arm64-v1"}}`)
			if mode == "foreign-route" {
				request.From.Instance = "foreign"
			}
			if mode == "unknown-schema" {
				request.Body = json.RawMessage(`{"schema":"guest_command_shell/v0.2"}`)
			}
			request.Schema = ipc.EnvelopeSchema(request.Body)
			raw, _ = json.Marshal(request)
			if e = framer.Write(ctx, raw); e != nil {
				t.Fatal(e)
			}
			if mode == "allowed" {
				if _, e = framer.Read(ctx); e != nil {
					t.Fatal(e)
				}
				if calls.Load() != 1 {
					t.Fatal("missing dispatch")
				}
				cancel()
				<-done
			} else {
				if e = <-done; e == nil {
					t.Fatal("refusal missing")
				}
				if calls.Load() != 0 {
					t.Fatal("unauthenticated dispatch")
				}
			}
		})
	}
}

func guestStreamingConfig(t *testing.T) ipc.Config {
	t.Helper()
	return ipc.Config{SocketPath: filepath.Join(t.TempDir(), "core.sock"), UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128, MaxConnections: 1, HelloTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 2 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
}
