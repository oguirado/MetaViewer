package frames

import (
	"sync"
	"testing"
)

func TestCurrentPublicationCopyAndRetirement(t *testing.T) {
	root, binding, native := ramFixture(t)
	p := publisher(t, root)
	if _, err := p.Current("a"); err == nil {
		t.Fatal("missing publication admitted")
	}
	first, err := p.Publish("a", binding, native)
	if err != nil {
		t.Fatal(err)
	}
	r, err := p.Current("a")
	if err != nil || r != first {
		t.Fatalf("current=%+v err=%v", r, err)
	}
	r.SHA256, r.SurfaceID = "mutated", "foreign"
	if again, err := p.Current("a"); err != nil || again != first {
		t.Fatal("external mutation changed publication")
	}
	if _, err := p.Current("foreign"); err == nil {
		t.Fatal("foreign surface admitted")
	}
	native.Seq++
	native.TSNS++
	second, err := p.PublishForced("a", binding, native)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := p.Current("a"); err != nil || got != second || got.Generation <= first.Generation {
		t.Fatal("current did not follow publication")
	}
	if err := p.Release("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Current("a"); err == nil {
		t.Fatal("released publication admitted")
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Current("a"); err == nil {
		t.Fatal("closed publication admitted")
	}
	var absent *Publisher
	if _, err := absent.Current("a"); err == nil {
		t.Fatal("nil publisher admitted")
	}
}

func TestCurrentConcurrentPublication(t *testing.T) {
	root, binding, native := ramFixture(t)
	p := publisher(t, root)
	if _, err := p.Publish("a", binding, native); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			if r, err := p.Current("a"); err != nil || r.SurfaceID != "a" || r.Generation == 0 {
				t.Error("invalid concurrent snapshot")
			}
		}
	}()
	for i := 0; i < 10; i++ {
		native.Seq++
		native.TSNS++
		if _, err := p.PublishForced("a", binding, native); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
}
