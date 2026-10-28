package frames

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
)

type captureSource struct {
	mu    sync.Mutex
	b     capsule.Binding
	f     capsule.NativeFrame
	err   error
	calls int
}

func (s *captureSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.f.Seq++
	return s.b, s.f, s.err
}
func TestSubscriptions(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	b.Surface.Visibility = "folded"
	source := &captureSource{b: b, f: f}
	events := make(chan json.RawMessage, 8)
	subs, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case events <- msg:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := subs.Close(context.Background()); e != nil {
			t.Error(e)
		}
	})
	if e = subs.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	if e = subs.Subscribe(context.Background(), "b"); e == nil {
		t.Fatal("subscription cap ignored")
	}
	var previous uint64
	for i := 0; i < 3; i++ {
		select {
		case msg := <-events:
			var ev struct {
				Event string `json:"event"`
				Data  struct {
					FrameRef Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if e = json.Unmarshal(msg, &ev); e != nil {
				t.Fatal(e)
			}
			if ev.Event != "frame_ready" || ev.Data.FrameRef.Tick <= previous {
				t.Fatal("folded capture stopped progressing")
			}
			previous = ev.Data.FrameRef.Tick
		case <-time.After(time.Second):
			t.Fatal("folded capture stalled")
		}
	}
	if e = subs.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	source.mu.Lock()
	calls := source.calls
	source.mu.Unlock()
	if e = subs.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal("late unsubscribe refused")
	}
	source.mu.Lock()
	if source.calls != calls {
		t.Fatal("capture after unsubscribe")
	}
	source.mu.Unlock()
}
func TestSubscriptionFailure(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	source := &captureSource{b: b, f: f, err: errors.New("capture unavailable")}
	delivered := make(chan json.RawMessage, 1)
	subs, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, p, func(ctx context.Context, msg json.RawMessage) error { delivered <- msg; return nil })
	if e != nil {
		t.Fatal(e)
	}
	if e = subs.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	select {
	case msg := <-delivered:
		var event map[string]json.RawMessage
		if e = json.Unmarshal(msg, &event); e != nil {
			t.Fatal(e)
		}
		if string(event["event"]) != `"error"` {
			t.Fatal("capture failure emitted fabricated frame")
		}
	case <-time.After(time.Second):
		t.Fatal("missing failure event")
	}
	if e = subs.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	if e = subs.Close(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e = subs.Subscribe(context.Background(), "a"); e == nil {
		t.Fatal("closed service accepted subscription")
	}
}

type blockedSource struct {
	entered chan struct{}
	release chan struct{}
}

func (s *blockedSource) Capture(context.Context, string) (capsule.Binding, capsule.NativeFrame, error) {
	close(s.entered)
	<-s.release
	return capsule.Binding{}, capsule.NativeFrame{}, errors.New("released")
}
func TestSubscriptionShutdownBound(t *testing.T) {
	root, _, _ := ramFixture(t)
	p := publisher(t, root)
	source := &blockedSource{entered: make(chan struct{}), release: make(chan struct{})}
	s, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: 10 * time.Millisecond}, source, p, func(context.Context, json.RawMessage) error { t.Error("emitted after cancellation"); return nil })
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	select {
	case <-source.entered:
	case <-time.After(time.Second):
		close(source.release)
		t.Fatal("capture never started")
	}
	e = s.Close(context.Background())
	close(source.release)
	if !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal("blocked source silently passed shutdown gate")
	}
	if e = s.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
}
func TestSubscriptionDeliveryFailure(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	source := &captureSource{b: b, f: f}
	sentinel := errors.New("delivery refused")
	delivered := make(chan json.RawMessage, 8)
	var mu sync.Mutex
	refuse := true
	s, e := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case delivered <- msg:
		case <-ctx.Done():
			return ctx.Err()
		}
		mu.Lock()
		defer mu.Unlock()
		if refuse {
			return sentinel
		}
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := s.Close(context.Background()); e != nil {
			t.Error(e)
		}
	})
	if e = s.Subscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	deadline := time.After(time.Second)
	for {
		s.mu.Lock()
		_, active := s.tasks["a"]
		s.mu.Unlock()
		if !active {
			break
		}
		select {
		case <-deadline:
			t.Fatal("delivery failure failed to remove subscription")
		case <-time.After(time.Millisecond):
		}
	}
	if !errors.Is(s.TerminalError("a"), sentinel) {
		t.Fatal("delivery failure was hidden")
	}
	// Completion includes notification delivery: require exactly one attempted
	// frame and one failure, even when the failure notification is refused too.
	if len(delivered) != 2 {
		t.Fatalf("expected one frame attempt and one failure notification, got %d", len(delivered))
	}
	var frame struct{ Event string }
	if msg := <-delivered; json.Unmarshal(msg, &frame) != nil || frame.Event != "frame_ready" {
		t.Fatalf("missing initial frame attempt: %s", msg)
	}
	var failure capsule.ErrorEvent
	if msg := <-delivered; json.Unmarshal(msg, &failure) != nil || failure.Event != "error" || failure.Data.Code != "capture_failed" || failure.Data.SurfaceID != "a" {
		t.Fatalf("missing capture_failed notification: %s", msg)
	}
	mu.Lock()
	refuse = false
	mu.Unlock()
	if e = s.Subscribe(context.Background(), "a"); e != nil {
		t.Fatalf("failed subscription retained capacity: %v", e)
	}
	for i := 0; i < 2; i++ {
		select {
		case msg := <-delivered:
			if json.Unmarshal(msg, &frame) != nil || frame.Event != "frame_ready" {
				t.Fatalf("healthy subscription did not resume frames: %s", msg)
			}
		case <-time.After(time.Second):
			t.Fatal("healthy subscription stalled after delivery failure")
		}
	}
	if e = s.Unsubscribe(context.Background(), "a"); e != nil {
		t.Fatal(e)
	}
	if s.TerminalError("a") != nil {
		t.Fatal("healthy subscription retained a terminal failure")
	}
}

func TestSubscriptionDeduplicatesUnchangedDigestAndPublishesOnMutation(t *testing.T) {
	root, b, f := ramFixture(t)
	p, err := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 64 << 20, MaxPixels: 64, MaxSurfaces: 4})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })

	source := &captureSource{b: b, f: f}
	events := make(chan json.RawMessage, 16)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions:      1,
		PollInterval:          2 * time.Millisecond,
		CaptureTimeout:        time.Second,
		ShutdownTimeout:       time.Second,
		DeduplicateUnchanged:  true,
		InitialUnchangedPolls: 2,
	}, source, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case events <- msg:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	// Initial 2 confirmation polls must be delivered.
	for i := 1; i <= 2; i++ {
		select {
		case msg := <-events:
			var ev struct {
				Event string `json:"event"`
				Data  struct {
					FrameRef Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" || ev.Data.FrameRef.Generation != uint64(i) {
				t.Fatalf("unexpected initial event %d: %+v err=%v", i, ev, err)
			}
		case <-time.After(time.Second):
			t.Fatal("stalled waiting for initial subscription frames")
		}
	}

	// Wait until at least 6 capture polls have occurred with identical SHA256RGB24.
	deadline := time.After(time.Second)
	for {
		source.mu.Lock()
		calls := source.calls
		source.mu.Unlock()
		if calls >= 6 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("source did not advance to 6 polls")
		case <-time.After(time.Millisecond):
		}
	}
	// No extra frame_ready events may be emitted while content hash is unchanged.
	select {
	case msg := <-events:
		t.Fatalf("expected unchanged frames after initial confirmation to be suppressed, got %s", msg)
	default:
	}

	// Negative control: mutate pixel content and SHA256RGB24; the next poll must emit generation 3.
	changedPath := filepath.Join(b.FramesRoot, "changed.png")
	cf, err := os.OpenFile(changedPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 2, 1))
	img.SetRGBA(0, 0, color.RGBA{R: 11, G: 22, B: 33, A: 255})
	img.SetRGBA(1, 0, color.RGBA{R: 44, G: 55, B: 66, A: 255})
	if err := png.Encode(cf, img); err != nil {
		t.Fatal(err)
	}
	if err := cf.Close(); err != nil {
		t.Fatal(err)
	}
	changedSum := sha256.Sum256([]byte{11, 22, 33, 44, 55, 66})
	changedHex := fmt.Sprintf("%x", changedSum[:])

	source.mu.Lock()
	source.f.Path = changedPath
	source.f.SHA256RGB24 = changedHex
	source.mu.Unlock()

	select {
	case msg := <-events:
		var ev struct {
			Event string `json:"event"`
			Data  struct {
				FrameRef Ref `json:"frame_ref"`
			} `json:"data"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" || ev.Data.FrameRef.Generation != 3 || ev.Data.FrameRef.SHA256 != changedHex {
			t.Fatalf("expected changed digest to emit generation 3 with new SHA256, got %+v err=%v", ev, err)
		}
	case <-time.After(time.Second):
		t.Fatal("stalled waiting for mutated frame delivery")
	}
}

type rewritingSource struct {
	mu    sync.Mutex
	b     capsule.Binding
	f     capsule.NativeFrame
	rgb   []byte
	w, h  int
	calls uint64
}

func (s *rewritingSource) Capture(_ context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	seq := s.calls
	img := image.NewRGBA(image.Rect(0, 0, s.w, s.h))
	for y := 0; y < s.h; y++ {
		for x := 0; x < s.w; x++ {
			off := (y*s.w + x) * 3
			img.SetRGBA(x, y, color.RGBA{R: s.rgb[off], G: s.rgb[off+1], B: s.rgb[off+2], A: 255})
		}
	}
	levels := []png.CompressionLevel{png.NoCompression, png.BestSpeed, png.DefaultCompression, png.BestCompression}
	enc := png.Encoder{CompressionLevel: levels[seq%uint64(len(levels))]}
	path := filepath.Join(s.b.FramesRoot, fmt.Sprintf("rewrite-%d.png", seq))
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return capsule.Binding{}, capsule.NativeFrame{}, err
	}
	if err := enc.Encode(file, img); err != nil {
		_ = file.Close()
		return capsule.Binding{}, capsule.NativeFrame{}, err
	}
	if err := file.Close(); err != nil {
		return capsule.Binding{}, capsule.NativeFrame{}, err
	}
	mtime := time.Now().Add(time.Duration(seq) * time.Second)
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		return capsule.Binding{}, capsule.NativeFrame{}, err
	}
	sum := sha256.Sum256(s.rgb)
	f := s.f
	f.Path = path
	f.Seq = seq
	f.Width = s.w
	f.Height = s.h
	f.SHA256RGB24 = fmt.Sprintf("%x", sum[:])
	f.CaptureMonoNS = 1000 + seq
	if f.Window != nil {
		win := *f.Window
		win.W = s.w
		win.H = s.h
		f.Window = &win
	}
	b := s.b
	b.Surface.Geometry.W = s.w
	b.Surface.Geometry.H = s.h
	return b, f, nil
}

func TestSubscriptionDeduplicatesReencodedPNGWithNewMtimeAndSizeMutation(t *testing.T) {
	root, b, f := ramFixture(t)
	p, err := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 64 << 20, MaxPixels: 64, MaxSurfaces: 4, Deduplicate: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })

	src := &rewritingSource{
		b:   b,
		f:   f,
		rgb: []byte{1, 2, 3, 4, 5, 6},
		w:   2,
		h:   1,
	}
	events := make(chan json.RawMessage, 16)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions:      1,
		PollInterval:          2 * time.Millisecond,
		CaptureTimeout:        time.Second,
		ShutdownTimeout:       time.Second,
		DeduplicateUnchanged:  true,
		InitialUnchangedPolls: 2,
	}, src, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case events <- msg:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		select {
		case msg := <-events:
			var ev struct {
				Data struct {
					FrameRef Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if err := json.Unmarshal(msg, &ev); err != nil || ev.Data.FrameRef.Generation != uint64(i) {
				t.Fatalf("initial confirmation %d: %+v err=%v", i, ev, err)
			}
		case <-time.After(time.Second):
			t.Fatal("stalled waiting for initial confirmation")
		}
	}

	deadline := time.After(time.Second)
	for {
		src.mu.Lock()
		calls := src.calls
		src.mu.Unlock()
		if calls >= 8 {
			break
		}
		select {
		case msg := <-events:
			t.Fatalf("unexpected frame_ready on re-encoded identical RGB24 poll: %s", msg)
		case <-deadline:
			t.Fatal("rewritingSource did not advance to 8 polls")
		case <-time.After(time.Millisecond):
		}
	}

	// Resubscribe after unsubscribe emits 1 confirmation frame (gen 3), then suppresses subsequent identical polls.
	if err := subs.Unsubscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-events:
		var ev struct {
			Data struct {
				FrameRef Ref `json:"frame_ref"`
			} `json:"data"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Data.FrameRef.Generation != 3 {
			t.Fatalf("resubscribe confirmation: %+v err=%v", ev, err)
		}
	case <-time.After(time.Second):
		t.Fatal("stalled waiting for resubscribe confirmation")
	}

	src.mu.Lock()
	baseCalls := src.calls
	src.mu.Unlock()
	deadline = time.After(time.Second)
	for {
		src.mu.Lock()
		calls := src.calls
		src.mu.Unlock()
		if calls >= baseCalls+5 {
			break
		}
		select {
		case msg := <-events:
			t.Fatalf("unexpected duplicate frame_ready after resubscribe confirmation: %s", msg)
		case <-deadline:
			t.Fatal("rewritingSource did not advance after resubscribe")
		case <-time.After(time.Millisecond):
		}
	}

	// Negative control: changing geometry (1x2 with identical RGB24 byte stream) must emit generation 4.
	src.mu.Lock()
	src.w = 1
	src.h = 2
	src.mu.Unlock()

	select {
	case msg := <-events:
		var ev struct {
			Data struct {
				FrameRef Ref `json:"frame_ref"`
			} `json:"data"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Data.FrameRef.Generation != 4 || ev.Data.FrameRef.Width != 1 || ev.Data.FrameRef.Height != 2 {
			t.Fatalf("expected geometry change to emit generation 4 (1x2), got %+v err=%v", ev, err)
		}
	case <-time.After(time.Second):
		t.Fatal("stalled waiting for geometry change frame_ready")
	}
}

type gatedCaptureSource struct {
	mu    sync.Mutex
	b     capsule.Binding
	f     capsule.NativeFrame
	err   error
	calls int
}

func (s *gatedCaptureSource) Capture(_ context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.err != nil {
		return capsule.Binding{}, capsule.NativeFrame{}, s.err
	}
	s.f.Seq++
	return s.b, s.f, nil
}

func TestResubscribeAfterUnsubscribeReconfirms(t *testing.T) {
	root, b, f := ramFixture(t)
	p, err := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 64 << 20, MaxPixels: 64, MaxSurfaces: 4})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })

	src := &gatedCaptureSource{b: b, f: f}
	if _, badErr := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions:      1,
		PollInterval:          2 * time.Millisecond,
		CaptureTimeout:        time.Second,
		ShutdownTimeout:       time.Second,
		DeduplicateUnchanged:  true,
		InitialUnchangedPolls: -1,
	}, src, p, func(context.Context, json.RawMessage) error { return nil }); badErr == nil {
		t.Fatal("expected NewSubscriptions to reject negative InitialUnchangedPolls")
	}

	events := make(chan json.RawMessage, 16)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions:      1,
		PollInterval:          2 * time.Millisecond,
		CaptureTimeout:        time.Second,
		ShutdownTimeout:       time.Second,
		DeduplicateUnchanged:  true,
		InitialUnchangedPolls: 2,
	}, src, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case events <- msg:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	// Configure source to fail on the 3rd poll after 2 initial confirmations.
	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		select {
		case msg := <-events:
			var ev struct {
				Event string `json:"event"`
			}
			if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" {
				t.Fatalf("expected initial confirmation %d frame_ready, got %s (%v)", i, msg, err)
			}
			if i == 2 {
				src.mu.Lock()
				src.err = errors.New("poll 3 failed")
				src.mu.Unlock()
			}
		case <-time.After(time.Second):
			t.Fatalf("stalled waiting for initial confirmation %d", i)
		}
	}

	select {
	case msg := <-events:
		var ev struct {
			Event string `json:"event"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "error" {
			t.Fatalf("expected error event on failed 3rd poll, got %s (%v)", msg, err)
		}
	case <-time.After(time.Second):
		t.Fatal("stalled waiting for failure event on 3rd poll")
	}

	// Wait for the failed task to finish recording its failure before calling Unsubscribe.
	deadline := time.After(time.Second)
	for {
		if subs.TerminalError("a") != nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("failed poll did not record terminal error")
		case <-time.After(time.Millisecond):
		}
	}

	if err := subs.Unsubscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	src.mu.Lock()
	src.err = nil
	src.mu.Unlock()

	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		select {
		case msg := <-events:
			var ev struct {
				Event string `json:"event"`
			}
			if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" {
				t.Fatalf("expected reconfirmation %d frame_ready after failed+unsubscribed resubscribe, got %s (%v)", i, msg, err)
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("expected 2 frame_ready confirmations after unsubscribe of failed task; stalled at confirmation %d", i)
		}
	}

	if err := subs.Unsubscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if err := p.Release("a"); err != nil {
		t.Fatal(err)
	}
	subs.mu.Lock()
	_, leakedConfirmed := subs.confirmed["a"]
	subs.mu.Unlock()
	if leakedConfirmed {
		t.Fatal("expected Publisher.Release to delete confirmed entry for released surface")
	}
}

type lossAwareCaptureSource struct {
	mu        sync.Mutex
	b         capsule.Binding
	f         capsule.NativeFrame
	failPolls map[int]error
	calls     int
	marked    int
}

func (s *lossAwareCaptureSource) Capture(_ context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if err, ok := s.failPolls[s.calls]; ok && err != nil {
		return capsule.Binding{}, capsule.NativeFrame{}, err
	}
	if s.b.Surface.State == "lost" {
		return capsule.Binding{}, capsule.NativeFrame{}, &cli.Fault{Code: "POLICY", Detail: "surface is lost"}
	}
	s.f.Seq++
	return s.b, s.f, nil
}

func (s *lossAwareCaptureSource) MarkLost(id string, confirmedAbsent bool) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !confirmedAbsent || s.b.Surface.SurfaceID != id {
		return nil, &cli.Fault{Code: "POLICY", Detail: "unconfirmed loss"}
	}
	if s.b.Surface.State == "lost" {
		return nil, &cli.Fault{Code: "POLICY", Detail: "surface already lost"}
	}
	s.marked++
	s.b.Surface.State = "lost"
	raw, err := json.Marshal(struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
		Data   struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}{
		Schema: "surface_event/v0.2",
		Event:  "state_changed",
		Data: struct {
			Surface capsule.Surface `json:"surface"`
		}{Surface: s.b.Surface},
	})
	return raw, err
}

func TestSubscriptionConfirmedLossAndTransientRecovery(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	absenceFault := cli.ExitFault("srf-identity-surface", 6, "")
	src := &lossAwareCaptureSource{
		b: b,
		f: f,
		failPolls: map[int]error{
			// Poll 2 is a single transient capture failure; poll 3 recovers.
			2: absenceFault,
			// Polls 4 and 5 are 2 consecutive capture failures -> confirmed loss.
			4: absenceFault,
			5: absenceFault,
		},
	}
	events := make(chan json.RawMessage, 16)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions: 1,
		PollInterval:     2 * time.Millisecond,
		CaptureTimeout:   time.Second,
		ShutdownTimeout:  time.Second,
	}, src, p, func(ctx context.Context, msg json.RawMessage) error {
		select {
		case events <- msg:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}

	// Expect two frame_ready events (from poll 1 and recovered poll 3); poll 2 must NOT mark lost.
	for i := 1; i <= 2; i++ {
		select {
		case msg := <-events:
			var ev struct {
				Event string `json:"event"`
				Data  struct {
					FrameRef Ref             `json:"frame_ref"`
					Surface  capsule.Surface `json:"surface"`
				} `json:"data"`
			}
			if err := json.Unmarshal(msg, &ev); err != nil {
				t.Fatal(err)
			}
			if ev.Event != "frame_ready" {
				t.Fatalf("transient capture failure prematurely terminated or marked lost on event %d: %s", i, msg)
			}
		case <-time.After(time.Second):
			t.Fatalf("stalled waiting for frame_ready %d across transient failure", i)
		}
	}

	// After polls 4 and 5 fail consecutively, expect state_changed(lost) followed by error(capture_failed).
	select {
	case msg := <-events:
		var ev struct {
			Schema string `json:"schema"`
			Event  string `json:"event"`
			Data   struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Schema != "surface_event/v0.2" || ev.Event != "state_changed" || ev.Data.Surface.SurfaceID != "a" || ev.Data.Surface.State != "lost" {
			t.Fatalf("expected state_changed(lost) before capture_failed, got %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("stalled waiting for state_changed(lost) event")
	}

	select {
	case msg := <-events:
		var ev capsule.ErrorEvent
		if err := json.Unmarshal(msg, &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Event != "error" || ev.Data.Code != "capture_failed" || ev.Data.SurfaceID != "a" {
			t.Fatalf("expected error(capture_failed) after state_changed(lost), got %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("stalled waiting for error(capture_failed) event")
	}

	src.mu.Lock()
	marked := src.marked
	state := src.b.Surface.State
	src.mu.Unlock()
	if marked != 1 || state != "lost" {
		t.Fatalf("expected MarkLost called once and state=lost, got marked=%d state=%s", marked, state)
	}
}

func (s *lossAwareCaptureSource) BeginMarkLost(id string) (json.RawMessage, error) {
	return s.MarkLost(id, true)
}

func (s *lossAwareCaptureSource) CompleteLost(id string, delivered bool) {
	if !delivered {
		s.mu.Lock()
		if s.b.Surface.SurfaceID == id && s.b.Surface.State == "lost" {
			s.b.Surface.State = "active"
			s.marked--
		}
		s.mu.Unlock()
	}
}

func (s *lossAwareCaptureSource) WaitLostDelivered(_ context.Context, _ string) {}

func TestSubscriptionCaptureFaultClassificationDoesNotMarkLost(t *testing.T) {
	for _, code := range []string{"malformed", "frame", "surface", "cli_failed", "POLICY", "uncertain"} {
		t.Run(code, func(t *testing.T) {
			root, b, f := ramFixture(t)
			b.Surface.State = "active"
			p := publisher(t, root)
			faultErr := &cli.Fault{Code: code, Detail: "non-absence fault"}
			src := &lossAwareCaptureSource{
				b: b,
				f: f,
				failPolls: map[int]error{
					1: faultErr,
					2: faultErr,
				},
			}
			events := make(chan json.RawMessage, 8)
			subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
				MaxSubscriptions: 1,
				PollInterval:     2 * time.Millisecond,
				CaptureTimeout:   time.Second,
				ShutdownTimeout:  time.Second,
			}, src, p, func(_ context.Context, msg json.RawMessage) error {
				events <- msg
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = subs.Close(context.Background()) })

			if err := subs.Subscribe(context.Background(), "a"); err != nil {
				t.Fatal(err)
			}
			select {
			case msg := <-events:
				var ev capsule.ErrorEvent
				if err := json.Unmarshal(msg, &ev); err != nil {
					t.Fatal(err)
				}
				if ev.Event != "error" || ev.Data.Code != "capture_failed" {
					t.Fatalf("code=%s: expected error(capture_failed), got %s", code, msg)
				}
			case <-time.After(time.Second):
				t.Fatalf("code=%s: timed out waiting for capture_failed", code)
			}
			if len(events) != 0 {
				t.Fatalf("code=%s: unexpected extra event emitted", code)
			}
			src.mu.Lock()
			marked := src.marked
			state := src.b.Surface.State
			src.mu.Unlock()
			if marked != 0 || state != "active" {
				t.Fatalf("code=%s: non-absence fault marked lost (marked=%d state=%s)", code, marked, state)
			}
		})
	}
}

func TestSubscriptionMixedTransientAndAbsenceFaultDoesNotMarkLost(t *testing.T) {
	pairs := []struct {
		name string
		e1   error
		e2   error
	}{
		{
			name: "uncertain_then_frame",
			e1:   &cli.Fault{Code: "uncertain", Detail: "timeout"},
			e2:   &cli.Fault{Code: "frame", Detail: "bad frame"},
		},
		{
			name: "uncertain_then_unavailable",
			e1:   &cli.Fault{Code: "uncertain", Detail: "timeout"},
			e2:   &cli.Fault{Code: "unavailable", Detail: "gone once"},
		},
		{
			name: "unavailable_then_uncertain",
			e1:   &cli.Fault{Code: "unavailable", Detail: "gone once"},
			e2:   &cli.Fault{Code: "uncertain", Detail: "timeout"},
		},
	}
	for _, tc := range pairs {
		t.Run(tc.name, func(t *testing.T) {
			root, b, f := ramFixture(t)
			b.Surface.State = "active"
			p := publisher(t, root)
			src := &lossAwareCaptureSource{
				b: b,
				f: f,
				failPolls: map[int]error{
					1: tc.e1,
					2: tc.e2,
				},
			}
			events := make(chan json.RawMessage, 8)
			subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
				MaxSubscriptions: 1,
				PollInterval:     2 * time.Millisecond,
				CaptureTimeout:   time.Second,
				ShutdownTimeout:  time.Second,
			}, src, p, func(_ context.Context, msg json.RawMessage) error {
				events <- msg
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = subs.Close(context.Background()) })

			if err := subs.Subscribe(context.Background(), "a"); err != nil {
				t.Fatal(err)
			}
			select {
			case msg := <-events:
				var ev struct {
					Event string `json:"event"`
				}
				if err := json.Unmarshal(msg, &ev); err != nil {
					t.Fatal(err)
				}
				if ev.Event != "error" {
					t.Fatalf("%s: expected error(capture_failed), got %s", tc.name, msg)
				}
			case <-time.After(time.Second):
				t.Fatalf("%s: timed out waiting for capture_failed", tc.name)
			}
			src.mu.Lock()
			marked := src.marked
			state := src.b.Surface.State
			src.mu.Unlock()
			if marked != 0 || state != "active" {
				t.Fatalf("%s: mixed pair marked surface lost (marked=%d state=%s)", tc.name, marked, state)
			}
		})
	}
}

func TestSubscriptionResubscribeRecoversAfterTwoTransientFrameFaults(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	frameFault := &cli.Fault{Code: "frame", Detail: "torn frame"}
	src := &lossAwareCaptureSource{
		b: b,
		f: f,
		failPolls: map[int]error{
			1: frameFault,
			2: frameFault,
		},
	}
	events := make(chan json.RawMessage, 8)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions: 1,
		PollInterval:     2 * time.Millisecond,
		CaptureTimeout:   time.Second,
		ShutdownTimeout:  time.Second,
	}, src, p, func(_ context.Context, msg json.RawMessage) error {
		events <- msg
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-events:
		var ev capsule.ErrorEvent
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "error" || ev.Data.Code != "capture_failed" {
			t.Fatalf("expected capture_failed after 2 frame faults, got %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for capture_failed")
	}

	subs.mu.Lock()
	done := subs.tasks["a"]
	subs.mu.Unlock()
	if done != nil {
		<-done.done
	}

	// Resubscribe on the still-active surface: poll 3 must emit frame_ready.
	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatalf("resubscribe failed: %v", err)
	}
	select {
	case msg := <-events:
		var ev struct {
			Event string `json:"event"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" {
			t.Fatalf("expected frame_ready after resubscribe, got %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for frame_ready after resubscribe")
	}
}

func TestSubscriptionSingleLockContentionMissRecoversWithoutCaptureFailed(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	src := &lossAwareCaptureSource{b: b, f: f}
	var surfaceMu sync.Mutex
	surfaceMu.Lock()

	events := make(chan json.RawMessage, 8)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions: 1,
		PollInterval:     5 * time.Millisecond,
		CaptureTimeout:   15 * time.Millisecond,
		ShutdownTimeout:  time.Second,
		SurfaceLock:      func(string) *sync.Mutex { return &surfaceMu },
	}, src, p, func(_ context.Context, msg json.RawMessage) error {
		events <- msg
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	// Hold SurfaceLock across 1.2 * CaptureTimeout (18ms) so the first poll times out on lock wait, then release.
	time.Sleep(18 * time.Millisecond)
	surfaceMu.Unlock()

	select {
	case msg := <-events:
		var ev struct {
			Event string `json:"event"`
		}
		if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" {
			t.Fatalf("expected frame_ready after single lock contention miss, got %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for frame_ready after releasing SurfaceLock")
	}
}

func TestSubscriptionCancelDuringLostEmitRollsBackBinding(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	absenceFault := cli.ExitFault("srf-identity-surface", 4, "")

	runCase := func(blockCancel bool) (bool, bool) {
		src := &lossAwareCaptureSource{
			b: b,
			f: f,
			failPolls: map[int]error{
				1: absenceFault,
				2: absenceFault,
			},
		}
		emitStarted := make(chan struct{})
		emitDone := make(chan struct{})
		var deliveredLost atomic.Int32
		subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
			MaxSubscriptions: 1,
			PollInterval:     time.Millisecond,
			CaptureTimeout:   time.Second,
			ShutdownTimeout:  time.Second,
		}, src, p, func(ctx context.Context, msg json.RawMessage) error {
			var decoded map[string]any
			_ = json.Unmarshal(msg, &decoded)
			if decoded["event"] == "state_changed" {
				close(emitStarted)
				if blockCancel {
					<-ctx.Done()
					return ctx.Err()
				}
				deliveredLost.Add(1)
				return nil
			}
			if !blockCancel && decoded["event"] == "error" {
				close(emitDone)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := subs.Subscribe(context.Background(), "a"); err != nil {
			t.Fatal(err)
		}
		select {
		case <-emitStarted:
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for lost emit to start")
		}
		if !blockCancel {
			select {
			case <-emitDone:
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for error emit after lost delivery")
			}
		}
		if err := subs.Close(context.Background()); err != nil {
			t.Fatal(err)
		}
		src.mu.Lock()
		state := src.b.Surface.State
		src.mu.Unlock()
		lostDelivered := deliveredLost.Load() > 0
		bindingActive := state == "active"
		if lostDelivered == bindingActive {
			t.Fatalf("expected lostDelivered XOR bindingActive (blockCancel=%v), got lostDelivered=%v state=%s", blockCancel, lostDelivered, state)
		}
		return lostDelivered, bindingActive
	}

	lostDeliveredCancel, activeCancel := runCase(true)
	if lostDeliveredCancel || !activeCancel {
		t.Fatalf("cancelled emit must roll back to active without delivery, got lostDelivered=%v active=%v", lostDeliveredCancel, activeCancel)
	}
	lostDeliveredOk, activeOk := runCase(false)
	if !lostDeliveredOk || activeOk {
		t.Fatalf("completed emit must deliver lost and transition binding to lost, got lostDelivered=%v active=%v", lostDeliveredOk, activeOk)
	}
}

type coordinatedLossSource struct {
	mu          sync.Mutex
	b           capsule.Binding
	calls       int
	secondEnter chan struct{}
	livenessSet chan struct{}
	lostDone    chan struct{}
}

func (s *coordinatedLossSource) Capture(_ context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
	s.mu.Lock()
	s.calls++
	call := s.calls
	if s.b.Surface.State != "active" {
		s.mu.Unlock()
		return capsule.Binding{}, capsule.NativeFrame{}, &cli.Fault{Code: "surface", Detail: "capture requires an active surface"}
	}
	s.mu.Unlock()
	if call == 2 {
		close(s.secondEnter)
		<-s.livenessSet
		s.mu.Lock()
		state := s.b.Surface.State
		s.mu.Unlock()
		if state != "active" {
			return capsule.Binding{}, capsule.NativeFrame{}, &cli.Fault{Code: "surface", Detail: "capture requires an active surface"}
		}
	}
	return capsule.Binding{}, capsule.NativeFrame{}, cli.ExitFault("srf-identity-surface", 4, "")
}

func (s *coordinatedLossSource) BeginMarkLost(id string) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.b.Surface.State == "lost" {
		return nil, nil
	}
	s.b.Surface.State = "lost"
	s.b.ConfirmedAbsent = true
	s.lostDone = make(chan struct{})
	raw, _ := json.Marshal(struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
		Data   struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}{
		Schema: "surface_event/v0.2",
		Event:  "state_changed",
		Data: struct {
			Surface capsule.Surface `json:"surface"`
		}{Surface: s.b.Surface},
	})
	return raw, nil
}

func (s *coordinatedLossSource) CompleteLost(_ string, _ bool) {
	s.mu.Lock()
	ch := s.lostDone
	s.lostDone = nil
	s.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func (s *coordinatedLossSource) WaitLostDelivered(ctx context.Context, _ string) {
	s.mu.Lock()
	ch := s.lostDone
	s.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case <-ch:
	case <-ctx.Done():
	}
}

func TestLivenessAndSubscriptionConcurrentLossWireOrder(t *testing.T) {
	root, b, _ := ramFixture(t)
	b.Surface.State = "active"
	p := publisher(t, root)
	src := &coordinatedLossSource{
		b:           b,
		secondEnter: make(chan struct{}),
		livenessSet: make(chan struct{}),
	}
	var surfaceMu sync.Mutex
	var wireMu sync.Mutex
	var wireEvents []string
	allDone := make(chan struct{})

	emit := func(_ context.Context, msg json.RawMessage) error {
		var ev struct {
			Event string `json:"event"`
			Data  struct {
				Code    string          `json:"code"`
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		_ = json.Unmarshal(msg, &ev)
		wireMu.Lock()
		if ev.Event == "state_changed" {
			wireEvents = append(wireEvents, "state_changed:"+ev.Data.Surface.State)
		} else {
			wireEvents = append(wireEvents, ev.Event+":"+ev.Data.Code)
		}
		n := len(wireEvents)
		wireMu.Unlock()
		if n == 2 {
			close(allDone)
		}
		return nil
	}

	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions: 1,
		PollInterval:     time.Millisecond,
		CaptureTimeout:   time.Second,
		ShutdownTimeout:  time.Second,
		SurfaceLock:      func(string) *sync.Mutex { return &surfaceMu },
	}, src, p, emit)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })

	if err := subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}

	// Wait until 2nd Capture holds SurfaceLock("a"), then have liveness mark lost and wait for SurfaceLock("a") to emit.
	select {
	case <-src.secondEnter:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for 2nd capture")
	}

	lostEv, err := src.BeginMarkLost("a")
	if err != nil || len(lostEv) == 0 {
		t.Fatalf("BeginMarkLost failed: %v", err)
	}
	go func() {
		surfaceMu.Lock()
		_ = emit(context.Background(), lostEv)
		surfaceMu.Unlock()
		src.CompleteLost("a", true)
	}()
	close(src.livenessSet)

	select {
	case <-allDone:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for both events")
	}

	wireMu.Lock()
	got := append([]string(nil), wireEvents...)
	wireMu.Unlock()
	if len(got) != 2 || got[0] != "state_changed:lost" || got[1] != "error:capture_failed" {
		t.Fatalf("expected wire order [state_changed:lost, error:capture_failed], got %v", got)
	}
}
