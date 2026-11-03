package frames

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/cli"
	"testing"
	"time"
)

func TestSubscriptionResizeDoesNotConsumeFailureBudget(t *testing.T) {
	root, b, f := ramFixture(t)
	absence := cli.ExitFault("srf-identity-surface", 6, "")
	resize := &cli.Fault{Code: "host_window_resized", Detail: "capture geometry changed"}
	src := &lossAwareCaptureSource{b: b, f: f, failPolls: map[int]error{2: absence, 3: resize, 4: resize, 5: resize, 6: absence, 8: absence, 9: absence}}
	events := make(chan json.RawMessage, 16)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: 10 * time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, src, publisher(t, root), func(ctx context.Context, msg json.RawMessage) error {
		select {
		case events <- msg:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })
	start := time.Now()
	if err = subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"frame_ready", "frame_ready", "state_changed", "error"} {
		select {
		case msg := <-events:
			var ev struct{ Event string }
			if err = json.Unmarshal(msg, &ev); err != nil {
				t.Fatal(err)
			}
			if ev.Event != want {
				t.Fatalf("event %d after resize: got %s, want %s", i, msg, want)
			}
			if i == 1 && time.Since(start) < 50*time.Millisecond {
				t.Fatal("resize retries spun instead of waiting for poll cadence")
			}
		case <-time.After(time.Second):
			t.Fatalf("no %s after resize", want)
		}
	}
	src.mu.Lock()
	defer src.mu.Unlock()
	if src.calls != 9 || src.marked != 1 {
		t.Fatalf("resize affected loss confirmation: calls=%d lost=%d", src.calls, src.marked)
	}
}
