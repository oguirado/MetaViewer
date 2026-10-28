package frames

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"sync"
	"testing"
	"time"
)

type externalHoldLossSource struct {
	mu          sync.Mutex
	b           capsule.Binding
	calls       int
	secondFault chan struct{}
	lostDone    chan struct{}
}

func (s *externalHoldLossSource) Capture(_ context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
	s.mu.Lock()
	s.calls++
	call := s.calls
	s.mu.Unlock()
	if call == 2 {
		close(s.secondFault)
	}
	return capsule.Binding{}, capsule.NativeFrame{}, &cli.Fault{Code: "surface", Detail: "capture requires an active surface"}
}

func (s *externalHoldLossSource) BeginMarkLost(_ string) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.b.Surface.State == "lost" {
		return nil, nil
	}
	s.b.Surface.State = "lost"
	s.b.ConfirmedAbsent = true
	s.lostDone = make(chan struct{})
	raw, _ := json.Marshal(struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
		Data   struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}{
		Schema: "surface_event/v0.2",
		Event:  "state_changed",
		Data: struct {
			Surface capsule.Surface `json:"surface"`
		}{Surface: s.b.Surface},
	})
	return raw, nil
}

func (s *externalHoldLossSource) CompleteLost(_ string, _ bool) {
	s.mu.Lock()
	ch := s.lostDone
	s.lostDone = nil
	s.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func (s *externalHoldLossSource) WaitLostDelivered(ctx context.Context, _ string) {
	s.mu.Lock()
	ch := s.lostDone
	s.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case <-ch:
	case <-ctx.Done():
	}
}

func TestCaptureFailedWaitsForInFlightExternalLostDelivery(t *testing.T) {
	// Mutation: daemon-adapter/internal/frames/subscriptions.go:654 delete the
	// WaitLostDelivered gate so capture_failed can overtake an in-flight lost event.
	root, b, _ := ramFixture(t)
	b.Surface.State = "active"
	p := publisher(t, root)
	src := &externalHoldLossSource{
		b:           b,
		secondFault: make(chan struct{}),
	}

	// Begin external lost delivery before subscribing so lostDone stays open across two non-absence faults.
	lostEv, err := src.BeginMarkLost("a")
	if err != nil || len(lostEv) == 0 {
		t.Fatalf("BeginMarkLost failed: %v", err)
	}

	var wireMu sync.Mutex
	var wireEvents []string
	captureFailedCh := make(chan struct{}, 1)
	allDone := make(chan struct{})

	emit := func(_ context.Context, msg json.RawMessage) error {
		var ev struct {
			Event string `json:"event"`
			Data  struct {
				Code    string          `json:"code"`
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		_ = json.Unmarshal(msg, &ev)
		wireMu.Lock()
		if ev.Event == "state_changed" {
			wireEvents = append(wireEvents, "state_changed:"+ev.Data.Surface.State)
		} else {
			wireEvents = append(wireEvents, ev.Event+":"+ev.Data.Code)
			if ev.Event == "error" && ev.Data.Code == "capture_failed" {
				select {
				case captureFailedCh <- struct{}{}:
				default:
				}
			}
		}
		n := len(wireEvents)
		wireMu.Unlock()
		if n == 2 {
			close(allDone)
		}
		return nil
	}

	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions: 1,
		PollInterval:     time.Millisecond,
		CaptureTimeout:   time.Second,
		ShutdownTimeout:  time.Second,
	}, src, p, emit)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}

	select {
	case <-src.secondFault:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for second non-absence frame fault")
	}

	// Expect no capture_failed within 100ms while external lost delivery remains open.
	select {
	case <-captureFailedCh:
		t.Fatal("capture_failed emitted while external lost delivery was still open")
	case <-time.After(100 * time.Millisecond):
	}

	_ = emit(context.Background(), lostEv)
	src.CompleteLost("a", true)

	select {
	case <-allDone:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for both wire events")
	}

	wireMu.Lock()
	got := append([]string(nil), wireEvents...)
	wireMu.Unlock()
	if len(got) != 2 || got[0] != "state_changed:lost" || got[1] != "error:capture_failed" {
		t.Fatalf("expected wire order [state_changed:lost, error:capture_failed], got %v", got)
	}
}
