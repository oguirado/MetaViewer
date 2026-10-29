package frames

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/capsule"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func ringFixture(t *testing.T) (*RingSource, capsule.Binding, string, []byte) {
	t.Helper()
	root := t.TempDir()
	run := filepath.Join(root, "run")
	dir := filepath.Join(run, "window")
	for _, d := range []string{root, run, dir} {
		if err := os.MkdirAll(d, 0770); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(d, os.ModeSetgid|0770); err != nil {
			t.Fatal(err)
		}
	}
	s := &RingSource{root: root, uid: uint32(os.Geteuid()), gid: uint32(os.Getegid()), clock: func() uint64 { return 1_000_000_000 }, origin: 1, retries: 4, maxAge: 500_000_000, stat: syscall.Fstat, statfs: func(_ int, fs *syscall.Statfs_t) error { fs.Type = 0x01021994; fs.Flags = ringFlags; return nil }, pinned: map[string]ringGeometry{}, payloads: map[string][]ringPayload{}}
	b := capsule.Binding{Surface: capsule.Surface{SurfaceID: "surface", Geometry: capsule.Geometry{W: 2, H: 1}}, RunID: "run", Window: "window", Container: "container"}
	raw := []byte{255, 0, 0, 0, 255, 0}
	wire := make([]byte, 64+2*(64+len(raw)))
	copy(wire, "OSRG")
	u := binary.BigEndian.PutUint32
	u(wire[4:8], 1)
	u(wire[8:12], 2)
	u(wire[12:16], 2)
	u(wire[16:20], 1)
	u(wire[20:24], 6)
	u(wire[24:28], 60)
	putRingSlot(wire[64:134], 2, 10, 999_000_000, raw)
	putRingSlot(wire[134:204], 4, 11, 999_000_000, raw)
	path := filepath.Join(dir, "ring.rgb24")
	writeRingFixture(t, path, wire)
	return s, b, path, wire
}
func putRingSlot(slot []byte, lock, seq, mono uint64, raw []byte) {
	u := binary.BigEndian.PutUint64
	u(slot[:8], lock)
	u(slot[8:16], seq)
	u(slot[16:24], mono)
	binary.BigEndian.PutUint32(slot[24:28], 2)
	binary.BigEndian.PutUint32(slot[28:32], 1)
	sum := sha256.Sum256(raw)
	copy(slot[32:64], sum[:])
	copy(slot[64:], raw)
}
func writeRingFixture(t *testing.T, path string, wire []byte) {
	t.Helper()
	if err := os.WriteFile(path, wire, 0640); err != nil {
		t.Fatal(err)
	}
}
func requireRingCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *RingError
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}
func TestRingNewestSequenceAndRawPublish(t *testing.T) {
	s, b, path, wire := ringFixture(t)
	// LatestSlot/PublishedSeq are deliberately misleading: order sealed slots.
	binary.BigEndian.PutUint64(wire[32:40], 0)
	binary.BigEndian.PutUint64(wire[40:48], 10)
	writeRingFixture(t, path, wire)
	f, raw, err := s.read(b)
	if err != nil || f.Seq != 11 || f.Path != path || f.Generation != b.Container || f.TSNS != 998_999_999 {
		t.Fatalf("%+v %v", f, err)
	}
	root, _, _ := ramFixture(t)
	p := publisher(t, root)
	p.sourceRead = func(int, string, string) ([]byte, error) { t.Fatal("ring tried PNG source read"); return nil, nil }
	ref, changed, err := p.PublishRGB24(b.Surface.SurfaceID, b, f, raw)
	if err != nil || !changed {
		t.Fatalf("publish %v %v", changed, err)
	}
	for i := 0; i < 2; i++ {
		f.Seq++
		f.TSNS++
		again, changed, err := p.PublishRGB24(b.Surface.SurfaceID, b, f, raw)
		if err != nil || changed || again != ref {
			t.Fatalf("unchanged ref %v %v", changed, err)
		}
	}
	f.Seq++
	raw[0] ^= 1
	if _, _, err = p.PublishRGB24(b.Surface.SurfaceID, b, f, raw); err == nil {
		t.Fatal("M-RING-SKIP-DIGEST: corrupted raw accepted after dedup warmup")
	}
}
func TestRingRefusals(t *testing.T) {
	for _, name := range []string{"extra", "oversize", "undersize", "gid", "mode", "torn", "digest", "stale", "future", "missing", "symlink", "rootfs", "rootflags", "rootgid", "rootmode"} {
		t.Run(name, func(t *testing.T) {
			s, b, path, wire := ringFixture(t)
			code := "ring_hostile"
			switch name {
			case "extra":
				writeRingFixture(t, filepath.Join(filepath.Dir(path), "extra"), []byte{1})
			case "oversize":
				writeRingFixture(t, path, append(wire, 0))
				code = "ring_length"
			case "undersize":
				writeRingFixture(t, path, wire[:len(wire)-1])
				code = "ring_length"
			case "gid":
				s.stat = func(fd int, st *syscall.Stat_t) error {
					e := syscall.Fstat(fd, st)
					if st.Mode&syscall.S_IFMT == syscall.S_IFREG {
						st.Gid++
					}
					return e
				}
			case "mode":
				if err := os.Chmod(path, 0660); err != nil {
					t.Fatal(err)
				}
			case "torn":
				binary.BigEndian.PutUint64(wire[64:72], 3)
				binary.BigEndian.PutUint64(wire[134:142], 5)
				writeRingFixture(t, path, wire)
				code = "ring_torn"
			case "digest":
				wire[128] ^= 1
				wire[198] ^= 1
				writeRingFixture(t, path, wire)
				code = "ring_torn"
			case "stale", "future":
				mono := uint64(1)
				if name == "future" {
					mono = 1_000_000_001
				}
				binary.BigEndian.PutUint64(wire[80:88], mono)
				binary.BigEndian.PutUint64(wire[150:158], mono)
				writeRingFixture(t, path, wire)
				code = "ring_stale"
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				code = "ring_missing"
			case "symlink":
				if err := os.Rename(path, path+".real"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path+".real", path); err != nil {
					t.Fatal(err)
				}
			case "rootfs":
				s.statfs = func(_ int, fs *syscall.Statfs_t) error { fs.Type = 0; fs.Flags = ringFlags; return nil }
				code = "ring_root"
			case "rootflags":
				s.statfs = func(_ int, fs *syscall.Statfs_t) error { fs.Type = 0x01021994; fs.Flags = 0; return nil }
				code = "ring_root"
			case "rootgid":
				s.gid++
				code = "ring_root"
			case "rootmode":
				if err := os.Chmod(s.root, 0770); err != nil {
					t.Fatal(err)
				}
				code = "ring_root"
			}
			_, _, err := s.read(b)
			requireRingCode(t, err, code)
			if name == "stale" && (!errors.Is(err, context.DeadlineExceeded) || shouldMarkCaptureLost(err)) {
				t.Fatal("stale promoted to confirmed loss")
			}
		})
	}
}
func TestRingPinnedGeometry(t *testing.T) {
	s, b, path, wire := ringFixture(t)
	if _, _, err := s.read(b); err != nil {
		t.Fatal(err)
	}
	binary.BigEndian.PutUint32(wire[24:28], 59)
	writeRingFixture(t, path, wire)
	_, _, err := s.read(b)
	requireRingCode(t, err, "ring_geometry")
}
func TestRingRootNoFollow(t *testing.T) {
	s, b, _, _ := ringFixture(t)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(s.root, link); err != nil {
		t.Fatal(err)
	}
	s.root = link
	_, _, err := s.read(b)
	requireRingCode(t, err, "ring_root")
}
func TestRingModeReporting(t *testing.T) {
	legacy := &captureSource{}
	for _, tc := range []struct {
		name          string
		enabled, fail bool
		mode          string
	}{{"off", false, false, capsule.CaptureModeLegacy}, {"root refused", true, true, capsule.CaptureModeLegacy}, {"ring", true, false, capsule.CaptureModeRing}} {
		t.Run(tc.name, func(t *testing.T) {
			var report bytes.Buffer
			calls := 0
			ring := &RingSource{}
			selected, interval := SelectRingSource(legacy, tc.enabled, 25, &report, func() (*RingSource, error) {
				calls++
				if tc.fail {
					return nil, ringError("ring_root")
				}
				return ring, nil
			})
			if tc.enabled && !strings.Contains(report.String(), "capture_mode="+tc.mode) {
				t.Fatal(report.String())
			}
			if !tc.enabled && (calls != 0 || report.Len() != 0) {
				t.Fatal("off opened ring")
			}
			if tc.mode == capsule.CaptureModeRing {
				if selected != ring || interval != 40*time.Millisecond {
					t.Fatal("ring selection/cadence")
				}
			} else if selected != legacy {
				t.Fatal("legacy selection")
			}
			if tc.fail && !strings.Contains(report.String(), "ring_root") {
				t.Fatal("silent root fallback")
			}
		})
	}
}
func TestRing25FPSVirtualCadence(t *testing.T) {
	root, b, f := ramFixture(t)
	clock := newCadenceClock()
	start := clock.Now()
	source := &cadenceSource{captureSource: &captureSource{b: b, f: f}, clock: clock, starts: make(chan time.Time, 16)}
	s, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: RingPollInterval(25), CaptureTimeout: time.Second, ShutdownTimeout: time.Second, Serial: true}, source, publisher(t, root), func(context.Context, json.RawMessage) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	s.clock = clock
	t.Cleanup(func() {
		if err := s.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	if err = s.Subscribe(context.Background(), b.Surface.SurfaceID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if got := cadenceReceive(t, source.starts).Sub(start); got != time.Duration(i)*40*time.Millisecond {
			t.Fatalf("start %s", got)
		}
		wait := cadenceReceive(t, clock.resets)
		if wait != 40*time.Millisecond {
			t.Fatalf("M-RING-POLL-SLOW: wait %s", wait)
		}
		clock.advance(wait)
	}
	for _, fps := range []int{-1, 1, 24, 25, 60, 120, 121} {
		if d := RingPollInterval(fps); d > 40*time.Millisecond || d < time.Second/120 {
			t.Fatalf("fps %d: %s", fps, d)
		}
	}
}

type ringRunner struct{ calls []string }

func (r *ringRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	r.calls = append(r.calls, args[1])
	switch args[1] {
	case "start":
		return []byte(`{"container":"srf-id-demo","run_id":"run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"","url":""}]}`), nil
	case "stop":
		return []byte(`{"stopped":"srf-id-demo","removed_verified":true}`), nil
	default:
		return nil, errors.New("legacy frame must never run after ring selection")
	}
}
func TestRingCaptureNoFallbackAndHostileStop(t *testing.T) {
	for _, scenario := range []string{"missing", "hostile", "torn", "large-seq", "retention"} {
		hostile := scenario == "hostile"
		t.Run(scenario, func(t *testing.T) {
			s, _, path, wire := ringFixture(t)
			if err := os.Rename(filepath.Dir(path), filepath.Join(filepath.Dir(filepath.Dir(path)), "w1")); err != nil {
				t.Fatal(err)
			}
			runner := &ringRunner{}
			m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), OriginNS: 1, MaxSurfaces: 1, MaxOutputBytes: 4096, Timeout: time.Second, Profiles: map[string]capsule.Profile{"demo": {Kind: "browser", NativeKind: "browser", Width: 2, Height: 1, Display: ":100", RAMRoot: "/dev/shm"}}}, runner, s.clock)
			if err != nil {
				t.Fatal(err)
			}
			events, err := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: json.RawMessage(`{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)})
			if err != nil {
				t.Fatal(err)
			}
			var ev struct {
				Data struct {
					Surface capsule.Surface `json:"surface"`
				} `json:"data"`
			}
			if err = json.Unmarshal(events[0], &ev); err != nil {
				t.Fatal(err)
			}
			s.Manager = m
			b, f, err := s.Capture(context.Background(), ev.Data.Surface.SurfaceID)
			if err != nil {
				t.Fatal(err)
			}
			root, _, _ := ramFixture(t)
			p := publisher(t, root)
			p.UseRingSource(s)
			if _, changed, err := p.PublishIfChanged(b.Surface.SurfaceID, b, f); err != nil || !changed {
				t.Fatalf("handoff publish %v", err)
			}
			path = filepath.Join(s.root, "run", "w1", "ring.rgb24")
			if scenario == "retention" {
				for i := 0; i < 4; i++ {
					if _, _, e := s.Capture(context.Background(), b.Surface.SurfaceID); e != nil {
						t.Fatal(e)
					}
					if q := s.payloads[b.Surface.SurfaceID]; len(q) == 2 && cap(q) != 2 {
						t.Fatal("M-QUEUE-ALIAS")
					}
				}
				q := s.payloads[b.Surface.SurfaceID]
				if len(q) != 2 || cap(q) != 2 {
					t.Fatal("M-QUEUE-ALIAS")
				}
				s.Forget(b.Surface.SurfaceID)
				if len(s.pinned) != 0 || len(s.payloads) != 0 {
					t.Fatal("M-FORGET")
				}
				return
			}
			if scenario == "large-seq" {
				binary.BigEndian.PutUint64(wire[142:150], 1_000_001)
				writeRingFixture(t, path, wire)
				_, f, e := s.Capture(context.Background(), b.Surface.SurfaceID)
				if e != nil || f.Seq != 1_000_001 || len(runner.calls) != 1 {
					t.Fatalf("M-SEQ-CAP: %v %v", f, e)
				}
				return
			}
			if scenario == "torn" {
				binary.BigEndian.PutUint64(wire[64:72], 3)
				binary.BigEndian.PutUint64(wire[134:142], 5)
				writeRingFixture(t, path, wire)
				_, _, e := s.Capture(context.Background(), b.Surface.SurfaceID)
				requireRingCode(t, e, "ring_torn")
				if len(runner.calls) != 1 || shouldMarkCaptureLost(e) {
					t.Fatal("M-TORN-STOP")
				}
				if _, e = m.SubscriptionBinding(b.Surface.SurfaceID); e != nil {
					t.Fatal(e)
				}
				return
			}
			if hostile {
				writeRingFixture(t, filepath.Join(filepath.Dir(path), "extra"), []byte{1})
			} else if err = os.Remove(path); err != nil {
				t.Fatal(err)
			}
			_, _, err = s.Capture(context.Background(), b.Surface.SurfaceID)
			code := "ring_missing"
			if hostile {
				code = "ring_hostile"
			}
			requireRingCode(t, err, code)
			for _, op := range runner.calls {
				if op == "frame" {
					t.Fatal("M-RING-SILENT-FALLBACK: CLI frame executed")
				}
			}
			want := 1
			if hostile {
				want = 2
			}
			if len(runner.calls) != want {
				t.Fatalf("calls %v", runner.calls)
			}
			if hostile {
				if len(s.pinned) != 0 || len(s.payloads) != 0 {
					t.Fatal("M-STOP-LEAK")
				}
				if _, err = m.SubscriptionBinding(b.Surface.SurfaceID); err == nil {
					t.Fatal("hostile binding still active")
				}
			}
		})
	}
}

func TestRingPostOpenGeometryChange(t *testing.T) {
	s, b, path, wire := ringFixture(t)
	changed := false
	s.clock = func() uint64 {
		if !changed {
			changed = true
			binary.BigEndian.PutUint32(wire[24:28], 59)
			writeRingFixture(t, path, wire)
		}
		return 1_000_000_000
	}
	_, _, err := s.read(b)
	requireRingCode(t, err, "ring_geometry")
}
func TestRingFileMountGate(t *testing.T) {
	s, b, _, _ := ringFixture(t)
	original := s.statfs
	s.statfs = func(fd int, fs *syscall.Statfs_t) error {
		if err := original(fd, fs); err != nil {
			return err
		}
		var st syscall.Stat_t
		if err := syscall.Fstat(fd, &st); err != nil {
			return err
		}
		if st.Mode&syscall.S_IFMT == syscall.S_IFREG {
			fs.Flags = 0
		}
		return nil
	}
	_, _, err := s.read(b)
	requireRingCode(t, err, "ring_hostile")
}

func TestRingPostReadMetadata(t *testing.T) {
	for _, name := range []string{"nlink", "flags", "fstype"} {
		t.Run(name, func(t *testing.T) {
			s, b, _, _ := ringFixture(t)
			final := false
			s.clock = func() uint64 { final = true; return 1_000_000_000 }
			originalStat, originalFS := s.stat, s.statfs
			s.stat = func(fd int, st *syscall.Stat_t) error {
				e := originalStat(fd, st)
				if final && name == "nlink" {
					st.Nlink = 2
				}
				return e
			}
			s.statfs = func(fd int, fs *syscall.Statfs_t) error {
				e := originalFS(fd, fs)
				if final {
					if name == "flags" {
						fs.Flags = 0
					}
					if name == "fstype" {
						fs.Type = 0
					}
				}
				return e
			}
			_, _, e := s.read(b)
			requireRingCode(t, e, "ring_hostile")
		})
	}
}
func TestRingRetryAllocationBound(t *testing.T) {
	s, b, path, wire := ringFixture(t)
	wire[128] ^= 1
	wire[198] ^= 1
	writeRingFixture(t, path, wire)
	measure := func(n int) float64 {
		s.retries = n
		return testing.AllocsPerRun(10, func() { _, _, e := s.read(b); requireRingCode(t, e, "ring_torn") })
	}
	base, retry := measure(1), measure(16)
	if retry > base+4 {
		t.Fatalf("M-SLOT-ALLOC: %f -> %f", base, retry)
	}
}
func TestRingWriterUID(t *testing.T) {
	s, b, _, _ := ringFixture(t)
	s.stat = func(fd int, st *syscall.Stat_t) error {
		e := syscall.Fstat(fd, st)
		if st.Mode&syscall.S_IFMT == syscall.S_IFREG {
			st.Uid = 10001
		}
		return e
	}
	if _, _, e := s.read(b); e != nil {
		t.Fatal(e)
	}
}
