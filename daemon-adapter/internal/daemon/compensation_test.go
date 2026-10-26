package daemon

import (
	"context"
	"encoding/json"
	"errors"
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
