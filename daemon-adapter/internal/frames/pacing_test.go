package frames

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestFoldedSubscriptionPacing(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	b.Surface.Visibility = "folded"
	source := &captureSource{b: b, f: f}
	const poll = 100 * time.Millisecond
	events := make(chan json.RawMessage, 32)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions: 1, PollInterval: poll,
		CaptureTimeout: time.Second, ShutdownTimeout: time.Second,
	}, source, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case events <- append(json.RawMessage(nil), msg...):
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := subs.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	started := time.Now()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	if err := subs.Subscribe(context.Background(), b.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
	var previous Ref
	for i := 0; i < 4; i++ {
		select {
		case msg := <-events:
			var event struct {
				Schema string `json:"schema"`
				Event  string `json:"event"`
				Data   struct {
					FrameRef Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if err := json.Unmarshal(msg, &event); err != nil {
				t.Fatal(err)
			}
			ref := event.Data.FrameRef
			if event.Schema != "surface_event/v0.2" || event.Event != "frame_ready" || ref.SurfaceID != b.Surface.SurfaceID || ref.Tick <= previous.Tick || ref.Generation <= previous.Generation {
				t.Fatalf("folded frame did not progress: %s", msg)
			}
			previous = ref
		case <-deadline.C:
			t.Fatal("folded subscription failed to emit four advancing frames within two seconds")
		}
	}
	if time.Since(started) >= 2*time.Second {
		t.Fatal("folded subscription exceeded pacing deadline")
	}
	if err := subs.Unsubscribe(context.Background(), b.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
	// Snapshot after the drain boundary; buffered events from before unsubscribe
	// are allowed, but no subsequent capture, publication or delivery is allowed.
	source.mu.Lock()
	calls := source.calls
	source.mu.Unlock()
	p.mu.Lock()
	generation := p.next
	p.mu.Unlock()
	queued := len(events)
	observation := time.NewTimer(3 * poll)
	defer observation.Stop()
	<-observation.C
	source.mu.Lock()
	afterCalls := source.calls
	source.mu.Unlock()
	p.mu.Lock()
	afterGeneration := p.next
	p.mu.Unlock()
	if afterCalls != calls || afterGeneration != generation || len(events) != queued {
		t.Fatalf("activity after unsubscribe: captures %d -> %d, generation %d -> %d, queued %d -> %d", calls, afterCalls, generation, afterGeneration, queued, len(events))
	}
}
