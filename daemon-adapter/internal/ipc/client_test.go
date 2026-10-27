package ipc

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// T2-R2-02: Connect must dispatch take_control concurrently with a blocked input handler,
// while preserving request order for pipelined data-plane operations.
func TestT2R202ClientTakeoverConcurrentAndDataPlaneOrdered(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	cfg := dispatchConfig(t)
	cfg.SocketPath = filepath.Join(dir, "client.sock")
	cfg.ReadTimeout = 5 * time.Second
	cfg.WriteTimeout = 2 * time.Second

	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	reg := Envelope{
		Schema:    "envelope/v0.2",
		MsgID:     "reg",
		From:      Endpoint{Component: "core", Instance: "core-1"},
		To:        Endpoint{Component: "daemon", Instance: "daemon-1"},
		SessionID: "s-1",
		Seq:       1,
		Nonce:     "n-1",
		Body:      json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`),
	}

	inputEntered := make(chan struct{})
	takeoverSeen := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Connect(ctx, cfg, &allowPolicy{}, reg, func(c context.Context, e Envelope) ([]json.RawMessage, error) {
			var body struct {
				Schema, Op string
			}
			_ = json.Unmarshal(e.Body, &body)
			if body.Schema == "hello/v0.2" {
				return nil, nil
			}
			switch body.Op {
			case "create":
				time.Sleep(40 * time.Millisecond)
			case "input":
				if e.MsgID == "blocked-input" {
					close(inputEntered)
					select {
					case <-takeoverSeen:
					case <-c.Done():
						return nil, c.Err()
					}
				}
			case "take_control":
				close(takeoverSeen)
			}
			reply, _ := json.Marshal(map[string]string{"id": e.MsgID, "op": body.Op})
			return []json.RawMessage{reply}, nil
		})
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
	if _, err := framer.Read(ctx); err != nil {
		t.Fatal(err)
	}

	var seq uint64
	send := func(id, op string) {
		t.Helper()
		seq++
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op})
		raw, _ := json.Marshal(Envelope{
			Schema: "envelope/v0.2", MsgID: id, From: reg.From, To: reg.To, SessionID: reg.SessionID,
			Seq: seq, Nonce: fmt.Sprintf("n-%d", seq), Body: body,
		})
		if err := framer.Write(ctx, raw); err != nil {
			t.Fatal(err)
		}
	}
	readReply := func() (string, string) {
		t.Helper()
		rctx, rcancel := context.WithTimeout(ctx, 2*time.Second)
		defer rcancel()
		raw, err := framer.Read(rctx)
		if err != nil {
			t.Fatalf("read timed out or failed: %v", err)
		}
		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		var msg struct{ ID, Op string }
		if err := json.Unmarshal(env.Body, &msg); err != nil {
			t.Fatal(err)
		}
		return msg.ID, msg.Op
	}

	// Negative control: pipelined create + input preserves data-plane order.
	send("c-1", "create")
	send("i-1", "input")
	id1, op1 := readReply()
	id2, op2 := readReply()
	if id1 != "c-1" || op1 != "create" || id2 != "i-1" || op2 != "input" {
		t.Fatalf("data-plane order violated: (%s,%s) then (%s,%s)", id1, op1, id2, op2)
	}

	// Positive regression: blocked input + take_control dispatches take_control concurrently.
	send("blocked-input", "input")
	select {
	case <-inputEntered:
	case <-time.After(time.Second):
		t.Fatal("input handler not entered")
	}
	send("tc-1", "take_control")
	got := map[string]bool{}
	for range 2 {
		id, _ := readReply()
		got[id] = true
	}
	if !got["tc-1"] || !got["blocked-input"] {
		t.Fatalf("expected both take_control and unblocked input replies, got %v", got)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Connect did not join")
	}
}
