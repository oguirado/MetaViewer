package capsule

import (
	"context"
	"encoding/json"
	"testing"
)

func TestNVDuplicateCreateDoesNotSpawn(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	_, err := m.Handle(context.Background(), req("create", createDemo))
	if err == nil || len(r.calls) != 1 {
		t.Fatalf("duplicate spawned: calls=%d err=%v", len(r.calls), err)
	}
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	if _, err = m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
		t.Fatal(err)
	}
	r.output = []byte(startOK)
	createID(t, m)
	if len(r.calls) != 3 {
		t.Fatal("unexpected lifecycle calls")
	}
}

type nvPendingRunner struct{ started, finish chan struct{} }

func (r *nvPendingRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	if args[1] == "start" {
		return []byte(startOK), nil
	}
	if args[1] == "input" {
		close(r.started)
		<-r.finish
		return []byte(`{"surface_id":"w1","kind":"click","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
	}
	return nil, fault("unexpected", "capture dispatched during pending input")
}
func TestNVPendingInputState(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(map[bool]string{false: "capture", true: "lost"}[lost], func(t *testing.T) {
			r := &nvPendingRunner{make(chan struct{}), make(chan struct{})}
			m := testManager(t, &scriptRunner{})
			m.runner = r
			id := createID(t, m)
			done := make(chan error, 1)
			go func() {
				out, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"nv","action":{"type":"click","x":1,"y":0,"button":"left"}}`))
				if lost && len(out) != 0 {
					done <- fault("unexpected", "input_applied on lost surface")
					return
				}
				done <- err
			}()
			awaitSignal(t, r.started)
			if lost {
				if _, err := m.MarkLost(id, true); err != nil {
					t.Fatal(err)
				}
			} else {
				_, _, err := m.Capture(context.Background(), id)
				if err == nil || err.Error() != "POLICY: input must be drained before capture" {
					t.Errorf("capture pending: %v", err)
				}
			}
			close(r.finish)
			err := <-done
			if lost {
				if err == nil || err.Error() == "unexpected: input_applied on lost surface" {
					t.Fatalf("lost completion: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			_, err = m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"nv","action":{"type":"click","x":1,"y":0,"button":"left"}}`))
			if err == nil {
				t.Fatal("proposal replay admitted")
			}
		})
	}
}

func TestNVLostDuringHoldingsProof(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(`{"input_mono_ns":200}`)})
	id := holdingsBinding(m)
	started, finish := make(chan struct{}), make(chan struct{})
	m.cfg.VerifyHoldingsInput = func(context.Context, Binding, string, json.RawMessage, uint64) error {
		close(started)
		<-finish
		return nil
	}
	done := make(chan error, 1)
	go func() {
		out, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"proof","action":{"type":"key","keys":["a"]}}`))
		if len(out) > 0 {
			done <- fault("unexpected", "lost proof emitted input_applied")
			return
		}
		done <- err
	}()
	awaitSignal(t, started)
	if _, err := m.MarkLost(id, true); err != nil {
		t.Fatal(err)
	}
	close(finish)
	requireFault(t, <-done, "surface")
}
