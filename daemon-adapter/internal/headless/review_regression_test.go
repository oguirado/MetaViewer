package headless

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

func TestReadRegularFIFORefusesWithoutWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fifo")
	if e := syscall.Mkfifo(path, 0600); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { _, e := readRegular(path, true, 4096); done <- e }()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("FIFO accepted")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("FIFO blocked before kind gate")
	}
}
func TestInterpreterRejectsWritableAndNonExecutable(t *testing.T) {
	m := fixture(t, &fakeProcess{})
	p := m.profile.Python
	for _, mode := range []os.FileMode{0666, 0600} {
		if e := os.Chmod(p.Path, mode); e != nil {
			t.Fatal(e)
		}
		if _, e := pinnedExecutable(p); e == nil {
			t.Fatalf("interpreter mode %o accepted", mode)
		}
	}
}

func TestInterpreterExecutesPrivateSnapshotPath(t *testing.T) {
	m := fixture(t, &fakeProcess{})
	attempt, unit, e := m.prepare()
	if e != nil {
		t.Fatal(e)
	}
	target := filepath.Join(attempt, "python")
	before, e := os.ReadFile(target)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(m.profile.Python.Path, []byte("changed donor"), 0700); e != nil {
		t.Fatal(e)
	}
	after, e := os.ReadFile(target)
	if e != nil || string(before) != string(after) {
		t.Fatal("snapshot follows donor")
	}
	st, e := os.Stat(target)
	if e != nil || st.Mode().Perm() != 0500 {
		t.Fatal("mutable snapshot mode")
	}
	args := strings.Join(serviceArgs(m.profile, attempt, unit), " ")
	if !strings.Contains(args, target+" -I -B") || strings.Contains(args, m.profile.Python.Path) {
		t.Fatal("exec reopened donor", args)
	}
}

func TestInterpreterProbeRequiresExactPrefixAndBoundedShape(t *testing.T) {
	if e := checkInterpreterProbe([]byte(`{"prefix":"/expected","base_prefix":"/expected"}`), "/expected"); e != nil {
		t.Fatal(e)
	}
	for _, raw := range []string{`{"prefix":"/other","base_prefix":"/other"}`, `{"prefix":"/expected","base_prefix":"/expected","extra":true}`, `{"prefix":"/expected","base_prefix":"/expected"} {}`} {
		if checkInterpreterProbe([]byte(raw), "/expected") == nil {
			t.Fatal("invalid probe admitted", raw)
		}
	}
	var b boundedProbeOutput
	if _, e := b.Write(make([]byte, 4097)); e == nil {
		t.Fatal("unbounded probe output")
	}
}

type retainedMock struct {
	signals   int
	available bool
}

func (p *retainedMock) WithHandle(f func(uintptr)) error {
	if !p.available {
		return os.ErrNoHandle
	}
	f(100)
	return nil
}
func (p *retainedMock) Signal(s os.Signal) error {
	if s != syscall.SIGTERM {
		return errors.New("unexpected signal")
	}
	p.signals++
	return nil
}
func (p *retainedMock) Release() error { return nil }
func TestEmergencyUsesRetainedHandleNeverReplacementName(t *testing.T) {
	original := serviceIdentity{Invocation: strings.Repeat("a", 32), Group: "/owned.service", Start: "10", PID: 100, Device: 1, Inode: 2}
	for _, kind := range []string{"same", "invocation", "inode", "pid", "missing", "no-handle"} {
		t.Run(kind, func(t *testing.T) {
			now := original
			main := &retainedMock{available: kind != "no-handle"}
			switch kind {
			case "invocation":
				now.Invocation = strings.Repeat("b", 32)
			case "inode":
				now.Inode++
			case "pid":
				now.PID++
			}
			s := serviceProcess{unit: "owned.service", identity: original, main: main, inspect: func(context.Context, string) (map[string]string, error) {
				if kind == "missing" {
					return nil, errors.New("unavailable")
				}
				return map[string]string{}, nil
			}, observe: func(map[string]string) (serviceIdentity, error) { return now, nil }}
			e := s.emergencySignal(context.Background())
			if kind == "same" {
				if e != nil || main.signals != 1 {
					t.Fatal("owned handle not signalled", e)
				}
			} else if e == nil || main.signals != 0 {
				t.Fatal("replacement/unknown signalled", kind, e)
			}
		})
	}
}

type testInput struct{}

func (testInput) Write(p []byte) (int, error) { return len(p), nil }
func (testInput) Close() error                { return nil }

func TestReplacementUnitCannotDischargeOldClosure(t *testing.T) {
	done := make(chan struct{})
	close(done)
	main := &retainedMock{available: true}
	s := serviceProcess{input: testInput{}, exited: done, stopRead: make(chan struct{}), main: main, identity: serviceIdentity{Invocation: strings.Repeat("a", 32), Group: "/own.service"}, cgroup: "/never/existing", inspect: func(context.Context, string) (map[string]string, error) {
		return map[string]string{"LoadState": "loaded", "ActiveState": "inactive", "InvocationID": strings.Repeat("b", 32), "ControlGroup": ""}, nil
	}}
	if e := s.Close(context.Background()); e == nil || main.signals != 0 {
		t.Fatal("replacement accepted/signalled", e)
	}
}

type schemaAuthority struct{}

func (schemaAuthority) Authenticate(context.Context, ipc.PeerCredentials, ipc.Envelope) error {
	return nil
}
func (schemaAuthority) Reserve(context.Context, ipc.SenderKey, uint64, string) error { return nil }
func (schemaAuthority) Wrap(context.Context, ipc.Envelope, json.RawMessage) (ipc.Envelope, error) {
	return ipc.Envelope{}, nil
}
func actualEventValidator(t *testing.T) func(json.RawMessage) error {
	t.Helper()
	c := ipc.Config{SocketPath: "/synthetic/core.sock", MaxFrameBytes: 1 << 20, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096, MaxReplayEntries: 10, MaxConnections: 1, HelloTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	p, e := ipc.NewPolicy(c, os.DirFS("../../../contracts/v0.2"), schemaAuthority{})
	if e != nil {
		t.Fatal(e)
	}
	return func(b json.RawMessage) error {
		e := ipc.Envelope{Schema: ipc.EnvelopeSchema(b), MsgID: "test", From: ipc.Endpoint{Component: "daemon", Instance: "daemon-test"}, To: ipc.Endpoint{Component: "core", Instance: "core-test"}, SessionID: "session-test", Seq: 1, Nonce: "nonce-test", Body: b}
		raw, _ := json.Marshal(e)
		_, err := p.ValidateEnvelope(raw)
		return err
	}
}
func TestLostFirstRunAcknowledgementPreservesActualJob(t *testing.T) {
	validate := actualEventValidator(t)
	f := &fakeProcess{}
	m := fixture(t, f)
	for _, name := range []string{"headless_event.valid.accepted_1.json", "headless_event.valid.state_changed_4.json"} {
		b, e := os.ReadFile(filepath.Join("../../../contracts/examples/v0.2", name))
		if e != nil {
			t.Fatal(e)
		}
		var v map[string]any
		json.Unmarshal(b, &v)
		v["request_id"] = "request-create"
		v["data"].(map[string]any)["session"].(map[string]any)["owner_id"] = m.profile.OwnerID
		b, _ = json.Marshal(v)
		f.lines = append(f.lines, b)
	}
	if _, e := m.Handle(context.Background(), request("request-create", "create"), validate); e != nil {
		t.Fatal(e)
	}
	f.failRead = true
	b := json.RawMessage(`{"schema":"headless_request/v0.2","request_id":"request-run","op":"run","params":{"workload_id":"workload-example","generation":1,"job_id":"job-reserved","operation":"sumsq","n":10}}`)
	out, e := m.Handle(context.Background(), b, validate)
	if e != nil || len(out) != 1 {
		t.Fatalf("unknown event absent: %s %v", out, e)
	}
	if e = validate(out[0]); e != nil {
		t.Fatal(e)
	}
	var v struct {
		Data struct {
			Session struct {
				Job struct {
					ID        string `json:"job_id"`
					Operation string `json:"operation"`
					N         int    `json:"n"`
					Status    string `json:"status"`
					Value     *int   `json:"value"`
				} `json:"job"`
			} `json:"session"`
		} `json:"data"`
	}
	json.Unmarshal(out[0], &v)
	j := v.Data.Session.Job
	if j.ID != "job-reserved" || j.N != 10 || j.Operation != "sumsq" || j.Status != "unknown" || j.Value != nil {
		t.Fatalf("lost reserved job: %s", out[0])
	}
	before := f.writes
	m.Handle(context.Background(), b, validate)
	if f.writes != before {
		t.Fatal("uncertain job replayed")
	}
}
