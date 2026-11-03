package slots

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func localHelper(ctx context.Context, op, profile, stage string, cap int64) (receipt, error) {
	cmd := exec.CommandContext(ctx, "python3", "-c", strings.Replace(helperScript, "OWNER = 10001", "OWNER = "+fmtInt(int64(os.Getuid())), 1), op, profile, stage, fmtInt(cap))
	out, e := cmd.CombinedOutput()
	var r receipt
	if e != nil {
		return r, errors.New(string(out))
	}
	e = decode(out, &r)
	return r, e
}
func fixture(t *testing.T) (*Store, Request) {
	t.Helper()
	root := t.TempDir()
	os.Chmod(root, 0700)
	for _, d := range []string{"profiles/demo", "metadata", "locks"} {
		if e := os.MkdirAll(filepath.Join(root, d), 0700); e != nil {
			t.Fatal(e)
		}
	}
	os.WriteFile(filepath.Join(root, "metadata/demo.json"), []byte(`{"profile_id":"demo"}`), 0600)
	os.WriteFile(filepath.Join(root, "profiles/demo/data"), []byte("original\x00bytes"), 0600)
	s, e := New(Config{Root: root, Image: "opensuperficies-identity-browser-arm64:0.1.1", CheckStopped: func(context.Context, string) error { return nil }})
	if e != nil {
		t.Fatal(e)
	}
	s.helper = localHelper
	s.profileUID = uint32(os.Getuid())
	return s, Request{SlotID: "slot-a", ProfileID: "demo", HumanConfirmed: true, Kind: "browser", Architecture: "arm64", Image: "image-sha"}
}
func TestRoundTrip(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	a, e := s.Save(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(s.cfg.Root, "profiles/demo/data"), []byte("changed"), 0600)
	if _, e = s.Load(ctx, r); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(filepath.Join(s.cfg.Root, "profiles/demo/data"))
	if string(b) != "original\x00bytes" {
		t.Fatal(string(b))
	}
	if a.Generation != 1 {
		t.Fatal(a)
	}
}
func TestPublicationFailpoints(t *testing.T) {
	for _, point := range SaveSteps {
		t.Run(point, func(t *testing.T) {
			s, r := fixture(t)
			ctx := context.Background()
			if _, e := s.Save(ctx, r); e != nil {
				t.Fatal(e)
			}
			s.cfg.Failpoint = func(p string) error {
				if p == point {
					return errors.New("crash")
				}
				return nil
			}
			if _, e := s.Save(ctx, r); e == nil {
				t.Fatal("failpoint not reached")
			}
			s.cfg.Failpoint = nil
			if e := s.Reconcile(ctx, r.SlotID); e != nil {
				t.Fatal(e)
			}
			m, e := s.Select(ctx, r.SlotID)
			if e != nil || m.Generation < 1 || m.Generation > 2 {
				t.Fatal(m, e)
			}
		})
	}
}
func TestTamperBeforeTouch(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	m, e := s.Save(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(s.generation(r.SlotID, m.Digest), "payload.tar"), []byte("bad"), 0600)
	if _, e = s.Load(ctx, r); e == nil {
		t.Fatal("tamper accepted")
	}
	b, _ := os.ReadFile(filepath.Join(s.cfg.Root, "profiles/demo/data"))
	if string(b) != "original\x00bytes" {
		t.Fatal("destination touched")
	}
}
func TestRefusals(t *testing.T) {
	for _, id := range []string{"mv-live", "srf-id-cuentas-1", "srf-id-perplexity-1", "srf-pg-demo", "srf-egress-proxy", "n8n", "distil-box", "../bad"} {
		t.Run(id, func(t *testing.T) {
			s, r := fixture(t)
			r.ProfileID = id
			if _, e := s.Save(context.Background(), r); e == nil {
				t.Fatal("protected accepted")
			}
		})
	}
	s, r := fixture(t)
	r.HumanConfirmed = false
	if _, e := s.Save(context.Background(), r); e == nil {
		t.Fatal("no consent")
	}
}
func TestLinksAndQuota(t *testing.T) {
	s, r := fixture(t)
	p := filepath.Join(s.cfg.Root, "profiles/demo")
	os.Symlink("missing", filepath.Join(p, "SingletonLock"))
	if _, e := s.Save(context.Background(), r); e != nil {
		t.Fatal(e)
	}
	os.Symlink("data", filepath.Join(p, "other"))
	if _, e := s.Save(context.Background(), r); e == nil {
		t.Fatal("link accepted")
	}
	os.Remove(filepath.Join(p, "other"))
	s.cfg.MaxBytes = 1
	if _, e := s.Save(context.Background(), r); e == nil {
		t.Fatal("quota accepted")
	}
}

func TestLoadFailpoints(t *testing.T) {
	for _, point := range LoadSteps {
		t.Run(point, func(t *testing.T) {
			s, r := fixture(t)
			ctx := context.Background()
			if _, e := s.Save(ctx, r); e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(s.cfg.Root, "profiles/demo/data")
			os.WriteFile(path, []byte("before-load"), 0600)
			s.cfg.Failpoint = func(p string) error {
				if p == point {
					return errors.New("crash")
				}
				return nil
			}
			if _, e := s.Load(ctx, r); e == nil {
				t.Fatal("failpoint not reached")
			}
			s.cfg.Failpoint = nil
			if e := s.Reconcile(ctx, r.SlotID); e != nil {
				t.Fatal(e)
			}
			b, e := os.ReadFile(path)
			if e != nil {
				t.Fatal(e)
			}
			if string(b) != "original\x00bytes" && string(b) != "before-load" {
				t.Fatal("partial destination")
			}
		})
	}
}
func TestCorruptReferenceQuarantines(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	for range 2 {
		if _, e := s.Save(ctx, r); e != nil {
			t.Fatal(e)
		}
	}
	os.WriteFile(filepath.Join(s.slot(r.SlotID), "B.json"), []byte("torn"), 0600)
	if _, e := s.Select(ctx, r.SlotID); e == nil || !strings.Contains(e.Error(), "QUARANTINED") {
		t.Fatal(e)
	}
}
func TestFutureVersion(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, e := s.Save(ctx, r); e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(s.slot(r.SlotID), "A.json")
	b, _ := os.ReadFile(p)
	var ref reference
	decode(b, &ref)
	ref.Version = Version + 1
	ref.Self = ""
	b, _ = json.Marshal(ref)
	ref.Self = hash(b)
	b, _ = json.Marshal(ref)
	os.WriteFile(p, b, 0600)
	if _, e := s.Load(ctx, r); e == nil || !strings.Contains(e.Error(), "SLOT_FUTURE_VERSION") {
		t.Fatal(e)
	}
	b, _ = os.ReadFile(filepath.Join(s.cfg.Root, "profiles/demo/data"))
	if string(b) != "original\x00bytes" {
		t.Fatal("destination touched")
	}
}
func TestCustodyAndCompatibility(t *testing.T) {
	for _, lease := range []string{`{"active":true}`, `{}`, `{"active":null}`, `bad`} {
		t.Run(lease, func(t *testing.T) {
			s, r := fixture(t)
			os.WriteFile(filepath.Join(s.cfg.Root, "locks/demo.json"), []byte(lease), 0600)
			if _, e := s.Save(context.Background(), r); e == nil {
				t.Fatal("uncertain lease accepted")
			}
		})
	}
	s, r := fixture(t)
	ctx := context.Background()
	s.cfg.CheckStopped = func(context.Context, string) error { return errors.New("LOGIN_IN_PROGRESS") }
	if _, e := s.Save(ctx, r); e == nil {
		t.Fatal("login accepted")
	}
	s.cfg.CheckStopped = func(context.Context, string) error { return nil }
	if _, e := s.Save(ctx, r); e != nil {
		t.Fatal(e)
	}
	r.Image = "new-image"
	if _, e := s.Load(ctx, r); e == nil {
		t.Fatal("incompatible image")
	}
}
func TestExchangeRefusalKeepsDestination(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, e := s.Save(ctx, r); e != nil {
		t.Fatal(e)
	}
	s.helper = func(c context.Context, op, p, stage string, cap int64) (receipt, error) {
		if op == "exchange-probe" {
			return receipt{}, errors.New("unsupported")
		}
		return localHelper(c, op, p, stage, cap)
	}
	if _, e := s.Load(ctx, r); e == nil || !strings.Contains(e.Error(), "RENAME_EXCHANGE_UNSUPPORTED") {
		t.Fatal(e)
	}
	if e := s.noIntent(r.SlotID); e != nil {
		t.Fatal(e)
	}
}
func TestMissingWitnessAndUnsafePaths(t *testing.T) {
	s, r := fixture(t)
	if _, e := New(Config{Root: s.cfg.Root, Image: "local"}); e == nil {
		t.Fatal("missing witness accepted")
	}
	s.cfg.LiveProfile = r.ProfileID
	if _, e := s.Save(context.Background(), r); e == nil {
		t.Fatal("live accepted")
	}
	s.cfg.LiveProfile = ""
	os.Remove(filepath.Join(s.cfg.Root, "metadata/demo.json"))
	os.Symlink("/etc/passwd", filepath.Join(s.cfg.Root, "metadata/demo.json"))
	if _, e := s.Save(context.Background(), r); e == nil {
		t.Fatal("symlink metadata accepted")
	}
}

// Explicit opt-in probe: go test -slots-docker-probe. Ordinary tests require no
// daemon. The probe creates only disposable bind-mounted data, never identities
// or application containers, and runs the production Docker helper unchanged.
var dockerProbe = flag.Bool("slots-docker-probe", false, "exercise uid-10001 Docker payloads")

func TestMain(m *testing.M) {
	flag.Parse()
	if *dockerProbe {
		if e := probeDocker(); e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr, "DOCKER_PROBE_OK uid=10001 mode=0600 marker byte-exact exchange supported")
	}
	os.Exit(m.Run())
}
func probeDocker() error {
	ctx := context.Background()
	root, e := os.MkdirTemp("", "slots-docker-probe-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(root)
	image := os.Getenv("MV_SLOT_PROBE_IMAGE")
	if image == "" {
		image = "opensuperficies-identity-browser-arm64:0.1.1"
	}
	for _, d := range []string{"profiles", "metadata", "locks"} {
		if e = os.Mkdir(filepath.Join(root, d), 0700); e != nil {
			return e
		}
	}
	if e = os.WriteFile(filepath.Join(root, "metadata/demo.json"), []byte(`{"profile_id":"demo"}`), 0600); e != nil {
		return e
	}
	setup := `import os; p='/profiles/demo'; os.mkdir(p,0o700); open(p+'/data','wb').write(b'opaque\x00credential-bytes'); os.chown(p+'/data',10001,10001); os.chmod(p+'/data',0o600); os.chown(p,10001,10001); os.symlink('stale-target',p+'/SingletonLock')`
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only", "--user", "0", "--entrypoint", "python3", "--mount", "type=bind,src="+filepath.Join(root, "profiles")+",dst=/profiles", image, "-c", setup)
	if out, e := cmd.CombinedOutput(); e != nil {
		return fmt.Errorf("setup: %w %s", e, out)
	}
	// Cleanup of uid-10001 directories is also performed without host sudo.
	defer exec.CommandContext(ctx, "docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only", "--user", "0", "--entrypoint", "python3", "--mount", "type=bind,src="+root+",dst=/cleanup", image, "-c", `import shutil,os; [shutil.rmtree('/cleanup/'+n) for n in os.listdir('/cleanup')]`).Run()
	s, e := New(Config{Root: root, Image: image, CheckStopped: func(context.Context, string) error { return nil }})
	if e != nil {
		return e
	}
	r := Request{SlotID: "slot-a", ProfileID: "demo", HumanConfirmed: true, Kind: "browser", Architecture: runtime.GOARCH, Image: image}
	a, e := s.Save(ctx, r)
	if e != nil {
		return e
	}
	b, e := s.Save(ctx, r)
	if e != nil {
		return e
	}
	if b.Generation != a.Generation+1 {
		return errors.New("generation did not advance")
	}
	if _, e = s.Load(ctx, r); e != nil {
		return e
	}
	check := `import os,hashlib; p='/profiles/demo'; assert open(p+'/data','rb').read()==b'opaque\x00credential-bytes'; assert os.stat(p).st_uid==10001; assert not os.path.lexists(p+'/SingletonLock'); print('marker verified')`
	out, e := exec.CommandContext(ctx, "docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only", "--user", "0", "--entrypoint", "python3", "--mount", "type=bind,src="+filepath.Join(root, "profiles")+",dst=/profiles,readonly", image, "-c", check).CombinedOutput()
	if e != nil {
		return fmt.Errorf("marker: %w %s", e, out)
	}
	return nil
}

func TestExplicitRecoveryCandidate(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	for range 2 {
		if _, e := s.Save(ctx, r); e != nil {
			t.Fatal(e)
		}
	}
	os.WriteFile(filepath.Join(s.slot(r.SlotID), "B.json"), []byte("torn"), 0600)
	if _, e := s.Select(ctx, r.SlotID); e == nil || !strings.Contains(e.Error(), "A.json") {
		t.Fatal(e)
	}
	m, e := s.InspectReference(ctx, r.SlotID, "A.json")
	if e != nil || m.Generation != 1 {
		t.Fatal(m, e)
	}
	if _, e = s.Select(ctx, r.SlotID); e == nil {
		t.Fatal("inspection cleared quarantine")
	}
}

func TestArchiveNegativeControls(t *testing.T) {
	for _, kind := range []string{"traversal", "absolute", "symlink", "hardlink", "device", "privilege", "foreign-owner", "duplicate"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			script := `import os,sys,tarfile,io
p,kind,owner=sys.argv[1:];owner=int(owner)
with tarfile.open(p+'/payload.tar','w') as tf:
 m=tarfile.TarInfo('safe');m.uid=owner;m.gid=owner;m.mode=0o600;m.size=1
 if kind=='traversal':m.name='../escape'
 if kind=='absolute':m.name='/escape'
 if kind=='symlink':m.type=tarfile.SYMTYPE;m.linkname='outside';m.size=0
 if kind=='hardlink':m.type=tarfile.LNKTYPE;m.linkname='safe';m.size=0
 if kind=='device':m.type=tarfile.CHRTYPE;m.size=0
 if kind=='privilege':m.mode=0o4600
 if kind=='foreign-owner':m.uid=owner+1
 tf.addfile(m,io.BytesIO(b'x'))
 if kind=='duplicate':tf.addfile(m,io.BytesIO(b'x'))
os.chmod(p+'/payload.tar',0o600)
`
			if out, e := exec.Command("python3", "-c", script, dir, kind, fmtInt(int64(os.Getuid()))).CombinedOutput(); e != nil {
				t.Fatal(e, string(out))
			}
			if _, e := localHelper(context.Background(), "verify", "", dir, DefaultMaxBytes); e == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}

func TestNamedSlotsOverwriteListDeleteAndStartupReconcile(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	r.CreateOnly = true
	first, e := s.Save(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Save(ctx, r); e == nil || e.Error() != "SLOT_EXISTS" {
		t.Fatal("Save silently overwrote", e)
	}
	rows, e := s.List(ctx, r.ProfileID)
	if e != nil || len(rows) != 1 || rows[0].SlotID != r.SlotID || rows[0].SavedAt == "" {
		t.Fatal(rows, e)
	}
	r.CreateOnly = false
	r.OverwriteOnly = true
	second, e := s.Save(ctx, r)
	if e != nil || second.Generation != first.Generation+1 {
		t.Fatal(second, e)
	}
	other := r
	other.ProfileID = "other-profile"
	rows, e = s.List(ctx, other.ProfileID)
	if e != nil || len(rows) != 0 {
		t.Fatal("foreign slots listed", rows, e)
	}
	s.cfg.Failpoint = func(point string) error {
		if point == "ref-sync" {
			return errors.New("crash")
		}
		return nil
	}
	_, _ = s.Save(ctx, r)
	s.cfg.Failpoint = nil
	if _, e = os.Stat(filepath.Join(s.slot(r.SlotID), "intent.json")); e != nil {
		t.Fatal("missing recovery marker", e)
	}
	if e = s.ReconcileAll(ctx); e != nil {
		t.Fatal("startup recovery", e)
	}
	if _, e = os.Stat(filepath.Join(s.slot(r.SlotID), "intent.json")); !os.IsNotExist(e) {
		t.Fatal("startup retained intent", e)
	}
	if e = s.Delete(ctx, r); e != nil {
		t.Fatal(e)
	}
	rows, e = s.List(ctx, r.ProfileID)
	if e != nil || len(rows) != 0 {
		t.Fatal(rows, e)
	}
	if _, e = s.Save(ctx, r); e == nil || e.Error() != "SLOT_NOT_FOUND" {
		t.Fatal("overwrite created missing slot", e)
	}
}

func TestCopySelectedSlotToNewProfileAndRejectForeignSourceBeforeTouch(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, e := s.Save(ctx, r); e != nil {
		t.Fatal(e)
	}
	id := "new-copy"
	if e := os.WriteFile(filepath.Join(s.cfg.Root, "metadata", id+".json"), []byte(`{"profile_id":"new-copy"}`), 0600); e != nil {
		t.Fatal(e)
	}
	if e := s.Provision(ctx, id); e != nil {
		t.Fatal(e)
	}
	r.SourceProfileID = r.ProfileID
	r.ProfileID = id
	if _, e := s.Load(ctx, r); e != nil {
		t.Fatal(e)
	}
	dest := filepath.Join(s.cfg.Root, "profiles", id, "data")
	got, e := os.ReadFile(dest)
	if e != nil || string(got) != "original\x00bytes" {
		t.Fatal("copied bytes differ", string(got), e)
	}
	if e = os.WriteFile(dest, []byte("destination marker"), 0600); e != nil {
		t.Fatal(e)
	}
	r.SourceProfileID = "foreign-profile"
	if _, e = s.Load(ctx, r); e == nil || e.Error() != "FOREIGN_SLOT" {
		t.Fatal("foreign source accepted", e)
	}
	got, e = os.ReadFile(dest)
	if e != nil || string(got) != "destination marker" {
		t.Fatal("refusal touched destination", string(got), e)
	}
	source, e := os.ReadFile(filepath.Join(s.cfg.Root, "profiles", "demo", "data"))
	if e != nil || string(source) != "original\x00bytes" {
		t.Fatal("copy touched source", e)
	}
}

func TestReconcileRemovesUnpublishedGeneration(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	s.cfg.Failpoint = func(p string) error {
		if p == "generation" {
			return errors.New("crash")
		}
		return nil
	}
	m, e := s.Save(ctx, r)
	if e == nil {
		t.Fatal("missing crash")
	}
	s.cfg.Failpoint = nil
	if e = s.Reconcile(ctx, r.SlotID); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(s.generation(r.SlotID, m.Digest)); !os.IsNotExist(e) {
		t.Fatal("unpublished generation retained", e)
	}
	if _, e = s.Save(ctx, r); e != nil {
		t.Fatal("retry failed", e)
	}
}

func TestReconcileRefusesNowLiveProfile(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, e := s.Save(ctx, r); e != nil {
		t.Fatal(e)
	}
	s.cfg.Failpoint = func(p string) error {
		if p == "load-prepared" {
			return errors.New("crash")
		}
		return nil
	}
	if _, e := s.Load(ctx, r); e == nil {
		t.Fatal("missing crash")
	}
	s.cfg.LiveProfile = r.ProfileID
	if e := s.Reconcile(ctx, r.SlotID); e == nil {
		t.Fatal("live recovery accepted")
	}
	if e := s.noIntent(r.SlotID); e == nil {
		t.Fatal("live intent cleared")
	}
	s.cfg.LiveProfile = ""
	if e := s.Reconcile(ctx, r.SlotID); e != nil {
		t.Fatal(e)
	}
}

func TestPartialExtractionCleanedWithoutPublication(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, e := s.Save(ctx, r); e != nil {
		t.Fatal(e)
	}
	s.helper = func(c context.Context, op, p, stage string, cap int64) (receipt, error) {
		if op == "unpack" {
			if e := os.WriteFile(filepath.Join(p, "partial"), []byte("partial"), 0600); e != nil {
				t.Fatal(e)
			}
			return receipt{}, errors.New("ENOSPC")
		}
		return localHelper(c, op, p, stage, cap)
	}
	if _, e := s.Load(ctx, r); e == nil {
		t.Fatal("partial extraction accepted")
	}
	b, e := os.ReadFile(filepath.Join(s.cfg.Root, "profiles/demo/data"))
	if e != nil || string(b) != "original\x00bytes" {
		t.Fatal("destination changed", e)
	}
	stages, e := filepath.Glob(filepath.Join(s.cfg.Root, "profiles/.slot-load-*"))
	if e != nil || len(stages) != 0 {
		t.Fatal("partial staging retained", stages, e)
	}
	if e = s.noIntent(r.SlotID); e != nil {
		t.Fatal(e)
	}
}

func TestSaveQuotaUsesPackedSize(t *testing.T) {
	s, r := fixture(t)
	for i := range 24 {
		if e := os.WriteFile(filepath.Join(s.cfg.Root, "profiles/demo", fmt.Sprint(i)), []byte("x"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	s.cfg.MaxBytes = 200000
	if _, e := s.Save(context.Background(), r); e != nil {
		t.Fatal("small packed profile refused", e)
	}
	s.cfg.MaxBytes = 1
	if _, e := s.Save(context.Background(), r); e == nil {
		t.Fatal("quota exceeded")
	}
}

func TestUnpackRefusesInsufficientInodes(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	m, e := s.Save(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	stage := t.TempDir()
	script := strings.Replace(helperScript, "OWNER = 10001", "OWNER = "+fmtInt(int64(os.Getuid()))+"\nclass FullInodes:\n f_favail=0\nos.statvfs=lambda p: FullInodes()", 1)
	out, e := exec.Command("python3", "-c", script, "unpack", stage, s.generation(r.SlotID, m.Digest), fmtInt(s.cfg.MaxBytes)).CombinedOutput()
	if e == nil || !strings.Contains(string(out), "SLOT_DISK_INODES") {
		t.Fatal("inode shortage accepted", e, string(out))
	}
	entries, e := os.ReadDir(stage)
	if e != nil || len(entries) != 0 {
		t.Fatal("extracted despite inode shortage", e)
	}
}

func TestReconcileAfterStagingCleanupCrash(t *testing.T) {
	s, r := fixture(t)
	ctx := context.Background()
	if _, e := s.Save(ctx, r); e != nil {
		t.Fatal(e)
	}
	s.cfg.Failpoint = func(p string) error {
		if p == "load-intent" {
			return errors.New("crash")
		}
		return nil
	}
	if _, e := s.Load(ctx, r); e == nil {
		t.Fatal("missing crash")
	}
	stages, e := filepath.Glob(filepath.Join(s.cfg.Root, "profiles/.slot-load-*"))
	if e != nil || len(stages) != 1 {
		t.Fatal(stages, e)
	}
	if e = os.RemoveAll(stages[0]); e != nil {
		t.Fatal(e)
	}
	if e = s.Reconcile(ctx, r.SlotID); e != nil {
		t.Fatal("cleanup recovery failed", e)
	}
}
