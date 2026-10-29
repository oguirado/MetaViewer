package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

type b1FramePolicy struct{ lifecyclePolicy }

func (p *b1FramePolicy) Wrap(ctx context.Context, in ipc.Envelope, body json.RawMessage) (ipc.Envelope, error) {
	out, err := p.lifecyclePolicy.Wrap(ctx, in, body)
	out.MsgID = fmt.Sprintf("frame-%d", out.Seq)
	return out, err
}

// MUT-ADAPTER-FATAL-VERDICT: rejecting a correlated STALE_FRAME in the real
// daemon-mode reader must fail the next publication on the same connection.
func TestB1StaleFrameVerdictKeepsPublishing(t *testing.T) {
	for _, event := range []bool{false, true} {
		t.Run(fmt.Sprintf("frame_ready=%v", event), func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			socket := filepath.Join(root, "core.sock")
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if err := listener.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
				t.Fatal(err)
			}
			cfg := ipc.Config{SocketPath: socket, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128, MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 5 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: 5 * time.Second}
			reg := ipc.Envelope{Schema: "envelope/v0.2", MsgID: "hello", From: ipc.Endpoint{Component: "core", Instance: "core-1"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon-1"}, SessionID: "s-1", Seq: 1, Nonce: "hello", Body: json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`)}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				generation := 0
				done <- connectStreaming(ctx, cfg, &b1FramePolicy{}, reg, func(ctx context.Context, in ipc.Envelope) ([]json.RawMessage, error) {
					var body struct{ Schema string }
					_ = json.Unmarshal(in.Body, &body)
					if body.Schema == "hello/v0.2" {
						return nil, nil
					}
					generation++
					frame := map[string]any{"schema": "frame_ref/v0.2", "surface_id": "surface-demo", "generation": generation, "tick": 7, "ts_ns": 1000000, "width": 800, "height": 600, "format": "rgb24", "ramws_path": "/dev/shm/ramws/demo.rgb", "sha256": fmt.Sprintf("%064d", 0), "capture_us": 120}
					var publication any = frame
					if event {
						publication = map[string]any{"schema": "surface_event/v0.2", "event": "frame_ready", "data": map[string]any{"frame_ref": frame}}
					}
					raw, err := json.Marshal(publication)
					if err != nil {
						return nil, err
					}
					return nil, ctx.Value(streamKey{}).(streamSession).emit(ctx, raw)
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
			read := func() ipc.Envelope {
				t.Helper()
				raw, err := framer.Read(ctx)
				if err != nil {
					t.Fatalf("publication stopped: %v", err)
				}
				var out ipc.Envelope
				if err := json.Unmarshal(raw, &out); err != nil {
					t.Fatal(err)
				}
				return out
			}
			read() // Adapter hello.
			seq := uint64(0)
			send := func(body any) {
				t.Helper()
				seq++
				env := reg
				env.Seq = seq
				env.MsgID = fmt.Sprintf("core-%d", seq)
				env.Nonce = env.MsgID
				env.Body, _ = json.Marshal(body)
				raw, _ := json.Marshal(env)
				if err := framer.Write(ctx, raw); err != nil {
					t.Fatal(err)
				}
			}
			request := map[string]any{"schema": "surface_request/v0.2", "op": "frame"}
			send(request)
			first := read()
			send(map[string]any{"schema": "action_verdict/v0.2", "proposal_id": first.MsgID, "decision": "refused", "reason_code": "STALE_FRAME", "core_seq": 1})
			send(request)
			second := read()
			var frame map[string]any
			if err := json.Unmarshal(second.Body, &frame); err != nil {
				t.Fatal(err)
			}
			if event {
				frame = frame["data"].(map[string]any)["frame_ref"].(map[string]any)
			}
			if frame["generation"] != float64(2) || second.MsgID == first.MsgID {
				t.Fatalf("no fresh frame after verdict: %s", second.Body)
			}
			select {
			case err := <-done:
				t.Fatalf("adapter exited before socket close: %v", err)
			default:
			}
			if err := conn.CloseWrite(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil && err != io.EOF {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("adapter did not drain")
			}
		})
	}
}
