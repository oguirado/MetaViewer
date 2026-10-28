package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type settlementRunner struct {
	started, finish chan struct{}
	initialRunner
	seq  int
	mode string
}

func (r *settlementRunner) Run(ctx context.Context, args []string, in []byte) ([]byte, error) {
	switch args[1] {
	case "input":
		if r.mode == "takeover" || r.mode == "lost" {
			close(r.started)
			<-ctx.Done()
			<-r.finish
			return nil, ctx.Err()
		}
		if r.mode == "native" {
			return nil, errors.New("native execution failed")
		}
		return []byte(`{"surface_id":"w1","kind":"key","focus_verified":true,"result":"ok","input_mono_ns":200}`), nil
	case "frame":
		r.seq++
		if r.seq > 1 && r.mode == "capture" {
			return nil, errors.New("capture failed")
		}
		path := filepath.Join(r.root, "demo-run/frames/w1/f.png")
		b, _ := json.Marshal(map[string]any{"sha256_rgb24": fmt.Sprintf("%x", sha256.Sum256(make([]byte, 6))), "path": path, "seq": r.seq, "width": 2, "height": 1, "capture_mono_ns": 200, "generation": "srf-id-demo", "window": map[string]any{"id": "w1", "w": 2, "h": 1}})
		return b, nil
	}
	return r.initialRunner.Run(ctx, args, in)
}

func TestInputFailuresSettleWithProposal(t *testing.T) {
	for _, mode := range []string{"native", "unsupported", "capture", "publish", "takeover", "lost"} {
		t.Run(mode, func(t *testing.T) {
			root, err := os.MkdirTemp("/dev/shm", "mv-input-settle-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(root)
			source := filepath.Join(root, "demo-run/frames/w1")
			if err = os.MkdirAll(source, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(source, "f.png")
			f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
			img.Set(0, 0, color.NRGBA{A: 255})
			img.Set(1, 0, color.NRGBA{A: 255})
			if err = png.Encode(f, img); err != nil {
				t.Fatal(err)
			}
			f.Close()
			profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
			runner := &settlementRunner{initialRunner: initialRunner{root: root}, mode: mode, started: make(chan struct{}), finish: make(chan struct{})}
			m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
			if err != nil {
				t.Fatal(err)
			}
			pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer pub.Close()
			h := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, 100)
			call := func(op string, params any) []json.RawMessage {
				t.Helper()
				body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
				events, err := h(context.Background(), ipc.Envelope{Body: body})
				if err != nil {
					t.Fatal(err)
				}
				return events
			}
			created := call("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
			if len(created) != 2 {
				t.Fatalf("create: %s", created)
			}
			var event struct {
				Data struct{ Surface capsule.Surface }
			}
			if err = json.Unmarshal(created[0], &event); err != nil {
				t.Fatal(err)
			}
			action := map[string]any{"type": "key", "keys": []string{"a"}}
			if mode == "unsupported" {
				action = map[string]any{"type": "unknown"}
			}
			if mode == "publish" {
				if err = os.Chmod(path, 0644); err != nil {
					t.Fatal(err)
				}
			}
			params := map[string]any{"surface_id": event.Data.Surface.SurfaceID, "proposal_id": "failed-proposal", "action": action}
			var events []json.RawMessage
			if mode == "takeover" || mode == "lost" {
				done := make(chan []json.RawMessage, 1)
				go func() { done <- call("input", params) }()
				select {
				case <-runner.started:
				case <-time.After(time.Second):
					t.Fatal("input never started")
				}
				if mode == "lost" {
					if _, err := m.MarkLost(event.Data.Surface.SurfaceID, true); err != nil {
						close(runner.finish)
						t.Fatal(err)
					}
				} else {
					call("take_control", map[string]any{"surface_id": event.Data.Surface.SurfaceID, "owner": "human"})
				}
				close(runner.finish)
				select {
				case events = <-done:
				case <-time.After(time.Second):
					t.Fatal("cancelled input never settled")
				}
				if mode == "takeover" {
					if ready, err := m.ControlReady(event.Data.Surface.SurfaceID); err != nil || !ready {
						t.Fatalf("failure did not drain: %v", err)
					}
					released := call("release_control", map[string]any{"surface_id": event.Data.Surface.SurfaceID})
					var result struct{ Event string }
					if len(released) != 1 || json.Unmarshal(released[0], &result) != nil || result.Event != "state_changed" {
						t.Fatalf("release refused: %s", released)
					}
				}
			} else {
				events = call("input", params)
			}
			var receipt map[string]any
			if len(events) != 1 || json.Unmarshal(events[0], &receipt) != nil {
				t.Fatalf("missing receipt: %s", events)
			}
			if receipt["schema"] != "action_receipt/v0.2" || receipt["proposal_id"] != "failed-proposal" || receipt["verified"] != false || receipt["error"] == "" || receipt["error"] == nil || receipt["after_frame"] == nil {
				t.Fatalf("uncorrelated or verified failure: %s", events)
			}
			if mode == "lost" {
				if again, err := m.MarkLost(event.Data.Surface.SurfaceID, true); err != nil || len(again) != 0 {
					t.Fatalf("repeated loss emitted a duplicate settlement: %s %v", again, err)
				}
			}
		})
	}
}

func TestHumanOriginWireReceipts(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-human-origin-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	source := filepath.Join(root, "demo-run/frames/w1")
	if err = os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(source, "f.png")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.NRGBA{A: 255})
	img.Set(1, 0, color.NRGBA{A: 255})
	if err = png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	f.Close()
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
	runner := &settlementRunner{initialRunner: initialRunner{root: root}, mode: "ok", started: make(chan struct{}), finish: make(chan struct{})}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	h := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, 100)
	call := func(op string, params any) []json.RawMessage {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		events, err := h(context.Background(), ipc.Envelope{Body: body})
		if err != nil {
			t.Fatal(err)
		}
		return events
	}
	created := call("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
	var event struct {
		Data struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(created[0], &event); err != nil {
		t.Fatal(err)
	}
	sid := event.Data.Surface.SurfaceID
	action := map[string]any{"type": "key", "keys": []string{"a"}}

	// 1. Human origin under agent control -> refused with SURFACE_NOT_HUMAN_CONTROLLED receipt.
	refusedHuman := call("input", map[string]any{"surface_id": sid, "proposal_id": "hi-under-agent", "origin": "human", "action": action})
	var receipt map[string]any
	if len(refusedHuman) != 1 || json.Unmarshal(refusedHuman[0], &receipt) != nil || receipt["proposal_id"] != "hi-under-agent" || receipt["error"] != "input failed: SURFACE_NOT_HUMAN_CONTROLLED: agent control blocks human input" {
		t.Fatalf("unexpected receipt for human origin under agent control: %s", refusedHuman)
	}

	// 2. Take control for human -> human origin applied without post-input pixel capture (input_applied + action_receipt error=="").
	call("take_control", map[string]any{"surface_id": sid, "owner": "human"})
	appliedHuman := call("input", map[string]any{"surface_id": sid, "proposal_id": "hi-under-human", "origin": "human", "action": action})
	if len(appliedHuman) != 2 {
		t.Fatalf("expected 2 events for applied human input (no post-input capture), got %s", appliedHuman)
	}
	receipt = nil
	if json.Unmarshal(appliedHuman[1], &receipt) != nil || receipt["proposal_id"] != "hi-under-human" || receipt["error"] != "" {
		t.Fatalf("unexpected receipt for applied human input: %s", appliedHuman[1])
	}

	// 3. Agent origin under human control -> refused with SURFACE_NOT_AGENT_CONTROLLED receipt.
	refusedAgent := call("input", map[string]any{"surface_id": sid, "proposal_id": "ag-under-human", "origin": "agent", "action": action})
	receipt = nil
	if len(refusedAgent) != 1 || json.Unmarshal(refusedAgent[0], &receipt) != nil || receipt["proposal_id"] != "ag-under-human" || receipt["error"] != "input failed: SURFACE_NOT_AGENT_CONTROLLED: human control blocks agent input" {
		t.Fatalf("unexpected receipt for agent origin under human control: %s", refusedAgent)
	}

	// 4. Release control back to agent (with refresh capture) -> agent path keeps post-input pixel verification (3 events: input_applied + frame_ready + action_receipt).
	call("release_control", map[string]any{"surface_id": sid})
	if _, _, err := m.Capture(context.Background(), sid); err != nil {
		t.Fatal(err)
	}
	appliedAgent := call("input", map[string]any{"surface_id": sid, "proposal_id": "ag-under-agent", "origin": "agent", "action": action})
	if len(appliedAgent) != 3 {
		t.Fatalf("expected 3 events for applied agent input, got %s", appliedAgent)
	}
}

type holdingsSettlementRunner struct {
	root string
}

func (r *holdingsSettlementRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	switch filepath.Base(args[0]) + ":" + args[1] {
	case "srf-holdings-capsule:start":
		framesDir := filepath.Join(r.root, "hc-0123456789ab/frames")
		return json.Marshal([]map[string]any{{
			"slot":        1,
			"container":   "srf-ng-hcap-hc-0123456789ab-1",
			"run_id":      "hc-0123456789ab",
			"display":     ":100",
			"width":       2,
			"height":      1,
			"lane_socket": "/tmp/lane.sock",
			"ready_line":  "READY",
			"ready_ms":    0,
			"frames_dir":  framesDir,
		}})
	case "srf-holdings-capsule:frame":
		path := filepath.Join(r.root, "hc-0123456789ab/frames/f.png")
		return json.Marshal(map[string]any{
			"sha256_rgb24":    fmt.Sprintf("%x", sha256.Sum256(make([]byte, 6))),
			"path":            path,
			"seq":             1,
			"width":           2,
			"height":          1,
			"capture_mono_ns": 200,
			"generation":      "srf-ng-hcap-hc-0123456789ab-1",
		})
	case "srf-holdings-capsule:input":
		return []byte(`{"input_mono_ns":200}`), nil
	}
	return nil, errors.New("unexpected native command")
}

func TestHumanEmptyBaselineSettles(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-human-empty-baseline-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	source := filepath.Join(root, "demo-run/frames/w1")
	if err = os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(source, "f.png")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.NRGBA{A: 255})
	img.Set(1, 0, color.NRGBA{A: 255})
	if err = png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	f.Close()

	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
	runner := &settlementRunner{initialRunner: initialRunner{root: root}, mode: "ok", started: make(chan struct{}), finish: make(chan struct{})}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()

	// Create directly on Manager so wireHandler's lastFrames baseline is empty.
	created, err := m.Handle(context.Background(), capsule.Request{
		Schema: "surface_request/v0.2",
		Op:     "create",
		Params: json.RawMessage(`{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`),
	})
	if err != nil || len(created) != 1 {
		t.Fatalf("create failed: %s %v", created, err)
	}
	var event struct {
		Data struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(created[0], &event); err != nil {
		t.Fatal(err)
	}
	sid := event.Data.Surface.SurfaceID

	h := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, 100)
	call := func(op string, params any) []json.RawMessage {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		events, err := h(context.Background(), ipc.Envelope{Body: body})
		if err != nil {
			t.Fatal(err)
		}
		return events
	}

	call("take_control", map[string]any{"surface_id": sid, "owner": "human"})
	action := map[string]any{"type": "key", "keys": []string{"a"}}
	settled := call("input", map[string]any{"surface_id": sid, "proposal_id": "hi-empty-baseline", "origin": "human", "action": action})
	if len(settled) != 2 {
		t.Fatalf("expected input_applied + error action_receipt when lastFrames is empty, got %s", settled)
	}
	var applied struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
		Data   struct {
			SurfaceID  string `json:"surface_id"`
			ProposalID string `json:"proposal_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(settled[0], &applied); err != nil || applied.Schema != "surface_event/v0.2" || applied.Event != "input_applied" || applied.Data.ProposalID != "hi-empty-baseline" {
		t.Fatalf("unexpected input_applied event: %s (%v)", settled[0], err)
	}
	var receipt map[string]any
	if err := json.Unmarshal(settled[1], &receipt); err != nil {
		t.Fatalf("unmarshal receipt: %s (%v)", settled[1], err)
	}
	if receipt["schema"] != "action_receipt/v0.2" || receipt["proposal_id"] != "hi-empty-baseline" || receipt["verified"] != false || receipt["error"] == "" || receipt["error"] == nil || receipt["after_frame"] == nil {
		t.Fatalf("unexpected error receipt for empty baseline: %s", settled[1])
	}

	policy, err := ipc.NewPolicy(ipc.Config{SocketPath: filepath.Join(t.TempDir(), "core.sock"), MaxReplayEntries: 100, MaxConnections: 1, HelloTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second, MaxFrameBytes: 1 << 20, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096}, os.DirFS(filepath.Join("..", "..", "..", "contracts", "v0.2")), &lifecyclePolicy{})
	if err != nil {
		t.Fatal(err)
	}
	envelope, _ := json.Marshal(ipc.Envelope{Schema: "envelope/v0.2", MsgID: "proof", From: ipc.Endpoint{Component: "daemon", Instance: "daemon"}, To: ipc.Endpoint{Component: "core", Instance: "core"}, SessionID: "proof", Seq: 1, Nonce: "proof", Body: settled[1]})
	if _, err = policy.ValidateEnvelope(envelope); err != nil {
		t.Fatalf("empty-baseline error receipt failed schema validation: %v (%s)", err, settled[1])
	}

	// Holdings human-origin input requires and invokes VerifyHoldingsInput.
	hSource := filepath.Join(root, "hc-0123456789ab/frames")
	if err = os.MkdirAll(hSource, 0700); err != nil {
		t.Fatal(err)
	}
	hPath := filepath.Join(hSource, "f.png")
	hf, err := os.OpenFile(hPath, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err = png.Encode(hf, img); err != nil {
		t.Fatal(err)
	}
	hf.Close()

	hProfiles := map[string]capsule.Profile{"game": {Kind: "game_capsule", NativeKind: "holdings", AppDir: "/opt/game", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
	hRunner := &holdingsSettlementRunner{root: root}
	var verifiedCalls int
	var verifyErr error
	hm, err := capsule.NewManager(capsule.Config{
		BinDir:         t.TempDir(),
		Profiles:       hProfiles,
		MaxSurfaces:    1,
		MaxOutputBytes: 8192,
		Timeout:        time.Second,
		OriginNS:       100,
		VerifyHoldingsInput: func(_ context.Context, _ capsule.Binding, proposal string, _ json.RawMessage, stamp uint64) error {
			verifiedCalls++
			if proposal == "" || stamp != 200 {
				return errors.New("invalid holdings verification args")
			}
			return verifyErr
		},
	}, hRunner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	hPub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer hPub.Close()
	hh := wireHandler(hm, hProfiles, map[string]*frames.Publisher{root: hPub}, 100)
	hCall := func(op string, params any) []json.RawMessage {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		events, err := hh(context.Background(), ipc.Envelope{Body: body})
		if err != nil {
			t.Fatal(err)
		}
		return events
	}
	hCreated := hCall("create", map[string]any{"kind": "game_capsule", "profile_id": "game", "geometry": map[string]int{"w": 2, "h": 1}})
	var hEvent struct {
		Data struct{ Surface capsule.Surface }
	}
	if err = json.Unmarshal(hCreated[0], &hEvent); err != nil {
		t.Fatal(err)
	}
	hSID := hEvent.Data.Surface.SurfaceID
	hCall("take_control", map[string]any{"surface_id": hSID, "owner": "human"})

	verifyErr = errors.New("holdings proof rejected")
	hFailed := hCall("input", map[string]any{"surface_id": hSID, "proposal_id": "hi-holdings-fail", "origin": "human", "action": action})
	if len(hFailed) != 1 || verifiedCalls != 1 {
		t.Fatalf("expected VerifyHoldingsInput refusal to settle with 1 error receipt, calls=%d events=%s", verifiedCalls, hFailed)
	}
	verifyErr = nil
	hOK := hCall("input", map[string]any{"surface_id": hSID, "proposal_id": "hi-holdings-ok", "origin": "human", "action": action})
	if len(hOK) != 2 || verifiedCalls != 2 {
		t.Fatalf("expected verified holdings human input to emit 2 events, calls=%d events=%s", verifiedCalls, hOK)
	}
}

func TestHumanInputReceiptAttachesLatestPublishedFrameRef(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-human-latest-frame-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	source := filepath.Join(root, "demo-run/frames/w1")
	if err = os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(source, "f.png")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.NRGBA{A: 255})
	img.Set(1, 0, color.NRGBA{A: 255})
	if err = png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	f.Close()

	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
	runner := &settlementRunner{initialRunner: initialRunner{root: root}, mode: "ok", started: make(chan struct{}), finish: make(chan struct{})}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 100}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()

	h := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, 100)
	call := func(op string, params any) []json.RawMessage {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		events, err := h(context.Background(), ipc.Envelope{Body: body})
		if err != nil {
			t.Fatal(err)
		}
		return events
	}

	// 1. Create surface and record initial create-time frame ref A.
	created := call("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
	if len(created) != 2 {
		t.Fatalf("expected 2 events on create, got %s", created)
	}
	var createEv struct {
		Data struct{ Surface capsule.Surface }
	}
	if err := json.Unmarshal(created[0], &createEv); err != nil {
		t.Fatal(err)
	}
	sid := createEv.Data.Surface.SurfaceID

	var readyA struct {
		Data struct {
			FrameRef frames.Ref `json:"frame_ref"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created[1], &readyA); err != nil {
		t.Fatal(err)
	}
	frameA := readyA.Data.FrameRef

	// 2. Perform an agent input that publishes a new post-input frame ref B.
	action := map[string]any{"type": "key", "keys": []string{"a"}}
	agentEvents := call("input", map[string]any{"surface_id": sid, "proposal_id": "agent-1", "origin": "agent", "action": action})
	if len(agentEvents) != 3 {
		t.Fatalf("expected 3 events for agent input, got %s", agentEvents)
	}
	var readyB struct {
		Data struct {
			FrameRef frames.Ref `json:"frame_ref"`
		} `json:"data"`
	}
	if err := json.Unmarshal(agentEvents[1], &readyB); err != nil {
		t.Fatal(err)
	}
	frameB := readyB.Data.FrameRef
	if frameB.Generation == frameA.Generation || frameB.RAMWSPath == frameA.RAMWSPath {
		t.Fatalf("post-input frame B (%+v) did not advance from create-time frame A (%+v)", frameB, frameA)
	}

	// 3. Take human control, perform a human input, and assert after_frame equals B (and NOT stale frame A).
	call("take_control", map[string]any{"surface_id": sid, "owner": "human"})
	humanEvents := call("input", map[string]any{"surface_id": sid, "proposal_id": "human-after-agent", "origin": "human", "action": action})
	if len(humanEvents) != 2 {
		t.Fatalf("expected 2 events for human input, got %s", humanEvents)
	}
	var humanReceipt struct {
		ProposalID string     `json:"proposal_id"`
		AfterFrame frames.Ref `json:"after_frame"`
		Error      string     `json:"error"`
	}
	if err := json.Unmarshal(humanEvents[1], &humanReceipt); err != nil {
		t.Fatal(err)
	}
	if humanReceipt.ProposalID != "human-after-agent" || humanReceipt.Error != "" {
		t.Fatalf("unexpected human receipt: %+v", humanReceipt)
	}
	if humanReceipt.AfterFrame == frameA || humanReceipt.AfterFrame.Generation == frameA.Generation || humanReceipt.AfterFrame.RAMWSPath == frameA.RAMWSPath {
		t.Fatalf("human receipt attached stale create-time frame A (%+v) instead of latest frame B (%+v)", humanReceipt.AfterFrame, frameB)
	}
	if humanReceipt.AfterFrame != frameB {
		t.Fatalf("human receipt after_frame = %+v, want latest frame B %+v", humanReceipt.AfterFrame, frameB)
	}
}
