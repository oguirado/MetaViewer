package frames

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"metaviewer/daemon-adapter/internal/capsule"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func displayTestTarget() DisplayTarget {
	return DisplayTarget{Container: "srf-id-test", Run: "test-run", Window: "w1", Display: ":100", XID: 42, Width: 2, Height: 1}
}
func displayTestXWD(t DisplayTarget, value byte) []byte {
	b := make([]byte, 100+4*t.Width*t.Height)
	fields := map[int]uint32{0: 100, 1: 7, 2: 2, 3: 24, 4: uint32(t.Width), 5: uint32(t.Height), 11: 32, 12: uint32(4 * t.Width), 13: 4, 14: 0xff0000, 15: 0xff00, 16: 0xff}
	for i, v := range fields {
		binary.BigEndian.PutUint32(b[i*4:], v)
	}
	for i := 100; i < len(b); i += 4 {
		b[i], b[i+1], b[i+2] = value, value+1, value+2
	}
	return b
}
func displayTestRecord(t DisplayTarget, d [32]byte, seq uint64) []byte {
	a := displayTestXWD(t, byte(seq))
	h := make([]byte, 128)
	copy(h, "W8UF")
	be := binary.BigEndian
	be.PutUint16(h[4:], 1)
	be.PutUint16(h[6:], 128)
	be.PutUint64(h[8:], uint64(144+2*len(a)))
	be.PutUint64(h[16:], seq)
	be.PutUint64(h[32:], seq)
	be.PutUint32(h[40:], uint32(t.Width))
	be.PutUint32(h[44:], uint32(t.Height))
	be.PutUint32(h[48:], uint32(3*t.Width))
	be.PutUint16(h[52:], 1)
	be.PutUint16(h[54:], 1)
	be.PutUint64(h[56:], uint64(16+2*len(a)))
	copy(h[96:], d[:])
	h = be.AppendUint64(h, uint64(len(a)))
	h = append(h, a...)
	h = be.AppendUint64(h, uint64(len(a)))
	return append(h, a...)
}
func displayTestHello(d [32]byte) []byte {
	h := make([]byte, 44)
	copy(h, "W8UH")
	binary.BigEndian.PutUint16(h[4:], 1)
	binary.BigEndian.PutUint16(h[6:], 1)
	copy(h[12:], d[:])
	return h
}
func displayReadControl(r io.Reader) (uint16, [32]byte, error) {
	var d [32]byte
	h := make([]byte, 44)
	if _, e := io.ReadFull(r, h); e != nil {
		return 0, d, e
	}
	n := binary.BigEndian.Uint32(h[8:])
	if string(h[:4]) != "W8UC" || n > 16384 {
		return 0, d, errors.New("bad control")
	}
	copy(d[:], h[12:])
	_, e := io.CopyN(io.Discard, r, int64(n))
	return binary.BigEndian.Uint16(h[6:]), d, e
}

// This executable is the fake stream sender. It uses real pipes/processes and
// never invokes docker or a real capsule.
func TestDisplaySenderHelper(t *testing.T) {
	if os.Getenv("MV_DISPLAY_TEST_HELPER") != "1" {
		return
	}
	kind, d, e := displayReadControl(os.Stdin)
	if e != nil || kind != 1 {
		os.Exit(12)
	}
	if kind, _, e = displayReadControl(os.Stdin); e != nil || kind != 2 {
		os.Exit(13)
	}
	target := displayTestTarget()
	bias := uint64(0)
	if rawBias := os.Getenv("MV_DISPLAY_TEST_BIAS"); rawBias != "" {
		if parsed, err := strconv.ParseUint(rawBias, 10, 8); err == nil {
			bias = parsed
		}
	}
	os.Stdout.Write(displayTestHello(d))
	mode := os.Getenv("MV_DISPLAY_TEST_MODE")
	if mode == "stderr" {
		fmt.Fprintln(os.Stderr, "display-sender-failed")
		os.Exit(9)
	}
	if mode == "mid" {
		os.Stdout.Write(displayTestRecord(target, d, 1)[:150])
		for {
			k, _, e := displayReadControl(os.Stdin)
			if e != nil || k == 3 {
				os.Exit(0)
			}
		}
	}
	for seq := uint64(1); seq <= 80; seq++ {
		if seq == 2 && mode == "blocked" {
			for {
				if _, e := os.Stat(os.Getenv("MV_DISPLAY_TEST_RELEASE")); e == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
		}
		rec := displayTestRecord(target, d, seq+bias)
		binary.BigEndian.PutUint64(rec[16:], seq)
		binary.BigEndian.PutUint64(rec[32:], seq)
		if _, e = os.Stdout.Write(rec); e != nil {
			os.Exit(0)
		}
		if mode == "exit" {
			os.Exit(0)
		}
		k, _, e := displayReadControl(os.Stdin)
		if e != nil || k == 3 {
			os.Exit(0)
		}
	}
	for {
		k, _, e := displayReadControl(os.Stdin)
		if e != nil || k == 3 {
			os.Exit(0)
		}
	}
}

type displayHarness struct {
	tap        *DisplayTaps
	root, path string
	mu         sync.Mutex
	target     DisplayTarget
	dead       bool
	commands   []*exec.Cmd
	overlap    bool
}

func newDisplayHarness(t *testing.T, mode string) *displayHarness {
	t.Helper()
	root, e := os.MkdirTemp("/dev/shm", "mv-display-test-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	if e = os.Mkdir(filepath.Join(root, "metaviewer"), 0700); e != nil {
		t.Fatal(e)
	}
	h := &displayHarness{root: root, path: filepath.Join(root, "metaviewer", "display", "surface.ring"), target: displayTestTarget()}
	h.tap = NewDisplayTaps(context.Background(), DisplayTapConfig{RuntimeDir: root, Admit: func() error { return nil }, Resolve: func(string) (DisplayTarget, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.dead {
			return DisplayTarget{}, errors.New("capsule dead")
		}
		return h.target, nil
	}, Command: func(ctx context.Context, target DisplayTarget) *exec.Cmd {
		exe, e := os.Executable()
		if e != nil {
			panic(e)
		}
		cmd := exec.CommandContext(ctx, exe, "-test.run=^TestDisplaySenderHelper$")
		cmd.Env = append(os.Environ(), "MV_DISPLAY_TEST_HELPER=1", "MV_DISPLAY_TEST_MODE="+mode, "MV_DISPLAY_TEST_RELEASE="+filepath.Join(root, "release"))
		h.mu.Lock()
		for _, old := range h.commands {
			if old.Process != nil && syscall.Kill(old.Process.Pid, 0) == nil {
				h.overlap = true
			}
		}
		h.commands = append(h.commands, cmd)
		h.mu.Unlock()
		return cmd
	}})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if e := h.tap.Close(ctx); e != nil {
			t.Error(e)
		}
	})
	return h
}
func displayEventually(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("DISPLAY condition timed out")
}
func displaySnapshot(path string) ([]byte, uint64, uint64, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, 0, 0, e
	}
	defer f.Close()
	h := make([]byte, 64)
	if _, e = f.ReadAt(h, 0); e != nil {
		return nil, 0, 0, e
	}
	le := binary.LittleEndian
	seq := le.Uint64(h[24:])
	if seq == 0 || seq%2 != 0 {
		return nil, 0, 0, errors.New("unstable")
	}
	n := int(le.Uint32(h[16:]) * le.Uint32(h[12:]))
	b := make([]byte, n)
	_, e = f.ReadAt(b, int64(64+int((seq/2)%2)*n))
	if e != nil {
		return nil, 0, 0, e
	}
	check := make([]byte, 8)
	_, e = f.ReadAt(check, 24)
	if e != nil || le.Uint64(check) != seq {
		return nil, 0, 0, errors.New("torn")
	}
	return b, le.Uint64(h[32:]), le.Uint64(h[40:]), nil
}
func TestDisplayNewestOnlyBlockedReader(t *testing.T) {
	h := newDisplayHarness(t, "blocked")
	h.tap.Start("surface")
	h.tap.mu.Lock()
	first := h.tap.tasks["surface"]
	h.tap.mu.Unlock()
	h.tap.Start("surface")
	h.tap.mu.Lock()
	same := first == h.tap.tasks["surface"]
	h.tap.mu.Unlock()
	if !same {
		t.Fatal("duplicate supervisor for surface")
	}
	displayEventually(t, func() bool { _, mono, _, e := displaySnapshot(h.path); return e == nil && mono == 1 })
	// Hold a reader and an exclusive flock: neither participates in writer progress.
	f, e := os.Open(h.path)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	if e = os.WriteFile(filepath.Join(h.root, "release"), nil, 0600); e != nil {
		t.Fatal(e)
	}
	displayEventually(t, func() bool { _, m, _, e := displaySnapshot(h.path); return e == nil && m == 80 })
	b, mono, _, e := displaySnapshot(h.path)
	if e != nil || mono != 80 || !bytes.Equal(b, []byte{82, 81, 80, 82, 81, 80}) {
		t.Fatalf("newest frame: %v %d %v", e, mono, b)
	}
	st, _ := f.Stat()
	if st.Size() != 76 || st.Mode().Perm() != 0600 {
		t.Fatalf("ring size/mode: %v", st)
	}
	raw, _ := os.ReadFile(h.path)
	if string(raw[:8]) != "MVDISP1\x00" || binary.LittleEndian.Uint32(raw[20:]) != 1 || !bytes.Equal(raw[48:64], make([]byte, 16)) {
		t.Fatal("ring ABI")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.commands) != 1 {
		t.Fatal("more than one resident sender")
	}
}
func TestDisplayTruncatedRecord(t *testing.T) {
	target := displayTestTarget()
	_, d := displayBinding(target)
	rec := displayTestRecord(target, d, 1)
	for _, cut := range []int{0, 3, 4, 40, 127, 128, 135, 150, len(rec) - 1} {
		calls := 0
		wire := append(displayTestHello(d), rec[:cut]...)
		e := displayDecode(bytes.NewReader(wire), io.Discard, d, target, func([]byte, uint64, DisplayTarget) error { calls++; return nil })
		if e == nil || calls != 0 {
			t.Fatalf("truncated record admitted at %d: %v", cut, e)
		}
	}
}
func TestDisplayExitRestartNoOverlap(t *testing.T) {
	h := newDisplayHarness(t, "exit")
	h.tap.Start("surface")
	displayEventually(t, func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.commands) >= 3 })
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.overlap {
		t.Fatal("overlapping stream incarnations")
	}
}
func TestDisplayDestroyMidFrame(t *testing.T) {
	h := newDisplayHarness(t, "mid")
	h.tap.Start("surface")
	displayEventually(t, func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.commands) > 0 })
	// Wait for Start outside the callback lock, avoiding a race on exec.Cmd.Process.
	time.Sleep(80 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if e := h.tap.Stop(ctx, "surface"); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(h.path); !os.IsNotExist(e) {
		t.Fatal("ring survives destroy")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, cmd := range h.commands {
		if cmd.Process == nil || syscall.Kill(cmd.Process.Pid, 0) == nil {
			t.Fatal("sender survives destroy")
		}
	}
}
func TestDisplayWindowGenerationAndDeath(t *testing.T) {
	h := newDisplayHarness(t, "burst")
	h.tap.Start("surface")
	var generation uint64
	displayEventually(t, func() bool {
		_, _, g, e := displaySnapshot(h.path)
		if e == nil {
			generation = g
			return true
		}
		return false
	})
	h.mu.Lock()
	h.target.XID++
	h.mu.Unlock()
	displayEventually(t, func() bool { _, _, g, e := displaySnapshot(h.path); return e == nil && g != generation })
	h.mu.Lock()
	h.dead = true
	h.mu.Unlock()
	displayEventually(t, func() bool { _, e := os.Stat(h.path); return os.IsNotExist(e) })
}
func TestDisplayDisabledAndRAMRefusal(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		t.Run(strconv.FormatBool(disabled), func(t *testing.T) {
			h := newDisplayHarness(t, "burst")
			var log bytes.Buffer
			h.tap.cfg.Diagnostics = &log
			h.tap.cfg.Admit = func() error { return errors.New("RAM floor") }
			if disabled {
				t.Setenv("MV_DISPLAY_TAP", "off")
			}
			h.tap.Start("surface")
			if disabled {
				h.tap.mu.Lock()
				n := len(h.tap.tasks)
				h.tap.mu.Unlock()
				if n != 0 {
					t.Fatal("disabled tap created supervisor")
				}
			}
			if !disabled {
				h.tap.mu.Lock()
				task := h.tap.tasks["surface"]
				h.tap.mu.Unlock()
				select {
				case <-task.done:
				case <-time.After(time.Second):
					t.Fatal("RAM refusal supervisor did not stop")
				}
			}
			if e := h.tap.Close(context.Background()); e != nil {
				t.Fatal(e)
			}
			h.mu.Lock()
			defer h.mu.Unlock()
			if len(h.commands) != 0 {
				t.Fatal("refused tap launched")
			}
			if !disabled && strings.Count(log.String(), "RAM admission") != 1 {
				t.Fatalf("warning count: %q", log.String())
			}
			if disabled && log.Len() != 0 {
				t.Fatal("disabled tap ran admission")
			}
		})
	}
}
func TestDisplayVerifiedByteIdentity(t *testing.T) {
	root, b, native := ramFixture(t)
	pub := publisher(t, root)
	before, e := pub.Publish("a", b, native)
	if e != nil {
		t.Fatal(e)
	}
	beforeBytes, e := os.ReadFile(before.RAMWSPath)
	if e != nil {
		t.Fatal(e)
	}
	h := newDisplayHarness(t, "burst")
	h.tap.Start("surface")
	displayEventually(t, func() bool { _, m, _, e := displaySnapshot(h.path); return e == nil && m == 80 })
	native.Seq++
	after, e := pub.Publish("a", b, native)
	if e != nil {
		t.Fatal(e)
	}
	afterBytes, e := os.ReadFile(after.RAMWSPath)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(beforeBytes, afterBytes) || before.SHA256 != after.SHA256 || before.Width != after.Width || before.Height != after.Height {
		t.Fatal("VERIFIED bytes changed with DISPLAY on")
	}
	if fmt.Sprint(beforeBytes) == "[]" {
		t.Fatal("empty identity fixture")
	}
}

func TestDisplayResolveNativeWindow(t *testing.T) {
	root, e := os.MkdirTemp("/dev/shm", "mv-display-state-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(root)
	target := displayTestTarget()
	stateDir := filepath.Join(root, "custom-native-state")
	if e = os.Mkdir(stateDir, 0700); e != nil {
		t.Fatal(e)
	}
	b := capsule.Binding{Container: target.Container, RunID: target.Run, NativeKind: "browser", Window: "w1", FramesRoot: filepath.Join(root, target.Run, "frames", "w1"), Surface: capsule.Surface{Display: ":100", Geometry: capsule.Geometry{W: 2, H: 1}}}
	path := filepath.Join(stateDir, target.Container+".json")
	state := map[string]any{"Ready": true, "Capsule": map[string]string{"container": target.Container, "run_id": target.Run}, "XIDs": map[string]string{"w1": "42"}}
	write := func() {
		raw, _ := json.Marshal(state)
		if e = os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write()
	got, e := ResolveDisplayTarget(b, stateDir)
	if e != nil || got != target {
		t.Fatalf("native window mapping: %+v %v", got, e)
	}
	b101 := b
	b101.Surface.Display = ":101"
	got101, e := ResolveDisplayTarget(b101, stateDir)
	if e != nil || got101.Display != ":101" {
		t.Fatalf("expected :101 display target, got %+v (%v)", got101, e)
	}
	for _, badDisplay := range []string{"", "   ", ";evil", "::", "100", ":100;id", ":abc"} {
		bad := b
		bad.Surface.Display = badDisplay
		if _, e = ResolveDisplayTarget(bad, stateDir); e == nil {
			t.Fatalf("invalid display %q accepted", badDisplay)
		} else {
			var ref *DisplayTapRefusal
			if !errors.As(e, &ref) {
				t.Fatalf("expected typed DisplayTapRefusal for %q, got %T (%v)", badDisplay, e, e)
			}
			wantCode := "DISPLAY_INVALID"
			if strings.TrimSpace(badDisplay) == "" {
				wantCode = "DISPLAY_MISSING"
			}
			if ref.Code != wantCode {
				t.Fatalf("display %q refusal code = %q, want %q", badDisplay, ref.Code, wantCode)
			}
		}
	}
	if _, e = ResolveDisplayTarget(b, ""); e == nil {
		t.Fatal("default state unexpectedly resolved custom state")
	}
	state["Ready"] = false
	write()
	if _, e = ResolveDisplayTarget(b, stateDir); e == nil {
		t.Fatal("unready session accepted")
	}
	state["Ready"] = true
	write()
	os.Chmod(path, 0644)
	if _, e = ResolveDisplayTarget(b, stateDir); e == nil {
		t.Fatal("public state accepted")
	}
	os.Chmod(path, 0600)
	os.Rename(path, path+".real")
	os.Symlink(path+".real", path)
	if _, e = ResolveDisplayTarget(b, stateDir); e == nil {
		t.Fatal("symlink state accepted")
	}
}
func TestDisplayGeometryNewFile(t *testing.T) {
	h := newDisplayHarness(t, "burst")
	dir := filepath.Dir(h.path)
	if e := os.Mkdir(dir, 0700); e != nil {
		t.Fatal(e)
	}
	target := displayTestTarget()
	r := &displayRing{path: h.path, generation: 1}
	if e := r.publish(make([]byte, 6), 1, target); e != nil {
		t.Fatal(e)
	}
	old, e := os.Open(h.path)
	if e != nil {
		t.Fatal(e)
	}
	defer old.Close()
	target.Width = 3
	if e = r.publish(make([]byte, 9), 2, target); e == nil {
		t.Fatal("in-place geometry resize accepted")
	}
	r.close()
	r = &displayRing{path: h.path, generation: 2}
	defer r.close()
	if e = r.publish(make([]byte, 9), 2, target); e != nil {
		t.Fatal(e)
	}
	oldInfo, _ := old.Stat()
	newInfo, _ := os.Stat(h.path)
	if os.SameFile(oldInfo, newInfo) || oldInfo.Size() != 76 || newInfo.Size() != 82 {
		t.Fatal("geometry did not replace inode")
	}
}
func TestDisplayMalformedHeaders(t *testing.T) {
	target := displayTestTarget()
	_, d := displayBinding(target)
	for _, mutate := range []func([]byte){
		func(b []byte) { binary.BigEndian.PutUint64(b[8:], ^uint64(0)) },
		func(b []byte) { binary.BigEndian.PutUint64(b[16:], 2) },
		func(b []byte) { b[96] ^= 1 },
		func(b []byte) { binary.BigEndian.PutUint32(b[40:], 4097) },
		func(b []byte) { binary.BigEndian.PutUint64(b[128:], ^uint64(0)) },
	} {
		rec := displayTestRecord(target, d, 1)
		mutate(rec)
		wire := append(displayTestHello(d), rec...)
		calls := 0
		if e := displayDecode(bytes.NewReader(wire), io.Discard, d, target, func([]byte, uint64, DisplayTarget) error { calls++; return nil }); e == nil || calls != 0 {
			t.Fatal("malformed frame accepted")
		}
	}
}

func TestDisplayCreatedOnlyReply(t *testing.T) {
	h := newDisplayHarness(t, "blocked")
	// A failed/error reply must not start anything.
	h.tap.StartReplies([]json.RawMessage{json.RawMessage(`{"event":"error","data":{"surface":{"surface_id":"surface"}}}`)})
	h.tap.mu.Lock()
	n := len(h.tap.tasks)
	h.tap.mu.Unlock()
	if n != 0 {
		t.Fatal("error started DISPLAY")
	}
	h.tap.StartReplies([]json.RawMessage{json.RawMessage(`{"event":"created","data":{"surface":{"surface_id":"surface"}}}`)})
	displayEventually(t, func() bool { _, _, _, err := displaySnapshot(h.path); return err == nil })
}

func TestDisplayXWDGetimageRealLayout(t *testing.T) {
	target := DisplayTarget{Width: 1280, Height: 900}
	for _, order := range []uint32{0, 1} {
		t.Run(strconv.Itoa(int(order)), func(t *testing.T) {
			// srf-fbread: 100-byte BE header plus 23-byte NUL-terminated window
			// name, 32 bpp ZPixmap. Pixel byte order is independent of header order.
			raw := make([]byte, 123+1280*900*4)
			fields := map[int]uint32{0: 123, 1: 7, 2: 2, 3: 24, 4: 1280, 5: 900, 7: order, 11: 32, 12: 5120, 13: 4, 14: 0xff0000, 15: 0xff00, 16: 0xff}
			for i, v := range fields {
				binary.BigEndian.PutUint32(raw[i*4:], v)
			}
			copy(raw[100:], "real-window-with-title!")
			for i := 123; i < len(raw); i += 4 {
				if order == 0 {
					copy(raw[i:], []byte{3, 2, 1, 0})
				} else {
					copy(raw[i:], []byte{0, 1, 2, 3})
				}
			}
			frames := 0
			err := displayDecodeXWD(bytes.NewReader(append(raw, raw...)), target, func(rgb []byte, mono uint64, got DisplayTarget) error {
				frames++
				if len(rgb) != 1280*900*3 || !bytes.Equal(rgb[:3], []byte{1, 2, 3}) || !bytes.Equal(rgb[len(rgb)-3:], []byte{1, 2, 3}) || mono == 0 {
					t.Fatal("wrong getimage pixels")
				}
				return nil
			})
			if !errors.Is(err, io.EOF) || frames != 2 {
				t.Fatalf("frames=%d: %v", frames, err)
			}
			binary.BigEndian.PutUint32(raw[28:], 2)
			if err = displayDecodeXWD(bytes.NewReader(raw), target, func([]byte, uint64, DisplayTarget) error { t.Fatal("invalid byte order accepted"); return nil }); err == nil {
				t.Fatal("bad order accepted")
			}
		})
	}
}

func TestDisplaySenderStderrDiagnostic(t *testing.T) {
	h := newDisplayHarness(t, "stderr")
	diagnostics := &tailBuffer{max: 4096}
	h.tap.cfg.Diagnostics = diagnostics
	h.tap.Start("surface")
	displayEventually(t, func() bool { return strings.Contains(diagnostics.String(), "sender stderr: display-sender-failed") })
	if !strings.Contains(diagnostics.String(), "adapter: DISPLAY tap surface: session ended:") {
		t.Fatal(diagnostics.String())
	}
}

func TestDisplayProductionGetimageCommand(t *testing.T) {
	// Single-capsule mv-live-1 (:100) golden argv and binding.
	t100 := displayTestTarget()
	cmd100 := displayGetimageCommand(context.Background(), t100)
	want100 := []string{"docker", "exec", "-i", "-u", "10001:10001", "-e", "DISPLAY=:100", "srf-id-test", "sh", "-c", "while :; do /usr/local/libexec/srf-fbread getimage :100 42 2>/dev/null || exit 9; sleep 0.03; done"}
	if fmt.Sprint(cmd100.Args) != fmt.Sprint(want100) {
		t.Fatalf("production sender (:100): %q", cmd100.Args)
	}
	body100, digest100 := displayBinding(t100)
	var parsed100 map[string]any
	if err := json.Unmarshal(body100, &parsed100); err != nil || parsed100["display"] != ":100" {
		t.Fatalf("binding (:100) = %s (%v)", body100, err)
	}

	// Second capsule mv-live-2 has pool slot :101 but its own X server is :100 (srf-fbread admits only :100); the binding keeps the slot.
	t101 := DisplayTarget{Container: "srf-id-mv-live-2", Run: "run-2", Window: "w1", Display: ":101", XID: 77, Width: 2, Height: 1}
	cmd101 := displayGetimageCommand(context.Background(), t101)
	want101 := []string{"docker", "exec", "-i", "-u", "10001:10001", "-e", "DISPLAY=:100", "srf-id-mv-live-2", "sh", "-c", "while :; do /usr/local/libexec/srf-fbread getimage :100 77 2>/dev/null || exit 9; sleep 0.03; done"}
	if fmt.Sprint(cmd101.Args) != fmt.Sprint(want101) {
		t.Fatalf("production sender (:101): %q", cmd101.Args)
	}
	body101, digest101 := displayBinding(t101)
	var parsed101 map[string]any
	if err := json.Unmarshal(body101, &parsed101); err != nil || parsed101["display"] != ":101" || digest101 == digest100 {
		t.Fatalf("binding (:101) = %s (%v)", body101, err)
	}
}

func TestDisplayTwoCapsulesDistinctDisplaysAndRingsAndRestart(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-display-multi-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := os.Mkdir(filepath.Join(root, "metaviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(root, "identity-state")
	if err := os.Mkdir(stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	writeState := func(container, run string, xid uint32) {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{
			"Ready":   true,
			"Capsule": map[string]string{"container": container, "run_id": run},
			"XIDs":    map[string]string{"w1": strconv.FormatUint(uint64(xid), 10)},
		})
		if err := os.WriteFile(filepath.Join(stateDir, container+".json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeState("srf-id-mv-live-1", "run-1", 42)
	writeState("srf-id-mv-live-2", "run-2", 84)

	var mu sync.Mutex
	bindings := map[string]capsule.Binding{
		"surface-1": {
			Container:  "srf-id-mv-live-1",
			RunID:      "run-1",
			NativeKind: "browser",
			Window:     "w1",
			FramesRoot: filepath.Join(root, "run-1", "frames", "w1"),
			Surface:    capsule.Surface{SurfaceID: "surface-1", Display: ":100", Geometry: capsule.Geometry{W: 2, H: 1}},
		},
		"surface-2": {
			Container:  "srf-id-mv-live-2",
			RunID:      "run-2",
			NativeKind: "browser",
			Window:     "w1",
			FramesRoot: filepath.Join(root, "run-2", "frames", "w1"),
			Surface:    capsule.Surface{SurfaceID: "surface-2", Display: ":101", Geometry: capsule.Geometry{W: 2, H: 1}},
		},
	}
	spawnedArgs := map[string][][]string{}
	tap := NewDisplayTaps(context.Background(), DisplayTapConfig{
		RuntimeDir: root,
		Admit:      func() error { return nil },
		Resolve: func(id string) (DisplayTarget, error) {
			mu.Lock()
			b, ok := bindings[id]
			mu.Unlock()
			if !ok {
				return DisplayTarget{}, errors.New("unknown surface")
			}
			return ResolveDisplayTarget(b, stateDir)
		},
		Command: func(ctx context.Context, target DisplayTarget) *exec.Cmd {
			prod := displayGetimageCommand(ctx, target)
			mu.Lock()
			spawnedArgs[target.Container] = append(spawnedArgs[target.Container], append([]string(nil), prod.Args...))
			mu.Unlock()
			exe, err := os.Executable()
			if err != nil {
				panic(err)
			}
			bias := "0"
			if target.Display == ":101" {
				bias = "100"
			}
			cmd := exec.CommandContext(ctx, exe, "-test.run=^TestDisplaySenderHelper$")
			cmd.Env = append(os.Environ(), "MV_DISPLAY_TEST_HELPER=1", "MV_DISPLAY_TEST_MODE=burst", "MV_DISPLAY_TEST_BIAS="+bias)
			return cmd
		},
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = tap.Close(ctx)
	})

	tap.StartReplies([]json.RawMessage{
		json.RawMessage(`{"event":"created","data":{"surface":{"surface_id":"surface-1"}}}`),
		json.RawMessage(`{"event":"created","data":{"surface":{"surface_id":"surface-2"}}}`),
	})

	ring1, err := DisplayRingPath(root, "surface-1")
	if err != nil {
		t.Fatal(err)
	}
	ring2, err := DisplayRingPath(root, "surface-2")
	if err != nil || ring1 == ring2 {
		t.Fatalf("expected distinct ring paths, got %q and %q (%v)", ring1, ring2, err)
	}

	var gen2Before uint64
	displayEventually(t, func() bool {
		b1, m1, _, e1 := displaySnapshot(ring1)
		b2, m2, g2, e2 := displaySnapshot(ring2)
		if e1 != nil || e2 != nil || m1 != 80 || m2 != 80 {
			return false
		}
		gen2Before = g2
		return bytes.Equal(b1, []byte{82, 81, 80, 82, 81, 80}) && bytes.Equal(b2, []byte{182, 181, 180, 182, 181, 180})
	})

	mu.Lock()
	args1 := spawnedArgs["srf-id-mv-live-1"]
	args2 := spawnedArgs["srf-id-mv-live-2"]
	mu.Unlock()
	if len(args1) == 0 || len(args2) == 0 {
		t.Fatalf("expected spawned commands for both capsules, got %d and %d", len(args1), len(args2))
	}
	if !strings.Contains(strings.Join(args1[0], " "), "DISPLAY=:100") || !strings.Contains(strings.Join(args1[0], " "), "getimage :100 42") {
		t.Fatalf("capsule 1 wrong display argv: %q", args1[0])
	}
	if !strings.Contains(strings.Join(args2[0], " "), "DISPLAY=:100") || !strings.Contains(strings.Join(args2[0], " "), "getimage :100 84") {
		t.Fatalf("capsule 2 wrong display argv: %q", args2[0])
	}

	// Simulate capsule 2 stop and restart with a new run_id and XID on :101.
	stopCtx, cancelStop := context.WithTimeout(context.Background(), time.Second)
	defer cancelStop()
	if err := tap.Stop(stopCtx, "surface-2"); err != nil {
		t.Fatal(err)
	}
	writeState("srf-id-mv-live-2", "run-2-restarted", 99)
	mu.Lock()
	b2 := bindings["surface-2"]
	b2.RunID = "run-2-restarted"
	bindings["surface-2"] = b2
	mu.Unlock()
	tap.StartReplies([]json.RawMessage{
		json.RawMessage(`{"event":"created","data":{"surface":{"surface_id":"surface-2"}}}`),
	})
	displayEventually(t, func() bool {
		_, m2, g2, e2 := displaySnapshot(ring2)
		return e2 == nil && m2 == 80 && g2 != gen2Before
	})
	mu.Lock()
	latestArgs2 := spawnedArgs["srf-id-mv-live-2"][len(spawnedArgs["srf-id-mv-live-2"])-1]
	mu.Unlock()
	if !strings.Contains(strings.Join(latestArgs2, " "), "DISPLAY=:100") || !strings.Contains(strings.Join(latestArgs2, " "), "getimage :100 99") {
		t.Fatalf("restarted capsule 2 wrong display argv: %q", latestArgs2)
	}
}

func TestDisplayMissingDisplayTypedRefusalKeepsVerifiedAvailable(t *testing.T) {
	root, b, native := ramFixture(t)
	pub := publisher(t, root)
	ringRoot, err := os.MkdirTemp("/dev/shm", "mv-display-refusal-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(ringRoot) })
	if err := os.Mkdir(filepath.Join(ringRoot, "metaviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(ringRoot, "identity-state")
	if err := os.Mkdir(stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	noDispBinding := b
	noDispBinding.NativeKind = "browser"
	noDispBinding.RunID = "run-nodisp"
	noDispBinding.Surface.SurfaceID = "surface-nodisp"
	noDispBinding.Surface.Display = ""
	rawState, _ := json.Marshal(map[string]any{
		"Ready":   true,
		"Capsule": map[string]string{"container": noDispBinding.Container, "run_id": noDispBinding.RunID},
		"XIDs":    map[string]string{noDispBinding.Window: "42"},
	})
	if err := os.WriteFile(filepath.Join(stateDir, noDispBinding.Container+".json"), rawState, 0600); err != nil {
		t.Fatal(err)
	}
	var diag bytes.Buffer
	spawned := 0
	tap := NewDisplayTaps(context.Background(), DisplayTapConfig{
		RuntimeDir:  ringRoot,
		Diagnostics: &diag,
		Admit:       func() error { return nil },
		Resolve: func(string) (DisplayTarget, error) {
			return ResolveDisplayTarget(noDispBinding, stateDir)
		},
		Command: func(ctx context.Context, target DisplayTarget) *exec.Cmd {
			spawned++
			return exec.CommandContext(ctx, "sh", "-c", "exit 9")
		},
	})
	t.Cleanup(func() { _ = tap.Close(context.Background()) })

	tap.Start("surface-nodisp")
	displayEventually(t, func() bool {
		return tap.Err("surface-nodisp") != nil
	})
	tapErr := tap.Err("surface-nodisp")
	var ref *DisplayTapRefusal
	if !errors.As(tapErr, &ref) || !errors.Is(tapErr, ErrDisplayMissing) || ref.Code != "DISPLAY_MISSING" {
		t.Fatalf("expected DISPLAY_MISSING typed refusal, got %T (%v)", tapErr, tapErr)
	}
	if spawned != 0 {
		t.Fatalf("missing-display tap spawned %d commands", spawned)
	}
	ringPath, err := DisplayRingPath(ringRoot, "surface-nodisp")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ringPath); !os.IsNotExist(err) {
		t.Fatalf("missing-display tap created ring file: %v", err)
	}

	// Slow VERIFIED path stays available for the surface.
	refFrame, err := pub.Publish("surface-nodisp", noDispBinding, native)
	if err != nil {
		t.Fatalf("VERIFIED Publish failed after DISPLAY tap refusal: %v", err)
	}
	verifiedBytes, err := os.ReadFile(refFrame.RAMWSPath)
	if err != nil || len(verifiedBytes) != 6 {
		t.Fatalf("VERIFIED frame unreadable: len=%d err=%v", len(verifiedBytes), err)
	}
}

func TestDisplayMultiCapsuleMutants(t *testing.T) {
	sourcePath, err := filepath.Abs("displaytap.go")
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	goTool, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, before, after, test, diagnostic string
	}{
		{
			"MUT-MDISP-GETIMAGE-POOL-SLOT",
			`getimage " + capsuleXDisplay + " "`,
			`getimage " + target.Display + " "`,
			"TestDisplayTwoCapsulesDistinctDisplaysAndRingsAndRestart$",
			"capsule 2 wrong display argv",
		},
		{
			"MUT-MDISP-ENV-POOL-SLOT",
			`"DISPLAY="+capsuleXDisplay`,
			`"DISPLAY="+target.Display`,
			"TestDisplayTwoCapsulesDistinctDisplaysAndRingsAndRestart$",
			"capsule 2 wrong display argv",
		},
		{
			"MUT-MDISP-BINDING-100",
			`"display": t.Display`,
			`"display": ":100"`,
			"TestDisplayProductionGetimageCommand$",
			"binding (:101)",
		},
		{
			"MUT-MDISP-DEFAULT-100",
			`if strings.TrimSpace(b.Surface.Display) == "" {`,
			`if strings.TrimSpace(b.Surface.Display) == "" { b.Surface.Display = ":100" } else if false {`,
			"TestDisplayMissingDisplayTypedRefusalKeepsVerifiedAvailable$",
			"expected DISPLAY_MISSING typed refusal",
		},
		{
			"MUT-MDISP-DROP-DISPLAY",
			`Display:   b.Surface.Display,`,
			`Display:   "",`,
			"TestDisplayResolveNativeWindow$",
			"DISPLAY_MISSING",
		},
		{
			"MUT-MDISP-SINGLE-GOLDEN",
			`sleep 0.03; done`,
			`sleep 0.05; done`,
			"TestDisplayProductionGetimageCommand$",
			"production sender (:100)",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if strings.Count(string(source), tc.before) != 1 {
				t.Fatalf("mutation anchor %q must be unique", tc.before)
			}
			dir := t.TempDir()
			replacement := filepath.Join(dir, "displaytap.go")
			if err := os.WriteFile(replacement, []byte(strings.Replace(string(source), tc.before, tc.after, 1)), 0600); err != nil {
				t.Fatal(err)
			}
			overlay := filepath.Join(dir, "overlay.json")
			raw, _ := json.Marshal(map[string]any{"Replace": map[string]string{sourcePath: replacement}})
			if err := os.WriteFile(overlay, raw, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, goTool, "test", "-count=1", "-overlay", overlay, "-run", "^"+tc.test, ".")
			output, err := cmd.CombinedOutput()
			var exit *exec.ExitError
			if ctx.Err() != nil || !errors.As(err, &exit) || exit.ExitCode() != 1 || !strings.Contains(string(output), "--- FAIL:") || !strings.Contains(string(output), tc.diagnostic) {
				t.Fatalf("mutation %s survived or failed outside assertion: %v\n%s", tc.name, err, output)
			}
			t.Logf("KILLED %s: %s", tc.name, strings.TrimSpace(string(output)))
		})
	}
}

func TestDisplayBaseIgnoresPrivateXDG(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("MV_DISPLAY_DIR", "")
	want := fmt.Sprintf("/dev/shm/metaviewer-display-%d", os.Getuid())
	if got := DisplayBaseDir(); got != want {
		t.Fatalf("default DISPLAY base: %s", got)
	}
	t.Setenv("MV_DISPLAY_DIR", "/dev/shm/explicit-display")
	if got := DisplayBaseDir(); got != "/dev/shm/explicit-display" {
		t.Fatalf("override DISPLAY base: %s", got)
	}
}

func TestDisplayFinishedTaskRevives(t *testing.T) {
	h := newDisplayHarness(t, "normal")
	h.dead = true
	release := make(chan struct{})
	resolve := h.tap.cfg.Resolve
	h.tap.cfg.Resolve = func(id string) (DisplayTarget, error) { <-release; return resolve(id) }
	h.tap.Start("surface")
	h.tap.mu.Lock()
	task := h.tap.tasks["surface"]
	h.tap.mu.Unlock()
	close(release)
	<-task.done
	h.mu.Lock()
	h.dead = false
	h.mu.Unlock()
	h.tap.Start("surface")
	displayEventually(t, func() bool { _, _, _, err := displaySnapshot(h.path); return err == nil })
}
func TestDisplayStaleRingReclaimed(t *testing.T) {
	h := newDisplayHarness(t, "normal")
	if err := os.Mkdir(filepath.Dir(h.path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.path, []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	h.tap.Start("surface")
	displayEventually(t, func() bool { _, _, _, err := displaySnapshot(h.path); return err == nil })
}
func TestDisplayStaleRingRejectsUnsafe(t *testing.T) {
	for _, kind := range []string{"symlink", "mode", "directory", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			h := newDisplayHarness(t, "normal")
			if err := os.Mkdir(filepath.Dir(h.path), 0700); err != nil {
				t.Fatal(err)
			}
			victim := filepath.Join(h.root, "victim")
			if err := os.WriteFile(victim, []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			switch kind {
			case "symlink":
				err = os.Symlink(victim, h.path)
			case "mode":
				err = os.WriteFile(h.path, []byte("keep"), 0644)
				if err == nil {
					err = os.Chmod(h.path, 0644)
				}
			case "directory":
				err = os.Mkdir(h.path, 0600)
			case "hardlink":
				err = os.Link(victim, h.path)
			}
			if err != nil {
				t.Fatal(err)
			}
			r := displayRing{path: h.path, generation: 1}
			if err := r.open(displayTestTarget()); err == nil {
				r.close()
				t.Fatal("unsafe stale file admitted")
			}
			data, err := os.ReadFile(victim)
			if err != nil || string(data) != "keep" {
				t.Fatal("victim changed")
			}
			if _, err = os.Lstat(h.path); err != nil {
				t.Fatal("unsafe file removed")
			}
		})
	}
}

func TestDisplayGetimageUsesTheCapsuleXServerNotThePoolSlot(t *testing.T) {
	cmd := displayGetimageCommand(context.Background(), DisplayTarget{Container: "c", Run: "r", Window: "w1", Display: ":103", XID: 42, Width: 10, Height: 10})
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "srf-fbread getimage :100 42") || !strings.Contains(joined, "DISPLAY=:100") || strings.Contains(joined, ":103") {
		t.Fatalf("command must use the capsule X server: %s", joined)
	}
}

func TestResolveDisplayTargetRefusesOtherNativeKinds(t *testing.T) {
	if _, err := ResolveDisplayTarget(capsule.Binding{NativeKind: "holdings", Window: "w1"}, ""); !errors.Is(err, ErrDisplayUnsupported) {
		t.Fatalf("holdings must stay unsupported: %v", err)
	}
}

func TestHostWindowCaptureCommandUsesSrfHostWindowNotDocker(t *testing.T) {
	cmd := displayGetimageCommand(context.Background(), DisplayTarget{
		HostWindow: true,
		Container:  "hw-77594627",
		Run:        "run-1",
		Window:     "w1",
		Display:    ":0",
		XID:        77594627,
		Witness:    "0x04a00003:1730541000",
		BinDir:     "/opt/srf/bin",
		Width:      4,
		Height:     2,
	})
	want := "/opt/srf/bin/srf-host-window capture --xid 77594627 --witness 0x04a00003:1730541000"
	if got := strings.Join(cmd.Args, " "); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if strings.Contains(strings.Join(cmd.Args, " "), "docker") {
		t.Fatalf("host window capture must never use docker: %v", cmd.Args)
	}
}

func TestHostWindowSenderHelper(t *testing.T) {
	if os.Getenv("MV_HW_CAPTURE_HELPER") != "1" {
		return
	}
	modeFile := os.Getenv("MV_HW_MODE_FILE")
	modeBytes, _ := os.ReadFile(modeFile)
	mode := strings.TrimSpace(string(modeBytes))
	switch mode {
	case "minimized":
		fmt.Fprintln(os.Stderr, "host_window_unavailable: window minimized")
		os.Exit(2)
	case "closed":
		fmt.Fprintln(os.Stderr, "host_window_unavailable: window closed")
		os.Exit(2)
	case "resized":
		// Emit a 2x1 frame first, then a 4x2 frame to trigger resize restart, then hold on 4x2.
		_ = os.WriteFile(modeFile, []byte("resized-steady"), 0600)
		xwdSmall := displayTestXWD(DisplayTarget{Width: 2, Height: 1}, 10)
		_, _ = os.Stdout.Write(xwdSmall)
		xwdLarge := displayTestXWD(DisplayTarget{Width: 4, Height: 2}, 20)
		_, _ = os.Stdout.Write(xwdLarge)
		select {}
	case "resized-steady":
		for i := byte(1); i < 50; i++ {
			xwdLarge := displayTestXWD(DisplayTarget{Width: 4, Height: 2}, 30+i)
			if _, err := os.Stdout.Write(xwdLarge); err != nil {
				os.Exit(0)
			}
			time.Sleep(5 * time.Millisecond)
		}
	default:
		for i := byte(1); i < 50; i++ {
			xwd := displayTestXWD(DisplayTarget{Width: 2, Height: 1}, i)
			if _, err := os.Stdout.Write(xwd); err != nil {
				os.Exit(0)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
}

func TestHostWindowDisplayTapResizeMinimizeAndClose(t *testing.T) {
	root, err := os.MkdirTemp("/dev/shm", "mv-hw-display-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := os.Mkdir(filepath.Join(root, "metaviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	modeFile := filepath.Join(root, "mode")
	if err := os.WriteFile(modeFile, []byte("normal"), 0600); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	target := DisplayTarget{
		HostWindow: true,
		Container:  "hw-77594627",
		Run:        "run-1",
		Window:     "w1",
		Display:    ":0",
		XID:        77594627,
		Witness:    "0x04a00003:1730541000",
		BinDir:     "/opt/srf/bin",
		Width:      2,
		Height:     1,
	}
	var resizes [][2]int
	var minimizedStates []bool
	var fatalReasons []string
	var activeCmds []*exec.Cmd

	tap := NewDisplayTaps(context.Background(), DisplayTapConfig{
		RuntimeDir: root,
		Admit:      func() error { return nil },
		Resolve: func(id string) (DisplayTarget, error) {
			mu.Lock()
			defer mu.Unlock()
			return target, nil
		},
		OnResize: func(id string, w, h int) {
			mu.Lock()
			defer mu.Unlock()
			target.Width = w
			target.Height = h
			resizes = append(resizes, [2]int{w, h})
		},
		OnMinimized: func(id string, min bool) {
			mu.Lock()
			defer mu.Unlock()
			minimizedStates = append(minimizedStates, min)
		},
		OnTerminal: func(id string, reason string) {
			mu.Lock()
			defer mu.Unlock()
			fatalReasons = append(fatalReasons, reason)
		},
		Command: func(ctx context.Context, tgt DisplayTarget) *exec.Cmd {
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestHostWindowSenderHelper$")
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			cmd.Env = append(os.Environ(), "MV_HW_CAPTURE_HELPER=1", "MV_HW_MODE_FILE="+modeFile)
			mu.Lock()
			activeCmds = append(activeCmds, cmd)
			mu.Unlock()
			return cmd
		},
	})
	t.Cleanup(func() { _ = tap.Stop(context.Background(), "hw-surface") })

	ringPath, err := DisplayRingPath(root, "hw-surface")
	if err != nil {
		t.Fatal(err)
	}
	tap.Start("hw-surface")
	displayEventually(t, func() bool {
		b, _, _, e := displaySnapshot(ringPath)
		return e == nil && len(b) == 2*1*3
	})

	// Trigger resize to 4x2: tap must update target via OnResize and reopen ring at 4x2.
	if err := os.WriteFile(modeFile, []byte("resized"), 0600); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	for _, c := range activeCmds {
		if c.Process != nil {
			_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		}
	}
	mu.Unlock()
	displayEventually(t, func() bool {
		mu.Lock()
		gotResize := len(resizes) > 0 && resizes[0] == [2]int{4, 2}
		mu.Unlock()
		if !gotResize {
			return false
		}
		b, _, _, e := displaySnapshot(ringPath)
		return e == nil && len(b) == 4*2*3
	})

	// Trigger minimized state: ring must be removed (closed) so no old frame is served as live, and OnMinimized(true) called.
	if err := os.WriteFile(modeFile, []byte("minimized"), 0600); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	for _, c := range activeCmds {
		if c.Process != nil {
			_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		}
	}
	mu.Unlock()
	displayEventually(t, func() bool {
		mu.Lock()
		gotMin := false
		for _, m := range minimizedStates {
			if m {
				gotMin = true
			}
		}
		mu.Unlock()
		_, e := os.Stat(ringPath)
		return gotMin && os.IsNotExist(e)
	})

	// Trigger closed window: OnTerminal must be called with the refusal line and task must finish.
	if err := os.WriteFile(modeFile, []byte("closed"), 0600); err != nil {
		t.Fatal(err)
	}
	displayEventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(fatalReasons) == 1 && strings.Contains(fatalReasons[0], "host_window_unavailable: window closed")
	})
}
