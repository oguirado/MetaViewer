package capsule

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"metaviewer/daemon-adapter/internal/cli"
)

// All production pendingHostLost writers follow markLostLocked(active, true)
// under mu. Delivery consumes pending before a failed delivery can clear proof.
func TestLostStopPendingProofAndDelivery(t *testing.T) {
	for _, cause := range []string{"capture", "input"} {
		t.Run(cause, func(t *testing.T) {
			m, r, profile := resizeFixture(t)
			id := resizeAttach(t, m, r, profile, 2, 1)
			closed := &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: window closed"}
			if cause == "capture" {
				r.captureErr = closed
				if _, _, err := m.Capture(context.Background(), id); err == nil {
					t.Fatal("closed capture succeeded")
				}
			} else {
				r.inputErr = closed
				params, _ := jsonParams(id, "first", "agent", map[string]any{"type": "click", "x": 0, "y": 0, "button": "left"})
				if _, err := m.Handle(context.Background(), req("input", params)); err == nil {
					t.Fatal("closed input succeeded")
				}
			}
			before := m.bindings[id]
			if !before.ConfirmedAbsent || len(before.pendingHostLost) == 0 || !m.hasPendingHostLossLocked(before) {
				t.Fatal("pending loss lacks absence proof")
			}
			calls := len(r.calls)
			params, _ := jsonParams(id, "repeat", "agent", map[string]any{"type": "click", "x": 0, "y": 0, "button": "left"})
			if _, err := m.Handle(context.Background(), req("input", params)); err == nil {
				t.Fatal("lost input succeeded")
			}
			if len(r.calls) != calls || !bytes.Equal(m.bindings[id].pendingHostLost, before.pendingHostLost) {
				t.Fatal("repeated input overwrote pending loss or performed IO")
			}
			ev, err := m.BeginMarkLost(id)
			if err != nil || !bytes.Equal(ev, before.pendingHostLost) {
				t.Fatalf("pending event not delivered: %s %v", ev, err)
			}
			m.CompleteLost(id, false)
			after := m.bindings[id]
			if after.ConfirmedAbsent || len(after.pendingHostLost) != 0 || m.hasPendingHostLossLocked(after) {
				t.Fatal("failed delivery retained pending event without proof")
			}
			if ev, err := m.MarkLost(id, false); err == nil || len(ev) != 0 {
				t.Fatal("unconfirmed absence created a pending loss")
			}
		})
	}
}

type lostStopRunner struct {
	*hostWindowFakeRunner
	onInput func()
}

func (r *lostStopRunner) Run(ctx context.Context, argv []string, input []byte) ([]byte, error) {
	if len(argv) > 1 && argv[1] == "input" {
		r.onInput()
	}
	return r.hostWindowFakeRunner.Run(ctx, argv, input)
}

// The CLI runs without mu. Inject a fenced binding during that call to prove
// input completion hits its active-state guard before markLostLocked.
func TestLostStopInputCompletionPreservesConcurrentLoss(t *testing.T) {
	m, r, profile := resizeFixture(t)
	id := resizeAttach(t, m, r, profile, 2, 1)
	r.inputErr = &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: window closed"}
	var pending json.RawMessage
	m.runner = &lostStopRunner{hostWindowFakeRunner: r, onInput: func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		ev, err := m.markLostLocked(id, true, false)
		if err != nil || len(ev) == 0 {
			t.Fatalf("concurrent loss failed: %s %v", ev, err)
		}
		b := m.bindings[id]
		b.pendingHostLost = ev
		m.bindings[id] = b
		pending = append(json.RawMessage(nil), ev...)
	}}
	params, _ := jsonParams(id, "racing", "agent", map[string]any{"type": "click", "x": 0, "y": 0, "button": "left"})
	if _, err := m.Handle(context.Background(), req("input", params)); err == nil {
		t.Fatal("concurrently lost input succeeded")
	}
	if !bytes.Equal(m.bindings[id].pendingHostLost, pending) {
		t.Fatal("input completion erased concurrent pending loss")
	}
	ev, err := m.BeginMarkLost(id)
	if err != nil || !bytes.Equal(ev, pending) {
		t.Fatalf("concurrent event not deliverable: %s %v", ev, err)
	}
	m.CompleteLost(id, true)
}
