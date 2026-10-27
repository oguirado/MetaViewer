package frames

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

type dummySource struct {
	ramRoot string
}

func (d *dummySource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	framesDir := filepath.Join(d.ramRoot, "run1", "frames", "w1")
	_ = os.MkdirAll(framesDir, 0700)
	imgPath := filepath.Join(framesDir, "f.png")
	if _, err := os.Stat(imgPath); os.IsNotExist(err) {
		// Valid 1x1 opaque PNG
		pngData := []byte{
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
			0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
			0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
			0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
			0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
			0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
			0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
			0x44, 0xae, 0x42, 0x60, 0x82,
		}
		_ = os.WriteFile(imgPath, pngData, 0600)
	}

	b := capsule.Binding{
		Surface: capsule.Surface{
			SurfaceID: id,
			Geometry:  capsule.Geometry{W: 1, H: 1},
		},
		Container:  "c1",
		RunID:      "run1",
		Window:     "w1",
		FramesRoot: framesDir,
	}
	f := capsule.NativeFrame{
		Path:          imgPath,
		Seq:           1,
		SHA256RGB24:   fmt.Sprintf("%x", sha256.Sum256([]byte{255, 0, 0})),
		Width:         1,
		Height:        1,
		CaptureMonoNS: 2000,
		Generation:    "c1",
		Window:        &capsule.Window{ID: "w1", W: 1, H: 1},
	}
	return b, f, nil
}

// Source: SW-0102 F5 (cancelled work delivered) & F7 (double completion or completion after cancel)
func TestCancelVsCompleteRace(t *testing.T) {
	for i := 0; i < 20; i++ {
		tmpShm, err := os.MkdirTemp("/dev/shm", "test-shm-")
		if err != nil {
			t.Skip("skipping /dev/shm test if unavailable")
		}

		pubCfg := PublishConfig{
			RAMRoot:       tmpShm,
			MaxFrameBytes: 4096,
			MaxPixels:     4096,
			MaxSurfaces:   10,
		}
		pub, err := NewPublisher(pubCfg)
		if err != nil {
			os.RemoveAll(tmpShm)
			t.Fatal(err)
		}

		source := &dummySource{ramRoot: tmpShm}
		binding, frame, err := source.Capture(context.Background(), "probe")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pub.Publish("probe", binding, frame); err != nil {
			t.Fatal(err)
		}

		var (
			deliveredCount atomic.Int32
			errCount       atomic.Int32
			mu             sync.Mutex
			events         []string
		)

		emit := func(ctx context.Context, msg json.RawMessage) error {
			deliveredCount.Add(1)
			var parsed struct {
				Event string `json:"event"`
			}
			_ = json.Unmarshal(msg, &parsed)
			mu.Lock()
			events = append(events, parsed.Event)
			mu.Unlock()
			if parsed.Event == "error" {
				errCount.Add(1)
			}
			return nil
		}

		cfg := SubscriptionConfig{
			MaxSubscriptions: 5,
			PollInterval:     10 * time.Microsecond,
			CaptureTimeout:   50 * time.Millisecond,
			ShutdownTimeout:  100 * time.Millisecond,
		}

		subs, err := NewSubscriptions(context.Background(), cfg, source, pub, emit)
		if err != nil {
			pub.Close()
			os.RemoveAll(tmpShm)
			t.Fatal(err)
		}

		surfaceID := "s1"
		if err := subs.Subscribe(context.Background(), surfaceID); err != nil {
			pub.Close()
			os.RemoveAll(tmpShm)
			t.Fatal(err)
		}

		// Race Unsubscribe or Close against in-flight captures/emits
		var wg sync.WaitGroup
		wg.Add(2)

		go func() {
			defer wg.Done()
			time.Sleep(50 * time.Microsecond)
			_ = subs.Unsubscribe(context.Background(), surfaceID)
		}()

		go func() {
			defer wg.Done()
			time.Sleep(50 * time.Microsecond)
			_ = subs.Close(context.Background())
		}()

		wg.Wait()
		pub.Close()
		os.RemoveAll(tmpShm)

		// Verify invariants:
		// 1. After unsubscribe/close, no frame_ready should be delivered after terminal error
		mu.Lock()
		seenError := false
		for _, ev := range events {
			if seenError && ev == "frame_ready" {
				t.Fatalf("iteration %d: frame_ready delivered after error event!", i)
			}
			if ev == "error" {
				seenError = true
			}
		}
		mu.Unlock()
	}
}

type cancelBeforePublishSource struct {
	subs     *Subscriptions
	b        capsule.Binding
	f        capsule.NativeFrame
	captured chan struct{}
	once     sync.Once
}

func (s *cancelBeforePublishSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	s.once.Do(func() {
		// Hold s.subs.mu across the return from Capture so poll reaches the
		// pre-Publish point while ctx.Err() is still nil, then the test cancels
		// the task under s.subs.mu before releasing the lock.
		s.subs.mu.Lock()
		close(s.captured)
	})
	return s.b, s.f, nil
}

func TestT2R205CancelBeforePublishDoesNotCommit(t *testing.T) {
	t.Run("cancel_before_publish_preserves_generations_and_refs", func(t *testing.T) {
		root, b, f := ramFixture(t)
		p := publisher(t, root)
		f.Seq = 1
		r1, err := p.Publish("a", b, f)
		if err != nil {
			t.Fatal(err)
		}
		f.Seq = 2
		r2, err := p.Publish("a", b, f)
		if err != nil {
			t.Fatal(err)
		}
		f3 := f
		f3.Seq = 3
		src := &cancelBeforePublishSource{b: b, f: f3, captured: make(chan struct{})}
		events := make(chan json.RawMessage, 4)
		subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
			MaxSubscriptions: 1,
			PollInterval:     time.Hour,
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
		src.subs = subs
		t.Cleanup(func() { _ = subs.Close(context.Background()) })

		if err := subs.Subscribe(context.Background(), "a"); err != nil {
			t.Fatal(err)
		}
		select {
		case <-src.captured:
		case <-time.After(time.Second):
			t.Fatal("capture did not start")
		}
		// Give poll time to pass the initial ctx.Err() check and reach Publish.
		time.Sleep(10 * time.Millisecond)
		if task := subs.tasks["a"]; task != nil {
			task.cancel()
		}
		subs.mu.Unlock()

		if err := subs.Unsubscribe(context.Background(), "a"); err != nil {
			t.Fatalf("Unsubscribe failed: %v", err)
		}
		if len(events) != 0 {
			t.Fatalf("cancelled poll emitted event: %d", len(events))
		}
		p.mu.Lock()
		nextGen := p.next
		refs := append([]Ref(nil), p.surfaces["a"].refs...)
		p.mu.Unlock()
		if nextGen != 2 {
			t.Fatalf("cancelled poll committed generation: got %d, want 2", nextGen)
		}
		if len(refs) != 2 || refs[0].RAMWSPath != r1.RAMWSPath || refs[1].RAMWSPath != r2.RAMWSPath {
			t.Fatalf("retained refs mutated by cancelled poll: %+v", refs)
		}
		if _, err := os.Stat(r1.RAMWSPath); err != nil {
			t.Fatalf("oldest retained ref was evicted after cancel: %v", err)
		}
	})

	t.Run("negative_control_cancel_after_publish_keeps_frame", func(t *testing.T) {
		root, b, f := ramFixture(t)
		p := publisher(t, root)
		source := &captureSource{b: b, f: f}
		events := make(chan json.RawMessage, 4)
		subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
			MaxSubscriptions: 1,
			PollInterval:     time.Hour,
			CaptureTimeout:   time.Second,
			ShutdownTimeout:  time.Second,
		}, source, p, func(ctx context.Context, msg json.RawMessage) error {
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
		var published Ref
		select {
		case msg := <-events:
			var ev struct {
				Event string `json:"event"`
				Data  struct {
					FrameRef Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if err := json.Unmarshal(msg, &ev); err != nil || ev.Event != "frame_ready" {
				t.Fatalf("unexpected event: %s (%v)", msg, err)
			}
			published = ev.Data.FrameRef
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for frame_ready")
		}
		if err := subs.Unsubscribe(context.Background(), "a"); err != nil {
			t.Fatalf("Unsubscribe failed: %v", err)
		}
		if published.Generation != 1 {
			t.Fatalf("expected generation 1, got %d", published.Generation)
		}
		if _, err := os.Stat(published.RAMWSPath); err != nil {
			t.Fatalf("published frame removed on unsubscribe: %v", err)
		}
	})
}
