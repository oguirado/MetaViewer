package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"strings"
	"testing"
	"time"
)

type humanOpeningRunner struct{ calls []string }

func (r *humanOpeningRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	r.calls = append(r.calls, args[1])
	if args[1] == "stop" {
		return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
	}
	if args[1] != "start" {
		return nil, fmt.Errorf("human opening attempted %s", args[1])
	}
	return []byte(`{"container":"srf-id-demo","run_id":"run-human","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":900,"title":"","url":""}]}`), nil
}

func TestHumanOpeningHasNoInitialCaptureAndExplicitSubscriptionRequiresPublisher(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "p18-no-poll-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	runner := &humanOpeningRunner{}
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 1280, Height: 900, Role: "human"}}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 1280 * 900 * 4, MaxPixels: 1280 * 900, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	handler := wireHandlerWithoutAdmission(m, profiles, map[string]*frames.Publisher{root: pub}, 100)
	out, err := handler(context.Background(), ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}}`)})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("human opening emitted agent frame: %s", out)
	}
	var created struct {
		Data struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(out[0], &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Surface.Control != "human" {
		t.Fatal("wrong opening mode")
	}
	// Opening stays capture-free. An explicit recording subscription must report
	// a missing publisher rather than silently pretending that it subscribed.
	subscribe := subscriptionHandler(m, profiles, map[string]*frames.Subscriptions{}, func(context.Context, ipc.Envelope) ([]json.RawMessage, error) {
		t.Fatal("subscription fell through")
		return nil, nil
	})
	body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": "frame_subscribe", "params": map[string]string{"surface_id": created.Data.Surface.SurfaceID}})
	reply, err := subscribe(context.Background(), ipc.Envelope{Body: body})
	if err != nil || len(reply) != 1 || !strings.Contains(string(reply[0]), `"code":"ADAPTER_CONFIGURATION"`) {
		t.Fatalf("human subscription did not report missing publisher: %s %v", reply, err)
	}
	if len(runner.calls) != 1 || runner.calls[0] != "start" {
		t.Fatalf("human frame consumer ran: %v", runner.calls)
	}
	destroy, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": "destroy", "params": map[string]string{"surface_id": created.Data.Surface.SurfaceID}})
	stopped, err := handler(context.Background(), ipc.Envelope{Body: destroy})
	if err != nil || len(stopped) != 1 {
		t.Fatalf("human cleanup requires nonexistent frame allocation: %s %v", stopped, err)
	}
	var terminal struct {
		Event string
		Data  struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(stopped[0], &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Event != "state_changed" || terminal.Data.Surface.State != "destroyed" {
		t.Fatalf("human destroy lacked acknowledgement: %s", stopped)
	}

}
