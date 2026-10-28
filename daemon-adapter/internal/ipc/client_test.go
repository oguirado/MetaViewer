package ipc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
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

// RV7-ADAPTER-LANES: data requests queued after take_control/release_control must wait
// for control completion; lanes drain before session cancellation on EOF; sessionErr is
// returned on read-loop exits.
func TestClientControlSequenceGateDrainingAndSessionErr(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	cfg := dispatchConfig(t)
	cfg.SocketPath = filepath.Join(dir, "gate.sock")
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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	var drainedMu sync.Mutex
	var drained []string
	go func() {
		done <- Connect(ctx, cfg, &allowPolicy{}, reg, func(c context.Context, e Envelope) ([]json.RawMessage, error) {
			var body struct {
				Schema, Op string
			}
			_ = json.Unmarshal(e.Body, &body)
			if body.Schema == "hello/v0.2" {
				return nil, nil
			}
			if body.Op == "take_control" || body.Op == "release_control" {
				time.Sleep(35 * time.Millisecond)
			}
			drainedMu.Lock()
			drained = append(drained, e.MsgID+":"+body.Op)
			drainedMu.Unlock()
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

	// Pipelined control -> data -> control -> data followed immediately by EOF:
	// data must wait for preceding control, and all queued work must drain before cancelSession.
	send("1", "take_control")
	send("2", "input")
	send("3", "release_control")
	send("4", "input")
	_ = conn.CloseWrite()

	var replies []string
	for range 4 {
		rctx, rcancel := context.WithTimeout(ctx, 2*time.Second)
		raw, err := framer.Read(rctx)
		rcancel()
		if err != nil {
			t.Fatalf("expected 4 drained replies before EOF exit, got %v (replies=%v)", err, replies)
		}
		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		var msg struct{ ID, Op string }
		if err := json.Unmarshal(env.Body, &msg); err != nil {
			t.Fatal(err)
		}
		replies = append(replies, msg.ID+":"+msg.Op)
	}
	want := []string{"1:take_control", "2:input", "3:release_control", "4:input"}
	drainedMu.Lock()
	gotDrained := append([]string(nil), drained...)
	drainedMu.Unlock()
	if fmt.Sprint(replies) != fmt.Sprint(want) || fmt.Sprint(gotDrained) != fmt.Sprint(want) {
		t.Fatalf("sequence gate / drain mismatch: replies=%v drained=%v want=%v", replies, gotDrained, want)
	}

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected EOF error from peer close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Connect did not exit after drain")
	}

	// Verify sessionErr takes precedence when a read-loop validation/auth error races with worker failure.
	errSock := filepath.Join(dir, "err.sock")
	errListener, err := net.ListenUnix("unix", &net.UnixAddr{Name: errSock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer errListener.Close()
	errCfg := cfg
	errCfg.SocketPath = errSock

	workerEntered := make(chan struct{})
	workerDone := make(chan struct{})
	errDone := make(chan error, 1)
	go func() {
		errDone <- Connect(ctx, errCfg, &allowPolicy{}, reg, func(c context.Context, e Envelope) ([]json.RawMessage, error) {
			var body struct{ Schema string }
			_ = json.Unmarshal(e.Body, &body)
			if body.Schema == "hello/v0.2" {
				return nil, nil
			}
			close(workerEntered)
			<-workerDone
			return nil, fmt.Errorf("worker Boom")
		})
	}()

	errConn, err := errListener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer errConn.Close()
	errFramer, err := NewFramer(errConn, errCfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := errFramer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": "input"})
	raw1, _ := json.Marshal(Envelope{
		Schema: "envelope/v0.2", MsgID: "w1", From: reg.From, To: reg.To, SessionID: reg.SessionID,
		Seq: 1, Nonce: "n-1", Body: body,
	})
	if err := errFramer.Write(ctx, raw1); err != nil {
		t.Fatal(err)
	}
	<-workerEntered
	close(workerDone)
	select {
	case gotErr := <-errDone:
		if gotErr == nil || fmt.Sprint(gotErr) != "dispatch: worker Boom" {
			t.Fatalf("expected sessionErr 'dispatch: worker Boom', got %v", gotErr)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Connect did not join on worker failure")
	}

	// T2-R16: Send peer-visible malformed wire bytes via raw conn.Write while a worker is
	// fenced on <-c.Done(), and assert the peer reader observes and fails on the wire error.
	wireSock := filepath.Join(dir, "wire-malformed.sock")
	wireListener, err := net.ListenUnix("unix", &net.UnixAddr{Name: wireSock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer wireListener.Close()
	wireCfg := cfg
	wireCfg.SocketPath = wireSock
	wireWorkerEntered := make(chan struct{})
	wireWorkerCancelled := make(chan struct{})
	wireDone := make(chan error, 1)
	go func() {
		wireDone <- Connect(ctx, wireCfg, &allowPolicy{}, reg, func(c context.Context, e Envelope) ([]json.RawMessage, error) {
			var b struct{ Schema string }
			_ = json.Unmarshal(e.Body, &b)
			if b.Schema == "hello/v0.2" {
				return nil, nil
			}
			close(wireWorkerEntered)
			<-c.Done()
			close(wireWorkerCancelled)
			return nil, c.Err()
		})
	}()
	wireConn, err := wireListener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer wireConn.Close()
	wireFramer, err := NewFramer(wireConn, wireCfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wireFramer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	if err := wireFramer.Write(ctx, raw1); err != nil {
		t.Fatal(err)
	}
	<-wireWorkerEntered
	if _, err := wireConn.Write([]byte("{\"invalid\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case gotWireErr := <-wireDone:
		if gotWireErr == nil || fmt.Sprint(gotWireErr) == "dispatch: worker Boom" {
			t.Fatalf("expected peer reader wire error, got %v", gotWireErr)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Connect did not abort on raw malformed wire frame")
	}
	select {
	case <-wireWorkerCancelled:
	case <-time.After(30 * time.Second):
		t.Fatal("in-flight worker was not cancelled on raw malformed wire frame")
	}
}

type rv8ClientPolicy struct {
	allowPolicy
}

func (p *rv8ClientPolicy) Authenticate(ctx context.Context, cred PeerCredentials, in Envelope) error {
	if in.MsgID == "bad-auth" {
		return fmt.Errorf("authentication refused")
	}
	return p.allowPolicy.Authenticate(ctx, cred, in)
}

// RV8-ADAPTER (P1): framing/JSON/validation/route/schema/auth failure branches in Connect
// must call fail(err) before exitLoop(err) so the session context cancels in-flight
// handlers immediately, queued envelopes do not drain, and the caller receives
// the typed error. Negative control: all-valid frames dispatch R1+R2, and 66 saturated
// data requests remain preemptible by take_control while draining in strict FIFO order.
func TestRV8ClientFailureCancelsInFlightWorkersBeforeDrain(t *testing.T) {
	t.Run("saturation-66-take-control", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Chmod(dir, 0700); err != nil {
			t.Fatal(err)
		}
		cfg := dispatchConfig(t)
		cfg.SocketPath = filepath.Join(dir, "sat66.sock")
		cfg.HelloTimeout = 5 * time.Second
		cfg.ReadTimeout = 30 * time.Second
		cfg.WriteTimeout = 5 * time.Second
		cfg.ShutdownTimeout = 5 * time.Second

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

		d1Entered := make(chan struct{})
		takeoverEntered := make(chan struct{})
		releaseTakeover := make(chan struct{})
		d1Unblock := make(chan struct{})
		var releaseOnce sync.Once
		defer releaseOnce.Do(func() { close(releaseTakeover) })

		var mu sync.Mutex
		var dataOrder []string
		var allOrder []string

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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
				if e.MsgID == "d-1" {
					close(d1Entered)
					select {
					case <-d1Unblock:
					case <-c.Done():
						return nil, c.Err()
					}
				}
				if body.Op == "take_control" {
					close(takeoverEntered)
					select {
					case <-releaseTakeover:
					case <-c.Done():
						return nil, c.Err()
					}
					mu.Lock()
					allOrder = append(allOrder, e.MsgID)
					mu.Unlock()
					close(d1Unblock)
					reply, _ := json.Marshal(map[string]string{"id": e.MsgID, "op": body.Op})
					return []json.RawMessage{reply}, nil
				}
				mu.Lock()
				dataOrder = append(dataOrder, e.MsgID)
				allOrder = append(allOrder, e.MsgID)
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

		send("d-1", "input")
		select {
		case <-d1Entered:
		case <-time.After(30 * time.Second):
			t.Fatal("d-1 did not enter handler")
		}
		for i := 2; i <= 66; i++ {
			send(fmt.Sprintf("d-%d", i), "input")
		}
		send("tc-1", "take_control")
		send("d-67", "input")

		select {
		case <-takeoverEntered:
		case <-time.After(30 * time.Second):
			t.Fatal("take_control did not preempt saturated data lane")
		}
		releaseOnce.Do(func() { close(releaseTakeover) })
		if err := conn.CloseWrite(); err != nil {
			t.Fatal(err)
		}

		for range 68 {
			if _, err := framer.Read(ctx); err != nil {
				t.Fatalf("failed reading drained reply: %v", err)
			}
		}
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("expected EOF after clean drain")
			}
		case <-time.After(30 * time.Second):
			t.Fatal("Connect did not exit after saturated drain")
		}

		mu.Lock()
		gotData := append([]string(nil), dataOrder...)
		gotAll := append([]string(nil), allOrder...)
		mu.Unlock()
		if len(gotData) != 67 {
			t.Fatalf("expected 67 data executions, got %d", len(gotData))
		}
		for i := 1; i <= 67; i++ {
			want := fmt.Sprintf("d-%d", i)
			if gotData[i-1] != want {
				t.Fatalf("FIFO data order violated at %d: got %s, want %s", i-1, gotData[i-1], want)
			}
		}
		if len(gotAll) != 68 || gotAll[0] != "tc-1" || gotAll[len(gotAll)-1] != "d-67" {
			t.Fatalf("control barrier ordering violated: first=%s last=%s", gotAll[0], gotAll[len(gotAll)-1])
		}
	})

	for _, tc := range []string{
		"validate",
		"body-unmarshal",
		"route",
		"schema",
		"auth",
		"raw-malformed-json",
		"raw-duplicate-key",
		"raw-truncated-eof",
		"raw-oversized-frame",
		"all-valid",
	} {
		t.Run(tc, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.Chmod(dir, 0700); err != nil {
				t.Fatal(err)
			}
			cfg := dispatchConfig(t)
			cfg.SocketPath = filepath.Join(dir, "rv8.sock")
			cfg.HelloTimeout = 5 * time.Second
			cfg.ReadTimeout = 30 * time.Second
			cfg.WriteTimeout = 5 * time.Second
			cfg.ShutdownTimeout = 5 * time.Second

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

			r1Entered := make(chan struct{})
			r1Release := make(chan struct{})
			var releaseOnce sync.Once
			defer releaseOnce.Do(func() { close(r1Release) })
			var r1SawCancel, r2Dispatched bool
			var mu sync.Mutex

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- Connect(ctx, cfg, &rv8ClientPolicy{}, reg, func(c context.Context, e Envelope) ([]json.RawMessage, error) {
					var body struct {
						Schema, Op string
					}
					_ = json.Unmarshal(e.Body, &body)
					if body.Schema == "hello/v0.2" {
						return nil, nil
					}
					switch e.MsgID {
					case "r1":
						close(r1Entered)
						select {
						case <-c.Done():
							mu.Lock()
							r1SawCancel = true
							mu.Unlock()
							return nil, c.Err()
						case <-r1Release:
						}
					case "r2":
						mu.Lock()
						r2Dispatched = true
						mu.Unlock()
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

			sendEnv := func(env Envelope) {
				t.Helper()
				raw, _ := json.Marshal(env)
				if err := framer.Write(ctx, raw); err != nil {
					t.Fatal(err)
				}
			}
			reqBody := json.RawMessage(`{"schema":"surface_request/v0.2","op":"input"}`)
			sendEnv(Envelope{
				Schema: "envelope/v0.2", MsgID: "r1", From: reg.From, To: reg.To, SessionID: reg.SessionID,
				Seq: 1, Nonce: "n-1", Body: reqBody,
			})
			select {
			case <-r1Entered:
			case <-time.After(30 * time.Second):
				t.Fatal("r1 did not enter handler")
			}
			sendEnv(Envelope{
				Schema: "envelope/v0.2", MsgID: "r2", From: reg.From, To: reg.To, SessionID: reg.SessionID,
				Seq: 2, Nonce: "n-2", Body: reqBody,
			})

			if tc == "all-valid" {
				releaseOnce.Do(func() { close(r1Release) })
				_ = conn.CloseWrite()
				for _, wantID := range []string{"r1", "r2"} {
					rctx, rcancel := context.WithTimeout(ctx, 30*time.Second)
					raw, err := framer.Read(rctx)
					rcancel()
					if err != nil {
						t.Fatalf("expected reply %s, got %v", wantID, err)
					}
					var out Envelope
					if err := json.Unmarshal(raw, &out); err != nil {
						t.Fatal(err)
					}
					var msg struct{ ID string }
					if err := json.Unmarshal(out.Body, &msg); err != nil || msg.ID != wantID {
						t.Fatalf("got reply %s, want %s", out.Body, wantID)
					}
				}
				select {
				case <-done:
				case <-time.After(30 * time.Second):
					t.Fatal("Connect did not exit after clean EOF")
				}
				mu.Lock()
				gotR2 := r2Dispatched
				cancelled := r1SawCancel
				mu.Unlock()
				if cancelled {
					t.Fatal("negative control failed: clean EOF cancelled in-flight r1")
				}
				if !gotR2 {
					t.Fatal("negative control failed: r2 was not dispatched")
				}
				return
			}

			switch tc {
			case "validate":
				if err := framer.Write(ctx, []byte(`[]`)); err != nil {
					t.Fatal(err)
				}
			case "body-unmarshal":
				sendEnv(Envelope{
					Schema: "envelope/v0.2", MsgID: "bad-body", From: reg.From, To: reg.To, SessionID: reg.SessionID,
					Seq: 3, Nonce: "n-3", Body: json.RawMessage(`[]`),
				})
			case "route":
				sendEnv(Envelope{
					Schema: "envelope/v0.2", MsgID: "bad-route", From: Endpoint{Component: "agents", Instance: "a-1"}, To: reg.To, SessionID: reg.SessionID,
					Seq: 3, Nonce: "n-3", Body: reqBody,
				})
			case "schema":
				sendEnv(Envelope{
					Schema: "envelope/v0.2", MsgID: "bad-schema", From: reg.From, To: reg.To, SessionID: reg.SessionID,
					Seq: 3, Nonce: "n-3", Body: json.RawMessage(`{"schema":"unknown/v0.2"}`),
				})
			case "auth":
				sendEnv(Envelope{
					Schema: "envelope/v0.2", MsgID: "bad-auth", From: reg.From, To: reg.To, SessionID: reg.SessionID,
					Seq: 3, Nonce: "n-3", Body: reqBody,
				})
			case "raw-malformed-json":
				if _, err := conn.Write([]byte("{\"invalid\n")); err != nil {
					t.Fatal(err)
				}
			case "raw-duplicate-key":
				if _, err := conn.Write([]byte("{\"a\":1,\"a\":2}\n")); err != nil {
					t.Fatal(err)
				}
			case "raw-truncated-eof":
				if _, err := conn.Write([]byte("{\"truncated")); err != nil {
					t.Fatal(err)
				}
				if err := conn.CloseWrite(); err != nil {
					t.Fatal(err)
				}
			case "raw-oversized-frame":
				oversized := append(bytes.Repeat([]byte("a"), cfg.MaxFrameBytes+1), '\n')
				if _, err := conn.Write(oversized); err != nil {
					t.Fatal(err)
				}
			}

			var gotErr error
			select {
			case gotErr = <-done:
			case <-time.After(30 * time.Second):
				t.Fatalf("Connect did not abort on %s failure", tc)
			}
			if gotErr == nil {
				t.Fatalf("expected non-nil error for %s, got nil", tc)
			}
			mu.Lock()
			cancelled := r1SawCancel
			dispatchedR2 := r2Dispatched
			mu.Unlock()
			if !cancelled {
				t.Fatalf("r1 did not observe session cancellation on %s failure", tc)
			}
			if dispatchedR2 {
				t.Fatalf("r2 was dispatched after %s failure", tc)
			}
		})
	}
}
