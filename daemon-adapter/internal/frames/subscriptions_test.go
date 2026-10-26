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
	delivered := make(chan struct{})
	s, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, p, func(context.Context, json.RawMessage) error { close(delivered); return sentinel })
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	select {
	case <-delivered:
	case <-time.After(time.Second):
		t.Fatal("delivery never attempted")
	}
	s.mu.Lock()
	done := s.tasks["a"].done
	s.mu.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("delivery failure failed to terminate subscription")
	}
	if !errors.Is(s.TerminalError("a"), sentinel) {
		t.Fatal("delivery failure was hidden")
	}
	if e = s.Close(context.Background()); e != nil {
		t.Fatal(e)
	}
}
