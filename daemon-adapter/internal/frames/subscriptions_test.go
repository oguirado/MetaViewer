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
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
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
