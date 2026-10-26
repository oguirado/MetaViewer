package frames

import (
	"crypto/sha256"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"testing"

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

// Extended lease safety tests
// Source: SW-0198 INV-3..INV-6
func TestLeaseSafetyExtensions(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)

	// 1. Third publish unlinks the first lease file
	f.Seq = 1
	r1, err := p.Publish("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(r1.RAMWSPath); err != nil {
		t.Fatalf("first lease file missing: %v", err)
	}

	f.Seq = 2
	r2, err := p.Publish("a", b, f)
	if err != nil {
		t.Fatal(err)
	}

	f.Seq = 3
	r3, err := p.Publish("a", b, f)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(r1.RAMWSPath); !os.IsNotExist(err) {
		t.Fatal("third publish failed to unlink the first lease file")
	}
	if _, err := os.Stat(r2.RAMWSPath); err != nil {
		t.Fatal("second lease file should still exist")
	}
	if _, err := os.Stat(r3.RAMWSPath); err != nil {
		t.Fatal("third lease file should still exist")
	}

	// 2. Monotonic generation/tick and race check during concurrent Publish
	var wg sync.WaitGroup
	var mu sync.Mutex
	lastGen := uint64(0)
	lastTick := uint64(0)

	for i := 4; i < 10; i++ {
		wg.Add(1)
		seq := uint64(i)
		go func() {
			defer wg.Done()
			frame := f
			frame.Seq = seq
			ref, err := p.Publish("a", b, frame)
			if err == nil {
				mu.Lock()
				if ref.Generation <= lastGen {
					t.Errorf("non-monotonic generation: got %d, last %d", ref.Generation, lastGen)
				}
				if ref.Tick <= lastTick {
					t.Errorf("non-monotonic tick: got %d, last %d", ref.Tick, lastTick)
				}
				lastGen = ref.Generation
				lastTick = ref.Tick
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	// 3. Double Close and Publish after Close
	if err := p.Close(); err != nil {
		t.Fatalf("first Close failed: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("second Close should be a no-op / non-failing: %v", err)
	}

	f.Seq = 100
	if _, err := p.Publish("a", b, f); err == nil {
		t.Fatal("publish after Close was accepted")
	}

	// 4. TOCTOU: Writer mutating PNG / size mid-read
	p2 := publisher(t, root)
	f.Seq = 101

	// Truncate/corrupt file
	_ = os.WriteFile(f.Path, []byte("corrupted png bytes"), 0600)
	if _, err := p2.Publish("a", b, f); err == nil {
		t.Fatal("mutated invalid PNG was accepted")
	}
}
