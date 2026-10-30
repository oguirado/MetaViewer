package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type postInputTestRunner struct {
	pngPath string
	sha     string
	seq     atomic.Uint64
}

func (r *postInputTestRunner) Run(_ context.Context, a []string, _ []byte) ([]byte, error) {
	switch a[1] {
	case "start":
		return []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1}]}`), nil
	case "input":
		return json.Marshal(map[string]any{
			"surface_id":     "w1",
			"kind":           "click",
			"input_mono_ns":  monotonic(),
			"focus_verified": true,
			"result":         "ok",
		})
	case "frame":
		seq := r.seq.Add(1)
		return json.Marshal(capsule.NativeFrame{
			Path:          r.pngPath,
			Seq:           seq,
			SHA256RGB24:   r.sha,
			Width:         2,
			Height:        1,
			CaptureMonoNS: monotonic(),
			Generation:    "srf-id-demo",
			Window:        &capsule.Window{ID: "w1", W: 2, H: 1},
		})
	}
	return nil, errors.New("unexpected native operation")
}

func TestPostInputUnknownProfileRefusesWithoutPanic(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-post-input-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	pngPath, sha := writeTestPNG(t, root)
	runner := &postInputTestRunner{pngPath: pngPath, sha: sha}
	managerProfiles := map[string]capsule.Profile{
		"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1},
	}
	origin := monotonic()
	m, err := capsule.NewManager(capsule.Config{
		BinDir:         t.TempDir(),
		Profiles:       managerProfiles,
		MaxSurfaces:    1,
		MaxOutputBytes: 8192,
		Timeout:        time.Second,
		OriginNS:       origin,
	}, runner, monotonic)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	created, err := m.Handle(ctx, capsule.Request{
		Schema: "surface_request/v0.2",
		Op:     "create",
		Params: json.RawMessage(`{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`),
	})
	if err != nil || len(created) != 1 {
		t.Fatalf("create failed: %s %v", created, err)
	}
	var createdEv struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created[0], &createdEv); err != nil || createdEv.Data.Surface.SurfaceID == "" {
		t.Fatalf("unmarshal created: %s %v", created[0], err)
	}
	surfaceID := createdEv.Data.Surface.SurfaceID

	pub, err := frames.NewPublisher(frames.PublishConfig{
		RAMRoot:       root,
		MaxFrameBytes: 8192,
		MaxPixels:     64,
		MaxSurfaces:   4,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	// Unknown profile in wireHandler profiles map: must refuse without nil-panicking.
	unknownHandler := isolatedWireHandler(t, m, map[string]capsule.Profile{}, map[string]*frames.Publisher{root: pub}, origin)
	inputEnv := ipc.Envelope{
		MsgID: "msg-1",
		Body:  json.RawMessage(`{"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"` + surfaceID + `","proposal_id":"p-1","action":{"type":"click","x":0,"y":0,"button":"left"}}}`),
	}
	events, err := unknownHandler(ctx, inputEnv)
	if err != nil || len(events) != 1 {
		t.Fatalf("expected error event on unknown profile post-input capture, got events=%s err=%v", events, err)
	}
	var errEv struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
	}
	if err := json.Unmarshal(events[0], &errEv); err != nil || errEv.Schema != "surface_event/v0.2" || errEv.Event != "error" {
		t.Fatalf("expected surface_event error, got %s (%v)", events[0], err)
	}

	// Negative control: with configured profile and publisher, post-input capture succeeds.
	validHandler := isolatedWireHandler(t, m, managerProfiles, map[string]*frames.Publisher{root: pub}, origin)
	inputEnv2 := ipc.Envelope{
		MsgID: "msg-2",
		Body:  json.RawMessage(`{"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"` + surfaceID + `","proposal_id":"p-2","action":{"type":"click","x":0,"y":0,"button":"left"}}}`),
	}
	okEvents, err := validHandler(ctx, inputEnv2)
	if err != nil || len(okEvents) != 3 {
		t.Fatalf("negative control failed: expected input_applied + frame_ready + action_receipt, got %s (%v)", okEvents, err)
	}
}
