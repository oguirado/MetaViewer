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

func TestSubscriptionReapsTerminalTasks(t *testing.T) {
	for _, mode := range []string{"lock_timeout", "capture_failure", "publication_failure", "delivery_failure", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			root, b, f := ramFixture(t)
			source := &captureSource{b: b, f: f}
			var work sync.Mutex
			work.Lock()
			defer work.Unlock()
			sentinel := errors.New("terminal failure")
			if mode == "capture_failure" {
				source.err = sentinel
			}
			if mode == "publication_failure" {
				source.f.Width = 0
			}
			events := make(chan json.RawMessage, 8)
			s, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: 20 * time.Millisecond, ShutdownTimeout: time.Second, CaptureLock: &work}, source, publisher(t, root), func(ctx context.Context, msg json.RawMessage) error {
				select {
				case events <- msg:
				case <-ctx.Done():
					return ctx.Err()
				}
				if mode == "delivery_failure" {
					return sentinel
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = s.Close(context.Background()) })
			if err := s.Subscribe(context.Background(), "a"); err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			task := s.tasks["a"]
			s.mu.Unlock()
			if mode == "cancel" {
				task.cancel()
			} else if mode != "lock_timeout" {
				work.Unlock()
				defer work.Lock()
			}
			select {
			case <-task.done:
			case <-time.After(time.Second):
				t.Fatal("terminal task did not finish")
			}
			s.mu.Lock()
			remaining := len(s.tasks)
			s.mu.Unlock()
			if remaining != 0 {
				t.Error("terminal task still consumes subscription capacity")
			}
			if mode == "cancel" {
				if s.TerminalError("a") != nil || len(events) != 0 {
					t.Error("ordinary cancellation reported a capture failure")
				}
			} else {
				if s.TerminalError("a") == nil {
					t.Error("terminal failure was lost after reaping")
				}
				if mode == "delivery_failure" {
					select {
					case msg := <-events:
						var event struct{ Event string }
						if err := json.Unmarshal(msg, &event); err != nil || event.Event != "frame_ready" {
							t.Fatalf("delivery failure did not follow frame publication: %s (%v)", msg, err)
						}
					default:
						t.Error("frame delivery was never attempted")
					}
				}
				{
					var event capsule.ErrorEvent
					select {
					case msg := <-events:
						if err := json.Unmarshal(msg, &event); err != nil || event.Data.Code != "capture_failed" || event.Data.SurfaceID != "a" {
							t.Fatalf("missing capture_failed: %s (%v)", msg, err)
						}
					default:
						t.Error("terminal capture failure was silent")
					}
				}
			}
			if err := s.Subscribe(context.Background(), "b"); err != nil {
				t.Errorf("terminal task prevented capacity reuse: %v", err)
			}
			if err := s.Unsubscribe(context.Background(), "a"); err != nil {
				t.Error(err)
			}
		})
	}
}
