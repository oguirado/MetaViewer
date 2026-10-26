package capsule

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

type handoffRunner struct {
	started, cancelled, finish chan struct{}
	inputs                     atomic.Int32
}

func (r *handoffRunner) Run(ctx context.Context, args []string, _ []byte) ([]byte, error) {
	switch args[1] {
	case "start":
		return []byte(startOK), nil
	case "input":
		if r.inputs.Add(1) == 1 {
			close(r.started)
			<-ctx.Done()
			close(r.cancelled)
			<-r.finish
			return nil, ctx.Err()
		}
		return []byte(`{"surface_id":"w1","kind":"click","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
	case "frame":
		return []byte(`{"path":"/dev/shm/demo-run/frames/w1/f.png","seq":1,"sha256_rgb24":"0000000000000000000000000000000000000000000000000000000000000000","width":2,"height":1,"capture_mono_ns":200,"generation":"srf-id-demo","window":{"id":"w1","w":2,"h":1}}`), nil
	}
	return nil, fault("unexpected", "unexpected test operation")
}
func awaitSignal(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(time.Second):
		t.Fatal("transition timed out")
	}
}
func TestHandoffCancelsDrainsAndReadmits(t *testing.T) {
	r := &handoffRunner{started: make(chan struct{}), cancelled: make(chan struct{}), finish: make(chan struct{})}
	m := testManager(t, &scriptRunner{})
	m.runner = r
	id := createID(t, m)
	ctx := context.Background()
	input := func(proposal string) Request {
		return req("input", `{"surface_id":"`+id+`","proposal_id":"`+proposal+`","action":{"type":"click","x":1,"y":0,"button":"left"}}`)
	}
	done := make(chan error, 1)
	go func() {
		out, e := m.Handle(ctx, input("p1"))
		if len(out) > 0 {
			done <- fault("unexpected", "cancelled input applied")
			return
		}
		done <- e
	}()
	awaitSignal(t, r.started)
	_, e := m.Handle(ctx, req("take_control", `{"surface_id":"`+id+`","owner":"human"}`))
	if e != nil {
		t.Fatal(e)
	}
	awaitSignal(t, r.cancelled)
	ready, e := m.ControlReady(id)
	if e != nil || ready {
		t.Fatalf("control ready before drain: %v", e)
	}
	_, e = m.Handle(ctx, input("p2"))
	requireFault(t, e, "SURFACE_NOT_AGENT_CONTROLLED")
	_, e = m.Handle(ctx, req("release_control", `{"surface_id":"`+id+`"}`))
	requireFault(t, e, "POLICY")
	requireFault(t, m.DrainInput(id, "p1"), "POLICY")
	close(r.finish)
	select {
	case e = <-done:
		requireFault(t, e, "SURFACE_NOT_AGENT_CONTROLLED")
	case <-time.After(time.Second):
		t.Fatal("cancel completion timed out")
	}
	_, e = m.Handle(ctx, req("release_control", `{"surface_id":"`+id+`"}`))
	requireFault(t, e, "POLICY")
	requireFault(t, m.DrainInput("other", "p1"), "POLICY")
	if e = m.DrainInput(id, "p1"); e != nil {
		t.Fatal(e)
	}
	ready, e = m.ControlReady(id)
	if e != nil || !ready {
		t.Fatalf("control not ready after drain: %v", e)
	}
	requireFault(t, m.DrainInput(id, "p1"), "POLICY")
	_, e = m.Handle(ctx, req("release_control", `{"surface_id":"`+id+`"}`))
	if e != nil {
		t.Fatal(e)
	}
	_, e = m.Handle(ctx, input("p2"))
	requireFault(t, e, "POLICY")
	if _, _, e = m.Capture(ctx, id); e != nil {
		t.Fatal(e)
	}
	_, e = m.Handle(ctx, input("p1"))
	requireFault(t, e, "POLICY")
	out, e := m.Handle(ctx, input("p2"))
	if e != nil || len(out) != 1 {
		t.Fatalf("readmission failed: %v", e)
	}
	_, e = m.Handle(ctx, input("p2"))
	requireFault(t, e, "POLICY")
	if r.inputs.Load() != 2 {
		t.Fatal("refused input dispatched")
	}
}
func TestHandoffNegativeControls(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	ctx := context.Background()
	for _, op := range []string{"take_control", "release_control"} {
		params := `{"surface_id":"unknown"}`
		if op == "take_control" {
			params = `{"surface_id":"unknown","owner":"human"}`
		}
		_, e := m.Handle(ctx, req(op, params))
		requireFault(t, e, "surface")
	}
	for _, owner := range []string{"agent", "shared", ""} {
		_, e := m.Handle(ctx, req("take_control", `{"surface_id":"`+id+`","owner":"`+owner+`"}`))
		requireFault(t, e, "POLICY")
	}
	for _, op := range []string{"frame_subscribe", "frame_unsubscribe", "record_start", "record_stop"} {
		_, e := m.Handle(ctx, req(op, `{}`))
		requireFault(t, e, "unsupported")
	}
	if _, e := m.ControlReady("unknown"); e == nil {
		t.Fatal("unknown control ready")
	}
	_, e := m.Handle(ctx, req("release_control", `{"surface_id":"`+id+`","owner":"human"}`))
	if e == nil {
		t.Fatal("release accepted extra field")
	}
}
func TestDestroyDrainTransitionRecovery(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	ctx := context.Background()
	calls := len(r.calls)
	m.cfg.BeforeDestroy = func(ctx context.Context, got string) error {
		if got != id {
			t.Fatal("wrong drain identity")
		}
		if _, _, e := m.Capture(ctx, id); e == nil {
			t.Fatal("capture admitted while draining")
		}
		_, e := m.Handle(ctx, req("destroy", `{"surface_id":"`+id+`"}`))
		requireFault(t, e, "surface")
		return fault("drain", "test drain failure")
	}
	_, e := m.Handle(ctx, req("destroy", `{"surface_id":"`+id+`"}`))
	requireFault(t, e, "drain")
	if m.bindings[id].Surface.State != "active" || len(r.calls) != calls {
		t.Fatal("drain failure changed native lifecycle")
	}
	m.cfg.BeforeDestroy = func(context.Context, string) error { return nil }
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":false}`)
	_, e = m.Handle(ctx, req("destroy", `{"surface_id":"`+id+`"}`))
	if e == nil {
		t.Fatal("unverified removal accepted")
	}
	if _, _, e = m.Capture(ctx, id); e == nil {
		t.Fatal("capture reopened after uncertain stop")
	}
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	out, e := m.Handle(ctx, req("destroy", `{"surface_id":"`+id+`"}`))
	if e != nil || len(out) != 1 {
		t.Fatalf("removal recovery: %v", e)
	}
}
func TestHoldingsIndependentProof(t *testing.T) {
	r := &scriptRunner{output: []byte(`{"input_mono_ns":200}`)}
	m := testManager(t, r)
	id := holdingsBinding(m)
	ctx := context.Background()
	input := func(p string) Request {
		return req("input", `{"surface_id":"`+id+`","proposal_id":"`+p+`","action":{"type":"key","keys":["a"]}}`)
	}
	_, e := m.Handle(ctx, input("no-proof"))
	requireFault(t, e, "input")
	m.cfg.VerifyHoldingsInput = func(_ context.Context, b Binding, p string, action json.RawMessage, stamp uint64) error {
		if b.Surface.SurfaceID != id || p != "proved" || stamp != 200 {
			return fault("input", "correlation mismatch")
		}
		var got struct {
			Type string
			Keys []string
		}
		if e := json.Unmarshal(action, &got); e != nil || got.Type != "key" || len(got.Keys) != 1 || got.Keys[0] != "a" {
			return fault("input", "operation mismatch")
		}
		return nil
	}
	_, e = m.Handle(ctx, input("wrong"))
	requireFault(t, e, "input")
	out, e := m.Handle(ctx, input("proved"))
	if e != nil || len(out) != 1 {
		t.Fatalf("verified input: %v", e)
	}
	r.output = []byte(`{"stopped":"srf-ng-hcap-hc-0123456789ab-1"}`)
	_, e = m.Handle(ctx, req("destroy", `{"surface_id":"`+id+`"}`))
	requireFault(t, e, "uncertain")
	m.cfg.VerifyHoldingsRemoval = func(_ context.Context, b Binding) error {
		if b.Container != "srf-ng-hcap-hc-0123456789ab-1" {
			t.Fatal("wrong removal binding")
		}
		return fault("uncertain", "still present")
	}
	_, e = m.Handle(ctx, req("destroy", `{"surface_id":"`+id+`"}`))
	requireFault(t, e, "uncertain")
	m.cfg.VerifyHoldingsRemoval = func(context.Context, Binding) error { return nil }
	out, e = m.Handle(ctx, req("destroy", `{"surface_id":"`+id+`"}`))
	if e != nil || len(out) != 1 {
		t.Fatalf("verified removal: %v", e)
	}
}

func TestTakeoverCancelsHoldingsVerification(t *testing.T) {
	r := &scriptRunner{output: []byte(`{"input_mono_ns":200}`)}
	m := testManager(t, r)
	id := holdingsBinding(m)
	started := make(chan struct{})
	done := make(chan error, 1)
	m.cfg.VerifyHoldingsInput = func(ctx context.Context, _ Binding, _ string, _ json.RawMessage, _ uint64) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	go func() {
		out, e := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"verify-pending","action":{"type":"key","keys":["a"]}}`))
		if len(out) != 0 {
			done <- fault("unexpected", "cancelled verification emitted input_applied")
			return
		}
		done <- e
	}()
	awaitSignal(t, started)
	_, e := m.Handle(context.Background(), req("take_control", `{"surface_id":"`+id+`","owner":"human"}`))
	if e != nil {
		t.Fatal(e)
	}
	select {
	case e = <-done:
		requireFault(t, e, "SURFACE_NOT_AGENT_CONTROLLED")
	case <-time.After(time.Second):
		t.Fatal("verification cancellation blocked")
	}
	if e = m.DrainInput(id, "verify-pending"); e != nil {
		t.Fatal(e)
	}
	ready, e := m.ControlReady(id)
	if e != nil || !ready {
		t.Fatalf("verification drain: %v", e)
	}
}
