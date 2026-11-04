package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type stateFrameRunner struct {
	postInputTestRunner
	fail     bool
	captures int
}

func (r *stateFrameRunner) Run(ctx context.Context, args []string, stdin []byte) ([]byte, error) {
	if args[1] == "frame" {
		r.captures++
		if r.fail {
			return nil, errors.New("capture unavailable")
		}
	}
	return r.postInputTestRunner.Run(ctx, args, stdin)
}

func TestStateChangeFreshFrame(t *testing.T) {
	for _, mode := range []string{"release", "capture-failure", "publisher-failure", "list", "list-capture-failure"} {
		t.Run(mode, func(t *testing.T) {
			root, err := os.MkdirTemp("/dev/shm", "mv-state-frame-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(root) })
			path, sha := writeTestPNG(t, root)
			runner := &stateFrameRunner{postInputTestRunner: postInputTestRunner{pngPath: path, sha: sha}}
			profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
			origin := monotonic()
			m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: origin}, runner, monotonic)
			if err != nil {
				t.Fatal(err)
			}
			pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 64, MaxSurfaces: 4, Deduplicate: true})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = pub.Close() })
			h := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, origin)
			call := func(op string, params any) []json.RawMessage {
				t.Helper()
				raw, err := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
				if err != nil {
					t.Fatal(err)
				}
				events, err := h(context.Background(), ipc.Envelope{MsgID: op, Body: raw})
				if err != nil {
					t.Fatal(err)
				}
				return events
			}
			created := call("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
			if len(created) != 2 {
				t.Fatalf("create: %s", created)
			}
			var initial struct {
				Data struct {
					FrameRef frames.Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if err := json.Unmarshal(created[1], &initial); err != nil {
				t.Fatal(err)
			}
			before := initial.Data.FrameRef
			params := map[string]string{"surface_id": before.SurfaceID}
			listing := mode == "list" || mode == "list-capture-failure"
			if !listing {
				captures := runner.captures
				taken := call("take_control", map[string]string{"surface_id": before.SurfaceID, "owner": "human"})
				if len(taken) != 1 || runner.captures != captures {
					t.Fatalf("take_control captured or changed replies: %s", taken)
				}
			}
			// Subscription polls on the unchanged picture cannot advance generation.
			binding, native, err := m.Capture(context.Background(), before.SurfaceID)
			if err != nil {
				t.Fatal(err)
			}
			polled, changed, err := pub.PublishIfChanged(before.SurfaceID, binding, native)
			if err != nil || changed || polled.Generation != before.Generation {
				t.Fatalf("static poll: %+v changed=%v err=%v", polled, changed, err)
			}
			captures := runner.captures
			runner.fail = mode == "capture-failure" || mode == "list-capture-failure"
			if mode == "publisher-failure" {
				if err := pub.Close(); err != nil {
					t.Fatal(err)
				}
			}
			op := "release_control"
			if listing {
				op = "list"
				params = map[string]string{}
			}
			events := call(op, params)
			var state struct {
				Event string
				Data  struct{ Surface capsule.Surface }
			}
			if len(events) == 0 || json.Unmarshal(events[0], &state) != nil || state.Event != "state_changed" || state.Data.Surface.Control != "agent" {
				t.Fatalf("state reply lost: %s", events)
			}
			if runner.captures != captures+1 {
				t.Fatalf("want one current capture, got %d", runner.captures-captures)
			}
			if runner.fail || mode == "publisher-failure" {
				if len(events) != 1 {
					t.Fatalf("failed capture/publication must preserve successful reply only: %s", events)
				}
				binding, err := m.SubscriptionBinding(before.SurfaceID)
				if err != nil || binding.Surface.Control != "agent" {
					t.Fatalf("release failed: %+v %v", binding, err)
				}
				if runner.fail {
					// Native control can be busy during release (for example while
					// sealing a demo). The next real static capture must still publish.
					runner.fail = false
					binding, native, err := m.Capture(context.Background(), before.SurfaceID)
					if err != nil {
						t.Fatal(err)
					}
					recovered, changed, err := pub.PublishIfChanged(before.SurfaceID, binding, native)
					if err != nil || !changed || recovered.Generation <= before.Generation || recovered.SHA256 != before.SHA256 {
						t.Fatalf("FRESH_FRAME_RECOVERY_REQUIRED: %+v changed=%v err=%v", recovered, changed, err)
					}
					// Once published, ordinary static polls deduplicate again.
					binding, native, err = m.Capture(context.Background(), before.SurfaceID)
					if err != nil {
						t.Fatal(err)
					}
					polled, changed, err := pub.PublishIfChanged(before.SurfaceID, binding, native)
					if err != nil || changed || polled.Generation != recovered.Generation {
						t.Fatalf("recovered static poll: %+v changed=%v err=%v", polled, changed, err)
					}
				}
				return
			}
			if len(events) != 2 {
				t.Fatalf("FRESH_FRAME_REQUIRED: state reply then forced frame: %s", events)
			}
			// Replay real wire order: applying state raises the fence; only a later
			// frame event may satisfy it. Never replay the frame before the reply.
			var ready struct {
				Event string
				Data  struct {
					FrameRef frames.Ref `json:"frame_ref"`
				}
			}
			if err := json.Unmarshal(events[1], &ready); err != nil {
				t.Fatal(err)
			}
			after := ready.Data.FrameRef
			if ready.Event != "frame_ready" || after.Generation <= before.Generation || after.SHA256 != before.SHA256 || after.SurfaceID != before.SurfaceID || after.RAMWSPath == before.RAMWSPath {
				t.Fatalf("FRESH_FRAME_REQUIRED: unchanged picture needs newer immutable ref: %+v before=%+v", ready, before)
			}
			current, err := pub.Current(before.SurfaceID)
			if err != nil || current.Generation != after.Generation {
				t.Fatalf("forced frame bypassed publisher: %+v %v", current, err)
			}
			if mode == "release" {
				captures := runner.captures
				refused := call("release_control", params)
				if len(refused) != 1 || runner.captures != captures {
					t.Fatalf("refused release captured: %s", refused)
				}
			}
		})
	}
}
