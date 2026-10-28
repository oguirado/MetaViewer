package frames

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

func ac02RAMRoot(t *testing.T) string {
	t.Helper()
	root, _, _ := ramFixture(t)
	return root
}

func generatePNGFixtureInTempDir(t *testing.T, width, height int, seed byte) (fixturePath string, pngBytes []byte, shaHex string) {
	t.Helper()
	fixtureDir := t.TempDir()
	fixturePath = filepath.Join(fixtureDir, fmt.Sprintf("fixture-%dx%d-%d.png", width, height, seed))

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	raw := make([]byte, width*height*3)
	n := 0
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			r := byte(((x / 16) + int(seed)*17) & 0xff)
			g := byte(((y / 16) + int(seed)*31) & 0xff)
			b := byte((((x / 16) ^ (y / 16)) + int(seed)*47) & 0xff)
			off := y*img.Stride + x*4
			img.Pix[off] = r
			img.Pix[off+1] = g
			img.Pix[off+2] = b
			img.Pix[off+3] = 0xff
			raw[n] = r
			raw[n+1] = g
			raw[n+2] = b
			n += 3
		}
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	pngBytes = buf.Bytes()
	if err := os.WriteFile(fixturePath, pngBytes, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	shaHex = fmt.Sprintf("%x", sum)
	return fixturePath, pngBytes, shaHex
}

type ac02StubSurface struct {
	mu      sync.Mutex
	binding capsule.Binding
	frames  [2]capsule.NativeFrame
	polls   atomic.Uint64
}

type ac02StubSource struct {
	cost     time.Duration
	surfaces map[string]*ac02StubSurface
}

func (s *ac02StubSource) Capture(ctx context.Context, id string) (capsule.Binding, capsule.NativeFrame, error) {
	surf, ok := s.surfaces[id]
	if !ok {
		return capsule.Binding{}, capsule.NativeFrame{}, fmt.Errorf("unknown surface %s", id)
	}
	if s.cost > 0 {
		timer := time.NewTimer(s.cost)
		select {
		case <-ctx.Done():
			timer.Stop()
			return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
		case <-timer.C:
		}
	}
	seq := surf.polls.Add(1)
	surf.mu.Lock()
	defer surf.mu.Unlock()
	f := surf.frames[seq%2]
	f.Seq = seq
	f.TSNS = seq * 100_000_000
	f.CaptureMonoNS = f.TSNS
	f.CaptureUS = uint64(s.cost / time.Microsecond)
	return surf.binding, f, nil
}

func TestAC02FourSurfaceCadenceAndDiagnostics(t *testing.T) {
	root := ac02RAMRoot(t)
	pub, err := NewPublisher(PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   64 << 20,
		MaxPixels:       64 << 20,
		MaxSurfaces:     16,
		MaxRetained:     64,
		MinRetention:    4 * time.Second,
		MaxSurfaceBytes: 128 << 20,
		MaxTotalBytes:   512 << 20,
		Deduplicate:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	surfaceIDs := []string{"srf-a", "srf-b", "srf-c", "srf-d"}
	stub := &ac02StubSource{
		cost:     20 * time.Millisecond,
		surfaces: make(map[string]*ac02StubSurface, len(surfaceIDs)),
	}

	for i, id := range surfaceIDs {
		srcDir := filepath.Join(root, "source-"+id)
		if err := os.Mkdir(srcDir, 0700); err != nil {
			t.Fatal(err)
		}
		_, png0, sha0 := generatePNGFixtureInTempDir(t, 64, 64, byte(i*2+1))
		_, png1, sha1 := generatePNGFixtureInTempDir(t, 64, 64, byte(i*2+2))
		p0 := filepath.Join(srcDir, "f0.png")
		p1 := filepath.Join(srcDir, "f1.png")
		if err := os.WriteFile(p0, png0, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p1, png1, 0600); err != nil {
			t.Fatal(err)
		}
		container := fmt.Sprintf("srf-id-ac02-%d", i)
		win := fmt.Sprintf("w%d", i+1)
		binding := capsule.Binding{
			Surface: capsule.Surface{
				SurfaceID: id,
				Geometry:  capsule.Geometry{W: 64, H: 64},
			},
			Container:  container,
			FramesRoot: srcDir,
			Window:     win,
		}
		stub.surfaces[id] = &ac02StubSurface{
			binding: binding,
			frames: [2]capsule.NativeFrame{
				{
					Path:        p0,
					Generation:  container,
					Width:       64,
					Height:      64,
					SHA256RGB24: sha0,
					Window:      &capsule.Window{ID: win, W: 64, H: 64},
				},
				{
					Path:        p1,
					Generation:  container,
					Width:       64,
					Height:      64,
					SHA256RGB24: sha1,
					Window:      &capsule.Window{ID: win, W: 64, H: 64},
				},
			},
		}
	}

	var diagBuf bytes.Buffer
	var refsMu sync.Mutex
	refsBySurface := make(map[string][]Ref, len(surfaceIDs))
	allTenReached := make(chan struct{})
	var closeOnce sync.Once

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	subs, err := NewSubscriptions(ctx, SubscriptionConfig{
		MaxSubscriptions:      16,
		PollInterval:          100 * time.Millisecond,
		CaptureTimeout:        2 * time.Second,
		ShutdownTimeout:       2 * time.Second,
		DeduplicateUnchanged:  true,
		InitialUnchangedPolls: 2,
		Diagnostics:           &diagBuf,
	}, stub, pub, func(_ context.Context, raw json.RawMessage) error {
		var ev struct {
			Event string `json:"event"`
			Data  struct {
				FrameRef Ref `json:"frame_ref"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			return err
		}
		if ev.Event != "frame_ready" {
			return fmt.Errorf("unexpected event %s: %s", ev.Event, raw)
		}
		refsMu.Lock()
		refsBySurface[ev.Data.FrameRef.SurfaceID] = append(refsBySurface[ev.Data.FrameRef.SurfaceID], ev.Data.FrameRef)
		done := true
		for _, sid := range surfaceIDs {
			if len(refsBySurface[sid]) < 10 {
				done = false
				break
			}
		}
		refsMu.Unlock()
		if done {
			closeOnce.Do(func() { close(allTenReached) })
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = subs.Close(context.Background()) }()

	start := time.Now()
	for _, id := range surfaceIDs {
		if err := subs.Subscribe(ctx, id); err != nil {
			t.Fatalf("Subscribe(%s): %v", id, err)
		}
	}

	select {
	case <-allTenReached:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for 4 surfaces x 10 polls; skipped=%d", subs.SkippedPolls())
	}
	elapsed := time.Since(start)

	for _, id := range surfaceIDs {
		if err := subs.Unsubscribe(ctx, id); err != nil {
			t.Fatalf("Unsubscribe(%s): %v", id, err)
		}
	}

	if skipped := subs.SkippedPolls(); skipped != 0 {
		t.Fatalf("expected SkippedPolls == 0 for 4 concurrent surfaces at 100ms with 20ms stub cost, got %d (diag=%q)", skipped, diagBuf.String())
	}
	for _, id := range surfaceIDs {
		if s := subs.SkippedPollsFor(id); s != 0 {
			t.Fatalf("expected SkippedPollsFor(%s) == 0, got %d", id, s)
		}
	}
	// 10 polls at 100 ms interval (first poll at t=0, 10th at t=900 ms) + 20 ms stub cost ~ 920 ms.
	// Allow generous hosted margin up to 2.5 s.
	if elapsed > 2500*time.Millisecond {
		t.Fatalf("4x10 polls took %v, exceeding generous 2.5s cadence ceiling", elapsed)
	}

	// Verify no two surfaces share a frame file path.
	seenPaths := make(map[string]string)
	refsMu.Lock()
	for _, id := range surfaceIDs {
		refs := refsBySurface[id]
		if len(refs) < 10 {
			t.Fatalf("surface %s emitted %d frames, want >= 10", id, len(refs))
		}
		for _, r := range refs {
			if owner, exists := seenPaths[r.RAMWSPath]; exists && owner != id {
				t.Fatalf("surfaces %s and %s shared frame file %s", owner, id, r.RAMWSPath)
			}
			seenPaths[r.RAMWSPath] = id
		}
	}
	refsMu.Unlock()

	// Verify SkippedPolls diagnostics emission when a surface overruns its poll interval.
	slowStub := &ac02StubSource{
		cost:     75 * time.Millisecond,
		surfaces: stub.surfaces,
	}
	var skipDiag bytes.Buffer
	var hookMissed, hookTotal atomic.Uint64
	slowDone := make(chan struct{})
	var slowOnce sync.Once
	slowSubs, err := NewSubscriptions(ctx, SubscriptionConfig{
		MaxSubscriptions: 4,
		PollInterval:     25 * time.Millisecond,
		CaptureTimeout:   time.Second,
		ShutdownTimeout:  time.Second,
		Diagnostics:      &skipDiag,
		OnSkippedPolls: func(_ string, missed, total uint64) {
			hookMissed.Add(missed)
			hookTotal.Store(total)
			slowOnce.Do(func() { close(slowDone) })
		},
	}, slowStub, pub, func(context.Context, json.RawMessage) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = slowSubs.Close(context.Background()) }()
	if err := slowSubs.Subscribe(ctx, "srf-a"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-slowDone:
	case <-ctx.Done():
		t.Fatal("timed out waiting for skipped poll diagnostic emission")
	}
	_ = slowSubs.Unsubscribe(ctx, "srf-a")
	if slowSubs.SkippedPolls() == 0 || slowSubs.SkippedPollsFor("srf-a") == 0 {
		t.Fatalf("expected non-zero SkippedPolls, got total=%d surface=%d", slowSubs.SkippedPolls(), slowSubs.SkippedPollsFor("srf-a"))
	}
	if hookMissed.Load() == 0 || hookTotal.Load() == 0 {
		t.Fatalf("expected OnSkippedPolls hook invocation, got missed=%d total=%d", hookMissed.Load(), hookTotal.Load())
	}
	if !strings.Contains(skipDiag.String(), "adapter: surface srf-a skipped_polls=") {
		t.Fatalf("expected Diagnostics output to contain skipped_polls line, got %q", skipDiag.String())
	}
}

func TestAC02Synthetic1280x900PublishCost(t *testing.T) {
	root := ac02RAMRoot(t)
	srcDir := filepath.Join(root, "source-hd")
	if err := os.Mkdir(srcDir, 0700); err != nil {
		t.Fatal(err)
	}
	pub, err := NewPublisher(PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   64 << 20,
		MaxPixels:       64 << 20,
		MaxSurfaces:     8,
		MaxRetained:     64,
		MinRetention:    4 * time.Second,
		MaxSurfaceBytes: 128 << 20,
		MaxTotalBytes:   512 << 20,
		Deduplicate:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pub.Close() })

	const (
		w          = 1280
		h          = 900
		iterations = 5
	)
	durations := make([]time.Duration, 0, iterations)
	var lastSHA string
	var lastFrame capsule.NativeFrame
	binding := capsule.Binding{
		Surface: capsule.Surface{
			SurfaceID: "hd-surface",
			Geometry:  capsule.Geometry{W: w, H: h},
		},
		Container:  "srf-id-hd",
		FramesRoot: srcDir,
		Window:     "w-hd",
	}

	for i := 1; i <= iterations; i++ {
		_, pngBytes, shaHex := generatePNGFixtureInTempDir(t, w, h, byte(i))
		p := filepath.Join(srcDir, fmt.Sprintf("hd-%d.png", i))
		if err := os.WriteFile(p, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}
		frame := capsule.NativeFrame{
			Path:        p,
			Generation:  binding.Container,
			Seq:         uint64(i),
			Width:       w,
			Height:      h,
			SHA256RGB24: shaHex,
			Window:      &capsule.Window{ID: "w-hd", W: w, H: h},
			TSNS:        uint64(i) * 100_000_000,
			CaptureUS:   1000,
		}
		t0 := time.Now()
		ref, changed, err := pub.PublishIfChanged("hd-surface", binding, frame)
		d := time.Since(t0)
		if err != nil || !changed {
			t.Fatalf("iteration %d PublishIfChanged failed: changed=%v err=%v", i, changed, err)
		}
		if ref.SHA256 != shaHex || ref.Width != w || ref.Height != h {
			t.Fatalf("iteration %d wire digest/geometry mismatch: got (%s, %dx%d), want (%s, %dx%d)", i, ref.SHA256, ref.Width, ref.Height, shaHex, w, h)
		}
		durations = append(durations, d)
		lastSHA = shaHex
		lastFrame = frame
	}

	slices.Sort(durations)
	p50 := durations[len(durations)/2]
	t.Logf("MEASURED_AC02_1280x900_PUBLISH_P50 p50_ms=%.2f max_ms=%.2f", float64(p50.Microseconds())/1000.0, float64(durations[len(durations)-1].Microseconds())/1000.0)
	if p50 > 250*time.Millisecond {
		t.Fatalf("1280x900 publish p50 = %v exceeds 250 ms ceiling", p50)
	}

	// Verify unchanged bytes are not rewritten when forced/initial publish runs on identical pixels.
	lastFrame.Seq = uint64(iterations + 1)
	refForced, err := pub.PublishForced("hd-surface", binding, lastFrame)
	if err != nil {
		t.Fatalf("PublishForced on unchanged bytes failed: %v", err)
	}
	if refForced.SHA256 != lastSHA {
		t.Fatalf("PublishForced SHA256 = %s, want %s", refForced.SHA256, lastSHA)
	}
}

type ac02BlockingRunner struct {
	starts       atomic.Uint64
	inputStarted chan struct{}
	releaseInput chan struct{}
	ramRoot      string
	shaHex       string
}

func (r *ac02BlockingRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	if len(args) < 2 {
		return nil, fmt.Errorf("short args")
	}
	switch args[1] {
	case "start":
		idx := r.starts.Add(1)
		container := fmt.Sprintf("srf-id-p%d", idx)
		runID := fmt.Sprintf("run-p%d", idx)
		return []byte(`{"container":"` + container + `","run_id":"` + runID + `","windows":[{"id":"w1","x":0,"y":0,"w":64,"h":64,"title":"","url":""}]}`), nil
	case "input":
		close(r.inputStarted)
		<-r.releaseInput
		return []byte(`{"surface_id":"w1","kind":"click","input_mono_ns":200,"focus_verified":true,"result":"ok"}`), nil
	case "capture", "frame":
		container := "srf-id-p2"
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "--container" {
				container = args[i+1]
				break
			}
		}
		suffix := strings.TrimPrefix(container, "srf-id-")
		f := capsule.NativeFrame{
			Path:          filepath.Join(r.ramRoot, "run-"+suffix, "frames", "w1", "f.png"),
			Seq:           2,
			SHA256RGB24:   r.shaHex,
			Width:         64,
			Height:        64,
			CaptureMonoNS: 200,
			Generation:    container,
			Window:        &capsule.Window{ID: "w1", W: 64, H: 64},
		}
		return json.Marshal(f)
	case "stop":
		container := args[3]
		return []byte(`{"stopped":"` + container + `","removed_verified":true}`), nil
	default:
		return nil, fmt.Errorf("unexpected verb %s", args[1])
	}
}

func TestAC02NegativeControls(t *testing.T) {
	t.Run("corrupt_png_and_digest_mismatch_refuse_and_never_publish", func(t *testing.T) {
		root := ac02RAMRoot(t)
		srcDir := filepath.Join(root, "source-neg")
		if err := os.Mkdir(srcDir, 0700); err != nil {
			t.Fatal(err)
		}
		pub, err := NewPublisher(PublishConfig{
			RAMRoot:       root,
			MaxFrameBytes: 1 << 20,
			MaxPixels:     1 << 20,
			MaxSurfaces:   4,
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pub.Close() })

		// 1. Corrupt PNG bytes in temp fixture.
		corruptTemp := filepath.Join(t.TempDir(), "corrupt.png")
		corruptBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDRcorrupt-payload-bytes")
		if err := os.WriteFile(corruptTemp, corruptBytes, 0600); err != nil {
			t.Fatal(err)
		}
		corruptPath := filepath.Join(srcDir, "corrupt.png")
		if err := os.WriteFile(corruptPath, corruptBytes, 0600); err != nil {
			t.Fatal(err)
		}
		binding := capsule.Binding{
			Surface:    capsule.Surface{SurfaceID: "neg-srf", Geometry: capsule.Geometry{W: 64, H: 64}},
			Container:  "srf-id-neg",
			FramesRoot: srcDir,
			Window:     "w1",
		}
		_, pngBytes, validSHA := generatePNGFixtureInTempDir(t, 64, 64, 9)
		corruptFrame := capsule.NativeFrame{
			Path:        corruptPath,
			Generation:  binding.Container,
			Seq:         1,
			Width:       64,
			Height:      64,
			SHA256RGB24: validSHA,
			Window:      &capsule.Window{ID: "w1", W: 64, H: 64},
			TSNS:        10,
			CaptureUS:   10,
		}
		if _, err := pub.Publish("neg-srf", binding, corruptFrame); err == nil {
			t.Fatal("expected corrupt PNG to be refused by Publish")
		}
		if _, _, err := pub.PublishIfChanged("neg-srf", binding, corruptFrame); err == nil {
			t.Fatal("expected corrupt PNG to be refused by PublishIfChanged")
		}

		// 2. Valid PNG with mismatched SHA256RGB24 digest.
		validPath := filepath.Join(srcDir, "valid.png")
		if err := os.WriteFile(validPath, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}
		badDigestFrame := corruptFrame
		badDigestFrame.Path = validPath
		badDigestFrame.SHA256RGB24 = strings.Repeat("0", 64)
		if _, err := pub.Publish("neg-srf", binding, badDigestFrame); err == nil {
			t.Fatal("expected digest mismatch to be refused by Publish")
		}
		if _, _, err := pub.PublishIfChanged("neg-srf", binding, badDigestFrame); err == nil {
			t.Fatal("expected digest mismatch to be refused by PublishIfChanged")
		}

		entries, err := os.ReadDir(pub.outputPath)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("expected 0 published .rgb files after corrupt/mismatch refusals, got %d", len(entries))
		}
	})

	t.Run("same_surface_input_vs_capture_refuses_policy_while_other_surface_captures", func(t *testing.T) {
		root := ac02RAMRoot(t)
		_, _, shaHex := generatePNGFixtureInTempDir(t, 64, 64, 11)

		runner := &ac02BlockingRunner{
			inputStarted: make(chan struct{}),
			releaseInput: make(chan struct{}),
			ramRoot:      root,
			shaHex:       shaHex,
		}
		mgr, err := capsule.NewManager(capsule.Config{
			BinDir:         t.TempDir(),
			OriginNS:       100,
			MaxSurfaces:    4,
			MaxOutputBytes: 4096,
			Timeout:        5 * time.Second,
			Profiles: map[string]capsule.Profile{
				"pa": {Kind: "browser", NativeKind: "browser", Width: 64, Height: 64, Display: ":100", RAMRoot: root},
				"pb": {Kind: "browser", NativeKind: "browser", Width: 64, Height: 64, Display: ":101", RAMRoot: root},
			},
		}, runner, func() uint64 { return 200 })
		if err != nil {
			t.Fatal(err)
		}

		createSurface := func(profileID string) string {
			evs, err := mgr.Handle(context.Background(), capsule.Request{
				Schema: "surface_request/v0.2",
				Op:     "create",
				Params: json.RawMessage(`{"kind":"browser","profile_id":"` + profileID + `","geometry":{"w":64,"h":64}}`),
			})
			if err != nil || len(evs) == 0 {
				t.Fatalf("create(%s): %v", profileID, err)
			}
			var created struct {
				Data struct {
					Surface capsule.Surface `json:"surface"`
				} `json:"data"`
			}
			if err := json.Unmarshal(evs[0], &created); err != nil {
				t.Fatal(err)
			}
			return created.Data.Surface.SurfaceID
		}

		idA := createSurface("pa")
		idB := createSurface("pb")

		inputDone := make(chan error, 1)
		go func() {
			_, err := mgr.Handle(context.Background(), capsule.Request{
				Schema: "surface_request/v0.2",
				Op:     "input",
				Params: json.RawMessage(`{"surface_id":"` + idA + `","proposal_id":"p1","action":{"type":"click","x":1,"y":1,"button":"left"}}`),
			})
			inputDone <- err
		}()

		select {
		case <-runner.inputStarted:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for input to start on surface A")
		}

		// Capture on the SAME surface during in-flight input MUST refuse with POLICY.
		_, _, err = mgr.Capture(context.Background(), idA)
		if err == nil || err.Error() != "POLICY: input must be drained before capture" {
			t.Fatalf("expected POLICY refusal for capture during input on same surface, got %v", err)
		}

		// Capture on a DIFFERENT surface succeeds while surface A is in input.
		if _, _, err := mgr.Capture(context.Background(), idB); err != nil {
			t.Fatalf("expected concurrent capture on surface B to succeed, got %v", err)
		}

		close(runner.releaseInput)
		if err := <-inputDone; err != nil {
			t.Fatalf("surface A input failed: %v", err)
		}
	})

	t.Run("two_surfaces_never_share_frame_file", func(t *testing.T) {
		root := ac02RAMRoot(t)
		srcA := filepath.Join(root, "source-1")
		srcB := filepath.Join(root, "source-2")
		if err := os.Mkdir(srcA, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(srcB, 0700); err != nil {
			t.Fatal(err)
		}
		pub, err := NewPublisher(PublishConfig{
			RAMRoot:       root,
			MaxFrameBytes: 1 << 20,
			MaxPixels:     1 << 20,
			MaxSurfaces:   4,
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pub.Close() })

		_, pngBytes, shaHex := generatePNGFixtureInTempDir(t, 32, 32, 42)
		pathA := filepath.Join(srcA, "same.png")
		pathB := filepath.Join(srcB, "same.png")
		if err := os.WriteFile(pathA, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(pathB, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}
		bindA := capsule.Binding{
			Surface:    capsule.Surface{SurfaceID: "surf-1", Geometry: capsule.Geometry{W: 32, H: 32}},
			Container:  "srf-id-one",
			FramesRoot: srcA,
			Window:     "w1",
		}
		bindB := capsule.Binding{
			Surface:    capsule.Surface{SurfaceID: "surf-2", Geometry: capsule.Geometry{W: 32, H: 32}},
			Container:  "srf-id-two",
			FramesRoot: srcB,
			Window:     "w2",
		}
		frameA := capsule.NativeFrame{
			Path:        pathA,
			Generation:  bindA.Container,
			Seq:         1,
			Width:       32,
			Height:      32,
			SHA256RGB24: shaHex,
			Window:      &capsule.Window{ID: "w1", W: 32, H: 32},
			TSNS:        10,
			CaptureUS:   5,
		}
		frameB := capsule.NativeFrame{
			Path:        pathB,
			Generation:  bindB.Container,
			Seq:         1,
			Width:       32,
			Height:      32,
			SHA256RGB24: shaHex,
			Window:      &capsule.Window{ID: "w2", W: 32, H: 32},
			TSNS:        10,
			CaptureUS:   5,
		}

		refA1, err := pub.Publish("surf-1", bindA, frameA)
		if err != nil {
			t.Fatal(err)
		}
		refB1, err := pub.Publish("surf-2", bindB, frameB)
		if err != nil {
			t.Fatal(err)
		}
		frameA.Seq = 2
		frameB.Seq = 2
		refA2, err := pub.PublishForced("surf-1", bindA, frameA)
		if err != nil {
			t.Fatal(err)
		}
		refB2, err := pub.PublishForced("surf-2", bindB, frameB)
		if err != nil {
			t.Fatal(err)
		}

		for _, pair := range [][2]Ref{{refA1, refB1}, {refA2, refB2}, {refA1, refB2}, {refA2, refB1}} {
			if pair[0].RAMWSPath == pair[1].RAMWSPath {
				t.Fatalf("two surfaces shared RAMWSPath %s", pair[0].RAMWSPath)
			}
			fi0, err := os.Stat(pair[0].RAMWSPath)
			if err != nil {
				t.Fatal(err)
			}
			fi1, err := os.Stat(pair[1].RAMWSPath)
			if err != nil {
				t.Fatal(err)
			}
			st0 := fi0.Sys().(*syscall.Stat_t)
			st1 := fi1.Sys().(*syscall.Stat_t)
			if st0.Ino == st1.Ino {
				t.Fatalf("two surfaces shared underlying inode %d (%s vs %s)", st0.Ino, pair[0].RAMWSPath, pair[1].RAMWSPath)
			}
		}
	})
}
