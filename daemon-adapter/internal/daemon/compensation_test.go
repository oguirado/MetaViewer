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
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type initialRunner struct {
	calls                  []string
	root                   string
	refuseStop, badPublish bool
	cancel                 context.CancelFunc
}

func (r *initialRunner) Run(ctx context.Context, a []string, _ []byte) ([]byte, error) {
	op := a[1]
	r.calls = append(r.calls, op)
	switch op {
	case "start":
		return []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"","url":""}]}`), nil
	case "frame":
		if r.cancel != nil {
			r.cancel()
		}
		if r.badPublish {
			return []byte(`{"path":"` + r.root + `/demo-run/frames/w1/missing.png","seq":1,"sha256_rgb24":"` + strings.Repeat("0", 64) + `","width":2,"height":1,"capture_mono_ns":200,"generation":"srf-id-demo","window":{"id":"w1","w":2,"h":1}}`), nil
		}
		return []byte(`{}`), nil
	case "stop":
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if r.refuseStop {
			return []byte(`{"stopped":"srf-id-demo","removed_verified":false}`), nil
		}
		return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
	}
	return nil, errors.New("unexpected operation")
}
func TestInitialFrameCompensation(t *testing.T) {
	for _, mode := range []string{"capture", "publish", "cancelled", "unverified-stop"} {
		t.Run(mode, func(t *testing.T) {
			root, err := os.MkdirTemp("/dev/shm", "mv-rollback-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(root)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r := &initialRunner{root: root, refuseStop: mode == "unverified-stop", badPublish: mode == "publish"}
			if mode == "cancelled" {
				r.cancel = cancel
			}
			m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, r, func() uint64 { return 200 })
			if err != nil {
				t.Fatal(err)
			}
			p, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			h, err := NewHandler(m, p)
			if err != nil {
				t.Fatal(err)
			}
			_, err = h(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}}`)})
			if err == nil {
				t.Fatal("broken frame accepted")
			}
			if !reflect.DeepEqual(r.calls, []string{"start", "frame", "stop"}) {
				t.Fatalf("missing compensation: %v", r.calls)
			}
			active, e := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "list", Params: json.RawMessage(`{}`)})
			if e != nil {
				t.Fatal(e)
			}
			if mode == "unverified-stop" {
				var recovery *CreationError
				if !errors.As(err, &recovery) || recovery.SurfaceID == "" || len(active) != 1 {
					t.Fatalf("uncertain removal lost identity: %v", err)
				}
			} else if len(active) != 0 {
				t.Fatal("active binding leaked")
			}
			files, e := filepath.Glob(filepath.Join(root, "frames-*", "*"))
			if e != nil || len(files) != 0 {
				t.Fatalf("publication leaked: %v %v", files, e)
			}
		})
	}
}

type validFrameRunner struct {
	initialRunner
	framePath string
	frameSHA  string
}

func (r *validFrameRunner) Run(ctx context.Context, a []string, in []byte) ([]byte, error) {
	if a[1] == "frame" {
		r.calls = append(r.calls, "frame")
		return []byte(`{"path":"` + r.framePath + `","seq":1,"sha256_rgb24":"` + r.frameSHA + `","width":2,"height":1,"capture_mono_ns":200,"generation":"srf-id-demo","window":{"id":"w1","w":2,"h":1}}`), nil
	}
	return r.initialRunner.Run(ctx, a, in)
}

func writeCompTestPNG(t *testing.T, path string, c0, c1 color.NRGBA) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, c0)
	img.Set(1, 0, c1)
	if err := png.Encode(f, img); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	raw := []byte{c0.R, c0.G, c0.B, c1.R, c1.G, c1.B}
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

func TestCreateCompensationReleasesPartiallyPublishedFrameLease(t *testing.T) {
	peerRoot, err := os.MkdirTemp("/dev/shm", "mv-comp-peer-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(peerRoot)

	root, err := os.MkdirTemp("/dev/shm", "mv-comp-create-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)

	// Each 2x1 RGB24 frame is 6 bytes; budget of 18 bytes holds 3 frames across the budget group.
	budget, err := frames.NewBudget(18)
	if err != nil {
		t.Fatal(err)
	}
	peerPub, err := frames.NewPublisher(frames.PublishConfig{
		RAMRoot:         peerRoot,
		MaxFrameBytes:   8192,
		MaxPixels:       2,
		MaxSurfaces:     1,
		MaxRetained:     4,
		MaxSurfaceBytes: 18,
		Budget:          budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer peerPub.Close()

	peerFramesRoot := filepath.Join(peerRoot, "peer-run/frames/w1")
	peerBinding := capsule.Binding{
		Surface: capsule.Surface{
			SurfaceID: "peer-surface",
			ProfileID: "peer",
			State:     "active",
			Geometry:  capsule.Geometry{W: 2, H: 1},
		},
		Container:  "srf-id-peer",
		RunID:      "peer-run",
		Window:     "w1",
		FramesRoot: peerFramesRoot,
	}
	for seq := uint64(1); seq <= 3; seq++ {
		pngPath := filepath.Join(peerFramesRoot, fmt.Sprintf("f-%d.png", seq))
		sha := writeCompTestPNG(t, pngPath, color.NRGBA{R: uint8(seq * 10), A: 255}, color.NRGBA{G: uint8(seq * 20), A: 255})
		_, err := peerPub.Publish("peer-surface", peerBinding, capsule.NativeFrame{
			Path:          pngPath,
			Seq:           seq,
			SHA256RGB24:   sha,
			Width:         2,
			Height:        1,
			CaptureMonoNS: 100 + seq,
			Generation:    "srf-id-peer",
			Window:        &capsule.Window{ID: "w1", W: 2, H: 1},
		})
		if err != nil {
			t.Fatalf("seed peer frame %d: %v", seq, err)
		}
	}

	peerOutDirs, err := filepath.Glob(filepath.Join(peerRoot, "frames-*"))
	if err != nil || len(peerOutDirs) != 1 {
		t.Fatalf("peer output dir: %v %v", peerOutDirs, err)
	}
	// Unlinkat without AT_REMOVEDIR rejects a directory even as namespace root.
	peerFiles, err := filepath.Glob(filepath.Join(peerOutDirs[0], "*.rgb"))
	if err != nil || len(peerFiles) != 3 {
		t.Fatalf("peer files: %v %v", peerFiles, err)
	}
	for _, path := range peerFiles {
		if err := os.Rename(path, path+".saved"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}

	createPNG := filepath.Join(root, "demo-run/frames/w1/f.png")
	createSHA := writeCompTestPNG(t, createPNG, color.NRGBA{R: 200, A: 255}, color.NRGBA{B: 100, A: 255})

	r := &validFrameRunner{
		initialRunner: initialRunner{root: root},
		framePath:     createPNG,
		frameSHA:      createSHA,
	}
	m, err := capsule.NewManager(capsule.Config{
		BinDir:         t.TempDir(),
		Profiles:       map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}},
		MaxSurfaces:    1,
		MaxOutputBytes: 8192,
		Timeout:        time.Second,
		OriginNS:       100,
	}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	p, err := frames.NewPublisher(frames.PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   8192,
		MaxPixels:       2,
		MaxSurfaces:     1,
		MaxRetained:     4,
		MaxSurfaceBytes: 18,
		Budget:          budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	h, err := NewHandler(m, p)
	if err != nil {
		t.Fatal(err)
	}
	createEnv := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}}`)}
	events, err := h(context.Background(), createEnv)
	if err == nil || !strings.Contains(err.Error(), "frame lease release") || len(events) != 0 {
		t.Fatalf("expected post-link frame lease release failure during create, got events=%s err=%v", events, err)
	}
	if !reflect.DeepEqual(r.calls, []string{"start", "frame", "stop"}) {
		t.Fatalf("expected start->frame->stop compensation, got %v", r.calls)
	}
	active, err := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "list", Params: json.RawMessage(`{}`)})
	if err != nil || len(active) != 0 {
		t.Fatalf("active surface leaked after compensation: %s %v", active, err)
	}
	orphaned, err := filepath.Glob(filepath.Join(root, "frames-*", "*"))
	if err != nil || len(orphaned) != 0 {
		t.Fatalf("partially published raw frame file leaked in output dir: %v %v", orphaned, err)
	}

	// Negative control: restore the peer files; eviction and normal create succeed.
	for _, path := range peerFiles {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(path+".saved", path); err != nil {
			t.Fatal(err)
		}
	}

	r.calls = nil
	events, err = h(context.Background(), createEnv)
	if err != nil || len(events) != 2 {
		t.Fatalf("normal create after restoring permissions failed: %s %v", events, err)
	}
	retained, err := filepath.Glob(filepath.Join(root, "frames-*", "*.rgb"))
	if err != nil || len(retained) != 1 {
		t.Fatalf("expected 1 retained raw frame file on normal create, got %v (%v)", retained, err)
	}
}
