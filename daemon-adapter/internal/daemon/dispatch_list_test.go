package daemon

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

func TestDirectHandlersListSnapshots(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-list-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 3, Height: 2}}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, shrinkingWindowRunner{root}, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := m.Handle(ctx, capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: json.RawMessage(`{"kind":"browser","profile_id":"demo","geometry":{"w":3,"h":2}}`)})
	if err != nil || len(created) != 1 {
		t.Fatalf("seed surface: %s %v", created, err)
	}
	var seed struct {
		Event string
		Data  json.RawMessage
	}
	if err := json.Unmarshal(created[0], &seed); err != nil || seed.Event != "created" {
		t.Fatalf("creation control: %s %v", created, err)
	}
	// List never publishes a frame, so no publisher resources are needed.
	direct, err := NewHandler(m, &frames.Publisher{})
	if err != nil {
		t.Fatal(err)
	}
	for name, handler := range map[string]ipc.Handler{"configured": direct, "wire": wireHandler(m, profiles, nil, 100)} {
		t.Run(name, func(t *testing.T) {
			for range 2 {
				out, err := handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"list","params":{}}`)})
				if err != nil || len(out) != 1 {
					t.Fatalf("list: %s %v", out, err)
				}
				var snapshot struct {
					Event string
					Data  json.RawMessage
				}
				if err := json.Unmarshal(out[0], &snapshot); err != nil || snapshot.Event != "state_changed" || string(snapshot.Data) != string(seed.Data) {
					t.Fatalf("list must preserve snapshot without committing creation: %s %v", out, err)
				}
			}
		})
	}
}

func TestListSnapshotsRejectMalformedData(t *testing.T) {
	for _, data := range []string{`null`, `{}`, `[]`, `"x"`, `{"surface":null}`, `{"surface":{}}`, `{"surface":{"surface_id":""}}`, `{"surface":{"surface_id":7}}`, `{"surface":{"surface_id":"s1"},"unexpected":true}`} {
		t.Run(data, func(t *testing.T) {
			raw := json.RawMessage(`{"schema":"surface_event/v0.2","event":"created","data":` + data + `}`)
			if out, err := listSnapshots([]json.RawMessage{raw}); err == nil || out != nil {
				t.Fatalf("malformed list data accepted: %s %v", out, err)
			}
		})
	}
	// Negative control: validation must still admit and preserve a valid snapshot.
	raw := json.RawMessage(`{"schema":"surface_event/v0.2","event":"created","data":{"surface":{"surface_id":"s1"}}}`)
	out, err := listSnapshots([]json.RawMessage{raw})
	if err != nil || len(out) != 1 || string(out[0]) != `{"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":{"surface_id":"s1"}}}` {
		t.Fatalf("valid snapshot refused or changed: %s %v", out, err)
	}
}
