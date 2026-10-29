package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
	"metaviewer/daemon-adapter/internal/record"
)

type verdictParityVector struct {
	ID       string            `json:"id"`
	Family   string            `json:"family"`
	Verdict  string            `json:"contract_verdict"`
	Findings map[string]string `json:"findings"`
	Payload  json.RawMessage   `json:"payload"`
}

func verdictParityFixture(t *testing.T) []verdictParityVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "fixtures", "verdict_parity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Vectors []verdictParityVector `json:"vectors"`
	}
	if err = json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f.Vectors
}

// A subsequent dispatched request proves the stream survived and consumed the verdict.
func verdictParityStream(t *testing.T, body json.RawMessage) bool {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "v.sock")
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cfg := ipc.Config{SocketPath: sock, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 256, MaxArrayItems: 128, MaxReplayEntries: 128, MaxConnections: 1, HelloTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	reg := ipc.Envelope{Schema: "envelope/v0.2", MsgID: "reg", From: ipc.Endpoint{Component: "core", Instance: "core-1"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon-1"}, SessionID: "s-1", Seq: 1, Nonce: "n-1", Body: json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`)}
	done := make(chan error, 1)
	seen := make(chan struct{}, 1)
	go func() {
		done <- connectStreaming(ctx, cfg, &rv8StreamPolicy{}, reg, func(_ context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
			if e.MsgID == "after" {
				seen <- struct{}{}
			}
			return nil, nil
		})
	}()
	if err = l.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	conn, err := l.AcceptUnix()
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
	for i, p := range []json.RawMessage{body, json.RawMessage(`{"schema":"surface_request/v0.2","op":"input"}`)} {
		env := reg
		env.Seq = uint64(i + 1)
		env.Nonce = []string{"n-1", "n-2"}[i]
		env.MsgID = []string{"verdict", "after"}[i]
		env.Body = p
		raw, e := json.Marshal(env)
		if e != nil {
			t.Fatal(e)
		}
		// An already refused stream can close before the following write.
		if e = framer.Write(ctx, raw); e != nil {
			break
		}
	}
	_ = conn.CloseWrite()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("stream failed to terminate")
	}
	select {
	case <-seen:
		return true
	default:
		return false
	}
}
func TestVerdictParityStream(t *testing.T) {
	for _, v := range verdictParityFixture(t) {
		if v.Family != "action_verdict" {
			continue
		}
		t.Run(v.ID, func(t *testing.T) {
			actual := verdictParityStream(t, v.Payload)
			want := v.Verdict == "accept"
			if finding := v.Findings["go_stream"]; finding != "" {
				if actual == want {
					t.Fatalf("stale %s", finding)
				}
				t.Skip(finding)
			}
			if actual != want {
				t.Fatalf("contract %s; stream accepted=%v", v.Verdict, actual)
			}
		})
	}
}

type verdictParityRunner struct{}

func (verdictParityRunner) Run(context.Context, []string, []byte) ([]byte, error) {
	return nil, errors.New("unexpected runner invocation")
}
func verdictParityRecord(t *testing.T, raw json.RawMessage) bool {
	t.Helper()
	dir := t.TempDir()
	// Map the fixture's destination capability into this test's private directory.
	var q map[string]any
	if err := json.Unmarshal(raw, &q); err != nil {
		t.Fatal(err)
	}
	if q["op"] == "disk_start" {
		q["params"].(map[string]any)["destination_path"] = dir
	}
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	m, err := record.NewManager(record.Config{Runner: verdictParityRunner{}, Clock: func() uint64 { return 1 }, BinDir: dir, Surfaces: map[string]record.Surface{"s": {Family: "srf-identity-surface", Container: "capsule", Window: "w1", FramesRoot: "/dev/shm/verdict-parity-unused"}}, MemoryBytes: 2, RingBytes: 1, MaxFPS: 120, Destination: &record.Destination{CapabilityID: "dest", Path: dir}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	events, err := m.Handle(context.Background(), raw)
	if err == nil {
		return true
	}
	var refused *record.Refusal
	if errors.As(err, &refused) && refused.Detail != "invalid recording bounds" {
		t.Fatalf("unrelated recording policy: %v (%v)", err, events)
	}
	return false
}
func TestVerdictParityRecord(t *testing.T) {
	for _, v := range verdictParityFixture(t) {
		if v.Family != "record_request" {
			continue
		}
		t.Run(v.ID, func(t *testing.T) {
			if got := verdictParityRecord(t, v.Payload); got != (v.Verdict == "accept") {
				t.Fatalf("contract %s; record accepted=%v", v.Verdict, got)
			}
		})
	}
}
func TestVerdictParityKillsPolicyEnumBypassMutant(t *testing.T) {
	for _, v := range verdictParityFixture(t) {
		if v.ID != "verdict_reason_code_0" {
			continue
		}
		if verdictParityStream(t, v.Payload) {
			t.Fatal("baseline accepted BOGUS")
		}
		var mutated map[string]any
		_ = json.Unmarshal(v.Payload, &mutated)
		// Behavioral mutant: bypass the reason enum by treating any code as POLICY.
		mutated["reason_code"] = "POLICY"
		raw, _ := json.Marshal(mutated)
		if !verdictParityStream(t, raw) {
			t.Fatal("mutant witness did not reach acceptance")
		}
		if v.Verdict != "refuse" {
			t.Fatal("mutant survived frozen oracle")
		}
		return
	}
	t.Fatal("missing mutation witness")
}
