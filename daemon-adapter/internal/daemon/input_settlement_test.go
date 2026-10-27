package daemon

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
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type settlementRunner struct {
	started, finish chan struct{}
	initialRunner
	seq  int
	mode string
}

func (r *settlementRunner) Run(ctx context.Context, args []string, in []byte) ([]byte, error) {
	switch args[1] {
	case "input":
		if r.mode == "takeover" || r.mode == "lost" {
			close(r.started)
			<-ctx.Done()
			<-r.finish
			return nil, ctx.Err()
		}
		if r.mode == "native" {
			return nil, errors.New("native execution failed")
		}
		return []byte(`{"surface_id":"w1","kind":"key","focus_verified":true,"result":"ok","input_mono_ns":200}`), nil
	case "frame":
		r.seq++
		if r.seq > 1 && r.mode == "capture" {
			return nil, errors.New("capture failed")
		}
		path := filepath.Join(r.root, "demo-run/frames/w1/f.png")
		b, _ := json.Marshal(map[string]any{"sha256_rgb24": fmt.Sprintf("%x", sha256.Sum256(make([]byte, 6))), "path": path, "seq": r.seq, "width": 2, "height": 1, "capture_mono_ns": 200, "generation": "srf-id-demo", "window": map[string]any{"id": "w1", "w": 2, "h": 1}})
		return b, nil
	}
	return r.initialRunner.Run(ctx, args, in)
}

func TestInputFailuresSettleWithProposal(t *testing.T) {
	for _, mode := range []string{"native", "unsupported", "capture", "publish", "takeover", "lost"} {
		t.Run(mode, func(t *testing.T) {
			root, err := os.MkdirTemp("/dev/shm", "mv-input-settle-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(root)
			source := filepath.Join(root, "demo-run/frames/w1")
			if err = os.MkdirAll(source, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(source, "f.png")
			f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
			img.Set(0, 0, color.NRGBA{A: 255})
			img.Set(1, 0, color.NRGBA{A: 255})
			if err = png.Encode(f, img); err != nil {
				t.Fatal(err)
			}
			f.Close()
			profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
			runner := &settlementRunner{initialRunner: initialRunner{root: root}, mode: mode, started: make(chan struct{}), finish: make(chan struct{})}
			m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
			if err != nil {
				t.Fatal(err)
			}
			pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer pub.Close()
			h := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, 100)
			call := func(op string, params any) []json.RawMessage {
				t.Helper()
				body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
				events, err := h(context.Background(), ipc.Envelope{Body: body})
				if err != nil {
					t.Fatal(err)
				}
				return events
			}
			created := call("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
			if len(created) != 2 {
				t.Fatalf("create: %s", created)
			}
			var event struct {
				Data struct{ Surface capsule.Surface }
			}
			if err = json.Unmarshal(created[0], &event); err != nil {
				t.Fatal(err)
			}
			action := map[string]any{"type": "key", "keys": []string{"a"}}
			if mode == "unsupported" {
				action = map[string]any{"type": "unknown"}
			}
			if mode == "publish" {
				if err = os.Chmod(path, 0644); err != nil {
					t.Fatal(err)
				}
			}
			params := map[string]any{"surface_id": event.Data.Surface.SurfaceID, "proposal_id": "failed-proposal", "action": action}
			var events []json.RawMessage
			if mode == "takeover" || mode == "lost" {
				done := make(chan []json.RawMessage, 1)
				go func() { done <- call("input", params) }()
				select {
				case <-runner.started:
				case <-time.After(time.Second):
					t.Fatal("input never started")
				}
				if mode == "lost" {
					if _, err := m.MarkLost(event.Data.Surface.SurfaceID, true); err != nil {
						close(runner.finish)
						t.Fatal(err)
					}
				} else {
					call("take_control", map[string]any{"surface_id": event.Data.Surface.SurfaceID, "owner": "human"})
				}
				close(runner.finish)
				select {
				case events = <-done:
				case <-time.After(time.Second):
					t.Fatal("cancelled input never settled")
				}
				if mode == "takeover" {
					if ready, err := m.ControlReady(event.Data.Surface.SurfaceID); err != nil || !ready {
						t.Fatalf("failure did not drain: %v", err)
					}
					released := call("release_control", map[string]any{"surface_id": event.Data.Surface.SurfaceID})
					var result struct{ Event string }
					if len(released) != 1 || json.Unmarshal(released[0], &result) != nil || result.Event != "state_changed" {
						t.Fatalf("release refused: %s", released)
					}
				}
			} else {
				events = call("input", params)
			}
			var receipt map[string]any
			if len(events) != 1 || json.Unmarshal(events[0], &receipt) != nil {
				t.Fatalf("missing receipt: %s", events)
			}
			if receipt["schema"] != "action_receipt/v0.2" || receipt["proposal_id"] != "failed-proposal" || receipt["verified"] != false || receipt["error"] == "" || receipt["error"] == nil || receipt["after_frame"] == nil {
				t.Fatalf("uncorrelated or verified failure: %s", events)
			}
			if mode == "lost" {
				if again, err := m.MarkLost(event.Data.Surface.SurfaceID, true); err != nil || len(again) != 0 {
					t.Fatalf("repeated loss emitted a duplicate settlement: %s %v", again, err)
				}
			}
		})
	}
}
