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

func TestR1033FailedExpiredUnlinkPreservesGeneration(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	f.Seq = 1
	r1, err := p.Publish("a", b, f)
	if err != nil || r1.Generation != 1 {
		t.Fatalf("first publish: %+v %v", r1, err)
	}
	f.Seq = 2
	r2, err := p.Publish("a", b, f)
	if err != nil || r2.Generation != 2 {
		t.Fatalf("second publish: %+v %v", r2, err)
	}
	// Obstruct unlinking of the expiring first lease so the 3rd publish fails.
	if err := os.Remove(r1.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(r1.RAMWSPath, 0700); err != nil {
		t.Fatal(err)
	}
	f.Seq = 3
	if _, err := p.Publish("a", b, f); err == nil {
		t.Fatal("expected publish to fail when expired lease unlink fails")
	}
	// Repair the expired lease so the retry can unlink it.
	if err := os.Remove(r1.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r1.RAMWSPath, []byte("lease"), 0600); err != nil {
		t.Fatal(err)
	}
	r3, err := p.Publish("a", b, f)
	if err != nil {
		t.Fatalf("retry publish failed: %v", err)
	}
	if r3.Generation != 3 {
		t.Fatalf("generation gap after failed expired-unlink: got %d, want 3", r3.Generation)
	}
	// Negative control: subsequent publish strictly increases generation.
	f.Seq = 4
	r4, err := p.Publish("a", b, f)
	if err != nil || r4.Generation != 4 {
		t.Fatalf("subsequent publish: got %+v, err=%v, want generation 4", r4, err)
	}
}

func TestR1039CloseRetryableAndToleratesENOENT(t *testing.T) {
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	f.Seq = 1
	first, err := p.Publish("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	f.Seq = 2
	second, err := p.Publish("a", b, f)
	if err != nil {
		t.Fatal(err)
	}
	// Remove first lease (ENOENT must be tolerated) and obstruct second lease with a directory.
	if err := os.Remove(first.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(second.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(second.RAMWSPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err == nil {
		t.Fatal("Close succeeded despite obstructed lease")
	}
	if p.closed {
		t.Fatal("failed Close marked publisher closed and non-retryable")
	}
	if len(p.surfaces["a"].refs) != 1 || p.surfaces["a"].refs[0].RAMWSPath != second.RAMWSPath {
		t.Fatalf("failed Close did not retain only the obstructed lease: %+v", p.surfaces["a"].refs)
	}
	// Repair the obstruction (leaving it absent also exercises ENOENT tolerance on retry).
	if err := os.Remove(second.RAMWSPath); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("retry Close after repair failed: %v", err)
	}
	if _, err := os.Stat(p.outputPath); !os.IsNotExist(err) {
		t.Fatalf("output directory still exists after successful Close retry: %v", err)
	}
	// Negative control: Close after success is a nil no-op.
	if err := p.Close(); err != nil {
		t.Fatalf("Close after success failed: %v", err)
	}
}
