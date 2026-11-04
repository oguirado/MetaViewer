package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type programSubscriptionRunner struct{ binary, role string }

func (r *programSubscriptionRunner) ConsumeOpeningProgramMode(id string) (string, string, error) {
	if id == "prog-dynamic" {
		return r.binary, r.role, nil
	}
	return "", "", nil
}
func (r *programSubscriptionRunner) Run(_ context.Context, argv []string, _ []byte) ([]byte, error) {
	if argv[1] != "start" {
		return nil, fmt.Errorf("unexpected native operation %q", argv[1])
	}
	id, container, kind := argv[5], "srf-id-"+argv[5], "browser"
	if argv[3] == "program" {
		container, kind = "srf-pg-"+id, "program"
	}
	return []byte(fmt.Sprintf(`{"kind":%q,"container":%q,"run_id":"run-fixture","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":900,"title":"","url":""}]}`, kind, container)), nil
}

type programSubscriptionSource struct{ entered chan string }

func (s *programSubscriptionSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	select {
	case s.entered <- id:
	case <-ctx.Done():
	}
	<-ctx.Done()
	return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
}

func programSubscriptionFixture(t *testing.T, role string) (*capsule.Manager, map[string]capsule.Profile, string) {
	t.Helper()
	root, err := os.MkdirTemp("/dev/shm", "mv-program-sub-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	binary := filepath.Join(t.TempDir(), "toy-program")
	if err = os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	profiles := map[string]capsule.Profile{"static-browser": {Role: role, Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":111", Width: 1280, Height: 900}}
	runner := &programSubscriptionRunner{binary: binary, role: role}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 2, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	return m, profiles, root
}

func subscriptionSurface(t *testing.T, m *capsule.Manager, kind, id string) string {
	t.Helper()
	raw := json.RawMessage(fmt.Sprintf(`{"kind":%q,"profile_id":%q,"geometry":{"w":1280,"h":900}}`, kind, id))
	events, err := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: raw})
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}
	if err = json.Unmarshal(events[0], &out); err != nil {
		t.Fatal(err)
	}
	return out.Data.Surface.SurfaceID
}

func subscribeProgramTest(h ipc.Handler, id string) ([]json.RawMessage, error) {
	body := json.RawMessage(fmt.Sprintf(`{"schema":"surface_request/v0.2","op":"frame_subscribe","params":{"surface_id":%q}}`, id))
	return h(context.Background(), ipc.Envelope{Body: body})
}

func TestDynamicProgramAndStaticBrowserSubscriptionsRouteToAdmittedRoot(t *testing.T) {
	for _, kind := range []string{"desktop_capsule", "browser"} {
		t.Run(kind, func(t *testing.T) {
			m, profiles, root := programSubscriptionFixture(t, "agent")
			id := "prog-dynamic"
			if kind == "browser" {
				id = "static-browser"
			}
			sid := subscriptionSurface(t, m, kind, id)
			if kind == "desktop_capsule" {
				if _, exists := profiles[id]; exists {
					t.Fatal("fixture is not dynamic")
				}
			}
			pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 1280 * 900 * 4, MaxPixels: 1280 * 900, MaxSurfaces: 2})
			if err != nil {
				t.Fatal(err)
			}
			defer pub.Close()
			source := &programSubscriptionSource{entered: make(chan string, 1)}
			sub, err := frames.NewSubscriptions(context.Background(), frames.SubscriptionConfig{MaxSubscriptions: 2, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, pub, func(context.Context, json.RawMessage) error { t.Error("cancelled capture emitted"); return nil })
			if err != nil {
				t.Fatal(err)
			}
			defer sub.Close(context.Background())
			h := subscriptionHandler(m, profiles, map[string]*frames.Subscriptions{root: sub}, nil)
			events, err := subscribeProgramTest(h, sid)
			if err != nil || len(events) != 0 {
				t.Fatalf("subscription refused: %s %v", events, err)
			}
			select {
			case got := <-source.entered:
				if got != sid {
					t.Fatal("wrong capture surface")
				}
			case <-time.After(time.Second):
				t.Fatal("no capture routed")
			}
		})
	}
}

func TestProgramSubscriptionMissingSurfacePublisherAndHumanMode(t *testing.T) {
	for _, mode := range []string{"missing-surface", "no-publisher", "human"} {
		t.Run(mode, func(t *testing.T) {
			role := "agent"
			if mode == "human" {
				role = "human"
			}
			m, profiles, _ := programSubscriptionFixture(t, role)
			sid := "unknown-surface"
			if mode != "missing-surface" {
				sid = subscriptionSurface(t, m, "desktop_capsule", "prog-dynamic")
			}
			h := subscriptionHandler(m, profiles, map[string]*frames.Subscriptions{}, nil)
			events, err := subscribeProgramTest(h, sid)
			if err != nil {
				t.Fatal(err)
			}
			if len(events) != 1 || !strings.Contains(string(events[0]), `"event":"error"`) {
				t.Fatalf("missing evidence did not refuse: %s", events)
			}
		})
	}
}

// Human view transport and verified recording have separate consumers. An
// explicit verified subscription must still reach the admitted publisher.
func TestHumanSubscriptionsProvideVerifiedRecordingFrames(t *testing.T) {
	for _, kind := range []string{"desktop_capsule", "browser"} {
		t.Run(kind, func(t *testing.T) {
			m, profiles, root := programSubscriptionFixture(t, "human")
			id := "prog-dynamic"
			if kind == "browser" {
				id = "static-browser"
			}
			sid := subscriptionSurface(t, m, kind, id)
			pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 1280 * 900 * 4, MaxPixels: 1280 * 900, MaxSurfaces: 2})
			if err != nil {
				t.Fatal(err)
			}
			defer pub.Close()
			source := &programSubscriptionSource{entered: make(chan string, 1)}
			sub, err := frames.NewSubscriptions(context.Background(), frames.SubscriptionConfig{MaxSubscriptions: 2, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, source, pub, func(context.Context, json.RawMessage) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			defer sub.Close(context.Background())
			h := subscriptionHandler(m, profiles, map[string]*frames.Subscriptions{root: sub}, nil)
			events, err := subscribeProgramTest(h, sid)
			if err != nil || len(events) != 0 {
				t.Fatalf("subscription failed: %s %v", events, err)
			}
			select {
			case got := <-source.entered:
				if got != sid {
					t.Fatal("wrong surface")
				}
			case <-time.After(time.Second):
				t.Fatal("human recording received no verified capture")
			}
		})
	}
}
