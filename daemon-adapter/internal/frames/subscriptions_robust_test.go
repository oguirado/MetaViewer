package frames

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"metaviewer/daemon-adapter/internal/capsule"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type orderedFrameSource func(context.Context, string) (capsule.Binding, capsule.NativeFrame, error)

func (f orderedFrameSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	return f(ctx, id)
}

// Replay capture -> publish -> emit -> open, including eviction before the open.
func TestSubscriptionRecoversOneFrameFault(t *testing.T) {
	for _, serial := range []bool{false, true} {
		for _, mode := range []string{"capture", "publication_enoent", "duplicate", "delivery", "retention_enoent"} {
			t.Run(fmt.Sprintf("%s/serial=%v", mode, serial), func(t *testing.T) {
				root, b, f := ramFixture(t)
				p := publisher(t, root)
				if mode == "retention_enoent" {
					p.cfg.MaxRetained = 2
				}
				changed := f
				changed.Path = filepath.Join(b.FramesRoot, "changed.png")
				file, err := os.OpenFile(changed.Path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if err != nil {
					t.Fatal(err)
				}
				img := image.NewRGBA(image.Rect(0, 0, 2, 1))
				img.SetRGBA(0, 0, color.RGBA{B: 255, A: 255})
				img.SetRGBA(1, 0, color.RGBA{B: 255, A: 255})
				if err := png.Encode(file, img); err != nil {
					t.Fatal(err)
				}
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
				changed.SHA256RGB24 = fmt.Sprintf("%x", sha256.Sum256([]byte{0, 0, 255, 0, 0, 255}))
				var diagnostic bytes.Buffer
				calls := 0
				source := orderedFrameSource(func(ctx context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
					calls++
					if calls > 5 {
						<-ctx.Done()
						return b, f, ctx.Err()
					}
					next := f
					if calls >= 3 {
						next = changed
					}
					next.Seq = uint64(calls * 10)
					if calls == 3 {
						switch mode {
						case "capture":
							return b, next, errors.New("isolated capture fault")
						case "publication_enoent":
							next.Path = filepath.Join(b.FramesRoot, "expired.png")
						case "duplicate":
							next = f // Exact native replay of the preceding capture.
							next.Seq = 20
						}
					}
					return b, next, nil
				})
				delivered := make(chan Ref, 8)
				attempts := 0
				setupErrors := make(chan error, 1)
				evicted := false
				sub, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second, Serial: serial, DeduplicateUnchanged: true, Diagnostics: &diagnostic}, source, p, func(_ context.Context, msg json.RawMessage) error {
					var event struct {
						Event string
						Data  struct {
							FrameRef Ref `json:"frame_ref"`
						}
					}
					if err := json.Unmarshal(msg, &event); err != nil {
						return err
					}
					if event.Event != "frame_ready" {
						return errors.New("unexpected terminal notice")
					}
					ref := event.Data.FrameRef
					attempts++
					if ref.Tick == 30 {
						if mode == "delivery" {
							return errors.New("isolated delivery fault")
						}
						if mode == "retention_enoent" {
							for _, seq := range []uint64{31, 32} {
								next := f
								next.Seq = seq
								newer, err := p.Publish("a", b, next)
								if err != nil {
									setupErrors <- err
									return err
								}
								if _, err = os.Stat(newer.RAMWSPath); err != nil {
									setupErrors <- err
									return err
								}
							}
							if _, err := os.ReadFile(ref.RAMWSPath); !errors.Is(err, os.ErrNotExist) {
								setupErr := fmt.Errorf("negative control: expected evicted frame, got %v", err)
								setupErrors <- setupErr
								return setupErr
							}
							evicted = true
							return os.ErrNotExist
						}
					}
					delivered <- ref
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = sub.Close(context.Background()) })
				if err = sub.Subscribe(context.Background(), "a"); err != nil {
					t.Fatal(err)
				}
				var ticks []uint64
				deadline := time.After(time.Second)
				for len(ticks) < 3 {
					select {
					case setupErr := <-setupErrors:
						t.Fatalf("retention setup failed: %v", setupErr)
					case ref := <-delivered:
						ticks = append(ticks, ref.Tick)
					case <-deadline:
						t.Fatalf("picture froze after one %s fault; delivered ticks=%v terminal=%v", mode, ticks, sub.TerminalError("a"))
					}
				}
				if terminal := sub.TerminalError("a"); terminal != nil {
					t.Fatalf("recovered fault retained terminal error: %v", terminal)
				}
				sub.mu.Lock()
				_, active := sub.tasks["a"]
				sub.mu.Unlock()
				if !active {
					t.Fatal("recovered subscription terminated")
				}
				if err = sub.Unsubscribe(context.Background(), "a"); err != nil {
					t.Fatal(err)
				}
				if ticks[0] != 10 || ticks[1] != 20 || ticks[2] != 40 {
					t.Fatalf("unexpected recovery order: %v", ticks)
				}
				select {
				case setupErr := <-setupErrors:
					t.Fatalf("retention setup failed: %v", setupErr)
				default:
				}
				if mode == "retention_enoent" && !evicted {
					t.Fatal("retention fault was never exercised")
				}
				if !strings.Contains(diagnostic.String(), "failure") {
					t.Fatalf("missing diagnostic: %s", diagnostic.String())
				}
				t.Logf("[MEASURED] recovered ticks=%v frame delivery attempts=%d", ticks, attempts)
			})
		}
	}
}

// Cancellation during a failing source read must bypass publication retry diagnostics.
// The uncancelled control proves that the same publication error exercises retry.
func TestSubscriptionPublicationCancellationQuiet(t *testing.T) {
	for _, mode := range []string{"task", "context", "uncancelled"} {
		t.Run(mode, func(t *testing.T) {
			root, b, f := ramFixture(t)
			p := publisher(t, root)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			work := &task{}
			reads := 0
			p.sourceRead = func(fd int, _, _ string) ([]byte, error) {
				_ = syscall.Close(fd)
				reads++
				switch mode {
				case "task":
					work.cancelled.Store(true)
				case "context":
					cancel()
				}
				return nil, os.ErrNotExist
			}
			var diagnostic bytes.Buffer
			emissions := 0
			sub, err := NewSubscriptions(context.Background(), SubscriptionConfig{
				MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second,
				ShutdownTimeout: time.Second, Diagnostics: &diagnostic,
			}, orderedFrameSource(func(context.Context, string) (capsule.Binding, capsule.NativeFrame, error) {
				t.Fatal("publish loop must consume the supplied capture")
				return b, f, nil
			}), p, func(context.Context, json.RawMessage) error { emissions++; return nil })
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = sub.Close(context.Background()) }()
			items := make(chan capturedItem, 1)
			ack := make(chan struct{})
			items <- capturedItem{binding: b, native: f, ack: ack}
			close(items)
			sub.publishLoop(ctx, "a", work, items)
			if reads != 1 || work.err != nil || emissions != 0 {
				t.Fatalf("reads=%d terminal=%v emissions=%d", reads, work.err, emissions)
			}
			if mode == "uncancelled" {
				if !strings.Contains(diagnostic.String(), "frame failure") {
					t.Fatalf("missing retry diagnostic: %s", diagnostic.String())
				}
				select {
				case <-ack:
				default:
					t.Fatal("retry did not acknowledge the failed capture")
				}
			} else {
				if diagnostic.Len() != 0 {
					t.Fatalf("cancellation logged a failure: %s", diagnostic.String())
				}
				select {
				case <-ack:
					t.Fatal("cancelled publication was retried")
				default:
				}
			}
		})
	}
}
