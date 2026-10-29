package capsule

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
	"time"
)

// MUT-V3-WEDGE removes settlement of unavailable stop after ConfirmedAbsent.
func TestV3DestroySettlesNativeAbsence(t *testing.T) {
	for _, holdings := range []bool{false, true} {
		t.Run(map[bool]string{false: "identity", true: "holdings"}[holdings], func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			m.cfg.MaxSurfaces = 1
			identityProfile := m.cfg.Profiles["demo"]
			create := createDemo
			if holdings {
				create = `{"kind":"game_capsule","profile_id":"demo","geometry":{"w":2,"h":1}}`
			}
			var id string
			if holdings {
				id = holdingsBinding(m)
			} else {
				id = createID(t, m)
			}
			destroy := req("destroy", `{"surface_id":"`+id+`"}`)
			// Negative control: unavailable alone is not removal proof.
			r.err = cli.ExitFault("srf-identity-surface", 4, "")
			_, err := m.Handle(context.Background(), destroy)
			requireFault(t, err, "unavailable")
			if m.bindings[id].Surface.State != "lost" || m.bindings[id].ConfirmedAbsent {
				t.Fatal("unavailable stop invented absence proof")
			}
			_, err = m.Handle(context.Background(), req("create", create))
			requireFault(t, err, "binding")

			// Use a fresh active binding: MarkLost accepts independently proven
			// disappearance of an active surface, not an uncertain stop outcome.
			r = &scriptRunner{output: []byte(startOK)}
			m = testManager(t, r)
			m.cfg.MaxSurfaces = 1
			if holdings {
				id = holdingsBinding(m)
			} else {
				id = createID(t, m)
			}
			if _, err = m.MarkLost(id, true); err != nil {
				t.Fatal(err)
			}
			destroy = req("destroy", `{"surface_id":"`+id+`"}`)
			r.err = cli.ExitFault("srf-identity-surface", 4, "")
			if holdings {
				_, err = m.Handle(context.Background(), destroy)
				requireFault(t, err, "uncertain")
				if m.bindings[id].Surface.State != "lost" {
					t.Fatal("Holdings settled without independent removal proof")
				}
				proofs := 0
				m.cfg.VerifyHoldingsRemoval = func(context.Context, Binding) error { proofs++; return nil }
				defer func() {
					if proofs != 1 {
						t.Errorf("independent proofs=%d", proofs)
					}
				}()
			}
			out, err := m.Handle(context.Background(), destroy)
			if err != nil || len(out) != 1 || m.bindings[id].Surface.State != "destroyed" {
				t.Fatalf("proven absence did not settle: %s %v", out, err)
			}
			r.err = nil
			r.output = []byte(startOK)
			m.cfg.Profiles["demo"] = identityProfile
			if createID(t, m) == id {
				t.Fatal("tombstone reused")
			}
		})
	}
}

// MUT-V3-REVIVE omits the recovery token on CompleteLost(false).
func TestV3ReviveRequiresPositiveProbe(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	if _, err := m.BeginMarkLost(id); err != nil {
		t.Fatal(err)
	}
	m.CompleteLost(id, false)
	input := req("input", `{"surface_id":"`+id+`","proposal_id":"revive","action":{"type":"key","keys":["a"]}}`)
	refuse := func() {
		t.Helper()
		n := len(r.calls)
		_, err := m.Handle(context.Background(), input)
		requireFault(t, err, "surface")
		_, _, err = m.Capture(context.Background(), id)
		requireFault(t, err, "surface")
		if len(r.calls) != n {
			t.Fatal("blocked I/O reached native")
		}
	}
	probe := func() {
		t.Helper()
		ticks := make(chan time.Time, 1)
		ticks <- time.Time{}
		close(ticks)
		if err := m.monitorLiveness(context.Background(), ticks, func(context.Context, json.RawMessage) error { return nil }); err != nil {
			t.Fatal(err)
		}
	}
	r.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
	refuse()
	r.err = fault("uncertain", "unknown probe")
	probe()
	refuse()
	r.err = nil
	r.output = []byte(`{}`)
	probe()
	refuse()
	r.err = cli.ExitFault("srf-identity-surface", 4, "")
	probe()
	refuse()
	frame, _ := (&handoffRunner{}).Run(context.Background(), []string{"native", "frame"}, nil)
	r.err = nil
	r.output = frame
	probe()
	if _, _, err := m.Capture(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	r.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
	if _, err := m.Handle(context.Background(), input); err != nil {
		t.Fatal(err)
	}
}

// MUT-V6-NOID drops the dispatched Container/RunID comparisons.
func TestV6InputPostFlightIdentity(t *testing.T) {
	for _, field := range []string{"unchanged", "container", "run"} {
		t.Run(field, func(t *testing.T) {
			m := testManager(t, &scriptRunner{output: []byte(startOK)})
			id := createID(t, m)
			m.runner = a2Runner(func(context.Context, []string, []byte) ([]byte, error) {
				m.mu.Lock()
				b := m.bindings[id]
				if field == "container" {
					b.Container = "srf-id-other"
				}
				if field == "run" {
					b.RunID = "different-run"
				}
				m.bindings[id] = b
				m.mu.Unlock()
				return []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
			})
			out, err := m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"identity","action":{"type":"key","keys":["a"]}}`))
			if field == "unchanged" {
				if err != nil || len(out) == 0 {
					t.Fatalf("valid receipt rejected: %v", err)
				}
				return
			}
			requireFault(t, err, "surface")
			if len(out) != 0 {
				t.Fatal("changed identity emitted receipt")
			}
		})
	}
}
