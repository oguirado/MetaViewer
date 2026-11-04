package capsule

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

var graphicalEnvironmentKeys = []string{"MV_GRAPHICAL_SESSION_ENABLED", "SRF_GRAPHICAL_VM_ENTRY", "SRF_GRAPHICAL_VM_ENTRY_SHA256", "SRF_GRAPHICAL_QEMU_IMG", "SRF_GRAPHICAL_QEMU_IMG_SHA256"}

// These are trusted launch settings, never a renderer- or request-owned path.
func validateGraphicalEnvironment(values []string) error {
	keys := map[string]string{}
	for _, item := range values {
		k, v, _ := strings.Cut(item, "=")
		for _, name := range graphicalEnvironmentKeys {
			if k == name {
				keys[k] = v
			}
		}
	}
	if len(keys) == 0 {
		return nil
	}
	bad := func() error {
		return fault("configuration", "complete pinned graphical VM entry configuration required")
	}
	if len(keys) != len(graphicalEnvironmentKeys) || keys["MV_GRAPHICAL_SESSION_ENABLED"] != "1" {
		return bad()
	}
	for _, key := range []string{"SRF_GRAPHICAL_VM_ENTRY", "SRF_GRAPHICAL_QEMU_IMG"} {
		if err := validateGraphicalExecutable(keys[key], keys[key+"_SHA256"]); err != nil {
			return err
		}
	}
	return nil
}

func validateGraphicalExecutable(path, expectedSHA string) error {
	bad := func() error { return fault("configuration", "canonical pinned graphical executable required") }
	if !digest.MatchString(expectedSHA) {
		return bad()
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return bad()
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || canonical != path {
		return bad()
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return bad()
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Mode().Perm()&0022 != 0 || before.Mode().Perm()&0111 == 0 || before.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 {
		return bad()
	}
	owner, ok := before.Sys().(*syscall.Stat_t)
	if !ok || owner.Nlink != 1 || (owner.Uid != 0 && owner.Uid != uint32(os.Getuid())) {
		return bad()
	}
	var magic [4]byte
	if _, err = f.ReadAt(magic[:], 0); err != nil || string(magic[:]) != "\x7fELF" {
		return bad()
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil || hex.EncodeToString(h.Sum(nil)) != expectedSHA {
		return bad()
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return bad()
	}
	return nil
}
