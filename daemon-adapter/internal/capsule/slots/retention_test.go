package slots

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func noLoadBackups(t *testing.T, s *Store) {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(s.cfg.Root, "profiles", ".slot-load-*"))
	if err != nil || len(paths) != 0 {
		t.Fatalf("retained credential backups: %v (%v)", paths, err)
	}
}

func TestCompletedLoadDiscardsCredentials(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, err := s.Save(ctx, r); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(ctx, r); err != nil {
		t.Fatal(err)
	}
	noLoadBackups(t, s)
}

func TestSaveRetainsOnlyReferencedGenerations(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	for range 5 {
		if _, err := s.Save(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(s.slot(r.SlotID), "generations"))
	if err != nil || len(entries) != 2 {
		t.Fatalf("unbounded retained generations: %v (%v)", entries, err)
	}
	for _, name := range []string{"A.json", "B.json"} {
		if _, err := s.InspectReference(ctx, r.SlotID, name); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInterruptedDeleteNeverResurrects(t *testing.T) {
	for _, point := range []string{"delete-intent", "delete-A.json", "delete-B.json", "delete-generation", "delete-generations-sync", "delete-backups", "delete-sync", "delete-complete"} {
		t.Run(point, func(t *testing.T) {
			s, r := fixture(t)
			ctx := context.Background()
			for range 3 {
				if _, err := s.Save(ctx, r); err != nil {
					t.Fatal(err)
				}
			}
			s.cfg.Failpoint = func(p string) error {
				if p == point {
					return errors.New("crash")
				}
				return nil
			}
			if err := s.Delete(ctx, r); err == nil {
				t.Fatal("delete crash point not reached")
			}
			s.cfg.Failpoint = nil
			if _, err := s.Select(ctx, r.SlotID); err == nil {
				t.Fatal("interrupted delete exposed credentials")
			}
			for _, name := range []string{"A.json", "B.json"} {
				if _, err := s.InspectReference(ctx, r.SlotID, name); err == nil {
					t.Fatal("explicit inspection exposed deleted credentials")
				}
			}
			for range 2 {
				if err := s.ReconcileAll(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.Select(ctx, r.SlotID); !os.IsNotExist(err) {
				t.Fatalf("deleted slot resurrected: %v", err)
			}
			entries, err := os.ReadDir(s.slot(r.SlotID))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if entry.Name() != "guard" && entry.Name() != "generations" {
					t.Fatalf("deleted credentials remain: %s", entry.Name())
				}
			}
			gens, err := os.ReadDir(filepath.Join(s.slot(r.SlotID), "generations"))
			if err != nil || len(gens) != 0 {
				t.Fatalf("deleted payloads remain: %v (%v)", gens, err)
			}
			noLoadBackups(t, s)
			if _, err := s.Save(ctx, r); err != nil {
				t.Fatalf("explicit recreation failed: %v", err)
			}
		})
	}
}

func TestInterruptedPruneKeepsBothRecoveryReferences(t *testing.T) {
	for _, point := range []string{"save-prune-generation", "save-prune", "save-prune-sync"} {
		t.Run(point, func(t *testing.T) {
			s, r := fixture(t)
			ctx := context.Background()
			for range 2 {
				if _, err := s.Save(ctx, r); err != nil {
					t.Fatal(err)
				}
			}
			s.cfg.Failpoint = func(p string) error {
				if p == point {
					return errors.New("crash")
				}
				return nil
			}
			if _, err := s.Save(ctx, r); err == nil {
				t.Fatal("prune crash point not reached")
			}
			s.cfg.Failpoint = nil
			if err := s.ReconcileAll(ctx); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"A.json", "B.json"} {
				if _, err := s.InspectReference(ctx, r.SlotID, name); err != nil {
					t.Fatal(err)
				}
			}
			entries, err := os.ReadDir(filepath.Join(s.slot(r.SlotID), "generations"))
			if err != nil || len(entries) != 2 {
				t.Fatalf("unreferenced credentials remain: %v (%v)", entries, err)
			}
			m, err := s.Select(ctx, r.SlotID)
			if err != nil || m.Generation != 3 {
				t.Fatalf("lost current generation: %+v %v", m, err)
			}
		})
	}
}

func TestReconcileInterruptedLoadCleanup(t *testing.T) {
	for _, point := range LoadSteps {
		t.Run(point, func(t *testing.T) {
			s, r := fixture(t)
			ctx := context.Background()
			if _, err := s.Save(ctx, r); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(s.cfg.Root, "profiles", r.ProfileID, "data")
			if err := os.WriteFile(path, []byte("current credentials"), 0600); err != nil {
				t.Fatal(err)
			}
			s.cfg.Failpoint = func(p string) error {
				if p == point {
					return errors.New("crash")
				}
				return nil
			}
			if _, err := s.Load(ctx, r); err == nil {
				t.Fatal("load crash point not reached")
			}
			s.cfg.Failpoint = nil
			for range 2 {
				if err := s.ReconcileAll(ctx); err != nil {
					t.Fatal(err)
				}
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			want := "current credentials"
			switch point {
			case "load-exchange", "load-sync", "load-discard", "load-discard-sync", "load-complete":
				want = "original\x00bytes"
			}
			if string(data) != want {
				t.Fatalf("lost current data: %q, want %q", data, want)
			}
			noLoadBackups(t, s)
		})
	}
}

func TestDeleteCleansOnlyOwnedLoadStages(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, err := s.Save(ctx, r); err != nil {
		t.Fatal(err)
	}
	owned := filepath.Join(s.cfg.Root, "profiles", ".slot-load-"+r.SlotID+".orphan")
	foreign := filepath.Join(s.cfg.Root, "profiles", ".slot-load-"+r.SlotID+"-other.orphan")
	for _, path := range []string{owned, foreign} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "data"), []byte("credentials"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Delete(ctx, r); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(owned); !os.IsNotExist(err) {
		t.Fatalf("owned backup remains: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(foreign, "data")); err != nil || string(data) != "credentials" {
		t.Fatalf("foreign backup removed: %q %v", data, err)
	}
}

func TestPruneRefusesCorruptRecoveryReference(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	for range 3 {
		if _, err := s.Save(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(s.slot(r.SlotID), "B.json"), []byte("torn"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.marker(r.SlotID, intent{Operation: "save", Profile: r.ProfileID}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadDir(filepath.Join(s.slot(r.SlotID), "generations"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ReconcileAll(ctx); err == nil {
		t.Fatal("corrupt reference passed GC")
	}
	after, err := os.ReadDir(filepath.Join(s.slot(r.SlotID), "generations"))
	if err != nil || len(after) != len(before) {
		t.Fatalf("GC destroyed recovery evidence: %v %v", after, err)
	}
}

func TestPartialBackupDiscardResumesWithoutLosingCurrentProfile(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, err := s.Save(ctx, r); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.cfg.Root, "profiles", r.ProfileID, "data")
	if err := os.WriteFile(path, []byte("old credentials"), 0600); err != nil {
		t.Fatal(err)
	}
	s.helper = func(ctx context.Context, op, profile, stage string, cap int64) (receipt, error) {
		if op == "discard" {
			if err := os.Remove(filepath.Join(profile, "data")); err != nil {
				t.Fatal(err)
			}
			return receipt{}, errors.New("crash during recursive discard")
		}
		return localHelper(ctx, op, profile, stage, cap)
	}
	if _, err := s.Load(ctx, r); err == nil {
		t.Fatal("discard crash not reached")
	}
	// Restart with the production recovery path and only the durable metadata.
	s, err := New(Config{Root: s.cfg.Root, Image: s.cfg.Image, CheckStopped: s.cfg.CheckStopped})
	if err != nil {
		t.Fatal(err)
	}
	s.helper = localHelper
	s.profileUID = uint32(os.Getuid())
	if err := s.ReconcileAll(ctx); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "original\x00bytes" {
		t.Fatalf("current data lost: %q %v", data, err)
	}
	noLoadBackups(t, s)
}

func TestInterruptedDeleteRecoveryResumes(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	for range 3 {
		if _, err := s.Save(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	s.cfg.Failpoint = func(p string) error {
		if p == "delete-intent" {
			return errors.New("crash")
		}
		return nil
	}
	if err := s.Delete(ctx, r); err == nil {
		t.Fatal("delete crash not reached")
	}
	s.cfg.Failpoint = func(p string) error {
		if p == "delete-generation" {
			return errors.New("recovery crash")
		}
		return nil
	}
	if err := s.ReconcileAll(ctx); err == nil {
		t.Fatal("recovery crash not reached")
	}
	if _, err := s.InspectReference(ctx, r.SlotID, "B.json"); err == nil {
		t.Fatal("explicit inspection bypassed deletion")
	}
	s.cfg.Failpoint = nil
	if err := s.ReconcileAll(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Select(ctx, r.SlotID); !os.IsNotExist(err) {
		t.Fatalf("delete recovery resurrected slot: %v", err)
	}
}

func TestPruneResumesPartiallyRemovedUnreferencedGeneration(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	first, err := s.Save(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(ctx, r); err != nil {
		t.Fatal(err)
	}
	s.cfg.Failpoint = func(p string) error {
		if p == "ref-sync" {
			return errors.New("crash")
		}
		return nil
	}
	if _, err := s.Save(ctx, r); err == nil {
		t.Fatal("publication crash not reached")
	}
	// Model a crash inside recursive GC, after its manifest has been unlinked.
	if err := os.Remove(filepath.Join(s.generation(r.SlotID, first.Digest), "manifest.json")); err != nil {
		t.Fatal(err)
	}
	s.cfg.Failpoint = nil
	if err := s.ReconcileAll(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.generation(r.SlotID, first.Digest)); !os.IsNotExist(err) {
		t.Fatalf("partial GC remains: %v", err)
	}
	if m, err := s.Select(ctx, r.SlotID); err != nil || m.Generation != 3 {
		t.Fatalf("lost newest generation: %+v %v", m, err)
	}
	for _, name := range []string{"A.json", "B.json"} {
		if _, err := s.InspectReference(ctx, r.SlotID, name); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLoadCleanupRequiresInodeWitness(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, err := s.Save(ctx, r); err != nil {
		t.Fatal(err)
	}
	s.cfg.Failpoint = func(p string) error {
		if p == "load-exchange" {
			return errors.New("crash")
		}
		return nil
	}
	if _, err := s.Load(ctx, r); err == nil {
		t.Fatal("exchange crash not reached")
	}
	s.cfg.Failpoint = nil
	profile := filepath.Join(s.cfg.Root, "profiles", r.ProfileID)
	preserved := filepath.Join(s.cfg.Root, "profiles", "preserved")
	if err := os.Rename(profile, preserved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(profile, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.ReconcileAll(ctx); err == nil {
		t.Fatal("unproven exchange permitted destructive cleanup")
	}
	stages, err := filepath.Glob(filepath.Join(s.cfg.Root, "profiles", ".slot-load-*"))
	if err != nil || len(stages) != 1 {
		t.Fatalf("quarantine destroyed backup: %v %v", stages, err)
	}
	if err := os.Remove(profile); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(preserved, profile); err != nil {
		t.Fatal(err)
	}
	if err := s.ReconcileAll(ctx); err != nil {
		t.Fatal(err)
	}
	noLoadBackups(t, s)
}
