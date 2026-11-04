package ipc

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAdditiveCorpusCannotHideLegacyLossOrChangedExtension(t *testing.T) {
	source := "../../../contracts/examples/v0.2"
	dir := t.TempDir()
	entries, err := os.ReadDir(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		raw, err := os.ReadFile(filepath.Join(source, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, entry.Name()), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	check := func() error {
		_, err := verifyContractFixtureCorpus(dir, "../../../contracts/v0.2")
		return err
	}
	if err := check(); err != nil {
		t.Fatal("unmodified corpus refused", err)
	}
	var added string
	for name := range additiveFixturePins {
		added = name
		break
	}
	if added == "" {
		t.Fatal("empty additive manifest")
	}
	path := filepath.Join(dir, added)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if check() == nil {
		t.Fatal("changed additive fixture admitted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if check() == nil {
		t.Fatal("missing additive fixture admitted")
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "surface_request.invalid.origin_unknown.json")); err != nil {
		t.Fatal(err)
	}
	if check() == nil {
		t.Fatal("additive examples concealed loss of required legacy fixture")
	}
}
