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
	"metaviewer/daemon-adapter/internal/cli"
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
	}, f.profiles)
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
				n := host.floor + ramReserveKB*(uint64(live)+1)
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
	return []byte(fmt.Sprintf(`{"container":"srf-id-%x","run_id":"run-%x","windows":[{"id":"w1","w":2,"h":1}]}`, random, random)), nil
}
func bareAdmissionManager(t *testing.T, orphan bool) (*capsule.Manager, ipc.Handler) {
	t.Helper()
	root, err := os.MkdirTemp("/dev/shm", "mv-admission-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	profiles := map[string]capsule.Profile{
		"pair-a": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1},
		"pair-b": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":101", Width: 2, Height: 1},
	}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 16, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 1}, admissionRunner{orphan: orphan}, monotonic)
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
		return ramMemory{available: ramFloorKB + 2*ramReserveKB - 1, total: 121 * 1024 * 1024}, nil
	}, profiles)
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

// Constants in this table are independent of production reserve/floor constants.
func TestRAMAdmissionJudgeTable(t *testing.T) {
	old := admissionMemory
	t.Cleanup(func() { admissionMemory = old })
	for _, totalGiB := range []uint64{8, 12, 16, 32, 121} {
		for live := 0; live <= 3; live++ {
			t.Run(fmt.Sprintf("%dGiB/%d-incumbents", totalGiB, live), func(t *testing.T) {
				total := totalGiB * 1024 * 1024
				floor := min(uint64(20*1024*1024), total/4)
				needed := floor + 4*1024*1024*uint64(live+1)
				admissionMemory = func() (ramMemory, error) { return ramMemory{total: total, available: total}, nil }
				err := checkRAM(admissionMemory, live)
				if (err == nil) != (total >= needed) {
					t.Fatalf("judge admission: needed=%d MiB available=%d MiB err=%v", needed/1024, total/1024, err)
				}
				// Force a numeric refusal even on hosts whose full capacity admits.
				available := min(total, needed-1024)
				admissionMemory = func() (ramMemory, error) { return ramMemory{total: total, available: available}, nil }
				err = checkRAM(admissionMemory, live)
				want := fmt.Sprintf("host MemAvailable below floor plus capsule reserves: needed %d MiB (floor %d MiB + reserve 4096 MiB x (%d incumbents + 1)), available %d MiB, total %d MiB, incumbents %d", needed/1024, floor/1024, live, available/1024, total/1024, live)
				var fault *cli.Fault
				if !errors.As(err, &fault) || fault.Code != "RAM_ADMISSION_REFUSED" || fault.Detail != want {
					t.Fatalf("numeric refusal: got %v want %s", err, want)
				}
				t.Logf("needed=%d MiB capacity=%d MiB admit=%t", needed/1024, total/1024, total >= needed)
			})
		}
	}
	// Verify on the GB10 (121 GiB) that four capsules sequentially admit through the full handler.
	t.Run("GB10-four-capsules", func(t *testing.T) {
		t.Setenv("MV_RAM_ADMISSION_DIR", filepath.Join(t.TempDir(), "gb10"))
		root, err := os.MkdirTemp("/dev/shm", "mv-gb10-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(root) })
		profiles := map[string]capsule.Profile{}
		for i := 1; i <= 4; i++ {
			id := fmt.Sprintf("mv-live-%d", i)
			profiles[id] = capsule.Profile{Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: fmt.Sprintf(":%d", 99+i), Width: 2, Height: 1}
		}
		m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 16, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 1}, admissionRunner{}, monotonic)
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
		h := admittedHandler(m, next, func() (ramMemory, error) {
			return ramMemory{available: 121 * 1024 * 1024, total: 121 * 1024 * 1024}, nil
		}, profiles)
		for i := 1; i <= 4; i++ {
			id := fmt.Sprintf("mv-live-%d", i)
			if out := admissionCreate(h, id); !strings.Contains(string(out[0]), `"event":"created"`) {
				t.Fatalf("GB10 capsule %d (%s) refused: %s", i, id, out)
			}
		}
	})
	// Verify an 8 GiB host admits the first capsule and refuses the second before Docker.
	t.Run("8GiB-second-refused-before-docker", func(t *testing.T) {
		f := newPair(t)
		f.available = 8 * 1024 * 1024
		m := capsuleMustManager(t, f)
		next := func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
			var q capsule.Request
			_ = json.Unmarshal(e.Body, &q)
			events, err := m.Handle(ctx, q)
			if err != nil {
				return wireFailure(e, q, err)
			}
			return events, nil
		}
		f.h = admittedHandler(m, next, func() (ramMemory, error) {
			return ramMemory{available: 8 * 1024 * 1024, total: 8 * 1024 * 1024}, nil
		}, f.profiles)
		out1 := admissionCreate(f.h, "pair-a")
		if !strings.Contains(string(out1[0]), `"event":"created"`) || f.native.starts != 1 {
			t.Fatalf("8GiB first capsule failed: %s starts=%d", out1, f.native.starts)
		}
		out2 := admissionCreate(f.h, "pair-b")
		if len(out2) != 1 || !strings.Contains(string(out2[0]), `"code":"RAM_ADMISSION_REFUSED"`) || !strings.Contains(string(out2[0]), "needed 10240 MiB") || f.native.starts != 1 {
			t.Fatalf("8GiB second capsule was not refused before Docker: %s starts=%d", out2, f.native.starts)
		}
	})
}

func capsuleMustManager(t *testing.T, f *pairFixture) *capsule.Manager {
	t.Helper()
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: f.profiles, MaxSurfaces: 16, MaxOutputBytes: 8192, Timeout: time.Second, OriginNS: 1}, f.native, monotonic)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestRAMAdmissionProfileCost(t *testing.T) {
	f := newPair(t)
	SetProfileMemoryMiB("pair-a", 8192)
	t.Cleanup(func() { SetProfileMemoryMiB("pair-a", 0) })
	f.available = ramFloorKB + 8192*1024 - 1
	out := f.call(t, "create", map[string]any{"kind": "browser", "profile_id": "pair-a", "geometry": map[string]int{"w": 2, "h": 1}})
	if len(out) != 1 || !strings.Contains(string(out[0]), "reserve 8192 MiB") || f.native.starts != 0 {
		t.Fatalf("profile ceiling ignored: %s", out)
	}
	f.available++
	f.create(t, "pair-a")
	out = f.call(t, "create", map[string]any{"kind": "browser", "profile_id": "pair-b", "geometry": map[string]int{"w": 2, "h": 1}})
	if len(out) != 1 || !strings.Contains(string(out[0]), "reserve 8192 MiB") {
		t.Fatalf("incumbent profile ceiling ignored: %s", out)
	}
	SetProfileMemoryMiB("pair-b", 1024)
	t.Cleanup(func() { SetProfileMemoryMiB("pair-b", 0) })
	if profileReserveKB("pair-b") != 1024*1024 {
		t.Fatal("declared profile ceiling ignored")
	}
}

func TestRAMAdmissionSHMBeforeCreate(t *testing.T) {
	old := admissionStatfs
	t.Cleanup(func() { admissionStatfs = old })
	for _, freeMiB := range []uint64{511, 512} {
		t.Run(fmt.Sprint(freeMiB), func(t *testing.T) {
			f := newPair(t)
			admissionStatfs = func(fd int, st *syscall.Statfs_t) error {
				if _, err := os.Stat(fmt.Sprintf("/proc/self/fd/%d", fd)); err != nil {
					return err
				}
				st.Type = 0x01021994
				st.Bsize = 4096
				st.Bavail = freeMiB * 256
				return nil
			}
			out := f.call(t, "create", map[string]any{"kind": "browser", "profile_id": "pair-a", "geometry": map[string]int{"w": 2, "h": 1}})
			if freeMiB < 512 {
				if len(out) != 1 || !strings.Contains(string(out[0]), `"code":"SHM_ADMISSION_REFUSED"`) || !strings.Contains(string(out[0]), "free 511 MiB, needed 512 MiB") || f.native.starts != 0 {
					t.Fatalf("missing shm check before native create: %s starts=%d", out, f.native.starts)
				}
			} else if len(out) != 2 || f.native.starts != 1 {
				t.Fatalf("shm boundary refused: %s", out)
			}
		})
	}
	if checkSHMFree(0, 4096) == nil || checkSHMFree(^uint64(0), 4096) == nil || checkSHMFree(1, 0) == nil {
		t.Fatal("invalid/empty shm admitted")
	}
	if err := checkSHM(filepath.Join(t.TempDir(), "missing")); err == nil || capsule.WireCode(err) != "SHM_ADMISSION_REFUSED" {
		t.Fatalf("unreadable shm admitted or untyped: %v", err)
	}
	admissionStatfs = func(_ int, _ *syscall.Statfs_t) error { return errors.New("probe failed") }
	if err := checkSHM(t.TempDir()); err == nil || capsule.WireCode(err) != "SHM_ADMISSION_REFUSED" {
		t.Fatalf("failed fstatfs admitted or untyped: %v", err)
	}
	admissionStatfs = func(_ int, st *syscall.Statfs_t) error { st.Type = 1; return nil }
	if err := checkSHM(t.TempDir()); err == nil || capsule.WireCode(err) != "SHM_ADMISSION_REFUSED" {
		t.Fatalf("non-tmpfs admitted or untyped: %v", err)
	}
}
