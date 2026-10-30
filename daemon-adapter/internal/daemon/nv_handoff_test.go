package daemon

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/ipc"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type nvWireRunner struct {
	started, finish chan struct{}
	stops           atomic.Int32
}

func (r *nvWireRunner) Run(ctx context.Context, args []string, _ []byte) ([]byte, error) {
	switch args[1] {
	case "start":
		return []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","w":2,"h":1}]}`), nil
	case "input":
		close(r.started)
		<-ctx.Done()
		<-r.finish
		return nil, ctx.Err()
	case "stop":
		r.stops.Add(1)
		return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
	}
	return nil, context.Canceled
}
func TestNVWireTakeoverDrains(t *testing.T) {
	r := &nvWireRunner{started: make(chan struct{}), finish: make(chan struct{})}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), OriginNS: 100, MaxSurfaces: 4, MaxOutputBytes: 4096, Timeout: time.Second, Profiles: map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", Width: 2, Height: 1, Display: ":100", RAMRoot: "/dev/shm"}}}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	request := func(op, params string) capsule.Request {
		return capsule.Request{Schema: "surface_request/v0.2", Op: op, Params: json.RawMessage(params)}
	}
	out, err := m.Handle(context.Background(), request("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		Data struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(out[0], &created); err != nil {
		t.Fatal(err)
	}
	id := created.Data.Surface.SurfaceID
	surface := `{"surface_id":"` + id + `"}`
	if _, err = m.Handle(context.Background(), request("release_control", surface)); err == nil {
		t.Fatal("release without takeover")
	}
	h := isolatedWireHandler(t, m, nil, nil, 100)
	done := make(chan error, 1)
	go func() {
		body, _ := json.Marshal(request("input", `{"surface_id":"`+id+`","proposal_id":"nv","action":{"type":"key","keys":["a"]}}`))
		events, e := h(context.Background(), ipc.Envelope{Body: body})
		if e == nil {
			var failure struct {
				Event string
				Data  struct{ Detail string }
			}
			if len(events) != 1 || json.Unmarshal(events[0], &failure) != nil || failure.Event != "error" || !strings.Contains(failure.Data.Detail, "SURFACE_NOT_AGENT_CONTROLLED") {
				e = context.Canceled
			}
		}
		done <- e
	}()
	select {
	case <-r.started:
	case <-time.After(time.Second):
		t.Fatal("input not started")
	}
	if _, err = m.Handle(context.Background(), request("take_control", `{"surface_id":"`+id+`","owner":"human"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Handle(context.Background(), request("release_control", surface)); err == nil {
		t.Fatal("release before native completion")
	}
	close(r.finish)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if ready, e := m.ControlReady(id); e != nil || !ready {
		t.Errorf("not ready after wire completion: %v", e)
	}
	if _, err = m.Handle(context.Background(), request("release_control", surface)); err != nil {
		t.Error(err)
	}
	if _, err = m.Handle(context.Background(), request("destroy", surface)); err != nil {
		t.Error(err)
	}
	if r.stops.Load() != 1 {
		t.Errorf("stop calls=%d", r.stops.Load())
	}
}
