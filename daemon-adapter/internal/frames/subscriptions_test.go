package frames

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

type captureSource struct {
	mu    sync.Mutex
	b     capsule.Binding
	f     capsule.NativeFrame
	err   error
	calls int
}

func (s *captureSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.f.Seq++
	return s.b, s.f, s.err
}
func TestSubscriptions(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	b.Surface.Visibility = "folded"
	source := &captureSource{b: b, f: f}
	events := make(chan json.RawMessage, 8)
	subs, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case events <- msg:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := subs.Close(context.Background()); e != nil {
			t.Error(e)
		}
	})
	if e = subs.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	if e = subs.Subscribe(context.Background(), "b"); e == nil {
		t.Fatal("subscription cap ignored")
	}
	var previous uint64
	for i := 0; i < 3; i++ {
		select {
		case msg := <-events:
			var ev struct {
				Event string `json:"event"`
				Data  struct {
					FrameRef Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if e = json.Unmarshal(msg, &ev); e != nil {
				t.Fatal(e)
			}
			if ev.Event != "frame_ready" || ev.Data.FrameRef.Tick <= previous {
				t.Fatal("folded capture stopped progressing")
			}
			previous = ev.Data.FrameRef.Tick
		case <-time.After(time.Second):
			t.Fatal("folded capture stalled")
		}
	}
	if e = subs.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	source.mu.Lock()
	calls := source.calls
	source.mu.Unlock()
	if e = subs.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal("late unsubscribe refused")
	}
	source.mu.Lock()
	if source.calls != calls {
		t.Fatal("capture after unsubscribe")
	}
	source.mu.Unlock()
}
func TestSubscriptionFailure(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	source := &captureSource{b: b, f: f, err: errors.New("capture unavailable")}
	delivered := make(chan json.RawMessage, 1)
	subs, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, p, func(ctx context.Context, msg json.RawMessage) error { delivered <- msg; return nil })
	if e != nil {
		t.Fatal(e)
	}
	if e = subs.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	select {
	case msg := <-delivered:
		var event map[string]json.RawMessage
		if e = json.Unmarshal(msg, &event); e != nil {
			t.Fatal(e)
		}
		if string(event["event"]) != `"error"` {
			t.Fatal("capture failure emitted fabricated frame")
		}
	case <-time.After(time.Second):
		t.Fatal("missing failure event")
	}
	if e = subs.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	if e = subs.Close(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e = subs.Subscribe(context.Background(), "a"); e == nil {
		t.Fatal("closed service accepted subscription")
	}
}

type blockedSource struct {
	entered chan struct{}
	release chan struct{}
}

func (s *blockedSource) Capture(context.Context, string) (capsule.Binding, capsule.NativeFrame, error) {
	close(s.entered)
	<-s.release
	return capsule.Binding{}, capsule.NativeFrame{}, errors.New("released")
}
func TestSubscriptionShutdownBound(t *testing.T) {
	root, _, _ := ramFixture(t)
	p := publisher(t, root)
	source := &blockedSource{entered: make(chan struct{}), release: make(chan struct{})}
	s, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: 10 * time.Millisecond}, source, p, func(context.Context, json.RawMessage) error { t.Error("emitted after cancellation"); return nil })
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	select {
	case <-source.entered:
	case <-time.After(time.Second):
		close(source.release)
		t.Fatal("capture never started")
	}
	e = s.Close(context.Background())
	close(source.release)
	if !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal("blocked source silently passed shutdown gate")
	}
	if e = s.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
}
func TestSubscriptionDeliveryFailure(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	source := &captureSource{b: b, f: f}
	sentinel := errors.New("delivery refused")
	delivered := make(chan json.RawMessage, 8)
	var mu sync.Mutex
	refuse := true
	s, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case delivered <- msg:
		case <-ctx.Done():
			return ctx.Err()
		}
		mu.Lock()
		defer mu.Unlock()
		if refuse {
			return sentinel
		}
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := s.Close(context.Background()); e != nil {
			t.Error(e)
		}
	})
	if e = s.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	deadline := time.After(time.Second)
	for {
		s.mu.Lock()
		_, active := s.tasks["a"]
		s.mu.Unlock()
		if !active {
			break
		}
		select {
		case <-deadline:
			t.Fatal("delivery failure failed to remove subscription")
		case <-time.After(time.Millisecond):
		}
	}
	if !errors.Is(s.TerminalError("a"), sentinel) {
		t.Fatal("delivery failure was hidden")
	}
	// Completion includes notification delivery: require exactly one attempted
	// frame and one failure, even when the failure notification is refused too.
	if len(delivered) != 2 {
		t.Fatalf("expected one frame attempt and one failure notification, got %d", len(delivered))
	}
	var frame struct{ Event string }
	if msg := <-delivered; json.Unmarshal(msg, &frame) != nil || frame.Event != "frame_ready" {
		t.Fatalf("missing initial frame attempt: %s", msg)
	}
	var failure capsule.ErrorEvent
	if msg := <-delivered; json.Unmarshal(msg, &failure) != nil || failure.Event != "error" || failure.Data.Code != "capture_failed" || failure.Data.SurfaceID != "a" {
		t.Fatalf("missing capture_failed notification: %s", msg)
	}
	mu.Lock()
	refuse = false
	mu.Unlock()
	if e = s.Subscribe(context.Background(), "a"); e != nil {
		t.Fatalf("failed subscription retained capacity: %v", e)
	}
	for i := 0; i < 2; i++ {
		select {
		case msg := <-delivered:
			if json.Unmarshal(msg, &frame) != nil || frame.Event != "frame_ready" {
				t.Fatalf("healthy subscription did not resume frames: %s", msg)
			}
		case <-time.After(time.Second):
			t.Fatal("healthy subscription stalled after delivery failure")
		}
	}
	if e = s.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	if s.TerminalError("a") != nil {
		t.Fatal("healthy subscription retained a terminal failure")
	}
}
