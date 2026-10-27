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

func TestSubscriptionPublicationLockTimeout(t *testing.T) {
	for _, deliveryFails := range []bool{false, true} {
		name := "delivered"
		if deliveryFails {
			name = "delivery_failure"
		}
		t.Run(name, func(t *testing.T) {
			root, b, f := ramFixture(t)
			source := &captureSource{b: b, f: f}
			var work sync.Mutex
			work.Lock()
			locked := true
			defer func() {
				if locked {
					work.Unlock()
				}
			}()
			events := make(chan json.RawMessage, 8)
			sentinel := errors.New("timeout event delivery refused")
			s, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Second, CaptureTimeout: 10 * time.Millisecond, ShutdownTimeout: time.Second, CaptureLock: &work}, source, publisher(t, root), func(_ context.Context, msg json.RawMessage) error {
				events <- msg
				if deliveryFails {
					return sentinel
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := s.Close(context.Background()); err != nil {
					t.Error(err)
				}
			})
			if err := s.Subscribe(context.Background(), "a"); err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			done := s.tasks["a"].done
			s.mu.Unlock()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("lock wait failed to terminate within capture timeout")
			}
			select {
			case msg := <-events:
				var event capsule.ErrorEvent
				if err := json.Unmarshal(msg, &event); err != nil {
					t.Fatal(err)
				}
				if event.Schema != "surface_event/v0.2" || event.Event != "error" || event.Data.Code != "capture_failed" || event.Data.SurfaceID != "a" {
					t.Errorf("unexpected lock timeout event: %s", msg)
				}
			default:
				t.Error("lock timeout silently terminated without capture_failed")
			}
			if len(events) != 0 {
				t.Error("lock timeout emitted more than one event")
			}
			want := error(context.DeadlineExceeded)
			if deliveryFails {
				want = sentinel
			}
			if err := s.TerminalError("a"); !errors.Is(err, want) {
				t.Errorf("terminal error = %v, want %v", err, want)
			}
			source.mu.Lock()
			calls := source.calls
			source.mu.Unlock()
			if calls != 0 {
				t.Error("captured without acquiring publication lock")
			}
			if err := s.Unsubscribe(context.Background(), "a"); err != nil {
				t.Fatal(err)
			}
			work.Unlock()
			locked = false
			if err := s.Subscribe(context.Background(), "a"); err != nil {
				t.Fatalf("failed to recover subscription: %v", err)
			}
			select {
			case msg := <-events:
				var event struct{ Event string }
				if err := json.Unmarshal(msg, &event); err != nil || event.Event != "frame_ready" {
					t.Fatalf("recovered subscription failed to publish: %s (%v)", msg, err)
				}
			case <-time.After(time.Second):
				t.Fatal("recovered subscription did not capture")
			}
		})
	}
}

func TestSubscriptionPublicationLockWaitCancellation(t *testing.T) {
	root, b, f := ramFixture(t)
	source := &captureSource{b: b, f: f}
	var work sync.Mutex
	work.Lock()
	defer work.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan json.RawMessage, 1)
	s, err := NewSubscriptions(ctx, SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second, CaptureLock: &work}, source, publisher(t, root), func(_ context.Context, msg json.RawMessage) error {
		events <- msg
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close(context.Background())
	if err := s.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	done := s.tasks["a"].done
	s.mu.Unlock()
	// Keep the publication lock held throughout cancellation and task completion.
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled lock waiter failed to terminate")
	}
	if err := s.TerminalError("a"); err != nil {
		t.Fatalf("cancellation recorded as failure: %v", err)
	}
	if len(events) != 0 {
		t.Fatal("cancellation emitted an event")
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.calls != 0 {
		t.Fatal("cancelled waiter captured without publication lock")
	}
}
