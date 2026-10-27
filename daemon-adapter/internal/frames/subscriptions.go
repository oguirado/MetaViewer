package frames

// [TARGET, unit decision] Capture pacing belongs to the session, independently
// of UI visibility. Emit must honor its context; delivery failure terminates the
// subscription instead of growing a queue. Unsubscribe drains in-flight work.
import (
	"context"
	"encoding/json"
	"errors"
	"sync"
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
}
type task struct {
	cancel context.CancelFunc
	done   chan struct{}
	err    error
}
type Subscriptions struct {
	mu        sync.Mutex
	ctx       context.Context
	cancel    context.CancelFunc
	cfg       SubscriptionConfig
	source    Source
	publisher *Publisher
	emit      Emit
	tasks     map[string]*task
	closed    bool
}

func NewSubscriptions(ctx context.Context, cfg SubscriptionConfig, source Source, publisher *Publisher, emit Emit) (*Subscriptions, error) {
	if ctx == nil || cfg.MaxSubscriptions < 1 || cfg.PollInterval <= 0 || cfg.CaptureTimeout <= 0 || cfg.ShutdownTimeout <= 0 || source == nil || publisher == nil || emit == nil {
		return nil, errors.New("complete bounded subscription dependencies required")
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Subscriptions{ctx: ctx, cancel: cancel, cfg: cfg, source: source, publisher: publisher, emit: emit, tasks: make(map[string]*task)}, nil
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
	t := &task{cancel: cancel, done: make(chan struct{})}
	s.tasks[id] = t
	go s.poll(run, id, t)
	return nil
}
func (s *Subscriptions) poll(ctx context.Context, id string, t *task) {
	defer close(t.done)
	defer t.cancel()
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
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
		if e == nil {
			var ref Ref
			ref, e = s.publisher.Publish(id, binding, native)
			if e == nil {
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
			event, eventErr := capsule.NewErrorEvent(id, &cli.Fault{Code: "capture_failed", Detail: "capture or publication refused"})
			if eventErr != nil {
				if locked {
					s.cfg.CaptureLock.Unlock()
				}
				t.err = eventErr
				return
			}
			event.Schema = "surface_event/v0.2"
			msg, _ = json.Marshal(event)
		}
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
			t.err = deliveryErr
			return
		}
		if failed {
			t.err = e
			return
		}
		timer.Reset(s.cfg.PollInterval)
	}
}
func (s *Subscriptions) Unsubscribe(ctx context.Context, id string) error {
	s.mu.Lock()
	t, ok := s.tasks[id]
	if ok {
		t.cancel()
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
	s.mu.Unlock()
	return nil
}

// TerminalError is read only after the task completes; it does not hide failure.
func (s *Subscriptions) TerminalError(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[id]
	if !ok {
		return nil
	}
	select {
	case <-t.done:
		return t.err
	default:
		return nil
	}
}
func (s *Subscriptions) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	ids := make([]string, 0, len(s.tasks))
	for id := range s.tasks {
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
