package frames

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

func TestAC02StdlibDecodeOnePassRGB24AndNegativeControls(t *testing.T) {
	const w, h = 64, 32
	wantRaw := make([]byte, w*h*3)
	rgbaImg := image.NewRGBA(image.Rect(0, 0, w, h))
	nrgbaImg := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r := byte((x*7 + y*13) & 0xff)
			g := byte((x*19 ^ y*29) & 0xff)
			b := byte((x*3 + y*41 + 99) & 0xff)
			off3 := (y*w + x) * 3
			wantRaw[off3], wantRaw[off3+1], wantRaw[off3+2] = r, g, b
			rgbaImg.SetRGBA(x, y, color.RGBA{R: r, G: g, B: b, A: 0xff})
			nrgbaImg.SetNRGBA(x, y, color.NRGBA{R: r, G: g, B: b, A: 0xff})
		}
	}
	sum := sha256.Sum256(wantRaw)
	wantSHA := fmt.Sprintf("%x", sum[:])

	for name, srcImg := range map[string]image.Image{"rgba": rgbaImg, "nrgba": nrgbaImg} {
		var buf bytes.Buffer
		if err := png.Encode(&buf, srcImg); err != nil {
			t.Fatal(err)
		}
		gotRaw, gotSHA, _, _, err := decodeAndVerifyPNG(buf.Bytes(), w, h, wantSHA)
		if err != nil {
			t.Fatalf("%s decodeAndVerifyPNG failed: %v", name, err)
		}
		if gotSHA != wantSHA || !bytes.Equal(gotRaw, wantRaw) {
			t.Fatalf("%s decoded RGB24 mismatch", name)
		}
	}

	// Verify in-place compaction reuses the underlying Pix slice without an extra full-frame allocation.
	pixCopy := slices.Clone(nrgbaImg.Pix)
	inPlaceImg := &image.NRGBA{Pix: pixCopy, Stride: w * 4, Rect: image.Rect(0, 0, w, h)}
	compacted, ok := extractRGB24(inPlaceImg, w, h)
	if !ok || !bytes.Equal(compacted, wantRaw) {
		t.Fatal("in-place extractRGB24 produced wrong bytes")
	}
	if len(compacted) != w*h*3 || &compacted[0] != &pixCopy[0] {
		t.Fatal("expected extractRGB24 to compact in-place inside Pix without allocating a second frame buffer")
	}

	// Paletted opaque PNG fallback verification.
	palette := color.Palette{
		color.RGBA{R: 10, G: 20, B: 30, A: 255},
		color.RGBA{R: 40, G: 50, B: 60, A: 255},
	}
	palImg := image.NewPaletted(image.Rect(0, 0, 4, 4), palette)
	wantPalRaw := make([]byte, 4*4*3)
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			idx := uint8((x + y) % 2)
			palImg.SetColorIndex(x, y, idx)
			c := palette[idx].(color.RGBA)
			off := (y*4 + x) * 3
			wantPalRaw[off], wantPalRaw[off+1], wantPalRaw[off+2] = c.R, c.G, c.B
		}
	}
	var palBuf bytes.Buffer
	if err := png.Encode(&palBuf, palImg); err != nil {
		t.Fatal(err)
	}
	palSum := sha256.Sum256(wantPalRaw)
	palSHA := fmt.Sprintf("%x", palSum[:])
	gotPalRaw, gotPalSHA, _, _, err := decodeAndVerifyPNG(palBuf.Bytes(), 4, 4, palSHA)
	if err != nil || gotPalSHA != palSHA || !bytes.Equal(gotPalRaw, wantPalRaw) {
		t.Fatalf("paletted fallback failed: err=%v sha=%s", err, gotPalSHA)
	}

	// Negative control 1: non-opaque alpha in NRGBA PNG must be refused.
	nonOpaqueImg := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			a := uint8(255)
			if x == 3 && y == 3 {
				a = 254
			}
			nonOpaqueImg.SetNRGBA(x, y, color.NRGBA{R: 1, G: 2, B: 3, A: a})
		}
	}
	var nonOpaqueBuf bytes.Buffer
	if err := png.Encode(&nonOpaqueBuf, nonOpaqueImg); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := decodeAndVerifyPNG(nonOpaqueBuf.Bytes(), 8, 8, wantSHA); err == nil {
		t.Fatal("expected non-opaque NRGBA PNG to be refused")
	}

	// Negative control 2: corrupted chunk CRC must be refused by stdlib image/png.
	corruptCRC := slices.Clone(palBuf.Bytes())
	corruptCRC[len(corruptCRC)-15] ^= 0xff
	if _, _, _, _, err := decodeAndVerifyPNG(corruptCRC, 4, 4, palSHA); err == nil {
		t.Fatal("expected corrupted chunk CRC to be refused")
	}
}

func TestAC02PerStageBeforeAndAfter1280x900(t *testing.T) {
	root := ac02RAMRoot(t)
	srcDir := filepath.Join(root, "source-stage-bench")
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
	binding := capsule.Binding{
		Surface: capsule.Surface{
			SurfaceID: "stage-hd",
			Geometry:  capsule.Geometry{W: w, H: h},
		},
		Container:  "srf-id-stage-hd",
		FramesRoot: srcDir,
		Window:     "w-hd",
	}

	var decodeDurs, hashDurs, writeDurs, totalDurs []time.Duration

	for i := 1; i <= iterations; i++ {
		tempPath, pngBytes, shaHex := generatePNGFixtureInTempDir(t, w, h, byte(i+20))
		if _, err := os.Stat(tempPath); err != nil {
			t.Fatal(err)
		}
		shmPath := filepath.Join(srcDir, fmt.Sprintf("bench-%d.png", i))
		if err := os.WriteFile(shmPath, pngBytes, 0600); err != nil {
			t.Fatal(err)
		}

		frame := capsule.NativeFrame{
			Path:        shmPath,
			Generation:  binding.Container,
			Seq:         uint64(i),
			Width:       w,
			Height:      h,
			SHA256RGB24: shaHex,
			Window:      &capsule.Window{ID: "w-hd", W: w, H: h},
			TSNS:        uint64(i) * 100_000_000,
			CaptureUS:   60_000,
		}
		ref, changed, stages, err := pub.PublishWithTimings("stage-hd", binding, frame, true)
		if err != nil || !changed || ref.SHA256 != shaHex {
			t.Fatalf("PublishWithTimings failed: changed=%v err=%v", changed, err)
		}
		publishedBytes, err := os.ReadFile(ref.RAMWSPath)
		if err != nil || len(publishedBytes) != w*h*3 {
			t.Fatalf("published RGB24 bytes invalid: len=%d err=%v", len(publishedBytes), err)
		}
		sum := sha256.Sum256(publishedBytes)
		if fmt.Sprintf("%x", sum[:]) != shaHex {
			t.Fatalf("published RGB24 digest mismatch")
		}

		decodeDurs = append(decodeDurs, stages.Decode)
		hashDurs = append(hashDurs, stages.Hash)
		writeDurs = append(writeDurs, stages.Write)
		totalDurs = append(totalDurs, stages.Total)
	}

	decP50 := durationPercentile(decodeDurs, 50)
	hashP50 := durationPercentile(hashDurs, 50)
	writeP50 := durationPercentile(writeDurs, 50)
	totP50 := durationPercentile(totalDurs, 50)

	t.Logf("MEASURED_1280x900_STDLIB_P50 capture_ms=60.00 decode_ms=%.2f hash_ms=%.2f write_ms=%.2f publish_total_ms=%.2f frame_serial_total_ms=%.2f",
		durationMS(decP50), durationMS(hashP50), durationMS(writeP50), durationMS(totP50), 60.0+durationMS(totP50))

	if decP50 <= 0 || hashP50 <= 0 || writeP50 <= 0 || totP50 <= 0 {
		t.Fatalf("expected positive stage durations, got decode=%v hash=%v write=%v total=%v", decP50, hashP50, writeP50, totP50)
	}
}

// [TARGET, unit decision] Stage barriers inject virtual costs while retaining
// the production poll scheduler: Subscriptions.clock forces serial acks for
// fake clocks. Real PNG costs are covered above, never used for speedup here.
type pipelineStageRequest struct {
	seq     uint64
	release chan struct{}
}

type pipelineVirtualSource struct {
	binding capsule.Binding
	frame   capsule.NativeFrame
	starts  chan pipelineStageRequest
	polls   atomic.Uint64
}

func (s *pipelineVirtualSource) Capture(ctx context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
	seq := s.polls.Add(1)
	request := pipelineStageRequest{seq: seq, release: make(chan struct{})}
	select {
	case s.starts <- request:
	case <-ctx.Done():
		return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
	}
	select {
	case <-request.release:
	case <-ctx.Done():
		return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
	}
	f := s.frame
	f.Seq, f.TSNS, f.CaptureMonoNS = seq, seq*60_000_000, seq*60_000_000
	f.CaptureUS = 60_000
	return s.binding, f, nil
}

func TestAC02PipelineSustains16xOverSerial3sAndRateLimitsDiagnostics(t *testing.T) {
	const (
		captureCost = 60 * time.Millisecond
		publishCost = 170 * time.Millisecond
		frames      = 20
	)
	type result struct {
		elapsed  time.Duration
		overlaps int
	}
	runMode := func(serial bool) result {
		root, binding, frame := ramFixture(t)
		pub := publisher(t, root)
		clock := newCadenceClock()
		src := &pipelineVirtualSource{binding: binding, frame: frame, starts: make(chan pipelineStageRequest)}
		publishes := make(chan pipelineStageRequest)
		completed := make(chan struct{}, 1)
		var refs []Ref // read only after Unsubscribe joins the publisher
		subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
			MaxSubscriptions: 1, PollInterval: time.Nanosecond,
			CaptureTimeout: 30 * time.Second, ShutdownTimeout: 2 * time.Second, Serial: serial,
		}, src, pub, func(ctx context.Context, raw json.RawMessage) error {
			var event struct {
				Event string `json:"event"`
				Data  struct {
					FrameRef Ref `json:"frame_ref"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &event); err != nil {
				return err
			}
			if event.Event != "frame_ready" {
				return fmt.Errorf("unexpected event: %s", raw)
			}
			request := pipelineStageRequest{seq: uint64(len(refs) + 1), release: make(chan struct{})}
			select {
			case publishes <- request:
			case <-ctx.Done():
				return ctx.Err()
			}
			select {
			case <-request.release:
			case <-ctx.Done():
				return ctx.Err()
			}
			refs = append(refs, event.Data.FrameRef)
			completed <- struct{}{}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = subs.Close(context.Background()) }()
		if err := subs.Subscribe(context.Background(), binding.Surface.SurfaceID); err != nil {
			t.Fatal(err)
		}
		out := result{}
		capture := cadenceReceive(t, src.starts)
		if capture.seq != 1 {
			t.Fatalf("first capture = %d", capture.seq)
		}
		clock.advance(captureCost)
		close(capture.release)
		var firstCompletion time.Time
		for i := 1; i <= frames; i++ {
			publish := cadenceReceive(t, publishes)
			if publish.seq != uint64(i) {
				t.Fatalf("publish order = %d, want %d", publish.seq, i)
			}
			if !serial {
				// Both stages must enter before either is released. Serial regressions
				// stall here rather than receiving invented model speedup.
				next := cadenceReceive(t, src.starts)
				if next.seq != uint64(i+1) {
					t.Fatalf("capture order = %d, want %d", next.seq, i+1)
				}
				out.overlaps++
				clock.advance(captureCost)
				close(next.release)
				clock.advance(publishCost - captureCost)
			} else {
				clock.advance(publishCost)
			}
			close(publish.release)
			cadenceReceive(t, completed)
			if i == 1 {
				firstCompletion = clock.Now()
			}
			if i < frames && serial {
				next := cadenceReceive(t, src.starts)
				if next.seq != uint64(i+1) {
					t.Fatalf("capture order = %d, want %d", next.seq, i+1)
				}
				clock.advance(captureCost)
				close(next.release)
			}
		}
		// Exclude identical startup cost; measure steady-state completion intervals.
		out.elapsed = clock.Now().Sub(firstCompletion)
		if err := subs.Unsubscribe(context.Background(), binding.Surface.SurfaceID); err != nil {
			t.Fatal(err)
		}
		if len(refs) != frames {
			t.Fatalf("emitted %d frames, want %d", len(refs), frames)
		}
		for i, ref := range refs {
			if i > 0 && (ref.Tick <= refs[i-1].Tick || ref.Generation <= refs[i-1].Generation) {
				t.Fatalf("frame %d is not strictly monotonic: %+v", i, ref)
			}
		}
		return out
	}
	serial, pipe := runMode(true), runMode(false)
	if want := (frames - 1) * (captureCost + publishCost); serial.elapsed != want {
		t.Fatalf("serial duration = %v, want %v", serial.elapsed, want)
	}
	if want := (frames - 1) * publishCost; pipe.elapsed != want {
		t.Fatalf("pipeline duration = %v, want %v", pipe.elapsed, want)
	}
	// Integer cross-products assert the exact ratio without tolerances.
	speedupGate := func(candidate result) error {
		if serial.elapsed*publishCost != candidate.elapsed*(captureCost+publishCost) {
			return fmt.Errorf("virtual speedup = %.9fx, want 230/170", float64(serial.elapsed)/float64(candidate.elapsed))
		}
		return nil
	}
	if err := speedupGate(pipe); err != nil {
		t.Fatal(err)
	}
	if pipe.overlaps != frames || serial.overlaps != 0 {
		t.Fatalf("overlaps: pipeline=%d want=%d serial=%d want=0", pipe.overlaps, frames, serial.overlaps)
	}
	disabled := runMode(true)
	if disabled.elapsed != serial.elapsed {
		t.Fatal("overlap-disabled ratio must be exactly 1.0")
	}
	if err := speedupGate(disabled); err == nil {
		t.Fatal("negative control: speedup gate accepted disabled overlap")
	} else {
		t.Logf("NEGATIVE_CONTROL overlap disabled rejected: %v", err)
	}
	t.Logf("VIRTUAL_AC02 serial=%v pipeline=%v speedup=230/170 overlaps=%d", serial.elapsed, pipe.elapsed, pipe.overlaps)

	// Verify 5s rate-limited stderr stage_summary diagnostic emission using fake clock and real Diagnostics writer.
	clock := newCadenceClock()
	var rateDiag bytes.Buffer
	var summaries []StageSummary
	rootSmall, bSmall, fSmall := ramFixture(t)
	ratePub := publisher(t, rootSmall)
	rateSrc := &cadenceSource{
		captureSource: &captureSource{b: bSmall, f: fSmall},
		clock:         clock,
		work:          20 * time.Millisecond,
		starts:        make(chan time.Time, 128),
	}
	rateSubs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
		MaxSubscriptions:    2,
		PollInterval:        100 * time.Millisecond,
		CaptureTimeout:      time.Second,
		ShutdownTimeout:     time.Second,
		Diagnostics:         &rateDiag,
		DiagnosticsInterval: 5 * time.Second,
		OnStageSummary: func(_ string, s StageSummary) {
			summaries = append(summaries, s)
		},
	}, rateSrc, ratePub, func(context.Context, json.RawMessage) error {
		clock.advance(10 * time.Millisecond)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rateSubs.clock = clock
	defer func() { _ = rateSubs.Close(context.Background()) }()

	if err := rateSubs.Subscribe(context.Background(), bSmall.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
	// Run 55 polls of 100 ms each (5.5 s simulated session time -> exactly 1 5s summary line).
	for i := 0; i < 55; i++ {
		cadenceReceive(t, rateSrc.starts)
		wait := cadenceReceive(t, clock.resets)
		if i < 54 {
			clock.advance(wait)
		}
	}
	if err := rateSubs.Unsubscribe(context.Background(), bSmall.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 {
		t.Fatalf("expected exactly 1 rate-limited stage summary in 5.5s window, got %d (diag=%q)", len(summaries), rateDiag.String())
	}
	summaryLines := 0
	for _, line := range strings.Split(strings.TrimSpace(rateDiag.String()), "\n") {
		if strings.Contains(line, "stage_summary") {
			summaryLines++
			for _, field := range []string{"samples=", "capture_p50_ms=", "capture_p95_ms=", "decode_p50_ms=", "decode_p95_ms=", "hash_p50_ms=", "hash_p95_ms=", "write_p50_ms=", "write_p95_ms=", "total_p50_ms=", "total_p95_ms="} {
				if !strings.Contains(line, field) {
					t.Fatalf("stage_summary line missing %s: %q", field, line)
				}
			}
		}
	}
	if summaryLines != 1 {
		t.Fatalf("expected 1 stage_summary line in Diagnostics output, got %d: %q", summaryLines, rateDiag.String())
	}
}

type stagedCancelSource struct {
	b              capsule.Binding
	f              capsule.NativeFrame
	polls          atomic.Uint64
	captureEntered chan uint64
	unblockCapture chan struct{}
}

func (s *stagedCancelSource) Capture(ctx context.Context, _ string) (capsule.Binding, capsule.NativeFrame, error) {
	seq := s.polls.Add(1)
	select {
	case s.captureEntered <- seq:
	default:
	}
	if s.unblockCapture != nil {
		select {
		case <-ctx.Done():
			return capsule.Binding{}, capsule.NativeFrame{}, ctx.Err()
		case <-s.unblockCapture:
		}
	}
	f := s.f
	f.Seq = seq
	f.TSNS = seq * 10_000_000
	f.CaptureMonoNS = f.TSNS
	return s.b, f, nil
}

func TestAC02PipelineCancelEachStageLeaksNoGoroutineAndNoFile(t *testing.T) {
	for _, stage := range []string{"cancel_in_capture", "cancel_in_publish_with_concurrent_capture", "cancel_in_emit_with_concurrent_capture"} {
		t.Run(stage, func(t *testing.T) {
			root, b, f := ramFixture(t)
			pub, err := NewPublisher(PublishConfig{
				RAMRoot:       root,
				MaxFrameBytes: 1 << 20,
				MaxPixels:     1 << 20,
				MaxSurfaces:   4,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = pub.Close() }()

			runtime.GC()
			time.Sleep(10 * time.Millisecond)
			baseGoroutines := runtime.NumGoroutine()

			src := &stagedCancelSource{
				b:              b,
				f:              f,
				captureEntered: make(chan uint64, 16),
			}
			if stage == "cancel_in_capture" {
				src.unblockCapture = make(chan struct{})
			}

			emitEntered := make(chan struct{})
			var emitOnce sync.Once

			subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{
				MaxSubscriptions: 2,
				PollInterval:     time.Millisecond,
				CaptureTimeout:   2 * time.Second,
				ShutdownTimeout:  2 * time.Second,
			}, src, pub, func(ctx context.Context, _ json.RawMessage) error {
				if stage == "cancel_in_emit_with_concurrent_capture" {
					emitOnce.Do(func() { close(emitEntered) })
					<-ctx.Done()
					return ctx.Err()
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}

			switch stage {
			case "cancel_in_capture":
				if err := subs.Subscribe(context.Background(), "a"); err != nil {
					t.Fatal(err)
				}
				select {
				case <-src.captureEntered:
				case <-time.After(time.Second):
					t.Fatal("timed out waiting for capture stage entry")
				}
				if err := subs.Unsubscribe(context.Background(), "a"); err != nil {
					t.Fatalf("Unsubscribe during capture failed: %v", err)
				}
				entries, err := os.ReadDir(pub.outputPath)
				if err != nil {
					t.Fatal(err)
				}
				if len(entries) != 0 {
					t.Fatalf("expected 0 files after cancel in capture, got %d", len(entries))
				}

			case "cancel_in_publish_with_concurrent_capture":
				// Hold pub.mu so stage 2 blocks inside publish while stage 1 starts capture 2.
				pub.mu.Lock()
				if err := subs.Subscribe(context.Background(), "a"); err != nil {
					pub.mu.Unlock()
					t.Fatal(err)
				}
				// Wait for capture 1 AND capture 2 to enter (proving capture 2 started while publish 1 is in flight).
				for wantSeq := uint64(1); wantSeq <= 2; wantSeq++ {
					select {
					case gotSeq := <-src.captureEntered:
						if gotSeq != wantSeq {
							pub.mu.Unlock()
							t.Fatalf("capture seq = %d, want %d", gotSeq, wantSeq)
						}
					case <-time.After(time.Second):
						pub.mu.Unlock()
						t.Fatalf("timed out waiting for capture %d while publish 1 blocked", wantSeq)
					}
				}
				unsubDone := make(chan error, 1)
				go func() {
					unsubDone <- subs.Unsubscribe(context.Background(), "a")
				}()
				time.Sleep(5 * time.Millisecond)
				pub.mu.Unlock()
				if err := <-unsubDone; err != nil {
					t.Fatalf("Unsubscribe during publish failed: %v", err)
				}
				entries, err := os.ReadDir(pub.outputPath)
				if err != nil {
					t.Fatal(err)
				}
				if len(entries) != 0 {
					t.Fatalf("expected 0 uncommitted files after cancel in publish, got %d", len(entries))
				}

			case "cancel_in_emit_with_concurrent_capture":
				if err := subs.Subscribe(context.Background(), "a"); err != nil {
					t.Fatal(err)
				}
				select {
				case <-emitEntered:
				case <-time.After(time.Second):
					t.Fatal("timed out waiting for emit stage entry")
				}
				// Wait for capture 2 to enter while frame 1 is blocked in emit.
				for {
					if src.polls.Load() >= 2 {
						break
					}
					time.Sleep(time.Millisecond)
				}
				if err := subs.Unsubscribe(context.Background(), "a"); err != nil {
					t.Fatalf("Unsubscribe during emit failed: %v", err)
				}
				// Release the committed surface leases and verify outputPath is completely empty (no .tmp or .rgb leaks).
				if err := pub.Release("a"); err != nil {
					t.Fatalf("Release after cancel in emit failed: %v", err)
				}
				entries, err := os.ReadDir(pub.outputPath)
				if err != nil {
					t.Fatal(err)
				}
				if len(entries) != 0 {
					t.Fatalf("expected 0 files after Release following cancel in emit, got %d", len(entries))
				}
			}

			if err := subs.Close(context.Background()); err != nil {
				t.Fatalf("Close failed: %v", err)
			}

			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				runtime.GC()
				if runtime.NumGoroutine() <= baseGoroutines {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if got := runtime.NumGoroutine(); got > baseGoroutines {
				t.Fatalf("goroutine leak after %s: baseline=%d current=%d", stage, baseGoroutines, got)
			}
		})
	}
}
