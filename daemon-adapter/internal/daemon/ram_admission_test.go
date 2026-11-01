package daemon

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type pairNative struct {
	paths, hashes map[string]string
	containers    map[string]string
	seq, inputs   map[string]uint64
	active        map[string]bool
	starts        int
}

func (r *pairNative) Run(_ context.Context, argv []string, _ []byte) ([]byte, error) {
	flag := func(key string) string {
		for i, v := range argv {
			if v == key && i+1 < len(argv) {
				return argv[i+1]
			}
		}
		return ""
	}
	id := flag("--container")
	switch argv[1] {
	case "start":
		id = r.containers[flag("--identity")]
		r.starts++
		r.active[id] = true
		return json.Marshal(map[string]any{"container": id, "run_id": id, "windows": []map[string]any{{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1}}})
	case "frame":
		r.seq[id]++
		return json.Marshal(capsule.NativeFrame{Path: r.paths[id], Seq: r.seq[id], SHA256RGB24: r.hashes[id], Width: 2, Height: 1, CaptureMonoNS: monotonic(), Generation: id, Window: &capsule.Window{ID: "w1", W: 2, H: 1}})
	case "input":
		r.inputs[id]++
		return json.Marshal(map[string]any{"surface_id": "w1", "kind": "click", "input_mono_ns": monotonic(), "focus_verified": true, "result": "ok"})
	case "stop":
		delete(r.active, id)
		return json.Marshal(map[string]any{"stopped": id, "removed_verified": true})
	}
	return nil, fmt.Errorf("unexpected %v", argv)
}

type pairFixture struct {
	h             ipc.Handler
	native        *pairNative
	available     uint64
	reads         int
	readErr       error
	afterStartLow bool
	profiles      map[string]capsule.Profile
}

func newPair(t *testing.T) *pairFixture {
	t.Helper()
	t.Setenv("MV_RAM_ADMISSION_DIR", filepath.Join(t.TempDir(), "admission"))
	f := &pairFixture{available: ramFloorKB + 4*ramReserveKB, profiles: map[string]capsule.Profile{}}
	r := &pairNative{containers: map[string]string{}, paths: map[string]string{}, hashes: map[string]string{}, seq: map[string]uint64{}, inputs: map[string]uint64{}, active: map[string]bool{}}
	f.native = r
	pubs := map[string]*frames.Publisher{}
	for i, id := range []string{"pair-a", "pair-b"} {
		root, err := os.MkdirTemp("/dev/shm", "mv-pair-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(root) })
		path, hash := writeTestPNG(t, root)
		var random [6]byte
		if _, err := rand.Read(random[:]); err != nil {
			t.Fatal(err)
		}
		nativeRun := fmt.Sprintf("srf-id-%x", random)
		r.containers[id] = nativeRun
		if err := os.Rename(filepath.Join(root, "demo-run"), filepath.Join(root, nativeRun)); err != nil {
			t.Fatal(err)
		}
		path = filepath.Join(root, nativeRun, "frames", "w1", filepath.Base(path))
		r.paths[nativeRun], r.hashes[nativeRun] = path, hash
		f.profiles[id] = capsule.Profile{Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: fmt.Sprintf(":%d", 100+i), Width: 2, Height: 1}
		pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 8192, MaxPixels: 64, MaxSurfaces: 16})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pub.Close() })
		pubs[root] = pub
	}
	if err := validateProfileRoots(f.profiles); err != nil {
		t.Fatal(err)
	}
	origin := monotonic()
	root, err := os.MkdirTemp("/dev/shm", "mv-admission-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: f.profiles, MaxSurfaces: 16, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: origin}, r, monotonic)
	if err != nil {
		t.Fatal(err)
	}
	f.h = admittedHandler(m, wireHandlerWithoutAdmission(m, f.profiles, pubs, origin), func() (ramMemory, error) {
		f.reads++
		if f.afterStartLow && f.reads%2 == 0 {
			return ramMemory{total: 121 * 1024 * 1024}, nil
		}
		return ramMemory{available: f.available, total: 121 * 1024 * 1024}, f.readErr
	})
	return f
}
func (f *pairFixture) call(t *testing.T, op string, params any) []json.RawMessage {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
	out, err := f.h(context.Background(), ipc.Envelope{Body: body})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func (f *pairFixture) create(t *testing.T, id string) (string, string) {
	t.Helper()
	out := f.call(t, "create", map[string]any{"kind": "browser", "profile_id": id, "geometry": map[string]int{"w": 2, "h": 1}})
	if len(out) != 2 {
		t.Fatalf("create %s: %s", id, out)
	}
	var ev struct {
		Data struct {
			Surface  capsule.Surface
			FrameRef frames.Ref `json:"frame_ref"`
		}
	}
	_ = json.Unmarshal(out[0], &ev)
	sid := ev.Data.Surface.SurfaceID
	_ = json.Unmarshal(out[1], &ev)
	return sid, ev.Data.FrameRef.RAMWSPath
}
func TestMultiCapsuleH1H3H4(t *testing.T) {
	f := newPair(t)
	a, pa := f.create(t, "pair-a")
	b, pb := f.create(t, "pair-b")
	// MUT-SHARED-PROFILE: both creates must succeed with distinct allocations.
	if a == b || pa == pb || filepath.Dir(pa) == filepath.Dir(pb) || len(f.native.active) != 2 {
		t.Fatalf("shared allocation: %s %s %s %s", a, b, pa, pb)
	}
	for _, p := range []string{pa, pb} {
		if _, err := os.Stat(p); err != nil {
			t.Fatal(err)
		}
	}
	// MUT-CROSS-INPUT: B's native input count and sequence must remain unchanged.
	seq := f.native.seq[f.native.containers["pair-b"]]
	out := f.call(t, "input", map[string]any{"surface_id": a, "proposal_id": "pair-input", "action": map[string]any{"type": "click", "x": 0, "y": 0, "button": "left"}})
	if len(out) != 3 || f.native.inputs[f.native.containers["pair-a"]] != 1 || f.native.inputs[f.native.containers["pair-b"]] != 0 || f.native.seq[f.native.containers["pair-b"]] != seq {
		t.Fatalf("cross input: %s %+v %+v", out, f.native.inputs, f.native.seq)
	}
	var receipt struct {
		AfterFrame frames.Ref `json:"after_frame"`
	}
	if err := json.Unmarshal(out[2], &receipt); err != nil || receipt.AfterFrame.SurfaceID != a {
		t.Fatalf("receipt bound to sibling: %s", out[2])
	}
	f.call(t, "destroy", map[string]string{"surface_id": a})
	if f.native.active[f.native.containers["pair-a"]] || !f.native.active[f.native.containers["pair-b"]] {
		t.Fatal("sibling stopped")
	}
	if _, err := os.Stat(pa); !os.IsNotExist(err) {
		t.Fatalf("A publication retained: %v", err)
	}
	if _, err := os.Stat(pb); err != nil {
		t.Fatal("B publication removed", err)
	}
	out = f.call(t, "input", map[string]any{"surface_id": b, "proposal_id": "survivor-input", "action": map[string]any{"type": "click", "x": 0, "y": 0, "button": "left"}})
	if len(out) != 3 || f.native.inputs[f.native.containers["pair-b"]] != 1 || f.native.seq[f.native.containers["pair-b"]] <= seq {
		t.Fatalf("B no longer advances: %s", out)
	}
	f.call(t, "destroy", map[string]string{"surface_id": b})
	t.Logf("H1/H3/H4 PASS owned_containers=%v ram_cleanup=PASS", f.native.containers)
}
func TestMultiCapsuleH2(t *testing.T) {
	for _, mode := range []string{"low", "missing", "post-start"} {
		t.Run(mode, func(t *testing.T) {
			f := newPair(t)
			_, pa := f.create(t, "pair-a")
			switch mode {
			case "low":
				f.available = ramFloorKB + ramReserveKB - 1
			case "missing":
				f.readErr = errors.New("unreadable")
			case "post-start":
				f.afterStartLow = true
			}
			out := f.call(t, "create", map[string]any{"kind": "browser", "profile_id": "pair-b", "geometry": map[string]int{"w": 2, "h": 1}})
			if len(out) != 1 || !strings.Contains(string(out[0]), `"code":"RAM_ADMISSION_REFUSED"`) {
				t.Fatalf("MUT-NO-RAM-ADMISSION survived: %s", out)
			}
			if !f.native.active[f.native.containers["pair-a"]] || f.native.active[f.native.containers["pair-b"]] {
				t.Fatalf("sibling affected: %+v", f.native.active)
			}
			if mode != "post-start" && f.native.starts != 1 {
				t.Fatal("refused create reached native")
			}
			if _, err := os.Stat(pa); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestRAMAdmissionParserAndBoundary(t *testing.T) {
	for _, raw := range []string{
		"", "MemFree: 999 kB", "MemTotal: 8 kB\nMemAvailable: -1 kB", "MemTotal: 8 kB\nMemAvailable: 2 MB",
		"MemTotal: 8 kB\nMemAvailable: 3 kB\nMemAvailable: 4 kB", "MemTotal: 8 kB\nMemAvailable: 18446744073709551616 kB",
		"MemTotal: 0 kB\nMemAvailable: 0 kB", "MemTotal: 4 kB\nMemAvailable: 5 kB",
		"MemTotal: 8 kB\nMemTotal: 8 kB\nMemAvailable: 4 kB",
		"MemTotal: -1 kB\nMemAvailable: 0 kB", "MemTotal: 8 MB\nMemAvailable: 0 kB",
		"MemTotal: 18446744073709551616 kB\nMemAvailable: 0 kB",
		"MemTotal: 8 kB", "MemAvailable: 0 kB",
	} {
		if _, err := parseMemoryKB([]byte(raw)); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	memory, err := parseMemoryKB([]byte("MemTotal: 8 kB\nMemAvailable: 0 kB\n"))
	if err != nil || memory.available != 0 {
		t.Fatal(memory, err)
	}
	for _, host := range []struct {
		name         string
		total, floor uint64
	}{
		{"large", 121 * 1024 * 1024, 20 * 1024 * 1024},
		{"small", 16 * 1024 * 1024, 4 * 1024 * 1024},
	} {
		t.Run(host.name, func(t *testing.T) {
			for _, live := range []int{0, 1, 2} {
				n := host.floor + ramReserveKB*uint64(live)
				path := filepath.Join(t.TempDir(), "meminfo")
				read := func() (ramMemory, error) { return readMemoryKB(path) }
				for _, available := range []uint64{n, n - 1} {
					raw := fmt.Sprintf("MemTotal: %d kB\nMemAvailable: %d kB\n", host.total, available)
					if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
						t.Fatal(err)
					}
					if err := checkRAM(read, live); (err == nil) != (available == n) {
						t.Fatalf("boundary available=%d live=%d: %v", available, live, err)
					}
				}
			}
		})
	}
	missing := filepath.Join(t.TempDir(), "absent")
	if checkRAM(func() (ramMemory, error) { return readMemoryKB(missing) }, 0) == nil {
		t.Fatal("unreadable meminfo admitted")
	}
	for _, live := range []int{-1, int(^uint(0) >> 1)} {
		if checkRAM(func() (ramMemory, error) { return ramMemory{total: ^uint64(0), available: ^uint64(0)}, nil }, live) == nil {
			t.Fatal("invalid reservation count admitted")
		}
	}
}
func TestMultiCapsuleRejectSharedRAM(t *testing.T) {
	f := newPair(t)
	a := f.profiles["pair-a"]
	f.profiles["pair-b"] = a
	if err := validateProfileRoots(f.profiles); err != nil {
		t.Fatalf("shared canonical roots refused: %v", err)
	}
	a.RAMRoot = filepath.Join(a.RAMRoot, "child")
	if err := os.Mkdir(a.RAMRoot, 0700); err != nil {
		t.Fatal(err)
	}
	f.profiles["pair-b"] = a
	if validateProfileRoots(f.profiles) == nil {
		t.Fatal("nested roots admitted")
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(f.profiles["pair-a"].RAMRoot, link); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{link, f.profiles["pair-a"].RAMRoot + "/", filepath.Join(f.profiles["pair-a"].RAMRoot, "missing")} {
		f.profiles["pair-b"] = capsule.Profile{RAMRoot: bad}
		if validateProfileRoots(f.profiles) == nil {
			t.Fatalf("non-canonical root admitted: %s", bad)
		}
	}
}

// admissionRunner has no frame publisher dependency: these tests exercise the
// host gate on systems where /dev/shm is not mounted as tmpfs.
type admissionRunner struct{ orphan bool }

func (r admissionRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	if args[1] == "stop" {
		return nil, errors.New("unverified stop")
	}
	if r.orphan {
		return []byte(`{"container":"srf-id-abcdef123456","run_id":"run","windows":[]}`), nil
	}
	dir, err := os.Open(os.Getenv("MV_RAM_ADMISSION_DIR"))
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	if err := syscall.Flock(int(dir.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != syscall.EWOULDBLOCK {
		if err == nil {
			_ = syscall.Flock(int(dir.Fd()), syscall.LOCK_UN)
		}
		return nil, fmt.Errorf("admission lock not held across native start: %v", err)
	}
	var random [6]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	return []byte(fmt.Sprintf(`{"container":"srf-id-%x","run_id":"run","windows":[{"id":"w1","w":2,"h":1}]}`, random)), nil
}
func bareAdmissionManager(t *testing.T, orphan bool) (*capsule.Manager, ipc.Handler) {
	t.Helper()
	root, err := os.MkdirTemp("/dev/shm", "mv-admission-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: map[string]capsule.Profile{
		"pair-a": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1},
		"pair-b": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":101", Width: 2, Height: 1},
	}, MaxSurfaces: 16, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 1}, admissionRunner{orphan: orphan}, monotonic)
	if err != nil {
		t.Fatal(err)
	}
	next := func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
		var q capsule.Request
		_ = json.Unmarshal(e.Body, &q)
		events, err := m.Handle(ctx, q)
		if err != nil {
			return wireFailure(e, q, err)
		}
		return events, nil
	}
	return m, admittedHandler(m, next, func() (ramMemory, error) {
		return ramMemory{available: ramFloorKB + ramReserveKB - 1, total: 121 * 1024 * 1024}, nil
	})
}
func admissionCreate(h ipc.Handler, profile string) []json.RawMessage {
	body, _ := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": "create", "params": map[string]any{"kind": "browser", "profile_id": profile, "geometry": map[string]int{"w": 2, "h": 1}}})
	out, err := h(context.Background(), ipc.Envelope{Body: body})
	if err != nil {
		panic(err)
	}
	return out
}
func TestRAMAdmissionAcrossManagers(t *testing.T) {
	t.Setenv("MV_RAM_ADMISSION_DIR", filepath.Join(t.TempDir(), "shared"))
	_, a := bareAdmissionManager(t, false)
	_, b := bareAdmissionManager(t, false)
	if out := admissionCreate(a, "pair-a"); !strings.Contains(string(out[0]), `"event":"created"`) {
		t.Fatalf("first: %s", out)
	}
	if out := admissionCreate(b, "pair-b"); !strings.Contains(string(out[0]), "RAM_ADMISSION_REFUSED") {
		t.Fatalf("sibling invisible: %s", out)
	}
}
func TestRAMAdmissionConcurrentManagers(t *testing.T) {
	t.Setenv("MV_RAM_ADMISSION_DIR", filepath.Join(t.TempDir(), "shared"))
	_, a := bareAdmissionManager(t, false)
	_, b := bareAdmissionManager(t, false)
	start := make(chan struct{})
	results := make(chan []json.RawMessage, 2)
	var wg sync.WaitGroup
	for _, h := range []ipc.Handler{a, b} {
		wg.Add(1)
		go func(h ipc.Handler) { defer wg.Done(); <-start; results <- admissionCreate(h, "pair-a") }(h)
	}
	close(start)
	wg.Wait()
	close(results)
	created, refused := 0, 0
	for out := range results {
		if strings.Contains(string(out[0]), `"event":"created"`) {
			created++
		}
		if strings.Contains(string(out[0]), "RAM_ADMISSION_REFUSED") {
			refused++
		}
	}
	if created != 1 || refused != 1 {
		t.Fatalf("created=%d refused=%d", created, refused)
	}
}
func TestRAMAdmissionCountsUnboundQuarantine(t *testing.T) {
	t.Setenv("MV_RAM_ADMISSION_DIR", filepath.Join(t.TempDir(), "shared"))
	m, h := bareAdmissionManager(t, true)
	if out := admissionCreate(h, "pair-a"); !strings.Contains(string(out[0]), `"event":"error"`) {
		t.Fatalf("expected failed readiness: %s", out)
	}
	if !m.AdmissionProfiles()["pair-a"] {
		t.Fatal("unbound orphan disappeared")
	}
	if out := admissionCreate(h, "pair-b"); !strings.Contains(string(out[0]), "RAM_ADMISSION_REFUSED") {
		t.Fatalf("quarantine invisible: %s", out)
	}
}
func TestRAMAdmissionRetainsUnknownDeadDaemon(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared")
	t.Setenv("MV_RAM_ADMISSION_DIR", path)
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "dead-pid-unknown-container"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	_, h := bareAdmissionManager(t, false)
	if out := admissionCreate(h, "pair-a"); !strings.Contains(string(out[0]), "RAM_ADMISSION_REFUSED") {
		t.Fatalf("dead pid treated as container absence: %s", out)
	}
}

func TestReservationProfileSuffixAndUnsafeName(t *testing.T) {
	dir := t.TempDir()
	owner := "12345-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	profile := "mv-example"
	legacy := fmt.Sprintf("%s-%x", owner, sha256.Sum256([]byte(profile)))
	if err := os.WriteFile(filepath.Join(dir, legacy), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := syncAdmissionRecords(dir, owner, map[string]bool{profile: true}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != legacy+"--"+profile {
		t.Fatalf("profile reservation: %v %v", entries, err)
	}
	if err := syncAdmissionRecords(dir, owner, map[string]bool{"../escape": true}); err == nil {
		t.Fatal("unsafe profile accepted")
	}
	if err := syncAdmissionRecords(dir, owner, map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	entries, err = os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("released reservation: %v %v", entries, err)
	}
}
