package guestcommand

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func rewindFixture(t *testing.T) (*RewindManager, *fakeProcess) {
	m, p, _ := fixture(t)
	m.profile.Rewind = true
	m.workload = "workload-unit"
	m.generation = 1
	m.attempted = true
	return &RewindManager{Manager: m, families: map[string]string{}, plans: map[string]rewindPlan{}, epoch: 1, phase: "paused", expectedWorkload: "workload-unit"}, p
}
func TestRewindTargetCommittedBeforeSendAndStopUsesIt(t *testing.T) {
	r, p := rewindFixture(t)
	request := json.RawMessage(`{"schema":"rewind_request/v0.2","request_id":"request-resume","op":"resume","params":{"workload_id":"workload-unit","generation":1,"authority_epoch":1}}`)
	if _, e := r.Handle(context.Background(), request, r.sessionID, r.validate, r.emit); e != nil {
		t.Fatal(e)
	}
	var packet struct {
		Binding struct {
			Generation int64 `json:"generation"`
			Epoch      int64 `json:"authority_epoch"`
		} `json:"binding"`
	}
	if json.Unmarshal(p.sent[0], &packet) != nil || packet.Binding.Generation != 2 || packet.Binding.Epoch != 2 {
		t.Fatal("missing core-assigned target")
	}
	stop := json.RawMessage(`{"schema":"guest_command_request/v0.2","request_id":"request-stop","op":"stop","params":{"workload_id":"workload-unit","generation":2}}`)
	if _, e := r.Handle(context.Background(), stop, r.sessionID, r.validate, r.emit); e != nil || len(p.sent) != 2 {
		t.Fatalf("stop lost after target transition: %v", e)
	}
}
func TestRewindForeignSessionAndStaleTupleNeverSend(t *testing.T) {
	r, p := rewindFixture(t)
	body := json.RawMessage(`{"schema":"rewind_request/v0.2","request_id":"request-pause","op":"pause","params":{"workload_id":"workload-unit","generation":1,"authority_epoch":1}}`)
	if _, e := r.Handle(context.Background(), body, "foreign", r.validate, r.emit); e == nil {
		t.Fatal("foreign accepted")
	}
	r.epoch = 2
	if out, e := r.Handle(context.Background(), body, r.sessionID, r.validate, r.emit); e != nil || len(out) != 1 || len(p.sent) != 0 {
		t.Fatal("stale tuple sent")
	}
}
func TestRewindCompletionRejectsUnplannedGeneration(t *testing.T) {
	r, _ := rewindFixture(t)
	r.pending["request-resume"] = &pending{op: "resume", accepted: true}
	r.families["request-resume"] = "rewind_request/v0.2"
	r.plans["request-resume"] = rewindPlan{Generation: 2, Epoch: 2, Phase: "ready"}
	body := json.RawMessage(`{"schema":"rewind_event/v0.2","event_id":"event-one","request_id":"request-resume","owner_id":"` + r.profile.OwnerID + `","event":"completed","session":{"owner_id":"` + r.profile.OwnerID + `","workload_id":"workload-unit","generation":3,"authority_epoch":2,"phase":"ready","ownership":"held"},"data":{"op":"resume","point_id":null}}`)
	if r.consumeRewind(context.Background(), body) == nil {
		t.Fatal("unplanned tuple accepted")
	}
}
func TestRewindBudgetHasNoIdleTTLAndPreservesNormal(t *testing.T) {
	normal := strings.Join(serviceArgs(&Profile{GuardianUnit: "owned.service"}, "/tmp/attempt", "owned.service"), " ")
	if !strings.Contains(normal, "RuntimeMaxSec=180") {
		t.Fatal("normal TTL changed")
	}
	rewind := strings.Join(serviceArgs(&Profile{Rewind: true, GuardianUnit: "owned.service"}, "/tmp/attempt", "owned.service"), " ")
	for _, want := range []string{"MemoryHigh=6G", "MemoryMax=8G", "MemorySwapMax=0", "CPUQuota=200%", "TasksMax=256", "UMask=0077", "BindsTo=owned.service"} {
		if !strings.Contains(rewind, want) {
			t.Fatal(want)
		}
	}
	if strings.Contains(rewind, "RuntimeMaxSec=") {
		t.Fatal("rewind idle TTL")
	}
}

type deadlineProbe struct{ had bool }

func (p *deadlineProbe) Send(context.Context, []byte) error { return nil }
func (p *deadlineProbe) Read(ctx context.Context) ([]byte, error) {
	_, p.had = ctx.Deadline()
	return nil, errors.New("synthetic EOF")
}
func (p *deadlineProbe) Close(context.Context) error { return nil }
func TestRewindIdleReadDoesNotAddNormalDeadline(t *testing.T) {
	r, _ := rewindFixture(t)
	p := &deadlineProbe{}
	r.child = p
	r.readerDone = make(chan struct{})
	r.receiveRewind(context.Background())
	if p.had {
		t.Fatal("idle deadline injected")
	}
}
func TestRewindMarkPlanPreservesMappedPoint(t *testing.T) {
	r, p := rewindFixture(t)
	r.rewindSession = json.RawMessage(`{"points":[{"point_id":"point-old","created_order":1,"active_references":1},{"point_id":"point-next","created_order":2,"active_references":0}]}`)
	body := json.RawMessage(`{"schema":"rewind_request/v0.2","request_id":"request-mark","op":"mark","params":{"workload_id":"workload-unit","generation":1,"authority_epoch":1,"label":"new"}}`)
	if _, e := r.Handle(context.Background(), body, r.sessionID, r.validate, r.emit); e != nil {
		t.Fatal(e)
	}
	plan := r.plans["request-mark"]
	if plan.Victim != "point-next" || plan.Order != 3 || len(p.sent) != 1 {
		t.Fatal("unsafe rotation plan", plan)
	}
}
func TestRewindOnlyOneStopDispatch(t *testing.T) {
	r, p := rewindFixture(t)
	for _, id := range []string{"request-stop-one", "request-stop-two"} {
		body, _ := json.Marshal(map[string]any{"schema": "guest_command_request/v0.2", "request_id": id, "op": "stop", "params": map[string]any{"workload_id": "workload-unit", "generation": 1}})
		if _, e := r.Handle(context.Background(), body, r.sessionID, r.validate, r.emit); e != nil {
			t.Fatal(e)
		}
	}
	if len(p.sent) != 1 {
		t.Fatal("more than one independent stop dispatched")
	}
}
func TestRewindIdleFailureStillEmitsOriginalCreateUnknown(t *testing.T) {
	r, _ := rewindFixture(t)
	out := []json.RawMessage{}
	r.emit = func(b json.RawMessage) error { out = append(out, b); return nil }
	r.pending[r.createID] = &pending{op: "create", done: true, accepted: true}
	r.families[r.createID] = "guest_command_request/v0.2"
	r.session, _ = json.Marshal(session(r.Manager, "ready", "held"))
	r.rewindSession = json.RawMessage(`{"phase":"ready"}`)
	r.failRewind()
	if len(out) != 1 {
		t.Fatal("idle failure lost")
	}
	var e struct {
		ID    string `json:"request_id"`
		Event string `json:"event"`
	}
	json.Unmarshal(out[0], &e)
	if e.ID != r.createID || e.Event != "outcome_unknown" {
		t.Fatal(string(out[0]))
	}
}
