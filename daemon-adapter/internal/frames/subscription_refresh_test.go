package frames

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRepeatedSubscribePublishesSamePixelsFromExistingCaptureTask(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	source := &captureSource{b: b, f: f}
	events := make(chan Ref, 16)
	s, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second, DeduplicateUnchanged: true, InitialUnchangedPolls: 2}, source, p, func(_ context.Context, raw json.RawMessage) error {
		var e struct {
			Event string `json:"event"`
			Data  struct {
				FrameRef Ref `json:"frame_ref"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &e); err != nil {
			return err
		}
		if e.Event != "frame_ready" {
			t.Errorf("non-frame event: %s", raw)
		}
		events <- e.Data.FrameRef
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close(context.Background())
	if err = s.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	next := func() Ref {
		select {
		case r := <-events:
			return r
		case <-time.After(time.Second):
			t.Fatal("no real frame publication")
			return Ref{}
		}
	}
	first, last := next(), next()
	deadline := time.Now().Add(time.Second)
	for {
		source.mu.Lock()
		calls := source.calls
		source.mu.Unlock()
		if calls >= 6 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("capture polling stopped")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-events:
		t.Fatal("unchanged capture was not deduplicated")
	default:
	}
	s.mu.Lock()
	original := s.tasks["a"]
	s.mu.Unlock()
	if err = s.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	same := s.tasks["a"] == original && len(s.tasks) == 1
	s.mu.Unlock()
	if !same {
		t.Fatal("repeat subscribe replaced or duplicated shared poller")
	}
	refreshed := next()
	if refreshed.Generation <= last.Generation || refreshed.Tick <= last.Tick || refreshed.SHA256 != first.SHA256 {
		t.Fatal("refresh did not publish newer real same-pixel capture")
	}
	if err = s.Unsubscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	source.mu.Lock()
	before := source.calls
	source.mu.Unlock()
	time.Sleep(5 * time.Millisecond)
	source.mu.Lock()
	after := source.calls
	source.mu.Unlock()
	if before != after {
		t.Fatal("capture continued after explicit surface unsubscribe")
	}
	for _, id := range []string{"", strings.Repeat("x", 129)} {
		if s.Subscribe(context.Background(), id) == nil {
			t.Fatal("invalid identity admitted")
		}
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if s.Subscribe(cancelled, "a") == nil {
		t.Fatal("cancelled request admitted")
	}
	if err = s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.Subscribe(context.Background(), "a") == nil {
		t.Fatal("stopped service admitted refresh")
	}
}
