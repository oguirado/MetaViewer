package capsule

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type a2Runner func(context.Context, []string, []byte) ([]byte, error)

func (f a2Runner) Run(ctx context.Context, args []string, in []byte) ([]byte, error) {
	return f(ctx, args, in)
}

func TestA2ReadinessCompensation(t *testing.T) {
	for _, stop := range []string{`{"stopped":"srf-id-demo","removed_verified":true}`, `{"stopped":"srf-id-demo","removed_verified":false}`, `{}`} {
		t.Run(stop, func(t *testing.T) {
			m := testManager(t, &scriptRunner{})
			starts, stops := 0, 0
			m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
				switch args[1] {
				case "start":
					starts++
					if starts == 1 {
						return []byte(strings.Replace(startOK, `"w":2`, `"w":0`, 1)), nil
					}
					return []byte(startOK), nil
				case "stop":
					stops++
					if len(args) != 4 || args[2] != "--container" || args[3] != "srf-id-demo" {
						t.Fatalf("unsafe compensation: %v", args)
					}
					return []byte(stop), nil
				}
				t.Fatalf("unexpected command: %v", args)
				return nil, nil
			})
			out, err := m.Handle(context.Background(), req("create", createDemo))
			if err == nil || len(out) != 0 {
				t.Fatal("invalid readiness committed")
			}
			if stops != 1 {
				t.Fatalf("compensation stops = %d, want 1", stops)
			}
			if strings.Contains(stop, `true`) {
				requireFault(t, err, "malformed_cli")
				if m.quarantined["demo"] {
					t.Fatal("verified cleanup retained quarantine")
				}
				createID(t, m)
			} else {
				requireFault(t, err, "uncertain")
				if !m.quarantined["demo"] {
					t.Fatal("unverified cleanup released quarantine")
				}
				_, err = m.Handle(context.Background(), req("create", createDemo))
				requireFault(t, err, "uncertain")
				if starts != 1 {
					t.Fatal("uncertain create retried")
				}
			}
		})
	}
}

func TestA2MarkLostDuringInput(t *testing.T) {
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	id := createID(t, m)
	started, finish := make(chan struct{}), make(chan struct{})
	m.runner = a2Runner(func(context.Context, []string, []byte) ([]byte, error) {
		close(started)
		<-finish
		return []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
	})
	done := make(chan error, 1)
	go func() {
		out, e := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"a2","action":{"type":"key","keys":["a"]}}`))
		if e == nil && len(out) != 1 {
			e = fault("test", "missing applied event")
		}
		done <- e
	}()
	awaitSignal(t, started)
	ev, e := m.MarkLost(id, true)
	close(finish)
	inputErr := <-done
	requireFault(t, e, "POLICY")
	if len(ev) != 0 {
		t.Fatal("pending input marked lost")
	}
	if inputErr != nil {
		t.Fatal(inputErr)
	}
	if _, e = m.MarkLost(id, true); e != nil {
		t.Fatal(e)
	}
}

func TestA2TerminalInputRefused(t *testing.T) {
	for _, state := range []string{"lost", "destroyed"} {
		t.Run(state, func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			id := createID(t, m)
			if state == "lost" {
				if _, e := m.MarkLost(id, true); e != nil {
					t.Fatal(e)
				}
			} else {
				r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
				if _, e := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); e != nil {
					t.Fatal(e)
				}
			}
			calls := len(r.calls)
			out, e := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"terminal","action":{"type":"key","keys":["a"]}}`))
			requireFault(t, e, "surface")
			if len(out) != 0 || len(r.calls) != calls {
				t.Fatal("terminal input dispatched or applied")
			}
		})
	}
}

func TestA2TerminalDuringHoldingsVerification(t *testing.T) {
	for _, state := range []string{"lost", "destroyed"} {
		t.Run(state, func(t *testing.T) {
			m := testManager(t, &scriptRunner{output: []byte(`{"input_mono_ns":200}`)})
			id := holdingsBinding(m)
			m.cfg.VerifyHoldingsInput = func(context.Context, Binding, string, json.RawMessage, uint64) error {
				// Simulate a terminal transition at the external verifier boundary.
				m.mu.Lock()
				b := m.bindings[id]
				b.Surface.State = state
				m.bindings[id] = b
				m.mu.Unlock()
				return nil
			}
			out, e := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"terminal-verify","action":{"type":"key","keys":["a"]}}`))
			requireFault(t, e, "surface")
			if len(out) != 0 {
				t.Fatal("terminal verification emitted input_applied")
			}
		})
	}
}

func TestA2UnsafeCleanupIdentityStaysQuarantined(t *testing.T) {
	for _, reply := range []string{`{"container":"srf-id-demo","run_id":"demo-run",`, `{"container":"../../other","run_id":"demo-run"}`, startOK} {
		t.Run(reply, func(t *testing.T) {
			r := &scriptRunner{output: []byte(reply)}
			m := testManager(t, r)
			if reply == startOK {
				m.bindings["other"] = Binding{Container: "srf-id-demo", Surface: Surface{State: "active", ProfileID: "other"}}
			}
			_, e := m.Handle(context.Background(), req("create", createDemo))
			requireFault(t, e, "uncertain")
			if len(r.calls) != 1 || !m.quarantined["demo"] {
				t.Fatal("unsafe identity stopped or quarantine released")
			}
		})
	}
}

func TestA2HoldingsReadinessCompensation(t *testing.T) {
	for _, proved := range []bool{false, true} {
		t.Run(map[bool]string{false: "uncertain", true: "proved"}[proved], func(t *testing.T) {
			m := testManager(t, &scriptRunner{})
			id := holdingsBinding(m)
			delete(m.bindings, id)
			starts, stops := 0, 0
			m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
				if args[1] == "start" {
					starts++
					return []byte(`[{"slot":1,"container":"srf-ng-hcap-hc-0123456789ab-1","run_id":"hc-0123456789ab","display":":100","width":2,"height":1,"ready_line":"","ready_ms":0,"frames_dir":"/dev/shm/test/frames"}]`), nil
				}
				if args[1] == "stop" {
					stops++
					return []byte(`{"stopped":"srf-ng-hcap-hc-0123456789ab-1"}`), nil
				}
				t.Fatalf("unexpected: %v", args)
				return nil, nil
			})
			if proved {
				m.cfg.VerifyHoldingsRemoval = func(_ context.Context, b Binding) error {
					if b.RunID != "hc-0123456789ab" {
						t.Fatal("missing cleanup correlation")
					}
					return nil
				}
			}
			out, e := m.Handle(context.Background(), req("create", `{"kind":"game_capsule","profile_id":"demo","geometry":{"w":2,"h":1}}`))
			if stops != 1 || starts != 1 || len(out) != 0 {
				t.Fatal("missing compensation or invalid readiness committed")
			}
			if proved {
				requireFault(t, e, "malformed_cli")
			} else {
				requireFault(t, e, "uncertain")
			}
			if m.quarantined["demo"] == proved {
				t.Fatal("quarantine disagrees with independent proof")
			}
		})
	}
}
