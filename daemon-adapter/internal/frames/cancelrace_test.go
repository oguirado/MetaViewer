package frames

import (
	"context"
	"encoding/json"
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
		SHA256RGB24:   "0000000000000000000000000000000000000000000000000000000000000000",
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
