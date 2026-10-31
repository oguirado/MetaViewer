package daemon

import (
	"metaviewer/daemon-adapter/internal/capsule"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedCanonicalRoots(t *testing.T) {
	root := t.TempDir()
	p := map[string]capsule.Profile{"a": {RAMRoot: root}, "b": {RAMRoot: root}}
	if err := validateProfileRoots(p); err != nil {
		t.Fatalf("shared canonical roots refused: %v", err)
	}
	child := filepath.Join(root, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{child, link, root + "/", root + "/child/..", filepath.Join(root, "missing")} {
		p["b"] = capsule.Profile{RAMRoot: bad}
		if validateProfileRoots(p) == nil {
			t.Fatalf("nested or noncanonical root admitted: %s", bad)
		}
	}
}
