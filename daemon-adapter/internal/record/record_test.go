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
	m, err := NewManager(Config{Runner: runner, Clock: func() uint64 { return 10 }, OriginNS: 100, BinDir: t.TempDir(), Surfaces: map[string]Surface{"s": {Family: "srf-identity-surface", Container: "capsule", Window: "w1"}}, Destination: dest, MemoryBytes: ring * 4, RingBytes: ring, MaxFPS: 30})
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
