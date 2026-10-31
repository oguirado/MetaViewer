package ipc

import (
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestTaggedListAcknowledgesEmptyDaemonOnly(t *testing.T) {
	cfg := dispatchConfig(t)
	cfg.SocketPath = filepath.Join(t.TempDir(), "keepalive.sock")
	cfg.ReadTimeout = time.Second
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	reg := Envelope{Schema: "envelope/v0.2", MsgID: "reg", From: Endpoint{Component: "core", Instance: "core-1"}, To: Endpoint{Component: "daemon", Instance: "daemon-1"}, SessionID: "s-1", Seq: 1, Nonce: "n-1", Body: json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Connect(ctx, cfg, &allowPolicy{}, reg, func(context.Context, Envelope) ([]json.RawMessage, error) { return nil, nil })
	}()
	conn, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	framer, err := NewFramer(conn, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = framer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	// An ordinary list has no synthetic reply; the tagged probe's ack must be first.
	for i, id := range []string{"ordinary-list", "core-keepalive-2"} {
		env := reg
		env.Seq = uint64(i + 1)
		env.Nonce = id
		env.MsgID = id
		env.Body = json.RawMessage(`{"schema":"surface_request/v0.2","op":"list","params":{}}`)
		raw, _ := json.Marshal(env)
		if err = framer.Write(ctx, raw); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := framer.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var reply Envelope
	if err = json.Unmarshal(raw, &reply); err != nil {
		t.Fatal(err)
	}
	var body struct{ Data struct{ Code, Detail string } }
	if err = json.Unmarshal(reply.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Code != "DAEMON_KEEPALIVE" || body.Data.Detail != "core-keepalive" {
		t.Fatalf("unexpected reply: %s", raw)
	}
	conn.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("client did not close")
	}
}
