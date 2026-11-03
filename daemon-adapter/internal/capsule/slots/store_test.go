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
