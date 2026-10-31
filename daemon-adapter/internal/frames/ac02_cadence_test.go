package frames

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

func ac02RAMRoot(t *testing.T) string {
	t.Helper()
	root, _, _ := ramFixture(t)
	return root
}

func generatePNGFixtureInTempDir(t *testing.T, width, height int, seed byte) (fixturePath string, pngBytes []byte, shaHex string) {
	t.Helper()
	fixtureDir := t.TempDir()
	fixturePath = filepath.Join(fixtureDir, fmt.Sprintf("fixture-%dx%d-%d.png", width, height, seed))

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	raw := make([]byte, width*height*3)
	n := 0
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			r := byte(((x / 16) + int(seed)*17) & 0xff)
			g := byte(((y / 16) + int(seed)*31) & 0xff)
			b := byte((((x / 16) ^ (y / 16)) + int(seed)*47) & 0xff)
			off := y*img.Stride + x*4
			img.Pix[off] = r
			img.Pix[off+1] = g
			img.Pix[off+2] = b
			img.Pix[off+3] = 0xff
			raw[n] = r
			raw[n+1] = g
			raw[n+2] = b
			n += 3
		}
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	pngBytes = buf.Bytes()
	if err := os.WriteFile(fixturePath, pngBytes, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	shaHex = fmt.Sprintf("%x", sum)
	return fixturePath, pngBytes, shaHex
}

type ac02FakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*ac02FakeTimer
	resets chan time.Duration
}

type ac02FakeTimer struct {
	clock    *ac02FakeClock
	ticks    chan time.Time
	deadline time.Time
	active   bool
}

func newAC02FakeClock() *ac02FakeClock {
	return &ac02FakeClock{
		now:    time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		resets: make(chan time.Duration, 64),
	}
}

func (c *ac02FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *ac02FakeClock) NewTimer(d time.Duration) pollTimer {
	c.mu.Lock()
	defer c.mu.Unlock()
	tm := &ac02FakeTimer{
		clock:    c,
		ticks:    make(chan time.Time, 1),
		deadline: c.now.Add(d),
		active:   true,
	}
	c.timers = append(c.timers, tm)
	c.fireLocked()
	return tm
}

func (c *ac02FakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	c.fireLocked()
}

func (c *ac02FakeClock) fireLocked() {
	for _, tm := range c.timers {
		if tm.active && !tm.deadline.After(c.now) {
			tm.active = false
			select {
			case tm.ticks <- c.now:
			default:
			}
		}
	}
}

func (tm *ac02FakeTimer) Ticks() <-chan time.Time { return tm.ticks }

func (tm *ac02FakeTimer) Reset(d time.Duration) bool {
	c := tm.clock
	c.mu.Lock()
	was := tm.active
	tm.active = true
	tm.deadline = c.now.Add(d)
	c.fireLocked()
	c.mu.Unlock()
	select {
	case c.resets <- d:
	default:
	}
	return was
}

func (tm *ac02FakeTimer) Stop() bool {
	c := tm.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	was := tm.active
	tm.active = false
	return was
}

type ac02CaptureTicket struct {
	id      string
	at      time.Time
	release chan struct{}
}

type ac02StubSurface struct {
	mu      sync.Mutex
	binding capsule.Binding
	frames  [2]capsule.NativeFrame
	polls   atomic.Uint64
}

type ac02StubSource struct {
	clock    *ac02FakeClock
	cost     time.Duration
	surfaces map[string]*ac02StubSurface
	entered  chan ac02CaptureTicket
}

func (s *ac02StubSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	surf, ok := s.surfaces[id]
	if !ok {
		return capsule.Binding{}, capsule.NativeFrame{}, fmt.Errorf("unknown surface %s", id)
	}
	rel := make(chan struct{})
	ticket := ac02CaptureTicket{
		id:      id,
		at:      s.clock.Now(),
		release: rel,
	}
	select {
	case <-ctx.Done():
		return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
	case s.entered <- ticket:
	}
	select {
	case <-ctx.Done():
		return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
	case <-rel:
	}
	seq := surf.polls.Add(1)
	surf.mu.Lock()
	defer surf.mu.Unlock()
	f := surf.frames[seq%2]
	f.Seq = seq
	f.TSNS = seq * 100_000_000
	f.CaptureMonoNS = f.TSNS
	f.CaptureUS = uint64(s.cost / time.Microsecond)
	return surf.binding, f, nil
}

func ac02Receive[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

// TestAC02FourSurfaceCadenceAndDiagnostics drives 4 concurrent surfaces at a
// 100 ms poll interval with a 20 ms capture cost using the injectable pollClock.
// Mutations killed:
//  1. Scheduling the next poll deadline from the end of capture (now + PollInterval)
//     instead of the previous deadline (next + PollInterval): would reset timers to
//     100 ms instead of 80 ms, drift poll start times by +20 ms per poll (1100 ms vs
//     920 ms over 10 polls), and fail to record SkippedPolls > 0 on overrun.
//  2. Serializing captures across surfaces with a shared lock instead of per-surface
//     SurfaceLock: all 4 surfaces would not enter Capture concurrently on each tick.
func TestAC02FourSurfaceCadenceAndDiagnostics(t *testing.T) {
	root := ac02RAMRoot(t)
	pub, err := NewPublisher(PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   64 << 20,
		MaxPixels:       64 << 20,
		MaxSurfaces:     16,
		MaxRetained:     64,
		MinRetention:    4 * time.Second,
		MaxSurfaceBytes: 128 << 20,
		MaxTotalBytes:   512 << 20,
		Deduplicate:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	const (
		pollInterval = 100 * time.Millisecond
		captureCost  = 20 * time.Millisecond
		pollsPerSurf = 10
	)
	surfaceIDs := []string{"srf-a", "srf-b", "srf-c", "srf-d"}
	clock := newAC02FakeClock()
	stub := &ac02StubSource{
		clock:    clock,
		cost:     captureCost,
		surfaces: make(map[string]*ac02StubSurface, len(surfaceIDs)),
		entered:  make(chan ac02CaptureTicket, len(surfaceIDs)*2),
	}

	for i, id := range surfaceIDs {
		srcDir := filepath.Join(root, "source-"+id)
		if err := os.Mkdir(srcDir, 0700); err != nil {
			t.Fatal(err)
		}
		_, png0, sha0 := generatePNGFixtureInTempDir(t, 64, 64, byte(i*2+1))
		_, png1, sha1 := generatePNGFixtureInTempDir(t, 64, 64, byte(i*2+2))
		p0 := filepath.Join(srcDir, "f0.png")
		p1 := filepath.Join(srcDir, "f1.png")
		if err := os.WriteFile(p0, png0, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p1, png1, 0600); err != nil {
			t.Fatal(err)
		}
		container := fmt.Sprintf("srf-id-ac02-%d", i)
		win := fmt.Sprintf("w%d", i+1)
		binding := capsule.Binding{
			Surface: capsule.Surface{
				SurfaceID: id,
				Geometry:  capsule.Geometry{W: 64, H: 64},
			},
			Container:  container,
			FramesRoot: srcDir,
			Window:     win,
		}
		stub.surfaces[id] = &ac02StubSurface{
			binding: binding,
			frames: [2]capsule.NativeFrame{
				{
					Path:        p0,
					Generation:  container,
					Width:       64,
					Height:      64,
					SHA256RGB24: sha0,
					Window:      &capsule.Window{ID: win, W: 64, H: 64},
				},
				{
					Path:        p1,
					Generation:  container,
					Width:       64,
					Height:      64,
					SHA256RGB24: sha1,
					Window:      &capsule.Window{ID: win, W: 64, H: 64},
				},
			},
		}
	}

	var diagBuf bytes.Buffer
	var refsMu sync.Mutex
	refsBySurface := make(map[string][]Ref, len(surfaceIDs))
	allTenReached := make(chan struct{})
	var closeOnce sync.Once

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	subs, err := NewSubscriptions(ctx, SubscriptionConfig{
		MaxSubscriptions:      16,
		PollInterval:          pollInterval,
		CaptureTimeout:        2 * time.Second,
		ShutdownTimeout:       2 * time.Second,
		DeduplicateUnchanged:  true,
		InitialUnchangedPolls: 2,
		Diagnostics:           &diagBuf,
	}, stub, pub, func(_ context.Context, raw json.RawMessage) error {
		var ev struct {
			Event string `json:"event"`
			Data  struct {
				FrameRef Ref `json:"frame_ref"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			return err
		}
		if ev.Event != "frame_ready" {
			return fmt.Errorf("unexpected event %s: %s", ev.Event, raw)
		}
		refsMu.Lock()
		refsBySurface[ev.Data.FrameRef.SurfaceID] = append(refsBySurface[ev.Data.FrameRef.SurfaceID], ev.Data.FrameRef)
		done := true
		for _, sid := range surfaceIDs {
			if len(refsBySurface[sid]) < pollsPerSurf {
				done = false
				break
			}
		}
		refsMu.Unlock()
		if done {
			closeOnce.Do(func() { close(allTenReached) })
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	subs.clock = clock
	defer func() { _ = subs.Close(context.Background()) }()

	start := clock.Now()
	for _, id := range surfaceIDs {
		if err := subs.Subscribe(ctx, id); err != nil {
			t.Fatalf("Subscribe(%s): %v", id, err)
		}
	}

	const expectedWait = pollInterval - captureCost // 80 ms
	for pollIdx := 0; pollIdx < pollsPerSurf; pollIdx++ {
		wantStart := time.Duration(pollIdx) * pollInterval
		tickets := make([]ac02CaptureTicket, 0, len(surfaceIDs))
		seenInRound := make(map[string]bool, len(surfaceIDs))
		for range surfaceIDs {
			tk := ac02Receive(t, stub.entered, fmt.Sprintf("poll %d capture entry", pollIdx))
			if seenInRound[tk.id] {
				t.Fatalf("poll %d: duplicate capture entry for %s before round release", pollIdx, tk.id)
			}
			seenInRound[tk.id] = true
			if got := tk.at.Sub(start); got != wantStart {
				t.Fatalf("poll %d surface %s capture start = %v, want %v (next deadline must anchor to previous deadline, not capture end)", pollIdx, tk.id, got, wantStart)
			}
			tickets = append(tickets, tk)
		}

		// All 4 surfaces are concurrently inside Capture; advance virtual time by the 20 ms capture cost.
		clock.advance(captureCost)
		for _, tk := range tickets {
			close(tk.release)
		}

		for range surfaceIDs {
			wait := ac02Receive(t, clock.resets, fmt.Sprintf("poll %d timer reset", pollIdx))
			if wait != expectedWait {
				t.Fatalf("poll %d timer reset = %v, want %v (scheduling from end of capture instead of previous deadline)", pollIdx, wait, expectedWait)
			}
		}

		if pollIdx < pollsPerSurf-1 {
			clock.advance(expectedWait - time.Nanosecond)
			select {
			case tk := <-stub.entered:
				t.Fatalf("poll %d: surface %s started capture before deadline", pollIdx, tk.id)
			default:
			}
			clock.advance(time.Nanosecond)
		}
	}

	select {
	case <-allTenReached:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for 4 surfaces x 10 polls; skipped=%d", subs.SkippedPolls())
	}
	elapsed := clock.Now().Sub(start)

	for _, id := range surfaceIDs {
		if err := subs.Unsubscribe(ctx, id); err != nil {
			t.Fatalf("Unsubscribe(%s): %v", id, err)
		}
	}

	if skipped := subs.SkippedPolls(); skipped != 0 {
		t.Fatalf("expected SkippedPolls == 0 for 4 concurrent surfaces at 100ms with 20ms stub cost, got %d (diag=%q)", skipped, diagBuf.String())
	}
	for _, id := range surfaceIDs {
		if s := subs.SkippedPollsFor(id); s != 0 {
			t.Fatalf("expected SkippedPollsFor(%s) == 0, got %d", id, s)
		}
	}
	// 10 polls at 100 ms interval (first poll at t=0, 10th at t=900 ms) + 20 ms stub cost = 920 ms exact on fake clock.
	const wantElapsed = (pollsPerSurf-1)*pollInterval + captureCost
	if elapsed != wantElapsed {
		t.Fatalf("4x10 polls virtual elapsed = %v, want exact %v", elapsed, wantElapsed)
	}

	// Verify no two surfaces share a frame file path.
	seenPaths := make(map[string]string)
	refsMu.Lock()
	for _, id := range surfaceIDs {
		refs := refsBySurface[id]
		if len(refs) < pollsPerSurf {
			t.Fatalf("surface %s emitted %d frames, want >= %d", id, len(refs), pollsPerSurf)
		}
		for _, r := range refs {
			if owner, exists := seenPaths[r.RAMWSPath]; exists && owner != id {
				t.Fatalf("surfaces %s and %s shared frame file %s", owner, id, r.RAMWSPath)
			}
			seenPaths[r.RAMWSPath] = id
		}
	}
	refsMu.Unlock()

	// Negative control: when stub capture cost (75 ms) exceeds PollInterval (25 ms),
	// SkippedPolls and Diagnostics MUST report missed deadlines (> 0).
	t.Setenv("MV_ADAPTER_DIAG", "verbose")
	slowClock := newAC02FakeClock()
	slowStub := &ac02StubSource{
		clock:    slowClock,
		cost:     75 * time.Millisecond,
		surfaces: stub.surfaces,
		entered:  make(chan ac02CaptureTicket, 4),
	}
	var skipDiag bytes.Buffer
	var hookMissed, hookTotal atomic.Uint64
	slowDone := make(chan struct{})
	var slowOnce sync.Once
	slowSubs, err := NewSubscriptions(ctx, SubscriptionConfig{
		MaxSubscriptions: 4,
		PollInterval:     25 * time.Millisecond,
		CaptureTimeout:   time.Second,
		ShutdownTimeout:  time.Second,
		Diagnostics:      &skipDiag,
		OnSkippedPolls: func(_ string, missed, total uint64) {
			hookMissed.Add(missed)
			hookTotal.Store(total)
			slowOnce.Do(func() { close(slowDone) })
		},
	}, slowStub, pub, func(context.Context, json.RawMessage) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	slowSubs.clock = slowClock
	defer func() { _ = slowSubs.Close(context.Background()) }()
	if err := slowSubs.Subscribe(ctx, "srf-a"); err != nil {
		t.Fatal(err)
	}
	slowTicket := ac02Receive(t, slowStub.entered, "slow surface capture entry")
	slowClock.advance(slowStub.cost)
	close(slowTicket.release)
	if wait := ac02Receive(t, slowClock.resets, "slow surface timer reset"); wait != 25*time.Millisecond {
		t.Fatalf("expected slow surface next wait = 25ms after 75ms overrun on 25ms interval, got %v", wait)
	}
	select {
	case <-slowDone:
	case <-ctx.Done():
		t.Fatal("timed out waiting for skipped poll diagnostic emission")
	}
	_ = slowSubs.Unsubscribe(ctx, "srf-a")
	if slowSubs.SkippedPolls() != 3 || slowSubs.SkippedPollsFor("srf-a") != 3 {
		t.Fatalf("expected SkippedPolls == 3 (75ms cost on 25ms interval), got total=%d surface=%d", slowSubs.SkippedPolls(), slowSubs.SkippedPollsFor("srf-a"))
	}
	if hookMissed.Load() != 3 || hookTotal.Load() != 3 {
		t.Fatalf("expected OnSkippedPolls hook invocation with missed=3 total=3, got missed=%d total=%d", hookMissed.Load(), hookTotal.Load())
	}
	if !strings.Contains(skipDiag.String(), "adapter: surface srf-a skipped_polls=3 total_skipped_polls=3") {
		t.Fatalf("expected Diagnostics output to contain skipped_polls=3 line, got %q", skipDiag.String())
	}
}

func TestAC02Synthetic1280x900PublishCost(t *testing.T) {
	root := ac02RAMRoot(t)
	srcDir := filepath.Join(root, "source-hd")
	if err := os.Mkdir(srcDir, 0700); err != nil {
		t.Fatal(err)
	}
	pub, err := NewPublisher(PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   64 << 20,
		MaxPixels:       64 << 20,
		MaxSurfaces:     8,
		MaxRetained:     64,
		MinRetention:    4 * time.Second,
		MaxSurfaceBytes: 128 << 20,
		MaxTotalBytes:   512 << 20,
		Deduplicate:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	const (
		w          = 1280
		h          = 900
		iterations = 5
	)
	// [TARGET, unit decision] Functional HD publication is independent of shared
	// runner wall speed. The cadence ceiling is exercised below with the same
	// virtual clock as the AC02 multi-surface scheduler and an over-budget control.
	var wallTotal time.Duration
	var lastSHA string
	var lastFrame capsule.NativeFrame
	binding := capsule.Binding{
		Surface: capsule.Surface{
			SurfaceID: "hd-surface",
			Geometry:  capsule.Geometry{W: w, H: h},
		},
		Container:  "srf-id-hd",
		FramesRoot: srcDir,
		Window:     "w-hd",
	}

	for i := 1; i <= iterations; i++ {
		_, pngBytes, shaHex := generatePNGFixtureInTempDir(t, w, h, byte(i))
		p := filepath.Join(srcDir, fmt.Sprintf("hd-%d.png", i))
		if err := os.WriteFile(p, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}
		frame := capsule.NativeFrame{
			Path:        p,
			Generation:  binding.Container,
			Seq:         uint64(i),
			Width:       w,
			Height:      h,
			SHA256RGB24: shaHex,
			Window:      &capsule.Window{ID: "w-hd", W: w, H: h},
			TSNS:        uint64(i) * 100_000_000,
			CaptureUS:   1000,
		}
		t0 := time.Now()
		ref, changed, err := pub.PublishIfChanged("hd-surface", binding, frame)
		d := time.Since(t0)
		if err != nil || !changed {
			t.Fatalf("iteration %d PublishIfChanged failed: changed=%v err=%v", i, changed, err)
		}
		if ref.SHA256 != shaHex || ref.Width != w || ref.Height != h {
			t.Fatalf("iteration %d wire digest/geometry mismatch: got (%s, %dx%d), want (%s, %dx%d)", i, ref.SHA256, ref.Width, ref.Height, shaHex, w, h)
		}
		wallTotal += d
		lastSHA = shaHex
		lastFrame = frame
	}

	t.Logf("[MEASURED] HD publication wall total=%v (shared runner diagnostic)", wallTotal)
	// Drive real subscriptions with HD frames and a controlled capture cost.
	// A cost above the unchanged 250ms ceiling must miss its cadence deadline.
	for _, cost := range []time.Duration{20 * time.Millisecond, 251 * time.Millisecond} {
		clock := newAC02FakeClock()
		id := fmt.Sprintf("hd-cadence-%d", cost)
		cadenceBinding := binding
		cadenceBinding.Surface.SurfaceID = id
		stub := &ac02StubSource{clock: clock, cost: cost,
			surfaces: map[string]*ac02StubSurface{id: {binding: cadenceBinding, frames: [2]capsule.NativeFrame{lastFrame, lastFrame}}},
			entered:  make(chan ac02CaptureTicket, 1)}
		subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: 250 * time.Millisecond, CaptureTimeout: 5 * time.Second, ShutdownTimeout: time.Second}, stub, pub, func(context.Context, json.RawMessage) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		defer subs.Close(context.Background())
		subs.clock = clock
		if err := subs.Subscribe(context.Background(), id); err != nil {
			t.Fatal(err)
		}
		ticket := ac02Receive(t, stub.entered, "HD capture")
		clock.advance(cost)
		close(ticket.release)
		wait := ac02Receive(t, clock.resets, "HD cadence deadline")
		if cost <= 250*time.Millisecond {
			if wait != 250*time.Millisecond-cost || subs.SkippedPolls() != 0 {
				t.Fatalf("HD cadence: wait=%v skipped=%d", wait, subs.SkippedPolls())
			}
		} else if subs.SkippedPolls() == 0 {
			t.Fatal("negative control: over-budget HD capture did not miss deadline")
		}
		subs.Close(context.Background())
	}

	// Verify unchanged bytes are not rewritten when forced/initial publish runs on identical pixels.
	lastFrame.Seq = uint64(iterations + 1)
	refForced, err := pub.PublishForced("hd-surface", binding, lastFrame)
	if err != nil {
		t.Fatalf("PublishForced on unchanged bytes failed: %v", err)
	}
	if refForced.SHA256 != lastSHA {
		t.Fatalf("PublishForced SHA256 = %s, want %s", refForced.SHA256, lastSHA)
	}
}

type ac02BlockingRunner struct {
	starts       atomic.Uint64
	inputStarted chan struct{}
	releaseInput chan struct{}
	ramRoot      string
	shaHex       string
}

func (r *ac02BlockingRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	if len(args) < 2 {
		return nil, fmt.Errorf("short args")
	}
	switch args[1] {
	case "start":
		idx := r.starts.Add(1)
		container := fmt.Sprintf("srf-id-p%d", idx)
		runID := fmt.Sprintf("run-p%d", idx)
		return []byte(`{"container":"` + container + `","run_id":"` + runID + `","windows":[{"id":"w1","x":0,"y":0,"w":64,"h":64,"title":"","url":""}]}`), nil
	case "input":
		close(r.inputStarted)
		<-r.releaseInput
		return []byte(`{"surface_id":"w1","kind":"click","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
	case "capture", "frame":
		container := "srf-id-p2"
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "--container" {
				container = args[i+1]
				break
			}
		}
		suffix := strings.TrimPrefix(container, "srf-id-")
		f := capsule.NativeFrame{
			Path:          filepath.Join(r.ramRoot, "run-"+suffix, "frames", "w1", "f.png"),
			Seq:           2,
			SHA256RGB24:   r.shaHex,
			Width:         64,
			Height:        64,
			CaptureMonoNS: 200,
			Generation:    container,
			Window:        &capsule.Window{ID: "w1", W: 64, H: 64},
		}
		return json.Marshal(f)
	case "stop":
		container := args[3]
		return []byte(`{"stopped":"` + container + `","removed_verified":true}`), nil
	default:
		return nil, fmt.Errorf("unexpected verb %s", args[1])
	}
}

func TestAC02NegativeControls(t *testing.T) {
	t.Run("corrupt_png_and_digest_mismatch_refuse_and_never_publish", func(t *testing.T) {
		root := ac02RAMRoot(t)
		srcDir := filepath.Join(root, "source-neg")
		if err := os.Mkdir(srcDir, 0700); err != nil {
			t.Fatal(err)
		}
		pub, err := NewPublisher(PublishConfig{
			RAMRoot:       root,
			MaxFrameBytes: 1 << 20,
			MaxPixels:     1 << 20,
			MaxSurfaces:   4,
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pub.Close() })

		// 1. Corrupt PNG bytes in temp fixture.
		corruptTemp := filepath.Join(t.TempDir(), "corrupt.png")
		corruptBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDRcorrupt-payload-bytes")
		if err := os.WriteFile(corruptTemp, corruptBytes, 0600); err != nil {
			t.Fatal(err)
		}
		corruptPath := filepath.Join(srcDir, "corrupt.png")
		if err := os.WriteFile(corruptPath, corruptBytes, 0600); err != nil {
			t.Fatal(err)
		}
		binding := capsule.Binding{
			Surface:    capsule.Surface{SurfaceID: "neg-srf", Geometry: capsule.Geometry{W: 64, H: 64}},
			Container:  "srf-id-neg",
			FramesRoot: srcDir,
			Window:     "w1",
		}
		_, pngBytes, validSHA := generatePNGFixtureInTempDir(t, 64, 64, 9)
		corruptFrame := capsule.NativeFrame{
			Path:        corruptPath,
			Generation:  binding.Container,
			Seq:         1,
			Width:       64,
			Height:      64,
			SHA256RGB24: validSHA,
			Window:      &capsule.Window{ID: "w1", W: 64, H: 64},
			TSNS:        10,
			CaptureUS:   10,
		}
		if _, err := pub.Publish("neg-srf", binding, corruptFrame); err == nil {
			t.Fatal("expected corrupt PNG to be refused by Publish")
		}
		if _, _, err := pub.PublishIfChanged("neg-srf", binding, corruptFrame); err == nil {
			t.Fatal("expected corrupt PNG to be refused by PublishIfChanged")
		}

		// 2. Valid PNG with mismatched SHA256RGB24 digest.
		validPath := filepath.Join(srcDir, "valid.png")
		if err := os.WriteFile(validPath, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}
		badDigestFrame := corruptFrame
		badDigestFrame.Path = validPath
		badDigestFrame.SHA256RGB24 = strings.Repeat("0", 64)
		if _, err := pub.Publish("neg-srf", binding, badDigestFrame); err == nil {
			t.Fatal("expected digest mismatch to be refused by Publish")
		}
		if _, _, err := pub.PublishIfChanged("neg-srf", binding, badDigestFrame); err == nil {
			t.Fatal("expected digest mismatch to be refused by PublishIfChanged")
		}

		entries, err := os.ReadDir(pub.outputPath)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("expected 0 published .rgb files after corrupt/mismatch refusals, got %d", len(entries))
		}
	})

	t.Run("same_surface_input_vs_capture_refuses_policy_while_other_surface_captures", func(t *testing.T) {
		root := ac02RAMRoot(t)
		_, _, shaHex := generatePNGFixtureInTempDir(t, 64, 64, 11)

		runner := &ac02BlockingRunner{
			inputStarted: make(chan struct{}),
			releaseInput: make(chan struct{}),
			ramRoot:      root,
			shaHex:       shaHex,
		}
		mgr, err := capsule.NewManager(capsule.Config{
			BinDir:         t.TempDir(),
			OriginNS:       100,
			MaxSurfaces:    4,
			MaxOutputBytes: 4096,
			Timeout:        5 * time.Second,
			Profiles: map[string]capsule.Profile{
				"pa": {Kind: "browser", NativeKind: "browser", Width: 64, Height: 64, Display: ":100", RAMRoot: root},
				"pb": {Kind: "browser", NativeKind: "browser", Width: 64, Height: 64, Display: ":101", RAMRoot: root},
			},
		}, runner, func() uint64 { return 200 })
		if err != nil {
			t.Fatal(err)
		}

		createSurface := func(profileID string) string {
			evs, err := mgr.Handle(context.Background(), capsule.Request{
				Schema: "surface_request/v0.2",
				Op:     "create",
				Params: json.RawMessage(`{"kind":"browser","profile_id":"` + profileID + `","geometry":{"w":64,"h":64}}`),
			})
			if err != nil || len(evs) == 0 {
				t.Fatalf("create(%s): %v", profileID, err)
			}
			var created struct {
				Data struct {
					Surface capsule.Surface `json:"surface"`
				} `json:"data"`
			}
			if err := json.Unmarshal(evs[0], &created); err != nil {
				t.Fatal(err)
			}
			return created.Data.Surface.SurfaceID
		}

		idA := createSurface("pa")
		idB := createSurface("pb")

		inputDone := make(chan error, 1)
		go func() {
			_, err := mgr.Handle(context.Background(), capsule.Request{
				Schema: "surface_request/v0.2",
				Op:     "input",
				Params: json.RawMessage(`{"surface_id":"` + idA + `","proposal_id":"p1","action":{"type":"click","x":1,"y":1,"button":"left"}}`),
			})
			inputDone <- err
		}()

		select {
		case <-runner.inputStarted:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for input to start on surface A")
		}

		// Capture on the SAME surface during in-flight input MUST refuse with POLICY.
		_, _, err = mgr.Capture(context.Background(), idA)
		if err == nil || err.Error() != "POLICY: input must be drained before capture" {
			t.Fatalf("expected POLICY refusal for capture during input on same surface, got %v", err)
		}

		// Capture on a DIFFERENT surface succeeds while surface A is in input.
		if _, _, err := mgr.Capture(context.Background(), idB); err != nil {
			t.Fatalf("expected concurrent capture on surface B to succeed, got %v", err)
		}

		close(runner.releaseInput)
		if err := <-inputDone; err != nil {
			t.Fatalf("surface A input failed: %v", err)
		}
	})

	t.Run("two_surfaces_never_share_frame_file", func(t *testing.T) {
		root := ac02RAMRoot(t)
		srcA := filepath.Join(root, "source-1")
		srcB := filepath.Join(root, "source-2")
		if err := os.Mkdir(srcA, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(srcB, 0700); err != nil {
			t.Fatal(err)
		}
		pub, err := NewPublisher(PublishConfig{
			RAMRoot:       root,
			MaxFrameBytes: 1 << 20,
			MaxPixels:     1 << 20,
			MaxSurfaces:   4,
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pub.Close() })

		_, pngBytes, shaHex := generatePNGFixtureInTempDir(t, 32, 32, 42)
		pathA := filepath.Join(srcA, "same.png")
		pathB := filepath.Join(srcB, "same.png")
		if err := os.WriteFile(pathA, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(pathB, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}
		bindA := capsule.Binding{
			Surface:    capsule.Surface{SurfaceID: "surf-1", Geometry: capsule.Geometry{W: 32, H: 32}},
			Container:  "srf-id-one",
			FramesRoot: srcA,
			Window:     "w1",
		}
		bindB := capsule.Binding{
			Surface:    capsule.Surface{SurfaceID: "surf-2", Geometry: capsule.Geometry{W: 32, H: 32}},
			Container:  "srf-id-two",
			FramesRoot: srcB,
			Window:     "w2",
		}
		frameA := capsule.NativeFrame{
			Path:        pathA,
			Generation:  bindA.Container,
			Seq:         1,
			Width:       32,
			Height:      32,
			SHA256RGB24: shaHex,
			Window:      &capsule.Window{ID: "w1", W: 32, H: 32},
			TSNS:        10,
			CaptureUS:   5,
		}
		frameB := capsule.NativeFrame{
			Path:        pathB,
			Generation:  bindB.Container,
			Seq:         1,
			Width:       32,
			Height:      32,
			SHA256RGB24: shaHex,
			Window:      &capsule.Window{ID: "w2", W: 32, H: 32},
			TSNS:        10,
			CaptureUS:   5,
		}

		refA1, err := pub.Publish("surf-1", bindA, frameA)
		if err != nil {
			t.Fatal(err)
		}
		refB1, err := pub.Publish("surf-2", bindB, frameB)
		if err != nil {
			t.Fatal(err)
		}
		frameA.Seq = 2
		frameB.Seq = 2
		refA2, err := pub.PublishForced("surf-1", bindA, frameA)
		if err != nil {
			t.Fatal(err)
		}
		refB2, err := pub.PublishForced("surf-2", bindB, frameB)
		if err != nil {
			t.Fatal(err)
		}

		for _, pair := range [][2]Ref{{refA1, refB1}, {refA2, refB2}, {refA1, refB2}, {refA2, refB1}} {
			if pair[0].RAMWSPath == pair[1].RAMWSPath {
				t.Fatalf("two surfaces shared RAMWSPath %s", pair[0].RAMWSPath)
			}
			fi0, err := os.Stat(pair[0].RAMWSPath)
			if err != nil {
				t.Fatal(err)
			}
			fi1, err := os.Stat(pair[1].RAMWSPath)
			if err != nil {
				t.Fatal(err)
			}
			st0 := fi0.Sys().(*syscall.Stat_t)
			st1 := fi1.Sys().(*syscall.Stat_t)
			if st0.Ino == st1.Ino {
				t.Fatalf("two surfaces shared underlying inode %d (%s vs %s)", st0.Ino, pair[0].RAMWSPath, pair[1].RAMWSPath)
			}
		}
	})
}
