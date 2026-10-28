package frames

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

func writeRGB24PNG(t *testing.T, dir, name string, w, h int, raw []byte) (string, string) {
	t.Helper()
	if len(raw) != w*h*3 {
		t.Fatalf("raw length %d != %d", len(raw), w*h*3)
	}
	path := filepath.Join(dir, name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			off := (y*w + x) * 3
			img.SetRGBA(x, y, color.RGBA{R: raw[off], G: raw[off+1], B: raw[off+2], A: 255})
		}
	}
	if err := png.Encode(file, img); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	return path, fmt.Sprintf("%x", sum[:])
}

// Kills M1: Publisher dedup ignores dimensions (daemon-adapter/internal/frames/publisher.go:425, 443-444).
func TestMutantM1PublisherDedupHonorsDimensions(t *testing.T) {
	root, b, f := ramFixture(t)
	pub, err := NewPublisher(PublishConfig{
		RAMRoot:       root,
		MaxFrameBytes: 64 << 20,
		MaxPixels:     64 << 20,
		MaxSurfaces:   4,
		Deduplicate:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	b.Surface.Geometry = capsule.Geometry{W: 4, H: 4}
	raw := []byte{10, 20, 30, 40, 50, 60}
	path2x1, sha := writeRGB24PNG(t, b.FramesRoot, "dim_2x1.png", 2, 1, raw)
	path1x2, sha1x2 := writeRGB24PNG(t, b.FramesRoot, "dim_1x2.png", 1, 2, raw)
	if sha != sha1x2 {
		t.Fatalf("expected identical RGB24 SHA256 across 2x1 and 1x2, got %s vs %s", sha, sha1x2)
	}

	// Step 1: Publish initial 2x1 frame.
	f1 := f
	f1.Seq = 1
	f1.Path = path2x1
	f1.Width = 2
	f1.Height = 1
	f1.SHA256RGB24 = sha
	f1.Window = &capsule.Window{ID: "w1", W: 2, H: 1}
	ref1, changed1, err := pub.PublishIfChanged("a", b, f1)
	if err != nil || !changed1 || ref1.Generation != 1 || ref1.Width != 2 || ref1.Height != 1 {
		t.Fatalf("initial publish failed: ref=%+v changed=%v err=%v", ref1, changed1, err)
	}

	// Negative control: identical SHA and identical 2x1 dimensions deduplicates.
	f2 := f1
	f2.Seq = 2
	ref2, changed2, err := pub.PublishIfChanged("a", b, f2)
	if err != nil || changed2 || ref2.Generation != 1 || ref2.RAMWSPath != ref1.RAMWSPath {
		t.Fatalf("negative control failed: expected unchanged 2x1 to deduplicate: ref=%+v changed=%v err=%v", ref2, changed2, err)
	}

	// Step 2: Same RGB24 SHA256, different Width and Height (1x2 vs 2x1) -> must NOT deduplicate.
	f3 := f1
	f3.Seq = 3
	f3.Path = path1x2
	f3.Width = 1
	f3.Height = 2
	f3.Window = &capsule.Window{ID: "w1", W: 1, H: 2}
	ref3, changed3, err := pub.PublishIfChanged("a", b, f3)
	if err != nil || !changed3 || ref3.Generation != 2 || ref3.Width != 1 || ref3.Height != 2 || ref3.RAMWSPath == ref1.RAMWSPath {
		t.Fatalf("expected same-SHA different-dimensions (1x2) to publish new generation 2, got ref=%+v changed=%v err=%v", ref3, changed3, err)
	}

	// Step 3: Isolate Width-only vs Height-only conjuncts in `unchanged` by seeding old.refs[last]
	// with matching SHA and one matching dimension while varying the other.
	pub.mu.Lock()
	st := pub.surfaces["a"]
	st.refs[len(st.refs)-1].Width = 2
	st.refs[len(st.refs)-1].Height = 2 // matches Height=2 below, differs in Width (2 vs 1)
	pub.surfaces["a"] = st
	pub.mu.Unlock()

	f4 := f3
	f4.Seq = 4
	ref4, changed4, err := pub.PublishIfChanged("a", b, f4)
	if err != nil || !changed4 || ref4.Generation != 3 || ref4.Width != 1 || ref4.Height != 2 {
		t.Fatalf("expected Width mismatch with matching SHA+Height to publish generation 3, got ref=%+v changed=%v err=%v", ref4, changed4, err)
	}

	pub.mu.Lock()
	st = pub.surfaces["a"]
	st.refs[len(st.refs)-1].Width = 2 // matches Width=2 below, differs in Height (2 vs 1)
	st.refs[len(st.refs)-1].Height = 2
	pub.surfaces["a"] = st
	pub.mu.Unlock()

	f5 := f1
	f5.Seq = 5
	ref5, changed5, err := pub.PublishIfChanged("a", b, f5)
	if err != nil || !changed5 || ref5.Generation != 4 || ref5.Width != 2 || ref5.Height != 1 {
		t.Fatalf("expected Height mismatch with matching SHA+Width to publish generation 4, got ref=%+v changed=%v err=%v", ref5, changed5, err)
	}

	// Step 4: Fast-path `sameEncoded` dimension guards (publisher.go:425).
	// Hold encoded PNG bytes and SHA equal while varying claimed f.Width or f.Height;
	// decodeAndVerifyPNG must run and reject the dimension mismatch instead of taking sameEncoded.
	fBadW := f5
	fBadW.Seq = 6
	fBadW.Width = 1
	fBadW.Height = 1
	fBadW.Window = &capsule.Window{ID: "w1", W: 1, H: 1}
	if _, _, err := pub.PublishIfChanged("a", b, fBadW); err == nil {
		t.Fatal("expected sameEncoded to reject claimed Width=1 against 2x1 encoded PNG")
	}

	fBadH := f5
	fBadH.Seq = 7
	fBadH.Width = 2
	fBadH.Height = 2
	fBadH.Window = &capsule.Window{ID: "w1", W: 2, H: 2}
	if _, _, err := pub.PublishIfChanged("a", b, fBadH); err == nil {
		t.Fatal("expected sameEncoded to reject claimed Height=2 against 2x1 encoded PNG")
	}
}

type transientCadenceSource struct {
	mu      sync.Mutex
	b       capsule.Binding
	f       capsule.NativeFrame
	clock   *cadenceClock
	starts  chan time.Time
	calls   int
	overrun time.Duration
}

func (s *transientCadenceSource) Capture(_ context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
	s.starts <- s.clock.Now()
	s.mu.Lock()
	s.calls++
	call := s.calls
	b := s.b
	f := s.f
	f.Seq = uint64(call)
	s.mu.Unlock()
	if call == 1 {
		s.clock.advance(s.overrun)
		return capsule.Binding{}, capsule.NativeFrame{}, errors.New("transient capture fault")
	}
	s.clock.advance(10 * time.Millisecond)
	return b, f, nil
}

// Kills M2: Transient-branch cadence skipped or miscounted (daemon-adapter/internal/frames/subscriptions.go:508-519).
func TestMutantM2TransientPollKeepsCadenceAndCapsContentionWait(t *testing.T) {
	t.Run("transient overrun advances deadline and counts missed polls", func(t *testing.T) {
		root, b, f := ramFixture(t)
		clock := newCadenceClock()
		origin := clock.Now()
		// PollInterval = 100ms. Poll 1 transiently fails after advancing fake clock by 250ms.
		// next advances to origin+100ms; now is origin+250ms -> now.Sub(next) = 150ms.
		// missed = 150ms/100ms + 1 = 2; next becomes origin+300ms; waitDur = 50ms.
		source := &transientCadenceSource{
			b:       b,
			f:       f,
			clock:   clock,
			starts:  make(chan time.Time, 8),
			overrun: 250 * time.Millisecond,
		}
		var skippedHookMissed, skippedHookTotal uint64
		subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
			MaxSubscriptions: 1,
			PollInterval:     100 * time.Millisecond,
			CaptureTimeout:   time.Second,
			ShutdownTimeout:  time.Second,
			OnSkippedPolls: func(_ string, missed, total uint64) {
				skippedHookMissed = missed
				skippedHookTotal = total
			},
		}, source, publisher(t, root), func(context.Context, json.RawMessage) error {
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		subs.clock = clock
		t.Cleanup(func() { _ = subs.Close(context.Background()) })

		if err := subs.Subscribe(context.Background(), b.Surface.SurfaceID); err != nil {
			t.Fatal(err)
		}

		start1 := cadenceReceive(t, source.starts)
		if got := start1.Sub(origin); got != 0 {
			t.Fatalf("poll 1 start = %s, want 0", got)
		}
		wait1 := cadenceReceive(t, clock.resets)
		if wait1 != 50*time.Millisecond {
			t.Fatalf("transient overrun waitDur = %s, want 50ms", wait1)
		}
		if got := subs.SkippedPolls(); got != 2 || skippedHookMissed != 2 || skippedHookTotal != 2 {
			t.Fatalf("skipped polls after transient overrun = %d (hook %d/%d), want 2", got, skippedHookMissed, skippedHookTotal)
		}

		// Advance to next deadline (origin + 300ms) and verify poll 2 starts on schedule.
		clock.advance(50 * time.Millisecond)
		start2 := cadenceReceive(t, source.starts)
		if got := start2.Sub(origin); got != 300*time.Millisecond {
			t.Fatalf("poll 2 start = %s, want 300ms", got)
		}
		wait2 := cadenceReceive(t, clock.resets)
		if wait2 != 90*time.Millisecond {
			t.Fatalf("poll 2 waitDur = %s, want 90ms", wait2)
		}
	})

	t.Run("non-overrun transient advances deadline by one interval", func(t *testing.T) {
		root, b, f := ramFixture(t)
		clock := newCadenceClock()
		origin := clock.Now()
		// Poll 1 transiently fails after 30ms (< 100ms PollInterval).
		// next advances to origin+100ms; missed = 0; waitDur = 70ms.
		source := &transientCadenceSource{
			b:       b,
			f:       f,
			clock:   clock,
			starts:  make(chan time.Time, 8),
			overrun: 30 * time.Millisecond,
		}
		subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
			MaxSubscriptions: 1,
			PollInterval:     100 * time.Millisecond,
			CaptureTimeout:   time.Second,
			ShutdownTimeout:  time.Second,
		}, source, publisher(t, root), func(context.Context, json.RawMessage) error {
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		subs.clock = clock
		t.Cleanup(func() { _ = subs.Close(context.Background()) })

		if err := subs.Subscribe(context.Background(), b.Surface.SurfaceID); err != nil {
			t.Fatal(err)
		}

		start1 := cadenceReceive(t, source.starts)
		if got := start1.Sub(origin); got != 0 {
			t.Fatalf("poll 1 start = %s, want 0", got)
		}
		wait1 := cadenceReceive(t, clock.resets)
		if wait1 != 70*time.Millisecond {
			t.Fatalf("transient non-overrun waitDur = %s, want 70ms (next must advance by PollInterval)", wait1)
		}
		if got := subs.SkippedPolls(); got != 0 {
			t.Fatalf("skipped polls = %d, want 0", got)
		}
	})

	t.Run("lock contention without attempted capture caps waitDur at CaptureTimeout", func(t *testing.T) {
		root, b, f := ramFixture(t)
		clock := newCadenceClock()
		var sharedMu sync.Mutex
		sharedMu.Lock()
		lockedOnEntry := true
		defer func() {
			if lockedOnEntry {
				sharedMu.Unlock()
			}
		}()

		source := &cadenceSource{
			captureSource: &captureSource{b: b, f: f},
			clock:         clock,
			work:          5 * time.Millisecond,
			starts:        make(chan time.Time, 8),
		}
		// PollInterval = 500ms, CaptureTimeout = 5ms.
		// Poll 1 cannot acquire sharedMu within 5ms, so attemptedCapture is false.
		// Fake clock did not advance, so next.Sub(now) = 500ms > CaptureTimeout (5ms).
		// The cap at subscriptions.go:516-518 must clamp waitDur to 5ms.
		subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
			MaxSubscriptions: 1,
			CaptureLock:      &sharedMu,
			PollInterval:     500 * time.Millisecond,
			CaptureTimeout:   5 * time.Millisecond,
			ShutdownTimeout:  time.Second,
		}, source, publisher(t, root), func(context.Context, json.RawMessage) error {
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		subs.clock = clock
		t.Cleanup(func() { _ = subs.Close(context.Background()) })

		if err := subs.Subscribe(context.Background(), b.Surface.SurfaceID); err != nil {
			t.Fatal(err)
		}

		wait1 := cadenceReceive(t, clock.resets)
		if wait1 != 5*time.Millisecond {
			t.Fatalf("lock contention waitDur = %s, want 5ms (CaptureTimeout cap)", wait1)
		}
		select {
		case <-source.starts:
			t.Fatal("Capture must not be called while CaptureLock is held")
		default:
		}

		sharedMu.Unlock()
		lockedOnEntry = false
		clock.advance(5 * time.Millisecond)
		cadenceReceive(t, source.starts)
		wait2 := cadenceReceive(t, clock.resets)
		if wait2 <= 5*time.Millisecond {
			t.Fatalf("expected normal uncapped waitDur after lock release, got %s", wait2)
		}
	})
}

// Kills M3: Dedup-default flipped (daemon-adapter/internal/frames/subscriptions.go:113-118).
func TestMutantM3DedupDefaultInitialUnchangedPolls(t *testing.T) {
	root, b, f := ramFixture(t)
	clock := newCadenceClock()
	source := &cadenceSource{
		captureSource: &captureSource{b: b, f: f},
		clock:         clock,
		work:          time.Millisecond,
		starts:        make(chan time.Time, 16),
	}
	events := make(chan json.RawMessage, 16)
	// Leave InitialUnchangedPolls unset (0) so initialUnchangedPolls() uses its default of 2.
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions:     1,
		PollInterval:         10 * time.Millisecond,
		CaptureTimeout:       time.Second,
		ShutdownTimeout:      time.Second,
		DeduplicateUnchanged: true,
	}, source, publisher(t, root), func(_ context.Context, msg json.RawMessage) error {
		events <- msg
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	subs.clock = clock
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	if got := subs.initialUnchangedPolls(); got != 2 {
		t.Fatalf("initialUnchangedPolls() default = %d, want 2", got)
	}

	if err := subs.Subscribe(context.Background(), b.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}

	// Poll 1 and Poll 2 must both emit frame_ready (generations 1 and 2).
	for wantGen := uint64(1); wantGen <= 2; wantGen++ {
		cadenceReceive(t, source.starts)
		wait := cadenceReceive(t, clock.resets)
		select {
		case raw := <-events:
			var ev struct {
				Event string `json:"event"`
				Data  struct {
					FrameRef Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &ev); err != nil || ev.Event != "frame_ready" || ev.Data.FrameRef.Generation != wantGen {
				t.Fatalf("poll %d emitted unexpected event: %+v err=%v", wantGen, ev, err)
			}
		default:
			t.Fatalf("poll %d did not emit confirmation frame_ready (default InitialUnchangedPolls must be 2)", wantGen)
		}
		clock.advance(wait)
	}

	// Poll 3 and Poll 4 with identical digest must be suppressed.
	for poll := 3; poll <= 4; poll++ {
		cadenceReceive(t, source.starts)
		wait := cadenceReceive(t, clock.resets)
		select {
		case raw := <-events:
			t.Fatalf("poll %d should be suppressed after 2 confirmations, got %s", poll, raw)
		default:
		}
		if poll < 4 {
			clock.advance(wait)
		}
	}
}

// Kills M4: Percentile off-by-one (daemon-adapter/internal/frames/subscriptions.go:186-193).
func TestMutantM4DurationPercentileExactSlotSelection(t *testing.T) {
	if got := durationPercentile(nil, 50); got != 0 {
		t.Fatalf("empty slice percentile = %v, want 0", got)
	}

	// Hand-computed 2-element sample [10ms, 90ms]:
	// n = 2 -> (n-1) = 1.
	// pct = 50 -> idx = 1*50/100 = 0 -> 10ms (any +1 shift or n*pct/100 picks idx 1 -> 90ms).
	// pct = 95 -> idx = 1*95/100 = 0 -> 10ms (ceil or +1 shift picks idx 1 -> 90ms).
	// pct = 100 -> idx = 1*100/100 = 1 -> 90ms (any -1 shift picks idx 0 -> 10ms).
	two := []time.Duration{90 * time.Millisecond, 10 * time.Millisecond}
	if got := durationPercentile(two, 50); got != 10*time.Millisecond {
		t.Fatalf("2-sample p50 = %v, want 10ms", got)
	}
	if got := durationPercentile(two, 95); got != 10*time.Millisecond {
		t.Fatalf("2-sample p95 = %v, want 10ms", got)
	}
	if got := durationPercentile(two, 100); got != 90*time.Millisecond {
		t.Fatalf("2-sample p100 = %v, want 90ms", got)
	}

	// Hand-computed 3-element sample [10ms, 20ms, 30ms]:
	// n = 3 -> (n-1) = 2.
	// pct = 50 -> idx = 2*50/100 = 1 -> 20ms (-1 shift gives 10ms, +1 shift gives 30ms).
	// pct = 95 -> idx = 2*95/100 = 1 -> 20ms (+1 shift gives 30ms).
	three := []time.Duration{30 * time.Millisecond, 10 * time.Millisecond, 20 * time.Millisecond}
	if got := durationPercentile(three, 50); got != 20*time.Millisecond {
		t.Fatalf("3-sample p50 = %v, want 20ms", got)
	}
	if got := durationPercentile(three, 95); got != 20*time.Millisecond {
		t.Fatalf("3-sample p95 = %v, want 20ms", got)
	}

	// Hand-computed 21-element sample [10ms, 20ms, ..., 210ms]:
	// n = 21 -> (n-1) = 20.
	// pct = 50 -> idx = 20*50/100 = 10 -> 110ms.
	// pct = 95 -> idx = 20*95/100 = 19 -> 200ms (-1 gives 190ms, +1 gives 210ms).
	twentyOne := make([]time.Duration, 21)
	for i := range twentyOne {
		twentyOne[i] = time.Duration(21-i) * 10 * time.Millisecond
	}
	if got := durationPercentile(twentyOne, 50); got != 110*time.Millisecond {
		t.Fatalf("21-sample p50 = %v, want 110ms", got)
	}
	if got := durationPercentile(twentyOne, 95); got != 200*time.Millisecond {
		t.Fatalf("21-sample p95 = %v, want 200ms", got)
	}

	// Verify summarizeStageDurations against hand-computed values for 3 samples.
	summary := summarizeStageDurations([]StageDurations{
		{Capture: 30 * time.Millisecond, Decode: 300 * time.Microsecond, Hash: 3 * time.Millisecond, Write: 30 * time.Microsecond, Total: 33330 * time.Microsecond},
		{Capture: 10 * time.Millisecond, Decode: 100 * time.Microsecond, Hash: 1 * time.Millisecond, Write: 10 * time.Microsecond, Total: 11110 * time.Microsecond},
		{Capture: 20 * time.Millisecond, Decode: 200 * time.Microsecond, Hash: 2 * time.Millisecond, Write: 20 * time.Microsecond, Total: 22220 * time.Microsecond},
	})
	if summary.Samples != 3 ||
		summary.CaptureP50 != 20*time.Millisecond || summary.CaptureP95 != 20*time.Millisecond ||
		summary.DecodeP50 != 200*time.Microsecond || summary.DecodeP95 != 200*time.Microsecond ||
		summary.HashP50 != 2*time.Millisecond || summary.HashP95 != 2*time.Millisecond ||
		summary.WriteP50 != 20*time.Microsecond || summary.WriteP95 != 20*time.Microsecond ||
		summary.TotalP50 != 22220*time.Microsecond || summary.TotalP95 != 22220*time.Microsecond {
		t.Fatalf("unexpected stage summary: %+v", summary)
	}
}

// Kills M7: Unchanged hardlink skips size or regular-file check (daemon-adapter/internal/frames/publisher.go:605-614).
func TestMutantM7UnchangedHardlinkVerifiesRegularFileAndExpectedSize(t *testing.T) {
	root, b, f := ramFixture(t)
	pub := publisher(t, root)
	wantRaw := []byte{255, 0, 0, 0, 255, 0}

	// Step 1: Initial forced publish creates generation 1 (6-byte .rgb file).
	f.Seq = 1
	ref1, err := pub.PublishForced("a", b, f)
	if err != nil {
		t.Fatal(err)
	}

	// Negative control: when ref1.RAMWSPath is an intact regular file of size 6,
	// a forced publish of identical content hardlinks to ref1.RAMWSPath (same inode).
	f.Seq = 2
	ref2, err := pub.PublishForced("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	var st1, st2 syscall.Stat_t
	if err := syscall.Lstat(ref1.RAMWSPath, &st1); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Lstat(ref2.RAMWSPath, &st2); err != nil {
		t.Fatal(err)
	}
	if st1.Ino != st2.Ino {
		t.Fatalf("negative control failed: expected intact unchanged forced publish to hardlink (ino %d != %d)", st1.Ino, st2.Ino)
	}

	// Step 2: Corrupt the prior file size (append extra bytes so st.Size() != expectedBytes).
	// Next forced publish must refuse to hardlink the corrupted file and instead write a fresh 6-byte file.
	if err := os.WriteFile(ref2.RAMWSPath, []byte("corrupted-wrong-size"), 0600); err != nil {
		t.Fatal(err)
	}
	f.Seq = 3
	ref3, err := pub.PublishForced("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	gotRaw3, err := os.ReadFile(ref3.RAMWSPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(gotRaw3) != len(wantRaw) || string(gotRaw3) != string(wantRaw) {
		t.Fatalf("size-corrupted prior file was hardlinked instead of rewritten: got %q (%d bytes), want %q", gotRaw3, len(gotRaw3), wantRaw)
	}

	// Step 3: Replace the prior path with a non-regular file (symlink) whose target or lstat size is 6 bytes.
	// On 6-byte target name "123456", symlink lstat size is 6 == expectedBytes, testing st.Mode().IsRegular() specifically.
	if err := os.Remove(ref3.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("123456", ref3.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	f.Seq = 4
	ref4, err := pub.PublishForced("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	var st4 syscall.Stat_t
	if err := syscall.Lstat(ref4.RAMWSPath, &st4); err != nil {
		t.Fatal(err)
	}
	if st4.Mode&syscall.S_IFMT != syscall.S_IFREG || st4.Size != int64(len(wantRaw)) {
		t.Fatalf("non-regular prior path was hardlinked instead of rewritten as regular file: mode=%o size=%d", st4.Mode, st4.Size)
	}
	gotRaw4, err := os.ReadFile(ref4.RAMWSPath)
	if err != nil || string(gotRaw4) != string(wantRaw) {
		t.Fatalf("unexpected content in ref4: %q err=%v", gotRaw4, err)
	}

	// Step 4: Exercise the `raw == nil` fallback decode branch (publisher.go:615-623) when
	// `sameEncoded` was true at line 425 (skipping initial decode) AND hardlink fails at line 608
	// because the prior output file was corrupted. If that fallback decode sees a corrupted PNG
	// (e.g. mutated IHDR width), it must return an error.
	if err := os.WriteFile(ref4.RAMWSPath, []byte("corrupted-again"), 0600); err != nil {
		t.Fatal(err)
	}
	f.Seq = 5
	ref5, err := pub.PublishForced("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	gotRaw5, err := os.ReadFile(ref5.RAMWSPath)
	if err != nil || string(gotRaw5) != string(wantRaw) {
		t.Fatalf("fallback decode when sameEncoded=true and hardlink skipped failed: %q err=%v", gotRaw5, err)
	}

	// Also verify fallback decode error return when prevEncoded matches corrupted PNG header.
	badPNG := append([]byte(nil), pub.surfaces["a"].encoded...)
	binary.BigEndian.PutUint32(badPNG[16:20], 99)
	badPath := filepath.Join(b.FramesRoot, "bad_ihdr.png")
	if err := os.WriteFile(badPath, badPNG, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ref5.RAMWSPath, []byte("corrupted"), 0600); err != nil {
		t.Fatal(err)
	}
	pub.mu.Lock()
	stA := pub.surfaces["a"]
	stA.encoded = badPNG
	pub.surfaces["a"] = stA
	pub.mu.Unlock()
	fBad := f
	fBad.Seq = 6
	fBad.Path = badPath
	if _, err := pub.PublishForced("a", b, fBad); err == nil {
		t.Fatal("expected fallback decode error when sameEncoded bypassed first decode and hardlink was rejected")
	}
}
