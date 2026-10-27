package frames

// [TARGET, unit decision] Capture pacing belongs to the session, independently
// of UI visibility. Emit must honor its context; delivery failure terminates the
// subscription instead of growing a queue. Unsubscribe drains in-flight work.
// [TARGET, unit decision] Terminal tasks release capacity automatically. Retain
// at most MaxSubscriptions recent failures for TerminalError, clearing a
// surface's prior failure on resubscription or explicit unsubscribe.
// [TARGET, unit decision] Poll deadlines use the monotonic session clock.
// Missed deadlines are skipped, counted across subscriptions, and never queued.
import (
	"context"
	"encoding/json"
	"errors"
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
	// CaptureLock serializes capture/publication with synchronous runtime capture.
	CaptureLock                                   *sync.Mutex
	PollInterval, CaptureTimeout, ShutdownTimeout time.Duration
	DeduplicateUnchanged                          bool
	InitialUnchangedPolls                         int
}
type task struct {
	cancel    context.CancelFunc
	done      chan struct{}
	err       error
	cancelled bool
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
	mu        sync.Mutex
	ctx       context.Context
	cancel    context.CancelFunc
	cfg       SubscriptionConfig
	source    Source
	publisher *Publisher
	emit      Emit
	tasks     map[string]*task
	failures  map[string]*task
	failedIDs []string
	closed    bool
	clock     pollClock
	skipped   atomic.Uint64
}

// SkippedPolls returns missed cadence deadlines over this service's lifetime.
// It excludes delivery drops, whose existing policy is unchanged.
func (s *Subscriptions) SkippedPolls() uint64 { return s.skipped.Load() }

func NewSubscriptions(ctx context.Context, cfg SubscriptionConfig, source Source, publisher *Publisher, emit Emit) (*Subscriptions, error) {
	if ctx == nil || cfg.MaxSubscriptions < 1 || cfg.PollInterval <= 0 || cfg.CaptureTimeout <= 0 || cfg.ShutdownTimeout <= 0 || source == nil || publisher == nil || emit == nil {
		return nil, errors.New("complete bounded subscription dependencies required")
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Subscriptions{ctx: ctx, cancel: cancel, cfg: cfg, source: source, publisher: publisher, emit: emit, tasks: make(map[string]*task), failures: make(map[string]*task), clock: monotonicPollClock{}}, nil
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
		locked := false
		if s.cfg.CaptureLock != nil {
			for {
				if e = capture.Err(); e != nil {
					break
				}
				if s.cfg.CaptureLock.TryLock() {
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
				s.cfg.CaptureLock.Unlock()
			}
			return
		}
		var msg json.RawMessage
		changed := true
		if e == nil {
			var ref Ref
			s.mu.Lock()
			cancelled := t.cancelled || s.closed || ctx.Err() != nil
			if !cancelled {
				if (s.cfg.DeduplicateUnchanged || s.publisher.cfg.Deduplicate) && t.emitted >= s.initialUnchangedPolls() {
					ref, changed, e = s.publisher.PublishIfChanged(id, binding, native)
				} else {
					ref, _, e = s.publisher.publish(id, binding, native, false)
				}
			}
			s.mu.Unlock()
			if cancelled {
				if locked {
					s.cfg.CaptureLock.Unlock()
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
			msg, eventErr = captureFailure(id)
			if eventErr != nil {
				if locked {
					s.cfg.CaptureLock.Unlock()
				}
				t.err = eventErr
				return
			}
		}
		if !failed && !changed {
			if locked {
				s.cfg.CaptureLock.Unlock()
			}
		} else {
			delivery, stop := context.WithTimeout(ctx, s.cfg.CaptureTimeout)
			deliveryErr := s.emit(delivery, msg)
			if deliveryErr == nil {
				deliveryErr = delivery.Err()
			}
			stop()
			if locked {
				s.cfg.CaptureLock.Unlock()
			}
			if deliveryErr != nil {
				t.err = errors.Join(e, deliveryErr)
				// A failed frame delivery gets one bounded failure notification.
				// Do not retry a failure notification or emit after cancellation.
				if !failed && ctx.Err() == nil {
					if failure, eventErr := captureFailure(id); eventErr == nil {
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
		}
		next = next.Add(s.cfg.PollInterval)
		now := s.clock.Now()
		if !next.After(now) {
			missed := now.Sub(next)/s.cfg.PollInterval + 1
			s.skipped.Add(uint64(missed))
			// Advance from now by the remainder to avoid overflowing a
			// duration when a long stall misses many intervals.
			next = now.Add(s.cfg.PollInterval - now.Sub(next)%s.cfg.PollInterval)
		}
		timer.Reset(next.Sub(now))
	}
}

func captureFailure(id string) (json.RawMessage, error) {
	event, err := capsule.NewErrorEvent(id, &cli.Fault{Code: "capture_failed", Detail: "capture, publication or delivery refused"})
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
		t.cancelled = true
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
	ids := make([]string, 0, len(s.tasks))
	for id, t := range s.tasks {
		t.cancelled = true
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
