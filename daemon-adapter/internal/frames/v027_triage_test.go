package frames

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

func TestV027DisplayRecoversTransientResolution(t *testing.T) {
	h := newDisplayHarness(t, "blocked")
	resolve := h.tap.cfg.Resolve
	var calls atomic.Int32
	h.tap.cfg.Resolve = func(id string) (DisplayTarget, error) {
		if calls.Add(1) == 1 {
			return DisplayTarget{}, syscall.EIO
		}
		return resolve(id)
	}
	h.tap.Start("surface")
	displayEventually(t, func() bool { _, _, _, err := displaySnapshot(h.path); return err == nil })
	if calls.Load() < 2 {
		t.Fatal("tap never retried resolution")
	}
	if err := h.tap.Err("surface"); err != nil {
		t.Fatal(err)
	}
}

func TestV027PublisherRefusesDirectorySwapAtLink(t *testing.T) {
	for _, unchanged := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh", true: "unchanged"}[unchanged], func(t *testing.T) {
			root, b, f := ramFixture(t)
			p := publisher(t, root)
			var old Ref
			if unchanged {
				var err error
				old, err = p.Publish("a", b, f)
				if err != nil {
					t.Fatal(err)
				}
				f.Seq++
			}
			heldPath := p.outputPath + "-moved"
			p.beforeLink = func() {
				if err := os.Rename(p.outputPath, heldPath); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(p.outputPath, 0700); err != nil {
					t.Fatal(err)
				}
				source := filepath.Base(old.RAMWSPath)
				if !unchanged {
					entries, err := filepath.Glob(filepath.Join(heldPath, "*.tmp"))
					if err != nil || len(entries) != 1 {
						t.Fatalf("missing temporary publication: %v %v", entries, err)
					}
					source = filepath.Base(entries[0])
				}
				if err := os.WriteFile(filepath.Join(p.outputPath, source), []byte{9, 9, 9, 9, 9, 9}, 0600); err != nil {
					t.Fatal(err)
				}
			}
			defer func() { _ = os.RemoveAll(p.outputPath); _ = os.Rename(heldPath, p.outputPath) }()
			if ref, err := p.PublishForced("a", b, f); err == nil {
				t.Fatalf("accepted reference through swapped directory: %+v", ref)
			}
		})
	}
}

type v027QueuedCapture struct {
	*RingSource
	b      capsule.Binding
	f      capsule.NativeFrame
	queued chan struct{}
}

func (s *v027QueuedCapture) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	s.mu.Lock()
	s.payloads[id] = []ringPayload{{frame: s.f, raw: []byte{1, 2, 3, 4, 5, 6}}}
	s.mu.Unlock()
	close(s.queued)
	<-ctx.Done()
	return s.b, s.f, nil
}
func TestV027UnsubscribeReleasesCapturedRingPayload(t *testing.T) {
	root, b, f := ramFixture(t)
	source := &v027QueuedCapture{RingSource: &RingSource{payloads: map[string][]ringPayload{}, pinned: map[string]ringGeometry{}}, b: b, f: f, queued: make(chan struct{})}
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, publisher(t, root), func(context.Context, json.RawMessage) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })
	if err = subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-source.queued:
	case <-time.After(time.Second):
		t.Fatal("capture not queued")
	}
	if err = subs.Unsubscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if len(source.payloads) != 0 {
		t.Fatal("cancelled ring payload retained")
	}
}
