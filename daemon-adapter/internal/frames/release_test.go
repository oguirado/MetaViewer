package frames

import (
	"os"
	"testing"
)

func TestSurfaceReleaseReclaimsCapacity(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	p.cfg.MaxSurfaces = 1
	first, e := p.Publish("a", b, f)
	if e != nil {
		t.Fatal(e)
	}
	f.Seq++
	retained, e := p.Publish("a", b, f)
	if e != nil {
		t.Fatal(e)
	}
	b.Surface.SurfaceID = "b"
	if _, e = p.Publish("b", b, f); e == nil {
		t.Fatal("capacity bypassed")
	}
	release, ok := any(p).(interface{ Release(string) error })
	if !ok {
		t.Fatal("per-surface release absent")
	}
	if e = release.Release("unknown"); e == nil {
		t.Fatal("unknown release succeeded")
	}
	if e = release.Release("a"); e != nil {
		t.Fatal(e)
	}
	for _, path := range []string{first.RAMWSPath, retained.RAMWSPath} {
		if _, e = os.Stat(path); !os.IsNotExist(e) {
			t.Fatal("released lease remains")
		}
	}
	if e = release.Release("a"); e == nil {
		t.Fatal("double release succeeded")
	}
	second, e := p.Publish("b", b, f)
	if e != nil {
		t.Fatal(e)
	}
	entries, e := os.ReadDir(p.outputPath)
	if e != nil || len(entries) != 1 {
		t.Fatalf("allocation leak: %v %v", entries, e)
	}
	if second.Generation <= first.Generation {
		t.Fatal("generation reused")
	}
	if _, e = os.Stat(f.Path); e != nil {
		t.Fatal("producer file deleted")
	}
}

func TestReleaseFailureRetainsCapacity(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	p.cfg.MaxSurfaces = 1
	ref, e := p.Publish("a", b, f)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Remove(ref.RAMWSPath); e != nil {
		t.Fatal(e)
	}
	if e = os.Mkdir(ref.RAMWSPath, 0700); e != nil {
		t.Fatal(e)
	}
	if e = p.Release("a"); e == nil {
		t.Fatal("failed unlink reclaimed capacity")
	}
	b.Surface.SurfaceID = "b"
	if _, e = p.Publish("b", b, f); e == nil {
		t.Fatal("capacity freed on failed release")
	}
	if e = os.Remove(ref.RAMWSPath); e != nil {
		t.Fatal(e)
	}
	if e = p.Release("a"); e != nil {
		t.Fatal(e)
	}
	if _, e = p.Publish("b", b, f); e != nil {
		t.Fatal(e)
	}
	if e = p.Close(); e != nil {
		t.Fatal(e)
	}
	if e = p.Release("b"); e == nil {
		t.Fatal("release after close accepted")
	}
}
