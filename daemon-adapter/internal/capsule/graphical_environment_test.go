package capsule

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGraphicalEnvironmentPinsAndDefault(t *testing.T) {
	if err := validateGraphicalEnvironment(nil); err != nil {
		t.Fatal("default absence changed", err)
	}
	dir := t.TempDir()
	data := append([]byte{0x7f, 'E', 'L', 'F'}, []byte("fixture-not-executed")...)
	sum := sha256.Sum256(data)
	paths := []string{filepath.Join(dir, "entry"), filepath.Join(dir, "qemu-img")}
	for _, path := range paths {
		if err := os.WriteFile(path, data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	good := []string{"MV_GRAPHICAL_SESSION_ENABLED=1", "SRF_GRAPHICAL_VM_ENTRY=" + paths[0], "SRF_GRAPHICAL_VM_ENTRY_SHA256=" + hex.EncodeToString(sum[:]), "SRF_GRAPHICAL_QEMU_IMG=" + paths[1], "SRF_GRAPHICAL_QEMU_IMG_SHA256=" + hex.EncodeToString(sum[:])}
	if err := validateGraphicalEnvironment(good); err != nil {
		t.Fatal("complete valid pins refused", err)
	}
	for i, item := range good {
		key, _, _ := strings.Cut(item, "=")
		t.Run("missing-"+key, func(t *testing.T) {
			bad := append([]string{}, good[:i]...)
			bad = append(bad, good[i+1:]...)
			if err := validateGraphicalEnvironment(bad); err == nil {
				t.Fatal("partial pin set accepted")
			}
		})
	}
	for slot, path := range paths {
		idx := 1 + slot*2
		for _, mutation := range []string{"hash", "relative", "symlink", "writable", "hardlink", "non-elf", "non-executable"} {
			t.Run(filepath.Base(path)+"/"+mutation, func(t *testing.T) {
				bad := append([]string{}, good...)
				switch mutation {
				case "hash":
					key, _, _ := strings.Cut(good[idx+1], "=")
					bad[idx+1] = key + "=" + strings.Repeat("0", 64)
				case "relative":
					key, _, _ := strings.Cut(good[idx], "=")
					bad[idx] = key + "=relative-bin"
				case "symlink":
					link := path + "-symlink"
					if err := os.Symlink(path, link); err != nil {
						t.Fatal(err)
					}
					defer os.Remove(link)
					key, _, _ := strings.Cut(good[idx], "=")
					bad[idx] = key + "=" + link
				case "writable":
					if err := os.Chmod(path, 0722); err != nil {
						t.Fatal(err)
					}
					defer os.Chmod(path, 0700)
				case "non-executable":
					if err := os.Chmod(path, 0600); err != nil {
						t.Fatal(err)
					}
					defer os.Chmod(path, 0700)
				case "hardlink":
					link := path + "-hard"
					if err := os.Link(path, link); err != nil {
						t.Fatal(err)
					}
					defer os.Remove(link)
				case "non-elf":
					payload := []byte("not an ELF")
					if err := os.WriteFile(path, payload, 0700); err != nil {
						t.Fatal(err)
					}
					defer os.WriteFile(path, data, 0700)
					changed := sha256.Sum256(payload)
					key, _, _ := strings.Cut(good[idx+1], "=")
					bad[idx+1] = key + "=" + hex.EncodeToString(changed[:])
				}
				if err := validateGraphicalEnvironment(bad); err == nil {
					t.Fatal("unsafe binary pin admitted")
				}
			})
		}
	}
	bad := append([]string{}, good...)
	bad[0] = "MV_GRAPHICAL_SESSION_ENABLED=0"
	if err := validateGraphicalEnvironment(bad); err == nil {
		t.Fatal("disabled flag admitted as complete pins")
	}
	if err := validateGraphicalEnvironment(good); err != nil {
		t.Fatal("negative controls failed to restore valid pins", err)
	}
}
