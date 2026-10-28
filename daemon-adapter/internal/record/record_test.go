package record

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

type fakeRunner struct {
	reply []byte
	err   error
	calls int
	argv  []string
}

func (r *fakeRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	r.calls++
	r.argv = append([]string(nil), args...)
	return r.reply, r.err
}
func fixture(t *testing.T) (string, []byte, uint64) {
	t.Helper()
	dir, err := os.MkdirTemp("/dev/shm", "record-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := os.RemoveAll(dir); e != nil {
			t.Error(e)
		}
	})
	path := filepath.Join(dir, "source.png")
	pixel := image.NewRGBA(image.Rect(0, 0, 2, 1))
	pixel.Set(0, 0, color.RGBA{R: 255, A: 255})
	pixel.Set(1, 0, color.RGBA{G: 255, A: 255})
	var b bytes.Buffer
	if err = png.Encode(&b, pixel); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, b.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte{255, 0, 0, 0, 255, 0})
	reply := map[string]any{"path": path, "seq": uint64(1), "sha256_rgb24": hex.EncodeToString(digest[:]), "width": 2, "height": 1, "capture_mono_ns": uint64(1000000100), "generation": "capsule", "window": map[string]any{"id": "w1", "x": 0, "y": 0, "w": 2, "h": 1, "title": "", "url": ""}}
	raw, err := json.Marshal(reply)
	if err != nil {
		t.Fatal(err)
	}
	return path, raw, uint64(b.Len())
}
func manager(t *testing.T, runner *fakeRunner, ring uint64, dest *Destination) *Manager {
	t.Helper()
	framesRoot := "/dev/shm/record-test-surface"
	if runner != nil && len(runner.reply) > 0 {
		var f struct {
			Path string `json:"path"`
		}
		if json.Unmarshal(runner.reply, &f) == nil && under("/dev/shm", filepath.Dir(f.Path)) {
			framesRoot = filepath.Dir(f.Path)
		}
	}
	m, err := NewManager(Config{Runner: runner, Clock: func() uint64 { return 10 }, OriginNS: 100, BinDir: t.TempDir(), Surfaces: map[string]Surface{"s": {Family: "srf-identity-surface", Container: "capsule", Window: "w1", FramesRoot: framesRoot}}, Destination: dest, MemoryBytes: ring * 4, RingBytes: ring, MaxFPS: 30})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := m.Close(); e != nil {
			t.Error(e)
		}
	})
	return m
}
func payload(op string, p map[string]any) []byte {
	b, err := json.Marshal(map[string]any{"schema": "record_request/v0.2", "request_id": "q", "op": op, "params": p})
	if err != nil {
		panic(err)
	}
	return b
}
func start(ring uint64) []byte {
	return payload("ram_start", map[string]any{"surface_id": "s", "recording_id": "r", "ring_bytes": ring, "max_fps": 20})
}
func stop(op string) []byte {
	return payload(op, map[string]any{"surface_id": "s", "recording_id": "r"})
}
func disk(path, cap string) []byte {
	return payload("disk_start", map[string]any{"surface_id": "s", "recording_id": "r", "destination_capability_id": cap, "destination_path": path, "max_fps": 20})
}
func update(t *testing.T, raw []byte, fields map[string]any) []byte {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for k, f := range fields {
		if f == nil {
			delete(v, k)
		} else {
			v[k] = f
		}
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func requireRefused(t *testing.T, events []Event, err error) {
	t.Helper()
	var refusal *Refusal
	if !errors.As(err, &refusal) || len(events) != 1 || events[0].Event != "refused" || events[0].ReasonCode != refusal.ReasonCode {
		t.Fatalf("expected typed refusal, got %+v %v", events, err)
	}
}

func TestRAMLifecycleEvictionPinsAndStop(t *testing.T) {
	source, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	m := manager(t, runner, size, nil)
	ctx := context.Background()
	events, err := m.Handle(ctx, start(size))
	if err != nil || events[0].Mode != "ram" {
		t.Fatalf("%+v %v", events, err)
	}
	events, err = m.Poll(ctx, "poll", "r")
	if err != nil || len(events) != 1 || events[0].Event != "frame_captured" || *events[0].ByteCount != size || events[0].MonoNS != 1000000000 {
		t.Fatalf("%+v %v", events, err)
	}
	owned := events[0].RAMPath
	if owned == source || !strings.HasPrefix(owned, "/dev/shm/") {
		t.Fatal("recording must own an independent RAM pin")
	}
	if info, e := os.Stat(owned); e != nil || info.Mode().Perm() != 0600 {
		t.Fatal("capture permissions", e)
	}
	want := []string{filepath.Join(m.cfg.BinDir, "srf-identity-surface"), "frame", "--container", "capsule", "--window", "w1"}
	if !reflect.DeepEqual(runner.argv, want) {
		t.Fatalf("argv=%v", runner.argv)
	}
	runner.reply = update(t, reply, map[string]any{"seq": 2, "generation": 2, "capture_mono_ns": 1100000100})
	events, err = m.Poll(ctx, "poll2", "r")
	if err != nil || len(events) != 2 || events[0].Policy != "ram_ring_oldest" || *events[0].DroppedFrames != 1 {
		t.Fatalf("%+v %v", events, err)
	}
	if _, err = os.Stat(owned); !os.IsNotExist(err) {
		t.Fatal("owned eviction was not removed")
	}
	if _, err = os.Stat(source); err != nil {
		t.Fatal("producer frame was removed", err)
	}
	events, err = m.Handle(ctx, stop("ram_stop"))
	if err != nil || *events[0].FrameCount != 1 || *events[0].ByteCount != size {
		t.Fatalf("%+v %v", events, err)
	}
	if _, err = m.Poll(ctx, "poll3", "r"); err == nil {
		t.Fatal("sealed recording accepted a frame")
	}
	events, err = m.Handle(ctx, stop("ram_stop"))
	requireRefused(t, events, err)
	events, err = m.Handle(ctx, start(size))
	requireRefused(t, events, err)
}
func TestScreenshotAndProgramGeneration(t *testing.T) {
	_, reply, size := fixture(t)
	runner := &fakeRunner{reply: update(t, reply, map[string]any{"generation": nil})}
	m := manager(t, runner, size, nil)
	events, err := m.Handle(context.Background(), payload("screenshot", map[string]any{"surface_id": "s", "capture_id": "capture"}))
	if err != nil || len(events) != 3 || events[0].Mode != "screenshot" || events[1].Event != "frame_captured" || events[2].Event != "stopped" || *events[2].FrameCount != 1 || runner.calls != 1 {
		t.Fatalf("%+v %v", events, err)
	}
	if err = os.Remove(events[1].RAMPath); err != nil {
		t.Fatal(err)
	}
	// Missing owned data cannot be exported by substituting a producer path.
	if _, err = ramFile(events[1].RAMPath); err == nil {
		t.Fatal("missing RAM pin accepted")
	}
}
func TestDiskDestinationRefusalHasNoEffects(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "capture.tar")
	for _, dest := range []*Destination{nil, {CapabilityID: "different", Path: path}, {CapabilityID: "cap", Path: filepath.Join(t.TempDir(), "other.tar")}} {
		runner := &fakeRunner{}
		m := manager(t, runner, 1024, dest)
		events, err := m.Handle(ctx, disk(path, "cap"))
		requireRefused(t, events, err)
		if events[0].ReasonCode != "POLICY" || runner.calls != 0 || len(m.records) != 0 || m.root != "" {
			t.Fatal("unauthorized destination mutated state")
		}
		if _, err = os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("unauthorized destination was written")
		}
	}
	m := manager(t, &fakeRunner{}, 1024, nil)
	events, err := m.Handle(ctx, disk("relative", "cap"))
	requireRefused(t, events, err)
}
func TestAuthorizedDiskArchiveAndNoOverwrite(t *testing.T) {
	source, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	dir := t.TempDir()
	path := filepath.Join(dir, "capture.tar")
	m := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: path})
	ctx := context.Background()
	if _, err := m.Handle(ctx, disk(path, "cap")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Poll(ctx, "poll", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("disk write before sealing")
	}
	events, err := m.Handle(ctx, stop("disk_stop"))
	if err != nil || len(events) != 2 || events[1].Event != "exported" {
		t.Fatalf("%+v %v", events, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	if *events[1].ByteCount != uint64(len(data)) || events[1].SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatal("export witness mismatch")
	}
	archive := tar.NewReader(bytes.NewReader(data))
	header, err := archive.Next()
	if err != nil || header.Name != "frame-000001.png" {
		t.Fatal(header, err)
	}
	captured, err := io.ReadAll(archive)
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(original, captured) {
		t.Fatal("archive differs from source", err)
	}
	if _, err = archive.Next(); err != io.EOF {
		t.Fatal("extra archive entries", err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 {
		t.Fatal("export escaped exact destination", err)
	}
	m2 := manager(t, runner, size, &Destination{CapabilityID: "cap", Path: path})
	if _, err = m2.Handle(ctx, disk(path, "cap")); err != nil {
		t.Fatal(err)
	}
	if _, err = m2.Handle(ctx, stop("disk_stop")); err == nil {
		t.Fatal("existing export was overwritten")
	}
	again, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(again, data) {
		t.Fatal("existing export changed", err)
	}
}
func TestFrameValidationRejectsWithoutMutation(t *testing.T) {
	source, reply, size := fixture(t)
	link := filepath.Join(filepath.Dir(source), "link.png")
	if err := os.Symlink(source, link); err != nil {
		t.Fatal(err)
	}
	bad := []map[string]any{
		{"extra": true}, {"capture_mono_ns": -1}, {"capture_mono_ns": 1}, {"path": "/tmp/frame.png"},
		{"path": "/dev/shm/../frame.png"}, {"path": link}, {"sha256_rgb24": strings.Repeat("0", 64)},
		{"width": 3}, {"width": nil}, {"height": 1 << 30}, {"seq": 0}, {"generation": nil, "seq": nil},
		{"generation": 0}, {"generation": "foreign-container"}, {"window": map[string]any{"id": "w1", "w": 2, "h": 1, "unknown": true}}, {"generation": json.RawMessage("null")}, {"window": "w2"},
	}
	for _, fields := range bad {
		runner := &fakeRunner{reply: update(t, reply, fields)}
		m := manager(t, runner, size, nil)
		if _, err := m.Handle(context.Background(), start(size)); err != nil {
			t.Fatal(err)
		}
		if _, err := m.Poll(context.Background(), "poll", "r"); err == nil {
			t.Fatalf("accepted invalid fields: %v", fields)
		}
		if m.records["r"].size != 0 || m.root != "" {
			t.Fatalf("invalid frame changed state: %v", fields)
		}
	}
	for _, raw := range [][]byte{[]byte("{"), append(reply, []byte("\n{}")...), []byte(`{"error":{"code":"bad","detail":"no"}}`)} {
		runner := &fakeRunner{reply: raw}
		m := manager(t, runner, size, nil)
		if _, err := m.Handle(context.Background(), start(size)); err != nil {
			t.Fatal(err)
		}
		if _, err := m.Poll(context.Background(), "poll", "r"); err == nil {
			t.Fatal("malformed CLI accepted")
		}
	}
}
func TestStaleGenerationRateAndCLIFailures(t *testing.T) {
	_, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	m := manager(t, runner, size, nil)
	ctx := context.Background()
	if _, err := m.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Poll(ctx, "poll", "r"); err != nil {
		t.Fatal(err)
	}
	before := m.records["r"].size
	if _, err := m.Poll(ctx, "poll", "r"); err == nil {
		t.Fatal("duplicate generation accepted")
	}
	runner.reply = update(t, reply, map[string]any{"generation": 2})
	if _, err := m.Poll(ctx, "poll", "r"); err == nil {
		t.Fatal("over-rate capture accepted")
	}
	if m.records["r"].size != before {
		t.Fatal("rejection changed ring")
	}
	for _, code := range []int{2, 3, 4, 5, 6, 7} {
		runner.err = cli.ExitFault("srf-identity-surface", code, "")
		if _, err := m.Poll(ctx, "poll", "r"); err == nil {
			t.Fatalf("exit %d accepted", code)
		}
	}
}
func TestClosedRequestBoundsAndUnknownIdentities(t *testing.T) {
	runner := &fakeRunner{}
	m := manager(t, runner, 100, nil)
	ctx := context.Background()
	for _, raw := range [][]byte{
		start(0), start(101), start(capBytes + 1),
		payload("ram_start", map[string]any{"surface_id": "s", "recording_id": "r", "ring_bytes": 1, "max_fps": 0}),
		payload("ram_start", map[string]any{"surface_id": "s", "recording_id": "r", "ring_bytes": 1, "max_fps": 121}),
		payload("ram_start", map[string]any{"surface_id": "other", "recording_id": "r", "ring_bytes": 1, "max_fps": 1}), stop("ram_stop"),
	} {
		events, err := m.Handle(ctx, raw)
		requireRefused(t, events, err)
	}
	for _, raw := range [][]byte{
		payload("ram_start", map[string]any{"surface_id": "s", "recording_id": "r", "ring_bytes": 1, "max_fps": 1, "capture_id": "extra"}),
		payload("ram_stop", map[string]any{"surface_id": "s", "recording_id": ""}),
		payload("ram_start", map[string]any{"surface_id": "s", "recording_id": "r", "max_fps": 1}),
		[]byte(`{"schema":"record_request/v0.2","request_id":"q","op":"ram_stop","params":{"surface_id":"s","recording_id":"r","recording_id":"x"}}`),
	} {
		if _, err := m.Handle(ctx, raw); err == nil {
			t.Fatal("invalid closed request accepted", string(raw))
		}
	}
	if runner.calls != 0 || len(m.records) != 0 || m.root != "" {
		t.Fatal("refusal had effects")
	}
}
func TestHoldingsGenerationAndCancellation(t *testing.T) {
	_, reply, size := fixture(t)
	runner := &fakeRunner{reply: update(t, reply, map[string]any{"generation": "capsule", "window": nil})}
	m := manager(t, runner, size, nil)
	s := m.cfg.Surfaces["s"]
	s.Family = "srf-holdings-capsule"
	s.Window = ""
	m.cfg.Surfaces["s"] = s
	if _, err := m.Handle(context.Background(), start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Poll(context.Background(), "poll", "r"); err != nil {
		t.Fatal(err)
	}
	if len(runner.argv) != 4 {
		t.Fatalf("Holdings frame takes no window flag: %v", runner.argv)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := runner.calls
	if _, err := m.Poll(ctx, "poll", "r"); !errors.Is(err, context.Canceled) || runner.calls != calls {
		t.Fatal("cancelled capture ran")
	}
}
func TestDestinationSymlinksNeverWrite(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(link, "capture.tar")
	m := manager(t, &fakeRunner{}, 1024, &Destination{CapabilityID: "cap", Path: path})
	if _, err := m.Handle(context.Background(), disk(path, "cap")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Handle(context.Background(), stop("disk_stop")); err == nil {
		t.Fatal("symlink destination accepted")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("destination escaped", err)
	}
}

func TestCloseReleasesOwnedPinsAndPreventsRestart(t *testing.T) {
	source, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	m := manager(t, runner, size, nil)
	if _, err := m.Handle(context.Background(), start(size)); err != nil {
		t.Fatal(err)
	}
	events, err := m.Poll(context.Background(), "poll", "r")
	if err != nil {
		t.Fatal(err)
	}
	path := events[0].RAMPath
	if err = m.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("owned pin leaked")
	}
	if _, err = os.Stat(source); err != nil {
		t.Fatal("producer pin removed", err)
	}
	if _, err = m.Handle(context.Background(), start(size)); err == nil {
		t.Fatal("closed manager restarted")
	}
}

// The clock advances through a recording interval without a live capsule or sleep.
func TestSyntheticFiveMinuteRAMRecordingNoDiskWrites(t *testing.T) {
	_, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	m := manager(t, runner, size, nil)
	home, repo := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Chdir(repo)
	ctx := context.Background()
	if _, err := m.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	for second := uint64(0); second < 300; second++ {
		runner.reply = update(t, reply, map[string]any{"seq": second + 1, "generation": "capsule", "capture_mono_ns": 100 + (second+1)*1_000_000_000})
		events, err := m.Poll(ctx, "poll", "r")
		if err != nil {
			t.Fatal(err)
		}
		captured := events[len(events)-1]
		if captured.Event != "frame_captured" || !strings.HasPrefix(captured.RAMPath, "/dev/shm/") {
			t.Fatal("capture escaped RAM")
		}
	}
	if _, err := m.Handle(ctx, stop("ram_stop")); err != nil {
		t.Fatal(err)
	}
	events, err := m.Handle(ctx, disk(filepath.Join(home, "forbidden.tar"), "cap"))
	requireRefused(t, events, err)
	for _, dir := range []string{home, repo} {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) != 0 {
			t.Fatalf("recording wrote outside RAM: %s %v", dir, err)
		}
	}
}

func setSurfaceFramesRoot(s *Surface, root string) bool {
	v := reflect.ValueOf(s).Elem().FieldByName("FramesRoot")
	if !v.IsValid() || !v.CanSet() {
		return false
	}
	v.SetString(root)
	return true
}

func encodePatternPNG(t *testing.T, w, h int, noisy bool) ([]byte, string) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	digest := sha256.New()
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var c color.RGBA
			if noisy {
				c = color.RGBA{R: uint8(x*17 + y*31 + 1), G: uint8(x*53 - y*19 + 2), B: uint8((x*97 ^ y*43) + 3), A: 255}
			} else {
				c = color.RGBA{R: 200, G: 100, B: 50, A: 255}
			}
			img.Set(x, y, c)
			_, _ = digest.Write([]byte{c.R, c.G, c.B})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes(), hex.EncodeToString(digest.Sum(nil))
}

func TestForeignSurfaceRAMProvenanceRefused(t *testing.T) {
	ownPath, reply, size := fixture(t)
	foreignPath, _, _ := fixture(t)
	runner := &fakeRunner{reply: update(t, reply, map[string]any{"path": foreignPath})}
	surf := Surface{Family: "srf-identity-surface", Container: "capsule", Window: "w1"}
	_ = setSurfaceFramesRoot(&surf, filepath.Dir(ownPath))
	m, err := NewManager(Config{
		Runner:      runner,
		Clock:       func() uint64 { return 10 },
		OriginNS:    100,
		BinDir:      t.TempDir(),
		Surfaces:    map[string]Surface{"s": surf},
		MemoryBytes: size * 4,
		RingBytes:   size,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	ctx := context.Background()
	if _, err := m.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Poll(ctx, "poll-foreign", "r"); err == nil {
		t.Fatal("foreign surface RAM provenance accepted")
	}
	if len(m.records["r"].frames) != 0 || m.records["r"].size != 0 {
		t.Fatalf("foreign frame mutated recording: %+v", m.records["r"])
	}
	for _, badRoot := range []string{"", "/dev/shm", "/tmp/frames", "/dev/shm/../tmp"} {
		badSurf := Surface{Family: "srf-identity-surface", Container: "capsule", Window: "w1", FramesRoot: badRoot}
		if _, err := NewManager(Config{
			Runner:      runner,
			Clock:       func() uint64 { return 10 },
			OriginNS:    100,
			BinDir:      t.TempDir(),
			Surfaces:    map[string]Surface{"s": badSurf},
			MemoryBytes: size * 4,
			RingBytes:   size,
			MaxFPS:      30,
		}); err == nil {
			t.Fatalf("accepted invalid FramesRoot %q", badRoot)
		}
	}
	// Negative control: own surface path with valid PNG is captured.
	runner.reply = reply
	events, err := m.Poll(ctx, "poll-own", "r")
	if err != nil || len(events) != 1 || events[0].Event != "frame_captured" {
		t.Fatalf("own frame rejected: %+v %v", events, err)
	}
}

func TestRingEvictionAtomicOnSecondUnlinkFailure(t *testing.T) {
	dir, err := os.MkdirTemp("/dev/shm", "record-evict-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	smallBytes, smallHash := encodePatternPNG(t, 16, 16, false)
	largeBytes, largeHash := encodePatternPNG(t, 16, 16, true)
	smallSize := uint64(len(smallBytes))
	largeSize := uint64(len(largeBytes))
	if smallSize*2 > largeSize {
		t.Fatalf("expected 2*small (%d) <= large (%d)", smallSize*2, largeSize)
	}
	smallPath := filepath.Join(dir, "small.png")
	largePath := filepath.Join(dir, "large.png")
	if err := os.WriteFile(smallPath, smallBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(largePath, largeBytes, 0600); err != nil {
		t.Fatal(err)
	}
	makeReply := func(path, hash string, seq uint64, mono uint64) []byte {
		raw, e := json.Marshal(map[string]any{
			"path":            path,
			"seq":             seq,
			"sha256_rgb24":    hash,
			"width":           16,
			"height":          16,
			"capture_mono_ns": mono,
			"generation":      seq,
			"window":          "w1",
		})
		if e != nil {
			t.Fatal(e)
		}
		return raw
	}
	runner := &fakeRunner{reply: makeReply(smallPath, smallHash, 1, 1_000_000_100)}
	surf := Surface{Family: "srf-identity-surface", Container: "capsule", Window: "w1"}
	_ = setSurfaceFramesRoot(&surf, dir)
	m, err := NewManager(Config{
		Runner:      runner,
		Clock:       func() uint64 { return 10 },
		OriginNS:    100,
		BinDir:      t.TempDir(),
		Surfaces:    map[string]Surface{"s": surf},
		MemoryBytes: largeSize * 4,
		RingBytes:   largeSize,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	ctx := context.Background()
	if _, err := m.Handle(ctx, start(largeSize)); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Poll(ctx, "p1", "r"); err != nil {
		t.Fatal(err)
	}
	runner.reply = makeReply(smallPath, smallHash, 2, 2_000_000_100)
	if _, err := m.Poll(ctx, "p2", "r"); err != nil {
		t.Fatal(err)
	}
	if len(m.records["r"].frames) != 2 || m.records["r"].size != smallSize*2 {
		t.Fatalf("expected 2 retained frames before double eviction, got %+v", m.records["r"])
	}
	// Plant a non-empty directory at the second lease path so the 2nd unlink fails.
	secondLease := m.records["r"].frames[1].path
	if err := os.Remove(secondLease); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(secondLease, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secondLease, "pin"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	runner.reply = makeReply(largePath, largeHash, 3, 3_000_000_100)
	if _, err := m.Poll(ctx, "p3", "r"); err == nil {
		t.Fatal("expected second unlink failure")
	}
	if len(m.records["r"].frames) != 1 || m.records["r"].size != smallSize {
		t.Fatalf("failed eviction did not commit removed prefix: frames=%d size=%d (want 1, %d)", len(m.records["r"].frames), m.records["r"].size, smallSize)
	}
	var sum uint64
	for i, f := range m.records["r"].frames {
		if _, statErr := os.Stat(f.path); statErr != nil {
			t.Fatalf("failed eviction left unlinked frame %d referenced: %v", i, statErr)
		}
		sum += f.bytes
	}
	if m.records["r"].size != sum {
		t.Fatalf("r.size=%d != sum(frames)=%d", m.records["r"].size, sum)
	}
	entries, err := os.ReadDir(m.root)
	if err != nil || len(entries) != 1 {
		t.Fatalf("new copy was not cleaned up on eviction failure: entries=%v err=%v", entries, err)
	}

	// Negative control: clean double eviction emits one dropped event with count 2.
	m2, err := NewManager(Config{
		Runner:      runner,
		Clock:       func() uint64 { return 10 },
		OriginNS:    100,
		BinDir:      t.TempDir(),
		Surfaces:    map[string]Surface{"s": surf},
		MemoryBytes: largeSize * 4,
		RingBytes:   largeSize,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m2.Close() })
	if _, err := m2.Handle(ctx, start(largeSize)); err != nil {
		t.Fatal(err)
	}
	runner.reply = makeReply(smallPath, smallHash, 1, 1_000_000_100)
	if _, err := m2.Poll(ctx, "c1", "r"); err != nil {
		t.Fatal(err)
	}
	runner.reply = makeReply(smallPath, smallHash, 2, 2_000_000_100)
	if _, err := m2.Poll(ctx, "c2", "r"); err != nil {
		t.Fatal(err)
	}
	runner.reply = makeReply(largePath, largeHash, 3, 3_000_000_100)
	events, err := m2.Poll(ctx, "c3", "r")
	if err != nil || len(events) != 2 || events[0].Event != "dropped" || events[0].DroppedFrames == nil || *events[0].DroppedFrames != 2 || events[1].Event != "frame_captured" {
		t.Fatalf("clean double eviction failed: %+v %v", events, err)
	}
}

func TestExportFailureAfterReplaceSparesReplacement(t *testing.T) {
	source, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	dir := t.TempDir()
	dest := filepath.Join(dir, "capture.tar")
	moved := filepath.Join(dir, "moved.tar")
	surf := Surface{Family: "srf-identity-surface", Container: "capsule", Window: "w1"}
	_ = setSurfaceFramesRoot(&surf, filepath.Dir(source))
	m, err := NewManager(Config{
		Runner:      runner,
		Clock:       func() uint64 { return 10 },
		OriginNS:    100,
		BinDir:      t.TempDir(),
		Surfaces:    map[string]Surface{"s": surf},
		Destination: &Destination{CapabilityID: "cap", Path: dest},
		MemoryBytes: size * 4,
		RingBytes:   size,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	ctx := context.Background()
	if _, err := m.Handle(ctx, disk(dest, "cap")); err != nil {
		t.Fatal(err)
	}
	events, err := m.Poll(ctx, "poll", "r")
	if err != nil {
		t.Fatal(err)
	}
	ownedPath := events[0].RAMPath
	const sparseLen = 512 << 20
	if err := os.Truncate(ownedPath, sparseLen); err != nil {
		t.Fatal(err)
	}
	m.records["r"].frames[0].bytes = sparseLen
	replacement := []byte("replacement file must survive")
	done := make(chan error, 1)
	go func() {
		for {
			if err := os.Rename(dest, moved); err == nil {
				if wErr := os.WriteFile(dest, replacement, 0600); wErr != nil {
					done <- wErr
					return
				}
				done <- os.Truncate(ownedPath, 0)
				return
			}
		}
	}()
	if _, err := m.Handle(ctx, stop("disk_stop")); err == nil {
		t.Fatal("expected export failure after truncated frame")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || !bytes.Equal(got, replacement) {
		t.Fatalf("replacement file was removed or modified: got=%q err=%v", got, err)
	}

	// Negative control: ordinary export failure still removes the partial file.
	dest2 := filepath.Join(dir, "ordinary.tar")
	m2, err := NewManager(Config{
		Runner:      runner,
		Clock:       func() uint64 { return 10 },
		OriginNS:    100,
		BinDir:      t.TempDir(),
		Surfaces:    map[string]Surface{"s": surf},
		Destination: &Destination{CapabilityID: "cap", Path: dest2},
		MemoryBytes: size * 4,
		RingBytes:   size,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m2.Close() })
	if _, err := m2.Handle(ctx, disk(dest2, "cap")); err != nil {
		t.Fatal(err)
	}
	events2, err := m2.Poll(ctx, "poll2", "r")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(events2[0].RAMPath, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := m2.Handle(ctx, stop("disk_stop")); err == nil {
		t.Fatal("expected ordinary export failure")
	}
	if _, err := os.Stat(dest2); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("ordinary failed export left partial file: %v", err)
	}
}

func TestExportFailureWithRenamedAncestorUnlinksPartialFile(t *testing.T) {
	source, reply, size := fixture(t)
	runner := &fakeRunner{reply: reply}
	root := t.TempDir()
	ancestor := filepath.Join(root, "ancestor")
	if err := os.Mkdir(ancestor, 0700); err != nil {
		t.Fatal(err)
	}
	renamed := filepath.Join(root, "renamed")
	dest := filepath.Join(ancestor, "capture.tar")
	surf := Surface{Family: "srf-identity-surface", Container: "capsule", Window: "w1"}
	_ = setSurfaceFramesRoot(&surf, filepath.Dir(source))
	m, err := NewManager(Config{
		Runner:      runner,
		Clock:       func() uint64 { return 10 },
		OriginNS:    100,
		BinDir:      t.TempDir(),
		Surfaces:    map[string]Surface{"s": surf},
		Destination: &Destination{CapabilityID: "cap", Path: dest},
		MemoryBytes: size * 4,
		RingBytes:   size,
		MaxFPS:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	ctx := context.Background()
	if _, err := m.Handle(ctx, disk(dest, "cap")); err != nil {
		t.Fatal(err)
	}
	events, err := m.Poll(ctx, "poll", "r")
	if err != nil {
		t.Fatal(err)
	}
	ownedPath := events[0].RAMPath
	const sparseLen = 512 << 20
	if err := os.Truncate(ownedPath, sparseLen); err != nil {
		t.Fatal(err)
	}
	m.records["r"].frames[0].bytes = sparseLen
	done := make(chan error, 1)
	go func() {
		for {
			if _, sErr := os.Lstat(dest); sErr == nil {
				if rErr := os.Rename(ancestor, renamed); rErr != nil {
					done <- rErr
					return
				}
				done <- os.Truncate(ownedPath, 0)
				return
			}
		}
	}()
	if _, err := m.Handle(ctx, stop("disk_stop")); err == nil {
		t.Fatal("expected export failure after truncated frame")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	renamedDest := filepath.Join(renamed, "capture.tar")
	if _, err := os.Stat(renamedDest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed export leaked partial file across ancestor rename: %v", err)
	}
}

func TestLstatAtDoesNotFollowSymlinks(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("payload"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	dangling := filepath.Join(dir, "dangling")
	if err := os.Symlink(filepath.Join(dir, "absent"), dangling); err != nil {
		t.Fatal(err)
	}
	dirFile, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = dirFile.Close() }()

	targetInfo, err := os.Lstat(target)
	if err != nil {
		t.Fatal(err)
	}
	linkInfo, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	danglingInfo, err := os.Lstat(dangling)
	if err != nil {
		t.Fatal(err)
	}

	var gotTarget, gotLink, gotDangling syscall.Stat_t
	if err := lstatAt(int(dirFile.Fd()), "target", &gotTarget); err != nil {
		t.Fatal(err)
	}
	if err := lstatAt(int(dirFile.Fd()), "link", &gotLink); err != nil {
		t.Fatal(err)
	}
	if err := lstatAt(int(dirFile.Fd()), "dangling", &gotDangling); err != nil {
		t.Fatal(err)
	}
	wantTarget := targetInfo.Sys().(*syscall.Stat_t)
	wantLink := linkInfo.Sys().(*syscall.Stat_t)
	wantDangling := danglingInfo.Sys().(*syscall.Stat_t)
	if gotTarget.Ino != wantTarget.Ino || gotTarget.Dev != wantTarget.Dev {
		t.Fatalf("target stat mismatch: got ino=%d want=%d", gotTarget.Ino, wantTarget.Ino)
	}
	if gotLink.Ino != wantLink.Ino || gotLink.Ino == wantTarget.Ino || gotLink.Mode&syscall.S_IFMT != syscall.S_IFLNK {
		t.Fatalf("symlink followed or wrong mode: got ino=%d mode=%o want ino=%d", gotLink.Ino, gotLink.Mode, wantLink.Ino)
	}
	if gotDangling.Ino != wantDangling.Ino || gotDangling.Mode&syscall.S_IFMT != syscall.S_IFLNK {
		t.Fatalf("dangling symlink stat mismatch: got ino=%d mode=%o want ino=%d", gotDangling.Ino, gotDangling.Mode, wantDangling.Ino)
	}
	if err := lstatAt(int(dirFile.Fd()), "missing", &gotTarget); !errors.Is(err, os.ErrNotExist) && !errors.Is(err, syscall.ENOENT) {
		t.Fatalf("missing entry error = %v, want ENOENT", err)
	}
}

func TestTimestampCeilingPreCommitRefusal(t *testing.T) {
	_, reply, size := fixture(t)
	// capture_mono_ns = 9007199254741092 with OriginNS = 100 yields mono = 9007199254740992 (> 2^53 - 1).
	oversized := update(t, reply, map[string]any{
		"seq":             uint64(1),
		"generation":      uint64(1),
		"capture_mono_ns": uint64(9007199254741092),
	})
	runner := &fakeRunner{reply: oversized}
	m := manager(t, runner, size, nil)
	ctx := context.Background()
	if _, err := m.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Poll(ctx, "poll-oversized", "r"); err == nil {
		t.Fatal("expected oversized capture_mono_ns above 2^53-1 to be refused")
	}
	rec := m.records["r"]
	if rec.captured || rec.lastNS != 0 || rec.generation != 0 || rec.size != 0 || len(rec.frames) != 0 || m.root != "" {
		t.Fatalf("oversized timestamp mutated recording state before refusal: %+v root=%q", rec, m.root)
	}

	// Negative control: subsequent frame with an ordinary valid timestamp is accepted and not rejected as stale.
	runner.reply = update(t, reply, map[string]any{
		"seq":             uint64(2),
		"generation":      uint64(2),
		"capture_mono_ns": uint64(1_000_000_100),
	})
	events, err := m.Poll(ctx, "poll-valid", "r")
	if err != nil || len(events) != 1 || events[0].Event != "frame_captured" || events[0].MonoNS != 1_000_000_000 {
		t.Fatalf("subsequent valid frame failed after oversized timestamp refusal: %+v %v", events, err)
	}
}

func checkExportTarHeaderContract(hdr *tar.Header) error {
	if hdr == nil {
		return errors.New("nil tar header")
	}
	if hdr.Mode != 0600 || hdr.Mode&0o077 != 0 || hdr.Mode&0o007 != 0 {
		return errors.New("tar header mode violates 0600 non-world-readable contract")
	}
	if hdr.Uid != 0 || hdr.Gid != 0 || hdr.Uname != "" || hdr.Gname != "" {
		return errors.New("tar header leaked owner or group identity")
	}
	return nil
}

func TestRecordingExportEnforcesRestrictiveTarHeaderModeAndFilePermissions(t *testing.T) {
	// Negative control on the contract checker: world/group permission bits must be rejected.
	for _, badMode := range []int64{0666, 0777, 0644, 0640, 0604, 0606} {
		if err := checkExportTarHeaderContract(&tar.Header{Name: "frame-000001.png", Mode: badMode, Size: 1}); err == nil {
			t.Fatalf("world/group-accessible tar header mode %#o was accepted", badMode)
		}
	}

	_, reply, size := fixture(t)
	ctx := context.Background()

	verifyArchive := func(t *testing.T, tarPath string, wantEntries int) {
		t.Helper()
		info, err := os.Stat(tarPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 || info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("exported archive file mode = %#o, want 0600", info.Mode().Perm())
		}
		data, err := os.ReadFile(tarPath)
		if err != nil {
			t.Fatal(err)
		}
		tr := tar.NewReader(bytes.NewReader(data))
		count := 0
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			count++
			if err := checkExportTarHeaderContract(hdr); err != nil {
				t.Fatalf("entry %d (%s) mode=%#o uid=%d gid=%d uname=%q gname=%q: %v", count, hdr.Name, hdr.Mode, hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname, err)
			}
		}
		if count != wantEntries {
			t.Fatalf("archive entry count = %d, want %d", count, wantEntries)
		}
	}

	// 1. Direct file export path (exportFile).
	fileDest := filepath.Join(t.TempDir(), "capture.tar")
	mFile := manager(t, &fakeRunner{reply: reply}, size, &Destination{CapabilityID: "cap", Path: fileDest})
	if _, err := mFile.Handle(ctx, disk(fileDest, "cap")); err != nil {
		t.Fatal(err)
	}
	if _, err := mFile.Poll(ctx, "poll-1", "r"); err != nil {
		t.Fatal(err)
	}
	events, err := mFile.Handle(ctx, stop("disk_stop"))
	if err != nil || len(events) != 2 || events[1].Event != "exported" {
		t.Fatalf("file export failed: %+v %v", events, err)
	}
	verifyArchive(t, fileDest, 1)

	// 2. Directory export path (exportDir).
	dirDest := t.TempDir()
	mDir := manager(t, &fakeRunner{reply: reply}, size, &Destination{CapabilityID: "cap", Path: dirDest})
	if _, err := mDir.Handle(ctx, start(size)); err != nil {
		t.Fatal(err)
	}
	if _, err := mDir.Poll(ctx, "poll-1", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := mDir.Handle(ctx, stop("ram_stop")); err != nil {
		t.Fatal(err)
	}
	dirEvents, err := mDir.Handle(ctx, disk(dirDest, "cap"))
	if err != nil || len(dirEvents) != 1 || dirEvents[0].Event != "exported" {
		t.Fatalf("dir export failed: %+v %v", dirEvents, err)
	}
	verifyArchive(t, dirEvents[0].DestinationPath, 1)
}
