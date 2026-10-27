package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

func writeTestPNG(t *testing.T, root string) (string, string) {
	t.Helper()
	source := filepath.Join(root, "demo-run", "frames", "w1")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(source, "f.png")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	img.Set(1, 0, color.NRGBA{G: 255, A: 255})
	if err := png.Encode(f, img); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte{255, 0, 0, 0, 255, 0})
	return path, fmt.Sprintf("%x", sum)
}

// T2-R2-03: cleanup must destroy active native bindings on shutdown; zero-surface cleanup is a no-op.
func TestT2R203ShutdownCleanupDestroysActiveSurfaces(t *testing.T) {
	for _, withSurface := range []bool{true, false} {
		name := "active-surface"
		if !withSurface {
			name = "zero-surfaces"
		}
		t.Run(name, func(t *testing.T) {
			nvEnvironment(t)
			bin := os.Getenv("MV_SRF_BIN_DIR")
			stopLog := filepath.Join(t.TempDir(), "stops.log")
			cliPath := filepath.Join(bin, "srf-identity-surface")
			orig, err := os.ReadFile(cliPath)
			if err != nil {
				t.Fatal(err)
			}
			instrumented := strings.Replace(
				string(orig),
				"elif op=='stop':\n",
				fmt.Sprintf("elif op=='stop':\n open(%q,'a').write(' '.join(sys.argv[1:])+'\\n')\n", stopLog),
				1,
			)
			if err := os.WriteFile(cliPath, []byte(instrumented), 0700); err != nil {
				t.Fatal(err)
			}
			r, err := RuntimeFromEnv()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx = context.WithValue(ctx, streamKey{}, streamSession{
				ctx:  ctx,
				work: &sync.Mutex{},
				emit: func(context.Context, json.RawMessage) error { return nil },
			})
			if _, err := r.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"hello/v0.2"}`)}); err != nil {
				r.Close()
				t.Fatal(err)
			}
			if withSurface {
				create := ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}}`)}
				out, err := r.Handler(ctx, create)
				if err != nil || len(out) != 2 {
					r.Close()
					t.Fatalf("create: %s %v", out, err)
				}
			}
			r.Close()
			data, err := os.ReadFile(stopLog)
			if withSurface {
				if err != nil || !strings.Contains(string(data), "stop --container srf-id-demo") {
					t.Fatalf("cleanup did not stop active native surface: log=%q err=%v", string(data), err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatalf("zero-surface cleanup invoked stop: %q", string(data))
			}
		})
	}
}

type r204Runner struct {
	pngPath, sha string
	inputEntered chan struct{}
	finishInput  chan struct{}
	seq          atomic.Uint64
	stopped      atomic.Bool
	framesAfter  atomic.Int32
}

func (r *r204Runner) Run(ctx context.Context, args []string, _ []byte) ([]byte, error) {
	switch args[1] {
	case "start":
		return []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1}]}`), nil
	case "frame":
		if r.stopped.Load() {
			r.framesAfter.Add(1)
		}
		seq := r.seq.Add(1)
		b, _ := json.Marshal(map[string]any{
			"path":            r.pngPath,
			"seq":             seq,
			"sha256_rgb24":    r.sha,
			"width":           2,
			"height":          1,
			"capture_mono_ns": 200,
			"generation":      "srf-id-demo",
			"window":          map[string]any{"id": "w1", "w": 2, "h": 1},
		})
		return b, nil
	case "input":
		close(r.inputEntered)
		select {
		case <-r.finishInput:
			return []byte(`{"surface_id":"w1","kind":"key","focus_verified":true,"result":"ok","input_mono_ns":200}`), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	case "stop":
		r.stopped.Store(true)
		return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
	}
	return nil, context.Canceled
}

// T2-R2-04: refused destroy while input is pending must keep the subscription alive;
// negative control: idle destroy still drains subscriptions before native stop.
func TestT2R204DestroyRefusedWhilePendingKeepsSubscription(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-r204-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	pngPath, sha := writeTestPNG(t, root)
	runner := &r204Runner{
		pngPath:      pngPath,
		sha:          sha,
		inputEntered: make(chan struct{}),
		finishInput:  make(chan struct{}),
	}
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	pubs := map[string]*frames.Publisher{root: pub}
	authority, err := newClientAuthority(filepath.Join(t.TempDir(), "replay"), 100)
	if err != nil {
		t.Fatal(err)
	}
	defer authority.file.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	emitted := make(chan json.RawMessage, 32)
	sessionCtx := context.WithValue(ctx, streamKey{}, streamSession{
		ctx:  ctx,
		work: &sync.Mutex{},
		emit: func(c context.Context, b json.RawMessage) error {
			select {
			case emitted <- b:
				return nil
			case <-c.Done():
				return c.Err()
			}
		},
	})
	var state helloState
	err = state.accept(
		sessionCtx,
		profiles,
		pubs,
		authority,
		func() uint64 { return 200 },
		func(cfg capsule.Config, clock cli.Clock) (*capsule.Manager, error) {
			cfg.BinDir = t.TempDir()
			return capsule.NewManager(cfg, runner, clock)
		},
		func(c context.Context, cfg frames.SubscriptionConfig, src frames.Source, p *frames.Publisher, emit frames.Emit) (*frames.Subscriptions, error) {
			cfg.PollInterval = 15 * time.Millisecond
			return frames.NewSubscriptions(c, cfg, src, p, emit)
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, s := range state.subscriptions {
			_ = s.Close(context.Background())
		}
	}()

	call := func(op string, params any) []json.RawMessage {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		out, err := state.handler(sessionCtx, ipc.Envelope{MsgID: op, Body: raw})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}

	created := call("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
	var ev struct {
		Event string
		Data  struct {
			Surface capsule.Surface `json:"surface"`
			Detail  string          `json:"detail"`
		}
	}
	if len(created) != 2 || json.Unmarshal(created[0], &ev) != nil || ev.Event != "created" {
		t.Fatalf("create: %s", created)
	}
	id := ev.Data.Surface.SurfaceID

	if out := call("frame_subscribe", map[string]string{"surface_id": id}); len(out) != 0 {
		t.Fatalf("subscribe: %s", out)
	}
	select {
	case <-emitted:
	case <-time.After(time.Second):
		t.Fatal("initial subscribed frame not delivered")
	}

	inputDone := make(chan []json.RawMessage, 1)
	go func() {
		inputDone <- call("input", map[string]any{"surface_id": id, "proposal_id": "p-1", "action": map[string]any{"type": "key", "keys": []string{"a"}}})
	}()
	select {
	case <-runner.inputEntered:
	case <-time.After(time.Second):
		t.Fatal("input did not start")
	}

	refused := call("destroy", map[string]string{"surface_id": id})
	if len(refused) != 1 || json.Unmarshal(refused[0], &ev) != nil || ev.Event != "error" || !strings.Contains(ev.Data.Detail, "POLICY") {
		t.Fatalf("expected POLICY refusal on destroy during pending input, got %s", refused)
	}

	close(runner.finishInput)
	select {
	case out := <-inputDone:
		if len(out) != 3 {
			t.Fatalf("expected settled input events, got %s", out)
		}
	case <-time.After(time.Second):
		t.Fatal("input did not finish")
	}

	for len(emitted) > 0 {
		<-emitted
	}
	select {
	case msg := <-emitted:
		if !strings.Contains(string(msg), `"frame_ready"`) {
			t.Fatalf("unexpected subscription message: %s", msg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("subscription stopped delivering after refused destroy")
	}

	// Negative control: destroy with no pending input drains subscriptions before native stop.
	destroyed := call("destroy", map[string]string{"surface_id": id})
	if len(destroyed) != 1 || json.Unmarshal(destroyed[0], &ev) != nil || ev.Event != "state_changed" || ev.Data.Surface.State != "destroyed" {
		t.Fatalf("idle destroy failed: %s", destroyed)
	}
	if !runner.stopped.Load() || runner.framesAfter.Load() != 0 {
		t.Fatalf("subscription was not drained before native stop: stopped=%v framesAfter=%d", runner.stopped.Load(), runner.framesAfter.Load())
	}
}

// T2-R2-06: Release failure after verified destroy must be retryable via a second destroy;
// negative control: a further destroy after successful Release is still refused.
func TestT2R206DestroyRetryRecoversFailedRelease(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-r206-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	pngPath, sha := writeTestPNG(t, root)
	runner := &r204Runner{pngPath: pngPath, sha: sha}
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
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
		raw, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		out, err := h(context.Background(), ipc.Envelope{MsgID: op, Body: raw})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}

	created := call("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
	if len(created) != 2 {
		t.Fatalf("create: %s", created)
	}
	var surfaceEv struct {
		Event string
		Data  struct {
			Surface capsule.Surface `json:"surface"`
			Detail  string          `json:"detail"`
		}
	}
	var readyEv struct {
		Data struct {
			FrameRef frames.Ref `json:"frame_ref"`
		}
	}
	_ = json.Unmarshal(created[0], &surfaceEv)
	_ = json.Unmarshal(created[1], &readyEv)
	id := surfaceEv.Data.Surface.SurfaceID
	leasePath := readyEv.Data.FrameRef.RAMWSPath

	// Obstruct unlinkat(0) in Publisher.Release by replacing the file with a directory.
	if err := os.Remove(leasePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(leasePath, 0700); err != nil {
		t.Fatal(err)
	}

	first := call("destroy", map[string]string{"surface_id": id})
	if len(first) != 1 || json.Unmarshal(first[0], &surfaceEv) != nil || surfaceEv.Event != "error" {
		t.Fatalf("expected first destroy to report Release failure, got %s", first)
	}

	// Repair the obstruction so retry of Release succeeds.
	if err := os.Remove(leasePath); err != nil {
		t.Fatal(err)
	}

	second := call("destroy", map[string]string{"surface_id": id})
	if len(second) != 1 || json.Unmarshal(second[0], &surfaceEv) != nil || surfaceEv.Event != "state_changed" || surfaceEv.Data.Surface.State != "destroyed" {
		t.Fatalf("second destroy did not recover terminal release: %s", second)
	}

	// Negative control: third destroy of the fully-released surface is refused.
	third := call("destroy", map[string]string{"surface_id": id})
	if len(third) != 1 || json.Unmarshal(third[0], &surfaceEv) != nil || surfaceEv.Event != "error" || !strings.Contains(surfaceEv.Data.Detail, "unknown or terminal surface") {
		t.Fatalf("third destroy of released surface was not refused: %s", third)
	}

	// Capacity on both Manager and Publisher (MaxSurfaces=1) must be reusable.
	recreated := call("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
	if len(recreated) != 2 || json.Unmarshal(recreated[0], &surfaceEv) != nil || surfaceEv.Event != "created" {
		t.Fatalf("capacity not reusable after recovered destroy: %s", recreated)
	}
}

type r202StreamRunner struct {
	pngPath, sha string
	inputStarted chan struct{}
	createDelay  time.Duration
	blockInput   bool
	seq          atomic.Uint64
}

func (r *r202StreamRunner) Run(ctx context.Context, args []string, _ []byte) ([]byte, error) {
	switch args[1] {
	case "start":
		if r.createDelay > 0 {
			time.Sleep(r.createDelay)
		}
		return []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1}]}`), nil
	case "frame":
		seq := r.seq.Add(1)
		b, _ := json.Marshal(map[string]any{
			"path":            r.pngPath,
			"seq":             seq,
			"sha256_rgb24":    r.sha,
			"width":           2,
			"height":          1,
			"capture_mono_ns": 200 + seq,
			"generation":      "srf-id-demo",
			"window":          map[string]any{"id": "w1", "w": 2, "h": 1},
		})
		return b, nil
	case "input":
		if r.blockInput {
			close(r.inputStarted)
			<-ctx.Done()
			return nil, ctx.Err()
		}
		seq := r.seq.Add(1)
		return []byte(fmt.Sprintf(`{"surface_id":"w1","kind":"key","focus_verified":true,"result":"ok","input_mono_ns":%d}`, 200+seq)), nil
	case "stop":
		return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
	}
	return nil, context.Canceled
}

// T2-R2-02: connectStreaming must dispatch take_control concurrently with a blocked input;
// negative control: pipelined data-plane ops preserve request order.
func TestT2R202StreamTakeoverCancelsBlockedInput(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-r202-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	pngPath, sha := writeTestPNG(t, root)
	runner := &r202StreamRunner{pngPath: pngPath, sha: sha, inputStarted: make(chan struct{}), blockInput: true}
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: 30 * time.Second, OriginNS: 100}, runner, func() uint64 { return 200 + runner.seq.Load() })
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	handler := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, 100)

	sockDir := t.TempDir()
	if err := os.Chmod(sockDir, 0700); err != nil {
		t.Fatal(err)
	}
	sockPath := filepath.Join(sockDir, "core.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	cfg := ipc.Config{SocketPath: sockPath, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128, MaxConnections: 1, HelloTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 2 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	reg := ipc.Envelope{
		Schema:    "envelope/v0.2",
		MsgID:     "reg",
		From:      ipc.Endpoint{Component: "core", Instance: "core-1"},
		To:        ipc.Endpoint{Component: "daemon", Instance: "daemon-1"},
		SessionID: "s-1",
		Seq:       1,
		Nonce:     "n-1",
		Body:      json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	streamDone := make(chan error, 1)
	go func() {
		streamDone <- connectStreaming(ctx, cfg, &lifecyclePolicy{}, reg, func(c context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
			var h struct{ Schema string }
			_ = json.Unmarshal(e.Body, &h)
			if h.Schema == "hello/v0.2" {
				return nil, nil
			}
			return handler(c, e)
		})
	}()

	conn, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	framer, err := ipc.NewFramer(conn, cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Read daemon hello.
	if _, err := framer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	var seq uint64
	send := func(op string, params any) {
		t.Helper()
		seq++
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		env, _ := json.Marshal(ipc.Envelope{
			Schema:    "envelope/v0.2",
			MsgID:     fmt.Sprintf("m-%d", seq),
			From:      reg.From,
			To:        reg.To,
			SessionID: reg.SessionID,
			Seq:       seq,
			Nonce:     fmt.Sprintf("n-%d", seq),
			Body:      body,
		})
		if err := framer.Write(ctx, env); err != nil {
			t.Fatal(err)
		}
	}
	readBody := func(timeout time.Duration) json.RawMessage {
		t.Helper()
		rctx, rcancel := context.WithTimeout(ctx, timeout)
		defer rcancel()
		raw, err := framer.Read(rctx)
		if err != nil {
			t.Fatalf("read failed within %v: %v", timeout, err)
		}
		var env ipc.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		return env.Body
	}

	send("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
	var created struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		}
	}
	if err := json.Unmarshal(readBody(2*time.Second), &created); err != nil {
		t.Fatal(err)
	}
	_ = readBody(2 * time.Second) // initial frame_ready
	id := created.Data.Surface.SurfaceID

	send("input", map[string]any{"surface_id": id, "proposal_id": "prop-1", "action": map[string]any{"type": "key", "keys": []string{"a"}}})
	select {
	case <-runner.inputStarted:
	case <-time.After(time.Second):
		t.Fatal("input never entered native runner")
	}

	send("take_control", map[string]any{"surface_id": id, "owner": "human"})

	var gotTakeover, gotCancelledReceipt bool
	for range 2 {
		body := readBody(2 * time.Second)
		var msg struct {
			Schema, Event, Error string
			Data                 struct {
				Surface capsule.Surface `json:"surface"`
			}
		}
		if err := json.Unmarshal(body, &msg); err != nil {
			t.Fatal(err)
		}
		if msg.Schema == "surface_event/v0.2" && msg.Event == "state_changed" && msg.Data.Surface.Control == "human" {
			gotTakeover = true
		}
		if msg.Schema == "action_receipt/v0.2" && strings.Contains(msg.Error, "SURFACE_NOT_AGENT_CONTROLLED") {
			gotCancelledReceipt = true
		}
	}
	if !gotTakeover || !gotCancelledReceipt {
		t.Fatalf("missing takeover or cancelled input settlement: takeover=%v receipt=%v", gotTakeover, gotCancelledReceipt)
	}

	// Negative control: pipelined data-plane ops preserve request order.
	orderSock := filepath.Join(sockDir, "order.sock")
	orderListener, err := net.ListenUnix("unix", &net.UnixAddr{Name: orderSock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer orderListener.Close()
	orderCfg := cfg
	orderCfg.SocketPath = orderSock

	orderCtx, orderCancel := context.WithCancel(context.Background())
	defer orderCancel()
	go func() {
		_ = connectStreaming(orderCtx, orderCfg, &lifecyclePolicy{}, reg, func(_ context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
			var req struct {
				Schema, Op string
			}
			_ = json.Unmarshal(e.Body, &req)
			if req.Schema == "hello/v0.2" {
				return nil, nil
			}
			if req.Op == "create" {
				time.Sleep(40 * time.Millisecond)
			}
			out, _ := json.Marshal(map[string]string{"op": req.Op})
			return []json.RawMessage{out}, nil
		})
	}()
	orderConn, err := orderListener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer orderConn.Close()
	orderFramer, err := ipc.NewFramer(orderConn, orderCfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := orderFramer.Read(orderCtx); err != nil {
		t.Fatal(err)
	}
	for i, op := range []string{"create", "input"} {
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": map[string]any{}})
		env, _ := json.Marshal(ipc.Envelope{
			Schema: "envelope/v0.2", MsgID: op, From: reg.From, To: reg.To, SessionID: reg.SessionID,
			Seq: uint64(i + 1), Nonce: op, Body: body,
		})
		if err := orderFramer.Write(orderCtx, env); err != nil {
			t.Fatal(err)
		}
	}
	var observed []string
	for range 2 {
		raw, err := orderFramer.Read(orderCtx)
		if err != nil {
			t.Fatal(err)
		}
		var env ipc.Envelope
		_ = json.Unmarshal(raw, &env)
		var res struct{ Op string }
		_ = json.Unmarshal(env.Body, &res)
		observed = append(observed, res.Op)
	}
	if len(observed) != 2 || observed[0] != "create" || observed[1] != "input" {
		t.Fatalf("data-plane order violated: %v", observed)
	}
	cancel()
	select {
	case err := <-streamDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("connectStreaming did not join")
	}
}

// RV7-ADAPTER-LANES: connectStreaming must order data requests queued after
// take_control/release_control behind control completion, drain queued lanes on
// EOF before cancelling the session, and return sessionErr on read-loop exits.
func TestStreamControlSequenceGateDrainingAndSessionErr(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-rv7lanes-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	pngPath, sha := writeTestPNG(t, root)
	runner := &r202StreamRunner{pngPath: pngPath, sha: sha, inputStarted: make(chan struct{})}
	profiles := map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 1, MaxOutputBytes: 8192, Timeout: 30 * time.Second, OriginNS: 100}, runner, func() uint64 { return 200 + runner.seq.Load() })
	if err != nil {
		t.Fatal(err)
	}
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 2, MaxSurfaces: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	handler := wireHandler(m, profiles, map[string]*frames.Publisher{root: pub}, 100)

	sockDir := t.TempDir()
	if err := os.Chmod(sockDir, 0700); err != nil {
		t.Fatal(err)
	}
	sockPath := filepath.Join(sockDir, "gate.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	cfg := ipc.Config{SocketPath: sockPath, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128, MaxConnections: 1, HelloTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 2 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	reg := ipc.Envelope{
		Schema:    "envelope/v0.2",
		MsgID:     "reg",
		From:      ipc.Endpoint{Component: "core", Instance: "core-1"},
		To:        ipc.Endpoint{Component: "daemon", Instance: "daemon-1"},
		SessionID: "s-1",
		Seq:       1,
		Nonce:     "n-1",
		Body:      json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	streamDone := make(chan error, 1)
	go func() {
		streamDone <- connectStreaming(ctx, cfg, &lifecyclePolicy{}, reg, func(c context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
			var h struct {
				Schema, Op string
			}
			_ = json.Unmarshal(e.Body, &h)
			if h.Schema == "hello/v0.2" {
				return nil, nil
			}
			if h.Op == "take_control" || h.Op == "release_control" {
				// Delay control handler to force any un-gated data worker to race ahead.
				time.Sleep(35 * time.Millisecond)
			}
			return handler(c, e)
		})
	}()

	conn, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	framer, err := ipc.NewFramer(conn, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := framer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	var seq uint64
	send := func(op string, params any) {
		t.Helper()
		seq++
		body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		env, _ := json.Marshal(ipc.Envelope{
			Schema:    "envelope/v0.2",
			MsgID:     fmt.Sprintf("m-%d", seq),
			From:      reg.From,
			To:        reg.To,
			SessionID: reg.SessionID,
			Seq:       seq,
			Nonce:     fmt.Sprintf("n-%d", seq),
			Body:      body,
		})
		if err := framer.Write(ctx, env); err != nil {
			t.Fatal(err)
		}
	}
	readBody := func(timeout time.Duration) json.RawMessage {
		t.Helper()
		rctx, rcancel := context.WithTimeout(ctx, timeout)
		defer rcancel()
		raw, err := framer.Read(rctx)
		if err != nil {
			t.Fatalf("read failed within %v: %v", timeout, err)
		}
		var env ipc.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		return env.Body
	}

	send("create", map[string]any{"kind": "browser", "profile_id": "demo", "geometry": map[string]int{"w": 2, "h": 1}})
	var created struct {
		Data struct {
			Surface capsule.Surface `json:"surface"`
		}
	}
	if err := json.Unmarshal(readBody(2*time.Second), &created); err != nil {
		t.Fatal(err)
	}
	_ = readBody(2 * time.Second) // initial frame_ready
	id := created.Data.Surface.SurfaceID

	// Pipelined take_control followed immediately by input and EOF:
	// input MUST wait for take_control (so it is refused with SURFACE_NOT_AGENT_CONTROLLED),
	// and both queued requests MUST drain before cancelSession on EOF.
	send("take_control", map[string]any{"surface_id": id, "owner": "human"})
	send("input", map[string]any{"surface_id": id, "proposal_id": "prop-after-tc", "action": map[string]any{"type": "key", "keys": []string{"a"}}})
	_ = conn.CloseWrite()

	body1 := readBody(2 * time.Second)
	body2 := readBody(2 * time.Second)
	var ev1, ev2 struct {
		Schema, Event, Error string
		Data                 struct {
			Surface capsule.Surface `json:"surface"`
		}
	}
	_ = json.Unmarshal(body1, &ev1)
	_ = json.Unmarshal(body2, &ev2)
	if ev1.Schema != "surface_event/v0.2" || ev1.Event != "state_changed" || ev1.Data.Surface.Control != "human" {
		t.Fatalf("expected take_control reply first, got %s", body1)
	}
	if ev2.Schema != "action_receipt/v0.2" || !strings.Contains(ev2.Error, "SURFACE_NOT_AGENT_CONTROLLED") {
		t.Fatalf("expected input queued after take_control to be refused as human-controlled, got %s", body2)
	}

	select {
	case err := <-streamDone:
		if err == nil {
			t.Fatal("expected EOF error from connectStreaming")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("connectStreaming did not exit after EOF drain")
	}

	// Verify sessionErr is returned when a read-loop validation/auth failure races with worker failure.
	errSock := filepath.Join(sockDir, "err.sock")
	errListener, err := net.ListenUnix("unix", &net.UnixAddr{Name: errSock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer errListener.Close()
	errCfg := cfg
	errCfg.SocketPath = errSock

	workerEntered := make(chan struct{})
	errDone := make(chan error, 1)
	go func() {
		errDone <- connectStreaming(ctx, errCfg, &lifecyclePolicy{}, reg, func(c context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
			var h struct{ Schema string }
			_ = json.Unmarshal(e.Body, &h)
			if h.Schema == "hello/v0.2" {
				return nil, nil
			}
			close(workerEntered)
			return nil, fmt.Errorf("stream worker Boom")
		})
	}()

	errConn, err := errListener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer errConn.Close()
	errFramer, err := ipc.NewFramer(errConn, errCfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := errFramer.Read(ctx); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": "list", "params": map[string]any{}})
	rawEnv, _ := json.Marshal(ipc.Envelope{
		Schema: "envelope/v0.2", MsgID: "m-1", From: reg.From, To: reg.To, SessionID: reg.SessionID,
		Seq: 1, Nonce: "n-1", Body: body,
	})
	if err := errFramer.Write(ctx, rawEnv); err != nil {
		t.Fatal(err)
	}
	<-workerEntered
	_ = errFramer.Write(ctx, []byte(`{"malformed`))

	select {
	case gotErr := <-errDone:
		if gotErr == nil || fmt.Sprint(gotErr) != "dispatch: stream worker Boom" {
			t.Fatalf("expected sessionErr 'dispatch: stream worker Boom', got %v", gotErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("connectStreaming did not join on worker failure")
	}
}

type rv8StreamPolicy struct {
	lifecyclePolicy
}

func (p *rv8StreamPolicy) Authenticate(ctx context.Context, cred ipc.PeerCredentials, in ipc.Envelope) error {
	if in.MsgID == "bad-auth" {
		return fmt.Errorf("authentication refused")
	}
	return p.lifecyclePolicy.Authenticate(ctx, cred, in)
}

// RV8-ADAPTER (P1): validation/route/schema/auth failure branches in connectStreaming
// must call fail(err) before exitLoop(err) so the session context cancels in-flight
// handlers immediately, queued envelopes do not drain, and the caller receives the
// typed error within <2s. Negative control: all-valid frames dispatch R1+R2.
func TestRV8StreamFailureCancelsInFlightWorkersBeforeDrain(t *testing.T) {
	for _, tc := range []string{"validate", "body-unmarshal", "route", "schema", "auth", "all-valid"} {
		t.Run(tc, func(t *testing.T) {
			sockDir := t.TempDir()
			if err := os.Chmod(sockDir, 0700); err != nil {
				t.Fatal(err)
			}
			sockPath := filepath.Join(sockDir, "rv8.sock")
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()

			cfg := ipc.Config{SocketPath: sockPath, UID: uint32(os.Getuid()), MaxFrameBytes: 8192, MaxDepth: 32, MaxStringBytes: 4096, MaxKeys: 128, MaxArrayItems: 128, MaxReplayEntries: 128, MaxConnections: 1, HelloTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 2 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
			reg := ipc.Envelope{
				Schema:    "envelope/v0.2",
				MsgID:     "reg",
				From:      ipc.Endpoint{Component: "core", Instance: "core-1"},
				To:        ipc.Endpoint{Component: "daemon", Instance: "daemon-1"},
				SessionID: "s-1",
				Seq:       1,
				Nonce:     "n-1",
				Body:      json.RawMessage(`{"schema":"hello/v0.2","component":"daemon"}`),
			}

			r1Entered := make(chan struct{})
			r1Release := make(chan struct{})
			var r1SawCancel, r2Dispatched bool
			var mu sync.Mutex

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- connectStreaming(ctx, cfg, &rv8StreamPolicy{}, reg, func(c context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
					var body struct {
						Schema, Op string
					}
					_ = json.Unmarshal(e.Body, &body)
					if body.Schema == "hello/v0.2" {
						return nil, nil
					}
					switch e.MsgID {
					case "r1":
						close(r1Entered)
						select {
						case <-c.Done():
							mu.Lock()
							r1SawCancel = true
							mu.Unlock()
							return nil, c.Err()
						case <-r1Release:
						case <-time.After(2200 * time.Millisecond):
						}
					case "r2":
						mu.Lock()
						r2Dispatched = true
						mu.Unlock()
					}
					reply, _ := json.Marshal(map[string]string{"id": e.MsgID, "op": body.Op})
					return []json.RawMessage{reply}, nil
				})
			}()

			conn, err := listener.AcceptUnix()
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			framer, err := ipc.NewFramer(conn, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := framer.Read(ctx); err != nil {
				t.Fatal(err)
			}

			sendEnv := func(env ipc.Envelope) {
				t.Helper()
				raw, _ := json.Marshal(env)
				if err := framer.Write(ctx, raw); err != nil {
					t.Fatal(err)
				}
			}
			reqBody := json.RawMessage(`{"schema":"surface_request/v0.2","op":"input"}`)
			sendEnv(ipc.Envelope{
				Schema: "envelope/v0.2", MsgID: "r1", From: reg.From, To: reg.To, SessionID: reg.SessionID,
				Seq: 1, Nonce: "n-1", Body: reqBody,
			})
			select {
			case <-r1Entered:
			case <-time.After(time.Second):
				t.Fatal("r1 did not enter handler")
			}
			sendEnv(ipc.Envelope{
				Schema: "envelope/v0.2", MsgID: "r2", From: reg.From, To: reg.To, SessionID: reg.SessionID,
				Seq: 2, Nonce: "n-2", Body: reqBody,
			})

			if tc == "all-valid" {
				close(r1Release)
				_ = conn.CloseWrite()
				for _, wantID := range []string{"r1", "r2"} {
					rctx, rcancel := context.WithTimeout(ctx, 2*time.Second)
					raw, err := framer.Read(rctx)
					rcancel()
					if err != nil {
						t.Fatalf("expected reply %s, got %v", wantID, err)
					}
					var out ipc.Envelope
					if err := json.Unmarshal(raw, &out); err != nil {
						t.Fatal(err)
					}
					var msg struct{ ID string }
					if err := json.Unmarshal(out.Body, &msg); err != nil || msg.ID != wantID {
						t.Fatalf("got reply %s, want %s", out.Body, wantID)
					}
				}
				select {
				case <-done:
				case <-time.After(2 * time.Second):
					t.Fatal("connectStreaming did not exit after clean EOF")
				}
				mu.Lock()
				gotR2 := r2Dispatched
				mu.Unlock()
				if !gotR2 {
					t.Fatal("negative control failed: r2 was not dispatched")
				}
				return
			}

			start := time.Now()
			switch tc {
			case "validate":
				if err := framer.Write(ctx, []byte(`[]`)); err != nil {
					t.Fatal(err)
				}
			case "body-unmarshal":
				sendEnv(ipc.Envelope{
					Schema: "envelope/v0.2", MsgID: "bad-body", From: reg.From, To: reg.To, SessionID: reg.SessionID,
					Seq: 3, Nonce: "n-3", Body: json.RawMessage(`[]`),
				})
			case "route":
				sendEnv(ipc.Envelope{
					Schema: "envelope/v0.2", MsgID: "bad-route", From: ipc.Endpoint{Component: "agents", Instance: "a-1"}, To: reg.To, SessionID: reg.SessionID,
					Seq: 3, Nonce: "n-3", Body: reqBody,
				})
			case "schema":
				sendEnv(ipc.Envelope{
					Schema: "envelope/v0.2", MsgID: "bad-schema", From: reg.From, To: reg.To, SessionID: reg.SessionID,
					Seq: 3, Nonce: "n-3", Body: json.RawMessage(`{"schema":"unknown/v0.2"}`),
				})
			case "auth":
				sendEnv(ipc.Envelope{
					Schema: "envelope/v0.2", MsgID: "bad-auth", From: reg.From, To: reg.To, SessionID: reg.SessionID,
					Seq: 3, Nonce: "n-3", Body: reqBody,
				})
			}

			var gotErr error
			select {
			case gotErr = <-done:
			case <-time.After(2 * time.Second):
				t.Fatalf("connectStreaming did not abort in <2s on %s failure", tc)
			}
			elapsed := time.Since(start)
			if elapsed >= 2*time.Second {
				t.Fatalf("connectStreaming took %v (>= 2s) on %s failure", elapsed, tc)
			}
			if gotErr == nil {
				t.Fatalf("expected non-nil error for %s, got nil", tc)
			}
			mu.Lock()
			cancelled := r1SawCancel
			dispatchedR2 := r2Dispatched
			mu.Unlock()
			if !cancelled {
				t.Fatalf("r1 did not observe session cancellation on %s failure", tc)
			}
			if dispatchedR2 {
				t.Fatalf("r2 was dispatched after %s failure", tc)
			}
		})
	}
}
