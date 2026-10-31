package daemon

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

type docProfileNoopRunner struct{}

func (docProfileNoopRunner) Run(_ context.Context, _ []string, _ []byte) ([]byte, error) {
	return nil, nil
}

func repoRootFromTestFile(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

var (
	fencedJSONBlockRe    = regexp.MustCompile("(?s)```json\\s*\n(.*?)\n\\s*```")
	exportProfilesLineRe = regexp.MustCompile(`(?m)^\s*export\s+MV_SRF_PROFILES='([^']+)'\s*$`)
	dropWidthFieldRe     = regexp.MustCompile(`"Width"\s*:\s*\d+\s*,?\s*`)
)

// extractMVSRFProfilesJSONBlocks returns every fenced json block (and any
// shell export MV_SRF_PROFILES='...' payload) that follows an occurrence of
// MV_SRF_PROFILES in the given markdown document.
func extractMVSRFProfilesJSONBlocks(docText string) []string {
	idx := strings.Index(docText, "MV_SRF_PROFILES")
	if idx < 0 {
		return nil
	}
	tail := docText[idx:]
	var blocks []string
	for _, m := range fencedJSONBlockRe.FindAllStringSubmatch(tail, -1) {
		if strings.Contains(m[1], "mv-live-1") {
			blocks = append(blocks, strings.TrimSpace(m[1]))
		}
	}
	for _, m := range exportProfilesLineRe.FindAllStringSubmatch(tail, -1) {
		blocks = append(blocks, strings.TrimSpace(m[1]))
	}
	return blocks
}

func validateMVSRFProfilesJSON(t *testing.T, raw string) (map[string]capsule.Profile, error) {
	t.Helper()
	profiles := map[string]capsule.Profile{}
	if err := decodeProfiles(raw, &profiles); err != nil {
		return nil, configuration("invalid MV_SRF_PROFILES: " + err.Error())
	}
	_, err := capsule.NewManager(capsule.Config{
		BinDir:         t.TempDir(),
		Profiles:       profiles,
		MaxSurfaces:    16,
		MaxOutputBytes: 8192,
		Timeout:        time.Second,
		OriginNS:       1,
	}, docProfileNoopRunner{}, func() uint64 { return 1 })
	if err != nil {
		return nil, err
	}
	return profiles, nil
}

func assertFourLiveBrowserProfiles(t *testing.T, doc string, profiles map[string]capsule.Profile) {
	t.Helper()
	const wantRoot = "/dev/shm/vqa-ramws/opensuperficies/os-cu-0"
	wantDisplays := map[string]string{
		"mv-live-1": ":100",
		"mv-live-2": ":101",
		"mv-live-3": ":102",
		"mv-live-4": ":103",
	}
	if len(profiles) != len(wantDisplays) {
		t.Fatalf("%s: got %d profiles, want %d", doc, len(profiles), len(wantDisplays))
	}
	for id, wantDisplay := range wantDisplays {
		p, ok := profiles[id]
		if !ok {
			t.Fatalf("%s: missing profile %q", doc, id)
		}
		if p.Kind != "browser" || p.NativeKind != "browser" || p.RAMRoot != wantRoot || p.Display != wantDisplay || p.Width != 1280 || p.Height != 900 || p.TextInput != "paste" {
			t.Fatalf("%s: profile %q mismatch: %+v", doc, id, p)
		}
	}
}

func TestDocumentedMVSRFProfiles(t *testing.T) {
	root := repoRootFromTestFile(t)
	docs := []string{
		filepath.Join("docs", "MULTI_CAPSULE.md"),
		filepath.Join("docs", "INSTALL.md"),
		filepath.Join("docs", "USER_GUIDE.md"),
	}
	for _, relPath := range docs {
		t.Run(relPath, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(root, relPath))
			if err != nil {
				t.Fatalf("read %s: %v", relPath, err)
			}
			blocks := extractMVSRFProfilesJSONBlocks(string(data))
			if len(blocks) == 0 {
				t.Fatalf("%s: no MV_SRF_PROFILES JSON block found", relPath)
			}
			for i, block := range blocks {
				profiles, err := validateMVSRFProfilesJSON(t, block)
				if err != nil {
					t.Fatalf("%s block[%d] refused: %v", relPath, i, err)
				}
				assertFourLiveBrowserProfiles(t, relPath, profiles)

				// Mutant 1: rename text_input to TextInput -> must fail decodeProfiles.
				mutantTextInput := strings.Replace(block, `"text_input"`, `"TextInput"`, 1)
				if mutantTextInput == block {
					t.Fatalf("%s block[%d]: missing \"text_input\" key to mutate", relPath, i)
				}
				if _, err := validateMVSRFProfilesJSON(t, mutantTextInput); err == nil {
					t.Fatalf("%s block[%d]: TextInput mutant unexpectedly accepted", relPath, i)
				}

				// Mutant 2: drop Width -> must fail NewManager profile validation.
				mutantNoWidth := dropWidthFieldRe.ReplaceAllString(block, "")
				if mutantNoWidth == block {
					t.Fatalf("%s block[%d]: missing \"Width\" field to mutate", relPath, i)
				}
				if _, err := validateMVSRFProfilesJSON(t, mutantNoWidth); err == nil {
					t.Fatalf("%s block[%d]: missing-Width mutant unexpectedly accepted", relPath, i)
				}
			}
		})
	}
}

func TestFourProfileSharedRAMRootAndDistinctDisplays(t *testing.T) {
	root := repoRootFromTestFile(t)
	data, err := os.ReadFile(filepath.Join(root, "docs", "MULTI_CAPSULE.md"))
	if err != nil {
		t.Fatal(err)
	}
	blocks := extractMVSRFProfilesJSONBlocks(string(data))
	if len(blocks) == 0 {
		t.Fatal("docs/MULTI_CAPSULE.md: no MV_SRF_PROFILES JSON block found")
	}
	profiles, err := validateMVSRFProfilesJSON(t, blocks[0])
	if err != nil {
		t.Fatalf("four-profile example refused: %v", err)
	}
	assertFourLiveBrowserProfiles(t, "docs/MULTI_CAPSULE.md", profiles)

	// Verify shared canonical existing RAMRoot acceptance under validateProfileRoots and NewManager.
	sharedRAM, err := os.MkdirTemp("/dev/shm", "mv-e4prof-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sharedRAM) })
	liveProfiles := make(map[string]capsule.Profile, len(profiles))
	for id, p := range profiles {
		p.RAMRoot = sharedRAM
		liveProfiles[id] = p
	}
	if err := validateProfileRoots(liveProfiles); err != nil {
		t.Fatalf("shared canonical RAM root refused by validateProfileRoots: %v", err)
	}
	if _, err := capsule.NewManager(capsule.Config{
		BinDir:         t.TempDir(),
		Profiles:       liveProfiles,
		MaxSurfaces:    16,
		MaxOutputBytes: 8192,
		Timeout:        time.Second,
		OriginNS:       1,
	}, docProfileNoopRunner{}, func() uint64 { return 1 }); err != nil {
		t.Fatalf("shared canonical RAM root with distinct displays refused by NewManager: %v", err)
	}

	// Refuse two profiles on the same display.
	collision := make(map[string]capsule.Profile, len(liveProfiles))
	for id, p := range liveProfiles {
		collision[id] = p
	}
	dup := collision["mv-live-2"]
	dup.Display = collision["mv-live-1"].Display
	collision["mv-live-2"] = dup
	_, err = capsule.NewManager(capsule.Config{
		BinDir:         t.TempDir(),
		Profiles:       collision,
		MaxSurfaces:    16,
		MaxOutputBytes: 8192,
		Timeout:        time.Second,
		OriginNS:       1,
	}, docProfileNoopRunner{}, func() uint64 { return 1 })
	if err == nil || !strings.Contains(err.Error(), "distinct profile displays required") {
		t.Fatalf("duplicate display accepted or wrong error: %v", err)
	}
}
