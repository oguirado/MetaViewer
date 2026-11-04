package guestcommand

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type fakeProcess struct {
	sent     [][]byte
	closeErr error
	closed   bool
}

func (f *fakeProcess) Send(_ context.Context, b []byte) error {
	f.sent = append(f.sent, append([]byte(nil), b...))
	return nil
}
func (f *fakeProcess) Read(context.Context) ([]byte, error) { return nil, errors.New("not used") }
func (f *fakeProcess) Close(context.Context) error          { f.closed = true; return f.closeErr }
func fixture(t *testing.T) (*Manager, *fakeProcess, *[]json.RawMessage) {
	t.Helper()
	child := &fakeProcess{}
	out := []json.RawMessage{}
	m := &Manager{profile: &Profile{OwnerID: "actor-" + strings.Repeat("a", 64), StateRoot: t.TempDir()}, child: child,
		reservation: t.TempDir() + "/owner", sessionID: "session-unit", createID: "request-create", token: reservationID("session-unit", "request-create"), pending: map[string]*pending{}, seen: map[string]bool{}, validate: func(b json.RawMessage) error {
			if !json.Valid(b) {
				return errors.New("json")
			}
			return nil
		}, emit: func(b json.RawMessage) error { out = append(out, append(json.RawMessage(nil), b...)); return nil }}
	return m, child, &out
}
func session(m *Manager, phase, ownership string) map[string]any {
	return map[string]any{"owner_id": m.profile.OwnerID, "workload_id": "workload-unit", "generation": 1, "phase": phase, "ownership": ownership, "job": nil, "jobs_started": 0, "controls": map[string]any{"cancel": nil, "stop": nil}}
}
func event(m *Manager, id, kind string, s any, data any) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"schema": "guest_command_event/v0.2", "event_id": "event-" + nonce(), "request_id": id, "reservation_id": m.token, "owner_id": m.profile.OwnerID, "session": s, "event": kind, "data": data})
	return b
}
func TestReservationGolden(t *testing.T) {
	if got := reservationID("session-unit", "request-create"); got != "reservation-6e4ef1293c64c110fcceb20b7fac432c31956e5960be8b02236c5e9472e96b60" {
		t.Fatal(got)
	}
}
func TestAcceptedBindsAndRejectsOwnerChanges(t *testing.T) {
	m, _, out := fixture(t)
	m.pending[m.createID] = &pending{op: "create"}
	if e := m.consumeLocked(context.Background(), event(m, m.createID, "accepted", session(m, "starting", "held"), map[string]any{"op": "create"})); e != nil {
		t.Fatal(e)
	}
	if m.workload != "workload-unit" || len(*out) != 1 {
		t.Fatal("missing binding")
	}
	changed := session(m, "ready", "held")
	changed["owner_id"] = "actor-foreign"
	if e := m.consumeLocked(context.Background(), event(m, m.createID, "ready", changed, map[string]any{})); e == nil {
		t.Fatal("foreign accepted")
	}
}
func TestHandleDoesNotWaitForPendingRunBeforeSendingCancel(t *testing.T) {
	m, child, _ := fixture(t)
	m.pending["request-run"] = &pending{op: "run", accepted: true}
	body := json.RawMessage(`{"schema":"guest_command_request/v0.2","request_id":"request-cancel","op":"cancel","params":{"workload_id":"workload-unit","generation":1,"job_id":"job-unit"}}`)
	replies, e := m.Handle(context.Background(), body, m.sessionID, m.validate, m.emit)
	if e != nil || len(replies) != 0 || len(child.sent) != 1 {
		t.Fatalf("cancel blocked %v %s", e, replies)
	}
}
func TestStoppedWaitsForExternalClosureBeforePublish(t *testing.T) {
	m, child, out := fixture(t)
	m.workload = "workload-unit"
	m.generation = 1
	m.pending["request-stop"] = &pending{op: "stop", accepted: true}
	child.closeErr = errors.New("still live")
	if e := m.consumeLocked(context.Background(), event(m, "request-stop", "stopped", session(m, "stopped", "released"), map[string]any{"native_absent": true})); e == nil {
		t.Fatal("false closure")
	}
	if len(*out) != 0 || m.child == nil {
		t.Fatal("released before native gate")
	}
}
func TestIdleFailureRetainsOriginalCreateAndHeldState(t *testing.T) {
	m, _, out := fixture(t)
	m.pending[m.createID] = &pending{op: "create", done: true, accepted: true}
	m.session, _ = json.Marshal(session(m, "ready", "held"))
	m.failLocked()
	if len(*out) != 1 {
		t.Fatal("missing unknown")
	}
	var e map[string]any
	json.Unmarshal((*out)[0], &e)
	if e["request_id"] != m.createID || e["event"] != "outcome_unknown" || e["session"].(map[string]any)["ownership"] != "held" {
		t.Fatal(e)
	}
}
func TestServiceBudgetPreserved(t *testing.T) {
	args := strings.Join(serviceArgs(&Profile{GuardianUnit: "own.service"}, "/private/attempt", "mv-guest-command-test.service"), " ")
	for _, s := range []string{"MemoryMax=512M", "MemorySwapMax=0", "CPUQuota=100%", "TasksMax=64", "RuntimeMaxSec=180", "BindsTo=own.service", "KillMode=control-group"} {
		if !strings.Contains(args, s) {
			t.Fatal(s)
		}
	}
}
