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

type waitingFrameRunner struct {
	entered chan struct{}
	initialRunner
}

func (r *waitingFrameRunner) Run(ctx context.Context, args []string, in []byte) ([]byte, error) {
	if args[1] == "frame" {
		close(r.entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return r.initialRunner.Run(ctx, args, in)
}

func TestWireUnsubscribeCancelsCaptureHoldingManagerLock(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-sub-drain-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	runner := &waitingFrameRunner{entered: make(chan struct{})}
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Minute, OriginNS: 100}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	events, err := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: json.RawMessage(`{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)})
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		Data struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(events[0], &created); err != nil {
		t.Fatal(err)
	}
	id := created.Data.Surface.SurfaceID
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	session, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub, err := frames.NewSubscriptions(session, frames.SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Minute, ShutdownTimeout: time.Second}, m, pub, func(context.Context, json.RawMessage) error { t.Error("cancelled capture emitted"); return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close(context.Background())
	if err = sub.Subscribe(session, id); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runner.entered:
	case <-time.After(time.Second):
		t.Fatal("capture never entered")
	}
	h := subscriptionHandler(m, profiles, map[string]*frames.Subscriptions{root: sub}, func(context.Context, ipc.Envelope) ([]json.RawMessage, error) {
		t.Error("unsubscribe fell through")
		return nil, nil
	})
	body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": "frame_unsubscribe", "params": map[string]string{"surface_id": id}})
	done := make(chan error, 1)
	go func() {
		events, err := h(session, ipc.Envelope{Body: body})
		if len(events) != 0 {
			t.Error("unsubscribe returned failure event")
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		cancel()
		<-done
		t.Fatal("unsubscribe waited for the manager lock before cancelling capture")
	}
}
