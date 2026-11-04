package guestcommand

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestRegressionForeignSessionCannotReconcile(t *testing.T) {
	m, child, _ := fixture(t)
	m.poisoned = true
	m.workload = "workload-unit"
	m.generation = 1
	m.session, _ = json.Marshal(session(m, "uncertain", "held"))
	body := json.RawMessage(`{"schema":"guest_command_request/v0.2","request_id":"request-stop","op":"stop","params":{"workload_id":"workload-unit","generation":1}}`)
	_, e := m.Handle(context.Background(), body, "session-foreign", m.validate, m.emit)
	if e == nil || child.closed {
		t.Fatal("foreign session closed an owned service")
	}
}
func TestRegressionNewRunUnknownMustResetPreviousControls(t *testing.T) {
	m, _, out := fixture(t)
	s := session(m, "ready", "held")
	s["jobs_started"] = 1
	s["job"] = map[string]any{"job_id": "job-old", "state": "cancelled", "exit_code": nil, "signal": 9, "stdout_bytes": 0, "stderr_bytes": 0, "output_complete": true}
	s["controls"] = map[string]any{"cancel": map[string]any{"request_id": "request-old-cancel", "ack": "accepted"}, "stop": nil}
	m.session, _ = json.Marshal(s)
	m.pending[m.createID] = &pending{op: "create", done: true, accepted: true}
	m.pending["request-new"] = &pending{op: "run", body: json.RawMessage(`{"params":{"job_id":"job-new"}}`)}
	m.failLocked()
	if len(*out) != 1 {
		t.Fatal("missing unknown")
	}
	var event map[string]any
	json.Unmarshal((*out)[0], &event)
	state := event["session"].(map[string]any)
	if state["controls"].(map[string]any)["cancel"] != nil {
		t.Fatal("new-run uncertainty retained a previous job's accepted cancel")
	}
}

type reviewHandle struct{ alive bool }

func (h *reviewHandle) WithHandle(f func(uintptr)) error { f(1); return nil }
func (h *reviewHandle) Signal(os.Signal) error {
	if h.alive {
		return nil
	}
	return os.ErrProcessDone
}
func (h *reviewHandle) Release() error { return nil }
func TestRegressionClosureRequiresDeadHandle(t *testing.T) {
	for _, alive := range []bool{false, true} {
		done := make(chan struct{})
		close(done)
		dir := t.TempDir() + "/absent"
		p := &serviceProcess{input: reviewWriter{}, exited: done, stopRead: make(chan struct{}), main: &reviewHandle{alive}, cgroup: dir, identity: serviceIdentity{Invocation: strings.Repeat("a", 32), Group: "/own"}, inspect: func(context.Context, string) (map[string]string, error) {
			return map[string]string{"LoadState": "not-found", "ActiveState": "inactive", "ControlGroup": ""}, nil
		}}
		p.input = reviewWriter{}
		err := p.Close(context.Background())
		if alive && err == nil {
			t.Fatal("live pidfd treated as absent")
		}
		if !alive && err != nil {
			t.Fatal(err)
		}
	}
}

type reviewWriter struct{}

func (reviewWriter) Write(b []byte) (int, error) { return len(b), nil }
func (reviewWriter) Close() error                { return nil }
