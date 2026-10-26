package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type malformedInitialFrameRunner struct{ initialRunner }

func (r *malformedInitialFrameRunner) Run(ctx context.Context, args []string, input []byte) ([]byte, error) {
	if args[1] == "frame" {
		r.calls = append(r.calls, "frame")
		return []byte(`{broken`), nil
	}
	return r.initialRunner.Run(ctx, args, input)
}

func TestMalformedInitialFrameVerifiedCompensation(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-malformed-initial-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	r := &malformedInitialFrameRunner{}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	p, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.Close(); err != nil {
			t.Error(err)
		}
	})
	h, err := NewHandler(m, p)
	if err != nil {
		t.Fatal(err)
	}
	events, err := h(context.Background(), ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}}`)})
	var creation *CreationError
	if !errors.As(err, &creation) || creation.SurfaceID == "" || creation.Cause == nil || creation.Rollback != nil || len(events) != 0 {
		t.Fatalf("missing verified compensation identity: events=%s error=%v", events, err)
	}
	if !reflect.DeepEqual(r.calls, []string{"start", "frame", "stop"}) {
		t.Fatalf("native lifecycle: %v", r.calls)
	}
	active, err := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "list", Params: json.RawMessage(`{}`)})
	if err != nil || len(active) != 0 {
		t.Fatalf("active bindings remain: %s %v", active, err)
	}
	files, err := filepath.Glob(filepath.Join(root, "frames-*", "*"))
	if err != nil || len(files) != 0 {
		t.Fatalf("publication remains: %v %v", files, err)
	}
}
