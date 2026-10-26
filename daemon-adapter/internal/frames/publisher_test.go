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
