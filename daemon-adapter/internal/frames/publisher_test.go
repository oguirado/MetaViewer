package frames

import (
	"crypto/sha256"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

func ramFixture(t *testing.T) (string, capsule.Binding, capsule.NativeFrame) {
	t.Helper()
	root, e := os.MkdirTemp("/dev/shm", "mv-frame-test-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := os.RemoveAll(root); e != nil {
			t.Error(e)
		}
	})
	source := filepath.Join(root, "source")
	if e = os.Mkdir(source, 0700); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(source, "f.png")
	file, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		t.Fatal(e)
	}
	img := image.NewRGBA(image.Rect(0, 0, 2, 1))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	img.Set(1, 0, color.RGBA{G: 255, A: 255})
	if e = png.Encode(file, img); e != nil {
		t.Fatal(e)
	}
	if e = file.Close(); e != nil {
		t.Fatal(e)
	}
	b := capsule.Binding{Surface: capsule.Surface{SurfaceID: "a", Geometry: capsule.Geometry{W: 2, H: 1}}, Container: "srf-id-demo", FramesRoot: source, Window: "w1"}
	f := capsule.NativeFrame{Path: path, Seq: 1, Generation: b.Container, Width: 2, Height: 1, SHA256RGB24: fmt.Sprintf("%x", sha256.Sum256([]byte{255, 0, 0, 0, 255, 0})), Window: &capsule.Window{ID: "w1", W: 2, H: 1}, TSNS: 1, CaptureUS: 2}
	return root, b, f
}
func publisher(t *testing.T, root string) *Publisher {
	t.Helper()
	p, e := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 4096, MaxPixels: 64, MaxSurfaces: 4})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := p.Close(); e != nil {
			t.Error(e)
		}
	})
	return p
}
func TestPublication(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	ref, e := p.Publish("a", b, f)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(ref.RAMWSPath)
	if e != nil {
		t.Fatal(e)
	}
	if string(raw) != string([]byte{255, 0, 0, 0, 255, 0}) || ref.Format != "rgb24" || ref.SHA256 != f.SHA256RGB24 || ref.TsNS != 1 || ref.CaptureUS != 2 {
		t.Fatal("incorrect raw publication")
	}
	if _, e = p.Publish("a", b, f); e == nil {
		t.Fatal("stale frame accepted")
	}
	if _, e = p.Publish("b", b, f); e == nil {
		t.Fatal("cross-surface frame accepted")
	}
}
func TestRAMBoundary(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	original := f.Path
	for _, bad := range []string{"/tmp/frame.png", filepath.Join(root, "foreign.png"), b.FramesRoot + "/../source/f.png"} {
		f.Path = bad
		if _, e := p.Publish("a", b, f); e == nil {
			t.Fatal("foreign allocation accepted")
		}
	}
	link := filepath.Join(b.FramesRoot, "link.png")
	if e := os.Symlink(original, link); e != nil {
		t.Fatal(e)
	}
	f.Path = link
	if _, e := p.Publish("a", b, f); e == nil {
		t.Fatal("symlink accepted")
	}
	f.Path = original
	f.SHA256RGB24 = fmt.Sprintf("%064x", 0)
	if _, e := p.Publish("a", b, f); e == nil {
		t.Fatal("digest mismatch accepted")
	}
	f.Width = 1 << 30
	if _, e := p.Publish("a", b, f); e == nil {
		t.Fatal("dimension bomb accepted")
	}
	if _, e := NewPublisher(PublishConfig{RAMRoot: t.TempDir(), MaxFrameBytes: 4096, MaxPixels: 64, MaxSurfaces: 4}); e == nil {
		t.Fatal("disk root accepted")
	}
}
func TestLease(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	var paths []string
	for seq := uint64(1); seq <= 4; seq++ {
		f.Seq = seq
		r, e := p.Publish("a", b, f)
		if e != nil {
			t.Fatal(e)
		}
		if r.Generation != seq {
			t.Fatal("publication generation did not advance")
		}
		paths = append(paths, r.RAMWSPath)
	}
	if _, e := os.Stat(paths[0]); !os.IsNotExist(e) {
		t.Fatal("expired owned publication retained")
	}
	for _, path := range paths[2:] {
		if _, e := os.Stat(path); e != nil {
			t.Fatal("current lease removed")
		}
	}
	if _, e := os.Stat(f.Path); e != nil {
		t.Fatal("native source removed")
	}
}

func TestProducerRootAndNativeGeometry(t *testing.T) {
	root, b, f := ramFixture(t)
	if e := os.Chmod(root, 0775); e != nil {
		t.Fatal(e)
	}
	b.Surface.Geometry = capsule.Geometry{W: 3, H: 2}
	p := publisher(t, root)
	st, e := os.Stat(p.outputPath)
	if e != nil || st.Mode().Perm() != 0700 {
		t.Fatalf("publication not private: %v", e)
	}
	ref, e := p.Publish("a", b, f)
	if e != nil || ref.Width != 2 || ref.Height != 1 {
		t.Fatalf("native geometry refused: %v", e)
	}
	for _, mutate := range []func(*capsule.NativeFrame){
		func(f *capsule.NativeFrame) { f.Generation = "srf-id-foreign" },
		func(f *capsule.NativeFrame) { f.Width = 4 },
		func(f *capsule.NativeFrame) { f.Height = 3 },
		func(f *capsule.NativeFrame) { f.Window = &capsule.Window{ID: "w1", W: 1, H: 1} },
		func(f *capsule.NativeFrame) { f.SHA256RGB24 = fmt.Sprintf("%064x", 0) },
	} {
		bad := f
		bad.Seq++
		mutate(&bad)
		if _, e := p.Publish("a", b, bad); e == nil {
			t.Fatal("invalid native frame accepted")
		}
	}
	if e := os.Chmod(root, 0777); e != nil {
		t.Fatal(e)
	}
	if other, e := NewPublisher(p.cfg); e == nil {
		_ = other.Close()
		t.Fatal("world-writable root accepted")
	}
}

func TestLiveBudgetRetentionRingAndNegativeControl(t *testing.T) {
	root, b, f := ramFixture(t)
	livePub, e := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 16 << 20, MaxPixels: 64, MaxSurfaces: 4})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = livePub.Close() })

	var livePaths []string
	for seq := uint64(1); seq <= 17; seq++ {
		f.Seq = seq
		r, err := livePub.Publish("a", b, f)
		if err != nil {
			t.Fatal(err)
		}
		livePaths = append(livePaths, r.RAMWSPath)
		if seq == 3 {
			// Generation 1 must still exist when generation 3 is published so a
			// 2-hop core+UI pipeline never hits ENOENT on generation >= 2.
			if _, statErr := os.Stat(livePaths[0]); statErr != nil {
				t.Fatalf("live-budget publisher unlinked generation 1 at generation 3: %v", statErr)
			}
		}
	}
	if _, err := os.Stat(livePaths[0]); !os.IsNotExist(err) {
		t.Fatal("expected generation 1 to be evicted on generation 17")
	}
	for i := 1; i < len(livePaths); i++ {
		if _, err := os.Stat(livePaths[i]); err != nil {
			t.Fatalf("expected retained generation %d to exist: %v", i+1, err)
		}
	}

	// Negative control: a 2-slot ring evicts generation 1 as soon as generation 3 is published.
	shortPub, e := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 16 << 20, MaxPixels: 64, MaxSurfaces: 4, MaxRetained: 2})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = shortPub.Close() })
	var shortPaths []string
	for seq := uint64(1); seq <= 3; seq++ {
		f.Seq = seq
		r, err := shortPub.Publish("a", b, f)
		if err != nil {
			t.Fatal(err)
		}
		shortPaths = append(shortPaths, r.RAMWSPath)
	}
	if _, err := os.Stat(shortPaths[0]); !os.IsNotExist(err) {
		t.Fatal("negative control failed: expected MaxRetained=2 to unlink generation 1 at generation 3")
	}
	if _, err := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 16 << 20, MaxPixels: 64, MaxSurfaces: 4, MaxRetained: 1}); err == nil {
		t.Fatal("expected MaxRetained=1 (< 2) to be refused")
	}

	// Per-surface RAM byte cap: with MaxFrameBytes = 1_200_000 (>= 1 MiB, so slot cap is 16),
	// maxRetainedBytes is 4 * 1_200_000 = 4_800_000 bytes. A 600x600 RGB24 frame is 1_080_000 bytes,
	// so at most 4 frames (4_320_000 bytes <= 4_800_000) may be retained; the 5th publish must evict frame 1.
	largePath := filepath.Join(b.FramesRoot, "large.png")
	largeFile, err := os.OpenFile(largePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	const side = 600
	largeImg := image.NewRGBA(image.Rect(0, 0, side, side))
	rawRGB := make([]byte, side*side*3)
	for y := 0; y < side; y++ {
		for x := 0; x < side; x++ {
			largeImg.SetRGBA(x, y, color.RGBA{R: 0x20, G: 0x40, B: 0x60, A: 0xff})
			off := (y*side + x) * 3
			rawRGB[off], rawRGB[off+1], rawRGB[off+2] = 0x20, 0x40, 0x60
		}
	}
	if err := png.Encode(largeFile, largeImg); err != nil {
		t.Fatal(err)
	}
	if err := largeFile.Close(); err != nil {
		t.Fatal(err)
	}
	largeBinding := b
	largeBinding.Surface.Geometry = capsule.Geometry{W: side, H: side}
	largeFrame := capsule.NativeFrame{
		Path:        largePath,
		Generation:  largeBinding.Container,
		Width:       side,
		Height:      side,
		SHA256RGB24: fmt.Sprintf("%x", sha256.Sum256(rawRGB)),
		Window:      &capsule.Window{ID: "w1", W: side, H: side},
		TSNS:        1,
		CaptureUS:   2,
	}
	byteCappedPub, err := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 1_200_000, MaxPixels: side * side, MaxSurfaces: 4})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = byteCappedPub.Close() })
	var cappedPaths []string
	for seq := uint64(1); seq <= 5; seq++ {
		largeFrame.Seq = seq
		r, pubErr := byteCappedPub.Publish("a", largeBinding, largeFrame)
		if pubErr != nil {
			t.Fatal(pubErr)
		}
		cappedPaths = append(cappedPaths, r.RAMWSPath)
		if seq == 4 {
			for i := 0; i < 4; i++ {
				if _, statErr := os.Stat(cappedPaths[i]); statErr != nil {
					t.Fatalf("expected frame %d within 4x byte cap to remain at seq 4: %v", i+1, statErr)
				}
			}
		}
	}
	if _, err := os.Stat(cappedPaths[0]); !os.IsNotExist(err) {
		t.Fatal("expected 5th 1.08MB frame to evict 1st frame under 4.8MB per-surface byte cap")
	}
	for i := 1; i < 5; i++ {
		if _, err := os.Stat(cappedPaths[i]); err != nil {
			t.Fatalf("expected retained frame %d within byte cap to exist: %v", i+1, err)
		}
	}
}

func TestTimeBasedRetentionGlobalCapAndDeduplication(t *testing.T) {
	root, b, f := ramFixture(t)
	now := time.Unix(1_700_000_000, 0)
	winPub, err := NewPublisher(PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   64 << 20,
		MaxPixels:       64 << 20,
		MaxSurfaces:     4,
		MaxRetained:     64,
		MinRetention:    3 * time.Second,
		MaxSurfaceBytes: 128 << 20,
		MaxTotalBytes:   512 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	winPub.now = func() time.Time { return now }
	t.Cleanup(func() { _ = winPub.Close() })

	// Publish 25 generations at 100 ms intervals (t = 0.0 s .. 2.4 s, all within 3 s window).
	// Even past generation 16, all 25 publications must survive inside MinRetention.
	var winPaths []string
	for seq := uint64(1); seq <= 25; seq++ {
		f.Seq = seq
		r, pubErr := winPub.Publish("a", b, f)
		if pubErr != nil {
			t.Fatal(pubErr)
		}
		winPaths = append(winPaths, r.RAMWSPath)
		now = now.Add(100 * time.Millisecond)
	}
	for i, pth := range winPaths {
		if _, statErr := os.Stat(pth); statErr != nil {
			t.Fatalf("expected generation %d to survive inside 3s retention window: %v", i+1, statErr)
		}
	}

	// Negative control: once time advances past MinRetention (t = 3.5 s, so generations
	// published at t <= 0.5 s are >= 3.0 s old), publishing generation 26 reclaims them.
	now = time.Unix(1_700_000_000, 0).Add(3500 * time.Millisecond)
	f.Seq = 26
	if _, pubErr := winPub.Publish("a", b, f); pubErr != nil {
		t.Fatal(pubErr)
	}
	for i := 0; i <= 5; i++ {
		if _, statErr := os.Stat(winPaths[i]); !os.IsNotExist(statErr) {
			t.Fatalf("negative control failed: expected expired generation %d to be unlinked past MinRetention", i+1)
		}
	}
	for i := 6; i < len(winPaths); i++ {
		if _, statErr := os.Stat(winPaths[i]); statErr != nil {
			t.Fatalf("expected non-expired generation %d to remain openable: %v", i+1, statErr)
		}
	}

	// Global byte cap across multiple surfaces: each 2x1 RGB24 frame is 6 bytes.
	// Set MaxSurfaceBytes = 24 (4 frames per surface) and MaxTotalBytes = 30 (5 frames total across surfaces)
	// with a 10 s MinRetention so byte caps override time retention.
	globalNow := time.Unix(1_700_000_000, 0)
	globalPub, err := NewPublisher(PublishConfig{
		RAMRoot:         root,
		MaxFrameBytes:   64 << 20,
		MaxPixels:       64 << 20,
		MaxSurfaces:     4,
		MaxRetained:     64,
		MinRetention:    10 * time.Second,
		MaxSurfaceBytes: 24,
		MaxTotalBytes:   30,
	})
	if err != nil {
		t.Fatal(err)
	}
	globalPub.now = func() time.Time { return globalNow }
	t.Cleanup(func() { _ = globalPub.Close() })

	bB := b
	bB.Surface.SurfaceID = "b"
	fA := f
	fB := f
	var pathsA, pathsB []string
	for seq := uint64(1); seq <= 3; seq++ {
		fA.Seq = seq
		rA, errA := globalPub.Publish("a", b, fA)
		if errA != nil {
			t.Fatal(errA)
		}
		pathsA = append(pathsA, rA.RAMWSPath)
		globalNow = globalNow.Add(50 * time.Millisecond)

		fB.Seq = seq
		rB, errB := globalPub.Publish("b", bB, fB)
		if errB != nil {
			t.Fatal(errB)
		}
		pathsB = append(pathsB, rB.RAMWSPath)
		globalNow = globalNow.Add(50 * time.Millisecond)
	}
	// Total frames published = 6 (36 bytes > MaxTotalBytes=30), so the globally oldest frame (pathsA[0]) must be evicted.
	if _, statErr := os.Stat(pathsA[0]); !os.IsNotExist(statErr) {
		t.Fatal("expected global byte cap to evict oldest generation on surface a")
	}
	for i := 1; i < len(pathsA); i++ {
		if _, statErr := os.Stat(pathsA[i]); statErr != nil {
			t.Fatalf("expected retained generation a[%d] to exist: %v", i, statErr)
		}
	}
	for i := 0; i < len(pathsB); i++ {
		if _, statErr := os.Stat(pathsB[i]); statErr != nil {
			t.Fatalf("expected retained generation b[%d] to exist: %v", i, statErr)
		}
	}

	// Unchanged-hash deduplication + negative control when content hash changes.
	dedupPub, err := NewPublisher(PublishConfig{
		RAMRoot:       root,
		MaxFrameBytes: 64 << 20,
		MaxPixels:     64 << 20,
		MaxSurfaces:   4,
		Deduplicate:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dedupPub.Close() })

	fDedup := f
	fDedup.Seq = 1
	ref1, changed1, err := dedupPub.PublishIfChanged("a", b, fDedup)
	if err != nil || !changed1 || ref1.Generation != 1 {
		t.Fatalf("expected initial frame to publish generation 1: changed=%v ref=%+v err=%v", changed1, ref1, err)
	}
	for seq := uint64(2); seq <= 5; seq++ {
		fDedup.Seq = seq
		refSame, changed, errSame := dedupPub.PublishIfChanged("a", b, fDedup)
		if errSame != nil || changed || refSame.Generation != ref1.Generation || refSame.RAMWSPath != ref1.RAMWSPath {
			t.Fatalf("expected unchanged frame at seq %d to deduplicate: changed=%v ref=%+v err=%v", seq, changed, refSame, errSame)
		}
	}
	// Negative control: mutate pixel content and digest; PublishIfChanged must publish a new generation.
	altPath := filepath.Join(b.FramesRoot, "alt.png")
	altFile, err := os.OpenFile(altPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	altImg := image.NewRGBA(image.Rect(0, 0, 2, 1))
	altImg.SetRGBA(0, 0, color.RGBA{R: 9, G: 8, B: 7, A: 255})
	altImg.SetRGBA(1, 0, color.RGBA{R: 6, G: 5, B: 4, A: 255})
	if err := png.Encode(altFile, altImg); err != nil {
		t.Fatal(err)
	}
	if err := altFile.Close(); err != nil {
		t.Fatal(err)
	}
	altSum := sha256.Sum256([]byte{9, 8, 7, 6, 5, 4})
	fDedup.Seq = 6
	fDedup.Path = altPath
	fDedup.SHA256RGB24 = fmt.Sprintf("%x", altSum[:])
	ref2, changed2, err := dedupPub.PublishIfChanged("a", b, fDedup)
	if err != nil || !changed2 || ref2.Generation != 2 || ref2.RAMWSPath == ref1.RAMWSPath {
		t.Fatalf("negative control failed: expected changed digest to publish generation 2: changed=%v ref=%+v err=%v", changed2, ref2, err)
	}

	// Real 1280x900 RGB24 (3,456,000 bytes) publisher latency measurement.
	const w, h = 1280, 900
	hdPath := filepath.Join(b.FramesRoot, "hd.png")
	hdFile, err := os.OpenFile(hdPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	hdImg := image.NewRGBA(image.Rect(0, 0, w, h))
	hdRaw := make([]byte, w*h*3)
	for i := 0; i < w*h; i++ {
		r, g, bl := byte(i), byte(i>>8), byte(i>>16)
		off4 := i * 4
		hdImg.Pix[off4], hdImg.Pix[off4+1], hdImg.Pix[off4+2], hdImg.Pix[off4+3] = r, g, bl, 0xff
		off3 := i * 3
		hdRaw[off3], hdRaw[off3+1], hdRaw[off3+2] = r, g, bl
	}
	if err := png.Encode(hdFile, hdImg); err != nil {
		t.Fatal(err)
	}
	if err := hdFile.Close(); err != nil {
		t.Fatal(err)
	}
	hdBinding := b
	hdBinding.Surface.SurfaceID = "hd"
	hdBinding.Surface.Geometry = capsule.Geometry{W: w, H: h}
	hdFrame := capsule.NativeFrame{
		Path:        hdPath,
		Generation:  hdBinding.Container,
		Seq:         1,
		Width:       w,
		Height:      h,
		SHA256RGB24: fmt.Sprintf("%x", sha256.Sum256(hdRaw)),
		Window:      &capsule.Window{ID: "w1", W: w, H: h},
		TSNS:        100,
		CaptureUS:   1000,
	}
	t0 := time.Now()
	hdRef, hdChanged, err := dedupPub.PublishIfChanged("hd", hdBinding, hdFrame)
	pubDur := time.Since(t0)
	if err != nil || !hdChanged || hdRef.Width != w || hdRef.Height != h {
		t.Fatalf("1280x900 publish failed: %v", err)
	}
	hdFrame.Seq = 2
	t1 := time.Now()
	_, hdChanged2, err := dedupPub.PublishIfChanged("hd", hdBinding, hdFrame)
	dedupDur := time.Since(t1)
	if err != nil || hdChanged2 {
		t.Fatalf("1280x900 deduplicated publish failed: changed=%v err=%v", hdChanged2, err)
	}
	t.Logf("MEASURED_PUBLISHER_1280x900 raw_bytes=%d publish_ms=%.2f dedup_ms=%.3f", len(hdRaw), float64(pubDur.Microseconds())/1000.0, float64(dedupDur.Microseconds())/1000.0)
}
