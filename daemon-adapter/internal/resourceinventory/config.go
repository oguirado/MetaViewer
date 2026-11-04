package resourceinventory

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

type Pin struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type Config struct {
	Schema              string            `json:"schema"`
	Journal             string            `json:"journal"`
	Root                string            `json:"root"`
	RunID               string            `json:"run_id"`
	Actor               string            `json:"actor"`
	SourceCommit        string            `json:"source_commit"`
	ASAR                string            `json:"asar_sha256"`
	SessionHelper       string            `json:"session_helper_sha256"`
	SetupHelper         string            `json:"setup_helper_sha256"`
	ProducerPins        map[string]Pin    `json:"producer_pins"`
	Manifest            Pin               `json:"package_manifest"`
	Registry            string            `json:"registry_sha256"`
	Images              map[string]string `json:"images"`
	IdentityProvisioner *Pin              `json:"identity_provisioner,omitempty"`
}

var serviceUnit = regexp.MustCompile(`^mv-guest-command-[0-9a-f]{16,64}\.service$`)

func canonical(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.HasPrefix(path, "//") {
		return fail("canonical absolute path")
	}
	real, e := filepath.EvalSymlinks(path)
	if e != nil {
		return e
	}
	if real != path {
		return fail("path alias")
	}
	return nil
}
func statInfo(f *os.File) (syscall.Stat_t, error) {
	var s syscall.Stat_t
	e := syscall.Fstat(int(f.Fd()), &s)
	return s, e
}
func regular(s syscall.Stat_t, private bool) bool {
	return s.Mode&syscall.S_IFMT == syscall.S_IFREG && s.Nlink == 1 && (s.Uid == 0 || s.Uid == uint32(os.Getuid())) && s.Mode&0022 == 0 && (!private || s.Uid == uint32(os.Getuid()) && s.Mode&07777 == 0600)
}
func statSame(a, b syscall.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func readProtected(path string, limit int64, private bool) ([]byte, error) {
	if e := canonical(path); e != nil {
		return nil, e
	}
	var before syscall.Stat_t
	if e := syscall.Lstat(path, &before); e != nil {
		return nil, e
	}
	fd, e := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	s, e := statInfo(f)
	if e != nil || !regular(s, private) || s.Size > limit || !statSame(before, s) {
		return nil, fail("protected regular file required")
	}
	raw, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e != nil {
		return nil, e
	}
	after, e := statInfo(f)
	var now syscall.Stat_t
	le := syscall.Lstat(path, &now)
	if e != nil || le != nil || int64(len(raw)) > limit || !statSame(s, after) || !statSame(s, now) {
		return nil, fail("file changed")
	}
	return raw, nil
}
func verifyPin(p Pin) error {
	if !hexLen(p.SHA256, 64) {
		return fail("explicit artifact SHA256 required")
	}
	raw, e := readProtected(p.Path, 1<<30, false)
	if e != nil {
		return e
	}
	if hash(raw) != p.SHA256 {
		return fail("artifact pin mismatch")
	}
	return nil
}
func (c Config) unit() string { return "metaviewer-arm64-" + c.RunID + ".scope" }
func (c Config) profile(kind string) string {
	if kind == "vm" {
		return "mv-arm64-" + c.RunID
	}
	if kind == "browser" || kind == "program" {
		return "arm64-" + kind + "-" + c.RunID
	}
	return ""
}
func validProgramProfile(id string) bool {
	return regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,39}$`).MatchString(id) && !strings.HasPrefix(id, "srf-id-cuentas-") && !strings.HasPrefix(id, "srf-id-perplexity-") && !strings.HasPrefix(id, "srf-pg-")
}
func (c Config) allowsProfile(kind, id string) bool {
	if kind == "program" {
		return validProgramProfile(id)
	}
	return c.profile(kind) != "" && id == c.profile(kind)
}
func (c Config) header(st syscall.Stat_t) map[string]any {
	return map[string]any{"stage": "session", "producer": "setup", "run_id": c.RunID, "actor": c.Actor, "unit": c.unit(), "root_device": st.Dev, "root_inode": st.Ino, "source_commit": c.SourceCommit, "asar_sha256": c.ASAR, "session_helper_sha256": c.SessionHelper, "setup_helper_sha256": c.SetupHelper, "producer_pins": c.ProducerPins, "package_manifest": c.Manifest, "registry_sha256": c.Registry}
}
func loadConfig(path string) (Config, error) {
	var c Config
	raw, e := readProtected(path, 65536, true)
	if e != nil {
		return c, e
	}
	if e = decode(raw, &c); e != nil {
		return c, e
	}
	var shape map[string]any
	if e = decode(raw, &shape); e != nil {
		return c, e
	}
	if value, present := shape["identity_provisioner"]; present && value == nil {
		return c, fail("null auxiliary pin")
	}
	if c.Schema != "arm64-resource-inventory-config/v1" || !hexLen(c.RunID, 24) || !hexLen(c.SourceCommit, 40) || !hexLen(c.ASAR, 64) || !hexLen(c.SessionHelper, 64) || !hexLen(c.SetupHelper, 64) || !hexLen(c.Registry, 64) || c.Actor != "actor-"+hash([]byte("agent:agent-arm64-"+c.RunID)) {
		return c, fail("configuration identity")
	}
	if c.Journal != filepath.Join(c.Root, "allocations.jsonl") || path != filepath.Join(c.Root, "inventory-config.json") || !strings.HasPrefix(filepath.Base(c.Root), "metaviewer-arm64-"+c.RunID+"-") || !strings.HasPrefix(c.Root, "/dev/shm/") {
		return c, fail("configuration root")
	}
	if len(c.ProducerPins) != 3 {
		return c, fail("producer pin set")
	}
	for _, n := range []string{"setup", "graphical", "guestcommand"} {
		if _, ok := c.ProducerPins[n]; !ok {
			return c, fail("producer missing")
		}
	}
	if c.ProducerPins["setup"].SHA256 != c.SessionHelper || c.ProducerPins["graphical"] != c.ProducerPins["guestcommand"] {
		return c, fail("producer source binding")
	}
	if c.Images["browser"] != "" && c.IdentityProvisioner == nil {
		return c, fail("browser identity provisioner pin required")
	}
	if c.IdentityProvisioner != nil {
		if filepath.Base(c.IdentityProvisioner.Path) != "mv_identity.py" {
			return c, fail("identity provisioner path")
		}
		if e := verifyPin(*c.IdentityProvisioner); e != nil {
			return c, e
		}
	}
	if c.Images["vm"] == "" || len(c.Images) > 3 {
		return c, fail("image set")
	}
	for k, v := range c.Images {
		if c.profile(k) == "" || !strings.HasPrefix(v, "sha256:") || !hexLen(strings.TrimPrefix(v, "sha256:"), 64) {
			return c, fail("image pin")
		}
	}
	return c, nil
}
func (c Config) verifyDescriptor() error {
	raw, e := readProtected(filepath.Join(c.Root, "setup.json"), 65536, true)
	if e != nil {
		return e
	}
	if hash(raw) != c.Registry {
		return fail("registry digest")
	}
	var d map[string]any
	if e = decode(raw, &d); e != nil {
		return e
	}
	pkg := object(d["package"])
	var asar Pin
	b, _ := json.Marshal(pkg["asar"])
	if e = decode(b, &asar); e != nil {
		return e
	}
	if text(d, "source_commit") != c.SourceCommit || asar.SHA256 != c.ASAR || !same(d["producer_pins"], c.ProducerPins) || !same(d["package_manifest"], c.Manifest) {
		return fail("descriptor policy binding")
	}
	var aux any
	if c.IdentityProvisioner != nil {
		aux = c.IdentityProvisioner
	}
	if !same(d["identity_provisioner"], aux) {
		return fail("descriptor auxiliary binding")
	}
	expectedImages := map[string]string{"vm": text(d, "vm_image")}
	for k, v := range object(d["normal_profiles"]) {
		expectedImages[k] = text(object(v), "image_id")
	}
	if !same(expectedImages, c.Images) {
		return fail("descriptor images")
	}
	pins := []Pin{asar, c.Manifest, {Path: filepath.Join(filepath.Dir(c.ProducerPins["setup"].Path), "arm64_capsules.py"), SHA256: c.SetupHelper}}
	for _, v := range c.ProducerPins {
		pins = append(pins, v)
	}
	// Every supplied descriptor artifact is independently pinned. No private source
	// is read: these are packaged binaries, public helpers and operator assets.
	values := []any{pkg["app"], d["python"], d["runner"], d["reconciler"]}
	for _, key := range []string{"native", "artifacts"} {
		for _, v := range object(d[key]) {
			values = append(values, v)
		}
	}
	if files, ok := d["files"].([]any); ok {
		for _, v := range files {
			m := object(v)
			values = append(values, map[string]any{"path": m["path"], "sha256": m["sha256"]})
		}
	} else {
		return fail("descriptor source closure")
	}
	for _, v := range values {
		var p Pin
		b, e := json.Marshal(v)
		if e != nil {
			return e
		}
		if e = decode(b, &p); e != nil {
			return e
		}
		pins = append(pins, p)
	}
	for _, p := range pins {
		if e = verifyPin(p); e != nil {
			return e
		}
	}
	return nil
}
func (p *Producer) checkRoot() error {
	var actual syscall.Stat_t
	if e := syscall.Lstat(p.cfg.Root, &actual); e != nil {
		return e
	}
	fd, e := statInfo(p.root)
	if e != nil || actual.Dev != p.rootStat.Dev || actual.Ino != p.rootStat.Ino || actual.Mode&syscall.S_IFMT != syscall.S_IFDIR || actual.Mode&0777 != 0700 || actual.Uid != uint32(os.Getuid()) || fd.Dev != actual.Dev || fd.Ino != actual.Ino {
		return fail("inventory root replaced")
	}
	for name, f := range map[string]*os.File{"allocations.jsonl": p.journal, "allocations.lock": p.lock} {
		var now syscall.Stat_t
		if e := syscall.Lstat(filepath.Join(p.cfg.Root, name), &now); e != nil {
			return e
		}
		bound, e := statInfo(f)
		if e != nil || !regular(now, true) || !regular(bound, true) || now.Dev != bound.Dev || now.Ino != bound.Ino {
			return fail("inventory file replaced")
		}
	}
	return nil
}
func OpenFromEnv(name string) (*Producer, error) {
	if os.Getenv("MV_ARM64_CAPSULES") != "1" {
		return nil, nil
	}
	path := os.Getenv("MV_ARM64_INVENTORY_CONFIG")
	if path == "" {
		return nil, fail("protected configuration required")
	}
	c, e := loadConfig(path)
	if e != nil {
		return nil, e
	}
	if name != "graphical" && name != "guestcommand" {
		return nil, fail("producer identity")
	}
	if e = c.verifyDescriptor(); e != nil {
		return nil, e
	}
	exe, e := os.Executable()
	if e != nil {
		return nil, e
	}
	if e = canonical(exe); e != nil {
		return nil, e
	}
	if c.ProducerPins[name].Path != exe {
		return nil, fail("producer executable path")
	}
	return open(c, name, true)
}
func open(c Config, name string, checkHost bool) (p *Producer, err error) {
	if e := canonical(c.Root); e != nil {
		return nil, e
	}
	fd, e := syscall.Open(c.Root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	p = &Producer{cfg: c, name: name, root: os.NewFile(uintptr(fd), c.Root), syncFile: func(f *os.File) error { return f.Sync() }}
	allocated := p
	defer func() {
		if err != nil {
			for _, f := range []*os.File{allocated.root, allocated.lock, allocated.journal, allocated.lease} {
				if f != nil {
					_ = f.Close()
				}
			}
		}
	}()
	p.rootStat, e = statInfo(p.root)
	if e != nil || p.rootStat.Mode&0777 != 0700 || p.rootStat.Uid != uint32(os.Getuid()) {
		return nil, fail("private root required")
	}
	openAt := func(name string, flags int) (*os.File, error) {
		fd, e := syscall.Openat(int(p.root.Fd()), name, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0600)
		if e != nil {
			return nil, e
		}
		f := os.NewFile(uintptr(fd), name)
		s, e := statInfo(f)
		if e != nil || !regular(s, true) {
			f.Close()
			return nil, fail("private ledger file")
		}
		return f, nil
	}
	if p.lock, e = openAt("allocations.lock", syscall.O_RDWR); e != nil {
		return nil, e
	}
	if p.journal, e = openAt("allocations.jsonl", syscall.O_RDWR|syscall.O_APPEND); e != nil {
		return nil, e
	}
	if e = p.checkRoot(); e != nil {
		return nil, e
	}
	raw, e := io.ReadAll(io.LimitReader(p.journal, maxJournal+1))
	if e != nil {
		return nil, e
	}
	h, e := parseHistory(c, raw, p.rootStat)
	if e != nil {
		return nil, e
	}
	if len(h.Rows) == 0 || h.Sealed[name] || h.Coordinator || h.Guardian == nil || h.App == nil || h.App["bound"] == nil {
		return nil, fail("setup admission absent")
	}
	if checkHost {
		if e = checkGuardian(h.Guardian, c.unit()); e != nil {
			return nil, e
		}
	}
	p.lease, e = openAt("producer-"+name+".lock", syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL)
	if e != nil {
		return nil, fail("producer already attempted")
	}
	if e = syscall.Flock(int(p.lease.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return nil, e
	}
	if e = p.syncFile(p.root); e != nil {
		return nil, e
	}
	return p, nil
}
func checkGuardian(g map[string]any, unit string) error {
	raw, e := os.ReadFile("/proc/self/cgroup")
	if e != nil {
		return e
	}
	group := strings.TrimSpace(string(raw))
	if group != "0::"+text(g, "cgroup") || !validGroup(text(g, "cgroup"), unit) {
		return fail("producer outside guardian")
	}
	root := "/sys/fs/cgroup" + text(g, "cgroup")
	s, e := os.Stat(root)
	if e != nil {
		return e
	}
	st := s.Sys().(*syscall.Stat_t)
	dev, e := number(g["device"])
	if e != nil {
		return e
	}
	ino, e := number(g["inode"])
	if e != nil || st.Dev != dev || st.Ino != ino {
		return fail("guardian inode")
	}
	for name, value := range map[string]string{"memory.high": "6442450944", "memory.max": "8589934592", "memory.swap.max": "0"} {
		b, e := os.ReadFile(filepath.Join(root, name))
		if e != nil || strings.TrimSpace(string(b)) != value {
			return fail("guardian memory limits")
		}
	}
	b, e := os.ReadFile(filepath.Join(root, "cpu.max"))
	var quota, period uint64
	if e != nil {
		return e
	}
	if _, e = fmt.Fscan(bytes.NewReader(b), &quota, &period); e != nil || quota == 0 || period == 0 || quota > period*2 {
		return fail("guardian CPU limits")
	}
	return nil
}
