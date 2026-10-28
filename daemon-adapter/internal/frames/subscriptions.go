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
// [TARGET, unit decision] Per-surface 2-stage pipeline overlaps capture N+1
// with decode/publish/emit of frame N (at most one capture and one publish in
// flight per surface via an unbuffered handoff channel), preserving strict FIFO
// frame order, generation monotonicity, deduplication, and cancellation drain.
// Per-stage durations (capture, decode, hash, write, total) emit rate-limited
// p50/p95 summaries per surface every 5 s to Diagnostics without wire changes.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
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

// StageSummary holds p50 and p95 latencies across a window of processed frames.
type StageSummary struct {
	Samples    int
	CaptureP50 time.Duration
	CaptureP95 time.Duration
	DecodeP50  time.Duration
	DecodeP95  time.Duration
	HashP50    time.Duration
	HashP95    time.Duration
	WriteP50   time.Duration
	WriteP95   time.Duration
	TotalP50   time.Duration
	TotalP95   time.Duration
}

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
	// Serial disables capture/publish overlap when true, running both stages sequentially per poll.
	Serial bool
	// Diagnostics receives human-readable diagnostic lines when poll deadlines are skipped
	// and rate-limited per-stage latency summaries every DiagnosticsInterval (default 5 s).
	Diagnostics io.Writer
	// DiagnosticsInterval sets the rate-limit window for per-surface stage summary lines (default 5 s).
	DiagnosticsInterval time.Duration
	// OnSkippedPolls is an optional diagnostic hook invoked when a poll deadline is missed.
	OnSkippedPolls func(surfaceID string, missed, total uint64)
	// OnStageSummary is an optional diagnostic hook invoked when a rate-limited stage summary is emitted.
	OnStageSummary func(surfaceID string, summary StageSummary)
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

type surfaceStageStats struct {
	windowStart time.Time
	window      []StageDurations
	all         []StageDurations
	lastSummary StageSummary
	summaries   uint64
}

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
	stageStats   map[string]*surfaceStageStats
	failedIDs    []string
	closed       bool
	clock        pollClock
	skipped      atomic.Uint64
}

const (
	defaultDiagnosticsInterval = 5 * time.Second
	maxStageSamples            = 4096
)

func (s *Subscriptions) diagnosticsInterval() time.Duration {
	if s.cfg.DiagnosticsInterval > 0 {
		return s.cfg.DiagnosticsInterval
	}
	return defaultDiagnosticsInterval
}

func (s *Subscriptions) isRealClock() bool {
	_, ok := s.clock.(monotonicPollClock)
	return ok
}

func durationPercentile(vals []time.Duration, pct int) time.Duration {
	if len(vals) == 0 {
		return 0
	}
	cp := slices.Clone(vals)
	slices.Sort(cp)
	idx := (len(cp) - 1) * pct / 100
	return cp[idx]
}

func summarizeStageDurations(samples []StageDurations) StageSummary {
	n := len(samples)
	if n == 0 {
		return StageSummary{}
	}
	capVals := make([]time.Duration, n)
	decVals := make([]time.Duration, n)
	hashVals := make([]time.Duration, n)
	writeVals := make([]time.Duration, n)
	totVals := make([]time.Duration, n)
	for i, d := range samples {
		capVals[i] = d.Capture
		decVals[i] = d.Decode
		hashVals[i] = d.Hash
		writeVals[i] = d.Write
		totVals[i] = d.Total
	}
	return StageSummary{
		Samples:    n,
		CaptureP50: durationPercentile(capVals, 50),
		CaptureP95: durationPercentile(capVals, 95),
		DecodeP50:  durationPercentile(decVals, 50),
		DecodeP95:  durationPercentile(decVals, 95),
		HashP50:    durationPercentile(hashVals, 50),
		HashP95:    durationPercentile(hashVals, 95),
		WriteP50:   durationPercentile(writeVals, 50),
		WriteP95:   durationPercentile(writeVals, 95),
		TotalP50:   durationPercentile(totVals, 50),
		TotalP95:   durationPercentile(totVals, 95),
	}
}

func durationMS(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000.0
}

// StageSummaryFor returns the p50/p95 stage durations observed for surface id.
func (s *Subscriptions) StageSummaryFor(id string) StageSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stageStats[id]
	if st == nil {
		return StageSummary{}
	}
	if len(st.all) > 0 {
		return summarizeStageDurations(st.all)
	}
	return st.lastSummary
}

func (s *Subscriptions) recordStageDurations(id string, d StageDurations) {
	now := s.clock.Now()
	interval := s.diagnosticsInterval()
	var emitSummary *StageSummary
	s.mu.Lock()
	if s.stageStats == nil {
		s.stageStats = make(map[string]*surfaceStageStats)
	}
	st := s.stageStats[id]
	if st == nil {
		st = &surfaceStageStats{windowStart: now.Add(-d.Total)}
		s.stageStats[id] = st
	}
	if st.windowStart.IsZero() {
		st.windowStart = now.Add(-d.Total)
	}
	if len(st.window) < maxStageSamples {
		st.window = append(st.window, d)
	}
	if len(st.all) < maxStageSamples {
		st.all = append(st.all, d)
	}
	if !now.Before(st.windowStart.Add(interval)) && len(st.window) > 0 {
		sum := summarizeStageDurations(st.window)
		st.lastSummary = sum
		st.summaries++
		st.window = st.window[:0]
		st.windowStart = now
		emitSummary = &sum
	}
	s.mu.Unlock()

	if emitSummary != nil {
		if s.cfg.OnStageSummary != nil {
			s.cfg.OnStageSummary(id, *emitSummary)
		}
		if s.cfg.Diagnostics != nil {
			s.diagMu.Lock()
			_, _ = fmt.Fprintf(
				s.cfg.Diagnostics,
				"adapter: surface %s stage_summary samples=%d capture_p50_ms=%.2f capture_p95_ms=%.2f decode_p50_ms=%.2f decode_p95_ms=%.2f hash_p50_ms=%.2f hash_p95_ms=%.2f write_p50_ms=%.2f write_p95_ms=%.2f total_p50_ms=%.2f total_p95_ms=%.2f\n",
				id,
				emitSummary.Samples,
				durationMS(emitSummary.CaptureP50), durationMS(emitSummary.CaptureP95),
				durationMS(emitSummary.DecodeP50), durationMS(emitSummary.DecodeP95),
				durationMS(emitSummary.HashP50), durationMS(emitSummary.HashP95),
				durationMS(emitSummary.WriteP50), durationMS(emitSummary.WriteP95),
				durationMS(emitSummary.TotalP50), durationMS(emitSummary.TotalP95),
			)
			s.diagMu.Unlock()
		}
	}
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
	s := &Subscriptions{ctx: ctx, cancel: cancel, cfg: cfg, source: source, publisher: publisher, emit: emit, tasks: make(map[string]*task), failures: make(map[string]*task), confirmed: make(map[string]uint64), surfaceLocks: make(map[string]*sync.Mutex), surfaceSkips: make(map[string]uint64), stageStats: make(map[string]*surfaceStageStats), clock: monotonicPollClock{}}
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

type capturedItem struct {
	binding    capsule.Binding
	native     capsule.NativeFrame
	err        error
	captureDur time.Duration
	ack        chan struct{}
}

func (s *Subscriptions) poll(ctx context.Context, id string, t *task) {
	// Unbuffered handoff enforces at most 1 capture and 1 publish in flight per surface:
	// as soon as stage 2 accepts frame N from pipeCh, stage 1 is free to start capture N+1
	// while stage 2 decodes, hashes, writes and emits frame N.
	pipeCh := make(chan capturedItem)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer t.cancel()
		s.publishLoop(ctx, id, t, pipeCh)
	}()

	defer func() {
		close(pipeCh)
		wg.Wait()
		t.cancel()
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
		tCap := time.Now()
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
		captureDur := time.Since(tCap)
		cancel()
		if locked {
			lock.Unlock()
		}
		if t.cancelled.Load() || ctx.Err() != nil {
			return
		}
		var ack chan struct{}
		if s.cfg.Serial || !s.isRealClock() {
			ack = make(chan struct{})
		}
		item := capturedItem{
			binding:    binding,
			native:     native,
			err:        e,
			captureDur: captureDur,
			ack:        ack,
		}
		select {
		case <-ctx.Done():
			return
		case pipeCh <- item:
		}
		if e != nil {
			return
		}
		if ack != nil {
			select {
			case <-ctx.Done():
				return
			case <-ack:
			}
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

func (s *Subscriptions) publishLoop(ctx context.Context, id string, t *task, pipeCh <-chan capturedItem) {
	for {
		var item capturedItem
		var ok bool
		select {
		case <-ctx.Done():
			return
		case item, ok = <-pipeCh:
			if !ok {
				return
			}
		}
		if t.cancelled.Load() || ctx.Err() != nil {
			return
		}
		e := item.err
		var msg json.RawMessage
		changed := true
		var stages StageDurations
		if e == nil {
			var ref Ref
			s.mu.Lock()
			cancelled := t.cancelled.Load() || s.closed || ctx.Err() != nil
			dedup := (s.cfg.DeduplicateUnchanged || s.publisher.cfg.Deduplicate) && s.confirmed[id] >= s.initialUnchangedPolls() && t.emitted >= 1
			s.mu.Unlock()
			if !cancelled {
				ref, changed, stages, e = s.publisher.publish(id, item.binding, item.native, dedup, func() bool {
					return t.cancelled.Load() || ctx.Err() != nil || s.ctx.Err() != nil
				})
				if errors.Is(e, errSubscriptionCancelled) {
					cancelled = true
					e = nil
				}
			}
			if cancelled || t.cancelled.Load() || ctx.Err() != nil {
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
				t.err = eventErr
				return
			}
		}
		if !failed && !changed {
			stages.Capture = item.captureDur
			stages.Total = item.captureDur + stages.Total
			s.recordStageDurations(id, stages)
			if item.ack != nil {
				close(item.ack)
			}
		} else {
			tEmit := time.Now()
			delivery, stop := context.WithTimeout(ctx, s.cfg.CaptureTimeout)
			deliveryErr := s.emit(delivery, msg)
			if deliveryErr == nil {
				deliveryErr = delivery.Err()
			}
			stop()
			emitDur := time.Since(tEmit)
			if deliveryErr != nil {
				if t.cancelled.Load() || ctx.Err() != nil {
					return
				}
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
			stages.Capture = item.captureDur
			stages.Write += emitDur
			stages.Total = item.captureDur + stages.Total + emitDur
			s.recordStageDurations(id, stages)
			if item.ack != nil {
				close(item.ack)
			}
		}
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
