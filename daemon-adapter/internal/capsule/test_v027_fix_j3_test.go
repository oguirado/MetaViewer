package capsule

import (
	"os"
	"path/filepath"
	"testing"
)

func TestV027FixJ3AbsoluteHostExecutable(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "Música programs")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(directory, "editor")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveHostBinary(binary, "")
	if err != nil || resolved != binary {
		t.Fatalf("absolute executable: got %q, %v", resolved, err)
	}
	for _, bad := range []string{binary + "-absent", "./editor", "../editor", "editor --flag", binary + ";id", binary + "\n", binary + "/..", "$(id)"} {
		if _, err := ResolveHostBinary(bad, directory); err == nil {
			t.Errorf("unsafe or absent executable accepted: %q", bad)
		}
	}
}
