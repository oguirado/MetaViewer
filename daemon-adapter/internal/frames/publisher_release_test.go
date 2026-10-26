package frames

import (
	"os"
	"testing"
)

func TestPartialReleaseCloseRetainsOnlyUnreleasedLease(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	first, err := p.Publish("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	f.Seq++
	second, err := p.Publish("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(second.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(second.RAMWSPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := p.Release("a"); err == nil {
		t.Fatal("release accepted an unlink failure")
	}
	if _, err := os.Stat(first.RAMWSPath); !os.IsNotExist(err) {
		t.Fatal("first lease was not released")
	}
	if len(p.surfaces["a"].refs) != 1 {
		t.Error("successfully released lease still tracked")
	}
	// Repair the obstructed lease; Close must reclaim it exactly once.
	if err := os.Remove(second.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second.RAMWSPath, []byte("lease"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close retried a released lease: %v", err)
	}
}
