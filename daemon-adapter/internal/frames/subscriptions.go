package frames

// [TARGET, unit decision] Capture pacing belongs to the session, independently
// of UI visibility. Emit must honor its context; delivery failure terminates the
// subscription instead of growing a queue. Unsubscribe drains in-flight work.
// [TARGET, unit decision] Terminal tasks release capacity automatically. Retain
// at most MaxSubscriptions recent failures for TerminalError, clearing a
// surface's prior failure on resubscription or explicit unsubscribe.
// [TARGET, unit decision] Poll deadlines use the monotonic session clock.
// Missed deadlines are skipped, counted across subscriptions, and never queued.
// [TARGET, unit decision] Per-surface capture exclusion replaces the global
// session lock so concurrent subscriptions hold cadence independently while
// same-surface operations remain serialized; missed poll deadlines emit through
// the diagnostics path alongside the atomic counter.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
)

type Source interface {
	Capture(context.Context, string) (capsule.Binding, capsule.NativeFrame, error)
}
type Emit func(context.Context, json.RawMessage) error
type SubscriptionConfig struct {
	MaxSubscriptions int
	// CaptureLock serializes capture/publication when a single shared lock is configured.
	CaptureLock *sync.Mutex
	// SurfaceLock returns a per-surface mutex serializing capture/publication for a single surface.
	// When both SurfaceLock and CaptureLock are nil, Subscriptions allocates a per-surface mutex automatically.
	SurfaceLock                                   func(string) *sync.Mutex
	PollInterval, CaptureTimeout, ShutdownTimeout time.Duration
	DeduplicateUnchanged                          bool
	InitialUnchangedPolls                         int
	// Diagnostics receives human-readable diagnostic lines when poll deadlines are skipped.
	Diagnostics io.Writer
	// OnSkippedPolls is an optional diagnostic hook invoked when a poll deadline is missed.
	OnSkippedPolls func(surfaceID string, missed, total uint64)
}
type task struct {
	cancel    context.CancelFunc
	done      chan struct{}
	err       error
	cancelled atomic.Bool
	emitted   uint64
}

func (s *Subscriptions) initialUnchangedPolls() uint64 {
	if s.cfg.InitialUnchangedPolls > 0 {
		return uint64(s.cfg.InitialUnchangedPolls)
	}
	return 2
}

type pollTimer interface {
	Ticks() <-chan time.Time
	Reset(time.Duration) bool
	Stop() bool
}

type pollClock interface {
	Now() time.Time
	NewTimer(time.Duration) pollTimer
}

type monotonicPollClock struct{}
type realPollTimer struct{ *time.Timer }

func (monotonicPollClock) Now() time.Time { return time.Now() }
func (monotonicPollClock) NewTimer(d time.Duration) pollTimer {
	return realPollTimer{time.NewTimer(d)}
}
func (t realPollTimer) Ticks() <-chan time.Time { return t.C }

type Subscriptions struct {
	mu           sync.Mutex
	diagMu       sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	cfg          SubscriptionConfig
	source       Source
	publisher    *Publisher
	emit         Emit
	tasks        map[string]*task
	failures     map[string]*task
	confirmed    map[string]uint64
	surfaceLocks map[string]*sync.Mutex
	surfaceSkips map[string]uint64
	failedIDs    []string
	closed       bool
	clock        pollClock
	skipped      atomic.Uint64
}

// SkippedPolls returns missed cadence deadlines over this service's lifetime.
// It excludes delivery drops, whose existing policy is unchanged.
func (s *Subscriptions) SkippedPolls() uint64 { return s.skipped.Load() }

// SkippedPollsFor returns missed cadence deadlines for a specific surface.
func (s *Subscriptions) SkippedPollsFor(id string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.surfaceSkips[id]
}

// SurfaceLock returns the mutex serializing capture/publication for surface id.
func (s *Subscriptions) SurfaceLock(id string) *sync.Mutex {
	if s.cfg.SurfaceLock != nil {
		if m := s.cfg.SurfaceLock(id); m != nil {
			return m
		}
	}
	if s.cfg.CaptureLock != nil {
		return s.cfg.CaptureLock
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.surfaceLocks == nil {
		s.surfaceLocks = make(map[string]*sync.Mutex)
	}
	m := s.surfaceLocks[id]
	if m == nil {
		m = &sync.Mutex{}
		s.surfaceLocks[id] = m
	}
	return m
}

func (s *Subscriptions) recordSkippedPolls(id string, missed uint64) uint64 {
	total := s.skipped.Add(missed)
	s.mu.Lock()
	if s.surfaceSkips == nil {
		s.surfaceSkips = make(map[string]uint64)
	}
	s.surfaceSkips[id] += missed
	s.mu.Unlock()
	if s.cfg.OnSkippedPolls != nil {
		s.cfg.OnSkippedPolls(id, missed, total)
	}
	if s.cfg.Diagnostics != nil {
		s.diagMu.Lock()
		_, _ = fmt.Fprintf(s.cfg.Diagnostics, "adapter: surface %s skipped_polls=%d total_skipped_polls=%d\n", id, missed, total)
		s.diagMu.Unlock()
	}
	return total
}

func NewSubscriptions(ctx context.Context, cfg SubscriptionConfig, source Source, publisher *Publisher, emit Emit) (*Subscriptions, error) {
	if ctx == nil || cfg.MaxSubscriptions < 1 || cfg.PollInterval <= 0 || cfg.CaptureTimeout <= 0 || cfg.ShutdownTimeout <= 0 || cfg.InitialUnchangedPolls < 0 || source == nil || publisher == nil || emit == nil {
		return nil, errors.New("complete bounded subscription dependencies required")
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &Subscriptions{ctx: ctx, cancel: cancel, cfg: cfg, source: source, publisher: publisher, emit: emit, tasks: make(map[string]*task), failures: make(map[string]*task), confirmed: make(map[string]uint64), surfaceLocks: make(map[string]*sync.Mutex), surfaceSkips: make(map[string]uint64), clock: monotonicPollClock{}}
	publisher.addReleaseHook(func(id string) {
		s.mu.Lock()
		delete(s.confirmed, id)
		s.forgetFailure(id)
		s.mu.Unlock()
	})
	return s, nil
}
func (s *Subscriptions) Subscribe(ctx context.Context, id string) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.ctx.Err() != nil || id == "" || len(id) > 128 {
		return errors.New("inactive session or invalid surface identity")
	}
	if _, ok := s.tasks[id]; ok {
		return errors.New("surface already subscribed")
	}
	if len(s.tasks) >= s.cfg.MaxSubscriptions {
		return errors.New("subscription capacity reached")
	}
	run, cancel := context.WithCancel(s.ctx)
	if _, failed := s.failures[id]; failed {
		delete(s.confirmed, id)
	}
	s.forgetFailure(id)
	t := &task{cancel: cancel, done: make(chan struct{})}
	s.tasks[id] = t
	go s.poll(run, id, t)
	return nil
}
func (s *Subscriptions) poll(ctx context.Context, id string, t *task) {
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.tasks[id] == t {
			delete(s.tasks, id)
			if t.err != nil {
				if len(s.failedIDs) == s.cfg.MaxSubscriptions {
					s.forgetFailure(s.failedIDs[0])
				}
				s.failures[id] = t
				s.failedIDs = append(s.failedIDs, id)
			}
		}
		close(t.done)
	}()
	defer t.cancel()
	next := s.clock.Now()
	timer := s.clock.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.Ticks():
		}
		if ctx.Err() != nil {
			return
		}
		capture, cancel := context.WithTimeout(ctx, s.cfg.CaptureTimeout)
		var binding capsule.Binding
		var native capsule.NativeFrame
		var e error
		lock := s.SurfaceLock(id)
		locked := false
		if lock != nil {
			for {
				if e = capture.Err(); e != nil {
					break
				}
				if lock.TryLock() {
					locked = true
					break
				}
				select {
				case <-capture.Done():
				case <-time.After(time.Millisecond):
				}
			}
		}
		if e == nil {
			binding, native, e = s.source.Capture(capture, id)
		}
		if e == nil {
			e = capture.Err()
		}
		cancel()
		if ctx.Err() != nil {
			if locked {
				lock.Unlock()
			}
			return
		}
		var msg json.RawMessage
		changed := true
		if e == nil {
			var ref Ref
			s.mu.Lock()
			cancelled := t.cancelled.Load() || s.closed || ctx.Err() != nil
			dedup := (s.cfg.DeduplicateUnchanged || s.publisher.cfg.Deduplicate) && s.confirmed[id] >= s.initialUnchangedPolls() && t.emitted >= 1
			s.mu.Unlock()
			if !cancelled {
				ref, changed, e = s.publisher.publish(id, binding, native, dedup, func() bool {
					return t.cancelled.Load() || ctx.Err() != nil
				})
				if errors.Is(e, errSubscriptionCancelled) {
					cancelled = true
					e = nil
				}
			}
			if cancelled || t.cancelled.Load() || ctx.Err() != nil {
				if locked {
					lock.Unlock()
				}
				return
			}
			if e == nil && changed {
				msg, _ = json.Marshal(struct {
					Schema string `json:"schema"`
					Event  string `json:"event"`
					Data   struct {
						FrameRef Ref `json:"frame_ref"`
					} `json:"data"`
				}{Schema: "surface_event/v0.2", Event: "frame_ready", Data: struct {
					FrameRef Ref `json:"frame_ref"`
				}{ref}})
			}
		}
		failed := e != nil
		if failed {
			var eventErr error
			msg, eventErr = captureFailure(id, s.SkippedPolls())
			if eventErr != nil {
				if locked {
					lock.Unlock()
				}
				t.err = eventErr
				return
			}
		}
		if !failed && !changed {
			if locked {
				lock.Unlock()
			}
		} else {
			delivery, stop := context.WithTimeout(ctx, s.cfg.CaptureTimeout)
			deliveryErr := s.emit(delivery, msg)
			if deliveryErr == nil {
				deliveryErr = delivery.Err()
			}
			stop()
			if locked {
				lock.Unlock()
			}
			if deliveryErr != nil {
				t.err = errors.Join(e, deliveryErr)
				// A failed frame delivery gets one bounded failure notification.
				// Do not retry a failure notification or emit after cancellation.
				if !failed && ctx.Err() == nil {
					if failure, eventErr := captureFailure(id, s.SkippedPolls()); eventErr == nil {
						notice, stop := context.WithTimeout(ctx, s.cfg.CaptureTimeout)
						_ = s.emit(notice, failure)
						stop()
					}
				}
				return
			}
			if failed {
				t.err = e
				return
			}
			t.emitted++
			s.mu.Lock()
			s.confirmed[id]++
			s.mu.Unlock()
		}
		next = next.Add(s.cfg.PollInterval)
		now := s.clock.Now()
		if !next.After(now) {
			missed := now.Sub(next)/s.cfg.PollInterval + 1
			s.recordSkippedPolls(id, uint64(missed))
			// Advance from now by the remainder to avoid overflowing a
			// duration when a long stall misses many intervals.
			next = now.Add(s.cfg.PollInterval - now.Sub(next)%s.cfg.PollInterval)
		}
		timer.Reset(next.Sub(now))
	}
}

func captureFailure(id string, skippedPolls uint64) (json.RawMessage, error) {
	event, err := capsule.NewErrorEvent(id, &cli.Fault{
		Code:   "capture_failed",
		Detail: fmt.Sprintf("capture, publication or delivery refused (skipped_polls=%d)", skippedPolls),
	})
	if err != nil {
		return nil, err
	}
	event.Schema = "surface_event/v0.2"
	return json.Marshal(event)
}

func (s *Subscriptions) Unsubscribe(ctx context.Context, id string) error {
	s.mu.Lock()
	t, ok := s.tasks[id]
	if ok {
		t.cancelled.Store(true)
		t.cancel()
	} else {
		s.forgetFailure(id)
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	wait, cancel := context.WithTimeout(ctx, s.cfg.ShutdownTimeout)
	defer cancel()
	select {
	case <-wait.Done():
		return wait.Err()
	case <-t.done:
	}
	s.mu.Lock()
	if s.tasks[id] == t {
		delete(s.tasks, id)
	}
	// A replacement subscription must keep its own terminal result.
	if s.failures[id] == t {
		s.forgetFailure(id)
	}
	s.mu.Unlock()
	return nil
}

// forgetFailure requires s.mu.
func (s *Subscriptions) forgetFailure(id string) {
	if _, ok := s.failures[id]; ok {
		delete(s.confirmed, id)
	}
	delete(s.failures, id)
	for i, failedID := range s.failedIDs {
		if failedID == id {
			s.failedIDs = append(s.failedIDs[:i], s.failedIDs[i+1:]...)
			return
		}
	}
}

// TerminalError returns a retained completed failure, if any.
func (s *Subscriptions) TerminalError(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.failures[id]; t != nil {
		return t.err
	}
	return nil
}
func (s *Subscriptions) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	clear(s.confirmed)
	ids := make([]string, 0, len(s.tasks))
	for id, t := range s.tasks {
		t.cancelled.Store(true)
		t.cancel()
		ids = append(ids, id)
	}
	s.mu.Unlock()
	var errs []error
	deadline, cancel := context.WithTimeout(ctx, s.cfg.ShutdownTimeout)
	defer cancel()
	for _, id := range ids {
		errs = append(errs, s.Unsubscribe(deadline, id))
	}
	return errors.Join(errs...)
}
