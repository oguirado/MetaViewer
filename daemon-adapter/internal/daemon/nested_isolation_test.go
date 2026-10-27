package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

// Mutation: remove the exclusive Flock in newClientAuthority; shared-state
// startup succeeds and the negative control fails.
func TestTwoInstancesIsolated(t *testing.T) {
	type instance struct {
		runtime     Runtime
		ctx         context.Context
		state, root string
	}
	newInstance := func(profile string) instance {
		state := nvEnvironment(t)
		t.Setenv("MV_SRF_LIVE_PROFILE", profile)
		root := os.Getenv("MV_SRF_LIVE_RAM_ROOT")
		r, err := RuntimeFromEnv()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(r.Close)
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		ctx = context.WithValue(ctx, streamKey{}, streamSession{ctx: ctx, work: &sync.Mutex{}, emit: func(context.Context, json.RawMessage) error {
			t.Error("unsubscribed instance emitted a frame")
			return nil
		}})
		if out, err := r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"hello/v0.2"}`)}); err != nil || len(out) != 0 {
			t.Fatalf("hello: %s %v", out, err)
		}
		return instance{r, ctx, state, root}
	}
	a, b := newInstance("outer"), newInstance("inner")
	if a.runtime.Config.SocketPath == b.runtime.Config.SocketPath || a.state == b.state || a.root == b.root {
		t.Fatal("instance roots or sockets overlap")
	}
	key := ipc.SenderKey{SessionID: "same-session", Component: "core", Instance: "same-core"}
	for _, inst := range []instance{a, b} {
		if err := inst.runtime.Policy.Reserve(inst.ctx, key, 1, "same-nonce"); err != nil {
			t.Fatalf("independent first reservation: %v", err)
		}
		if err := inst.runtime.Policy.Reserve(inst.ctx, key, 1, "same-nonce"); err == nil {
			t.Fatal("local replay accepted")
		}
	}
	first, err := os.Stat(filepath.Join(a.state, "wire-replay.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := os.Stat(filepath.Join(b.state, "wire-replay.jsonl"))
	if err != nil || os.SameFile(first, second) || first.Size() == 0 || second.Size() == 0 {
		t.Fatalf("replay ledgers not independent: %v", err)
	}
	call := func(inst instance, op string, params any) []json.RawMessage {
		raw, err := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		if err != nil {
			t.Fatal(err)
		}
		out, err := inst.runtime.Handler(inst.ctx, ipc.Envelope{Body: raw})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	create := func(inst instance, profile string) string {
		out := call(inst, "create", map[string]any{"kind": "browser", "profile_id": profile, "geometry": map[string]int{"w": 1280, "h": 900}})
		var created struct {
			Event string
			Data  struct{ Surface capsule.Surface }
		}
		if len(out) != 2 || json.Unmarshal(out[0], &created) != nil || created.Event != "created" || created.Data.Surface.ProfileID != profile || created.Data.Surface.State != "active" {
			t.Fatalf("create: %s", out)
		}
		var frame struct {
			Event string
			Data  struct {
				Ref frames.Ref `json:"frame_ref"`
			}
		}
		if json.Unmarshal(out[1], &frame) != nil || frame.Event != "frame_ready" || frame.Data.Ref.SurfaceID != created.Data.Surface.SurfaceID || !strings.HasPrefix(frame.Data.Ref.RAMWSPath, inst.root+"/") {
			t.Fatalf("frame escaped allocation: %s", out[1])
		}
		return created.Data.Surface.SurfaceID
	}
	idA := create(a, "outer")
	if out := call(b, "list", map[string]any{}); len(out) != 0 {
		t.Fatalf("outer creation leaked to inner: %s", out)
	}
	idB := create(b, "inner")
	if idA == "" || idB == "" || idA == idB {
		t.Fatal("surface IDs overlap")
	}
	if out := call(b, "destroy", map[string]string{"surface_id": idA}); len(out) != 1 || !strings.Contains(string(out[0]), `"event":"error"`) {
		t.Fatalf("cross-instance destroy admitted: %s", out)
	}
	if out := call(a, "destroy", map[string]string{"surface_id": idA}); len(out) != 1 || !strings.Contains(string(out[0]), `"state":"destroyed"`) {
		t.Fatalf("outer destroy: %s", out)
	}
	out := call(b, "list", map[string]any{})
	if len(out) != 1 || !strings.Contains(string(out[0]), idB) || !strings.Contains(string(out[0]), `"state":"active"`) {
		t.Fatalf("outer destroy damaged inner: %s", out)
	}
	if out := call(b, "destroy", map[string]string{"surface_id": idB}); len(out) != 1 || !strings.Contains(string(out[0]), `"state":"destroyed"`) {
		t.Fatalf("inner destroy: %s", out)
	}
	// The configured runtime is a core client. Shared-root startup is refused
	// by its replay ledger lock rather than by binding a daemon-owned socket.
	duplicate, err := RuntimeFromEnv()
	if err == nil {
		duplicate.Close()
		t.Fatal("shared state admitted a second runtime")
	}
}
