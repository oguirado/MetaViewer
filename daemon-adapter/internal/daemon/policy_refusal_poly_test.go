package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

func TestPolicyRefusalTripleAndNegativeControls(t *testing.T) {
	t.Run("exact-policy-refusal-consumed-stream-continues", func(t *testing.T) {
		sockDir := t.TempDir()
		if err := os.Chmod(sockDir, 0700); err != nil {
			t.Fatal(err)
		}
		sockPath := filepath.Join(sockDir, "policy.sock")
		listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()

		cfg := ipc.Config{
			SocketPath: sockPath, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32,
			MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128,
			MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
			WriteTimeout: 5 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: 5 * time.Second,
		}
		reg := ipc.Envelope{
			Schema:    "envelope/v0.2",
			MsgID:     "reg",
			From:      ipc.Endpoint{Component: "core", Instance: "core-1"},
			To:        ipc.Endpoint{Component: "daemon", Instance: "daemon-1"},
			SessionID: "s-1",
			Seq:       1,
			Nonce:     "n-1",
			Body:      json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`),
		}

		var mu sync.Mutex
		var dispatched []string

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			done <- connectStreaming(ctx, cfg, &rv8StreamPolicy{}, reg, func(_ context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
				var body struct {
					Schema, Op string
				}
				_ = json.Unmarshal(e.Body, &body)
				if body.Schema == "hello/v0.2" {
					return nil, nil
				}
				mu.Lock()
				dispatched = append(dispatched, e.MsgID)
				mu.Unlock()
				reply, _ := json.Marshal(map[string]string{"id": e.MsgID, "op": body.Op})
				return []json.RawMessage{reply}, nil
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
		if _, err := framer.Read(ctx); err != nil {
			t.Fatal(err)
		}

		sendEnv := func(env ipc.Envelope) {
			t.Helper()
			raw, _ := json.Marshal(env)
			if err := framer.Write(ctx, raw); err != nil {
				t.Fatal(err)
			}
		}

		sendEnv(ipc.Envelope{
			Schema: "envelope/v0.2", MsgID: "refusal-policy", From: reg.From, To: reg.To, SessionID: reg.SessionID,
			Seq: 1, Nonce: "n-1",
			Body: json.RawMessage(`{"schema":"action_verdict/v0.2","proposal_id":"prop-1","decision":"refused","reason_code":"POLICY","core_seq":1}`),
		})
		sendEnv(ipc.Envelope{
			Schema: "envelope/v0.2", MsgID: "req-after-refusal", From: reg.From, To: reg.To, SessionID: reg.SessionID,
			Seq: 2, Nonce: "n-2",
			Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"input"}`),
		})
		if err := conn.CloseWrite(); err != nil {
			t.Fatal(err)
		}

		raw, err := framer.Read(ctx)
		if err != nil {
			t.Fatalf("expected reply for req-after-refusal, got %v", err)
		}
		var out ipc.Envelope
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		var msg struct{ ID string }
		if err := json.Unmarshal(out.Body, &msg); err != nil || msg.ID != "req-after-refusal" {
			t.Fatalf("got reply %s, want req-after-refusal", out.Body)
		}

		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Fatal("connectStreaming did not exit after clean EOF")
		}

		mu.Lock()
		gotDispatched := append([]string(nil), dispatched...)
		mu.Unlock()
		if len(gotDispatched) != 1 || gotDispatched[0] != "req-after-refusal" {
			t.Fatalf("expected only req-after-refusal dispatched, got %v", gotDispatched)
		}
	})

	cases := []struct {
		name    string
		msgID   string
		body    string
		wantErr string
	}{
		{
			name:    "wrong-reason-refused",
			msgID:   "verdict-stale",
			body:    `{"schema":"action_verdict/v0.2","proposal_id":"prop-1","decision":"refused","reason_code":"STALE_FRAME","core_seq":1}`,
			wantErr: "core surface request required",
		},
		{
			name:    "wrong-decision-refused",
			msgID:   "verdict-admitted",
			body:    `{"schema":"action_verdict/v0.2","proposal_id":"prop-1","decision":"admitted","reason_code":"POLICY","core_seq":1}`,
			wantErr: "core surface request required",
		},
		{
			name:    "wrong-schema-refused",
			msgID:   "verdict-wrong-schema",
			body:    `{"schema":"action_proposal/v0.2","proposal_id":"prop-1","decision":"refused","reason_code":"POLICY","core_seq":1}`,
			wantErr: "core surface request required",
		},
		{
			name:    "policy-refusal-bad-auth-refused",
			msgID:   "bad-auth",
			body:    `{"schema":"action_verdict/v0.2","proposal_id":"prop-1","decision":"refused","reason_code":"POLICY","core_seq":1}`,
			wantErr: "authentication refused",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sockDir := t.TempDir()
			if err := os.Chmod(sockDir, 0700); err != nil {
				t.Fatal(err)
			}
			sockPath := filepath.Join(sockDir, "neg.sock")
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()

			cfg := ipc.Config{
				SocketPath: sockPath, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32,
				MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128,
				MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second,
				WriteTimeout: 5 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: 5 * time.Second,
			}
			reg := ipc.Envelope{
				Schema:    "envelope/v0.2",
				MsgID:     "reg",
				From:      ipc.Endpoint{Component: "core", Instance: "core-1"},
				To:        ipc.Endpoint{Component: "daemon", Instance: "daemon-1"},
				SessionID: "s-1",
				Seq:       1,
				Nonce:     "n-1",
				Body:      json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`),
			}

			var dispatched bool
			var mu sync.Mutex

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- connectStreaming(ctx, cfg, &rv8StreamPolicy{}, reg, func(_ context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
					var body struct {
						Schema string
					}
					_ = json.Unmarshal(e.Body, &body)
					if body.Schema == "hello/v0.2" {
						return nil, nil
					}
					mu.Lock()
					dispatched = true
					mu.Unlock()
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
			if _, err := framer.Read(ctx); err != nil {
				t.Fatal(err)
			}

			raw, _ := json.Marshal(ipc.Envelope{
				Schema: "envelope/v0.2", MsgID: tc.msgID, From: reg.From, To: reg.To, SessionID: reg.SessionID,
				Seq: 1, Nonce: "n-1", Body: json.RawMessage(tc.body),
			})
			if err := framer.Write(ctx, raw); err != nil {
				t.Fatal(err)
			}
			_ = conn.CloseWrite()

			var gotErr error
			select {
			case gotErr = <-done:
			case <-time.After(30 * time.Second):
				t.Fatalf("connectStreaming did not abort on %s", tc.name)
			}
			if gotErr == nil || !strings.Contains(fmt.Sprint(gotErr), tc.wantErr) {
				t.Fatalf("got error %v, want substring %q", gotErr, tc.wantErr)
			}
			mu.Lock()
			wasDispatched := dispatched
			mu.Unlock()
			if wasDispatched {
				t.Fatalf("unexpected handler dispatch on %s", tc.name)
			}
		})
	}
}
