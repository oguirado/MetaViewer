package frames

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
	"time"
)

type windowClosePollSource struct {
	*capsule.Manager
	source  Source
	entered chan struct{}
	resume  chan struct{}
}

func (s *windowClosePollSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	select {
	case s.entered <- struct{}{}:
	case <-ctx.Done():
		return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
	}
	select {
	case <-s.resume:
		return s.source.Capture(ctx, id)
	case <-ctx.Done():
		return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
	}
}

// Replay an independent capture noticing closure before VERIFIED's next poll.
// The pending transition must precede the capture error on both transports.
func TestWindowCloseBeforeSubscriptionPoll(t *testing.T) {
	for _, transport := range []string{"pair", "ring"} {
		t.Run(transport, func(t *testing.T) {
			ring, runner, binding := vmPairFixture(t, "host-window")
			id := binding.Surface.SurfaceID
			var source Source = ring.Manager
			if transport == "ring" {
				source = ring
			}
			root, _, _ := ramFixture(t)
			events := make(chan json.RawMessage, 4)
			poll := &windowClosePollSource{Manager: ring.Manager, source: source, entered: make(chan struct{}, 1), resume: make(chan struct{})}
			sub, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, poll, publisher(t, root), func(_ context.Context, msg json.RawMessage) error {
				events <- append(json.RawMessage(nil), msg...)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = sub.Close(context.Background()) })
			if err = sub.Subscribe(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			select {
			case <-poll.entered:
			case <-time.After(time.Second):
				t.Fatal("subscription did not start while window was active")
			}
			runner.frameErr = &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: window closed"}
			lost, _, err := ring.Manager.Capture(context.Background(), id)
			if err == nil || lost.Surface.State != "lost" {
				t.Fatalf("closure not witnessed: %+v %v", lost, err)
			}
			calls := len(runner.calls)
			close(poll.resume)
			for _, want := range []string{"state_changed", "error"} {
				select {
				case msg := <-events:
					var ev struct {
						Event string
						Data  struct{ Surface capsule.Surface }
					}
					if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != want {
						t.Fatalf("want %s, got %s (%v)", want, msg, err)
					}
					if want == "state_changed" && (ev.Data.Surface.State != "lost" || ev.Data.Surface.SurfaceID != id) {
						t.Fatalf("wrong lost surface: %s", msg)
					}
				case <-time.After(time.Second):
					t.Fatalf("missing %s", want)
				}
			}
			if err := sub.Unsubscribe(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			if len(runner.calls) != calls {
				t.Fatal("closed window invoked native capture again")
			}
			if ev, err := ring.MarkHostWindowLost(id, "window closed"); err != nil || len(ev) != 0 {
				t.Fatalf("DISPLAY duplicated delivered loss: %s %v", ev, err)
			}
		})
	}
}
