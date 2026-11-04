package capsule

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/cli"
)

type hostWindowFakeRunner struct {
	calls      [][]string
	windows    map[string]*HostWindowSpec
	captureOut []byte
	captureErr error
	inputOut   []byte
	inputErr   error
	otherOut   []byte
	otherErr   error
}

func (f *hostWindowFakeRunner) ConsumeOpeningWindow(profile string) (*HostWindowSpec, error) {
	if f.windows == nil {
		return nil, nil
	}
	spec := f.windows[profile]
	delete(f.windows, profile)
	if spec == nil {
		return nil, nil
	}
	if err := ValidateHostWindowSpec(spec); err != nil {
		return nil, err
	}
	return spec, nil
}

func (f *hostWindowFakeRunner) Run(_ context.Context, argv []string, _ []byte) ([]byte, error) {
	if len(argv) == 0 {
		return nil, nil
	}
	call := append([]string{filepath.Base(argv[0])}, argv[1:]...)
	f.calls = append(f.calls, call)
	if filepath.Base(argv[0]) == "srf-host-window" && len(argv) > 1 {
		switch argv[1] {
		case "capture":
			return f.captureOut, f.captureErr
		case "input":
			if f.inputOut == nil && f.inputErr == nil {
				fields := map[string]string{}
				for i := 2; i+1 < len(argv); i++ {
					fields[argv[i]] = argv[i+1]
				}
				kind := "click"
				if fields["--key"] != "" {
					kind = "key"
				}
				if fields["--type"] != "" {
					kind = "type"
				}
				xid, _ := strconv.ParseUint(fields["--xid"], 10, 32)
				out, _ := json.Marshal(map[string]any{"ok": true, "xid": xid, "witness": fields["--witness"], "kind": kind, "focus_verified": true})
				return out, nil
			}
			return f.inputOut, f.inputErr
		}
	}
	return f.otherOut, f.otherErr
}

func makeTestXWD(w, h int, pixel byte) []byte {
	b := make([]byte, 100+4*w*h)
	fields := map[int]uint32{
		0: 100, 1: 7, 2: 2, 3: 24,
		4: uint32(w), 5: uint32(h),
		11: 32, 12: uint32(4 * w), 13: 4,
		14: 0xff0000, 15: 0xff00, 16: 0xff,
	}
	for i, v := range fields {
		binary.BigEndian.PutUint32(b[i*4:], v)
	}
	for i := 100; i < len(b); i += 4 {
		b[i], b[i+1], b[i+2] = pixel, pixel+1, pixel+2
	}
	return b
}

func TestHostWindowAttachDetachInputCaptureAndNoDisplaySlot(t *testing.T) {
	ramRoot, err := os.MkdirTemp("/dev/shm", "mv-hw-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(ramRoot) })
	binDir := t.TempDir()
	t.Setenv("DISPLAY", ":0")
	runner := &hostWindowFakeRunner{
		windows:  map[string]*HostWindowSpec{},
		otherOut: []byte(startOK),
	}
	// Configure only ONE identity display slot (:100) and occupy it with a browser capsule first.
	m, err := NewManager(Config{
		BinDir:         binDir,
		MaxSurfaces:    4,
		MaxOutputBytes: 4096,
		Timeout:        time.Second,
		OriginNS:       100,
		Profiles: map[string]Profile{
			"demo": {Kind: "browser", NativeKind: "browser", Width: 2, Height: 1, RAMRoot: ramRoot, Display: ":100"},
		},
	}, runner, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}

	// 1. Occupy the only display pool slot (:100) with demo.
	createBrowser, _ := json.Marshal(map[string]any{
		"kind":       "browser",
		"profile_id": "demo",
		"geometry":   map[string]any{"w": 2, "h": 1},
	})
	if _, err := m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "create", Params: createBrowser}); err != nil {
		t.Fatalf("browser create failed: %v", err)
	}

	// 2. Attach TWO desktop windows even though 0 display pool slots remain free.
	runner.windows["hw-4a00003"] = &HostWindowSpec{
		XID:     77594627,
		Witness: "0x04a00003:1730541000",
		Title:   "Chromium — Logged In",
		Program: "chromium",
		Width:   1280,
		Height:  900,
	}
	runner.windows["hw-4a00004"] = &HostWindowSpec{
		XID:     77594628,
		Witness: "0x04a00004:1730541001",
		Title:   "Terminal — Notes",
		Program: "xterm",
		Width:   1024,
		Height:  768,
	}
	runner.calls = nil

	createHW1, _ := json.Marshal(map[string]any{
		"kind":       "desktop_capsule",
		"profile_id": "hw-4a00003",
		"geometry":   map[string]any{"w": 1280, "h": 900},
	})
	evs1, err := m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "create", Params: createHW1})
	if err != nil {
		t.Fatalf("host window 1 attach failed: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("attach must not spawn docker or srf-identity-surface, got calls: %v", runner.calls)
	}
	var created1 struct {
		Event string `json:"event"`
		Data  struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if err := json.Unmarshal(evs1[0], &created1); err != nil {
		t.Fatal(err)
	}
	sid1 := created1.Data.Surface.SurfaceID
	b1, ok := m.bindings[sid1]
	if !ok || b1.Surface.State != "active" || b1.NativeKind != "host-window" || b1.HostXID != 77594627 || b1.HostWitness != "0x04a00003:1730541000" {
		t.Fatalf("unexpected binding for host window 1: %+v", b1)
	}

	createHW2, _ := json.Marshal(map[string]any{
		"kind":       "desktop_capsule",
		"profile_id": "hw-4a00004",
		"geometry":   map[string]any{"w": 1024, "h": 768},
	})
	evs2, err := m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "create", Params: createHW2})
	if err != nil {
		t.Fatalf("host window 2 attach failed: %v", err)
	}
	var created2 struct {
		Data struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	_ = json.Unmarshal(evs2[0], &created2)
	sid2 := created2.Data.Surface.SurfaceID

	// 3. Input routing: click, key, type go through srf-host-window input with --xid and --witness.
	clickParams, _ := jsonParams(sid1, "p-click", "agent", map[string]any{"type": "click", "x": 320, "y": 240, "button": "left"})
	if _, err := m.Handle(context.Background(), req("input", clickParams)); err != nil {
		t.Fatalf("click input failed: %v", err)
	}
	wantClick := []string{"srf-host-window", "input", "--xid", "77594627", "--witness", "0x04a00003:1730541000", "--click", "320", "240"}
	if got := runner.calls[len(runner.calls)-1]; !reflect.DeepEqual(got, wantClick) {
		t.Fatalf("click call = %v, want %v", got, wantClick)
	}

	keyParams, _ := jsonParams(sid1, "p-key", "agent", map[string]any{"type": "key", "keys": []string{"Return"}})
	if _, err := m.Handle(context.Background(), req("input", keyParams)); err != nil {
		t.Fatalf("key input failed: %v", err)
	}
	wantKey := []string{"srf-host-window", "input", "--xid", "77594627", "--witness", "0x04a00003:1730541000", "--key", "Return"}
	if got := runner.calls[len(runner.calls)-1]; !reflect.DeepEqual(got, wantKey) {
		t.Fatalf("key call = %v, want %v", got, wantKey)
	}

	// Host program input alone gets a dwell. The desktop-window call above
	// is the negative control; the following type/click checks remain unchanged.
	programBinding := m.bindings[sid1]
	programBinding.NativeKind = "host-xpra"
	m.bindings[sid1] = programBinding
	holdParams, _ := jsonParams(sid1, "p-key-held", "agent", map[string]any{"type": "key", "keys": []string{"Return"}})
	if _, err := m.Handle(context.Background(), req("input", holdParams)); err != nil {
		t.Fatalf("held program key input failed: %v", err)
	}
	wantHeld := append(append([]string(nil), wantKey...), "--key-hold-ms", "80")
	if got := runner.calls[len(runner.calls)-1]; !reflect.DeepEqual(got, wantHeld) {
		t.Fatalf("held key call = %v, want %v", got, wantHeld)
	}
	programBinding.NativeKind = "host-window"
	m.bindings[sid1] = programBinding

	typeParams, _ := jsonParams(sid1, "p-type", "agent", map[string]any{"type": "type", "text": "hello world"})
	if _, err := m.Handle(context.Background(), req("input", typeParams)); err != nil {
		t.Fatalf("type input failed: %v", err)
	}
	wantType := []string{"srf-host-window", "input", "--xid", "77594627", "--witness", "0x04a00003:1730541000", "--type", "hello world"}
	if got := runner.calls[len(runner.calls)-1]; !reflect.DeepEqual(got, wantType) {
		t.Fatalf("type call = %v, want %v", got, wantType)
	}

	// Real native acknowledgement: a successful dispatch must still reject
	// missing, foreign, unfocused or extended receipts.
	for i, ack := range []string{
		`{}`, `{"ok":true,"xid":77594628,"witness":"0x04a00003:1730541000","kind":"click","focus_verified":true}`,
		`{"ok":true,"xid":77594627,"witness":"stale","kind":"click","focus_verified":true}`,
		`{"ok":true,"xid":77594627,"witness":"0x04a00003:1730541000","kind":"click","focus_verified":false}`,
		`{"ok":true,"xid":77594627,"witness":"0x04a00003:1730541000","kind":"key","focus_verified":true}`,
		`{"ok":true,"xid":77594627,"witness":"0x04a00003:1730541000","kind":"click","focus_verified":true,"extra":1}`,
	} {
		runner.inputOut = []byte(ack)
		params, _ := jsonParams(sid1, fmt.Sprintf("bad-ack-%d", i), "agent", map[string]any{"type": "click", "x": 1, "y": 1, "button": "left"})
		if _, err := m.Handle(context.Background(), req("input", params)); err == nil {
			t.Fatalf("accepted invalid native acknowledgement %s", ack)
		}
	}
	runner.inputOut = nil

	// 4. Capture via srf-host-window capture decodes XWD and updates geometry on resize.
	runner.captureOut = makeTestXWD(4, 2, 42)
	cb, frame, err := m.Capture(context.Background(), sid1)
	if err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	if frame.Width != 4 || frame.Height != 2 || cb.Surface.Geometry.W != 4 || cb.Surface.Geometry.H != 2 {
		t.Fatalf("capture did not update resized geometry: frame=%dx%d surface=%+v", frame.Width, frame.Height, cb.Surface.Geometry)
	}

	// 5. Minimized window during capture sets HostMinimized=true and keeps surface active (waiting state, not lost).
	runner.captureOut = nil
	runner.captureErr = &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: window minimized"}
	_, _, err = m.Capture(context.Background(), sid1)
	if err == nil || !strings.Contains(err.Error(), "minimized") {
		t.Fatalf("expected minimized error, got %v", err)
	}
	bMin, ok := m.bindings[sid1]
	if !ok || !bMin.HostMinimized || bMin.Surface.State != "active" {
		t.Fatalf("minimized window must remain active in waiting state, got: %+v", bMin)
	}

	// 6. Stop detaches without invoking any external stop/kill command (never closes the user's window).
	runner.calls = nil
	destroyParams, _ := json.Marshal(map[string]any{"surface_id": sid2})
	if _, err := m.Handle(context.Background(), Request{Schema: "surface_request/v0.2", Op: "destroy", Params: destroyParams}); err != nil {
		t.Fatalf("destroy (detach) failed: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("detach must never call external close/kill tools, got: %v", runner.calls)
	}
	if b2, ok := m.bindings[sid2]; ok && b2.Surface.State == "active" {
		t.Fatalf("detached surface %s must not remain active: %+v", sid2, b2)
	}

	// 7. Witness mismatch during input marks the surface lost and never silently rebinds.
	runner.inputErr = &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: witness mismatch"}
	badClick, _ := jsonParams(sid1, "p-stale", "agent", map[string]any{"type": "click", "x": 1, "y": 1, "button": "left"})
	_, err = m.Handle(context.Background(), req("input", badClick))
	if err == nil || !strings.Contains(err.Error(), "witness mismatch") {
		t.Fatalf("expected witness mismatch error, got %v", err)
	}
	if bLost, ok := m.bindings[sid1]; ok && bLost.Surface.State != "lost" {
		t.Fatalf("surface %s must be marked lost on witness mismatch, got state %q", sid1, bLost.Surface.State)
	}
}
