package frames

import (
	"os"
	"sort"
	"sync"
	"testing"
)

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
	var refs []Ref

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
				refs = append(refs, ref)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	sort.Slice(refs, func(i, j int) bool { return refs[i].Generation < refs[j].Generation })
	for i, ref := range refs {
		if i > 0 && (ref.Generation <= refs[i-1].Generation || ref.Tick <= refs[i-1].Tick) {
			t.Fatal("non-monotonic publication order")
		}
	}
	if len(refs) == 0 {
		t.Fatal("no concurrent publication succeeded")
	}

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
