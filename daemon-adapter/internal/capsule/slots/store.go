// Package slots stores stopped capsule data, not open tabs or process state.
// [TARGET, unit decision] Adapter-only API; callers must hold core authority.
// CheckStopped supplies native absence/login evidence under the native identity
// guard. HumanConfirmed means an explicit click acknowledging signed-in sessions
// travel. No default custody witness is supplied. Slot quotas include retained
// generations and orphans. Load backups remain under profiles for guarded GC;
// each load checks free space. GC and explicit recovery are separate actions.
// btrfs and WSL2 remain unqualified for power loss. No power-loss claim is made.
package slots

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const DefaultMaxBytes int64 = 4 << 30 // [TARGET] total retained slot bytes.
const Version = 1

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,39}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var SaveSteps = []string{"intent", "staging", "payload", "manifest", "generation", "generation-sync", "ref-file", "ref-rename", "ref-sync", "complete"}
var LoadSteps = []string{"load-intent", "load-extract", "load-prepared", "load-exchange", "load-sync", "load-complete"}

type Config struct {
	Root, Image, LiveProfile string
	MaxBytes                 int64
	CheckStopped             func(context.Context, string) error
	Failpoint                func(string) error
}
type Request struct {
	SlotID, ProfileID, Kind, Architecture, Image string
	SourceProfileID                              string
	HumanConfirmed                               bool
	CreateOnly, OverwriteOnly                    bool
}
type Manifest struct {
	SavedAt       string `json:"saved_at,omitempty"`
	Version       int    `json:"version"`
	Generation    uint64 `json:"generation"`
	ProfileID     string `json:"profile_id"`
	Kind          string `json:"kind"`
	Architecture  string `json:"architecture"`
	Image         string `json:"image"`
	PayloadSHA256 string `json:"payload_sha256"`
	PayloadBytes  int64  `json:"payload_bytes"`
	ExpandedBytes int64  `json:"expanded_bytes"`
	Entries       int64  `json:"entries"`
	Digest        string `json:"-"`
}
type reference struct {
	Version    int    `json:"version"`
	Generation uint64 `json:"generation"`
	Digest     string `json:"digest"`
	Self       string `json:"self"`
}
type intent struct {
	Operation string `json:"operation"`
	Profile   string `json:"profile"`
	Stage     string `json:"stage"`
	Before    uint64 `json:"before"`
	Prepared  uint64 `json:"prepared"`
}
type receipt struct {
	Hash     string `json:"hash"`
	Bytes    int64  `json:"bytes"`
	Expanded int64  `json:"expanded"`
	Entries  int64  `json:"entries"`
}
type helperFunc func(context.Context, string, string, string, int64) (receipt, error)
type Store struct {
	// [TARGET, unit decision] Dialog listings share slot guards across profiles.
	// Serialize readers so they cannot spuriously refuse each other as SLOT_BUSY.
	listMu     sync.Mutex
	cfg        Config
	helper     helperFunc
	profileUID uint32
}

func New(c Config) (*Store, error) {
	if c.Root == "" {
		c.Root = os.Getenv("SRF_IDENTITY_STORE_ROOT")
	}
	if !filepath.IsAbs(c.Root) || c.Image == "" || c.CheckStopped == nil {
		return nil, errors.New("SLOT_CONFIGURATION_REQUIRED")
	}
	if strings.ContainsAny(c.Root, ",\n\r") {
		return nil, errors.New("UNSAFE_PATH")
	}
	if c.MaxBytes == 0 {
		c.MaxBytes = DefaultMaxBytes
	}
	if c.MaxBytes < 1 {
		return nil, errors.New("SLOT_QUOTA")
	}
	clean := filepath.Clean(c.Root)
	real, e := filepath.EvalSymlinks(clean)
	if e != nil || real != clean {
		return nil, errors.New("UNSAFE_PATH")
	}
	c.Root = clean
	if e = privateDir(c.Root); e != nil {
		return nil, e
	}
	for _, d := range []string{"profiles", "metadata", "locks"} {
		if e = privateDir(filepath.Join(c.Root, d)); e != nil {
			return nil, e
		}
	}
	if e = mkdir(filepath.Join(c.Root, "slots")); e != nil {
		return nil, e
	}
	if _, e = filesystem(c.Root); e != nil {
		return nil, e
	}
	if e = syncDir(c.Root); e != nil {
		return nil, e
	}
	s := &Store{cfg: c, profileUID: 10001}
	s.helper = s.docker
	return s, nil
}
func fmtInt(n int64) string { return strconv.FormatInt(n, 10) }
func decode(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return errors.New("TRAILING_JSON")
	}
	return nil
}
func hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func privateDir(p string) error {
	st, e := os.Lstat(p)
	if e != nil {
		return e
	}
	if !st.IsDir() || st.Mode().Perm() != 0700 || st.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
		return errors.New("UNSAFE_DIRECTORY")
	}
	return nil
}
func mkdir(p string) error {
	e := os.Mkdir(p, 0700)
	if e != nil && !os.IsExist(e) {
		return e
	}
	return privateDir(p)
}
func filesystem(p string) (syscall.Statfs_t, error) {
	var s syscall.Statfs_t
	e := syscall.Statfs(p, &s)
	if e != nil {
		return s, e
	}
	switch uint64(s.Type) {
	case 0x01021997, 0x53464846, 0x65735546, 0x01021994:
		return s, errors.New("UNQUALIFIED_FILESYSTEM")
	}
	return s, nil
}
func syncDir(p string) error {
	f, e := os.Open(p)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
func writeSync(p string, b []byte) error {
	fd, e := syscall.Open(p, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return e
	}
	f := os.NewFile(uintptr(fd), p)
	defer f.Close()
	if _, e = f.Write(b); e != nil {
		return e
	}
	return f.Sync()
}
func read(p string) ([]byte, error) {
	fd, e := syscall.Open(p, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), p)
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || st.Size() > 65536 || st.Mode().Perm() != 0600 || st.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
		return nil, errors.New("UNSAFE_METADATA")
	}
	return io.ReadAll(io.LimitReader(f, 65537))
}
func (s *Store) step(p string) error {
	if s.cfg.Failpoint != nil {
		return s.cfg.Failpoint(p)
	}
	return nil
}
func (s *Store) slot(id string) string          { return filepath.Join(s.cfg.Root, "slots", id) }
func (s *Store) generation(id, d string) string { return filepath.Join(s.slot(id), "generations", d) }
func lock(p string) (func(), error) {
	fd, e := syscall.Open(p, syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), p)
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 {
		f.Close()
		return nil, errors.New("UNSAFE_GUARD")
	}
	if e = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("SLOT_BUSY")
	}
	return func() { f.Close() }, nil
}
func (s *Store) slotLock(id string) (func(), error) {
	if !idPattern.MatchString(id) {
		return nil, errors.New("INVALID_SLOT_ID")
	}
	if e := mkdir(s.slot(id)); e != nil {
		return nil, e
	}
	if e := mkdir(filepath.Join(s.slot(id), "generations")); e != nil {
		return nil, e
	}
	if e := syncDir(filepath.Join(s.cfg.Root, "slots")); e != nil {
		return nil, e
	}
	if e := syncDir(s.slot(id)); e != nil {
		return nil, e
	}
	return lock(filepath.Join(s.slot(id), "guard"))
}
func protected(id string) bool {
	for _, p := range []string{"mv-", "srf-id-cuentas-", "srf-id-perplexity-", "srf-pg-"} {
		if strings.HasPrefix(id, p) {
			return true
		}
	}
	return id == "srf-egress-proxy" || id == "n8n" || id == "distil-box"
}
func (s *Store) custody(ctx context.Context, r Request) (func(), error) {
	if !idPattern.MatchString(r.ProfileID) || protected(r.ProfileID) || r.ProfileID == s.cfg.LiveProfile {
		return nil, errors.New("IDENTITY_PROTECTED")
	}
	if !r.HumanConfirmed {
		return nil, errors.New("CREDENTIAL_COPY_CONFIRMATION_REQUIRED")
	}
	if (r.Kind != "browser" && r.Kind != "program") || r.Architecture == "" || r.Image == "" {
		return nil, errors.New("COMPATIBILITY_REQUIRED")
	}
	release, e := lock(filepath.Join(s.cfg.Root, "locks", r.ProfileID+".guard"))
	if e != nil {
		return nil, e
	}
	fail := func(e error) (func(), error) { release(); return nil, e }
	b, e := read(filepath.Join(s.cfg.Root, "metadata", r.ProfileID+".json"))
	if e != nil {
		return fail(e)
	}
	var m struct {
		ProfileID string `json:"profile_id"`
	}
	if json.Unmarshal(b, &m) != nil || m.ProfileID != r.ProfileID {
		return fail(errors.New("FOREIGN_IDENTITY"))
	}
	b, e = read(filepath.Join(s.cfg.Root, "locks", r.ProfileID+".json"))
	if e == nil {
		var l struct {
			Active *bool `json:"active"`
		}
		if json.Unmarshal(b, &l) != nil || l.Active == nil || *l.Active {
			return fail(errors.New("IDENTITY_BOUND"))
		}
	} else if !os.IsNotExist(e) {
		return fail(e)
	}
	p := filepath.Join(s.cfg.Root, "profiles", r.ProfileID)
	st, e := os.Lstat(p)
	if e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm() != 0700 || st.Sys().(*syscall.Stat_t).Uid != s.profileUID {
		return fail(errors.New("UNSAFE_PROFILE"))
	}
	if _, e = filesystem(p); e != nil {
		return fail(e)
	}
	if e = s.cfg.CheckStopped(ctx, r.ProfileID); e != nil {
		return fail(e)
	}
	return release, nil
}
func (s *Store) marker(id string, in intent) error {
	b, e := json.Marshal(in)
	if e != nil {
		return e
	}
	if e = writeSync(filepath.Join(s.slot(id), "intent.json"), b); e != nil {
		return errors.New("SLOT_RECONCILIATION_REQUIRED")
	}
	return syncDir(s.slot(id))
}
func (s *Store) clear(id string) error {
	if e := os.Remove(filepath.Join(s.slot(id), "intent.json")); e != nil {
		return e
	}
	return syncDir(s.slot(id))
}
func (s *Store) noIntent(id string) error {
	_, e := os.Lstat(filepath.Join(s.slot(id), "intent.json"))
	if os.IsNotExist(e) {
		return nil
	}
	return errors.New("SLOT_RECONCILIATION_REQUIRED")
}
func (s *Store) inspectLocked(ctx context.Context, id string, refs []string) (Manifest, error) {
	var best Manifest
	for _, name := range refs {
		other := "A.json"
		if name == "A.json" {
			other = "B.json"
		}
		quarantine := func(reason string) error {
			return fmt.Errorf("SLOT_QUARANTINED: %s unverifiable (%s); explicitly inspect %s with InspectReference", name, reason, other)
		}
		b, e := read(filepath.Join(s.slot(id), name))
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return best, quarantine("unsafe reference")
		}
		var ref reference
		if e = decode(b, &ref); e != nil {
			return best, quarantine("digest or format invalid")
		}
		if ref.Version > Version {
			return best, errors.New("SLOT_FUTURE_VERSION: update required")
		}
		self := ref.Self
		ref.Self = ""
		raw, _ := json.Marshal(ref)
		if ref.Version != Version || self != hash(raw) || ref.Generation == 0 || !digestPattern.MatchString(ref.Digest) {
			return best, quarantine("digest or format invalid")
		}
		dir := s.generation(id, ref.Digest)
		if e = privateDir(dir); e != nil {
			return best, quarantine("digest or format invalid")
		}
		b, e = read(filepath.Join(dir, "manifest.json"))
		if e != nil || hash(b) != ref.Digest {
			return best, quarantine("digest or format invalid")
		}
		var m Manifest
		if decode(b, &m) != nil {
			return best, quarantine("digest or format invalid")
		}
		if m.Version > Version {
			return best, errors.New("SLOT_FUTURE_VERSION: update required")
		}
		if m.Version != Version || m.Generation != ref.Generation || m.PayloadBytes < 0 || m.PayloadBytes > s.cfg.MaxBytes || !digestPattern.MatchString(m.PayloadSHA256) {
			return best, quarantine("digest or format invalid")
		}
		v, e := s.helper(ctx, "verify", "", dir, s.cfg.MaxBytes)
		if e != nil || v.Hash != m.PayloadSHA256 || v.Bytes != m.PayloadBytes || v.Expanded != m.ExpandedBytes || v.Entries != m.Entries {
			return best, quarantine("payload verification failed")
		}
		m.Digest = ref.Digest
		if m.Generation == best.Generation && best.Digest != m.Digest {
			return best, quarantine("conflicting generation")
		}
		if m.Generation > best.Generation {
			best = m
		}
	}
	if best.Generation == 0 {
		return best, os.ErrNotExist
	}
	return best, nil
}

func (s *Store) selectLocked(ctx context.Context, id string) (Manifest, error) {
	return s.inspectLocked(ctx, id, []string{"A.json", "B.json"})
}

// InspectReference offers an explicitly chosen recovery candidate, never clears
// quarantine or installs it. The caller must surface this choice to the human.
func (s *Store) InspectReference(ctx context.Context, id, name string) (Manifest, error) {
	if name != "A.json" && name != "B.json" {
		return Manifest{}, errors.New("INVALID_REFERENCE")
	}
	u, e := s.slotLock(id)
	if e != nil {
		return Manifest{}, e
	}
	defer u()
	return s.inspectLocked(ctx, id, []string{name})
}

// Select never silently falls back: any unverifiable reference quarantines the
// entire slot. Otherwise the highest fully verified referenced generation wins.
func (s *Store) Select(ctx context.Context, id string) (Manifest, error) {
	u, e := s.slotLock(id)
	if e != nil {
		return Manifest{}, e
	}
	defer u()
	if e = s.noIntent(id); e != nil {
		return Manifest{}, e
	}
	return s.selectLocked(ctx, id)
}
func (s *Store) Save(ctx context.Context, r Request) (Manifest, error) {
	var m Manifest
	u, e := s.custody(ctx, r)
	if e != nil {
		return m, e
	}
	defer u()
	v, e := s.slotLock(r.SlotID)
	if e != nil {
		return m, e
	}
	defer v()
	if e = s.noIntent(r.SlotID); e != nil {
		return m, e
	}
	old, e := s.selectLocked(ctx, r.SlotID)
	if e != nil && !os.IsNotExist(e) {
		return m, e
	}
	if r.CreateOnly && old.Generation != 0 {
		return m, errors.New("SLOT_EXISTS")
	}
	if r.OverwriteOnly && old.Generation == 0 {
		return m, errors.New("SLOT_NOT_FOUND")
	}
	if old.Generation != 0 && old.ProfileID != r.ProfileID {
		return m, errors.New("FOREIGN_SLOT")
	}
	if old.Generation == math.MaxUint64 {
		return m, errors.New("SLOT_GENERATION_EXHAUSTED")
	}
	profile := filepath.Join(s.cfg.Root, "profiles", r.ProfileID)
	estimate, e := s.helper(ctx, "probe", profile, "", s.cfg.MaxBytes)
	if e != nil {
		return m, e
	}
	var used int64
	e = filepath.Walk(s.slot(r.SlotID), func(p string, st os.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return errors.New("UNSAFE_SLOT")
		}
		if !st.IsDir() {
			if st.Size() > s.cfg.MaxBytes-used {
				return errors.New("SLOT_QUOTA")
			}
			used += st.Size()
		}
		return nil
	})
	if e != nil {
		return m, e
	}
	required := estimate.Bytes + 65536
	if required < 0 || used > s.cfg.MaxBytes-65536 {
		return m, errors.New("SLOT_QUOTA")
	}
	fs, e := filesystem(s.slot(r.SlotID))
	if e != nil {
		return m, e
	}
	if fs.Bsize <= 0 || fs.Bavail > math.MaxUint64/uint64(fs.Bsize) || uint64(required) > fs.Bavail*uint64(fs.Bsize) {
		return m, errors.New("SLOT_DISK_SPACE")
	}
	if e = s.marker(r.SlotID, intent{Operation: "save", Profile: r.ProfileID}); e != nil {
		return m, e
	}
	if e = s.step("intent"); e != nil {
		return m, e
	}
	stage, e := os.MkdirTemp(s.slot(r.SlotID), "staging-")
	if e != nil {
		return m, e
	}
	if e = syncDir(s.slot(r.SlotID)); e != nil {
		return m, e
	}
	if e = s.step("staging"); e != nil {
		return m, e
	}
	payload, e := s.helper(ctx, "pack", profile, stage, s.cfg.MaxBytes-used-65536)
	if e != nil {
		return m, e
	}
	if e = s.step("payload"); e != nil {
		return m, e
	}
	m = Manifest{SavedAt: time.Now().UTC().Format(time.RFC3339Nano), Version: Version, Generation: old.Generation + 1, ProfileID: r.ProfileID, Kind: r.Kind, Architecture: r.Architecture, Image: r.Image, PayloadSHA256: payload.Hash, PayloadBytes: payload.Bytes, ExpandedBytes: payload.Expanded, Entries: payload.Entries}
	b, _ := json.Marshal(m)
	if payload.Bytes < 0 || payload.Bytes > s.cfg.MaxBytes-used-int64(len(b))-65536 {
		return m, errors.New("SLOT_QUOTA")
	}
	m.Digest = hash(b)
	if e = writeSync(filepath.Join(stage, "manifest.json"), b); e != nil {
		return m, e
	}
	if e = syncDir(stage); e != nil {
		return m, e
	}
	if e = s.step("manifest"); e != nil {
		return m, e
	}
	if e = os.Rename(stage, s.generation(r.SlotID, m.Digest)); e != nil {
		return m, e
	}
	if e = s.step("generation"); e != nil {
		return m, e
	}
	if e = syncDir(filepath.Join(s.slot(r.SlotID), "generations")); e != nil {
		return m, e
	}
	if e = syncDir(s.slot(r.SlotID)); e != nil {
		return m, e
	}
	if e = s.step("generation-sync"); e != nil {
		return m, e
	}
	ref := reference{Version: Version, Generation: m.Generation, Digest: m.Digest}
	b, _ = json.Marshal(ref)
	ref.Self = hash(b)
	b, _ = json.Marshal(ref)
	f, e := os.CreateTemp(s.slot(r.SlotID), "ref-")
	if e != nil {
		return m, e
	}
	name := f.Name()
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return m, e
	}
	if ce != nil {
		return m, ce
	}
	if e = s.step("ref-file"); e != nil {
		return m, e
	}
	target := "A.json"
	if m.Generation%2 == 0 {
		target = "B.json"
	}
	// Cancellation can arrive after the helper finishes but before publication.
	if e = ctx.Err(); e != nil {
		return m, e
	}
	if e = os.Rename(name, filepath.Join(s.slot(r.SlotID), target)); e != nil {
		return m, e
	}
	if e = s.step("ref-rename"); e != nil {
		return m, e
	}
	if e = syncDir(s.slot(r.SlotID)); e != nil {
		return m, e
	}
	if e = s.step("ref-sync"); e != nil {
		return m, e
	}
	if e = s.clear(r.SlotID); e != nil {
		return m, e
	}
	return m, s.step("complete")
}
func inode(p string) (uint64, error) {
	st, e := os.Lstat(p)
	if e != nil {
		return 0, e
	}
	if !st.IsDir() {
		return 0, errors.New("UNSAFE_PROFILE")
	}
	return st.Sys().(*syscall.Stat_t).Ino, nil
}
func (s *Store) Load(ctx context.Context, r Request) (Manifest, error) {
	var m Manifest
	u, e := s.custody(ctx, r)
	if e != nil {
		return m, e
	}
	defer u()
	v, e := s.slotLock(r.SlotID)
	if e != nil {
		return m, e
	}
	defer v()
	if e = s.noIntent(r.SlotID); e != nil {
		return m, e
	}
	m, e = s.selectLocked(ctx, r.SlotID)
	if e != nil {
		return m, e
	}
	if r.SourceProfileID != "" && m.ProfileID != r.SourceProfileID {
		return m, errors.New("FOREIGN_SLOT")
	}
	if m.Kind != r.Kind || m.Architecture != r.Architecture || m.Image != r.Image {
		return m, errors.New("SLOT_INCOMPATIBLE: update required")
	}
	profile := filepath.Join(s.cfg.Root, "profiles", r.ProfileID)
	before, e := inode(profile)
	if e != nil {
		return m, e
	}
	fs, e := filesystem(profile)
	if e != nil {
		return m, e
	}
	if m.Entries < 0 || uint64(m.Entries)+3 > fs.Ffree {
		return m, errors.New("SLOT_DISK_INODES")
	}
	if m.ExpandedBytes < 0 || m.ExpandedBytes > math.MaxInt64-65536 || fs.Bsize <= 0 || fs.Bavail > math.MaxUint64/uint64(fs.Bsize) || uint64(m.ExpandedBytes+65536) > fs.Bavail*uint64(fs.Bsize) {
		return m, errors.New("SLOT_DISK_SPACE")
	}
	// Probe exchange on disposable siblings before preparing destination state.
	if _, e = s.helper(ctx, "exchange-probe", profile, "", s.cfg.MaxBytes); e != nil {
		return m, errors.New("RENAME_EXCHANGE_UNSUPPORTED")
	}
	stage, e := os.MkdirTemp(filepath.Dir(profile), ".slot-load-")
	if e != nil {
		return m, e
	}
	prepared, e := inode(stage)
	if e != nil {
		return m, e
	}
	if e = syncDir(filepath.Dir(profile)); e != nil {
		return m, e
	}
	in := intent{Operation: "load", Profile: r.ProfileID, Stage: filepath.Base(stage), Before: before, Prepared: prepared}
	if e = s.marker(r.SlotID, in); e != nil {
		return m, e
	}
	if e = s.step("load-intent"); e != nil {
		return m, e
	}
	if _, e = s.helper(ctx, "unpack", stage, s.generation(r.SlotID, m.Digest), s.cfg.MaxBytes); e != nil {
		// An uncertain helper may still be writing; leave its intent for recovery.
		if strings.Contains(e.Error(), "SLOT_HELPER_CLEANUP_UNCERTAIN") {
			return m, e
		}
		if _, ce := s.helper(ctx, "discard", stage, "", s.cfg.MaxBytes); ce != nil {
			return m, errors.Join(e, ce)
		}
		if ce := syncDir(filepath.Dir(stage)); ce != nil {
			return m, errors.Join(e, ce)
		}
		return m, errors.Join(e, s.clear(r.SlotID))
	}
	if e = s.step("load-extract"); e != nil {
		return m, e
	}
	if e = syncDir(filepath.Dir(profile)); e != nil {
		return m, e
	}
	if e = s.step("load-prepared"); e != nil {
		return m, e
	}
	if _, e = s.helper(ctx, "exchange", profile, stage, s.cfg.MaxBytes); e != nil {
		return m, e
	}
	if e = s.step("load-exchange"); e != nil {
		return m, e
	}
	if e = syncDir(filepath.Dir(profile)); e != nil {
		return m, e
	}
	if e = s.step("load-sync"); e != nil {
		return m, e
	}
	if e = s.clear(r.SlotID); e != nil {
		return m, e
	}
	return m, s.step("load-complete")
}

// Reconcile proves the exchange outcome from durable inode witnesses. It never
// retries an exchange. The old destination remains as a private sibling backup.
func (s *Store) Reconcile(ctx context.Context, id string) error {
	u, e := s.slotLock(id)
	if e != nil {
		return e
	}
	defer u()
	b, e := read(filepath.Join(s.slot(id), "intent.json"))
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	var in intent
	if decode(b, &in) != nil || !idPattern.MatchString(in.Profile) || protected(in.Profile) || in.Profile == s.cfg.LiveProfile {
		return errors.New("SLOT_QUARANTINED")
	}
	v, e := lock(filepath.Join(s.cfg.Root, "locks", in.Profile+".guard"))
	if e != nil {
		return e
	}
	defer v()
	if e = s.cfg.CheckStopped(ctx, in.Profile); e != nil {
		return e
	}
	switch in.Operation {
	case "save":
		best, err := s.selectLocked(ctx, id)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		// Discard only unpublished successors; older retained generations stay.
		dir := filepath.Join(s.slot(id), "generations")
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			p := filepath.Join(dir, entry.Name())
			if !digestPattern.MatchString(entry.Name()) || privateDir(p) != nil {
				return errors.New("SLOT_QUARANTINED")
			}
			raw, err := read(filepath.Join(p, "manifest.json"))
			var m Manifest
			if err != nil || hash(raw) != entry.Name() || decode(raw, &m) != nil {
				return errors.New("SLOT_QUARANTINED")
			}
			if m.Generation > best.Generation {
				if err = os.RemoveAll(p); err != nil {
					return err
				}
			}
		}
		if err = syncDir(dir); err != nil {
			return err
		}
		entries, err = os.ReadDir(s.slot(id))
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "staging-") || strings.HasPrefix(entry.Name(), "ref-") {
				if err = os.RemoveAll(filepath.Join(s.slot(id), entry.Name())); err != nil {
					return err
				}
			}
		}
	case "load":
		if !strings.HasPrefix(in.Stage, ".slot-load-") || filepath.Base(in.Stage) != in.Stage {
			return errors.New("SLOT_QUARANTINED")
		}
		a, e := inode(filepath.Join(s.cfg.Root, "profiles", in.Profile))
		if e != nil {
			return e
		}
		b, e := inode(filepath.Join(s.cfg.Root, "profiles", in.Stage))
		if os.IsNotExist(e) && a == in.Before && in.Before != 0 && in.Prepared != 0 && in.Before != in.Prepared {
			// Cleanup may have completed before the intent was durably cleared.
			if e = syncDir(filepath.Join(s.cfg.Root, "profiles")); e != nil {
				return e
			}
			return s.clear(id)
		}
		if e != nil {
			return e
		}
		if !((a == in.Before && b == in.Prepared) || (a == in.Prepared && b == in.Before)) {
			return errors.New("SLOT_QUARANTINED")
		}
		if a == in.Before {
			// No exchange occurred: discard even a partially extracted tree.
			if _, e = s.helper(ctx, "discard", filepath.Join(s.cfg.Root, "profiles", in.Stage), "", s.cfg.MaxBytes); e != nil {
				return e
			}
		}
		if e = syncDir(filepath.Join(s.cfg.Root, "profiles")); e != nil {
			return e
		}
	default:
		return errors.New("SLOT_QUARANTINED")
	}
	return s.clear(id)
}
func (s *Store) docker(ctx context.Context, op, profile, stage string, cap int64) (receipt, error) {
	var nonce [16]byte
	if _, e := rand.Read(nonce[:]); e != nil {
		return receipt{}, e
	}
	name := "mv-slot-helper-" + hex.EncodeToString(nonce[:])
	args := []string{"run", "--name", name, "--rm", "--pull=never", "--network", "none", "--read-only", "--cap-drop=ALL", "--cap-add=DAC_OVERRIDE", "--cap-add=CHOWN", "--cap-add=FOWNER", "--security-opt=no-new-privileges", "--user", "0", "--entrypoint", "python3"}
	mappedProfile, mappedStage := "", ""
	if profile != "" {
		parent := filepath.Dir(profile)
		mode := ",readonly"
		if op == "provision" || op == "unpack" || op == "exchange" || op == "exchange-probe" || op == "discard" {
			mode = ""
		}
		args = append(args, "--mount", "type=bind,src="+parent+",dst=/profiles"+mode)
		mappedProfile = "/profiles/" + filepath.Base(profile)
	}
	if stage != "" {
		mode := ",readonly"
		if op == "pack" {
			mode = ""
		}
		if op == "exchange" {
			mappedStage = "/profiles/" + filepath.Base(stage)
		} else {
			args = append(args, "--mount", "type=bind,src="+stage+",dst=/slot"+mode)
			mappedStage = "/slot"
		}
	}
	args = append(args, s.cfg.Image, "-c", helperScript, op, mappedProfile, mappedStage, fmtInt(cap))
	cmd := exec.CommandContext(ctx, "docker", args...)
	var out limitedBuffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	e := cmd.Run()
	if e != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if ce := exec.CommandContext(cleanup, "docker", "rm", "-f", name).Run(); ce != nil {
			return receipt{}, fmt.Errorf("SLOT_HELPER_CLEANUP_UNCERTAIN (%s): %w", name, e)
		}
		return receipt{}, fmt.Errorf("SLOT_HELPER_REFUSED (%s): %w", op, e)
	}
	var r receipt
	if e = decode(out.Bytes(), &r); e != nil {
		return r, e
	}
	return r, nil
}

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 4096 {
		return 0, errors.New("HELPER_OUTPUT_LIMIT")
	}
	return b.Buffer.Write(p)
}

// The privileged helper never emits payload data. Packing uses tar|tee|sha256sum
// with pipefail; a second streaming pass verifies the on-disk bytes. Validation
// precedes extraction and rejects all links, special nodes and unsafe paths.
const helperScript = `
import os,sys,stat,json,hashlib,tarfile,subprocess,ctypes,tempfile,resource,shutil
OWNER = 10001
op,p,s,cap=sys.argv[1:]; cap=int(cap)
excluded={'SingletonLock','SingletonCookie','SingletonSocket'}
def syncdir(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def exchange(a,b):
 libc=ctypes.CDLL(None,use_errno=True)
 if libc.renameat2(-100,os.fsencode(a),-100,os.fsencode(b),2)!=0: raise OSError(ctypes.get_errno(),'exchange refused')
def inventory(p):
 total=0;count=0
 assert os.lstat(p).st_uid==OWNER and stat.S_ISDIR(os.lstat(p).st_mode)
 for root,dirs,files in os.walk(p,followlinks=False):
  if root==p:
   dirs[:]=[x for x in dirs if x not in excluded];files=[x for x in files if x not in excluded]
  for name in dirs+files:
   path=os.path.join(root,name); st=os.lstat(path);count+=1
   assert len(os.fsencode(os.path.relpath(path,p)))<=4096 and count<=100000
   assert st.st_uid==OWNER and st.st_gid==OWNER and not st.st_mode&0o7000
   assert stat.S_ISDIR(st.st_mode) or (stat.S_ISREG(st.st_mode) and st.st_nlink==1)
   if stat.S_ISREG(st.st_mode): total+=st.st_size
   assert total<=cap
 return total,count

def verify(s):
 path=os.path.join(s,'payload.tar');st=os.lstat(path)
 assert stat.S_ISREG(st.st_mode) and st.st_uid==OWNER and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1 and st.st_size<=cap
 h=hashlib.sha256()
 with open(path,'rb') as f:
  while True:
   b=f.read(1048576)
   if not b:break
   h.update(b)
 total=0;count=0;seen=set()
 with tarfile.open(path,'r:') as tf:
  for m in tf:
   name=m.name
   if name=='.': assert m.isdir() and m.uid==OWNER and m.gid==OWNER and m.mode==0o700;continue
   if name.startswith('./'):name=name[2:]
   parts=name.rstrip('/').split('/')
   assert name and not name.startswith('/') and all(x not in ('','..','.') for x in parts)
   assert parts[0] not in excluded and len(os.fsencode(name))<=4096
   assert name not in seen;seen.add(name)
   assert (m.isfile() or m.isdir()) and m.uid==OWNER and m.gid==OWNER and m.size>=0 and not m.mode&0o7000
   count+=1;total+=m.size;assert count<=100000 and total<=cap
 return dict(hash=h.hexdigest(),bytes=st.st_size,expanded=total,entries=count)
if op=='provision':
 assert not os.path.islink(p)
 os.makedirs(p,mode=0o700,exist_ok=True);assert os.path.isdir(p)
 os.chown(p,OWNER,OWNER);os.chmod(p,0o700);syncdir(os.path.dirname(p));r={}
elif op=='discard':
 assert os.path.basename(p).startswith('.slot-load-') and stat.S_ISDIR(os.lstat(p).st_mode)
 shutil.rmtree(p);syncdir(os.path.dirname(p));r={}
elif op=='probe':
 total,count=inventory(p);r=dict(bytes=total+count*12288+65536,expanded=total,entries=count)
elif op=='pack':
 total,count=inventory(p)
 resource.setrlimit(resource.RLIMIT_FSIZE,(cap,cap))
 payload=os.path.join(s,'payload.tar');fd=os.open(payload,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
 # GNU tar preserves file bytes and numeric application metadata.
 cmd=['/bin/bash','-o','pipefail','-c','tar --format=pax --numeric-owner --anchored --exclude=./SingletonLock --exclude=./SingletonCookie --exclude=./SingletonSocket -C "$1" -cf - . | tee "$2" | sha256sum','slot-helper',p,payload]
 streamed=subprocess.check_output(cmd).decode().split()[0]
 os.chown(payload,OWNER,OWNER);os.chmod(payload,0o600)
 with open(payload,'rb') as f:os.fsync(f.fileno())
 syncdir(s);r=verify(s);assert r['hash']==streamed and r['expanded']==total and r['entries']==count
elif op=='verify':r=verify(s)
elif op=='unpack':
 r=verify(s)
 assert os.statvfs(p).f_favail>=r['entries'], 'SLOT_DISK_INODES'
 assert not os.listdir(p) and stat.S_ISDIR(os.lstat(p).st_mode)
 # All members were validated above. Refuse conflicting hierarchy on extraction.
 subprocess.check_call(['tar','--numeric-owner','--same-owner','--same-permissions','-xf',os.path.join(s,'payload.tar'),'-C',p],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 for root,dirs,files in os.walk(p,topdown=False):
  for name in files:
   with open(os.path.join(root,name),'rb') as f:os.fsync(f.fileno())
  syncdir(root)
 os.chown(p,OWNER,OWNER);os.chmod(p,0o700);syncdir(p)
elif op=='exchange':exchange(p,s);syncdir(os.path.dirname(p));r={}
elif op=='exchange-probe':
 parent=os.path.dirname(p);a=tempfile.mkdtemp(prefix='.exchange-probe-',dir=parent);b=tempfile.mkdtemp(prefix='.exchange-probe-',dir=parent)
 try:exchange(a,b);syncdir(parent)
 finally:os.rmdir(a);os.rmdir(b)
 r={}
else:raise ValueError('unknown helper operation')
print(json.dumps(r,separators=(',',':')))
`

// [TARGET, unit decision] Listing exports metadata only, capped to the wire limit.
type Entry struct {
	SlotID     string `json:"slot_id"`
	Name       string `json:"name"`
	SavedAt    string `json:"saved_at"`
	Generation uint64 `json:"generation"`
	SizeBytes  int64  `json:"size_bytes"`
}

func (s *Store) List(ctx context.Context, profile string) ([]Entry, error) {
	s.listMu.Lock()
	defer s.listMu.Unlock()
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	entries, e := os.ReadDir(filepath.Join(s.cfg.Root, "slots"))
	if e != nil {
		return nil, e
	}
	out := []Entry{}
	for _, entry := range entries {
		if !idPattern.MatchString(entry.Name()) || !entry.IsDir() {
			return nil, errors.New("UNSAFE_SLOT")
		}
		m, e := s.Select(ctx, entry.Name())
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return nil, e
		}
		if m.ProfileID != profile {
			continue
		}
		stamp := m.SavedAt
		if stamp == "" {
			st, e := os.Stat(filepath.Join(s.generation(entry.Name(), m.Digest), "manifest.json"))
			if e != nil {
				return nil, e
			}
			stamp = st.ModTime().UTC().Format(time.RFC3339Nano)
		}
		out = append(out, Entry{entry.Name(), entry.Name(), stamp, m.Generation, m.PayloadBytes})
		if len(out) > 256 {
			return nil, errors.New("SLOT_LIST_LIMIT")
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SlotID < out[j].SlotID })
	return out, nil
}
func (s *Store) Delete(ctx context.Context, r Request) error {
	u, e := s.custody(ctx, r)
	if e != nil {
		return e
	}
	defer u()
	v, e := s.slotLock(r.SlotID)
	if e != nil {
		return e
	}
	defer v()
	if e = s.noIntent(r.SlotID); e != nil {
		return e
	}
	m, e := s.selectLocked(ctx, r.SlotID)
	if e != nil {
		return e
	}
	if m.ProfileID != r.ProfileID {
		return errors.New("FOREIGN_SLOT")
	}
	// Retain the guard inode so competing operations cannot lock an unlinked guard.
	entries, e := os.ReadDir(s.slot(r.SlotID))
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if entry.Name() != "guard" {
			if e = os.RemoveAll(filepath.Join(s.slot(r.SlotID), entry.Name())); e != nil {
				return e
			}
		}
	}
	return syncDir(s.slot(r.SlotID))
}
func (s *Store) ReconcileAll(ctx context.Context) error {
	entries, e := os.ReadDir(filepath.Join(s.cfg.Root, "slots"))
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if !entry.IsDir() || !idPattern.MatchString(entry.Name()) {
			return errors.New("UNSAFE_SLOT")
		}
		if e = s.Reconcile(ctx, entry.Name()); e != nil {
			return e
		}
	}
	return nil
}

// Provision is called only after native identity creation; never overwrites data.
func (s *Store) Provision(ctx context.Context, id string) error {
	if !idPattern.MatchString(id) || protected(id) || id == s.cfg.LiveProfile {
		return errors.New("IDENTITY_PROTECTED")
	}
	u, e := lock(filepath.Join(s.cfg.Root, "locks", id+".guard"))
	if e != nil {
		return e
	}
	defer u()
	if e = s.cfg.CheckStopped(ctx, id); e != nil {
		return e
	}
	p := filepath.Join(s.cfg.Root, "profiles", id)
	st, e := os.Lstat(p)
	if e == nil {
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("UNSAFE_PROFILE")
		}
		entries, e := os.ReadDir(p)
		if e != nil || len(entries) != 0 {
			return errors.New("PROFILE_ALREADY_BOUND")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	_, e = s.helper(ctx, "provision", p, "", s.cfg.MaxBytes)
	return e
}

func (s *Store) Image() string { return s.cfg.Image }

func (s *Store) AcquireStopped(ctx context.Context, r Request) (func(), error) {
	return s.custody(ctx, r)
}
