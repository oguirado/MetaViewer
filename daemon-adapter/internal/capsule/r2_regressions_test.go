package capsule

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

func TestT2R207InputTimestampReplayRefused(t *testing.T) {
	var now atomic.Uint64
	now.Store(150)
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	m.clock = func() uint64 { return now.Load() }
	id := createID(t, m)

	// Negative control: fresh in-window stamp on first input is accepted.
	r.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":150,"focus_verified":true,"result":"ok"}`)
	_, ev1, err := m.HandleInputWithEvidence(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p1","action":{"type":"key","keys":["a"]}}`))
	if err != nil || ev1.InputMonoNS != 150 || ev1.InputTSNS != 50 {
		t.Fatalf("fresh in-window stamp refused: %+v %v", ev1, err)
	}

	// Regression: clock advances to [250, 260]; hostile CLI replays old stamp 150 (< before=250).
	var calls atomic.Int32
	m.clock = func() uint64 {
		if calls.Add(1) == 1 {
			return 250
		}
		return 260
	}
	r.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":150,"focus_verified":true,"result":"ok"}`)
	out, evReplay, err := m.HandleInputWithEvidence(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p2","action":{"type":"key","keys":["a"]}}`))
	requireFault(t, err, "input")
	if len(out) != 0 || evReplay != (InputEvidence{}) {
		t.Fatalf("replayed pre-window stamp accepted: %s %+v", out, evReplay)
	}

	// Regression: hostile CLI reports future stamp 270 (> after=260).
	calls.Store(0)
	r.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":270,"focus_verified":true,"result":"ok"}`)
	out, evFuture, err := m.HandleInputWithEvidence(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p3","action":{"type":"key","keys":["a"]}}`))
	requireFault(t, err, "input")
	if len(out) != 0 || evFuture != (InputEvidence{}) {
		t.Fatalf("out-of-window future stamp accepted: %s %+v", out, evFuture)
	}

	// Negative control: fresh stamp 255 in [250, 260] is accepted with distinct evidence.
	calls.Store(0)
	r.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":255,"focus_verified":true,"result":"ok"}`)
	_, ev2, err := m.HandleInputWithEvidence(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p4","action":{"type":"key","keys":["a"]}}`))
	if err != nil || ev2.InputMonoNS != 255 || ev2.InputTSNS != 155 || ev2.InputMonoNS == ev1.InputMonoNS {
		t.Fatalf("second fresh in-window stamp failed: %+v %v", ev2, err)
	}
}

func TestT6R2009AndR1085InputMonoNSRail(t *testing.T) {
	const maxSafeInt = uint64(9007199254740991)
	var now atomic.Uint64
	now.Store(maxSafeInt + 10)
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	m.clock = func() uint64 { return now.Load() }
	id := createID(t, m)

	// Regression (T6R2-009 / R1-085): receipt with 2^53 (9007199254740992) refused early with input fault.
	r.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":9007199254740992,"focus_verified":true,"result":"ok"}`)
	out, evOver, err := m.HandleInputWithEvidence(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"rail-over","action":{"type":"key","keys":["a"]}}`))
	requireFault(t, err, "input")
	if len(out) != 0 || evOver != (InputEvidence{}) {
		t.Fatalf("above-rail input_mono_ns admitted: %s %+v", out, evOver)
	}

	// Negative control: receipt at exact rail 2^53-1 (9007199254740991) admitted.
	now.Store(maxSafeInt)
	r.output = []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":9007199254740991,"focus_verified":true,"result":"ok"}`)
	out, evOK, err := m.HandleInputWithEvidence(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"rail-max","action":{"type":"key","keys":["a"]}}`))
	if err != nil || len(out) != 1 || evOK.InputMonoNS != maxSafeInt || evOK.InputTSNS != maxSafeInt-m.cfg.OriginNS {
		t.Fatalf("under-rail input_mono_ns refused: %+v %v", evOK, err)
	}
}

func TestT2R208CaptureReleasesMutexAcrossNativeCLI(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	p := m.cfg.Profiles["demo"]
	p.Width, p.Height = 4, 4
	m.cfg.Profiles["demo"] = p
	m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
		switch args[1] {
		case "start":
			return []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":4,"h":4,"title":"","url":""}]}`), nil
		case "frame":
			close(started)
			<-release
			return []byte(`{"path":"/dev/shm/demo-run/frames/w1/f.png","seq":1,"sha256_rgb24":"0000000000000000000000000000000000000000000000000000000000000000","width":2,"height":2,"capture_mono_ns":200,"generation":"srf-id-demo","window":{"id":"w1","w":2,"h":2}}`), nil
		case "stop":
			return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
		}
		return nil, fault("unexpected", "unexpected command")
	})
	out, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":4,"h":4}}`))
	if err != nil {
		t.Fatal(err)
	}
	var ev struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out[0], &ev); err != nil {
		t.Fatal(err)
	}
	id := ev.Data.Surface.SurfaceID

	capDone := make(chan error, 1)
	go func() {
		_, _, e := m.Capture(context.Background(), id)
		capDone <- e
	}()
	awaitSignal(t, started)

	// Regression: concurrent list must complete while capture native CLI is blocked.
	listDone := make(chan error, 1)
	go func() {
		listOut, e := m.Handle(context.Background(), req("list", `{}`))
		if e == nil && len(listOut) != 1 {
			e = fault("test", "unexpected list length")
		}
		listDone <- e
	}()
	select {
	case e := <-listDone:
		if e != nil {
			t.Fatalf("concurrent list failed: %v", e)
		}
	case <-time.After(200 * time.Millisecond):
		close(release)
		<-capDone
		t.Fatal("list blocked while capture native CLI outstanding (mu held)")
	}

	// Negative control: surface destroyed mid-capture -> capture refused, no geometry write.
	if _, err := m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); err != nil {
		close(release)
		<-capDone
		t.Fatalf("destroy during blocked capture failed: %v", err)
	}
	close(release)
	capErr := <-capDone
	requireFault(t, capErr, "surface")
	if got := m.bindings[id].Surface.Geometry; got != (Geometry{W: 4, H: 4}) {
		t.Fatalf("destroyed mid-capture mutated geometry to %+v", got)
	}
}

func TestCaptureRefusesInputEpochAdvanceAcrossUnlock(t *testing.T) {
	frameEntered := make(chan struct{})
	releaseFrame := make(chan struct{})
	var frameCalls atomic.Int32
	m := testManager(t, &scriptRunner{output: []byte(startOK)})
	m.runner = a2Runner(func(_ context.Context, args []string, _ []byte) ([]byte, error) {
		switch args[1] {
		case "start":
			return []byte(startOK), nil
		case "frame":
			if frameCalls.Add(1) == 1 {
				close(frameEntered)
				<-releaseFrame
			}
			return []byte(`{"path":"/dev/shm/demo-run/frames/w1/f.png","seq":1,"sha256_rgb24":"0000000000000000000000000000000000000000000000000000000000000000","width":2,"height":1,"capture_mono_ns":200,"generation":"srf-id-demo","window":{"id":"w1","w":2,"h":1}}`), nil
		case "input":
			return []byte(`{"surface_id":"w1","kind":"key","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
		}
		return nil, fault("unexpected", "unexpected command")
	})
	id := createID(t, m)
	ctx := context.Background()

	capDone := make(chan error, 1)
	go func() {
		_, _, e := m.Capture(ctx, id)
		capDone <- e
	}()
	awaitSignal(t, frameEntered)

	if _, err := m.Handle(ctx, req("input", `{"surface_id":"`+id+`","proposal_id":"in-window","action":{"type":"key","keys":["a"]}}`)); err != nil {
		close(releaseFrame)
		<-capDone
		t.Fatalf("input inside capture window failed: %v", err)
	}
	close(releaseFrame)
	requireFault(t, <-capDone, "POLICY")

	// Negative control: capture with no overlapping input succeeds.
	if _, _, err := m.Capture(ctx, id); err != nil {
		t.Fatalf("clean capture after input drained failed: %v", err)
	}
}
