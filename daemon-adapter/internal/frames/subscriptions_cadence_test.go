package frames

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

// The fake advances only explicitly, including work inside Capture and Emit.
// Reset notifications fence the end of each poll without wall-clock sleeps.
type cadenceClock struct {
	mu      sync.Mutex
	now     time.Time
	timer   *cadenceTimer
	resets  chan time.Duration
	stopped chan struct{}
}

type cadenceTimer struct {
	clock    *cadenceClock
	ticks    chan time.Time
	deadline time.Time
	active   bool
}

func newCadenceClock() *cadenceClock {
	return &cadenceClock{now: time.Now(), resets: make(chan time.Duration, 16), stopped: make(chan struct{})}
}
func (c *cadenceClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}
func (c *cadenceClock) NewTimer(d time.Duration) pollTimer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &cadenceTimer{clock: c, ticks: make(chan time.Time, 1), deadline: c.now.Add(d), active: true}
	c.timer = t
	c.fire()
	return t
}
func (c *cadenceClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	c.fire()
}
func (c *cadenceClock) fire() {
	if c.timer != nil && c.timer.active && !c.timer.deadline.After(c.now) {
		c.timer.active = false
		c.timer.ticks <- c.now
	}
}
func (t *cadenceTimer) Ticks() <-chan time.Time { return t.ticks }
func (t *cadenceTimer) Reset(d time.Duration) bool {
	c := t.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	was := t.active
	t.active, t.deadline = true, c.now.Add(d)
	c.fire()
	c.resets <- d
	return was
}
func (t *cadenceTimer) Stop() bool {
	c := t.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	was := t.active
	t.active = false
	close(c.stopped)
	return was
}

type cadenceSource struct {
	*captureSource
	clock    *cadenceClock
	work     time.Duration
	starts   chan time.Time
	blocking bool
}

func (s *cadenceSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	s.starts <- s.clock.Now()
	if s.blocking {
		<-ctx.Done()
		return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
	}
	s.clock.advance(s.work)
	return s.captureSource.Capture(ctx, id)
}

func cadenceReceive[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("cadence worker stalled")
		var zero T
		return zero
	}
}

func TestSubscriptionFixedCadence(t *testing.T) {
	for _, tc := range []struct {
		name              string
		capture, delivery time.Duration
		period, wait      time.Duration
		missed            uint64
	}{
		{"slow capture and delivery", 30 * time.Millisecond, 20 * time.Millisecond, 100 * time.Millisecond, 50 * time.Millisecond, 0},
		{"overrun skips without burst", 250 * time.Millisecond, 20 * time.Millisecond, 300 * time.Millisecond, 30 * time.Millisecond, 2},
		{"exact overrun boundary", 180 * time.Millisecond, 20 * time.Millisecond, 300 * time.Millisecond, 100 * time.Millisecond, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, b, f := ramFixture(t)
			clock := newCadenceClock()
			origin := clock.Now()
			source := &cadenceSource{captureSource: &captureSource{b: b, f: f}, clock: clock, work: tc.capture, starts: make(chan time.Time, 16)}
			s, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: 100 * time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, publisher(t, root), func(context.Context, json.RawMessage) error {
				clock.advance(tc.delivery)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			s.clock = clock
			t.Cleanup(func() {
				if err := s.Close(context.Background()); err != nil {
					t.Error(err)
				}
			})
			if err := s.Subscribe(context.Background(), b.Surface.SurfaceID); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 4; i++ {
				start := cadenceReceive(t, source.starts)
				if got := start.Sub(origin); got != time.Duration(i)*tc.period {
					t.Fatalf("capture %d drifted: start %s", i, got)
				}
				if wait := cadenceReceive(t, clock.resets); wait != tc.wait {
					t.Fatalf("wait %s, want %s (work must not accumulate)", wait, tc.wait)
				}
				if got := s.SkippedPolls(); got != uint64(i+1)*tc.missed {
					t.Fatalf("missed ticks %d, want %d", got, uint64(i+1)*tc.missed)
				}
				clock.advance(tc.wait - time.Nanosecond)
				select {
				case <-source.starts:
					t.Fatal("capture before next deadline or burst catch-up")
				default:
				}
				if i < 3 {
					clock.advance(time.Nanosecond)
				}
			}
		})
	}
}

func TestSubscriptionCadenceCancellation(t *testing.T) {
	for _, mode := range []string{"unsubscribe", "parent cancel", "close", "capture cancel"} {
		t.Run(mode, func(t *testing.T) {
			root, b, f := ramFixture(t)
			clock := newCadenceClock()
			source := &cadenceSource{captureSource: &captureSource{b: b, f: f}, clock: clock, starts: make(chan time.Time, 16), blocking: mode == "capture cancel"}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s, err := NewSubscriptions(ctx, SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Second, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, publisher(t, root), func(context.Context, json.RawMessage) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			s.clock = clock
			t.Cleanup(func() { _ = s.Close(context.Background()) })
			if err := s.Subscribe(context.Background(), b.Surface.SurfaceID); err != nil {
				t.Fatal(err)
			}
			cadenceReceive(t, source.starts)
			if !source.blocking {
				cadenceReceive(t, clock.resets)
			}
			switch mode {
			case "parent cancel", "capture cancel":
				cancel()
			case "unsubscribe":
				err = s.Unsubscribe(context.Background(), b.Surface.SurfaceID)
			case "close":
				err = s.Close(context.Background())
			}
			if err != nil {
				t.Fatal(err)
			}
			cadenceReceive(t, clock.stopped)
			clock.advance(10 * time.Second)
			select {
			case <-source.starts:
				t.Fatal("capture after cancellation")
			default:
			}
		})
	}
}
