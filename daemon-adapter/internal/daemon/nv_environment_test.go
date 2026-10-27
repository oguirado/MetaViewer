package daemon

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func nvEnvironment(t *testing.T) string {
	t.Helper()
	bin, root := fakeNative(t)
	for key, value := range map[string]string{"MV_SRF_BIN_DIR": bin, "MV_SRF_STATE_DIR": filepath.Join(t.TempDir(), "state"), "SRF_IDENTITY_STORE_ROOT": root, "SRF_PROXY_REGISTRY": filepath.Join(root, "proxies.json"), "XDG_RUNTIME_DIR": t.TempDir(), "MV_SESSION_ID": "nv", "MV_CORE_INSTANCE": "core", "MV_DAEMON_INSTANCE": "daemon", "MV_COMPONENT_COMMIT": "f8f9294fc70a423164d63f2cf6e5de65ec6f6516", "MV_CONTRACT_DIR": filepath.Join("..", "..", "..", "contracts", "v0.2"), "MV_SRF_PROFILES": "", "MV_SRF_LIVE_PROFILE": "demo", "MV_SRF_LIVE_RAM_ROOT": root} {
		t.Setenv(key, value)
	}
	return os.Getenv("MV_SRF_STATE_DIR")
}
func TestNVEnvironmentStatePaths(t *testing.T) {
	for _, kind := range []string{"symlink", "leaf-symlink", "slash", "dot", "clean"} {
		t.Run(kind, func(t *testing.T) {
			state := nvEnvironment(t)
			switch kind {
			case "symlink":
				real := t.TempDir()
				link := filepath.Join(t.TempDir(), "link")
				if err := os.Symlink(real, link); err != nil {
					t.Fatal(err)
				}
				state = link + "/state"
				defer func() {
					if _, err := os.Stat(filepath.Join(real, "state")); !os.IsNotExist(err) {
						t.Error("created state through symlink")
					}
				}()
			case "leaf-symlink":
				real := t.TempDir()
				if err := os.Chmod(real, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(real, state); err != nil {
					t.Fatal(err)
				}
			case "slash":
				state += "/"
			case "dot":
				state = filepath.Dir(state) + "/./state"
			}
			t.Setenv("MV_SRF_STATE_DIR", state)
			r, err := RuntimeFromEnv()
			if err == nil {
				defer r.Close()
			}
			if kind == "clean" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("unsafe path accepted")
			}
		})
	}
}
func TestNVSecondHelloPreservesSurface(t *testing.T) {
	nvEnvironment(t)
	r, err := RuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	emitted := make(chan json.RawMessage, 16)
	ctx = context.WithValue(ctx, streamKey{}, streamSession{ctx: ctx, work: &sync.Mutex{}, emit: func(c context.Context, b json.RawMessage) error {
		select {
		case emitted <- b:
			return nil
		case <-c.Done():
			return c.Err()
		}
	}})
	hello := ipc.Envelope{Body: json.RawMessage(`{"schema":"hello/v0.2"}`)}
	if _, err = r.Handler(ctx, hello); err != nil {
		t.Fatal(err)
	}
	create := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}}`)}
	out, err := r.Handler(ctx, create)
	if err != nil || len(out) < 1 {
		t.Fatalf("create: %s %v", out, err)
	}
	var created struct {
		Data struct {
			Surface struct {
				SurfaceID string `json:"surface_id"`
			} `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out[0], &created); err != nil || created.Data.Surface.SurfaceID == "" {
		t.Fatalf("create failed: %s %v", out, err)
	}
	id := created.Data.Surface.SurfaceID
	subscribe := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"frame_subscribe","params":{"surface_id":"` + id + `"}}`)}
	if events, e := r.Handler(ctx, subscribe); e != nil || len(events) != 0 {
		t.Fatalf("subscribe: %s %v", events, e)
	}
	select {
	case msg := <-emitted:
		if !strings.Contains(string(msg), `"frame_ready"`) {
			t.Fatalf("subscription failed: %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("no subscribed frame")
	}
	if _, err = r.Handler(ctx, hello); err == nil {
		t.Error("second hello accepted")
	}
	// The same task must remain registered: a second subscribe must still fail.
	if events, e := r.Handler(ctx, subscribe); e != nil || len(events) != 1 || !strings.Contains(string(events[0]), "already subscribed") {
		t.Errorf("subscription replaced: %s %v", events, e)
	}
	unsubscribe := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"frame_unsubscribe","params":{"surface_id":"` + id + `"}}`)}
	if events, e := r.Handler(ctx, unsubscribe); e != nil || len(events) != 0 {
		t.Fatalf("unsubscribe: %s %v", events, e)
	}
	listed, err := r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"list","params":{}}`)})
	if err != nil || len(listed) != 1 {
		t.Fatalf("surface lost: %s %v", listed, err)
	}
}
