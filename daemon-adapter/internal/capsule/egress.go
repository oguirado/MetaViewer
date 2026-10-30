package capsule

// [TARGET, unit decision] Egress is keyed by the admitted profile identity before
// native start. Only browser profiles use it. Missing records mean open; malformed
// records never do. Limits: 64 KiB per file and 256 exact ASCII hostnames.
import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const egressSchema = "metaviewer.capsule_egress/v1"
const egressLimit = 64 << 10

type Egress struct {
	Schema  string   `json:"schema"`
	Mode    string   `json:"mode"`
	Domains []string `json:"domains"`
}

func (e Egress) Validate() error {
	if e.Schema != egressSchema || (e.Mode != "open" && e.Mode != "allowlisted") || (e.Mode == "open" && len(e.Domains) != 0) || (e.Mode == "allowlisted" && (len(e.Domains) < 1 || len(e.Domains) > 256)) {
		return fault("NET_EGRESS_INVALID", "invalid egress schema, mode or domain count")
	}
	seen := map[string]bool{}
	for _, h := range e.Domains {
		if !exactHostname(h) || seen[h] {
			return fault("NET_DOMAIN_INVALID", "domains must be unique normalized exact ASCII hostnames")
		}
		seen[h] = true
	}
	return nil
}
func exactHostname(h string) bool {
	if !strings.Contains(h, ".") || len(h) > 253 || h != strings.ToLower(h) || net.ParseIP(h) != nil {
		return false
	}
	for _, suffix := range []string{"localhost", "local", "internal", "lan", "home.arpa"} {
		if h == suffix || strings.HasSuffix(h, "."+suffix) {
			return false
		}
	}
	for _, label := range strings.Split(h, ".") {
		if strings.HasPrefix(label, "0x") && strings.Trim(label[2:], "0123456789abcdef") == "" {
			return false
		}
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	// Reject alternate numeric address forms as well as canonical IPs.
	return strings.IndexFunc(h, func(c rune) bool { return c >= 'a' && c <= 'z' }) >= 0
}

// Hold each directory descriptor while walking; never follow any symlink.
func egressDirectory(state string, create bool) (*os.File, error) {
	if !filepath.IsAbs(state) || filepath.Clean(state) != state {
		return nil, syscall.EINVAL
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	parts := append(strings.Split(strings.TrimPrefix(state, "/"), "/"), "egress")
	for i, part := range parts {
		if create && i == len(parts)-1 {
			if err = syscall.Mkdirat(fd, part, 0700); err != nil && err != syscall.EEXIST {
				syscall.Close(fd)
				return nil, err
			}
		}
		next, e := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		syscall.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
		if i >= len(parts)-2 {
			var st syscall.Stat_t
			if e = syscall.Fstat(fd, &st); e != nil || st.Uid != uint32(os.Getuid()) || st.Mode != syscall.S_IFDIR|0700 {
				syscall.Close(fd)
				return nil, syscall.EACCES
			}
		}
	}
	return os.NewFile(uintptr(fd), filepath.Join(state, "egress")), nil
}
func readEgressFile(dir *os.File, name string) ([]byte, error) {
	return readPrivateEgressFile(dir, name, 0600)
}
func readPrivateEgressFile(dir *os.File, name string, mode os.FileMode) ([]byte, error) {
	fd, err := syscall.Openat(int(dir.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || st.Mode() != mode || st.Size() > egressLimit {
		return nil, syscall.EACCES
	}
	b, err := io.ReadAll(io.LimitReader(f, egressLimit+1))
	if len(b) > egressLimit {
		return nil, syscall.EFBIG
	}
	return b, err
}
func LoadEgress(state, identity string) (Egress, error) {
	empty := Egress{Schema: egressSchema, Mode: "open", Domains: []string{}}
	if !profileID.MatchString(identity) {
		return Egress{}, fault("NET_EGRESS_INVALID", "invalid egress identity")
	}
	dir, err := egressDirectory(state, false)
	if errors.Is(err, syscall.ENOENT) {
		return empty, nil
	}
	if err != nil {
		return Egress{}, fault("NET_EGRESS_IO", err.Error())
	}
	defer dir.Close()
	b, err := readEgressFile(dir, identity+".json")
	if errors.Is(err, syscall.ENOENT) {
		return empty, nil
	}
	if err != nil {
		return Egress{}, fault("NET_EGRESS_IO", err.Error())
	}
	var e Egress
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&e); err != nil {
		return Egress{}, fault("NET_EGRESS_INVALID", err.Error())
	}
	if err = dec.Decode(new(any)); err != io.EOF {
		return Egress{}, fault("NET_EGRESS_INVALID", "trailing JSON")
	}
	return e, e.Validate()
}
func writeEgressFile(state, name string, value any) (string, error) {
	return writePrivateEgressFile(state, name, value, 0600)
}
func writePrivateEgressFile(state, name string, value any, mode os.FileMode) (string, error) {
	b, err := json.Marshal(value)
	if err != nil || len(b) > egressLimit {
		return "", fault("NET_EGRESS_INVALID", "oversized egress document")
	}
	dir, err := egressDirectory(state, true)
	if err != nil {
		return "", fault("NET_EGRESS_IO", err.Error())
	}
	defer dir.Close()
	// Existing special files, links or permissive files are refused, not replaced.
	if _, err = readPrivateEgressFile(dir, name, mode); err != nil && !errors.Is(err, syscall.ENOENT) {
		return "", fault("NET_EGRESS_IO", err.Error())
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return "", err
	}
	tmp := ".egress-" + hex.EncodeToString(nonce[:])
	fd, err := syscall.Openat(int(dir.Fd()), tmp, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, uint32(mode))
	if err != nil {
		return "", fault("NET_EGRESS_IO", err.Error())
	}
	defer syscall.Unlinkat(int(dir.Fd()), tmp)
	f := os.NewFile(uintptr(fd), tmp)
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = syscall.Renameat(int(dir.Fd()), tmp, int(dir.Fd()), name)
	}
	if err == nil {
		err = dir.Sync()
	}
	if err != nil {
		return "", fault("NET_EGRESS_IO", err.Error())
	}
	return filepath.Join(state, "egress", name), nil
}
func StoreEgress(state, identity string, e Egress) error {
	if !profileID.MatchString(identity) {
		return fault("NET_EGRESS_INVALID", "invalid egress identity")
	}
	if err := e.Validate(); err != nil {
		return err
	}
	_, err := writeEgressFile(state, identity+".json", e)
	return err
}
