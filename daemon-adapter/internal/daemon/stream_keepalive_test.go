package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

// The production adapter runs connectStreaming, not ipc.Connect. A core liveness
// probe on that path must be acknowledged by the adapter itself, even while the
// data lane is occupied, and must never reach the handler.
func TestStreamingAnswersCoreKeepaliveWithoutHandler(t *testing.T) {
	sockDir := t.TempDir()
	if err := os.Chmod(sockDir, 0700); err != nil {
		t.Fatal(err)
	}
	sockPath := filepath.Join(sockDir, "core.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg := ipc.Config{SocketPath: sockPath, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128, MaxConnections: 1, HelloTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 2 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	reg := ipc.Envelope{Schema: "envelope/v0.2", MsgID: "reg", From: ipc.Endpoint{Component: "core", Instance: "core-1"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon-1"}, SessionID: "s-1", Seq: 1, Nonce: "n-1", Body: json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`)}

	var mu sync.Mutex
	handled := map[string]int{}
	blocked := make(chan struct{})
	release := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- connectStreaming(ctx, cfg, &lifecyclePolicy{}, reg, func(c context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
			var h struct{ Schema, Op string }
			_ = json.Unmarshal(e.Body, &h)
			if h.Schema == "hello/v0.2" {
				return nil, nil
			}
			mu.Lock()
			handled[e.MsgID]++
			mu.Unlock()
			if e.MsgID == "busy-1" {
				close(blocked)
				select {
				case <-release:
				case <-c.Done():
				}
			}
			return []json.RawMessage{json.RawMessage(`{"schema":"surface_event/v0.2","event":"surface_list","data":{"handled":"` + e.MsgID + `"}}`)}, nil
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
	if _, err = framer.Read(ctx); err != nil { // daemon hello
		t.Fatal(err)
	}
	var seq uint64
	send := func(msgID, body string) {
		t.Helper()
		seq++
		raw, _ := json.Marshal(ipc.Envelope{Schema: "envelope/v0.2", MsgID: msgID, From: reg.From, To: reg.To, SessionID: reg.SessionID, Seq: seq, Nonce: fmt.Sprintf("n-%d", seq), Body: json.RawMessage(body)})
		if err := framer.Write(ctx, raw); err != nil {
			t.Fatal(err)
		}
	}
	read := func(timeout time.Duration) ipc.Envelope {
		t.Helper()
		rctx, rcancel := context.WithTimeout(ctx, timeout)
		defer rcancel()
		raw, err := framer.Read(rctx)
		if err != nil {
			t.Fatalf("no reply within %v: %v", timeout, err)
		}
		var env ipc.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		return env
	}
	handledBy := func(env ipc.Envelope, id string) bool {
		var body struct{ Data struct{ Handled string } }
		return json.Unmarshal(env.Body, &body) == nil && body.Data.Handled == id
	}
	const list = `{"schema":"surface_request/v0.2","op":"list","params":{}}`

	// Occupy the data lane with an untagged request, then probe behind it.
	send("busy-1", list)
	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("handler never saw the untagged list")
	}
	send("core-keepalive-1-8", list)
	ack := read(2 * time.Second)
	var event struct {
		Event string
		Data  struct {
			SurfaceID string `json:"surface_id"`
			Code      string `json:"code"`
			Detail    string `json:"detail"`
		}
	}
	if err := json.Unmarshal(ack.Body, &event); err != nil {
		t.Fatal(err)
	}
	if event.Event != "error" || event.Data.SurfaceID != "daemon" || event.Data.Code != "DAEMON_KEEPALIVE" || event.Data.Detail != "core-keepalive" {
		t.Fatalf("probe not acknowledged while data lane busy: %s", ack.Body)
	}

	// Release the busy request: untagged lists still reach the handler.
	close(release)
	if reply := read(2 * time.Second); !handledBy(reply, "busy-1") {
		t.Fatalf("untagged list reply missing: %s", reply.Body)
	}
	send("plain-2", list)
	if reply := read(2 * time.Second); !handledBy(reply, "plain-2") {
		t.Fatalf("untagged list did not reach the handler: %s", reply.Body)
	}
	mu.Lock()
	defer mu.Unlock()
	if handled["core-keepalive-1-8"] != 0 || handled["busy-1"] != 1 || handled["plain-2"] != 1 {
		t.Fatalf("handler calls: %v", handled)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("connectStreaming did not join")
	}
}
