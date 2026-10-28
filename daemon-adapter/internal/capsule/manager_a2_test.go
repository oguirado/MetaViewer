package capsule

import (
	"context"
	"encoding/json"
	"strconv"
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
	calls := 0
	m.runner = a2Runner(func(context.Context, []string, []byte) ([]byte, error) {
		calls++
		close(started)
		<-finish
		return []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
	})
	done := make(chan error, 1)
	go func() {
		out, e := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"a2","action":{"type":"key","keys":["a"]}}`))
		if len(out) != 0 {
			e = fault("test", "lost input emitted an applied event")
		}
		done <- e
	}()
	awaitSignal(t, started)
	ev, e := m.MarkLost(id, true)
	close(finish)
	inputErr := <-done
	if e != nil || len(ev) == 0 {
		t.Fatalf("pending input did not mark lost: %s %v", ev, e)
	}
	requireFault(t, inputErr, "surface")
	if m.hasPending(id) || len(m.pending) != 0 {
		t.Fatal("lost input was not drained")
	}
	if ev, e = m.MarkLost(id, true); e != nil || len(ev) != 0 {
		t.Fatalf("repeated loss was not idempotent: %s %v", ev, e)
	}
	for _, proposal := range []string{"a2", "after-lost"} {
		out, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"`+proposal+`","action":{"type":"key","keys":["a"]}}`))
		requireFault(t, err, "surface")
		if len(out) != 0 || calls != 1 {
			t.Fatal("input executed or settled again after loss")
		}
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

// RV8-ADAPTER (P2): terminal destroy must delete per-surface inputEpochs and refresh
// entries while keeping m.used intact. Negative control: omitting destroy retains them.
func TestRV8DestroyCleansPerSurfaceEpochAndRefreshMaps(t *testing.T) {
	runLoop := func(t *testing.T, withDestroy bool) *Manager {
		t.Helper()
		m := testManager(t, &scriptRunner{})
		m.cfg.MaxSurfaces = 1000
		for i := range 1000 {
			pid := "demo-" + strconv.Itoa(i)
			m.cfg.Profiles[pid] = m.cfg.Profiles["demo"]
			cid := "srf-id-demo-" + strconv.Itoa(i)
			m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
				switch args[1] {
				case "start":
					return []byte(`{"container":"` + cid + `","run_id":"run-` + strconv.Itoa(i) + `","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1}]}`), nil
				case "input":
					return []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
				case "stop":
					return []byte(`{"stopped":"` + cid + `","removed_verified":true}`), nil
				}
				t.Fatalf("unexpected command: %v", args)
				return nil, nil
			})
			out, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"`+pid+`","geometry":{"w":2,"h":1}}`))
			if err != nil {
				t.Fatal(err)
			}
			var ev struct {
				Data struct {
					Surface Surface `json:"surface"`
				} `json:"data"`
			}
			if err := json.Unmarshal(out[0], &ev); err != nil {
				t.Fatal(err)
			}
			sid := ev.Data.Surface.SurfaceID
			prop := "prop-" + strconv.Itoa(i)
			if _, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+sid+`","proposal_id":"`+prop+`","action":{"type":"key","keys":["a"]}}`)); err != nil {
				t.Fatal(err)
			}
			if _, err := m.Handle(context.Background(), req("take_control", `{"surface_id":"`+sid+`","owner":"human"}`)); err != nil {
				t.Fatal(err)
			}
			if _, err := m.Handle(context.Background(), req("release_control", `{"surface_id":"`+sid+`"}`)); err != nil {
				t.Fatal(err)
			}
			if withDestroy {
				if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+sid+`"}`)); err != nil {
					t.Fatal(err)
				}
			}
		}
		return m
	}

	// Negative control: without destroy, inputEpochs and refresh retain 1000 entries.
	neg := runLoop(t, false)
	if len(neg.inputEpochs) == 0 || len(neg.refresh) == 0 {
		t.Fatalf("negative control failed: len(inputEpochs)=%d len(refresh)=%d, want >0", len(neg.inputEpochs), len(neg.refresh))
	}

	// Positive regression: with destroy, inputEpochs and refresh are cleaned to 0 while m.used stays intact.
	pos := runLoop(t, true)
	if len(pos.inputEpochs) != 0 || len(pos.refresh) != 0 {
		t.Fatalf("leaked per-surface maps after destroy: len(inputEpochs)=%d len(refresh)=%d, want 0", len(pos.inputEpochs), len(pos.refresh))
	}
	if len(pos.used) != 1000 {
		t.Fatalf("replay protection m.used modified: len(used)=%d, want 1000", len(pos.used))
	}
}

type gatedViewBackend struct {
	openStarted chan struct{}
	releaseOpen chan struct{}
	stopCalled  chan string
	opens       int
	stops       int
}

func (g *gatedViewBackend) Open(_ context.Context, container string, _ bool) error {
	g.opens++
	if g.openStarted != nil {
		close(g.openStarted)
	}
	if g.releaseOpen != nil {
		<-g.releaseOpen
	}
	_ = container
	return nil
}

func (g *gatedViewBackend) Stop(_ context.Context, container string) error {
	g.stops++
	if g.stopCalled != nil {
		g.stopCalled <- container
	}
	return nil
}

func TestLateViewOpenRechecksSurfaceState(t *testing.T) {
	for _, transition := range []string{"active", "destroy", "mark-lost"} {
		t.Run(transition, func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			vb := &gatedViewBackend{
				stopCalled: make(chan string, 2),
			}
			if transition != "active" {
				vb.openStarted = make(chan struct{})
				vb.releaseOpen = make(chan struct{})
			}
			m.cfg.View = vb
			id := createID(t, m)

			if transition == "active" {
				out, err := m.Handle(context.Background(), req("view", `{"surface_id":"`+id+`"}`))
				if err != nil || len(out) != 1 {
					t.Fatalf("active view open failed: %s %v", out, err)
				}
				if !m.views["srf-id-demo"] || vb.opens != 1 || vb.stops != 0 {
					t.Fatalf("active view not registered: views=%v opens=%d stops=%d", m.views, vb.opens, vb.stops)
				}
				return
			}

			viewDone := make(chan struct {
				out []json.RawMessage
				err error
			}, 1)
			go func() {
				out, err := m.Handle(context.Background(), req("view", `{"surface_id":"`+id+`"}`))
				viewDone <- struct {
					out []json.RawMessage
					err error
				}{out, err}
			}()
			awaitSignal(t, vb.openStarted)

			if transition == "destroy" {
				r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
				if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := m.MarkLost(id, true); err != nil {
					t.Fatal(err)
				}
			}

			close(vb.releaseOpen)
			res := <-viewDone
			requireFault(t, res.err, "surface")
			if len(res.out) != 0 {
				t.Fatalf("late view emitted success event: %s", res.out)
			}
			if m.views["srf-id-demo"] {
				t.Fatal("late view registered in m.views after terminal transition")
			}
			if vb.stops != 1 {
				t.Fatalf("expected late view to be stopped once, got %d", vb.stops)
			}
		})
	}
}
