package capsule

import (
	"context"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
)

func TestWindowClosePendingLossCaptureEntries(t *testing.T) {
	for _, kind := range []string{"host-window", "host-xpra"} {
		for _, cause := range []string{"capture", "input"} {
			t.Run(kind+"/"+cause, func(t *testing.T) {
				m, r, profile := resizeFixture(t)
				id := resizeAttach(t, m, r, profile, 2, 1)
				b := m.bindings[id]
				b.NativeKind = kind
				m.bindings[id] = b
				closed := &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: window closed"}
				if cause == "capture" {
					r.captureErr = closed
					if _, _, err := m.Capture(context.Background(), id); err == nil {
						t.Fatal("closed capture succeeded")
					}
				} else {
					r.inputErr = closed
					params, _ := jsonParams(id, "close-input", "agent", map[string]any{"type": "click", "x": 0, "y": 0, "button": "left"})
					if _, err := m.Handle(context.Background(), req("input", params)); err == nil {
						t.Fatal("closed input succeeded")
					}
				}
				calls := len(r.calls)
				for _, resident := range []bool{false, true} {
					var got Binding
					var err error
					if resident {
						got, _, err = m.CaptureResident(context.Background(), id, func(Binding) (NativeFrame, error) {
							t.Fatal("pending loss read a resident frame")
							return NativeFrame{}, nil
						})
					} else {
						got, _, err = m.Capture(context.Background(), id)
					}
					if err == nil || got.Surface.State != "lost" || !got.ConfirmedAbsent {
						t.Fatalf("pending loss hidden: %+v %v", got, err)
					}
				}
				if len(r.calls) != calls {
					t.Fatal("loss evidence caused native IO")
				}
				if ev, err := m.BeginMarkLost(id); err != nil || len(ev) == 0 {
					t.Fatalf("pending event missing: %s %v", ev, err)
				}
				m.CompleteLost(id, true)
				if got, _, err := m.Capture(context.Background(), id); err == nil || got.Surface.State == "lost" {
					t.Fatal("delivered loss was offered again")
				}
				if _, err := m.SubscriptionBinding(id); err == nil {
					t.Fatal("lost surface admitted a new subscription binding")
				}
			})
		}
	}
}
