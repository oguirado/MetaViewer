package frames

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// Cancellation must drain a poll waiting behind synchronous input without
// requiring that input's publication lock to be released first.
func TestSubscriptionCancelWhilePublicationLocked(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	source := &captureSource{b: b, f: f}
	var work sync.Mutex
	work.Lock()
	defer work.Unlock()
	s, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second, CaptureLock: &work}, source, p, func(context.Context, json.RawMessage) error { t.Error("cancelled poll emitted"); return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close(context.Background())
	if err = s.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	// Give polling a chance to contend for the held lock. The negative control
	// is that neither native capture nor delivery can occur while it is held.
	time.Sleep(10 * time.Millisecond)
	if err = s.Unsubscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.calls != 0 {
		t.Fatal("poll captured without publication lock")
	}
}
