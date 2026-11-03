package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type postInputTestRunner struct {
	pngPath string
	sha     string
	seq     atomic.Uint64
}

func (r *postInputTestRunner) Run(_ context.Context, a []string, _ []byte) ([]byte, error) {
	switch a[1] {
	case "start":
		return []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1}]}`), nil
	case "input":
		return json.Marshal(map[string]any{
			"surface_id":     "w1",
			"kind":           "click",
			"input_mono_ns":  monotonic(),
			"focus_verified": true,
			"result":         "ok",
		})
	case "frame":
		seq := r.seq.Add(1)
		return json.Marshal(capsule.NativeFrame{
			Path:          r.pngPath,
			Seq:           seq,
			SHA256RGB24:   r.sha,
			Width:         2,
			Height:        1,
			CaptureMonoNS: monotonic(),
			Generation:    "srf-id-demo",
			Window:        &capsule.Window{ID: "w1", W: 2, H: 1},
		})
	}
	return nil, errors.New("unexpected native operation")
}

func TestPostInputUnknownProfileRefusesWithoutPanic(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-post-input-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	pngPath, sha := writeTestPNG(t, root)
	runner := &postInputTestRunner{pngPath: pngPath, sha: sha}
	managerProfiles := map[string]capsule.Profile{
		"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1},
	}
	origin := monotonic()
	m, err := capsule.NewManager(capsule.Config{
		BinDir:         t.TempDir(),
		Profiles:       managerProfiles,
		MaxSurfaces:    1,
		MaxOutputBytes: 8192,
		Timeout:        time.Second,
		OriginNS:       origin,
	}, runner, monotonic)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	created, err := m.Handle(ctx, capsule.Request{
		Schema: "surface_request/v0.2",
		Op:     "create",
		Params: json.RawMessage(`{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`),
	})
	if err != nil || len(created) != 1 {
		t.Fatalf("create failed: %s %v", created, err)
	}
	var createdEv struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created[0], &createdEv); err != nil || createdEv.Data.Surface.SurfaceID == "" {
		t.Fatalf("unmarshal created: %s %v", created[0], err)
	}
	surfaceID := createdEv.Data.Surface.SurfaceID

	pub, err := frames.NewPublisher(frames.PublishConfig{
		RAMRoot:       root,
		MaxFrameBytes: 8192,
		MaxPixels:     64,
		MaxSurfaces:   4,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	// Unknown profile in wireHandler profiles map: must refuse without nil-panicking.
	unknownHandler := isolatedWireHandler(t, m, map[string]capsule.Profile{}, map[string]*frames.Publisher{root: pub}, origin)
	inputEnv := ipc.Envelope{
		MsgID: "msg-1",
		Body:  json.RawMessage(`{"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"` + surfaceID + `","proposal_id":"p-1","action":{"type":"click","x":0,"y":0,"button":"left"}}}`),
	}
	events, err := unknownHandler(ctx, inputEnv)
	if err != nil || len(events) != 1 {
		t.Fatalf("expected error event on unknown profile post-input capture, got events=%s err=%v", events, err)
	}
	var errEv struct {
		Schema string `json:"schema"`
		Event  string `json:"event"`
	}
	if err := json.Unmarshal(events[0], &errEv); err != nil || errEv.Schema != "surface_event/v0.2" || errEv.Event != "error" {
		t.Fatalf("expected surface_event error, got %s (%v)", events[0], err)
	}

	// Negative control: with configured profile and publisher, post-input capture succeeds.
	// Agent input now requires a genuine current publication before dispatch.
	binding, native, err := m.Capture(ctx, surfaceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pub.Publish(surfaceID, binding, native); err != nil {
		t.Fatal(err)
	}
	validHandler := isolatedWireHandler(t, m, managerProfiles, map[string]*frames.Publisher{root: pub}, origin)
	inputEnv2 := ipc.Envelope{
		MsgID: "msg-2",
		Body:  json.RawMessage(`{"schema":"surface_request/v0.2","op":"input","params":{"surface_id":"` + surfaceID + `","proposal_id":"p-2","action":{"type":"click","x":0,"y":0,"button":"left"}}}`),
	}
	okEvents, err := validHandler(ctx, inputEnv2)
	if err != nil || len(okEvents) != 3 {
		t.Fatalf("negative control failed: expected input_applied + frame_ready + action_receipt, got %s (%v)", okEvents, err)
	}
}

type multiDisplayRunner struct {
	mu       sync.Mutex
	root     string
	stateDir string
	pngBytes []byte
	sha      string
	runFrame map[string]string
	seq      uint64
	runs     int
}

func (r *multiDisplayRunner) Run(_ context.Context, a []string, _ []byte) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch a[1] {
	case "start":
		identity := ""
		for i := 0; i+1 < len(a); i++ {
			if a[i] == "--identity" {
				identity = a[i+1]
			}
		}
		r.runs++
		container := "srf-id-" + identity
		runID := "run-" + identity + "-" + strconv.Itoa(r.runs)
		xid := strconv.Itoa(100 + r.runs)
		stateRaw, _ := json.Marshal(map[string]any{
			"Ready":   true,
			"Capsule": map[string]string{"container": container, "run_id": runID},
			"XIDs":    map[string]string{"w1": xid},
		})
		if err := os.WriteFile(filepath.Join(r.stateDir, container+".json"), stateRaw, 0600); err != nil {
			return nil, err
		}
		frameDir := filepath.Join(r.root, runID, "frames", "w1")
		if err := os.MkdirAll(frameDir, 0700); err != nil {
			return nil, err
		}
		framePath := filepath.Join(frameDir, "f.png")
		if err := os.WriteFile(framePath, r.pngBytes, 0600); err != nil {
			return nil, err
		}
		if r.runFrame == nil {
			r.runFrame = map[string]string{}
		}
		r.runFrame[container] = framePath
		return json.Marshal(map[string]any{
			"container": container,
			"run_id":    runID,
			"windows":   []map[string]any{{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1}},
		})
	case "frame":
		container := ""
		for i := 0; i+1 < len(a); i++ {
			if a[i] == "--container" {
				container = a[i+1]
			}
		}
		r.seq++
		return json.Marshal(capsule.NativeFrame{
			Path:          r.runFrame[container],
			Seq:           r.seq,
			SHA256RGB24:   r.sha,
			Width:         2,
			Height:        1,
			CaptureMonoNS: monotonic(),
			Generation:    container,
			Window:        &capsule.Window{ID: "w1", W: 2, H: 1},
		})
	case "stop":
		container := ""
		for i := 0; i+1 < len(a); i++ {
			if a[i] == "--container" {
				container = a[i+1]
			}
		}
		return json.Marshal(map[string]any{"stopped": container, "removed_verified": true})
	}
	return nil, errors.New("unexpected native operation")
}

func TestHelloDisplayTapsPerCapsuleDisplayAndRestart(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-mdisp-env-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	displayDir := filepath.Join(root, "display-base")
	stateDir := filepath.Join(root, "identity-state")
	admDir := filepath.Join(root, "ram-admission")
	for _, d := range []string{displayDir, stateDir, admDir} {
		if err := os.MkdirAll(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("MV_DISPLAY_DIR", displayDir)
	t.Setenv("MV_SRF_STATE_DIR", stateDir)
	t.Setenv("MV_RAM_ADMISSION_DIR", admDir)
	t.Setenv("MV_DISPLAY_TAP", "")

	pngPath, sha := writeTestPNG(t, root)
	pngBytes, err := os.ReadFile(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	runner := &multiDisplayRunner{root: root, stateDir: stateDir, pngBytes: pngBytes, sha: sha}

	profiles := map[string]capsule.Profile{
		"mv-live-1": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1},
		"mv-live-2": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":101", Width: 2, Height: 1},
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{
		RAMRoot:       root,
		MaxFrameBytes: 8192,
		MaxPixels:     64,
		MaxSurfaces:   4,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	var targetMu sync.Mutex
	seenTargets := map[string][]frames.DisplayTarget{}
	targetReady := make(chan struct{}, 8)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := streamSession{
		ctx:   ctx,
		work:  &sync.Mutex{},
		locks: &surfaceLocks{},
		emit:  func(context.Context, json.RawMessage) error { return nil },
	}
	sessionCtx := context.WithValue(ctx, streamKey{}, session)

	state := helloState{
		displayCommand: func(cmdCtx context.Context, target frames.DisplayTarget) *exec.Cmd {
			targetMu.Lock()
			seenTargets[target.Container] = append(seenTargets[target.Container], target)
			targetMu.Unlock()
			select {
			case targetReady <- struct{}{}:
			default:
			}
			cmd := exec.CommandContext(cmdCtx, "sh", "-c", "cat >/dev/null")
			return cmd
		},
	}
	t.Cleanup(func() {
		if state.displayTaps != nil {
			stopCtx, stopCancel := context.WithTimeout(context.Background(), time.Second)
			defer stopCancel()
			_ = state.displayTaps.Close(stopCtx)
		}
		for _, s := range state.subscriptions {
			_ = s.Close(context.Background())
		}
	})

	binDir := t.TempDir()
	newRuntime := func(cfg capsule.Config, clock cli.Clock) (*capsule.Manager, error) {
		cfg.BinDir = binDir
		cfg.LivenessInterval = time.Hour
		return capsule.NewManager(cfg, runner, clock)
	}
	authority := &clientAuthority{origin: monotonic()}
	if err := state.accept(sessionCtx, profiles, map[string]*frames.Publisher{root: pub}, authority, monotonic, newRuntime, frames.NewSubscriptions); err != nil {
		t.Fatalf("accept failed: %v", err)
	}

	createCapsule := func(profileID string) string {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{
			"schema": "surface_request/v0.2",
			"op":     "create",
			"params": map[string]any{"kind": "browser", "profile_id": profileID, "geometry": map[string]int{"w": 2, "h": 1}},
		})
		evs, err := state.handler(sessionCtx, ipc.Envelope{MsgID: "create-" + profileID, Body: raw})
		if err != nil || len(evs) == 0 {
			t.Fatalf("create %s failed: %s (%v)", profileID, evs, err)
		}
		var created struct {
			Event string `json:"event"`
			Data  struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(evs[0], &created); err != nil || created.Event != "created" {
			t.Fatalf("unexpected create reply for %s: %s (%v)", profileID, evs[0], err)
		}
		return created.Data.Surface.SurfaceID
	}

	id1 := createCapsule("mv-live-1")
	id2 := createCapsule("mv-live-2")
	if id1 == id2 {
		t.Fatalf("expected distinct surface IDs, got %q", id1)
	}

	waitTargets := func(c1Count, c2Count int) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			targetMu.Lock()
			n1 := len(seenTargets["srf-id-mv-live-1"])
			n2 := len(seenTargets["srf-id-mv-live-2"])
			targetMu.Unlock()
			if n1 >= c1Count && n2 >= c2Count {
				return
			}
			select {
			case <-targetReady:
			case <-time.After(10 * time.Millisecond):
			}
		}
		t.Fatalf("timed out waiting for display tap targets (want >=%d, >=%d)", c1Count, c2Count)
	}
	waitTargets(1, 1)

	targetMu.Lock()
	t1 := seenTargets["srf-id-mv-live-1"][0]
	t2 := seenTargets["srf-id-mv-live-2"][0]
	targetMu.Unlock()
	if t1.Display != ":100" {
		t.Fatalf("mv-live-1 tap display = %q, want :100", t1.Display)
	}
	if t2.Display != ":101" {
		t.Fatalf("mv-live-2 tap display = %q, want :101", t2.Display)
	}

	// Destroy and restart mv-live-2; verify a new tap starts with :101 and the new run/XID.
	destroyRaw, _ := json.Marshal(map[string]any{
		"schema": "surface_request/v0.2",
		"op":     "destroy",
		"params": map[string]any{"surface_id": id2},
	})
	if evs, err := state.handler(sessionCtx, ipc.Envelope{MsgID: "destroy-2", Body: destroyRaw}); err != nil || len(evs) == 0 {
		t.Fatalf("destroy mv-live-2 failed: %s (%v)", evs, err)
	}
	targetMu.Lock()
	beforeRestartCount := len(seenTargets["srf-id-mv-live-2"])
	targetMu.Unlock()

	_ = createCapsule("mv-live-2")
	waitTargets(1, beforeRestartCount+1)
	targetMu.Lock()
	restarted := seenTargets["srf-id-mv-live-2"][len(seenTargets["srf-id-mv-live-2"])-1]
	targetMu.Unlock()
	if restarted.Display != ":101" || restarted.Run == t2.Run || restarted.XID == t2.XID {
		t.Fatalf("restarted mv-live-2 target = %+v, previous = %+v", restarted, t2)
	}
}
